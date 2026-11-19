'use strict';
/*
 * 隐私锁 v2 状态机测试（B 线，沙箱实跑）：
 *  A. 合法/非法转移（表外转移拒绝并记 last_error）；
 *  B. ACK 验 lock_id＋单调 revision（旧 revision = 重放，拒收）；
 *  C. 事务持久化往返 + 状态文件损坏不猜、不清零；
 *  D. 降级上报口径：LOCKED + degradation 时 effective_state 不是 LOCKED。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LockStateMachine, LockStateStore, LockStateError, newLockId } = require('../lock-v2/lock-state');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr200/lock-v2-state-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

(async () => {
  // A
  const m = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1', sessionId: 1, userSid: 'S-1-5-21-test' });
  ok('A1_init_unlocked', m.actualState === 'UNLOCKED' && m.revision === 0);
  m.setDesired('LOCKED', 'lock-abc');
  m.transition('LOCKING', { reason: 'arm' });
  ok('A2_locking', m.actualState === 'LOCKING' && m.revision === 1 && m.lockId === 'lock-abc');
  let illegal = false;
  try { m.transition('UNLOCKING'); } catch (e) { illegal = e instanceof LockStateError && e.code === 'INVALID_TRANSITION'; }
  ok('A3_illegal_rejected', illegal && m.actualState === 'LOCKING', { lastError: m.lastError && m.lastError.code });
  m.transition('LOCKED', { reason: 'ack' });
  ok('A4_locked', m.actualState === 'LOCKED' && m.isProtected());
  // D（先做：LOCKED+降级时 effective 不是 LOCKED）
  m.markDegraded('DEGRADED', '熄屏调用未确认');
  ok('D1_degraded_not_locked', m.effectiveState() === 'DEGRADED' && m.isProtected() === false);
  m.clearDegradation();
  ok('D2_clear_restores', m.effectiveState() === 'LOCKED' && m.isProtected() === true);
  m.transition('UNLOCKING', { reason: 'disarm' });
  m.transition('UNLOCKED', { reason: 'ack' });
  ok('A5_unlock_cycle', m.actualState === 'UNLOCKED' && m.degradation === null);

  // B
  const m2 = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1' });
  const lid = newLockId();
  m2.setDesired('LOCKED', lid);
  m2.transition('LOCKING');
  let stale = false;
  try { m2.applyAck({ lock_id: lid, revision: m2.revision, actual_state: 'LOCKED' }); } catch (e) { stale = e.code === 'ACK_STALE_REVISION'; }
  ok('B1_stale_ack_rejected', stale && m2.actualState === 'LOCKING');
  let mismatch = false;
  try { m2.applyAck({ lock_id: 'lock-other', revision: 99, actual_state: 'LOCKED' }); } catch (e) { mismatch = e.code === 'ACK_LOCK_MISMATCH'; }
  ok('B2_wrong_lock_rejected', mismatch);
  const r = m2.applyAck({ lock_id: lid, revision: m2.revision + 1, actual_state: 'LOCKED', note: 'session ack' });
  ok('B3_ack_confirms', r.changed && m2.actualState === 'LOCKED');
  const r2 = m2.applyAck({ lock_id: lid, revision: m2.revision + 1, actual_state: 'LOCKED' });
  ok('B4_same_state_idempotent', r2.changed === false, { changed: r2.changed });

  // C
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-lockv2-state-'));
  const store = new LockStateStore(dir);
  store.save(m2);
  const loaded = store.load();
  ok('C1_roundtrip', loaded.ok && loaded.exists && loaded.machine.actualState === 'LOCKED' && loaded.machine.revision === m2.revision,
    { revision: loaded.machine && loaded.machine.revision });
  ok('C2_journal_appended', fs.existsSync(path.join(dir, 'lock-state.journal')) &&
    fs.readFileSync(path.join(dir, 'lock-state.journal'), 'utf8').includes('"actual_state":"LOCKED"'));
  fs.writeFileSync(path.join(dir, 'lock-state.json'), '{ broken json');
  const bad = store.load();
  ok('C3_corrupt_not_unlocked', bad.ok === false && bad.corrupt === true, { error: bad.error });

  // E（P3-05 F-1：契约 §1 并集表，B 线补 3 条边；RECOVERY_REQUIRED→UNLOCKING 不纳入）
  const mE1 = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1', actualState: 'UNLOCKED' });
  mE1.transition('RECOVERY_REQUIRED', { reason: 'probe' });
  ok('E1_unlocked_to_recovery', mE1.actualState === 'RECOVERY_REQUIRED');
  const mE2 = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1', actualState: 'UNLOCKING' });
  mE2.transition('LOCKED', { reason: 'probe' });
  ok('E2_unlocking_to_locked', mE2.actualState === 'LOCKED');
  const mE3 = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1', actualState: 'UNKNOWN' });
  mE3.transition('UNLOCKING', { reason: 'probe' });
  ok('E3_unknown_to_unlocking', mE3.actualState === 'UNLOCKING');
  let e4 = false;
  const mE4 = new LockStateMachine({ deviceId: 'dev-1', bootId: 'boot-1', actualState: 'RECOVERY_REQUIRED' });
  try { mE4.transition('UNLOCKING', { reason: 'probe' }); } catch (err) { e4 = err instanceof LockStateError && err.code === 'INVALID_TRANSITION'; }
  ok('E4_recovery_to_unlocking_still_illegal', e4 && mE4.actualState === 'RECOVERY_REQUIRED');

  result.pass = Object.values(result.cases).every((c) => c.pass);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('lock-v2-state: ' + (result.pass ? 'PASS' : 'FAIL') + ' ' + Object.keys(result.cases).length + ' cases');
  process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
