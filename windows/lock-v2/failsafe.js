'use strict';
/*
 * QFRemote 隐私锁 v2 · 安全失效降级（B 线）
 * ================================================================
 * 定夺 §3 约束 6：异常退出必须失败保护。
 * 若无法继续保证本地隐私，系统进入可恢复的安全降级：由仍正常工作的
 * 会话组件调用 Windows 原生锁屏（LockWorkStation），同时向远程控制端
 * 明确报告功能降级——不能悄悄露出桌面并仍宣称受保护。
 *
 * 降级判定（任一成立即降级）：
 *   - 会话内隐私显示组件进程退出 / 心跳超时（默认 10 秒）；
 *   - IPC 断开且重连失败；
 *   - 状态文件损坏且无法确认实际保护；
 *   - 一次性密码失败次数满（由密码保管模块触发）；
 *   - 协调层重启后发现旧 LOCKED 状态但会话组件无法确认保护仍在。
 *
 * 降级动作（顺序执行，缺一不可）：
 *   1. 标记 degradation={ kind:'FAILSAFE', reason }，actual_state 保持
 *      RECOVERY_REQUIRED（或 LOCKED+FAILSAFE 上报，effective_state 为 FAILSAFE）；
 *   2. 请求会话组件执行原生锁屏（LockWorkStation）；若无可用会话组件，
 *      降级仍要上报，绝不静默；
 *   3. 撤销本次一次性密码；
 *   4. 向服务端/控制台上报 FAILSAFE 事件（带 lock_id、revision、原因），
 *      控制台必须显示“隐私保护已降级”，不得继续显示正常 LOCKED。
 */
const FAILSAFE_HEARTBEAT_TIMEOUT_MS = 10000;

function decideFailsafe(ctx) {
  // ctx: { componentAlive, heartbeatAgeMs, ipcAlive, stateCorrupt,
  //        passwordRevoked, lockConfirmed, reason? }
  const reasons = [];
  if (ctx.componentAlive === false) reasons.push('会话内隐私显示组件已退出');
  if (typeof ctx.heartbeatAgeMs === 'number' && ctx.heartbeatAgeMs > FAILSAFE_HEARTBEAT_TIMEOUT_MS) {
    reasons.push('组件心跳超时 ' + ctx.heartbeatAgeMs + 'ms（阈值 ' + FAILSAFE_HEARTBEAT_TIMEOUT_MS + 'ms）');
  }
  if (ctx.ipcAlive === false) reasons.push('与会话组件的 IPC 已断开');
  if (ctx.stateCorrupt) reasons.push('锁状态文件损坏，无法确认实际保护');
  if (ctx.passwordRevoked) reasons.push('一次性密码已撤销（失败次数满或过期）');
  if (ctx.lockConfirmed === false && ctx.actualState === 'LOCKED') reasons.push('会话组件无法确认保护仍在');
  if (reasons.length === 0) return { failsafe: false, reasons };
  return { failsafe: true, reasons, reason: reasons.join('；') };
}

module.exports = { FAILSAFE_HEARTBEAT_TIMEOUT_MS, decideFailsafe };
