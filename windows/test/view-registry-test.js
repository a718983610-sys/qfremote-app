'use strict';
/*
 * S-001（审计 F-007）ViewRegistry 自检：登记／逐个释放／失败隔离／
 * 临时窗口统一 disposer；另静态断言 main.js closed 处理器先停 timer、
 * 再 disposeAll、最后清空引用，且全部视图创建点都已登记。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const { createViewRegistry } = require('../view-registry');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-c1/view-registry-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const SRC = path.join(__dirname, '..');

function mockView() {
  const wc = { destroyed: false, closed: 0, isDestroyed() { return this.destroyed; }, close() { this.closed++; this.destroyed = true; } };
  return { webContents: wc, _wc: wc };
}
function mockParent() {
  const removed = [];
  return { removed, removeChildView(v) { removed.push(v); } };
}
function mockWindow() {
  const w = { destroyed: false, closed: 0, destroyedN: 0, isDestroyed() { return this.destroyed; }, close() { this.closed++; this.destroyed = true; }, destroy() { this.destroyedN++; this.destroyed = true; } };
  return w;
}

{
  // A. 登记与释放顺序：parent.removeChildView 先于 webContents.close。
  const reg = createViewRegistry();
  const parent = mockParent();
  const v1 = mockView(); const v2 = mockView();
  const order = [];
  const origClose1 = v1._wc.close.bind(v1._wc);
  v1._wc.close = () => { order.push('close-v1'); origClose1(); };
  parent.removeChildView = (v) => { order.push(v === v1 ? 'remove-v1' : 'remove-v2'); };
  ok('A1_register', reg.register('console', v1, { parent }) && reg.register('toolbar', v2, { parent }) && reg.size() === 2);
  const r = reg.disposeAll();
  ok('A2_disposeAll_both', r.disposed.length === 2 && r.failed.length === 0 && reg.size() === 0);
  ok('A3_remove_before_close', order[0] === 'remove-v1' && order.indexOf('close-v1') > order.indexOf('remove-v1'));
  ok('A4_wc_closed', v1._wc.closed === 1 && v2._wc.closed === 1);
  ok('A5_disposeAll_idempotent', reg.disposeAll().disposed.length === 0);
}
{
  // B. 已销毁的 webContents 不再 close；释放失败只记 failed、不阻塞其余。
  const reg = createViewRegistry();
  const parent = mockParent();
  const dead = mockView(); dead._wc.destroyed = true;
  const bad = { webContents: { isDestroyed: () => false, close() { throw new Error('boom'); } } };
  const good = mockView();
  reg.register('dead', dead, { parent });
  reg.register('bad', bad, { parent });
  reg.register('good', good, { parent });
  const r = reg.disposeAll();
  ok('B1_dead_not_closed', dead._wc.closed === 0);
  ok('B2_failed_isolated', r.failed.length === 1 && r.failed[0].name === 'bad' && r.disposed.indexOf('good') >= 0 && good._wc.closed === 1);
  ok('B3_registry_emptied', reg.size() === 0);
}
{
  // C. 临时窗口：close 后仍存活且有 destroy 时补 destroy；closed 即 unregister。
  const reg = createViewRegistry();
  const w = mockWindow();
  w.close = () => { w.closed++; /* close 被拦截、不销毁（模拟进托盘） */ };
  reg.register('about', w, { kind: 'window' });
  const r = reg.disposeOne('about');
  ok('C1_window_close_then_destroy', r.disposed === true && w.closed === 1 && w.destroyedN === 1);
  ok('C2_unregister', reg.register('x', mockView(), {}) && reg.unregister('x') && !reg.has('x'));
  ok('C3_disposeOne_unknown', reg.disposeOne('nope').disposed === false);
}
{
  // D. 静态：main.js closed 处理器先停 timer、再 disposeAll、最后清空引用；
  // 全部视图创建点都已登记（toolbar/console/social/home/devices/session/
  // sessionBar/gate/extBar/splash/about/force/lock）。
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const closedIdx = main.indexOf("win.on('closed'");
  const closedBlock = main.slice(closedIdx, closedIdx + 2000);
  const iStop = closedBlock.indexOf('watchdog.stop()');
  const iDispose = closedBlock.indexOf('viewRegistry.disposeAll()');
  const iNull = closedBlock.indexOf('win = null;');
  ok('D1_closed_stop_before_dispose_before_null', iStop > 0 && iDispose > iStop && iNull > iDispose,
    { iStop, iDispose, iNull });
  const want = ['toolbar', 'console', 'social:', 'home', 'devices', 'session', 'sessionBar', 'gate', 'extBar', 'splash', 'about', 'force', 'lock'];
  const missing = want.filter((w) => main.indexOf("viewRegistry.register('" + w) < 0);
  ok('D2_all_views_registered', missing.length === 0, { missing });
  ok('D3_main_requires_registry', /require\('\.\/view-registry'\)/.test(main));
  ok('D4_pkg_files_has_registry', JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).build.files.indexOf('view-registry.js') >= 0);
}

const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
result.pass = failed.length === 0;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ pass: result.pass, failed }));
process.exit(result.pass ? 0 : 1);
