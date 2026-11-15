const { contextBridge, ipcRenderer } = require('electron');
// F-08 capability table：本桥只调下面这些 channel；主进程 ipc-trust.js 的
// IPC_CAPABILITIES 逐条校验 sender（精确 force-update.html＋主框架＋活窗口），
// 表外一律拒绝。只作声明与审计对照，强制执行在主进程。
const CAPABILITIES = Object.freeze(['qf-force-get', 'qf-force-download', 'qf-force-open', 'qf-force-release']);
// 强制更新页专用桥：只有取状态、下载、安装更新三件事——没有关闭、没有跳过。
contextBridge.exposeInMainWorld('qfForce', {
  getState: () => ipcRenderer.invoke('qf-force-get'),
  onState: (cb) => ipcRenderer.on('qf-force-state', (e, s) => cb(s)),
  onProgress: (cb) => ipcRenderer.on('qf-force-progress', (e, p) => cb(p)),
  download: () => ipcRenderer.send('qf-force-download'),
  openInstaller: () => ipcRenderer.send('qf-force-open'),
  // 仅在下载失败态可用（页面控制显隐）：先进入软件，下次启动再更新
  release: () => ipcRenderer.send('qf-force-release')
});
