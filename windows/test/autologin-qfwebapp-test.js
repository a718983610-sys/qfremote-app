'use strict';
/*
 * QFR webapp pageDetect 自检（纯 Node + DOM 桩，不需要 Electron/真服务器）：
 *  3.0.0 首启触发器根因钉死——pageDetect 只认原生 MC 标记时，QFR 自家
 *  控制台（webapp）上登录成功恒回 'other'，processAuthPage 的 console 分支
 *  永不跑，maybeInstallSystemServices 永不触发。
 *  断言：
 *  F1 QFR 登录页（loginForm 在、authRoot 可见、shellRoot 隐藏）-> 'login'；
 *  F2 QFR 登录页带 #li-err 可见文案 -> 'login' + failedBanner；
 *  F3 QFR 控制台（shellRoot 可见、S.user 已写）-> 'console' + username=S.user；
 *  F4 QFR 控制台无 S 时 -> 'console' + username 取 .sideidtx small；
 *  F5 QFR 控制台无 S、无侧栏时 -> 'console' + username 取 #li-user；
 *  R1 原生 MC 登录页（loginpanelform）-> 'login' + failedBanner（回归）；
 *  R2 原生 MC 控制台（logoutControl）-> 'console'（回归）；
 *  R3 空白页 -> 'other'；
 *  S1 main.js 含 did-navigate-in-page -> processAuthPage 钩子（触发器之二）；
 *  S2 main.js console 分支先落 gateUsername 再调 maybeInstallSystemServices。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。跑法：node windows/test/autologin-qfwebapp-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const autologin = require('../autologin');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr300/autologin-qfwebapp-result.json';
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

// DOM 桩：bare 的 window/document/sessionStorage/S 均进 vm 全局。
function makeCtx(elById, opts) {
  opts = opts || {};
  const sessionStore = opts.session || {};
  const sandbox = {
    window: {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    },
    document: {
      getElementById: (id) => (Object.prototype.hasOwnProperty.call(elById, id) ? elById[id] : null),
      querySelector: (sel) => {
        if (sel === '.sideidtx small') return opts.sideSmall || null;
        return null;
      },
    },
    sessionStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null),
    },
  };
  if (opts.S !== undefined) sandbox.S = opts.S;
  vm.createContext(sandbox);
  return sandbox;
}

function detect(ctx) {
  return vm.runInContext(autologin.DETECT_JS, ctx);
}

(async () => {
  try {
    // ---- F1：QFR 登录页 ----
    let ctx = makeCtx({
      loginForm: makeEl({}),
      authRoot: makeEl({ hidden: false }),
      shellRoot: makeEl({ hidden: true }),
      'li-err': makeEl({ hidden: true }),
    });
    let d = detect(ctx);
    ok('F1_qf_login', d.state === 'login' && d.username === '', d);

    // ---- F2：QFR 登录页带错误 ----
    ctx = makeCtx({
      loginForm: makeEl({}),
      authRoot: makeEl({ hidden: false }),
      shellRoot: makeEl({ hidden: true }),
      'li-err': makeEl({ hidden: false, textContent: '账号或密码不正确，请核对后重试。' }),
    });
    d = detect(ctx);
    ok('F2_qf_login_failed_banner', d.state === 'login' && d.failedBanner === true && d.failureText.indexOf('账号或密码不正确') === 0, d);

    // ---- F3：QFR 控制台，S.user ----
    ctx = makeCtx({
      authRoot: makeEl({ hidden: true }),
      shellRoot: makeEl({ hidden: false }),
    }, { S: { user: 'qfdriver1028' } });
    d = detect(ctx);
    ok('F3_qf_console_S_user', d.state === 'console' && d.username === 'qfdriver1028', d);

    // ---- F4：QFR 控制台，无 S，侧栏 small ----
    ctx = makeCtx({
      authRoot: makeEl({ hidden: true }),
      shellRoot: makeEl({ hidden: false }),
    }, { sideSmall: makeEl({ textContent: 'testuser01' }) });
    d = detect(ctx);
    ok('F4_qf_console_dom_small', d.state === 'console' && d.username === 'testuser01', d);

    // ---- F5：QFR 控制台，无 S、无侧栏，#li-user ----
    ctx = makeCtx({
      authRoot: makeEl({ hidden: true }),
      shellRoot: makeEl({ hidden: false }),
      'li-user': makeEl({ value: 'testuser02' }),
    });
    d = detect(ctx);
    ok('F5_qf_console_li_user', d.state === 'console' && d.username === 'testuser02', d);

    // ---- R1：原生 MC 登录页（回归） ----
    ctx = makeCtx({
      loginpanelform: makeEl({}),
      message1: makeEl({ textContent: '登录失败，请重试。' }),
    });
    d = detect(ctx);
    ok('R1_mc_login', d.state === 'login' && d.failedBanner === true, d);

    // ---- R2：原生 MC 控制台（回归） ----
    ctx = makeCtx({ logoutControl: makeEl({}) });
    d = detect(ctx);
    ok('R2_mc_console', d.state === 'console', d);

    // ---- R3：空白页 ----
    ctx = makeCtx({});
    d = detect(ctx);
    ok('R3_other', d.state === 'other', d);

    // ---- S1/S2：main.js 触发器静态断言 ----
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const hookIdx = mainSrc.indexOf("wc.on('did-navigate-in-page'");
    const procIdx = hookIdx >= 0 ? mainSrc.indexOf('processAuthPage()', hookIdx) : -1;
    ok('S1_did_navigate_in_page_hook', hookIdx >= 0 && procIdx > hookIdx && procIdx - hookIdx < 200, { hookIdx, procIdx });
    const gateIdx = mainSrc.indexOf('if (det.username) gateUsername = det.username;');
    const maybeIdx = mainSrc.indexOf('maybeInstallSystemServices().catch', gateIdx);
    ok('S2_gateUsername_before_maybe', gateIdx >= 0 && maybeIdx > gateIdx && maybeIdx - gateIdx < 3000, { gateIdx, maybeIdx });

    result.pass = Object.values(result.cases).every(c => c.pass);
  } catch (e) {
    result.fatal = e.message + '\n' + e.stack;
  } finally {
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    process.exit(result.pass ? 0 : 1);
  }
})();
