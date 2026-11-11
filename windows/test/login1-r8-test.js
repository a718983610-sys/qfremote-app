'use strict';
/*
 * r8 登录 #1 回归自检（2026-11-11，纯 Node + vm 桩，不需要 Electron/真服务器）：
 *  根因——登出后立即重登（About 登出→表单立即出现→当场登录）必落 BanLock
 *  “登录状态已结束”插页、须登第二次（r7 实证：服务端 ok:true、应用插页、
 *  LEA 全程零记录）。确切机制（见 evidence-r8-login1-20261111/MECHANISM.md）：
 *  7fa370a 的 500ms 补跑恰落在 doLogin 等 /me＋/stats 的窗口里——页面仍是
 *  登录表单、主进程 manualLogout 仍为真，processAuthPage 登录分支无条件
 *  执行 clearConsoleSession，把刚下发的 新会话 xid 一并删掉；随后 doLogin
 *  回 ok 翻壳、立即心跳 401 落插页；2500ms 补跑撞上插页已画，console 分支
 *  永不跑，LEA 零记录。登录 #2/#3 正常只是竞速时序差异（翻壳先于补跑、
 *  或 manualLogout 已清）。
 *  修法（只动 windows/main.js）：
 *  ① /qf-login POST 响应头到达时打戳 lastLoginPostAt；登出时归零。
 *  ② processAuthPage 登录分支清 cookie＋CLEAR_PAGE_STATE_JS 之前守门：
 *      det.freshLogin 为真、或距最近 POST 不足 LOGIN_POST_QUIET_MS（15s）
 *      时整块跳过（pendingManualClear 也不消费），跳过记 bootLog 供真机复核。
 *  ③ 补跑加第三档 8000ms：慢网翻壳超过 2500ms 时仍有一次 console 分支观测，
 *      LEA 通知不漏（notifyLeaLogin 有去重）。
 *  断言：
 *  R1 onHeadersReceived 内 POST 打戳 lastLoginPostAt；
 *  R2 handleManualLogout 归零 lastLoginPostAt；
 *  R3 LOGIN_POST_QUIET_MS=15000、登录分支含 freshLogin＋freshPost 双路守门、
 *      跳过记 bootLog('auth.skip-cookie-clear-fresh-login')；
 *  R4 scheduleLoginNotifyCheck 为 500/2500/8000 三档；
 *  R5 行为（vm 抽 processAuthPage）：新 POST 后（age 0）＋登录态＋manualLogout
 *      → 不清 cookie、不清页状态、pendingManualClear 不消费、记跳过日志；
 *  R6 行为：无 POST（lastLoginPostAt=0）→ 清 cookie 一次、清页状态、
 *      pendingManualClear 消费（r6 登出清理口径不变）；
 *  R7 行为：POST 已过期（age 20000）→ 照常清 cookie（静默窗过期恢复清理）；
 *  R8 行为：det.freshLogin=true 且 POST 已过期 → 不清 cookie（freshLogin 臂独立生效）；
 *  R9 行为（vm 抽调度器）：三档 500/2500/8000，各调一次 processAuthPage；
 *      第二次调度清掉第一次的三枚计时器。
 *  R10（r8 副项）：notifyLeaLogin 成功路径记 bootLog('lea.login-notify-ok')
 *      （去重保证一次登录只记一次），4a 通过时 boot log 有可观测成功行。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。跑法：node windows/test/login1-r8-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr300/login1-r8-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// R1：/qf-login onHeadersReceived 内 POST 打戳。
{
  const at = mainJs.indexOf("ses.webRequest.onHeadersReceived({ urls: ['*://' + ALLOWED_HOST + '/qf-login*'] }");
  const body = at >= 0 ? mainJs.slice(at, at + 1200) : '';
  const stamp = body.includes("if (details && details.method === 'POST') lastLoginPostAt = Date.now();");
  ok('R1_login_post_stamps_time', stamp, {});
}
// R2：handleManualLogout 归零打戳。
{
  const at = mainJs.indexOf('function handleManualLogout()');
  const body = at >= 0 ? mainJs.slice(at, at + 1200) : '';
  ok('R2_logout_resets_stamp', body.includes('lastLoginPostAt = 0;'), {});
}
// R3：静默窗常量＋双路守门＋跳过日志。
const QUIET_MS = (() => {
  const m = /const LOGIN_POST_QUIET_MS = (\d+);/.exec(mainJs);
  return m ? Number(m[1]) : null;
})();
{
  const at = mainJs.indexOf('if (settings.auth.manualLogout || pendingManualClear) {');
  const body = at >= 0 ? mainJs.slice(at, at + 2200) : '';
  const freshArm = body.includes('!det.freshLogin');
  const postArm = body.includes('Date.now() - lastLoginPostAt < LOGIN_POST_QUIET_MS');
  const skipLog = body.includes("bootLog('auth.skip-cookie-clear-fresh-login')");
  const wipeInside = body.includes('clearConsoleSession(authSession(), CONSOLE_URL)');
  ok('R3_guard_two_arms_and_skip_log', QUIET_MS === 15000 && freshArm && postArm && skipLog && wipeInside,
    { QUIET_MS, freshArm, postArm, skipLog, wipeInside });
}
// R4：调度器三档。
{
  const at = mainJs.indexOf('function scheduleLoginNotifyCheck()');
  const endMark = '// ---- end scheduleLoginNotifyCheck ----';
  const end = at >= 0 ? mainJs.indexOf(endMark, at) : -1;
  const body = at >= 0 && end > at ? mainJs.slice(at, end) : '';
  const d500 = body.includes('}, 500)');
  const d2500 = body.includes('}, 2500)');
  const d8000 = body.includes('}, 8000)');
  ok('R4_scheduler_three_delays', d500 && d2500 && d8000, { d500, d2500, d8000 });
}

// ---- R5–R8：抽取 processAuthPage 做 vm 行为测试 ----
function extractFn(src, startMark, endMark) {
  const at = src.indexOf(startMark);
  const end = at >= 0 ? src.indexOf(endMark, at) : -1;
  return at >= 0 && end > at ? src.slice(at, end) : '';
}
const authPageSrc = extractFn(mainJs, 'async function processAuthPage()', 'async function startupAuthFlow()');

async function runAuthPage(opts) {
  // opts: { lastLoginPostAt, det, manualLogout }
  const calls = { clearConsole: 0, clearPageState: 0, flush: 0, bootLogs: [] };
  const det = Object.assign({ state: 'login', failedBanner: false, failureText: '', manualLogout: false, fieldsCleared: false, pending: null, username: '', freshLogin: false }, opts.det || {});
  const settings = { auth: { manualLogout: !!opts.manualLogout, rememberDevice: false } };
  const sandbox = {
    PREVIEW: false,
    authProcessing: false,
    view: {
      webContents: {
        isDestroyed: () => false,
        getURL: () => 'https://app.qfremote.top/',
        executeJavaScript: (js) => {
          if (js === 'DETECT_JS_STUB') return Promise.resolve(det);
          if (js === 'CLEAR_PAGE_STATE_STUB') { calls.clearPageState++; return Promise.resolve(true); }
          return Promise.resolve(true);
        },
      },
    },
    isTargetUrl: () => true,
    pendingVerify: null,
    authNoticePending: false,
    settings,
    pendingManualClear: true,
    gateCredsMemory: null,
    autologinMod: {
      DETECT_JS: 'DETECT_JS_STUB',
      CLEAR_PAGE_STATE_JS: 'CLEAR_PAGE_STATE_STUB',
      buildInjectScript: () => 'INJECT_STUB',
      clearConsoleSession: () => { calls.clearConsole++; return Promise.resolve(1); },
      planHarvest: () => ({ save: null, clearVault: false, rememberDevice: null, clearManualLogout: false }),
    },
    authSession: () => ({ dummy: true }),
    CONSOLE_URL: 'https://app.qfremote.top/',
    flushConsoleCookies: () => { calls.flush++; },
    authPolicy: { decide: () => ({ action: 'none' }), noteFailure: () => {}, noteSuccess: () => {}, noteAttempt: () => {} },
    credStore: { has: () => false, load: () => null, save: () => {}, clear: () => {} },
    bootLog: (tag, detail) => { calls.bootLogs.push(tag + (detail ? ':' + detail : '')); },
    lastLoginPostAt: opts.lastLoginPostAt,
    LOGIN_POST_QUIET_MS: QUIET_MS,
    oscTripped: false,
    // 登录态路径上不执行、但为防引用缺失一并给桩：
    clearPendingVerify: () => {}, isPendingVerifyFresh: () => false,
    noteLoginLanding: () => false, oscNoticeShown: false, showAuthNotice: () => {},
    silentLoginInFlight: false, silentLoginWithCreds: () => Promise.resolve(false),
    setPendingVerify: () => {}, safeLoad: () => {},
    viewMgr: { noteLogin: () => {}, noteLogout: () => {} }, schedulePreload: () => {},
    devicesLanded: true, showView: () => {}, runLicenseGateCheck: () => Promise.resolve(),
    maybeInstallSystemServices: () => Promise.resolve(), notifyLeaLogin: () => Promise.resolve({ ok: true }),
    currentGateUsername: () => '', saveSettings: () => {},
    Promise, Date, setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(authPageSrc, sandbox);
  await vm.runInContext('processAuthPage()', sandbox);
  return { calls, pendingManualClear: sandbox.pendingManualClear, settings };
}

async function runBehavior() {
  const now = Date.now();
  // R5：新 POST 后 0 秒——r7 登录 #1 复现态：不清 cookie、不清页状态、不消费标记、记跳过日志。
  {
    const r = await runAuthPage({ lastLoginPostAt: now, manualLogout: true, det: { state: 'login', freshLogin: false } });
    ok('R5_fresh_post_skips_wipe', r.calls.clearConsole === 0 && r.calls.clearPageState === 0
      && r.pendingManualClear === true && r.calls.bootLogs.some((x) => x.indexOf('auth.skip-cookie-clear-fresh-login') === 0),
      { clearConsole: r.calls.clearConsole, clearPageState: r.calls.clearPageState, pendingManualClear: r.pendingManualClear, bootLogs: r.calls.bootLogs });
  }
  // R6：无 POST——r6 登出清理口径不变：清一次、消费标记。
  {
    const r = await runAuthPage({ lastLoginPostAt: 0, manualLogout: true, det: { state: 'login', freshLogin: false } });
    ok('R6_no_post_still_wipes', r.calls.clearConsole === 1 && r.calls.clearPageState === 1 && r.pendingManualClear === false,
      { clearConsole: r.calls.clearConsole, clearPageState: r.calls.clearPageState, pendingManualClear: r.pendingManualClear });
  }
  // R7：POST 已过期（20s > 15s 窗）——照常清。
  {
    const r = await runAuthPage({ lastLoginPostAt: now - 20000, manualLogout: true, det: { state: 'login', freshLogin: false } });
    ok('R7_stale_post_wipes', r.calls.clearConsole === 1 && r.pendingManualClear === false,
      { clearConsole: r.calls.clearConsole, pendingManualClear: r.pendingManualClear });
  }
  // R8：freshLogin 已写、POST 已过期——freshLogin 臂独立生效，不清。
  {
    const r = await runAuthPage({ lastLoginPostAt: now - 20000, manualLogout: true, det: { state: 'login', freshLogin: true } });
    ok('R8_freshLogin_arm_skips_wipe', r.calls.clearConsole === 0 && r.calls.clearPageState === 0 && r.pendingManualClear === true,
      { clearConsole: r.calls.clearConsole, clearPageState: r.calls.clearPageState, pendingManualClear: r.pendingManualClear });
  }
}

// ---- R9：调度器行为（vm＋mock 计时器） ----
function runScheduler(times) {
  const schedSrc = extractFn(mainJs, 'let lastLoginPostAt = 0;', '// ---- end scheduleLoginNotifyCheck ----');
  const timers = [];
  const cleared = [];
  let calls = 0;
  let nextId = 1;
  const sandbox = {
    setTimeout: (cb, ms) => { const id = nextId++; timers.push({ id, cb, ms }); return id; },
    clearTimeout: (id) => { cleared.push(id); const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    processAuthPage: () => { calls++; return Promise.resolve(); },
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(schedSrc, sandbox);
  for (let i = 0; i < times; i++) vm.runInContext('scheduleLoginNotifyCheck();', sandbox);
  return { sandbox, timers, cleared, get calls() { return calls; } };
}
{
  const r = runScheduler(1);
  const delays = r.timers.map((t) => t.ms).sort((a, b) => a - b);
  const cbs = r.timers.slice();
  for (const t of cbs) t.cb();
  ok('R9_scheduler_three_delays_call_auth_page', JSON.stringify(delays) === JSON.stringify([500, 2500, 8000]) && r.calls === 3, { delays, calls: r.calls });
  const r2 = runScheduler(2);
  const live = r2.timers.map((t) => t.ms).sort((a, b) => a - b);
  ok('R9b_second_schedule_clears_first', r2.cleared.length === 3 && JSON.stringify(live) === JSON.stringify([500, 2500, 8000]), { cleared: r2.cleared, live });
}
// R10（r8 副项）：notifyLeaLogin 成功后记一行 bootLog（去重点之后、无账号内容）。
{
  const at = mainJs.indexOf('leaLastNotifiedAccount = String(account);');
  const body = at >= 0 ? mainJs.slice(at, at + 400) : '';
  ok('R10_login_notify_ok_bootlog', body.includes("bootLog('lea.login-notify-ok')"), {});
}

(async () => {
  await runBehavior();
  result.pass = Object.values(result.cases).every((c) => c.pass);
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})();
