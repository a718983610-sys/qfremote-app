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
// T07：Key 生成时盖上当时的 grant_epoch——先建立绑定＋授权再建 Key；
// §3 会再次确认同一状态（同账号重复绑定／重复 grant 不动 epoch）。
core.recordBinding(DEV, USER, 'test-login');
core.grantMuse(USER, 'owner');
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
// T07/H22：Key 必须在绑定＋授权建立之后生成——生成时盖上当时的 binding_epoch
// 与 grant_epoch；绑定前生成的 Key（binding_epoch 0）准入时按不匹配拒绝；
// 授权前生成的 Key 盖上的 grant_epoch 为 0，准入时按授权撤销拒绝。
const genBound = core.generateKey(USER, { device_scope: DEV });
let adm = core.admit({ key: core.findKeyById(genBound.record.key_id), deviceId: DEV, command: 'ui.click' });
t('绑定+授权齐全 → 准入通过', adm.ok === true);
// scope：device_scope 不一致
const genOther = core.generateKey(USER, { device_scope: 'node//other-device' });
adm = core.admit({ key: core.findKeyById(genOther.record.key_id), deviceId: DEV, command: 'ui.click' });
t('device_id 与 Key 绑定不一致 → 403 QFR_SCOPE_DENIED', adm.ok === false && adm.status === 403 && adm.code === 'QFR_SCOPE_DENIED');
// 未授权账号：先授 carol、换绑、建 Key，再撤销授权，准入应报授权已撤销
// （T07：revokeGrant 递增 grant_epoch，旧 Key 的 epoch 再也对不上）。
core.grantMuse('carol', 'owner');
core.recordBinding(DEV, 'carol', 'test-login-carol'); // 换绑到 carol：alice 的旧 Key 应随之失效（见 §7.4，下组断言）
const genNoGrant = core.generateKey('carol', { device_scope: DEV });
core.revokeGrant('carol', 'owner');
adm = core.admit({ key: core.findKeyById(genNoGrant.record.key_id), deviceId: DEV, command: 'ui.click' });
t('账号授权已撤销 → 403 QFR_GRANT_REVOKED', adm.ok === false && adm.code === 'QFR_GRANT_REVOKED');
// 未绑定设备（用无 device_scope 的 Key，免得先触发 SCOPE_DENIED）
core.grantMuse('carol', 'owner'); // 重新授予，genNoScope 才能建出
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
  requestId: 'req-000001', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
  keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000001',
  command: 'ui.click', params: { x: 1 }, timeoutMs: 5000,
});
t('信封时间窗 expires-issued = 60s', env.expires_at - env.issued_at === 60);
t('信封签名可验', core.verifyEnvelope(env) === true);
const tampered = Object.assign({}, env, { command: 'script.run' });
t('篡改命令后验签失败', core.verifyEnvelope(tampered) === false);
t('信封带 signature 字段', typeof env.signature === 'string' && env.signature.length > 40);

// ---------- 7b) 规范串 v1（S1/S4 定稿；与 C 单测同一向量） ----------
const VEC_ENV = {
  version: 1, request_id: 'req-0000001', batch_id: 'batch-0001', seq: 1,
  device_id: 'node-1', account_id: 'alice', api_key_id: 'key-abc12345',
  binding_epoch: 3, nonce: 'nonce-00001', issued_at: 1780000000, expires_at: 1780000060,
  idempotency_key: 'idem-key-0001', command: 'ui.click',
  params: { b: 2, a: 1 }, timeout_ms: 5000,
};
const VEC_ENVELOPE_CANONICAL = [
  'qfr-lea-envelope-v1', '1', 'req-0000001', 'batch-0001', '1', 'node-1', 'alice',
  'key-abc12345', '3', 'nonce-00001', '1780000000', '1780000060', 'idem-key-0001',
  'ui.click', '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777', '5000',
].join('\n');
t('信封规范串 v1 与定稿向量字节相等', core.envelopeSigningBytes(VEC_ENV) === VEC_ENVELOPE_CANONICAL);
t('params 键序不同时规范串相同（归一化）',
  core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { params: { a: 1, b: 2 } })) === VEC_ENVELOPE_CANONICAL);
t('stableStringify 递归排序嵌套对象',
  core._test.stableStringify({ z: { b: 2, a: 1 }, a: [3, { d: 4, c: 3 }] }) === '{"a":[3,{"c":3,"d":4}],"z":{"a":1,"b":2}}');
// 线上形式：buildEnvelope 发出的 params 子串即 stable JSON
const wireEnv = core.buildEnvelope({
  requestId: 'req-vec-1', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
  keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-vec-1',
  command: 'ui.click', params: { b: 2, a: 1 }, timeoutMs: 5000,
});
t('线上信封 params 子串为 stable 形式', JSON.stringify(wireEnv).includes('"params":{"a":1,"b":2}'));
t('buildEnvelope 归一化后签名可验', core.verifyEnvelope(wireEnv) === true);
// 篡改矩阵：任一覆盖字段一改即验签失败
const signedVec = core.signEnvelope(Object.assign({}, VEC_ENV, { params: { a: 1, b: 2 } }));
t('向量信封签名可验', core.verifyEnvelope(signedVec) === true);
for (const [name, patch] of [
  ['params', { params: { a: 1, b: 3 } }],
  ['account_id', { account_id: 'mallory' }],
  ['api_key_id', { api_key_id: 'key-xxxx0000' }],
  ['timeout_ms', { timeout_ms: 6000 }],
  ['batch_id', { batch_id: 'batch-9999' }],
  ['seq', { seq: 2 }],
  ['device_id', { device_id: 'node-2' }],
  ['binding_epoch', { binding_epoch: 4 }],
  ['idempotency_key', { idempotency_key: 'idem-key-9999' }],
  ['nonce', { nonce: 'nonce-99999' }],
  ['issued_at', { issued_at: 1780000001 }],
  ['expires_at', { expires_at: 1780000061 }],
]) {
  t('篡改 ' + name + ' 后验签失败', core.verifyEnvelope(Object.assign({}, signedVec, patch)) === false);
}
t('无 batch_id 时规范串对应行为空行',
  core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { batch_id: null })).split('\n')[3] === '');
// 含控制字符的字段拒绝签名（fail-closed，不产出签名）
let threw = false;
try {
  core.buildEnvelope({
    requestId: 'req-bad-1', batchId: null, seq: 1, deviceId: DEV, accountId: 'a\nb',
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-bad-1',
    command: 'ui.click', params: {}, timeoutMs: 5000,
  });
} catch (e) { threw = true; }
t('account_id 含换行时 buildEnvelope 抛错（不签名）', threw === true);

// ---------- 7c) 票据规范串 v1（S2） ----------
const VEC_TICKET = {
  account_id: 'alice', device_id: 'node-1', binding_epoch: 3, grant_epoch: 1,
  grant_muse_execute: 1, scopes: 'muse.execute', lease_id: 'lease-0123456789abcdef',
  expires_at: 1780086400,
};
const VEC_TICKET_CANONICAL = [
  'qfr-lea-ticket-v1', 'alice', 'node-1', '3', '1', '1', 'muse.execute',
  'lease-0123456789abcdef', '1780086400',
].join('\n');
t('票据规范串 v1 与定稿向量字节相等', core.ticketSigningBytes(VEC_TICKET) === VEC_TICKET_CANONICAL);
const signedTicket = core.signTicket(Object.assign({}, VEC_TICKET));
t('票据签名可验', core.verifyTicket(signedTicket) === true);
for (const [name, patch] of [
  ['grant 翻转 1→0', { grant_muse_execute: 0 }],
  ['scopes 加 dangerous', { scopes: 'muse.execute,muse.execute.dangerous' }],
  ['lease_id 更换', { lease_id: 'lease-ffffffffffffffff' }],
  ['expires_at 更换', { expires_at: 1780086401 }],
  ['account 更换', { account_id: 'mallory' }],
  ['grant_epoch 更换', { grant_epoch: 2 }],
]) {
  t('票据篡改 ' + name + ' 后验签失败', core.verifyTicket(Object.assign({}, signedTicket, patch)) === false);
}
t('票据 scopes 未排序时 verifyTicket 失败（格式即拒）',
  core.verifyTicket(Object.assign({}, signedTicket, { scopes: 'muse.execute.dangerous,muse.execute' })) === false);
// issueBindingTicket：scopes 数组自动排序＋签发
const issuedTicket = core.issueBindingTicket({
  accountId: 'alice', deviceId: 'node-1', bindingEpoch: 3, grantEpoch: 1,
  grantMuseExecute: 1, scopes: ['muse.execute.dangerous', 'muse.execute'],
  leaseId: 'lease-0123456789abcdef', expiresAt: 1780086400,
});
t('签发票据 scopes 自动排成规范串', issuedTicket.scopes === 'muse.execute,muse.execute.dangerous');
t('签发票据可验', core.verifyTicket(issuedTicket) === true);
t('签发票据 lease_id 形如 lease-+16 hex', /^lease-[0-9a-f]{16}$/.test(issuedTicket.lease_id));

// ---------- 7d) 规范串 v1 严格校验（DS 复查 round 1 返修） ----------
const intKeyParams = { '10': 1, '2': 2 };
t('stableStringify 整数键按数值升序在前',
  core._test.stableStringify(intKeyParams) === '{"2":2,"10":1}');
t('normalizeParams 后线上 JSON 与 stable JSON 字节相等（整数键）',
  JSON.stringify(core._test.normalizeParams(intKeyParams)) === core._test.stableStringify(intKeyParams));
t('normalizeParams 嵌套整数键与 stable 一致',
  JSON.stringify(core._test.normalizeParams({ z: { '10': 1, '2': 2 } })) === core._test.stableStringify({ z: { '10': 1, '2': 2 } }));
t('normalizeParams 保留 __proto__ 键',
  JSON.stringify(core._test.normalizeParams(JSON.parse('{"__proto__":{"x":1},"a":2}'))) === '{"__proto__":{"x":1},"a":2}');
// 整数键信封：线上 params 子串的哈希即签名哈希，验签通过
const intKeyEnv = core.buildEnvelope({
  requestId: 'req-000011', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
  keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000011',
  command: 'ui.click', params: intKeyParams, timeoutMs: 5000,
});
t('整数键信封签名可验', core.verifyEnvelope(intKeyEnv) === true);
t('整数键信封线上 params 子串哈希等于 stable 哈希',
  crypto.createHash('sha256').update(JSON.stringify(intKeyEnv.params), 'utf8').digest('hex')
    === crypto.createHash('sha256').update(core._test.stableStringify(intKeyParams), 'utf8').digest('hex'));
// timeout：缺失取默认，非法（0／负／超上限）抛错
t('timeout 缺失时规范串取命令默认值',
  core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { timeout_ms: undefined })).split('\n')[15] === '5000');
for (const [name, v] of [['timeout 0', 0], ['timeout 负数', -5], ['timeout 超上限 ui.click 60000', 60000], ['timeout 非整数', 1.5]]) {
  let bad = false;
  try { core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { timeout_ms: v })); } catch (e) { bad = true; }
  t('envelopeSigningBytes ' + name + ' 抛错', bad === true);
}
// seq／版本／命令／id／token 严格校验
for (const [name, patch] of [
  ['seq 0', { seq: 0 }],
  ['seq 缺失', { seq: undefined }],
  ['version 2', { version: 2 }],
  ['未知命令', { command: 'rm -rf' }],
  ['空 device_id', { device_id: '' }],
  ['超长 account_id（128 字符）', { account_id: 'a'.repeat(128) }],
  ['短 request_id', { request_id: 'req-1' }],
  ['nonce 含非法字符', { nonce: 'nonce:00001' }],
]) {
  let bad = false;
  try {
    const e = Object.assign({}, VEC_ENV, patch);
    if (patch.seq === undefined && 'seq' in patch) delete e.seq;
    core.envelopeSigningBytes(e);
  } catch (err) { bad = true; }
  t('envelopeSigningBytes ' + name + ' 抛错', bad === true);
}
// 固定密钥跨实例验签（Ed25519 占位实现下，签名不绑定临时实例密钥）
{
  const kp = crypto.generateKeyPairSync('ed25519');
  const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubDer = kp.publicKey.export({ format: 'der', type: 'spki' });
  const keyFile = path.join(tmpDir, 'lea-fixed-key.b64');
  fs.writeFileSync(keyFile, Buffer.concat([privDer.subarray(-32), pubDer.subarray(-32)]).toString('base64'));
  const coreF1 = createLeaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-f1-')), enableSweeps: false, signingKeyFile: keyFile });
  const coreF2 = createLeaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-f2-')), enableSweeps: false, signingKeyFile: keyFile });
  t('固定密钥两实例 signing 模式为 real', coreF1.signingInfo().mode === 'real' && coreF2.signingInfo().mode === 'real');
  const fEnv = coreF1.buildEnvelope({
    requestId: 'req-000012', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000012',
    command: 'ui.click', params: { x: 1 }, timeoutMs: 5000,
  });
  t('固定密钥实例 A 签名可被实例 B 验签', coreF2.verifyEnvelope(fEnv) === true);
  t('固定密钥实例 B 篡改后验签失败', coreF2.verifyEnvelope(Object.assign({}, fEnv, { command: 'script.run' })) === false);
  const fTicket = coreF1.issueBindingTicket({
    accountId: 'alice', deviceId: 'node-1', bindingEpoch: 3, grantEpoch: 1,
    grantMuseExecute: 1, scopes: ['muse.execute'], leaseId: 'lease-0123456789abcdef', expiresAt: 1780086400,
  });
  t('固定密钥票据可被另一实例验签', coreF2.verifyTicket(fTicket) === true);
}

// ---------- 7e) 票据严格校验（DS 复查 round 1 返修） ----------
for (const [name, patch] of [
  ['scopes 为数组', { scopes: ['muse.execute'] }],
  ['grant 为 2', { grant_muse_execute: 2 }],
  ['grant 为 true', { grant_muse_execute: true }],
  ['grant 缺失', { grant_muse_execute: undefined }],
]) {
  let bad = false;
  try { core.ticketSigningBytes(Object.assign({}, VEC_TICKET, patch)); } catch (e) { bad = true; }
  t('ticketSigningBytes ' + name + ' 抛错', bad === true);
}
t('verifyTicket grant 为 2 返回 false',
  core.verifyTicket(Object.assign({}, signedTicket, { grant_muse_execute: 2 })) === false);
t('长 scope token（100 字符）可签可验',
  core.verifyTicket(core.signTicket(Object.assign({}, VEC_TICKET, { scopes: 's'.repeat(100) }))) === true);
{
  let bad = false;
  try {
    core.issueBindingTicket({
      accountId: 'alice', deviceId: 'node-1', bindingEpoch: 3, grantEpoch: 1,
      grantMuseExecute: 1, scopes: ['muse.execute'], leaseId: 'bad-lease', expiresAt: 1780086400,
    });
  } catch (e) { bad = true; }
  t('issueBindingTicket 非法 lease_id 抛错', bad === true);
}

// ---------- 7f) 规范串 v1 严格校验·第三轮（DS 复查 round 2 返修） ----------
// toJSON／非 JSON 安全值：签名哈希须与线上 JSON.stringify 输出一致，遇即抛错
for (const [name, badParams] of [
  ['toJSON 自有函数', (() => { const o = { x: 1 }; o.toJSON = () => ({ a: 1 }); return o; })()],
  ['嵌套 toJSON', { a: (() => { const o = {}; o.toJSON = () => 1; return o; })() }],
  ['函数值', { f: () => 1 }],
  ['undefined 值', { u: undefined }],
  ['Symbol 值', { s: Symbol('x') }],
  ['Date 值', { d: new Date(1780000000000) }],
  ['数组内函数', [() => 1]],
]) {
  let bad = false;
  try {
    core.buildEnvelope({
      requestId: 'req-000013', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000013',
      command: 'ui.click', params: badParams, timeoutMs: 5000,
    });
  } catch (e) { bad = true; }
  t('buildEnvelope ' + name + ' 抛错', bad === true);
}
t('stableStringify 遇 toJSON 抛错',
  (() => { try { core._test.stableStringify({ toJSON: () => ({}) }); return false; } catch (e) { return true; } })());
t('normalizeParams 遇函数值抛错',
  (() => { try { core._test.normalizeParams({ f: () => 1 }); return false; } catch (e) { return true; } })());
// params 顶层须为 JSON 对象
for (const [name, badParams] of [['数组 params', []], ['字符串 params', 'x'], ['数字 params', 5]]) {
  let bad = false;
  try {
    core.buildEnvelope({
      requestId: 'req-000014', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000014',
      command: 'ui.click', params: badParams, timeoutMs: 5000,
    });
  } catch (e) { bad = true; }
  t('buildEnvelope ' + name + ' 抛错', bad === true);
}
t('buildEnvelope params 缺失时取空对象',
  core.verifyEnvelope(core.buildEnvelope({
    requestId: 'req-000015', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000015',
    command: 'ui.click', params: null, timeoutMs: 5000,
  })) === true);
// id 字段长度按 UTF-8 字节计（100 个汉字 = 300 字节 > 127）
for (const [name, patch, shouldThrow] of [
  ['account 100 汉字（300 字节）', { account_id: '中'.repeat(100) }, true],
  ['account 43 汉字（129 字节）', { account_id: '中'.repeat(43) }, true],
  ['account 42 汉字（126 字节）', { account_id: '中'.repeat(42) }, false],
  ['account 127 ASCII', { account_id: 'a'.repeat(127) }, false],
]) {
  let bad = false;
  try { core.envelopeSigningBytes(Object.assign({}, VEC_ENV, patch)); } catch (e) { bad = true; }
  t('envelopeSigningBytes ' + name + (shouldThrow ? ' 抛错' : ' 通过'), bad === shouldThrow);
}
// 票据 lease／scopes 长度上限
for (const [name, patch, shouldThrow] of [
  ['lease 200 字符', { lease_id: 'a'.repeat(200) }, true],
  ['lease 127 字符', { lease_id: 'a'.repeat(127) }, false],
  ['scopes 257 字节', { scopes: 's'.repeat(257) }, true],
  ['scopes 256 字节', { scopes: 's'.repeat(256) }, false],
]) {
  let bad = false;
  try { core.ticketSigningBytes(Object.assign({}, VEC_TICKET, patch)); } catch (e) { bad = true; }
  t('ticketSigningBytes ' + name + (shouldThrow ? ' 抛错' : ' 通过'), bad === shouldThrow);
}
{
  let bad = false;
  try {
    core.issueBindingTicket({
      accountId: 'alice', deviceId: 'node-1', bindingEpoch: 3, grantEpoch: 1,
      grantMuseExecute: 1, scopes: ['muse.execute'], leaseId: '', expiresAt: 1780086400,
    });
  } catch (e) { bad = true; }
  t('issueBindingTicket 显式空 leaseId 抛错（不得静默改发）', bad === true);
  const gen = core.issueBindingTicket({
    accountId: 'alice', deviceId: 'node-1', bindingEpoch: 3, grantEpoch: 1,
    grantMuseExecute: 1, scopes: ['muse.execute'], expiresAt: 1780086400,
  });
  t('issueBindingTicket 缺省 leaseId 自动生成', /^lease-[0-9a-f]{16}$/.test(gen.lease_id));
}

// ---------- 7g) 整数字段安全整数（DS 复查 round 3 返修） ----------
for (const [name, patch, shouldThrow] of [
  ['seq 超安全整数', { seq: 2 ** 53 + 1 }, true],
  ['seq 4294967297（安全整数内）', { seq: 4294967297 }, false],
  ['binding_epoch 超安全整数', { binding_epoch: 2 ** 53 + 1 }, true],
  ['issued_at 超安全整数', { issued_at: 2 ** 53 + 1 }, true],
]) {
  let bad = false;
  try { core.envelopeSigningBytes(Object.assign({}, VEC_ENV, patch)); } catch (e) { bad = true; }
  t('envelopeSigningBytes ' + name + (shouldThrow ? ' 抛错' : ' 通过'), bad === shouldThrow);
}
t('envelopeSigningBytes seq 4294967297 规范串含原值',
  core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { seq: 4294967297 })).split('\n')[4] === '4294967297');
{
  let bad = false;
  try { core.ticketSigningBytes(Object.assign({}, VEC_TICKET, { grant_epoch: 2 ** 53 + 1 })); } catch (e) { bad = true; }
  t('ticketSigningBytes grant_epoch 超安全整数抛错', bad === true);
}
// timeout_ms: null 是显式非法值，不是缺失（DS 复查 round 4 返修）
{
  let bad = false;
  try { core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { timeout_ms: null })); } catch (e) { bad = true; }
  t('envelopeSigningBytes timeout_ms null 抛错', bad === true);
  bad = false;
  try {
    core.buildEnvelope({
      requestId: 'req-000016', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000016',
      command: 'ui.click', params: {}, timeoutMs: null,
    });
  } catch (e) { bad = true; }
  t('buildEnvelope timeoutMs null 抛错', bad === true);
}

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
    requestId: 'req-000002', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000002',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d = await core.dispatchEnvelope(mockChannel, env2, { timeoutMs: 5000 });
  t('mock 下发成功', d.ok === true && d.result.code === 'done');
  // H21：此前 §5/§6 已吊销多把 Key，下发前会先同步一次本机吊销表
  // （powershell 写 revoked_keys.txt），故 calls[0] 是同步命令；下发命令
  // 须按“含 ' dispatch '”过滤出来断言（exe 路径带引号，'exe dispatch'
  // 连写匹配不上）。
  const disp1 = calls.filter((c) => c.cmd.includes(' dispatch '));
  t('下发目标为绑定设备', disp1.length === 1 && disp1[0].nodeId === DEV);
  t('下发命令含 LEA 客户端路径', disp1.length === 1 && disp1[0].cmd.includes('qf-lea-client.exe'));
  t('下发命令含 dispatch 动词', disp1.length === 1 && disp1[0].cmd.includes('dispatch'));
  const b64 = disp1[0].cmd.trim().split(/\s+/).pop();
  const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  t('下发信封 base64 可解出原信封', decoded.request_id === 'req-000002' && decoded.command === 'sys.info');
  t('S3：下发命令不含裸 JSON（防 shell 元字符，只走 dispatch+base64）', !disp1[0].cmd.includes('{"version"'));
  t('S3：dispatch 的 base64 载荷可被真客户端解码（见 test-lea-realclient.js）', typeof b64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(b64));
  t('下发超时 5s', disp1[0].timeoutMs === 5000);
  t('H21 吊销表只同步一次（本次下发后 pushed_epoch 已追上）', calls.filter((c) => c.cmd.includes('revoked_keys.txt')).length === 1);
  // 大信封走 inbox 两步
  calls.length = 0;
  const bigEnv = core.buildEnvelope({
    requestId: 'req-000003', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000003',
    command: 'ui.input', params: { text: 'x'.repeat(9000) }, timeoutMs: 5000,
  });
  const d2 = await core.dispatchEnvelope(mockChannel, bigEnv, { timeoutMs: 5000 });
  t('大信封下发成功', d2.ok === true);
  t('大信封走两步（写 inbox + apply）', calls.length === 2 && calls[0].cmd.includes('LEA\\inbox') && calls[1].cmd.includes('apply'));
  t('S3：apply 带 inbox 全路径（旧裸文件名会使客户端误发）', calls[1].cmd.includes('LEA\\inbox\\req-000003.json'));
  t('S3：写 inbox 路径与 apply 路径一致', calls[0].cmd.includes(core.leaInboxPath('req-000003.json')) && calls[1].cmd.includes(core.leaInboxPath('req-000003.json')));
  // 危险命令不自动重试：通道抛错只发一次（H21 同步命令不计入下发次数）
  calls.length = 0;
  const errChannel = { async runCommand(nodeId, cmd) { calls.push({ nodeId, cmd }); throw new Error('boom'); }, async nodeOnline() { return true; } };
  const dangEnv = core.buildEnvelope({
    requestId: 'req-000004', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000004',
    command: 'script.run', params: {}, timeoutMs: 5000,
  });
  const d3 = await core.dispatchEnvelope(errChannel, dangEnv, { timeoutMs: 5000 });
  t('危险命令失败只尝试 1 次（禁自动重试）', d3.ok === false && calls.filter((c) => c.cmd.includes(' dispatch ')).length === 1);
  // 普通命令失败重试 1 次（共 2 次）
  calls.length = 0;
  const normalEnv = core.buildEnvelope({
    requestId: 'req-000005', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-000005',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d4 = await core.dispatchEnvelope(errChannel, normalEnv, { timeoutMs: 5000 });
  t('普通命令失败重试 1 次（共 2 次）', d4.ok === false && calls.filter((c) => c.cmd.includes(' dispatch ')).length === 2);

  // ---------- H15：parseClientOutput 严格判成功 ----------
  t('H15 {ok:false} 判失败', core.parseClientOutput(JSON.stringify({ ok: false, code: 'QFR_LEA_EXEC_FAILED' })).ok === false);
  t('H15 {ok:true} 判成功', core.parseClientOutput(JSON.stringify({ ok: true, code: 'done' })).ok === true);
  t('H15 非 JSON 文本判失败', core.parseClientOutput('some error text').ok === false);
  t('H15 空串判失败', core.parseClientOutput('').ok === false);
  t('H15 JSON 数组判失败', core.parseClientOutput('[1,2]').ok === false);
  t('H15 无 ok 字段的对象判失败', core.parseClientOutput(JSON.stringify({ code: 'done' })).ok === false);
  t('H15 ok 非布尔 true 判失败', core.parseClientOutput(JSON.stringify({ ok: 'true' })).ok === false);
  // dispatch 经 H15：客户端回 {ok:false} 不得记成功
  const failChannel = { async runCommand() { return JSON.stringify({ ok: false, code: 'QFR_LEA_EXEC_FAILED' }); }, async nodeOnline() { return true; } };
  const envF = core.buildEnvelope({
    requestId: 'req-h15-1', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-h15-1',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const dF = await core.dispatchEnvelope(failChannel, envF, { timeoutMs: 5000 });
  t('H15 dispatch 回 {ok:false} → 不成功', dF.ok === false);

  // ---------- H11：nonce／幂等落盘持久化（重启不丢） ----------
  core.idemRecord(USER, g5.record.key_id, 'idem-persist-1', { status: 'SUCCEEDED', result: { job_id: 'job_p1' } });
  core.nonceCheck(g5.record.key_id, 'persist-nonce-001');
  const core2 = createLeaCore({ dir: tmpDir, enableSweeps: false });
  t('H11 重启后幂等去重不丢', core2.idemLookup(USER, g5.record.key_id, 'idem-persist-1') !== null
    && core2.idemLookup(USER, g5.record.key_id, 'idem-persist-1').status === 'SUCCEEDED');
  t('H11 重启后 nonce 防重放不丢', core2.nonceCheck(g5.record.key_id, 'persist-nonce-001') === false);
  t('H11 落盘文件存在', fs.existsSync(path.join(tmpDir, 'idem-seen.json')) && fs.existsSync(path.join(tmpDir, 'nonce-seen.json')));

  // ---------- H14：job 推进器（失联 job 不再长期卡住重试） ----------
  const staleJob = core.createJob({
    account_id: USER, device_id: DEV, api_key_id: g5.record.key_id,
    command: 'sys.info', request_id: 'req-stale-1', idempotency_key: 'idem-stale-1', status: 'RUNNING',
  });
  core.idemRecord(USER, g5.record.key_id, 'idem-stale-1', { status: 'RUNNING', job_id: staleJob.job_id });
  // 把 job 更新时间拨回 16 分钟前，模拟失联（超 JOB_STALE_MS=15 分钟）
  const jobsSt = core._test.loadJobs();
  jobsSt.jobs[staleJob.job_id].updated_at = Date.now() - 16 * 60 * 1000;
  fs.writeFileSync(path.join(tmpDir, 'jobs.json'), JSON.stringify(jobsSt, null, 2));
  core.sweepStaleJobs();
  t('H14 失联 RUNNING job 推进为 UNKNOWN', core.getJob(staleJob.job_id).status === 'UNKNOWN');
  t('H14 失联 job 的幂等键转 UNKNOWN（重试不再卡 409）', core.idemLookup(USER, g5.record.key_id, 'idem-stale-1').status === 'UNKNOWN');
  // 新鲜 RUNNING job 不动
  const freshJob = core.createJob({
    account_id: USER, device_id: DEV, api_key_id: g5.record.key_id,
    command: 'sys.info', request_id: 'req-fresh-1', idempotency_key: 'idem-fresh-1', status: 'RUNNING',
  });
  core.sweepStaleJobs();
  t('H14 新鲜 RUNNING job 不推进', core.getJob(freshJob.job_id).status === 'RUNNING');

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
  // 批量步级 request_id／幂等键用 '-' 连接步号（':' 不合 token 规则，C 端拒收）
  const batchB64 = calls[calls.length - 1].cmd.trim().split(/\s+/).pop();
  const batchEnv = JSON.parse(Buffer.from(batchB64, 'base64').toString('utf8'));
  t('批量步 request_id 用 - 连接且合 token 规则', /^[A-Za-z0-9_-]{8,128}$/.test(batchEnv.request_id) && batchEnv.request_id.endsWith('-2'));
  t('批量步幂等键用 - 连接且合 token 规则', batchEnv.idempotency_key === 'route-batch-1-2');
  let rh;
  // H13：批量级幂等——重复提交返回缓存，不重跑步骤
  const callsBeforeDup = calls.length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-1' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }] });
  t('H13 路由 batches 重复提交返回缓存 duplicate', rh.code === 200 && rh.obj.duplicate === true && rh.obj.status === 'SUCCEEDED');
  t('H13 路由 batches 重复提交不重跑步骤', calls.length === callsBeforeDup);
  // H13：步级幂等键已写入 idemSeen
  t('H13 步级幂等键已写入 idemSeen', core.idemLookup(USER, g6.record.key_id, 'route-batch-1-1') !== null
    && core.idemLookup(USER, g6.record.key_id, 'route-batch-1-1').status === 'SUCCEEDED'
    && core.idemLookup(USER, g6.record.key_id, 'route-batch-1-2').status === 'SUCCEEDED');
  // H13：含失败步的批次终态 FAILED（不谎称 SUCCEEDED）
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-badstep' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'no.such', params: {} }] });
  t('H13 含失败步的批次终态 FAILED', rh.code === 200 && rh.obj.status === 'FAILED');
  // H13（DS 复查）：UNKNOWN 重试时 steps 指纹不一致 → 步级缓存不复用
  const fpSteps = [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }];
  const fpMatch = crypto.createHash('sha256').update(JSON.stringify(fpSteps)).digest('hex');
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp', { status: 'UNKNOWN', job_id: 'job_fp', steps_fp: 'different-fingerprint' });
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp-1', { status: 'SUCCEEDED', job_id: 'job_fp', result: { ok: true, code: 'done', nodeId: DEV } });
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp-2', { status: 'SUCCEEDED', job_id: 'job_fp', result: { ok: true, code: 'done', nodeId: DEV } });
  const callsBeforeFp = calls.length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-fp' }),
    { device_id: DEV, steps: fpSteps });
  t('H13 指纹不一致时不复用步级缓存（全部重跑）', rh.code === 200 && rh.obj.status === 'SUCCEEDED'
    && calls.length === callsBeforeFp + 2 && !(rh.obj.results || []).some((x) => x.duplicate));
  // 指纹一致 → 复用已成功步
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp2', { status: 'UNKNOWN', job_id: 'job_fp2', steps_fp: fpMatch });
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp2-1', { status: 'SUCCEEDED', job_id: 'job_fp2', result: { ok: true, code: 'done', nodeId: DEV } });
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp2-2', { status: 'SUCCEEDED', job_id: 'job_fp2', result: { ok: true, code: 'done', nodeId: DEV } });
  const callsBeforeFp2 = calls.length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-fp2' }),
    { device_id: DEV, steps: fpSteps });
  t('H13 指纹一致时复用步级缓存（不重跑）', rh.code === 200 && rh.obj.status === 'SUCCEEDED'
    && calls.length === callsBeforeFp2 && (rh.obj.results || []).every((x) => x.duplicate === true));
  // H12：batches 设备离线 → 503（handleExecute 查了，handleBatches 原来没查）
  const nodeOnlineOrig = mockChannel.nodeOnline;
  mockChannel.nodeOnline = async () => false;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-offline' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }] });
  t('H12 路由 batches 设备离线 → 503', rh.code === 503 && rh.obj.code === 'QFR_LEA_NOT_INSTALLED');
  mockChannel.nodeOnline = async () => null;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-unknown' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }] });
  t('H12 路由 batches 通道不可达 → 503', rh.code === 503);
  mockChannel.nodeOnline = nodeOnlineOrig;
  // 非 token 幂等键 → 400（不签名、不下发）
  const rBadIdem = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'bad:key' }),
    { device_id: DEV, command: 'sys.info', params: {} });
  t('路由 execute 非 token 幂等键 → 400', rBadIdem.code === 400);
  // params 非对象 → 400（数组／标量不得签出）
  const rArrParams = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-arr-params' }),
    { device_id: DEV, command: 'sys.info', params: [] });
  t('路由 execute 数组 params → 400', rArrParams.code === 400);
  // request_id 非 token → 400（不得 buildEnvelope 抛错变 500）
  const rBadReq = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-bad-reqid', 'x-qfr-request-id': 'bad:req' }),
    { device_id: DEV, command: 'sys.info', params: {} });
  t('路由 execute 非 token request_id → 400', rBadReq.code === 400);
  // 批量：128 字符基础幂等键加 '-N' 后缀超限 → 400；120 字符放行
  const rBatchLong = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'i'.repeat(128) }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }] });
  t('路由 batches 128 字符基础幂等键 → 400（后缀留长）', rBatchLong.code === 400);
  const rBatchOk = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'i'.repeat(120) }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }] });
  t('路由 batches 120 字符基础幂等键 → 200', rBatchOk.code === 200);
  // 批量某步 params 非对象 → 400
  const rBatchBadParams = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-badp' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: [] }] });
  t('路由 batches 步 params 数组 → 400', rBatchBadParams.code === 400);
  // timeout_ms 显式非法 → 400（不得 clamp 成合法值再签名）
  const rTmo0 = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-tmo-zero' }),
    { device_id: DEV, command: 'sys.info', params: {}, timeout_ms: 0 });
  t('路由 execute timeout_ms=0 → 400', rTmo0.code === 400);
  const rTmoOver = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-tmo-over' }),
    { device_id: DEV, command: 'sys.info', params: {}, timeout_ms: 999999 });
  t('路由 execute timeout_ms 超上限 → 400', rTmoOver.code === 400);
  const rTmoOk = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-tmo-ok' }),
    { device_id: DEV, command: 'sys.info', params: {}, timeout_ms: 5000 });
  t('路由 execute timeout_ms=5000 → 200', rTmoOk.code === 200);
  const rBatchTmo0 = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-tmo0' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {}, timeout_ms: 0 }] });
  t('路由 batches 步 timeout_ms=0 → 400', rBatchTmo0.code === 400);
  const rBatchTmoOver = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-tmoover' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {}, timeout_ms: 99999 }] });
  t('路由 batches 步 timeout_ms 超上限 → 400', rBatchTmoOver.code === 400);
  // timeout_ms: null 是显式非法值，不得回退默认值（DS 复查 round 4 返修）
  const rTmoNull = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-tmo-null' }),
    { device_id: DEV, command: 'sys.info', params: {}, timeout_ms: null });
  t('路由 execute timeout_ms null → 400', rTmoNull.code === 400);
  const rBatchTmoNull = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-tmonull' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {}, timeout_ms: null }] });
  t('路由 batches 步 timeout_ms null → 400', rBatchTmoNull.code === 400);
  // 查 job（归属校验：他人 job 查不到）
  const jobId = r.obj.job_id;
  r = await callRoute('GET', '/api/lea/v1/jobs/' + jobId, bearerHeaders(g6.key));
  t('路由查 job 200', r.code === 200 && r.obj.job.job_id === jobId);
  core.grantMuse(OTHER, 'owner'); // T07：bob 建 Key 前先授权，否则盖上的 grant_epoch 为 0
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
  // H26/QF-33/三端入口：吊销立即生效——吊销后该 Key 调 execute 一律 401。
  const doomed = core.generateKey(USER, { device_scope: DEV });
  r = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(doomed.key), { 'idempotency-key': 'route-revoked-before' }),
    { device_id: DEV, command: 'sys.info', params: {} });
  t('吊销前 Key 可调用 execute', r.code === 200);
  r = await callRoute('POST', '/api/lea/v1/keys/' + doomed.record.key_id + '/revoke', {}, {});
  t('路由吊销待验 Key 200', r.code === 200 && r.obj.record.status === 'revoked');
  r = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(doomed.key), { 'idempotency-key': 'route-revoked-after' }),
    { device_id: DEV, command: 'sys.info', params: {} });
  t('吊销后同一 Key 调 execute → 401 QFR_API_KEY_REVOKED', r.code === 401 && r.obj.code === 'QFR_API_KEY_REVOKED');
  // 授权接口非站长 → 403
  r = await callRoute('POST', '/api/lea/v1/grants', {}, { account_id: USER, action: 'grant' });
  t('路由 grants 非站长 → 403', r.code === 403);
  // 非 LEA 路径不匹配
  const nm = await routes.handle(mkReq('GET', '/api/device/presence', {}), mkRes());
  t('非 LEA 路径返回 false（不拦截既有路由）', nm === false);

  // ---------- 13) 票据签发：recordBinding 与 rebind 路由（S2） ----------
  const rb = core.recordBinding(DEV, USER, 'test-ticket');
  t('recordBinding 返回可验签的票据', !!rb.ticket && core.verifyTicket(rb.ticket) === true);
  t('recordBinding 票据 account/device/epoch 一致',
    rb.ticket.account_id === USER && rb.ticket.device_id === DEV && rb.ticket.binding_epoch === rb.binding_epoch);
  t('recordBinding 票据 grant 与当前授权一致', rb.ticket.grant_muse_execute === 1 && rb.ticket.scopes === 'muse.execute');
  t('recordBinding 票据 lease_id 形如 lease-+16 hex', /^lease-[0-9a-f]{16}$/.test(rb.ticket.lease_id));
  t('recordBinding 票据 24h 过期', rb.ticket.expires_at - Math.floor(Date.now() / 1000) > 23 * 3600
    && rb.ticket.expires_at - Math.floor(Date.now() / 1000) <= 24 * 3600);
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/rebind', {}, { account_id: USER });
  t('路由 rebind 200 且返回可验签票据', r.code === 200 && !!r.obj.ticket && core.verifyTicket(r.obj.ticket) === true);

  // ---------- 14) C 组：T07 Key 绑 grant_epoch／H22 epoch 不跳 0／H21 吊销推送 ----------
  // 用独立账号/设备，避免干扰前面的共享状态。
  const DEV2 = 'node//test-device-2';
  const USER2 = 'dave';
  core.recordBinding(DEV2, USER2, 'test-t07');
  core.grantMuse(USER2, 'owner');
  // T07：授权后生成的 Key 可用；撤销授权 → 拒绝；重授予后旧 Key 仍拒绝
  // （不复活），新 Key 可用。（授权前生成的 Key 盖上的 grant_epoch 为 0，
  // admit 按授权撤销拒绝。）
  const postGrant = core.generateKey(USER2, { device_scope: DEV2 });
  let adm14 = core.admit({ key: core.findKeyById(postGrant.record.key_id), deviceId: DEV2, command: 'ui.click' });
  t('T07 授权后生成的 Key 准入通过', adm14.ok === true);
  // 撤销授权 → 拒绝；重授予后旧 Key 仍拒绝（不复活），新 Key 可用
  core.revokeGrant(USER2, 'owner');
  adm14 = core.admit({ key: core.findKeyById(postGrant.record.key_id), deviceId: DEV2, command: 'ui.click' });
  t('T07 撤销授权后旧 Key → 403 QFR_GRANT_REVOKED', adm14.ok === false && adm14.code === 'QFR_GRANT_REVOKED');
  core.grantMuse(USER2, 'owner');
  adm14 = core.admit({ key: core.findKeyById(postGrant.record.key_id), deviceId: DEV2, command: 'ui.click' });
  t('T07 撤销后重授予旧 Key 仍拒绝（不复活）', adm14.ok === false && adm14.code === 'QFR_GRANT_REVOKED');
  const postRegrant = core.generateKey(USER2, { device_scope: DEV2 });
  adm14 = core.admit({ key: core.findKeyById(postRegrant.record.key_id), deviceId: DEV2, command: 'ui.click' });
  t('T07 重授予后新生成的 Key 准入通过', adm14.ok === true);
  // 重复 grant 不动 epoch（在用 Key 不被误废）
  const epochBefore = core.getGrant(USER2).grant_epoch;
  core.grantMuse(USER2, 'owner');
  t('T07 在效授权上重复 grant 不递增 grant_epoch', core.getGrant(USER2).grant_epoch === epochBefore);
  adm14 = core.admit({ key: core.findKeyById(postRegrant.record.key_id), deviceId: DEV2, command: 'ui.click' });
  t('T07 重复 grant 后在用 Key 仍可准入', adm14.ok === true);
  // H22：绑定前生成的 Key（binding_epoch 0），绑定后按不匹配拒绝
  const preBind = core.generateKey(USER2, { device_scope: 'node//test-device-3' });
  core.recordBinding('node//test-device-3', USER2, 'test-h22');
  const adm22 = core.admit({ key: core.findKeyById(preBind.record.key_id), deviceId: 'node//test-device-3', command: 'ui.click' });
  t('H22 binding_epoch 0 的 Key 绑定后 → 409 QFR_BINDING_CHANGED', adm22.ok === false && adm22.code === 'QFR_BINDING_CHANGED');
  // H21：吊销记入推送台账；下发时先同步写本机文件，写成功后不再重复推
  const rvKey = core.generateKey(USER2, { device_scope: DEV2 });
  core.revokeKey(rvKey.record.key_id, USER2, 'test-h21');
  let snap = core.getRevocations(DEV2);
  t('H21 吊销后推送台账含该 key_id', snap.revoked_key_ids.includes(rvKey.record.key_id) && snap.revocation_epoch >= 1 && snap.pushed_epoch === 0);
  calls.length = 0;
  const env21 = core.buildEnvelope({
    requestId: 'req-h21-1', batchId: null, seq: 1, deviceId: DEV2, accountId: USER2,
    keyId: postRegrant.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-h21-1',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d21 = await core.dispatchEnvelope(mockChannel, env21, { timeoutMs: 5000 });
  const syncCalls = calls.filter((c) => c.cmd.includes('revoked_keys.txt'));
  t('H21 下发前先同步本机吊销表（写 revoked_keys.txt）', d21.ok === true && syncCalls.length === 1);
  const syncB64 = syncCalls[0].cmd.match(/FromBase64String\('([^']+)'\)/)[1];
  const syncText = Buffer.from(syncB64, 'base64').toString('utf8');
  t('H21 同步文件内容为吊销 key_id 全集（每行一个）', syncText.split('\n').filter(Boolean).includes(rvKey.record.key_id));
  snap = core.getRevocations(DEV2);
  t('H21 同步成功后 pushed_epoch 追上 revocation_epoch', snap.pushed_epoch === snap.revocation_epoch);
  calls.length = 0;
  const env21b = core.buildEnvelope({
    requestId: 'req-h21-2', batchId: null, seq: 1, deviceId: DEV2, accountId: USER2,
    keyId: postRegrant.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-h21-2',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d21b = await core.dispatchEnvelope(mockChannel, env21b, { timeoutMs: 5000 });
  t('H21 已同步后下次下发不再重复写吊销表', d21b.ok === true && calls.filter((c) => c.cmd.includes('revoked_keys.txt')).length === 0);
  // H21：同步失败不拦本次命令（admit 是第一层），下次重试
  const flaky = { async runCommand(nodeId, cmd) { if (cmd.includes('revoked_keys.txt')) throw new Error('nope'); return JSON.stringify({ ok: true, code: 'done' }); }, async nodeOnline() { return true; } };
  const rvKey2 = core.generateKey(USER2, { device_scope: DEV2 });
  core.revokeKey(rvKey2.record.key_id, USER2, 'test-h21b');
  const env21c = core.buildEnvelope({
    requestId: 'req-h21-3', batchId: null, seq: 1, deviceId: DEV2, accountId: USER2,
    keyId: postRegrant.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-h21-3',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d21c = await core.dispatchEnvelope(flaky, env21c, { timeoutMs: 5000 });
  snap = core.getRevocations(DEV2);
  t('H21 吊销同步失败不拦下发且 pushed_epoch 不动（下次重试）', d21c.ok === true && snap.pushed_epoch < snap.revocation_epoch);
  // H21：路由 GET revocations 返回台账快照；换绑响应带 revocations 快照
  r = await callRoute('GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV2) + '/revocations', bearerHeaders(postRegrant.key));
  t('H21 路由 GET revocations 200 且含已吊销 key_id', r.code === 200 && Array.isArray(r.obj.revoked_key_ids) && r.obj.revoked_key_ids.includes(rvKey.record.key_id));
  // 用 alice 自己的 DEV（其台账含 §6 撤销授权时记入的 g5），断言快照在位。
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/rebind', {}, { account_id: USER });
  t('H21 路由 rebind 200 且带 revocations 快照', r.code === 200 && r.obj.revocations && Array.isArray(r.obj.revocations.revoked_key_ids) && r.obj.revocations.revoked_key_ids.includes(g5.record.key_id));

  // ---------- 12) 审计不含 Key 明文 ----------
  const auditText = fs.readdirSync(tmpDir).filter((f) => f.startsWith('audit-'))
    .map((f) => fs.readFileSync(path.join(tmpDir, f), 'utf8')).join('\n');
  t('审计日志不含任何已生成 Key 的明文', ![gen.key, gen2.key, g5.key, g6.key].some((k) => auditText.includes(k)));
  t('审计文件已生成', auditText.includes('lea-key-generated'));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '；失败 ' + fail + (failures.length ? '：' + failures.join('；') : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
