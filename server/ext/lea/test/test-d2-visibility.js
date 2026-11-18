'use strict';
/*
 * D2 可见性专项断言（2026-11-18）
 * 验合并树内 D1+D2 移植后的文件。
 * 覆盖：① rebind 强制可见性矩阵（200/403/404/503、裸 id 归一、dep 透
 * 传 (auth, req)）；② deviceVisibleTo 双账户（读路径跨账户泄露已堵，
 * 含旧 Key 兼容分支）；③ login-attestation 双账户；④ 审计 reason 区分
 * （not-visible vs visibility-unavailable）。
 * 运行：node test-d2-visibility.js（在本目录）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createLeaCore } = require('../lea-core');
const { createLeaRoutes } = require('../lea-routes');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; failures.push(name); console.log('FAIL-', name, extra ? String(extra).slice(0, 300) : ''); }
}

// C 测试向量密钥（与 D1 专项同款，仅测试用）
const seed = Buffer.from([...Array(32).keys()]);
const privDer = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const privKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
const pubBytes = crypto.createPublicKey(privKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-vis-'));
const keyFile = path.join(tmpDir, 'test-signing-key.b64');
fs.writeFileSync(keyFile, Buffer.concat([seed, pubBytes]).toString('base64'));
const core = createLeaCore({ dir: tmpDir, enableSweeps: false, signingKeyFile: keyFile });

const ALICE = 'alice', BOB = 'bob', ADMIN = '718983610';
const DEV1 = 'node//d2-device-1', DEV2 = 'node//d2-device-2', GHOST = 'node//d2-ghost';
const mockChannel = {
  async listNodes() { return [{ _id: DEV1, conn: 1 }, { _id: DEV2, conn: 1 }]; },
  async nodeOnline() { return true; },
};
core.recordBinding(DEV1, ALICE, 'd2-setup');
core.recordBinding(DEV2, BOB, 'd2-setup');
core.grantMuse(ALICE, 'owner');
core.grantMuse(BOB, 'owner');
const aliceKeyDev1 = core.generateKey(ALICE, { device_scope: DEV1 });
const bobKeyDev2 = core.generateKey(BOB, { device_scope: DEV2 });
// D2-K1：跨归属／未绑定 scope 的 Key 生成时已被拒绝——读路径的跨账户
// fixture 改为先合法生成再直接改写台账 scope（与 B7 同款手法），保留
// “旧读路径会泄露”的回归断言目标。
const bobKeyDev1 = core.generateKey(BOB, { device_scope: DEV2 });
const aliceKeyDev2 = core.generateKey(ALICE, { device_scope: DEV1 });
const aliceKeyDev3 = core.generateKey(ALICE, { device_scope: DEV1 });
{
  const keysPath = path.join(tmpDir, 'keys.json');
  const st = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  const setScope = (keyId, scope) => { const rec = st.keys.find((k) => k && k.key_id === keyId); rec.device_scope = scope; };
  setScope(bobKeyDev1.record.key_id, DEV1);
  setScope(aliceKeyDev2.record.key_id, DEV2);
  setScope(aliceKeyDev3.record.key_id, 'node//d2-device-3');
  fs.writeFileSync(keysPath, JSON.stringify(st));
}

const sent = [];
function bearerHeaders(plain, extra) {
  return Object.assign({ authorization: 'Bearer ' + plain,
    'x-qfr-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-qfr-nonce': 'n-' + crypto.randomBytes(6).toString('hex') }, extra || {});
}
// visFn 为 undefined 时不注入 listVisibleDeviceIds（测 503 缺依赖分支）。
function mkRoutes(sessionUser, visFn, channel) {
  const deps = {
    sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
    readJsonBody: async (req) => req._body || {},
    log: () => {},
    verifyPassword: async () => true,
    resolveConsoleAuth: async () => (sessionUser ? { user: sessionUser, siteadmin: sessionUser === ADMIN ? 1 : 0 } : null),
    isSiteAdmin: (a) => a.user === ADMIN,
  };
  if (visFn !== undefined) deps.listVisibleDeviceIds = visFn;
  return createLeaRoutes(core, channel || mockChannel, deps);
}
async function callRoute(rts, method, url, headers, body) {
  sent.length = 0;
  const req = { method, url, headers: headers || {}, _body: body || {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = {};
  const matched = await rts.handle(req, res);
  return { matched, code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
}
function auditText() {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith('audit-'))
    .map((f) => fs.readFileSync(path.join(tmpDir, f), 'utf8')).join('\n');
}
// 记录 dep 收到的入参，验 handler 是否把 (auth, req) 透传。
const visCalls = [];
function visRecorder(list) {
  return async (a, req) => {
    visCalls.push({ user: a && a.user, hasReq: !!req, cookie: req && req.headers ? (req.headers.cookie || null) : null });
    return list;
  };
}
const COOKIE = 'xid=d2-test-cookie';

(async () => {
  // ---------- A) rebind 强制可见性矩阵 ----------
  // A1：清单内＋绑自己 → 200
  let r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1])), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A1 rebind 清单内＋绑自己 → 200', r.code === 200 && r.obj.account_id === ALICE);
  // A2：清单内＋绑他人（非站长）→ 403，且文案为归属拒绝（③，非 ①）
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1, DEV2])), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV2) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A2 rebind 清单内＋绑他人 → 403 归属拒绝', r.code === 403 && /已绑定其他账号/.test(r.obj.msg || ''));
  // A3：清单外 → 403 可见性拒绝（①），文案与 A2 不同
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1])), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV2) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A3 rebind 清单外 → 403 可见性拒绝', r.code === 403 && /不在该账号可见范围内/.test(r.obj.msg || ''));
  // A4：未注入依赖 → 503（D2 强制，D1 时为 200）
  r = await callRoute(mkRoutes(ALICE, undefined), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A4 rebind 未注入可见性依赖 → 503 QFR_VISIBILITY_UNAVAILABLE', r.code === 503 && r.obj.code === 'QFR_VISIBILITY_UNAVAILABLE');
  // A5：查询抛错 → 503
  r = await callRoute(mkRoutes(ALICE, async () => { throw new Error('vis-down'); }), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A5 rebind 可见性查询抛错 → 503', r.code === 503 && r.obj.code === 'QFR_VISIBILITY_UNAVAILABLE');
  // A6：返回非数组 → 503
  r = await callRoute(mkRoutes(ALICE, async () => 'not-a-list'), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A6 rebind 可见性查询返回非数组 → 503', r.code === 503 && r.obj.code === 'QFR_VISIBILITY_UNAVAILABLE');
  // A7：清单为空（确认不可见）→ 403（与 503 区分）
  r = await callRoute(mkRoutes(ALICE, async () => []), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A7 rebind 可见性清单为空 → 403（确认不可见，非 503）', r.code === 403 && r.obj.code === 'FORBIDDEN');
  // A8：清单内＋通道无此节点 → 404
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1, GHOST])), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(GHOST) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A8 rebind 清单内＋未知设备 → 404', r.code === 404 && r.obj.code === 'NOT_FOUND');
  // A9/A10：裸 id 归一（入参裸形／清单裸形均 200）
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1])), 'POST', '/api/lea/v1/devices/' + encodeURIComponent('d2-device-1') + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A9 rebind 裸 id 入参 → 200', r.code === 200 && r.obj.device_id === 'd2-device-1');
  r = await callRoute(mkRoutes(ALICE, visRecorder(['d2-device-1'])), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A10 rebind 清单裸 id＋入参全形 → 200', r.code === 200);
  // A11：body account_id 与会话不一致（非站长）→ 403，且先于 ①（即使未注入依赖也 403）
  r = await callRoute(mkRoutes(ALICE, undefined), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: BOB });
  t('A11 rebind 非站长代绑他人账号 → 403（先于可见性校验）', r.code === 403 && /只能绑定自己的账号/.test(r.obj.msg || ''));
  // A12：dep 收到 (auth, req)——auth.user 为会话账号，req.headers.cookie 为原样透传
  visCalls.length = 0;
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1])), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A12 rebind 时 dep 收到会话账号 auth.user=alice', r.code === 200 && visCalls.length === 1 && visCalls[0].user === ALICE);
  t('A12 rebind 时 dep 收到 req 且 cookie 原样透传', visCalls.length === 1 && visCalls[0].hasReq === true && visCalls[0].cookie === COOKIE);
  // A13：审计 reason 区分——403 记 not-visible，503 记 visibility-unavailable
  let a0 = auditText();
  await callRoute(mkRoutes(ALICE, async () => []), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A13 审计：可见性 403 记 lea-rebind-denied/not-visible', auditText().slice(a0.length).includes('lea-rebind-denied') && auditText().slice(a0.length).includes('not-visible'));
  a0 = auditText();
  await callRoute(mkRoutes(ALICE, undefined), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A13 审计：可见性 503 记 lea-rebind-denied/visibility-unavailable', auditText().slice(a0.length).includes('lea-rebind-denied') && auditText().slice(a0.length).includes('visibility-unavailable'));

  // A14（D2 修订，GPT 六项裁决 D1-2）：rebind 通道不可达 → 503，不换绑。
  // ① 可见性清单已确认设备在清单内，但 ② 存在性校验因通道不可达无法
  // 完成时，不得跳过存在性校验继续换绑——“记审计”不能替代验证。
  const downChannel = { async listNodes() { throw new Error('svc-down'); }, async nodeOnline() { return true; } };
  a0 = auditText();
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1]), downChannel), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('A14 rebind 通道不可达 → 503 QFR_VISIBILITY_UNAVAILABLE（不换绑）', r.code === 503 && r.obj.code === 'QFR_VISIBILITY_UNAVAILABLE');
  t('A14 审计：rebind 503 记 lea-rebind-denied/existence-unverifiable-channel-down', auditText().slice(a0.length).includes('lea-rebind-denied') && auditText().slice(a0.length).includes('existence-unverifiable-channel-down'));

  // ---------- B) deviceVisibleTo 双账户（读路径） ----------
  // B1：归属账号＋自有 scope → 200
  r = await callRoute(mkRoutes(ALICE, async () => [DEV1]), 'GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/status', bearerHeaders(aliceKeyDev1.key), {});
  t('B1 归属账号 Key（scope=DEV1）读本设备状态 → 200', r.code === 200 && r.obj.account_id === ALICE && r.obj.bound === true);
  // B2：★ 跨账户泄露主案——bob 的 Key scope=DEV1（DEV1 绑 alice）读状态 → 403（旧逻辑 scope 匹配即放行 → 200）
  r = await callRoute(mkRoutes(ALICE, async () => [DEV1]), 'GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/status', bearerHeaders(bobKeyDev1.key), {});
  t('B2 他人 Key（scope=DEV1，DEV1 绑 alice）读状态 → 403', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  // B3：同一 Key 读吊销快照 → 403
  r = await callRoute(mkRoutes(ALICE, async () => [DEV1]), 'GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/revocations', bearerHeaders(bobKeyDev1.key), {});
  t('B3 他人 Key（scope=DEV1）读吊销快照 → 403', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  // B4：反向——alice 的 Key scope=DEV2（DEV2 绑 bob）读 DEV2 → 403
  r = await callRoute(mkRoutes(ALICE, async () => [DEV2]), 'GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV2) + '/status', bearerHeaders(aliceKeyDev2.key), {});
  t('B4 他人 Key（scope=DEV2，DEV2 绑 bob）读状态 → 403', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  // B5：bob 读自己设备 → 200
  r = await callRoute(mkRoutes(ALICE, async () => [DEV2]), 'GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV2) + '/status', bearerHeaders(bobKeyDev2.key), {});
  t('B5 归属账号 Key（scope=DEV2）读本设备状态 → 200', r.code === 200 && r.obj.account_id === BOB);
  // B6：scope 指向未绑定设备 → 403（未绑定一律 403）
  r = await callRoute(mkRoutes(ALICE, async () => ['node//d2-device-3']), 'GET', '/api/lea/v1/devices/' + encodeURIComponent('node//d2-device-3') + '/status', bearerHeaders(aliceKeyDev3.key), {});
  t('B6 scope 指向未绑定设备 → 403', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  // B7：旧 Key 兼容——device_scope 为空（DC-A-1 前旧 Key）＋归属匹配 → 200
  {
    const keysPath = path.join(tmpDir, 'keys.json');
    const st = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
    const rec = st.keys.find((k) => k.key_id === aliceKeyDev1.record.key_id);
    const savedScope = rec.device_scope;
    rec.device_scope = null;
    fs.writeFileSync(keysPath, JSON.stringify(st));
    r = await callRoute(mkRoutes(ALICE, async () => [DEV1]), 'GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV1) + '/status', bearerHeaders(aliceKeyDev1.key), {});
    t('B7 无 scope 旧 Key＋归属匹配 → 200（兼容分支）', r.code === 200 && r.obj.account_id === ALICE);
    // 同一旧 Key 读他人设备 → 403
    r = await callRoute(mkRoutes(ALICE, async () => [DEV2]), 'GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV2) + '/status', bearerHeaders(aliceKeyDev1.key), {});
    t('B7 无 scope 旧 Key 读他人设备 → 403', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
    rec.device_scope = savedScope;
    fs.writeFileSync(keysPath, JSON.stringify(st));
  }

  // ---------- C) login-attestation 双账户 ----------
  // C1：alice 会话＋DEV1 在其清单内 → 200，账号恒等于会话账号
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1])), 'POST', '/api/lea/v1/login-attestation', { cookie: COOKIE }, { device_id: DEV1 });
  t('C1 attestation 清单内 → 200 且 account_id=会话账号', r.code === 200 && r.obj.ok === true && r.obj.account_id === ALICE && r.obj.device_id === 'd2-device-1');
  // C2：证明≠绑定——DEV2 绑 bob，但 MeshCentral 显示 alice 可见 DEV2 时仍签发（v3 设计）
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV2])), 'POST', '/api/lea/v1/login-attestation', { cookie: COOKIE }, { device_id: DEV2 });
  t('C2 attestation 可见但绑他人 → 200（证明≠绑定，不做已绑他人检查）', r.code === 200 && r.obj.account_id === ALICE);
  // C3：DEV2 不在 alice 清单内 → 403
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1])), 'POST', '/api/lea/v1/login-attestation', { cookie: COOKIE }, { device_id: DEV2 });
  t('C3 attestation 清单外 → 403', r.code === 403 && r.obj.code === 'FORBIDDEN');
  // C4：未注入依赖 → 503
  r = await callRoute(mkRoutes(ALICE, undefined), 'POST', '/api/lea/v1/login-attestation', { cookie: COOKIE }, { device_id: DEV1 });
  t('C4 attestation 未注入可见性依赖 → 503 QFR_VISIBILITY_UNAVAILABLE', r.code === 503 && r.obj.code === 'QFR_VISIBILITY_UNAVAILABLE');
  // C5：body 自报 account_id 不得改写签发账号（双账户 framing）
  r = await callRoute(mkRoutes(ALICE, visRecorder([DEV1])), 'POST', '/api/lea/v1/login-attestation', { cookie: COOKIE }, { device_id: DEV1, account_id: BOB });
  t('C5 attestation body 自报 account_id=bob 被忽略，仍签发 alice', r.code === 200 && r.obj.account_id === ALICE);
  // C6：bob 会话＋DEV2 在其清单内 → 200，account_id=bob
  r = await callRoute(mkRoutes(BOB, visRecorder([DEV2])), 'POST', '/api/lea/v1/login-attestation', { cookie: COOKIE }, { device_id: DEV2 });
  t('C6 attestation bob 会话＋DEV2 清单内 → 200 且 account_id=bob', r.code === 200 && r.obj.account_id === BOB);
  // C7：审计——attestation 403 记 lea-login-attestation-denied/not-visible
  a0 = auditText();
  await callRoute(mkRoutes(ALICE, async () => []), 'POST', '/api/lea/v1/login-attestation', { cookie: COOKIE }, { device_id: DEV1 });
  t('C7 审计：attestation 403 记 denied/not-visible', auditText().slice(a0.length).includes('lea-login-attestation-denied') && auditText().slice(a0.length).includes('not-visible'));

  // ---------- D) 站长换绑（放最后：会改绑定并吊销 bob 在 DEV2 上的 Key） ----------
  r = await callRoute(mkRoutes(ADMIN, visRecorder([DEV1, DEV2])), 'POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV2) + '/rebind', { cookie: COOKIE }, { account_id: ALICE });
  t('D1 站长换绑他人设备 → 200', r.code === 200 && r.obj.account_id === ALICE);
  t('D1 站长换绑后 bob 在 DEV2 上的旧 Key 被吊销', core.keyStatus(core.findKeyById(bobKeyDev2.record.key_id)) === 'revoked_by_rebind');
  core.recordBinding(DEV2, BOB, 'd2-restore');

  console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '；失败 ' + fail + (failures.length ? '：' + failures.join('；') : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
