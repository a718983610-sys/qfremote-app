const { contextBridge, ipcRenderer } = require('electron');
// F-08 capability table：本桥只调下面这些 channel；主进程 ipc-trust.js 的
// IPC_CAPABILITIES 逐条校验 sender（精确 toolbar.html＋主框架＋活窗口），
// 表外一律拒绝。只作声明与审计对照，强制执行在主进程。
const CAPABILITIES = Object.freeze(['qf-nav', 'qf-lock-open', 'qf-win', 'qf-autolaunch-get', 'qf-autolaunch-set', 'qf-zoom', 'qf-fs-toggle', 'qf-top-toggle', 'qf-version', 'qf-ui-state', 'qf-theme-toggle', 'qf-overflow-menu', 'qf-probe-get', 'qf-screenshot', 'qf-about-open', 'qf-admin-open', 'qf-update-get', 'qf-reconnect-cancel']);
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
  // RC-04：取消本次重连（工具栏状态行“取消”按钮）
  cancelReconnect: () => ipcRenderer.send('qf-reconnect-cancel'),
  // v1.0.2：主题 / 探活 / 截图 / 关于
  toggleTheme: () => ipcRenderer.send('qf-theme-toggle'),
  onThemeState: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t)),
  // W1：三态模式广播 {mode, resolved}（内容页只收 resolved，工具栏要 mode）。
  onThemeMode: (cb) => ipcRenderer.on('qf-theme-mode', (e, m) => cb(m)),
  // W2：溢出菜单（原生 Menu）：把当前进菜单的 id 清单＋“更多”按钮位置发主进程；
  // 标签与动作由主进程白名单定，渲染端只传 id。
  showOverflowMenu: (items, x, y) => ipcRenderer.send('qf-overflow-menu', { items, x, y }),
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
