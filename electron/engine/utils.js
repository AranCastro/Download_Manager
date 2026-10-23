'use strict';

const fs = require('fs');
const path = require('path');

// Extension lists per category, modelled on the default categories of
// desktop download managers.
const CATEGORY_EXTENSIONS = {
  Compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'cab', 'arj', 'lzh', 'zst'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'epub', 'md'],
  Music: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aif', 'aiff'],
  Programs: ['exe', 'msi', 'msix', 'appx', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'bat', 'jar'],
  Video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts'],
};

const CATEGORIES = [...Object.keys(CATEGORY_EXTENSIONS), 'Other'];

const DOWNLOADABLE_EXTENSIONS = new Set(Object.values(CATEGORY_EXTENSIONS).flat());

function extensionOf(fileName) {
  const ext = path.extname(fileName || '').slice(1).toLowerCase();
  return ext;
}

function categorise(fileName) {
  const ext = extensionOf(fileName);
  for (const [category, exts] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (exts.includes(ext)) return category;
  }
  return 'Other';
}

// True when a string looks like a direct link to a downloadable file;
// used by the clipboard monitor.
function looksLikeDownloadUrl(text) {
  if (typeof text !== 'string' || text.length > 4096) return false;
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const name = decodeSafe(url.pathname.split('/').pop() || '');
  return DOWNLOADABLE_EXTENSIONS.has(extensionOf(name));
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function sanitiseFileName(name) {
  let clean = String(name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!clean) clean = 'download';
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  if (clean.length > 200) {
    const ext = path.extname(clean).slice(0, 20);
    clean = clean.slice(0, 200 - ext.length) + ext;
  }
  return clean;
}

// Parses RFC 6266 Content-Disposition, preferring filename* (RFC 5987).
function fileNameFromContentDisposition(header) {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    const value = decodeSafe(extended[2].trim().replace(/^"|"$/g, ''));
    if (value) return value;
  }
  const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare) return bare[1].trim();
  return null;
}

function fileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeSafe(last) : parsed.hostname;
  } catch {
    return null;
  }
}

function fileNameFromResponse(url, headers) {
  const fromHeader = fileNameFromContentDisposition(headers.get('content-disposition'));
  return sanitiseFileName(fromHeader || fileNameFromUrl(url) || 'download');
}

// Picks "name.ext", then "name (1).ext", "name (2).ext" ... so that neither
// the final file nor its partial file exists and no other download has
// reserved the same path.
function uniquePath(directory, fileName, reserved = new Set()) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(directory, i === 0 ? fileName : `${base} (${i})${ext}`);
    const taken =
      reserved.has(candidate) || fs.existsSync(candidate) || fs.existsSync(candidate + PART_SUFFIX);
    if (!taken) return candidate;
  }
}

const PART_SUFFIX = '.dmpart';

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

module.exports = {
  CATEGORIES,
  CATEGORY_EXTENSIONS,
  PART_SUFFIX,
  categorise,
  looksLikeDownloadUrl,
  sanitiseFileName,
  fileNameFromContentDisposition,
  fileNameFromUrl,
  fileNameFromResponse,
  uniquePath,
  sleep,
};
