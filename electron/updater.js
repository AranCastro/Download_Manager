'use strict';

const { app } = require('electron');

// Updates from GitHub Releases. The installed (NSIS) build downloads a new
// version in the background with electron-updater and installs it on
// restart. The portable exe and development runs cannot replace themselves,
// so they only report that a newer version exists.

const RELEASES_PAGE = 'https://github.com/AranCastro/Download_Manager/releases/latest';
const FIRST_CHECK_MS = 20 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// 1.10.0 > 1.9.3; pre-release suffixes are ignored.
function isNewer(candidate, current) {
  const parts = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function createUpdater({ send, autoCheck }) {
  const selfUpdating =
    app.isPackaged && ((process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR) || Boolean(process.env.APPIMAGE));
  let state = { status: 'idle', current: app.getVersion(), selfUpdating, page: RELEASES_PAGE };
  const set = (patch) => {
    state = { ...state, ...patch };
    send('dm:app-update', state);
  };

  let autoUpdater = null;
  if (selfUpdating) {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.logger = null;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('update-not-available', () => set({ status: 'latest', checkedAt: Date.now() }));
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => set({ status: 'error', error: err.message.split('\n')[0] }));
  }

  // Without self-update, see where GitHub's "latest release" page redirects
  // (…/releases/tag/v1.3.0). Unlike the GitHub API, this has no hourly limit
  // per address, which matters on shared mobile and office networks.
  async function checkOnly() {
    set({ status: 'checking', error: null });
    try {
      const res = await fetch(RELEASES_PAGE, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      const tag = /\/releases\/tag\/v?([^/?#]+)$/.exec(res.url);
      if (!res.ok || !tag) throw new Error(`GitHub answered HTTP ${res.status}`);
      const latest = decodeURIComponent(tag[1]);
      set(isNewer(latest, state.current)
        ? { status: 'available', version: latest, page: res.url }
        : { status: 'latest', checkedAt: Date.now() });
    } catch (err) {
      set({ status: 'error', error: err.message });
    }
  }

  async function check() {
    if (['checking', 'downloading', 'ready'].includes(state.status)) return state;
    if (!autoUpdater) await checkOnly();
    else await autoUpdater.checkForUpdates().catch((err) => set({ status: 'error', error: err.message.split('\n')[0] }));
    return state;
  }

  const timers = [
    setTimeout(() => autoCheck() && check(), FIRST_CHECK_MS),
    setInterval(() => autoCheck() && check(), CHECK_EVERY_MS),
  ];
  timers.forEach((t) => t.unref?.());

  return {
    state: () => state,
    check,
    // Quits (downloads are saved on the way out) and starts the installer.
    install: () => {
      if (state.status === 'ready' && autoUpdater) setImmediate(() => autoUpdater.quitAndInstall(false, true));
    },
  };
}

module.exports = { createUpdater, isNewer };
