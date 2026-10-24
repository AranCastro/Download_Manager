'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { BaseDownload } = require('./BaseDownload');
const { HttpError, request } = require('./http');
const ftp = require('./ftp');
const {
  PART_SUFFIX,
  categorise,
  fileNameFromResponse,
  sanitiseFileName,
  uniquePath,
  sleep,
} = require('./utils');

// A segment is never split below this size; smaller files use one connection.
const MIN_SEGMENT_BYTES = 256 * 1024;
const MAX_RETRIES = 5;

function segmentDone(seg) {
  return seg.end == null ? Boolean(seg.done) : seg.start + seg.downloaded > seg.end;
}

function segmentRemaining(seg) {
  return seg.end == null ? Infinity : seg.end - (seg.start + seg.downloaded) + 1;
}

// HTTP(S): probe with a one-byte range request, then one ranged GET per segment.
const httpTransport = {
  async probe(dl, signal) {
    const res = await request(dl.url, {
      headers: dl.requestHeaders({ Range: 'bytes=0-0' }),
      signal,
      auth: dl.auth,
    });
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    const encoded = (res.headers.get('content-encoding') || 'identity') !== 'identity';
    let totalBytes = null;
    let resumable = false;
    if (res.status === 206 && !encoded) {
      const match = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      totalBytes = match ? Number(match[1]) : null;
      resumable = totalBytes != null;
    } else {
      const length = res.headers.get('content-length');
      totalBytes = length != null && !encoded ? Number(length) : null;
    }
    const fileName = fileNameFromResponse(res.url || dl.url, res.headers);
    const contentType = res.headers.get('content-type');
    await res.body?.cancel().catch(() => {});
    return { totalBytes, resumable, fileName, contentType };
  },

  async *open(dl, seg, signal) {
    const extra = dl.resumable ? { Range: `bytes=${seg.start + seg.downloaded}-${seg.end}` } : {};
    const res = await request(dl.url, { headers: dl.requestHeaders(extra), signal, auth: dl.auth });
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    if (dl.resumable && res.status !== 206) {
      const err = new Error('Server stopped accepting range requests');
      err.fatal = true;
      throw err;
    }
    yield* res.body;
  },
};

const ftpTransport = {
  probe: (dl, signal) => ftp.probe(dl.url, dl.ctx.credentialsFor(dl), signal),
  open: (dl, seg, signal) =>
    ftp.openRange(dl.url, dl.ctx.credentialsFor(dl), seg.start + seg.downloaded, signal),
};

// A single file fetched over several connections (HTTP ranges or FTP REST).
class Download extends BaseDownload {
  constructor(data, ctx) {
    super({ ...data, kind: 'file' }, ctx);
    this.resumable = data.resumable ?? false;
    this.segments = (data.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      downloaded: s.downloaded,
      done: s.done,
    }));
    this.transport = /^ftps?:/i.test(this.url) ? ftpTransport : httpTransport;
  }

  get tempPath() {
    return this.savePath ? this.savePath + PART_SUFFIX : null;
  }

  async run(session) {
    await this.probe(session);
    if (session.cancelled) return;
    const fh = await this.openTempFile();
    try {
      this.setStatus('downloading');
      await this.runSegments(session, fh);
    } finally {
      await fh.close().catch(() => {});
    }
    if (session.cancelled) return;
    await this.finalise();
  }

  // Finds the size, whether ranges work and the file name without
  // transferring the body.
  async probe(session) {
    if (this.probed && this.savePath) {
      if (!this.resumable) this.resetProgress();
      return;
    }
    const { ctrl, release } = this.controller(session);
    let info;
    try {
      info = await this.transport.probe(this, ctrl.signal);
    } finally {
      release();
    }
    if (session.cancelled) return;
    this.totalBytes = info.totalBytes;
    this.resumable = info.resumable;
    if (!this.fileNameLocked) this.fileName = info.fileName;
    this.fileName = sanitiseFileName(this.fileName);
    this.category = categorise(this.fileName);

    const directory = this.directory || this.ctx.resolveDirectory(this.category);
    await fsp.mkdir(directory, { recursive: true });
    this.savePath = uniquePath(directory, this.fileName, this.ctx.reservedPaths(this));
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
    if (this.downloadedBytes > 0 && this.resumable && fs.existsSync(temp)) {
      return fsp.open(temp, 'r+');
    }
    if (this.downloadedBytes > 0) this.resetProgress();
    const fh = await fsp.open(temp, 'w+');
    // Pre-allocate (sparse on NTFS/ext4) so segments can write at any offset.
    if (this.totalBytes) await fh.truncate(this.totalBytes);
    return fh;
  }

  // Runs one worker per connection. A worker that finishes its segment takes
  // half of the largest remaining segment (dynamic segmentation), so fast
  // connections keep working until the file is complete.
  async runSegments(session, fh) {
    const workers = this.resumable ? this.connections : 1;
    let failure = null;
    let running = workers;

    const worker = async () => {
      try {
        while (!session.cancelled && !failure) {
          let seg = this.segments.find((s) => !s.active && !segmentDone(s));
          if (!seg && this.resumable) seg = this.splitLargestSegment();
          if (!seg) return;
          seg.active = true;
          try {
            await this.runSegment(seg, session, fh);
          } catch (err) {
            // A server that limits connections: leave the segment to the
            // workers that did get in, unless this was the last one.
            if (err.tooManyConnections && running > 1) return;
            failure = failure || err;
            for (const ctrl of session.controllers) ctrl.abort();
          } finally {
            seg.active = false;
          }
        }
      } finally {
        running--;
      }
    };

    await Promise.all(Array.from({ length: workers }, worker));
    if (failure && !session.cancelled) throw failure;
    if (!session.cancelled && this.segments.some((s) => !segmentDone(s))) {
      throw new Error('Download stopped before all segments finished');
    }
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
      const { ctrl, release } = this.controller(session);
      try {
        await this.pipe(this.transport.open(this, seg, ctrl.signal), seg, session, ctrl, fh);
        if (session.cancelled) return;
        if (seg.end == null) seg.done = true;
        else if (!segmentDone(seg)) throw new Error('Connection closed before the segment finished');
        attempt = 0;
      } catch (err) {
        if (session.cancelled) return;
        // A plain stream cannot be continued mid-way, and 4xx errors are final.
        if (!this.resumable || err.fatal || err.tooManyConnections || ++attempt > MAX_RETRIES) throw err;
        await sleep(Math.min(1000 * 2 ** attempt, 15000), ctrl.signal);
      } finally {
        release();
      }
    }
  }

  async pipe(chunks, seg, session, ctrl, fh) {
    for await (const value of chunks) {
      if (session.cancelled) return;
      await this.ctx.limiter.consume(value.length, ctrl.signal);
      if (session.cancelled) return;
      // The segment end can shrink while we wait (another worker took half),
      // so clamp the chunk right before writing.
      const position = seg.start + seg.downloaded;
      const length = Math.min(value.length, segmentRemaining(seg));
      if (length <= 0) return;
      // Count the bytes before the write so a concurrent split sees them.
      seg.downloaded += length;
      this.recordBytes(length);
      await fh.write(value, 0, length, position);
      if (segmentDone(seg)) return;
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
    await this.removeFiles(targets);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      resumable: this.resumable,
      segments: this.segments.map(({ start, end, downloaded, done }) => ({ start, end, downloaded, done })),
    };
  }

  snapshot() {
    return {
      ...super.snapshot(),
      segments: this.segments.map((s) => ({ ...s, active: Boolean(s.active) })),
      activeConnections: this.segments.filter((s) => s.active).length,
    };
  }
}

module.exports = { Download, HttpError, MIN_SEGMENT_BYTES };
