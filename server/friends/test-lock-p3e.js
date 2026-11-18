'use strict';
/*
 * P3-05 · 契约 §14 九项代码缺口验收测试（沙箱实跑）
 * 依据：LOCK-PROTOCOL-CONTRACT.md v2.0.0 §14（P3-04 锁定）＋ VERIFY-P304。
 * 覆盖：R-9（#9 FAIL 的修复，改判前置——本线只记“已修、待 P3-06 复测”，
 * 不自行改判）／R-7／F-2／F-1／R-3／R-4／R-6／R-10 的服务端侧（DOM 断言
 * 在 lock-modal-dom-test.js 与 lock-confirm-web.test.mjs 中另补）／F-3
 * （契约文字，见集成 CONTRACT.md §6 已为 v2 先查先拒，本文件不测文字）。
 * M-1（桥掩盖性问题）只记录，不由本线修、不由本文件断言。
 * 全部纯函数级＋桥谓词级，不碰网络、不读生产文件、不做真机判断。
 * 用法：node server/friends/test-lock-p3e.js；退出码 0=全过。
 */
const S = require('./lock-state');
const B = require('./lock-bridge');
const { LockStateMachine } = require('../../windows/lock-v2/lock-state');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; console.log('FAIL-', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const NOW = Date.parse('2026-11-19T03:05:00+08:00');
const CREATED = Date.parse('2026-11-18T17:11:58.053Z');
const FRESH = new Date(NOW).toISOString();
const DEV = 'node//D39ABOL-test';
const PAUSE_NOTICE = '当前屏幕锁功能因兼容性故障暂停使用。请勿手动运行旧版 QFLockUI.exe。正常远程控制功能不受此项暂停影响。';
function lockedRecord(over) {
  return S.createLockRecord(Object.assign({
    device_id: DEV, boot_id: 'boot-1', session_id: 'sess-1', sid: 'S-1-5-21-100',
    desired_state: 'LOCKED', actual_state: 'LOCKED', now: NOW, created_at: CREATED,
    last_heartbeat: CREATED,
  }, over || {}));
}
// v1 形 status（无 actual_state／无 revision，旧设备口径）
function stV1(over) {
  return Object.assign({ state: 'Off', updatedAt: FRESH, lastEvents: [] }, over || {});
}
// v2 形 status（带 actual_state；revision 有则传，无则缺——R-7 用）
function stV2(over) {
  return Object.assign({ state: 'Off', actual_state: 'UNLOCKED', version: '2.0.0', updatedAt: FRESH, lastEvents: [] }, over || {});
}

// ---------- R-9：降级只在 LOCKED／LOCKING 下（#9 FAIL 的修复） ----------
t('R9-1 LOCKED+unknown 记 DEGRADED', (() => {
  const r = S.reconcileRecord(lockedRecord(), stV1({ state: 'Locked', captureExclusion: 'unknown' }), { now: NOW });
  return r.record.degraded === 'DEGRADED';
})());
t('R9-2 UNLOCKED+unknown 不记降级（#9-C2 原 FAIL 点）', (() => {
  const rec = lockedRecord({ actual_state: 'UNLOCKED', desired_state: 'UNLOCKED', revision: 5 });
  const r = S.reconcileRecord(rec, stV1({ state: 'Off', captureExclusion: 'unknown' }), { now: NOW });
  return r.record.degraded === null;
})());
t('R9-3 UNLOCKED+failed-degraded 不记降级（#9-C3 原 FAIL 点）', (() => {
  const rec = lockedRecord({ actual_state: 'UNLOCKED', desired_state: 'UNLOCKED', revision: 5 });
  const r = S.reconcileRecord(rec, stV1({ state: 'Off', captureExclusion: 'failed-degraded' }), { now: NOW });
  return r.record.degraded === null;
})());
t('R9-4 LOCKING+unknown 记 DEGRADED', (() => {
  const rec = lockedRecord({ actual_state: 'LOCKING', desired_state: 'LOCKED', revision: 5 });
  const r = S.reconcileRecord(rec, stV1({ state: 'Locked', captureExclusion: 'unknown' }), { now: NOW });
  return r.record.degraded === 'DEGRADED';
})());
t('R9-5 LOCKED+active 清除降级', (() => {
  const r = S.reconcileRecord(lockedRecord(), stV1({ state: 'Locked', captureExclusion: 'active' }), { now: NOW });
  return r.record.degraded === null;
})());
t('R9-6 LOCKED+failed-degraded 记 DEGRADED', (() => {
  const r = S.reconcileRecord(lockedRecord(), stV1({ state: 'Locked', captureExclusion: 'failed-degraded' }), { now: NOW });
  return r.record.degraded === 'DEGRADED';
})());
t('R9-7 v2 一致上报 LOCKED+unknown 记 DEGRADED（state 与 actual_state 一致）', (() => {
  const rec = lockedRecord();
  const st = stV2({ state: 'Locked', actual_state: 'LOCKED', revision: 6, captureExclusion: 'unknown' });
  const r = S.reconcileRecord(rec, st, { now: NOW });
  return r.record.actual_state === 'LOCKED' && r.record.degraded === 'DEGRADED';
})());

// ---------- R-7：v2 缺 revision → RECOVERY_REQUIRED（revision-missing） ----------
t('R7-1 v2 缺 revision 进 RECOVERY_REQUIRED（#7-C2 原缺口）', (() => {
  const rec = lockedRecord();
  const st = stV2({ state: 'Locked', actual_state: 'LOCKED', lastEvents: [{ ts: '2026-11-18T17:12:00Z', ev: 'arm', fields: { armId: rec.lock_id } }] });
  delete st.revision;
  const r = S.reconcileRecord(rec, st, { now: NOW });
  return r.record.actual_state === 'RECOVERY_REQUIRED' && r.reason === 'revision-missing';
})());
t('R7-2 v2 带 revision（与服务端一致）不触发 revision-missing', (() => {
  const rec = lockedRecord();
  const st = stV2({ state: 'Locked', actual_state: 'LOCKED', revision: rec.revision,
    lastEvents: [{ ts: '2026-11-18T17:12:00Z', ev: 'arm', fields: { armId: rec.lock_id } }] });
  const r = S.reconcileRecord(rec, st, { now: NOW });
  return r.decision === 'confirmed' && r.reason !== 'revision-missing';
})());
t('R7-3 v1 缺 revision 仍跳过（负向：version 2.4.5 不单独算 v2）', (() => {
  const rec = lockedRecord();
  const st = stV1({ state: 'Locked', version: '2.4.5',
    lastEvents: [{ ts: '2026-11-18T17:12:00Z', ev: 'arm', fields: { armId: rec.lock_id } }] });
  const r = S.reconcileRecord(rec, st, { now: NOW });
  return r.decision === 'confirmed' && r.record.actual_state === 'LOCKED';
})());
t('R7-4 v2 revision 非数字同样判 revision-missing', (() => {
  const rec = lockedRecord();
  const st = stV2({ state: 'Locked', actual_state: 'LOCKED', revision: '5' });
  const r = S.reconcileRecord(rec, st, { now: NOW });
  return r.record.actual_state === 'RECOVERY_REQUIRED' && r.reason === 'revision-missing';
})());

// ---------- F-2：v2 优先读 actual_state，v1 回落 state ----------
t('F2-1 state=Off 但 actual_state=LOCKED → 判 LOCKED（探针 A-1 原缺口）', (() => {
  const c = S.classifyDeviceStatus(stV2({ state: 'Off', actual_state: 'LOCKED', revision: 5 }), lockedRecord(), NOW);
  return c.actual === 'LOCKED';
})());
t('F2-2 state=Locked 但 actual_state=UNLOCKED＋disarm 强证据 → 判 UNLOCKED', (() => {
  const rec = lockedRecord();
  const c = S.classifyDeviceStatus(stV2({ state: 'Locked', actual_state: 'UNLOCKED', revision: 6,
    lastEvents: [{ ts: '2026-11-18T17:12:30Z', ev: 'disarm', fields: { lockId: rec.lock_id } }] }), rec, NOW);
  return c.actual === 'UNLOCKED' && c.evidence === 'strong' && c.reason === 'disarm-event-match';
})());
t('F2-3 actual_state=LOCKING 直接按设备自报（弱证据）', (() => {
  const c = S.classifyDeviceStatus(stV2({ state: 'Off', actual_state: 'LOCKING', revision: 5 }), lockedRecord(), NOW);
  return c.actual === 'LOCKING' && c.evidence === 'weak';
})());
t('F2-4 actual_state=UNKNOWN → UNKNOWN（不猜 UNLOCKED）', (() => {
  const c = S.classifyDeviceStatus(stV2({ state: 'Off', actual_state: 'UNKNOWN', revision: 5 }), lockedRecord(), NOW);
  return c.actual === 'UNKNOWN' && c.evidence === 'none';
})());
t('F2-5 v1 无 actual_state 回落 state 映射（旧行为不变）', (() => {
  const c = S.classifyDeviceStatus(stV1({ state: 'Locked' }), lockedRecord(), NOW);
  return c.actual === 'LOCKED';
})());
t('F2-6 无记录基线优先读 actual_state', (() => {
  const r = S.reconcileRecord(null, stV2({ state: 'Off', actual_state: 'LOCKED', revision: 5 }), { device_id: DEV, now: NOW });
  return r.record.actual_state === 'LOCKED' && r.decision === 'baseline-from-device';
})());

// ---------- F-1：转移表并集 ----------
t('F1-1 C：RECOVERY_REQUIRED→LOCKING 合法（原 A4 判非法）', (() => {
  const rec = lockedRecord({ actual_state: 'RECOVERY_REQUIRED' });
  return S.transition(rec, 'LOCKING', { now: NOW, reason: 'probe' }).ok === true;
})());
t('F1-2 C：RECOVERY_REQUIRED→UNLOCKING 仍非法（不纳入）', (() => {
  const rec = lockedRecord({ actual_state: 'RECOVERY_REQUIRED' });
  return S.transition(rec, 'UNLOCKING', { now: NOW, reason: 'probe' }).ok === false;
})());
t('F1-3 B：UNLOCKED→RECOVERY_REQUIRED 合法', (() => {
  const m = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1', actualState: 'UNLOCKED' });
  m.transition('RECOVERY_REQUIRED', { reason: 'probe' });
  return m.actualState === 'RECOVERY_REQUIRED';
})());
t('F1-4 B：UNLOCKING→LOCKED 合法', (() => {
  const m = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1', actualState: 'UNLOCKING' });
  m.transition('LOCKED', { reason: 'probe' });
  return m.actualState === 'LOCKED';
})());
t('F1-5 B：UNKNOWN→UNLOCKING 合法', (() => {
  const m = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1', actualState: 'UNKNOWN' });
  m.transition('UNLOCKING', { reason: 'probe' });
  return m.actualState === 'UNLOCKING';
})());
t('F1-6 双端：LOCKED→UNLOCKED 直达仍禁（须经 UNLOCKING 两步）', (() => {
  let threw = false;
  const m = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1', actualState: 'LOCKED' });
  try { m.transition('UNLOCKED', { reason: 'probe' }); } catch (e) { threw = true; }
  return threw && S.transition(lockedRecord(), 'UNLOCKED', { now: NOW }).ok === false;
})());

// ---------- R-3：桥 disable 等待谓词 lockId 优先 ----------
const pred = B._test.disarmWaitPredicate;
const SINCE = Date.parse('2026-11-19T03:00:00+08:00');
t('R3-1 lockId 匹配放行（事件时间早于窗口也放行）', (() => {
  const p = pred('lock-new', SINCE);
  return p({ state: 'Off', lastEvents: [{ ts: '2026-11-18T17:00:00Z', ev: 'disarm', fields: { lockId: 'lock-new' } }] }) === true;
})());
t('R3-2 旧 lockId＋旧时间不放行（负向）', (() => {
  const p = pred('lock-new', SINCE);
  return p({ state: 'Off', lastEvents: [{ ts: '2026-11-18T17:00:00Z', ev: 'disarm', fields: { lockId: 'lock-old' } }] }) === false;
})());
t('R3-3 无时间戳事件不放行（负向：旧谓词 !ev.time 会放行）', (() => {
  const p = pred('lock-new', SINCE);
  return p({ state: 'Off', lastEvents: [{ ev: 'disarm', fields: {} }] }) === false
    && p({ state: 'Off', lastEvents: [{ ev: 'disarm' }] }) === false;
})());
t('R3-4 无 lockId 但时间在窗口内仍放行（时间窗口兜底保留）', (() => {
  const p = pred('lock-new', SINCE);
  return p({ state: 'Off', lastEvents: [{ ts: new Date(SINCE + 1000).toISOString(), ev: 'disarm', fields: { by: 'alice' } }] }) === true;
})());
t('R3-5 设备未 Off 时不放行（负向）', (() => {
  const p = pred('lock-new', SINCE);
  return p({ state: 'Locked', lastEvents: [{ ts: new Date(SINCE + 1000).toISOString(), ev: 'disarm', fields: { lockId: 'lock-new' } }] }) === false;
})());
t('R3-6 v2 形事件只有 ts（无 time 键）＋窗口内时间放行', (() => {
  const p = pred('lock-new', SINCE);
  return p({ state: 'Off', lastEvents: [{ ts: new Date(SINCE + 1000).toISOString(), ev: 'disarm', fields: { by: 'alice' } }] }) === true;
})());

// ---------- R-4：无 fields 的 unlock-ok 也须过时间窗口 ----------
t('R4-1 无 fields＋陈旧 unlock-ok 不作强证据（负向）', (() => {
  const rec = lockedRecord();
  const c = S.classifyDeviceStatus(stV1({ state: 'Off',
    lastEvents: [{ ts: '2026-11-18T17:11:00Z', ev: 'unlock-ok' }] }), rec, NOW);
  return c.actual === 'RECOVERY_REQUIRED' && c.reason === 'off-without-proof';
})());
t('R4-2 无 fields＋窗口内 unlock-ok 作强证据', (() => {
  const rec = lockedRecord();
  const c = S.classifyDeviceStatus(stV1({ state: 'Off',
    lastEvents: [{ ts: '2026-11-18T17:12:30Z', ev: 'unlock-ok' }] }), rec, NOW);
  return c.actual === 'UNLOCKED' && c.evidence === 'strong';
})());
t('R4-3 无 fields＋无时间戳 unlock-ok 不作强证据（负向）', (() => {
  const rec = lockedRecord();
  const c = S.classifyDeviceStatus(stV1({ state: 'Off', lastEvents: [{ ev: 'unlock-ok' }] }), rec, NOW);
  return c.actual === 'RECOVERY_REQUIRED';
})());

// ---------- R-6：身份字段回填在 reconcileRecord 出口统一做 ----------
t('R6-1 to-unlocked 两步路径同样回填三身份字段（旧 confirmed 分支漏填）', (() => {
  const rec = lockedRecord({ boot_id: null, session_id: null, sid: null });
  const st = stV2({ state: 'Off', actual_state: 'UNLOCKED', revision: 6,
    boot_id: 'boot-9', session_id: '7', sid: 'S-1-5-21-999',
    lastEvents: [{ ts: '2026-11-18T17:12:30Z', ev: 'disarm', fields: { lockId: rec.lock_id } }] });
  const r = S.reconcileRecord(rec, st, { now: NOW });
  return r.record.actual_state === 'UNLOCKED'
    && r.record.boot_id === 'boot-9' && r.record.session_id === '7' && r.record.sid === 'S-1-5-21-999';
})());
t('R6-2 已有身份字段不被覆盖（负向）', (() => {
  const rec = lockedRecord();
  const st = stV2({ state: 'Locked', actual_state: 'LOCKED', revision: rec.revision,
    boot_id: 'boot-other', session_id: '99', sid: 'S-OTHER',
    lastEvents: [{ ts: '2026-11-18T17:12:00Z', ev: 'arm', fields: { armId: rec.lock_id } }] });
  const r = S.reconcileRecord(rec, st, { now: NOW });
  return r.record.boot_id === 'boot-1' && r.record.session_id === 'sess-1' && r.record.sid === 'S-1-5-21-100';
})());

// ---------- R-10：PAUSE_NOTICE 原文（服务端侧常量比对；DOM 断言见另两测试） ----------
t('R10-1 B 侧 PAUSE_NOTICE 与裁决 §2.2 原文一字不改', (() => {
  const { PAUSE_NOTICE: PN } = require('../../windows/lock-v2/legacy-retirement');
  return PN === PAUSE_NOTICE;
})());

console.log('----');
console.log('test-lock-p3e: PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
