const { contextBridge, ipcRenderer } = require('electron');
// F-08 capability table：本桥只调下面这些 channel；主进程 ipc-trust.js 的
// IPC_CAPABILITIES 逐条校验 sender（精确 lock.html＋主框架＋活窗口），
// 表外一律拒绝。只作声明与审计对照，强制执行在主进程。
const CAPABILITIES = Object.freeze(['qf-lock-devices', 'qf-lock-enable', 'qf-lock-disable', 'qf-lock-reset', 'qf-lock-close', 'qf-lock-repair', 'qf-lock-install-component', 'qf-lock-go-login', 'qf-lock-open-devices', 'qf-lock-open-friends', 'qf-lock-challenge']);
contextBridge.exposeInMainWorld('qfLock', {
  devices: () => ipcRenderer.invoke('qf-lock-devices'),
  enable: (id, password) => ipcRenderer.invoke('qf-lock-enable', id, password),
  disable: (id, opts) => ipcRenderer.invoke('qf-lock-disable', id, opts),
  challenge: (id, op) => ipcRenderer.invoke('qf-lock-challenge', id, op),
  reset: (id, loginPassword, newPassword) => ipcRenderer.invoke('qf-lock-reset', id, loginPassword, newPassword),
  close: () => ipcRenderer.send('qf-lock-close'),
  repair: () => ipcRenderer.invoke('qf-lock-repair'),
  installComponent: () => ipcRenderer.invoke('qf-lock-install-component'),
  goLogin: () => ipcRenderer.send('qf-lock-go-login'),
  openDevices: () => ipcRenderer.send('qf-lock-open-devices'),
  openFriends: () => ipcRenderer.send('qf-lock-open-friends'),
  onTheme: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t))
});
