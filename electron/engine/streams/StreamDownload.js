'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { BaseDownload } = require('../BaseDownload');
const { HttpError, request } = require('../http');
const { mux } = require('../ffmpeg');
const { sanitiseFileName, uniquePath, sleep } = require('../utils');
const { resolveHls, segmentIv } = require('./hls');
const { resolveDash } = require('./dash');

const MAX_RETRIES = 5;
const PIECE_CELLS = 120;
const GENERIC_NAMES = /^(master|index|playlist|manifest|stream|video|main|chunklist.*|prog_index)$/i;

// A name for the saved video when none was given: the playlist file name,
// or the folder above it when the playlist has a generic name.
function streamBaseName(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const last = (parts.pop() || '').replace(/\.(m3u8|mpd)$/i, '');
    if (last && !GENERIC_NAMES.test(last)) return last;
    return parts.pop() || new URL(url).hostname;
  } catch {
    return 'video';
  }
}

function decryptAes128(data, key, iv) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// HLS or DASH video: the manifest is resolved to tracks of segments, the
// segments are fetched in parallel (and decrypted for AES-128 HLS), each
// track is concatenated, and FFmpeg (when available) merges the tracks.
class StreamDownload extends BaseDownload {
  constructor(data, ctx) {
    super({ ...data, category: 'Video' }, ctx);
    this.quality = data.quality || 'best';
    this.segmentsTotal = data.segmentsTotal || 0;
    this.segmentsDone = data.segmentsDone || 0;
    this.streamInfo = data.streamInfo || null;
    this.extraFiles = data.extraFiles || [];
    this.doneMap = null;
    this.keys = new Map();
  }

  get tempDir() {
    return this.savePath ? `${this.savePath}.dmparts` : null;
  }

  async fetchText(url, signal) {
    const res = await request(url, { headers: this.requestHeaders(), signal, auth: this.auth });
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    return res.text();
  }

  async run(session) {
    const { ctrl, release } = this.controller(session);
    let plan;
    try {
      const resolve = this.kind === 'dash' ? resolveDash : resolveHls;
      plan = await resolve(this.url, (u) => this.fetchText(u, ctrl.signal), this.quality);
    } finally {
      release();
    }
    if (session.cancelled) return;

    this.streamInfo = {
      ...plan.info,
      tracks: plan.tracks.map((t) => ({ type: t.type, segments: t.segments.length })),
    };
    if (!this.savePath) await this.chooseSavePath();
    await fsp.mkdir(this.tempDir, { recursive: true });

    const jobs = this.buildJobs(plan.tracks);
    this.segmentsTotal = jobs.length;
    this.segmentsDone = 0;
    this.downloadedBytes = 0;
    this.doneMap = new Uint8Array(jobs.length);
    // Segments saved by an earlier run are kept (resume).
    jobs.forEach((job, i) => {
      const stat = fs.statSync(job.file, { throwIfNoEntry: false });
      if (stat) {
        this.doneMap[i] = 1;
        this.segmentsDone++;
        this.downloadedBytes += stat.size;
      }
    });
    this.updateEstimate();
    this.probed = true;
    this.setStatus('downloading');

    await this.runJobs(session, jobs);
    if (session.cancelled) return;
    this.setStatus('merging');
    await this.assemble(session, plan.tracks, jobs);
  }

  async chooseSavePath() {
    let base = this.fileNameLocked ? this.fileName : streamBaseName(this.url);
    base = sanitiseFileName(base.replace(/\.(m3u8|mpd|mp4|ts|mkv|webm)$/i, ''));
    const directory = this.directory || this.ctx.resolveDirectory('Video');
    await fsp.mkdir(directory, { recursive: true });
    this.savePath = uniquePath(directory, `${base}.mp4`, this.ctx.reservedPaths(this));
    this.fileName = path.basename(this.savePath);
  }

  buildJobs(tracks) {
    const jobs = [];
    tracks.forEach((track, t) => {
      const init = track.init || track.segments[0]?.map || null;
      if (init) {
        jobs.push({ track: t, uri: init.uri, byteRange: init.byteRange, file: path.join(this.tempDir, `${t}-init.seg`) });
      }
      track.segments.forEach((seg, i) => {
        jobs.push({
          track: t,
          uri: seg.uri,
          byteRange: seg.byteRange,
          key: seg.key || null,
          segment: seg,
          file: path.join(this.tempDir, `${t}-${String(i).padStart(6, '0')}.seg`),
        });
      });
    });
    return jobs;
  }

  updateEstimate() {
    this.totalBytes = this.segmentsDone
      ? Math.round((this.downloadedBytes / this.segmentsDone) * this.segmentsTotal)
      : null;
  }

  async runJobs(session, jobs) {
    let next = 0;
    let failure = null;
    const worker = async () => {
      while (!session.cancelled && !failure) {
        while (next < jobs.length && this.doneMap[next]) next++;
        if (next >= jobs.length) return;
        const index = next++;
        try {
          await this.fetchJob(jobs[index], session);
          if (session.cancelled) return;
          this.doneMap[index] = 1;
          this.segmentsDone++;
          this.updateEstimate();
        } catch (err) {
          failure = failure || err;
          for (const ctrl of session.controllers) ctrl.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: this.connections }, worker));
    if (failure && !session.cancelled) throw failure;
  }

  async fetchJob(job, session) {
    for (let attempt = 0; ; attempt++) {
      const { ctrl, release } = this.controller(session);
      let counted = 0;
      try {
        const range = job.byteRange
          ? { Range: `bytes=${job.byteRange.offset}-${job.byteRange.offset + job.byteRange.length - 1}` }
          : {};
        const res = await request(job.uri, { headers: this.requestHeaders(range), signal: ctrl.signal, auth: this.auth });
        if (!res.ok) throw new HttpError(res.status, res.statusText);
        const chunks = [];
        for await (const chunk of res.body) {
          if (session.cancelled) return;
          await this.ctx.limiter.consume(chunk.length, ctrl.signal);
          chunks.push(chunk);
          counted += chunk.length;
          this.recordBytes(chunk.length);
        }
        let data = Buffer.concat(chunks);
        // A server that ignored the Range header sent the whole file.
        if (job.byteRange && res.status === 200) {
          data = data.subarray(job.byteRange.offset, job.byteRange.offset + job.byteRange.length);
        }
        if (job.key) data = decryptAes128(data, await this.key(job.key.uri, ctrl.signal), segmentIv(job.segment));
        await fsp.writeFile(`${job.file}.tmp`, data);
        await fsp.rename(`${job.file}.tmp`, job.file);
        return;
      } catch (err) {
        this.downloadedBytes -= counted;
        if (session.cancelled) return;
        if (err.fatal || attempt >= MAX_RETRIES) throw err;
        await sleep(Math.min(1000 * 2 ** attempt, 15000), ctrl.signal);
      } finally {
        release();
      }
    }
  }

  key(uri, signal) {
    if (!this.keys.has(uri)) {
      const pending = (async () => {
        const res = await request(uri, { headers: this.requestHeaders(), signal, auth: this.auth });
        if (!res.ok) throw new HttpError(res.status, res.statusText);
        const key = Buffer.from(await res.arrayBuffer());
        if (key.length !== 16) throw new Error(`Invalid AES-128 key (${key.length} bytes)`);
        return key;
      })();
      pending.catch(() => this.keys.delete(uri));
      this.keys.set(uri, pending);
    }
    return this.keys.get(uri);
  }

  // Concatenates each track's segments in order, then muxes with FFmpeg or
  // keeps the raw tracks.
  async assemble(session, tracks, jobs) {
    const outputs = [];
    for (const [t, track] of tracks.entries()) {
      const file = path.join(this.tempDir, `track${t}${track.ext}`);
      const fh = await fsp.open(file, 'w');
      try {
        for (const job of jobs) if (job.track === t) await fh.write(await fsp.readFile(job.file));
      } finally {
        await fh.close();
      }
      outputs.push({ type: track.type, ext: track.ext, file });
    }
    if (session.cancelled) return;

    const directory = path.dirname(this.savePath);
    const base = this.savePath.slice(0, -path.extname(this.savePath).length);
    const ffmpeg = await this.ctx.ffmpeg();
    const needsMux = outputs.length > 1 || outputs[0].ext === '.ts';
    let finalPath = null;
    this.note = null;
    this.extraFiles = [];

    if (needsMux && ffmpeg) {
      const target = fs.existsSync(this.savePath) ? uniquePath(directory, path.basename(this.savePath)) : this.savePath;
      try {
        await mux(ffmpeg.path, outputs.map((o) => o.file), target);
        finalPath = target;
      } catch (err) {
        await fsp.rm(target, { force: true }).catch(() => {});
        this.note = `FFmpeg could not merge the tracks (${err.message}); the raw tracks were kept.`;
      }
    }
    if (!finalPath) {
      const [main, ...rest] = outputs;
      finalPath = uniquePath(directory, path.basename(base + main.ext));
      await fsp.rename(main.file, finalPath);
      for (const extra of rest) {
        const target = uniquePath(directory, path.basename(`${base}.${extra.type}${extra.ext}`));
        await fsp.rename(extra.file, target);
        this.extraFiles.push(target);
      }
      if (rest.length && !this.note) {
        this.note =
          'Audio and video were saved as separate files. Set up FFmpeg in Options → General to merge them automatically.';
      }
    }

    await fsp.rm(this.tempDir, { recursive: true, force: true });
    this.savePath = finalPath;
    this.fileName = path.basename(finalPath);
    this.totalBytes = fs.statSync(finalPath).size;
    this.downloadedBytes = this.totalBytes;
    this.completedAt = Date.now();
    this.setStatus('completed');
  }

  async deleteFiles({ includeCompleted = false } = {}) {
    const targets = [this.tempDir];
    if (includeCompleted && this.status === 'completed') targets.push(this.savePath, ...this.extraFiles);
    await this.removeFiles(targets);
  }

  // Segment progress folded into a fixed number of cells for the UI.
  pieces() {
    if (this.status === 'completed') return [1];
    if (!this.doneMap || !this.segmentsTotal) return [];
    const cells = Math.min(PIECE_CELLS, this.segmentsTotal);
    const out = new Array(cells).fill(0);
    for (let i = 0; i < this.doneMap.length; i++) {
      const cell = Math.floor((i / this.doneMap.length) * cells);
      out[cell] += this.doneMap[i] / Math.ceil(this.doneMap.length / cells);
    }
    return out.map((v) => Math.min(1, Math.round(v * 100) / 100));
  }

  toJSON() {
    return {
      ...super.toJSON(),
      quality: this.quality,
      segmentsTotal: this.segmentsTotal,
      segmentsDone: this.segmentsDone,
      streamInfo: this.streamInfo,
      extraFiles: this.extraFiles,
    };
  }

  snapshot() {
    return {
      ...super.snapshot(),
      segments: [],
      activeConnections: this.isActive ? this.session?.controllers.size || 0 : 0,
      sizeIsEstimate: this.status !== 'completed' && this.totalBytes != null,
      pieces: this.pieces(),
    };
  }
}

module.exports = { StreamDownload, streamBaseName };
