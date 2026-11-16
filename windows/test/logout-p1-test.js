'use strict';
/*
 * P1 登出修复自检（2026-11-11，纯 Node + DOM 桩，不需要 Electron/真服务器）：
 *  根因 A——SPA 登出无导航，processAuthPage 永不跑，clearConsoleSession
 *  永不清 cookie，致重启后自动登录：修为 handleManualLogout 登出即清。
 *  根因 B——processAuthPage console 分支无条件复位 manualLogout，冷启凭
 *  残留 cookie 恢复成 console 即洗掉标记：修为只在真实新登录（freshLogin）
 *  时清。
 *  根因 C——doLogout 的 api('/logout') 最长约 60 秒才放行 showAuth：修为
 *  8 秒竞速＋showAuth 必跑＋2 秒兜底重切。
 *  防御 D——登出后心跳 checkSession 凭残留会话把 S.auth 翻回 'in'：
 *  doLogout 置 S._manualLogout，checkSessionInner 守门，doLogin 清标记。
 *  P1-4a（2026-11-11）登出后登录表单仍不立即出现：r4 真机登出后内容区变
 *  深蓝空白（控制台视图底色 #0d2f66），刷新与切视图均不恢复，只有整应用
 *  重启才出现；webapp 侧 showAuth 在浏览器桩中已证实可用，根因在 Electron
 *  视图层。修为两层防御：主进程 handleManualLogout 末调
 *  recoverConsoleViewAfterLogout（强制控制台视图回前台＋3 秒后复核页面状
 *  态，空白文档即重载控制台地址）；webapp 侧 doLogout 兜底改 2 秒＋5 秒
 *  两轮、真可见性判定（getBoundingClientRect＋computed style）、S.auth
 *  守门（防 5 秒内快速重登被冲回登录页）。
 *  断言：
 *  P1 pageDetect 在 console 态读到 qfShellFreshLogin='1' -> freshLogin:true；
 *  P2 pageDetect 未设该键 -> freshLogin:false；
 *  P3 CLEAR_PAGE_STATE_JS 清掉 qfShellFreshLogin 键；
 *  P4 main.js handleManualLogout 含 clearConsoleSession 调用；
 *  P5 main.js console 分支无“无条件复位 manualLogout”，有 freshLogin 门；
 *  P6 app.js doLogout 含 8 秒竞速、置 S._manualLogout=true、有兜底重切
 *  （P1-4a 后为 [2000, 5000] 两轮＋真可见性判定）；
 *  P7 app.js checkSessionInner 含 S._manualLogout 守门；
 *  P8 app.js doLogin 成功路径写 qfShellFreshLogin 并清 S._manualLogout。
 *  P9 main.js handleManualLogout 末调 recoverConsoleViewAfterLogout；
 *  P10 recoverConsoleViewAfterLogout 含 showView('console')、manualLogout
 *  守门、DETECT_JS、state==='other'、loadURL(CONSOLE_URL)、3000ms、
 *  bootLog('logout.recover-reload')；
 *  P11 recoverConsoleViewAfterLogout 行为（vm＋mock）：a 登录态不重载、
 *  b 空白 other 重载、c 检测抛错重载、d 3 秒内已重登不重载、e console 态
 *  不重载、f det 为 null 重载；
 *  P12 app.js doLogout 兜底为 [2000, 5000] 两轮、真可见性判定
 *  （getBoundingClientRect）、S.auth==='out' 守门。
 *  P13 main.js 两处登出入口（qf-gate-logout / qf-logout-request）先等
 *  cookie 清净（await clearConsoleSession）再 loadURL 回登录页
 *  （P1-4a 第三轮：handleManualLogout 内清 cookie 是 fire-and-forget，
 *  loadURL 立即走会与重载后 checkSession /me 竞速，r6 真机实测出首页）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。跑法：node windows/test/logout-p1-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const autologin = require('../autologin');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr300/logout-p1-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

function makeEl(opts) {
  opts = opts || {};
  return {
    hidden: !!opts.hidden,
    textContent: opts.textContent || '',
    value: opts.value || '',
    getBoundingClientRect: () => ({ width: opts.w || 100, height: opts.h || 20 }),
  };
}

function makeCtx(elById, opts) {
  opts = opts || {};
  const sessionStore = opts.session || {};
  const sandbox = {
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    document: {
      getElementById: (id) => (Object.prototype.hasOwnProperty.call(elById, id) ? elById[id] : null),
      querySelector: () => null,
    },
    sessionStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null),
      setItem: (k, v) => { sessionStore[k] = String(v); },
      removeItem: (k) => { delete sessionStore[k]; },
    },
  };
  sandbox._sessionStore = sessionStore;
  if (opts.S !== undefined) sandbox.S = opts.S;
  vm.createContext(sandbox);
  return sandbox;
}

// P1/P2：pageDetect freshLogin 检测（console 态）。
{
  const shell = makeEl({ hidden: false });
  const ctx1 = makeCtx({ shellRoot: shell }, { session: { qfShellFreshLogin: '1' }, S: { user: 'testuser' } });
  const det1 = vm.runInContext(autologin.DETECT_JS, ctx1);
  ok('P1_detect_freshLogin_true', det1.state === 'console' && det1.freshLogin === true, { state: det1.state, freshLogin: det1.freshLogin });
  const ctx2 = makeCtx({ shellRoot: shell }, { session: {}, S: { user: 'testuser' } });
  const det2 = vm.runInContext(autologin.DETECT_JS, ctx2);
  ok('P2_detect_freshLogin_false', det2.state === 'console' && det2.freshLogin === false, { state: det2.state, freshLogin: det2.freshLogin });
}

// P3：CLEAR_PAGE_STATE_JS 清掉 fresh 键（与其余三键一起）。
{
  const ctx = makeCtx({}, { session: { qfShellPendingLogin: '{}', qfShellManualLogout: '1', qfShellFieldsCleared: '1', qfShellFreshLogin: '1' } });
  vm.runInContext(autologin.CLEAR_PAGE_STATE_JS, ctx);
  const left = Object.keys(ctx._sessionStore);
  ok('P3_clear_removes_fresh', left.length === 0, { left });
}

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
// W-08：app.js 已改名内容 hash 文件，经 ASSETS.json 解析当前文件名（只改读路径）
const _waDir = path.join(__dirname, '..', '..', 'server', 'webapp');
const _assets = JSON.parse(fs.readFileSync(path.join(_waDir, 'ASSETS.json'), 'utf8')).files;
const appJs = fs.readFileSync(path.join(_waDir, (_assets && _assets['app.js']) || 'app.js'), 'utf8');

// P4：handleManualLogout 登出即清 cookie。
{
  const at = mainJs.indexOf('function handleManualLogout()');
  const body = at >= 0 ? mainJs.slice(at, at + 3000) : '';
  ok('P4_handleLogout_clears_cookies', body.includes('autologinMod.clearConsoleSession(authSession(), CONSOLE_URL)'), {});
}
// P5：console 分支无无条件复位、有 freshLogin 门。
{
  const bad = /else if \(settings\.auth\.manualLogout\) \{\s*settings\.auth\.manualLogout = false;/.test(mainJs);
  const good = mainJs.includes('} else if (det.freshLogin) {');
  ok('P5_no_unconditional_reset', !bad && good, { bad, good });
}

// P6：doLogout 8 秒竞速＋S._manualLogout＋兜底（单次 2 秒或 [2000,5000] 两轮均可）。
{
  const at = appJs.indexOf('async function doLogout()');
  const body = at >= 0 ? appJs.slice(at, at + 4000) : '';
  const race = body.includes('Promise.race([') && body.includes('setTimeout(() => res(null), 8000)');
  const flag = body.includes('S._manualLogout = true;');
  const hasWatchdogTimer = body.includes('}, 2000);') || body.includes('[2000, 5000].forEach((ms) => {');
  const watch = body.includes("setTimeout(() => {") && body.includes("document.getElementById('loginForm')") && hasWatchdogTimer;
  ok('P6_doLogout_race_flag_watchdog', race && flag && watch, { race, flag, watch });
}
// P7：checkSessionInner 守门（a1f3d44 后为内存标记或持久标记任一即守门）。
{
  const at = appJs.indexOf('async function checkSessionInner(');
  const head = at >= 0 ? appJs.slice(at, at + 800) : '';
  ok('P7_checkSession_guards_manualLogout', head.includes('if (S._manualLogout || ManualLogout.is()) return false;'), {});
}
// P8：doLogin 成功路径写 fresh 标记并清标记。
{
  const at = appJs.indexOf('async function doLogin(');
  const body = at >= 0 ? appJs.slice(at, at + 4500) : '';
  const sets = body.includes("sessionStorage.setItem('qfShellFreshLogin', '1')");
  const clears = body.includes('S._manualLogout = false;');
  ok('P8_doLogin_sets_fresh_clears_flag', sets && clears, { sets, clears });
}

// P9：handleManualLogout 末调 recoverConsoleViewAfterLogout（P1-4a）。
{
  const at = mainJs.indexOf('function handleManualLogout()');
  const body = at >= 0 ? mainJs.slice(at, at + 4000) : '';
  ok('P9_handleLogout_recovers_view', body.includes('recoverConsoleViewAfterLogout();'), {});
}
// P10：recoverConsoleViewAfterLogout 含两层防御关键要素。
{
  const at = mainJs.indexOf('function recoverConsoleViewAfterLogout()');
  const endMark = '// ---- end recoverConsoleViewAfterLogout ----';
  const end = at >= 0 ? mainJs.indexOf(endMark, at) : -1;
  const body = at >= 0 && end > at ? mainJs.slice(at, end) : '';
  const front = body.includes("showView('console')");
  const guard = body.includes('if (!settings.auth.manualLogout) return;');
  const detect = body.includes('autologinMod.DETECT_JS');
  const other = body.includes("det.state === 'other'");
  const reload = body.includes('view.webContents.loadURL(CONSOLE_URL)');
  const delay = body.includes('}, 3000);');
  const log = body.includes("bootLog('logout.recover-reload'");
  ok('P10_recovery_has_both_layers', front && guard && detect && other && reload && delay && log, { front, guard, detect, other, reload, delay, log });
}
// P12：app.js doLogout 兜底为 [2000, 5000] 两轮＋真可见性判定＋S.auth 守门。
{
  const at = appJs.indexOf('async function doLogout()');
  const body = at >= 0 ? appJs.slice(at, at + 4000) : '';
  const twoRounds = body.includes('[2000, 5000].forEach((ms) => {');
  const vis = body.includes('getBoundingClientRect()') && body.includes('r.width > 0') && body.includes('r.height > 0');
  const guard = body.includes("if (S.auth !== 'out') return;");
  ok('P12_doLogout_watchdog_two_rounds_visible_guard', twoRounds && vis && guard, { twoRounds, vis, guard });
}
// P13：主进程两处登出入口先等 cookie 清净再回登录页（P1-4a 第三轮）。
{
  const check = (name) => {
    // F-08（2026-11-14）：main.js 的 IPC 注册已改走 trustedHandle 包装器，定位符同步改名；断言本身（先清 cookie 再回登录页）不变。
    const at = mainJs.indexOf("trustedHandle('" + name + "'");
    const body = at >= 0 ? mainJs.slice(at, at + 5000) : '';
    const awaitAt = body.indexOf('await autologinMod.clearConsoleSession(authSession(), CONSOLE_URL)');
    const loadAt = body.indexOf("loadURL(CONSOLE_URL + 'logout')");
    return awaitAt >= 0 && loadAt > awaitAt;
  };
  const gate = check('qf-gate-logout');
  const req = check('qf-logout-request');
  ok('P13_logout_awaits_cookie_clear_before_load', gate && req, { gate, req });
}

// P11：recoverConsoleViewAfterLogout 行为（vm＋mock，不需要 Electron）。
async function testRecovery() {
  const start = mainJs.indexOf('function recoverConsoleViewAfterLogout()');
  const endMark = '// ---- end recoverConsoleViewAfterLogout ----';
  const end = start >= 0 ? mainJs.indexOf(endMark, start) : -1;
  const fnSrc = start >= 0 && end > start ? mainJs.slice(start, end) : '';
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  async function runCase(detResult, opts) {
    opts = opts || {};
    let timerCb = null;
    let loadedUrl = null;
    const showed = [];
    const bootLogs = [];
    const settings = { auth: { manualLogout: opts.manualLogout !== false } };
    const view = {
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: () => (detResult instanceof Error ? Promise.reject(detResult) : Promise.resolve(detResult)),
        loadURL: (u) => { loadedUrl = u; },
      },
    };
    const sandbox = {
      showView: (k) => { showed.push(k); },
      setTimeout: (cb) => { timerCb = cb; return 1; },
      settings,
      view,
      autologinMod: { DETECT_JS: 'DETECT_JS_STUB' },
      bootLog: (tag, detail) => { bootLogs.push(tag + ':' + detail); },
      CONSOLE_URL: 'https://app.qfremote.top/console',
      Promise,
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc, sandbox);
    vm.runInContext('recoverConsoleViewAfterLogout();', sandbox);
    if (opts.clearBeforeFire) settings.auth.manualLogout = false;
    if (typeof timerCb === 'function') timerCb();
    await flush();
    return { showed, loadedUrl, bootLogs };
  }
  const a = await runCase({ state: 'login' });
  ok('P11a_login_no_reload', a.showed.indexOf('console') >= 0 && a.loadedUrl === null, { showed: a.showed, loadedUrl: a.loadedUrl });
  const b = await runCase({ state: 'other' });
  ok('P11b_other_reloads', b.loadedUrl === 'https://app.qfremote.top/console' && b.bootLogs.some((x) => x.indexOf('logout.recover-reload') === 0), { loadedUrl: b.loadedUrl, bootLogs: b.bootLogs });
  const c = await runCase(new Error('no context'));
  ok('P11c_detect_failed_reloads', c.loadedUrl === 'https://app.qfremote.top/console', { loadedUrl: c.loadedUrl });
  const d = await runCase({ state: 'other' }, { clearBeforeFire: true });
  ok('P11d_relogged_no_reload', d.loadedUrl === null, { loadedUrl: d.loadedUrl });
  const e = await runCase({ state: 'console' });
  ok('P11e_console_no_reload', e.loadedUrl === null, { loadedUrl: e.loadedUrl });
  const f = await runCase(null);
  ok('P11f_null_det_reloads', f.loadedUrl === 'https://app.qfremote.top/console', { loadedUrl: f.loadedUrl });
}

(async () => {
  await testRecovery();
  result.pass = Object.values(result.cases).every((c) => c.pass);
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})();
