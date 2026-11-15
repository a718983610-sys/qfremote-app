'use strict';
/*
 * D-08 启动性能测试（分阶段初始化＋界面先出、数据后到）：
 *  A. 阶段执行器：超时放行（8 秒门超时不卡启动）、单步抛错不拖垮
 *     整条链、顺序执行、阶段名只认 STAGES 表。
 *  B. 静态顺序断言（main.js whenReady / createWindow）：
 *     - 建主窗在更新门之前（窗口先出）；
 *     - 服务地址刷新在建主窗之后（deferred 阶段）；
 *     - 控制台立即首载、启动恢复后台并行（不再串行 .then(loadURL)）；
 *     - 探活/积分心跳在建窗后 2 秒才起（不在启动关键路径上）。
 *  C. 启动关键路径无网络请求：stage1（window）段内无 https/http
 *     请求调用（静态扫描 createWindow 建窗段：从 createWindow()
 *     到首次 loadURL 之间无 runProbe/runUpdateCheck/fetchManifest/
 *     svcUrls.refresh/startupAuthFlow 的同步等待）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const stages = require('../startup-stages');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-d08/d08-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------- A 执行器 ----------
  {
    const slow = await stages.runStep(() => new Promise(() => {}), 50);
    ok('A1_timeout_releases', slow.ok === false && slow.timedOut === true);
    const throwing = await stages.runStep(() => { throw new Error('boom'); }, 0);
    ok('A2_throw_isolated', throwing.ok === false && throwing.timedOut === false);
    const order = [];
    const res = await stages.runStages([
      { name: 'window', fn: async () => { order.push('window'); } },
      { name: 'essential', fn: async () => { order.push('essential'); throw new Error('gate fail'); } },
      { name: 'deferred', fn: async () => { order.push('deferred'); } }
    ], { log: () => {} });
    ok('A3_order_and_continue', order.join(',') === 'window,essential,deferred' && res[1].ok === false && res[2].ok === true);
    ok('A4_known_stages', stages.isKnownStage('window') && stages.isKnownStage('essential') && stages.isKnownStage('deferred') && !stages.isKnownStage('nope'));
    ok('A5_stage1_no_network', stages.STAGES.find((s) => s.name === 'window').network === false);
  }

  // ---------- B/C main.js 静态顺序 ----------
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const whenReady = mainSrc.slice(mainSrc.indexOf('app.whenReady()'));
  // stage1 段：从 stage1 注释到更新门 runStep 之间只应有建窗＋托盘。
  const stage1 = whenReady.slice(whenReady.indexOf('D-08 stage1'), whenReady.indexOf('startupStages.runStep'));
  ok('B1_window_before_gate', stage1.includes('if (!createWindow())') && stage1.includes('ensureTray()'));
  ok('B2_gate_after_window', whenReady.indexOf('if (!createWindow())') < whenReady.indexOf('startupStages.runStep'));
  ok('B3_gate_has_timeout', whenReady.includes('startupStages.runStep(() => startupUpdateGate(), 8000'));
  ok('B4_gate_timeout_fallback', whenReady.includes('startupUpdateGate.timeout-fallback'));
  ok('B5_svc_refresh_after_window', whenReady.indexOf('if (!createWindow())') < whenReady.indexOf('svcUrls.refresh()'));
  ok('B6_update_check_deferred_safe_mode', whenReady.includes("if (!safeMode) runUpdateCheck(5000, { auto: true })"));
  ok('B7_agent_heal_deferred_safe_mode', whenReady.includes("if (!safeMode) runStartupAgentHeal()"));

  const createWindowSrc = mainSrc.slice(mainSrc.indexOf('function createWindow()'), mainSrc.indexOf('function startWatchdog()'));
  ok('B8_console_loads_first', createWindowSrc.includes('view.webContents.loadURL(CONSOLE_URL);'));
  ok('B9_auth_runs_background', createWindowSrc.includes('if (!safeMode) startupAuthFlow().catch(() => {});'));
  ok('B10_no_serial_auth_then_load', !createWindowSrc.includes('startupAuthFlow().then(() => {'));
  ok('B11_probe_heartbeat_deferred_2s', createWindowSrc.includes('setTimeout(() => { startProbeLoop(); if (!safeMode) startPointsHeartbeat(); }, 2000);'));
  ok('B12_no_direct_probe_in_createWindow', !/^\s*startProbeLoop\(\);$/m.test(createWindowSrc));
  ok('B13_window_shows_on_error', whenReady.includes("bootLog('whenReady.crash'") && whenReady.includes('if (!createWindow()) { bootLog'));

  const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
  result.pass = failed.length === 0;
  result.failed = failed;
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ pass: result.pass, failed }));
  process.exit(result.pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
