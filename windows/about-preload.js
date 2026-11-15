const { contextBridge, ipcRenderer } = require('electron');
// F-08 capability table：本桥只调下面这些 channel；主进程 ipc-trust.js 的
// IPC_CAPABILITIES 逐条校验 sender（精确 about.html＋主框架＋活窗口），
// 表外一律拒绝。只作声明与审计对照，强制执行在主进程。
const CAPABILITIES = Object.freeze(['qf-probe-now', 'qf-about-close', 'qf-update-check', 'qf-update-get', 'qf-update-download', 'qf-update-open', 'qf-update-settings-get', 'qf-update-settings-set', 'qf-diagnostics-copy', 'qf-autolaunch-get', 'qf-autolaunch-set', 'qf-heal-retry', 'qf-open-register', 'qf-logout-request', 'qf-points-me', 'qf-license-me', 'qf-license-bind', 'qf-license-claim', 'qf-license-open']);
contextBridge.exposeInMainWorld('qfAbout', {
  check: () => ipcRenderer.invoke('qf-probe-now'),
  close: () => ipcRenderer.send('qf-about-close'),
  onTheme: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t)),
  // v1.0.3：软件内更新 + 诊断复制
  checkUpdate: () => ipcRenderer.invoke('qf-update-check'),
  getUpdateState: () => ipcRenderer.invoke('qf-update-get'),
  onUpdateState: (cb) => ipcRenderer.on('qf-update-state', (e, s) => cb(s)),
  downloadUpdate: (opts) => ipcRenderer.send('qf-update-download', opts || {}),
  onUpdateProgress: (cb) => ipcRenderer.on('qf-update-progress', (e, p) => cb(p)),
  openInstaller: () => ipcRenderer.send('qf-update-open'),
  // D-05：更新设置（总开关＋下载前先问）与安装方式。
  getUpdateSettings: () => ipcRenderer.invoke('qf-update-settings-get'),
  setUpdateSettings: (patch) => ipcRenderer.invoke('qf-update-settings-set', patch),
  copyDiagnostics: () => ipcRenderer.invoke('qf-diagnostics-copy'),
  // W-23：开机自启明示＋一键关闭；W-14：手动重试自愈
  getAutoLaunch: () => ipcRenderer.invoke('qf-autolaunch-get'),
  setAutoLaunch: (on) => ipcRenderer.send('qf-autolaunch-set', on),
  retryHeal: () => ipcRenderer.invoke('qf-heal-retry'),
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
