/* console-preload.js — 控制台视图（home／friends／chat／forum）的桌面桥。
 * 只暴露 window.qfLea 最小接口，供网页版 SPA（一键链接本机助手）调用：
 * - deviceInfo()：本机设备 id（node//… 形）／设备名／平台。
 * - deliverTicket(args)：把 issue 票据交主进程→QFRLEA→USH，USH 设备
 *   签名调 complete 换凭据；Key 明文只进 USH，永不回传到页面。
 * - ushStatus()：USH 是否在运行（ui.ping 探活）。
 * - selfBindStatus()：本机链接态（读 USH 元数据，不含凭据）。
 * - selfBindRenew(deviceId)：静默续期（USH 持凭据＋设备签名调 renew）。
 * - clearCredential()：清本机凭据（吊销后调用）。
 * 与 toolbar-preload.js 同款写法（contextBridge＋ipcRenderer.invoke，
 * sandbox:true 下可用）。页面须是同源控制台页才有此桥；纯浏览器打开
 * 网页版时 window.qfLea 不存在，SPA 走“下载桌面助手”分支。
 */
const { contextBridge, ipcRenderer } = require('electron');
// F-08 capability table：本桥只调下面这些 channel；主进程 ipc-trust.js 的
// IPC_CAPABILITIES 逐条校验 sender（自家源＋主框架＋活窗口），表外一律拒绝。
// 只作声明与审计对照，强制执行在主进程。
const CAPABILITIES = Object.freeze(['qf-lea-device-info', 'qf-lea-selfbind-deliver', 'qf-lea-ush-status', 'qf-lea-selfbind-status', 'qf-lea-selfbind-renew', 'qf-lea-selfbind-clear', 'qf-theme-state-get']);
contextBridge.exposeInMainWorld('qfLea', {
  deviceInfo: () => ipcRenderer.invoke('qf-lea-device-info'),
  deliverTicket: (args) => ipcRenderer.invoke('qf-lea-selfbind-deliver', args),
  ushStatus: () => ipcRenderer.invoke('qf-lea-ush-status'),
  selfBindStatus: () => ipcRenderer.invoke('qf-lea-selfbind-status'),
  selfBindRenew: (deviceId) => ipcRenderer.invoke('qf-lea-selfbind-renew', deviceId),
  clearCredential: () => ipcRenderer.invoke('qf-lea-selfbind-clear'),
  // P0-2 主题同步（只读＋推送监听，不写任何设置）：主进程下发 resolved
  // （'dark'|'blue'，'blue' 为浅色历史键名）与 mode（'system'|'blue'|'dark'）；
  // 页面收到后按“壳手动 ＞ 本机偏好 ＞ 系统”统一落主题。getThemeState 供页面
  // 初次加载同步一次（视图懒创建时无广播可接，须主动取）。
  onTheme: (cb) => {
    ipcRenderer.on('qf-theme-state', (e, t) => { try { cb(t, null); } catch (_) {} });
    ipcRenderer.on('qf-theme-mode', (e, m) => { try { cb(m && m.resolved, m && m.mode); } catch (_) {} });
  },
  getThemeState: () => ipcRenderer.invoke('qf-theme-state-get'),
});
