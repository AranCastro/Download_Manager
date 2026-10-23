'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const {
  PART_SUFFIX,
  categorise,
  fileNameFromResponse,
  fileNameFromUrl,
  sanitiseFileName,
  uniquePath,
  sleep,
} = require('./utils');

// A segment is never split below this size; smaller files use one connection.
const MIN_SEGMENT_BYTES = 256 * 1024;
const MAX_RETRIES = 5;
const SPEED_WINDOW_MS = 3000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0 Safari/537.36 DownloadManager/1.0';

const ACTIVE_STATUSES = new Set(['connecting', 'downloading']);

function segmentDone(seg) {
  return seg.end == null ? Boolean(seg.done) : seg.start + seg.downloaded > seg.end;
}

function segmentRemaining(seg) {
  return seg.end == null ? Infinity : seg.end - (seg.start + seg.downloaded) + 1;
}

// fetch() reports network failures as "fetch failed" with the reason in .cause.
function describeError(err) {
  const cause = err?.cause;
  if (cause) return `${err.message}: ${cause.code || cause.message || cause}`;
  return err?.message || String(err);
}

class HttpError extends Error {
  constructor(status, statusText) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.status = status;
    // 4xx responses (except timeouts / rate limits) will not succeed on retry.
    this.fatal = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

class Download extends EventEmitter {
  constructor(data, ctx) {
    super();
    this.ctx = ctx;
    this.id = data.id || crypto.randomUUID();
    this.url = data.url;
    this.headers = data.headers || {};
    this.fileNameLocked = Boolean(data.fileNameLocked ?? data.fileName);
    // Until the server is probed, the URL gives a provisional name to display.
    this.fileName = data.fileName || sanitiseFileName(fileNameFromUrl(data.url));
    this.directory = data.directory || null;
    this.savePath = data.savePath || null;
    this.category = data.category || (this.fileName ? categorise(this.fileName) : 'Other');
    this.totalBytes = data.totalBytes ?? null;
    this.downloadedBytes = data.downloadedBytes || 0;
    this.resumable = data.resumable ?? false;
    this.probed = data.probed ?? false;
    this.connections = data.connections || 8;
    this.segments = (data.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      downloaded: s.downloaded,
      done: s.done,
    }));
    this.status = data.status || 'paused';
    this.error = data.error || null;
    this.createdAt = data.createdAt || Date.now();
    this.completedAt = data.completedAt || null;
    this.lastTryAt = data.lastTryAt || null;

    this.speedSamples = [];
    this.session = null;
  }

  get isActive() {
    return ACTIVE_STATUSES.has(this.status);
  }

  get tempPath() {
    return this.savePath ? this.savePath + PART_SUFFIX : null;
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit('status', this);
  }

  // Bytes per second averaged over the last few seconds.
  get speed() {
    if (!this.isActive) return 0;
    const cutoff = Date.now() - SPEED_WINDOW_MS;
    while (this.speedSamples.length && this.speedSamples[0].t < cutoff) this.speedSamples.shift();
    const bytes = this.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
    return bytes / (SPEED_WINDOW_MS / 1000);
  }

  async start() {
    if (this.isActive || this.status === 'completed') return;
    const session = { cancelled: false, controllers: new Set() };
    this.session = session;
    this.lastTryAt = Date.now();
    this.speedSamples = [];
    this.setStatus('connecting');

    let fh = null;
    try {
      await this.probe(session);
      if (session.cancelled) return;
      fh = await this.openTempFile();
      this.setStatus('downloading');
      await this.runSegments(session, fh);
      await fh.close();
      fh = null;
      if (session.cancelled) return;
      await this.finalise();
    } catch (err) {
      if (session.cancelled) return;
      this.setStatus('error', describeError(err));
    } finally {
      if (fh) await fh.close().catch(() => {});
      if (this.session === session) this.session = null;
    }
  }

  pause() {
    const session = this.session;
    if (session) {
      session.cancelled = true;
      for (const ctrl of session.controllers) ctrl.abort();
      this.session = null;
    }
    if (this.status !== 'completed') this.setStatus('paused');
  }

  // Requests byte 0 only, which tells us the size, whether ranges work and the
  // file name without transferring the body.
  async probe(session) {
    if (this.probed && this.savePath) {
      // Re-check that the server still honours ranges before resuming.
      if (!this.resumable) this.resetProgress();
      return;
    }
    const ctrl = new AbortController();
    session.controllers.add(ctrl);
    try {
      const res = await fetch(this.url, {
        headers: this.requestHeaders({ Range: 'bytes=0-0' }),
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new HttpError(res.status, res.statusText);
      const encoded = (res.headers.get('content-encoding') || 'identity') !== 'identity';
      if (res.status === 206 && !encoded) {
        const match = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
        this.totalBytes = match ? Number(match[1]) : null;
        this.resumable = this.totalBytes != null;
      } else {
        const length = res.headers.get('content-length');
        this.totalBytes = length != null && !encoded ? Number(length) : null;
        this.resumable = false;
      }
      if (!this.fileNameLocked) this.fileName = fileNameFromResponse(res.url || this.url, res.headers);
      this.fileName = sanitiseFileName(this.fileName);
      this.category = categorise(this.fileName);
      await res.body?.cancel().catch(() => {});
    } finally {
      ctrl.abort();
      session.controllers.delete(ctrl);
    }
    if (session.cancelled) return;

    const directory = this.directory || this.ctx.resolveDirectory(this.category);
    await fsp.mkdir(directory, { recursive: true });
    this.savePath = uniquePath(directory, this.fileName, this.ctx.reservedPaths());
    this.fileName = path.basename(this.savePath);
    this.probed = true;
    this.resetProgress();
  }

  resetProgress() {
    this.downloadedBytes = 0;
    if (this.resumable && this.totalBytes > 0) {
      const count = Math.max(
        1,
        Math.min(this.connections, Math.floor(this.totalBytes / MIN_SEGMENT_BYTES)),
      );
      const size = Math.ceil(this.totalBytes / count);
      this.segments = [];
      for (let start = 0; start < this.totalBytes; start += size) {
        this.segments.push({ start, end: Math.min(start + size, this.totalBytes) - 1, downloaded: 0 });
      }
    } else if (this.totalBytes === 0) {
      this.segments = [];
    } else {
      this.segments = [{ start: 0, end: null, downloaded: 0 }];
    }
  }

  async openTempFile() {
    const temp = this.tempPath;
    let fh;
    if (this.downloadedBytes > 0 && this.resumable && fs.existsSync(temp)) {
      fh = await fsp.open(temp, 'r+');
    } else {
      if (this.downloadedBytes > 0) this.resetProgress();
      fh = await fsp.open(temp, 'w+');
      // Pre-allocate (sparse on NTFS/ext4) so segments can write at any offset.
      if (this.totalBytes) await fh.truncate(this.totalBytes);
    }
    return fh;
  }

  // Runs one worker per connection. A worker that finishes its segment takes
  // half of the largest remaining segment (dynamic segmentation), so fast
  // connections keep working until the file is complete.
  async runSegments(session, fh) {
    const workers = this.resumable ? this.connections : 1;
    let failure = null;

    const worker = async () => {
      while (!session.cancelled && !failure) {
        let seg = this.segments.find((s) => !s.active && !segmentDone(s));
        if (!seg && this.resumable) seg = this.splitLargestSegment();
        if (!seg) return;
        seg.active = true;
        try {
          await this.runSegment(seg, session, fh);
        } catch (err) {
          failure = failure || err;
          for (const ctrl of session.controllers) ctrl.abort();
        } finally {
          seg.active = false;
        }
      }
    };

    await Promise.all(Array.from({ length: workers }, worker));
    if (failure && !session.cancelled) throw failure;
  }

  splitLargestSegment() {
    let largest = null;
    for (const seg of this.segments) {
      if (seg.active && segmentRemaining(seg) > (largest ? segmentRemaining(largest) : 0)) {
        largest = seg;
      }
    }
    if (!largest) return null;
    const remaining = segmentRemaining(largest);
    if (remaining < MIN_SEGMENT_BYTES * 2) return null;
    const mid = largest.start + largest.downloaded + Math.floor(remaining / 2);
    const seg = { start: mid, end: largest.end, downloaded: 0 };
    largest.end = mid - 1;
    this.segments.splice(this.segments.indexOf(largest) + 1, 0, seg);
    return seg;
  }

  async runSegment(seg, session, fh) {
    let attempt = 0;
    while (!session.cancelled && !segmentDone(seg)) {
      const ctrl = new AbortController();
      session.controllers.add(ctrl);
      try {
        const extra = this.resumable
          ? { Range: `bytes=${seg.start + seg.downloaded}-${seg.end}` }
          : {};
        const res = await fetch(this.url, {
          headers: this.requestHeaders(extra),
          signal: ctrl.signal,
          redirect: 'follow',
        });
        if (!res.ok) throw new HttpError(res.status, res.statusText);
        if (this.resumable && res.status !== 206) {
          const err = new Error('Server stopped accepting range requests');
          err.fatal = true;
          throw err;
        }
        await this.pipeBody(res.body, seg, session, ctrl, fh);
        if (session.cancelled) return;
        if (seg.end == null) seg.done = true;
        else if (!segmentDone(seg)) throw new Error('Connection closed before the segment finished');
        attempt = 0;
      } catch (err) {
        if (session.cancelled) return;
        // A plain stream cannot be continued mid-way, and 4xx errors are final.
        if (!this.resumable || err.fatal || ++attempt > MAX_RETRIES) throw err;
        await sleep(Math.min(1000 * 2 ** attempt, 15000), ctrl.signal);
      } finally {
        ctrl.abort();
        session.controllers.delete(ctrl);
      }
    }
  }

  async pipeBody(body, seg, session, ctrl, fh) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || session.cancelled) return;
        await this.ctx.limiter.consume(value.length, ctrl.signal);
        if (session.cancelled) return;
        // The segment end can shrink while we wait (another worker took half),
        // so clamp the chunk right before writing.
        const position = seg.start + seg.downloaded;
        const length = Math.min(value.length, segmentRemaining(seg));
        if (length <= 0) return;
        // Count the bytes before the write so a concurrent split sees them.
        seg.downloaded += length;
        this.downloadedBytes += length;
        this.speedSamples.push({ t: Date.now(), bytes: length });
        await fh.write(value, 0, length, position);
        if (segmentDone(seg)) return;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async finalise() {
    if (this.totalBytes == null) this.totalBytes = this.downloadedBytes;
    const target = fs.existsSync(this.savePath)
      ? uniquePath(path.dirname(this.savePath), path.basename(this.savePath))
      : this.savePath;
    await fsp.rename(this.tempPath, target);
    this.savePath = target;
    this.fileName = path.basename(target);
    this.completedAt = Date.now();
    this.segments = [];
    this.setStatus('completed');
  }

  async deleteFiles({ includeCompleted = false } = {}) {
    const targets = [this.tempPath];
    if (includeCompleted && this.status === 'completed') targets.push(this.savePath);
    for (const file of targets) {
      if (file) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  requestHeaders(extra) {
    return {
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'identity',
      ...this.headers,
      ...extra,
    };
  }

  get eta() {
    const speed = this.speed;
    if (!speed || this.totalBytes == null) return null;
    return Math.max(0, (this.totalBytes - this.downloadedBytes) / speed);
  }

  toJSON() {
    return {
      id: this.id,
      url: this.url,
      headers: this.headers,
      fileName: this.fileName,
      fileNameLocked: this.fileNameLocked,
      directory: this.directory,
      savePath: this.savePath,
      category: this.category,
      totalBytes: this.totalBytes,
      downloadedBytes: this.downloadedBytes,
      resumable: this.resumable,
      probed: this.probed,
      connections: this.connections,
      segments: this.segments.map(({ start, end, downloaded, done }) => ({ start, end, downloaded, done })),
      status: this.status,
      error: this.error,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      lastTryAt: this.lastTryAt,
    };
  }

  snapshot() {
    return {
      ...this.toJSON(),
      segments: this.segments.map((s) => ({ ...s, active: Boolean(s.active) })),
      activeConnections: this.segments.filter((s) => s.active).length,
      speed: this.speed,
      eta: this.eta,
    };
  }
}

module.exports = { Download, HttpError, MIN_SEGMENT_BYTES };
