'use strict';
/*
 * QFRemote 隐私锁 v2 · 设备端状态机（B 线）
 * ================================================================
 * 定夺依据：~/workspace/qfremote/gpt-a16s2-lockbug-ruling-20261119.md §4.2
 * 状态一字不改采用定夺定义，禁止用 locked=true/false 单布尔代表锁状态。
 *
 *   UNLOCKED           已验证未锁定
 *   LOCKING            正在建立保护
 *   LOCKED             设备确认保护生效
 *   UNLOCKING          正在解除保护
 *   UNKNOWN            设备状态不可确认
 *   RECOVERY_REQUIRED  状态冲突／故障恢复中
 * 另记 degradation（DEGRADED／FAILSAFE 原因）：保护能力降级的设备
 * 绝不能当作正常 LOCKED 上报；degradation 非空时控制台必须显示降级。
 *
 * 记录字段（定夺 §4.2 全量）：lock_id、device_id、boot_id、session_id、
 * 用户 SID、revision、desired_state、actual_state、last_heartbeat、last_error。
 *
 * 事务纪律（定夺 §3 约束 2）：状态写入 = 写临时文件 + fsync + 原子重命名
 * + 追加 journal；revision 只在提交成功后递增；旧 revision 的响应一律拒收。
 * 请求送达 ≠ 锁成功：只有会话内隐私显示组件的确认（ACK）才能把
 * LOCKING 推成 LOCKED，进程已启动本身不算成功。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATES = Object.freeze([
  'UNLOCKED', 'LOCKING', 'LOCKED', 'UNLOCKING', 'UNKNOWN', 'RECOVERY_REQUIRED'
]);

// 合法转移表。任何表外转移一律拒绝并记入 last_error，不静默改写状态。
const TRANSITIONS = Object.freeze({
  UNLOCKED: ['LOCKING', 'UNKNOWN'],
  LOCKING: ['LOCKED', 'UNLOCKED', 'UNKNOWN', 'RECOVERY_REQUIRED'],
  LOCKED: ['UNLOCKING', 'UNKNOWN', 'RECOVERY_REQUIRED'],
  UNLOCKING: ['UNLOCKED', 'UNKNOWN', 'RECOVERY_REQUIRED'],
  UNKNOWN: ['UNLOCKED', 'LOCKED', 'LOCKING', 'RECOVERY_REQUIRED'],
  RECOVERY_REQUIRED: ['UNLOCKED', 'LOCKED', 'UNKNOWN', 'LOCKING']
});

function newLockId() {
  return 'lock-' + crypto.randomBytes(8).toString('hex');
}

function nowIso() { return new Date().toISOString(); }

class LockStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LockStateError';
    this.code = code || 'INVALID_TRANSITION';
  }
}

class LockStateMachine {
  constructor(opts) {
    const o = opts || {};
    this.deviceId = o.deviceId || '';
    this.bootId = o.bootId || '';
    this.sessionId = o.sessionId != null ? o.sessionId : null;
    this.userSid = o.userSid || '';
    this.lockId = o.lockId || null;
    this.revision = o.revision || 0;
    this.desiredState = o.desiredState || 'UNLOCKED';
    this.actualState = o.actualState || 'UNLOCKED';
    this.lastHeartbeat = o.lastHeartbeat || null;
    this.lastError = o.lastError || null;
    // degradation: null | { kind: 'DEGRADED'|'FAILSAFE', reason, at }
    this.degradation = o.degradation || null;
    this.history = Array.isArray(o.history) ? o.history : [];
    // armedAt：最近一次进入 LOCKED 的 ISO 时间；离开 LOCKED 即清空。
    // 供 status.json 的 armedAt 与 unlock-ok/arm 时间比较用（P3-04 #4）。
    this.armedAt = o.armedAt || null;
  }

  snapshot() {
    return {
      lock_id: this.lockId,
      device_id: this.deviceId,
      boot_id: this.bootId,
      session_id: this.sessionId,
      user_sid: this.userSid,
      sid: this.userSid, // P3-04 #6：status.json 的 sid 与 user_sid 同值（Windows 用户 SID）
      armed_at: this.armedAt,
      revision: this.revision,
      desired_state: this.desiredState,
      actual_state: this.actualState,
      last_heartbeat: this.lastHeartbeat,
      last_error: this.lastError,
      degradation: this.degradation
    };
  }

  // 收到会话组件的 ACK 才能确认状态。revision 必须严格大于当前值，
  // 否则是旧响应重放，直接拒收（不改状态、不升 revision）。
  applyAck(ack) {
    if (!ack || typeof ack !== 'object') throw new LockStateError('ACK 为空', 'BAD_ACK');
    if (ack.lock_id !== this.lockId) {
      throw new LockStateError('ACK lock_id 与当前操作不符', 'ACK_LOCK_MISMATCH');
    }
    if (typeof ack.revision !== 'number' || ack.revision <= this.revision) {
      throw new LockStateError('ACK revision 过期（疑似重放）', 'ACK_STALE_REVISION');
    }
    const target = ack.actual_state;
    if (!STATES.includes(target)) throw new LockStateError('ACK 状态非法', 'BAD_ACK');
    return this.transition(target, { revision: ack.revision, reason: ack.note || 'ack' });
  }

  transition(target, opts) {
    const o = opts || {};
    const from = this.actualState;
    if (!STATES.includes(target)) throw new LockStateError('目标状态非法: ' + target, 'BAD_STATE');
    if (from === target && !o.force) {
      // 同态转移不产生新 revision（幂等重放不算一次新状态）。
      return { changed: false, snapshot: this.snapshot() };
    }
    if (!(TRANSITIONS[from] || []).includes(target)) {
      const err = '非法状态转移 ' + from + ' -> ' + target;
      this.lastError = { code: 'INVALID_TRANSITION', message: err, at: nowIso() };
      throw new LockStateError(err, 'INVALID_TRANSITION');
    }
    this.actualState = target;
    this.revision = (typeof o.revision === 'number') ? o.revision : this.revision + 1;
    if (target === 'LOCKED') this.armedAt = nowIso();
    if (target === 'UNLOCKED') this.armedAt = null;
    if (o.degradation !== undefined) this.degradation = o.degradation;
    if (target === 'UNLOCKED') this.degradation = null;
    if (o.error) this.lastError = o.error;
    if (o.heartbeat) this.lastHeartbeat = o.heartbeat;
    this.history.push({ from, to: target, revision: this.revision, at: nowIso(), reason: o.reason || '' });
    if (this.history.length > 200) this.history = this.history.slice(-200);
    return { changed: true, snapshot: this.snapshot() };
  }

  // 欲求状态只能由服务端意图设置，设备端 actual_state 不跟随它自动变。
  setDesired(desired, lockId) {
    if (!STATES.includes(desired)) throw new LockStateError('desired 非法', 'BAD_STATE');
    this.desiredState = desired;
    if (lockId) this.lockId = lockId;
    return this.snapshot();
  }

  markHeartbeat(at) {
    this.lastHeartbeat = at || nowIso();
    return this.lastHeartbeat;
  }

  markDegraded(kind, reason) {
    if (kind !== 'DEGRADED' && kind !== 'FAILSAFE') {
      throw new LockStateError('degradation 种类非法', 'BAD_DEGRADATION');
    }
    this.degradation = { kind, reason: String(reason || ''), at: nowIso() };
    return this.degradation;
  }

  clearDegradation() { this.degradation = null; return null; }

  // 对外上报口径：LOCKED + degradation 非空时，effective_state 必须报
  // DEGRADED/FAILSAFE，绝不只报 LOCKED 蒙混。
  effectiveState() {
    if (this.actualState === 'LOCKED' && this.degradation) return this.degradation.kind;
    return this.actualState;
  }

  isProtected() {
    // 只有设备确认的 LOCKED 且无降级，才算真正受保护。
    return this.actualState === 'LOCKED' && !this.degradation;
  }
}

/*
 * 事务持久化：state.json + state.journal（追加写）。
 * 写：tmp 文件 → fsync → rename（原子替换）→ journal 追加一行。
 * 读：state.json 损坏时不猜、不自动清零，返回 { ok:false, corrupt:true }，
 * 由协调层进入 UNKNOWN/RECOVERY_REQUIRED，绝不把损坏当成 UNLOCKED。
 */
class LockStateStore {
  constructor(dir) {
    this.dir = dir;
    this.stateFile = path.join(dir, 'lock-state.json');
    this.journalFile = path.join(dir, 'lock-state.journal');
  }

  ensureDir() { fs.mkdirSync(this.dir, { recursive: true }); }

  save(machine) {
    this.ensureDir();
    const snap = machine.snapshot();
    snap.history = machine.history;
    const tmp = this.stateFile + '.tmp-' + process.pid;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(snap, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.stateFile);
    try {
      const jfd = fs.openSync(this.journalFile, 'a');
      try {
        fs.writeSync(jfd, JSON.stringify({ at: nowIso(), revision: snap.revision, actual_state: snap.actual_state, desired_state: snap.desired_state, lock_id: snap.lock_id }) + '\n');
        fs.fsyncSync(jfd);
      } finally { fs.closeSync(jfd); }
    } catch (e) { /* journal 写失败不推翻已提交的状态，但要让调用方知道 */ throw new LockStateError('journal 追加失败: ' + e.message, 'JOURNAL_WRITE_FAILED'); }
    return snap;
  }

  load() {
    if (!fs.existsSync(this.stateFile)) return { ok: true, exists: false, machine: null };
    let raw;
    try { raw = fs.readFileSync(this.stateFile, 'utf8'); } catch (e) {
      return { ok: false, corrupt: true, error: '状态文件不可读: ' + e.message };
    }
    let data;
    try { data = JSON.parse(raw); } catch (e) {
      return { ok: false, corrupt: true, error: '状态文件 JSON 损坏: ' + e.message };
    }
    if (!data || !STATES.includes(data.actual_state) || typeof data.revision !== 'number') {
      return { ok: false, corrupt: true, error: '状态文件字段非法' };
    }
    const m = new LockStateMachine({
      deviceId: data.device_id, bootId: data.boot_id, sessionId: data.session_id,
      userSid: data.user_sid, lockId: data.lock_id, revision: data.revision,
      desiredState: data.desired_state, actualState: data.actual_state,
      lastHeartbeat: data.last_heartbeat, lastError: data.last_error,
      degradation: data.degradation, history: data.history, armedAt: data.armed_at
    });
    return { ok: true, exists: true, machine: m };
  }
}

module.exports = {
  STATES, TRANSITIONS, LockStateError, LockStateMachine, LockStateStore, newLockId
};
