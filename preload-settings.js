'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (data) => ipcRenderer.invoke('settings:save', data),
  close: () => ipcRenderer.send('settings:close'),
  // Парение и полёт: применяются сразу
  setMotion: (patch) => ipcRenderer.invoke('settings:motion', patch),
  resetMotion: () => ipcRenderer.invoke('settings:motion-reset'),
  // Настройки движения поменяли не здесь (например, галочка в меню трея)
  onMotion: (cb) => ipcRenderer.on('settings:motion-changed', (_e, m) => cb(m)),
});
