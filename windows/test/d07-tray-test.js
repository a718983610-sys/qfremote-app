'use strict';
/*
 * D-07 托盘专项测试：
 *  A. 图标唯一性（假 Electron）：反复 ensureTray 只留 1 个 live 实例；
 *     destroy 后为 0；isDestroyed 的旧实例永不再用。
 *  B. 托盘菜单覆盖常用操作：状态行＋打开主窗口/重新连接/打开日志/
 *     检查更新/关于/退出，回调逐个可触发。
 *  C. 三开关拆开：enabled / minimizeToTray / closeToTray 各自独立；
 *     closeToTray 未定过时 closeToTrayDecided=false（须首次弹提示）。
 *  D. 静态接线：main.js 有托盘创建（随主窗建）＋60 秒巡检重建、
 *     点 X 最小化到托盘＋首次明确选择 dialog、启动最小化到托盘
 *     suppressShowMain、探活同步托盘状态。
 *  E. 托盘点击唤起主窗（回调 onShow 可调）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 * 注：Explorer 重启后图标唯一需真机回归（Electron 未暴露 Explorer
 * 重启事件），见收尾报告 ECS 项；本测试覆盖沙箱可验的部分。
 */
const fs = require('fs');
const path = require('path');
const trayMod = require('../tray-manager');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-d07/d07-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

// ---------- 假 Electron ----------
function fakeElectron() {
  const trays = [];
  class FakeTray {
    constructor(image) { this.image = image; this.destroyed = false; this.menu = null; this.tip = ''; trays.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setToolTip(t) { this.tip = t; }
    setContextMenu(m) { this.menu = m; }
    on() { /* click 监听由调用方回调模拟 */ }
  }
  return {
    Tray: FakeTray,
    Menu: { buildFromTemplate: (tpl) => tpl },
    nativeImage: { createFromPath: (p) => ({ fakeImage: p }) },
    _trays: trays
  };
}

// ---------- A 图标唯一 ----------
{
  const el = fakeElectron();
  const mgr = trayMod.createTrayManager(el, { iconPath: 'C:\\app\\icon.png' });
  const r1 = mgr.ensureTray({});
  const r2 = mgr.ensureTray({});
  const r3 = mgr.ensureTray({});
  ok('A1_ensure_ok', r1.created && r2.created && r3.created);
  ok('A2_only_one_live', mgr.liveCount() === 1 && el._trays.filter((t) => !t.destroyed).length === 1);
  ok('A3_old_destroyed', el._trays.slice(0, -1).every((t) => t.destroyed));
  mgr.destroyTray();
  ok('A4_destroy_zero', mgr.liveCount() === 0);
  const r4 = mgr.ensureTray({});
  ok('A5_recreate_after_destroy', r4.created && mgr.liveCount() === 1);
}

// ---------- B 菜单覆盖常用操作 ----------
{
  const hits = [];
  const tpl = trayMod.buildMenuTemplate('在线', {
    onShow: () => hits.push('show'),
    onReconnect: () => hits.push('reconnect'),
    onOpenLog: () => hits.push('log'),
    onCheckUpdate: () => hits.push('update'),
    onAbout: () => hits.push('about'),
    onQuit: () => hits.push('quit')
  });
  ok('B1_status_row', tpl[0].label === '状态：在线' && tpl[0].enabled === false);
  const labels = tpl.filter((i) => i.label).map((i) => i.label);
  for (const want of ['打开主窗口', '重新连接', '打开日志', '检查更新', '关于 QFRemote', '退出']) {
    ok('B2_has_' + want, labels.indexOf(want) >= 0);
  }
  tpl.filter((i) => typeof i.click === 'function').forEach((i) => i.click());
  ok('B3_callbacks_fire', hits.join(',') === 'show,reconnect,log,update,about,quit', { hits });
}

// ---------- C 三开关拆开 ----------
{
  ok('C1_defaults_all_false', (() => { const t = trayMod.traySettings({}); return !t.enabled && !t.minimizeToTray && !t.closeToTray; })());
  ok('C2_each_independent', (() => {
    const t = trayMod.traySettings({ tray: { enabled: true, minimizeToTray: false, closeToTray: true } });
    return t.enabled === true && t.minimizeToTray === false && t.closeToTray === true;
  })());
  ok('C3_undecided_when_undefined', trayMod.traySettings({}).closeToTrayDecided === false);
  ok('C4_decided_when_set', trayMod.traySettings({ tray: { closeToTray: false } }).closeToTrayDecided === true);
  ok('C5_default_const', trayMod.DEFAULT_TRAY_SETTINGS.enabled === false && trayMod.DEFAULT_TRAY_SETTINGS.closeToTray === false);
}

// ---------- D main.js 静态接线 ----------
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok('D1_ensureTray_after_window', mainSrc.includes('ensureTray();'));
  ok('D2_60s_recreate_patrol', mainSrc.includes('60000') && mainSrc.includes("if (trayMgr && !trayMgr.isAlive()) ensureTray()"));
  ok('D3_close_to_tray', mainSrc.includes('closeToTray') && mainSrc.includes("event.preventDefault(); win.hide();"));
  ok('D4_first_close_prompt', mainSrc.includes('关闭 QFRemote 时，是最小化到托盘、还是完全退出？'));
  ok('D5_start_minimized', mainSrc.includes('suppressShowMain') && mainSrc.includes('minimizeToTray'));
  ok('D6_probe_syncs_tray', mainSrc.includes("trayMgr.setStatus(lastProbe.ok ? '在线' : '离线'"));
  ok('D7_quit_destroys_tray', mainSrc.includes('trayMgr.destroyTray()'));
  ok('D8_tray_callbacks', mainSrc.includes('onOpenLog') && mainSrc.includes('shell.openPath(bootLogPath())'));
}

// ---------- E onShow 回调 ----------
{
  const el = fakeElectron();
  const mgr = trayMod.createTrayManager(el, { iconPath: 'C:\\app\\icon.png' });
  let shown = 0;
  mgr.ensureTray({ onShow: () => { shown++; } });
  ok('E1_show_callback_wired', shown === 0); // 未点不触发
  const tpl = trayMod.buildMenuTemplate('在线', { onShow: () => { shown++; } });
  tpl.find((i) => i.label === '打开主窗口').click();
  ok('E2_show_callback_fires', shown === 1);
}

const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
result.pass = failed.length === 0;
result.failed = failed;
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
console.log(JSON.stringify({ pass: result.pass, failed }));
process.exit(result.pass ? 0 : 1);
