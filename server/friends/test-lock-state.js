'use strict';
/*
 * C 线 · 服务端锁状态机／对账／幂等／操作挑战 单测（沙箱实跑）
 * 依据：定夺 §4.2（状态机＋记录字段）／§4.3（幂等对账修正）／§4.4（挑战＋幂等）。
 * 全部纯函数级，不碰网络、不读生产文件、不做真机判断。
 * 故障注入五项（超时、掉线、状态变化、重复确认、并发重放）见 F 节。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./lock-state');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; console.log('FAIL-', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const NOW = Date.parse('2026-11-19T03:05:00+08:00'); // 与任务派单时间一致的固定时钟，便于断言
const DEV = 'node//D39ABOL-test';
function lockedRecord(over) {
  return S.createLockRecord(Object.assign({
    device_id: DEV, boot_id: 'boot-1', session_id: 'sess-1', sid: 'S-1-5-21-100',
    desired_state: 'LOCKED', actual_state: 'LOCKED', now: NOW,
    created_at: Date.parse('2026-11-18T17:11:58.053Z'),
    last_heartbeat: Date.parse('2026-11-18T17:11:58.053Z'),
  }, over || {}));
}

// ---------- A. 状态机 ----------
t('A1 UNLOCKED->LOCKING 合法', S.transition(S.createLockRecord({ device_id: DEV, actual_state: 'UNLOCKED', now: NOW }), 'LOCKING', { now: NOW }).ok === true);
t('A2 LOCKED->UNLOCKED 直接迁移非法（须经 UNLOCKING）', S.transition(lockedRecord(), 'UNLOCKED', { now: NOW }).ok === false);
t('A3 UNKNOWN->LOCKED 合法（证据到达可恢复）', S.transition(S.createLockRecord({ device_id: DEV, actual_state: 'UNKNOWN', now: NOW }), 'LOCKED', { now: NOW }).ok === true);
t('A4 RECOVERY_REQUIRED->LOCKING 合法（P3-05 F-1：契约 §1 并集表补边，原判非法）', S.transition(S.createLockRecord({ device_id: DEV, actual_state: 'RECOVERY_REQUIRED', now: NOW }), 'LOCKING', { now: NOW }).ok === true);
t('A4b RECOVERY_REQUIRED->UNLOCKING 仍非法（并集表不纳入，P3-05 F-1）', S.transition(S.createLockRecord({ device_id: DEV, actual_state: 'RECOVERY_REQUIRED', now: NOW }), 'UNLOCKING', { now: NOW }).ok === false);
t('A5 未知状态名拒绝', S.transition(lockedRecord(), 'BOGUS', { now: NOW }).ok === false);
t('A6 迁移 revision+1 且留审计', (() => {
  const r = S.transition(lockedRecord(), 'UNLOCKING', { now: NOW, op_id: 'op-x', by: 'alice', reason: 'user-disable' });
  return r.ok && r.record.revision === lockedRecord().revision + 1 && r.record.history.length === 1 && r.record.history[0].op_id === 'op-x';
})());
t('A7 记录含定夺 §4.2 全部字段', (() => {
  const r = S.createLockRecord({ device_id: DEV, boot_id: 'b', session_id: 's', sid: 'SID', now: NOW });
  return ['lock_id', 'device_id', 'boot_id', 'session_id', 'sid', 'revision', 'desired_state', 'actual_state', 'last_heartbeat', 'last_error']
    .every((k) => Object.prototype.hasOwnProperty.call(r, k));
})());
t('A8 mapLegacyState：Off/Locked/Fault/未知', S.mapLegacyState('Off') === 'UNLOCKED' && S.mapLegacyState('Locked') === 'LOCKED'
  && S.mapLegacyState('Fault') === 'RECOVERY_REQUIRED' && S.mapLegacyState('???') === 'UNKNOWN');

// ---------- B. 设备上报分类 ----------
t('B1 读不到设备（null）→ UNKNOWN、证据 none', (() => {
  const c = S.classifyDeviceStatus(null, lockedRecord(), NOW);
  return c.actual === 'UNKNOWN' && c.evidence === 'none';
})());
t('B2 设备 Fault → RECOVERY_REQUIRED', S.classifyDeviceStatus({ state: 'Fault' }, lockedRecord(), NOW).actual === 'RECOVERY_REQUIRED');
t('B3 设备 Locked＋匹配 arm 事件 → LOCKED 强证据', (() => {
  const rec = lockedRecord();
  const c = S.classifyDeviceStatus({ state: 'Locked', lastEvents: [{ ts: '2026-11-18T17:12:00Z', ev: 'arm', fields: { armId: rec.lock_id } }] }, rec, NOW);
  return c.actual === 'LOCKED' && c.evidence === 'strong';
})());
t('B4 设备 Locked 无匹配事件 → LOCKED 弱证据（信自报，不算验证通过）', (() => {
  const c = S.classifyDeviceStatus({ state: 'Locked', lastEvents: [] }, lockedRecord(), NOW);
  return c.actual === 'LOCKED' && c.evidence === 'weak';
})());
t('B5 设备 Off＋匹配 disarm 事件 → UNLOCKED 强证据', (() => {
  const rec = lockedRecord();
  const c = S.classifyDeviceStatus({ state: 'Off', boot_id: 'boot-1', lastEvents: [{ ts: '2026-11-18T17:20:00Z', ev: 'disarm', fields: { lockId: rec.lock_id } }] }, rec, NOW);
  return c.actual === 'UNLOCKED' && c.evidence === 'strong';
})());
t('B6 设备 Off 无任何证明＋服务端 LOCKED → RECOVERY_REQUIRED（D39ABOL 模式）', (() => {
  const c = S.classifyDeviceStatus({ state: 'Off', boot_id: 'boot-1', lastEvents: [] }, lockedRecord(), NOW);
  return c.actual === 'RECOVERY_REQUIRED' && c.reason === 'off-without-proof';
})());
t('B7 设备 Off＋boot_id 变化 → UNLOCKED 强证据（重启后旧锁必然消失）', (() => {
  const c = S.classifyDeviceStatus({ state: 'Off', boot_id: 'boot-2', lastEvents: [] }, lockedRecord(), NOW);
  return c.actual === 'UNLOCKED' && c.evidence === 'strong' && c.reason === 'boot-changed';
})());
t('B8 服务端非 LOCKED 时设备 Off → UNLOCKED（无需强证据）', (() => {
  const rec = S.createLockRecord({ device_id: DEV, actual_state: 'UNKNOWN', now: NOW });
  return S.classifyDeviceStatus({ state: 'Off' }, rec, NOW).actual === 'UNLOCKED';
})());
t('B9 旧格式 lastEvents（type/time）同样识别 disarm', (() => {
  const rec = lockedRecord();
  const c = S.classifyDeviceStatus({ state: 'Off', lastEvents: [{ time: '2026-11-18T17:20:00Z', type: 'disarm', fields: { lockId: rec.lock_id } }] }, rec, NOW);
  return c.actual === 'UNLOCKED' && c.evidence === 'strong';
})());
t('B10 设备 Off＋unlock-ok（本地输密码解锁）→ UNLOCKED 强证据', (() => {
  const c = S.classifyDeviceStatus({ state: 'Off', lastEvents: [{ ts: '2026-11-18T17:20:00Z', ev: 'unlock-ok', fields: { by: '718983610' } }] }, lockedRecord(), NOW);
  return c.actual === 'UNLOCKED' && c.evidence === 'strong' && c.reason === 'disarm-event-match';
})());
t('B11 设备 Off＋boot-recovered 事件（status.json v1 无 boot_id 时的重启证明）→ UNLOCKED 强证据', (() => {
  const c = S.classifyDeviceStatus({ state: 'Off', lastEvents: [{ ts: '2026-11-18T17:20:00Z', ev: 'boot-recovered', fields: {} }] }, lockedRecord(), NOW);
  return c.actual === 'UNLOCKED' && c.evidence === 'strong' && c.reason === 'boot-recovered';
})());
t('B12 updatedAt 超 2 分钟未更新 → UNKNOWN（stale-heartbeat），不信旧文件', (() => {
  const c = S.classifyDeviceStatus({ state: 'Locked', updatedAt: '2026-11-18T19:00:00Z', lastEvents: [] }, lockedRecord(), NOW);
  return c.actual === 'UNKNOWN' && c.reason === 'stale-heartbeat';
})());
t('B13 updatedAt 新鲜（60 秒内）仍按 state 判 LOCKED', (() => {
  const c = S.classifyDeviceStatus({ state: 'Locked', updatedAt: '2026-11-18T19:04:00Z', lastEvents: [] }, lockedRecord(), NOW);
  return c.actual === 'LOCKED';
})());
t('B14 fault 字段（state-corrupt）→ RECOVERY_REQUIRED', (() => {
  const c = S.classifyDeviceStatus({ state: 'Locked', fault: 'state-corrupt', lastEvents: [] }, lockedRecord(), NOW);
  return c.actual === 'RECOVERY_REQUIRED' && c.reason === 'device-fault';
})());

// ---------- C. 对账 ----------
t('C1 超时／读不到：LOCKED→UNKNOWN，绝不改 UNLOCKED', (() => {
  const r = S.reconcileRecord(lockedRecord(), null, { now: NOW });
  return r.record.actual_state === 'UNKNOWN' && r.decision === 'to-unknown';
})());
t('C2 设备 Off 无证明：LOCKED→RECOVERY_REQUIRED', (() => {
  const r = S.reconcileRecord(lockedRecord(), { state: 'Off', boot_id: 'boot-1', lastEvents: [] }, { now: NOW });
  return r.record.actual_state === 'RECOVERY_REQUIRED' && r.decision === 'to-recovery';
})());
t('C3 设备真实已解锁（强证据）：LOCKED 经 UNLOCKING 两步收敛到 UNLOCKED，审计留两步', (() => {
  const rec = lockedRecord();
  const r = S.reconcileRecord(rec, { state: 'Off', boot_id: 'boot-1', lastEvents: [{ ts: '2026-11-18T17:20:00Z', ev: 'disarm', fields: { lockId: rec.lock_id } }] }, { now: NOW });
  return r.record.actual_state === 'UNLOCKED' && r.decision === 'to-unlocked'
    && r.record.history.length === 2 && r.record.history[0].to === 'UNLOCKING' && r.record.history[1].to === 'UNLOCKED';
})());
t('C4 设备确认仍锁定：状态不变、只刷新心跳', (() => {
  const rec = lockedRecord();
  const r = S.reconcileRecord(rec, { state: 'Locked', lastEvents: [{ ts: '2026-11-18T17:12:00Z', ev: 'arm', fields: { armId: rec.lock_id } }] }, { now: NOW + 5000 });
  return r.record.actual_state === 'LOCKED' && r.changed === false && r.record.last_heartbeat === NOW + 5000 && r.decision === 'confirmed';
})());
t('C5 设备上报 revision 旧于服务端 → RECOVERY_REQUIRED', (() => {
  const rec = lockedRecord({ revision: 7 });
  const r = S.reconcileRecord(rec, { state: 'Locked', revision: 3 }, { now: NOW });
  return r.record.actual_state === 'RECOVERY_REQUIRED' && r.decision === 'revision-conflict';
})());
t('C6 无服务端记录：以设备自报建基线', (() => {
  const r = S.reconcileRecord(null, { state: 'Locked', deviceId: DEV }, { now: NOW, device_id: DEV });
  return r.record.actual_state === 'LOCKED' && r.decision === 'baseline-from-device';
})());
t('C7 captureExclusion=failed-degraded 记 degraded=DEGRADED；恢复 active 后清除', (() => {
  const r1 = S.reconcileRecord(lockedRecord(), { state: 'Locked', captureExclusion: 'failed-degraded', lastEvents: [] }, { now: NOW });
  const r2 = S.reconcileRecord(r1.record, { state: 'Locked', captureExclusion: 'active', lastEvents: [] }, { now: NOW });
  return r1.record.degraded === 'DEGRADED' && r2.record.degraded === null;
})());
t('C8 心跳取 status.updatedAt（非读取时间）', (() => {
  const r = S.reconcileRecord(lockedRecord(), { state: 'Locked', updatedAt: '2026-11-18T19:04:30Z', lastEvents: [] }, { now: NOW });
  return r.record.last_heartbeat === Date.parse('2026-11-18T19:04:30Z');
})());

// ---------- D. 幂等对账修正 ----------
// 注：C3 表明对账本身不把 LOCKED 直改 UNLOCKED；真正的解锁确认走修正通道。
t('D1 无操作编号拒绝修正', S.applyCorrection(lockedRecord(), { to_state: 'UNLOCKED', reason: 'x', evidence: 'strong' }).ok === false);
t('D2 无理由拒绝修正', S.applyCorrection(lockedRecord(), { op_id: 'op-1', to_state: 'UNLOCKED', evidence: 'strong' }).ok === false);
t('D3 弱证据离开 LOCKED 去 UNLOCKED 拒绝', S.applyCorrection(lockedRecord(), { op_id: 'op-1', to_state: 'UNLOCKED', reason: 'looks-off', evidence: 'weak' }).reason === 'evidence-insufficient');
t('D4 强证据修正通过：revision+2（两步）、原记录保留、created_at 不变', (() => {
  const rec = lockedRecord();
  const r = S.applyCorrection(rec, { op_id: 'op-9', by: 'alice', to_state: 'UNLOCKED', reason: 'disarm-confirmed-by-device', evidence: 'strong', now: NOW });
  return r.ok && r.record.actual_state === 'UNLOCKED' && r.record.revision === rec.revision + 2
    && r.record.created_at === rec.created_at && r.record.lock_id === rec.lock_id
    && r.record.history.length === 2 && r.record.history[0].op_id === 'op-9' && r.record.history[1].op_id === 'op-9';
})());
t('D5 同一操作编号重复修正拒绝（不产生第二次修正）', (() => {
  const rec = lockedRecord();
  const c = { op_id: 'op-9', by: 'alice', to_state: 'UNLOCKED', reason: 'disarm-confirmed-by-device', evidence: 'strong', now: NOW };
  const r1 = S.applyCorrection(rec, c);
  const r2 = S.applyCorrection(r1.record, c);
  return r1.ok === true && r2.ok === false && r2.reason === 'op-id-replayed';
})());
t('D6 从 RECOVERY_REQUIRED 经强证据修正到 UNLOCKED 通过', (() => {
  const rec = S.createLockRecord({ device_id: DEV, actual_state: 'RECOVERY_REQUIRED', now: NOW });
  const r = S.applyCorrection(rec, { op_id: 'op-10', to_state: 'UNLOCKED', reason: 'device-confirmed-off-after-reboot', evidence: 'strong', now: NOW });
  return r.ok && r.record.actual_state === 'UNLOCKED';
})());

// ---------- E. 操作挑战 ----------
let _now = NOW;
const ch = S.createChallengeStore({ now: () => _now });
const iss = ch.issue({ account: 'Alice', deviceId: DEV, op: 'disarm' });
t('E1 挑战签发含 challenge 与过期时间', !!iss && typeof iss.challenge === 'string' && iss.expiresAt === NOW + ch.ttlMs);
t('E2 挑战一次性验证通过（账号大小写不敏感）', ch.verify({ challenge: iss.challenge, account: 'alice', deviceId: DEV, op: 'disarm' }).ok === true);
t('E3 同一挑战重放验证失败（已消费）', ch.verify({ challenge: iss.challenge, account: 'alice', deviceId: DEV, op: 'disarm' }).ok === false);
const iss2 = ch.issue({ account: 'alice', deviceId: DEV, op: 'disarm' });
t('E4 挑战绑定他人账号验证失败', ch.verify({ challenge: iss2.challenge, account: 'mallory', deviceId: DEV, op: 'disarm' }).ok === false);
t('E5 挑战绑定他台设备验证失败', ch.verify({ challenge: iss2.challenge, account: 'alice', deviceId: 'node//OTHER', op: 'disarm' }).ok === false);
t('E6 挑战绑定他种操作验证失败', ch.verify({ challenge: iss2.challenge, account: 'alice', deviceId: DEV, op: 'arm' }).ok === false);
t('E7 绑定失败不消费挑战（原挑战仍可用）', ch.verify({ challenge: iss2.challenge, account: 'alice', deviceId: DEV, op: 'disarm' }).ok === true);
const iss3 = ch.issue({ account: 'alice', deviceId: DEV, op: 'disarm' });
_now += 5 * 60 * 1000 + 1;
t('E8 挑战 5 分钟过期后验证失败', ch.verify({ challenge: iss3.challenge, account: 'alice', deviceId: DEV, op: 'disarm' }).reason === 'challenge-expired');
t('E9 缺挑战返回 challenge-required', ch.verify({ account: 'alice', deviceId: DEV, op: 'disarm' }).reason === 'challenge-required');
t('E10 缺字段签发失败', ch.issue({ account: 'alice', deviceId: DEV }) === null);

// ---------- F. 故障注入（超时、掉线、状态变化、重复确认、并发重放） ----------
t('F1 注入·超时：30s 对账窗口内读不到 → UNKNOWN（见 C1）', S.reconcileRecord(lockedRecord(), null, { now: NOW }).record.actual_state === 'UNKNOWN');
t('F2 注入·掉线：掉线后设备再报 Off 无证明 → 不清除，仍 RECOVERY_REQUIRED', (() => {
  let rec = lockedRecord();
  rec = S.reconcileRecord(rec, null, { now: NOW }).record; // 掉线 → UNKNOWN
  const r = S.reconcileRecord(rec, { state: 'Off', boot_id: 'boot-1', lastEvents: [] }, { now: NOW + 1000 });
  return r.record.actual_state === 'RECOVERY_REQUIRED';
})());
t('F3 注入·状态变化：锁定时设备中途报 Fault → RECOVERY_REQUIRED', (() => {
  const r = S.reconcileRecord(lockedRecord(), { state: 'Fault' }, { now: NOW });
  return r.record.actual_state === 'RECOVERY_REQUIRED';
})());
t('F4 注入·重复确认：同一 operationId 只存一次成功结果，重复提交返回旧结果', (() => {
  const ops = S.createOperationStore({ now: () => NOW });
  const res = { ok: true, lockState: 'UNLOCKED', revision: 2 };
  const first = ops.store('op-dup-1', res);
  const second = ops.store('op-dup-1', { ok: true, lockState: 'UNLOCKED', revision: 3 });
  const hit = ops.lookup('op-dup-1');
  return first === true && second === false && hit && hit.revision === 2;
})());
t('F5 注入·并发重放：5 路并发同一 operationId 只有一路能存入，其余命中旧结果', (() => {
  const ops = S.createOperationStore({ now: () => NOW });
  const results = [];
  for (let i = 0; i < 5; i++) {
    const seen = ops.lookup('op-race-1');
    if (seen) { results.push({ replayed: true, result: seen }); continue; }
    const stored = ops.store('op-race-1', { ok: true, n: i });
    results.push({ replayed: false, stored });
  }
  const storedCount = results.filter((r) => r.stored === true).length;
  const replayCount = results.filter((r) => r.replayed === true).length;
  return storedCount === 1 && replayCount === 4;
})());
t('F6 注入·操作存储 24h 过期后可重新提交', (() => {
  let tnow = NOW;
  const ops = S.createOperationStore({ now: () => tnow });
  ops.store('op-old', { ok: true });
  tnow += 24 * 60 * 60 * 1000 + 1;
  return ops.lookup('op-old') === null;
})());

// ---------- G. 记录存储 ----------
t('G1 内存存储 upsert/get/all', (() => {
  const st = S.createLockRecordStore({});
  const rec = lockedRecord();
  st.upsert(rec);
  return st.get(DEV) && st.get(DEV).lock_id === rec.lock_id && st.all().length === 1 && st.size() === 1;
})());
t('G2 文件持久化：写盘后新实例可读回', (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockrec-'));
  const fp = path.join(dir, 'lock-records.json');
  const rec = lockedRecord();
  const st1 = S.createLockRecordStore({ filePath: fp });
  st1.upsert(rec);
  const st2 = S.createLockRecordStore({ filePath: fp });
  const n = st2.load();
  const back = st2.get(DEV);
  fs.rmSync(dir, { recursive: true, force: true });
  return n === 1 && back && back.actual_state === 'LOCKED' && back.lock_id === rec.lock_id;
})());
t('G3 损坏的记录文件不抛错、load 返回 0、不删文件', (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockrec-'));
  const fp = path.join(dir, 'lock-records.json');
  fs.writeFileSync(fp, '{bad json', 'utf8');
  let threw = false, n = -1;
  try { n = S.createLockRecordStore({ filePath: fp }).load(); } catch (e) { threw = true; }
  const stillThere = fs.existsSync(fp);
  fs.rmSync(dir, { recursive: true, force: true });
  return threw === false && n === 0 && stillThere === true;
})());

// ---------- H. D39ABOL 旧状态夹具（阶段 1 证据转述，非本轮真机） ----------
// 服务端记录：2026-11-18T17:11:58.053Z arm 成功，此后零次 disarm 成功（阶段 1 报告 §2，实跑摘录）。
// 设备端当前不可达（阶段 1 报告 §3，两次桥会话失败，实跑）。
t('H1 D39ABOL：设备不可达 → UNKNOWN，不得定论未锁定', (() => {
  const rec = lockedRecord();
  const r = S.reconcileRecord(rec, null, { now: NOW });
  return r.record.actual_state === 'UNKNOWN';
})());
t('H2 D39ABOL：弱证据修正到 UNLOCKED 被拒（不许无证明清锁）', (() => {
  const rec = S.reconcileRecord(lockedRecord(), null, { now: NOW }).record; // UNKNOWN
  const r = S.applyCorrection(rec, { op_id: 'op-d39-1', by: '718983610', to_state: 'UNLOCKED', reason: 'desktop-looks-fine', evidence: 'weak', now: NOW });
  return r.ok === false && r.reason === 'evidence-insufficient';
})());
t('H3 D39ABOL：修正须带操作编号＋理由，缺一拒绝', (() => {
  const rec = lockedRecord();
  return S.applyCorrection(rec, { to_state: 'UNLOCKED', reason: 'x', evidence: 'strong' }).ok === false
    && S.applyCorrection(rec, { op_id: 'op-d39-2', to_state: 'UNLOCKED', evidence: 'strong' }).ok === false;
})());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
