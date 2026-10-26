const { contextBridge, ipcRenderer } = require('electron');
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
