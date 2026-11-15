'use strict';
/*
 * QFRemote Windows 运行端 — 托盘管理（D-07，3.0.0）
 * ================================================================
 * 来源：RustDesk 1.5.0 ghost/duplicate 托盘图标修复、Clash Verge
 * Rev（托盘即主界面）、VLC/OBS（三开关拆开）、Joplin（点 X 默认
 * 进托盘被骂——必须显式提示）。
 * 契约：
 *   1. 图标唯一：同一时刻最多一个 live Tray；ensureTray() 先销毁
 *      旧实例再建新实例；destroy() 后实例置空；isDestroyed 的
 *      Tray 永不再用。Explorer 重启导致图标丢失时，调用方定时调
 *      ensureTray()（main.js 每 60 秒探活时顺带调用，Tray 对象
 *      已销毁即重建；Electron 未暴露 Explorer 重启事件，真机
 *      回归见收尾报告 ECS 项）。
 *   2. 托盘菜单覆盖常用操作：打开主窗口、重新连接、打开日志、
 *      检查更新、关于、退出；菜单首行显示当前状态（在线/离线/
 *      重连中），图标 tooltip 同步状态。
 *   3. 三开关拆开（settings.tray 三个独立键，缺省全 false）：
 *      enabled（显示托盘图标）、minimizeToTray（启动最小化到托盘）、
 *      closeToTray（点 X 最小化到托盘而非退出）。
 *   4. 点 X 行为显式提示：closeToTray 未定（undefined）时首次点 X
 *      由 main.js 弹一次明确选择（最小化到托盘 / 退出），并记下
 *      选择；不学 Joplin 的不声不响默认进托盘。
 * 本模块不直接 require('electron')：electron 对象（Tray/Menu/
 * nativeImage/shell/app）由调用方注入，便于沙箱单测用假对象验证
 * 唯一性与菜单结构；生产接线见 main.js。
 */
const path = require('path');

const DEFAULT_TRAY_SETTINGS = Object.freeze({
  enabled: false,
  minimizeToTray: false,
  closeToTray: false
});

function traySettings(settings) {
  const t = (settings && settings.tray) || {};
  return {
    enabled: t.enabled === true,
    minimizeToTray: t.minimizeToTray === true,
    closeToTray: t.closeToTray === true,
    // closeToTray 是否已由用户明确决定过（undefined=未定，须首次弹提示）
    closeToTrayDecided: typeof t.closeToTray === 'boolean'
  };
}

// 菜单模板（纯数据，调用方传入 callbacks 后由 buildMenu 拼成模板）。
// callbacks: { onShow, onReconnect, onOpenLog, onCheckUpdate, onAbout, onQuit }
function buildMenuTemplate(statusText, callbacks) {
  const cb = callbacks || {};
  const noop = () => {};
  return [
    { label: '状态：' + statusText, enabled: false },
    { type: 'separator' },
    { label: '打开主窗口', click: cb.onShow || noop },
    { label: '重新连接', click: cb.onReconnect || noop },
    { label: '打开日志', click: cb.onOpenLog || noop },
    { label: '检查更新', click: cb.onCheckUpdate || noop },
    { type: 'separator' },
    { label: '关于 QFRemote', click: cb.onAbout || noop },
    { label: '退出', click: cb.onQuit || noop }
  ];
}

function createTrayManager(electron, opts) {
  const o = opts || {};
  const iconPath = o.iconPath || path.join(__dirname, 'build', 'icon.png');
  let tray = null;
  let lastStatus = '离线';

  function destroyTray() {
    if (!tray) return;
    try { tray.destroy(); } catch (e) { /* ignore */ }
    tray = null;
  }

  function isAlive() {
    if (!tray) return false;
    try {
      if (typeof tray.isDestroyed === 'function' && tray.isDestroyed()) { tray = null; return false; }
    } catch (e) { tray = null; return false; }
    return true;
  }

  // 幂等建托盘：已有 live 实例时先销毁再建，保证图标唯一。
  // 返回 { created: bool, reason }。
  function ensureTray(callbacks) {
    if (!electron || !electron.Tray) return { created: false, reason: 'no-electron-tray' };
    destroyTray();
    let image = iconPath;
    try {
      if (electron.nativeImage && typeof electron.nativeImage.createFromPath === 'function') {
        image = electron.nativeImage.createFromPath(iconPath);
      }
    } catch (e) { image = iconPath; }
    try {
      tray = new electron.Tray(image);
    } catch (e) {
      tray = null;
      return { created: false, reason: 'tray-create-failed: ' + ((e && e.message) || e) };
    }
    setStatus(lastStatus, callbacks);
    try {
      if (typeof tray.on === 'function') {
        tray.on('click', () => { try { if (callbacks && callbacks.onShow) callbacks.onShow(); } catch (e) { /* ignore */ } });
      }
    } catch (e) { /* ignore */ }
    return { created: true, reason: 'ok' };
  }

  function setStatus(status, callbacks) {
    lastStatus = status || lastStatus;
    if (!isAlive()) return false;
    try {
      if (typeof tray.setToolTip === 'function') tray.setToolTip('QFRemote（' + lastStatus + '）');
    } catch (e) { /* ignore */ }
    try {
      if (electron.Menu && typeof electron.Menu.buildFromTemplate === 'function') {
        tray.setContextMenu(electron.Menu.buildFromTemplate(buildMenuTemplate(lastStatus, callbacks || {})));
      }
    } catch (e) { /* ignore */ }
    return true;
  }

  return {
    ensureTray,
    destroyTray,
    setStatus,
    isAlive,
    getStatus: () => lastStatus,
    // 单测用：当前 live 实例数（0 或 1）。
    liveCount: () => (isAlive() ? 1 : 0)
  };
}

module.exports = { DEFAULT_TRAY_SETTINGS, traySettings, buildMenuTemplate, createTrayManager };
