'use strict';
/*
 * C 线 · lock-bridge HTTP 烟囱测试（沙箱实跑，不碰生产服务、不连 MeshCentral）
 * 覆盖：① 暂停守卫 POST /lock/enable 一律 503 维护文案（阶段 1 守卫原样保留）；
 * ② 未登录 401；③ /lock/disable 提交前校验顺序（operationId → 幂等重放 →
 * 挑战缺失／无效），全程不依赖设备在线；④ /lock/devices 读路径在通道
 * 故障时仍 200 回空表。
 * 桥配置用临时生成的 Ed25519 调度密钥；mcUrl 指向本地未监听端口，
 * svc 通道必然快速失败（就绪门 ≤400ms），用以模拟设备离线／通道故障。
 * 退出码 0=通过（末尾 process.exit，避开 svc 退避重连定时器）。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createLockBridge } = require('./lock-bridge');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; console.log('FAIL-', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// 临时桥配置：Ed25519 密钥（seed||pub 共 64B，Base64）＋不可达的 mcUrl。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockc-'));
const kp = crypto.generateKeyPairSync('ed25519');
const privDer = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
const seed = privDer.subarray(privDer.length - 32); // PKCS8 末 32B 即 seed
const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
const pubRaw = pubDer.subarray(pubDer.length - 32);
const keyB64 = Buffer.concat([seed, pubRaw]).toString('base64');
const keyFile = path.join(tmp, 'dispatcher.key');
fs.writeFileSync(keyFile, keyB64, 'utf8');
const bridgeCfgPath = path.join(tmp, 'bridge-config.json');
fs.writeFileSync(bridgeCfgPath, JSON.stringify({
  keyFile, mcUrl: 'wss://127.0.0.1:9', svcUser: 'qf-locksvc', svcPass: 'x',
}), 'utf8');
const recordsPath = path.join(tmp, 'lock-records.json');

let currentUser = 'alice';
function makeBridge() {
  return createLockBridge({
    cfg: {},
    log: () => {},
    sessionUser: () => currentUser,
    mcConnect: async () => { throw new Error('bad-password'); },
    mcConnectCookie: async () => { throw new Error('no-session'); },
    bridgeCfgPath,
    lockRecordsPath: recordsPath,
    isBanLinked: () => false,
    isSiteAdmin: () => false,
  });
}

function mockReq(method, url, bodyObj) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { cookie: '' };
  process.nextTick(() => {
    if (bodyObj !== undefined) req.emit('data', Buffer.from(JSON.stringify(bodyObj), 'utf8'));
    req.emit('end');
  });
  return req;
}
function mockRes() {
  const res = { statusCode: 0, headers: {}, body: '', headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; },
    end(data) { this.body = String(data || ''); if (this.onEnd) this.onEnd(); } };
  res.done = new Promise((resolve) => { res.onEnd = resolve; });
  return res;
}
async function call(bridge, method, url, bodyObj) {
  const req = mockReq(method, url, bodyObj);
  const res = mockRes();
  await bridge.handle(req, res);
  await res.done;
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { /* 非 JSON */ }
  return { status: res.statusCode, json, raw: res.body };
}

(async () => {
  const bridge = makeBridge();

  // 1. 未登录 → 401
  currentUser = null;
  let r = await call(bridge, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' });
  t('C1 未登录 POST /lock/enable → 401', r.status === 401 && r.json && r.json.error === '请先登录。', r);

  // 2. 暂停守卫：已登录也一律 503 维护文案（不走到设备读取）
  currentUser = 'alice';
  r = await call(bridge, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' });
  t('C2 暂停守卫：POST /lock/enable → 503 维护文案', r.status === 503 && r.json && r.json.error === '隐私锁功能正在维护，暂时无法开启新的锁定。已锁定的设备仍可正常关闭。', r);

  // 3. disable 缺 operationId → 409 operation-required（设备离线也不影响此判定）
  r = await call(bridge, 'POST', '/lock/disable', { id: 'node-1' });
  t('C3 disable 缺 operationId → 409 operation-required', r.status === 409 && r.json && r.json.code === 'operation-required', r);

  // 4. disable 有 operationId、无 challenge → 409 challenge-required
  r = await call(bridge, 'POST', '/lock/disable', { id: 'node-1', operationId: 'op-test-1' });
  t('C4 disable 缺 challenge → 409 challenge-required', r.status === 409 && r.json && r.json.code === 'challenge-required', r);

  // 5. disable 挑战伪造 → 409 challenge-invalid（不耗设备、不产生操作）
  r = await call(bridge, 'POST', '/lock/disable', { id: 'node-1', operationId: 'op-test-2', challenge: 'ch-fake' });
  t('C5 disable 伪造 challenge → 409 challenge-invalid', r.status === 409 && r.json && r.json.code === 'challenge-invalid', r);

  // 6. 挑战签发需设备在线：通道故障时 503 unreachable（不是 401/404）
  r = await call(bridge, 'GET', '/lock/challenge?id=node-1&op=disarm');
  t('C6 通道故障时 GET /lock/challenge → 503 unreachable', r.status === 503 && r.json && r.json.error === '暂时无法连接这台电脑，请确认设备在线后重试。', r);

  // 7. 读路径在通道故障时仍 200 回空表（不炸、不挂起）
  r = await call(bridge, 'GET', '/lock/devices');
  t('C7 通道故障时 GET /lock/devices → 200 空表', r.status === 200 && r.json && Array.isArray(r.json.devices) && r.json.devices.length === 0, r);

  // 8. 未知路由 404（桥本身工作正常）
  r = await call(bridge, 'GET', '/lock/nope');
  t('C8 未知路由 → 404', r.status === 404, r);

  // 9. 锁记录文件未被写出空表以外的东西（纯内存路径无文件副作用）
  t('C9 本轮未产生锁记录文件（无设备交互即无记录）', !fs.existsSync(recordsPath));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(' harness error:', e); process.exit(1); });
