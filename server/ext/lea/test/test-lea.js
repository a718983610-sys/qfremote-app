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
const { createLeaChannel, bareNodeId, nodeMatchesId } = require('../lea-channel');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; failures.push(name); console.log('FAIL-', name, extra ? String(extra).slice(0, 300) : ''); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-'));
const core = createLeaCore({ dir: tmpDir, enableSweeps: false, whitelist: ['node//test-device-1', 'node//test-device-2', 'node//test-device-3', 'node//never-bound', 'node//other'] });
// 注：never-bound／other 须在白名单内，§3／§11 的断言才能走到绑定／scope
// 分支（白名单检查在 ③⑥ 之前，否则先报 NOT_WHITELISTED）。
core.grantMuse('alice', 'owner'); // H06：生成 Key 须先有授权；§1 的生成依赖此授权
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
// H06（并行线已落地）：生成 Key 须先有 muse.execute 授权——先建立绑定＋
// 授权再建 Key；§3 会再次确认同一状态（同账号重复绑定／重复 grant 不动 epoch）。
core.recordBinding(DEV, USER, 'test-login');
core.grantMuse(USER, 'owner');
const gen = core.generateKey(USER, { device_scope: DEV });
t('Key 格式 qfr_lea_+43 位 base64url', /^qfr_lea_[A-Za-z0-9_-]{43}$/.test(gen.key));
t('key_id 形如 k_+10 字符', /^k_[a-z0-9]{10}$/.test(gen.record.key_id));
const keysFile = fs.readFileSync(path.join(tmpDir, 'keys.json'), 'utf8');
t('台账不存 Key 明文', !keysFile.includes(gen.key));
t('台账存 salt+hash（无明文可逆字段）', /"salt":\s*"[0-9a-f]{32}"/.test(keysFile) && /"hash":\s*"[0-9a-f]{64}"/.test(keysFile));
t('列表不显明文，只显前缀脱敏', gen.record.prefix.includes('…') && !gen.record.prefix.includes(gen.key.slice(12)));
// T04：新 Key 的 prefix 存的是 12 位明文前缀的 SHA-256 指纹（16 位 hex），
// 不是明文；台账里不得出现 12 位明文前缀本身。
t('T04 新 Key prefix 为 16 位 hex 指纹（非明文）', /^[0-9a-f]{8}…[0-9a-f]{4}$/.test(gen.record.prefix));
t('T04 台账不含 12 位明文前缀', !keysFile.includes(gen.key.slice(0, 12)));
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
// 与 grant_epoch；绑定前生成的 Key（binding_epoch 0）准入时按不匹配拒绝。
// （授权前生成的 Key 已由 H06 在生成时直接拒绝，此处不再单列。）
const genBound = core.generateKey(USER, { device_scope: DEV });
let adm = core.admit({ key: core.findKeyById(genBound.record.key_id), deviceId: DEV, command: 'ui.click' });
t('绑定+授权齐全 → 准入通过', adm.ok === true);
// scope：device_scope 不一致
const genOther = core.generateKey(USER, { device_scope: 'node//other-device' });
adm = core.admit({ key: core.findKeyById(genOther.record.key_id), deviceId: DEV, command: 'ui.click' });
t('device_id 与 Key 绑定不一致 → 403 QFR_SCOPE_DENIED', adm.ok === false && adm.status === 403 && adm.code === 'QFR_SCOPE_DENIED');
// 未授权账号：H06 之后无授权建不出 Key——先授 carol、换绑、建 Key，再撤销
// 授权，准入应报授权已撤销（NOT_AUTHORIZED 分支只对“从无授权记录”的手工
// Key 可达，generateKey 建不出来，见 H06）。
core.grantMuse('carol', 'owner');
core.recordBinding(DEV, 'carol', 'test-login-carol'); // 换绑到 carol：alice 的旧 Key 应随之失效（见 §7.4，下组断言）
const genNoGrant = core.generateKey('carol', { device_scope: DEV });
core.revokeGrant('carol', 'owner');
adm = core.admit({ key: core.findKeyById(genNoGrant.record.key_id), deviceId: DEV, command: 'ui.click' });
t('账号授权已撤销 → 403 QFR_GRANT_REVOKED', adm.ok === false && adm.code === 'QFR_GRANT_REVOKED');
// 未绑定设备（用显式未绑定设备域的 Key，免得先触发 SCOPE_DENIED；
  // DC-A-1：device_scope 为空的 Key 现由 generateKey 自动取设备，
  // 此处须显式给未绑定设备域才能走到 NOT_BOUND 分支）
core.grantMuse('carol', 'owner'); // 重新授予，genNoScope 才能建出
const genNoScope = core.generateKey('carol', { device_scope: 'node//never-bound' });
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

// ---------- 6b) H04 白名单 + H06 Key 生成门 ----------
adm = core.admit({ key: core.findKeyById(g5.record.key_id), deviceId: 'node//not-whitelisted', command: 'ui.click' });
t('H04 白名单外设备 → 403 QFR_DEVICE_NOT_WHITELISTED', adm.ok === false && adm.status === 403 && adm.code === 'QFR_DEVICE_NOT_WHITELISTED');
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-wl-'));
  fs.writeFileSync(path.join(dir2, 'whitelist.json'), JSON.stringify({ devices: [DEV] }));
  const coreWl = createLeaCore({ dir: dir2, enableSweeps: false });
  coreWl.grantMuse(USER, 'owner');
  coreWl.recordBinding(DEV, USER, 'test');
  const gWl = coreWl.generateKey(USER, { device_scope: DEV });
  const admWl = coreWl.admit({ key: coreWl.findKeyById(gWl.record.key_id), deviceId: DEV, command: 'ui.click' });
  t('H04 whitelist.json 内设备准入通过', admWl.ok === true);
  const admWl2 = coreWl.admit({ key: coreWl.findKeyById(gWl.record.key_id), deviceId: 'node//other', command: 'ui.click' });
  t('H04 whitelist.json 外设备 → 403 QFR_DEVICE_NOT_WHITELISTED', admWl2.ok === false && admWl2.code === 'QFR_DEVICE_NOT_WHITELISTED');
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-wl2-'));
  const coreNoWl = createLeaCore({ dir: dir3, enableSweeps: false });
  coreNoWl.grantMuse(USER, 'owner');
  coreNoWl.recordBinding(DEV, USER, 'test');
  const gNoWl = coreNoWl.generateKey(USER, { device_scope: DEV });
  const admNoWl = coreNoWl.admit({ key: coreNoWl.findKeyById(gNoWl.record.key_id), deviceId: DEV, command: 'ui.click' });
  t('H04 无白名单配置时 admit 拒绝（fail-closed）', admNoWl.ok === false && admNoWl.code === 'QFR_DEVICE_NOT_WHITELISTED');
  // 归一化：白名单全形条目＋调用方裸形 id（P2-02 真跑 execute 时的形态）
  {
    const BARE = 'test-device-1'; // DEV 的裸形
    // 正向：白名单文件存全形条目，裸形 deviceId＋全形 scope 的 Key 准入通过
    const dirN = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-wl-norm-'));
    fs.writeFileSync(path.join(dirN, 'whitelist.json'), JSON.stringify({ devices: [DEV] }));
    const coreN = createLeaCore({ dir: dirN, enableSweeps: false });
    coreN.grantMuse(USER, 'owner');
    coreN.recordBinding(BARE, USER, 'test-norm');
    const gN = coreN.generateKey(USER, { device_scope: DEV });
    const admN = coreN.admit({ key: coreN.findKeyById(gN.record.key_id), deviceId: BARE, command: 'ui.click' });
    t('归一化 白名单全形条目＋裸形 deviceId＋全形 scope → 准入通过', admN.ok === true);
    // 反向：白名单文件存裸形条目，全形 deviceId＋裸形 scope 的 Key 准入通过
    const dirN2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-wl-norm2-'));
    fs.writeFileSync(path.join(dirN2, 'whitelist.json'), JSON.stringify({ devices: [BARE] }));
    const coreN2 = createLeaCore({ dir: dirN2, enableSweeps: false });
    coreN2.grantMuse(USER, 'owner');
    coreN2.recordBinding(BARE, USER, 'test-norm2');
    const gN2 = coreN2.generateKey(USER, { device_scope: BARE });
    const admN2 = coreN2.admit({ key: coreN2.findKeyById(gN2.record.key_id), deviceId: DEV, command: 'ui.click' });
    t('归一化 白名单裸形条目＋全形 deviceId＋裸形 scope → 准入通过', admN2.ok === true);
    // isWhitelisted 直接比对：双向命中＋空／退化 id 永不命中
    t('归一化 isWhitelisted 裸形命中全形条目', coreN.isWhitelisted(BARE) === true);
    t('归一化 isWhitelisted 全形命中裸形条目', coreN2.isWhitelisted(DEV) === true);
    t('归一化 空 deviceId 永不在白名单', coreN.isWhitelisted('') === false);
    t('归一化 裸形为空的 node// 永不在白名单', coreN.isWhitelisted('node//') === false);
    const dirN3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-wl-norm3-'));
    fs.writeFileSync(path.join(dirN3, 'whitelist.json'), JSON.stringify({ devices: ['node//', ''] }));
    const coreN3 = createLeaCore({ dir: dirN3, enableSweeps: false });
    t('归一化 退化白名单条目（node//／空串）不放行真设备', coreN3.isWhitelisted(DEV) === false && coreN3.isWhitelisted(BARE) === false);
    // getBinding 双向命中：全形查到裸形入账的绑定
    t('归一化 getBinding 全形查到裸形入账的绑定', coreN.getBinding(DEV) !== null && coreN.getBinding(DEV).account_id === USER);
    t('归一化 getBinding 裸形查到裸形入账的绑定', coreN.getBinding(BARE) !== null && coreN.getBinding(BARE).account_id === USER);
    // 换绑吊销横扫双向：全形 scope 旧 Key 在裸形 rebind 时被吊销，反向亦然
    const gR = coreN.generateKey(USER, { device_scope: DEV });
    coreN.recordBinding(BARE, OTHER, 'rebind-norm');
    t('归一化 裸形 rebind 吊销全形 scope 的旧 Key', coreN.keyStatus(coreN.findKeyById(gR.record.key_id)) === 'revoked_by_rebind');
    const gR2 = coreN2.generateKey(USER, { device_scope: BARE });
    coreN2.recordBinding(DEV, OTHER, 'rebind-norm2');
    t('归一化 全形 rebind 吊销裸形 scope 的旧 Key', coreN2.keyStatus(coreN2.findKeyById(gR2.record.key_id)) === 'revoked_by_rebind');
  }
}
// H06：无授权账号生成 Key 拒绝
let threwNoGrant = null;
try { core.generateKey('nobody-no-grant', { device_scope: DEV }); } catch (e) { threwNoGrant = e; }
t('H06 无 muse.execute 授权生成 Key → 抛 QFR_MUSE_NOT_AUTHORIZED', !!threwNoGrant && threwNoGrant.code === 'QFR_MUSE_NOT_AUTHORIZED');
// H06：自助选 dangerous scope 拒绝
let threwDg = null;
try { core.generateKey(USER, { device_scope: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] }); } catch (e) { threwDg = e; }
t('H06 无 dangerous 授权自选 dangerous scope → 抛 QFR_SCOPE_DENIED', !!threwDg && threwDg.code === 'QFR_SCOPE_DENIED');
// H06：站长授 dangerous 后可生成；撤销授权后 dangerous 一并失效
core.grantMuse(USER, 'owner', { dangerous: true });
t('H06 站长授 dangerous 后 hasDangerousGrant 为真', core.hasDangerousGrant(USER) === true);
const gDg = core.generateKey(USER, { device_scope: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
t('H06 有 dangerous 授权可生成 dangerous scope Key', gDg.record.scopes.includes('muse.execute.dangerous'));
core.revokeGrant(USER, 'owner');
t('H06 撤销授权后 dangerous 授权失效', core.hasDangerousGrant(USER) === false);
core.grantMuse(USER, 'owner'); // 恢复（不带 dangerous）供后续测试
t('H06 重授（不带 dangerous）后 dangerous 仍无', core.hasDangerousGrant(USER) === false);
// H07 第二轮（DS #8）：admit 要求绑定 state==='ACTIVE'，PENDING 时报
// BINDING_PENDING；服务端侧同账号重绑直接置 ACTIVE、epoch 不变，故服务端
// 侧旧 Key 无中断窗口；PENDING 只存在于 C 端本地（login_changed 后至
// binding.confirm 前），其间本地不执行，confirm 后恢复 ACTIVE，旧 Key
// 无须重新生成。以下三断言锁死该契约（新 Key 在重授后生成，防旧 epoch 干扰）。
const gRelogin = core.generateKey(USER, { device_scope: DEV });
let admRelogin = core.admit({ key: core.findKeyById(gRelogin.record.key_id), deviceId: DEV, command: 'ui.click' });
t('H07 同账号重登前旧 Key 准入通过', admRelogin.ok === true);
const bBeforeRelogin = core.getBinding(DEV);
const bRelogin = core.recordBinding(DEV, USER, 'test-h07-relogin');
t('H07 同账号重登服务端绑定仍 ACTIVE 且 epoch 不变',
  bRelogin.binding_epoch === bBeforeRelogin.binding_epoch && core.getBinding(DEV).state === 'ACTIVE');
admRelogin = core.admit({ key: core.findKeyById(gRelogin.record.key_id), deviceId: DEV, command: 'ui.click' });
t('H07 同账号重登后旧 Key 准入仍通过', admRelogin.ok === true);

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
  t('H14 失联 job 的幂等键转 UNKNOWN（重试不再卡 409）', core.idemLookup(USER, g5.record.key_id, 'idem-stale-1', core.IDEM_NS.EXEC).status === 'UNKNOWN');
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

  // ---------- T27/T28：nodeOnline 未知态与 TLS 校验 ----------
  // FakeWS：捕获构造参数（T28），按 FakeWS.nodesReply 回 nodes（T27）。
  class FakeWS {
    constructor(url, opts) {
      FakeWS.lastUrl = url; FakeWS.lastOpts = opts;
      this.handlers = {};
      setImmediate(() => this.emit('message', JSON.stringify({ action: 'userinfo' })));
    }
    on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); }
    emit(ev, d) { for (const cb of (this.handlers[ev] || [])) cb(d); }
    send(s) {
      const m = JSON.parse(s);
      setImmediate(() => this.emit('message', JSON.stringify(
        { action: 'nodes', responseid: m.responseid, nodes: FakeWS.nodesReply })));
    }
    close() {}
  }
  FakeWS.nodesReply = [];
  const _envUser = process.env.QFR_LEA_SVC_USER, _envPass = process.env.QFR_LEA_SVC_PASS, _envUrl = process.env.QFR_LEA_MC_URL;
  process.env.QFR_LEA_SVC_USER = 'svc'; process.env.QFR_LEA_SVC_PASS = 'pw';
  async function mkCh(mcUrl) {
    process.env.QFR_LEA_MC_URL = mcUrl;
    return createLeaChannel({ log: () => {}, WebSocketCtor: FakeWS });
  }
  const ch27 = await mkCh('wss://127.0.0.1:8443');
  FakeWS.nodesReply = [{ _id: DEV, conn: 1 }];
  t('T27 nodeOnline conn=1 → true', (await ch27.nodeOnline(DEV)) === true);
  FakeWS.nodesReply = [{ _id: DEV, conn: 0 }];
  t('T27 nodeOnline conn=0 → false', (await ch27.nodeOnline(DEV)) === false);
  FakeWS.nodesReply = [{ _id: DEV }];
  t('T27 nodeOnline 无 conn → null（未知，不谎称在线）', (await ch27.nodeOnline(DEV)) === null);
  FakeWS.nodesReply = [{ _id: 'node//other', conn: 1 }];
  t('T27 nodeOnline 不在清单 → false', (await ch27.nodeOnline(DEV)) === false);
  // r5：裸 id 归一——客户端只认裸 id（windows/devices.js bareNodeId），
  // 服务端比对前须去 node// 前缀，否则可见节点仍 404。
  t('bareNodeId 去 node// 前缀', bareNodeId('node//abc') === 'abc' && bareNodeId('abc') === 'abc' && bareNodeId('') === '' && bareNodeId(null) === '');
  t('nodeMatchesId 全形／裸形均命中', nodeMatchesId({ _id: DEV, conn: 1 }, DEV) === true && nodeMatchesId({ _id: DEV, conn: 1 }, 'test-device-1') === true);
  t('nodeMatchesId 空目标／空节点永不匹配', nodeMatchesId({ _id: DEV, conn: 1 }, '') === false && nodeMatchesId({}, 'test-device-1') === false && nodeMatchesId(null, DEV) === false);
  FakeWS.nodesReply = [{ _id: DEV, conn: 1 }];
  t('T27 nodeOnline 裸 id → true', (await ch27.nodeOnline('test-device-1')) === true);
  FakeWS.nodesReply = [{ _id: 'node//other', conn: 1 }];
  t('T27 nodeOnline 裸 id 不在清单 → false', (await ch27.nodeOnline('test-device-1')) === false);
  t('T28 回环 mcUrl 仍放宽证书校验', !!(FakeWS.lastOpts && FakeWS.lastOpts.rejectUnauthorized === false));
  t('T28 回环判定 helper：127.0.0.1/localhost 真、公网/非法假',
    ch27._test.mcUrlIsLoopback('wss://127.0.0.1:8443') === true
    && ch27._test.mcUrlIsLoopback('wss://localhost:8443') === true
    && ch27._test.mcUrlIsLoopback('wss://mc.example.com:8443') === false
    && ch27._test.mcUrlIsLoopback('not-a-url') === false);
  const ch28 = await mkCh('wss://mc.example.com:8443');
  try { await ch28.nodeOnline(DEV); } catch (e) {}
  t('T28 非回环 mcUrl 强制校验证书', !!(FakeWS.lastOpts && FakeWS.lastOpts.rejectUnauthorized === true));
  if (_envUser === undefined) delete process.env.QFR_LEA_SVC_USER; else process.env.QFR_LEA_SVC_USER = _envUser;
  if (_envPass === undefined) delete process.env.QFR_LEA_SVC_PASS; else process.env.QFR_LEA_SVC_PASS = _envPass;
  if (_envUrl === undefined) delete process.env.QFR_LEA_MC_URL; else process.env.QFR_LEA_MC_URL = _envUrl;

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
  t('H13 步级幂等键已写入 idemSeen', core.idemLookup(USER, g6.record.key_id, 'route-batch-1-1', core.IDEM_NS.STEP) !== null
    && core.idemLookup(USER, g6.record.key_id, 'route-batch-1-1', core.IDEM_NS.STEP).status === 'SUCCEEDED'
    && core.idemLookup(USER, g6.record.key_id, 'route-batch-1-2', core.IDEM_NS.STEP).status === 'SUCCEEDED');
  // H13：含失败步的批次终态 FAILED（不谎称 SUCCEEDED）
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-badstep' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'no.such', params: {} }] });
  t('H13 含失败步的批次终态 FAILED', rh.code === 200 && rh.obj.status === 'FAILED');
  // H13（DS 复查）：UNKNOWN 重试时 steps 指纹不一致 → 步级缓存不复用
  const fpSteps = [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }];
  const fpMatch = crypto.createHash('sha256').update(JSON.stringify(fpSteps)).digest('hex');
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp', { status: 'UNKNOWN', job_id: 'job_fp', steps_fp: 'different-fingerprint' }, core.IDEM_NS.BATCH);
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp-1', { status: 'SUCCEEDED', job_id: 'job_fp', result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp-2', { status: 'SUCCEEDED', job_id: 'job_fp', result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  const callsBeforeFp = calls.length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-fp' }),
    { device_id: DEV, steps: fpSteps });
  t('H13 指纹不一致时不复用步级缓存（全部重跑）', rh.code === 200 && rh.obj.status === 'SUCCEEDED'
    && calls.length === callsBeforeFp + 2 && !(rh.obj.results || []).some((x) => x.duplicate));
  // 指纹一致 → 复用已成功步
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp2', { status: 'UNKNOWN', job_id: 'job_fp2', steps_fp: fpMatch }, core.IDEM_NS.BATCH);
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp2-1', { status: 'SUCCEEDED', job_id: 'job_fp2', result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp2-2', { status: 'SUCCEEDED', job_id: 'job_fp2', result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
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
  core.grantMuse(OTHER, 'owner'); // H06：bob 建 Key 须先有授权
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
  r = await callRoute('POST', '/api/lea/v1/keys/' + victim.record.key_id + '/revoke', {}, { password: 'correct-password' });
  t('路由吊销单个 Key 200', r.code === 200 && r.obj.record.status === 'revoked');
  r = await callRoute('POST', '/api/lea/v1/keys/revoke-all', {}, { password: 'correct-password' });
  t('路由一键吊销全部 200', r.code === 200 && r.obj.revoked_count >= 1);
  // H26/QF-33/三端入口：吊销立即生效——吊销后该 Key 调 execute 一律 401。
  const doomed = core.generateKey(USER, { device_scope: DEV });
  r = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(doomed.key), { 'idempotency-key': 'route-revoked-before' }),
    { device_id: DEV, command: 'sys.info', params: {} });
  t('吊销前 Key 可调用 execute', r.code === 200);
  r = await callRoute('POST', '/api/lea/v1/keys/' + doomed.record.key_id + '/revoke', {}, { password: 'correct-password' });
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
    rb.ticket.account_id === USER && rb.ticket.device_id === core.bareNodeId(DEV) && rb.ticket.binding_epoch === rb.binding_epoch);
  t('recordBinding 票据 grant 与当前授权一致', rb.ticket.grant_muse_execute === 1 && rb.ticket.scopes === 'muse.execute');
  t('recordBinding 票据 lease_id 形如 lease-+16 hex', /^lease-[0-9a-f]{16}$/.test(rb.ticket.lease_id));
  t('recordBinding 票据 24h 过期', rb.ticket.expires_at - Math.floor(Date.now() / 1000) > 23 * 3600
    && rb.ticket.expires_at - Math.floor(Date.now() / 1000) <= 24 * 3600);
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/rebind', {}, { account_id: USER });
  t('路由 rebind 200 且返回可验签票据', r.code === 200 && !!r.obj.ticket && core.verifyTicket(r.obj.ticket) === true);
  // H07 第二轮：票据九字段锁死——C 端 binding.confirm 经 lea_parse_ticket
  // 读的正是这九个顶层字段，服务端少一个字段钩子就送不出有效票据。
  t('H07 rebind 票据含全部九字段', !!r.obj.ticket && ['account_id', 'device_id', 'binding_epoch', 'grant_epoch', 'grant_muse_execute', 'scopes', 'lease_id', 'expires_at', 'ticket_signature'].every((k) => k in r.obj.ticket));

  // ---------- 14) C 组：T07 Key 绑 grant_epoch／H22 epoch 不跳 0／H21 吊销推送 ----------
  // 用独立账号/设备，避免干扰前面的共享状态。
  const DEV2 = 'node//test-device-2';
  const USER2 = 'dave';
  core.recordBinding(DEV2, USER2, 'test-t07');
  core.grantMuse(USER2, 'owner');
  // T07：授权后生成的 Key 可用；撤销授权 → 拒绝；重授予后旧 Key 仍拒绝
  // （不复活），新 Key 可用。（授权前生成 Key 的情形已由 H06 在生成时
  // 直接拒绝，此处不再单列。）
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
  // H05 之后非站长只能换绑自己的设备：用 alice 自己的 DEV（其台账含 §6
  // 撤销授权时记入的 g5），断言快照在位。
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/rebind', {}, { account_id: USER });
  t('H21 路由 rebind 200 且带 revocations 快照', r.code === 200 && r.obj.revocations && Array.isArray(r.obj.revocations.revoked_key_ids) && r.obj.revocations.revoked_key_ids.includes(g5.record.key_id));

  // ---------- #1 版本化（B-补线）：generation 单调／推送携带／回包携带／不回退 ----------
  // 未知设备 generation 为 0；旧台账（只有 revocation_epoch）读时归一。
  t('#1 未知设备 generation 为 0', core.getRevocations('node//never-bound').generation === 0);
  const genBefore = core.getRevocations(DEV2).generation;
  const rvKey3 = core.generateKey(USER2, { device_scope: DEV2 });
  core.revokeKey(rvKey3.record.key_id, USER2, 'test-gen');
  const snapGen = core.getRevocations(DEV2);
  t('#1 generation 随吊销变更单调 +1', snapGen.generation === genBefore + 1 && snapGen.revocation_epoch === snapGen.generation);
  t('#1 pushed_generation 与 pushed_epoch 别名一致', snapGen.pushed_generation === snapGen.pushed_epoch);
  // 推送命令携带 generation 门（写世代文件＋陈旧判断），内容仍为全集。
  calls.length = 0;
  const envGen = core.buildEnvelope({
    requestId: 'req-h21-gen-1', batchId: null, seq: 1, deviceId: DEV2, accountId: USER2,
    keyId: postRegrant.record.key_id, bindingEpoch: 1, idempotencyKey: 'idem-h21-gen-1',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const dGen = await core.dispatchEnvelope(mockChannel, envGen, { timeoutMs: 5000 });
  const syncGen = calls.filter((c) => c.cmd.includes('revoked_keys.txt'));
  t('#1 H21 推送命令携带 generation 门', dGen.ok === true && syncGen.length === 1 &&
    syncGen[0].cmd.includes('revoked_keys.gen') && syncGen[0].cmd.includes('$incoming=' + snapGen.generation) &&
    syncGen[0].cmd.includes('-lt $cur') && syncGen[0].cmd.includes('Move($tmpGen, $genFile)'));
  const syncGenB64 = syncGen[0].cmd.match(/FromBase64String\('([^']+)'\)/)[1];
  t('#1 世代推送内容仍为吊销全集', Buffer.from(syncGenB64, 'base64').toString('utf8').split('\n').filter(Boolean).includes(rvKey3.record.key_id));
  t('#1 推送成功后 pushed_generation 追上 generation', core.getRevocations(DEV2).pushed_generation === snapGen.generation);
  // 无 generation 即拒绝（fail-closed，不发无版本直写）。
  let genThrew = false;
  try { core.leaRevocationsWriteCmd('QUJD'); } catch (e) { genThrew = true; }
  t('#1 leaRevocationsWriteCmd 缺 generation 即抛错', genThrew);
  genThrew = false;
  try { core.leaRevocationsWriteCmd('QUJD', -1); } catch (e) { genThrew = true; }
  t('#1 leaRevocationsWriteCmd 负 generation 即抛错', genThrew);
  t('#1 leaRevocationsWriteCmd 带 generation 生成带门命令', core.leaRevocationsWriteCmd('QUJD', 3).includes('$incoming=3'));
  // 不回退：台账文件被旧备份覆盖后，已发出的 generation 不往下发（用后恢复）。
  const revocFile = path.join(tmpDir, 'revocations.json');
  const revocOrig = fs.readFileSync(revocFile, 'utf8');
  const rolledBack = JSON.parse(revocOrig);
  rolledBack.devices[DEV2] = { revoked_key_ids: [], generation: 0, revocation_epoch: 0, pushed_generation: 0, pushed_epoch: 0, updated_at: 0 };
  fs.writeFileSync(revocFile, JSON.stringify(rolledBack));
  t('#1 台账回滚后 getRevocations 的 generation 不回退', core.getRevocations(DEV2).generation >= snapGen.generation);
  fs.writeFileSync(revocFile, revocOrig);
  t('#1 台账恢复后 generation 仍为原值', core.getRevocations(DEV2).generation === snapGen.generation);
  // rebind 回包顶层附带 generation 且与快照一致（测试路由的 consoleAuth
  // 恒为 alice，只可换绑自己的 DEV）。
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/rebind', {}, { account_id: USER });
  t('#1 rebind 回包附带 revocation_generation 且与快照一致', r.code === 200 && r.obj.revocation_generation === r.obj.revocations.generation && Number.isSafeInteger(r.obj.revocation_generation));

  // ---------- 12) 审计不含 Key 明文 ----------
  const auditText = fs.readdirSync(tmpDir).filter((f) => f.startsWith('audit-'))
    .map((f) => fs.readFileSync(path.join(tmpDir, f), 'utf8')).join('\n');
  t('审计日志不含任何已生成 Key 的明文', ![gen.key, gen2.key, g5.key, g6.key].some((k) => auditText.includes(k)));
  t('审计文件已生成', auditText.includes('lea-key-generated'));

  // ---------- 14) H05 换绑归属／可见性 + H06 路由层 Key 门 + H07 epoch 协调 ----------
  // H05：未知设备换绑 → 404
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent('node//ghost') + '/rebind', {}, { account_id: USER });
  t('H05 路由 rebind 未知设备 → 404', r.code === 404);
  // H05：设备已绑他人时非站长换绑 → 403
  core.recordBinding(DEV, OTHER, 'test-h05-setup');
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/rebind', {}, { account_id: USER });
  t('H05 路由 rebind 他人设备 → 403', r.code === 403);
  // H05：站长可换绑
  const adminRoutes = createLeaRoutes(core, mockChannel, {
    sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
    readJsonBody: async (req) => req._body || {},
    log: () => {},
    verifyPassword: async (u, p) => p === 'correct-password',
    resolveConsoleAuth: async () => ({ user: '718983610', siteadmin: 1 }),
    isSiteAdmin: (a) => a.user === '718983610',
  });
  async function callAdminRoute(method, url, headers, body) {
    sent.length = 0;
    const req = mkReq(method, url, headers, body);
    const res = mkRes();
    const matched = await adminRoutes.handle(req, res);
    return { matched, code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
  }
  r = await callAdminRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/rebind', {}, { account_id: USER });
  t('H05 路由 rebind 站长换绑他人设备 → 200', r.code === 200 && r.obj.account_id === USER);
  // H05：换绑回自己（已绑自己）→ 200
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/rebind', {}, { account_id: USER });
  t('H05 路由 rebind 已绑自己的设备 → 200', r.code === 200);
  // r5：rebind 用裸 id 也须 200（客户端 resolveOwnNodeId 只给裸 id；
  // 修前服务端只比全形 _id，裸 id 即使节点可见也 404）。
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent('test-device-1') + '/rebind', {}, { account_id: USER });
  t('H05 路由 rebind 裸 id → 200', r.code === 200 && r.obj.account_id === USER);
  r = await callRoute('POST', '/api/lea/v1/devices/' + encodeURIComponent('ghost') + '/rebind', {}, { account_id: USER });
  t('H05 路由 rebind 裸 id 未知设备 → 404', r.code === 404);
  // H07：rebind 传回 LEA epoch 只许向前
  const rbEpoch = core.recordBinding('node//epoch-dev', USER, 'test-h07-epoch', { bindingEpoch: 99 });
  t('H07 recordBinding 接受 LEA epoch（向前）', rbEpoch.binding_epoch === 99);
  const rbEpoch2 = core.recordBinding('node//epoch-dev', USER, 'test-h07-epoch2', { bindingEpoch: 5 });
  t('H07 recordBinding epoch 永不倒退', rbEpoch2.binding_epoch === 99);
  // H06 路由：自选 dangerous scope → 403（device_id 明示：DC-A-1 后无 device_id 时按绑定设备数自动取／拒绝）
  r = await callRoute('POST', '/api/lea/v1/keys', {}, { password: 'correct-password', device_id: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
  t('H06 路由生成 dangerous scope Key（无审批）→ 403', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  // H06 路由：站长授 dangerous 后可生成
  r = await callAdminRoute('POST', '/api/lea/v1/grants', {}, { account_id: USER, action: 'grant', dangerous: true });
  t('H06 路由站长授 dangerous → 200 且带 dangerous', r.code === 200 && r.obj.dangerous === true);
  r = await callRoute('POST', '/api/lea/v1/keys', {}, { password: 'correct-password', device_id: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
  t('H06 路由生成 dangerous scope Key（已审批）→ 200', r.code === 200 && !!r.obj.key && r.obj.record.scopes.includes('muse.execute.dangerous'));

  // ---------- 15) L-B 低组：T04 旧前缀迁移／T10 key_id 唯一／T30 单 Key
  // 吊销二次确认／T21 调用方读 LEA_DEGRADED（静态接线守卫） ----------
  // T04：旧记录的 12 位明文前缀在读到时一次迁移为指纹并落盘。
  {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-legacy-'));
    const legacyCore = createLeaCore({ dir: legacyDir, enableSweeps: false });
    legacyCore.grantMuse(USER, 'owner');
    const legacyKey = legacyCore.generateKey(USER, { device_scope: DEV });
    const legacyKeysPath = path.join(legacyDir, 'keys.json');
    const legacyPlainPrefix = legacyKey.key.slice(0, 12);
    const legacySt = JSON.parse(fs.readFileSync(legacyKeysPath, 'utf8'));
    legacySt.keys[0].prefix = legacyPlainPrefix; // 模拟旧版落盘的明文前缀
    fs.writeFileSync(legacyKeysPath, JSON.stringify(legacySt, null, 2));
    const legacyList = legacyCore.listKeys(USER); // 读即触发迁移
    const legacyAfter = fs.readFileSync(legacyKeysPath, 'utf8');
    t('T04 旧明文前缀读到即迁移为 16 位 hex 指纹', /^[0-9a-f]{16}$/.test(JSON.parse(legacyAfter).keys[0].prefix));
    t('T04 迁移后台账不再含旧明文前缀', !legacyAfter.includes(legacyPlainPrefix));
    t('T04 迁移后列表仍只显指纹脱敏', /^[0-9a-f]{8}…[0-9a-f]{4}$/.test(legacyList[0].prefix));
  }
  // T10：连续生成 20 个 Key，key_id 全部唯一（碰撞即重新生成）。
  core.grantMuse(USER, 'owner');
  {
    const ids = new Set();
    for (let i = 0; i < 20; i++) ids.add(core.generateKey(USER, { device_scope: DEV }).record.key_id);
    t('T10 连续生成 20 个 Key 的 key_id 全部唯一', ids.size === 20);
  }
  // T30：单 Key 吊销须密码二次确认（与吊销全部同口径）。
  {
    const t30 = core.generateKey(USER, { device_scope: DEV });
    r = await callRoute('POST', '/api/lea/v1/keys/' + t30.record.key_id + '/revoke', {}, {});
    t('T30 路由吊销单个 Key 无密码 → 400', r.code === 400);
    r = await callRoute('POST', '/api/lea/v1/keys/' + t30.record.key_id + '/revoke', {}, { password: 'wrong' });
    t('T30 路由吊销单个 Key 密码错误 → 401', r.code === 401);
    r = await callRoute('POST', '/api/lea/v1/keys/' + t30.record.key_id + '/revoke', {}, { password: 'correct-password' });
    t('T30 路由吊销单个 Key 密码正确 → 200', r.code === 200 && r.obj.record.status === 'revoked');
  }
  // T21：调用方显式读 LEA_DEGRADED／报告。Windows 提权脚本在沙箱跑不了
  // 真机，此处作静态接线守卫（接线被删即失败）；真机行为见阿里冒烟。
  {
    const repoRoot = path.join(__dirname, '..', '..', '..', '..');
    const sysSvcPs1 = fs.readFileSync(path.join(repoRoot, 'windows', 'install-system-services.ps1'), 'utf8');
    t('T21 wrapper 读 LEA_DEGRADED 标记并记明确失败行', sysSvcPs1.includes('LEA_DEGRADED') && sysSvcPs1.includes('LEA install FAILED (degraded marker/report'));
    t('T21 wrapper 读 install-report.json', sysSvcPs1.includes('install-report.json'));
    const leaPs1 = fs.readFileSync(path.join(repoRoot, 'windows', 'install-lea.ps1'), 'utf8');
    t('T21 install-lea.ps1 失败返回 exit 1（5ad5bc6 口径：LEA 段失败非零，wrapper 自身仍 exit 0 不阻塞主程序）', leaPs1.includes('exit 1 # P2-02 问题 6'));
    const mainJs = fs.readFileSync(path.join(repoRoot, 'windows', 'main.js'), 'utf8');
    t('T21 main.js 补装后复核 LEA_DEGRADED（lea-degraded／lea-installed 日志）', mainJs.includes('system-services.lea-degraded') && mainJs.includes('system-services.lea-installed'));
  }

  // ---------- 12) DC-A 发版前兜底深查新发现 ----------
  // DC-A-1：控制台生成 Key 不传 device_id 时不得再发 binding_epoch 0 的死钥
  {
    const dirA1 = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-dca1-'));
    const coreA1 = createLeaCore({ dir: dirA1, enableSweeps: false, whitelist: [DEV, 'node//test-device-2'] });
    coreA1.grantMuse(USER, 'owner');
    coreA1.recordBinding(DEV, USER, 'dc-a1');
    const gA1 = coreA1.generateKey(USER, {});
    t('DC-A-1 无 device_scope 且恰绑 1 台 → 自动取该台', gA1.record.device_scope === coreA1.bareNodeId(DEV));
    t('DC-A-1 自动取设备后 binding_epoch 与绑定一致', gA1.record.binding_epoch === 1);
    const admA1 = coreA1.admit({ key: coreA1.findKeyById(gA1.record.key_id), deviceId: DEV, command: 'ui.click' });
    t('DC-A-1 自动取设备的 Key 准入通过（不再出生即死）', admA1.ok === true);
    coreA1.grantMuse('eve', 'owner');
    let threwNoDev = null;
    try { coreA1.generateKey('eve', {}); } catch (e) { threwNoDev = e; }
    t('DC-A-1 无绑定设备时生成 Key 拒绝（不发死钥）', !!threwNoDev && threwNoDev.code === 'QFR_DEVICE_SCOPE_REQUIRED' && threwNoDev.reason === 'no-device');
    coreA1.recordBinding('node//test-device-2', USER, 'dc-a1-2');
    let threwMulti = null;
    try { coreA1.generateKey(USER, {}); } catch (e) { threwMulti = e; }
    t('DC-A-1 绑定多台时生成 Key 须明示 device_id', !!threwMulti && threwMulti.code === 'QFR_DEVICE_SCOPE_REQUIRED' && threwMulti.reason === 'multi-device');
    // 路由层：控制台 UI 只发 {password}（不传 device_id），须 200 且自动取设备。
    // 主 core 里 alice 已绑 2 台（DEV＋node//epoch-dev），须用恰绑 1 台的新 core 验路由自动取；
    // 多台时路由应 400 并明示须选设备。
    const dir1r = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-dca1r-'));
    const core1r = createLeaCore({ dir: dir1r, enableSweeps: false, whitelist: [DEV, 'node//test-device-2'] });
    core1r.grantMuse(USER, 'owner');
    core1r.recordBinding(DEV, USER, 'dc-a1r');
    const routes1r = createLeaRoutes(core1r, mockChannel, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    async function callRoute1r(method, url, headers, body) {
      sent.length = 0;
      const req = mkReq(method, url, headers); req._body = body;
      await routes1r.handle(req, mkRes());
      return { code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
    }
    const rA1r = await callRoute1r('POST', '/api/lea/v1/keys', {}, { password: 'correct-password' });
    t('DC-A-1 路由生成 Key 不传 device_id → 200 且自动取唯一绑定设备',
      rA1r.code === 200 && !!rA1r.obj.key && rA1r.obj.record.device_scope === core1r.bareNodeId(DEV)
      && rA1r.obj.record.binding_epoch === core1r.getBinding(DEV).binding_epoch);
    core1r.recordBinding('node//test-device-2', USER, 'dc-a1r-2');
    const rA1m = await callRoute1r('POST', '/api/lea/v1/keys', {}, { password: 'correct-password' });
    t('DC-A-1 路由多设备不传 device_id → 400 明示须选设备',
      rA1m.code === 400 && rA1m.obj.code === 'QFR_DEVICE_SCOPE_REQUIRED' && /多台/.test(rA1m.obj.msg || ''));
  }
  // DC-A-3：设备状态／吊销快照只许归属账号或设备域 Key 读
  // （g6 已在 §11 被 revoke-all 吊销，须用新 Key；以下 DC-A-4 同）
  const gA = core.generateKey(USER, { device_scope: DEV });
  {
    core.recordBinding('node//test-device-2', 'carol', 'dc-a3');
    core.grantMuse('carol', 'owner');
    const gCarol = core.generateKey('carol', { device_scope: 'node//test-device-2' });
    r = await callRoute('GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/status', bearerHeaders(gCarol.key));
    t('DC-A-3 他人 Key 读设备状态 → 403', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
    r = await callRoute('GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/revocations', bearerHeaders(gCarol.key));
    t('DC-A-3 他人 Key 读吊销快照 → 403', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
    r = await callRoute('GET', '/api/lea/v1/devices/' + encodeURIComponent(DEV) + '/status', bearerHeaders(gA.key));
    t('DC-A-3 归属账号 Key 读设备状态 → 200', r.code === 200 && r.obj.account_id === USER);
    r = await callRoute('GET', '/api/lea/v1/devices/' + encodeURIComponent('node//test-device-2') + '/status', bearerHeaders(gCarol.key));
    t('DC-A-3 设备域 Key 读本设备状态 → 200', r.code === 200 && r.obj.device_id === 'node//test-device-2');
    // 归一化：device_scope 裸形＋URL 全形（及反向）均可见
    const gCarolBare = core.generateKey('carol', { device_scope: 'test-device-2' });
    r = await callRoute('GET', '/api/lea/v1/devices/' + encodeURIComponent('node//test-device-2') + '/status', bearerHeaders(gCarolBare.key));
    t('归一化 设备域 Key（裸形 scope）读全形 id 设备状态 → 200', r.code === 200 && r.obj.account_id === 'carol');
    r = await callRoute('GET', '/api/lea/v1/devices/' + encodeURIComponent('test-device-2') + '/status', bearerHeaders(gCarol.key));
    t('归一化 设备域 Key（全形 scope）读裸形 id 设备状态 → 200', r.code === 200 && r.obj.account_id === 'carol');
  }
  // DC-A-4：幂等命名空间隔离（单条／批量／批量步互不串槽）
  {
    core.idemRecord(USER, g6.record.key_id, 'dc-a4-1', { status: 'SUCCEEDED', result: { job_id: 'job_dca4_single' } }, core.IDEM_NS.EXEC);
    t('DC-A-4 单条缓存不被批量步查到', core.idemLookup(USER, g6.record.key_id, 'dc-a4-1', core.IDEM_NS.STEP) === null);
    core.idemRecord(USER, g6.record.key_id, 'dc-a4-1', { status: 'SUCCEEDED', result: { job_id: 'job_dca4_step' } }, core.IDEM_NS.STEP);
    t('DC-A-4 批量步缓存不被单条查到', (core.idemLookup(USER, g6.record.key_id, 'dc-a4-1', core.IDEM_NS.EXEC) || {}).result.job_id === 'job_dca4_single');
    core.idemRecord(USER, g6.record.key_id, 'dc-a4-legacy', { status: 'SUCCEEDED', result: { job_id: 'job_dca4_legacy' } });
    t('DC-A-4 旧版无命名空间条目仍可读（升级兼容）', (core.idemLookup(USER, g6.record.key_id, 'dc-a4-legacy', core.IDEM_NS.EXEC) || {}).result.job_id === 'job_dca4_legacy');
    // DC-A-4 负向（DS round 1 要求）：旧条目被 EXEC 查到后单向迁移，旧键删除；
    // 同键再写新 EXEC 条目不与旧条目冲突，STEP 查不到 EXEC 的条目。
    t('DC-A-4 迁移后旧键不再可读（单向迁移）', core.idemLookup(USER, g6.record.key_id, 'dc-a4-legacy') === null);
    core.idemRecord(USER, g6.record.key_id, 'dc-a4-legacy', { status: 'SUCCEEDED', result: { job_id: 'job_dca4_exec_new' } }, core.IDEM_NS.EXEC);
    t('DC-A-4 同键新 EXEC 写入覆盖迁移来的旧条目', (core.idemLookup(USER, g6.record.key_id, 'dc-a4-legacy', core.IDEM_NS.EXEC) || {}).result.job_id === 'job_dca4_exec_new');
    t('DC-A-4 同键新 EXEC 写入不被 STEP 查到', core.idemLookup(USER, g6.record.key_id, 'dc-a4-legacy', core.IDEM_NS.STEP) === null);
    const dispCount = () => calls.filter((c) => c.cmd.includes(' dispatch ')).length;
    r = await callRoute('POST', '/api/lea/v1/execute',
      Object.assign(bearerHeaders(gA.key), { 'idempotency-key': 'dc-a4r-1' }),
      { device_id: DEV, command: 'sys.info', params: {} });
    t('DC-A-4 单条 dc-a4r-1 执行成功', r.code === 200 && r.obj.ok === true);
    const before = dispCount();
    r = await callRoute('POST', '/api/lea/v1/batches',
      Object.assign(bearerHeaders(gA.key), { 'idempotency-key': 'dc-a4r-1' }),
      { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'sys.info', params: {} }] });
    t('DC-A-4 批量步不复用单条缓存（两步都真执行）', r.code === 200 && r.obj.status === 'SUCCEEDED'
      && (r.obj.results || []).every((x) => x.ok === true && !x.duplicate) && dispCount() - before === 2);
    r = await callRoute('POST', '/api/lea/v1/batches',
      Object.assign(bearerHeaders(gA.key), { 'idempotency-key': 'dc-a4b-01' }),
      { device_id: DEV, steps: [{ command: 'sys.info', params: {} }] });
    t('DC-A-4 批量 dc-a4b-01 执行成功', r.code === 200 && r.obj.status === 'SUCCEEDED');
    const before2 = dispCount();
    r = await callRoute('POST', '/api/lea/v1/execute',
      Object.assign(bearerHeaders(gA.key), { 'idempotency-key': 'dc-a4b-01' }),
      { device_id: DEV, command: 'sys.info', params: {} });
    t('DC-A-4 单条不复用批量缓存（真执行）', r.code === 200 && r.obj.duplicate !== true && dispCount() - before2 === 1);
  }
  // DC-A-5：批量取消后终态不得被在途步骤的超时／失败覆盖
  {
    const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-dca5-'));
    const core5 = createLeaCore({ dir: dir5, enableSweeps: false, whitelist: [DEV] });
    core5.grantMuse(USER, 'owner');
    core5.recordBinding(DEV, USER, 'dc-a5');
    const g5b = core5.generateKey(USER, { device_scope: DEV });
    let releaseSlow = null;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const slowChannel = {
      async runCommand() { await slowGate; throw new Error('slow-fail'); },
      async nodeOnline() { return true; },
      async listNodes() { return [{ _id: DEV, conn: 1 }]; },
    };
    const routes5 = createLeaRoutes(core5, slowChannel, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    async function callRoute5(method, url, headers, body) {
      sent.length = 0;
      const req = mkReq(method, url, headers, body);
      const res = mkRes();
      const matched = await routes5.handle(req, res);
      return { matched, code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
    }
    const batchP = callRoute5('POST', '/api/lea/v1/batches',
      Object.assign(bearerHeaders(g5b.key), { 'idempotency-key': 'dc-a5-batch-1' }),
      { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'sys.info', params: {} }] });
    // 等 job 建好（createJob 在首步下发前同步落盘），再取消
    let jobId5 = null;
    for (let i = 0; i < 100 && !jobId5; i++) {
      const js = core5._test.loadJobs().jobs || {};
      const found = Object.values(js).find((j) => j && j.idempotency_key === 'dc-a5-batch-1');
      if (found) jobId5 = found.job_id;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    t('DC-A-5 慢步骤批量建 job', !!jobId5);
    const rc = await callRoute5('POST', '/api/lea/v1/jobs/' + jobId5 + '/cancel', bearerHeaders(g5b.key), {});
    t('DC-A-5 在途取消 → 200 CANCELLED', rc.code === 200 && rc.obj.status === 'CANCELLED');
    releaseSlow(); // 在途步骤随即失败（旧实现会把 job 置 FAILED）
    const rb = await batchP;
    t('DC-A-5 取消后在途步骤失败，job 终态仍为 CANCELLED', core5.getJob(jobId5).status === 'CANCELLED' && rb.obj.status === 'CANCELLED');
  }

  console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '；失败 ' + fail + (failures.length ? '：' + failures.join('；') : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
