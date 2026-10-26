const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qfAbout', {
  check: () => ipcRenderer.invoke('qf-probe-now'),
  close: () => ipcRenderer.send('qf-about-close'),
  onTheme: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t)),
  // v1.0.3：软件内更新 + 诊断复制
  checkUpdate: () => ipcRenderer.invoke('qf-update-check'),
  getUpdateState: () => ipcRenderer.invoke('qf-update-get'),
  onUpdateState: (cb) => ipcRenderer.on('qf-update-state', (e, s) => cb(s)),
  downloadUpdate: () => ipcRenderer.send('qf-update-download'),
  onUpdateProgress: (cb) => ipcRenderer.on('qf-update-progress', (e, p) => cb(p)),
  openInstaller: () => ipcRenderer.send('qf-update-open'),
  copyDiagnostics: () => ipcRenderer.invoke('qf-diagnostics-copy'),
  openRegister: () => ipcRenderer.send('qf-open-register'),
  requestLogout: () => ipcRenderer.invoke('qf-logout-request'),
  // v2.2.0：积分与使用时长（取不到返回 null，页面显示「—」）
  getPoints: () => ipcRenderer.invoke('qf-points-me'),
  // v2.3.1：付费与激活（许可概览与 /license/api/me 同源；取不到返回 null）
  getLicense: () => ipcRenderer.invoke('qf-license-me'),
  bindLicense: (key) => ipcRenderer.invoke('qf-license-bind', key),
  claimLicense: (key) => ipcRenderer.invoke('qf-license-claim', key),
  openLicense: (target) => ipcRenderer.send('qf-license-open', target)
});
