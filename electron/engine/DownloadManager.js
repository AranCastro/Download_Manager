'use strict';

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { Download } = require('./Download');
const { StreamDownload, streamBaseName } = require('./streams/StreamDownload');
const { probeHls } = require('./streams/hls');
const { probeDash } = require('./streams/dash');
const { HttpError, request, describeError } = require('./http');
const { RateLimiter } = require('./RateLimiter');
const { CredentialStore, siteKey } = require('./CredentialStore');
const { Scheduler, DEFAULT_SCHEDULE, normaliseSchedule } = require('./Scheduler');
const { findFfmpeg } = require('./ffmpeg');
const { categorise } = require('./utils');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0 Safari/537.36 DownloadManager/1.1';

const DEFAULT_SETTINGS = {
  downloadDir: path.join(os.homedir(), 'Downloads'),
  categoryFolders: true,
  maxConcurrent: 3,
  connections: 8,
  speedLimitKBps: 0,
  clipboardMonitor: true,
  notifyOnComplete: true,
  apiPort: 6801,
  ffmpegPath: '',
  schedule: DEFAULT_SCHEDULE,
  // Appearance and window behaviour (used by the UI and the main process).
  theme: 'system',
  accent: 'blue',
  density: 'comfortable',
  closeToTray: false,
};

const THEMES = ['system', 'light', 'dark'];
const ACCENTS = ['blue', 'violet', 'teal', 'green', 'orange', 'rose'];
const DENSITIES = ['comfortable', 'compact'];

const LIMITS = {
  maxConcurrent: [1, 20],
  connections: [1, 32],
  speedLimitKBps: [0, 10_000_000],
  apiPort: [1024, 65535],
};

const PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'ftps:']);
const KINDS = new Set(['file', 'hls', 'dash']);
const QUALITIES = /^(best|worst|\d{3,4})$/;
// Headers a caller may not override: they would break range requests.
const BLOCKED_HEADERS = new Set(['host', 'range', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']);

function clamp(value, [min, max]) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function detectKind(url, requested) {
  if (KINDS.has(requested)) return requested;
  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith('.m3u8')) return 'hls';
  if (pathname.endsWith('.mpd')) return 'dash';
  return 'file';
}

function cleanHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !/^[\w-]+$/.test(name)) continue;
    if (BLOCKED_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value.replace(/[\r\n]/g, ' ');
  }
  return out;
}

// Owns every download: queue order, the concurrency limit, the shared speed
// limiter, the scheduler, saved logins and persistence to <dataDir>.
class DownloadManager extends EventEmitter {
  constructor({ dataDir, settings = {}, encrypt, decrypt, now }) {
    super();
    this.dataDir = dataDir;
    this.settings = this.normaliseSettings({ ...DEFAULT_SETTINGS, ...settings });
    this.downloads = new Map();
    this.limiter = new RateLimiter();
    this.secrets = new CredentialStore(path.join(dataDir, 'credentials.json'), { encrypt, decrypt });
    this.scheduler = new Scheduler(() => this.settings.schedule, now);
    this.scheduleRunning = false;
    this.scheduleCompleted = 0;
    this.ffmpegLookup = null;
    this.saveTimer = null;
    this.saving = Promise.resolve();
    this.ticker = null;
    this.ctx = {
      limiter: this.limiter,
      userAgent: USER_AGENT,
      resolveDirectory: (category) =>
        this.settings.categoryFolders
          ? path.join(this.settings.downloadDir, category)
          : this.settings.downloadDir,
      reservedPaths: (self) =>
        new Set(
          [...this.downloads.values()]
            .filter((d) => d !== self && d.status !== 'completed' && d.savePath)
            .map((d) => d.savePath),
        ),
      credentialsFor: (d) => this.secrets.get(`download:${d.id}`) || this.secrets.get(siteKey(d.url)),
      ffmpeg: () => this.ffmpeg(),
    };
    this.scheduler.on('start', () => this.runSchedule());
    this.scheduler.on('stop', () => this.stopSchedule());
  }

  get settingsFile() {
    return path.join(this.dataDir, 'settings.json');
  }

  get downloadsFile() {
    return path.join(this.dataDir, 'downloads.json');
  }

  async init({ startScheduler = true } = {}) {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await this.secrets.load();
    const saved = await readJson(this.settingsFile);
    if (saved) this.settings = this.normaliseSettings({ ...this.settings, ...saved });
    this.limiter.setRate(this.settings.speedLimitKBps * 1024);

    const list = (await readJson(this.downloadsFile)) || [];
    for (const data of list) {
      // Anything that was running when the app closed waits for the user,
      // or for the next scheduler window if the scheduler started it.
      if (['connecting', 'downloading', 'merging', 'queued'].includes(data.status)) {
        data.status = data.fromSchedule ? 'scheduled' : 'paused';
      }
      data.headers = this.secrets.get(`headers:${data.id}`) || {};
      this.attach(this.create(data));
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
    if (startScheduler) this.scheduler.start();
    return this;
  }

  create(data, ctx = this.ctx) {
    return data.kind === 'hls' || data.kind === 'dash' ? new StreamDownload(data, ctx) : new Download(data, ctx);
  }

  attach(download) {
    this.downloads.set(download.id, download);
    download.on('status', (d) => {
      if (d.status === 'completed') {
        if (d.fromSchedule) this.scheduleCompleted++;
        this.emit('completed', d.snapshot());
      }
      if (d.status === 'error') this.emit('failed', d.snapshot());
      if (d.status === 'auth-required') this.emit('auth-required', d.snapshot());
      this.changed();
      if (!d.isActive) {
        this.pump();
        this.checkScheduleFinished();
      }
    });
  }

  // Validates a URL; credentials embedded in it are split off.
  parseTarget(url, kind) {
    let parsed;
    try {
      parsed = new URL(String(url || '').trim());
    } catch {
      throw new Error('A valid http(s) or ftp URL is required');
    }
    if (!PROTOCOLS.has(parsed.protocol)) throw new Error('Only http, https, ftp and ftps URLs are supported');
    const detected = detectKind(parsed, kind);
    if (detected !== 'file' && !parsed.protocol.startsWith('http')) {
      throw new Error('HLS and DASH streams must use http or https');
    }
    const urlLogin = parsed.username
      ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
      : null;
    parsed.username = '';
    parsed.password = '';
    return { parsed, detected, urlLogin };
  }

  // Looks at a URL without downloading it: name, size, resumability, and for
  // streams the available qualities and duration. Never throws for server
  // answers; problems come back as { error } or { authRequired }.
  async probe({ url, kind, headers, username, password } = {}) {
    const { parsed, detected, urlLogin } = this.parseTarget(url, kind);
    const login = username ? { username: String(username), password: String(password ?? '') } : urlLogin;
    const ctx = {
      ...this.ctx,
      credentialsFor: (d) => login || this.ctx.credentialsFor(d),
    };
    const draft = this.create({ url: parsed.href, kind: detected, headers: cleanHeaders(headers) }, ctx);
    const signal = AbortSignal.timeout(20000);
    const base = { url: parsed.href, kind: detected };
    try {
      if (detected === 'file') {
        const info = await draft.transport.probe(draft, signal);
        return {
          ...base,
          fileName: info.fileName,
          totalBytes: info.totalBytes,
          resumable: info.resumable,
          category: categorise(info.fileName),
        };
      }
      const fetchText = async (u) => {
        const res = await request(u, { headers: draft.requestHeaders(), signal, auth: draft.auth });
        if (!res.ok) throw new HttpError(res.status, res.statusText);
        return res.text();
      };
      const info = await (detected === 'dash' ? probeDash : probeHls)(parsed.href, fetchText);
      return { ...base, ...info, fileName: `${streamBaseName(parsed.href)}.mp4`, category: 'Video', resumable: true };
    } catch (err) {
      if (err.authRequired) return { ...base, authRequired: true, realm: err.realm, error: err.message };
      return { ...base, error: err.name === 'TimeoutError' ? 'The server did not answer in time' : describeError(err) };
    }
  }

  add({ url, fileName, directory, connections, headers, start = true, schedule = false, kind, quality, username, password } = {}) {
    // Credentials in the URL are moved to the encrypted store.
    const { parsed, detected, urlLogin } = this.parseTarget(url, kind);

    const download = this.create({
      url: parsed.href,
      kind: detected,
      fileName: fileName ? String(fileName) : null,
      directory: directory ? path.resolve(String(directory)) : null,
      connections: clamp(connections ?? this.settings.connections, LIMITS.connections),
      quality: QUALITIES.test(String(quality)) ? String(quality) : 'best',
      headers: cleanHeaders(headers),
      status: schedule ? 'scheduled' : start ? 'queued' : 'paused',
    });
    const login = username ? { username: String(username), password: String(password ?? '') } : urlLogin;
    if (login) this.secrets.set(`download:${download.id}`, login);
    if (Object.keys(download.headers).length) this.secrets.set(`headers:${download.id}`, download.headers);
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
    download.fromSchedule = false;
    download.setStatus('queued');
    this.pump();
    return download.snapshot();
  }

  pause(id) {
    const download = this.get(id);
    if (download.status !== 'completed') {
      download.fromSchedule = false;
      download.pause();
    }
    return download.snapshot();
  }

  // Saves a login for one download (and optionally its whole site), then retries.
  async setCredentials(id, { username, password = '', remember = false } = {}) {
    const download = this.get(id);
    if (!username) throw new Error('A user name is required');
    const login = { username: String(username), password: String(password) };
    await this.secrets.set(`download:${id}`, login);
    if (remember) await this.secrets.set(siteKey(download.url), login);
    download.auth.challenge = null;
    if (download.status === 'auth-required' || download.status === 'error') return this.resume(id);
    return download.snapshot();
  }

  resumeAll() {
    for (const d of this.downloads.values()) {
      const retryable = d.status === 'paused' || d.status === 'error';
      const loginReady = d.status === 'auth-required' && this.ctx.credentialsFor(d);
      if (retryable || loginReady) {
        d.fromSchedule = false;
        d.setStatus('queued');
      }
    }
    this.pump();
  }

  pauseAll() {
    for (const d of this.downloads.values()) {
      if (d.isActive || d.status === 'queued') {
        d.fromSchedule = false;
        d.pause();
      }
    }
  }

  // Moves downloads into the scheduled queue; they start in the next window.
  schedule(ids) {
    for (const id of ids) {
      const d = this.get(id);
      if (d.status === 'completed') continue;
      if (d.isActive) d.pause('scheduled');
      else d.setStatus('scheduled');
    }
    return ids.map((id) => this.get(id).snapshot());
  }

  // Scheduler window opened (or "Start now"): queue every scheduled download.
  runSchedule() {
    let started = 0;
    for (const d of this.downloads.values()) {
      if (d.status === 'scheduled') {
        d.fromSchedule = true;
        d.setStatus('queued');
        started++;
      }
    }
    this.scheduleRunning = started > 0;
    this.scheduleCompleted = 0;
    this.emit('schedule-started', started);
    this.pump();
    return started;
  }

  // Scheduler window closed: put scheduler-started downloads back on hold.
  stopSchedule() {
    this.scheduleRunning = false;
    for (const d of this.downloads.values()) {
      if (d.fromSchedule && (d.isActive || d.status === 'queued')) d.pause('scheduled');
    }
  }

  checkScheduleFinished() {
    if (!this.scheduleRunning) return;
    const pending = [...this.downloads.values()].some((d) => d.fromSchedule && (d.isActive || d.status === 'queued'));
    if (pending) return;
    this.scheduleRunning = false;
    for (const d of this.downloads.values()) d.fromSchedule = false;
    // The after-done action (quit, sleep, shut down) only follows a run that
    // completed something, not one the user stopped by hand.
    if (this.scheduleCompleted > 0) this.emit('schedule-finished', this.settings.schedule.afterDone);
  }

  async remove(id, { deleteFile = false } = {}) {
    const download = this.get(id);
    download.pause();
    download.removeAllListeners('status');
    this.downloads.delete(id);
    await download.deleteFiles({ includeCompleted: deleteFile });
    await this.secrets.set(`download:${id}`, null);
    await this.secrets.set(`headers:${id}`, null);
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

  ffmpeg() {
    if (!this.ffmpegLookup) this.ffmpegLookup = findFfmpeg(this.settings.ffmpegPath);
    return this.ffmpegLookup;
  }

  normaliseSettings(input) {
    const s = { ...DEFAULT_SETTINGS, ...input };
    for (const [key, range] of Object.entries(LIMITS)) s[key] = clamp(s[key], range);
    s.downloadDir = path.resolve(String(s.downloadDir || DEFAULT_SETTINGS.downloadDir));
    s.categoryFolders = Boolean(s.categoryFolders);
    s.clipboardMonitor = Boolean(s.clipboardMonitor);
    s.notifyOnComplete = Boolean(s.notifyOnComplete);
    s.ffmpegPath = String(s.ffmpegPath || '').trim();
    s.schedule = normaliseSchedule(s.schedule);
    s.theme = THEMES.includes(s.theme) ? s.theme : 'system';
    s.accent = ACCENTS.includes(s.accent) ? s.accent : 'blue';
    s.density = DENSITIES.includes(s.density) ? s.density : 'comfortable';
    s.closeToTray = Boolean(s.closeToTray);
    return s;
  }

  async updateSettings(patch = {}) {
    const known = Object.fromEntries(Object.entries(patch).filter(([key]) => key in DEFAULT_SETTINGS));
    if (known.schedule) known.schedule = { ...this.settings.schedule, ...known.schedule };
    const previousFfmpeg = this.settings.ffmpegPath;
    this.settings = this.normaliseSettings({ ...this.settings, ...known });
    if (this.settings.ffmpegPath !== previousFfmpeg) this.ffmpegLookup = null;
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
    this.scheduler.stop();
    // Quitting must never look like a finished scheduled run.
    this.scheduleRunning = false;
    for (const d of this.downloads.values()) {
      if (d.isActive) d.pause(d.fromSchedule ? 'scheduled' : 'paused');
    }
    await this.save();
    await this.secrets.writing;
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
