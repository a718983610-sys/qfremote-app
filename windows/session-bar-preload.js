const { contextBridge, ipcRenderer } = require('electron');
// F-08 capability table：本桥只调下面这些 channel；主进程 ipc-trust.js 的
// IPC_CAPABILITIES 逐条校验 sender（精确 session-bar.html＋主框架＋活窗口），
// 表外一律拒绝。只作声明与审计对照，强制执行在主进程。
const CAPABILITIES = Object.freeze(['qf-sessionbar-back']);
// 收编会话栏桥（2.3.2 收编 Windows 线）：会话视图顶部的壳内会话栏——
// 显示当前设备与会话类型，「断开并返回」回设备页（主进程据此真正
// 断开 relay 并卸载会话视图，不是只切走画面）。
contextBridge.exposeInMainWorld('qfSessionBar', {
  back: () => ipcRenderer.send('qf-sessionbar-back'),
  onState: (cb) => ipcRenderer.on('qf-sessionbar-state', (e, s) => cb(s)),
  onTheme: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t))
});
