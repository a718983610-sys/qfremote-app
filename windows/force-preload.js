const { contextBridge, ipcRenderer } = require('electron');
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
