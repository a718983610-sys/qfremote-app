'use strict';
/*
 * LEA 服务端单测（Stage 1 MVP）· Node 无依赖
 * 运行：node test/test-lea.js  （在 server/ext/lea/ 目录下，或任意目录）
 * 覆盖：Key 生成/吊销/换号失效、认证拒绝各码、签名验签占位、
 *   幂等去重、防重放、runcommands 下发构造（mock 通道，不真连
 *   MeshCentral）、路由层 execute/batches/jobs 全流程（mock 通道）。
 * 须真机/服务端联调的项不在此列，见 ../README.md「未完成/须联调」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createLeaCore } = require('../lea-core');
const { createLeaRoutes } = require('../lea-routes');
const { createLeaChannel } = require('../lea-channel');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; failures.push(name); console.log('FAIL-', name, extra ? String(extra).slice(0, 300) : ''); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-'));
const core = createLeaCore({ dir: tmpDir, enableSweeps: false });
const DEV = 'node//test-device-1';
const USER = 'alice';
const OTHER = 'bob';

function bearerHeaders(plain, extra) {
  return Object.assign({
    authorization: 'Bearer ' + plain,
    'x-qfr-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-qfr-nonce': 'n-' + crypto.randomBytes(6).toString('hex'),
  }, extra || {});
}

// ---------- 1) Key 生成：格式 / 只存哈希 / 列表脱敏 ----------
const gen = core.generateKey(USER, { device_scope: DEV });
t('Key 格式 qfr_lea_+43 位 base64url', /^qfr_lea_[A-Za-z0-9_-]{43}$/.test(gen.key));
t('key_id 形如 k_+10 字符', /^k_[a-z0-9]{10}$/.test(gen.record.key_id));
const keysFile = fs.readFileSync(path.join(tmpDir, 'keys.json'), 'utf8');
t('台账不存 Key 明文', !keysFile.includes(gen.key));
t('台账存 salt+hash（无明文可逆字段）', /"salt":\s*"[0-9a-f]{32}"/.test(keysFile) && /"hash":\s*"[0-9a-f]{64}"/.test(keysFile));
t('列表不显明文，只显前缀脱敏', gen.record.prefix.includes('…') && !gen.record.prefix.includes(gen.key.slice(12)));
t('列表不含明文 Key 字段', !('key' in gen.record));

// ---------- 2) 认证拒绝各码 ----------
let a = core.authenticate({});
t('无 Bearer → 401', a.ok === false && a.status === 401);
a = core.authenticate({ authorization: 'Bearer qfr_lea_' + 'A'.repeat(43) });
t('假 Key → 401 QFR_API_KEY_REVOKED', a.ok === false && a.code === 'QFR_API_KEY_REVOKED');
a = core.authenticate(bearerHeaders(gen.key));
t('真 Key + 有效时间戳/nonce → 通过', a.ok === true && a.key.key_id === gen.record.key_id);
// 防重放：同一 nonce 再用一次
const hDup = bearerHeaders(gen.key, { 'x-qfr-nonce': 'replay-nonce-001' });
a = core.authenticate(hDup);
t('首次 nonce 通过', a.ok === true);
a = core.authenticate(hDup);
t('同一 nonce 重放 → 401 QFR_REPLAY_DETECTED', a.ok === false && a.code === 'QFR_REPLAY_DETECTED');
// 时间戳超窗
a = core.authenticate(bearerHeaders(gen.key, { 'x-qfr-timestamp': String(Math.floor(Date.now() / 1000) - 3600) }));
t('时间戳超 60s 窗 → 401 QFR_REPLAY_DETECTED', a.ok === false && a.code === 'QFR_REPLAY_DETECTED');
// 缺 nonce
a = core.authenticate({ authorization: 'Bearer ' + gen.key, 'x-qfr-timestamp': String(Math.floor(Date.now() / 1000)) });
t('缺 nonce → 401 QFR_REPLAY_DETECTED', a.ok === false && a.code === 'QFR_REPLAY_DETECTED');

// ---------- 3) 准入七项校验 ----------
// 绑定 + 授权先行建立
core.recordBinding(DEV, USER, 'test-login');
core.grantMuse(USER, 'owner');
let adm = core.admit({ key: core.findKeyById(gen.record.key_id), deviceId: DEV, command: 'ui.click' });
t('绑定+授权齐全 → 准入通过', adm.ok === true);
// scope：device_scope 不一致
const genOther = core.generateKey(USER, { device_scope: 'node//other-device' });
adm = core.admit({ key: core.findKeyById(genOther.record.key_id), deviceId: DEV, command: 'ui.click' });
t('device_id 与 Key 绑定不一致 → 403 QFR_SCOPE_DENIED', adm.ok === false && adm.status === 403 && adm.code === 'QFR_SCOPE_DENIED');
// 未授权账号
const genNoGrant = core.generateKey('carol', { device_scope: DEV });
core.recordBinding(DEV, 'carol', 'test-login-carol'); // 换绑到 carol：alice 的旧 Key 应随之失效（见 §7.4，下组断言）
adm = core.admit({ key: core.findKeyById(genNoGrant.record.key_id), deviceId: DEV, command: 'ui.click' });
t('账号无 muse.execute 授权 → 403 QFR_MUSE_NOT_AUTHORIZED', adm.ok === false && adm.code === 'QFR_MUSE_NOT_AUTHORIZED');
// 未绑定设备（用无 device_scope 的 Key，免得先触发 SCOPE_DENIED）
const genNoScope = core.generateKey('carol', {});
adm = core.admit({ key: core.findKeyById(genNoScope.record.key_id), deviceId: 'node//never-bound', command: 'ui.click' });
t('设备未绑定 → 403 QFR_LEA_NOT_BOUND', adm.ok === false && adm.code === 'QFR_LEA_NOT_BOUND');
// 危险命令 scope
adm = core.admit({ key: core.findKeyById(genNoGrant.record.key_id), deviceId: DEV, command: 'script.run' });
t('危险命令无 dangerous scope → 403 QFR_SCOPE_DENIED', adm.ok === false && adm.code === 'QFR_SCOPE_DENIED');
// 未知命令
adm = core.admit({ key: core.findKeyById(genNoGrant.record.key_id), deviceId: DEV, command: 'rm -rf' });
t('未知命令 → 400 VALIDATION', adm.ok === false && adm.status === 400);

// ---------- 4) 换号失效（§7.4） ----------
// 上一步 recordBinding(DEV,'carol') 已把 alice 在 DEV 上的 Key 标记 revoked_by_rebind
const aliceKeyAfter = core.findKeyById(gen.record.key_id);
t('换绑后旧账号 Key 状态 revoked_by_rebind', core.keyStatus(aliceKeyAfter) === 'revoked_by_rebind');
a = core.authenticate(bearerHeaders(gen.key));
t('换绑后旧 Key 再调用 → 401 QFR_API_KEY_REVOKED', a.ok === false && a.code === 'QFR_API_KEY_REVOKED');
// 恢复：绑回 alice，重新生成 Key 供后续测试
core.recordBinding(DEV, USER, 'test-login-back');
core.grantMuse(USER, 'owner');
const gen2 = core.generateKey(USER, { device_scope: DEV });
t('换绑回原账号后可生成新 Key', /^qfr_lea_/.test(gen2.key));
a = core.authenticate(bearerHeaders(gen2.key));
t('新 Key 可用', a.ok === true);

// ---------- 5) 吊销 / 一键吊销 ----------
let rv = core.revokeKey(gen2.record.key_id, USER, 'test');
t('吊销单个 Key 成功', rv.ok === true && core.keyStatus(core.findKeyById(gen2.record.key_id)) === 'revoked');
a = core.authenticate(bearerHeaders(gen2.key));
t('吊销后调用 → 401 QFR_API_KEY_REVOKED', a.ok === false && a.code === 'QFR_API_KEY_REVOKED');
const g3 = core.generateKey(USER, { device_scope: DEV });
const g4 = core.generateKey(USER, { device_scope: DEV });
const all = core.revokeAllKeys(USER, USER, 'test-revoke-all');
t('一键吊销全部：g3/g4 均被吊销', all.revoked_count >= 2
  && core.keyStatus(core.findKeyById(g3.record.key_id)) === 'revoked'
  && core.keyStatus(core.findKeyById(g4.record.key_id)) === 'revoked');
t('一键吊销后两 Key 均 revoked', core.keyStatus(core.findKeyById(g3.record.key_id)) === 'revoked'
  && core.keyStatus(core.findKeyById(g4.record.key_id)) === 'revoked');

// ---------- 6) 授权撤销 ----------
const g5 = core.generateKey(USER, { device_scope: DEV });
core.grantMuse(USER, 'owner');
adm = core.admit({ key: core.findKeyById(g5.record.key_id), deviceId: DEV, command: 'ui.click' });
t('授权在效时准入通过', adm.ok === true);
core.revokeGrant(USER, 'owner');
adm = core.admit({ key: core.findKeyById(g5.record.key_id), deviceId: DEV, command: 'ui.click' });
t('撤销授权后 → 403 QFR_GRANT_REVOKED', adm.ok === false && adm.code === 'QFR_GRANT_REVOKED');
core.grantMuse(USER, 'owner'); // 恢复供路由测试

// ---------- 7) 签名验签（占位实现，明确标注） ----------
t('未配真实私钥时 signing 模式为 placeholder-ephemeral', core.signingInfo().mode === 'placeholder-ephemeral');
const env = core.buildEnvelope({
  requestId: 'req-1', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
  keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-1',
  command: 'ui.click', params: { x: 1 }, timeoutMs: 5000,
});
t('信封时间窗 expires-issued = 60s', env.expires_at - env.issued_at === 60);
t('信封签名可验', core.verifyEnvelope(env) === true);
const tampered = Object.assign({}, env, { command: 'script.run' });
t('篡改命令后验签失败', core.verifyEnvelope(tampered) === false);
t('信封带 signature 字段', typeof env.signature === 'string' && env.signature.length > 40);

// ---------- 8) 幂等去重 ----------
t('幂等未命中返回 null', core.idemLookup(USER, 'k_x', 'nope') === null);
core.idemRecord(USER, 'k_x', 'idem-a', { status: 'RUNNING' });
t('幂等 RUNNING 可查', core.idemLookup(USER, 'k_x', 'idem-a').status === 'RUNNING');
core.idemRecord(USER, 'k_x', 'idem-a', { status: 'SUCCEEDED', result: { job_id: 'job_1' } });
t('幂等 SUCCEEDED 带缓存结果', core.idemLookup(USER, 'k_x', 'idem-a').result.job_id === 'job_1');

// ---------- 9) runcommands 下发构造（mock 通道） ----------
const calls = [];
const mockChannel = {
  async runCommand(nodeId, cmd, timeoutMs) {
    calls.push({ nodeId, cmd, timeoutMs });
    return JSON.stringify({ ok: true, code: 'done', nodeId });
  },
  async nodeOnline() { return true; },
  async listNodes() { return [{ _id: DEV, conn: 1 }]; },
};
(async () => {
  const env2 = core.buildEnvelope({
    requestId: 'req-2', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-2',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d = await core.dispatchEnvelope(mockChannel, env2, { timeoutMs: 5000 });
  t('mock 下发成功', d.ok === true && d.result.code === 'done');
  t('下发目标为绑定设备', calls[0].nodeId === DEV);
  t('下发命令含 LEA 客户端路径', calls[0].cmd.includes('qf-lea-client.exe'));
  t('下发命令含 dispatch 动词', calls[0].cmd.includes('dispatch'));
  const b64 = calls[0].cmd.trim().split(/\s+/).pop();
  const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  t('下发信封 base64 可解出原信封', decoded.request_id === 'req-2' && decoded.command === 'sys.info');
  t('S3：下发命令不含裸 JSON（防 shell 元字符，只走 dispatch+base64）', !calls[0].cmd.includes('{"version"'));
  t('S3：dispatch 的 base64 载荷可被真客户端解码（见 test-lea-realclient.js）', typeof b64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(b64));
  t('下发超时 5s', calls[0].timeoutMs === 5000);
  // 大信封走 inbox 两步
  calls.length = 0;
  const bigEnv = core.buildEnvelope({
    requestId: 'req-3', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-3',
    command: 'ui.input', params: { text: 'x'.repeat(9000) }, timeoutMs: 5000,
  });
  const d2 = await core.dispatchEnvelope(mockChannel, bigEnv, { timeoutMs: 5000 });
  t('大信封下发成功', d2.ok === true);
  t('大信封走两步（写 inbox + apply）', calls.length === 2 && calls[0].cmd.includes('LEA\\inbox') && calls[1].cmd.includes('apply'));
  t('S3：apply 带 inbox 全路径（旧裸文件名会使客户端误发）', calls[1].cmd.includes('LEA\\inbox\\req-3.json'));
  t('S3：写 inbox 路径与 apply 路径一致', calls[0].cmd.includes(core.leaInboxPath('req-3.json')) && calls[1].cmd.includes(core.leaInboxPath('req-3.json')));
  // 危险命令不自动重试：通道抛错只发一次
  calls.length = 0;
  const errChannel = { async runCommand() { calls.push(1); throw new Error('boom'); }, async nodeOnline() { return true; } };
  const dangEnv = core.buildEnvelope({
    requestId: 'req-4', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-4',
    command: 'script.run', params: {}, timeoutMs: 5000,
  });
  const d3 = await core.dispatchEnvelope(errChannel, dangEnv, { timeoutMs: 5000 });
  t('危险命令失败只尝试 1 次（禁自动重试）', d3.ok === false && calls.length === 1);
  // 普通命令失败重试 1 次（共 2 次）
  calls.length = 0;
  const normalEnv = core.buildEnvelope({
    requestId: 'req-5', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-5',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d4 = await core.dispatchEnvelope(errChannel, normalEnv, { timeoutMs: 5000 });
  t('普通命令失败重试 1 次（共 2 次）', d4.ok === false && calls.length === 2);

  // ---------- 10) 通道模块：无配置时 fail-closed ----------
  const ch = createLeaChannel({ log: () => {}, configPath: path.join(tmpDir, 'no-such-config.json') });
  t('通道无服务账号配置时 status.configured=false', ch.status().configured === false);

  // ---------- 11) 路由层全流程（mock 通道 + 桩 deps） ----------
  const g6 = core.generateKey(USER, { device_scope: DEV });
  const sent = [];
  const routes = createLeaRoutes(core, mockChannel, {
    sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
    readJsonBody: async (req) => req._body || {},
    log: () => {},
    verifyPassword: async (u, p) => p === 'correct-password',
    resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
    isSiteAdmin: (a) => a.user === '718983610',
  });
  function mkReq(method, url, headers, body) {
    return { method, url, headers: headers || {}, _body: body || {}, socket: { remoteAddress: '127.0.0.1' } };
  }
  function mkRes() { return {}; }
  async function callRoute(method, url, headers, body) {
    sent.length = 0;
    const req = mkReq(method, url, headers, body);
    const res = mkRes();
    const matched = await routes.handle(req, res);
    return { matched, code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
  }
  // execute 成功
  let r = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-idem-1' }),
    { device_id: DEV, command: 'sys.info', params: {} });
  t('路由 execute 200 且带 job_id', r.matched === true && r.code === 200 && !!r.obj.job_id);
  // 同一幂等键再次调用 → 缓存结果 duplicate
  r = await callRoute('POST', '/api/lea/v1/execute',
    bearerHeaders(g6.key, { 'idempotency-key': 'route-idem-1' }),
    { device_id: DEV, command: 'sys.info', params: {} });
  t('同一幂等键重放返回缓存 duplicate', r.code === 200 && r.obj.duplicate === true);
  // 吊销后 Key 调 execute → 401
  const g7 = core.generateKey(USER, { device_scope: DEV });
  core.revokeKey(g7.record.key_id, USER, 'test');
  r = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g7.key), { 'idempotency-key': 'route-idem-2' }),
    { device_id: DEV, command: 'sys.info', params: {} });
  t('路由 execute 吊销 Key → 401 QFR_API_KEY_REVOKED', r.code === 401 && r.obj.code === 'QFR_API_KEY_REVOKED');
  // device_scope 不一致 → 403
  r = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-idem-3' }),
    { device_id: 'node//other', command: 'sys.info', params: {} });
  t('路由 execute 设备不一致 → 403 QFR_SCOPE_DENIED', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  // 缺幂等键 → 400
  r = await callRoute('POST', '/api/lea/v1/execute',
    bearerHeaders(g6.key),
    { device_id: DEV, command: 'sys.info', params: {} });
  t('路由 execute 缺 Idempotency-Key → 400', r.code === 400);
  // batches 成功
  r = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-1' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }] });
  t('路由 batches 200 且两步完成', r.code === 200 && r.obj.status === 'SUCCEEDED' && (r.obj.results || []).length === 2);
  // 查 job（归属校验：他人 job 查不到）
  const jobId = r.obj.job_id;
  r = await callRoute('GET', '/api/lea/v1/jobs/' + jobId, bearerHeaders(g6.key));
  t('路由查 job 200', r.code === 200 && r.obj.job.job_id === jobId);
  r = await callRoute('GET', '/api/lea/v1/jobs/' + jobId, bearerHeaders(core.generateKey(OTHER, { device_scope: DEV }).key));
  t('他人 job 查不到 → 404（不泄露存在性）', r.code === 404);
  // 设备状态
  r = await callRoute('GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/status', bearerHeaders(g6.key));
  t('路由设备状态 200 且 bound/online', r.code === 200 && r.obj.bound === true && r.obj.online === true);
  // Key 生成：密码二次确认
  r = await callRoute('POST', '/api/lea/v1/keys', {}, { password: 'correct-password', device_id: DEV });
  t('路由生成 Key 200 且返回明文一次', r.code === 200 && /^qfr_lea_/.test(r.obj.key || ''));
  r = await callRoute('POST', '/api/lea/v1/keys', {}, { password: 'wrong' });
  t('路由生成 Key 密码错误 → 401', r.code === 401);
  r = await callRoute('GET', '/api/lea/v1/keys', {}, {});
  t('路由 Key 列表 200 且无明文字段', r.code === 200 && Array.isArray(r.obj.keys)
    && r.obj.keys.every((k) => !('key' in k) && !('hash' in k)));
  // 吊销单个 + 吊销全部
  const victim = core.generateKey(USER, { device_scope: DEV });
  r = await callRoute('POST', '/api/lea/v1/keys/' + victim.record.key_id + '/revoke', {}, {});
  t('路由吊销单个 Key 200', r.code === 200 && r.obj.record.status === 'revoked');
  r = await callRoute('POST', '/api/lea/v1/keys/revoke-all', {}, { password: 'correct-password' });
  t('路由一键吊销全部 200', r.code === 200 && r.obj.revoked_count >= 1);
  // 授权接口非站长 → 403
  r = await callRoute('POST', '/api/lea/v1/grants', {}, { account_id: USER, action: 'grant' });
  t('路由 grants 非站长 → 403', r.code === 403);
  // 非 LEA 路径不匹配
  const nm = await routes.handle(mkReq('GET', '/api/device/presence', {}), mkRes());
  t('非 LEA 路径返回 false（不拦截既有路由）', nm === false);

  // ---------- 12) 审计不含 Key 明文 ----------
  const auditText = fs.readdirSync(tmpDir).filter((f) => f.startsWith('audit-'))
    .map((f) => fs.readFileSync(path.join(tmpDir, f), 'utf8')).join('\n');
  t('审计日志不含任何已生成 Key 的明文', ![gen.key, gen2.key, g5.key, g6.key].some((k) => auditText.includes(k)));
  t('审计文件已生成', auditText.includes('lea-key-generated'));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '；失败 ' + fail + (failures.length ? '：' + failures.join('；') : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
