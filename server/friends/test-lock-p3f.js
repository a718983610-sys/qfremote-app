'use strict';
/*
 * P3-06 · 完整回归补测（沙箱实跑，不碰生产服务、不连真机、不碰 D39ABOL）
 * 依据：GPT 三项定夺（2026-11-19 04:25）§1／§3；LOCK-PROTOCOL-CONTRACT.md
 * v2.0.0（§4 对账／§5 事件／§6 revision 与幂等／§7 暂停／§10 分级认证）；
 * VERIFY-P3E §6（跨端联调待 P3-06）＋ VERIFY-P3C §4（M-1 桥掩盖性问题）。
 *
 * 做法：本地假 MeshCentral control 通道（ws 服务端，实现 userinfo／nodes／
 * runcommands 三语义，设备 status.json 用 Base64 回传；disarm 信封投递＋
 * apply 后翻 Off＋补事件），全程实跑 /lock/disable 真分支；另有纯函数级
 * 断言（挑战过期／applyCorrection 失败模式／信封去重）。
 * 两台假设备：node-1＝v2 设备（actual_state／revision／lockId 事件），
 * node-2＝旧 Go 设备（无 actual_state／无 revision／version 2.0.3、无 lockId 事件）。
 * 用法：node server/friends/test-lock-p3f.js；退出码 0=全过。
 * 注意：F-B2 超时用例实跑桥内 30 秒对账窗口，整文件约 40 秒。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const S = require('./lock-state');
const { EnvelopeReplayGuard } = require('../../windows/lock-v2/envelope-replay');
const { createLockBridge, _test: BT } = require('./lock-bridge');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; console.log('FAIL-', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 假设备（两台） =================
// node-1：v2 设备；node-2：旧 Go 设备（version 2.x，仍是 v1 协议）。
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
    if (!d.noRevision) base.revision = d.revision; // F-C2：置 noRevision 时模拟 v2 缺 revision 上报
    base.boot_id = d.boot_id;
    base.session_id = 1;
    base.sid = 'S-1-5-21-100';
  }
  return base;
}
let fakeWss = null;
async function startFakeMc() {
  fakeWss = new WebSocket.Server({ port: 0 });
  await new Promise((r) => fakeWss.on('listening', r));
  fakeWss.on('connection', (ws) => {
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
          if (d.mode === 'never') {
            // 设备不响应：不翻 Off、不补事件（对账超时场景）。
          } else if (d.mode === 'reject') {
            if (d.pendingDisarm) {
              d.events.push({ ts: new Date().toISOString(), ev: 'envelope-rejected', fields: { id: d.pendingDisarm, reason: 'bad-signature' } });
              d.pendingDisarm = null;
            }
          } else if (d.mode === 'v2') {
            if (d.pendingDisarm) {
              d.locked = false;
              // 真实 v2 设备 disarm 走两步（LOCKED→UNLOCKING→UNLOCKED，见
              // lock-coordinator.js：transition UNLOCKING ＋ applyAck UNLOCKED），
              // revision 共 +2，与服务端 applyCorrection 的两步 +2 对齐；
              // 只 +1 会使下次读触发 revision-conflict（假设备建模问题，非产品 bug）。
              d.revision += 2;
              d.events.push({ ts: new Date().toISOString(), ev: 'disarm', fields: { by: 'owner', lockId: d.lockId } });
              d.pendingDisarm = null;
            }
          } else { // old Go：事件只有 {by}，无 lockId（时间窗口兜底）
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
  return fakeWss.address().port;
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

let currentUser = 'alice';
let siteAdminUser = null;
const COOKIE_A = 'qfr_frd=SESS-ALICE-A; xid=X-A';
const COOKIE_B = 'qfr_frd=SESS-ALICE-B; xid=X-B'; // 同一账号、另一会话
const COOKIE_MALLORY = 'qfr_frd=SESS-MALLORY; xid=X-M';
const COOKIE_ADMIN = 'qfr_frd=SESS-ADMIN; xid=X-ADM';
function makeBridge(mcPort, opts) {
  const o = opts || {};
  const tmp = o.tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockp3f-'));
  const keyFile = makeKeyMaterial(tmp);
  const bridgeCfgPath = path.join(tmp, 'bridge-config.json');
  fs.writeFileSync(bridgeCfgPath, JSON.stringify({
    keyFile, mcUrl: 'ws://127.0.0.1:' + mcPort, svcUser: 'qf-locksvc', svcPass: 'x',
  }), 'utf8');
  const logs = [];
  const bridge = createLockBridge({
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
    isBanLinked: () => false,
    isSiteAdmin: (u) => !!siteAdminUser && u === siteAdminUser,
  });
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
function resetScenario(b, nodeId, opts) {
  const o = opts || {};
  const d = devices[nodeId];
  d.mode = o.mode || (nodeId === 'node-1' ? 'v2' : 'old');
  d.locked = o.locked !== false;
  d.events = o.events ? o.events.slice() : [];
  d.inboxWrites = 0;
  d.applyCalls = 0;
  d.pendingDisarm = null;
  if (o.boot_id) d.boot_id = o.boot_id;
  scenSeq++;
  const rec = S.createLockRecord({
    device_id: nodeId, lock_id: 'lock-p3f-' + nodeId + '-' + scenSeq,
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
  // 取挑战后重读一次 revision：读路径对账可能已推进记录（如设备已报强证据解锁），
  // 提交须用最新 revision（真实前端点“重新加载”同款行为），否则必吃 revision-stale。
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

(async () => {
  const mcPort = await startFakeMc();
  const { bridge: b1, tmp: tmp1, logs: logs1 } = makeBridge(mcPort);
  currentUser = 'alice';
  const warm = await warmup(b1);
  t('F-00 假通道就绪：GET /lock/devices → 200 两台机主设备', !!warm && warm.json.devices.length === 2
    && warm.json.devices.some((x) => x.id === 'node-1') && warm.json.devices.some((x) => x.id === 'node-2'));

  // ================= A. 跨端集成 =================
  // A1：v2 设备实报 disarm 事件（含 lockId）走完整 /lock/disable 链路。
  resetScenario(b1, 'node-1');
  const a1 = await disableFlow(b1, 'node-1');
  const a1rec = recOf(b1, 'node-1');
  const a1ev = devices['node-1'].events.find((e) => e.ev === 'disarm');
  t('F-A1 v2 disarm 事件（lockId 匹配）走完整 disable → 200 UNLOCKED',
    a1.r.status === 200 && a1.r.json && a1.r.json.lockState === 'UNLOCKED' && a1rec && a1rec.actual_state === 'UNLOCKED'
    && a1ev && a1ev.fields && a1ev.fields.lockId === a1rec.lock_id
    && devices['node-1'].inboxWrites === 1 && devices['node-1'].applyCalls === 1,
    JSON.stringify({ status: a1.r.status, json: a1.r.json, rec: a1rec && a1rec.actual_state, ev: a1ev }));
  // A2：v2 设备实报 unlock-ok 事件（本地输密码解锁）→ 幂等分支，0 信封投递。
  resetScenario(b1, 'node-1');
  const a2rec = recOf(b1, 'node-1');
  devices['node-1'].locked = false;
  devices['node-1'].revision += 2; // 本地解锁同样走设备端两步，revision +2，与记录对账的 +2 对齐
  devices['node-1'].events.push({ ts: new Date().toISOString(), ev: 'unlock-ok', fields: { by: 'local', lockId: a2rec.lock_id } });
  const a2 = await disableFlow(b1, 'node-1');
  t('F-A2 v2 unlock-ok 事件走 disable → 200 alreadyUnlocked、0 信封投递',
    a2.r.status === 200 && a2.r.json && a2.r.json.lockState === 'UNLOCKED' && a2.r.json.alreadyUnlocked === true
    && devices['node-1'].inboxWrites === 0 && devices['node-1'].applyCalls === 0
    && recOf(b1, 'node-1').actual_state === 'UNLOCKED',
    JSON.stringify({ status: a2.r.status, json: a2.r.json }));
  // A3：v2 设备实报 boot-recovered 事件（重启后恢复）→ 幂等分支。
  resetScenario(b1, 'node-1');
  const a3rec = recOf(b1, 'node-1');
  devices['node-1'].locked = false;
  devices['node-1'].revision += 2; // 重启恢复同样走设备端两步，revision +2
  devices['node-1'].boot_id = 'boot-2';
  devices['node-1'].events.push({ ts: new Date().toISOString(), ev: 'boot-recovered', fields: { marker: 'boot-changed', bootId: 'boot-2', lockId: a3rec.lock_id, previousState: 'LOCKED' } });
  const a3 = await disableFlow(b1, 'node-1');
  t('F-A3 v2 boot-recovered 事件走 disable → 200 alreadyUnlocked（reason boot-recovered）',
    a3.r.status === 200 && a3.r.json && a3.r.json.lockState === 'UNLOCKED' && a3.r.json.alreadyUnlocked === true
    && devices['node-1'].inboxWrites === 0 && recOf(b1, 'node-1').actual_state === 'UNLOCKED',
    JSON.stringify({ status: a3.r.status, json: a3.r.json }));
  devices['node-1'].boot_id = 'boot-1';
  // A4：服务端 operationId 去重——同一 opId＋新挑战再次提交，返回首次成功结果，不产生第二次真实操作。
  resetScenario(b1, 'node-1');
  const a4 = await disableFlow(b1, 'node-1');
  const a4writes = devices['node-1'].inboxWrites;
  const a4applies = devices['node-1'].applyCalls;
  const a4ch = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=' + encodeURIComponent(a4.opId), undefined, COOKIE_A);
  const a4r2 = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: a4ch.json && a4ch.json.challenge, operationId: a4.opId, revision: a4.r.json ? a4.r.json.revision : 0 }, COOKIE_A);
  t('F-A4 服务端 operationId 去重：同 opId 重提交 → 200 replayed、无第二次投递',
    a4.r.status === 200 && a4r2.status === 200 && a4r2.json && a4r2.json.replayed === true
    && a4r2.json.lockState === 'UNLOCKED'
    && devices['node-1'].inboxWrites === a4writes && devices['node-1'].applyCalls === a4applies,
    JSON.stringify({ first: a4.r.status, second: a4r2.json, writes: devices['node-1'].inboxWrites }));
  // A5：设备端信封去重（EnvelopeReplayGuard）：同一信封 id 第二次必拒 E_ENVELOPE_REPLAY。
  t('F-A5 设备端信封去重：同一信封 id 第二次 check → replay＋E_ENVELOPE_REPLAY', (() => {
    const g = new EnvelopeReplayGuard();
    if (g.check('env-p3f-1').replay !== false) return false;
    g.remember('env-p3f-1');
    const chk = g.check('env-p3f-1');
    if (!(chk.replay === true && chk.code === 'E_ENVELOPE_REPLAY')) return false;
    if (g.check('env-p3f-2').replay !== false) return false;
    for (let i = 0; i < 64; i++) g.remember('env-x' + i);
    return g.count() === 64 && !g.has('env-p3f-1');
  })());
  // A6：旧 Go 设备（无 lockId 事件）走时间窗口兜底 → 200 UNLOCKED。
  resetScenario(b1, 'node-2');
  const a6 = await disableFlow(b1, 'node-2');
  const a6ev = devices['node-2'].events.find((e) => e.ev === 'disarm');
  t('F-A6 旧 Go 设备无 lockId 事件走时间窗口兜底 → 200 UNLOCKED',
    a6.r.status === 200 && a6.r.json && a6.r.json.lockState === 'UNLOCKED'
    && recOf(b1, 'node-2').actual_state === 'UNLOCKED'
    && a6ev && a6ev.fields && !('lockId' in a6ev.fields),
    JSON.stringify({ status: a6.r.status, json: a6.r.json, ev: a6ev }));
  // A7：两类设备混跑不串扰——各自 disable 后记录独立，node-1 的事件不影响 node-2。
  resetScenario(b1, 'node-1');
  resetScenario(b1, 'node-2');
  const a7r1 = recOf(b1, 'node-1');
  const a7r2 = recOf(b1, 'node-2');
  const a7d1 = await disableFlow(b1, 'node-1');
  const a7mid2 = recOf(b1, 'node-2');
  const a7d2 = await disableFlow(b1, 'node-2');
  const a7f1 = recOf(b1, 'node-1');
  const a7f2 = recOf(b1, 'node-2');
  t('F-A7 混跑不串扰：node-1 解锁不碰 node-2 记录，两台各自独立落 UNLOCKED',
    a7d1.r.status === 200 && a7d2.r.status === 200
    && a7mid2.actual_state === 'LOCKED' && a7mid2.lock_id === a7r2.lock_id && a7mid2.revision === a7r2.revision
    && a7f1.actual_state === 'UNLOCKED' && a7f2.actual_state === 'UNLOCKED'
    && a7f1.lock_id === a7r1.lock_id && a7f2.lock_id === a7r2.lock_id && a7f1.lock_id !== a7f2.lock_id,
    JSON.stringify({ mid2: a7mid2 && a7mid2.actual_state, f1: a7f1 && a7f1.actual_state, f2: a7f2 && a7f2.actual_state }));

  // ================= B. 失败注入 =================
  // B1（M-1）：applyCorrection 失败时桥必须不报成功——预置同 opId 的修正审计，
  // 使本次 disable 末尾的 applyCorrection 走 op-id-replayed。
  resetScenario(b1, 'node-1');
  const m1op = 'op-m1-' + (++scenSeq);
  const m1seed = recOf(b1, 'node-1');
  const m1seeded = Object.assign({}, m1seed, {
    history: m1seed.history.concat([{ at: Date.now(), op_id: m1op, by: 'alice', action: 'correction:unlocked', from: 'UNLOCKING', to: 'UNLOCKED', reason: 'preseed-p3f' }]),
  });
  b1._stores.lockRecordStore.upsert(m1seeded);
  const m1 = await disableFlow(b1, 'node-1', { opId: m1op });
  const m1rec = recOf(b1, 'node-1');
  const m1cached = b1._stores.opStore.lookup(m1op);
  t('F-B1(M-1) applyCorrection 失败时桥不报成功：不回 200 UNLOCKED、不缓存假成功、记录仍 UNLOCKING',
    m1.r.status === 409 && m1.r.json && m1.r.json.code === 'state-conflict'
    && m1rec && m1rec.actual_state === 'UNLOCKING' && m1cached === null,
    JSON.stringify({ status: m1.r.status, json: m1.r.json, rec: m1rec && m1rec.actual_state, cached: m1cached }));
  // B1b：applyCorrection 单元失败模式（op-id-replayed／证据不足／未知目标态）。
  t('F-B1b applyCorrection 单元：重放／弱证据／未知态均 ok:false', (() => {
    const base = S.createLockRecord({ device_id: 'node//x', lock_id: 'lock-x', desired_state: 'LOCKED', actual_state: 'LOCKED', now: Date.now() });
    const withHist = Object.assign({}, base, { history: [{ at: Date.now(), op_id: 'op-r', by: 'a', action: 'correction:unlocked', from: 'UNLOCKING', to: 'UNLOCKED', reason: 'r' }] });
    if (S.applyCorrection(withHist, { op_id: 'op-r', to_state: 'UNLOCKED', reason: 'r', evidence: 'strong' }).ok !== false) return false;
    if (S.applyCorrection(withHist, { op_id: 'op-r', to_state: 'UNLOCKED', reason: 'r', evidence: 'strong' }).reason !== 'op-id-replayed') return false;
    if (S.applyCorrection(base, { op_id: 'op-w', to_state: 'UNLOCKED', reason: 'r', evidence: 'weak' }).reason !== 'evidence-insufficient') return false;
    if (S.applyCorrection(base, { op_id: 'op-u', to_state: 'NOPE', reason: 'r', evidence: 'strong' }).reason !== 'unknown-state') return false;
    return S.applyCorrection(base, { op_id: 'op-ok', to_state: 'UNLOCKED', reason: 'r', evidence: 'strong' }).ok === true;
  })());
  // B2：超时——设备不响应，对账 30 秒后 504，记录翻 UNKNOWN（不判 UNLOCKED），操作编号不缓存。
  resetScenario(b1, 'node-1', { mode: 'never' });
  const tout = await disableFlow(b1, 'node-1');
  t('F-B2 超时：设备不响应 → 504、记录 UNKNOWN、op 未缓存',
    tout.r.status === 504 && recOf(b1, 'node-1').actual_state === 'UNKNOWN'
    && b1._stores.opStore.lookup(tout.opId) === null && devices['node-1'].locked === true,
    JSON.stringify({ status: tout.r.status, json: tout.r.json, rec: recOf(b1, 'node-1').actual_state }));
  // B3：拒绝——设备拒收 disarm 信封，409，记录进 RECOVERY_REQUIRED，op 未缓存。
  resetScenario(b1, 'node-1', { mode: 'reject' });
  const brej = await disableFlow(b1, 'node-1');
  t('F-B3 拒绝：设备拒收信封 → 409、记录 RECOVERY_REQUIRED、op 未缓存',
    brej.r.status === 409 && recOf(b1, 'node-1').actual_state === 'RECOVERY_REQUIRED'
    && b1._stores.opStore.lookup(brej.opId) === null && devices['node-1'].locked === true,
    JSON.stringify({ status: brej.r.status, json: brej.r.json, rec: recOf(b1, 'node-1').actual_state }));
  // B4：revision 冲突——提交时 revision 与服务端不一致 → 409 revision-stale。
  resetScenario(b1, 'node-1');
  const b4 = await disableFlow(b1, 'node-1', { revision: 999 });
  t('F-B4 revision 冲突：提交 revision 与服务端不一致 → 409 revision-stale',
    b4.r.status === 409 && b4.r.json && b4.r.json.code === 'revision-stale',
    JSON.stringify({ status: b4.r.status, json: b4.r.json }));
  // B5：挑战过期（单元级，注入时钟）：5 分钟后验证失败。
  t('F-B5 挑战过期：5 分钟后验证 → challenge-expired', (() => {
    let now = Date.parse('2026-11-19T06:00:00+08:00');
    const chs = S.createChallengeStore({ now: () => now });
    const issued = chs.issue({ account: 'alice', deviceId: 'node-1', op: 'disarm', lockId: 'lock-1', revision: 1, operationId: 'op-e', sessionKey: 'sess-A' });
    now += 5 * 60 * 1000 + 1;
    return chs.verify({ challenge: issued.challenge, account: 'alice', deviceId: 'node-1', op: 'disarm', lockId: 'lock-1', revision: 1, operationId: 'op-e', sessionKey: 'sess-A' }).reason === 'challenge-expired';
  })());
  // B6：挑战重放（HTTP）：有效挑战＋错 revision 提交一次（409，挑战已消费）→ 同挑战再提交 → 409。
  resetScenario(b1, 'node-1');
  const b6 = await disableFlow(b1, 'node-1', { revision: 999 });
  const b6r2 = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: b6.ch && b6.ch.json && b6.ch.json.challenge, operationId: b6.opId, revision: b6.rev }, COOKIE_A);
  t('F-B6 挑战重放：消费过的挑战再提交 → 409（不回放成功）',
    b6.r.status === 409 && b6r2.status === 409 && b6r2.json && b6r2.json.code === 'challenge-invalid',
    JSON.stringify({ first: b6.r.json, second: b6r2.json }));
  // B7：会话撤销后重放（HTTP）：取挑战后 purgeUser → 提交 → 409。
  resetScenario(b1, 'node-1');
  const b7op = 'op-b7-' + (++scenSeq);
  const b7ch = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=' + encodeURIComponent(b7op), undefined, COOKIE_A);
  b1.purgeUser('alice');
  const b7devs = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const b7rev = b7devs.json.devices.find((x) => x.id === 'node-1').revision;
  const b7r = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: b7ch.json && b7ch.json.challenge, operationId: b7op, revision: b7rev }, COOKIE_A);
  t('F-B7 会话撤销后重放：purgeUser 后旧挑战提交 → 409',
    b7r.status === 409 && b7r.json && (b7r.json.code === 'challenge-invalid' || b7r.json.code === 'challenge-expired'),
    JSON.stringify({ status: b7r.status, json: b7r.json }));

  // ================= C. 旧新版本兼容 =================
  // C1：旧 Go 设备上报无 actual_state、无 revision、version 2.x——服务端仍按 v1
  // 处理，读路径不进 RECOVERY_REQUIRED（§6 勘误的判定口径：只看 actual_state）。
  resetScenario(b1, 'node-2');
  const c1devs = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const c1st = fakeStatus('node-2');
  t('F-C1 旧 Go 设备（version 2.0.3、无 actual_state、无 revision）读路径不判 v2 缺 revision',
    c1st.version === '2.0.3' && !('actual_state' in c1st) && !('revision' in c1st)
    && recOf(b1, 'node-2').actual_state === 'LOCKED'
    && c1devs.json.devices.find((x) => x.id === 'node-2').lockState === 'LOCKED',
    JSON.stringify({ status: c1st, rec: recOf(b1, 'node-2').actual_state }));
  // C2：v2 设备缺 revision（HTTP 级）→ 读路径进 RECOVERY_REQUIRED（revision-missing）。
  resetScenario(b1, 'node-1');
  devices['node-1'].noRevision = true;
  await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const c2rec = recOf(b1, 'node-1');
  devices['node-1'].noRevision = false;
  t('F-C2 v2 设备缺 revision → 读路径进 RECOVERY_REQUIRED（revision-missing）',
    c2rec && c2rec.actual_state === 'RECOVERY_REQUIRED',
    JSON.stringify({ rec: c2rec && c2rec.actual_state }));
  // C3：v2 revision 非数字（单元级）→ 同样判 revision-missing。
  t('F-C3 v2 revision 非数字 → revision-missing（单元级）', (() => {
    const rec = S.createLockRecord({ device_id: 'node//x', lock_id: 'lock-x', desired_state: 'LOCKED', actual_state: 'LOCKED', now: Date.now() });
    const st = { state: 'Locked', actual_state: 'LOCKED', version: '2.0.0', revision: 'x', updatedAt: new Date().toISOString(), lastEvents: [] };
    const r = S.reconcileRecord(rec, st, { now: Date.now() });
    return r.decision === 'to-recovery' && r.reason === 'revision-missing';
  })());
  // C4：旧设备 status 永远不带 actual_state（§6 勘误的事实前提：旧 Go 从不写该字段）。
  t('F-C4 旧设备 status 无 actual_state 字段（version 2.x 不是 v2 判据）',
    !('actual_state' in fakeStatus('node-2')) && fakeStatus('node-2').version.split('.')[0] === '2'
    && ('actual_state' in fakeStatus('node-1')));

  // ================= D. 暂停守卫 =================
  const updBody = { id: 'node-1', update: { version: '9.9.9', url: 'https://example.com/x.zip', sha256: 'a'.repeat(64) } };
  resetScenario(b1, 'node-1');
  let dr = await call(b1, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, COOKIE_A);
  t('F-D1 暂停守卫：普通用户 enable → 503、0 副作用',
    dr.status === 503 && devices['node-1'].inboxWrites === 0 && devices['node-1'].applyCalls === 0 && devices['node-1'].locked === true);
  dr = await call(b1, 'POST', '/lock/update', updBody, COOKIE_A);
  t('F-D2 暂停守卫：普通用户 update → 503 lock-remediation-paused、0 副作用',
    dr.status === 503 && dr.json && dr.json.code === 'lock-remediation-paused'
    && devices['node-1'].inboxWrites === 0 && devices['node-1'].applyCalls === 0 && devices['node-1'].version === '2.0.0');
  siteAdminUser = '718983610'; currentUser = '718983610';
  dr = await call(b1, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, COOKIE_ADMIN);
  const d3a = dr.status === 503 && devices['node-1'].inboxWrites === 0;
  dr = await call(b1, 'POST', '/lock/update', updBody, COOKIE_ADMIN);
  const d3b = dr.status === 503 && dr.json && dr.json.code === 'lock-remediation-paused' && devices['node-1'].inboxWrites === 0;
  currentUser = 'alice'; siteAdminUser = null;
  t('F-D3 暂停守卫：站长账号 enable/update 暂停期仍拒绝（无白名单例外）', d3a && d3b);
  dr = await call(b1, 'POST', '/lock/update', updBody, COOKIE_A);
  dr = await call(b1, 'POST', '/lock/update', updBody, COOKIE_A);
  await sleep(1500);
  dr = await call(b1, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, COOKIE_A);
  t('F-D4 暂停守卫：重试 update/enable＋静置 1.5 秒仍 0 副作用（无后台任务偷跑）',
    dr.status === 503 && devices['node-1'].inboxWrites === 0 && devices['node-1'].applyCalls === 0 && devices['node-1'].locked === true);
  // D5：重启后仍有效——新桥实例（同一记录文件）enable/update 仍 503，记录从文件重载。
  const d5before = recOf(b1, 'node-1');
  const b2 = makeBridge(mcPort, { tmp: tmp1, lockRecordsPath: path.join(tmp1, 'lock-records.json') }).bridge;
  const d5rec = b2._stores.lockRecordStore.get('node-1');
  const d5r1 = await call(b2, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, COOKIE_A);
  const d5r2 = await call(b2, 'POST', '/lock/update', updBody, COOKIE_A);
  t('F-D5 暂停守卫：重启（新桥实例）后 enable/update 仍 503，锁记录从文件重载一致',
    d5r1.status === 503 && d5r2.status === 503 && d5r2.json && d5r2.json.code === 'lock-remediation-paused'
    && d5rec && d5rec.lock_id === d5before.lock_id && d5rec.revision === d5before.revision && d5rec.actual_state === d5before.actual_state,
    JSON.stringify({ before: d5before && d5before.actual_state, after: d5rec && d5rec.actual_state }));
  dr = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  t('F-D6 暂停守卫：只读诊断 GET /lock/devices 正常可用（200）', dr.status === 200 && Array.isArray(dr.json.devices));

  // ================= E. 鉴权负向 =================
  // E1：未登录 → 401（enable／disable 均不泄露暂停信息）。
  resetScenario(b1, 'node-1');
  currentUser = null;
  const e1a = await call(b1, 'POST', '/lock/disable', { id: 'node-1', operationId: 'op-e1', challenge: 'x', revision: 1 }, '');
  const e1b = await call(b1, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, '');
  currentUser = 'alice';
  t('F-E1 未登录 enable/disable → 401', e1a.status === 401 && e1b.status === 401);
  // E2：非机主——取挑战 403；设备列表为空；持机主挑战提交 → 409（挑战绑定不认非机主）。
  resetScenario(b1, 'node-1');
  currentUser = 'mallory';
  const e2ch = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-e2', undefined, COOKIE_MALLORY);
  const e2devs = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_MALLORY);
  currentUser = 'alice';
  // 机主取一个新挑战（只取不提交），再由 mallory 持该挑战提交：挑战绑定账号 alice，
  // 换账号即 binding-mismatch。注意不能用已成功提交过的 opId——opStore 幂等重放
  // 在机主核对之前返回首次成功结果（设计如此：重放不产生新操作），那条路径不测机主。
  const e2chA = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-e2c', undefined, COOKIE_A);
  const e2devsA = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const e2revA = e2devsA.json.devices.find((x) => x.id === 'node-1').revision;
  currentUser = 'mallory';
  const e2r2 = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: e2chA.json && e2chA.json.challenge, operationId: 'op-e2c', revision: e2revA }, COOKIE_MALLORY);
  currentUser = 'alice';
  t('F-E2 非机主：取挑战 403、设备列表为空、持机主挑战提交仍拒绝',
    e2ch.status === 403 && Array.isArray(e2devs.json.devices) && e2devs.json.devices.length === 0
    && e2r2.status === 409,
    JSON.stringify({ ch: e2ch.status, devs: e2devs.json && e2devs.json.devices.length, submit: e2r2.status }));
  // E3：伪造挑战 → 409 challenge-invalid。
  resetScenario(b1, 'node-1');
  const e3devs = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const e3rev = e3devs.json.devices.find((x) => x.id === 'node-1').revision;
  const e3r = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: 'ch-forged-00000000000000000000000000000000', operationId: 'op-e3', revision: e3rev }, COOKIE_A);
  t('F-E3 伪造挑战 → 409 challenge-invalid',
    e3r.status === 409 && e3r.json && e3r.json.code === 'challenge-invalid',
    JSON.stringify({ status: e3r.status, json: e3r.json }));
  // E4：跨设备挑战（node-1 的挑战用于 node-2）→ 409。
  resetScenario(b1, 'node-1');
  resetScenario(b1, 'node-2');
  const e4ch = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-e4', undefined, COOKIE_A);
  const e4devs = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const e4rev2 = e4devs.json.devices.find((x) => x.id === 'node-2').revision;
  const e4r = await call(b1, 'POST', '/lock/disable',
    { id: 'node-2', challenge: e4ch.json && e4ch.json.challenge, operationId: 'op-e4', revision: e4rev2 }, COOKIE_A);
  t('F-E4 跨设备挑战 → 409（挑战绑定设备）',
    e4r.status === 409 && e4r.json && (e4r.json.code === 'challenge-mismatch' || e4r.json.code === 'challenge-binding-mismatch'),
    JSON.stringify({ status: e4r.status, json: e4r.json }));
  // E5：跨会话提交（同一账号、另一会话 cookie）→ 409。
  resetScenario(b1, 'node-1');
  const e5 = await disableFlow(b1, 'node-1', { submitCookie: COOKIE_B });
  t('F-E5 跨会话提交 → 409（挑战绑定会话）',
    e5.r.status === 409 && e5.r.json && (e5.r.json.code === 'challenge-mismatch' || e5.r.json.code === 'challenge-binding-mismatch'),
    JSON.stringify({ status: e5.r.status, json: e5.r.json }));
  // E6：错操作编号（挑战绑 op-A，提交 op-B）→ 409。
  resetScenario(b1, 'node-1');
  const e6devs = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const e6rev = e6devs.json.devices.find((x) => x.id === 'node-1').revision;
  const e6ch = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-e6a', undefined, COOKIE_A);
  const e6r = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: e6ch.json && e6ch.json.challenge, operationId: 'op-e6b', revision: e6rev }, COOKIE_A);
  t('F-E6 错操作编号 → 409（挑战绑定操作编号）',
    e6r.status === 409 && e6r.json && (e6r.json.code === 'challenge-mismatch' || e6r.json.code === 'challenge-binding-mismatch'),
    JSON.stringify({ status: e6r.status, json: e6r.json }));
  // E7：revision 变化——旧挑战＋旧 revision 在记录推进后提交 → 409 revision-stale。
  resetScenario(b1, 'node-1');
  const e7opOld = 'op-e7-old-' + (++scenSeq);
  const e7chOld = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=' + encodeURIComponent(e7opOld), undefined, COOKIE_A);
  const e7devs0 = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const e7revOld = e7devs0.json.devices.find((x) => x.id === 'node-1').revision;
  const e7ok = await disableFlow(b1, 'node-1'); // 成功一次，记录 revision 推进
  const e7r = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: e7chOld.json && e7chOld.json.challenge, operationId: e7opOld, revision: e7revOld }, COOKIE_A);
  t('F-E7 revision 变化后旧挑战提交 → 409 revision-stale',
    e7ok.r.status === 200 && e7r.status === 409 && e7r.json && e7r.json.code === 'revision-stale',
    JSON.stringify({ first: e7ok.r.status, second: e7r.json }));
  // E8：增强保护缺密码 → 403 step-up-required；带正确登录密码 → 200。
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockp3f-enh-'));
  const enhPath = path.join(tmp3, 'enhanced-auth.json');
  fs.writeFileSync(enhPath, JSON.stringify({ accounts: ['alice'] }), 'utf8');
  const { bridge: b3 } = makeBridge(mcPort, { enhancedAuthPath: enhPath });
  await warmup(b3);
  resetScenario(b3, 'node-1');
  const e8a = await disableFlow(b3, 'node-1');
  const e8b = await disableFlow(b3, 'node-1', { password: 'correct-pw' });
  t('F-E8 增强保护：缺登录密码 → 403 step-up-required；带正确密码 → 200',
    e8a.r.status === 403 && e8a.r.json && e8a.r.json.code === 'step-up-required'
    && e8b.r.status === 200 && e8b.r.json && e8b.r.json.lockState === 'UNLOCKED',
    JSON.stringify({ noPw: e8a.r.json, withPw: e8b.r.status }));
  // E9：UNKNOWN 记录正常路径不直接清状态——无强证据时即使带正确密码也不落 UNLOCKED。
  resetScenario(b1, 'node-1');
  const e9base = recOf(b1, 'node-1');
  const e9unk = S.transition(e9base, 'UNKNOWN', { action: 'probe:unknown', reason: 'p3f-e9' });
  b1._stores.lockRecordStore.upsert(e9unk.record);
  devices['node-1'].revision = e9unk.record.revision;
  devices['node-1'].locked = false; // 设备报 Off，但无 disarm／unlock-ok／boot-recovered 强证据
  devices['node-1'].events = [];
  const e9a = await disableFlow(b1, 'node-1');
  const e9b = await disableFlow(b1, 'node-1', { password: 'correct-pw' });
  const e9rec = recOf(b1, 'node-1');
  t('F-E9 UNKNOWN 正常路径不直接清状态：缺密码 403、有密码仍 409、记录永不落 UNLOCKED',
    e9a.r.status === 403 && e9a.r.json && e9a.r.json.code === 'step-up-required'
    && e9b.r.status === 409 && e9rec && e9rec.actual_state !== 'UNLOCKED',
    JSON.stringify({ noPw: e9a.r.status, withPw: e9b.r.status, rec: e9rec && e9rec.actual_state }));
  devices['node-1'].locked = true;

  console.log('----');
  console.log('test-lock-p3f: PASS ' + pass + ' / FAIL ' + fail);
  try { fakeWss.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.stack || e); try { fakeWss.close(); } catch (_) {} process.exit(2); });
