'use strict';
/*
 * 自动登录（autologin.js）纯逻辑 + 静默登录本地自检：
 *  A. isLogoutUrl：/logout 与 /logout/ 命中，其余不误伤；
 *  B. 策略状态机：有凭据+登录页 -> 静默登录；手动退出/失败横幅/无凭据/
 *     次数用尽 -> 一律不动；成功后计数清零可再试；
 *  C. 收割决策：成功+勾选 -> 存；成功+没勾 -> 清旧；失败 -> 什么都不动；
 *     非壳来源 -> 不动；
 *  D. Set-Cookie 解析与写回：Max-Age/Expires/Path/Domain/host-only；
 *  E. clearConsoleSession：只清目标主机 cookie，别的主机不动；
 *  F. 静默登录打本地假控制台：对密码 -> ok 且带回 xid；错密码 -> 回
 *     登录页判失败；会话探活：带对 cookie -> alive，带错 -> 不成立；
 *  G. 注入脚本：含「记住账号密码」与字段名；无凭据时脚本里不出现密码位。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  isLogoutUrl, isLoginFailureText, createAutoLoginPolicy, planHarvest,
  parseSetCookie, applySetCookies, clearConsoleSession,
  httpSilentLogin, httpProbeSession, buildInjectScript
} = require('../autologin');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr230/autologin-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

(async () => {
  try {
    // A
    ok('A1_logout', isLogoutUrl('https://app.qfremote.top/logout') === true);
    ok('A2_logout_slash_query', isLogoutUrl('https://app.qfremote.top/logout/?a=1') === true);
    ok('A3_not_logout', isLogoutUrl('https://app.qfremote.top/') === false && isLogoutUrl('https://app.qfremote.top/logoutx') === false && isLogoutUrl('not a url') === false);
    ok('A4_failure_text', isLoginFailureText('登录失败，请检查账号和密码后重试。') === true && isLoginFailureText('欢迎回来') === false);

    // B
    const pol = createAutoLoginPolicy({ maxAttempts: 2 });
    ok('B1_silent', pol.decide({ pageState: 'login', hasCreds: true, manualLogout: false, failedBanner: false }).action === 'silent-login');
    ok('B2_manual_blocks', pol.decide({ pageState: 'login', hasCreds: true, manualLogout: true, failedBanner: false }).reason === 'manual-logout');
    ok('B3_nocreds', pol.decide({ pageState: 'login', hasCreds: false, manualLogout: false, failedBanner: false }).reason === 'no-creds');
    ok('B4_console_skip', pol.decide({ pageState: 'console', hasCreds: true, manualLogout: false, failedBanner: false }).reason === 'not-login-page');
    ok('B5_token_skip', pol.decide({ pageState: 'token', hasCreds: true, manualLogout: false, failedBanner: false }).reason === 'not-login-page');
    pol.noteAttempt(); pol.noteAttempt();
    ok('B6_exhausted', pol.decide({ pageState: 'login', hasCreds: true, manualLogout: false, failedBanner: false }).reason === 'attempts-exhausted');
    pol.noteSuccess();
    ok('B7_success_resets', pol.decide({ pageState: 'login', hasCreds: true, manualLogout: false, failedBanner: false }).action === 'silent-login');
    const pol2 = createAutoLoginPolicy({});
    const fb = pol2.decide({ pageState: 'login', hasCreds: true, manualLogout: false, failedBanner: true });
    const after = pol2.decide({ pageState: 'login', hasCreds: true, manualLogout: false, failedBanner: false });
    ok('B8_failure_sticks', fb.reason === 'login-failed' && after.reason === 'login-failed');
    pol2.noteSuccess();
    ok('B9_failure_cleared_by_success', pol2.decide({ pageState: 'login', hasCreds: true, manualLogout: false, failedBanner: false }).action === 'silent-login');

    // C
    const pend = { src: 'shell', u: 'user1', p: 'pass1', rp: true, rd: true };
    const h1 = planHarvest(pend, 'success');
    ok('C1_save_when_checked', !!h1.save && h1.save.username === 'user1' && h1.save.password === 'pass1' && h1.clearVault === false && h1.rememberDevice === true && h1.clearManualLogout === true, h1);
    const h2 = planHarvest(Object.assign({}, pend, { rp: false, rd: false }), 'success');
    ok('C2_clear_when_unchecked', h2.save === null && h2.clearVault === true && h2.rememberDevice === false, h2);
    const h3 = planHarvest(pend, 'failure');
    ok('C3_failure_noop', h3.save === null && h3.clearVault === false && h3.rememberDevice === null, h3);
    const h4 = planHarvest(null, 'success');
    const h5 = planHarvest({ src: 'other', u: 'x', p: 'y', rp: true }, 'success');
    ok('C4_no_pending_noop', h4.save === null && h4.clearVault === false && h5.save === null && h5.clearVault === false);

    // D
    const c1 = parseSetCookie('xid=abc123; Path=/; Max-Age=2592000; Secure; HttpOnly', 'https://app.qfremote.top/');
    ok('D1_maxage', !!c1 && c1.name === 'xid' && c1.value === 'abc123' && c1.path === '/' && c1.secure === true && c1.httpOnly === true && !('domain' in c1) && Math.abs(c1.expirationDate - (Math.floor(Date.now() / 1000) + 2592000)) <= 2, c1);
    const c2 = parseSetCookie('qfrem=1; Domain=.example.com; Expires=Wed, 01 Jan 2031 00:00:00 GMT', 'https://example.com/');
    ok('D2_domain_expires', !!c2 && c2.domain === 'example.com' && c2.expirationDate === Math.floor(Date.parse('2031-01-01T00:00:00Z') / 1000), c2);
    ok('D3_bad', parseSetCookie('', 'https://x/') === null && parseSetCookie('noequals', 'https://x/') === null);
    const setCalls = [];
    const fakeSes = { cookies: { set: async (d) => { setCalls.push(d); }, get: async () => [], remove: async () => {} } };
    const applied = await applySetCookies(fakeSes, ['xid=v1; Path=/; Max-Age=100', 'xid.sig=v2; Path=/'], 'https://app.qfremote.top/');
    ok('D4_apply', applied === 2 && setCalls.length === 2 && setCalls[0].name === 'xid');

    // E
    const jar = [
      { name: 'xid', value: 'a', domain: 'app.qfremote.top', path: '/' },
      { name: 'xid.sig', value: 'b', domain: '.app.qfremote.top', path: '/' },
      { name: 'qfrem', value: '1', domain: 'app.qfremote.top', path: '/' },
      { name: 'other', value: 'z', domain: 'example.com', path: '/' }
    ];
    const removedNames = [];
    const fakeSes2 = {
      cookies: {
        get: async () => jar.slice(),
        remove: async (url, name) => { removedNames.push(name); },
        set: async () => {}
      }
    };
    const removed = await clearConsoleSession(fakeSes2, 'https://app.qfremote.top/');
    ok('E_clear_host_only', removed === 3 && removedNames.includes('xid') && removedNames.includes('xid.sig') && removedNames.includes('qfrem') && !removedNames.includes('other'), { removed, removedNames });

    // F: 本地假控制台
    const GOOD_U = 'testuser01', GOOD_P = 'TestPass2026';
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          if (params.get('action') === 'login' && params.get('username') === GOOD_U && params.get('password') === GOOD_P) {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['xid=SESSION123; Path=/; Max-Age=2592000; HttpOnly', 'xid.sig=SIG456; Path=/; Max-Age=2592000'] });
            res.end('<html><body><div id="masthead"></div>控制台</body></html>');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><form id="loginpanelform"></form><div id="message1">登录失败</div></body></html>');
          }
        });
      } else {
        const cookie = req.headers.cookie || '';
        const alive = cookie.includes('xid=SESSION123');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(alive ? '<html><head><title>QFRemote 控制台</title></head><body><div id="masthead"></div><!-- 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding 控制台页面填充 console page padding -->控制台</body></html>' : '<html><body><form id="loginpanelform"></form></body></html>');
      }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    const good = await httpSilentLogin({ baseUrl: base, username: GOOD_U, password: GOOD_P });
    ok('F1_silent_ok', good.ok === true && good.setCookies.some(sc => sc.startsWith('xid=SESSION123')), { status: good.status });
    const bad = await httpSilentLogin({ baseUrl: base, username: GOOD_U, password: 'wrong-pass' });
    ok('F2_silent_bad_rejected', bad.ok === false, { status: bad.status });
    const probeOk = await httpProbeSession({ baseUrl: base, cookieHeader: 'xid=SESSION123' });
    const probeBad = await httpProbeSession({ baseUrl: base, cookieHeader: 'xid=NOPE' });
    ok('F3_probe', probeOk.alive === true && probeBad.alive === false, { probeOk, probeBad });
    server.close();

    // G
    const s1 = buildInjectScript({ username: 'user1', password: 'pass1', rememberPassword: true, rememberDevice: true });
    ok('G1_script_shape', s1.includes('记住账号密码') && s1.includes('qfRememberPassword') && s1.includes('qfrememberpassword') && s1.includes('user1'));
    const s2 = buildInjectScript({ username: null, password: null, rememberPassword: false, rememberDevice: false });
    ok('G2_script_no_creds', s2.includes('记住账号密码') && s2.includes('"username":null') && s2.includes('"password":null'));

    result.pass = Object.values(result.cases).every(c => c.pass);
  } catch (e) {
    result.fatal = e.message + '\n' + e.stack;
  } finally {
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    process.exit(result.pass ? 0 : 1);
  }
})();
