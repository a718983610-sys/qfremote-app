'use strict';
/*
 * opStore B 方案 · 安全回归 SEC-01～SEC-12（沙箱实跑，不碰生产服务、不连真机、不碰 D39ABOL）
 * 依据：GPT opStore 定夺（2026-11-19 07:33 取回）§2 实施契约／§4 回归矩阵；
 * 缺陷 LOCK-SEC-P3-REPLAY；契约 CONTRACT.md §6 幂等重放归属鉴权。
 *
 * 做法：本地假 MeshCentral control 通道（ws 服务端，实现 userinfo／nodes／
 * runcommands 三语义，设备 status.json 用 Base64 回传；disarm 信封投递＋
 * apply 后翻 Off＋补事件），全程实跑 /lock/disable 真分支。两台假设备：
 * node-1＝v2 设备（actual_state／revision／lockId 事件），node-2＝旧 Go 设备。
 * 归属台账用可变假 K1 台账注入（getDeviceBinding），测试可改绑／抛错／封禁，
 * 覆盖转移、撤销、台账不可用等场景；另有一组用真实 bindings.json 文件直读
 * （生产默认路径），证明不注入时文件读路径可用。
 * 用法：node server/friends/test-lock-opstore-b.js；退出码 0=全过。
 * 注意：SEC-04 关假 MC 后桥 svc 会退避重连，末尾 process.exit 避开定时器。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const S = require('./lock-state');
const { createLockBridge, _test: BT } = require('./lock-bridge');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; console.log('FAIL-', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= U. lock-state 纯函数（opStore 绑定扩展） =================
(function pureTests() {
  const ops = S.createOperationStore();
  const fp1 = S.fingerprintDisableRequest({ deviceId: 'node-1', lockId: 'lock-x' });
  const fp2 = S.fingerprintDisableRequest({ deviceId: 'node-1', lockId: 'lock-x' });
  const fp3 = S.fingerprintDisableRequest({ deviceId: 'node-1', lockId: 'lock-y' });
  const fp4 = S.fingerprintDisableRequest({ deviceId: 'node-2', lockId: 'lock-x' });
  t('U-1 指纹确定性：同输入同值、锁实例／设备不同则不同',
    fp1 === 'disarm|node-1|lock-x' && fp1 === fp2 && fp1 !== fp3 && fp1 !== fp4);
  const binding = {
    account_id: 'alice', device_id: 'node-1', lock_id: 'lock-x', operation_type: 'disarm',
    request_fingerprint: fp1, revision: 5, completed_at: 1795020000000,
  };
  t('U-2 带信封存储：lookupEntry 返回完整条目（result＋binding），lookup 只返 result',
    ops.store('op-u-1', { lockState: 'UNLOCKED', revision: 5 }, binding) === true
    && JSON.stringify(ops.lookup('op-u-1')) === JSON.stringify({ lockState: 'UNLOCKED', revision: 5 })
    && ops.lookupEntry('op-u-1') && ops.lookupEntry('op-u-1').binding
    && ops.lookupEntry('op-u-1').binding.account_id === 'alice'
    && ops.lookupEntry('op-u-1').binding.completed_at === 1795020000000);
  t('U-3 旧调用兼容：无 binding 存储写出 legacy 条目（binding null），lookup 仍可用',
    ops.store('op-u-2', { lockState: 'UNLOCKED', revision: 7 }) === true
    && ops.lookupEntry('op-u-2') && ops.lookupEntry('op-u-2').binding === null
    && ops.lookup('op-u-2') && ops.lookup('op-u-2').revision === 7);
  t('U-4 先到先得：同一编号第二次存储返回 false、保留首次信封',
    ops.store('op-u-1', { lockState: 'UNLOCKED', revision: 9 },
      Object.assign({}, binding, { revision: 9 })) === false
    && ops.lookup('op-u-1').revision === 5
    && ops.lookupEntry('op-u-1').binding.revision === 5);
})();

// ================= 假设备（两台） =================
const devices = {
  'node-1': { mode: 'v2', version: '2.0.0', locked: true, revision: 1, boot_id: 'boot-1', events: [], inboxWrites: 0, applyCalls: 0, pendingDisarm: null, lockId: null },
  'node-2': { mode: 'old', version: '2.0.3', locked: true, revision: 1, boot_id: 'boot-1', events: [], inboxWrites: 0, applyCalls: 0, pendingDisarm: null, lockId: null },
};
function fakeStatus(nodeId) {
  const d = devices[nodeId];
  const base = {
    state: d.locked ? 'Locked' : 'Off',
    version: d.version,
    ownerUsername: 'alice',
    updatedAt: new Date().toISOString(),
    lastEvents: d.events.slice(),
  };
  if (d.mode === 'v2') {
    base.actual_state = d.locked ? 'LOCKED' : 'UNLOCKED';
    base.revision = d.revision;
    base.boot_id = d.boot_id;
    base.session_id = 1;
    base.sid = 'S-1-5-21-100';
  }
  return base;
}
async function startFakeMc() {
  const wss = new WebSocket.Server({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ action: 'userinfo', userinfo: { _id: 'user/qf-locksvc' } }));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      const rid = m.responseid;
      const nodeId = (Array.isArray(m.nodeids) && m.nodeids[0]) || 'node-1';
      const d = devices[nodeId] || devices['node-1'];
      if (m.action === 'nodes') {
        ws.send(JSON.stringify({ responseid: rid, action: 'nodes', nodes: [{ _id: 'node-1', name: 'PC-1' }, { _id: 'node-2', name: 'PC-2' }] }));
        return;
      }
      if (m.action === 'runcommands') {
        const cmd = String(m.cmds || '');
        let result = '';
        if (cmd.includes('status.json')) {
          result = Buffer.from(JSON.stringify(fakeStatus(nodeId)), 'utf8').toString('base64');
        } else if (cmd.includes('WriteAllBytes')) {
          d.inboxWrites++;
          const mm = cmd.match(/FromBase64String\('([^']+)'\)/);
          if (mm) {
            try {
              const env = JSON.parse(Buffer.from(mm[1], 'base64').toString('utf8'));
              if (env.op === 'disarm') d.pendingDisarm = env.id;
            } catch (e) { /* 非信封写入不处理 */ }
          }
          result = '';
        } else if (cmd.includes('qf-lockctl.exe')) {
          d.applyCalls++;
          if (d.mode === 'v2') {
            if (d.pendingDisarm) {
              d.locked = false;
              d.revision += 2;
              d.events.push({ ts: new Date().toISOString(), ev: 'disarm', fields: { by: 'owner', lockId: d.lockId } });
              d.pendingDisarm = null;
            }
          } else {
            if (d.pendingDisarm) {
              d.locked = false;
              d.events.push({ ts: new Date().toISOString(), ev: 'disarm', fields: { by: 'owner' } });
              d.pendingDisarm = null;
            }
          }
          result = '';
        }
        ws.send(JSON.stringify({ responseid: rid, action: 'runcommands', result }));
        return;
      }
    });
  });
  return wss;
}
function stopFakeMc(wss) {
  // 断开全部已建连接（只 close 服务端会留存量连接，桥仍能读写设备）。
  for (const ws of wss.clients) { try { ws.terminate(); } catch (e) { /* 已断 */ } }
  try { wss.close(); } catch (e) { /* 已关 */ }
}

// ================= 桥配置与 HTTP 调用 =================
function makeKeyMaterial(tmp) {
  const kp = crypto.generateKeyPairSync('ed25519');
  const privDer = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
  const seed = privDer.subarray(privDer.length - 32);
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  const pubRaw = pubDer.subarray(pubDer.length - 32);
  const keyB64 = Buffer.concat([seed, pubRaw]).toString('base64');
  const keyFile = path.join(tmp, 'dispatcher.key');
  fs.writeFileSync(keyFile, keyB64, 'utf8');
  return keyFile;
}

// 可变测试控制面：当前会话账号／封禁集／假 K1 台账／台账抛错开关。
let currentUser = 'alice';
let siteAdminUser = null;
const bannedUsers = new Set();
const ledgerBindings = {
  'node-1': { device_id: 'node-1', account_id: 'alice', binding_epoch: 1, state: 'ACTIVE', updated_at: '2026-11-19T00:00:00Z', trigger: 'test' },
  'node-2': { device_id: 'node-2', account_id: 'alice', binding_epoch: 1, state: 'ACTIVE', updated_at: '2026-11-19T00:00:00Z', trigger: 'test' },
};
let ledgerThrow = false;
const COOKIE_A = 'qfr_frd=SESS-ALICE-A; xid=X-A';
const COOKIE_MALLORY = 'qfr_frd=SESS-MALLORY; xid=X-M';
const COOKIE_BOB = 'qfr_frd=SESS-BOB; xid=X-B';
function makeBridge(mcPort, opts) {
  const o = opts || {};
  const tmp = o.tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockops-'));
  const keyFile = makeKeyMaterial(tmp);
  const bridgeCfgPath = path.join(tmp, 'bridge-config.json');
  fs.writeFileSync(bridgeCfgPath, JSON.stringify({
    keyFile, mcUrl: 'ws://127.0.0.1:' + mcPort, svcUser: 'qf-locksvc', svcPass: 'x',
  }), 'utf8');
  const logs = [];
  const bridgeOpts = {
    cfg: {},
    log: (tag, msg) => logs.push(String(tag) + ':' + String(msg)),
    sessionUser: () => currentUser,
    mcConnect: async (cfg, user, pw) => {
      if (pw === 'correct-pw') return { ws: { close() {} } };
      throw new Error('bad-password');
    },
    mcConnectCookie: async () => { throw new Error('no-session'); },
    bridgeCfgPath,
    lockRecordsPath: o.lockRecordsPath || path.join(tmp, 'lock-records.json'),
    enhancedAuthPath: o.enhancedAuthPath || path.join(tmp, 'enhanced-auth-missing.json'),
    isBanLinked: (u) => bannedUsers.has(u),
    isSiteAdmin: (u) => !!siteAdminUser && u === siteAdminUser,
  };
  // o.bindingsFile 指定时走生产默认路径（文件直读）；否则注入假台账。
  if (o.bindingsFile) bridgeOpts.bindingsFile = o.bindingsFile;
  else {
    bridgeOpts.getDeviceBinding = (deviceId) => {
      if (ledgerThrow) throw new Error('fake-ledger-down');
      return ledgerBindings[deviceId] || null;
    };
  }
  const bridge = createLockBridge(bridgeOpts);
  return { bridge, tmp, logs, bridgeCfgPath };
}
function mockReq(method, url, bodyObj, cookie) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { cookie: cookie || '' };
  process.nextTick(() => {
    if (bodyObj !== undefined) req.emit('data', Buffer.from(JSON.stringify(bodyObj), 'utf8'));
    req.emit('end');
  });
  return req;
}
function mockRes() {
  const res = {
    statusCode: 0, headers: {}, body: '', headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; },
    end(data) { this.body = String(data || ''); if (this.onEnd) this.onEnd(); },
  };
  res.done = new Promise((resolve) => { res.onEnd = resolve; });
  return res;
}
async function call(bridge, method, url, bodyObj, cookie) {
  const req = mockReq(method, url, bodyObj, cookie);
  const res = mockRes();
  await bridge.handle(req, res);
  await res.done;
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { /* 非 JSON */ }
  return { status: res.statusCode, json, raw: res.body };
}

// 场景复位：假设备重新上锁＋服务端记一条新的 LOCKED 记录（lock_id／revision 一致）。
let scenSeq = 0;
function resetScenario(b, nodeId) {
  const d = devices[nodeId];
  d.mode = nodeId === 'node-1' ? 'v2' : 'old';
  d.locked = true;
  d.events = [];
  d.inboxWrites = 0;
  d.applyCalls = 0;
  d.pendingDisarm = null;
  scenSeq++;
  const rec = S.createLockRecord({
    device_id: nodeId, lock_id: 'lock-ops-' + nodeId + '-' + scenSeq,
    boot_id: 'boot-1', session_id: '1', sid: 'S-1-5-21-100',
    desired_state: 'LOCKED', actual_state: 'LOCKED', now: Date.now(),
  });
  b._stores.lockRecordStore.upsert(rec);
  d.revision = rec.revision;
  d.lockId = rec.lock_id;
  return rec;
}
function recOf(b, nodeId) { return b._stores.lockRecordStore.get(nodeId); }
async function warmup(b) {
  for (let i = 0; i < 8; i++) {
    const r = await call(b, 'GET', '/lock/devices', undefined, COOKIE_A);
    if (r.status === 200 && r.json && Array.isArray(r.json.devices) && r.json.devices.length === 2) return r;
    await sleep(300);
  }
  return null;
}
// 标准关锁流程：读设备取 revision → 取挑战（带操作编号）→ 提交 disable。
async function disableFlow(b, nodeId, opts) {
  const o = opts || {};
  const cookie = o.cookie || COOKIE_A;
  const devs = await call(b, 'GET', '/lock/devices?force=1', undefined, cookie);
  const dev = devs.json && devs.json.devices ? devs.json.devices.find((x) => x.id === nodeId) : null;
  const rev = dev ? dev.revision : 0;
  const opId = o.opId || ('op-flow-' + (++scenSeq));
  const ch = await call(b, 'GET', '/lock/challenge?id=' + nodeId + '&op=disarm&opId=' + encodeURIComponent(opId), undefined, cookie);
  const devs2 = await call(b, 'GET', '/lock/devices?force=1', undefined, cookie);
  const dev2 = devs2.json && devs2.json.devices ? devs2.json.devices.find((x) => x.id === nodeId) : null;
  const rev2 = dev2 ? dev2.revision : rev;
  const body = { id: nodeId, challenge: ch.json && ch.json.challenge, operationId: opId, revision: o.revision != null ? o.revision : rev2 };
  if (o.password) body.loginPassword = o.password;
  if (o.grantId) body.agentGrantId = o.grantId;
  if (o.challengeOverride !== undefined) body.challenge = o.challengeOverride;
  if (o.opIdOverride !== undefined) body.operationId = o.opIdOverride;
  const submitCookie = o.submitCookie || cookie;
  const r = await call(b, 'POST', '/lock/disable', body, submitCookie);
  return { devs, ch, r, rev, opId };
}
// 纯重放提交：不带挑战（已消费／从未签发时同款），只带操作编号。
async function replayCall(b, nodeId, opId, cookie) {
  return call(b, 'POST', '/lock/disable', { id: nodeId, operationId: opId }, cookie || COOKIE_A);
}
// 响应是否泄露缓存内容：不得出现 lockState／revision／replayed／UNLOCKED。
function leaksNothing(r) {
  return !/lockState|revision|replayed|UNLOCKED/.test(r.raw || '');
}

(async () => {
  const mcWss = await startFakeMc();
  const mcPort = mcWss.address().port;
  const { bridge: b1 } = makeBridge(mcPort);
  currentUser = 'alice';
  const warm = await warmup(b1);
  t('SEC-00 假通道就绪：GET /lock/devices → 200 两台机主设备', !!warm && warm.json.devices.length === 2);

  // ---------- SEC-01：非机主用真实 opId 重放 → 拒绝，0 泄露 ----------
  resetScenario(b1, 'node-1');
  const s1 = await disableFlow(b1, 'node-1');
  const s1writes = devices['node-1'].inboxWrites;
  currentUser = 'mallory';
  const s1r = await replayCall(b1, 'node-1', s1.opId, COOKIE_MALLORY);
  currentUser = 'alice';
  t('SEC-01 非机主真实 opId 重放 → 409、无缓存内容泄露、无第二次操作',
    s1.r.status === 200 && s1r.status === 409 && leaksNothing(s1r)
    && devices['node-1'].inboxWrites === s1writes,
    JSON.stringify({ first: s1.r.status, replay: s1r }));

  // ---------- SEC-02：非机主用不存在 opId → 与 SEC-01 响应逐字节一致 ----------
  currentUser = 'mallory';
  const s2r = await replayCall(b1, 'node-1', 'op-never-existed-1', COOKIE_MALLORY);
  currentUser = 'alice';
  t('SEC-02 非机主不存在 opId → 409，且与真实 opId 的拒绝响应逐字节一致（无 HIT/MISS 差异）',
    s2r.status === 409 && s2r.raw === s1r.raw,
    JSON.stringify({ real: s1r.raw, fake: s2r.raw }));

  // ---------- SEC-03：原机主正常重放 → 200 replayed，无第二次操作 ----------
  resetScenario(b1, 'node-1');
  const s3 = await disableFlow(b1, 'node-1');
  const s3writes = devices['node-1'].inboxWrites;
  const s3applies = devices['node-1'].applyCalls;
  const s3r = await replayCall(b1, 'node-1', s3.opId, COOKIE_A);
  t('SEC-03 原机主正常重放 → 200 replayed、lockState 与首次一致、带 completed_at、无第二次操作',
    s3.r.status === 200 && s3r.status === 200 && s3r.json && s3r.json.replayed === true
    && s3r.json.lockState === 'UNLOCKED' && s3r.json.revision === s3.r.json.revision
    && typeof s3r.json.completed_at === 'number'
    && devices['node-1'].inboxWrites === s3writes && devices['node-1'].applyCalls === s3applies,
    JSON.stringify({ first: s3.r.json, replay: s3r.json }));

  // ---------- SEC-05：同账号双击并发 → 恰一次真实执行 ----------
  resetScenario(b1, 'node-1');
  const devs5 = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const rev5 = devs5.json.devices.find((x) => x.id === 'node-1').revision;
  const op5 = 'op-race-' + (++scenSeq);
  const ch5 = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=' + encodeURIComponent(op5), undefined, COOKIE_A);
  const body5 = { id: 'node-1', challenge: ch5.json.challenge, operationId: op5, revision: rev5 };
  const applyBefore5 = devices['node-1'].applyCalls;
  const [race1, race2] = await Promise.all([
    call(b1, 'POST', '/lock/disable', body5, COOKIE_A),
    call(b1, 'POST', '/lock/disable', body5, COOKIE_A),
  ]);
  const okCount5 = [race1, race2].filter((x) => x.status === 200).length;
  const s5r = await replayCall(b1, 'node-1', op5, COOKIE_A);
  t('SEC-05 同账号双击并发：恰一次 200、恰一次真实操作、事后同编号可查询首次结果',
    okCount5 === 1 && (devices['node-1'].applyCalls - applyBefore5) === 1
    && s5r.status === 200 && s5r.json && s5r.json.replayed === true,
    JSON.stringify({ race1: race1.status, race2: race2.status, replay: s5r.json }));

  // ---------- SEC-06：相同 opId、不同请求参数 → 409 operation-conflict ----------
  // (a) 换设备：opId 属 node-1，请求带 node-2。
  resetScenario(b1, 'node-1');
  resetScenario(b1, 'node-2');
  const s6 = await disableFlow(b1, 'node-1');
  const s6writes2 = devices['node-2'].inboxWrites;
  const s6a = await replayCall(b1, 'node-2', s6.opId, COOKIE_A);
  t('SEC-06a 相同 opId 换设备重放 → 409 operation-conflict、无缓存内容、目标设备零操作',
    s6.r.status === 200 && s6a.status === 409 && s6a.json && s6a.json.code === 'operation-conflict'
    && leaksNothing(s6a) && devices['node-2'].inboxWrites === s6writes2,
    JSON.stringify({ replay: s6a }));
  // (b) 换锁实例：重新上锁产生新 lock_id 后，旧 opId 重放。
  resetScenario(b1, 'node-1');
  const s6b = await replayCall(b1, 'node-1', s6.opId, COOKIE_A);
  const rec6b = recOf(b1, 'node-1');
  t('SEC-06b 相同 opId 换锁实例重放 → 409 operation-conflict、服务端记录仍 LOCKED',
    s6b.status === 409 && s6b.json && s6b.json.code === 'operation-conflict'
    && leaksNothing(s6b) && rec6b && rec6b.actual_state === 'LOCKED'
    && devices['node-1'].locked === true,
    JSON.stringify({ replay: s6b, rec: rec6b && rec6b.actual_state }));

  // ---------- SEC-07：归属转移后原机主重放 → 拒绝 ----------
  resetScenario(b1, 'node-1');
  const s7 = await disableFlow(b1, 'node-1');
  ledgerBindings['node-1'].account_id = 'bob'; // 设备已转移给 bob
  const s7r = await replayCall(b1, 'node-1', s7.opId, COOKIE_A);
  ledgerBindings['node-1'].account_id = 'alice'; // 恢复
  t('SEC-07 归属转移后原机主重放 → 409、无缓存内容泄露',
    s7.r.status === 200 && s7r.status === 409 && leaksNothing(s7r),
    JSON.stringify({ replay: s7r }));

  // ---------- SEC-08：新机主用旧机主 opId → 拒绝 ----------
  resetScenario(b1, 'node-1');
  const s8 = await disableFlow(b1, 'node-1');
  ledgerBindings['node-1'].account_id = 'bob'; // 设备已转移给 bob
  currentUser = 'bob';
  const s8r = await replayCall(b1, 'node-1', s8.opId, COOKIE_BOB);
  currentUser = 'alice';
  ledgerBindings['node-1'].account_id = 'alice'; // 恢复
  t('SEC-08 新机主用旧机主 opId 重放 → 409、无缓存内容泄露',
    s8.r.status === 200 && s8r.status === 409 && leaksNothing(s8r),
    JSON.stringify({ replay: s8r }));

  // ---------- SEC-09：注销／撤销后重放 → 拒绝 ----------
  // (a) 封禁：入口 403，碰不到重放分支。
  resetScenario(b1, 'node-1');
  const s9 = await disableFlow(b1, 'node-1');
  bannedUsers.add('alice');
  const s9a = await replayCall(b1, 'node-1', s9.opId, COOKIE_A);
  bannedUsers.delete('alice');
  // (b) 会话撤销：sessionUser 返回 null，入口 401。
  currentUser = null;
  const s9b = await replayCall(b1, 'node-1', s9.opId, COOKIE_A);
  currentUser = 'alice';
  t('SEC-09 注销／撤销后重放 → 封禁 403、会话撤销 401，均无缓存内容泄露',
    s9.r.status === 200 && s9a.status === 403 && leaksNothing(s9a)
    && s9b.status === 401 && leaksNothing(s9b),
    JSON.stringify({ banned: s9a, revoked: s9b }));

  // ---------- SEC-10：旧记录缺失主体字段 → 不泄露原文 ----------
  resetScenario(b1, 'node-1');
  b1._stores.opStore.store('op-legacy-1', { lockState: 'UNLOCKED', revision: 7 }); // 无 binding
  const s10a = await replayCall(b1, 'node-1', 'op-legacy-1', COOKIE_A);
  // 同编号＋新挑战走正常流程：得新鲜结果（非缓存），replayed 标志缺席、revision 不是旧值 7。
  const s10b = await disableFlow(b1, 'node-1', { opId: 'op-legacy-1' });
  t('SEC-10 旧记录缺失主体字段：无挑战重放 → 409 不泄露原文；新挑战走正常流程 → 新鲜结果、非重放',
    s10a.status === 409 && leaksNothing(s10a)
    && s10b.r.status === 200 && s10b.r.json && s10b.r.json.replayed !== true
    && s10b.r.json.lockState === 'UNLOCKED' && s10b.r.json.revision !== 7,
    JSON.stringify({ replay: s10a, fresh: s10b.r.json }));

  // ---------- SEC-11：归属台账不可用 → 安全拒绝，不回退免鉴权 ----------
  resetScenario(b1, 'node-1');
  const s11 = await disableFlow(b1, 'node-1');
  ledgerThrow = true;
  const s11r = await replayCall(b1, 'node-1', s11.opId, COOKIE_A);
  ledgerThrow = false;
  t('SEC-11 归属台账不可用：重放 → 409、不泄露缓存内容（不回退免鉴权）',
    s11.r.status === 200 && s11r.status === 409 && leaksNothing(s11r),
    JSON.stringify({ replay: s11r }));

  // ---------- SEC-12：历史 UNLOCKED 重放不覆盖更新的实际锁状态 ----------
  resetScenario(b1, 'node-1');
  const s12 = await disableFlow(b1, 'node-1');
  const s12rev = s12.r.json.revision;
  resetScenario(b1, 'node-1'); // 重新上锁：新 lock_id、记录回 LOCKED、设备重新锁定
  const s12writes = devices['node-1'].inboxWrites;
  const s12r = await replayCall(b1, 'node-1', s12.opId, COOKIE_A);
  const rec12 = recOf(b1, 'node-1');
  t('SEC-12 历史 UNLOCKED 重放 → 409，服务端记录仍 LOCKED（新 lock_id）、设备仍锁定、无新操作',
    s12.r.status === 200 && s12r.status === 409 && leaksNothing(s12r)
    && rec12 && rec12.actual_state === 'LOCKED' && rec12.revision !== s12rev
    && devices['node-1'].locked === true && devices['node-1'].inboxWrites === s12writes,
    JSON.stringify({ replay: s12r, rec: rec12 && { state: rec12.actual_state, rev: rec12.revision } }));

  // ---------- X-1：生产默认路径——台账文件直读（不注入 getDeviceBinding） ----------
  const tmpX = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockops-x1-'));
  const bindingsFileX = path.join(tmpX, 'bindings.json');
  fs.writeFileSync(bindingsFileX, JSON.stringify({
    bindings: {
      'node-1': { device_id: 'node-1', account_id: 'alice', binding_epoch: 1, state: 'ACTIVE', updated_at: '2026-11-19T00:00:00Z', trigger: 'test' },
      'node-2': { device_id: 'node-2', account_id: 'alice', binding_epoch: 1, state: 'ACTIVE', updated_at: '2026-11-19T00:00:00Z', trigger: 'test' },
    },
  }), 'utf8');
  const { bridge: b3 } = makeBridge(mcPort, { bindingsFile: bindingsFileX });
  resetScenario(b3, 'node-1');
  const x1 = await disableFlow(b3, 'node-1');
  const x1r = await replayCall(b3, 'node-1', x1.opId, COOKIE_A);
  t('X-1 台账文件直读（生产默认路径）：disable 200、重放 200 replayed',
    x1.r.status === 200 && x1r.status === 200 && x1r.json && x1r.json.replayed === true
    && x1r.json.lockState === 'UNLOCKED',
    JSON.stringify({ first: x1.r.json, replay: x1r.json }));

  // ---------- SEC-04：原机主离线重放 → 200 replayed（不依赖设备在线） ----------
  // 最后跑：关掉本节专用假 MC 后，任何设备读取都会失败；200 即证明重放
  // 全程未碰设备。
  const mcWss2 = await startFakeMc();
  const { bridge: b2 } = makeBridge(mcWss2.address().port);
  const warm2 = await warmup(b2);
  resetScenario(b2, 'node-1');
  const s4 = await disableFlow(b2, 'node-1');
  stopFakeMc(mcWss2);
  await sleep(300); // 等连接彻底断开
  const s4r = await replayCall(b2, 'node-1', s4.opId, COOKIE_A);
  t('SEC-04 原机主离线重放 → 200 replayed（假 MC 已关，设备不可达仍可重放）',
    !!warm2 && s4.r.status === 200 && s4r.status === 200 && s4r.json && s4r.json.replayed === true
    && s4r.json.lockState === 'UNLOCKED' && s4r.json.revision === s4.r.json.revision,
    JSON.stringify({ first: s4.r.json, replay: s4r.json }));

  console.log('----');
  console.log('test-lock-opstore-b: PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
