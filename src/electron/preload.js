// Electron preload：通过 contextBridge 向前端暴露窗口控制 API（安全隔离）
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-hide'),
});
