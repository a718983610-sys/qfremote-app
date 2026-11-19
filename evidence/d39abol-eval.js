'use strict';
/*
 * C 线 · D39ABOL 旧状态对账评估（沙箱实跑，只读阶段 1 保全的原始记录）
 * 输入：../lockfix-phase1/evidence/lock-records-20261119.jsonl（298 行，
 *   SHA 982b78274e390555f6d255fd215716f2310fe5def49d15b3d44b59da4b177db1，见阶段 1 报告 §2）
 * 做法：数出 arm/disarm 成功行 → 按最后一次 arm 建服务端记录 → 设备不可达
 *   （status=null，阶段 1 两次桥会话失败）做一次对账 → 尝试弱证据修正到 UNLOCKED。
 * 输出：evidence/d39abol-eval-20261119.json。结论写入 REPORT.md，不改任何生产状态。
 */
const fs = require('fs');
const path = require('path');
const S = require('../server/friends/lock-state');

const RECORDS = path.resolve(__dirname, '..', '..', '..', 'lockfix-phase1', 'evidence', 'lock-records-20261119.jsonl');
const OUT = path.resolve(__dirname, 'd39abol-eval-20261119.json');

const lines = fs.readFileSync(RECORDS, 'utf8').split('\n').filter(Boolean);
const parsed = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const isArm = (r) => /arm 成功/.test(r.msg || '') && !/disarm 成功/.test(r.msg || ''); // “disarm 成功”含 “arm 成功”子串，须排除
const isDisarm = (r) => /disarm 成功/.test(r.msg || '');
const armOk = parsed.filter(isArm);
const disarmOk = parsed.filter(isDisarm);
const lastArm = armOk[armOk.length - 1];

const record = S.createLockRecord({
  device_id: 'node//8tVIMXjJh50uyBWFCvfJzyEWfc7PFcmYgL1wMmMf3xiv2cFYhjnn@7WnygBlCSp7',
  boot_id: null, session_id: null, sid: null,
  desired_state: 'LOCKED', actual_state: 'LOCKED',
  created_at: Date.parse(lastArm.at),
  last_heartbeat: Date.parse(lastArm.at),
  now: Date.parse('2026-11-19T03:05:00+08:00'),
});
record.lock_id = 'lock-d39abol-20261118-arm';

// 步骤 1：设备不可达时对账（阶段 1 §3：两次桥会话 opening→idle 死亡）
const reconciled = S.reconcileRecord(record, null, { now: Date.parse('2026-11-19T03:05:00+08:00') });
// 步骤 2：弱证据修正到 UNLOCKED（桌面看起来恢复了，但无设备端证明）
const weakCorrection = S.applyCorrection(reconciled.record, {
  op_id: 'op-d39abol-eval-1', by: '718983610', to_state: 'UNLOCKED',
  reason: 'desktop-looks-restored-after-accident', evidence: 'weak',
  now: Date.parse('2026-11-19T03:05:00+08:00'),
});
// 步骤 3：设备报 Off 但无证明时对账（假设设备回线后只报 Off、无 disarm 事件）
const offNoProof = S.reconcileRecord(record, { state: 'Off', lastEvents: [] }, { now: Date.parse('2026-11-19T03:05:00+08:00') });

const out = {
  evaluated_at: '2026-11-19T03:05:00+08:00',
  source_file: 'lockfix-phase1/evidence/lock-records-20261119.jsonl',
  source_lines: lines.length,
  arm_success_total: armOk.length,
  disarm_success_total: disarmOk.length,
  arm_success_list: armOk.map((r) => r.at),
  disarm_success_list: disarmOk.map((r) => r.at),
  last_arm_at: lastArm.at,
  disarm_after_last_arm: disarmOk.filter((r) => Date.parse(r.at) > Date.parse(lastArm.at)).length,
  step1_unreachable_reconcile: { actual_state: reconciled.record.actual_state, decision: reconciled.decision, reason: reconciled.reason },
  step2_weak_correction_to_unlocked: { ok: weakCorrection.ok, reason: weakCorrection.reason || null },
  step3_off_without_proof_reconcile: { actual_state: offNoProof.record.actual_state, decision: offNoProof.decision, reason: offNoProof.reason },
  conclusion: '服务端仍持有过期 LOCKED；设备不可达时定为 UNKNOWN，弱证据修正被拒；'
    + '设备报 Off 无证明时定为 RECOVERY_REQUIRED。修正须等笔记本回线、设备端确认无活跃锁并给出强证据（disarm 事件或 boot 变化）后，带操作编号执行。',
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(out, null, 2));
