'use strict';
/*
 * QFRemote Windows 运行端 — 断线重连策略（RC-04 客户端层，3.0.0）
 * ================================================================
 * 来源：FreeRDP client/common/client.c 的 client_auto_reconnect_do()
 * ＋ Remmina rdp_plugin.c 的自实现重连循环（remote-control/REPORT.md
 * §十二 RC-04）：
 *   - 客户端层重试最多 5 次、间隔 ≥5 秒、界面显示“第 N 次 / 共 N 次”
 *     与取消按钮；重连期间输入事件短路丢弃（看护只点重连按钮，
 *     不代用户点其它控件）；
 *   - 凭据/授权类失败立即停止重试（反复试错只会更快锁号），只有
 *     纯网络错误才继续；用户取消也立即停。
 * 本模块是纯策略（不含票据格式）：凭票据恢复原会话的那一层
 * （服务端票据规范）由 L1 先出，规范未到之前不发明票据格式；
 * 本模块只管“重试几次、隔多久、什么情况立即停”。
 * 失败分类（调用方传入，watchdog 侧按页面状态映射）：
 *   - 'credential'：落到登录页 / 授权被吊销 / 密码错；
 *   - 'network'：纯网络错误（断网、服务端重启、切 Wi-Fi）；
 *   - 'cancelled'：用户点了取消；
 *   - 'unknown'：未分类——按网络错误处理，但只给 1 次试探机会
 *     后即停（fail-closed，不无限刷）。
 * watchdog.js 接线：maxAttempts 默认 5，attempt 计数按“断开回合”
 * 计，恢复 ok 即清零；到顶后停手并报 reconnect-failed，等待用户
 * 手动点连接（看护继续轮询，只不再自动点）。
 */
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MIN_INTERVAL_MS = 5000;
const DEFAULT_BACKOFF_MAX_MS = 30000;

// RC-04 票据层凭据类错误码（L1 票据规范 RC-04-RECONNECT-TICKET-SPEC.md
// §5.2／§3.2／§4）：命中任一码即立即停止重试，不刷屏、不再试同一张
// 票据——反复试错只会更快锁号。服务端错误体为 { ok:false, code, msg }
//（lea-routes.js fail()），故分类只认 code 字段，不猜 msg 文案。
// F-WIN-03（2026-11-15）：QFR_TICKET_INVALID 是签名／形状类服务端
// 拒绝，与 QFR_TICKET_REUSED／QFR_TICKET_EXPIRED 同级归凭据类，
// 否则 resume 收到它会保留坏票反复重发（400 落 unknown）。
const TICKET_CREDENTIAL_CODES = Object.freeze([
  'QFR_API_KEY_REVOKED',
  'QFR_TICKET_REUSED',
  'QFR_TICKET_EXPIRED',
  'QFR_TICKET_INVALID',
  'QFR_BINDING_CHANGED',
  'QFR_GRANT_REVOKED',
  'QFR_SCOPE_DENIED',
  'QFR_LEA_NOT_BOUND'
]);

function isCredentialTicketCode(code) {
  return typeof code === 'string' && TICKET_CREDENTIAL_CODES.indexOf(code) >= 0;
}

// 票据端点（/reconnect/issue、/reconnect/resume）一次调用的失败分类：
//   'credential'  — 凭据/授权类（§5.2 立即停；调用方须丢弃手中票据）；
//   'network'     — 纯网络错误（status 0 超时/断网、429、500/502/503，
//                   可继续走重试循环，票据未被消费、保留）；
//   'unavailable' — 端点不存在（404：服务端尚未实现 §7 后续项，票据
//                   未被消费、保留，走原有点“连接”按钮重连）；
//   'unknown'     — 其余（未分类，调用方按单次试探处理，不无限刷）。
// 注意：HTTP 状态与 code 双通道——已知凭据码优先于状态码；401/403/409
// 无已知码时按 fail-closed 归凭据类（§5.2 “凭据/授权类失败立即停”）。
function classifyTicketFailure(status, code) {
  if (isCredentialTicketCode(code)) return 'credential';
  if (status === 404) return 'unavailable';
  if (status === 0 || status === 429 || status === 500 || status === 502 || status === 503) return 'network';
  if (status === 401 || status === 403 || status === 409) return 'credential';
  return 'unknown';
}

// 按失败种类判定：是否允许继续重试。
function shouldRetry(kind) {
  if (kind === 'credential' || kind === 'cancelled') return false;
  return true; // network / unknown 允许继续（unknown 由次数上限兜底）
}

// 下一次重试的等待毫秒：5s 起步、每次翻倍、封顶 30s；第 attempt 次
// （从 1 计）重试前的等待。
function nextDelayMs(attempt, opts) {
  const o = opts || {};
  const start = o.minIntervalMs || DEFAULT_MIN_INTERVAL_MS;
  const max = o.backoffMaxMs || DEFAULT_BACKOFF_MAX_MS;
  return Math.min(start * Math.pow(2, Math.max(0, attempt - 1)), max);
}

// 综合判定：已试 attempt 次、本次失败种类 kind，是否还能再试一次。
// 返回 { retry: bool, reason, delayMs }。
function decide(attempt, kind, opts) {
  const o = opts || {};
  const max = o.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  if (!shouldRetry(kind)) {
    return { retry: false, reason: kind === 'cancelled' ? 'user-cancelled' : 'credential-stop', delayMs: 0 };
  }
  if (attempt >= max) {
    return { retry: false, reason: 'max-attempts', delayMs: 0 };
  }
  if (kind === 'unknown' && attempt >= 1) {
    return { retry: false, reason: 'unknown-single-probe', delayMs: 0 };
  }
  return { retry: true, reason: 'ok', delayMs: nextDelayMs(attempt + 1, o) };
}

// watchdog 页面状态 -> 失败种类映射：
//   'login' = 落到登录页（凭据/授权类，立即停）；
//   'disconnected' = 纯网络断开；'partial'/'unknown' = 未分类。
function classifyPageState(state) {
  if (state === 'login') return 'credential';
  if (state === 'disconnected') return 'network';
  return 'unknown';
}

// 进度文案：工具栏状态行用（“第 N 次 / 共 5 次”）。
function progressText(attempt, maxAttempts) {
  const max = maxAttempts || DEFAULT_MAX_ATTEMPTS;
  return '正在重连（第 ' + attempt + ' 次 / 共 ' + max + ' 次）';
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_BACKOFF_MAX_MS,
  TICKET_CREDENTIAL_CODES,
  isCredentialTicketCode,
  classifyTicketFailure,
  shouldRetry,
  nextDelayMs,
  decide,
  classifyPageState,
  progressText
};
