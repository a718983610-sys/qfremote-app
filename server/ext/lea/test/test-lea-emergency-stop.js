'use strict';
/*
 * LEA emergency_stop 服务端单测（GPT 2026-11-18 裁决问题 1、3、六节）· Node 无依赖
 * 运行：node test/test-lea-emergency-stop.js （在 server/ext/lea/ 目录下，或任意目录）
 * 覆盖：
 *   A. 恢复票据规范串（须与 C 端 lea_recovery_ticket_canonical 逐字一致）／
 *      同步回执规范串／签发验签往返／篡改拒绝；
 *   B. 同步：记录停控＋按 device_scope 逐个吊销（同账号他设备 Key 不动）＋
 *      回执签名验签；
 *   C. admit 门：停控时业务命令拒 403 EMERGENCY_STOPPED，只读内联命令与
 *      恢复命令放行，已吊销 Key 先报 BAD_KEY；
 *   D. 签发恢复票据：无活动停控／事件不匹配拒绝，代次由服务端铸造
 *      （已见最大＋1），有效期 1h；
 *   E. 已用票据记录：下发记 pending，恢复后记 recovered，代次递进；
 *      清停控记录后 admit 恢复通过、再签发拒绝；
 *   F. 路由层（真实 MFA 核心）：同步端点与恢复票据签发端点的鉴权／
 *      归属／密码二次确认／全员强制 MFA 门（未启用→MFA_REQUIRED、冷静
 *      期→MFA_COOLDOWN、错码→BAD_MFA）。
 * 设备端（QFRLEA.c 停控门／恢复提交顺序／专用 admission）不在此列，
 * 见 windows/lea/test/test_lea.c estop 组＋腾讯真机待验清单。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createLeaCore } = require('../lea-core');
const { createLeaRoutes } = require('../lea-routes');
const { createMfaCore, totpCode } = require('../mfa-core');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; failures.push(name); console.log('FAIL-', name, extra ? String(extra).slice(0, 300) : ''); }
}
function makeCore(dir) {
  const kp = crypto.generateKeyPairSync('ed25519');
  const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubDer = kp.publicKey.export({ format: 'der', type: 'spki' });
  const keyFile = path.join(dir, 'lea-test-key.b64');
  fs.writeFileSync(keyFile, Buffer.concat([privDer.subarray(-32), pubDer.subarray(-32)]).toString('base64'));
  return { core: createLeaCore({ dir, enableSweeps: false, signingKeyFile: keyFile, whitelist: ['node//test-device-1', 'node//test-device-2'] }), pubB64: pubDer.subarray(-32).toString('base64') };
}

const DEV = 'node//test-device-1';
const DEV2 = 'node//test-device-2';
const USER = 'alice';

// ---------- A. 恢复票据规范串：与 C 端逐字一致 ----------
// 与 windows/lea/test/test_lea.c estop-canon-exact 用同一组值。
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-estop-a-'));
  const { core, pubB64 } = makeCore(tmpDir);
  const TICKET = {
    type: 'emergency_stop_recovery',
    account_id: 'alice',
    device_id: 'node-1',
    stop_event_id: 'estop-3-1763412000',
    binding_epoch: 3,
    grant_epoch: 2,
    recovery_epoch: 5,
    scope: 'device-control',
    ticket_id: 'rtk-0123456789abcdef0123456789abcdef',
    issued_at: 1763412000,
    expires_at: 1763415600,
    auth_context: 'password+mfa@1763412000',
  };
  const EXPECTED_CANON = 'qfr-lea-recovery-ticket-v1\nemergency_stop_recovery\nalice\nnode-1\nestop-3-1763412000\n3\n2\n5\ndevice-control\nrtk-0123456789abcdef0123456789abcdef\n1763412000\n1763415600\npassword+mfa@1763412000';
  t('A1 recoveryTicketSigningBytes 与 C 端规范串逐字一致', core.recoveryTicketSigningBytes(TICKET) === EXPECTED_CANON);
  t('A2 sync 回执规范串格式', core.emergencyStopSyncSigningBytes({ stop_event_id: 'estop-3-1763412000', account_id: 'alice', device_id: 'node-1', synced_at: 1763412100 }) === 'qfr-lea-emergency-stop-sync-v1\nestop-3-1763412000\nalice\nnode-1\n1763412100');
  const signed = core.signRecoveryTicket(TICKET);
  t('A3 signRecoveryTicket 出 ticket_signature', typeof signed.ticket_signature === 'string' && signed.ticket_signature.length > 0);
  t('A4 verifyRecoveryTicket 往返通过', core.verifyRecoveryTicket(signed) === true);
  t('A5 verifyRecoveryTicket 改字段即失败', core.verifyRecoveryTicket(Object.assign({}, signed, { recovery_epoch: 6 })) === false);
  t('A6 verifyRecoveryTicket 类型错即失败', core.verifyRecoveryTicket(Object.assign({}, signed, { type: 'binding' })) === false);
  t('A7 verifyRecoveryTicket 无签名即失败', core.verifyRecoveryTicket(Object.assign({}, signed, { ticket_signature: undefined })) === false);
  // 同步回执规范串拒绝非法 synced_at（与 C 端 lea_emergency_stop_sync_canonical 同规则）。
  let threwSync = null;
  try { core.emergencyStopSyncSigningBytes({ stop_event_id: 'estop-3-1763412000', account_id: 'alice', device_id: 'node-1', synced_at: 0 }); } catch (e) { threwSync = e; }
  t('A8 sync 规范串拒绝 synced_at<=0', !!threwSync);
}

// ---------- B/C/D/E：同一 core 上的停控→同步→恢复全流程 ----------
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-estop-b-'));
  const { core, pubB64 } = makeCore(tmpDir);
  core.recordBinding(DEV, USER, 'test-login');
  core.grantMuse(USER, 'owner', { dangerous: true });
  const gen = core.generateKey(USER, { device_scope: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
  const key = core.findKeyById(gen.record.key_id);
  const binding = core.getBinding(DEV);
  const grant = core.getGrant(USER);
  t('B0 setup：绑定 ACTIVE 且 Key 含 dangerous scope', binding && binding.state === 'ACTIVE' && key.scopes.includes('muse.execute.dangerous'));
  t('B0 setup：停控前业务准入通过', core.admit({ key, deviceId: DEV, command: 'ui.click' }).ok === true);

  // D. 签发前置：无活动停控即拒绝。
  let threw = null;
  // auth_context 须为 password+<totp|passkey>@<5 分钟内验证>（GPT 2026-11-18
  // 裁决 §三；核心层强校验）。此处无活动停控，先报 NO_ACTIVE_STOP。
  const freshAuth = () => 'password+totp@' + Math.floor(Date.now() / 1000);
  try { core.issueRecoveryTicket({ accountId: USER, deviceId: DEV, stopEventId: 'estop-3-1763412000', grantEpoch: grant.grant_epoch, scope: '', authContext: freshAuth() }); } catch (e) { threw = e; }
  t('D1 无活动停控时签发拒绝 QFR_LEA_NO_ACTIVE_EMERGENCY_STOP', !!threw && threw.code === 'QFR_LEA_NO_ACTIVE_EMERGENCY_STOP');

  // B. 同步：同账号另一台设备的 Key 不得被误伤（revokeAllKeys 是全账号，不可用）。
  core.recordBinding(DEV2, USER, 'test-login-2');
  const gen2 = core.generateKey(USER, { device_scope: DEV2, scopes: ['muse.execute'] });
  const sync = core.emergencyStopSync({
    accountId: USER, deviceId: DEV,
    stopEventId: 'estop-3-1763412000', stopSeq: 3, scope: 'device-control',
    bindingEpoch: binding.binding_epoch, grantEpoch: grant.grant_epoch,
    stoppedAt: 1763412000,
  });
  t('B1 sync 返回回执＋吊销清单', !!sync.receipt && Array.isArray(sync.revoked_key_ids));
  t('B2 sync 只吊销本设备 Key', sync.revoked_key_ids.length === 1 && sync.revoked_key_ids[0] === gen.record.key_id);
  t('B3 sync 不动他设备 Key', core.keyStatus(core.findKeyById(gen2.record.key_id)) === 'active');
  t('B4 sync 后本设备 Key 已吊销', core.keyStatus(core.findKeyById(gen.record.key_id)) !== 'active');
  const stop = core.getEmergencyStop(USER, DEV);
  t('B5 sync 后停控记录在位', !!stop && stop.stopped === true && stop.stop_event_id === 'estop-3-1763412000' && stop.sync_status === 'synced');
  const receiptBytes = core.emergencyStopSyncSigningBytes(sync.receipt);
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubB64 }, format: 'jwk' });
  t('B6 回执签名验签通过', crypto.verify(null, Buffer.from(receiptBytes, 'utf8'), pub, Buffer.from(sync.receipt.signature, 'base64')) === true);
  t('B7 回执规范串逐字一致', receiptBytes === 'qfr-lea-emergency-stop-sync-v1\nestop-3-1763412000\nalice\ntest-device-1\n' + sync.receipt.synced_at);

  // C. admit 门：步骤 1（停控后签发新 Key，绑定仍 ACTIVE，停控不解绑）。
  const genNew = core.generateKey(USER, { device_scope: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
  const keyNew = core.findKeyById(genNew.record.key_id);
  t('C0 步骤1：停控后仍可发新 Key', !!keyNew && core.keyStatus(keyNew) === 'active');
  let adm = core.admit({ key: keyNew, deviceId: DEV, command: 'ui.click' });
  t('C1 admit：停控时业务命令拒 403 EMERGENCY_STOPPED', adm.ok === false && adm.status === 403 && adm.code === 'QFR_LEA_EMERGENCY_STOPPED');
  adm = core.admit({ key: keyNew, deviceId: DEV, command: 'sys.info' });
  t('C2 admit：停控时只读 sys.info 放行', adm.ok === true);
  adm = core.admit({ key: keyNew, deviceId: DEV, command: 'lea.status' });
  t('C2b admit：lea.status 不在服务端命令表（设备状态只走本地管道），报未知命令', adm.ok === false && adm.code === 'VALIDATION');
  adm = core.admit({ key: keyNew, deviceId: DEV, command: 'sys.ping' });
  t('C3 admit：停控时 sys.ping 放行', adm.ok === true);
  adm = core.admit({ key: keyNew, deviceId: DEV, command: 'emergency_stop.recover' });
  t('C4 admit：停控时恢复命令放行（授权凭专用票据）', adm.ok === true);
  adm = core.admit({ key: keyNew, deviceId: DEV, command: 'lea.pause' });
  t('C5 admit：停控时 lea.pause 亦拒', adm.ok === false && adm.code === 'QFR_LEA_EMERGENCY_STOPPED');
  adm = core.admit({ key: core.findKeyById(gen.record.key_id), deviceId: DEV, command: 'ui.click' });
  t('C6 admit：已吊销 Key 先报 BAD_KEY', adm.ok === false && adm.code === 'QFR_API_KEY_REVOKED');

  // D. 签发恢复票据：代次由服务端铸造（已见最大＋1），有效期 1h。
  const bindingNow = core.getBinding(DEV);
  const grantNow = core.getGrant(USER);
  const ticket = core.issueRecoveryTicket({
    accountId: USER, deviceId: DEV,
    stopEventId: 'estop-3-1763412000',
    grantEpoch: grantNow.grant_epoch, scope: '', authContext: freshAuth(),
  });
  t('D2 签发成功且 type 固定', ticket.type === 'emergency_stop_recovery');
  t('D3 recovery_epoch 首次铸造为 1', ticket.recovery_epoch === 1);
  t('D4 票据 binding_epoch 取服务端绑定', ticket.binding_epoch === bindingNow.binding_epoch);
  t('D5 票据 grant_epoch 取当前授权代次', ticket.grant_epoch === grantNow.grant_epoch);
  t('D6 票据有效期 1h', ticket.expires_at - ticket.issued_at === 3600);
  t('D7 签发的票据验签通过', core.verifyRecoveryTicket(ticket) === true);
  let threw2 = null;
  try { core.issueRecoveryTicket({ accountId: USER, deviceId: DEV, stopEventId: 'estop-9-999', grantEpoch: grantNow.grant_epoch, scope: '', authContext: 'x' }); } catch (e) { threw2 = e; }
  t('D8 事件不匹配拒绝签发', !!threw2 && threw2.code === 'QFR_VALIDATION');

  // E. 已用票据记录：下发记 pending，恢复后记 recovered，代次递进。
  core.recordRecoveryTicketUsed(ticket, 'consumed_pending_clear');
  const used = core.getRecoveryTicket(ticket.ticket_id);
  t('E1 已用记录为 pending', !!used && used.status === 'consumed_pending_clear' && used.recovery_epoch === 1);
  t('E2 recoveryMaxEpoch 含 pending 票据', core.recoveryMaxEpoch(USER, DEV) === 1);
  core.markRecoveryTicketRecovered(ticket.ticket_id);
  t('E3 mark 后为 recovered', core.getRecoveryTicket(ticket.ticket_id).status === 'recovered');
  const cleared = core.clearEmergencyStopRecord(USER, DEV, ticket.ticket_id, ticket.recovery_epoch);
  t('E4 清停控记录成功', !!cleared && cleared.stopped === false && cleared.last_recovery_epoch === 1);
  t('E5 清记录后 admit 业务恢复通过', core.admit({ key: keyNew, deviceId: DEV, command: 'ui.click' }).ok === true);
  let threw3 = null;
  try { core.issueRecoveryTicket({ accountId: USER, deviceId: DEV, stopEventId: 'estop-3-1763412000', grantEpoch: grantNow.grant_epoch, scope: '', authContext: 'x' }); } catch (e) { threw3 = e; }
  t('E6 清记录后签发拒绝（无活动停控）', !!threw3 && threw3.code === 'QFR_LEA_NO_ACTIVE_EMERGENCY_STOP');
  // 第二次停控＋恢复：代次须递进（上次 recovered 的 epoch 1 已见，新票须为 2）。
  core.emergencyStopSync({ accountId: USER, deviceId: DEV, stopEventId: 'estop-4-1763413000', stopSeq: 4, scope: 'device-control', bindingEpoch: bindingNow.binding_epoch, grantEpoch: grantNow.grant_epoch, stoppedAt: 1763413000 });
  const ticket2 = core.issueRecoveryTicket({ accountId: USER, deviceId: DEV, stopEventId: 'estop-4-1763413000', grantEpoch: grantNow.grant_epoch, scope: '', authContext: freshAuth() });
  t('E7 第二次签发代次递进为 2', ticket2.recovery_epoch === 2);
}

// ---------- F. 路由层（真实 MFA 核心） ----------
(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-estop-f-'));
  const { core } = makeCore(tmpDir);
  core.recordBinding(DEV, USER, 'test-login');
  core.grantMuse(USER, 'owner', { dangerous: true });
  const gen = core.generateKey(USER, { device_scope: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
  core.recordBinding(DEV2, 'bob', 'test-login-bob'); // 他人设备：归属校验用
  // F 组用真实 MFA 核心（冷静期取 0，注册后立即可用；冷静期分支另见 F12）。
  // 注册确认用上一步的码：确认本身消耗该计数器，F4 再用当步码才是新码，
  // 否则同一 30 秒步长内的码会被防重放拒绝（属预期行为，非缺陷）。
  const mfa = createMfaCore({ dir: tmpDir, log: () => {}, cooldownSec: 0 });
  const enr = mfa.beginEnrollment(USER, { ip: '127.0.0.1', userAgent: 'test' });
  mfa.confirmEnrollment(USER, enr.enrollment_id, totpCode(enr.secret, Math.floor(Date.now() / 1000 / 30) - 1), null);
  const mfaSecret = enr.secret;
  const sent = [];
  function mkRoutes(overrides) {
    return createLeaRoutes(core, {}, Object.assign({
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      verifyMfa: null,
      mfa,
      resolveConsoleAuth: async () => ({ user: USER, siteadmin: 0 }),
      isSiteAdmin: (a) => a.user === '718983610',
    }, overrides || {}));
  }
  const routes = mkRoutes();
  function mkReq(method, url, body) {
    return { method, url, headers: {}, _body: body || {}, socket: { remoteAddress: '127.0.0.1' } };
  }
  async function callRoute(rts, method, url, body) {
    sent.length = 0;
    const matched = await rts.handle(mkReq(method, url, body), {});
    return { matched, code: sent.length ? sent[sent.length - 1].code : null, obj: sent.length ? sent[sent.length - 1].obj : null };
  }
  let r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/sync',
    { device_id: DEV, stop_event_id: 'estop-3-1763412000', stop_seq: 3 });
  t('F1 路由 sync 200 且带签名回执', r.matched === true && r.code === 200 && !!r.obj.receipt && typeof r.obj.receipt.signature === 'string');
  t('F2 路由 sync 吊销本设备 Key', r.obj.revoked_key_ids.length === 1 && r.obj.revoked_key_ids[0] === gen.record.key_id);
  t('F3 路由 sync 后停控记录在位', !!core.getEmergencyStop(USER, DEV) && core.getEmergencyStop(USER, DEV).stopped === true);
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: totpCode(mfaSecret, Math.floor(Date.now() / 1000 / 30)), device_id: DEV, stop_event_id: 'estop-3-1763412000' });
  t('F4 路由 recovery-ticket 200 且票据 type 固定', r.matched === true && r.code === 200 && !!r.obj.ticket && r.obj.ticket.type === 'emergency_stop_recovery');
  t('F4b 路由 recovery-ticket auth_context 记 totp', r.obj.ticket && /^password\+totp@\d+$/.test(r.obj.ticket.auth_context));
  t('F5 路由 recovery-ticket 代次为 1', r.obj.ticket && r.obj.ticket.recovery_epoch === 1);
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'wrong-password', mfa_code: '123456', device_id: DEV, stop_event_id: 'estop-3-1763412000' });
  t('F6 路由 recovery-ticket 密码错 → 401 BAD_PASSWORD', r.code === 401 && r.obj.code === 'BAD_PASSWORD');
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: '123456', device_id: DEV2, stop_event_id: 'estop-3-1763412000' });
  t('F7 路由 recovery-ticket 他人设备 → 403', r.code === 403 && r.obj.code === 'QFR_LEA_NOT_BOUND');
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/sync',
    { device_id: DEV2, stop_event_id: 'estop-3-1763412000', stop_seq: 3 });
  t('F8 路由 sync 他人设备 → 403', r.code === 403 && r.obj.code === 'QFR_LEA_NOT_BOUND');
  // MFA 未通过分支：错码时签发拒绝（全员强制 MFA 门）。
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: '000000', device_id: DEV, stop_event_id: 'estop-3-1763412000' });
  t('F9 路由 recovery-ticket MFA 未通过 → 401 BAD_MFA', r.code === 401 && r.obj.code === 'BAD_MFA');
  // 未启用 MFA：换一个空 MFA 台账（同一 core、同一停控记录），签发拒绝并给注册路径。
  const mfaEmpty = createMfaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-estop-f11-')), log: () => {} });
  const routesNoMfa = mkRoutes({ mfa: mfaEmpty });
  r = await callRoute(routesNoMfa, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: '123456', device_id: DEV, stop_event_id: 'estop-3-1763412000' });
  t('F11 路由 recovery-ticket 未启用 MFA → 403 MFA_REQUIRED＋注册路径', r.code === 403 && r.obj.code === 'MFA_REQUIRED' && !!r.obj.recovery_path && r.obj.recovery_path.action === 'enroll');
  // 冷静期：新注册因素（冷静期 24h）在期满前不得签发。
  const mfaCool = createMfaCore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-estop-f12-')), log: () => {}, cooldownSec: 24 * 3600 });
  const enrCool = mfaCool.beginEnrollment(USER, null);
  mfaCool.confirmEnrollment(USER, enrCool.enrollment_id, totpCode(enrCool.secret, Math.floor(Date.now() / 1000 / 30)), null);
  const routesCool = mkRoutes({ mfa: mfaCool });
  r = await callRoute(routesCool, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: totpCode(enrCool.secret, Math.floor(Date.now() / 1000 / 30)), device_id: DEV, stop_event_id: 'estop-3-1763412000' });
  t('F12 路由 recovery-ticket 冷静期内 → 403 MFA_COOLDOWN', r.code === 403 && r.obj.code === 'MFA_COOLDOWN');
  // 未登录分支。
  const routesNoAuth = mkRoutes({ resolveConsoleAuth: async () => null });
  r = await callRoute(routesNoAuth, 'POST', '/api/lea/v1/emergency-stop/sync',
    { device_id: DEV, stop_event_id: 'estop-3-1763412000', stop_seq: 3 });
  t('F10 路由 sync 未登录 → 401', r.code === 401);

  console.log('\n==== LEA emergency_stop tests: ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) console.log('failed:', failures.join(', '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
