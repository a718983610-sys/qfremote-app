'use strict';
/*
 * 自动登录页面级自检（Electron + 本地假 MeshCentral，不需要真服务器）：
 *  A. 无凭据注入：登录页出现「记住账号密码」勾选，位置在「记住此设备」
 *     下一行，两框默认不勾、输入框为空；
 *  B. 有凭据注入：自动回填账号密码、两框按已存偏好勾上；点登录后进入
 *     控制台，主进程经 DETECT 收到的暂存与收割决策正确（成功+勾选->存）；
 *  C. 错密码：提交后回到登录页且出现失败提示，DETECT 报 failedBanner，
 *     策略据此停手（不再自动试）；
 *  D. 手动退出标记：在控制台装守卫后点「退出账号」，回到登录页时
 *     DETECT 报 manualLogout；
 *  E. 清空输入框：回填后把密码框清空，DETECT 报 fieldsCleared。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。跑法同 watchdog-test（xvfb）。
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const autologin = require('../autologin');

if (process.getuid && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}

const OUT = process.env.QFTEST_OUT || '/tmp/qfr230/autologin-page-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const GOOD_U = 'testuser01';
const GOOD_P = 'TestPass2026';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startFakeServer() {
  const loginHtml = fs.readFileSync(path.join(__dirname, 'fixture-mc-login.html'), 'utf8');
  const consoleHtml = fs.readFileSync(path.join(__dirname, 'fixture-mc-console.html'), 'utf8');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && u.pathname === '/do-login') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        if (params.get('username') === GOOD_U && params.get('password') === GOOD_P) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'xid=SESSION123; Path=/; Max-Age=2592000' });
          res.end(consoleHtml);
        } else {
          res.writeHead(302, { Location: '/fixture-mc-login.html?err=1' });
          res.end();
        }
      });
      return;
    }
    if (u.pathname === '/logout') {
      res.writeHead(302, { Location: '/fixture-mc-login.html', 'Set-Cookie': 'xid=; Path=/; Max-Age=0' });
      res.end();
      return;
    }
    if (u.pathname === '/fixture-mc-console.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(consoleHtml); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(loginHtml);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

app.whenReady().then(async () => {
  let server = null;
  let win = null;
  try {
    server = await startFakeServer();
    const base = 'http://127.0.0.1:' + server.address().port;
    const loginUrl = base + '/fixture-mc-login.html';
    win = new BrowserWindow({ width: 900, height: 700, show: false });
    const wc = win.webContents;
    const ev = (js) => wc.executeJavaScript(js, true);
    const detect = async () => ev(autologin.DETECT_JS);
    const waitFor = async (fn, timeout) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeout || 15000)) {
        try { const v = await fn(); if (v) return v; } catch (e) { /* 页面跳转中 */ }
        await sleep(300);
      }
      return null;
    };

    // ---- A：无凭据注入 ----
    await win.loadURL(loginUrl);
    const injA = await ev(autologin.buildInjectScript({ username: null, password: null, rememberPassword: false, rememberDevice: false }));
    const shapeA = await ev(`(() => {
      var rows = Array.prototype.slice.call(document.querySelectorAll('#loginpanelform tr'));
      var devIdx = -1, pwIdx = -1;
      rows.forEach(function (tr, i) {
        if (tr.querySelector('#qfRememberDevice')) devIdx = i;
        if (tr.querySelector('#qfRememberPassword')) pwIdx = i;
      });
      var pw = document.getElementById('qfRememberPassword');
      var dev = document.getElementById('qfRememberDevice');
      return { devIdx, pwIdx, pwExists: !!pw, pwChecked: pw ? pw.checked : null, devChecked: dev ? dev.checked : null,
               u: document.getElementById('username').value, p: document.getElementById('password').value,
               labelText: pw ? pw.closest('label').textContent.trim() : '' };
    })()`);
    ok('A_inject', !!injA && injA.ok === true && injA.pwBox === true, injA);
    ok('A_checkbox_below_device', shapeA.pwExists && shapeA.devIdx >= 0 && shapeA.pwIdx === shapeA.devIdx + 1, shapeA);
    ok('A_defaults', shapeA.pwChecked === false && shapeA.devChecked === false && shapeA.u === '' && shapeA.p === '' && shapeA.labelText === '记住账号密码', shapeA);

    // ---- E：清框信号（借 A 的页面：先回填再清） ----
    await win.loadURL(loginUrl);
    await ev(autologin.buildInjectScript({ username: GOOD_U, password: GOOD_P, rememberPassword: true, rememberDevice: true }));
    const filled = await ev(`(() => ({ u: document.getElementById('username').value, p: document.getElementById('password').value,
      rp: document.getElementById('qfRememberPassword').checked, rd: document.getElementById('qfRememberDevice').checked }))()`);
    ok('E_autofill', filled.u === GOOD_U && filled.p === GOOD_P && filled.rp === true && filled.rd === true, filled);
    await ev(`(() => { var p = document.getElementById('password'); p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const detE = await detect();
    ok('E_fields_cleared', detE.fieldsCleared === true, detE);

    // ---- B：回填后点登录 -> 控制台 -> 收割 ----
    await win.loadURL(loginUrl);
    await ev(autologin.buildInjectScript({ username: GOOD_U, password: GOOD_P, rememberPassword: true, rememberDevice: true }));
    await ev(`document.getElementById('loginButton').click(); true`);
    const detB = await waitFor(async () => { const d = await detect(); return d.state === 'console' ? d : null; });
    ok('B_reached_console', !!detB, detB);
    const planB = detB ? autologin.planHarvest(detB.pending, 'success') : null;
    ok('B_harvest_saves', !!planB && !!planB.save && planB.save.username === GOOD_U && planB.save.password === GOOD_P && planB.rememberDevice === true, { pending: detB && detB.pending, planB });

    // ---- C：错密码回登录页 + 失败横幅 + 策略停手 ----
    await win.loadURL(loginUrl + '?err=0');
    await win.loadURL(loginUrl); // 干净登录页
    await ev(autologin.buildInjectScript({ username: GOOD_U, password: 'WrongPass999', rememberPassword: true, rememberDevice: false }));
    await ev(`document.getElementById('loginButton').click(); true`);
    const detC = await waitFor(async () => { const d = await detect(); return (d.state === 'login' && d.failedBanner) ? d : null; });
    ok('C_failure_detected', !!detC, detC);
    const pol = autologin.createAutoLoginPolicy({});
    const decC = pol.decide({ pageState: 'login', hasCreds: true, manualLogout: false, failedBanner: !!(detC && detC.failedBanner) });
    ok('C_policy_stops', decC.action === 'none' && decC.reason === 'login-failed', decC);

    // ---- D：手动退出标记 ----
    await win.loadURL(base + '/fixture-mc-console.html');
    await ev(autologin.GUARD_JS);
    await ev(`document.getElementById('logoutMenuOption').click(); true`);
    const detD = await waitFor(async () => { const d = await detect(); return d.state === 'login' ? d : null; });
    ok('D_manual_logout_flag', !!detD && detD.manualLogout === true, detD);
    const decD = pol.decide({ pageState: 'login', hasCreds: true, manualLogout: !!(detD && detD.manualLogout), failedBanner: false });
    ok('D_policy_blocks', decD.action === 'none', decD);

    result.pass = Object.values(result.cases).every(c => c.pass);
  } catch (e) {
    result.fatal = e.message + '\n' + e.stack;
  } finally {
    try { if (server) server.close(); } catch (e) { /* ignore */ }
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    app.exit(result.pass ? 0 : 1);
  }
});
