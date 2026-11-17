const { contextBridge, ipcRenderer } = require('electron');
// F-08 capability table：本桥只调下面这些 channel；主进程 ipc-trust.js 的
// IPC_CAPABILITIES 逐条校验 sender（精确 license-gate.html＋主框架＋活窗口），
// 表外一律拒绝。只作声明与审计对照，强制执行在主进程。
const CAPABILITIES = Object.freeze(['qf-gate-get', 'qf-gate-claim', 'qf-gate-open', 'qf-gate-recheck', 'qf-gate-logout']);
// 许可拦截面桥（2.3.1 阶段 E）：拦截面是壳内本地页，只暴露许可动作，
// 不暴露任何凭据/会话细节；领取只回主进程算好的展示结果。
contextBridge.exposeInMainWorld('qfGate', {
  getState: () => ipcRenderer.invoke('qf-gate-get'),
  onState: (cb) => ipcRenderer.on('qf-gate-state', (e, s) => cb(s)),
  onTheme: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t)),
  claim: (key) => ipcRenderer.invoke('qf-gate-claim', key),
  open: (target) => ipcRenderer.send('qf-gate-open', target),
  recheck: () => ipcRenderer.invoke('qf-gate-recheck'),
  logout: () => ipcRenderer.invoke('qf-gate-logout')
});
