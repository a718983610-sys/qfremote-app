'use strict';
/*
 * QFRemote 隐私锁 · 服务端锁状态机与对账（C 线，定夺 §4.2／§4.3／§4.4）
 * ================================================================
 * 契约正本：工作区根目录 CONTRACT.md。B 线设备端逐项对齐该契约；
 * 两边不一致时先对齐再继续，本模块是服务端侧的执行体。
 *
 * 铁则（定夺 §4.2，一字不改）：
 *   - 服务端只能提出锁定意图，不能自行宣布锁已成功；
 *   - 客户端也不能只因 QFLockUI 进程已启动就返回锁定成功；
 *   - 真正成功必须包括受保护会话、实际隐私保护以及要求的远程能力验证。
 *   - 单 locked=true/false 不再代表设备锁状态。
 *
 * 本模块全部是纯函数／内存存储，不碰网络、不读生产文件、不做真机判断：
 * 设备端 actual_state 永远以设备上报＋对账为准，沙箱单测只验服务端规则。
 * D39ABOL 旧状态修正走 applyCorrection（带操作编号、留审计），绝不删记录文件。
 */
const crypto = require('crypto');

// ---------- 状态 ----------
const STATES = Object.freeze(['UNLOCKED', 'LOCKING', 'LOCKED', 'UNLOCKING', 'UNKNOWN', 'RECOVERY_REQUIRED']);
// 降级原因（另记，不得把保护能力降级的设备当作正常 LOCKED）：
const DEGRADED_REASONS = Object.freeze(['DEGRADED', 'FAILSAFE']);

// 允许的状态迁移（RECOVERY_REQUIRED 只许经带证据的修正离开，见 applyCorrection）。
const TRANSITIONS = Object.freeze({
  UNLOCKED: ['LOCKING', 'UNKNOWN', 'RECOVERY_REQUIRED'],
  LOCKING: ['LOCKED', 'UNLOCKED', 'UNKNOWN', 'RECOVERY_REQUIRED'],
  LOCKED: ['UNLOCKING', 'UNKNOWN', 'RECOVERY_REQUIRED'],
  UNLOCKING: ['UNLOCKED', 'LOCKED', 'UNKNOWN', 'RECOVERY_REQUIRED'],
  UNKNOWN: ['UNLOCKED', 'LOCKING', 'LOCKED', 'UNLOCKING', 'RECOVERY_REQUIRED'],
  RECOVERY_REQUIRED: ['UNLOCKED', 'LOCKED', 'UNKNOWN'],
});

// 设备 status.json 的 state（组件侧）→ 服务端 actual_state 的直映射（仅状态名，不含证据判断）。
function mapLegacyState(deviceState) {
  if (deviceState === 'Locked') return 'LOCKED';
  if (deviceState === 'Off') return 'UNLOCKED';
  if (deviceState === 'Fault') return 'RECOVERY_REQUIRED';
  return 'UNKNOWN';
}

// 证据新鲜度：设备上报心跳超过该值即视为过期证据，不得据此清除 LOCKED。
const HEARTBEAT_FRESH_MS = 120000;

function newLockId() { return 'lock-' + crypto.randomBytes(8).toString('hex'); }
function newOpId() { return 'op-' + crypto.randomBytes(8).toString('hex'); }

// ---------- 锁记录 ----------
// 每次锁定记录至少含（定夺 §4.2）：lock_id、device_id、boot_id、session_id、
// 用户 SID、revision、desired_state、actual_state、last_heartbeat、last_error。
// 另附：created_at、updated_at、degraded（null 或 DEGRADED/FAILSAFE 原因）、
// history[]（恢复审计：每次迁移与修正都记一条，永不删除）。
function createLockRecord(fields) {
  const f = fields || {};
  const now = f.now != null ? f.now : Date.now();
  return {
    lock_id: f.lock_id || newLockId(),
    device_id: String(f.device_id || ''),
    boot_id: f.boot_id != null ? String(f.boot_id) : null,
    session_id: f.session_id != null ? String(f.session_id) : null,
    sid: f.sid != null ? String(f.sid) : null,
    revision: typeof f.revision === 'number' ? f.revision : 1,
    desired_state: f.desired_state || 'UNLOCKED',
    actual_state: f.actual_state || 'UNKNOWN',
    degraded: f.degraded || null,
    last_heartbeat: f.last_heartbeat != null ? f.last_heartbeat : null,
    last_error: f.last_error || null,
    created_at: f.created_at != null ? f.created_at : now,
    updated_at: f.updated_at != null ? f.updated_at : now,
    history: Array.isArray(f.history) ? f.history.slice() : [],
  };
}

function audit(record, entry) {
  const next = Object.assign({}, record);
  next.history = record.history.concat([Object.assign({
    at: Date.now(), op_id: null, by: null, action: '', from: record.actual_state, to: record.actual_state, reason: '',
  }, entry)]);
  next.updated_at = entry.at != null ? entry.at : Date.now();
  return next;
}

// 合法迁移检查；非法迁移不抛错，返回 {ok:false}，调用方据此进 RECOVERY_REQUIRED。
function transition(record, to, meta) {
  const m = meta || {};
  if (STATES.indexOf(to) < 0) return { ok: false, reason: 'unknown-state', from: record.actual_state, to };
  const allowed = TRANSITIONS[record.actual_state] || [];
  if (allowed.indexOf(to) < 0) {
    return { ok: false, reason: 'illegal-transition', from: record.actual_state, to };
  }
  const next = Object.assign({}, record, {
    actual_state: to,
    revision: record.revision + 1,
    last_error: m.reason ? String(m.reason) : record.last_error,
    degraded: Object.prototype.hasOwnProperty.call(m, 'degraded') ? m.degraded : record.degraded,
  });
  if (m.desired_state) next.desired_state = m.desired_state;
  if (m.last_heartbeat != null) next.last_heartbeat = m.last_heartbeat;
  const audited = audit(next, {
    at: m.now != null ? m.now : Date.now(), op_id: m.op_id || null, by: m.by || null,
    action: m.action || ('transition:' + record.actual_state + '->' + to),
    from: record.actual_state, to, reason: m.reason || '',
  });
  return { ok: true, record: audited, from: record.actual_state, to };
}

// 记录是否曾经处于 LOCKED（当前态或审计历史）：曾经锁定过的记录，
// 清除到 UNLOCKED 必须有强证据，哪怕中间因掉线先变过 UNKNOWN。
function wasLocked(record) {
  if (!record) return false;
  if (record.actual_state === 'LOCKED') return true;
  return Array.isArray(record.history) && record.history.some((h) => h && (h.to === 'LOCKED' || h.from === 'LOCKED'));
}

// 只追加一条审计并把 revision+1，不改变 actual_state（用于 remote-reset
// 这类“状态不变但须让进行中的确认重新校验”的操作）。
function appendAudit(record, entry) {
  const e = entry || {};
  const next = Object.assign({}, record, { revision: record.revision + 1 });
  return audit(next, {
    at: e.at != null ? e.at : Date.now(), op_id: e.op_id || null, by: e.by || null,
    action: e.action || 'audit', from: record.actual_state, to: record.actual_state, reason: e.reason || '',
  });
}
// 把一次设备 status 读取结果分类为服务端 actual_state 候选＋证据等级。
// status 为 null ＝读不到（超时／掉线／通道故障）→ UNKNOWN，永不判 UNLOCKED。
// evidence 等级：'strong'（可据此清除 LOCKED）／'weak'（仅供展示）／'none'。
// 新鲜度：本次读取本身就是新鲜证据（读路径只用 fresh 实读或 ≤15s 缓存），
// 不再拿记录里陈旧的 last_heartbeat 卡强证据。
// lastEvents 归一化：组件写 {ts,ev}，旧格式 {time,type}，两套键都认。
function eventName(ev) { return ev ? (ev.ev || ev.type) : undefined; }
function eventTime(ev) { return ev ? (ev.ts || ev.time) : undefined; }
function hasEvent(status, type, pred) {
  if (!status || !Array.isArray(status.lastEvents)) return false;
  return status.lastEvents.some((ev) => eventName(ev) === type && (!pred || pred(ev)));
}
function classifyDeviceStatus(status, record, nowMs) {
  void nowMs; // 保留入参位（调用方传读取时间）；新鲜度由“本次读取”本身保证，不另算
  if (!status || typeof status !== 'object') {
    return { actual: 'UNKNOWN', evidence: 'none', reason: 'device-unreachable' };
  }
  // 设备契约 §2：updatedAt 超 2 分钟未更新＝组件异常／离线，不得当作实时状态。
  const now = nowMs != null ? nowMs : Date.now();
  if (typeof status.updatedAt === 'string' && status.updatedAt) {
    const hb = Date.parse(status.updatedAt);
    if (!isNaN(hb) && (now - hb) > HEARTBEAT_FRESH_MS) {
      return { actual: 'UNKNOWN', evidence: 'none', reason: 'stale-heartbeat' };
    }
  }
  const devState = status.state;
  // 设备契约 §2：fault 字段出现（state-corrupt）即组件故障态；桥侧另有
  // state==='Fault' 的同义形态，两路都认。
  if (devState === 'Fault' || status.fault) {
    return { actual: 'RECOVERY_REQUIRED', evidence: 'strong', reason: 'device-fault' };
  }
  if (devState === 'Locked') {
    // 设备称已锁：有与本记录 lock_id 匹配的 arm 事件即强证据；无则仍信设备
    // 自报（设备是自身状态的权威），但标 weak——服务端不得据此宣布“验证通过”。
    const strong = record && record.lock_id
      ? hasEvent(status, 'arm', (ev) => ev.fields && ev.fields.armId === record.lock_id)
      : false;
    return { actual: 'LOCKED', evidence: strong ? 'strong' : 'weak', reason: strong ? 'arm-event-match' : 'device-report-locked' };
  }
  if (devState === 'Off') {
    // 设备称未锁：要清除服务端 LOCKED 必须有强证据，缺一不可——
    // ① 本次锁的 disarm 事件；或 ② boot_id 变化（重启后旧锁必然消失）。
    // 缺强证据且曾经锁定过 → RECOVERY_REQUIRED，不自动当作未锁定。
    if (!wasLocked(record)) {
      return { actual: 'UNLOCKED', evidence: 'weak', reason: 'device-report-off' };
    }
    const disarmProof = hasEvent(status, 'disarm', (ev) => {
      if (!ev.fields) return false;
      // disarm 事件须属于本次锁（带 lock_id/id 任一匹配）或时间在本次 arm 之后。
      // 注意：现版组件 disarm 事件字段只有 {by}（见设备契约 §6／engine.go），
      // 无 lockId——在 B 线补 fields.lockId 之前，时间窗口是唯一判据。
      if (ev.fields.lockId === record.lock_id || ev.fields.id === record.lock_id) return true;
      const t = eventTime(ev);
      return !!t && record.created_at != null && Date.parse(t) >= record.created_at;
    }) || hasEvent(status, 'unlock-ok', (ev) => {
      // 设备契约 §6：unlock-ok＝本地输密码解锁，与远程 disarm 同为真实解锁。
      if (!ev.fields) return true; // 本地解锁事件无归属字段，时间窗口是唯一判据
      if (ev.fields.lockId === record.lock_id || ev.fields.id === record.lock_id) return true;
      const t = eventTime(ev);
      return !!t && record.created_at != null && Date.parse(t) >= record.created_at;
    });
    const bootChanged = record.boot_id != null && status.boot_id != null
      && String(status.boot_id) !== String(record.boot_id);
    // status.json v1 尚无 boot_id 字段（待 B 线补）：先用 boot-recovered
    // 事件（设备契约 §6，重启后恢复）作重启证明，时间须在本次 arm 之后。
    const bootRecovered = hasEvent(status, 'boot-recovered', (ev) => {
      const t = eventTime(ev);
      return !!t && record.created_at != null && Date.parse(t) >= record.created_at;
    });
    if (disarmProof) {
      return { actual: 'UNLOCKED', evidence: 'strong', reason: 'disarm-event-match' };
    }
    if (bootChanged || bootRecovered) {
      return { actual: 'UNLOCKED', evidence: 'strong', reason: bootChanged ? 'boot-changed' : 'boot-recovered' };
    }
    return { actual: 'RECOVERY_REQUIRED', evidence: 'none', reason: 'off-without-proof' };
  }
  return { actual: 'UNKNOWN', evidence: 'none', reason: 'unknown-device-state' };
}

// ---------- 对账 ----------
// reconcileRecord(record, status, opts)：按定夺 §4.3 把一次设备读取结果并入记录。
//   - status null（超时／掉线）→ actual UNKNOWN（last_heartbeat 不动），永不改 UNLOCKED；
//   - 设备 Off 但无强证据 → RECOVERY_REQUIRED，不清除 LOCKED；
//   - 设备真实已解锁（强证据）→ UNLOCKED，revision+1，审计留痕；
//   - 状态冲突（revision 不符的设备上报）→ RECOVERY_REQUIRED。
// 返回 {record, changed, decision, reason, evidence}；decision 供桥写日志／回包。
// 设备契约 §2：captureExclusion=failed-degraded（防截取未完全生效）或
// unknown（保护状态未知）记降级；active / not-locked 清除降级标记。
function degradedFromStatus(status) {
  if (!status || typeof status !== 'object') return null;
  if (status.captureExclusion === 'failed-degraded' || status.captureExclusion === 'unknown') return 'DEGRADED';
  return null;
}
// 设备契约 §2：心跳以 status.updatedAt 为准（组件每 30 秒刷新）；无字段时用读取时间。
function heartbeatOf(status, now) {
  if (status && typeof status.updatedAt === 'string' && status.updatedAt) {
    const t = Date.parse(status.updatedAt);
    if (!isNaN(t)) return t;
  }
  return now;
}

function reconcileRecord(record, status, opts) {
  const res = reconcileRecordInner(record, status, opts);
  // 降级标记与状态机迁移无关：统一在出口处按本次设备读取刷新。
  if (status && typeof status === 'object' && res && res.record) {
    res.record = Object.assign({}, res.record, { degraded: degradedFromStatus(status) });
  }
  return res;
}

function reconcileRecordInner(record, status, opts) {
  const o = opts || {};
  const now = o.now != null ? o.now : Date.now();
  const applyDegraded = (r) => (status && typeof status === 'object'
    ? Object.assign({}, r, { degraded: degradedFromStatus(status) }) : r);
  if (!record) {
    // 服务端无记录：以设备自报建一条只读基线（actual 以设备为准，desired 同步）。
    const base = createLockRecord({
      device_id: o.device_id || (status && status.deviceId) || '',
      boot_id: status ? status.boot_id : null,
      session_id: status ? status.session_id : null,
      sid: status ? status.sid : null,
      desired_state: mapLegacyState(status ? status.state : null),
      actual_state: mapLegacyState(status ? status.state : null),
      last_heartbeat: status ? heartbeatOf(status, now) : null,
      now,
    });
    return { record: applyDegraded(base), changed: true, decision: 'baseline-from-device', reason: 'no-server-record', evidence: 'weak' };
  }
  // 设备上报带 revision 且与服务端不符 → 旧响应覆盖新状态的风险，进恢复态。
  if (status && typeof status.revision === 'number' && typeof record.revision === 'number'
    && status.revision < record.revision && status.state) {
    const r = transition(record, 'RECOVERY_REQUIRED', {
      now, op_id: o.op_id || null, by: o.by || null, action: 'reconcile:revision-conflict',
      reason: 'stale-device-revision:' + status.revision + '<' + record.revision,
    });
    if (!r.ok) return { record, changed: false, decision: 'illegal-transition', reason: r.reason, evidence: 'none' };
    return { record: r.record, changed: true, decision: 'revision-conflict', reason: r.reason, evidence: 'none' };
  }
  const c = classifyDeviceStatus(status, record, now);
  if (c.actual === 'UNKNOWN') {
    if (record.actual_state === 'UNKNOWN') {
      return { record, changed: false, decision: 'still-unknown', reason: c.reason, evidence: c.evidence };
    }
    const r = transition(record, 'UNKNOWN', {
      now, op_id: o.op_id || null, by: o.by || null, action: 'reconcile:unreachable', reason: c.reason,
    });
    if (!r.ok) return { record, changed: false, decision: 'illegal-transition', reason: r.reason, evidence: c.evidence };
    return { record: r.record, changed: true, decision: 'to-unknown', reason: c.reason, evidence: c.evidence };
  }
  if (c.actual === 'RECOVERY_REQUIRED') {
    if (record.actual_state === 'RECOVERY_REQUIRED') {
      const next = Object.assign({}, record, { last_error: c.reason, updated_at: now });
      return { record: next, changed: false, decision: 'still-recovery', reason: c.reason, evidence: c.evidence };
    }
    const r = transition(record, 'RECOVERY_REQUIRED', {
      now, op_id: o.op_id || null, by: o.by || null, action: 'reconcile:conflict', reason: c.reason,
    });
    if (!r.ok) return { record, changed: false, decision: 'illegal-transition', reason: r.reason, evidence: c.evidence };
    return { record: r.record, changed: true, decision: 'to-recovery', reason: c.reason, evidence: c.evidence };
  }
  // LOCKED / UNLOCKED：与当前 actual 一致即只刷新心跳；不一致按迁移表走。
  if (c.actual === record.actual_state) {
    const next = Object.assign({}, record, { last_heartbeat: heartbeatOf(status, now), updated_at: now });
    if (status && status.boot_id != null && next.boot_id == null) next.boot_id = String(status.boot_id);
    if (status && status.session_id != null && next.session_id == null) next.session_id = String(status.session_id);
    if (status && status.sid != null && next.sid == null) next.sid = String(status.sid);
    return { record: next, changed: false, decision: 'confirmed', reason: c.reason, evidence: c.evidence };
  }
  // 强证据的真实解锁（本地输密码解锁／重启后清锁）从 LOCKED 到 UNLOCKED
  // 不许直达：先记 UNLOCKING 再记 UNLOCKED，两步都进审计，迁移表不变。
  if (c.actual === 'UNLOCKED' && c.evidence === 'strong' && record.actual_state === 'LOCKED') {
    const step1 = transition(record, 'UNLOCKING', {
      now, op_id: o.op_id || null, by: o.by || null, action: 'reconcile:observed-unlocking',
      reason: c.reason, last_heartbeat: heartbeatOf(status, now),
    });
    if (!step1.ok) {
      const rr = transition(record, 'RECOVERY_REQUIRED', {
        now, op_id: o.op_id || null, by: o.by || null, action: 'reconcile:illegal-target', reason: 'illegal:' + record.actual_state + '->' + c.actual,
      });
      if (!rr.ok) return { record, changed: false, decision: 'illegal-transition', reason: step1.reason, evidence: c.evidence };
      return { record: rr.record, changed: true, decision: 'to-recovery', reason: 'illegal:' + record.actual_state + '->' + c.actual, evidence: c.evidence };
    }
    const step2 = transition(step1.record, 'UNLOCKED', {
      now, op_id: o.op_id || null, by: o.by || null, action: 'reconcile:unlocked',
      reason: c.reason, last_heartbeat: heartbeatOf(status, now),
    });
    if (!step2.ok) return { record: step1.record, changed: true, decision: 'to-unlocking', reason: c.reason, evidence: c.evidence };
    return { record: step2.record, changed: true, decision: 'to-unlocked', reason: c.reason, evidence: c.evidence };
  }
  const r = transition(record, c.actual, {
    now, op_id: o.op_id || null, by: o.by || null, action: 'reconcile:' + c.actual.toLowerCase(),
    reason: c.reason, last_heartbeat: heartbeatOf(status, now),
  });
  if (!r.ok) {
    // 迁移表不许（如 LOCKED→UNLOCKED 无中间态）→ 进恢复态，不静默改写。
    const rr = transition(record, 'RECOVERY_REQUIRED', {
      now, op_id: o.op_id || null, by: o.by || null, action: 'reconcile:illegal-target', reason: 'illegal:' + record.actual_state + '->' + c.actual,
    });
    if (!rr.ok) return { record, changed: false, decision: 'illegal-transition', reason: r.reason, evidence: c.evidence };
    return { record: rr.record, changed: true, decision: 'to-recovery', reason: 'illegal:' + record.actual_state + '->' + c.actual, evidence: c.evidence };
  }
  return { record: r.record, changed: true, decision: 'to-' + c.actual.toLowerCase(), reason: c.reason, evidence: c.evidence };
}

// ---------- 幂等对账修正 ----------
// applyCorrection(record, correction)：针对经验证的旧状态执行带操作编号的修正。
//   correction: {op_id(必填), by, to_state, reason(必填), evidence('strong' 必填，否则拒绝)}
//   - 保留原记录：原值进 history，不删记录、不删文件、不改 created_at；
//   - 只有 evidence==='strong' 才允许离开 LOCKED/RECOVERY_REQUIRED 去 UNLOCKED；
//   - 目标态须在迁移表内，否则拒绝并说明。
// 返回 {ok, record?, reason?}。
function applyCorrection(record, correction) {
  const c = correction || {};
  if (!record) return { ok: false, reason: 'no-record' };
  if (!c.op_id || typeof c.op_id !== 'string') return { ok: false, reason: 'op-id-required' };
  if (!c.reason || typeof c.reason !== 'string') return { ok: false, reason: 'reason-required' };
  if (STATES.indexOf(c.to_state) < 0) return { ok: false, reason: 'unknown-state' };
  if (record.history.some((h) => h.op_id === c.op_id)) {
    return { ok: false, reason: 'op-id-replayed', record };
  }
  const leavesLocked = c.to_state === 'UNLOCKED' && wasLocked(record);
  if (leavesLocked && c.evidence !== 'strong') {
    return { ok: false, reason: 'evidence-insufficient' };
  }
  // LOCKED→UNLOCKED 不许直达（迁移表）：强证据修正同样走两步，
  // LOCKED→UNLOCKING→UNLOCKED，两步共用同一操作编号、都进审计。
  if (record.actual_state === 'LOCKED' && c.to_state === 'UNLOCKED') {
    const step1 = transition(record, 'UNLOCKING', {
      now: c.now != null ? c.now : Date.now(), op_id: c.op_id, by: c.by || null,
      action: 'correction:unlocking', reason: c.reason, desired_state: 'UNLOCKED',
    });
    if (!step1.ok) return { ok: false, reason: step1.reason };
    const step2 = transition(step1.record, 'UNLOCKED', {
      now: c.now != null ? c.now : Date.now(), op_id: c.op_id, by: c.by || null,
      action: 'correction:unlocked', reason: c.reason, desired_state: 'UNLOCKED',
    });
    if (!step2.ok) return { ok: false, reason: step2.reason, record: step1.record };
    return { ok: true, record: step2.record };
  }
  const r = transition(record, c.to_state, {
    now: c.now != null ? c.now : Date.now(), op_id: c.op_id, by: c.by || null,
    action: 'correction:' + c.to_state.toLowerCase(), reason: c.reason,
    desired_state: c.to_state,
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, record: r.record };
}

// ---------- 操作编号幂等存储 ----------
// 成功结果才缓存：失败（超时／拒绝）不缓存，同一 operationId 可重试真操作；
// 缓存命中即直接返回旧结果，不产生第二次真实操作。
function createOperationStore(opts) {
  const o = opts || {};
  const nowFn = typeof o.now === 'function' ? o.now : Date.now;
  const ttlMs = o.ttlMs != null ? o.ttlMs : 24 * 60 * 60 * 1000;
  const table = new Map(); // opId -> { result, at }
  function prune() {
    const now = nowFn();
    for (const [k, v] of table) { if (now - v.at > ttlMs) table.delete(k); }
  }
  return {
    lookup(opId) {
      if (typeof opId !== 'string' || !opId) return null;
      prune();
      const e = table.get(opId);
      return e ? e.result : null;
    },
    store(opId, result) {
      if (typeof opId !== 'string' || !opId) return false;
      if (table.has(opId)) return false;
      table.set(opId, { result, at: nowFn() });
      return true;
    },
    size() { prune(); return table.size; },
  };
}

// ---------- 短期操作挑战 ----------
// issue({account, deviceId, op}) → {challenge, expiresAt}；
// verify({challenge, account, deviceId, op}) → {ok} / {ok:false, reason}。
// 单次有效（验过即消费）、5 分钟过期、绑定账号＋设备＋操作；不含任何密码与密钥。
function createChallengeStore(opts) {
  const o = opts || {};
  const nowFn = typeof o.now === 'function' ? o.now : Date.now;
  const ttlMs = o.ttlMs != null ? o.ttlMs : 5 * 60 * 1000;
  const random = typeof o.randomBytes === 'function' ? o.randomBytes : (n) => crypto.randomBytes(n);
  const table = new Map(); // challenge -> { account, deviceId, op, expiresAt }
  function prune() {
    const now = nowFn();
    for (const [k, v] of table) { if (now >= v.expiresAt) table.delete(k); }
  }
  return {
    ttlMs,
    issue(input) {
      const i = input || {};
      if (!i.account || !i.deviceId || !i.op) return null;
      prune();
      const challenge = 'ch-' + random(16).toString('hex');
      const expiresAt = nowFn() + ttlMs;
      table.set(challenge, { account: String(i.account).toLowerCase(), deviceId: String(i.deviceId), op: String(i.op), expiresAt });
      return { challenge, expiresAt };
    },
    verify(input) {
      const i = input || {};
      if (typeof i.challenge !== 'string' || !i.challenge) return { ok: false, reason: 'challenge-required' };
      const rec = table.get(i.challenge);
      if (!rec) { prune(); return { ok: false, reason: 'challenge-invalid' }; }
      if (nowFn() >= rec.expiresAt) { table.delete(i.challenge); return { ok: false, reason: 'challenge-expired' }; }
      if (rec.account !== String(i.account || '').toLowerCase() || rec.deviceId !== String(i.deviceId || '') || rec.op !== String(i.op || '')) {
        return { ok: false, reason: 'challenge-binding-mismatch' };
      }
      table.delete(i.challenge); // 单次有效：验过即消费，重放同一挑战无效
      return { ok: true };
    },
    size() { prune(); return table.size; },
  };
}

// ---------- 锁记录存储（内存＋可选文件持久化） ----------
// filePath 为空即纯内存（单测用）；有路径时每次变更后原子写盘（tmp＋rename），
// 写盘失败只记日志、永不抛错中断服务；文件缺失＝空表，损坏＝保留内存表＋记日志。
function createLockRecordStore(opts) {
  const o = opts || {};
  const nowFn = typeof o.now === 'function' ? o.now : Date.now;
  const logFn = typeof o.log === 'function' ? o.log : function () {};
  const filePath = o.filePath || null;
  const fsMod = o.fs || require('fs');
  const pathMod = o.path || require('path');
  const table = new Map(); // device_id -> record
  function save() {
    if (!filePath) return true;
    try {
      const data = JSON.stringify({ version: 1, records: Array.from(table.values()) }, null, 2);
      const tmp = filePath + '.tmp-' + process.pid;
      fsMod.writeFileSync(tmp, data, 'utf8');
      fsMod.renameSync(tmp, filePath);
      return true;
    } catch (e) {
      logFn('lock-records-save-failed', '锁记录持久化失败（内存表继续服务）：' + (e && e.message));
      return false;
    }
  }
  function load() {
    if (!filePath) return 0;
    let raw;
    try { raw = fsMod.readFileSync(filePath, 'utf8'); } catch (e) { return 0; }
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed.records) ? parsed.records : [];
      let n = 0;
      for (const r of list) {
        if (r && typeof r.device_id === 'string' && r.device_id) { table.set(r.device_id, r); n++; }
      }
      return n;
    } catch (e) {
      logFn('lock-records-load-failed', '锁记录文件损坏（保留内存空表继续服务，不删文件）：' + (e && e.message));
      return 0;
    }
  }
  return {
    load, save,
    get(deviceId) { return table.get(String(deviceId)) || null; },
    upsert(record) {
      if (!record || !record.device_id) return null;
      const next = Object.assign({}, record, { updated_at: nowFn() });
      table.set(String(record.device_id), next);
      save();
      return next;
    },
    all() { return Array.from(table.values()); },
    size() { return table.size; },
  };
}

module.exports = {
  STATES, DEGRADED_REASONS, TRANSITIONS, HEARTBEAT_FRESH_MS,
  mapLegacyState, newLockId, newOpId, wasLocked,
  createLockRecord, transition, classifyDeviceStatus, reconcileRecord, applyCorrection, appendAudit,
  createOperationStore, createChallengeStore, createLockRecordStore,
};
