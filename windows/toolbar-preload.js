const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qfNav', {
  go: (action) => ipcRenderer.send('qf-nav', action),
  friends: () => ipcRenderer.send('qf-nav', 'friends'),
  forum: () => ipcRenderer.send('qf-nav', 'forum'),
  homePage: () => ipcRenderer.send('qf-nav', 'home-page'),
  register: () => ipcRenderer.send('qf-nav', 'register'),
  openLock: () => ipcRenderer.send('qf-lock-open'),
  win: (action) => ipcRenderer.send('qf-win', action),
  getAutoLaunch: () => ipcRenderer.invoke('qf-autolaunch-get'),
  setAutoLaunch: (on) => ipcRenderer.send('qf-autolaunch-set', on),
  zoom: (action) => ipcRenderer.send('qf-zoom', action),
  toggleFullscreen: () => ipcRenderer.send('qf-fs-toggle'),
  toggleTop: () => ipcRenderer.send('qf-top-toggle'),
  getVersion: () => ipcRenderer.invoke('qf-version'),
  getUiState: () => ipcRenderer.invoke('qf-ui-state'),
  onZoomState: (cb) => ipcRenderer.on('qf-zoom-state', (e, pct) => cb(pct)),
  onFsState: (cb) => ipcRenderer.on('qf-fs-state', (e, on) => cb(on)),
  onTopState: (cb) => ipcRenderer.on('qf-top-state', (e, on) => cb(on)),
  onStatus: (cb) => ipcRenderer.on('qf-conn-status', (e, s) => cb(s)),
  // v1.0.2：主题 / 探活 / 截图 / 关于
  toggleTheme: () => ipcRenderer.send('qf-theme-toggle'),
  onThemeState: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t)),
  getProbe: () => ipcRenderer.invoke('qf-probe-get'),
  onProbeState: (cb) => ipcRenderer.on('qf-probe-state', (e, s) => cb(s)),
  screenshot: () => ipcRenderer.send('qf-screenshot'),
  onShotFeedback: (cb) => ipcRenderer.on('qf-shot-feedback', (e, f) => cb(f)),
  openAbout: () => ipcRenderer.send('qf-about-open'),
  // v2.2.0：站长管理入口（默认隐藏，main 判定站长后才显示）
  openAdmin: () => ipcRenderer.send('qf-admin-open'),
  onViewState: (cb) => ipcRenderer.on('qf-view-state', (e, k) => cb(k)),
  onAdminState: (cb) => ipcRenderer.on('qf-admin-state', (e, on) => cb(on)),
  // v1.0.3：软件内更新徽标
  getUpdateState: () => ipcRenderer.invoke('qf-update-get'),
  onUpdateState: (cb) => ipcRenderer.on('qf-update-state', (e, s) => cb(s))
});
