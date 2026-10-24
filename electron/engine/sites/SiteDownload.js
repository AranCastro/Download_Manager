'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { BaseDownload } = require('../BaseDownload');
const { isAudio, downloadArgs, parseLine, describeFailure, cookieFile, siteName } = require('./ytdlp');

const PARTIAL = /\.(part|ytdl|temp)$|\.part-Frag\d+|\.f\d+\.\w+$/;

// A video page (YouTube and other yt-dlp sites). yt-dlp does the download;
// pausing stops the process and resuming continues its .part files.
class SiteDownload extends BaseDownload {
  constructor(data, ctx) {
    super({ ...data, kind: 'site', category: isAudio(data.quality) ? 'Music' : 'Video' }, ctx);
    this.quality = data.quality || 'best';
    this.siteInfo = data.siteInfo || null;
    this.partBase = data.partBase || null;
    if (!this.fileNameLocked && !data.siteInfo) this.fileName = siteName(this.url);
  }

  async run(session) {
    const tool = await this.ctx.ytdlp();
    if (!tool) {
      throw Object.assign(new Error('yt-dlp is not installed. Install it in Options → General (one click).'), { fatal: true });
    }
    const ffmpeg = await this.ctx.ffmpeg();
    const directory = this.directory || this.ctx.resolveDirectory(this.category);
    await fsp.mkdir(directory, { recursive: true });

    let cookiesPath = null;
    if (this.headers.Cookie) {
      cookiesPath = path.join(os.tmpdir(), `anabranch-cookies-${crypto.randomBytes(6).toString('hex')}.txt`);
      await fsp.writeFile(cookiesPath, cookieFile(this.headers.Cookie, this.url), { mode: 0o600 });
    }

    const args = downloadArgs({
      url: this.url,
      quality: this.quality,
      directory,
      fileName: this.fileNameLocked ? this.fileName.replace(/\.(mp4|m4a|mp3|webm|mkv)$/i, '') : null,
      hasFfmpeg: Boolean(ffmpeg),
      ffmpegLocation: ffmpeg && path.isAbsolute(ffmpeg.path) ? path.dirname(ffmpeg.path) : null,
      cookiesFile: cookiesPath,
      userAgent: this.headers['User-Agent'],
      connections: this.connections,
    });

    const { ctrl, release } = this.controller(session);
    const parts = new Map();
    let expected = null;
    let finalPath = null;
    let stderr = '';
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(tool.command, [...tool.args, ...args], { signal: ctrl.signal, windowsHide: true });
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          let nl;
          while ((nl = buffer.search(/\r?\n/)) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + (buffer[nl] === '\r' ? 2 : 1));
            const event = parseLine(line);
            if (!event || session.cancelled) continue;
            if (event.type === 'DMINFO') {
              this.siteInfo = { site: siteName(this.url), title: event.title, uploader: event.uploader, duration: event.duration, height: event.height, id: event.id };
              expected = event.expectedBytes;
              if (!this.fileNameLocked) this.fileName = `${event.title}${isAudio(this.quality) ? (this.quality === 'mp3' && ffmpeg ? '.mp3' : '.m4a') : '.mp4'}`;
            } else if (event.type === 'DMNAME') {
              this.savePath = event.path;
              this.partBase = event.path.replace(/\.[^.\\/]+$/, '');
            } else if (event.type === 'DMPROG') {
              const part = parts.get(event.formatId) || { downloaded: 0, total: null };
              const before = part.downloaded;
              part.downloaded = event.downloaded ?? part.downloaded;
              part.total = event.total ?? part.total;
              parts.set(event.formatId, part);
              if (part.downloaded > before) this.recordBytes(part.downloaded - before);
              this.downloadedBytes = [...parts.values()].reduce((s, p) => s + p.downloaded, 0);
              const known = [...parts.values()].reduce((s, p) => s + (p.total || p.downloaded), 0);
              this.totalBytes = Math.max(expected || 0, known) || null;
              if (this.status !== 'downloading') this.setStatus('downloading');
            } else if (event.type === 'DMPOST' && event.status === 'started') {
              if (this.status !== 'merging') this.setStatus('merging');
            } else if (event.type === 'DMFILE') {
              finalPath = event.path;
            }
          }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d) => {
          stderr = (stderr + d).slice(-6000);
        });
        child.on('error', reject);
        child.on('close', resolve);
      });
      if (session.cancelled) return;
      if (code !== 0 || !finalPath) {
        throw Object.assign(new Error(describeFailure(stderr || `yt-dlp exited with code ${code}`)), { fatal: true });
      }
    } catch (err) {
      if (session.cancelled || err.name === 'AbortError') return;
      throw err;
    } finally {
      release();
      if (cookiesPath) await fsp.rm(cookiesPath, { force: true }).catch(() => {});
    }

    const size = fs.statSync(finalPath).size;
    this.savePath = finalPath;
    this.fileName = path.basename(finalPath);
    this.category = isAudio(this.quality) ? 'Music' : 'Video';
    this.totalBytes = size;
    this.downloadedBytes = size;
    this.completedAt = Date.now();
    this.setStatus('completed');
    // An interrupted fragment can leave a stale ".part-FragN.part" behind.
    await this.deleteFiles();
  }

  // Partial files share the output name: "<name>.f137.mp4.part", "<name>.mp4.ytdl"…
  async deleteFiles({ includeCompleted = false } = {}) {
    if (!this.partBase) return;
    const dir = path.dirname(this.partBase);
    const base = path.basename(this.partBase);
    const targets = [];
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!name.startsWith(base)) continue;
      const full = path.join(dir, name);
      const isFinal = this.status === 'completed' && full === this.savePath;
      if (PARTIAL.test(name) || (isFinal && includeCompleted)) targets.push(full);
    }
    await this.removeFiles(targets);
  }

  toJSON() {
    return { ...super.toJSON(), quality: this.quality, siteInfo: this.siteInfo, partBase: this.partBase };
  }

  snapshot() {
    return {
      ...super.snapshot(),
      segments: [],
      activeConnections: this.isActive ? 1 : 0,
      sizeIsEstimate: this.status !== 'completed' && this.totalBytes != null,
    };
  }
}

module.exports = { SiteDownload };
