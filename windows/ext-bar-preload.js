const { contextBridge, ipcRenderer } = require('electron');
// F-08 capability table：本桥只调下面这些 channel；主进程 ipc-trust.js 的
// IPC_CAPABILITIES 逐条校验 sender（精确 ext-bar.html＋主框架＋活窗口），
// 表外一律拒绝。只作声明与审计对照，强制执行在主进程。
const CAPABILITIES = Object.freeze(['qf-extbar-back']);
// 壳内网页返回栏桥（2.3.1 阶段 E）：购买/查询/申诉/客服等自有网页在
// 首页视图内打开时，顶部原生返回栏（与安卓 ShellWebPage 页栏同口径）。
contextBridge.exposeInMainWorld('qfExtBar', {
  back: () => ipcRenderer.send('qf-extbar-back'),
  onState: (cb) => ipcRenderer.on('qf-extbar-state', (e, s) => cb(s)),
  onTheme: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t))
});
