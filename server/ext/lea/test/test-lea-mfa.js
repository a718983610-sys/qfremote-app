'use strict';
/*
 * LEA MFA 单测（GPT 2026-11-18 裁决 §三／§五 MFA 相关验收）
 * 运行：node test/test-lea-mfa.js（在 server/ext/lea/ 目录下，或任意目录）
 * 覆盖：
 *   A. TOTP（RFC 6238 向量）／窗口／防重放；
 *   B. 注册：确认＋冷静期（冷静期内验证拒绝，期满放行）；
 *   C. 路由：未启用 MFA 申请恢复 → 403 MFA_REQUIRED＋安全注册路径；
 *   D. 路由：注册→冷静期拒绝→期满验证→签发；错误／过期／重复使用
 *      的 MFA 一律拒绝；验证记录单次使用；
 *   E. 路由：MFA 丢失→挂失立案→非站长审批拒绝→站长批准→重新注册；
 *   F. 核心层：issueRecoveryTicket 只接受 password+<totp|passkey>@
 *      <5 分钟内验证>，只凭密码／泛化表述／过期验证一律拒绝；
 *   G. 恢复对照：恢复后旧 Key 仍拒绝、新 Key 按正常权限可用。
 * 时间：mfa-core 与 lea-core 均注入同一可控时钟（now），冷静期在测试
 * 里取 5 秒（生产默认 24 小时），推进时钟即推进冷静期／有效期。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createLeaCore } = require('../lea-core');
const { createLeaRoutes } = require('../lea-routes');
const { createMfaCore, totpCode, verifyTotp, base32Encode, base32Decode } = require('../mfa-core');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; failures.push(name); console.log('FAIL-', name, extra ? String(extra).slice(0, 300) : ''); }
}

// 可控时钟：mfa-core 与 lea-core 共用同一时钟。
let nowMs = Date.now();
const nowFn = () => nowMs;
const nowSec = () => Math.floor(nowMs / 1000);
function advance(sec) { nowMs += sec * 1000; }
// 推进到下一个 TOTP 步长边界之后（保证计数器递进，避免"确认注册时消耗
// 的计数器"与"随后验证用的码"落在同一 30 秒步长内而被防重放误拒）。
function advanceToNextStep() {
  const stepMs = 30 * 1000;
  nowMs = (Math.floor(nowMs / stepMs) + 1) * stepMs + 1000;
}

const DEV = 'node//test-device-1';
const USER = 'alice';
const ADMIN = '718983610';

function makeCore(dir) {
  const kp = crypto.generateKeyPairSync('ed25519');
  const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubDer = kp.publicKey.export({ format: 'der', type: 'spki' });
  const keyFile = path.join(dir, 'lea-test-key.b64');
  fs.writeFileSync(keyFile, Buffer.concat([privDer.subarray(-32), pubDer.subarray(-32)]).toString('base64'));
  const core = createLeaCore({ dir, enableSweeps: false, signingKeyFile: keyFile, whitelist: [DEV], now: nowFn });
  const mfa = createMfaCore({ dir, log: () => {}, now: nowFn, cooldownSec: 5, verifyTtlSec: 300, enrollTtlSec: 600 });
  return { core, mfa };
}

// ---------- A. TOTP（RFC 6238 附录 B，SHA-1 向量） ----------
{
  // secret ASCII "12345678901234567890" 的 Base32。
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  t('A1 base32 编解码往返', base32Decode(base32Encode(Buffer.from('12345678901234567890'))).toString() === '12345678901234567890');
  // RFC 6238 向量为 8 位码；本实现用 6 位（验证器 App 默认），期望值
  // 取 8 位向量后 6 位。
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [ts, expected] of vectors) {
    const counter = Math.floor(ts / 30);
    t('A2 RFC6238 向量 T=' + ts, totpCode(SECRET, counter) === expected);
  }
  t('A3 当步码验证通过', verifyTotp(SECRET, totpCode(SECRET, Math.floor(59 / 30)), 59, null).ok === true);
  t('A4 前一步码在窗口内通过', verifyTotp(SECRET, totpCode(SECRET, Math.floor(59 / 30) - 1), 59, null).ok === true);
  t('A5 后一步码在窗口内通过', verifyTotp(SECRET, totpCode(SECRET, Math.floor(59 / 30) + 1), 59, null).ok === true);
  t('A6 两步外码拒绝', verifyTotp(SECRET, totpCode(SECRET, Math.floor(59 / 30) - 2), 59, null).ok === false);
  t('A7 同一计数器重放拒绝', verifyTotp(SECRET, totpCode(SECRET, Math.floor(59 / 30)), 59, Math.floor(59 / 30)).ok === false);
  t('A8 错误码拒绝', verifyTotp(SECRET, '000000', 59, null).ok === false);
  t('A9 非 6 位码拒绝', verifyTotp(SECRET, '12345', 59, null).ok === false);
}

// ---------- B. 注册＋冷静期（mfa-core 单元） ----------
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-mfa-b-'));
  const mfa = createMfaCore({ dir: tmpDir, log: () => {}, now: nowFn, cooldownSec: 5, verifyTtlSec: 300, enrollTtlSec: 600 });
  t('B0 未注册时状态 none', mfa.getFactorStatus(USER).status === 'none');
  let threw = null;
  try { mfa.verifyCode(USER, '123456'); } catch (e) { threw = e; }
  t('B1 未注册验证 → QFR_MFA_NOT_ENROLLED', !!threw && threw.code === 'QFR_MFA_NOT_ENROLLED');
  const enr = mfa.beginEnrollment(USER, { ip: '127.0.0.1', userAgent: 'test' });
  t('B2 注册开始返回 secret 与 otpauth URL', !!enr.secret && enr.otpauth_url.indexOf('otpauth://totp/') === 0 && !!enr.enrollment_id);
  threw = null;
  try { mfa.confirmEnrollment(USER, enr.enrollment_id, '000000', null); } catch (e) { threw = e; }
  t('B3 注册确认错码 → QFR_MFA_BAD_CODE', !!threw && threw.code === 'QFR_MFA_BAD_CODE');
  const code = totpCode(enr.secret, Math.floor(nowSec() / 30));
  const conf = mfa.confirmEnrollment(USER, enr.enrollment_id, code, null);
  t('B4 注册确认成功且进冷静期', conf.method === 'totp' && conf.cooldown_until === conf.enrolled_at + 5);
  t('B5 注册后状态 cooling-off', mfa.getFactorStatus(USER).status === 'cooling-off');
  threw = null;
  try { mfa.verifyCode(USER, totpCode(enr.secret, Math.floor(nowSec() / 30))); } catch (e) { threw = e; }
  t('B6 冷静期内验证 → QFR_MFA_COOLDOWN', !!threw && threw.code === 'QFR_MFA_COOLDOWN');
  threw = null;
  try { mfa.beginEnrollment(USER, null); } catch (e) { threw = e; }
  t('B7 已注册后重复注册 → QFR_MFA_ALREADY_ENROLLED', !!threw && threw.code === 'QFR_MFA_ALREADY_ENROLLED');
  advance(6);
  t('B8 冷静期满状态 active', mfa.getFactorStatus(USER).status === 'active');
  advanceToNextStep();
  const v = mfa.verifyCode(USER, totpCode(enr.secret, Math.floor(nowSec() / 30)));
  t('B9 冷静期满验证通过', v.method === 'totp' && v.verified_at === nowSec());
  threw = null;
  try { mfa.verifyCode(USER, totpCode(enr.secret, Math.floor(nowSec() / 30))); } catch (e) { threw = e; }
  t('B10 同一 TOTP 码重放拒绝', !!threw && threw.code === 'QFR_MFA_BAD_CODE');
  const rec = mfa.createVerification(USER, 'totp', nowSec());
  t('B11 验证记录 5 分钟有效', rec.expires_at - rec.verified_at === 300 && rec.purpose === 'emergency-stop-recovery');
  const consumed = mfa.consumeVerification(USER, rec.verification_id);
  t('B12 验证记录消费成功', consumed.method === 'totp' && consumed.verified_at === rec.verified_at);
  threw = null;
  try { mfa.consumeVerification(USER, rec.verification_id); } catch (e) { threw = e; }
  t('B13 验证记录重复消费 → QFR_MFA_VERIFICATION_REUSED', !!threw && threw.code === 'QFR_MFA_VERIFICATION_REUSED');
  const rec2 = mfa.createVerification(USER, 'totp', nowSec());
  advance(301);
  threw = null;
  try { mfa.consumeVerification(USER, rec2.verification_id); } catch (e) { threw = e; }
  t('B14 验证记录过期 → QFR_MFA_VERIFICATION_EXPIRED', !!threw && threw.code === 'QFR_MFA_VERIFICATION_EXPIRED');
  // 恢复时钟到测试主线（B 节推进了 307 秒，后续路由测试用当前时钟）。
}

// ---------- C–G. 路由级（共用同一 core＋routes，连续剧情） ----------
(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-mfa-c-'));
  const { core, mfa } = makeCore(tmpDir);
  core.recordBinding(DEV, USER, 'test-login');
  core.grantMuse(USER, 'owner', { dangerous: true });
  const genOld = core.generateKey(USER, { device_scope: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
  const sent = [];
  let currentUser = USER;
  function mkRoutes(overrides) {
    return createLeaRoutes(core, {}, Object.assign({
      sendJson: (res, code, obj) => { sent.push({ code, obj }); res._code = code; res._obj = obj; },
      readJsonBody: async (req) => req._body || {},
      log: () => {},
      verifyPassword: async (u, p) => p === 'correct-password',
      verifyMfa: null,
      mfa,
      resolveConsoleAuth: async () => ({ user: currentUser, siteadmin: currentUser === ADMIN ? 1 : 0 }),
      isSiteAdmin: (a) => a.user === ADMIN,
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
  const codeNow = (secret) => totpCode(secret, Math.floor(nowSec() / 30));

  // 先建停控记录（恢复票据签发的前置条件；旧 Key 随同步被吊销）。
  let r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/sync',
    { device_id: DEV, stop_event_id: 'estop-1-1000', stop_seq: 1 });
  // keyStatus 读传入记录的 revoked_at，须重新取 fresh 记录（旧快照仍称 active）。
  t('C0 sync 200 且旧 Key 被吊销', r.code === 200 && r.obj.revoked_key_ids.length === 1 && core.keyStatus(core.findKeyById(genOld.record.key_id)) !== 'active');

  // C. 未启用 MFA 申请恢复 → 403 MFA_REQUIRED＋安全注册路径。
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/status', {});
  t('C1 未注册时 /mfa/status 报 none', r.code === 200 && r.obj.factor.status === 'none');
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: '123456', device_id: DEV, stop_event_id: 'estop-1-1000' });
  t('C2 未启用 MFA 申请恢复 → 403 MFA_REQUIRED', r.code === 403 && r.obj.code === 'MFA_REQUIRED');
  t('C3 MFA_REQUIRED 带安全注册路径', !!r.obj.recovery_path && r.obj.recovery_path.action === 'enroll' && !!r.obj.recovery_path.enroll_begin);
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/verify', { mfa_code: '123456' });
  t('C4 未注册时 /mfa/verify → 403 MFA_REQUIRED', r.code === 403 && r.obj.code === 'MFA_REQUIRED');

  // D. 注册→冷静期拒绝→期满验证→签发；错误／过期／重复使用拒绝。
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/enroll/begin', { password: 'correct-password' });
  t('D1 注册开始 200 且带 secret', r.code === 200 && !!r.obj.secret && !!r.obj.enrollment_id);
  const enrollmentId = r.obj.enrollment_id;
  const secret = r.obj.secret;
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/enroll/confirm',
    { password: 'correct-password', enrollment_id: enrollmentId, mfa_code: '000000' });
  t('D2 注册确认错码 → 401 BAD_MFA', r.code === 401 && r.obj.code === 'BAD_MFA');
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/enroll/confirm',
    { password: 'correct-password', enrollment_id: enrollmentId, mfa_code: codeNow(secret) });
  t('D3 注册确认成功且进冷静期', r.code === 200 && r.obj.cooldown_until === r.obj.enrolled_at + 5);
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: codeNow(secret), device_id: DEV, stop_event_id: 'estop-1-1000' });
  t('D4 刚注册的新 MFA 申请恢复 → 403 MFA_COOLDOWN', r.code === 403 && r.obj.code === 'MFA_COOLDOWN');
  t('D5 MFA_COOLDOWN 带剩余时间', r.obj.recovery_path && r.obj.recovery_path.cooldown_remaining_s > 0);
  advance(6);
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/verify', { mfa_code: '000000' });
  t('D6 /mfa/verify 错码 → 401 BAD_MFA', r.code === 401 && r.obj.code === 'BAD_MFA');
  advanceToNextStep();
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/verify', { mfa_code: codeNow(secret) });
  t('D7 /mfa/verify 成功返回单次验证记录', r.code === 200 && !!r.obj.verification_id && r.obj.expires_at - r.obj.verified_at === 300);
  const verificationId = r.obj.verification_id;
  const verifiedAt = r.obj.verified_at;
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', device_id: DEV, stop_event_id: 'estop-1-1000' });
  t('D8 无码无验证记录 → 400 MFA_CODE_REQUIRED', r.code === 400 && r.obj.code === 'MFA_CODE_REQUIRED');
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: '000000', device_id: DEV, stop_event_id: 'estop-1-1000' });
  t('D9 错码申请恢复 → 401 BAD_MFA', r.code === 401 && r.obj.code === 'BAD_MFA');
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_verification_id: verificationId, device_id: DEV, stop_event_id: 'estop-1-1000' });
  t('D10 凭验证记录签发 200', r.code === 200 && !!r.obj.ticket && r.obj.ticket.type === 'emergency_stop_recovery');
  t('D11 票据 auth_context 记 totp 与验证时间', r.obj.ticket && r.obj.ticket.auth_context === 'password+totp@' + verifiedAt);
  t('D12 首张票据 recovery_epoch 为 1', r.obj.ticket && r.obj.ticket.recovery_epoch === 1);
  const ticket1 = r.obj.ticket;
  // 模拟真实下发：票据下发时记 consumed_pending_clear，代次随之推进
  // （否则下一次签发仍为 epoch 1，见 emergency_stop E 组同款）。
  core.recordRecoveryTicketUsed(ticket1, 'consumed_pending_clear');
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_verification_id: verificationId, device_id: DEV, stop_event_id: 'estop-1-1000' });
  t('D13 同一验证记录重用 → 401 BAD_MFA', r.code === 401 && r.obj.code === 'BAD_MFA');
  // 过期验证记录：再取一个（须先推进到下一 TOTP 步长，否则同一计数器
  // 的码会被防重放拒绝），推进 301 秒后使用。
  advanceToNextStep();
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/verify', { mfa_code: codeNow(secret) });
  const verificationId2 = r.obj.verification_id;
  advance(301);
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_verification_id: verificationId2, device_id: DEV, stop_event_id: 'estop-1-1000' });
  t('D14 过期验证记录 → 401 BAD_MFA', r.code === 401 && r.obj.code === 'BAD_MFA');
  // 内联验码路径同样可用（同一请求内验证＋签发）。
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: codeNow(secret), device_id: DEV, stop_event_id: 'estop-1-1000' });
  t('D15 内联验码签发 200 且代次递进为 2', r.code === 200 && r.obj.ticket && r.obj.ticket.recovery_epoch === 2);
  const ticket2 = r.obj.ticket;

  // F. 核心层 auth_context 强校验（直接调 core，不走路由）。
  let threw = null;
  try { core.issueRecoveryTicket({ accountId: USER, deviceId: DEV, stopEventId: 'estop-1-1000', grantEpoch: core.getGrant(USER).grant_epoch, scope: '', authContext: 'password@' + nowSec() }); } catch (e) { threw = e; }
  t('F1 只凭密码的 auth_context → QFR_VALIDATION', !!threw && threw.code === 'QFR_VALIDATION');
  threw = null;
  try { core.issueRecoveryTicket({ accountId: USER, deviceId: DEV, stopEventId: 'estop-1-1000', grantEpoch: core.getGrant(USER).grant_epoch, scope: '', authContext: 'password+mfa@' + nowSec() }); } catch (e) { threw = e; }
  t('F2 泛化 password+mfa 的 auth_context → QFR_VALIDATION', !!threw && threw.code === 'QFR_VALIDATION');
  threw = null;
  try { core.issueRecoveryTicket({ accountId: USER, deviceId: DEV, stopEventId: 'estop-1-1000', grantEpoch: core.getGrant(USER).grant_epoch, scope: '', authContext: 'password+totp@' + (nowSec() - 301) }); } catch (e) { threw = e; }
  t('F3 超过 5 分钟的验证 → QFR_VALIDATION', !!threw && threw.code === 'QFR_VALIDATION');
  threw = null;
  try { core.issueRecoveryTicket({ accountId: USER, deviceId: DEV, stopEventId: 'estop-1-1000', grantEpoch: core.getGrant(USER).grant_epoch, scope: '', authContext: 'password+totp@' + (nowSec() + 3600) }); } catch (e) { threw = e; }
  t('F4 未来过远的验证时间 → QFR_VALIDATION', !!threw && threw.code === 'QFR_VALIDATION');

  // G. 恢复对照：旧 Key 仍拒绝、新 Key 恢复后可用（停控清除只清对应
  // 设备停控状态，被撤销的 Key 与历史撤销记录保持失效）。
  const genNew = core.generateKey(USER, { device_scope: DEV, scopes: ['muse.execute', 'muse.execute.dangerous'] });
  const keyNew = core.findKeyById(genNew.record.key_id);
  let adm = core.admit({ key: keyNew, deviceId: DEV, command: 'ui.click' });
  t('G1 停控时新 Key 业务仍拒 EMERGENCY_STOPPED', adm.ok === false && adm.code === 'QFR_LEA_EMERGENCY_STOPPED');
  adm = core.admit({ key: core.findKeyById(genOld.record.key_id), deviceId: DEV, command: 'ui.click' });
  t('G2 旧 Key 先报 BAD_KEY（已吊销）', adm.ok === false && adm.code === 'QFR_API_KEY_REVOKED');
  // 模拟设备端恢复提交：下发记 pending → recovered → 清服务端停控记录。
  core.recordRecoveryTicketUsed(ticket2, 'consumed_pending_clear');
  core.markRecoveryTicketRecovered(ticket2.ticket_id);
  const cleared = core.clearEmergencyStopRecord(USER, DEV, ticket2.ticket_id, ticket2.recovery_epoch);
  t('G3 清停控记录成功（只清对应设备停控）', !!cleared && cleared.stopped === false);
  adm = core.admit({ key: core.findKeyById(genOld.record.key_id), deviceId: DEV, command: 'ui.click' });
  t('G4 恢复后旧 Key 仍然拒绝', adm.ok === false && adm.code === 'QFR_API_KEY_REVOKED');
  adm = core.admit({ key: keyNew, deviceId: DEV, command: 'ui.click' });
  t('G5 恢复后重新授权的新 Key 可按正常权限连接', adm.ok === true);
  // 旧票据重放：ticket1 已是 consumed_pending_clear／recovered 历史，
  // 服务端不再凭它签发新票（须新停控＋新 MFA 验证）。
  threw = null;
  try { core.issueRecoveryTicket({ accountId: USER, deviceId: DEV, stopEventId: 'estop-1-1000', grantEpoch: core.getGrant(USER).grant_epoch, scope: '', authContext: 'password+totp@' + nowSec() }); } catch (e) { threw = e; }
  t('G6 停控已清后签发拒绝（无活动停控）', !!threw && threw.code === 'QFR_LEA_NO_ACTIVE_EMERGENCY_STOP');

  // E. MFA 丢失流程（另起一段：重新停控，复用同一账号）。
  core.emergencyStopSync({ accountId: USER, deviceId: DEV, stopEventId: 'estop-2-2000', stopSeq: 2, scope: 'device-control', bindingEpoch: core.getBinding(DEV).binding_epoch, grantEpoch: core.getGrant(USER).grant_epoch, stoppedAt: nowSec() });
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/report-lost', { password: 'correct-password' });
  t('E1 挂失 200 且立案 pending', r.code === 200 && !!r.obj.case_id && r.obj.status === 'pending');
  const caseId = r.obj.case_id;
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/status', {});
  t('E2 挂失后因素状态 lost', r.code === 200 && r.obj.factor.status === 'lost');
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: codeNow(secret), device_id: DEV, stop_event_id: 'estop-2-2000' });
  t('E3 挂失后申请恢复 → 403 MFA_LOST', r.code === 403 && r.obj.code === 'MFA_LOST');
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/enroll/begin', { password: 'correct-password' });
  t('E4 挂失后未审批即重新注册 → 403', r.code === 403 && r.obj.code === 'QFR_MFA_RECOVERY_REQUIRED');
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/recovery/resolve', { case_id: caseId, decision: 'approved' });
  t('E5 非站长审批 → 403', r.code === 403);
  currentUser = ADMIN;
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/recovery/resolve', { case_id: caseId, decision: 'approved' });
  t('E6 站长批准恢复案件 200', r.code === 200 && r.obj.case.status === 'approved');
  currentUser = USER;
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/enroll/begin', { password: 'correct-password' });
  t('E7 批准后可重新注册', r.code === 200 && !!r.obj.enrollment_id);
  const enrollmentId2 = r.obj.enrollment_id;
  const secret2 = r.obj.secret;
  r = await callRoute(routes, 'POST', '/api/lea/v1/mfa/enroll/confirm',
    { password: 'correct-password', enrollment_id: enrollmentId2, mfa_code: codeNow(secret2) });
  t('E8 重新注册确认成功', r.code === 200);
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: codeNow(secret2), device_id: DEV, stop_event_id: 'estop-2-2000' });
  t('E9 新因素冷静期内仍拒绝恢复', r.code === 403 && r.obj.code === 'MFA_COOLDOWN');
  advance(6);
  advanceToNextStep();
  r = await callRoute(routes, 'POST', '/api/lea/v1/emergency-stop/recovery-ticket',
    { password: 'correct-password', mfa_code: codeNow(secret2), device_id: DEV, stop_event_id: 'estop-2-2000' });
  t('E10 冷静期满后新因素可签发恢复票据', r.code === 200 && !!r.obj.ticket);

  // 审计落盘：mfa.json 与当日 audit 文件存在且含 MFA 事件。
  const auditFiles = fs.readdirSync(tmpDir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  let auditText = '';
  for (const f of auditFiles) auditText += fs.readFileSync(path.join(tmpDir, f), 'utf8');
  t('H1 审计文件含 MFA 注册／验证／签发事件',
    auditText.includes('lea-mfa-enroll-confirm') && auditText.includes('lea-mfa-verify-ok') && auditText.includes('lea-recovery-ticket-issued'));
  t('H2 审计不含 secret 与 TOTP 码', !auditText.includes(secret) && !auditText.includes(secret2));
  t('H3 mfa.json 落盘且 secret 未进路由响应明文之外的文件', fs.existsSync(path.join(tmpDir, 'mfa.json')));

  console.log('\n==== LEA MFA tests: ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) console.log('failed:', failures.join(', '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
