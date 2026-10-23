'use strict';

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { Download } = require('./Download');
const { RateLimiter } = require('./RateLimiter');

const DEFAULT_SETTINGS = {
  downloadDir: path.join(os.homedir(), 'Downloads'),
  categoryFolders: true,
  maxConcurrent: 3,
  connections: 8,
  speedLimitKBps: 0,
  clipboardMonitor: true,
  notifyOnComplete: true,
  apiPort: 6801,
};

const LIMITS = {
  maxConcurrent: [1, 20],
  connections: [1, 32],
  speedLimitKBps: [0, 10_000_000],
  apiPort: [1024, 65535],
};

function clamp(value, [min, max]) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// Owns every download: queue order, the concurrency limit, the shared speed
// limiter and persistence to <dataDir>/downloads.json and settings.json.
class DownloadManager extends EventEmitter {
  constructor({ dataDir, settings = {} }) {
    super();
    this.dataDir = dataDir;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.downloads = new Map();
    this.limiter = new RateLimiter();
    this.saveTimer = null;
    this.saving = Promise.resolve();
    this.ticker = null;
    this.ctx = {
      limiter: this.limiter,
      resolveDirectory: (category) =>
        this.settings.categoryFolders
          ? path.join(this.settings.downloadDir, category)
          : this.settings.downloadDir,
      reservedPaths: () =>
        new Set(
          [...this.downloads.values()]
            .filter((d) => d.status !== 'completed' && d.savePath)
            .map((d) => d.savePath),
        ),
    };
  }

  get settingsFile() {
    return path.join(this.dataDir, 'settings.json');
  }

  get downloadsFile() {
    return path.join(this.dataDir, 'downloads.json');
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    const saved = await readJson(this.settingsFile);
    if (saved) this.settings = this.normaliseSettings({ ...this.settings, ...saved });
    this.limiter.setRate(this.settings.speedLimitKBps * 1024);

    const list = (await readJson(this.downloadsFile)) || [];
    for (const data of list) {
      // Anything that was running when the app closed resumes as paused.
      if (['connecting', 'downloading', 'queued'].includes(data.status)) data.status = 'paused';
      this.attach(new Download(data, this.ctx));
    }
    // Progress ticks drive the UI; resume state is flushed every few seconds.
    let ticks = 0;
    this.ticker = setInterval(() => {
      const active = [...this.downloads.values()].some((d) => d.isActive);
      if (!active) return;
      this.emit('progress');
      if (++ticks % 5 === 0) this.save();
    }, 1000);
    this.ticker.unref?.();
    return this;
  }

  attach(download) {
    this.downloads.set(download.id, download);
    download.on('status', (d) => {
      if (d.status === 'completed') this.emit('completed', d.snapshot());
      if (d.status === 'error') this.emit('failed', d.snapshot());
      this.changed();
      if (!d.isActive) this.pump();
    });
  }

  add({ url, fileName, directory, connections, headers, start = true } = {}) {
    let parsed;
    try {
      parsed = new URL(String(url || '').trim());
    } catch {
      throw new Error('A valid http(s) URL is required');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http and https URLs are supported');
    }
    const download = new Download(
      {
        url: parsed.href,
        fileName: fileName ? String(fileName) : null,
        directory: directory ? path.resolve(String(directory)) : null,
        connections: clamp(connections ?? this.settings.connections, LIMITS.connections),
        headers: headers && typeof headers === 'object' ? headers : {},
        status: start ? 'queued' : 'paused',
      },
      this.ctx,
    );
    this.attach(download);
    this.changed();
    this.pump();
    return download.snapshot();
  }

  get(id) {
    const download = this.downloads.get(id);
    if (!download) throw new Error(`No download with id ${id}`);
    return download;
  }

  resume(id) {
    const download = this.get(id);
    if (download.isActive || download.status === 'completed' || download.status === 'queued') {
      return download.snapshot();
    }
    download.setStatus('queued');
    this.pump();
    return download.snapshot();
  }

  pause(id) {
    const download = this.get(id);
    if (download.status !== 'completed') download.pause();
    return download.snapshot();
  }

  resumeAll() {
    for (const d of this.downloads.values()) {
      if (d.status === 'paused' || d.status === 'error') d.setStatus('queued');
    }
    this.pump();
  }

  pauseAll() {
    for (const d of this.downloads.values()) {
      if (d.isActive || d.status === 'queued') d.pause();
    }
  }

  async remove(id, { deleteFile = false } = {}) {
    const download = this.get(id);
    download.pause();
    download.removeAllListeners('status');
    this.downloads.delete(id);
    await download.deleteFiles({ includeCompleted: deleteFile });
    this.changed();
    this.pump();
  }

  async removeCompleted() {
    for (const d of [...this.downloads.values()]) {
      if (d.status === 'completed') await this.remove(d.id);
    }
  }

  // Starts queued downloads in the order they were added until the
  // concurrency limit is reached.
  pump() {
    let running = [...this.downloads.values()].filter((d) => d.isActive).length;
    for (const d of this.downloads.values()) {
      if (running >= this.settings.maxConcurrent) break;
      if (d.status === 'queued') {
        running++;
        d.start();
      }
    }
  }

  list() {
    return [...this.downloads.values()].map((d) => d.snapshot());
  }

  normaliseSettings(input) {
    const s = { ...DEFAULT_SETTINGS, ...input };
    for (const [key, range] of Object.entries(LIMITS)) s[key] = clamp(s[key], range);
    s.downloadDir = path.resolve(String(s.downloadDir || DEFAULT_SETTINGS.downloadDir));
    s.categoryFolders = Boolean(s.categoryFolders);
    s.clipboardMonitor = Boolean(s.clipboardMonitor);
    s.notifyOnComplete = Boolean(s.notifyOnComplete);
    return s;
  }

  async updateSettings(patch = {}) {
    const known = Object.fromEntries(
      Object.entries(patch).filter(([key]) => key in DEFAULT_SETTINGS),
    );
    this.settings = this.normaliseSettings({ ...this.settings, ...known });
    this.limiter.setRate(this.settings.speedLimitKBps * 1024);
    await writeJson(this.settingsFile, this.settings);
    this.emit('settings', this.settings);
    this.pump();
    return this.settings;
  }

  changed() {
    this.emit('changed');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1000);
  }

  // Progress is saved periodically too, so a crash loses little resume state.
  // Saves are chained so two writes never race on the same temporary file.
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const list = [...this.downloads.values()].map((d) => d.toJSON());
    this.saving = this.saving
      .then(() => writeJson(this.downloadsFile, list))
      .catch((err) => this.emit('error-log', err));
    return this.saving;
  }

  async shutdown() {
    clearInterval(this.ticker);
    for (const d of this.downloads.values()) {
      if (d.isActive) d.pause();
    }
    await this.save();
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// Write to a temporary file and rename, so a crash never leaves half a file.
async function writeJson(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2));
  await fsp.rename(temp, file);
}

module.exports = { DownloadManager, DEFAULT_SETTINGS, readJson, writeJson };
