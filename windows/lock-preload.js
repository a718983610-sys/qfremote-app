const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qfLock', {
  devices: () => ipcRenderer.invoke('qf-lock-devices'),
  enable: (id, password) => ipcRenderer.invoke('qf-lock-enable', id, password),
  disable: (id) => ipcRenderer.invoke('qf-lock-disable', id),
  reset: (id, loginPassword, newPassword) => ipcRenderer.invoke('qf-lock-reset', id, loginPassword, newPassword),
  close: () => ipcRenderer.send('qf-lock-close'),
  repair: () => ipcRenderer.invoke('qf-lock-repair'),
  installComponent: () => ipcRenderer.invoke('qf-lock-install-component'),
  goLogin: () => ipcRenderer.send('qf-lock-go-login'),
  openDevices: () => ipcRenderer.send('qf-lock-open-devices'),
  openFriends: () => ipcRenderer.send('qf-lock-open-friends'),
  onTheme: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t))
});
