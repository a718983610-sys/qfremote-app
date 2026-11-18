'use strict';
/*
 * QFRemote 隐私锁 v2 · 远程输入健康与恢复（B 线）
 * ================================================================
 * 定夺 §5.2 最小诊断链（operation_id 端到端，五段分开记）：
 *   01 Web 远程控制界面：用户点击事件是否生成（带 operation_id）
 *   02 控制信令通道：设备是否收到对应指令
 *   03 USH／输入执行组件：输入队列、会话路由、注入调用是否成功
 *   04 Windows 目标窗口：点击是否到达正确桌面与窗口
 *   05 远程画面反馈：画面上是否出现预期变化
 * 必须区分“收到指令”“系统 API 返回成功”“目标应用实际响应”三个层次。
 *
 * 定夺 §5.3 修复要求：
 *   - 输入通道健康检查，独立于画面通道（画面时钟在走 ≠ 输入可用）；
 *   - 锁组件退出或会话切换后的输入状态重核；
 *   - 安全恢复输入组件的机制（重新核验用户会话和调用身份）；
 *   - 输入失败时明确报错，不许一直显示 Connected 让用户误以为控制可用；
 *   - 必要时只重建控制通道，不强制断开整个远程桌面。
 *
 * 禁止（A16-S2 安全规则继续有效）：放宽 LEA 身份准入、伪造父进程、
 * 跨会话注入。恢复只重建“控制通道”（重新握手 + 重核会话/SID/调用者），
 * 不碰 LEA 白名单、不改进程父子关系、不向非目标会话注入。
 *
 * 低级键盘钩子的“注入事件”标志（LLKHF_INJECTED）只作诊断线索写入
 * 健康报告，绝不作为“事件来自可信远控端”的证明（定夺 §3 约束 5）。
 */
const crypto = require('crypto');

const STAGES = Object.freeze(['ui_event', 'signal_received', 'ush_execute', 'window_target', 'video_feedback']);
const STAGE_LABELS = Object.freeze({
  ui_event: '01 Web 点击事件生成',
  signal_received: '02 控制信令到达设备',
  ush_execute: '03 USH 输入执行（队列/会话路由/注入调用）',
  window_target: '04 点击到达正确桌面与窗口',
  video_feedback: '05 远程画面出现预期变化'
});

function newOperationId() { return 'op-' + crypto.randomBytes(8).toString('hex'); }

// 单次输入操作的端到端追踪记录。
class InputOperationTrace {
  constructor(operationId, kind) {
    this.operation_id = operationId || newOperationId();
    this.kind = kind || 'click'; // click | double-click | drag | key | hotkey | type
    this.startedAt = Date.now();
    this.stages = {}; // stage -> { ok, at, detail }
    this.done = false;
    this.verdict = null; // 'ok' | 'failed' | 'timeout'
    this.failedStage = null;
  }

  mark(stage, ok, detail) {
    if (!STAGES.includes(stage)) throw new Error('未知诊断段: ' + stage);
    this.stages[stage] = { ok: !!ok, at: Date.now(), detail: detail || '' };
    if (!ok && !this.failedStage) { this.failedStage = stage; this.verdict = 'failed'; this.done = true; }
    return this;
  }

  // 收到 ≠ 执行成功 ≠ 应用响应：三层分开记，调用方必须逐段 mark。
  finishOk() { this.verdict = 'ok'; this.done = true; return this; }

  toJSON() {
    return {
      operation_id: this.operation_id, kind: this.kind,
      startedAt: this.startedAt, done: this.done, verdict: this.verdict,
      failedStage: this.failedStage,
      stages: Object.fromEntries(Object.entries(this.stages).map(([k, v]) => [k, { ok: v.ok, detail: v.detail }])),
      stageLabels: STAGE_LABELS
    };
  }
}

/*
 * 输入通道健康监视器（独立于画面通道）。
 * 健康判定只看输入链路自己的探针结果：定期向 USH/输入执行组件发
 * 无副作用探针（probe：空操作 + 会话路由核验），画面帧率/时钟一律不算分。
 * 状态：healthy | degraded | failed。failed 时必须向控制台明确报错，
 * 协调层不得继续对外显示“控制可用”。
 */
class InputHealthMonitor {
  constructor(opts) {
    const o = opts || {};
    // probe: async () => ({ ok, stage?, detail? })，由调用方注入真实 USH 探针；
    // 未注入时 monitor 只能报 unknown，绝不假装 healthy。
    this.probe = o.probe || null;
    this.probeIntervalMs = o.probeIntervalMs || 5000;
    this.failThreshold = o.failThreshold || 2; // 连续失败几次判 failed
    this.consecutiveFailures = 0;
    this.status = 'unknown'; // unknown | healthy | degraded | failed
    this.lastProbeAt = null;
    this.lastError = null;
    this.traces = []; // 最近 50 条操作追踪
    this.timer = null;
    this.onStatusChange = o.onStatusChange || null;
  }

  _setStatus(next, detail) {
    if (next === this.status) return;
    const prev = this.status;
    this.status = next;
    if (next === 'failed' || next === 'degraded') this.lastError = detail || this.lastError;
    if (this.onStatusChange) { try { this.onStatusChange({ prev, next, detail: detail || null, at: new Date().toISOString() }); } catch (e) { /* 回调异常不炸监视器 */ } }
  }

  async probeOnce() {
    this.lastProbeAt = new Date().toISOString();
    if (!this.probe) { this._setStatus('unknown', '未注入输入探针，健康未知'); return { ok: false, status: 'unknown' }; }
    let r;
    try { r = await this.probe(); } catch (e) { r = { ok: false, detail: '探针异常: ' + e.message }; }
    if (r && r.ok) {
      this.consecutiveFailures = 0;
      this._setStatus('healthy');
      return { ok: true, status: 'healthy' };
    }
    this.consecutiveFailures += 1;
    const detail = (r && r.detail) || '输入探针失败';
    if (this.consecutiveFailures >= this.failThreshold) this._setStatus('failed', detail);
    else this._setStatus('degraded', detail);
    return { ok: false, status: this.status, detail };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.probeOnce().catch(() => {}); }, this.probeIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  newTrace(kind) {
    const t = new InputOperationTrace(null, kind);
    this.traces.push(t);
    if (this.traces.length > 50) this.traces = this.traces.slice(-50);
    return t;
  }

  // 锁组件退出或会话切换后调用：重核输入状态。
  // reverify: async ({ sessionId, userSid, caller }) => ({ ok, sessionId, userSid, detail? })
  // 校验失败 → 绝不恢复输入，状态置 failed 并明确报错。
  async reverifyAfterDisruption(reverify, expected) {
    if (typeof reverify !== 'function') {
      this._setStatus('failed', '无重核函数，输入状态不可确认');
      return { ok: false, code: 'NO_REVERIFY', message: '无重核函数，输入状态不可确认' };
    }
    let r;
    try { r = await reverify(expected || {}); } catch (e) {
      this._setStatus('failed', '输入重核异常: ' + e.message);
      return { ok: false, code: 'REVERIFY_ERROR', message: '输入重核异常: ' + e.message };
    }
    if (!r || !r.ok) {
      this._setStatus('failed', (r && r.detail) || '输入重核失败：会话/SID/调用者不符');
      return { ok: false, code: 'REVERIFY_FAILED', message: (r && r.detail) || '输入重核失败：会话/SID/调用者不符' };
    }
    if (expected && expected.sessionId != null && r.sessionId != null && r.sessionId !== expected.sessionId) {
      this._setStatus('failed', '重核会话不一致：期望 ' + expected.sessionId + '，实际 ' + r.sessionId);
      return { ok: false, code: 'SESSION_MISMATCH', message: '重核会话不一致' };
    }
    if (expected && expected.userSid && r.userSid && r.userSid !== expected.userSid) {
      this._setStatus('failed', '重核用户 SID 不一致');
      return { ok: false, code: 'SID_MISMATCH', message: '重核用户 SID 不一致' };
    }
    this.consecutiveFailures = 0;
    this._setStatus('healthy');
    return { ok: true, code: 'OK', sessionId: r.sessionId, userSid: r.userSid };
  }

  // 只重建控制通道：重新握手 + 重核，不碰整桌断开、不改 LEA 准入。
  // rebuildChannel: async () => ({ ok, detail? })，由调用方注入真实重建逻辑。
  async rebuildControlChannelOnly(rebuildChannel, reverify, expected) {
    if (typeof rebuildChannel !== 'function') {
      return { ok: false, code: 'NO_REBUILD', message: '无控制通道重建函数' };
    }
    let r;
    try { r = await rebuildChannel(); } catch (e) {
      this._setStatus('failed', '控制通道重建异常: ' + e.message);
      return { ok: false, code: 'REBUILD_ERROR', message: '控制通道重建异常: ' + e.message };
    }
    if (!r || !r.ok) {
      this._setStatus('failed', (r && r.detail) || '控制通道重建失败');
      return { ok: false, code: 'REBUILD_FAILED', message: (r && r.detail) || '控制通道重建失败' };
    }
    // 重建完必须重核，否则不算恢复。
    return this.reverifyAfterDisruption(reverify, expected);
  }

  // 给控制台的明确状态：failed/degraded 时调用方必须原样展示，不得再显示 Connected。
  report() {
    return {
      input_status: this.status,
      consecutive_failures: this.consecutiveFailures,
      last_probe_at: this.lastProbeAt,
      last_error: this.lastError,
      // 画面通道与输入通道分开：本报告不含任何画面指标。
      note: this.status === 'healthy' ? '' : '远程输入不可用或未确认，请勿继续操作；画面仍在走不代表输入可用。'
    };
  }
}

module.exports = {
  STAGES, STAGE_LABELS, newOperationId,
  InputOperationTrace, InputHealthMonitor
};
