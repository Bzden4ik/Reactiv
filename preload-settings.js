'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (data) => ipcRenderer.invoke('settings:save', data),
  close: () => ipcRenderer.send('settings:close'),
});
