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
 *  断言：
 *  P1 pageDetect 在 console 态读到 qfShellFreshLogin='1' -> freshLogin:true；
 *  P2 pageDetect 未设该键 -> freshLogin:false；
 *  P3 CLEAR_PAGE_STATE_JS 清掉 qfShellFreshLogin 键；
 *  P4 main.js handleManualLogout 含 clearConsoleSession 调用；
 *  P5 main.js console 分支无“无条件复位 manualLogout”，有 freshLogin 门；
 *  P6 app.js doLogout 含 8 秒竞速、置 S._manualLogout=true、有 2 秒兜底；
 *  P7 app.js checkSessionInner 含 S._manualLogout 守门；
 *  P8 app.js doLogin 成功路径写 qfShellFreshLogin 并清 S._manualLogout。
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
const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'webapp', 'app.js'), 'utf8');

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

// P6：doLogout 8 秒竞速＋S._manualLogout＋2 秒兜底。
{
  const at = appJs.indexOf('async function doLogout()');
  const body = at >= 0 ? appJs.slice(at, at + 3000) : '';
  const race = body.includes('Promise.race([') && body.includes('setTimeout(() => res(null), 8000)');
  const flag = body.includes('S._manualLogout = true;');
  const watch = body.includes("setTimeout(() => {") && body.includes("document.getElementById('loginForm')") && body.includes('}, 2000);');
  ok('P6_doLogout_race_flag_watchdog', race && flag && watch, { race, flag, watch });
}
// P7：checkSessionInner 守门。
{
  const at = appJs.indexOf('async function checkSessionInner(');
  const head = at >= 0 ? appJs.slice(at, at + 800) : '';
  ok('P7_checkSession_guards_manualLogout', head.includes('if (S._manualLogout) return false;'), {});
}
// P8：doLogin 成功路径写 fresh 标记并清标记。
{
  const at = appJs.indexOf('async function doLogin(');
  const body = at >= 0 ? appJs.slice(at, at + 4500) : '';
  const sets = body.includes("sessionStorage.setItem('qfShellFreshLogin', '1')");
  const clears = body.includes('S._manualLogout = false;');
  ok('P8_doLogin_sets_fresh_clears_flag', sets && clears, { sets, clears });
}

result.pass = Object.values(result.cases).every((c) => c.pass);
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
