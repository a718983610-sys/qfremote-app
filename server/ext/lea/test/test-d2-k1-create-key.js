'use strict';
/*
 * D2-K1 创建 Key 时验归属专项断言（2026-11-18）
 * 验合并树内 D1+D2 v2+K1 移植后的文件。
 * 覆盖 GPT D1＋D2 最后两项裁决 ④ 的 7 项验收用例＋路由层错误映射：
 *   K1  A 为 A 的设备创建 Key → 200
 *   K2  A 为 B 的设备创建 Key → 403 QFR_SCOPE_DENIED，不生成 Key
 *   K3  A 输入未知设备 ID → 不生成 Key，且不泄露其他账户设备信息
 *   K4  A 的设备正在绑定确认中 → 409 QFR_LEA_BINDING_PENDING
 *   K5  B 为 A 的待确认设备创建 Key → 403（不向非归属方透露 PENDING 状态）
 *   K6  非法设备 ID → 400 VALIDATION
 *   K7  危险 scope 与归属拒绝同为 403 但文案须区分
 *   K8  归属拒绝记审计（只记请求账号与请求设备，不记设备实际归属）
 *   K9  Key 创建后设备换绑 → 旧 Key 无法控制该设备，新归属方可建新 Key
 *   K10 路由层：core 抛 QFR_VISIBILITY_UNAVAILABLE → 503（防御性映射）
 *   C1-C8 Core 层：直接调 generateKey 的旁路同样受限；显式与自动取设备
 *       走同一套校验；非法请求被拒绝后台账 Key 数量不增加、无明文返回。
 *   S1-S4 补充（GPT D2-K1 确认裁决 §三）：
 *       S1 本人设备离线、绑定 ACTIVE → 可创建 Key；执行按在线状态拒绝
 *       S2 MeshCentral 通道不可达、台账正常 → 可创建 Key；执行 503
 *       S3 设备已换绑给他人，旧账户创建 → 403
 *       S4 创建与换绑同时发生 → 不得留下可用于旧归属设备的有效 Key
 * 运行：node test-d2-k1-create-key.js（在本目录）
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

const seed = Buffer.from([...Array(32).keys()]);
const privDer = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const privKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
const pubBytes = crypto.createPublicKey(privKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-k1-'));
const keyFile = path.join(tmpDir, 'test-signing-key.b64');
fs.writeFileSync(keyFile, Buffer.concat([seed, pubBytes]).toString('base64'));
const WL = ['node//d2-k1-dev-1', 'node//d2-k1-dev-2', 'node//d2-k1-dev-3', 'node//d2-k1-dev-pend', 'node//d2-k1-unknown'];
const core = createLeaCore({ dir: tmpDir, enableSweeps: false, signingKeyFile: keyFile, whitelist: WL });

const ALICE = 'alice', BOB = 'bob';
const DEV1 = 'node//d2-k1-dev-1', DEV2 = 'node//d2-k1-dev-2', DEV3 = 'node//d2-k1-dev-3';
const PEND = 'node//d2-k1-dev-pend', UNKNOWN = 'node//d2-k1-unknown';
const mockChannel = {
  async listNodes() { return [{ _id: DEV1, conn: 1 }, { _id: DEV2, conn: 1 }, { _id: DEV3, conn: 1 }, { _id: PEND, conn: 1 }]; },
  async nodeOnline() { return true; },
};
// S1/S2 补充用例（GPT D2-K1 确认裁决 §三）：离线通道与不可达通道。
// nodeOnline false＝设备离线；抛错＝通道不可达（路由层按 null 处理 → 503）。
const offlineChannel = {
  async listNodes() { return [{ _id: DEV1, conn: 0 }, { _id: DEV2, conn: 0 }, { _id: DEV3, conn: 0 }, { _id: PEND, conn: 0 }]; },
  async nodeOnline() { return false; },
};
const downChannel = {
  async listNodes() { throw new Error('meshcentral-channel-down'); },
  async nodeOnline() { throw new Error('meshcentral-channel-down'); },
};
core.recordBinding(DEV1, ALICE, 'k1-setup');
core.recordBinding(DEV2, BOB, 'k1-setup');
core.recordBinding(DEV3, ALICE, 'k1-setup');
// PENDING 绑定：recordBinding 只写 ACTIVE，故直接写 bindings.json 构造
// （与 D2 B7 改写 keys.json 同款夹具手法，仅测试用）。
{
  const bPath = path.join(tmpDir, 'bindings.json');
  const st = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  st.bindings['d2-k1-dev-pend'] = { device_id: 'd2-k1-dev-pend', account_id: ALICE, binding_epoch: 1, state: 'PENDING', updated_at: Date.now(), trigger: 'k1-setup' };
  fs.writeFileSync(bPath, JSON.stringify(st));
}
core.grantMuse(ALICE, 'owner');
core.grantMuse(BOB, 'owner');

const sent = [];
function mkRoutes(sessionUser, coreOverride, channelOverride) {
  const deps = {
    sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
    readJsonBody: async (req) => req._body || {},
    log: () => {},
    verifyPassword: async () => true,
    resolveConsoleAuth: async () => (sessionUser ? { user: sessionUser, siteadmin: 0 } : null),
    isSiteAdmin: (a) => a.user === '718983610',
    listVisibleDeviceIds: async () => [DEV1, DEV2, DEV3, PEND],
  };
  return createLeaRoutes(coreOverride || core, channelOverride || mockChannel, deps);
}
async function callRoute(rts, method, url, headers, body) {
  sent.length = 0;
  const req = { method, url, headers: headers || {}, _body: body || {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = {};
  const matched = await rts.handle(req, res);
  return { matched, code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
}
function keyCount() { return core.listKeys(ALICE).length + core.listKeys(BOB).length; }
// S1/S2：经执行路由调一条命令（admit ③ 通过后才到 nodeOnline 门）。
// 每次调用用独立 nonce 与幂等键，防重放／幂等拦截。
async function callExecute(rts, plainKey, deviceId, tag) {
  const headers = {
    authorization: 'Bearer ' + plainKey,
    'x-qfr-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-qfr-nonce': tag + '-nonce-0001',
    'idempotency-key': tag + '-idem-0001',
    'x-qfr-request-id': tag + '-req-00001',
  };
  return callRoute(rts, 'POST', '/api/lea/v1/execute', headers, { device_id: deviceId, command: 'ui.click', params: {} });
}
function auditText() {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith('audit-'))
    .map((f) => fs.readFileSync(path.join(tmpDir, f), 'utf8')).join('\n');
}
const OWNERSHIP_MSG = '当前账户无权为该设备创建 API Key，请检查设备绑定状态。';

(async () => {
  // ---------- K1：A 为 A 的设备创建 Key → 200 ----------
  let n0 = keyCount();
  let r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV1 });
  t('K1 A 为 A 的设备创建 Key → 200 且返回明文一次', r.code === 200 && /^qfr_lea_/.test(r.obj.key || ''));
  t('K1 生成的 Key scope 归一后为该设备 id', r.code === 200 && core.bareNodeId(r.obj.record.device_scope) === 'd2-k1-dev-1');
  t('K1 生成的 Key binding_epoch 与当前绑定一致', r.code === 200 && r.obj.record.binding_epoch === core.getBinding(DEV1).binding_epoch);
  t('K1 成功创建后台账 Key 数量 +1', keyCount() === n0 + 1);

  // ---------- K2：A 为 B 的设备创建 Key → 403，不生成 Key ----------
  n0 = keyCount();
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV2 });
  t('K2 A 为 B 的设备创建 Key → 403 QFR_SCOPE_DENIED', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  t('K2 归属拒绝用统一文案', r.code === 403 && r.obj.msg === OWNERSHIP_MSG);
  t('K2 归属拒绝不透露设备属于谁', r.code === 403 && !JSON.stringify(r.obj).includes(BOB));
  t('K2 归属拒绝不返回明文 Key', r.code === 403 && !('key' in r.obj));
  t('K2 归属拒绝后台账 Key 数量不增加', keyCount() === n0);

  // ---------- K3：A 输入未知设备 ID → 不生成 Key，且不泄露信息 ----------
  n0 = keyCount();
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: UNKNOWN });
  t('K3 未知设备 ID → 403（不以 404 区分不存在与非本人设备）', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  t('K3 未知设备拒绝文案与跨账户拒绝一致', r.code === 403 && r.obj.msg === OWNERSHIP_MSG);
  t('K3 未知设备拒绝后台账 Key 数量不增加', keyCount() === n0);

  // ---------- K4/K5：绑定确认中 ----------
  n0 = keyCount();
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: PEND });
  t('K4 本人设备绑定确认中 → 409 QFR_LEA_BINDING_PENDING', r.code === 409 && r.obj.code === 'QFR_LEA_BINDING_PENDING');
  t('K4 绑定确认中不提前签发（台账不增加）', keyCount() === n0);
  r = await callRoute(mkRoutes(BOB), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: PEND });
  t('K5 他人为待确认设备创建 Key → 403（不向非归属方透露 PENDING 状态）', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  t('K5 他人待确认设备拒绝文案为统一归属文案', r.code === 403 && r.obj.msg === OWNERSHIP_MSG);

  // ---------- K6：非法设备 ID → 400 ----------
  n0 = keyCount();
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: 'node//bad\nid' });
  t('K6 含换行的设备 ID → 400 VALIDATION', r.code === 400 && r.obj.code === 'VALIDATION');
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: '   ' });
  t('K6 全空白设备 ID → 400 VALIDATION', r.code === 400 && r.obj.code === 'VALIDATION');
  t('K6 非法设备 ID 拒绝后台账 Key 数量不增加', keyCount() === n0);

  // ---------- K7：危险 scope 与归属拒绝同为 403 但文案须区分 ----------
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV1, scopes: ['muse.execute', 'muse.execute.dangerous'] });
  t('K7 无审批选 dangerous scope → 403 且为危险授权文案（非归属文案）', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED' && /dangerous/.test(r.obj.msg || '') && r.obj.msg !== OWNERSHIP_MSG);

  // ---------- K8：归属拒绝记审计 ----------
  {
    const a0 = auditText();
    await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV2 });
    const fresh = auditText().slice(a0.length);
    t('K8 归属拒绝记 lea-key-create-denied/device-ownership 审计', fresh.includes('lea-key-create-denied') && fresh.includes('device-ownership'));
    t('K8 归属拒绝审计不记设备实际归属账号', !fresh.includes('"current_account_id"'));
  }

  // ---------- K9：Key 创建后设备换绑 → 旧 Key 无法控制 ----------
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV3 });
  t('K9 换绑前为 DEV3 建 Key → 200', r.code === 200 && !!r.obj.key);
  const k9id = r.obj.record.key_id;
  core.recordBinding(DEV3, BOB, 'k1-rebind');
  t('K9 换绑后旧 Key 状态 revoked_by_rebind', core.keyStatus(core.findKeyById(k9id)) === 'revoked_by_rebind');
  const adm9 = core.admit({ key: core.findKeyById(k9id), deviceId: DEV3, command: 'ui.click' });
  t('K9 换绑后旧 Key 准入失败（无法控制该设备）', adm9.ok === false);
  r = await callRoute(mkRoutes(BOB), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV3 });
  t('K9 换绑后新归属方为 DEV3 建 Key → 200', r.code === 200 && !!r.obj.key);

  // ---------- K10：路由层防御性映射（core 抛 QFR_VISIBILITY_UNAVAILABLE → 503） ----------
  {
    const proxyCore = Object.assign({}, core, { generateKey() { const e = new Error('ownership authority down'); e.code = 'QFR_VISIBILITY_UNAVAILABLE'; throw e; } });
    r = await callRoute(mkRoutes(ALICE, proxyCore), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV1 });
    t('K10 core 抛 QFR_VISIBILITY_UNAVAILABLE → 路由 503', r.code === 503 && r.obj.code === 'QFR_VISIBILITY_UNAVAILABLE');
  }

  // ---------- C：Core 层直接调 generateKey 的旁路 ----------
  n0 = keyCount();
  let threw = null;
  try { core.generateKey(ALICE, { device_scope: DEV2 }); } catch (e) { threw = e; }
  t('C1 直接调 generateKey 为他人设备 → 抛 QFR_SCOPE_DENIED', !!threw && threw.code === 'QFR_SCOPE_DENIED' && threw.reason === 'device-ownership');
  threw = null;
  try { core.generateKey(ALICE, { device_scope: UNKNOWN }); } catch (e) { threw = e; }
  t('C2 直接调 generateKey 未知设备 → 抛 QFR_SCOPE_DENIED', !!threw && threw.code === 'QFR_SCOPE_DENIED');
  threw = null;
  try { core.generateKey(ALICE, { device_scope: PEND }); } catch (e) { threw = e; }
  t('C3 直接调 generateKey 待确认设备 → 抛 QFR_LEA_BINDING_PENDING', !!threw && threw.code === 'QFR_LEA_BINDING_PENDING');
  threw = null;
  try { core.generateKey(ALICE, { device_scope: 'node//bad\nid' }); } catch (e) { threw = e; }
  t('C4 直接调 generateKey 非法设备 ID → 抛 VALIDATION', !!threw && threw.code === 'VALIDATION');
  t('C5 旁路拒绝后 Core 台账 Key 数量不增加', keyCount() === n0);
  threw = null;
  let okKey = null;
  try { okKey = core.generateKey(ALICE, { device_scope: DEV1 }); } catch (e) { threw = e; }
  t('C6 直接调 generateKey 为本人设备 → 成功且 epoch 与绑定一致', !threw && !!okKey && okKey.record.binding_epoch === core.getBinding(DEV1).binding_epoch);

  // ---------- C7/C8：显式与自动取设备走同一套 Core 校验 ----------
  {
    const dirPend = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-k1-pend-'));
    const corePend = createLeaCore({ dir: dirPend, enableSweeps: false, signingKeyFile: keyFile, whitelist: WL });
    corePend.grantMuse(ALICE, 'owner');
    const bPath = path.join(dirPend, 'bindings.json');
    fs.writeFileSync(bPath, JSON.stringify({ bindings: { 'd2-k1-dev-pend': { device_id: 'd2-k1-dev-pend', account_id: ALICE, binding_epoch: 1, state: 'PENDING', updated_at: Date.now(), trigger: 'k1-setup' } } }));
    let tPend = null;
    try { corePend.generateKey(ALICE, {}); } catch (e) { tPend = e; }
    t('C7 自动取唯一设备（PENDING）→ 同样 409（显式与自动取走同一套校验）', !!tPend && tPend.code === 'QFR_LEA_BINDING_PENDING');
    const dirAuto = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-k1-auto-'));
    const coreAuto = createLeaCore({ dir: dirAuto, enableSweeps: false, signingKeyFile: keyFile, whitelist: WL });
    coreAuto.grantMuse(ALICE, 'owner');
    coreAuto.recordBinding(DEV1, ALICE, 'k1-auto');
    let autoKey = null;
    try { autoKey = coreAuto.generateKey(ALICE, {}); } catch (e) { autoKey = null; }
    t('C8 自动取唯一设备（ACTIVE）→ 成功且 scope 为该设备', !!autoKey && autoKey.record.device_scope === 'd2-k1-dev-1');
  }

  // ---------- S：GPT D2-K1 确认裁决 §三 四个专项用例（补充） ----------
  // 说明：创建 Key 只查可信绑定台账，不查运行时在线状态；执行时 admit() ③
  // 复核绑定、授权和代次，再由执行通道 nodeOnline() 查当前可执行状态。
  // nodeOnline() 只证明节点能否通过当前通道访问，不证明该账户具有
  // MeshCentral 节点可见权限（见 SUPPLEMENT.md §1）。
  // 顺序说明：S3 复用 K9 换绑后的 DEV3（已绑 BOB）；S4 用 DEV1 且放在最后，
  // 其换绑副作用不影响后续用例。

  // S1：本人设备离线，绑定仍 ACTIVE → 可以创建 Key；执行按在线状态拒绝。
  let s1Key = null;
  r = await callRoute(mkRoutes(ALICE, null, offlineChannel), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV1 });
  t('S1 本人设备离线（nodeOnline false）仍可创建 Key → 200', r.code === 200 && !!r.obj.key);
  if (r.code === 200) s1Key = r.obj.key;
  if (s1Key) {
    const e1 = await callExecute(mkRoutes(ALICE, null, offlineChannel), s1Key, DEV1, 's1-exec');
    t('S1 离线设备执行命令 → 503 QFR_LEA_NOT_INSTALLED', e1.code === 503 && e1.obj.code === 'QFR_LEA_NOT_INSTALLED');
    t('S1 离线拒绝文案为设备未安装或不在线', e1.code === 503 && /不在线/.test(e1.obj.msg || ''));
  } else {
    t('S1 离线设备执行命令 → 503 QFR_LEA_NOT_INSTALLED', false, 'S1 未建成 Key');
    t('S1 离线拒绝文案为设备未安装或不在线', false, 'S1 未建成 Key');
  }

  // S2：MeshCentral 通道不可达，可信绑定台账正常 → 可以创建 Key；
  // 实际执行按在线状态拒绝（通道不可达 → 503）。
  let s2Key = null;
  r = await callRoute(mkRoutes(ALICE, null, downChannel), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV1 });
  t('S2 MeshCentral 通道不可达仍可创建 Key → 200', r.code === 200 && !!r.obj.key);
  t('S2 通道不可达时创建的 Key 代次与当前绑定一致', r.code === 200 && r.obj.record.binding_epoch === core.getBinding(DEV1).binding_epoch);
  if (r.code === 200) s2Key = r.obj.key;
  if (s2Key) {
    const e2 = await callExecute(mkRoutes(ALICE, null, downChannel), s2Key, DEV1, 's2-exec');
    t('S2 通道不可达时执行命令 → 503 QFR_LEA_NOT_INSTALLED', e2.code === 503 && e2.obj.code === 'QFR_LEA_NOT_INSTALLED');
    t('S2 通道不可达拒绝文案为下发通道暂时不可达', e2.code === 503 && /暂时不可达/.test(e2.obj.msg || ''));
  } else {
    t('S2 通道不可达时执行命令 → 503 QFR_LEA_NOT_INSTALLED', false, 'S2 未建成 Key');
    t('S2 通道不可达拒绝文案为下发通道暂时不可达', false, 'S2 未建成 Key');
  }

  // S3：设备已换绑给其他账户，旧账户仍尝试创建 → 403，不能创建。
  // （DEV3 在 K9 已换绑给 BOB；此处再显式换绑一次使本用例自足——同账号
  // 重复换绑不升代次、不吊销。）
  core.recordBinding(DEV3, BOB, 'supp-s3');
  n0 = keyCount();
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV3 });
  t('S3 设备已换绑给他人，旧账户创建 → 403 QFR_SCOPE_DENIED', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  t('S3 换绑后旧账户拒绝文案为统一归属文案', r.code === 403 && r.obj.msg === OWNERSHIP_MSG);
  t('S3 换绑后旧账户拒绝后无明文返回且台账不增加', r.code === 403 && !('key' in r.obj) && keyCount() === n0);

  // S4：创建与换绑同时发生 → 不得留下可用于旧归属设备的有效 Key。
  // 补充说明：Node 单进程内 generateKey 全程同步、最终复核与写入之间无
  // await，故进程内不存在“检查与写入之间被换绑插队”的真实交错；本用例验
  // 两种顺序的可观测结果——建后换绑、换绑回原账户，旧 Key 在任何一种顺序
  // 下都不可用（recordBinding 换绑即吊销旧账户在该设备上的 Key；admit ③
  // 再按账号与代次复核）。
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV1 });
  t('S4 建后换绑前：为 DEV1 建 Key → 200', r.code === 200 && !!r.obj.key);
  const s4id = r.code === 200 ? r.obj.record.key_id : null;
  core.recordBinding(DEV1, BOB, 'supp-s4-rebind');
  t('S4 创建后换绑：旧 Key 状态 revoked_by_rebind', !!s4id && core.keyStatus(core.findKeyById(s4id)) === 'revoked_by_rebind');
  t('S4 换绑后旧 Key 准入失败', !!s4id && core.admit({ key: core.findKeyById(s4id), deviceId: DEV1, command: 'ui.click' }).ok === false);
  n0 = keyCount();
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV1 });
  t('S4 换绑后旧账户再创建 → 403', r.code === 403 && r.obj.code === 'QFR_SCOPE_DENIED');
  core.recordBinding(DEV1, ALICE, 'supp-s4-rebind-back');
  t('S4 换绑回原账户后旧 Key 仍为 revoked_by_rebind（不复活）', !!s4id && core.keyStatus(core.findKeyById(s4id)) === 'revoked_by_rebind');
  t('S4 换绑回原账户后旧 Key 准入仍失败', !!s4id && core.admit({ key: core.findKeyById(s4id), deviceId: DEV1, command: 'ui.click' }).ok === false);
  r = await callRoute(mkRoutes(ALICE), 'POST', '/api/lea/v1/keys', {}, { password: 'x', device_id: DEV1 });
  t('S4 换绑回原账户后新 Key 可建且代次与当前绑定一致', r.code === 200 && !!r.obj.key && r.obj.record.binding_epoch === core.getBinding(DEV1).binding_epoch);

  console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '；失败 ' + fail + (failures.length ? '：' + failures.join('；') : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
