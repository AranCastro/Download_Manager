'use strict';

const { sanitiseFileName } = require('../utils');

// Video sites (YouTube and others) are handled by yt-dlp, which keeps up with
// the sites' frequent player changes. This module builds its arguments and
// reads its machine-readable output; SiteDownload runs it.

const SITE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

function isSiteUrl(url) {
  try {
    return SITE_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function siteName(url) {
  try {
    const host = new URL(url).hostname.replace(/^(www|m|music)\./, '');
    return SITE_HOSTS.test(host) ? 'YouTube' : host;
  } catch {
    return 'Video site';
  }
}

const isAudio = (quality) => quality === 'audio' || quality === 'mp3';

// Format choice. With FFmpeg, the best video and audio streams are merged
// into MP4 (H.264/AAC preferred for compatibility); without it only
// single-file formats can be used, which on YouTube means 360p at most.
function formatArgs(quality, hasFfmpeg) {
  if (quality === 'mp3') {
    return hasFfmpeg ? ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'] : ['-f', 'ba[ext=m4a]/ba/b'];
  }
  if (quality === 'audio') return ['-f', 'ba[ext=m4a]/ba/b'];
  const height = Number(quality);
  const limited = Number.isFinite(height) && height > 0;
  if (!hasFfmpeg) return ['-f', limited ? `b[height<=${height}]/b` : 'b'];
  return ['-f', 'bv*+ba/b', '-S', limited ? `res:${height},ext:mp4:m4a` : 'res,ext:mp4:m4a', '--merge-output-format', 'mp4'];
}

const PROGRESS = 'download:DMPROG %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(info.format_id)s';
const POSTPROCESS = 'postprocess:DMPOST %(progress.status)s|%(progress.postprocessor)s';
const INFO = 'before_dl:DMINFO %(title)s|%(uploader,channel)s|%(duration)s|%(height)s|%(id)s|%(filesize,filesize_approx)s';

// hasFfmpeg: FFmpeg can be used at all. ffmpegLocation: the folder holding
// ffmpeg and ffprobe, passed only when known (an FFmpeg on PATH is found by
// yt-dlp itself, and a bare command name is not a location).
function downloadArgs({ url, quality, directory, fileName, hasFfmpeg, ffmpegLocation, cookiesFile, userAgent, connections }) {
  const name = fileName ? `${sanitiseFileName(fileName).replace(/%/g, '%%')}.%(ext)s` : '%(title).150B [%(id)s].%(ext)s';
  const args = [
    '--newline',
    '--no-colors',
    '--no-playlist',
    '--no-mtime',
    '--windows-filenames',
    '--continue',
    '--quiet',
    '--progress',
    '--progress-template', PROGRESS,
    '--progress-template', POSTPROCESS,
    '--print', INFO,
    '--print', 'before_dl:DMNAME %(filename)s',
    '--print', 'after_move:DMFILE %(filepath)s',
    '-N', String(Math.max(1, Math.min(16, connections || 4))),
    '-P', directory,
    '-o', name,
    ...formatArgs(quality, Boolean(hasFfmpeg)),
  ];
  if (hasFfmpeg && ffmpegLocation) args.push('--ffmpeg-location', ffmpegLocation);
  if (cookiesFile) args.push('--cookies', cookiesFile);
  if (userAgent) args.push('--user-agent', userAgent);
  args.push('--', url);
  return args;
}

function probeArgs(url, { cookiesFile } = {}) {
  const args = ['-J', '--no-warnings', '--no-playlist', '--flat-playlist'];
  if (cookiesFile) args.push('--cookies', cookiesFile);
  args.push('--', url);
  return args;
}

const num = (v) => (v == null || v === 'NA' || v === 'None' || v === '' ? null : Number(v));

// One DMPROG/DMPOST/DMINFO/DMNAME/DMFILE line → an event, or null.
function parseLine(line) {
  const m = /^(DMPROG|DMPOST|DMINFO|DMNAME|DMFILE) (.*)$/.exec(line.trim());
  if (!m) return null;
  const [, type, rest] = m;
  if (type === 'DMNAME' || type === 'DMFILE') return { type, path: rest };
  const parts = rest.split('|');
  if (type === 'DMPROG') {
    return {
      type,
      status: parts[0],
      downloaded: num(parts[1]),
      total: num(parts[2]) ?? num(parts[3]),
      formatId: parts[4],
    };
  }
  if (type === 'DMPOST') return { type, status: parts[0], postprocessor: parts[1] };
  // The title may itself contain "|", so read the fixed fields from the end.
  const tail = parts.slice(-5);
  return {
    type,
    title: parts.slice(0, parts.length - 5).join('|'),
    uploader: tail[0] === 'NA' ? null : tail[0],
    duration: num(tail[1]),
    height: num(tail[2]),
    id: tail[3],
    expectedBytes: num(tail[4]),
  };
}

// yt-dlp -J output → what the Add dialog shows.
function parseProbe(json, url) {
  const site = siteName(url);
  if (json._type === 'playlist') {
    const entries = (json.entries || [])
      .filter((e) => e && (e.url || e.id))
      .map((e) => ({
        url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
        title: e.title || e.id,
        duration: e.duration ?? null,
      }));
    return { kind: 'site', site, playlist: { title: json.title || 'Playlist', count: entries.length }, entries, category: 'Video' };
  }
  if (json.is_live || json.live_status === 'is_live') {
    return { kind: 'site', site, error: 'Live streams cannot be downloaded yet' };
  }
  const formats = json.formats || [];
  if (formats.length && formats.every((f) => f.has_drm)) {
    return { kind: 'site', site, error: 'This video is DRM-protected and cannot be downloaded' };
  }
  const byHeight = new Map();
  for (const f of formats) {
    if (!f.height || f.vcodec === 'none' || f.has_drm) continue;
    const current = byHeight.get(f.height);
    const bitrate = (f.tbr || f.vbr || 0) * 1000;
    if (!current || bitrate > current.bandwidth) byHeight.set(f.height, { height: f.height, width: f.width || null, bandwidth: bitrate });
  }
  const title = json.title || json.id || 'video';
  return {
    kind: 'site',
    site,
    title,
    fileName: `${sanitiseFileName(title)}.mp4`,
    uploader: json.uploader || json.channel || null,
    duration: json.duration ?? null,
    thumbnail: json.thumbnail || null,
    qualities: [...byHeight.values()].sort((a, b) => b.height - a.height),
    totalBytes: json.filesize ?? json.filesize_approx ?? null,
    resumable: true,
    category: 'Video',
  };
}

// The last ERROR line of yt-dlp, rewritten where a clearer next step exists.
function describeFailure(stderr) {
  const line =
    stderr
      .split(/\r?\n/)
      .reverse()
      .find((l) => /^ERROR:/.test(l)) || stderr.trim().split(/\r?\n/).pop() || 'yt-dlp failed';
  if (/confirm you.?re not a bot|Sign in to confirm/i.test(line)) {
    return 'YouTube asked to confirm you are not a bot. Send the video from the browser extension (it passes your YouTube sign-in) and try again.';
  }
  if (/Private video|members|Join this channel|age|inappropriate/i.test(line)) {
    return 'This video needs a signed-in account with access. Send it from the browser extension while signed in to YouTube.';
  }
  if (/DRM/i.test(line)) return 'This video is DRM-protected and cannot be downloaded.';
  if (/Requested format is not available/i.test(line)) return 'That quality is not available for this video. Choose another quality.';
  return line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '');
}

// A Netscape-format cookie file from a Cookie header, for yt-dlp --cookies.
function cookieFile(cookieHeader, url) {
  const host = new URL(url).hostname;
  const domain = SITE_HOSTS.test(host) ? '.youtube.com' : `.${host.replace(/^www\./, '')}`;
  const lines = ['# Netscape HTTP Cookie File'];
  for (const pair of cookieHeader.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    lines.push([domain, 'TRUE', '/', 'TRUE', '0', pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  isSiteUrl,
  siteName,
  isAudio,
  formatArgs,
  downloadArgs,
  probeArgs,
  parseLine,
  parseProbe,
  describeFailure,
  cookieFile,
};
