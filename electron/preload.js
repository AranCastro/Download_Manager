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
  updateSettings: invoke('dm:update-settings'),
  openFile: invoke('dm:open-file'),
  showInFolder: invoke('dm:show-in-folder'),
  openDownloadDir: invoke('dm:open-download-dir'),
  chooseDirectory: invoke('dm:choose-directory'),
  copy: invoke('dm:copy'),
  clipboardUrl: invoke('dm:clipboard-url'),
  apiInfo: invoke('dm:api-info'),
  onUpdate: subscribe('dm:update'),
  onSettings: subscribe('dm:settings'),
  onPromptAdd: subscribe('dm:prompt-add'),
});
