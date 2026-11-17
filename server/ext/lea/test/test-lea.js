'use strict';
/*
 * LEA 服务端单测（Stage 1 MVP）· Node 无依赖
 * 运行：node test/test-lea.js  （在 server/ext/lea/ 目录下，或任意目录）
 * 覆盖：Key 生成/吊销/换号失效、认证拒绝各码、签名验签（F-04：
 *   默认固定真实密钥；未配密钥默认 disabled，见文末 F-04 节）、
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
// F-04：全文件默认用固定真实测试密钥（mode='real'，与生产路径一致）；
// 未配密钥时 signing 默认 disabled（见文末 F-04 节），不再静默临时密钥。
const _f04kp = crypto.generateKeyPairSync('ed25519');
const _f04privDer = _f04kp.privateKey.export({ format: 'der', type: 'pkcs8' });
const _f04pubDer = _f04kp.publicKey.export({ format: 'der', type: 'spki' });
const testKeyFile = path.join(tmpDir, 'lea-test-key.b64');
fs.writeFileSync(testKeyFile, Buffer.concat([_f04privDer.subarray(-32), _f04pubDer.subarray(-32)]).toString('base64'));
const core = createLeaCore({ dir: tmpDir, enableSweeps: false, signingKeyFile: testKeyFile, whitelist: ['node//test-device-1', 'node//test-device-2', 'node//test-device-3', 'node//never-bound', 'node//other'] });
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

// RC-01：测试用握手识别——从 dispatch 命令的 base64 载荷里解出信封，
// 判断是否为 sys.handshake 下发。mock 通道据此让握手成功、业务按原剧本走；
// 计数断言须把握手下发滤掉（只计业务下发）。
function dispatchEnvelopeOf(cmd) {
  if (typeof cmd !== 'string' || !cmd.includes(' dispatch ')) return null;
  try {
    const b64 = cmd.trim().split(/\s+/).pop();
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) { return null; }
}
function isHandshakeDispatch(cmd) {
  const env = dispatchEnvelopeOf(cmd);
  return !!(env && env.command === 'sys.handshake');
}
const HANDSHAKE_OK_LINE = JSON.stringify({ ok: true, code: 'done', request_id: 'hs-ok', result: { handshake: 'ok' } });

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
  const coreWl = createLeaCore({ signingKeyFile: testKeyFile, dir: dir2, enableSweeps: false });
  coreWl.grantMuse(USER, 'owner');
  coreWl.recordBinding(DEV, USER, 'test');
  const gWl = coreWl.generateKey(USER, { device_scope: DEV });
  const admWl = coreWl.admit({ key: coreWl.findKeyById(gWl.record.key_id), deviceId: DEV, command: 'ui.click' });
  t('H04 whitelist.json 内设备准入通过', admWl.ok === true);
  const admWl2 = coreWl.admit({ key: coreWl.findKeyById(gWl.record.key_id), deviceId: 'node//other', command: 'ui.click' });
  t('H04 whitelist.json 外设备 → 403 QFR_DEVICE_NOT_WHITELISTED', admWl2.ok === false && admWl2.code === 'QFR_DEVICE_NOT_WHITELISTED');
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-wl2-'));
  const coreNoWl = createLeaCore({ signingKeyFile: testKeyFile, dir: dir3, enableSweeps: false });
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
    const coreN = createLeaCore({ signingKeyFile: testKeyFile, dir: dirN, enableSweeps: false });
    coreN.grantMuse(USER, 'owner');
    coreN.recordBinding(BARE, USER, 'test-norm');
    const gN = coreN.generateKey(USER, { device_scope: DEV });
    const admN = coreN.admit({ key: coreN.findKeyById(gN.record.key_id), deviceId: BARE, command: 'ui.click' });
    t('归一化 白名单全形条目＋裸形 deviceId＋全形 scope → 准入通过', admN.ok === true);
    // 反向：白名单文件存裸形条目，全形 deviceId＋裸形 scope 的 Key 准入通过
    const dirN2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-wl-norm2-'));
    fs.writeFileSync(path.join(dirN2, 'whitelist.json'), JSON.stringify({ devices: [BARE] }));
    const coreN2 = createLeaCore({ signingKeyFile: testKeyFile, dir: dirN2, enableSweeps: false });
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
    const coreN3 = createLeaCore({ signingKeyFile: testKeyFile, dir: dirN3, enableSweeps: false });
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

// ---------- 7) 签名验签（F-04：固定真实密钥，mode='real'） ----------
t('固定测试密钥 signing 模式为 real', core.signingInfo().mode === 'real');
const env = core.buildEnvelope({
  requestId: 'req-000001', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
  keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000001',
  command: 'ui.click', params: { x: 1 }, timeoutMs: 5000,
});
t('信封时间窗 expires-issued = 60s', env.expires_at - env.issued_at === 60);
t('信封签名可验', core.verifyEnvelope(env) === true);
const tampered = Object.assign({}, env, { command: 'script.run' });
t('篡改命令后验签失败', core.verifyEnvelope(tampered) === false);
t('信封带 signature 字段', typeof env.signature === 'string' && env.signature.length > 40);

// ---------- 7b) 规范串 v2（F-02，2026-11-14；与 C 单测同一向量） ----------
const VEC_ENV = {
  version: 2, request_id: 'req-0000001', batch_id: 'batch-0001', seq: 1,
  device_id: 'node-1', account_id: 'alice', api_key_id: 'key-abc12345',
  binding_epoch: 3, grant_epoch: 1, nonce: 'nonce-00001', issued_at: 1780000000, expires_at: 1780000060,
  idempotency_key: 'idem-key-0001', command: 'ui.click',
  params: { b: 2, a: 1 }, timeout_ms: 5000,
};
const VEC_ENVELOPE_CANONICAL = [
  'qfr-lea-envelope-v2', '2', 'req-0000001', 'batch-0001', '1', 'node-1', 'alice',
  'key-abc12345', '3', '1', 'nonce-00001', '1780000000', '1780000060', 'idem-key-0001',
  'ui.click', '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777', '5000',
  // B1：规范串 20 行（VEC_ENV 未设 job_id／mode／deadline_ms，缺省 ''／''／0）。
  '', '', '0',
].join('\n');
t('信封规范串 v2 与定稿向量字节相等', core.envelopeSigningBytes(VEC_ENV) === VEC_ENVELOPE_CANONICAL);
t('params 键序不同时规范串相同（归一化）',
  core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { params: { a: 1, b: 2 } })) === VEC_ENVELOPE_CANONICAL);
t('stableStringify 递归排序嵌套对象',
  core._test.stableStringify({ z: { b: 2, a: 1 }, a: [3, { d: 4, c: 3 }] }) === '{"a":[3,{"c":3,"d":4}],"z":{"a":1,"b":2}}');
// 线上形式：buildEnvelope 发出的 params 子串即 stable JSON
const wireEnv = core.buildEnvelope({
  requestId: 'req-vec-1', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
  keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-vec-1',
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
  ['grant_epoch', { grant_epoch: 2 }],
  ['idempotency_key', { idempotency_key: 'idem-key-9999' }],
  ['nonce', { nonce: 'nonce-99999' }],
  ['issued_at', { issued_at: 1780000001 }],
  ['expires_at', { expires_at: 1780000061 }],
]) {
  t('篡改 ' + name + ' 后验签失败', core.verifyEnvelope(Object.assign({}, signedVec, patch)) === false);
}
t('无 batch_id 时规范串对应行为空行',
  core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { batch_id: null })).split('\n')[3] === '');

// ---------- 7b-F02) 信封 v2：grant_epoch 入信封＋规范串＋严格表示 ----------
// 准入撤销语义由 §14 T07 覆盖（撤销授权后旧 Key → 403 QFR_GRANT_REVOKED，
// 重授予后旧 Key 仍拒绝）；此处锁死 v2 信封形态与 grant_epoch 表示规则。
t('F02 buildEnvelope 产出 version 2 且含 grant_epoch',
  env.version === 2 && env.grant_epoch === 1);
t('F02 规范串为 20 行、grant_epoch 在 binding_epoch 之后一行',
  core.envelopeSigningBytes(VEC_ENV).split('\n').length === 20
  && core.envelopeSigningBytes(VEC_ENV).split('\n')[8] === '3'
  && core.envelopeSigningBytes(VEC_ENV).split('\n')[9] === '1');
t('F02 规范串 LF 连接、无结尾换行、无 CR',
  !core.envelopeSigningBytes(VEC_ENV).includes('\r')
  && !core.envelopeSigningBytes(VEC_ENV).endsWith('\n'));
for (const [name, patch, inputPatch] of [
  ['envelopeSigningBytes version 1', { version: 1 }, null],
  ['envelopeSigningBytes grant_epoch 缺失', { grant_epoch: undefined }, null],
  ['envelopeSigningBytes grant_epoch 超安全整数', { grant_epoch: 2 ** 53 }, null],
  ['envelopeSigningBytes grant_epoch 负数', { grant_epoch: -1 }, null],
  ['envelopeSigningBytes grant_epoch 非整数', { grant_epoch: 1.5 }, null],
  ['envelopeSigningBytes 未知字段', { evil_field: 1 }, null],
]) {
  let bad = false;
  try { core.envelopeSigningBytes(Object.assign({}, VEC_ENV, patch)); } catch (e) { bad = true; }
  t('F02 ' + name + ' 抛错', bad === true);
}
for (const [name, grantEpoch] of [
  ['buildEnvelope grantEpoch 缺失', undefined],
  ['buildEnvelope grantEpoch 超安全整数', 2 ** 53],
  ['buildEnvelope grantEpoch 负数', -1],
  ['buildEnvelope grantEpoch 非整数', 1.5],
]) {
  let bad = false;
  try {
    core.buildEnvelope({
      requestId: 'req-f02-1', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch,
      idempotencyKey: 'idem-f02-1', command: 'ui.click', params: {}, timeoutMs: 5000,
    });
  } catch (e) { bad = true; }
  t('F02 ' + name + ' 抛错（不发信封）', bad === true);
}
t('F02 buildEnvelope grant_epoch 0 可签（显式 0 为合法表示，准入层再拦）',
  core.verifyEnvelope(core.buildEnvelope({
    requestId: 'req-f02-0', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 0,
    idempotencyKey: 'idem-f02-0', command: 'ui.click', params: {}, timeoutMs: 5000,
  })) === true);
// 含控制字符的字段拒绝签名（fail-closed，不产出签名）
let threw = false;
try {
  core.buildEnvelope({
    requestId: 'req-bad-1', batchId: null, seq: 1, deviceId: DEV, accountId: 'a\nb',
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-bad-1',
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
  keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000011',
  command: 'ui.click', params: intKeyParams, timeoutMs: 5000,
});
t('整数键信封签名可验', core.verifyEnvelope(intKeyEnv) === true);
t('整数键信封线上 params 子串哈希等于 stable 哈希',
  crypto.createHash('sha256').update(JSON.stringify(intKeyEnv.params), 'utf8').digest('hex')
    === crypto.createHash('sha256').update(core._test.stableStringify(intKeyParams), 'utf8').digest('hex'));
// timeout：缺失取默认，非法（0／负／超上限）抛错
t('timeout 缺失时规范串取命令默认值',
  core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { timeout_ms: undefined })).split('\n')[16] === '5000');
for (const [name, v] of [['timeout 0', 0], ['timeout 负数', -5], ['timeout 超上限 ui.click 60000', 60000], ['timeout 非整数', 1.5]]) {
  let bad = false;
  try { core.envelopeSigningBytes(Object.assign({}, VEC_ENV, { timeout_ms: v })); } catch (e) { bad = true; }
  t('envelopeSigningBytes ' + name + ' 抛错', bad === true);
}
// seq／版本／命令／id／token 严格校验
for (const [name, patch] of [
  ['seq 0', { seq: 0 }],
  ['seq 缺失', { seq: undefined }],
  ['version 1（v1 信封不再接受）', { version: 1 }],
  ['version 3', { version: 3 }],
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
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000012',
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
      keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000013',
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
      keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000014',
      command: 'ui.click', params: badParams, timeoutMs: 5000,
    });
  } catch (e) { bad = true; }
  t('buildEnvelope ' + name + ' 抛错', bad === true);
}
t('buildEnvelope params 缺失时取空对象',
  core.verifyEnvelope(core.buildEnvelope({
    requestId: 'req-000015', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000015',
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
      keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000016',
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
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000002',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d = await core.dispatchEnvelope(mockChannel, env2, { timeoutMs: 5000 });
  t('mock 下发成功', d.ok === true && d.result.code === 'done');
  // H21：此前 §5/§6 已吊销多把 Key，下发前会先同步一次本机吊销表
  // （powershell 写 revoked_keys.txt），故 calls[0] 是同步命令；下发命令
  // 须按“含 ' dispatch '”过滤出来断言（exe 路径带引号，'exe dispatch'
  // 连写匹配不上）。
  const dispAll = calls.filter((c) => c.cmd.includes(' dispatch '));
  const hs1 = dispAll.filter((c) => isHandshakeDispatch(c.cmd));
  const disp1 = dispAll.filter((c) => !isHandshakeDispatch(c.cmd));
  t('RC-01 业务下发前先有一次握手下发', hs1.length === 1 && calls.indexOf(hs1[0]) < calls.indexOf(disp1[0]));
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
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000003',
    command: 'ui.input', params: { text: 'x'.repeat(9000) }, timeoutMs: 5000,
  });
  const d2 = await core.dispatchEnvelope(mockChannel, bigEnv, { timeoutMs: 5000 });
  t('大信封下发成功', d2.ok === true);
  t('大信封走两步（写 inbox + apply）', calls.length === 2 && calls[0].cmd.includes('LEA\\inbox') && calls[1].cmd.includes('apply'));
  t('S3：apply 带 inbox 全路径（旧裸文件名会使客户端误发）', calls[1].cmd.includes('LEA\\inbox\\req-000003.json'));
  t('S3：写 inbox 路径与 apply 路径一致', calls[0].cmd.includes(core.leaInboxPath('req-000003.json')) && calls[1].cmd.includes(core.leaInboxPath('req-000003.json')));
  // 危险命令不自动重试：通道抛错只发一次（H21 同步命令不计入下发次数）
  calls.length = 0;
  const errChannel = { async runCommand(nodeId, cmd) { calls.push({ nodeId, cmd }); if (isHandshakeDispatch(cmd)) return HANDSHAKE_OK_LINE; throw new Error('boom'); }, async nodeOnline() { return true; } };
  const dangEnv = core.buildEnvelope({
    requestId: 'req-000004', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000004',
    command: 'script.run', params: {}, timeoutMs: 5000,
  });
  const d3 = await core.dispatchEnvelope(errChannel, dangEnv, { timeoutMs: 5000 });
  t('危险命令失败只尝试 1 次（禁自动重试）', d3.ok === false && calls.filter((c) => c.cmd.includes(' dispatch ') && !isHandshakeDispatch(c.cmd)).length === 1);
  // 普通命令失败重试 1 次（共 2 次）
  calls.length = 0;
  const normalEnv = core.buildEnvelope({
    requestId: 'req-000005', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-000005',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d4 = await core.dispatchEnvelope(errChannel, normalEnv, { timeoutMs: 5000 });
  t('普通命令失败重试 1 次（共 2 次）', d4.ok === false && calls.filter((c) => c.cmd.includes(' dispatch ') && !isHandshakeDispatch(c.cmd)).length === 2);

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
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-h15-1',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const dF = await core.dispatchEnvelope(failChannel, envF, { timeoutMs: 5000 });
  t('H15 dispatch 回 {ok:false} → 不成功', dF.ok === false);

  // ---------- r9：runcommands transcript 回包解析 ----------
  // r8 实证：runcommands 回包是整段控制台 transcript（banner＋回显命令
  // 行＋客户端 JSON 行＋尾部 "C:\...>exit" 提示行），旧 parse 只取末行
  // 恒为提示行 → API 四条全 502 bad-client-output，而 LEA 侧 click
  // 78ms 已成功。修法：逐行扫描取首个含布尔 ok 的 JSON 对象行。
  const TRANSCRIPT_OK = [
    'Microsoft Windows [Version 10.0.20348.5622]',
    '(c) Microsoft Corporation. All rights reserved.',
    '',
    'C:\\Program Files\\Mesh Agent>"C:\\Program Files\\QFR\\LEA\\qf-lea-client.exe" dispatch <b64>',
    JSON.stringify({ ok: true, code: 'done', request_id: 'req-r9-1', duration_ms: 78, result: { method: 'coordinate' } }),
    '',
    'C:\\Program Files\\Mesh Agent>exit',
    '',
  ].join('\r\n');
  t('r9 transcript 末行是提示行时仍解析出客户端 JSON', core.parseClientOutput(TRANSCRIPT_OK).ok === true);
  t('r9 transcript 解析结果与客户端 JSON 一致', core.parseClientOutput(TRANSCRIPT_OK).result.code === 'done');
  const TRANSCRIPT_FAIL = [
    'Microsoft Windows [Version 10.0.20348.5622]',
    'C:\\Program Files\\Mesh Agent>"C:\\Program Files\\QFR\\LEA\\qf-lea-client.exe" dispatch <b64>',
    JSON.stringify({ ok: false, code: 'QFR_USH_FAILED', request_id: 'req-r9-2', detail: 'PNG encode failed' }),
    'C:\\Program Files\\Mesh Agent>exit',
  ].join('\r\n');
  const pf = core.parseClientOutput(TRANSCRIPT_FAIL);
  t('r9 transcript 里 {ok:false} 判失败且带回真实 code', pf.ok === false && pf.clientResult && pf.clientResult.code === 'QFR_USH_FAILED');
  t('r9 只有 banner／提示行、无 JSON 行判失败', core.parseClientOutput('Microsoft Windows [Version 10.0.20348.5622]\r\nC:\\Program Files\\Mesh Agent>exit\r\n').ok === false);
  t('r9 JSON 数组行被跳过、其后对象行仍被解析', core.parseClientOutput('[1,2]\r\n' + JSON.stringify({ ok: true, code: 'done' }) + '\r\n').ok === true);
  // dispatch 层：transcript 首试即通，不重试
  const transcriptChannel = { async runCommand() { return TRANSCRIPT_OK; }, async nodeOnline() { return true; } };
  const envT = core.buildEnvelope({
    requestId: 'req-r9-1', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-r9-1',
    command: 'ui.click', params: { x: 500, y: 500 }, timeoutMs: 5000,
  });
  const dT = await core.dispatchEnvelope(transcriptChannel, envT, { timeoutMs: 5000 });
  t('r9 dispatch 解析 transcript 成功且只发 1 次', dT.ok === true && dT.attempts === 1);
  // dispatch 层：客户端 {ok:false} 不重试、透传真实 code
  const failTranscriptChannel = { async runCommand() { return TRANSCRIPT_FAIL; }, async nodeOnline() { return true; } };
  const envTF = core.buildEnvelope({
    requestId: 'req-r9-2', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-r9-2',
    command: 'ui.snapshot', params: {}, timeoutMs: 5000,
  });
  const dTF = await core.dispatchEnvelope(failTranscriptChannel, envTF, { timeoutMs: 5000 });
  t('r9 dispatch 回客户端失败不重试且透传 code', dTF.ok === false && dTF.attempts === 1 && dTF.clientResult && dTF.clientResult.code === 'QFR_USH_FAILED');
  // dispatch 层：传输层异常首次失败，重试换新信封（新 request_id／nonce，复用同一幂等键）后成功
  const seenDispatch = [];
  const flakyTranscript = {
    async runCommand(nodeId, cmd) {
      if (!cmd.includes(' dispatch ')) return '';
      seenDispatch.push(cmd);
      if (seenDispatch.length === 1) throw new Error('svc-down');
      return TRANSCRIPT_OK;
    },
    async nodeOnline() { return true; },
  };
  const envR = core.buildEnvelope({
    requestId: 'req-r9-3', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-r9-3',
    command: 'ui.tree', params: { max_depth: 2, max_nodes: 50 }, timeoutMs: 5000,
  });
  const dR = await core.dispatchEnvelope(flakyTranscript, envR, { timeoutMs: 5000 });
  const decR1 = JSON.parse(Buffer.from(seenDispatch[0].trim().split(/\s+/).pop(), 'base64').toString('utf8'));
  const decR2 = JSON.parse(Buffer.from(seenDispatch[1].trim().split(/\s+/).pop(), 'base64').toString('utf8'));
  t('r9 传输异常重试后成功', dR.ok === true && dR.attempts === 2 && seenDispatch.length === 2);
  t('r9 重试轮换 request_id／nonce 但复用同一幂等键（旧信封重发必撞 REPLAY_DETECTED；轮换幂等键会重复执行）',
    decR2.request_id === 'req-r9-3-r2' && decR2.idempotency_key === 'idem-r9-3' && decR2.nonce !== decR1.nonce && decR2.signature !== decR1.signature);
  // r9（DS 复核）：回包无 JSON 行时是否已执行未知，不自动重试（只发 1 次），防重复执行
  const seenGarbage = [];
  const garbageChannel = {
    async runCommand(nodeId, cmd) {
      if (!cmd.includes(' dispatch ')) return '';
      seenGarbage.push(cmd);
      return 'garbage-no-json\r\nC:\\Program Files\\Mesh Agent>exit\r\n';
    },
    async nodeOnline() { return true; },
  };
  const envG = core.buildEnvelope({
    requestId: 'req-r9-5', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-r9-5',
    command: 'ui.click', params: { x: 1, y: 1 }, timeoutMs: 5000,
  });
  const dG = await core.dispatchEnvelope(garbageChannel, envG, { timeoutMs: 5000 });
  t('r9 回包无 JSON 行不重试（只发 1 次）', dG.ok === false && dG.attempts === 1 && seenGarbage.length === 1);
  // dispatch 层：批量步不重试（同 seq 重发撞 batch-seq 单调性）
  const seenBatch = [];
  const batchFlaky = {
    async runCommand(nodeId, cmd) {
      if (!cmd.includes(' dispatch ')) return '';
      seenBatch.push(cmd);
      return 'garbage-no-json\r\n';
    },
    async nodeOnline() { return true; },
  };
  const envB = core.buildEnvelope({
    requestId: 'req-r9-4-1', batchId: 'batch_r9', seq: 1, deviceId: DEV, accountId: USER,
    keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-r9-4-1',
    command: 'ui.click', params: { x: 1, y: 1 }, timeoutMs: 5000,
  });
  const dB = await core.dispatchEnvelope(batchFlaky, envB, { timeoutMs: 5000 });
  t('r9 批量步坏回包不重试（只发 1 次）', dB.ok === false && seenBatch.length === 1);

  // ---------- H11：nonce／幂等落盘持久化（重启不丢） ----------
  core.idemRecord(USER, g5.record.key_id, 'idem-persist-1', { status: 'SUCCEEDED', result: { job_id: 'job_p1' } });
  core.nonceCheck(g5.record.key_id, 'persist-nonce-001');
  const core2 = createLeaCore({ signingKeyFile: testKeyFile, dir: tmpDir, enableSweeps: false });
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
  // FIX1：派生步级键 helper（与路由同款算法：基础键 + '-' + 步号 + '-' + 步指纹前 12 位）。
  function stepKeyFor(base, i, step) {
    return base + '-' + (i + 1) + '-' + crypto.createHash('sha256').update(JSON.stringify(step)).digest('hex').slice(0, 12);
  }
  function stepFpOf(step) { return crypto.createHash('sha256').update(JSON.stringify(step)).digest('hex'); }
  // batches 成功
  r = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-1' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }] });
  t('路由 batches 200 且两步完成', r.code === 200 && r.obj.status === 'SUCCEEDED' && (r.obj.results || []).length === 2);
  // 批量步级 request_id／幂等键用 '-' 连接步号（':' 不合 token 规则，C 端拒收）
  const batchB64 = calls[calls.length - 1].cmd.trim().split(/\s+/).pop();
  const batchEnv = JSON.parse(Buffer.from(batchB64, 'base64').toString('utf8'));
  t('批量步 request_id 用 - 连接且合 token 规则', /^[A-Za-z0-9_-]{8,128}$/.test(batchEnv.request_id) && batchEnv.request_id.endsWith('-2'));
  t('批量步幂等键用 - 连接且含步指纹（FIX1）', batchEnv.idempotency_key === stepKeyFor('route-batch-1', 1, { command: 'ui.snapshot', params: {} }));
  let rh;
  // H13：批量级幂等——重复提交返回缓存，不重跑步骤
  const callsBeforeDup = calls.length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-1' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }] });
  t('H13 路由 batches 重复提交返回缓存 duplicate', rh.code === 200 && rh.obj.duplicate === true && rh.obj.status === 'SUCCEEDED');
  t('H13 路由 batches 重复提交不重跑步骤', calls.length === callsBeforeDup);
  // H13：步级幂等键已写入 idemSeen（FIX1：派生键，含步指纹）
  t('H13 步级幂等键已写入 idemSeen', core.idemLookup(USER, g6.record.key_id, stepKeyFor('route-batch-1', 0, { command: 'sys.info', params: {} }), core.IDEM_NS.STEP) !== null
    && core.idemLookup(USER, g6.record.key_id, stepKeyFor('route-batch-1', 0, { command: 'sys.info', params: {} }), core.IDEM_NS.STEP).status === 'SUCCEEDED'
    && core.idemLookup(USER, g6.record.key_id, stepKeyFor('route-batch-1', 1, { command: 'ui.snapshot', params: {} }), core.IDEM_NS.STEP).status === 'SUCCEEDED');
  // H13：含失败步的批次终态 FAILED（不谎称 SUCCEEDED）
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-badstep' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'no.such', params: {} }] });
  t('H13 含失败步的批次终态 FAILED', rh.code === 200 && rh.obj.status === 'FAILED');
  // H13（DS 复查）：UNKNOWN 重试时 steps 指纹不一致 → 步级缓存不复用
  const fpSteps = [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }];
  const fpMatch = crypto.createHash('sha256').update(JSON.stringify(fpSteps)).digest('hex');
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp', { status: 'UNKNOWN', job_id: 'job_fp', steps_fp: 'different-fingerprint' }, core.IDEM_NS.BATCH);
  core.idemRecord(USER, g6.record.key_id, stepKeyFor('route-batch-fp', 0, fpSteps[0]), { status: 'SUCCEEDED', job_id: 'job_fp', step_fp: stepFpOf(fpSteps[0]), result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  core.idemRecord(USER, g6.record.key_id, stepKeyFor('route-batch-fp', 1, fpSteps[1]), { status: 'SUCCEEDED', job_id: 'job_fp', step_fp: stepFpOf(fpSteps[1]), result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  const callsBeforeFp = calls.length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-fp' }),
    { device_id: DEV, steps: fpSteps });
  t('H13 指纹不一致时不复用步级缓存（全部重跑）', rh.code === 200 && rh.obj.status === 'SUCCEEDED'
    && calls.length === callsBeforeFp + 2 && !(rh.obj.results || []).some((x) => x.duplicate));
  // 指纹一致 → 复用已成功步
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp2', { status: 'UNKNOWN', job_id: 'job_fp2', steps_fp: fpMatch }, core.IDEM_NS.BATCH);
  core.idemRecord(USER, g6.record.key_id, stepKeyFor('route-batch-fp2', 0, fpSteps[0]), { status: 'SUCCEEDED', job_id: 'job_fp2', step_fp: stepFpOf(fpSteps[0]), result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  core.idemRecord(USER, g6.record.key_id, stepKeyFor('route-batch-fp2', 1, fpSteps[1]), { status: 'SUCCEEDED', job_id: 'job_fp2', step_fp: stepFpOf(fpSteps[1]), result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  const callsBeforeFp2 = calls.length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-fp2' }),
    { device_id: DEV, steps: fpSteps });
  t('H13 指纹一致时复用步级缓存（不重跑）', rh.code === 200 && rh.obj.status === 'SUCCEEDED'
    && calls.length === callsBeforeFp2 && (rh.obj.results || []).every((x) => x.duplicate === true));
  // FIX1（batch1-fix1）：幂等键绑定不可变请求指纹——负向测试。
  function businessDispatches() {
    return calls.filter((c) => { const e = dispatchEnvelopeOf(c.cmd); return e && e.command !== 'sys.handshake'; });
  }
  // (a) 已 SUCCEEDED 的批次，同键换 steps 重提 → 409 指纹错配，不回旧结果、不重跑。
  // route-batch-1 已 SUCCEEDED（steps 为 [sys.info, ui.snapshot]）；换 steps 重提。
  const callsBeforeFix1a = calls.length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-1' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.tree', params: {} }] });
  t('FIX1 已成功批次同键换 steps → 409 指纹错配', rh.code === 409 && rh.obj.code === 'QFR_LEA_IDEMPOTENT_MISMATCH');
  t('FIX1 指纹错配不重跑步骤', calls.length === callsBeforeFix1a);
  // (b) 单条 execute 同键换命令 → 409 指纹错配，不回旧成功结果。
  // route-idem-1 已 SUCCEEDED（sys.info）；同键改发 ui.snapshot。
  r = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-idem-1' }),
    { device_id: DEV, command: 'ui.snapshot', params: {} });
  t('FIX1 单条同键换命令 → 409 指纹错配', r.code === 409 && r.obj.code === 'QFR_LEA_IDEMPOTENT_MISMATCH');
  // (c) UNKNOWN 批次换 steps 重试：不得沿用旧步级键，须以新步级键重跑。
  const fp3Steps = [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }];
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp3', { status: 'UNKNOWN', job_id: 'job_fp3', steps_fp: 'different-fingerprint' }, core.IDEM_NS.BATCH);
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp3-1', { status: 'SUCCEEDED', job_id: 'job_fp3', result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  core.idemRecord(USER, g6.record.key_id, 'route-batch-fp3-2', { status: 'SUCCEEDED', job_id: 'job_fp3', result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  const dispBeforeFp3 = businessDispatches().length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-batch-fp3' }),
    { device_id: DEV, steps: fp3Steps });
  const newKeysFp3 = businessDispatches().slice(dispBeforeFp3).map((c) => dispatchEnvelopeOf(c.cmd).idempotency_key);
  t('FIX1 UNKNOWN 换 steps 重试全部重跑', rh.code === 200 && rh.obj.status === 'SUCCEEDED'
    && newKeysFp3.length === 2 && !(rh.obj.results || []).some((x) => x.duplicate));
  t('FIX1 换 steps 后步级键不再沿用旧键', newKeysFp3.length === 2
    && newKeysFp3[0] !== 'route-batch-fp3-1' && newKeysFp3[1] !== 'route-batch-fp3-2'
    && newKeysFp3[0] === stepKeyFor('route-batch-fp3', 0, fp3Steps[0])
    && newKeysFp3[1] === stepKeyFor('route-batch-fp3', 1, fp3Steps[1]));
  // (d) 危险 UNKNOWN 不自动重试：上批 file.write 结果 UNKNOWN，同键同 steps 重提 →
  // 批次仍 UNKNOWN，危险步不下发（第 1 步安全步可复用缓存）。
  // gDg 是文件开头生成的旧 Key（授权代次已变）；且 dangerous 授权在 §1 末已被收回。
  // 此处站长重授 dangerous（在效授权上重复 grant 不动 epoch，g6 不受影响），再新生成一把危险 Key。
  core.grantMuse(USER, 'owner', { dangerous: true });
  const gDg2 = core.generateKey(USER, { device_scope: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
  const dgSteps = [{ command: 'sys.info', params: {} }, { command: 'file.write', params: { path: 'C:\\QFR\\t.txt', content: 'v1' } }];
  const dgStepsFp = crypto.createHash('sha256').update(JSON.stringify(dgSteps)).digest('hex');
  core.idemRecord(USER, gDg2.record.key_id, 'route-batch-dg', { status: 'UNKNOWN', job_id: 'job_dg', steps_fp: dgStepsFp, dangerous: true }, core.IDEM_NS.BATCH);
  core.idemRecord(USER, gDg2.record.key_id, stepKeyFor('route-batch-dg', 0, dgSteps[0]), { status: 'SUCCEEDED', job_id: 'job_dg', step_fp: stepFpOf(dgSteps[0]), result: { ok: true, code: 'done', nodeId: DEV } }, core.IDEM_NS.STEP);
  core.idemRecord(USER, gDg2.record.key_id, stepKeyFor('route-batch-dg', 1, dgSteps[1]), { status: 'UNKNOWN', job_id: 'job_dg', step_fp: stepFpOf(dgSteps[1]) }, core.IDEM_NS.STEP);
  const dispBeforeDg = businessDispatches().length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(gDg2.key), { 'idempotency-key': 'route-batch-dg' }),
    { device_id: DEV, steps: dgSteps });
  t('FIX1 危险 UNKNOWN 不自动重试（批次仍 UNKNOWN）', rh.code === 200 && rh.obj.status === 'UNKNOWN');
  t('FIX1 危险 UNKNOWN 重试不下发任何步骤', businessDispatches().length === dispBeforeDg);
  // (e) UNKNOWN 批次换 steps（含危险步）重试 → 整批 409 拒绝，不下发。
  const dg2OldSteps = [{ command: 'sys.info', params: {} }, { command: 'file.write', params: { path: 'C:\\QFR\\t.txt', content: 'v1' } }];
  core.idemRecord(USER, gDg2.record.key_id, 'route-batch-dg2', { status: 'UNKNOWN', job_id: 'job_dg2', steps_fp: crypto.createHash('sha256').update(JSON.stringify(dg2OldSteps)).digest('hex'), dangerous: true }, core.IDEM_NS.BATCH);
  const dispBeforeDg2 = businessDispatches().length;
  rh = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(gDg2.key), { 'idempotency-key': 'route-batch-dg2' }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'file.write', params: { path: 'C:\\QFR\\t.txt', content: 'v2' } }] });
  t('FIX1 UNKNOWN 换 steps 含危险步 → 409 拒绝自动重试', rh.code === 409 && rh.obj.code === 'QFR_LEA_EXECUTION_UNKNOWN');
  t('FIX1 该拒绝不下发任何步骤', businessDispatches().length === dispBeforeDg2);
  // (f) 单条危险命令上次 UNKNOWN → 409 拒绝自动重试。
  core.idemRecord(USER, gDg2.record.key_id, 'route-idem-dg', { status: 'UNKNOWN', job_id: 'job_dg1', dangerous: true }, core.IDEM_NS.EXEC);
  r = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(gDg2.key), { 'idempotency-key': 'route-idem-dg' }),
    { device_id: DEV, command: 'file.write', params: { path: 'C:\\QFR\\t.txt', content: 'v1' } });
  t('FIX1 单条危险 UNKNOWN 不自动重试 → 409', r.code === 409 && r.obj.code === 'QFR_LEA_EXECUTION_UNKNOWN');
  // 收尾：收回本块临时重授的 dangerous（恢复 H06 测试的前提：无审批时生成危险 Key 应 403；
  // 在效授权上重复 grant 不动 epoch，g6 不受影响）。
  core.grantMuse(USER, 'owner', { dangerous: false });
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
  // 批量：128 字符基础幂等键加后缀超限 → 400；113 字符放行（FIX1：步级后缀
  // 改为 '-N-<12 位步指纹>'，2 步时占 15 字符，113+15=128 恰好放行；114 字符 → 400）
  const rBatchLong = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'i'.repeat(128) }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }] });
  t('路由 batches 128 字符基础幂等键 → 400（后缀留长）', rBatchLong.code === 400);
  const rBatchOk = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'i'.repeat(113) }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }] });
  t('路由 batches 113 字符基础幂等键 → 200', rBatchOk.code === 200);
  const rBatchTooLong = await callRoute('POST', '/api/lea/v1/batches',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'i'.repeat(114) }),
    { device_id: DEV, steps: [{ command: 'sys.info', params: {} }, { command: 'ui.snapshot', params: {} }] });
  t('路由 batches 114 字符基础幂等键 → 400（FIX1 步指纹后缀）', rBatchTooLong.code === 400);
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
  // 查 job（归属校验：他人 job 查不到）——自给自足：现发一条成功命令取 job_id，
  // 不依赖前面某次调用残留的 r（FIX1 测试复用 r 会改写它）。
  const rJobOk = await callRoute('POST', '/api/lea/v1/execute',
    Object.assign(bearerHeaders(g6.key), { 'idempotency-key': 'route-job-lookup' }),
    { device_id: DEV, command: 'sys.info', params: {} });
  const jobId = rJobOk.obj.job_id;
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
    keyId: postRegrant.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-h21-1',
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
    keyId: postRegrant.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-h21-2',
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
    keyId: postRegrant.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-h21-3',
    command: 'sys.info', params: {}, timeoutMs: 5000,
  });
  const d21c = await core.dispatchEnvelope(flaky, env21c, { timeoutMs: 5000 });
  snap = core.getRevocations(DEV2);
  t('H21 吊销同步失败不拦下发且 pushed_epoch 不动（下次重试）', d21c.ok === true && snap.pushed_epoch < snap.revocation_epoch);
  // ---------- F-01：吊销同步失败时危险命令禁下发（分级门） ----------
  // 此时 DEV2 仍有未推送的吊销（rvKey2，pushed_epoch < revocation_epoch），
  // 同步一律失败。危险命令须被门拦住（0 次下发、明确错误、不重试）；
  // 非危险／sys.ping／sys.info／sys.reset 继续下发（admit 仍是第一层
  // 实时控制；sys.reset 是 B1 通道自愈的指定恢复命令、无执行载荷，
  // 且 COMMANDS 里它本就不是 dangerous）。同步成功时危险命令照常下发。
  const f01calls = [];
  const f01flaky = { async runCommand(nodeId, cmd) { f01calls.push({ nodeId, cmd }); if (cmd.includes('revoked_keys.txt')) throw new Error('nope'); return JSON.stringify({ ok: true, code: 'done' }); }, async nodeOnline() { return true; } };
  const f01env = (req, cmd) => core.buildEnvelope({
    requestId: req, batchId: null, seq: 1, deviceId: DEV2, accountId: USER2,
    keyId: postRegrant.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-' + req,
    command: cmd, params: {}, timeoutMs: 5000,
  });
  f01calls.length = 0;
  const dF01a = await core.dispatchEnvelope(f01flaky, f01env('req-f01-1', 'script.run'), { timeoutMs: 5000 });
  t('F-01 同步失败时危险命令 script.run 被拒（revocation-sync-failed，不下发）', dF01a.ok === false && dF01a.error && dF01a.error.message === 'revocation-sync-failed' && dF01a.revocationSyncBlocked === true && f01calls.filter((c) => c.cmd.includes(' dispatch ')).length === 0);
  f01calls.length = 0;
  const dF01b = await core.dispatchEnvelope(f01flaky, f01env('req-f01-2', 'file.write'), { timeoutMs: 5000 });
  t('F-01 同步失败时危险命令 file.write 被拒（不下发）', dF01b.ok === false && dF01b.error && dF01b.error.message === 'revocation-sync-failed' && f01calls.filter((c) => c.cmd.includes(' dispatch ')).length === 0);
  f01calls.length = 0;
  const dF01c = await core.dispatchEnvelope(f01flaky, f01env('req-f01-3', 'sys.info'), { timeoutMs: 5000 });
  t('F-01 同步失败时非危险命令 sys.info 继续下发', dF01c.ok === true && f01calls.filter((c) => c.cmd.includes(' dispatch ')).length === 1);
  f01calls.length = 0;
  const dF01d = await core.dispatchEnvelope(f01flaky, f01env('req-f01-4', 'sys.ping'), { timeoutMs: 5000 });
  t('F-01 同步失败时 sys.ping 继续下发', dF01d.ok === true && f01calls.filter((c) => c.cmd.includes(' dispatch ')).length === 1);
  f01calls.length = 0;
  const dF01e = await core.dispatchEnvelope(f01flaky, f01env('req-f01-5', 'sys.reset'), { timeoutMs: 5000 });
  t('F-01 同步失败时 sys.reset 继续下发（B1 恢复命令）', dF01e.ok === true && f01calls.filter((c) => c.cmd.includes(' dispatch ')).length === 1);
  f01calls.length = 0;
  const dF01f = await core.dispatchEnvelope(f01flaky, f01env('req-f01-6', 'ui.click'), { timeoutMs: 5000 });
  t('F-01 同步失败时非危险命令 ui.click 继续下发', dF01f.ok === true && f01calls.filter((c) => c.cmd.includes(' dispatch ')).length === 1);
  // 同步成功（mockChannel 推送成功）→ 危险命令照常下发，且 pushed 追上。
  calls.length = 0;
  const dF01g = await core.dispatchEnvelope(mockChannel, f01env('req-f01-7', 'script.run'), { timeoutMs: 5000 });
  t('F-01 同步成功时危险命令 script.run 照常下发', dF01g.ok === true && calls.filter((c) => c.cmd.includes(' dispatch ')).length === 1);
  t('F-01 同步成功后 pushed_epoch 追上 revocation_epoch', core.getRevocations(DEV2).pushed_epoch === core.getRevocations(DEV2).revocation_epoch);
  // R5（Q7 审阅第 7 点前置①）：同步失败放行 sys.reset 时记
  // lea-revocation-sync-degraded-allow（command／generation／reason 齐全）。
  // 主 core 未注入 log（默认 noop），故用带 log 捕获的独立 core 实例复现
  // 同一场景：吊销未推送＋写吊销表一律失败。只断言事件，不改分级门逻辑。
  const r5logs = [];
  const coreR5 = createLeaCore({ signingKeyFile: testKeyFile, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-r5-')), enableSweeps: false, whitelist: [DEV2], log: (e) => { r5logs.push(e); } });
  coreR5.recordBinding(DEV2, USER2, 'test-r5');
  coreR5.grantMuse(USER2, 'owner');
  const r5key = coreR5.generateKey(USER2, { device_scope: DEV2 });
  const r5rv = coreR5.generateKey(USER2, { device_scope: DEV2 });
  coreR5.revokeKey(r5rv.record.key_id, USER2, 'test-r5');
  const r5gen = coreR5.getRevocations(DEV2).generation;
  const r5flaky = { async runCommand(nodeId, cmd) { if (cmd.includes('revoked_keys.txt')) throw new Error('nope'); return JSON.stringify({ ok: true, code: 'done' }); }, async nodeOnline() { return true; } };
  const r5env = (req, cmd) => coreR5.buildEnvelope({
    requestId: req, batchId: null, seq: 1, deviceId: DEV2, accountId: USER2,
    keyId: r5key.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-' + req,
    command: cmd, params: {}, timeoutMs: 5000,
  });
  r5logs.length = 0;
  const dR5 = await coreR5.dispatchEnvelope(r5flaky, r5env('req-r5-1', 'sys.reset'), { timeoutMs: 5000 });
  const r5ev = r5logs.filter((e) => e && e.ev === 'lea-revocation-sync-degraded-allow');
  t('R5 同步失败放行 sys.reset 时记 lea-revocation-sync-degraded-allow（command／generation／reason 齐全）', dR5.ok === true && r5ev.length === 1 && r5ev[0].command === 'sys.reset' && r5ev[0].generation === r5gen && r5ev[0].reason === 'write-failed');
  const dR5b = await coreR5.dispatchEnvelope(r5flaky, r5env('req-r5-2', 'sys.info'), { timeoutMs: 5000 });
  t('R5 同步失败放行 sys.info 不记 degraded-allow（事件只针对 sys.reset）', dR5b.ok === true && r5logs.filter((e) => e && e.ev === 'lea-revocation-sync-degraded-allow').length === 1);
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
    keyId: postRegrant.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-h21-gen-1',
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
  const writeCmd3 = core.leaRevocationsWriteCmd('QUJD', 3);
  t('#1 leaRevocationsWriteCmd 含 binding.dat 历史判断', writeCmd3.includes("binding.dat") && writeCmd3.includes('$hasHistory'));
  t('#1 leaRevocationsWriteCmd 有历史只写表跳 .gen', writeCmd3.includes('$skipGen') && writeCmd3.includes('if (-not $skipGen)'));
  t('#1 leaRevocationsWriteCmd 无旧口径抛错文本', !writeCmd3.includes('explicit migration required'));
  t('#1 leaRevocationsWriteCmd 世代损坏仍抛错', writeCmd3.includes('revoked generation file corrupt'));
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
    const legacyCore = createLeaCore({ signingKeyFile: testKeyFile, dir: legacyDir, enableSweeps: false });
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
    t('T21 wrapper 读 LEA_DEGRADED 标记并记明确失败行', sysSvcPs1.includes('LEA_DEGRADED') && sysSvcPs1.includes('LEA install FAILED (install-lea exit='));
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
    const coreA1 = createLeaCore({ signingKeyFile: testKeyFile, dir: dirA1, enableSweeps: false, whitelist: [DEV, 'node//test-device-2'] });
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
    const core1r = createLeaCore({ signingKeyFile: testKeyFile, dir: dir1r, enableSweeps: false, whitelist: [DEV, 'node//test-device-2'] });
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
    const core5 = createLeaCore({ signingKeyFile: testKeyFile, dir: dir5, enableSweeps: false, whitelist: [DEV] });
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

  // ---------- B1：通道自愈（服务端） ----------
  {
    // 命令表：sys.ping／sys.reset 存在，tier 0，非危险；tier 与 C 端一致。
    t('B1 COMMANDS 有 sys.ping', !!core.COMMANDS['sys.ping']);
    t('B1 COMMANDS 有 sys.reset', !!core.COMMANDS['sys.reset']);
    t('B1 sys.ping tier 0 非危险', core.COMMANDS['sys.ping'].tier === 0 && core.COMMANDS['sys.ping'].dangerous === false);
    t('B1 sys.reset tier 0 非危险', core.COMMANDS['sys.reset'].tier === 0 && core.COMMANDS['sys.reset'].dangerous === false);
    t('B1 sys.ping／sys.reset scope 为 muse.execute', core.COMMANDS['sys.ping'].scope === 'muse.execute' && core.COMMANDS['sys.reset'].scope === 'muse.execute');
    t('B1 tier 与 C 端一致（file.write 2／script.run 2／sys.info 0／ui.click 1）',
      core.COMMANDS['file.write'].tier === 2 && core.COMMANDS['script.run'].tier === 2 &&
      core.COMMANDS['sys.info'].tier === 0 && core.COMMANDS['ui.click'].tier === 1);
    t('B1 DISPATCH_TIMEOUT_MS 为 8000', core.DISPATCH_TIMEOUT_MS === 8000);
    // buildEnvelope B1 字段
    const bePing = core.buildEnvelope({
      requestId: 'req-b1-ping', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-b1-ping',
      command: 'sys.ping', params: {}, timeoutMs: 5000,
    });
    t('B1 buildEnvelope job_id 缺省即 request_id', bePing.job_id === 'req-b1-ping');
    t('B1 buildEnvelope sys.ping mode 为 sync', bePing.mode === 'sync');
    t('B1 buildEnvelope sys.ping deadline 为 min(5000,8000)=5000', bePing.deadline_ms === 5000);
    const beRun = core.buildEnvelope({
      requestId: 'req-b1-run', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-b1-run',
      command: 'script.run', params: {}, timeoutMs: 30000,
    });
    t('B1 buildEnvelope script.run mode 为 async', beRun.mode === 'async');
    t('B1 buildEnvelope script.run deadline 为 min(30000,120000)=30000', beRun.deadline_ms === 30000);
    const beWrite = core.buildEnvelope({
      requestId: 'req-b1-write', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-b1-write',
      command: 'file.write', params: {}, timeoutMs: 10000,
    });
    t('B1 buildEnvelope file.write mode 为 sync（tier 2 但不是长命令）', beWrite.mode === 'sync');
    t('B1 buildEnvelope file.write deadline 为 min(10000,120000)=10000（不用 8000 误杀）', beWrite.deadline_ms === 10000);
    t('B1 buildEnvelope 新字段签名可验', core.verifyEnvelope(bePing) === true && core.verifyEnvelope(beRun) === true);
    // 规范串 20 行；篡改任一新字段即验签失败
    t('B1 规范串为 20 行', core.envelopeSigningBytes(VEC_ENV).split('\n').length === 20);
    const signedB1 = core.signEnvelope(Object.assign({}, VEC_ENV, { params: { a: 1, b: 2 }, job_id: 'job-b1-test', mode: 'sync', deadline_ms: 5000 }));
    t('B1 含新字段的信封签名可验', core.verifyEnvelope(signedB1) === true);
    for (const [name, patch] of [
      ['job_id', { job_id: 'job-other-1' }],
      ['mode', { mode: 'async' }],
      ['deadline_ms', { deadline_ms: 6000 }],
    ]) {
      const tampered = Object.assign({}, signedB1, patch);
      t('B1 篡改 ' + name + ' 即验签失败', core.verifyEnvelope(tampered) === false);
    }
    // parseClientOutput 两行协议
    const ackLine = JSON.stringify({ ok: true, code: 'QFR_LEA_ACCEPTED', request_id: 'req-b1-1', job_id: 'job-b1-1', result: { job_id: 'job-b1-1' } });
    const resLine = JSON.stringify({ ok: true, code: 'done', request_id: 'req-b1-1', result: { version: '0.1.0' } });
    const twoLine = 'C:\\>qf-lea-client.exe dispatch <b64>\r\n' + ackLine + '\r\n' + resLine + '\r\nC:\\>exit\r\n';
    const p2 = core.parseClientOutput(twoLine);
    t('B1 两行协议：ACK 被跳过、取结果行', p2.ok === true && p2.result && p2.result.code === 'done');
    const ackOnly = 'C:\\>qf-lea-client.exe dispatch <b64>\r\n' + ackLine + '\r\nC:\\>exit\r\n';
    const pA = core.parseClientOutput(ackOnly);
    t('B1 只有 ACK 时回 acceptedOnly（不把 ACK 当成功）', pA.ok === false && pA.acceptedOnly === true && pA.accepted && pA.accepted.code === 'QFR_LEA_ACCEPTED');
    const toLine = JSON.stringify({ ok: false, code: 'QFR_LEA_TIMEOUT', request_id: 'req-b1-1', retryable: true, detail: 'result-timeout-no-result-in-6s' });
    const pT = core.parseClientOutput(ackLine + '\r\n' + toLine + '\r\n');
    t('B1 ACK＋timeout JSON 时回 clientResult QFR_LEA_TIMEOUT', pT.ok === false && pT.clientResult && pT.clientResult.code === 'QFR_LEA_TIMEOUT');
    t('B1 老单行协议仍兼容', core.parseClientOutput(resLine).ok === true && core.parseClientOutput(resLine).result.code === 'done');
  }

  // B1：下发超时→健康降级→探测恢复→sweepB1Jobs 推进（独立 core＋可控时钟）
  {
    const dirB1 = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-b1-'));
    let fakeNow = Date.now();
    const coreB1 = createLeaCore({ signingKeyFile: testKeyFile, dir: dirB1, enableSweeps: false, whitelist: [DEV], now: () => fakeNow });
    coreB1.grantMuse(USER, 'owner');
    coreB1.recordBinding(DEV, USER, 'b1-test');
    const gB1 = coreB1.generateKey(USER, { device_scope: DEV });
    const mkEnvB1 = (reqId, cmd) => coreB1.buildEnvelope({
      requestId: reqId, batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: gB1.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-' + reqId,
      command: cmd, params: {}, timeoutMs: 5000,
    });
    // 挂起通道：runCommand 抛超时错（模拟 runcommands 8s 未回包）
    const hangChannel = {
      async runCommand(nodeId, cmd) {
        if (cmd.includes('revoked_keys.txt')) return 'ok';
        if (isHandshakeDispatch(cmd)) return HANDSHAKE_OK_LINE;
        throw new Error('runcommands timeout');
      },
      async nodeOnline() { return true; },
      async listNodes() { return [{ _id: DEV, conn: 1 }]; },
    };
    const dHang = await coreB1.dispatchEnvelope(hangChannel, mkEnvB1('req-b1-hang1', 'sys.info'), { timeoutMs: 8000 });
    t('B1 通道超时即回 timeout', dHang.ok === false && dHang.timeout === true);
    t('B1 一次超时后健康仍 OK（须连续 2 次才降级）', coreB1.healthGet(DEV).state === 'OK' && coreB1.healthGet(DEV).fails === 1);
    const dHang2 = await coreB1.dispatchEnvelope(hangChannel, mkEnvB1('req-b1-hang2', 'sys.info'), { timeoutMs: 8000 });
    t('B1 第二次超时仍回 timeout', dHang2.ok === false && dHang2.timeout === true);
    t('B1 连续 2 次超时即标 DEGRADED', coreB1.healthGet(DEV).state === 'DEGRADED' && coreB1.healthGet(DEV).fails === 2);
    // DEGRADED 后下发先探测：挂起通道探测失败即拒下发（notInstalled）
    const dDeg = await coreB1.dispatchEnvelope(hangChannel, mkEnvB1('req-b1-hang3', 'sys.info'), { timeoutMs: 8000 });
    t('B1 DEGRADED 且探测失败即拒下发（notInstalled）', dDeg.ok === false && dDeg.notInstalled === true);
    // 恢复通道：sys.ping 成功即探测通过、恢复 OK，下发继续
    const okChannel = {
      async runCommand(nodeId, cmd) {
        if (cmd.includes('revoked_keys.txt')) return 'ok';
        return JSON.stringify({ ok: true, code: 'done', request_id: 'req-b1-ok' });
      },
      async nodeOnline() { return true; },
      async listNodes() { return [{ _id: DEV, conn: 1 }]; },
    };
    const dRec = await coreB1.dispatchEnvelope(okChannel, mkEnvB1('req-b1-rec1', 'sys.info'), { timeoutMs: 8000 });
    t('B1 探测恢复后下发成功', dRec.ok === true);
    t('B1 成功后健康回 OK、计数清零', coreB1.healthGet(DEV).state === 'OK' && coreB1.healthGet(DEV).fails === 0);
    // in-flight 名额：8 条放行，第 9 条拒绝；释放后可再入
    const devB1 = 'node-b1-inflight';
    let acquired = 0;
    for (let i = 0; i < 8; i++) if (coreB1.inflightAcquire(devB1)) acquired++;
    t('B1 in-flight 8 条放行', acquired === 8);
    t('B1 in-flight 第 9 条拒绝', coreB1.inflightAcquire(devB1) === false);
    coreB1.inflightRelease(devB1);
    t('B1 in-flight 释放后可再入', coreB1.inflightAcquire(devB1) === true);
    coreB1.inflightRelease(devB1);
    // sweepB1Jobs：UNKNOWN／DISPATCH_TIMEOUT 超 10 秒转 TIMED_OUT
    const jobU = coreB1.createJob({ account_id: USER, device_id: DEV, api_key_id: gB1.record.key_id, command: 'sys.info', request_id: 'req-b1-sweep-u', idempotency_key: 'idem-b1-sweep-u', status: 'UNKNOWN' });
    const jobD = coreB1.createJob({ account_id: USER, device_id: DEV, api_key_id: gB1.record.key_id, command: 'sys.info', request_id: 'req-b1-sweep-d', idempotency_key: 'idem-b1-sweep-d', status: 'DISPATCH_TIMEOUT' });
    const jobFresh = coreB1.createJob({ account_id: USER, device_id: DEV, api_key_id: gB1.record.key_id, command: 'sys.info', request_id: 'req-b1-sweep-f', idempotency_key: 'idem-b1-sweep-f', status: 'UNKNOWN' });
    fakeNow += 11 * 1000;
    // jobFresh 建在推进前 11 秒内？不：它与 jobU 同批建（同一 fakeNow），
    // 推进时会一起超 10 秒；为验“未超 10 秒不动”，先把它改回新时间。
    coreB1.updateJob(jobFresh.job_id, { status: 'UNKNOWN' });
    fakeNow += 1000; // jobFresh 的 updated_at 在此时，距推进仅 0 秒（未超 10 秒）
    coreB1.sweepB1Jobs();
    t('B1 sweepB1Jobs：UNKNOWN 超 10 秒转 TIMED_OUT', coreB1.getJob(jobU.job_id).status === 'TIMED_OUT');
    t('B1 sweepB1Jobs：DISPATCH_TIMEOUT 超 10 秒转 TIMED_OUT', coreB1.getJob(jobD.job_id).status === 'TIMED_OUT');
    t('B1 sweepB1Jobs：未超 10 秒的 UNKNOWN 不动', coreB1.getJob(jobFresh.job_id).status === 'UNKNOWN');
    // 客户端 timeout JSON 终态：dispatch 直接回 clientResult QFR_LEA_TIMEOUT
    const toChannel = {
      async runCommand(nodeId, cmd) {
        if (cmd.includes('revoked_keys.txt')) return 'ok';
        return JSON.stringify({ ok: true, code: 'QFR_LEA_ACCEPTED', request_id: 'req-b1-to', job_id: 'job-b1-to' }) + '\r\n' +
          JSON.stringify({ ok: false, code: 'QFR_LEA_TIMEOUT', request_id: 'req-b1-to', retryable: true, detail: 'result-timeout-no-result-in-6s' });
      },
      async nodeOnline() { return true; },
      async listNodes() { return [{ _id: DEV, conn: 1 }]; },
    };
    const dTo = await coreB1.dispatchEnvelope(toChannel, mkEnvB1('req-b1-to', 'sys.info'), { timeoutMs: 8000 });
    t('B1 客户端 timeout JSON 即回 clientResult QFR_LEA_TIMEOUT', dTo.ok === false && dTo.clientResult && dTo.clientResult.code === 'QFR_LEA_TIMEOUT');
    t('B1 客户端 timeout 记一次健康失败', coreB1.healthGet(DEV).fails === 1);
  }

  // B1：路由层映射（独立 core＋routes）
  {
    const dirR = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-b1r-'));
    const coreR = createLeaCore({ signingKeyFile: testKeyFile, dir: dirR, enableSweeps: false, whitelist: [DEV] });
    coreR.grantMuse(USER, 'owner');
    coreR.recordBinding(DEV, USER, 'b1-route');
    const gR = coreR.generateKey(USER, { device_scope: DEV });
    const mkChannel = (fn) => ({
      async runCommand(nodeId, cmd) {
        if (cmd.includes('revoked_keys.txt')) return 'ok';
        return fn(nodeId, cmd);
      },
      async nodeOnline() { return true; },
      async listNodes() { return [{ _id: DEV, conn: 1 }]; },
    });
    const mkRoutes = (ch) => createLeaRoutes(coreR, ch, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    const callR = async (routes, idem, cmd, params) => {
      sent.length = 0;
      const req = mkReq('POST', '/api/lea/v1/execute',
        Object.assign(bearerHeaders(gR.key), { 'idempotency-key': idem }),
        { device_id: DEV, command: cmd, params: params || {} });
      const res = mkRes();
      const matched = await routes.handle(req, res);
      const o = sent.length ? sent[sent.length - 1] : null;
      return { matched, code: o ? o.code : null, obj: o ? o.obj : null };
    };
    // 通道超时 → 202 DISPATCH_TIMEOUT，job 记 DISPATCH_TIMEOUT
    const hangCh = mkChannel(async (nodeId, cmd) => { if (isHandshakeDispatch(cmd)) return HANDSHAKE_OK_LINE; throw new Error('runcommands timeout'); });
    const routesHang = mkRoutes(hangCh);
    let rr = await callR(routesHang, 'b1r-hang-1', 'sys.info');
    t('B1 路由通道超时 → 202 DISPATCH_TIMEOUT', rr.code === 202 && rr.obj && rr.obj.status === 'DISPATCH_TIMEOUT');
    t('B1 路由通道超时 job 记 DISPATCH_TIMEOUT', rr.obj && coreR.getJob(rr.obj.job_id).status === 'DISPATCH_TIMEOUT');
    // 客户端 timeout JSON → 502 QFR_LEA_TIMEOUT，job 记 TIMED_OUT
    const toCh = mkChannel(async () =>
      JSON.stringify({ ok: true, code: 'QFR_LEA_ACCEPTED', request_id: 'req-b1r-to', job_id: 'job-b1r-to' }) + '\r\n' +
      JSON.stringify({ ok: false, code: 'QFR_LEA_TIMEOUT', request_id: 'req-b1r-to', retryable: true, detail: 'result-timeout-no-result-in-6s' }));
    const routesTo = mkRoutes(toCh);
    rr = await callR(routesTo, 'b1r-to-1', 'sys.info');
    t('B1 路由客户端 timeout → 502 QFR_LEA_TIMEOUT', rr.code === 502 && rr.obj && rr.obj.code === 'QFR_LEA_TIMEOUT');
    const idemTo = coreR.idemLookup(USER, gR.record.key_id, 'b1r-to-1', coreR.IDEM_NS.EXEC);
    t('B1 路由客户端 timeout job 记 TIMED_OUT', !!(idemTo && idemTo.job_id && coreR.getJob(idemTo.job_id) && coreR.getJob(idemTo.job_id).status === 'TIMED_OUT'));
    // 只有 ACK（同步／异步）：用全新 core（健康初始 OK，不触发探测；
    // 前面的 hang／to 测试已把 coreR 健康打到 DEGRADED）。
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-b1a-'));
    const coreA = createLeaCore({ signingKeyFile: testKeyFile, dir: dirA, enableSweeps: false, whitelist: [DEV] });
    coreA.grantMuse(USER, 'owner', { dangerous: true });
    coreA.recordBinding(DEV, USER, 'b1-ack');
    const gA = coreA.generateKey(USER, { device_scope: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
    const ackCh = mkChannel(async (nodeId, cmd) =>
      isHandshakeDispatch(cmd) ? HANDSHAKE_OK_LINE :
      JSON.stringify({ ok: true, code: 'QFR_LEA_ACCEPTED', request_id: 'req-b1r-ack', job_id: 'job-b1r-ack' }));
    const routesAck = createLeaRoutes(coreA, ackCh, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    const callA = async (idem, cmd, params) => {
      sent.length = 0;
      const req = mkReq('POST', '/api/lea/v1/execute',
        Object.assign(bearerHeaders(gA.key), { 'idempotency-key': idem }),
        { device_id: DEV, command: cmd, params: params || {} });
      const res = mkRes();
      const matched = await routesAck.handle(req, res);
      const o = sent.length ? sent[sent.length - 1] : null;
      return { matched, code: o ? o.code : null, obj: o ? o.obj : null };
    };
    rr = await callA('b1r-ack-1', 'sys.info');
    t('B1 路由只有 ACK（同步）→ 202 UNKNOWN', rr.code === 202 && rr.obj && rr.obj.status === 'UNKNOWN');
    // 只有 ACK（script.run 异步）→ 202 RUNNING
    rr = await callA('b1r-ack-2', 'script.run');
    t('B1 路由只有 ACK（异步）→ 202 RUNNING', rr.code === 202 && rr.obj && rr.obj.status === 'RUNNING');
    // in-flight 满 → 503 QUEUE_FULL
    for (let i = 0; i < 8; i++) coreR.inflightAcquire(DEV);
    const okCh = mkChannel(async () => JSON.stringify({ ok: true, code: 'done' }));
    const routesOk = mkRoutes(okCh);
    rr = await callR(routesOk, 'b1r-full-1', 'sys.info');
    t('B1 路由 in-flight 满 → 503 QUEUE_FULL', rr.code === 503 && rr.obj && rr.obj.code === 'QFR_QUEUE_FULL');
    for (let i = 0; i < 8; i++) coreR.inflightRelease(DEV);
    rr = await callR(routesOk, 'b1r-full-2', 'sys.info');
    t('B1 路由 in-flight 释放后下发恢复 200', rr.code === 200);
  }

  // ---------- C1) 自助绑定：issue / complete / renew / status / 自助吊销 ----------
  {
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-c1-'));
    const coreC = createLeaCore({ signingKeyFile: testKeyFile, dir: dirC, enableSweeps: false, whitelist: [DEV, 'node//test-device-2', 'node//test-device-3', 'node//test-device-4'] });
    const DEV2 = 'node//test-device-2';
    const DEV3 = 'node//test-device-3';
    const DEV4 = 'node//test-device-4';
    const CAROL = 'carol';
    // 规范串里的 device_id 一律用裸形（去 node// 前缀），与绑定台账
    // 键一致；complete/renew 入参可用原始形（服务端归一化），签名
    // 必须用裸形，否则验签失败。
    const bare = (id) => String(id).replace(/^node\/\//, '');
    coreC.grantMuse(USER, 'owner');
    coreC.recordBinding(DEV, USER, 'c1-login');
    coreC.recordBinding(DEV2, USER, 'c1-login');
    coreC.recordBinding(DEV3, USER, 'c1-login');
    coreC.recordBinding(DEV4, CAROL, 'c1-login'); // carol：有绑定、无授权（测自助建 grant）
    // P-256 设备密钥对（测试替身，替 USH 的 CNG 设备密钥）
    function devKeyPair() {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
      return { pubB64: raw.toString('base64'), priv: privateKey };
    }
    function signComplete(kp, o) {
      // Node 24.22.1 的 crypto.sign 不接受 options 对象（第 4 参会被当
      // 回调），故先签 DER 再转 P1363 原始格式（与 USH 的输出一致）。
      const canonical = coreC.selfBindCompleteSigningBytes(o);
      const der = crypto.sign('sha256', Buffer.from(canonical, 'utf8'), kp.priv);
      return coreC.ecdsaDerToP1363(der).toString('base64');
    }
    function signRenew(kp, o) {
      const canonical = coreC.selfBindRenewSigningBytes(o);
      const der = crypto.sign('sha256', Buffer.from(canonical, 'utf8'), kp.priv);
      return coreC.ecdsaDerToP1363(der).toString('base64');
    }
    // issue：未绑定设备 → 拒绝
    let threw = null;
    try { coreC.issueSelfBindTicket(USER, 'node//never-bound', { nonce: 'test-nonce-001' }); } catch (e) { threw = e; }
    t('C1 issue 未绑定设备 → QFR_LEA_NOT_BOUND', !!(threw && threw.code === 'QFR_LEA_NOT_BOUND'));
    // issue：成功（票据格式／TTL／challenge）
    const iss = coreC.issueSelfBindTicket(USER, DEV, { device_name: 'TEST-PC', platform: 'windows', nonce: 'test-nonce-001' });
    t('C1 issue 成功返回 sbt_ 票据＋challenge＋5 分钟 TTL', /^sbt_[A-Za-z0-9_-]{43}$/.test(iss.ticket) && !!iss.challenge && iss.ttl_s === 300 && iss.expires_at > Math.floor(Date.now() / 1000));
    // issue：票据明文不落盘（台账只存 SHA-256）
    const tkFile = fs.readFileSync(path.join(dirC, 'selfbind-tickets.json'), 'utf8');
    t('C1 票据台账不存票据明文', !tkFile.includes(iss.ticket) && tkFile.includes(crypto.createHash('sha256').update(iss.ticket).digest('hex')));
    // issue：5 秒内重复签发 → 限流
    threw = null;
    try { coreC.issueSelfBindTicket(USER, DEV, { device_name: 'TEST-PC', platform: 'windows', nonce: 'test-nonce-002' }); } catch (e) { threw = e; }
    t('C1 issue 5 秒内重复签发 → QFR_RATE_LIMITED', !!(threw && threw.code === 'QFR_RATE_LIMITED'));
    // complete：签名错误 → 拒绝
    const kp = devKeyPair();
    threw = null;
    try {
      coreC.completeSelfBind({ ticket: iss.ticket, account_id: USER, device_id: DEV, nonce: 'test-nonce-001', device_pubkey: kp.pubB64, signature: Buffer.alloc(64).toString('base64') });
    } catch (e) { threw = e; }
    t('C1 complete 签名错误 → QFR_DEVICE_SIGNATURE_INVALID', !!(threw && threw.code === 'QFR_DEVICE_SIGNATURE_INVALID'));
    // complete：nonce 不一致 → 拒绝
    threw = null;
    try {
      const sig = signComplete(kp, { account_id: USER, device_id: bare(DEV), ticket: iss.ticket, challenge: iss.challenge, nonce: 'test-nonce-001', device_pubkey: kp.pubB64, expires_at: iss.expires_at });
      coreC.completeSelfBind({ ticket: iss.ticket, account_id: USER, device_id: DEV, nonce: 'wrong-nonce-999', device_pubkey: kp.pubB64, signature: sig });
    } catch (e) { threw = e; }
    t('C1 complete nonce 不一致 → QFR_TICKET_MISMATCH', !!(threw && threw.code === 'QFR_TICKET_MISMATCH'));
    // complete：成功（90 天 Key、自助标记、设备名／平台、绑定 epoch）
    const sigOk = signComplete(kp, { account_id: USER, device_id: bare(DEV), ticket: iss.ticket, challenge: iss.challenge, nonce: 'test-nonce-001', device_pubkey: kp.pubB64, expires_at: iss.expires_at });
    const done = coreC.completeSelfBind({ ticket: iss.ticket, account_id: USER, device_id: DEV, nonce: 'test-nonce-001', device_pubkey: kp.pubB64, signature: sigOk });
    t('C1 complete 成功返回 Key 明文一次', /^qfr_lea_[A-Za-z0-9_-]{43}$/.test(done.key));
    t('C1 complete Key 默认 90 天', Math.abs(done.record.expires_at - (Date.now() + 90 * 24 * 3600 * 1000)) < 60 * 1000);
    t('C1 complete 记录带 self_bind／设备名／平台', done.record.self_bind === true && done.record.device_name === 'TEST-PC' && done.record.platform === 'windows');
    t('C1 complete Key 可用（认证通过）', coreC.authenticate(bearerHeaders(done.key)).ok === true);
    // complete：票据重放 → 拒绝
    threw = null;
    try { coreC.completeSelfBind({ ticket: iss.ticket, account_id: USER, device_id: DEV, nonce: 'test-nonce-001', device_pubkey: kp.pubB64, signature: sigOk }); } catch (e) { threw = e; }
    t('C1 complete 票据重放 → QFR_TICKET_REUSED', !!(threw && threw.code === 'QFR_TICKET_REUSED'));
    // complete：设备公钥已存绑定记录（TOFU）
    t('C1 complete 设备公钥存入绑定记录', coreC.getBinding(DEV).device_pubkey === kp.pubB64);
    // complete：无授权账号自助建 grant（carol）
    t('C1 carol 事前无授权', coreC.hasGrant(CAROL) === false);
    const issC = coreC.issueSelfBindTicket(CAROL, DEV4, { device_name: 'CAROL-PC', platform: 'windows', nonce: 'carol-nonce-01' });
    const kpC = devKeyPair();
    const sigC = signComplete(kpC, { account_id: CAROL, device_id: bare(DEV4), ticket: issC.ticket, challenge: issC.challenge, nonce: 'carol-nonce-01', device_pubkey: kpC.pubB64, expires_at: issC.expires_at });
    const doneC = coreC.completeSelfBind({ ticket: issC.ticket, account_id: CAROL, device_id: DEV4, nonce: 'carol-nonce-01', device_pubkey: kpC.pubB64, signature: sigC });
    t('C1 carol complete 后自动建 grant（无 dangerous）', coreC.hasGrant(CAROL) === true && coreC.hasDangerousGrant(CAROL) === false && !!doneC.key);
    // complete：过期票据 → 拒绝（直接改台账 expires_at 到过去）
    const issE = coreC.issueSelfBindTicket(USER, DEV2, { device_name: 'TEST-PC2', platform: 'windows', nonce: 'test-nonce-003' });
    const tkSt = JSON.parse(fs.readFileSync(path.join(dirC, 'selfbind-tickets.json'), 'utf8'));
    const hE = crypto.createHash('sha256').update(issE.ticket).digest('hex');
    tkSt.tickets[hE].expires_at = Math.floor(Date.now() / 1000) - 10;
    fs.writeFileSync(path.join(dirC, 'selfbind-tickets.json'), JSON.stringify(tkSt));
    threw = null;
    try {
      const sigE = signComplete(kp, { account_id: USER, device_id: bare(DEV2), ticket: issE.ticket, challenge: issE.challenge, nonce: 'test-nonce-003', device_pubkey: kp.pubB64, expires_at: issE.expires_at });
      coreC.completeSelfBind({ ticket: issE.ticket, account_id: USER, device_id: DEV2, nonce: 'test-nonce-003', device_pubkey: kp.pubB64, signature: sigE });
    } catch (e) { threw = e; }
    t('C1 complete 过期票据 → QFR_TICKET_EXPIRED', !!(threw && threw.code === 'QFR_TICKET_EXPIRED'));
    // status：active（设备名／有效期／key 前缀，不含明文）
    const st1 = coreC.selfBindStatus(USER, DEV);
    t('C1 status 已链接 → active＋设备名＋有效期', st1.status === 'active' && st1.device_name === 'TEST-PC' && st1.expires_at === done.record.expires_at && !('key' in st1));
    const st2 = coreC.selfBindStatus(USER, DEV3);
    t('C1 status 未链接 → pending', st2.status === 'pending');
    // listKeys：补设备名／平台／自助标记／最后在线字段
    const listed = coreC.listKeys(USER).find((k) => k.key_id === done.record.key_id);
    t('C1 listKeys 带设备名／平台／自助标记', !!listed && listed.device_name === 'TEST-PC' && listed.platform === 'windows' && listed.self_bind === true && 'last_seen_at' in listed);
    // renew：未到窗口 → 409 口径
    threw = null;
    try {
      const ts = Math.floor(Date.now() / 1000);
      const sigR = signRenew(kp, { account_id: USER, device_id: bare(DEV), key_id: done.record.key_id, nonce: 'renew-nonce-01', timestamp: ts });
      coreC.renewSelfBindKey({ key_id: done.record.key_id, device_id: DEV, nonce: 'renew-nonce-01', timestamp: ts, signature: sigR });
    } catch (e) { threw = e; }
    t('C1 renew 未到窗口 → QFR_NOT_RENEWABLE', !!(threw && threw.code === 'QFR_NOT_RENEWABLE' && threw.renewable_at));
    // renew：窗口内（改 expires_at 到 1 天后）→ 延长 90 天
    const kSt = JSON.parse(fs.readFileSync(path.join(dirC, 'keys.json'), 'utf8'));
    const kRec = kSt.keys.find((x) => x.key_id === done.record.key_id);
    kRec.expires_at = Date.now() + 24 * 3600 * 1000;
    fs.writeFileSync(path.join(dirC, 'keys.json'), JSON.stringify(kSt));
    const ts2 = Math.floor(Date.now() / 1000);
    const sigR2 = signRenew(kp, { account_id: USER, device_id: bare(DEV), key_id: done.record.key_id, nonce: 'renew-nonce-02', timestamp: ts2 });
    const ren = coreC.renewSelfBindKey({ key_id: done.record.key_id, device_id: DEV, nonce: 'renew-nonce-02', timestamp: ts2, signature: sigR2 });
    t('C1 renew 窗口内成功延长 90 天', ren.ok === true && Math.abs(ren.record.expires_at - (Date.now() + 90 * 24 * 3600 * 1000)) < 60 * 1000);
    // renew：签名错误 → 拒绝
    threw = null;
    try {
      const ts3 = Math.floor(Date.now() / 1000);
      coreC.renewSelfBindKey({ key_id: done.record.key_id, device_id: DEV, nonce: 'renew-nonce-03', timestamp: ts3, signature: Buffer.alloc(64).toString('base64') });
    } catch (e) { threw = e; }
    t('C1 renew 签名错误 → QFR_DEVICE_SIGNATURE_INVALID', !!(threw && threw.code === 'QFR_DEVICE_SIGNATURE_INVALID'));
    // 自助吊销：控制台 Key 拒绝；自助 Key 通过；status 变 revoked
    const consoleKey = coreC.generateKey(USER, { device_scope: DEV });
    const rvBad = coreC.revokeSelfBindKey(USER, consoleKey.record.key_id);
    t('C1 自助吊销控制台 Key → SCOPE_DENIED', rvBad.ok === false && rvBad.code === 'QFR_SCOPE_DENIED');
    const rvOk = coreC.revokeSelfBindKey(USER, done.record.key_id);
    t('C1 自助吊销自助 Key 成功', rvOk.ok === true && rvOk.record.status === 'revoked');
    t('C1 吊销后 status 变 revoked', coreC.selfBindStatus(USER, DEV).status === 'revoked');
    t('C1 吊销后 Key 认证失败', coreC.authenticate(bearerHeaders(done.key)).ok === false);
    // 路由层：issue／complete／status／renew／自助吊销
    const routesC = createLeaRoutes(coreC, mockChannel, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    async function callC(method, url, headers, body) {
      sent.length = 0;
      const req = mkReq(method, url, headers, body);
      const res = mkRes();
      const matched = await routesC.handle(req, res);
      return { matched, code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
    }
    let rc = await callC('POST', '/api/lea/v1/self-bind/issue', {}, { device_id: DEV3, device_name: 'ROUTE-PC', platform: 'windows', nonce: 'route-nonce-01' });
    t('C1 路由 issue 200 返回票据', rc.matched === true && rc.code === 200 && /^sbt_/.test(rc.obj.ticket || ''));
    const kpR = devKeyPair();
    const sigCR = signComplete(kpR, { account_id: USER, device_id: bare(DEV3), ticket: rc.obj.ticket, challenge: rc.obj.challenge, nonce: 'route-nonce-01', device_pubkey: kpR.pubB64, expires_at: rc.obj.expires_at });
    rc = await callC('POST', '/api/lea/v1/self-bind/complete', {}, { ticket: rc.obj.ticket, account_id: USER, device_id: DEV3, nonce: 'route-nonce-01', device_pubkey: kpR.pubB64, signature: sigCR });
    t('C1 路由 complete 200 返回 Key', rc.code === 200 && /^qfr_lea_/.test(rc.obj.key || '') && rc.obj.record.self_bind === true);
    const routeKeyId = rc.obj.record.key_id;
    rc = await callC('GET', '/api/lea/v1/self-bind/status?device_id=' + encodeURIComponent(DEV3), {}, {});
    t('C1 路由 status 200 active', rc.code === 200 && rc.obj.status === 'active' && rc.obj.key_id === routeKeyId);
    rc = await callC('POST', '/api/lea/v1/self-bind/revoke/' + encodeURIComponent(routeKeyId), {}, {});
    t('C1 路由自助吊销 200', rc.code === 200 && rc.obj.record.status === 'revoked');
    rc = await callC('POST', '/api/lea/v1/self-bind/revoke/' + encodeURIComponent(consoleKey.record.key_id), {}, {});
    t('C1 路由自助吊销控制台 Key → 403', rc.code === 403);
    // 路由层 renew：全新自助 Key，窗口内，Bearer＋签名 → 200 延长
    let rc2 = await callC('POST', '/api/lea/v1/self-bind/issue', {}, { device_id: DEV2, device_name: 'RENEW-PC', platform: 'windows', nonce: 'route-renew-issue-01' });
    t('C1 路由 renew 前置 issue 200', rc2.code === 200 && /^sbt_/.test(rc2.obj.ticket || ''));
    const kpR2 = devKeyPair();
    const sigCR2 = signComplete(kpR2, { account_id: USER, device_id: bare(DEV2), ticket: rc2.obj.ticket, challenge: rc2.obj.challenge, nonce: 'route-renew-issue-01', device_pubkey: kpR2.pubB64, expires_at: rc2.obj.expires_at });
    rc2 = await callC('POST', '/api/lea/v1/self-bind/complete', {}, { ticket: rc2.obj.ticket, account_id: USER, device_id: DEV2, nonce: 'route-renew-issue-01', device_pubkey: kpR2.pubB64, signature: sigCR2 });
    t('C1 路由 renew 前置 complete 200', rc2.code === 200 && !!rc2.obj.key);
    const kSt2 = JSON.parse(fs.readFileSync(path.join(dirC, 'keys.json'), 'utf8'));
    const kRec2 = kSt2.keys.find((x) => x.key_id === rc2.obj.record.key_id);
    kRec2.expires_at = Date.now() + 24 * 3600 * 1000;
    fs.writeFileSync(path.join(dirC, 'keys.json'), JSON.stringify(kSt2));
    const tsR = Math.floor(Date.now() / 1000);
    const sigRR = signRenew(kpR2, { account_id: USER, device_id: bare(DEV2), key_id: rc2.obj.record.key_id, nonce: 'route-renew-nonce-02', timestamp: tsR });
    rc2 = await callC('POST', '/api/lea/v1/self-bind/renew', {
      authorization: 'Bearer ' + rc2.obj.key,
      'x-qfr-timestamp': String(tsR),
      'x-qfr-nonce': 'route-renew-nonce-02',
    }, { device_id: DEV2, timestamp: tsR, signature: sigRR });
    t('C1 路由 renew 200 延长 90 天', rc2.code === 200 && Math.abs(rc2.obj.record.expires_at - (Date.now() + 90 * 24 * 3600 * 1000)) < 60 * 1000);
    // 已吊销 Key 续期 → 401（须重新链接）
    const kSt3 = JSON.parse(fs.readFileSync(path.join(dirC, 'keys.json'), 'utf8'));
    const kRec3 = kSt3.keys.find((x) => x.key_id === routeKeyId);
    t('C1 路由 renew 前置：已吊销 Key 无法续期（须重新链接）', !!kRec3 && !!kRec3.revoked_at);
  }

  // ---------- DEREG) 卸载注销：POST /devices/{id}/deregister ----------
  // 固定契约：规范串 qfr-lea-deregister-v1\n<account>\n<device裸>\n<nonce>\n<ts>，
  // P-256 设备私钥 P1363 签名，ts ±300s，nonce ≥16 字节 base64url；
  // 成功 {ok:true, deregistered:true}，已注销过幂等成功；Key／grant 不动。
  {
    const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-dereg-'));
    const DEVD = 'node//test-device-d';
    const DEVD2 = 'node//test-device-d2';
    const DEVD3 = 'node//test-device-d3';
    const coreD = createLeaCore({ signingKeyFile: testKeyFile, dir: dirD, enableSweeps: false, whitelist: [DEVD, DEVD2, DEVD3] });
    const bareD = (id) => String(id).replace(/^node\/\//, '');
    coreD.grantMuse(USER, 'owner');
    coreD.recordBinding(DEVD, USER, 'dereg-login');
    coreD.recordBinding(DEVD2, USER, 'dereg-login');
    coreD.recordBinding(DEVD3, USER, 'dereg-login');
    function devKeyPairD() {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
      return { pubB64: raw.toString('base64'), priv: privateKey };
    }
    function signCompleteD(kp, o) {
      const canonical = coreD.selfBindCompleteSigningBytes(o);
      const der = crypto.sign('sha256', Buffer.from(canonical, 'utf8'), kp.priv);
      return coreD.ecdsaDerToP1363(der).toString('base64');
    }
    function signDeregD(kp, o) {
      const canonical = coreD.deregisterSigningBytes(o);
      const der = crypto.sign('sha256', Buffer.from(canonical, 'utf8'), kp.priv);
      return coreD.ecdsaDerToP1363(der).toString('base64');
    }
    function deregBodyD(kp, accountId, deviceId, nonce, tsOverride) {
      const ts = tsOverride !== undefined ? tsOverride : Math.floor(Date.now() / 1000);
      const sig = signDeregD(kp, { account_id: accountId, device_id: bareD(deviceId), nonce, timestamp: ts });
      return { account_id: accountId, device_id: deviceId, nonce, timestamp: ts, signature: sig };
    }
    // 三台设备各走一次自助绑定，拿到设备公钥＋自助 Key（issue 限流按设备分桶，不撞）。
    async function bindDeviceD(dev, nonce) {
      const kp = devKeyPairD();
      const iss = coreD.issueSelfBindTicket(USER, dev, { device_name: 'DEREG-PC', platform: 'windows', nonce });
      const sig = signCompleteD(kp, { account_id: USER, device_id: bareD(dev), ticket: iss.ticket, challenge: iss.challenge, nonce, device_pubkey: kp.pubB64, expires_at: iss.expires_at });
      const done = coreD.completeSelfBind({ ticket: iss.ticket, account_id: USER, device_id: dev, nonce, device_pubkey: kp.pubB64, signature: sig });
      return { kp, done };
    }
    const devD = await bindDeviceD(DEVD, 'dereg-bind-nonce-01');
    const devD2 = await bindDeviceD(DEVD2, 'dereg-bind-nonce-02');
    const devD3 = await bindDeviceD(DEVD3, 'dereg-bind-nonce-03');
    t('DEREG 前置：三台设备自助绑定成功且公钥已存', coreD.getBinding(DEVD).device_pubkey === devD.kp.pubB64 && coreD.getBinding(DEVD2).device_pubkey === devD2.kp.pubB64 && !!devD.done.key && !!devD2.done.key);
    const grantEpochBefore = coreD.getGrant(USER).grant_epoch;
    const keysBefore = JSON.parse(fs.readFileSync(path.join(dirD, 'keys.json'), 'utf8')).keys.map((k) => k.key_id).sort();
    // 路由层：mock 通道记 deleteNode 调用
    const deleteCalls = [];
    const mockChannelD = {
      async runCommand() { return '{}'; },
      async nodeOnline() { return true; },
      async listNodes() { return []; },
      async deleteNode(id) { deleteCalls.push(id); return { ok: true, result: 'ok' }; },
    };
    const routesD = createLeaRoutes(coreD, mockChannelD, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    async function callD(method, url, headers, body) {
      sent.length = 0;
      const req = mkReq(method, url, headers, body);
      const res = mkRes();
      const matched = await routesD.handle(req, res);
      return { matched, code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
    }
    const deregUrl = '/api/lea/v1/devices/' + encodeURIComponent(bareD(DEVD)) + '/deregister';
    // 验签失败 → 401，绑定不动
    let rd = await callD('POST', deregUrl, {}, { account_id: USER, device_id: DEVD, nonce: 'dereg-bad-nonce-01', timestamp: Math.floor(Date.now() / 1000), signature: Buffer.alloc(64).toString('base64') });
    t('DEREG 签名错误 → 401 QFR_DEVICE_SIGNATURE_INVALID', rd.code === 401 && rd.obj.code === 'QFR_DEVICE_SIGNATURE_INVALID');
    t('DEREG 签名错误后绑定仍在', !!(coreD.getBinding(DEVD) && coreD.getBinding(DEVD).state === 'ACTIVE'));
    // 账号不符（拿本设备私钥签他人账号）→ 401，绑定不动
    rd = await callD('POST', deregUrl, {}, deregBodyD(devD.kp, 'bob', DEVD, 'dereg-bad-nonce-02'));
    t('DEREG 账号不符 → 401', rd.code === 401 && rd.obj.code === 'QFR_DEVICE_SIGNATURE_INVALID');
    t('DEREG 账号不符后绑定仍在', !!(coreD.getBinding(DEVD) && coreD.getBinding(DEVD).state === 'ACTIVE'));
    // 路径与 body device_id 不一致 → 400，只许删路径里那台设备
    rd = await callD('POST', '/api/lea/v1/devices/' + encodeURIComponent(bareD(DEVD2)) + '/deregister', {}, deregBodyD(devD.kp, USER, DEVD, 'dereg-bad-nonce-03'));
    t('DEREG 路径与 body device 不一致 → 400', rd.code === 400);
    // 过期时间戳 → 401 QFR_REPLAY_DETECTED
    rd = await callD('POST', deregUrl, {}, deregBodyD(devD.kp, USER, DEVD, 'dereg-bad-nonce-04', Math.floor(Date.now() / 1000) - 3600));
    t('DEREG 过期时间戳 → 401 QFR_REPLAY_DETECTED', rd.code === 401 && rd.obj.code === 'QFR_REPLAY_DETECTED');
    // 从未绑定过的设备 → 401（与坏签名同码，无存在性预言）
    rd = await callD('POST', '/api/lea/v1/devices/never-bound/deregister', {}, deregBodyD(devD.kp, USER, 'node//never-bound', 'dereg-bad-nonce-05'));
    t('DEREG 从未绑定设备 → 401（同码，不区分存在性）', rd.code === 401 && rd.obj.code === 'QFR_DEVICE_SIGNATURE_INVALID');
    // 成功注销
    const okBody = deregBodyD(devD.kp, USER, DEVD, 'dereg-ok-nonce-01');
    rd = await callD('POST', deregUrl, {}, okBody);
    t('DEREG 成功注销 → 200 {ok:true, deregistered:true}', rd.matched === true && rd.code === 200 && rd.obj.ok === true && rd.obj.deregistered === true);
    t('DEREG 成功后绑定条目已删', coreD.getBinding(DEVD) === null);
    t('DEREG 成功后该设备自助票据已清', !Object.values(JSON.parse(fs.readFileSync(path.join(dirD, 'selfbind-tickets.json'), 'utf8')).tickets || {}).some((tk) => tk && tk.device_id === bareD(DEVD)));
    t('DEREG 成功后节点删除被调用一次且传裸 id', deleteCalls.length === 1 && deleteCalls[0] === bareD(DEVD));
    // 审计：lea-deregistered 已记
    const auditFilesD = fs.readdirSync(dirD).filter((f) => f.startsWith('audit-'));
    const auditTextD = auditFilesD.map((f) => fs.readFileSync(path.join(dirD, f), 'utf8')).join('\n');
    t('DEREG 成功后记 lea-deregistered 审计', auditTextD.includes('"ev":"lea-deregistered"') && auditTextD.includes(bareD(DEVD)));
    // 重放同一请求（同一 nonce／时间戳／签名）→ 401
    rd = await callD('POST', deregUrl, {}, okBody);
    t('DEREG 同一 nonce 重放 → 401 QFR_REPLAY_DETECTED', rd.code === 401 && rd.obj.code === 'QFR_REPLAY_DETECTED');
    // 重复注销（新 nonce／新签名，凭墓碑验签）→ 200 幂等成功
    rd = await callD('POST', deregUrl, {}, deregBodyD(devD.kp, USER, DEVD, 'dereg-ok-nonce-02'));
    t('DEREG 重复注销 → 200 幂等成功', rd.code === 200 && rd.obj.ok === true && rd.obj.deregistered === true);
    t('DEREG 重复注销仍尝试删节点（best-effort）', deleteCalls.length === 2);
    const alreadyOut = coreD.deregisterDevice(deregBodyD(devD.kp, USER, DEVD, 'dereg-ok-nonce-03'));
    t('DEREG core 层重复注销 already=true', alreadyOut.ok === true && alreadyOut.already === true);
    // 密钥完好：同一把 Key 还在、在效；grant 不变；另一台设备绑定不动
    const keysAfter = JSON.parse(fs.readFileSync(path.join(dirD, 'keys.json'), 'utf8')).keys;
    t('DEREG 后同一把 Key 还在 keys.json', keysAfter.some((k) => k.key_id === devD.done.record.key_id));
    t('DEREG 后同一把 Key 状态仍 active（未删未吊销）', coreD.keyStatus(coreD.findKeyById(devD.done.record.key_id)) === 'active');
    t('DEREG 后全部 Key 一个不少', JSON.stringify(keysAfter.map((k) => k.key_id).sort()) === JSON.stringify(keysBefore));
    t('DEREG 后 grant 不变（epoch／在效）', coreD.hasGrant(USER) === true && coreD.getGrant(USER).grant_epoch === grantEpochBefore);
    t('DEREG 后另一台设备绑定不动', !!(coreD.getBinding(DEVD2) && coreD.getBinding(DEVD2).state === 'ACTIVE' && coreD.getBinding(DEVD2).account_id === USER));
    // 没绑定不能执行：注销后同一把 Key 准入 → NOT_BOUND；另一台设备仍可执行
    const admD = coreD.admit({ key: coreD.findKeyById(devD.done.record.key_id), deviceId: DEVD, command: 'sys.info' });
    t('DEREG 后无绑定 Key 不能执行 → 403 QFR_LEA_NOT_BOUND', admD.ok === false && admD.code === 'QFR_LEA_NOT_BOUND');
    const admD2 = coreD.admit({ key: coreD.findKeyById(devD2.done.record.key_id), deviceId: DEVD2, command: 'sys.info' });
    t('DEREG 后另一台设备 Key 仍可执行', admD2.ok === true);
    // 墓碑：只有账号＋公钥＋时间＋epoch，不含任何 Key 明文／哈希
    const tombFile = fs.readFileSync(path.join(dirD, 'deregistered.json'), 'utf8');
    const tomb = JSON.parse(tombFile).devices[bareD(DEVD)];
    t('DEREG 墓碑含账号＋公钥＋epoch', !!tomb && tomb.account_id === USER && tomb.device_pubkey === devD.kp.pubB64 && tomb.binding_epoch === devD.done.binding_epoch);
    t('DEREG 墓碑不含 Key 明文', !tombFile.includes(devD.done.key) && !tombFile.includes(devD2.done.key));
    // 节点删不掉不阻断：deleteNode 抛错 → 仍 200，绑定已删，记失败审计
    const failChannelD = {
      async runCommand() { return '{}'; },
      async nodeOnline() { return true; },
      async listNodes() { return []; },
      async deleteNode() { throw new Error('svc-down'); },
    };
    const routesF = createLeaRoutes(coreD, failChannelD, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    const deregUrl3 = '/api/lea/v1/devices/' + encodeURIComponent(bareD(DEVD3)) + '/deregister';
    sent.length = 0;
    const reqF = mkReq('POST', deregUrl3, {}, deregBodyD(devD3.kp, USER, DEVD3, 'dereg-fail-nonce-01'));
    await routesF.handle(reqF, mkRes());
    const rf = { code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
    t('DEREG 节点删失败仍 200（卸载不阻断）', rf.code === 200 && rf.obj.ok === true && rf.obj.deregistered === true);
    t('DEREG 节点删失败后绑定已删', coreD.getBinding(DEVD3) === null);
    const auditTextF = fs.readdirSync(dirD).filter((f) => f.startsWith('audit-')).map((f) => fs.readFileSync(path.join(dirD, f), 'utf8')).join('\n');
    t('DEREG 节点删失败记 lea-deregistered-node-delete-failed 审计', auditTextF.includes('"ev":"lea-deregistered-node-delete-failed"'));
    // 重新绑定清墓碑：设备回来后可重新链接，旧墓碑不得残留
    coreD.recordBinding(DEVD, USER, 'dereg-relogin');
    t('DEREG 重新绑定后墓碑已清', !((coreD._test.loadDeregistered().devices || {})[bareD(DEVD)]));
    t('DEREG 重新绑定后绑定恢复 ACTIVE', !!(coreD.getBinding(DEVD) && coreD.getBinding(DEVD).state === 'ACTIVE'));
  }

  // ---------- F-04 生产 fail-closed 门禁 ----------
  // 未配置密钥 → mode='disabled'，签名直接拒，下发门拒并记审计；
  // 已配置但加载失败 → createLeaCore 抛错拒绝启动；显式临时密钥
  // 只许测试开启，且下发门仍只放行 real。只核对公钥指纹，不碰密钥内容。
  {
    const f04logs = [];
    const coreDisabled = createLeaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-f04-dis-')), enableSweeps: false, log: (e) => { f04logs.push(e); } });
    t('F04 未配密钥 signing 模式为 disabled', coreDisabled.signingInfo().mode === 'disabled');
    t('F04 未配密钥公钥为空', coreDisabled.signingInfo().publicKeyBase64 === null);
    t('F04 启动日志明确记录 signing_mode=disabled', f04logs.some((e) => e && e.ev === 'lea-signing-mode' && e.signing_mode === 'disabled'));
    let f04threw = false;
    try {
      coreDisabled.buildEnvelope({ requestId: 'req-f04-1', batchId: null, seq: 1, deviceId: DEV, accountId: USER, keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-f04-1', command: 'sys.ping', params: {}, timeoutMs: 5000 });
    } catch (e) { f04threw = true; }
    t('F04 未配密钥 buildEnvelope 直接拒（不签无密钥信封）', f04threw);
    f04threw = false;
    try { coreDisabled.signTicket({ account_id: USER, device_id: DEV, binding_epoch: 1, grant_epoch: 1, grant_muse_execute: 0, scopes: '', lease_id: 'lease-0123456789abcdef', expires_at: 1780086400 }); } catch (e) { f04threw = true; }
    t('F04 未配密钥 signTicket 直接拒', f04threw);
    // 下发门：用 real core 建的合法信封，disabled core 下发 → 拒＋审计，通道不被调用
    const f04env = core.buildEnvelope({ requestId: 'req-f04-2', batchId: null, seq: 1, deviceId: DEV, accountId: USER, keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-f04-2', command: 'sys.ping', params: {}, timeoutMs: 5000 });
    let f04chanCalled = false;
    const f04d = await coreDisabled.dispatchEnvelope({ async runCommand() { f04chanCalled = true; return '{}'; }, async nodeOnline() { return true; } }, f04env, { timeoutMs: 5000 });
    t('F04 未配密钥 dispatch 拒绝下发（signingBlocked，不调通道）', f04d.ok === false && f04d.signingBlocked === true && f04d.attempts === 0 && f04chanCalled === false);
    t('F04 未配密钥 dispatch 记 lea-dispatch-signing-blocked 审计', f04logs.some((e) => e && e.ev === 'lea-dispatch-signing-blocked' && e.signing_mode === 'disabled' && e.command === 'sys.ping'));
    // 已配置但加载失败 → 抛错拒绝启动（三种坏法：文件不存在／内容损坏／长度不对）
    let f04loadThrew = 0;
    try { createLeaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-f04-nofile-')), enableSweeps: false, signingKeyFile: path.join(os.tmpdir(), 'lea-test-f04-no-such-key.b64') }); } catch (e) { f04loadThrew++; }
    const f04badFile = path.join(tmpDir, 'lea-test-f04-bad.b64');
    fs.writeFileSync(f04badFile, '!!!not-valid-base64!!!');
    try { createLeaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-f04-bad-')), enableSweeps: false, signingKeyFile: f04badFile }); } catch (e) { f04loadThrew++; }
    const f04shortFile = path.join(tmpDir, 'lea-test-f04-short.b64');
    fs.writeFileSync(f04shortFile, Buffer.alloc(32, 1).toString('base64'));
    try { createLeaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-f04-short-')), enableSweeps: false, signingKeyFile: f04shortFile }); } catch (e) { f04loadThrew++; }
    t('F04 已配置但加载失败三种坏法均抛错拒绝启动', f04loadThrew === 3);
    let f04pemThrew = false;
    try { createLeaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-f04-pem-')), enableSweeps: false, signingKeyPem: '-----BEGIN PRIVATE KEY-----\nbad\n-----END PRIVATE KEY-----' }); } catch (e) { f04pemThrew = true; }
    t('F04 已配置但 PEM 损坏抛错拒绝启动', f04pemThrew);
    // 显式临时密钥（测试专用）：可签可验，但下发门仍拒
    const f04ephLogs = [];
    const coreEph = createLeaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-f04-eph-')), enableSweeps: false, allowEphemeralSigning: true, log: (e) => { f04ephLogs.push(e); } });
    t('F04 显式开启临时密钥模式为 placeholder-ephemeral', coreEph.signingInfo().mode === 'placeholder-ephemeral');
    const f04ephEnv = coreEph.buildEnvelope({ requestId: 'req-f04-3', batchId: null, seq: 1, deviceId: DEV, accountId: USER, keyId: g5.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-f04-3', command: 'sys.ping', params: {}, timeoutMs: 5000 });
    t('F04 显式临时密钥签名可自验', coreEph.verifyEnvelope(f04ephEnv) === true);
    const f04ephD = await coreEph.dispatchEnvelope({ async runCommand() { throw new Error('must-not-be-called'); }, async nodeOnline() { return true; } }, f04ephEnv, { timeoutMs: 5000 });
    t('F04 显式临时密钥 dispatch 仍拒绝下发（门只放行 real）', f04ephD.ok === false && f04ephD.signingBlocked === true);
    t('F04 显式临时密钥 dispatch 记审计', f04ephLogs.some((e) => e && e.ev === 'lea-dispatch-signing-blocked' && e.signing_mode === 'placeholder-ephemeral'));
    // 启动日志只记公钥指纹，不记密钥内容
    const f04realLogs = [];
    const coreReal = createLeaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-f04-real-')), enableSweeps: false, signingKeyFile: testKeyFile, log: (e) => { f04realLogs.push(e); } });
    const f04pub = coreReal.signingInfo().publicKeyBase64;
    const f04fp = crypto.createHash('sha256').update(f04pub).digest('hex').slice(0, 16);
    t('F04 真实密钥启动日志记录 signing_mode=real', f04realLogs.some((e) => e && e.ev === 'lea-signing-mode' && e.signing_mode === 'real'));
    t('F04 启动日志公钥指纹与 signingInfo 公钥 SHA-256 前 16 位一致', f04realLogs.some((e) => e && e.ev === 'lea-signing-mode' && e.public_key_fingerprint === f04fp));
    t('F04 启动日志不含公钥原文（只记指纹）', !JSON.stringify(f04realLogs).includes(f04pub));
  }

  // ---------- RC-01 握手＋ RC-02 吊销即踢 ----------
  {
    const dirRC = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-rc-'));
    const coreRC = createLeaCore({ signingKeyFile: testKeyFile, dir: dirRC, enableSweeps: false, whitelist: [DEV] });
    coreRC.grantMuse(USER, 'owner');
    coreRC.recordBinding(DEV, USER, 'rc-test');
    const gRC = coreRC.generateKey(USER, { device_scope: DEV });
    const mkEnvRC = (reqId, cmd, opts) => coreRC.buildEnvelope(Object.assign({
      requestId: reqId, batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: gRC.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-' + reqId,
      command: cmd, params: {}, timeoutMs: 5000,
    }, opts || {}));
    const fpRC = crypto.createHash('sha256').update(coreRC.signingInfo().publicKeyBase64).digest('hex').slice(0, 16);
    // RC-01：握手信封内容（sys.handshake＋指纹＋协议版本 2）且可自验
    const hsEnv = coreRC.buildHandshakeEnvelope({ deviceId: DEV, accountId: USER, keyId: gRC.record.key_id, bindingEpoch: 1, grantEpoch: 1 });
    t('RC-01 握手信封为 sys.handshake 且带服务端公钥指纹＋协议版本 2',
      hsEnv.command === 'sys.handshake' && hsEnv.params.server_pubkey_fp === fpRC && hsEnv.params.protocol_version === 2
      && hsEnv.params.server_pubkey_fp === coreRC.signingPublicKeyFingerprint());
    t('RC-01 握手信封签名可自验', coreRC.verifyEnvelope(hsEnv) === true);
    // RC-01 阴性：篡改协议版本／指纹 → 签名失效
    const hsTamperV = JSON.parse(JSON.stringify(hsEnv)); hsTamperV.params.protocol_version = 1;
    t('RC-01 伪造降级版本（protocol_version=1）签名失效', coreRC.verifyEnvelope(hsTamperV) === false);
    const hsTamperF = JSON.parse(JSON.stringify(hsEnv)); hsTamperF.params.server_pubkey_fp = '00'.repeat(8);
    t('RC-01 篡改公钥指纹签名失效', coreRC.verifyEnvelope(hsTamperF) === false);
    // RC-01：握手只做一次，第二次业务下发走缓存
    const hsCalls = [];
    const countCh = {
      async runCommand(nodeId, cmd) {
        if (cmd.includes('revoked_keys.txt')) return 'ok';
        hsCalls.push(cmd);
        if (isHandshakeDispatch(cmd)) return HANDSHAKE_OK_LINE;
        return JSON.stringify({ ok: true, code: 'done' });
      },
      async nodeOnline() { return true; },
    };
    const dRC1 = await coreRC.dispatchEnvelope(countCh, mkEnvRC('req-rc-1', 'sys.info'), { timeoutMs: 5000 });
    const dRC2 = await coreRC.dispatchEnvelope(countCh, mkEnvRC('req-rc-2', 'sys.info'), { timeoutMs: 5000 });
    t('RC-01 两次业务下发只握手一次（缓存命中）',
      dRC1.ok === true && dRC2.ok === true && hsCalls.filter((c) => isHandshakeDispatch(c)).length === 1
      && hsCalls.filter((c) => !isHandshakeDispatch(c)).length === 2);
    t('RC-01 握手态已缓存且 epochs 一致', (() => { const s = coreRC.handshakeState(DEV); return !!s && s.grantEpoch === 1 && s.bindingEpoch === 1; })());
    // RC-01：grant epoch 变化 → 缓存失效，重新握手
    const dRC3 = await coreRC.dispatchEnvelope(countCh, mkEnvRC('req-rc-3', 'sys.info', { grantEpoch: 2 }), { timeoutMs: 5000 });
    t('RC-01 grant epoch 变化即重新握手',
      dRC3.ok === true && hsCalls.filter((c) => isHandshakeDispatch(c)).length === 2);
    // RC-01：显式失效后下一次下发重新握手
    coreRC.invalidateHandshake(DEV);
    const dRC4 = await coreRC.dispatchEnvelope(countCh, mkEnvRC('req-rc-4', 'sys.info'), { timeoutMs: 5000 });
    t('RC-01 invalidateHandshake 后下一次下发重新握手',
      dRC4.ok === true && hsCalls.filter((c) => isHandshakeDispatch(c)).length === 3);
    // RC-01：握手失败（设备回 {ok:false}）→ 业务一律不投递
    coreRC.invalidateHandshake(DEV);
    let bizSent = 0;
    const hsFailCh = {
      async runCommand(nodeId, cmd) {
        if (cmd.includes('revoked_keys.txt')) return 'ok';
        if (isHandshakeDispatch(cmd)) return JSON.stringify({ ok: false, code: 'QFR_LEA_EXEC_FAILED' });
        bizSent++; return JSON.stringify({ ok: true, code: 'done' });
      },
      async nodeOnline() { return true; },
    };
    const dRCF = await coreRC.dispatchEnvelope(hsFailCh, mkEnvRC('req-rc-f', 'sys.info'), { timeoutMs: 5000 });
    t('RC-01 握手失败即拒下发（handshakeBlocked，业务 0 次）',
      dRCF.ok === false && dRCF.handshakeBlocked === true && dRCF.attempts === 0 && bizSent === 0);
    // RC-01：设备丢握手态（首个业务回 HANDSHAKE_REQUIRED）→ 失效缓存、重握、重试成功
    coreRC.invalidateHandshake(DEV);
    let bizN = 0;
    const dropCh = {
      async runCommand(nodeId, cmd) {
        if (cmd.includes('revoked_keys.txt')) return 'ok';
        if (isHandshakeDispatch(cmd)) return HANDSHAKE_OK_LINE;
        bizN++;
        if (bizN === 1) return JSON.stringify({ ok: false, code: 'QFR_LEA_HANDSHAKE_REQUIRED' });
        return JSON.stringify({ ok: true, code: 'done' });
      },
      async nodeOnline() { return true; },
    };
    const dRCD = await coreRC.dispatchEnvelope(dropCh, mkEnvRC('req-rc-d', 'sys.info'), { timeoutMs: 5000 });
    t('RC-01 设备丢握手态后重握重试成功（业务发 2 次）', dRCD.ok === true && bizN === 2);
    // RC-02：在途下发遇吊销即作废（不回执行结果）
    const gSlow = coreRC.generateKey(USER, { device_scope: DEV });
    let releaseSlow = null;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const slowCh = {
      async runCommand(nodeId, cmd) {
        if (cmd.includes('revoked_keys.txt')) return 'ok';
        if (isHandshakeDispatch(cmd)) return HANDSHAKE_OK_LINE;
        await slowGate;
        return JSON.stringify({ ok: true, code: 'done' });
      },
      async nodeOnline() { return true; },
    };
    const pSlow = coreRC.dispatchEnvelope(slowCh, coreRC.buildEnvelope({
      requestId: 'req-rc-slow', batchId: null, seq: 1, deviceId: DEV, accountId: USER,
      keyId: gSlow.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-rc-slow',
      command: 'sys.info', params: {}, timeoutMs: 5000,
    }), { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    coreRC.revokeKey(gSlow.record.key_id, USER, 'rc02-test');
    releaseSlow();
    const dSlow = await pSlow;
    t('RC-02 在途下发遇吊销即作废（revokedDuringDispatch）', dSlow.ok === false && dSlow.revokedDuringDispatch === true);
    // RC-02：吊销即取消该 Key 的 job（PENDING／RUNNING／UNKNOWN → CANCELLED），他 Key 的 job 不动
    const gJ1 = coreRC.generateKey(USER, { device_scope: DEV });
    const gJ2 = coreRC.generateKey(USER, { device_scope: DEV });
    const jobJ1 = coreRC.createJob({ account_id: USER, device_id: DEV, api_key_id: gJ1.record.key_id, command: 'sys.info', request_id: 'req-rc-j1', idempotency_key: 'idem-rc-j1', status: 'PENDING' });
    const jobJ2 = coreRC.createJob({ account_id: USER, device_id: DEV, api_key_id: gJ2.record.key_id, command: 'sys.info', request_id: 'req-rc-j2', idempotency_key: 'idem-rc-j2', status: 'RUNNING' });
    coreRC.revokeKey(gJ1.record.key_id, USER, 'rc02-test');
    t('RC-02 吊销即取消该 Key 的 PENDING job', coreRC.getJob(jobJ1.job_id).status === 'CANCELLED' && coreRC.getJob(jobJ1.job_id).error_code === 'QFR_API_KEY_REVOKED');
    t('RC-02 吊销不碰他 Key 的 job', coreRC.getJob(jobJ2.job_id).status === 'RUNNING');
    // RC-02：kick 摘要（推吊销＋发踢出命令）5 秒内完成
    const gK = coreRC.generateKey(USER, { device_scope: DEV });
    const kick = await coreRC.kickRevokedSessions(mockChannel, { keyIds: [gK.record.key_id], deviceIds: [DEV], accountId: USER, reason: 'rc02-test' });
    t('RC-02 kick 摘要 5 秒内完成', kick.ok === true && kick.within_5s === true && kick.elapsed_ms < 5000 && (kick.devices || []).length === 1);
    // RC-02：路由吊销响应含 kick 字段（吊销本身不受 kick 成败反噬）
    const routesRC = createLeaRoutes(coreRC, mockChannel, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    const gR2 = coreRC.generateKey(USER, { device_scope: DEV });
    sent.length = 0;
    await routesRC.handle(mkReq('POST', '/api/lea/v1/keys/' + gR2.record.key_id + '/revoke', {}, { password: 'correct-password' }), mkRes());
    const oR2 = sent.length ? sent[sent.length - 1] : null;
    t('RC-02 路由吊销响应含 kick 且 5 秒内', oR2 && oR2.code === 200 && oR2.obj && oR2.obj.kick && oR2.obj.kick.within_5s === true);
    // RC-02：离线通道 kick 失败也不反噬吊销（仍 200，Key 已吊销）
    const deadCh = { async runCommand() { throw new Error('svc-down'); }, async nodeOnline() { return true; }, async listNodes() { return []; } };
    const routesDead = createLeaRoutes(coreRC, deadCh, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    const gR3 = coreRC.generateKey(USER, { device_scope: DEV });
    sent.length = 0;
    await routesDead.handle(mkReq('POST', '/api/lea/v1/keys/' + gR3.record.key_id + '/revoke', {}, { password: 'correct-password' }), mkRes());
    const oR3 = sent.length ? sent[sent.length - 1] : null;
    t('RC-02 离线通道吊销仍 200 且 Key 已吊销', oR3 && oR3.code === 200 && coreRC.keyStatus(coreRC.findKeyById(gR3.record.key_id)) === 'revoked');
  }

  // ---------- RC-04) 断线重连票据：签发／核验／单次性／过期／epochs／吊销 ----------
  // 假时钟 core（now 可拨）：覆盖过期／时钟偏差／5 秒限流／只留最新，
  // 不真等 300 秒。主 core（真时钟）另做路由层测试。
  {
    const dirR = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-rc4-'));
    let fakeNow = Date.now();
    const coreR = createLeaCore({ signingKeyFile: testKeyFile, dir: dirR, enableSweeps: false, whitelist: [DEV, 'node//test-device-2'], now: () => fakeNow });
    const advance = (ms) => { fakeNow += ms; };
    const nowSecR = () => Math.floor(fakeNow / 1000);
    const shaR = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
    function codeOf(fn) { try { fn(); return null; } catch (e) { return e && e.code; } }
    function ledgerEntryFor(ticket) {
      const st = coreR._test.loadReconnectTickets();
      return Object.values(st.tickets || {}).find((tk) => tk && tk.resume_id_hash === shaR(ticket.resume_id)) || null;
    }
    coreR.grantMuse(USER, 'owner');
    coreR.recordBinding(DEV, USER, 'rc4-login');
    const gR = coreR.generateKey(USER, { device_scope: DEV });
    const S1 = 'sess-aaaaaaaaaaaaaaaa';
    const S2 = 'sess-bbbbbbbbbbbbbbbb';
    const S3 = 'sess-cccccccccccccccc';
    const issueR = (sessionId, keyRec) => coreR.issueReconnectTicket({ accountId: USER, deviceId: DEV, keyId: (keyRec || gR).record.key_id, sessionId });
    // 签名能力关闭时拒绝签发（同目录无密钥 core，只读同一台账做准入）
    const coreNoSign = createLeaCore({ dir: dirR, enableSweeps: false, whitelist: [DEV, 'node//test-device-2'], now: () => fakeNow });
    t('RC-04 签名能力非 real 时签发 → QFR_SIGNING_NOT_REAL', codeOf(() => coreNoSign.issueReconnectTicket({ accountId: USER, deviceId: DEV, keyId: gR.record.key_id, sessionId: S2 })) === 'QFR_SIGNING_NOT_REAL');
    // 签发形状
    const tk1 = issueR(S1);
    t('RC-04 签发：10 字段齐全、TTL 恰好 300、resume/session 格式',
      Object.keys(tk1).length === 10 && tk1.expires_at - tk1.issued_at === 300 &&
      /^resume-[0-9a-f]{16}$/.test(tk1.resume_id) && tk1.session_id === S1 &&
      tk1.account_id === USER && tk1.device_id === 'test-device-1' && tk1.api_key_id === gR.record.key_id &&
      typeof tk1.ticket_signature === 'string' && Buffer.from(tk1.ticket_signature, 'base64').length === 64);
    t('RC-04 签发：epochs 取自准入（与 Key 绑定／授权代次一致）',
      tk1.binding_epoch === gR.record.binding_epoch && tk1.grant_epoch === coreR.getGrant(USER).grant_epoch);
    const ledgerText = fs.readFileSync(path.join(dirR, 'reconnect-tickets.json'), 'utf8');
    t('RC-04 台账只存哈希：无票据明文 resume_id、无签名落盘',
      !ledgerText.includes(tk1.resume_id) && !ledgerText.includes(tk1.ticket_signature) && ledgerText.includes('resume_id_hash'));
    // 核验＋消费＋重放
    const v1 = coreR.verifyReconnectTicket(tk1);
    t('RC-04 核验成功返回 epochs 与 session',
      v1.ok === true && v1.session_id === S1 && v1.device_id === 'test-device-1' &&
      v1.binding_epoch === tk1.binding_epoch && v1.grant_epoch === tk1.grant_epoch);
    t('RC-04 重放同一票据 → QFR_TICKET_REUSED', codeOf(() => coreR.verifyReconnectTicket(tk1)) === 'QFR_TICKET_REUSED');
    // 消费后同 session 凭仍在效 Key 可再领（滚动续领，规范 (b)）
    advance(6000);
    const tk1b = issueR(S1);
    t('RC-04 消费后同 session 可再领新票据', !!tk1b && tk1b.resume_id !== tk1.resume_id && tk1b.session_id === S1);
    // 速率限制
    t('RC-04 同设备 5 秒内重复签发 → QFR_RATE_LIMITED', codeOf(() => issueR(S2)) === 'QFR_RATE_LIMITED');
    advance(6000);
    // 篡改／形状
    t('RC-04 篡改 device_id → QFR_TICKET_INVALID（验签失败）',
      codeOf(() => coreR.verifyReconnectTicket(Object.assign({}, tk1b, { device_id: 'test-device-2' }))) === 'QFR_TICKET_INVALID');
    t('RC-04 未知顶层字段 → QFR_TICKET_INVALID',
      codeOf(() => coreR.verifyReconnectTicket(Object.assign({}, tk1b, { extra: 1 }))) === 'QFR_TICKET_INVALID');
    t('RC-04 TTL 非 300 → QFR_TICKET_INVALID',
      codeOf(() => coreR.verifyReconnectTicket(Object.assign({}, tk1b, { expires_at: tk1b.issued_at + 299 }))) === 'QFR_TICKET_INVALID');
    t('RC-04 坏 session_id 签发 → 400 QFR_VALIDATION',
      codeOf(() => issueR('bad-session')) === 'QFR_VALIDATION');
    t('RC-04 未知 Key 签发 → QFR_API_KEY_REVOKED',
      codeOf(() => coreR.issueReconnectTicket({ accountId: USER, deviceId: DEV, keyId: 'k_0000000000', sessionId: S2 })) === 'QFR_API_KEY_REVOKED');
    // 他人 Key 代签发 → 拒绝
    coreR.grantMuse('bob', 'owner');
    coreR.recordBinding('node//test-device-2', 'bob', 'rc4-bob-login');
    const gBob = coreR.generateKey('bob', { device_scope: 'node//test-device-2' });
    t('RC-04 他人 Key 代签发 → QFR_API_KEY_REVOKED',
      codeOf(() => coreR.issueReconnectTicket({ accountId: USER, deviceId: DEV, keyId: gBob.record.key_id, sessionId: S2 })) === 'QFR_API_KEY_REVOKED');
    // 未进白名单设备签发 → admit 透传 403
    const gNW = coreR.generateKey(USER, { device_scope: 'node//test-device-3' });
    t('RC-04 未进白名单设备签发 → QFR_DEVICE_NOT_WHITELISTED',
      codeOf(() => coreR.issueReconnectTicket({ accountId: USER, deviceId: 'node//test-device-3', keyId: gNW.record.key_id, sessionId: S2 })) === 'QFR_DEVICE_NOT_WHITELISTED');
    // 正常核验 tk1b（消费掉，后面不再用）
    t('RC-04 未篡改票据核验成功', coreR.verifyReconnectTicket(tk1b).ok === true);
    // 时钟偏差：拨回 120 秒 → INVALID；拨回后过期检查不受影响
    advance(6000);
    const tk2 = issueR(S2);
    fakeNow -= 120000;
    t('RC-04 时钟偏差超 60 秒 → QFR_TICKET_INVALID', codeOf(() => coreR.verifyReconnectTicket(tk2)) === 'QFR_TICKET_INVALID');
    fakeNow += 120000;
    advance(301000);
    t('RC-04 过期（>300 秒）→ QFR_TICKET_EXPIRED', codeOf(() => coreR.verifyReconnectTicket(tk2)) === 'QFR_TICKET_EXPIRED');
    // 过期票据被清理后仍报 EXPIRED（复核 R-3：先签发一张新票触发 prune
    // 删过期条目，再验旧票）；账号含换行 → INVALID（规范串字段禁控制字符）。
    advance(6000);
    const tkP = issueR(S1);
    t('RC-04 过期条目被清理后核验仍报 QFR_TICKET_EXPIRED', codeOf(() => coreR.verifyReconnectTicket(tk2)) === 'QFR_TICKET_EXPIRED');
    t('RC-04 账号含换行 → QFR_TICKET_INVALID（规范串字段禁控制字符）',
      codeOf(() => coreR.verifyReconnectTicket(Object.assign({}, tkP, { account_id: 'alice\nx' }))) === 'QFR_TICKET_INVALID');
    // “只留最新”（RC-04 (b) 定夺 A＋附带缺口 (i)）：同 session 连领 4 张，
    // 每次签发即作废同 session 旧未消费票；最后只有第 4 张有效
    const caps = [];
    for (let i = 0; i < 4; i++) { advance(6000); caps.push(issueR(S3)); }
    t('RC-04 同 session 第 4 张签发后前 3 张均已作废（核验 → INVALID）',
      codeOf(() => coreR.verifyReconnectTicket(caps[0])) === 'QFR_TICKET_INVALID' &&
      codeOf(() => coreR.verifyReconnectTicket(caps[1])) === 'QFR_TICKET_INVALID' &&
      codeOf(() => coreR.verifyReconnectTicket(caps[2])) === 'QFR_TICKET_INVALID');
    // 消费时作废仍是兜底（R-2）：台账里直接补一条同 session 活票（模拟
    // 旧版／外部写入的并存票），核验最新票消费时须一并作废它
    const ledgerPath = path.join(dirR, 'reconnect-tickets.json');
    const ledgerJson = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const capsEntry = Object.values(ledgerJson.tickets || {}).find((tk) => tk && tk.resume_id_hash === shaR(caps[3].resume_id));
    const twinKey = shaR('rc4-twin-' + caps[3].resume_id);
    ledgerJson.tickets[twinKey] = Object.assign({}, capsEntry, { resume_id_hash: shaR('resume-twin0123456789ab') });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledgerJson));
    t('RC-04 同 session 只有最新一张可核验', coreR.verifyReconnectTicket(caps[3]).ok === true);
    const ledgerAfter = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    t('RC-04 成功消费后同 session 其余票被作废 → INVALID',
      !!(ledgerAfter.tickets[twinKey] && ledgerAfter.tickets[twinKey].voided_at));
    // 复核 R-1：直接作废（实时状态全通过）→ 仍拒绝
    advance(6000);
    const tkV = issueR(S2);
    const voidOut = coreR.voidReconnectTickets({ keyIds: [gR.record.key_id] }, 'rc4-review-test');
    t('RC-04 直接作废返回作废张数', voidOut.ok === true && voidOut.voided_count >= 1);
    t('RC-04 实时状态全通过但已作废 → QFR_TICKET_INVALID',
      codeOf(() => coreR.verifyReconnectTicket(tkV)) === 'QFR_TICKET_INVALID');
    // Key 吊销 → API_KEY_REVOKED，且台账 voided_at 已置
    advance(6000);
    const tkR = issueR(S1);
    coreR.revokeKey(gR.record.key_id, USER, 'rc4-test');
    t('RC-04 Key 吊销后核验 → QFR_API_KEY_REVOKED', codeOf(() => coreR.verifyReconnectTicket(tkR)) === 'QFR_API_KEY_REVOKED');
    t('RC-04 Key 吊销后台账 voided_at 已置',
      !!(ledgerEntryFor(tkR) && ledgerEntryFor(tkR).voided_at));
    // 同账号换绑 epoch 前进（Key 不吊销）→ BINDING_CHANGED，且台账已作废
    const gR2 = coreR.generateKey(USER, { device_scope: DEV });
    advance(6000);
    const tkB = issueR(S1, gR2);
    coreR.recordBinding(DEV, USER, 'rc4-bump', { bindingEpoch: 5 });
    t('RC-04 同账号 epoch 前进后核验 → QFR_BINDING_CHANGED', codeOf(() => coreR.verifyReconnectTicket(tkB)) === 'QFR_BINDING_CHANGED');
    t('RC-04 epoch 前进后台账 voided_at 已置',
      !!(ledgerEntryFor(tkB) && ledgerEntryFor(tkB).voided_at));
    // 授权撤销 → GRANT_REVOKED（Key 本身仍 active，先过 Key 门）
    const gR4 = coreR.generateKey(USER, { device_scope: DEV });
    advance(6000);
    const tkG = issueR(S1, gR4);
    coreR.revokeGrant(USER, 'owner');
    t('RC-04 授权撤销后核验 → QFR_GRANT_REVOKED', codeOf(() => coreR.verifyReconnectTicket(tkG)) === 'QFR_GRANT_REVOKED');
    // 注销 → BINDING_CHANGED（Key 不动，先过 Key 门；绑定已删）
    coreR.grantMuse(USER, 'owner');
    const kpR = (() => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
      return { pubB64: raw.toString('base64'), priv: privateKey };
    })();
    const issR = coreR.issueSelfBindTicket(USER, DEV, { device_name: 'RC4-PC', platform: 'windows', nonce: 'rc4-bind-nonce-01' });
    const sigComplete = coreR.ecdsaDerToP1363(crypto.sign('sha256', Buffer.from(coreR.selfBindCompleteSigningBytes({ account_id: USER, device_id: 'test-device-1', ticket: issR.ticket, challenge: issR.challenge, nonce: 'rc4-bind-nonce-01', device_pubkey: kpR.pubB64, expires_at: issR.expires_at }), 'utf8'), kpR.priv)).toString('base64');
    const doneR = coreR.completeSelfBind({ ticket: issR.ticket, account_id: USER, device_id: DEV, nonce: 'rc4-bind-nonce-01', device_pubkey: kpR.pubB64, signature: sigComplete });
    advance(6000);
    const tkD = coreR.issueReconnectTicket({ accountId: USER, deviceId: DEV, keyId: doneR.record.key_id, sessionId: S1 });
    const deregTs = nowSecR();
    const sigDereg = coreR.ecdsaDerToP1363(crypto.sign('sha256', Buffer.from(coreR.deregisterSigningBytes({ account_id: USER, device_id: 'test-device-1', nonce: 'dereg-rc4-nonce-01', timestamp: deregTs }), 'utf8'), kpR.priv)).toString('base64');
    coreR.deregisterDevice({ account_id: USER, device_id: DEV, nonce: 'dereg-rc4-nonce-01', timestamp: deregTs, signature: sigDereg });
    t('RC-04 注销后核验 → QFR_BINDING_CHANGED', codeOf(() => coreR.verifyReconnectTicket(tkD)) === 'QFR_BINDING_CHANGED');
    t('RC-04 注销后台账 voided_at 已置',
      !!(ledgerEntryFor(tkD) && ledgerEntryFor(tkD).voided_at));
  }

  // ---------- RC-04 路由层：/reconnect/issue 与 /reconnect/resume ----------
  {
    const gRC = core.generateKey(USER, { device_scope: DEV });
    // 控制台会话路径（无 Bearer）：取该账号在该设备最近的在用 Key
    core.recordBinding('node//test-device-2', USER, 'rc4-route-console');
    const gRC2 = core.generateKey(USER, { device_scope: 'node//test-device-2' });
    let rr = await callRoute('POST', '/api/lea/v1/reconnect/issue', {},
      { device_id: 'node//test-device-2', session_id: 'sess-2222222222222222' });
    t('RC-04 路由 issue 控制台会话 → 200 返回票据原文（无 ok 壳）',
      rr.code === 200 && rr.obj && !('ok' in rr.obj) && rr.obj.session_id === 'sess-2222222222222222' &&
      rr.obj.device_id === 'test-device-2' && rr.obj.expires_at - rr.obj.issued_at === 300);
    // Bearer 路径
    rr = await callRoute('POST', '/api/lea/v1/reconnect/issue',
      bearerHeaders(gRC.key),
      { device_id: DEV, session_id: 'sess-1111111111111111' });
    t('RC-04 路由 issue Bearer → 200 票据原文且 session 回显',
      rr.code === 200 && rr.obj && rr.obj.session_id === 'sess-1111111111111111' && rr.obj.device_id === 'test-device-1');
    const routeTicket = rr.obj;
    // 已出示 Bearer 但无效 → 401，不回落控制台（fail-closed）。
    // 注：本测试桩 resolveConsoleAuth 恒返回 alice，故无 Bearer 的请求
    // 会走控制台路径（上一条已覆盖）；此处只测坏 Bearer 不回落。
    rr = await callRoute('POST', '/api/lea/v1/reconnect/issue',
      { authorization: 'Bearer not-a-real-key', 'x-qfr-timestamp': String(Math.floor(Date.now() / 1000)), 'x-qfr-nonce': 'n-route-bad-1' },
      { device_id: DEV, session_id: 'sess-1111111111111111' });
    t('RC-04 路由 issue 坏 Bearer → 401 不回落控制台', rr.code === 401 && rr.obj.code === 'QFR_API_KEY_REVOKED');
    // 5 秒内重复签发 → 429
    rr = await callRoute('POST', '/api/lea/v1/reconnect/issue',
      bearerHeaders(gRC.key),
      { device_id: DEV, session_id: 'sess-3333333333333333' });
    t('RC-04 路由 issue 5 秒内重复 → 429 QFR_RATE_LIMITED', rr.code === 429 && rr.obj.code === 'QFR_RATE_LIMITED');
    // 坏 session_id → 400
    rr = await callRoute('POST', '/api/lea/v1/reconnect/issue',
      bearerHeaders(gRC.key),
      { device_id: DEV, session_id: 'bad' });
    t('RC-04 路由 issue 坏 session_id → 400', rr.code === 400 && rr.obj.code === 'QFR_VALIDATION');
    // resume 成功
    rr = await callRoute('POST', '/api/lea/v1/reconnect/resume', {}, routeTicket);
    t('RC-04 路由 resume → 200 {ok, session, device, epochs}',
      rr.code === 200 && rr.obj.ok === true && rr.obj.session_id === 'sess-1111111111111111' &&
      rr.obj.device_id === 'test-device-1' && Number.isSafeInteger(rr.obj.binding_epoch) && Number.isSafeInteger(rr.obj.grant_epoch));
    // resume 重放 → 401 REUSED
    rr = await callRoute('POST', '/api/lea/v1/reconnect/resume', {}, routeTicket);
    t('RC-04 路由 resume 重放 → 401 QFR_TICKET_REUSED', rr.code === 401 && rr.obj.code === 'QFR_TICKET_REUSED');
    // resume 垃圾体 → 401 INVALID
    rr = await callRoute('POST', '/api/lea/v1/reconnect/resume', {}, {});
    t('RC-04 路由 resume 空体 → 401 QFR_TICKET_INVALID', rr.code === 401 && rr.obj.code === 'QFR_TICKET_INVALID');
    // 吊销后 resume → 401 REVOKED（新设备桶，避 5 秒限流）
    core.recordBinding('node//test-device-3', USER, 'rc4-route-revoke');
    const gRX = core.generateKey(USER, { device_scope: 'node//test-device-3' });
    rr = await callRoute('POST', '/api/lea/v1/reconnect/issue',
      bearerHeaders(gRX.key),
      { device_id: 'node//test-device-3', session_id: 'sess-4444444444444444' });
    const routeTicketX = rr.obj;
    core.revokeKey(gRX.record.key_id, USER, 'rc4-route-test');
    rr = await callRoute('POST', '/api/lea/v1/reconnect/resume', {}, routeTicketX);
    t('RC-04 路由 resume 吊销 Key 的票据 → 401 QFR_API_KEY_REVOKED', rr.code === 401 && rr.obj.code === 'QFR_API_KEY_REVOKED');
  }

  // ---------- RC-04 互操作：L3 windows/reconnect-ticket.js 直通服务端路由 ----------
  // 服务端签发的真票据须过 L3 validateTicket；L3 store 的 issue→resume
  // 全流程须走通（issue 用 Bearer，resume 只凭票据、不带 Bearer）。
  {
    const rc04client = require('../../../../windows/reconnect-ticket');
    const dirI = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-rc4i-'));
    const coreI = createLeaCore({ signingKeyFile: testKeyFile, dir: dirI, enableSweeps: false, whitelist: [DEV] });
    coreI.grantMuse(USER, 'owner');
    coreI.recordBinding(DEV, USER, 'rc4-interop-login');
    const gI = coreI.generateKey(USER, { device_scope: DEV });
    const routesI = createLeaRoutes(coreI, mockChannel, {
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    });
    async function callI(method, url, headers, body) {
      sent.length = 0;
      const req = mkReq(method, url, headers, body);
      const res = mkRes();
      await routesI.handle(req, res);
      return { code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
    }
    const store = rc04client.createReconnectTicketStore({
      baseUrl: 'http://localhost', // 测试桩：request 直接调路由，不真发 HTTP
      request: async (method, url, body) => {
        const headers = url.endsWith('/resume') ? {} : bearerHeaders(gI.key);
        const r = await callI(method, url, headers, body);
        return { status: r.code, json: r.obj, text: JSON.stringify(r.obj) };
      },
    });
    const sessI = store.startSession();
    // 注意：此处传裸形 device_id（与 L3 自身测试一致）。生产 main.js 的
    // resolveOwnNodeId() 返回的是全形 node//… id，而 L3 issue() 用
    // `json.device_id !== did` 严格比对、服务端按规范 §1 只返裸形——
    // 全形传入时 L3 会误判 mismatch 丢票（见收尾报告“发现的互操作问题”，
    // 须 L3 线把该处比对改成裸形比对；服务端不改规范、不回全形）。
    const issuedI = await store.issue({ deviceId: 'test-device-1' });
    t('RC-04 互操作：L3 store 申领成功且服务端票据过 L3 validateTicket',
      issuedI.ok === true && store.hasUsableTicket() === true);
    const outI = await store.attemptResume({ deviceId: DEV });
    t('RC-04 互操作：L3 store attemptResume 成功、session 一致、票据已消费丢弃',
      outI.ok === true && outI.sessionId === sessI && store.hasUsableTicket() === false);
  }

  // ---------- 12) 崩溃上报接收端（CRASH-REPORT-SPEC.md） ----------
  // 注意：限流按 IP 计数，本节每个用例用不同 x-forwarded-for，避免互相
  // 挤占 5 份/小时额度；限流用例单独用一个 IP 连发 6 次。
  function crashBody(over) {
    return Object.assign({
      schema_version: 1,
      report_id: '123e4567-e89b-42d3-a456-426614174000',
      app_version: '3.0.0',
      platform: 'win32',
      os_version: 'Windows_NT 10.0.19045',
      arch: 'x64',
      crash_time: new Date().toISOString(),
      exception_type: 'uncaughtException',
      module: 'main',
      exit_code: null,
      stack: 'Error: boom\n    at main.js:1:1',
    }, over || {});
  }
  function crashHeaders(ip) {
    return { 'content-type': 'application/json', 'x-forwarded-for': ip };
  }
  async function callCrash(body, ip, extraHeaders) {
    return callRoute('POST', '/api/lea/v1/crash-report',
      Object.assign(crashHeaders(ip), extraHeaders || {}), body);
  }
  const crashDir = path.join(tmpDir, 'crash-reports');
  const crashFile = path.join(crashDir, '123e4567-e89b-42d3-a456-426614174000.json');
  r = await callCrash(crashBody(), '10.0.12.1');
  t('崩溃上报 有效报告 → 200 stored', r.code === 200 && r.obj.ok === true && r.obj.stored === true && r.obj.report_id === '123e4567-e89b-42d3-a456-426614174000');
  let crashStored = null;
  try { crashStored = JSON.parse(fs.readFileSync(crashFile, 'utf8')); } catch (e) { crashStored = null; }
  t('崩溃上报 落盘文件存在且 0600、含 received_at',
    !!crashStored && crashStored.stack === 'Error: boom\n    at main.js:1:1' && !!crashStored.received_at &&
    (fs.statSync(crashFile).mode & 0o777) === 0o600);
  r = await callCrash(crashBody(), '10.0.12.2');
  t('崩溃上报 同 report_id 重发 → 200 duplicate、不重写',
    r.code === 200 && r.obj.duplicate === true && fs.readdirSync(crashDir).filter((n) => n.endsWith('.json')).length === 1);
  const noStack = crashBody(); delete noStack.stack;
  r = await callCrash(noStack, '10.0.12.3');
  t('崩溃上报 缺字段 → 400', r.code === 400 && r.obj.code === 'VALIDATION');
  r = await callCrash(crashBody({ password: 'x' }), '10.0.12.4');
  t('崩溃上报 未知字段（含疑似敏感名）→ 400', r.code === 400 && r.obj.code === 'VALIDATION');
  r = await callCrash(crashBody({ report_id: 'not-a-uuid' }), '10.0.12.5');
  t('崩溃上报 非法 report_id → 400', r.code === 400);
  r = await callCrash(crashBody({ crash_time: 'not-a-time' }), '10.0.12.6');
  t('崩溃上报 非法 crash_time → 400', r.code === 400);
  r = await callCrash(crashBody({ crash_time: new Date(Date.now() + 3600000).toISOString() }), '10.0.12.7');
  t('崩溃上报 未来 crash_time → 400', r.code === 400);
  r = await callCrash(crashBody({ stack: 's'.repeat(130 * 1024) }), '10.0.12.8');
  t('崩溃上报 stack 超 128KB → 400', r.code === 400);
  r = await callCrash(crashBody({ stack: 'y'.repeat(210 * 1024) }), '10.0.12.9');
  t('崩溃上报 请求体超 200KB → 413', r.code === 413 && r.obj.code === 'QFR_CRASH_TOO_LARGE');
  r = await callRoute('POST', '/api/lea/v1/crash-report', { 'content-type': 'text/plain', 'x-forwarded-for': '10.0.12.10' }, crashBody());
  t('崩溃上报 Content-Type 非 JSON → 415', r.code === 415 && r.obj.code === 'QFR_CRASH_UNSUPPORTED_MEDIA');
  r = await callRoute('POST', '/api/lea/v1/crash-report', { 'x-forwarded-for': '10.0.12.11' }, crashBody());
  t('崩溃上报 缺 Content-Type → 415', r.code === 415);
  r = await callCrash(['not', 'an', 'object'], '10.0.12.12');
  t('崩溃上报 数组体 → 400', r.code === 400);
  r = await callRoute('GET', '/api/lea/v1/crash-report', crashHeaders('10.0.12.13'), {});
  t('崩溃上报 GET → 404（无列表／查询口）', r.code === 404);
  let rlCodes = [];
  for (let i = 0; i < 6; i++) {
    const rr = await callCrash(crashBody({ report_id: '123e4567-e89b-42d3-a456-4266141740' + String(i).padStart(2, '0') }), '10.0.12.99');
    rlCodes.push(rr.code);
  }
  t('崩溃上报 同 IP 第 6 份 → 429 限流，前 5 份 200',
    JSON.stringify(rlCodes) === JSON.stringify([200, 200, 200, 200, 200, 429]));
  r = await callCrash(crashBody(), '10.0.12.99');
  t('崩溃上报 限流后仍 429', r.code === 429 && r.obj.code === 'QFR_RATE_LIMITED');

  // ---------- 13) C-4（S-089/S-091/S-092/S-093，2026-11-15） ----------
  // S-091 可信 IP：XFF 首段伪造不再决定限流键。
  {
    // 固定 XFF 首段伪造值、末段真实值：6 份应按末段 203.0.113.9 计
    // （5×200＋429）；随后单用首段 1.2.3.4 发 1 份应 200（不同桶）。
    let codes = [];
    for (let i = 0; i < 6; i++) {
      const rr = await callRoute('POST', '/api/lea/v1/crash-report',
        { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
        crashBody({ report_id: '123e4567-e89b-42d3-a456-4266141741' + String(i).padStart(2, '0') }));
      codes.push(rr.code);
    }
    t('S-091 XFF 伪造首段不决定限流键（末段 203.0.113.9 计 5×200＋429）',
      JSON.stringify(codes) === JSON.stringify([200, 200, 200, 200, 200, 429]));
    r = await callRoute('POST', '/api/lea/v1/crash-report',
      { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      crashBody({ report_id: '123e4567-e89b-42d3-a456-426614174199' }));
    t('S-091 伪造首段 1.2.3.4 单独成桶（不受 203.0.113.9 限流牵连）', r.code === 200);
    // CF-Connecting-IP 优先于 XFF。
    codes = [];
    for (let i = 0; i < 6; i++) {
      const rr = await callRoute('POST', '/api/lea/v1/crash-report',
        { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9', 'cf-connecting-ip': '198.51.100.7' },
        crashBody({ report_id: '123e4567-e89b-42d3-a456-4266141742' + String(i).padStart(2, '0') }));
      codes.push(rr.code);
    }
    t('S-091 CF-Connecting-IP 优先（198.51.100.7 计 5×200＋429）',
      JSON.stringify(codes) === JSON.stringify([200, 200, 200, 200, 200, 429]));
    // 非回环直连：XFF 全忽略，只信 socket IP。
    codes = [];
    for (let i = 0; i < 6; i++) {
      sent.length = 0;
      const req = { method: 'POST', url: '/api/lea/v1/crash-report', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.12.200' }, _body: crashBody({ report_id: '123e4567-e89b-42d3-a456-4266141743' + String(i).padStart(2, '0') }), socket: { remoteAddress: '203.0.113.50' } };
      await routes.handle(req, mkRes());
      codes.push(sent.length ? sent[sent.length - 1].code : null);
    }
    t('S-091 非回环直连忽略 XFF（socket 203.0.113.50 计 5×200＋429）',
      JSON.stringify(codes) === JSON.stringify([200, 200, 200, 200, 200, 429]));
    r = await callCrash(crashBody({ report_id: '123e4567-e89b-42d3-a456-426614174399' }), '10.0.12.200');
    t('S-091 直连后回环 XFF 10.0.12.200 另成桶（200）', r.code === 200);
    // S-091：非法请求不再耗尽全局额度——同一 IP 25 份非法体后，
    // 该 IP 的合法报告仍 200（非法桶 20/小时满后才 429，与全局无关）。
    for (let i = 0; i < 21; i++) {
      await callCrash(crashBody({ password: 'x' }), '10.0.13.77');
    }
    r = await callCrash(crashBody({ report_id: '123e4567-e89b-42d3-a456-426614174377' }), '10.0.13.77');
    t('S-091 非法体 21 份后同 IP 合法报告仍 200（非法桶独立）', r.code === 200);
    r = await callCrash(crashBody({ password: 'x' }), '10.0.13.77');
    t('S-091 非法体超 20/小时 → 429（独立桶生效）', r.code === 429 && r.obj.code === 'QFR_RATE_LIMITED');
  }
  // S-093 L-01～L-04、L-07、L-08 与 S-092 脱敏。
  {
    r = await callCrash(crashBody({ password: 's3cret-value' }), '10.0.14.1');
    t('L-01 未知字段只回固定文案（不回显字段名／值）',
      r.code === 400 && r.obj.msg === '请求含未知字段。' && !String(r.obj.msg).includes('password'));
    const noStack = crashBody(); delete noStack.stack;
    r = await callCrash(noStack, '10.0.14.2');
    t('L-01 缺失字段只回固定文案', r.code === 400 && r.obj.msg === '请求缺少必填字段。');
    r = await callCrash(crashBody({ crash_time: 'Nov 15 2026' }), '10.0.14.3');
    t('L-02 非 ISO 时间 "Nov 15 2026" → 400', r.code === 400);
    r = await callCrash(crashBody({ crash_time: '2026/11/15' }), '10.0.14.4');
    t('L-02 非 ISO 时间 "2026/11/15" → 400', r.code === 400);
    r = await callCrash(crashBody({ report_id: '123e4567-e89b-42d3-a456-426614174401', crash_time: new Date().toISOString().replace('Z', '+08:00') }), '10.0.14.5');
    t('L-02 带时区偏移的 ISO 时间通过', r.code === 200);
    const upperId = '123E4567-E89B-42D3-A456-426614174402';
    r = await callCrash(crashBody({ report_id: upperId }), '10.0.14.6');
    const lowerFile = path.join(crashDir, upperId.toLowerCase() + '.json');
    t('L-03 大写 UUID 归一小写落盘', r.code === 200 && r.obj.stored === true && fs.existsSync(lowerFile) && !fs.existsSync(path.join(crashDir, upperId + '.json')));
    r = await callCrash(crashBody({ report_id: upperId.toLowerCase() }), '10.0.14.7');
    t('L-03 大小写变体二次上报判 duplicate', r.code === 200 && r.obj.duplicate === true);
    // L-04：并发同 report_id 只落一份盘（两个调用共用套件 sent 数组，
    // 响应体归属不可靠，改以落盘文件数＋审计行的 stored/duplicate 计断言）。
    const concId = '123e4567-e89b-42d3-a456-426614174403';
    const conc = await Promise.all([
      callCrash(crashBody({ report_id: concId }), '10.0.14.8'),
      callCrash(crashBody({ report_id: concId }), '10.0.14.8'),
    ]);
    const concFiles = fs.readdirSync(crashDir).filter((n) => n === concId + '.json').length;
    const _d2 = new Date();
    const _p22 = (n) => String(n).padStart(2, '0');
    const auditToday = path.join(tmpDir, 'audit-' + _d2.getFullYear() + '-' + _p22(_d2.getMonth() + 1) + '-' + _p22(_d2.getDate()) + '.jsonl');
    let auditLines = [];
    try { auditLines = fs.readFileSync(auditToday, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.report_id === concId); } catch (e) { auditLines = []; }
    const auditStored = auditLines.filter((e) => e.result === 'stored').length;
    const auditDup = auditLines.filter((e) => e.result === 'duplicate').length;
    t('L-04 并发同 report_id 只落一份盘、审计恰一 stored 一 duplicate',
      conc.every((x) => x.code === 200) && concFiles === 1 && auditStored === 1 && auditDup === 1);
    // S-092：堆栈路径与凭据形态脱敏后落盘。
    const scrubId = '123e4567-e89b-42d3-a456-426614174404';
    r = await callCrash(crashBody({ report_id: scrubId, stack: 'Error: x\n    at C:\\Users\\Wayne\\AppData\\Local\\QFRemote\\main.js:10:5\n    at /home/wayne/secret-note.txt:3:1\n    at load token: abc123def' }), '10.0.14.9');
    let scrubStored = null;
    try { scrubStored = JSON.parse(fs.readFileSync(path.join(crashDir, scrubId + '.json'), 'utf8')); } catch (e) { scrubStored = null; }
    t('S-092 落盘堆栈已脱敏（用户名／路径／token 形态均掩码）',
      r.code === 200 && !!scrubStored && !scrubStored.stack.includes('Wayne') && !scrubStored.stack.includes('wayne')
      && scrubStored.stack.includes('C:\\Users\\<redacted>') && scrubStored.stack.includes('/home/<redacted>')
      && scrubStored.stack.includes('token: <redacted>'));
    // L-07：超期 tmp 孤儿随下次落盘清理。
    const orphan = path.join(crashDir, '123e4567-e89b-42d3-a456-426614174405.json.tmp-1-abcdef');
    fs.writeFileSync(orphan, 'orphan');
    fs.utimesSync(orphan, new Date(Date.now() - 2 * 3600 * 1000), new Date(Date.now() - 2 * 3600 * 1000));
    r = await callCrash(crashBody({ report_id: '123e4567-e89b-42d3-a456-426614174406' }), '10.0.14.10');
    t('L-07 超期 .tmp 孤儿随落盘清理', r.code === 200 && !fs.existsSync(orphan));
    // L-08：审计写失败 → 503（把当日审计文件先占成目录，事后恢复）。
    const _d = new Date();
    const _p2 = (n) => String(n).padStart(2, '0');
    const auditName = 'audit-' + _d.getFullYear() + '-' + _p2(_d.getMonth() + 1) + '-' + _p2(_d.getDate()) + '.jsonl';
    const auditPath = path.join(tmpDir, auditName);
    let auditExisted = false;
    try { if (fs.existsSync(auditPath)) { auditExisted = true; fs.renameSync(auditPath, auditPath + '.bak-c4'); } } catch (e) {}
    try { fs.mkdirSync(auditPath); } catch (e) {}
    r = await callCrash(crashBody({ report_id: '123e4567-e89b-42d3-a456-426614174407' }), '10.0.14.11');
    t('L-08 审计写失败回 503（不谎报 200）', r.code === 503 && r.obj.code === 'QFR_CRASH_AUDIT_FAILED');
    try { fs.rmdirSync(auditPath); } catch (e) {}
    try { if (auditExisted) fs.renameSync(auditPath + '.bak-c4', auditPath); } catch (e) {}
    r = await callCrash(crashBody({ report_id: '123e4567-e89b-42d3-a456-426614174408' }), '10.0.14.12');
    t('L-08 审计恢复后上报回 200', r.code === 200);
  }
  // S-089：执行限流（专用 Key，61 次 sys.info → 前 60 个 200，第 61 个 429）；
  // 批量步数上限 20（21 步 → 400）。
  {
    const gR = core.generateKey(USER, { device_scope: DEV });
    let codes = [];
    for (let i = 0; i < 61; i++) {
      const rr = await callRoute('POST', '/api/lea/v1/execute',
        Object.assign(bearerHeaders(gR.key), { 'idempotency-key': 'c4-rate-' + String(i).padStart(3, '0') }),
        { device_id: DEV, command: 'sys.info', params: {} });
      codes.push(rr.code);
    }
    t('S-089 同 Key 执行 61 次 → 前 60 个 200、第 61 个 429',
      codes.slice(0, 60).every((c) => c === 200) && codes[60] === 429);
    const rr429 = await callRoute('POST', '/api/lea/v1/execute',
      Object.assign(bearerHeaders(gR.key), { 'idempotency-key': 'c4-rate-429' }),
      { device_id: DEV, command: 'sys.info', params: {} });
    t('S-089 限流回 QFR_RATE_LIMITED', rr429.code === 429 && rr429.obj.code === 'QFR_RATE_LIMITED');
    const manySteps = [];
    for (let i = 0; i < 21; i++) manySteps.push({ command: 'sys.info', params: {} });
    const rb = await callRoute('POST', '/api/lea/v1/batches',
      Object.assign(bearerHeaders(gR.key), { 'idempotency-key': 'c4-batch-21' }),
      { device_id: DEV, steps: manySteps });
    t('S-089 批量 21 步 → 400（上限 20）', rb.code === 400 && String(rb.obj.msg || '').includes('20'));
  }
  // S-083：统一诊断事件（server/ext/qf-diagnostics.js）。
  {
    const diag = require('../../qf-diagnostics');
    const ev = diag.buildDiagnosticEvent({
      app_version: '3.0.0', platform: 'server', trace_id: 'req_abc',
      session_id: 'sess-secret-value', stage: 'execute', error_code: 'QFR_RATE_LIMITED',
      retry_attempt: 2, duration_ms: 123, password: 'nope', cookie: 'xid=abc',
      token: 'tok', input: 'hello', account_id: 'alice', device_id: DEV,
    });
    t('S-083 诊断事件禁键全丢（密码／cookie／token／输入内容）',
      !('password' in ev) && !('cookie' in ev) && !('token' in ev) && !('input' in ev));
    t('S-083 诊断事件保留 P2-05 字段', ev.trace_id === 'req_abc' && ev.stage === 'execute'
      && ev.error_code === 'QFR_RATE_LIMITED' && ev.retry_attempt === 2 && ev.duration_ms === 123
      && ev.account_id === 'alice' && !!ev.timestamp);
    t('S-083 session_id 只留 16 位指纹、不存原文',
      typeof ev.session_id === 'string' && ev.session_id.length === 16 && ev.session_id !== 'sess-secret-value'
      && ev.session_id === diag.hashSessionId('sess-secret-value'));
    t('S-083 审计禁键过滤保留合法字段',
      (() => { const s = diag.scrubForbiddenKeys({ account_id: 'a', password: 'x', direction: 'reply' }); return s.account_id === 'a' && s.direction === 'reply' && !('password' in s); })());
  }

  console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '；失败 ' + fail + (failures.length ? '：' + failures.join('；') : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
