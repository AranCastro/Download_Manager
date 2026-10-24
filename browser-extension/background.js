// Anabranch browser integration (Chrome, Edge, Firefox).
//
// - Hands file downloads over to the desktop app (with cookies and referrer,
//   so links that need a browser session still work).
// - Adds "Download with Anabranch" and "Download all links" menus.
// - Detects HLS/DASH streams and video files a page loads and lists them in
//   the toolbar panel.
// - Puts a Download button on YouTube's player (youtube.js) and sends the
//   video page to the app, which downloads it with yt-dlp.
//
// The app is reached at http://127.0.0.1:<port>; the token comes from a
// one-time pairing the user approves in the app.

const ext = globalThis.browser ?? globalThis.chrome;
const action = ext.action ?? ext.browserAction;

const DEFAULTS = {
  capture: true,
  confirm: true,
  port: 6801,
  token: '',
  types:
    'zip rar 7z tar gz tgz bz2 xz iso img exe msi msix apk dmg pkg deb rpm appimage ' +
    'pdf doc docx xls xlsx ppt pptx odt ods epub csv ' +
    'mp3 flac wav aac m4a ogg opus mp4 mkv avi mov wmv webm flv m4v ' +
    'tif tiff nc hdf h5 he5 grib grb2 gpkg kmz las laz dem jp2',
  minSizeKB: 0,
  skipHosts: '',
};
const SETTING_KEYS = ['capture', 'confirm', 'types', 'minSizeKB', 'skipHosts'];
const MIN_DIRECT_MEDIA = 1024 * 1024;

const listOf = (text) => String(text || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const extensionOf = (name) => (/\.([a-z0-9]{1,9})$/i.exec(name || '') || [])[1]?.toLowerCase() || '';
const baseName = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
};

async function getSettings() {
  return { ...DEFAULTS, ...(await ext.storage.local.get(Object.keys(DEFAULTS))) };
}

async function call(path, { method = 'GET', body, port, token, timeout = 5000 } = {}) {
  const s = await getSettings();
  const bearer = token ?? s.token;
  const res = await fetch(`http://127.0.0.1:${port ?? s.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// Finds the app on its saved port or the default range 6801–6810.
async function findApp() {
  const s = await getSettings();
  const ports = [s.port, ...Array.from({ length: 10 }, (_, i) => 6801 + i).filter((p) => p !== s.port)];
  for (const port of ports) {
    try {
      const info = await call('/api/ping', { port, timeout: 800 });
      if (info.app === 'anabranch') {
        if (port !== s.port) await ext.storage.local.set({ port });
        return { port, authorised: info.authorised };
      }
    } catch {
      // not on this port
    }
  }
  return null;
}

async function connectionStatus() {
  const app = await findApp();
  if (!app) return 'offline';
  return app.authorised ? 'connected' : 'unpaired';
}

function browserName() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  return 'Chrome';
}

// Asks the app for a token; the user approves the request in the app window.
async function pair() {
  const app = await findApp();
  if (!app) throw new Error('Anabranch is not running.');
  const { token } = await call('/api/pair', {
    method: 'POST',
    body: { browser: browserName() },
    port: app.port,
    token: '',
    timeout: 130000,
  });
  await ext.storage.local.set({ token });
  return 'connected';
}

async function cookieHeader(url, storeId) {
  try {
    const cookies = await ext.cookies.getAll({ url, ...(storeId ? { storeId } : {}) });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

// The request context the app needs to fetch the file as the browser would.
async function buildItem({ url, referrer, fileName, kind, storeId }) {
  const headers = { 'User-Agent': navigator.userAgent };
  if (referrer && /^https?:/i.test(referrer)) headers.Referer = referrer;
  const cookie = await cookieHeader(url, storeId);
  if (cookie) headers.Cookie = cookie;
  return { url, fileName: fileName || undefined, kind: kind || undefined, headers };
}

async function sendItems(items, { prompt } = {}) {
  const s = await getSettings();
  if (!s.token) throw new Error('Not connected to Anabranch');
  try {
    if (prompt ?? s.confirm) return await call('/api/prompt', { method: 'POST', body: { items } });
    for (const item of items) await call('/api/downloads', { method: 'POST', body: item });
    return { added: items.length };
  } catch (err) {
    // The app revoked this browser's token: pair again next time.
    if (err.status === 401) await ext.storage.local.set({ token: '' });
    throw err;
  }
}

// ---- Download interception ------------------------------------------------

const MIME_EXTENSIONS = {
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/gzip': 'gz',
  'application/x-msdownload': 'exe',
  'application/x-msi': 'msi',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'image/tiff': 'tif',
};

// 'capture', 'skip', or 'unknown' when only the final file name can tell
// (e.g. /download?id=7 served as application/octet-stream).
function verdict(item, s) {
  const url = item.finalUrl || item.url;
  if (!/^(https?|ftp):/i.test(url)) return 'skip'; // blob:, data: stay in the browser
  if (item.byExtensionId || item.incognito) return 'skip'; // incl. downloads we hand back
  const host = new URL(url).hostname;
  if (listOf(s.skipHosts).some((h) => host === h || host.endsWith(`.${h}`))) return 'skip';
  const size = item.fileSize > 0 ? item.fileSize : item.totalBytes > 0 ? item.totalBytes : -1;
  if (size >= 0 && size < s.minSizeKB * 1024) return 'skip';
  const type =
    extensionOf(itemName(item)) || extensionOf(baseName(url)) || MIME_EXTENSIONS[(item.mime || '').toLowerCase()];
  if (!type) return 'unknown';
  return listOf(s.types).includes(type) ? 'capture' : 'skip';
}

// The browser's chosen name, when it has one with an extension (not a
// temporary name).
function itemName(item) {
  const name = item.filename ? item.filename.split(/[\\/]/).pop() : '';
  return extensionOf(name) ? name : '';
}

const handled = new Set();

async function intercept(item, stage) {
  if (handled.has(item.id)) return;
  const s = await getSettings();
  if (!s.capture || !s.token) return;
  const decision = verdict(item, s);
  // In Chrome a later onDeterminingFilename carries the final name.
  if (decision === 'unknown' && stage === 'created' && ext.downloads.onDeterminingFilename) return;
  if (decision !== 'capture' || handled.has(item.id)) return;
  handled.add(item.id);
  const url = item.finalUrl || item.url;
  try {
    await ext.downloads.cancel(item.id);
  } catch {
    return;
  }
  // Too late: a small file can finish before the cancel arrives.
  const [current] = await ext.downloads.search({ id: item.id });
  if (current?.state === 'complete') return;
  ext.downloads.erase({ id: item.id }).catch(() => {});
  try {
    await sendItems([await buildItem({ url, referrer: item.referrer, fileName: itemName(item) || undefined })]);
  } catch {
    // The app is closed or refused: let the browser download it after all.
    ext.downloads.download({ url }).catch(() => {});
  }
}

// onCreated decides as early as possible from the URL or MIME type. Chrome
// also reports the final name (from Content-Disposition) in
// onDeterminingFilename, which settles the cases onCreated cannot; Firefox
// already has the final name in onCreated.
ext.downloads.onCreated.addListener((item) => {
  intercept(item, 'created');
});
ext.downloads.onDeterminingFilename?.addListener((item) => {
  intercept(item, 'filename');
});

// ---- Context menus --------------------------------------------------------

async function createMenus() {
  await Promise.resolve(ext.contextMenus.removeAll());
  ext.contextMenus.create({
    id: 'dm-link',
    title: 'Download with Anabranch',
    contexts: ['link', 'image', 'video', 'audio'],
  });
  ext.contextMenus.create({ id: 'dm-all', title: 'Download all links with Anabranch…', contexts: ['page'] });
}
ext.runtime.onInstalled.addListener(createMenus);
ext.runtime.onStartup?.addListener(createMenus);

async function collectLinks(tabId) {
  const grab = () => [...document.querySelectorAll('a[href]')].map((a) => a.href);
  if (ext.scripting) {
    const results = await ext.scripting.executeScript({ target: { tabId, allFrames: true }, func: grab });
    return results.flatMap((r) => r.result || []);
  }
  const results = await ext.tabs.executeScript(tabId, {
    code: "[...document.querySelectorAll('a[href]')].map((a) => a.href)",
    allFrames: true,
  });
  return results.flat();
}

ext.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'dm-link') {
      const url = info.linkUrl || info.srcUrl;
      await sendItems([await buildItem({ url, referrer: info.pageUrl, storeId: tab?.cookieStoreId })]);
    } else if (info.menuItemId === 'dm-all') {
      const s = await getSettings();
      const types = listOf(s.types);
      const links = [...new Set(await collectLinks(tab.id))].filter(
        (u) => /^(https?|ftp):/i.test(u) && types.includes(extensionOf(baseName(u))),
      );
      if (!links.length) return flashBadge(tab.id, '0');
      const items = await Promise.all(
        links.slice(0, 500).map((url) => buildItem({ url, referrer: tab.url, storeId: tab.cookieStoreId })),
      );
      await sendItems(items, { prompt: true });
    }
  } catch {
    flashBadge(tab?.id, '!');
  }
});

function flashBadge(tabId, text) {
  if (tabId == null) return;
  action.setBadgeText({ tabId, text });
  setTimeout(() => refreshBadge(tabId), 2500);
}

// ---- Media detection ------------------------------------------------------

const memory = new Map();
const session = ext.storage.session ?? null;
const mediaKey = (tabId) => `media:${tabId}`;

async function getMedia(tabId) {
  if (session) return (await session.get(mediaKey(tabId)))[mediaKey(tabId)] || [];
  return memory.get(tabId) || [];
}

async function setMedia(tabId, list) {
  if (session) await session.set({ [mediaKey(tabId)]: list });
  else memory.set(tabId, list);
  refreshBadge(tabId, list.length);
}

async function clearMedia(tabId) {
  if (session) await session.remove(mediaKey(tabId));
  memory.delete(tabId);
  refreshBadge(tabId, 0);
}

async function refreshBadge(tabId, count) {
  if (tabId == null || tabId < 0) return;
  const n = count ?? (await getMedia(tabId)).length;
  try {
    action.setBadgeBackgroundColor({ tabId, color: '#1f6feb' });
    await action.setBadgeText({ tabId, text: n ? String(n) : '' });
  } catch {
    // tab closed
  }
}

// YouTube's player streams scrambled fragments that only yt-dlp can turn
// into a video; the page itself is sent instead (player button or panel).
const SITE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com)$/;
const isYouTubePage = (url) => {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname) && (u.pathname === '/watch' || u.pathname.startsWith('/shorts/'));
  } catch {
    return false;
  }
};

function classify(url, contentType) {
  if (SITE_HOSTS.test(new URL(url).hostname)) return null;
  const path = new URL(url).pathname.toLowerCase();
  const type = (contentType || '').toLowerCase().split(';')[0].trim();
  if (type.includes('mpegurl') || path.endsWith('.m3u8')) return 'hls';
  if (type === 'application/dash+xml' || path.endsWith('.mpd')) return 'dash';
  if (/\.(m4s|ts|m4f|cmfv|cmfa)$/.test(path)) return null; // stream fragments
  if (/^(video\/(mp4|webm|x-matroska|quicktime|x-flv|x-msvideo)|audio\/(mpeg|mp4|aac|ogg|flac|wav|webm|x-m4a))$/.test(type)) {
    return 'file';
  }
  return null;
}

// Describes an HLS playlist: a master lists qualities; a media playlist
// referenced by a master on the same page is not listed separately.
async function inspectHls(url) {
  try {
    const text = await (await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(4000) })).text();
    if (!text.includes('#EXT-X-STREAM-INF')) return { master: false };
    const heights = [...text.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]));
    return { master: true, label: heights.length ? `up to ${Math.max(...heights)}p` : 'adaptive' };
  } catch {
    return { master: false };
  }
}

// Entries for one tab are recorded one at a time, so a master playlist and
// its variants (requested together) are compared against a settled list.
const recording = new Map();

function record(tabId, entry) {
  const next = (recording.get(tabId) || Promise.resolve()).then(() => recordNow(tabId, entry)).catch(() => {});
  recording.set(tabId, next);
  return next;
}

async function recordNow(tabId, entry) {
  let list = await getMedia(tabId);
  if (list.some((m) => m.url === entry.url)) return;
  if (entry.kind === 'hls') {
    const info = await inspectHls(entry.url);
    entry.master = info.master;
    if (info.master) {
      entry.label = info.label;
      list = list.filter((m) => m.kind !== 'hls' || m.master);
    } else if (list.some((m) => m.master)) {
      return;
    }
  }
  await setMedia(tabId, [entry, ...list].slice(0, 30));
}

ext.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const header = (name) => d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value || '';
    let kind;
    try {
      kind = classify(d.url, header('content-type'));
    } catch {
      return;
    }
    if (!kind) return;
    const range = /\/(\d+)\s*$/.exec(header('content-range'));
    const size = range ? Number(range[1]) : Number(header('content-length')) || null;
    if (kind === 'file' && (size ?? 0) < MIN_DIRECT_MEDIA) return;
    record(d.tabId, { url: d.url, kind, size, contentType: header('content-type'), time: Date.now() });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'object', 'other'] },
  ['responseHeaders'],
);

// A new page in the tab (not an in-page history change) starts a fresh list.
ext.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) clearMedia(d.tabId);
});
ext.tabs.onRemoved.addListener((tabId) => clearMedia(tabId));

// ---- Messages from the toolbar panel --------------------------------------

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'status': {
      const s = await getSettings();
      return { status: await connectionStatus(), settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k]])) };
    }
    case 'pair':
      return { status: await pair() };
    case 'disconnect':
      await ext.storage.local.set({ token: '' });
      return { status: 'unpaired' };
    case 'media':
      return { media: await getMedia(msg.tabId) };
    case 'clear-media':
      await clearMedia(msg.tabId);
      return { media: [] };
    case 'download-media': {
      const item = await buildItem({
        url: msg.url,
        referrer: msg.pageUrl,
        kind: msg.kind === 'file' ? undefined : msg.kind,
        fileName: msg.fileName,
        storeId: msg.storeId,
      });
      return sendItems([item]);
    }
    case 'download-page': {
      // A video page (YouTube): the app hands it to yt-dlp, with the
      // browser's YouTube sign-in for members-only or age-restricted videos.
      const url = msg.url || sender?.tab?.url;
      if (!isYouTubePage(url)) throw new Error('Not a video page');
      const storeId = msg.storeId ?? sender?.tab?.cookieStoreId;
      return sendItems([await buildItem({ url, kind: 'site', storeId })]);
    }
    case 'save-settings': {
      const patch = Object.fromEntries(Object.entries(msg.settings || {}).filter(([k]) => SETTING_KEYS.includes(k)));
      await ext.storage.local.set(patch);
      return { ok: true };
    }
    default:
      throw new Error(`Unknown message ${msg.type}`);
  }
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (err) => sendResponse({ error: err.message }));
  return true;
});
