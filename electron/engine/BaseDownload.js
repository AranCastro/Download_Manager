'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const { EventEmitter } = require('events');
const { AuthSession, describeError } = require('./http');
const { categorise, fileNameFromUrl, sanitiseFileName } = require('./utils');

const SPEED_WINDOW_MS = 3000;
const ACTIVE_STATUSES = new Set(['connecting', 'downloading', 'merging']);

// State and lifecycle shared by file downloads (HTTP/FTP) and stream
// downloads (HLS/DASH). Subclasses implement run(session).
class BaseDownload extends EventEmitter {
  constructor(data, ctx) {
    super();
    this.ctx = ctx;
    this.id = data.id || crypto.randomUUID();
    this.url = data.url;
    this.kind = data.kind || 'file';
    this.headers = data.headers || {};
    this.fileNameLocked = Boolean(data.fileNameLocked ?? data.fileName);
    // Until the server is probed, the URL gives a provisional name to display.
    this.fileName = data.fileName || sanitiseFileName(fileNameFromUrl(data.url));
    this.directory = data.directory || null;
    this.savePath = data.savePath || null;
    this.category = data.category || categorise(this.fileName);
    this.totalBytes = data.totalBytes ?? null;
    this.downloadedBytes = data.downloadedBytes || 0;
    this.connections = data.connections || 8;
    this.probed = data.probed ?? false;
    this.status = data.status || 'paused';
    this.error = data.error || null;
    this.note = data.note || null;
    this.fromSchedule = Boolean(data.fromSchedule);
    this.createdAt = data.createdAt || Date.now();
    this.completedAt = data.completedAt || null;
    this.lastTryAt = data.lastTryAt || null;

    this.auth = new AuthSession(() => ctx.credentialsFor(this));
    this.speedSamples = [];
    this.session = null;
  }

  get isActive() {
    return ACTIVE_STATUSES.has(this.status);
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit('status', this);
  }

  recordBytes(bytes) {
    this.downloadedBytes += bytes;
    this.speedSamples.push({ t: Date.now(), bytes });
  }

  // Bytes per second averaged over the last few seconds.
  get speed() {
    if (!this.isActive) return 0;
    const cutoff = Date.now() - SPEED_WINDOW_MS;
    while (this.speedSamples.length && this.speedSamples[0].t < cutoff) this.speedSamples.shift();
    const bytes = this.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
    return bytes / (SPEED_WINDOW_MS / 1000);
  }

  get eta() {
    const speed = this.speed;
    if (!speed || this.totalBytes == null) return null;
    return Math.max(0, (this.totalBytes - this.downloadedBytes) / speed);
  }

  async start() {
    if (this.isActive || this.status === 'completed') return;
    const session = { cancelled: false, controllers: new Set() };
    this.session = session;
    this.lastTryAt = Date.now();
    this.speedSamples = [];
    this.setStatus('connecting');
    try {
      await this.run(session);
    } catch (err) {
      if (session.cancelled) return;
      if (err.authRequired) this.setStatus('auth-required', err.message);
      else this.setStatus('error', describeError(err));
    } finally {
      if (this.session === session) this.session = null;
    }
  }

  pause(nextStatus = 'paused') {
    const session = this.session;
    if (session) {
      session.cancelled = true;
      for (const ctrl of session.controllers) ctrl.abort();
      this.session = null;
    }
    if (this.status !== 'completed') this.setStatus(nextStatus);
  }

  // An AbortController that pause() aborts along with the rest of the session.
  controller(session) {
    const ctrl = new AbortController();
    session.controllers.add(ctrl);
    const release = () => {
      ctrl.abort();
      session.controllers.delete(ctrl);
    };
    return { ctrl, release };
  }

  requestHeaders(extra) {
    return {
      'User-Agent': this.ctx.userAgent,
      'Accept-Encoding': 'identity',
      ...this.headers,
      ...extra,
    };
  }

  async removeFiles(paths) {
    for (const file of paths) {
      if (file) await fsp.rm(file, { recursive: true, force: true }).catch(() => {});
    }
  }

  toJSON() {
    return {
      id: this.id,
      url: this.url,
      kind: this.kind,
      fileName: this.fileName,
      fileNameLocked: this.fileNameLocked,
      directory: this.directory,
      savePath: this.savePath,
      category: this.category,
      totalBytes: this.totalBytes,
      downloadedBytes: this.downloadedBytes,
      connections: this.connections,
      probed: this.probed,
      status: this.status,
      error: this.error,
      note: this.note,
      fromSchedule: this.fromSchedule,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      lastTryAt: this.lastTryAt,
    };
  }

  snapshot() {
    return {
      ...this.toJSON(),
      hasLogin: Boolean(this.ctx.credentialsFor(this)),
      speed: this.speed,
      eta: this.eta,
    };
  }
}

module.exports = { BaseDownload, ACTIVE_STATUSES };
