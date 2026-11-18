'use strict';
/*
 * 隐私锁桥（lock.js）本地自检：
 *  A. 密码预检边界（<4 拒、4 收、64 收、65 拒）；
 *  B. Mock 桥状态机：列表含 owner/component 标记、enable->locked、
 *     disable->unlocked、reset 保持 locked、非机主 enable 被拒、
 *     未装组件 enable 被拒、短密码被拒；
 *     C 线：Mock disable 须带挑战＋操作编号＋revision（与服务端新契约同语义），
 *     同一 operationId 重复提交返回首次结果（replayed，不产生第二次操作），
 *     无挑战／无编号直接拒绝；
 *  C. 真桥对本地假服务（自签 HTTPS，语义同生产）：devices 解析、
 *     enable/disable/reset 走通、401 -> NEED_LOGIN、服务端 error 原样带回。
 *     C 线：真桥 challenge 取值＋disable 载荷（challenge／operationId／revision）
 *     走通，假服务收到完整载荷。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { validateLockPassword, createLockBridge, createMockBridge } = require('../lock');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr200/lock-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

(async () => {
  // A
  ok('A1_short_rejected', validateLockPassword('abc') !== null);
  ok('A2_min_ok', validateLockPassword('abcd') === null);
  ok('A3_max_ok', validateLockPassword('x'.repeat(64)) === null);
  ok('A4_over_rejected', validateLockPassword('x'.repeat(65)) !== null);

  // B
  const mock = createMockBridge();
  const list = await mock.listDevices();
  ok('B1_list_shape', list.length === 4 && list.some(d => d.owner && d.component) && list.some(d => !d.owner), { count: list.length });
  const pc1 = list.find(d => d.id === 'mock-pc-1');
  ok('B2_default_off', pc1.locked === false);
  await mock.enable('mock-pc-1', 'pass1234');
  ok('B3_enable_locks', (await mock.listDevices()).find(d => d.id === 'mock-pc-1').locked === true);
  await mock.reset('mock-pc-1', 'loginpw', 'newpass1');
  ok('B4_reset_keeps_locked', (await mock.listDevices()).find(d => d.id === 'mock-pc-1').locked === true);
  // C 线：Mock disable 走新契约——先取挑战，再带挑战＋操作编号＋revision 提交。
  const chB = await mock.challenge('mock-pc-1');
  ok('B5a_mock_challenge_shape', chB && typeof chB.challenge === 'string' && chB.op === 'disarm');
  await mock.disable('mock-pc-1', { challenge: chB.challenge, operationId: 'op-b5', revision: 0 });
  ok('B5_disable_unlocks', (await mock.listDevices()).find(d => d.id === 'mock-pc-1').locked === false);
  // 同一 operationId 重复提交：返回首次结果（replayed），不产生第二次真实操作。
  const replayB = await mock.disable('mock-pc-1', { challenge: chB.challenge, operationId: 'op-b5', revision: 0 });
  ok('B5b_mock_replay_returns_first_result', replayB && replayB.replayed === true && replayB.ok === true);
  let noChallengeRejected = 0;
  try { await mock.disable('mock-pc-1', { operationId: 'op-b5x', revision: 0 }); } catch (e) { noChallengeRejected++; }
  try { await mock.disable('mock-pc-1', { challenge: chB.challenge, revision: 0 }); } catch (e) { noChallengeRejected++; }
  ok('B5c_mock_disable_without_challenge_or_opid_rejected', noChallengeRejected === 2, { noChallengeRejected });
  let rejected = 0;
  try { await mock.enable('mock-pc-4', 'pass1234'); } catch (e) { rejected++; }
  try { await mock.enable('mock-pc-3', 'pass1234'); } catch (e) { rejected++; }
  try { await mock.enable('mock-pc-1', 'abc'); } catch (e) { rejected++; }
  ok('B6_guards_reject', rejected === 3, { rejected });

  // C: 本地自签 HTTPS 假服务（实现接缝契约）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lock-'));
  execSync('openssl req -x509 -newkey rsa:2048 -keyout ' + path.join(tmp, 'k.pem') +
    ' -out ' + path.join(tmp, 'c.pem') + ' -days 2 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"',
    { stdio: 'pipe' });
  const state = { locked: false };
  let authed = false;
  let seenDisableBody = null;
  const server = https.createServer(
    { key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) },
    (req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (!authed) { send(401, { error: '未登录' }); return; }
        if (req.url === '/lock/devices') {
          send(200, { devices: [{ id: 'pc-9', name: '测试机', owner: true, locked: state.locked, component: true }] });
        } else if (req.url.startsWith('/lock/challenge')) {
          // C 线：假服务签发挑战（与服务端新契约同形）。
          send(200, { ok: true, challenge: 'fake-ch-1', expiresAt: Date.now() + 5 * 60 * 1000, op: 'disarm', deviceId: 'pc-9' });
        } else if (req.url === '/lock/enable') {
          const b = JSON.parse(body || '{}');
          if (b.password === 'badpass') { send(400, { error: '服务端拒绝示例' }); return; }
          state.locked = true; send(200, { ok: true });
        } else if (req.url === '/lock/disable') {
          seenDisableBody = JSON.parse(body || '{}');
          state.locked = false; send(200, { ok: true });
        } else if (req.url === '/lock/reset') { send(200, { ok: true }); }
        else send(404, { error: '没有这个接口' });
      });
    });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'https://127.0.0.1:' + server.address().port + '/lock';
  const bridge = createLockBridge(null, { base });

  let needLogin = false;
  try { await bridge.listDevices(); } catch (e) { needLogin = e.code === 'NEED_LOGIN'; }
  ok('C1_401_need_login', needLogin);
  authed = true;
  const devs = await bridge.listDevices();
  ok('C2_devices_parse', devs.length === 1 && devs[0].id === 'pc-9' && devs[0].owner === true && devs[0].locked === false);
  await bridge.enable('pc-9', 'pass1234');
  ok('C3_enable', (await bridge.listDevices())[0].locked === true);
  let passthrough = false;
  try { await bridge.enable('pc-9', 'badpass'); } catch (e) { passthrough = e.message === '服务端拒绝示例'; }
  ok('C4_error_passthrough', passthrough);
  await bridge.reset('pc-9', 'loginpw', 'newpass1');
  ok('C5_reset_keeps_locked', (await bridge.listDevices())[0].locked === true);
  // C 线：真桥先取挑战，再带挑战＋操作编号＋revision 关锁；假服务收到完整载荷。
  const chC = await bridge.challenge('pc-9', 'disarm');
  ok('C6a_challenge_shape', chC && chC.ok === true && chC.challenge === 'fake-ch-1' && chC.op === 'disarm');
  await bridge.disable('pc-9', { challenge: chC.challenge, operationId: 'op-c6', revision: 0 });
  ok('C6_disable', (await bridge.listDevices())[0].locked === false
    && seenDisableBody && seenDisableBody.challenge === 'fake-ch-1'
    && seenDisableBody.operationId === 'op-c6' && seenDisableBody.revision === 0, { seenDisableBody });
  // 同一操作编号再次提交：客户端原样重发同一载荷（服务端幂等层负责去重，见服务端单测）。
  await bridge.disable('pc-9', { challenge: chC.challenge, operationId: 'op-c6', revision: 0 });
  ok('C6b_disable_replay_same_payload', seenDisableBody && seenDisableBody.operationId === 'op-c6' && seenDisableBody.challenge === 'fake-ch-1');
  server.close();

  // D（2.4.5 W-29/W-11③）：cookie 按名取、component 缺失为 null、http 回环
  const http = require('http');
  const seenNames = [];
  let seenCookieHeader = '';
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/lock/devices') {
      seenCookieHeader = req.headers.cookie || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ devices: [{ id: 'pc-10', name: '本机', owner: true, locked: false }] }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
  const httpBase = 'http://127.0.0.1:' + httpServer.address().port + '/lock';
  const fakeSession = {
    cookies: {
      get: async ({ name }) => {
        seenNames.push(name);
        if (name === 'xid') return [{ name: 'xid', value: 'X1' }];
        if (name === 'xid.sig') return [{ name: 'xid.sig', value: 'S1' }];
        if (name === 'qfr_frd') return [{ name: 'qfr_frd', value: 'F1' }];
        return [{ name, value: 'SHOULD-NOT-BE-ASKED' }];
      }
    }
  };
  const httpBridge = createLockBridge(() => fakeSession, { base: httpBase });
  const httpDevs = await httpBridge.listDevices();
  ok('D1_cookie_only_named', seenNames.length === 3 && seenNames[0] === 'xid' && seenNames[1] === 'xid.sig' && seenNames[2] === 'qfr_frd', { seenNames });
  ok('D2_cookie_header_minimal', seenCookieHeader === 'xid=X1; xid.sig=S1; qfr_frd=F1' && !seenCookieHeader.includes('SHOULD-NOT-BE-ASKED'), { seenCookieHeader });
  ok('D3_component_missing_null', httpDevs.length === 1 && httpDevs[0].component === null, { devs: httpDevs });
  ok('D4_http_loopback_works', httpDevs.length === 1 && httpDevs[0].id === 'pc-10');
  httpServer.close();

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
