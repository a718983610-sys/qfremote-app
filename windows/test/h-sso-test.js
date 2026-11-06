'use strict';
/*
 * QFRemote 2.3.0 H 线（全局免登）壳侧自检：
 *  A. svc-urls 论坛接口地址推导（兜底值 + product.json 新鲜值两路）；
 *  B. 聊天静默解锁决策 planChatUnlock 全矩阵；
 *  C. 解锁注入脚本形态（调 qfShellUnlock、只试一次标记、密码安全转义）；
 *  D. 隐私锁真桥取 cookie 口径：整罐取（get({})，不按 URL 过滤）且请求
 *     真带上 xid；401 文案不再赶人去好友页登录。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { createSvcUrls, FALLBACKS } = require('../svc-urls');
const autologin = require('../autologin');
const { createLockBridge } = require('../lock');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr230/h-sso-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

(async () => {
  // A1 兜底值推导
  const svc = createSvcUrls({ fetchJson: async () => { throw new Error('offline'); }, loadCache: () => null, saveCache: () => {} });
  await svc.refresh();
  ok('A1_forum_api_fallback', svc.forumApi('sso-token') === 'https://app.qfremote.top/api/forum/sso-token', { got: svc.forumApi('sso-token') });
  ok('A2_forum_sso_login_url', svc.forumSsoLoginUrl('a b+c') === 'https://app.qfremote.top/api/forum/sso-login?token=a%20b%2Bc', { got: svc.forumSsoLoginUrl('a b+c') });
  // A4 写死兜底防回归（2026-10-29 审计 J-1）：兜底必须落在正式 Web 基座，
  // 任何一键都不得再指向已拆除的临时隧道；friendsUrl 保持既定代际直连。
  ok('A4_fallback_prod_base', FALLBACKS.forumUrl === 'https://app.qfremote.top/forum' && FALLBACKS.registerUrl === 'https://app.qfremote.top/register' && FALLBACKS.adminUrl === 'https://app.qfremote.top/admin' && FALLBACKS.pointsUrl === 'https://app.qfremote.top/points', FALLBACKS);
  ok('A5_fallback_no_tunnel', !Object.values(FALLBACKS).some(u => String(u).includes('trycloudflare')), FALLBACKS);
  ok('A6_fallback_friends_domain', FALLBACKS.friendsUrl === 'https://app.qfremote.top/friends');
  // A3 product.json 新鲜值推导
  const svc2 = createSvcUrls({
    fetchJson: async () => ({ web: { forumUrl: 'https://tun.example.com/forum' } }),
    loadCache: () => null, saveCache: () => {}
  });
  await svc2.refresh();
  ok('A3_forum_api_fresh', svc2.forumApi('sso') === 'https://tun.example.com/api/forum/sso', { got: svc2.forumApi('sso') });

  // B 决策矩阵
  const base = { hasCreds: true, manualLogout: false, hasToken: true, locked: true, unlocked: false };
  ok('B1_silent_unlock', autologin.planChatUnlock(base).action === 'silent-unlock');
  ok('B2_no_creds', autologin.planChatUnlock(Object.assign({}, base, { hasCreds: false })).reason === 'no-creds');
  ok('B3_manual_logout', autologin.planChatUnlock(Object.assign({}, base, { manualLogout: true })).reason === 'manual-logout');
  ok('B4_no_token', autologin.planChatUnlock(Object.assign({}, base, { hasToken: false })).reason === 'no-chat-session');
  ok('B5_already_unlocked', autologin.planChatUnlock(Object.assign({}, base, { unlocked: true })).reason === 'already-unlocked');
  ok('B6_not_locked', autologin.planChatUnlock(Object.assign({}, base, { locked: false })).reason === 'not-locked');

  // C 注入脚本
  const script = autologin.buildChatUnlockScript('p"\\w');
  ok('C1_script_calls_hook', script.includes('qfShellUnlock') && script.includes('__qfShellUnlockTried'));
  ok('C2_script_escapes_password', script.includes('p\\"\\\\w') || script.includes(JSON.stringify('p"\\w')));

  // D 真桥取 cookie 口径（本地自签假服务）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-hsso-'));
  execSync('openssl req -x509 -newkey rsa:2048 -keyout ' + path.join(tmp, 'k.pem') +
    ' -out ' + path.join(tmp, 'c.pem') + ' -days 2 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"',
    { stdio: 'pipe' });
  let seenCookie = '';
  let deny = false;
  const server = https.createServer(
    { key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) },
    (req, res) => {
      seenCookie = req.headers.cookie || '';
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (deny) { send(401, { error: '请先登录。' }); return; }
      if (req.url === '/lock/devices') send(200, { devices: [{ id: 'pc-1', name: '测试机', owner: true, locked: false, component: true }] });
      else send(404, { error: '没有这个接口' });
    });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base2 = 'https://127.0.0.1:' + server.address().port + '/lock';
  let getArg = null;
  const fakeSession = { cookies: { get: async (arg) => { getArg = arg; return [{ name: 'xid', value: 'abc123' }, { name: 'xid.sig', value: 'sig456' }, { name: 'qfr_frd', value: 'frd789' }]; } } };
  const bridge = createLockBridge(() => fakeSession, { base: base2 });
  const devs = await bridge.listDevices();
  ok('D1_devices_ok', devs.length === 1 && devs[0].id === 'pc-1');
  ok('D2_cookie_whole_jar', getArg && Object.keys(getArg).length === 0, { getArg: JSON.stringify(getArg) });
  ok('D3_cookie_sends_xid', seenCookie.includes('xid=abc123') && seenCookie.includes('xid.sig=sig456'), { seenCookie });
  deny = true;
  let msg = '';
  try { await bridge.listDevices(); } catch (e) { msg = e.message; }
  ok('D4_401_copy_no_friends_detour', msg.includes('重新登录软件') && !msg.includes('好友'), { msg });
  server.close();

  result.pass = Object.values(result.cases).every(c => c.pass);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
})().catch(e => {
  result.fatal = e.message;
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (err) {}
  console.error('FATAL', e);
  process.exit(1);
});
