'use strict';
/*
 * QFRemote Windows 运行端 — RC-03 IDR 请求发送器（3.0.0）
 * ========================================================
 * 依据：QF-VIDEO-1 客户端协议规范 v1（server/ext/QF-VIDEO-1-CLIENT-SPEC.md）
 * §2（IDR 请求端点）／§3 第 5–6 条（发送时机与收到 coalesced/rejected
 * 后的行为）。服务端准入状态机见 server/ext/idr-core.js。
 *
 * 发送时机（只这三种，不得另加，规范 §3 第 5 条）：
 *   - 新观看端加入：一次 reason=join（绑定后 10s 宽限内发）；
 *   - 帧不可恢复：超时窗口届满后一次 reason=loss；
 *   - 档位切换需关键帧：每次档位切换最多一次 reason=quality-change。
 *
 * seq（规范 §2.4）：每会话从 1 开始单调递增，每发一次请求加 1，无论
 * 上次是放行、合并还是拒绝——被合并的请求也消费 seq。收到 REPLAY 时
 * 不得原样重发；本地以单调计数器为准（每次发送的 seq 大于之前所有已
 * 发送的 seq），下一次触发时用新 seq 再发。多观看端同 sessionId 须
 * 共用一个 seq 计数器（由会话主持端统一发）；本发送器是单观看端实例，
 * 多端共用计数器须由调用方协调，本模块不假装能跨进程同步 seq。
 *
 * 收到 coalesced / rejected 后的行为（规范 §3 第 6 条）：不补发、不换
 * reason 重发、不降级成“每帧都请求”；等已放行的关键帧或等冷却/窗口
 * 过去；UI 上不得向用户报错（节流是正常行为，只记诊断日志）。
 * 冷却：COOLDOWN 响应带 retryAfterMs，冷却结束前不得再发——本发送器
 * 在本地记 cooldownUntil，未到时 send() 直接短路、不发网络请求。
 * 本地同 reason 合并窗口（loss 1s / quality-change 2s / join 1s）：
 * 窗口内重复触发直接短路（服务端同样会合并，不发请求即不消费 seq）。
 *
 * 诚实边界（规范 §4.3）：服务端只做准入决策返回，不直接把放行转发给
 * agent——“转发给 agent 强制出 IDR”通道尚未实现。forward 只表示
 * “服务端允许”，本模块不得假设 agent 已收到；调用方不得把 forward
 * 当作“关键帧已在路上”的保证，只能等下一关键帧到达后渲染。
 */
const IDR_PATH = '/license/api/session/idr-request';
const REASONS = ['loss', 'join', 'quality-change'];
const COALESCE_MS = { loss: 1000, 'quality-change': 2000, join: 1000 };
// F-WIN-07（2026-11-15）：join 宽限 10s 本地强制执行——绑定后超
// 宽限才首次发 join 时直接短路记日志，不发网络请求。
const JOIN_WINDOW_MS = 10000;
// 拒绝码 → 客户端反应（规范 §2.2，与 idr-core.js 一字一致）。
const REJECTED_CODES = {
  NO_SESSION: { retryableNextTrigger: false, note: '会话未绑定；检查 sessionId 是否传错，不得重试刷请求' },
  NOT_BOUND: { retryableNextTrigger: false, note: '会话不属于当前用户/agent；停止请求，走重新绑定/重新登录' },
  AGENT_NOT_BOUND: { retryableNextTrigger: false, note: '设备归属校验未通过（设备未绑定到当前账号，或绑定已失效）；停止请求，走重新绑定/重新登录' },
  BAD_REASON: { retryableNextTrigger: false, note: 'reason 非法；客户端 bug，不得重试' },
  REPLAY: { retryableNextTrigger: true, note: 'seq 非单调递增；下一次触发时用新 seq 再发，不得原样重发' },
  COOLDOWN: { retryableNextTrigger: true, note: '连续超限冷却中；等冷却结束后再发' },
  HARD_LIMIT: { retryableNextTrigger: true, note: '硬上限；等窗口滑过后再发' },
  SESSION_BUCKET: { retryableNextTrigger: true, note: '会话令牌桶已空；等令牌恢复后再发' },
  AGENT_BUCKET: { retryableNextTrigger: true, note: 'agent 令牌桶已空；等令牌恢复后再发' }
};

function createIdrSender(opts) {
  const o = opts || {};
  if (typeof o.request !== 'function') throw new Error('qf-idr: request 注入缺失');
  if (typeof o.baseUrl !== 'string' || !o.baseUrl) throw new Error('qf-idr: baseUrl 缺失');
  const request = o.request;
  const baseUrl = String(o.baseUrl).replace(/\/+$/, '');
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  let sessionId = typeof o.sessionId === 'string' ? o.sessionId : '';
  let agentId = typeof o.agentId === 'string' ? o.agentId : '';
  let seq = 0; // 下一次发送用 seq+1（首发 seq=1，规范 §2.4）
  let cooldownUntil = 0;
  let lastSentAtByReason = {}; // reason -> ms（本地合并窗口）
  let joinSent = false;
  let lastReplayAt = 0;
  let bindAt = 0; // F-WIN-07：最近一次 bind() 的时刻（join 10s 宽限起点）

  function bind(ids) {
    if (ids && typeof ids.sessionId === 'string') sessionId = ids.sessionId;
    if (ids && typeof ids.agentId === 'string') agentId = ids.agentId;
    seq = 0;
    cooldownUntil = 0;
    lastSentAtByReason = {};
    joinSent = false;
    bindAt = nowMs();
  }
  function unbind() {
    sessionId = '';
    agentId = '';
    seq = 0;
    cooldownUntil = 0;
    lastSentAtByReason = {};
    joinSent = false;
    bindAt = 0;
  }

  // 发一次 IDR 请求。返回值一律 { ok, decision?, code?, kind, retryableNextTrigger }：
  //   ok=true 当且仅当 decision 为 forward 或 coalesced（规范 §2.2）。
  //   kind：'forward' | 'coalesced' | 'rejected' | 'cooldown' | 'local-coalesced' |
  //         'no-session' | 'no-agent' | 'bad-reason' | 'join-already-sent' |
  //         'join-window-expired' | 'network' | 'unavailable' | 'unknown'。
  //   除 network / unavailable 外，任何拒绝都不立即重发（retryableNextTrigger
  //   只表示“下一次新触发时可再试”，不是“现在重发”）。
  async function send(reason) {
    if (REASONS.indexOf(reason) < 0) return { ok: false, kind: 'bad-reason', code: 'BAD_REASON', retryableNextTrigger: false };
    if (!sessionId) return { ok: false, kind: 'no-session', code: 'NO_SESSION', retryableNextTrigger: false };
    if (!agentId) return { ok: false, kind: 'no-agent', code: 'NOT_BOUND', retryableNextTrigger: false };
    const now = nowMs();
    if (now < cooldownUntil) {
      return { ok: false, kind: 'cooldown', code: 'COOLDOWN', retryAfterMs: cooldownUntil - now, retryableNextTrigger: true };
    }
    const lastSent = lastSentAtByReason[reason];
    if (typeof lastSent === 'number' && now - lastSent < COALESCE_MS[reason]) {
      return { ok: false, kind: 'local-coalesced', code: 'COALESCED', retryableNextTrigger: true };
    }
    if (reason === 'join' && joinSent) {
      return { ok: false, kind: 'join-already-sent', code: 'COALESCED', retryableNextTrigger: false };
    }
    // F-WIN-07：join 只在绑定后 10s 宽限内发；超宽限首次发 join 直接
    // 短路（不消费 seq、不发网络请求），服务端若按宽限拒绝客户端无从
    // 得知，故本地先拦一道。
    if (reason === 'join' && bindAt > 0 && now - bindAt > JOIN_WINDOW_MS) {
      log('idr.join-window-expired ageMs=' + (now - bindAt));
      return { ok: false, kind: 'join-window-expired', code: 'JOIN_WINDOW_EXPIRED', retryableNextTrigger: false };
    }
    seq += 1; // 每发一次消费一个 seq（放行/合并/拒绝都消费，规范 §2.4）
    const useSeq = seq;
    lastSentAtByReason[reason] = now;
    if (reason === 'join') joinSent = true;
    let res;
    try {
      res = await request('POST', baseUrl + IDR_PATH, { sessionId, agentId, seq: useSeq, reason });
    } catch (e) {
      // R-W1：网络失败不算已发 join——回滚 joinSent，否则本 bind 内
      // 永久回 join-already-sent（retryableNextTrigger:false）。seq 已
      // 消费按规范 §2.4 不回滚；1s 本地合并窗口仍保留（有界重试：只在
      // 下次新触发时再试，不立即重发）。
      if (reason === 'join') joinSent = false;
      return { ok: false, kind: 'network', retryableNextTrigger: true };
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 503 && json && json.code === 'L5_UNAVAILABLE') {
      return { ok: false, kind: 'unavailable', code: 'L5_UNAVAILABLE', retryableNextTrigger: true };
    }
    if (status !== 200 || !json || typeof json.decision !== 'string') {
      // R-W1：未收到服务端决策，同样回滚 joinSent（同上）；503 已是
      // 服务端明确响应，不回滚（收到拒绝后不补发，规范 §3 第 6 条）。
      if (reason === 'join') joinSent = false;
      return { ok: false, kind: status === 0 ? 'network' : 'unknown', retryableNextTrigger: true };
    }
    if (json.decision === 'forward') {
      return { ok: true, kind: 'forward', decision: 'forward', code: json.code || 'OK', seq: useSeq, retryableNextTrigger: false };
    }
    if (json.decision === 'coalesced') {
      // 已合并：等已放行的那次关键帧，不得重发（规范 §3 第 6 条）。
      log('idr.coalesced reason=' + reason + ' seq=' + useSeq);
      return { ok: true, kind: 'coalesced', decision: 'coalesced', code: json.code || 'COALESCED', seq: useSeq, retryableNextTrigger: false };
    }
    // rejected：按码查表；COOLDOWN 记本地冷却截止（服务端 retryAfterMs 为准）。
    const code = json.code || 'UNKNOWN';
    if (code === 'COOLDOWN') {
      const wait = Number.isFinite(Number(json.retryAfterMs)) && Number(json.retryAfterMs) > 0
        ? Number(json.retryAfterMs) : 10000;
      cooldownUntil = nowMs() + wait;
      log('idr.cooldown retryAfterMs=' + wait);
    }
    if (code === 'REPLAY') {
      // 不原样重发；本地计数器本就单调，下一次触发自然用新 seq。
      lastReplayAt = nowMs();
      log('idr.replay seq=' + useSeq);
    } else {
      log('idr.rejected code=' + code + ' reason=' + reason);
    }
    const known = REJECTED_CODES[code] || { retryableNextTrigger: true, note: '未知拒绝码，按可重试处理' };
    return { ok: false, kind: 'rejected', decision: 'rejected', code, seq: useSeq, retryableNextTrigger: known.retryableNextTrigger };
  }

  async function sendLoss() { return send('loss'); }
  async function sendJoin() { return send('join'); }
  async function sendQualityChange() { return send('quality-change'); }

  return {
    bind,
    unbind,
    send,
    sendLoss,
    sendJoin,
    sendQualityChange,
    getSessionId: () => sessionId,
    getAgentId: () => agentId,
    nextSeq: () => seq + 1,
    lastSeqSent: () => seq,
    inCooldown: () => nowMs() < cooldownUntil,
    cooldownRemainingMs: () => Math.max(0, cooldownUntil - nowMs()),
    lastReplayAt: () => lastReplayAt,
    joinSent: () => joinSent
  };
}

module.exports = { IDR_PATH, REASONS, COALESCE_MS, REJECTED_CODES, createIdrSender };
