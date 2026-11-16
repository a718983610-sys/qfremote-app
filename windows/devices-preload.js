const { contextBridge, ipcRenderer } = require('electron');
// F-08 capability table：本桥只调下面这些 channel；主进程 ipc-trust.js 的
// IPC_CAPABILITIES 逐条校验 sender（精确 devices.html＋主框架＋活窗口），
// 表外一律拒绝。只作声明与审计对照，强制执行在主进程。
const CAPABILITIES = Object.freeze(['qf-devices-list', 'qf-devices-open']);
// 收编设备页桥（2.3.2 收编 Windows 线）：页面只经本桥取设备清单模型与
// 发「打开会话」指令。清单由主进程在已登录的控制台视图同源上下文里经
// 控制通道取得并归一（本地页直连 WS 带不上会话 cookie，会被服务端以
// noauth 关闭——真环境实测）；桥不传账号密码、不产生第二次登录。
contextBridge.exposeInMainWorld('qfDevices', {
  list: () => ipcRenderer.invoke('qf-devices-list'),
  open: (nodeId, name, mode) => ipcRenderer.send('qf-devices-open', { nodeId, name, mode }),
  onReset: (cb) => ipcRenderer.on('qf-devices-reset', () => cb()),
  // r12②：登出只清不读（见 main.js handleManualLogout）——clear 只清
  // 模型与状态、不跑 load()，不再制造一次必失败的读取。
  onClear: (cb) => ipcRenderer.on('qf-devices-clear', () => cb()),
  onTheme: (cb) => ipcRenderer.on('qf-theme-state', (e, t) => cb(t))
});
