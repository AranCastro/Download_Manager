'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');

// External tools the app can use: yt-dlp (video sites such as YouTube) and
// FFmpeg (merging audio and video). Both are found on PATH, at a configured
// path, or in the app's own tools folder after a one-click install.

const YTDLP_ASSETS = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux',
};
const YTDLP_URL = (asset) => `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
const FFMPEG_WIN_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

// Runs `bin --version` (or the given args) and returns the first output line.
function versionOf(command, args = ['--version']) {
  return new Promise((resolve, reject) => {
    let out = '';
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim().split(/\r?\n/)[0]);
      else reject(new Error(`exit ${code}`));
    });
  });
}

// A tool is a command plus fixed leading arguments (tests point yt-dlp at a
// script run by Node this way).
async function findYtDlp({ preferred, toolsDir, override } = {}) {
  if (override) {
    const version = await versionOf(override.command, [...(override.args || []), '--version']).catch(() => null);
    return version ? { command: override.command, args: override.args || [], version } : null;
  }
  const candidates = [preferred, toolsDir && path.join(toolsDir, exe('yt-dlp')), 'yt-dlp'].filter(Boolean);
  for (const command of candidates) {
    if (path.isAbsolute(command) && !fs.existsSync(command)) continue;
    const version = await versionOf(command).catch(() => null);
    if (version) return { command, args: [], version };
  }
  return null;
}

// Downloads a URL to a file (following redirects), reporting progress.
async function fetchToFile(url, file, { onProgress, signal } = {}) {
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || null;
  const temp = `${file}.download`;
  const fh = await fsp.open(temp, 'w');
  let done = 0;
  try {
    for await (const chunk of res.body) {
      await fh.write(chunk);
      done += chunk.length;
      onProgress?.({ done, total });
    }
  } finally {
    await fh.close();
  }
  await fsp.rename(temp, file);
}

async function installYtDlp(toolsDir, options = {}) {
  const asset = YTDLP_ASSETS[process.platform];
  if (!asset) throw new Error(`No yt-dlp build for ${process.platform}`);
  await fsp.mkdir(toolsDir, { recursive: true });
  const target = path.join(toolsDir, exe('yt-dlp'));
  await fetchToFile(YTDLP_URL(asset), target, options);
  if (process.platform !== 'win32') await fsp.chmod(target, 0o755);
  return target;
}

// Windows only: the BtbN static build, unpacked with the tar that ships with
// Windows 10 and later (it reads zip archives).
async function installFfmpeg(toolsDir, options = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Install FFmpeg with your package manager (for example apt install ffmpeg or brew install ffmpeg).');
  }
  await fsp.mkdir(toolsDir, { recursive: true });
  const zip = path.join(toolsDir, 'ffmpeg.zip');
  const unpack = path.join(toolsDir, 'ffmpeg-unpack');
  await fetchToFile(FFMPEG_WIN_URL, zip, options);
  await fsp.rm(unpack, { recursive: true, force: true });
  await fsp.mkdir(unpack);
  await new Promise((resolve, reject) =>
    execFile('tar', ['-xf', zip, '-C', unpack], { windowsHide: true }, (err) => (err ? reject(err) : resolve())),
  );
  // ffprobe is needed too: yt-dlp uses it when extracting audio.
  const target = path.join(toolsDir, 'ffmpeg.exe');
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    const found = findFile(unpack, name);
    if (!found) throw new Error(`${name} was not found in the downloaded archive`);
    await fsp.copyFile(found, path.join(toolsDir, name));
  }
  await fsp.rm(unpack, { recursive: true, force: true });
  await fsp.rm(zip, { force: true });
  return target;
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

module.exports = { findYtDlp, installYtDlp, installFfmpeg, versionOf, fetchToFile, YTDLP_ASSETS };
