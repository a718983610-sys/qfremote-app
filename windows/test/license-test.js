'use strict';
/*
 * QFRemote 2.3.1 阶段 E 许可流程自检（与安卓阶段 D license_test.dart 同口径）：
 *  A. 许可判定解析（/license/api/me 与 device-report）
 *  B. 门裁决 resolveGateAction（影子 / forceLogout / 待审）
 *  C. 拦截文案按 code 取 L 系列（不得另编）
 *  D. 领取分支（§7.5.5 / L17）
 *  E. TrialBar 与剩余时长（满 24 小时制折算，与网页正本同口径）
 *  F. 设备码（生成一次、恒定不变、加密落盘与明文标识退回路径）
 *  G. 扩展服务同源地址（svc-urls ext 收口）
 *  H. 登录页许可入口（16:37 定版注入脚本＋导航拦截判定）
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const lic = require('../license');
const { createDeviceCodeStore } = require('../device-code');
const { createSvcUrls } = require('../svc-urls');
const autologin = require('../autologin');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr231/license-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

// ---------- A. 解析 ----------
{
  const me = lic.parseMe({
    ok: true, username: 'qflic2510a', planName: 'QFRemote 永久套餐',
    maskedKey: 'QFR8K-•••••-•••••-•••••-V5YQZ', displayStatus: '正常',
    slots: { pc: 1, mobile: 0 }, trialExpiresMs: null, keyExpiresMs: null,
    webEnabled: true, everBanned: false, hasKey: true,
    decision: { allow: true, code: 'OK', shadow: true, enforce: true }
  });
  ok('A1_me_full', me && me.planName === 'QFRemote 永久套餐' && me.slotsPc === 1 && me.slotsMobile === 0 &&
    me.webEnabled === true && me.decision.code === 'OK' && me.forceLogout === false);
  const me2 = lic.parseMe({ ok: true, planName: 'QFRemote 试用套餐', forceLogout: true, gateCode: 'G1', decision: { allow: false, code: 'G1' } });
  ok('A2_me_forceLogout', me2 && me2.forceLogout === true && me2.gateCode === 'G1');
  ok('A3_me_bad_null', lic.parseMe({ ok: false }) === null && lic.parseMe('not json') === null && lic.parseMe([]) === null);
  const rep = lic.parseDeviceReport({ ok: true, device: { reviewPending: true, forceLogout: true }, decision: { allow: false, code: 'DEVICE_REVIEW', shadow: true } });
  ok('A4_report_parse', rep && rep.reviewPending === true && rep.deviceForceLogout === true && rep.decision.code === 'DEVICE_REVIEW');
}

// ---------- B. 门裁决 ----------
{
  ok('B1_shadow_no_block', lic.resolveGateAction({ decision: { allow: false, code: 'G1', shadow: true, enforce: false } }).kind === 'none');
  const a2 = lic.resolveGateAction({ decision: { allow: false, code: 'G2', shadow: true, enforce: true } });
  ok('B2_enforce_show_gate', a2.kind === 'showGate' && a2.decision.code === 'G2');
  const a3 = lic.resolveGateAction({ decision: { allow: true, code: 'OK' }, forceLogoutSignal: true, forceLogoutGateCode: 'G1' });
  const a3b = lic.resolveGateAction({ decision: { allow: false, code: 'G5' }, forceLogoutSignal: true });
  ok('B3_forceLogout_gateCode_only', a3.kind === 'forceLogoutToGate' && a3.decision.code === 'G1' && a3b.decision.code === 'G1');
  const a4 = lic.resolveGateAction({ decision: { allow: false, code: 'DEVICE_REVIEW', shadow: true }, fromDeviceReport: true, reviewPending: true });
  ok('B4_device_review_bypass_shadow', a4.kind === 'deviceReview');
  ok('B5_allow_and_null_none', lic.resolveGateAction({ decision: { allow: true, code: 'OK' } }).kind === 'none' &&
    lic.resolveGateAction({ decision: null }).kind === 'none');
}

// ---------- C. L 文案 ----------
{
  const g1 = lic.gateCopyFor({ allow: false, code: 'G1' });
  ok('C1_G1', g1 && g1.title === '尚未激活' && g1.body.includes('尚未购买密钥激活') && g1.hasClaimBox && g1.hasTransferGuide && g1.primary === 'purchase');
  const ms = new Date(2026, 9, 28).getTime();
  const g2 = lic.gateCopyFor({ allow: false, code: 'G2', trialExpiresMs: ms });
  ok('C2_G2_date', g2 && g2.title === '试用已到期' && g2.body.includes('3 天免费试用已于 2026 年 10 月 28 日 到期') && g2.hasClaimBox);
  const g5 = lic.gateCopyFor({ allow: false, code: 'G5' });
  ok('C3_G5_no_trial_word', g5 && g5.title === '密钥已过期' && g5.body.includes('密钥已到期') && !g5.body.includes('试用') && g5.hasClaimBox);
  ok('C4_G3_G4_no_claim', lic.gateCopyFor({ allow: false, code: 'G3' }).hasClaimBox === false &&
    lic.gateCopyFor({ allow: false, code: 'G4' }).hasClaimBox === false);
  ok('C4b_G3_rebind_entry', lic.gateCopyFor({ allow: false, code: 'G3' }).hasRebind === true &&
    !lic.gateCopyFor({ allow: false, code: 'G1' }).hasRebind &&
    !lic.gateCopyFor({ allow: false, code: 'G4' }).hasRebind);
  const bp = lic.gateCopyFor({ allow: false, code: 'BAN_PERM', banCode: 'B6' });
  ok('C5_BAN_PERM_B6', bp && bp.primary === 'appeal' && bp.body.includes('同一设备登录多个账号，经审核确认违规') && !bp.hasClaimBox);
  const ms2 = new Date(2026, 10, 1).getTime();
  const bu = lic.gateCopyFor({ allow: false, code: 'BAN_UNTIL', banCode: 'B10', endsAtMs: ms2 });
  ok('C6_BAN_UNTIL_B10', bu && bu.title === '账号已被冻结' && bu.body.includes('密钥绑定异常操作') && bu.body.includes('2026 年 11 月 1 日'));
  const dr = lic.gateCopyFor({ allow: false, code: 'DEVICE_REVIEW' });
  ok('C7_DEVICE_REVIEW', dr && dr.title === '设备异常登录' && dr.primary === 'none' && dr.body.includes('正在核实中') && !dr.body.includes('封禁'));
  ok('C8_unknown_null', lic.gateCopyFor({ allow: false, code: 'X9' }) === null && !!lic.FALLBACK_GATE_COPY);
}

// ---------- D. 领取分支 ----------
{
  ok('D1_format_local', lic.claimDisplayText('abc', null) === '密钥格式不正确，请检查后重新输入。' &&
    lic.isKeyFormatValid('QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ') === true &&
    lic.isKeyFormatValid('qfr8k-m2x9p-7w4td-h6n3c-v5yqz') === true &&
    lic.isKeyFormatValid('QFR8K-M2X9P-7W4TD-H6N3C') === false);
  ok('D2_key_expired_exact', lic.claimDisplayText('QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', { ok: false, code: 'KEY_EXPIRED', msg: '别字' }) === '密钥已过期。');
  // F-2 裁决批①：过期提示带到期日期（服务端回 expiredAt 时）
  const expMs = new Date(2026, 9, 25).getTime();
  ok('D2b_key_expired_dated', lic.claimDisplayText('QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', { ok: false, code: 'KEY_EXPIRED', msg: '别字', expiredAtMs: expMs }) === '密钥已过期，已于 2026 年 10 月 25 日 到期。');
  ok('D2c_parse_op_result_expiredAt', lic.parseOpResult({ ok: false, code: 'KEY_EXPIRED', expiredAt: expMs }).expiredAtMs === expMs);
  const g5d = lic.gateCopyFor({ allow: false, code: 'G5', keyExpiresMs: expMs });
  ok('C3b_G5_dated', g5d && g5d.body.includes('您的密钥已于 2026 年 10 月 25 日 到期') && !g5d.body.includes('试用'));
  ok('C3c_parse_decision_keyExpires', lic.parseDecision({ allow: false, code: 'G5', keyExpiresMs: expMs }).keyExpiresMs === expMs);
  ok('D3_server_msg', lic.claimDisplayText('QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', { ok: true, msg: '领取成功，密钥已转入您的账号。' }) === '领取成功，密钥已转入您的账号。' &&
    lic.claimDisplayText('QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', { ok: false, code: 'KEY_INVALID', msg: '密钥无效，请核对后重试。' }) === '密钥无效，请核对后重试。');
  ok('D4_network_honest', lic.claimDisplayText('QFR8K-M2X9P-7W4TD-H6N3C-V5YQZ', null) === '网络异常，请稍后再试。');
}

// ---------- E. TrialBar / 折算 ----------
{
  ok('E1_formatRemain', lic.formatRemainMs(2 * 86400000 + 3 * 3600000) === '2 天 3 小时' &&
    lic.formatRemainMs(5 * 3600000 + 7 * 60000) === '5 小时 7 分钟' &&
    lic.formatRemainMs(9 * 60000) === '9 分钟' &&
    lic.formatRemainMs(0) === '已到期' && lic.formatRemainMs(-1000) === '已到期');
  const now = new Date(2026, 9, 25, 12).getTime();
  const meTrial = { planName: 'QFRemote 试用套餐', trialExpiresMs: now + 26 * 3600000, webEnabled: false, hasKey: true, keyExpiresMs: null };
  const mePaid = { planName: 'QFRemote 试用套餐', trialExpiresMs: now + 3600000, webEnabled: true, hasKey: true, keyExpiresMs: null };
  const mePerm = { planName: 'QFRemote 永久套餐', trialExpiresMs: now + 3600000, webEnabled: false, hasKey: true, keyExpiresMs: null };
  ok('E2_trialBar', lic.trialBarText(meTrial, now) === '免费试用中 · 剩余 1 天 2 小时' &&
    lic.trialBarText(mePaid, now) === null && lic.trialBarText(mePerm, now) === null);
}

// ---------- F. 设备码 ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-devcode-'));
  const fakeSs = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('E:' + s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^E:/, '')
  };
  let gen = 0;
  const store = createDeviceCodeStore({
    file: path.join(dir, 'qf-device-code.json'), safeStorage: fakeSs,
    randomBytes: (n) => { gen++; return Buffer.alloc(n, gen); }
  });
  const c1 = store.ensure();
  const c2 = store.ensure();
  const raw = fs.readFileSync(path.join(dir, 'qf-device-code.json'), 'utf8');
  ok('F1_code_stable_encrypted', !!c1 && c1 === c2 && gen === 1 && !raw.includes(c1) &&
    !fs.existsSync(path.join(dir, 'qf-device-code.json.plain')));
  const store2 = createDeviceCodeStore({ file: path.join(dir, 'qf-device-code.json'), safeStorage: fakeSs, randomBytes: () => Buffer.alloc(16, 9) });
  ok('F2_code_survives_recreate', store2.ensure() === c1);
  const noSs = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('no'); }, decryptString: () => { throw new Error('no'); } };
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-devcode2-'));
  const store3 = createDeviceCodeStore({ file: path.join(dir2, 'qf-device-code.json'), safeStorage: noSs, randomBytes: () => Buffer.alloc(16, 7) });
  const c3 = store3.ensure();
  ok('F3_plain_fallback_identifier_only', !!c3 && /^[0-9a-f]{32}$/.test(c3) &&
    fs.readFileSync(path.join(dir2, 'qf-device-code.json.plain'), 'utf8').trim() === c3 && store3.ensure() === c3);
}

// ---------- G. 同源地址 ----------
{
  const urls = createSvcUrls({ loadCache: () => ({ pointsUrl: 'https://tun.example.com/points' }) });
  ok('G1_ext_same_origin', urls.extOrigin() === 'https://tun.example.com' &&
    urls.homeUrl() === 'https://tun.example.com/home' &&
    urls.purchaseUrl() === 'https://tun.example.com/purchase' &&
    urls.licenseStatusUrl() === 'https://tun.example.com/license/status' &&
    urls.appealUrl() === 'https://tun.example.com/appeal' &&
    urls.supportUrl() === 'https://tun.example.com/support' &&
    urls.licenseApi('me') === 'https://tun.example.com/license/api/me' &&
    urls.licenseApi('transfer/claim') === 'https://tun.example.com/license/api/transfer/claim' &&
    urls.licenseApi('device-report') === 'https://tun.example.com/license/api/device-report');
}

// ---------- H. 登录页许可入口 ----------
{
  const js = autologin.buildInjectScript({ username: null, password: null, rememberPassword: false, rememberDevice: false });
  ok('H1_inject_rows', js.includes('qfLicenseRows') && js.includes('购买密钥') && js.includes('查询密钥') &&
    js.includes('#111') && js.includes('#2470E0') && js.includes('qfBuyKeyRow'));
  ok('H2_nav_target', lic.licenseNavTarget('https://54.248.9.192:8443/purchase', '54.248.9.192') === 'purchase' &&
    lic.licenseNavTarget('https://54.248.9.192:8443/license/status', '54.248.9.192') === 'status' &&
    lic.licenseNavTarget('https://54.248.9.192:8443/license/rebind', '54.248.9.192') === 'rebind' &&
    lic.licenseNavTarget('https://tun.example.com/purchase', '54.248.9.192') === null &&
    lic.licenseNavTarget('https://54.248.9.192:8443/', '54.248.9.192') === null);
}

// ---------- I. parseMe 新字段与缺省（2.3.2 热修：slots 上限 / lifecycle / plan / remainText） ----------
{
  const full = lic.parseMe({
    ok: true, username: 'u1', planName: 'QFRemote 按天套餐', hasKey: true,
    slots: { pc: 1, pcMax: 2, mobile: 0, mobileMax: 1 },
    keyLifecycle: 'unactivated', keyPlan: 'd1', keyDurationHours: 24,
    remainText: '未激活（自激活起 24 小时有效）',
    decision: { allow: true, code: 'OK' }
  });
  ok('I1_parseMe_new_fields', full && full.slotsPcMax === 2 && full.slotsMobileMax === 1 &&
    full.keyLifecycle === 'unactivated' && full.keyPlan === 'd1' && full.keyDurationHours === 24 &&
    full.serverRemainText === '未激活（自激活起 24 小时有效）');
  const dflt = lic.parseMe({ ok: true, hasKey: true, slots: { pc: 0, mobile: 0 } });
  ok('I2_parseMe_defaults', dflt && dflt.slotsPcMax === 2 && dflt.slotsMobileMax === 1 &&
    dflt.keyLifecycle === null && dflt.keyPlan === null && dflt.keyDurationHours === null &&
    dflt.serverRemainText === null);
  const emptyRemain = lic.parseMe({ ok: true, remainText: '', slots: {} });
  const nullRemain = lic.parseMe({ ok: true, remainText: null });
  ok('I3_parseMe_remain_empty_null', emptyRemain && emptyRemain.serverRemainText === null &&
    nullRemain && nullRemain.serverRemainText === null &&
    emptyRemain.slotsPcMax === 2 && emptyRemain.slotsMobileMax === 1);
  const customMax = lic.parseMe({ ok: true, slots: { pc: 2, pcMax: 3, mobile: 1, mobileMax: 2 } });
  ok('I4_parseMe_custom_max', customMax && customMax.slotsPcMax === 3 && customMax.slotsMobileMax === 2);
}

// ---------- J. licenseRemainText（serverRemainText 优先＋各兜底分支） ----------
{
  const now = new Date(2026, 9, 25, 12).getTime();
  ok('J1_server_priority_over_expires', lic.licenseRemainText({
    serverRemainText: '未激活（自激活起 24 小时有效）', keyExpiresMs: now + 86400000, hasKey: true,
    keyLifecycle: 'unactivated', keyPlan: 'd1'
  }, now) === '未激活（自激活起 24 小时有效）');
  ok('J2_server_priority_permanent_unactivated', lic.licenseRemainText({
    serverRemainText: '未激活（激活后长期有效）', keyExpiresMs: null, hasKey: true,
    keyLifecycle: 'unactivated', keyPlan: 'permanent'
  }, now) === '未激活（激活后长期有效）');
  ok('J3_unactivated_d1', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'unactivated', keyPlan: 'd1', keyDurationHours: 24
  }, now) === '未激活（自激活起 24 小时有效）');
  ok('J4_unactivated_d7_d30', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'unactivated', keyPlan: 'd7', keyDurationHours: 168
  }, now) === '未激活（自激活起 168 小时有效）' &&
  lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'unactivated', keyPlan: 'd30', keyDurationHours: 720
  }, now) === '未激活（自激活起 720 小时有效）');
  ok('J5_unactivated_map_fallback', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'unactivated', keyPlan: 'd1', keyDurationHours: null
  }, now) === '未激活（自激活起 24 小时有效）' &&
  lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'unactivated', keyPlan: 'd7'
  }, now) === '未激活（自激活起 168 小时有效）' &&
  lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'unactivated', keyPlan: 'd30'
  }, now) === '未激活（自激活起 720 小时有效）');
  ok('J6_unactivated_no_plan_no_hours', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'unactivated', keyPlan: null, keyDurationHours: null
  }, now) === '未激活');
  ok('J7_unactivated_permanent', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'unactivated', keyPlan: 'permanent', keyDurationHours: null
  }, now) === '未激活（激活后长期有效）');
  ok('J8_no_lifecycle_timed_plan', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyPlan: 'd7'
  }, now) === '未激活（自激活起 168 小时有效）');
  ok('J9_activated_permanent_longterm', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'activated', keyPlan: 'permanent'
  }, now) === '长期有效');
  ok('J10_activated_timed_via_expires', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: now + 2 * 86400000 + 3 * 3600000, keyLifecycle: 'activated', keyPlan: 'd30'
  }, now) === '2 天 3 小时');
  ok('J11_expired_revoked', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'expired', keyPlan: 'd1'
  }, now) === '已过期' &&
  lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, keyLifecycle: 'revoked', keyPlan: 'permanent'
  }, now) === '已收回');
  ok('J12_no_key_and_null', lic.licenseRemainText({ hasKey: false, keyExpiresMs: null }, now) === '—' &&
    lic.licenseRemainText(null, now) === '—');
  ok('J13_trial_retained', lic.licenseRemainText({
    hasKey: true, keyExpiresMs: null, planName: 'QFRemote 试用套餐', trialExpiresMs: now + 5 * 3600000 + 7 * 60000
  }, now) === '5 小时 7 分钟');
}

// ---------- K. licenseEntryMode 三态矩阵（决策 #49） ----------
{
  ok('K1_entry_permanent', lic.licenseEntryMode({ keyPlan: 'permanent', keyLifecycle: 'activated' }) === 'permanent');
  ok('K2_entry_timed', lic.licenseEntryMode({ keyPlan: 'd1', keyLifecycle: 'activated' }) === 'timed' &&
    lic.licenseEntryMode({ keyPlan: 'd7', keyLifecycle: 'activated' }) === 'timed' &&
    lic.licenseEntryMode({ keyPlan: 'd30', keyLifecycle: 'activated' }) === 'timed');
  ok('K3_entry_inactive_matrix',
    lic.licenseEntryMode(null) === 'inactive' &&
    lic.licenseEntryMode({}) === 'inactive' &&
    lic.licenseEntryMode({ keyPlan: 'permanent', keyLifecycle: 'unactivated' }) === 'inactive' &&
    lic.licenseEntryMode({ keyPlan: 'd1', keyLifecycle: 'unactivated' }) === 'inactive' &&
    lic.licenseEntryMode({ keyPlan: 'permanent', keyLifecycle: null }) === 'inactive' &&
    lic.licenseEntryMode({ keyPlan: 'trial', keyLifecycle: 'activated' }) === 'inactive' &&
    lic.licenseEntryMode({ keyPlan: 'permanent', keyLifecycle: 'expired' }) === 'inactive' &&
    lic.licenseEntryMode({ keyPlan: 'd7', keyLifecycle: 'revoked' }) === 'inactive');
}

result.pass = Object.values(result.cases).every(c => c.pass);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
