'use strict';

const path = require('path');
const crypto = require('crypto');
const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  clipboard,
  Notification,
  Menu,
} = require('electron');
const { DownloadManager, readJson, writeJson } = require('./engine/DownloadManager');
const { createApiServer, listen } = require('./api-server');
const { looksLikeDownloadUrl, CATEGORIES } = require('./engine/utils');

let mainWindow = null;
let manager = null;
let apiServer = null;
let apiInfo = { port: null, token: null };

// URLs passed on the command line, e.g. `"Download Manager.exe" https://...`.
const urlArgs = (argv) => argv.filter((a) => /^https?:\/\//i.test(a));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    for (const url of urlArgs(argv)) send('dm:prompt-add', url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(boot);
}

async function boot() {
  Menu.setApplicationMenu(null);
  manager = await new DownloadManager({ dataDir: app.getPath('userData') }).init();
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
  manager.on('settings', (s) => send('dm:settings', s));
  manager.on('completed', (d) => {
    if (manager.settings.notifyOnComplete && Notification.isSupported()) {
      const note = new Notification({ title: 'Download complete', body: d.fileName });
      note.on('click', () => shell.showItemInFolder(d.savePath));
      note.show();
    }
  });

  registerIpc();
  createWindow();
  startClipboardMonitor();
  for (const url of urlArgs(process.argv)) {
    mainWindow.webContents.once('did-finish-load', () => send('dm:prompt-add', url));
  }
}

// The API token is kept between runs so MCP client configs stay valid.
async function startApi() {
  const file = path.join(app.getPath('userData'), 'api.json');
  const saved = await readJson(file);
  const token = saved?.token || crypto.randomBytes(24).toString('hex');
  apiServer = createApiServer(manager, { token });
  try {
    const port = await listen(apiServer, manager.settings.apiPort);
    apiInfo = { port, token };
    await writeJson(file, { port, token, pid: process.pid });
  } catch (err) {
    console.error('Local API disabled:', err.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 820,
    minHeight: 480,
    title: 'Download Manager',
    backgroundColor: '#f3f4f6',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));

  handle('dm:init', () => ({
    downloads: manager.list(),
    settings: manager.settings,
    categories: CATEGORIES,
    version: app.getVersion(),
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
  handle('dm:update-settings', (patch) => manager.updateSettings(patch));
  handle('dm:open-file', (id) => shell.openPath(manager.get(id).savePath));
  handle('dm:show-in-folder', (id) => {
    const d = manager.get(id);
    if (d.status === 'completed') shell.showItemInFolder(d.savePath);
    else shell.openPath(d.savePath ? path.dirname(d.savePath) : manager.settings.downloadDir);
  });
  handle('dm:open-download-dir', () => shell.openPath(manager.settings.downloadDir));
  handle('dm:choose-directory', async (current) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: current || manager.settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('dm:copy', (text) => clipboard.writeText(String(text)));
  handle('dm:clipboard-url', () => {
    const text = clipboard.readText().trim();
    return /^https?:\/\//i.test(text) ? text : '';
  });
  handle('dm:api-info', () => ({
    ...apiInfo,
    url: apiInfo.port ? `http://127.0.0.1:${apiInfo.port}` : null,
    mcpScript: app.isPackaged
      ? path.join(process.resourcesPath, 'mcp', 'download-manager-mcp.cjs')
      : path.join(__dirname, '..', 'dist-mcp', 'download-manager-mcp.cjs'),
    executable: process.execPath,
  }));
}

// Offers to download a link when one is copied, like browser-less IDM capture.
function startClipboardMonitor() {
  let last = clipboard.readText();
  setInterval(() => {
    if (!manager.settings.clipboardMonitor) return;
    const text = clipboard.readText();
    if (text === last) return;
    last = text;
    if (looksLikeDownloadUrl(text)) send('dm:prompt-add', text.trim());
  }, 1000).unref();
}

let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting || !manager) return;
  event.preventDefault();
  quitting = true;
  await manager.shutdown();
  apiServer?.close();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
