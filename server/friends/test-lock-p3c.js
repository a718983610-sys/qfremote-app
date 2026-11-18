'use strict';
/*
 * C 线 · 阶段 3 P3-01＋P3-03 验收测试（沙箱实跑，不碰生产服务、不连真机）
 * 依据：GPT 三项定夺全文（2026-11-19 04:25 取回）§1（P3-01 十项验收）
 *       与 §3（P3-03 十二项验收）；任务书 brief-p3c.md。
 *
 * 做法：
 *  A. lock-state.js 纯函数级：暂停常量、挑战全绑定（锁实例／revision／
 *     操作编号／会话）、吊销、风险分级、增强保护文件、AI 授权。
 *  B. lock-bridge.js HTTP 级：本地假 MeshCentral control 通道（ws 服务端，
 *     实现 userinfo／nodes／runcommands 三语义，设备 status.json 用 Base64
 *     回传；disarm 信封投递＋apply 后翻 Off＋补 disarm 事件），全程实跑
 *     enable／update／disable／challenge／agent-grant／repair 真分支。
 * 退出码 0=通过（末尾 process.exit，避开 svc 退避重连定时器）。
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

// ================= A. lock-state 纯函数 =================
const NOW = Date.parse('2026-11-19T04:40:00+08:00');
const DEV = 'node//P3C-test';
function lockedRecord(over) {
  return S.createLockRecord(Object.assign({
    device_id: DEV, boot_id: 'boot-1', session_id: 'sess-1', sid: 'S-1-5-21-100',
    desired_state: 'LOCKED', actual_state: 'LOCKED', now: NOW,
    created_at: Date.parse('2026-11-18T17:11:58.053Z'),
    last_heartbeat: Date.parse('2026-11-18T17:11:58.053Z'),
  }, over || {}));
}

// --- A1 暂停常量 ---
t('A1 暂停常量启用、统一错误码为 lock-remediation-paused',
  S.isLockRemediationPaused() === true && S.LOCK_REMEDIATION_PAUSE.code === 'lock-remediation-paused'
  && S.LOCK_REMEDIATION_PAUSE.scope.indexOf('POST /lock/update') >= 0
  && S.LOCK_REMEDIATION_PAUSE.scope.indexOf('POST /lock/enable') >= 0);
t('A1b 桥侧导出同一暂停码', BT.LOCK_PAUSE_CODE === 'lock-remediation-paused' && BT.isLockRemediationPaused() === true);

// --- A2 挑战全绑定 ---
let _now = NOW;
const ch = S.createChallengeStore({ now: () => _now });
const full = ch.issue({ account: 'Alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3, operationId: 'op-1', sessionKey: 'sess-A' });
t('A2 挑战签发含 challenge 与过期时间', !!full && typeof full.challenge === 'string' && full.expiresAt === NOW + ch.ttlMs);
const okV = ch.verify({ challenge: full.challenge, account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3, operationId: 'op-1', sessionKey: 'sess-A' });
t('A2b 全绑定一致验证通过且回绑定信息', okV.ok === true && okV.binding && okV.binding.lockId === 'lock-1' && okV.binding.revision === 3);
t('A2c 同一挑战重放失败（已消费）', ch.verify({ challenge: full.challenge, account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3, operationId: 'op-1', sessionKey: 'sess-A' }).ok === false);
const b2 = ch.issue({ account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3, operationId: 'op-1', sessionKey: 'sess-A' });
t('A2d 错锁实例拒绝', ch.verify({ challenge: b2.challenge, account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-OTHER', revision: 3, operationId: 'op-1', sessionKey: 'sess-A' }).reason === 'challenge-binding-mismatch');
t('A2e revision 变化单独报 revision-mismatch', ch.verify({ challenge: b2.challenge, account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 4, operationId: 'op-1', sessionKey: 'sess-A' }).reason === 'challenge-revision-mismatch');
t('A2f 错操作编号拒绝', ch.verify({ challenge: b2.challenge, account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3, operationId: 'op-OTHER', sessionKey: 'sess-A' }).reason === 'challenge-binding-mismatch');
t('A2g 换会话拒绝（同一账号、不同会话指纹）', ch.verify({ challenge: b2.challenge, account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3, operationId: 'op-1', sessionKey: 'sess-B' }).reason === 'challenge-binding-mismatch');
t('A2h 绑定失败不消费挑战（原挑战仍可用）', ch.verify({ challenge: b2.challenge, account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3, operationId: 'op-1', sessionKey: 'sess-A' }).ok === true);
const b3 = ch.issue({ account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3 });
_now += 5 * 60 * 1000 + 1;
t('A2i 挑战 5 分钟过期后验证失败', ch.verify({ challenge: b3.challenge, account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3 }).reason === 'challenge-expired');
_now = NOW;
const b4 = ch.issue({ account: 'alice', deviceId: DEV, op: 'disarm' });
t('A2j 未传可选绑定字段的旧调用仍可验证（兼容）', ch.verify({ challenge: b4.challenge, account: 'alice', deviceId: DEV, op: 'disarm' }).ok === true);
const b5 = ch.issue({ account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3 });
t('A2k 吊销账号后未用挑战失效', ch.revokeForAccount('alice') >= 1 && ch.verify({ challenge: b5.challenge, account: 'alice', deviceId: DEV, op: 'disarm', lockId: 'lock-1', revision: 3 }).reason === 'challenge-invalid');
const b6 = ch.issue({ account: 'alice', deviceId: DEV, op: 'disarm', sessionKey: 'sess-A' });
const b7 = ch.issue({ account: 'alice', deviceId: DEV, op: 'disarm', sessionKey: 'sess-B' });
t('A2l 按会话吊销只吊销该会话的挑战', ch.revokeForSession('sess-A') === 1
  && ch.verify({ challenge: b6.challenge, account: 'alice', deviceId: DEV, op: 'disarm', sessionKey: 'sess-A' }).reason === 'challenge-invalid'
  && ch.verify({ challenge: b7.challenge, account: 'alice', deviceId: DEV, op: 'disarm', sessionKey: 'sess-B' }).ok === true);

// --- A3 风险分级 ---
t('A3a 正常所有者：normal、不须升级认证', (() => {
  const r = S.classifyUnlockRisk({ record: lockedRecord() });
  return r.level === 'normal' && r.requiresStepUp === false;
})());
t('A3b 用户开启增强保护：enhanced、须升级认证', (() => {
  const r = S.classifyUnlockRisk({ record: lockedRecord(), enhancedProtection: true });
  return r.level === 'enhanced' && r.requiresStepUp === true && r.reasons.indexOf('enhanced-protection-opt-in') >= 0;
})());
t('A3c 锁记录 UNKNOWN：high、须升级认证', (() => {
  const r = S.classifyUnlockRisk({ record: lockedRecord({ actual_state: 'UNKNOWN' }) });
  return r.level === 'high' && r.requiresStepUp === true && r.reasons.indexOf('record-unknown') >= 0;
})());
t('A3d 锁记录 RECOVERY_REQUIRED：high、须升级认证', (() => {
  const r = S.classifyUnlockRisk({ record: lockedRecord({ actual_state: 'RECOVERY_REQUIRED' }) });
  return r.level === 'high' && r.requiresStepUp === true && r.reasons.indexOf('record-recovery-required') >= 0;
})());
t('A3e 增强保护＋高风险叠加仍为 high（不降级）', (() => {
  const r = S.classifyUnlockRisk({ record: lockedRecord({ actual_state: 'UNKNOWN' }), enhancedProtection: true });
  return r.level === 'high' && r.requiresStepUp === true;
})());
t('A3f 无记录＋设备侧证据：normal（不因无记录升风险）', (() => {
  const r = S.classifyUnlockRisk({ record: null });
  return r.level === 'normal' && r.requiresStepUp === false;
})());

// --- A4 增强保护文件 ---
let _eNow = NOW;
let _eMtime = 1000;
let _eContent = JSON.stringify({ accounts: ['alice'] });
const enh = S.createEnhancedAuthStore({
  filePath: '/tmp/p3c-enhanced.json',
  statFile: () => ({ mtimeMs: _eMtime }), readFile: () => _eContent, now: () => _eNow,
});
t('A4a 文件登记 alice 开启增强保护（大小写不敏感）', enh.isEnhanced('alice') === true && enh.isEnhanced('ALICE') === true);
t('A4b 未登记账号不开启', enh.isEnhanced('mallory') === false);
_eNow += 60000; _eMtime = 2000; _eContent = '{bad json';
t('A4c 文件损坏后保留上次好表、不抛错', enh.isEnhanced('alice') === true);
_eNow += 60000; _eMtime = 3000; _eContent = JSON.stringify({ accounts: [] });
t('A4d 文件更新后新表生效', enh.isEnhanced('alice') === false);
const enhMissing = S.createEnhancedAuthStore({
  filePath: '/tmp/p3c-enhanced-missing.json',
  statFile: () => { throw new Error('ENOENT'); }, readFile: () => { throw new Error('ENOENT'); }, now: () => NOW,
});
t('A4e 文件缺失＝无人开启（默认关闭）', enhMissing.isEnhanced('alice') === false);

// --- A5 AI 授权 ---
let _gNow = NOW;
const grants = S.createAgentGrantStore({ now: () => _gNow });
const g1 = grants.issue({ account: 'alice', deviceId: DEV, op: 'disarm', by: 'alice' });
t('A5a 授权签发含 grantId 与 15 分钟过期', !!g1 && typeof g1.grantId === 'string' && g1.expiresAt === NOW + 15 * 60 * 1000);
t('A5b 授权验证通过（单次）', grants.verify({ grantId: g1.grantId, account: 'alice', deviceId: DEV, op: 'disarm' }).ok === true);
t('A5c 同一授权重放失败（已消费）', grants.verify({ grantId: g1.grantId, account: 'alice', deviceId: DEV, op: 'disarm' }).ok === false);
const g2 = grants.issue({ account: 'alice', deviceId: DEV, op: 'disarm' });
t('A5d 授权绑定他人账号拒绝', grants.verify({ grantId: g2.grantId, account: 'mallory', deviceId: DEV, op: 'disarm' }).reason === 'agent-grant-binding-mismatch');
t('A5e 授权绑定他台设备拒绝', grants.verify({ grantId: g2.grantId, account: 'alice', deviceId: 'node//OTHER', op: 'disarm' }).reason === 'agent-grant-binding-mismatch');
t('A5f 授权绑定失败不消费（原授权仍可用）', grants.verify({ grantId: g2.grantId, account: 'alice', deviceId: DEV, op: 'disarm' }).ok === true);
const g3 = grants.issue({ account: 'alice', deviceId: DEV, op: 'disarm' });
_gNow += 15 * 60 * 1000 + 1;
t('A5g 授权 15 分钟过期后验证失败', grants.verify({ grantId: g3.grantId, account: 'alice', deviceId: DEV, op: 'disarm' }).reason === 'agent-grant-expired');
_gNow = NOW;
const g4 = grants.issue({ account: 'alice', deviceId: DEV, op: 'disarm' });
t('A5h 仅本人可撤销自己的授权', grants.revokeForCaller(g4.grantId, 'mallory') === false && grants.revokeForCaller(g4.grantId, 'alice') === true
  && grants.verify({ grantId: g4.grantId, account: 'alice', deviceId: DEV, op: 'disarm' }).ok === false);
const g5 = grants.issue({ account: 'alice', deviceId: DEV, op: 'disarm' });
const g6 = grants.issue({ account: 'bob', deviceId: DEV, op: 'disarm' });
t('A5i 按账号吊销只吊销该账号的授权', grants.revokeForAccount('alice') === 1
  && grants.verify({ grantId: g5.grantId, account: 'alice', deviceId: DEV, op: 'disarm' }).ok === false
  && grants.verify({ grantId: g6.grantId, account: 'bob', deviceId: DEV, op: 'disarm' }).ok === true);

// ================= B. lock-bridge HTTP 级（假 MeshCentral 通道） =================
// 假设备：node-1（PC-1），机主 alice；状态在 fake 对象里，供断言副作用计数。
const fake = { locked: true, version: '2.4.5', events: [], inboxWrites: 0, applyCalls: 0, pendingDisarm: null };
function fakeStatus() {
  return {
    state: fake.locked ? 'Locked' : 'Off',
    version: fake.version,
    ownerUsername: 'alice',
    updatedAt: new Date().toISOString(),
    lastEvents: fake.events.slice(),
  };
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
      if (m.action === 'nodes') {
        ws.send(JSON.stringify({ responseid: rid, action: 'nodes', nodes: [{ _id: 'node-1', name: 'PC-1' }] }));
        return;
      }
      if (m.action === 'runcommands') {
        const cmd = String(m.cmds || '');
        let result = '';
        if (cmd.includes('status.json')) {
          result = Buffer.from(JSON.stringify(fakeStatus()), 'utf8').toString('base64');
        } else if (cmd.includes('WriteAllBytes')) {
          fake.inboxWrites++;
          const mm = cmd.match(/FromBase64String\('([^']+)'\)/);
          if (mm) {
            try {
              const env = JSON.parse(Buffer.from(mm[1], 'base64').toString('utf8'));
              if (env.op === 'disarm') fake.pendingDisarm = env.id;
            } catch (e) { /* 非信封写入不处理 */ }
          }
          result = '';
        } else if (cmd.includes('qf-lockctl.exe')) {
          fake.applyCalls++;
          if (fake.pendingDisarm) {
            fake.locked = false;
            fake.events.push({ ts: new Date().toISOString(), ev: 'disarm', fields: {} });
            fake.pendingDisarm = null;
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

// 临时桥配置：Ed25519 调度密钥＋假 MC 地址。
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
let siteAdminUser = null; // 设为账号名时该账号为站长（isSiteAdmin）
const COOKIE_A = 'qfr_frd=SESS-ALICE-A; xid=X-A';
const COOKIE_B = 'qfr_frd=SESS-ALICE-B; xid=X-B'; // 同一账号、另一会话（模拟会话被盗用／另一会话）
const COOKIE_MALLORY = 'qfr_frd=SESS-MALLORY; xid=X-M';
function makeBridge(mcPort, opts) {
  const o = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockp3c-'));
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
    lockRecordsPath: path.join(tmp, 'lock-records.json'),
    enhancedAuthPath: o.enhancedAuthPath || path.join(tmp, 'enhanced-auth-missing.json'),
    isBanLinked: () => false,
    isSiteAdmin: (u) => !!siteAdminUser && u === siteAdminUser,
  });
  return { bridge, tmp, logs };
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
// 每次 disable 场景前复位：假设备重新上锁＋服务端记一条新的 LOCKED 记录
// （lock_id／revision 与挑战绑定一致；不用旧记录，避免 UNLOCKED→LOCKED
// 的非法迁移把记录翻成 RECOVERY_REQUIRED——那是另一场景的专用状态）。
let scenSeq = 0;
function resetScenario(b, fakeLocked) {
  fake.locked = fakeLocked !== false;
  fake.events = [];
  fake.inboxWrites = 0;
  fake.applyCalls = 0;
  fake.pendingDisarm = null;
  scenSeq++;
  const rec = S.createLockRecord({
    device_id: 'node-1', lock_id: 'lock-p3c-' + scenSeq,
    desired_state: 'LOCKED', actual_state: 'LOCKED', now: Date.now(),
  });
  b._stores.lockRecordStore.upsert(rec);
  return rec;
}
async function warmup(b) {
  for (let i = 0; i < 8; i++) {
    const r = await call(b, 'GET', '/lock/devices', undefined, COOKIE_A);
    if (r.status === 200 && r.json && Array.isArray(r.json.devices) && r.json.devices.length === 1) return r;
    await sleep(300);
  }
  return null;
}
// 标准关锁流程：读设备取 revision → 取挑战（带操作编号）→ 提交 disable。
async function disableFlow(b, opts) {
  const o = opts || {};
  const cookie = o.cookie || COOKIE_A;
  // force=1：每次取新鲜设备状态（跳过 15 秒机主状态缓存与 1 秒同账号合并窗口）。
  // 假设备在场景间反复上锁／解锁，缓存的旧 Off 快照会在对账时误翻记录；
  // 真实前端同款行为是点“重新加载”走 force=1（见 lock-bridge.js X-14）。
  const devs = await call(b, 'GET', '/lock/devices?force=1', undefined, cookie);
  const rev = devs.json && devs.json.devices && devs.json.devices[0] ? devs.json.devices[0].revision : 0;
  const opId = o.opId || ('op-flow-' + (++scenSeq));
  const ch = await call(b, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=' + encodeURIComponent(opId), undefined, cookie);
  const body = { id: 'node-1', challenge: ch.json && ch.json.challenge, operationId: opId, revision: o.revision != null ? o.revision : rev };
  if (o.password) body.loginPassword = o.password;
  if (o.grantId) body.agentGrantId = o.grantId;
  if (o.challengeOverride !== undefined) body.challenge = o.challengeOverride;
  if (o.opIdOverride !== undefined) body.operationId = o.opIdOverride;
  if (o.cookieOverride !== undefined) { /* 提交用另一会话 cookie */ }
  const submitCookie = o.submitCookie || cookie;
  const r = await call(b, 'POST', '/lock/disable', body, submitCookie);
  return { devs, ch, r, rev, opId };
}

(async () => {
  const mcPort = await startFakeMc();
  const { bridge: b1, tmp: tmp1, logs: logs1 } = makeBridge(mcPort);
  currentUser = 'alice';
  const warm = await warmup(b1);
  t('B0 假通道就绪：GET /lock/devices → 200 一台机主设备', !!warm && warm.json.devices[0].id === 'node-1' && warm.json.devices[0].lockState === 'LOCKED');

  // ---------- P3-01 十项（裁决 §1.4） ----------
  // (1) 普通用户 enable 503 且 0 锁定副作用
  resetScenario(b1);
  let r = await call(b1, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, COOKIE_A);
  t('P01-1 普通用户 enable → 503 维护文案、0 副作用', r.status === 503 && r.json && r.json.error === '隐私锁功能正在维护，暂时无法开启新的锁定。已锁定的设备仍可正常关闭。'
    && fake.inboxWrites === 0 && fake.applyCalls === 0 && fake.locked === true);
  // (2) 站长账号 enable 暂停期仍拒绝
  siteAdminUser = '718983610'; currentUser = '718983610';
  r = await call(b1, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, 'qfr_frd=SESS-ADMIN; xid=X-ADM');
  t('P01-2 站长账号 enable 暂停期仍拒绝（无白名单例外）', r.status === 503 && fake.inboxWrites === 0 && fake.applyCalls === 0);
  currentUser = 'alice'; siteAdminUser = null;
  // (3) 普通用户 update 503 且 0 更新副作用（含空体——守卫在一切处理之前）
  resetScenario(b1);
  const updBody = { id: 'node-1', update: { version: '9.9.9', url: 'https://example.com/x.zip', sha256: 'a'.repeat(64) } };
  r = await call(b1, 'POST', '/lock/update', updBody, COOKIE_A);
  t('P01-3 普通用户 update → 503 统一码 lock-remediation-paused、0 更新副作用',
    r.status === 503 && r.json && r.json.code === 'lock-remediation-paused' && fake.inboxWrites === 0 && fake.applyCalls === 0 && fake.version === '2.4.5');
  r = await call(b1, 'POST', '/lock/update', {}, COOKIE_A);
  t('P01-3b 空体 update 同样 503（守卫先于参数校验）', r.status === 503 && r.json && r.json.code === 'lock-remediation-paused');
  // (4) 站长账号 update 暂停期仍拒绝
  siteAdminUser = '718983610'; currentUser = '718983610';
  r = await call(b1, 'POST', '/lock/update', updBody, 'qfr_frd=SESS-ADMIN; xid=X-ADM');
  t('P01-4 站长账号 update 暂停期仍拒绝（无白名单例外）', r.status === 503 && r.json && r.json.code === 'lock-remediation-paused' && fake.inboxWrites === 0);
  currentUser = 'alice'; siteAdminUser = null;
  // (5) 后台更新任务不得绕过暂停：同一 update 重试两次＋静置 1.5 秒，仍 0 副作用
  r = await call(b1, 'POST', '/lock/update', updBody, COOKIE_A);
  r = await call(b1, 'POST', '/lock/update', updBody, COOKIE_A);
  await sleep(1500);
  t('P01-5 重试 update 两次＋静置 1.5 秒仍 0 副作用（无后台任务偷跑）',
    r.status === 503 && fake.inboxWrites === 0 && fake.applyCalls === 0 && fake.version === '2.4.5');
  // (6) 旧请求／重试任务不能在暂停状态重新启动危险操作：同上重试＋enable 重试
  r = await call(b1, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, COOKIE_A);
  t('P01-6 旧请求重试 enable 仍 503、0 副作用', r.status === 503 && fake.inboxWrites === 0 && fake.applyCalls === 0);
  // (7) 未授权请求不能因暂停机制泄露敏感信息或获得权限：先鉴权后暂停
  currentUser = null;
  r = await call(b1, 'POST', '/lock/update', updBody, '');
  const r7b = await call(b1, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, '');
  currentUser = 'alice';
  t('P01-7 未登录 update/enable → 401（不泄露设备存在与否、不给 503 暂停信息）',
    r.status === 401 && r7b.status === 401 && !(r.json && r.json.code === 'lock-remediation-paused'));
  // (8) 只读诊断正常可用
  r = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  t('P01-8 只读诊断 GET /lock/devices 正常可用（200）', r.status === 200 && r.json && Array.isArray(r.json.devices) && r.json.devices.length === 1);
  // (9) 经授权的安全恢复操作可用：disable／reset 走正常校验、不被暂停拦截
  r = await call(b1, 'POST', '/lock/disable', { id: 'node-1', operationId: 'op-p019' }, COOKIE_A);
  t('P01-9a 安全恢复路径未被冻结：disable 缺挑战 → 409（不是 503）', r.status === 409 && r.json && r.json.code === 'challenge-required');
  r = await call(b1, 'POST', '/lock/reset', { id: 'node-1' }, COOKIE_A);
  t('P01-9b 安全恢复路径未被冻结：reset 缺密码 → 400（不是 503）', r.status === 400);
  r = await call(b1, 'POST', '/lock/repair', { id: 'node-1' }, COOKIE_A);
  t('P01-9c 受控修复占位：POST /lock/repair → 503 lock-repair-not-available、0 副作用',
    r.status === 503 && r.json && r.json.code === 'lock-repair-not-available' && fake.inboxWrites === 0 && fake.applyCalls === 0);
  // (10) 服务重启后暂停策略仍有效：全新桥实例（新内存表）同样拒绝
  const { bridge: bRestart, tmp: tmpR } = makeBridge(mcPort);
  currentUser = 'alice';
  const warm2 = await warmup(bRestart);
  r = await call(bRestart, 'POST', '/lock/update', updBody, COOKIE_A);
  const r10b = await call(bRestart, 'POST', '/lock/enable', { id: 'node-1', password: 'abcd1234' }, COOKIE_A);
  t('P01-10 重启后（新桥实例）update/enable 仍 503（暂停写死在代码里）',
    !!warm2 && r.status === 503 && r.json && r.json.code === 'lock-remediation-paused' && r10b.status === 503);
  // 暂停审计与守卫原文
  const bridgeSrc = fs.readFileSync(path.join(__dirname, 'lock-bridge.js'), 'utf8');
  t('P01-audit 暂停拒绝记结构化审计（含 op／account／统一码，不含秘密）',
    logs1.some((l) => l.includes('lock-remediation-paused op=/lock/update account=alice code=lock-remediation-paused'))
    && logs1.some((l) => l.includes('lock-remediation-paused op=/lock/enable account=alice code=lock-remediation-paused'))
    && !logs1.some((l) => l.includes('abcd1234')));
  t('P01-guard 阶段 1 四行 enable 守卫原样保留（逐字一致）',
    bridgeSrc.includes("// LOCK-P0 pause (2026-11-19, GPT lock-bug ruling s1.1): new privacy-lock activations paused for maintenance.\n      // Only /lock/enable is stopped; /lock/disable, /lock/reset, /lock/devices and normal remote control are unaffected.\n      // Rollback: delete this block, then restart qfremote-friends.service.\n      if (req.method === 'POST' && p === '/lock/enable') { fail(res, 503, '隐私锁功能正在维护，暂时无法开启新的锁定。已锁定的设备仍可正常关闭。'); return true; }"));
  t('P01-guard2 deliverEnvelope 第二道拦截在位（arm/update 信封到不了设备）',
    bridgeSrc.includes("if (env && (env.op === 'arm' || env.op === 'update') && lockState.isLockRemediationPaused())"));

  // ---------- P3-03 十二项（裁决 §3.4） ----------
  // (1) 正常所有者、有效可信会话：不输密码完成授权解锁
  resetScenario(b1);
  let f = await disableFlow(b1, {});
  t('P03-1 正常所有者有效会话：不输密码完成授权解锁（200 UNLOCKED，恰一次真实操作）',
    f.r.status === 200 && f.r.json && f.r.json.ok === true && f.r.json.lockState === 'UNLOCKED'
    && fake.locked === false && fake.applyCalls === 1);
  // (2) 未登录拒绝
  currentUser = null;
  f = await disableFlow(b1, { cookie: '' });
  currentUser = 'alice';
  t('P03-2 未登录解锁 → 401', f.r.status === 401 || (f.ch.status === 401));
  // (3) 非机主无授权拒绝
  currentUser = 'mallory';
  r = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm', undefined, COOKIE_MALLORY);
  const r3b = await call(b1, 'POST', '/lock/disable', { id: 'node-1', challenge: 'ch-fake', operationId: 'op-p033', revision: 1 }, COOKIE_MALLORY);
  currentUser = 'alice';
  t('P03-3 非机主无授权：取挑战 403、提交伪造挑战 409', r.status === 403 && r3b.status === 409 && r3b.json && r3b.json.code === 'challenge-invalid');
  // (4) 挑战过期或重复使用拒绝（重复使用：P03-1 已消费的挑战重放）
  resetScenario(b1);
  f = await disableFlow(b1, {});
  const replayOp = 'op-replay-' + (++scenSeq);
  const r4 = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: f.ch.json.challenge, operationId: replayOp, revision: f.rev }, COOKIE_A);
  t('P03-4 已消费挑战重放 → 409 challenge-invalid（过期见 A2i 单元）',
    f.r.status === 200 && r4.status === 409 && r4.json && r4.json.code === 'challenge-invalid',
    { fStatus: f.r.status, fJson: f.r.json, r4Status: r4.status, r4Json: r4.json });
  // (5) 挑战绑定其他设备拒绝
  resetScenario(b1);
  f = await disableFlow(b1, {});
  // 上面已成功解锁；另取 node-1 挑战、改投 node-2（verify 在设备读取前即拦）
  const ch5 = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-p035', undefined, COOKIE_A);
  const r5 = await call(b1, 'POST', '/lock/disable',
    { id: 'node-2', challenge: ch5.json.challenge, operationId: 'op-p035', revision: 1 }, COOKIE_A);
  t('P03-5 挑战绑定其他设备 → 409 challenge-binding-mismatch', r5.status === 409 && r5.json && r5.json.code === 'challenge-binding-mismatch');
  // (6) revision 已变化：旧请求不执行、要求重新获取状态
  resetScenario(b1);
  const devs6 = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const rev6 = devs6.json.devices[0].revision;
  const ch6 = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-p036', undefined, COOKIE_A);
  const rec6 = b1._stores.lockRecordStore.get('node-1');
  b1._stores.lockRecordStore.upsert(Object.assign({}, rec6, { revision: rev6 + 1 })); // 模拟期间状态变化
  const r6 = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: ch6.json.challenge, operationId: 'op-p036', revision: rev6 + 1 }, COOKIE_A);
  t('P03-6 revision 已变化：旧挑战不执行 → 409 revision-stale、设备仍锁定',
    r6.status === 409 && r6.json && r6.json.code === 'revision-stale' && fake.locked === true);
  // (7) 用户开启增强保护：必须完成配置的升级认证（另建增强桥）
  const enhPath = path.join(tmp1, 'enhanced-auth.json');
  fs.writeFileSync(enhPath, JSON.stringify({ accounts: ['alice'] }), 'utf8');
  const { bridge: bEnh, tmp: tmpE } = makeBridge(mcPort, { enhancedAuthPath: enhPath });
  await warmup(bEnh);
  resetScenario(bEnh);
  let f7 = await disableFlow(bEnh, {});
  t('P03-7a 增强保护用户未输密码 → 403 step-up-required、设备仍锁定',
    f7.r.status === 403 && f7.r.json && f7.r.json.code === 'step-up-required' && fake.locked === true);
  const f7b = await disableFlow(bEnh, { password: 'wrong-pw' });
  t('P03-7b 增强保护用户密码错误 → 403 badLoginPw、不降级', f7b.r.status === 403 && f7b.r.json && f7b.r.json.error === '登录密码不正确，请检查后重试。');
  const f7c = await disableFlow(bEnh, { password: 'correct-pw' });
  t('P03-7c 增强保护用户密码正确 → 200 解锁', f7c.r.status === 200 && f7c.r.json && f7c.r.json.lockState === 'UNLOCKED' && fake.locked === false);
  // (8) 会话撤销后重放挑战拒绝
  resetScenario(b1);
  const devs8 = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const rev8 = devs8.json.devices[0].revision;
  const ch8 = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-p038', undefined, COOKIE_A);
  b1.purgeUser('alice'); // 模拟退出登录／会话撤销（封禁联动同款入口）
  const r8 = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: ch8.json.challenge, operationId: 'op-p038', revision: rev8 }, COOKIE_A);
  t('P03-8 会话撤销（purgeUser）后重放挑战 → 409 challenge-invalid', r8.status === 409 && r8.json && r8.json.code === 'challenge-invalid');
  // (9) 高风险操作无法完成升级认证不得降级为普通确认（见 P03-7a/7b 与下项）
  // (10) UNKNOWN 锁状态不能通过正常解锁路径直接清状态
  resetScenario(b1);
  const devs10 = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const rev10 = devs10.json.devices[0].revision;
  const ch10 = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-p0310', undefined, COOKIE_A);
  const rec10 = b1._stores.lockRecordStore.get('node-1');
  b1._stores.lockRecordStore.upsert(Object.assign({}, rec10, { actual_state: 'UNKNOWN' })); // 锁实例／版本不变，只翻状态
  const r10 = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: ch10.json.challenge, operationId: 'op-p0310', revision: rev10 }, COOKIE_A);
  const rec10after = b1._stores.lockRecordStore.get('node-1');
  t('P03-10a UNKNOWN 记录正常路径解锁 → 403 step-up-required、不清状态、设备仍锁定',
    r10.status === 403 && r10.json && r10.json.code === 'step-up-required'
    && rec10after && rec10after.actual_state === 'UNKNOWN' && fake.locked === true);
  const ch10b = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-p0310b', undefined, COOKIE_A);
  // 注意：取挑战时的读路径对账会把 UNKNOWN 记录翻回 LOCKED（设备报 Locked），
  // 故在提交前按 10a 同款手法把记录重翻回 UNKNOWN（锁实例／版本保持与挑战绑定一致），
  // 这样提交时风险门看到的仍是 UNKNOWN。
  const rec10b = b1._stores.lockRecordStore.get('node-1');
  b1._stores.lockRecordStore.upsert(Object.assign({}, rec10b, { actual_state: 'UNKNOWN' }));
  const r10c = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: ch10b.json.challenge, operationId: 'op-p0310b', revision: rec10b.revision, loginPassword: 'correct-pw' }, COOKIE_A);
  t('P03-10b UNKNOWN 记录＋升级认证通过＋设备强证据 → 200 解锁（非“输密码即清状态”）',
    r10c.status === 200 && r10c.json && r10c.json.lockState === 'UNLOCKED' && fake.locked === false);
  t('P03-9 高风险无法完成升级认证不得降级（P03-7a/7b/10a 均已证：无密码／错密码皆拒绝）',
    f7.r.status === 403 && f7b.r.status === 403 && r10.status === 403);
  // (11) 连续快速点击确认：实际操作最多执行一次、结果可查询
  resetScenario(b1);
  const devs11 = await call(b1, 'GET', '/lock/devices?force=1', undefined, COOKIE_A);
  const rev11 = devs11.json.devices[0].revision;
  const op11 = 'op-race-' + (++scenSeq);
  const ch11 = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=' + op11, undefined, COOKIE_A);
  const body11 = { id: 'node-1', challenge: ch11.json.challenge, operationId: op11, revision: rev11 };
  const applyBefore = fake.applyCalls;
  const [race1, race2] = await Promise.all([
    call(b1, 'POST', '/lock/disable', body11, COOKIE_A),
    call(b1, 'POST', '/lock/disable', body11, COOKIE_A),
  ]);
  const okCount = [race1, race2].filter((x) => x.status === 200).length;
  const disarmEvents = fake.events.filter((e) => e.ev === 'disarm').length;
  const replay11 = await call(b1, 'POST', '/lock/disable', body11, COOKIE_A);
  t('P03-11 并发双击：恰一次 200、恰一次真实操作、事后同编号可查询首次结果',
    okCount === 1 && (fake.applyCalls - applyBefore) === 1 && disarmEvents === 1
    && replay11.status === 200 && replay11.json && replay11.json.replayed === true,
    { race1, race2, applyDelta: fake.applyCalls - applyBefore, disarmEvents, replay11 });
  // (12) AI 代理无明确授权不允许借用用户界面权限直接解锁
  resetScenario(b1);
  const ch12 = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-p0312', undefined, COOKIE_A);
  const r12 = await call(b1, 'POST', '/lock/disable',
    { id: 'node-1', challenge: ch12.json.challenge, operationId: 'op-p0312', revision: 1 }, COOKIE_B);
  t('P03-12a AI 会话借用 UI 会话挑战 → 409（挑战绑定会话，换会话即失效）',
    r12.status === 409 && r12.json && r12.json.code === 'challenge-binding-mismatch' && fake.locked === true);
  // 明确授权路径：机主签发 AI 授权，AI 会话持自己的挑战＋授权解锁
  const g12 = await call(b1, 'POST', '/lock/agent-grant', { id: 'node-1' }, COOKIE_A);
  t('P03-12b 机主可签发 AI 解锁授权（单设备、仅 disarm、15 分钟）',
    g12.status === 200 && g12.json && typeof g12.json.grantId === 'string' && g12.json.deviceId === 'node-1' && g12.json.op === 'disarm');
  const f12 = await disableFlow(b1, { cookie: COOKIE_B, grantId: g12.json.grantId });
  t('P03-12c AI 会话持授权＋自己的挑战 → 200 解锁（授权可审计、单次）',
    f12.r.status === 200 && f12.r.json && f12.r.json.lockState === 'UNLOCKED' && fake.locked === false,
    { f12Status: f12.r.status, f12Json: f12.r.json, fakeLocked: fake.locked, f12ch: f12.ch.json });
  const g12b = await call(b1, 'POST', '/lock/agent-grant', { id: 'node-1' }, COOKIE_A);
  const revoke12 = await call(b1, 'POST', '/lock/agent-grant/revoke', { grantId: g12b.json.grantId }, COOKIE_A);
  const f12b = await disableFlow(b1, { cookie: COOKIE_B, grantId: g12b.json.grantId });
  t('P03-12d 已撤销授权再用 → 409 agent-grant-invalid',
    revoke12.status === 200 && revoke12.json && revoke12.json.revoked === true
    && f12b.r.status === 409 && f12b.r.json && String(f12b.r.json.code || '').indexOf('agent-grant') === 0);
  currentUser = 'mallory';
  const r12e2 = await call(b1, 'POST', '/lock/agent-grant', { id: 'node-1' }, COOKIE_MALLORY);
  currentUser = 'alice';
  t('P03-12e 非机主签发授权 → 403（签发只认设备所有者）', r12e2.status === 403);
  // 挑战响应回锁实例与版本（前端快照一致性）
  resetScenario(b1);
  const chX = await call(b1, 'GET', '/lock/challenge?id=node-1&op=disarm&opId=op-x1', undefined, COOKIE_A);
  const recX = b1._stores.lockRecordStore.get('node-1');
  t('P03-x 挑战响应回 lockId/revision，与服务端记录一致',
    chX.status === 200 && chX.json && chX.json.lockId === recX.lock_id && chX.json.revision === recX.revision);

  if (fakeWss) fakeWss.close();
  fs.rmSync(tmp1, { recursive: true, force: true });
  fs.rmSync(tmpR, { recursive: true, force: true });
  fs.rmSync(tmpE, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(' harness error:', e); if (fakeWss) { try { fakeWss.close(); } catch (err) {} } process.exit(1); });
