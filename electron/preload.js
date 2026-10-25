'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

// The only surface the React UI can use; it has no Node.js access.
contextBridge.exposeInMainWorld('dm', {
  init: invoke('dm:init'),
  add: invoke('dm:add'),
  pause: invoke('dm:pause'),
  resume: invoke('dm:resume'),
  pauseAll: invoke('dm:pause-all'),
  resumeAll: invoke('dm:resume-all'),
  remove: invoke('dm:remove'),
  removeCompleted: invoke('dm:remove-completed'),
  setCredentials: invoke('dm:set-credentials'),
  schedule: invoke('dm:schedule'),
  runSchedule: invoke('dm:run-schedule'),
  updateSettings: invoke('dm:update-settings'),
  cancelPowerAction: invoke('dm:power-cancel'),
  respondPair: invoke('dm:pair-response'),
  pairings: invoke('dm:pairings'),
  revokePairing: invoke('dm:revoke-pairing'),
  checkFfmpeg: invoke('dm:check-ffmpeg'),
  probe: invoke('dm:probe'),
  toolStatus: invoke('dm:tools'),
  installTool: invoke('dm:install-tool'),
  appUpdateState: invoke('dm:app-update-state'),
  checkAppUpdate: invoke('dm:check-app-update'),
  installAppUpdate: invoke('dm:install-app-update'),
  openExternal: invoke('dm:open-external'),
  platform: invoke('dm:platform'),
  setTitleBar: invoke('dm:titlebar'),
  openFile: invoke('dm:open-file'),
  showInFolder: invoke('dm:show-in-folder'),
  openDownloadDir: invoke('dm:open-download-dir'),
  openExtensionFolder: invoke('dm:open-extension-folder'),
  extensionFolder: invoke('dm:extension-folder'),
  chooseDirectory: invoke('dm:choose-directory'),
  chooseFile: invoke('dm:choose-file'),
  copy: invoke('dm:copy'),
  clipboardUrl: invoke('dm:clipboard-url'),
  apiInfo: invoke('dm:api-info'),
  onUpdate: subscribe('dm:update'),
  onSettings: subscribe('dm:settings'),
  onPromptAdd: subscribe('dm:prompt-add'),
  onAuthRequired: subscribe('dm:auth-required'),
  onPairRequest: subscribe('dm:pair-request'),
  onPairClosed: subscribe('dm:pair-closed'),
  onPowerCountdown: subscribe('dm:power-countdown'),
  onToolProgress: subscribe('dm:tool-progress'),
  onAppUpdate: subscribe('dm:app-update'),
});
