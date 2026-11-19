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
const fs = require('fs');

// ---------- P3-01：锁修复暂停（LOCK_REMEDIATION_PAUSE，GPT 三项定夺 §1） ----------
// 暂停是写死在代码里的常量守卫，不是运行时开关：服务重启、进程重建、
// 配置重载都不能清除它；只有改代码＋重新部署＋协调人按统一受控流程
// （阶段 3 集成＋阶段 4 真机验收＋独立放行审核）放行才能解除。
// 覆盖：POST /lock/enable、POST /lock/update，以及任何经后台任务／重试
// 队列间接触发的等效锁组件更新（桥内 deliverEnvelope 对 arm/update
// 信封做第二道拦截；本仓库内无独立的锁更新后台任务／重试队列，见 REPORT）。
const LOCK_REMEDIATION_PAUSE = Object.freeze({
  code: 'lock-remediation-paused',
  enabled: true,
  scope: Object.freeze(['POST /lock/enable', 'POST /lock/update']),
});
function isLockRemediationPaused() { return LOCK_REMEDIATION_PAUSE.enabled === true; }

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
  RECOVERY_REQUIRED: ['UNLOCKED', 'LOCKED', 'UNKNOWN', 'LOCKING'],
});

// P3-05 F-2：v2 设备状态源。status 含合法六态 actual_state 时优先按它
// 分类；无 actual_state 的 v1 设备回落 v1 state 映射（见 classifyDeviceStatus）。
// 注意：actual_state 须为六态之一才采信，非法值回落 v1 映射、不猜。
function preferredActualState(status) {
  if (!status || typeof status !== 'object') return null;
  if (typeof status.actual_state === 'string' && STATES.indexOf(status.actual_state) >= 0) return status.actual_state;
  return null;
}
// P3-05 R-7：自称 v2 的设备判定。唯一可靠标志是 status 含 actual_state
//（v1 设备从不写该字段，v2 设备恒写，见契约 §3）。
// 契约 §6 另写“version 主版本 ≥ 2”亦算 v2——本实现不采用该判据，原因：
// ① 旧 Go 组件的 ComponentVersion 同为 2.x（update.go 目标版本如 "2.0.3"），
// 主版本 ≥ 2 无法区分 v1 Go 与 v2；② C 线自有 P3C 假设备 status.version
// 为应用版本 '2.4.5'，按字面判据会被误判 v2、缺 revision 即进恢复态，
// 直接破坏已验盘的 P3C 71 项。实际判定只看 actual_state 是否出现；
// 该口径偏差已记入 P3-05 REPORT（请协调人裁决契约 §6 文字是否修订）。
function isV2Status(status) {
  if (!status || typeof status !== 'object') return false;
  return status.actual_state != null;
}

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
  // P3-05 F-2（契约 §4）：v2 设备优先按 actual_state 分类；v1 设备（无
  // actual_state）回落 v1 state 映射。LOCKING／UNLOCKING／UNKNOWN 直接按
  // 设备自报返回（弱证据／无证据）；RECOVERY_REQUIRED 同 fault 态处理。
  // actual_state 只是设备自报，证据等级仍按事件定（LOCKED 强证据须 arm
  // 事件匹配，UNLOCKED 强证据须 disarm／重启证明），不只凭它宣布强证据。
  const v2Actual = preferredActualState(status);
  if (v2Actual === 'LOCKING' || v2Actual === 'UNLOCKING') {
    return { actual: v2Actual, evidence: 'weak', reason: 'device-report-' + v2Actual.toLowerCase() };
  }
  if (v2Actual === 'UNKNOWN') {
    return { actual: 'UNKNOWN', evidence: 'none', reason: 'device-report-unknown' };
  }
  if (v2Actual === 'RECOVERY_REQUIRED') {
    return { actual: 'RECOVERY_REQUIRED', evidence: 'strong', reason: 'device-report-recovery' };
  }
  const devState = v2Actual === 'LOCKED' ? 'Locked' : v2Actual === 'UNLOCKED' ? 'Off' : status.state;
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
      // P3-05 R-4（契约 §5）：无 fields 的旧事件也须过时间窗口校验
      //（ts ≥ 本次 created_at），不得无条件认作强证据——与 disarm 同口径。
      // 旧代码 `if (!ev.fields) return true;` 不论时间一律认，与其注释
      // “时间窗口是唯一判据”自相矛盾，现按注释收紧代码（注释同步改写）。
      if (!ev.fields) {
        const t = eventTime(ev);
        return !!t && record.created_at != null && Date.parse(t) >= record.created_at;
      }
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
// P3-05 R-9（契约 §9，#9 FAIL 的修复）：降级映射只在 LOCKED／LOCKING 下。
// actualState 须由调用方传入本次对账后的实际状态；UNLOCKED 空闲态不记降级
//（没有保护，就没有什么可降级），UNLOCKED 下的 failed-degraded 同样不记。
function degradedFromStatus(status, actualState) {
  if (!status || typeof status !== 'object') return null;
  if (actualState !== 'LOCKED' && actualState !== 'LOCKING') return null;
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
  // 降级标记与状态机迁移无关：统一在出口处按本次设备读取＋对账后实际状态刷新。
  // P3-05 R-6：身份字段（boot_id／session_id／sid）回填也在出口统一做——
  // 不只在 confirmed 分支，to-unlocked 两步路径等状态变化分支同样回填。
  if (status && typeof status === 'object' && res && res.record) {
    const next = Object.assign({}, res.record);
    if (next.boot_id == null && status.boot_id != null) next.boot_id = String(status.boot_id);
    if (next.session_id == null && status.session_id != null) next.session_id = String(status.session_id);
    if (next.sid == null && status.sid != null) next.sid = String(status.sid);
    next.degraded = degradedFromStatus(status, next.actual_state);
    res.record = next;
  }
  return res;
}

function reconcileRecordInner(record, status, opts) {
  const o = opts || {};
  const now = o.now != null ? o.now : Date.now();
  const applyDegraded = (r) => (status && typeof status === 'object'
    ? Object.assign({}, r, { degraded: degradedFromStatus(status, r.actual_state) }) : r);
  if (!record) {
    // 服务端无记录：以设备自报建一条只读基线（actual 以设备为准，desired 同步）。
    // P3-05 F-2：基线实际状态同样优先读 v2 actual_state，v1 回落 state 映射。
    const baseActual = preferredActualState(status) || mapLegacyState(status ? status.state : null);
    const base = createLockRecord({
      device_id: o.device_id || (status && status.deviceId) || '',
      boot_id: status ? status.boot_id : null,
      session_id: status ? status.session_id : null,
      sid: status ? status.sid : null,
      desired_state: baseActual,
      actual_state: baseActual,
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
  // P3-05 R-7（契约 §6）：自称 v2 的设备（status 含 actual_state）上报缺
  // revision 或 revision 非数字 → 异常，进 RECOVERY_REQUIRED
  //（revision-missing），不静默跳过；v1 设备（无 actual_state）仍跳过。
  // 判定口径见 isV2Status：不以 version 主版本 ≥ 2 认定 v2（旧 Go 组件版
  // 本号同为 2.x，无法区分；详见该函数注释与 P3-05 REPORT）。
  // 心跳已过期（>2 分钟）的上报不由本条改判：契约 §4 新鲜度优先于 revision
  // 合规检查，过期上报直接落入下方 classify 的 stale-heartbeat → UNKNOWN。
  const hbStale = status && typeof status.updatedAt === 'string' && status.updatedAt
    ? (!isNaN(Date.parse(status.updatedAt)) && (now - Date.parse(status.updatedAt)) > HEARTBEAT_FRESH_MS) : false;
  if (status && typeof status === 'object' && isV2Status(status) && typeof status.revision !== 'number' && !hbStale) {
    if (record.actual_state === 'RECOVERY_REQUIRED') {
      const next = Object.assign({}, record, { last_error: 'revision-missing', updated_at: now });
      return { record: next, changed: false, decision: 'still-recovery', reason: 'revision-missing', evidence: 'none' };
    }
    const r = transition(record, 'RECOVERY_REQUIRED', {
      now, op_id: o.op_id || null, by: o.by || null, action: 'reconcile:revision-missing', reason: 'revision-missing',
    });
    if (!r.ok) return { record, changed: false, decision: 'illegal-transition', reason: r.reason, evidence: 'none' };
    return { record: r.record, changed: true, decision: 'to-recovery', reason: 'revision-missing', evidence: 'none' };
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
  // P3-05 R-6：身份回填已移到 reconcileRecord 出口统一做，此处不再单做。
    const next = Object.assign({}, record, { last_heartbeat: heartbeatOf(status, now), updated_at: now });
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
  // P3-03 修正：重放检查只认“修正”动作（action 以 'correction:' 开头）。
  // 旧检查认所有同 op_id 的审计条目，与 /lock/disable 的正常流程冲突：
  // disable 先以同一 operationId 记一条 'disarm:start' 迁移（LOCKED→UNLOCKING），
  // 成功后再以同一编号调 applyCorrection 落 UNLOCKED——旧检查会把前者
  // 误判为“修正已执行”而拒绝，导致记录永久卡在 UNLOCKING（阶段 3 实测）。
  // 修正动作只由 applyCorrection 产生，收紧后 D39ABOL 修正重放仍被拒绝。
  if (record.history.some((h) => h.op_id === c.op_id && typeof h.action === 'string' && h.action.indexOf('correction:') === 0)) {
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
// LOCK-SEC-P3-REPLAY（GPT opStore 定夺 §2.2，2026-11-19）：缓存记录须绑
// 定可信主体信封（binding），操作编号仅作识别、不作授权凭证；无信封的
// 旧记录一律不得直接返回原始成功结果（桥在重放前另行鉴权，见 lock-bridge
// authorizeReplay）。store 的第三参 binding 可选——旧调用（无 binding）
// 仍兼容，写出 legacy 条目。
function createOperationStore(opts) {
  const o = opts || {};
  const nowFn = typeof o.now === 'function' ? o.now : Date.now;
  const ttlMs = o.ttlMs != null ? o.ttlMs : 24 * 60 * 60 * 1000;
  const table = new Map(); // opId -> { result, at, binding }
  function prune() {
    const now = nowFn();
    for (const [k, v] of table) { if (now - v.at > ttlMs) table.delete(k); }
  }
  return {
    // 只返成功结果（兼容旧调用）。注意：直接返回 result 不等于授权重放——
    // 桥必须先经 lookupEntry 取完整条目并完成归属鉴权，才能向外返回。
    lookup(opId) {
      if (typeof opId !== 'string' || !opId) return null;
      prune();
      const e = table.get(opId);
      return e ? e.result : null;
    },
    // 返回完整条目 { result, at, binding }（binding 为 null 即 legacy 旧记录）。
    lookupEntry(opId) {
      if (typeof opId !== 'string' || !opId) return null;
      prune();
      const e = table.get(opId);
      return e || null;
    },
    // binding（可选）：{ account_id, device_id, lock_id, operation_type,
    //   request_fingerprint, revision, completed_at }——身份字段须来自受信任
    //   的服务端认证和已验证请求（桥的 replayBinding 构造），不得取自客户端原文。
    store(opId, result, binding) {
      if (typeof opId !== 'string' || !opId) return false;
      if (table.has(opId)) return false;
      table.set(opId, {
        result, at: nowFn(),
        binding: binding && typeof binding === 'object' ? binding : null,
      });
      return true;
    },
    size() { prune(); return table.size; },
  };
}

// LOCK-SEC-P3-REPLAY：disable 重放请求的确定性身份指纹。只含操作类型＋
// 设备＋锁实例（不含 revision——重放请求带的是冻结旧 revision；不含登录
// 密码 presence——重试可能省略密码）。同一编号＋同一指纹才是同一操作；
// 指纹不同即不同操作，须拒绝冲突（409 operation-conflict）。
function fingerprintDisableRequest(input) {
  const deviceId = String((input && input.deviceId) || '');
  const lockId = (input && input.lockId != null) ? String(input.lockId) : '';
  return 'disarm|' + deviceId + '|' + lockId;
}

// ---------- 短期操作挑战 ----------
// issue({account, deviceId, op, lockId?, revision?, operationId?, sessionKey?})
//   → {challenge, expiresAt}；
// verify({challenge, account, deviceId, op, lockId?, revision?, operationId?, sessionKey?})
//   → {ok, binding} / {ok:false, reason}。
// 单次有效（验过即消费）、5 分钟过期；绑定账号＋设备＋操作＋锁实例＋
// 状态版本＋操作编号＋已认证会话（P3-03，GPT 三项定夺 §3.3）：
// 挑战不得跨账号／跨设备／跨锁实例／跨 revision／跨操作／跨会话复用。
// 可选绑定字段的语义：调用方传了才校验（旧调用方不传即不校验，保持兼容）；
// 调用方传了、签发时也绑了，两边不一致即拒绝，且绑定失败不消费挑战
// （原挑战仍可用，见阶段 2 单测 E7）；revision 不一致单独报
// 'challenge-revision-mismatch'，供桥映射为 revision-stale（前端刷新快照）。
// 锁实例绑定：lockId 为 null 表示签发时服务端尚无锁记录（基线未建）；
// 签发后记录新建／lock_id 变化，旧挑战即失效，须重新取挑战。
// 会话绑定：sessionKey 由桥按请求 Cookie 指纹计算（只存哈希，不存原文）；
// 退出登录／重新登录／会话撤销后 sessionKey 变化，旧挑战即失效。
// 撤销：revokeForAccount / revokeForSession 供 purgeUser（封禁联动／退出
// 登录）调用，未使用挑战立即失效。日志绝不记挑战值。
function createChallengeStore(opts) {
  const o = opts || {};
  const nowFn = typeof o.now === 'function' ? o.now : Date.now;
  const ttlMs = o.ttlMs != null ? o.ttlMs : 5 * 60 * 1000;
  const random = typeof o.randomBytes === 'function' ? o.randomBytes : (n) => crypto.randomBytes(n);
  const table = new Map(); // challenge -> { account, deviceId, op, lockId, lockIdBound, revision, revisionBound, operationId, operationIdBound, sessionKey, sessionKeyBound, expiresAt }
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
      table.set(challenge, {
        account: String(i.account).toLowerCase(),
        deviceId: String(i.deviceId),
        op: String(i.op),
        lockId: i.lockId === undefined ? null : (i.lockId === null ? null : String(i.lockId)),
        lockIdBound: i.lockId !== undefined,
        revision: typeof i.revision === 'number' ? i.revision : null,
        revisionBound: typeof i.revision === 'number',
        operationId: typeof i.operationId === 'string' && i.operationId ? i.operationId : null,
        operationIdBound: typeof i.operationId === 'string' && !!i.operationId,
        sessionKey: typeof i.sessionKey === 'string' && i.sessionKey ? i.sessionKey : null,
        sessionKeyBound: typeof i.sessionKey === 'string' && !!i.sessionKey,
        expiresAt,
      });
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
      if (rec.sessionKeyBound && i.sessionKey !== rec.sessionKey) {
        return { ok: false, reason: 'challenge-binding-mismatch' };
      }
      if (rec.operationIdBound && i.operationId !== rec.operationId) {
        return { ok: false, reason: 'challenge-binding-mismatch' };
      }
      if (rec.lockIdBound) {
        const gotLockId = i.lockId === undefined ? null : (i.lockId === null ? null : String(i.lockId));
        if (gotLockId !== rec.lockId) return { ok: false, reason: 'challenge-binding-mismatch' };
      }
      if (rec.revisionBound) {
        if (typeof i.revision !== 'number') return { ok: false, reason: 'challenge-binding-mismatch' };
        if (i.revision !== rec.revision) return { ok: false, reason: 'challenge-revision-mismatch' };
      }
      table.delete(i.challenge); // 单次有效：验过即消费，重放同一挑战无效
      return {
        ok: true,
        binding: { lockId: rec.lockId, revision: rec.revision, operationId: rec.operationId, sessionKey: rec.sessionKey },
      };
    },
    revokeForAccount(account) {
      const a = String(account || '').toLowerCase();
      let n = 0;
      for (const [k, v] of table) { if (v.account === a) { table.delete(k); n++; } }
      return n;
    },
    revokeForSession(sessionKey) {
      let n = 0;
      for (const [k, v] of table) { if (v.sessionKeyBound && v.sessionKey === sessionKey) { table.delete(k); n++; } }
      return n;
    },
    size() { prune(); return table.size; },
  };
}

// ---------- P3-03：解锁风险分级（GPT 三项定夺 §3.2／§3.3） ----------
// classifyUnlockRisk({record, enhancedProtection, sessionTrustLow})
//   → {level: 'normal'|'enhanced'|'high', reasons[], requiresStepUp}。
//   - normal：已登录、权限有效、风险正常的设备所有者——服务端权限校验＋
//     挑战＋revision＋明确确认即可，无需每次重新输密码。
//   - enhanced：用户自行开启增强保护——在原有校验上增加登录密码升级认证。
//   - high：身份异常／权限变化／状态冲突／高风险远程解锁——必须升级认证
//     或进入受控恢复流程，绝不降级为普通确认。当前可判定的 high 信号：
//     服务端锁记录为 UNKNOWN 或 RECOVERY_REQUIRED（状态未核实，重新认证
//     只证明操作者身份，不证明设备实际锁状态，故不许经正常路径直接清状态）。
//   - sessionTrustLow：调用方提供的会话可信度信号（桥当前鉴权层只返回账号名、
//     无独立会话可信度评分，故桥内恒传 false；会话被盗用的实际防护由挑战的
//     sessionKey 绑定＋purgeUser 吊销承担，见 CONTRACT §11 残留说明）。
function classifyUnlockRisk(input) {
  const i = input || {};
  const rec = i.record || null;
  const reasons = [];
  let level = 'normal';
  if (rec && (rec.actual_state === 'UNKNOWN' || rec.actual_state === 'RECOVERY_REQUIRED')) {
    level = 'high';
    reasons.push(rec.actual_state === 'UNKNOWN' ? 'record-unknown' : 'record-recovery-required');
  }
  if (i.sessionTrustLow) {
    reasons.push('session-trust-low');
    level = 'high';
  }
  if (i.enhancedProtection) {
    reasons.push('enhanced-protection-opt-in');
    if (level === 'normal') level = 'enhanced';
  }
  return { level, reasons, requiresStepUp: level !== 'normal' };
}

// ---------- P3-03：增强保护选项（用户自选，运维文件登记） ----------
// 文件 /opt/qfremote-lock/enhanced-auth.json（运维维护，与 owner-alias.json
// 同款口径）：{"accounts": ["<账号>", ...]}，缺失＝无人开启，损坏＝保留
// 上次好表＋记日志、不抛错；30 秒重载。开启后该账号每次远程解锁都须完成
// 登录密码升级认证（classifyUnlockRisk → enhanced）。控制台开关 UI 未做，
// 本线只落实服务端契约与文件登记口径（见 CONTRACT §11）。
function createEnhancedAuthStore(opts) {
  const o = opts || {};
  const filePath = o.filePath || '/opt/qfremote-lock/enhanced-auth.json';
  const readFile = o.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const statFile = o.statFile || ((p) => fs.statSync(p));
  const logFn = o.log || (() => {});
  const nowFn = typeof o.now === 'function' ? o.now : Date.now;
  const RELOAD_MS = 30000;
  let accounts = new Set();
  let mtimeMs = -1;
  let lastCheck = 0;
  function load(force) {
    const now = nowFn();
    if (!force && (now - lastCheck) < RELOAD_MS) return;
    lastCheck = now;
    let st;
    try { st = statFile(filePath); } catch (e) {
      if (mtimeMs !== -1) { accounts = new Set(); mtimeMs = -1; }
      return;
    }
    if (!force && mtimeMs === st.mtimeMs) return;
    try {
      const raw = JSON.parse(readFile(filePath));
      const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.accounts) ? raw.accounts : (raw && Array.isArray(raw.enhanced) ? raw.enhanced : null));
      if (!Array.isArray(list)) throw new Error('增强保护文件格式须为 {"accounts": [...]}');
      const next = new Set();
      for (const a of list) { if (typeof a === 'string' && a.trim()) next.add(a.trim().toLowerCase()); }
      accounts = next;
      mtimeMs = st.mtimeMs;
    } catch (e) {
      logFn('enhanced-auth-bad', '增强保护文件读取失败（保留上次好表继续服务）：' + (e && e.message));
    }
  }
  return {
    isEnhanced(account) {
      load(false);
      return typeof account === 'string' && !!account.trim() && accounts.has(account.trim().toLowerCase());
    },
    reload() { load(true); },
    size() { load(false); return accounts.size; },
  };
}

// ---------- P3-03：AI 代理解锁独立授权（GPT 三项定夺 §3.3） ----------
// 与网页用户界面权限分离的独立、受限、可撤销授权：单设备、仅 disarm、
// 默认 15 分钟内单次有效（TTL 可配但封顶 15 分钟），验过即消费，过期／
// 撤销／用过即失效。签发只认设备所有者本人（桥内经 getDeviceOrFail 机主
// 核对）。授权标识（grantId）是凭证：日志绝不记其原文，只记签发／使用／
// 撤销的设备与账号。注意：当前 HTTP 层没有调用方类型信号，服务端无法从
// 请求本身区分“用户本人”与“AI 代理”——硬性防线是挑战的 sessionKey 绑定
// （UI 会话签发的挑战换个会话即失效），授权机制是自动化调用方必须出示
// 的独立凭证＋审计；调用方类型识别残留见 CONTRACT §11。
function createAgentGrantStore(opts) {
  const o = opts || {};
  const nowFn = typeof o.now === 'function' ? o.now : Date.now;
  const defaultTtlMs = o.ttlMs != null ? o.ttlMs : 15 * 60 * 1000;
  const maxTtlMs = o.maxTtlMs != null ? o.maxTtlMs : 15 * 60 * 1000;
  const random = typeof o.randomBytes === 'function' ? o.randomBytes : (n) => crypto.randomBytes(n);
  const table = new Map(); // grantId -> { account, deviceId, op, expiresAt, by }
  function prune() {
    const now = nowFn();
    for (const [k, v] of table) { if (now >= v.expiresAt) table.delete(k); }
  }
  return {
    ttlMs: defaultTtlMs,
    issue(input) {
      const i = input || {};
      if (!i.account || !i.deviceId) return null;
      prune();
      const ttl = Math.min(Math.max(typeof i.ttlMs === 'number' ? i.ttlMs : defaultTtlMs, 60 * 1000), maxTtlMs);
      const grantId = 'ag-' + random(16).toString('hex');
      const expiresAt = nowFn() + ttl;
      table.set(grantId, {
        account: String(i.account).toLowerCase(),
        deviceId: String(i.deviceId),
        op: String(i.op || 'disarm'),
        expiresAt,
        by: i.by ? String(i.by) : null,
      });
      return { grantId, expiresAt };
    },
    verify(input) {
      const i = input || {};
      if (typeof i.grantId !== 'string' || !i.grantId) return { ok: false, reason: 'agent-grant-invalid' };
      const rec = table.get(i.grantId);
      if (!rec) { prune(); return { ok: false, reason: 'agent-grant-invalid' }; }
      if (nowFn() >= rec.expiresAt) { table.delete(i.grantId); return { ok: false, reason: 'agent-grant-expired' }; }
      if (rec.account !== String(i.account || '').toLowerCase() || rec.deviceId !== String(i.deviceId || '') || rec.op !== String(i.op || 'disarm')) {
        return { ok: false, reason: 'agent-grant-binding-mismatch' };
      }
      table.delete(i.grantId); // 单次有效：验过即消费
      return { ok: true };
    },
    revoke(grantId) {
      if (typeof grantId !== 'string' || !grantId) return false;
      return table.delete(grantId);
    },
    revokeForCaller(grantId, account) {
      if (typeof grantId !== 'string' || !grantId) return false;
      const rec = table.get(grantId);
      if (!rec || rec.account !== String(account || '').toLowerCase()) return false;
      table.delete(grantId);
      return true;
    },
    revokeForAccount(account) {
      const a = String(account || '').toLowerCase();
      let n = 0;
      for (const [k, v] of table) { if (v.account === a) { table.delete(k); n++; } }
      return n;
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
  LOCK_REMEDIATION_PAUSE, isLockRemediationPaused,
  mapLegacyState, newLockId, newOpId, wasLocked, preferredActualState, isV2Status,
  createLockRecord, transition, classifyDeviceStatus, reconcileRecord, applyCorrection, appendAudit,
  createOperationStore, createChallengeStore, createLockRecordStore,
  fingerprintDisableRequest,
  classifyUnlockRisk, createEnhancedAuthStore, createAgentGrantStore,
};
