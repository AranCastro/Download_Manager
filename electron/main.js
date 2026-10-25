'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  clipboard,
  Notification,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  safeStorage,
} = require('electron');
const { DownloadManager, readJson, writeJson } = require('./engine/DownloadManager');
const { createApiServer, listen } = require('./api-server');
const { looksLikeDownloadUrl, CATEGORIES } = require('./engine/utils');
const { findFfmpeg } = require('./engine/ffmpeg');
const { createUpdater } = require('./updater');

const POWER_COUNTDOWN_SECONDS = 60;
const PAIR_TIMEOUT_MS = 120000;

let mainWindow = null;
let manager = null;
let apiServer = null;
let apiInfo = { port: null, token: null };
let pairings = [];
let powerTimer = null;
let tray = null;
let quitting = false;
let updater = null;
const pendingPairs = new Map();
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
// Height of the custom title bar; the native window buttons are drawn over it.
const TITLEBAR_HEIGHT = 44;

// URLs passed on the command line, e.g. `"Anabranch.exe" https://...`.
const urlArgs = (argv) => argv.filter((a) => /^(https?|ftps?):\/\//i.test(a));
const userFile = (name) => path.join(app.getPath('userData'), name);
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const urls = urlArgs(argv);
    if (urls.length) promptAdd(urls.map((url) => ({ url })));
    showWindow();
  });
  app.whenReady().then(boot);
}

// Secrets are encrypted with the OS key store (DPAPI on Windows). Where none
// is available (some Linux desktops) they are only base64-encoded.
const encrypt = (text) =>
  safeStorage.isEncryptionAvailable()
    ? `v1:${safeStorage.encryptString(text).toString('base64')}`
    : `b64:${Buffer.from(text).toString('base64')}`;
const decrypt = (stored) =>
  stored.startsWith('v1:')
    ? safeStorage.decryptString(Buffer.from(stored.slice(3), 'base64'))
    : Buffer.from(stored.slice(4), 'base64').toString('utf8');

async function boot() {
  Menu.setApplicationMenu(null);
  manager = await new DownloadManager({ dataDir: app.getPath('userData'), encrypt, decrypt }).init();
  pairings = (await readJson(userFile('pairings.json'))) || [];
  await startApi();

  // Coalesce engine events into at most a few UI updates per second.
  let pending = null;
  const pushUpdate = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      send('dm:update', manager.list());
    }, 150);
  };
  manager.on('changed', pushUpdate);
  manager.on('progress', pushUpdate);
  manager.on('changed', updateTaskbar);
  manager.on('progress', updateTaskbar);
  manager.on('settings', (s) => send('dm:settings', s));
  manager.on('completed', (d) => {
    if (manager.settings.notifyOnComplete) notify('Download complete', d.fileName, () => shell.showItemInFolder(d.savePath));
  });
  manager.on('auth-required', (d) => {
    send('dm:auth-required', d);
    if (!mainWindow?.isFocused()) notify('Login required', `${d.fileName} needs a user name and password`, showWindow);
  });
  manager.on('schedule-finished', startPowerCountdown);

  updater = createUpdater({ send, autoCheck: () => manager.settings.autoUpdate });
  // yt-dlp must keep up with YouTube's changes: the copy the app installed
  // updates itself once a day.
  const updateYtDlp = () => manager.settings.autoUpdate && manager.updateYtDlp().catch(() => {});
  setTimeout(updateYtDlp, 30 * 1000).unref();
  setInterval(updateYtDlp, 6 * 60 * 60 * 1000).unref();

  registerIpc();
  createWindow();
  createTray();
  startClipboardMonitor();
  const urls = urlArgs(process.argv);
  if (urls.length) {
    mainWindow.webContents.once('did-finish-load', () => promptAdd(urls.map((url) => ({ url }))));
  }
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body });
  if (onClick) note.on('click', onClick);
  note.show();
}

// The API token is kept between runs so MCP client configs stay valid.
async function startApi() {
  const saved = await readJson(userFile('api.json'));
  const token = saved?.token || crypto.randomBytes(24).toString('hex');
  apiServer = createApiServer(manager, {
    token,
    version: app.getVersion(),
    isPairedToken: (candidate) => {
      const hash = hashToken(candidate);
      return pairings.some((p) => p.tokenHash === hash);
    },
    onPair: requestPairing,
    onPrompt: promptAdd,
  });
  try {
    const port = await listen(apiServer, manager.settings.apiPort);
    apiInfo = { port, token };
    await writeJson(userFile('api.json'), { port, token, pid: process.pid });
  } catch (err) {
    console.error('Local API disabled:', err.message);
  }
}

// A browser extension asked to connect: the user approves it in the app,
// then the extension receives its own token (only its hash is stored).
function requestPairing({ origin, browser }) {
  const key = origin || browser;
  if (pendingPairs.has(key)) return pendingPairs.get(key).promise;
  const requestId = crypto.randomUUID();
  let settle;
  const promise = new Promise((resolve) => (settle = resolve));
  const timer = setTimeout(() => finish(false), PAIR_TIMEOUT_MS);
  const finish = async (allow) => {
    clearTimeout(timer);
    pendingPairs.delete(key);
    send('dm:pair-closed', requestId);
    if (!allow) return settle(null);
    const token = crypto.randomBytes(24).toString('hex');
    pairings = pairings.filter((p) => p.origin !== origin || !origin);
    pairings.push({ id: requestId, browser, origin, tokenHash: hashToken(token), createdAt: Date.now() });
    await writeJson(userFile('pairings.json'), pairings);
    settle(token);
  };
  pendingPairs.set(key, { promise, requestId, finish, browser, origin });
  showWindow();
  send('dm:pair-request', { requestId, browser, origin });
  return promise;
}

function promptAdd(items) {
  showWindow();
  send('dm:prompt-add', { items });
}

// Countdown before quit / sleep / shutdown, which the user can cancel.
function startPowerCountdown(action) {
  if (!action || action === 'nothing') return;
  clearTimeout(powerTimer);
  showWindow();
  send('dm:power-countdown', { action, seconds: POWER_COUNTDOWN_SECONDS });
  powerTimer = setTimeout(() => performPowerAction(action), POWER_COUNTDOWN_SECONDS * 1000);
}

async function performPowerAction(action) {
  powerTimer = null;
  send('dm:power-countdown', null);
  await manager.save();
  const platform = process.platform;
  const commands = {
    sleep: {
      win32: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']],
      darwin: ['pmset', ['sleepnow']],
      linux: ['systemctl', ['suspend']],
    },
    shutdown: {
      win32: ['shutdown', ['/s', '/t', '0']],
      darwin: ['osascript', ['-e', 'tell app "System Events" to shut down']],
      linux: ['systemctl', ['poweroff']],
    },
  };
  if (action === 'quit') return app.quit();
  const command = commands[action]?.[platform];
  if (!command) return;
  execFile(command[0], command[1], { windowsHide: true }, (err) => {
    if (err) notify('Could not run the scheduled action', err.message);
  });
  if (action === 'shutdown') app.quit();
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isDark() {
  const theme = manager.settings.theme;
  return theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
}

// Colours of the native window buttons; the renderer sends exact values
// whenever the theme or accent changes.
function titleBarColours(dark = isDark()) {
  return dark ? { color: '#14161b', symbolColor: '#e6e9ee' } : { color: '#eef0f4', symbolColor: '#1c2129' };
}

function createWindow() {
  const dark = isDark();
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 760,
    minWidth: 860,
    minHeight: 520,
    title: 'Anabranch',
    backgroundColor: titleBarColours(dark).color,
    icon: ICON,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { ...titleBarColours(dark), height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Links in the UI open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  // "Close to tray": the window hides and downloads continue.
  mainWindow.on('close', (event) => {
    if (!quitting && manager.settings.closeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const size = process.platform === 'win32' ? 16 : 22;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: size, height: size }));
  tray.setToolTip('Anabranch');
  tray.on('click', showWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Anabranch', click: showWindow },
      {
        label: 'Add link from clipboard',
        click: async () => {
          const text = String((await clipboard.readText().catch(() => '')) || '').trim();
          promptAdd(/^(https?|ftps?):\/\//i.test(text) ? [{ url: text }] : []);
        },
      },
      { type: 'separator' },
      { label: 'Resume all', click: () => manager.resumeAll() },
      { label: 'Pause all', click: () => manager.pauseAll() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

// Overall progress on the taskbar button and in the tray tooltip.
let lastTaskbar = 0;
function updateTaskbar() {
  const now = Date.now();
  if (now - lastTaskbar < 500 || !mainWindow) return;
  lastTaskbar = now;
  const active = manager.list().filter((d) => ['connecting', 'downloading', 'merging'].includes(d.status));
  const speed = active.reduce((sum, d) => sum + (d.speed || 0), 0);
  if (!active.length) {
    mainWindow.setProgressBar(-1);
    tray?.setToolTip('Anabranch');
    return;
  }
  const known = active.filter((d) => d.totalBytes);
  const total = known.reduce((sum, d) => sum + d.totalBytes, 0);
  const done = known.reduce((sum, d) => sum + Math.min(d.downloadedBytes, d.totalBytes), 0);
  if (total) mainWindow.setProgressBar(done / total);
  else mainWindow.setProgressBar(2, { mode: 'indeterminate' });
  const mb = (speed / 1048576).toFixed(1);
  tray?.setToolTip(`Anabranch — ${active.length} active, ${mb} MB/s`);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function extensionFolder(browser) {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(__dirname, '..', 'dist-extension');
  return path.join(root, browser === 'firefox' ? 'firefox' : 'chromium');
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));

  handle('dm:init', () => ({
    downloads: manager.list(),
    settings: manager.settings,
    categories: CATEGORIES,
    version: app.getVersion(),
    pendingPairs: [...pendingPairs.values()].map(({ requestId, browser, origin }) => ({ requestId, browser, origin })),
  }));
  handle('dm:add', (options) => manager.add(options));
  handle('dm:pause', (ids) => ids.forEach((id) => manager.pause(id)));
  handle('dm:resume', (ids) => ids.forEach((id) => manager.resume(id)));
  handle('dm:pause-all', () => manager.pauseAll());
  handle('dm:resume-all', () => manager.resumeAll());
  handle('dm:remove', async (ids, deleteFile) => {
    for (const id of ids) await manager.remove(id, { deleteFile });
  });
  handle('dm:remove-completed', () => manager.removeCompleted());
  handle('dm:set-credentials', (id, login) => manager.setCredentials(id, login));
  handle('dm:schedule', (ids) => manager.schedule(ids));
  handle('dm:run-schedule', () => manager.runSchedule());
  handle('dm:update-settings', (patch) => manager.updateSettings(patch));
  handle('dm:power-cancel', () => {
    clearTimeout(powerTimer);
    powerTimer = null;
    send('dm:power-countdown', null);
  });
  handle('dm:pair-response', (requestId, allow) => {
    const pending = [...pendingPairs.values()].find((p) => p.requestId === requestId);
    pending?.finish(Boolean(allow));
  });
  handle('dm:pairings', () => pairings.map(({ tokenHash, ...p }) => p));
  handle('dm:revoke-pairing', async (id) => {
    pairings = pairings.filter((p) => p.id !== id);
    await writeJson(userFile('pairings.json'), pairings);
    return pairings.map(({ tokenHash, ...p }) => p);
  });
  handle('dm:check-ffmpeg', (bin) => findFfmpeg(bin ?? manager.settings.ffmpegPath));
  handle('dm:probe', (options) => manager.probe(options));
  handle('dm:tools', () => manager.toolStatus());
  handle('dm:install-tool', (name) =>
    manager.installTool(name, { onProgress: (progress) => send('dm:tool-progress', { name, ...progress }) }),
  );
  handle('dm:app-update-state', () => updater.state());
  handle('dm:check-app-update', () => updater.check());
  handle('dm:install-app-update', () => updater.install());
  handle('dm:open-external', (url) => /^https:\/\/github\.com\/AranCastro\//.test(url) && shell.openExternal(url));
  handle('dm:platform', () => process.platform);
  handle('dm:titlebar', (colours) => {
    if (process.platform !== 'darwin' && mainWindow && colours?.color) {
      mainWindow.setTitleBarOverlay({ color: colours.color, symbolColor: colours.symbolColor, height: TITLEBAR_HEIGHT });
      mainWindow.setBackgroundColor(colours.color);
    }
  });
  handle('dm:open-file', (id) => shell.openPath(manager.get(id).savePath));
  handle('dm:show-in-folder', (id) => {
    const d = manager.get(id);
    if (d.status === 'completed') shell.showItemInFolder(d.savePath);
    else shell.openPath(d.savePath ? path.dirname(d.savePath) : manager.settings.downloadDir);
  });
  handle('dm:open-download-dir', () => shell.openPath(manager.settings.downloadDir));
  handle('dm:open-extension-folder', (browser) => {
    const folder = extensionFolder(browser);
    return fs.existsSync(folder) ? shell.openPath(folder) : `Not found: ${folder}`;
  });
  handle('dm:extension-folder', (browser) => extensionFolder(browser));
  handle('dm:choose-directory', async (current) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: current || manager.settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('dm:choose-file', async (current) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: current || undefined,
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  // Electron's clipboard API is asynchronous (W3C style).
  handle('dm:copy', (text) => clipboard.writeText(String(text)));
  handle('dm:clipboard-url', async () => {
    const text = String((await clipboard.readText()) || '').trim();
    return /^(https?|ftps?):\/\//i.test(text) ? text : '';
  });
  handle('dm:api-info', () => ({
    ...apiInfo,
    url: apiInfo.port ? `http://127.0.0.1:${apiInfo.port}` : null,
    mcpScript: app.isPackaged
      ? path.join(process.resourcesPath, 'mcp', 'anabranch-mcp.cjs')
      : path.join(__dirname, '..', 'dist-mcp', 'anabranch-mcp.cjs'),
    executable: process.execPath,
  }));
}

// Offers to download a link when one is copied, like browser-less IDM capture.
async function startClipboardMonitor() {
  const read = async () => String((await clipboard.readText().catch(() => '')) || '');
  let last = await read();
  let busy = false;
  setInterval(async () => {
    if (!manager.settings.clipboardMonitor || busy) return;
    busy = true;
    try {
      const text = await read();
      if (text !== last) {
        last = text;
        if (looksLikeDownloadUrl(text)) promptAdd([{ url: text.trim() }]);
      }
    } finally {
      busy = false;
    }
  }, 1000).unref();
}

app.on('before-quit', async (event) => {
  if (quitting || !manager) return;
  event.preventDefault();
  quitting = true;
  clearTimeout(powerTimer);
  await manager.shutdown();
  apiServer?.close();
  tray?.destroy();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
