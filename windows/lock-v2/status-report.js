'use strict';
/*
 * QFRemote 隐私锁 v2 · 设备端 status.json 上报器（B 线，阶段 3 P3-04）
 * ================================================================
 * 解决 C 线 CONTRACT §9 的 #3/#4/#5/#6/#7/#9（旧 Go 组件只读参考，
 * 绝不打补丁；以下全部是 v2 新组件的行为）：
 *
 *  #3 disarm 事件补 fields.lockId（与 arm 的 armId 对称）。
 *  #4 unlock-ok 事件 ts 为 ISO 时间（UTC，toISOString），与 arm 的
 *      ts 同格式、可直接按时间比较；另补 fields.lockId。
 *  #5 boot-recovered：v2 在 recoverAfterRestart() 走到“boot_id 变化
 *      且旧态为 LOCKED/LOCKING”的重启恢复分支时必写。注意与旧 Go
 *      的冲突：旧 Go 只在 BootMarker=='fail-limit-reboot' 时写
 *      boot-recovered（engine.go NewEngine），不是每次重启恢复都写；
 *      统一契约采用 v2 规则（见 ANSWERS-8Q.md #5“冲突情况”）。
 *  #6 status.json 补 boot_id / session_id / sid（Windows 用户 SID；
 *      与 session_id 的数字会话号不同，见 buildStatus）。
 *  #7 status.revision：每次真实状态变更 +1（lock-state.js 已有，
 *      transition() 实现；同态转移不 +1，见 lock-state.js 注释）。
 *      本模块只负责把它原样写进 status.json，不另设计数器。
 *  #9 captureExclusion 写入时机与 unknown 语义：见 setCaptureExclusion
 *      与 degradedFor() 的注释；LOCKED 下非 active 一律按 DEGRADED 对待。
 *
 * 事件字段白名单：只允许事件名与非敏感元数据；疑似秘密的键
 * （password/passwd/hash/secret/token/pw）一律丢弃（与旧 Go
 * audit.go forbiddenKey 同口径），宁可少记，不可泄密。
 * lastEvents 只保留最近 10 条（与服务端“只取最近 10 条”同口径）。
 */
const MAX_EVENTS = 10;

const CAPTURE_VALUES = Object.freeze(['active', 'failed-degraded', 'unknown']);

function nowIso(clock) {
  const d = clock ? clock() : new Date();
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

function isForbiddenKey(k) {
  const l = String(k).toLowerCase();
  return ['password', 'passwd', 'hash', 'secret', 'token', 'pw'].some((s) => l.includes(s));
}

function cleanFields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const [k, v] of Object.entries(fields)) {
    if (isForbiddenKey(k)) continue;
    out[k] = v;
  }
  return out;
}

// v1 兼容 state：只有设备确认的 LOCKED 才报 'Locked'，其余（LOCKING /
// UNLOCKING / UNKNOWN / RECOVERY_REQUIRED / UNLOCKED）一律报 'Off'。
// LOCKING 报 Off 是有意的：送达 ≠ 成功，未经 ACK 的 LOCKING 绝不谎报
// 已锁。六态真相在 actual_state 里，服务端对账必须优先读 actual_state。
function v1State(actualState) {
  return actualState === 'LOCKED' ? 'Locked' : 'Off';
}

class StatusReporter {
  constructor(opts) {
    const o = opts || {};
    this.clock = o.clock || null; // () => Date（测试可注入固定时钟）
    this.events = []; // [{ ts, ev, fields }]，最近 10 条
    this.captureExclusion = 'unknown'; // 宿主（会话组件 hello）未回报前为 unknown
    this.captureAssessed = false; // 是否收到过一次宿主回报
    this.armedAt = null; // 最近一次 arm 的 ISO 时间；disarm/unlock-ok 后清空
    this.armSource = null;
  }

  appendEvent(ev, fields) {
    if (!ev || typeof ev !== 'string') throw new Error('事件名必填');
    const entry = { ts: nowIso(this.clock), ev, fields: cleanFields(fields) };
    this.events.push(entry);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    return entry;
  }

  // #3：disarm 必须带 lockId（与 arm 的 armId 对称）。缺 lockId 是调用方
  // bug：直接抛错，不写一条无法对账的 disarm 事件。
  recordDisarm(by, lockId) {
    if (!lockId) throw new Error('disarm 事件须带 lockId');
    const e = this.appendEvent('disarm', { by: by || '', lockId });
    this.armedAt = null;
    this.armSource = null;
    return e;
  }

  recordArm(lockId, by) {
    if (!lockId) throw new Error('arm 事件须带 lockId');
    const e = this.appendEvent('arm', { by: by || '', armId: lockId, lockId });
    this.armedAt = e.ts;
    this.armSource = by || '';
    return e;
  }

  // #4：本地输密码解锁。ts 与 arm 同为 ISO UTC，可直接比较；
  // fields 补 lockId，服务端不再只靠“事件时间 ≥ arm 时间”窗口兜底。
  recordUnlockOk(lockId, by) {
    if (!lockId) throw new Error('unlock-ok 事件须带 lockId');
    const e = this.appendEvent('unlock-ok', { by: by || '', lockId });
    this.armedAt = null;
    this.armSource = null;
    return e;
  }

  // #5：重启后恢复锁状态时必写。调用点：协调层 recoverAfterRestart()
  // 确认 boot_id 变化且旧态为 LOCKED/LOCKING 的分支（且仅该分支）。
  // 非重启恢复（如同 boot_id 下的状态重核）不写，避免把普通重核
  // 冒充成重启证明。
  recordBootRecovered(opts) {
    const o = opts || {};
    if (!o.bootId) throw new Error('boot-recovered 事件须带 bootId');
    return this.appendEvent('boot-recovered', {
      marker: 'boot-changed',
      bootId: o.bootId,
      lockId: o.previousLockId || null,
      previousState: o.previousState || null
    });
  }

  recordEnvelopeRejected(reason, id) {
    return this.appendEvent('envelope-rejected', { reason: reason || '', id: id || '' });
  }

  // #9：captureExclusion 由会话组件在 hello 时回报（旧 Go：qflocksvc
  // handlePipeConn 的 req.Affinity → SetCaptureExclusion → 写盘）。
  // 写入时机：每次 buildStatus() 写盘时取当前值；值只在这里被改写，
  // 不由 arm/disarm 顺带改写。非法值直接抛错，不静默落成 unknown。
  setCaptureExclusion(value) {
    if (!CAPTURE_VALUES.includes(value)) {
      throw new Error('captureExclusion 非法值: ' + String(value));
    }
    this.captureExclusion = value;
    this.captureAssessed = true;
    return value;
  }

  // #9 unknown 语义：unknown = “尚未证实防截取生效”，不是“已生效”。
  // LOCKED/LOCKING 下 captureExclusion 非 active（failed-degraded 或
  // unknown）一律按 DEGRADED 对待（与 C 线 CONTRACT §1 映射一致）；
  // 未锁定（UNLOCKED）时不记降级——没有保护，就没有什么可降级。
  degradedFor(actualState) {
    if ((actualState === 'LOCKED' || actualState === 'LOCKING') && this.captureExclusion !== 'active') {
      return 'DEGRADED';
    }
    return null;
  }

  lastEvents() {
    return this.events.map((e) => ({ ts: e.ts, ev: e.ev, fields: Object.assign({}, e.fields) }));
  }

  // status.json v2：v1 字段全保留（state/version/nodeId/ownerUsername/
  // devicePublicKey/captureExclusion/updatedAt/lastEvents），新增
  // boot_id / session_id / sid / revision / actual_state / armedAt。
  // sid = Windows 用户 SID（字符串，如 S-1-5-21-…）；session_id = 数字
  // 会话号（如 1）；两者不是同一个东西，不可互相替代。
  buildStatus(snapshot, meta) {
    const m = meta || {};
    const snap = snapshot || {};
    const actual = snap.actual_state || 'UNKNOWN';
    return {
      component: m.component || 'QFRemote 本机锁 v2',
      version: m.version || '2.0.0',
      state: v1State(actual),
      actual_state: actual,
      fault: snap.last_error ? (snap.last_error.code || '') : '',
      failCount: typeof m.failCount === 'number' ? m.failCount : 0,
      lockoutUntil: m.lockoutUntil || null,
      armedAt: this.armedAt || snap.armed_at || null,
      armSource: this.armSource || null,
      ownerUsername: m.ownerUsername || '',
      nodeId: m.nodeId || snap.device_id || '',
      devicePublicKey: m.devicePublicKey || '',
      captureExclusion: this.captureExclusion,
      boot_id: snap.boot_id || m.bootId || '',
      session_id: snap.session_id != null ? snap.session_id : (m.sessionId != null ? m.sessionId : null),
      sid: snap.sid || snap.user_sid || m.sid || '',
      revision: typeof snap.revision === 'number' ? snap.revision : 0,
      updatedAt: nowIso(this.clock),
      lastEvents: this.lastEvents()
    };
  }
}

module.exports = { StatusReporter, MAX_EVENTS, CAPTURE_VALUES, v1State, cleanFields };
