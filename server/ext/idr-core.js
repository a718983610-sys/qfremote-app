'use strict';
/*
 * QFRemote 扩展服务 · L5 RC-03：IDR 请求准入控制（协议 QF-VIDEO-1）
 * ================================================================
 * 大肥鱼复核裁决（2026-11-15，原文 l5-evidence/ds-review-rc03-rc09-20261115.md）：
 * idr-request 不能只做格式校验和“透传”——关键帧远大于普通帧，
 * 高频 IDR 请求会造成关键帧风暴、码率突增、编码器排队。服务端
 * 必须是“校验 + 鉴权 + 去重 + 限流 + 转发/合并 + 审计”。
 *
 * 规则（数值全部来自复核意见原文）：
 *   - 鉴权/绑定（U3；GPT A4 裁决）：绑定只认调用方注入校验器验证过的身份——
 *     createIdrGate({ verifyAgent })，verifyAgent(userId, agentId) 须由调用方
 *     用服务端可信源实现（server.js 用 LEA 绑定台账：绑定存在、account_id
 *     等于登录用户、state 为 ACTIVE）。未注入校验器，或校验未通过，bind()
 *     一律拒绝建立绑定（返回 null）。每次 request() 重验绑定归属（换绑/解绑
 *     后旧绑定立即失效，不等过期）。先到先得只发生在“同一 (sessionId, user,
 *     agent)”之内：已存在的绑定不受后来 bind() 调用影响，request() 按绑定
 *     的 userId/agentId 比对——伪造 agentId、冒用他人 sessionId 一律拒绝。
 *     闲置过期：sweep(nowMs, idleMs) 丢弃长期无请求的绑定，过期后重建须重新
 *     校验，不复活旧状态（seq/冷却清零）。
 *   - 字段校验：reason 白名单（loss/join/quality-change）；seq
 *     每会话单调递增，服务端维护重放窗口（只接受 seq > 已见最大
 *     seq，乱序/重放拒绝）。
 *   - 限流：每 session 令牌桶 rate=0.5/s、burst=2；同 reason 合并
 *     窗口 loss 1s、quality-change 2s；硬上限每 session 1/s、
 *     5/10s；每 agent 令牌桶 rate=2/s、burst=5。
 *   - 超限返回 rejected/coalesced 并记审计（经注入的 log 回调，
 *     只记元数据）；连续超限 3 次触发 10s 冷却＋告警。
 *   - 特殊放行：会话建立后 10s 内允许 1 次 join（不占令牌桶，
 *     仍受硬上限与合并窗口约束）；quality-change 每次档位切换
 *     最多 1 次（由调用方在 reason 内标记，同一档位切换只放行
 *     首次——此处以合并窗口实现）。
 *   - 多观看端同 session 请求按 session 合并，不各触发一次关键帧。
 *
 * 本模块是纯状态机（时间由调用方注入 nowMs，便于测试）；不做
 * 网络 IO，不直接碰编码器——放行决策由调用方转发给 agent。
 */
const REASONS = ['loss', 'join', 'quality-change'];
const COALESCE_MS = { loss: 1000, 'quality-change': 2000, join: 1000 };
const SESSION_RATE_PER_SEC = 0.5;
const SESSION_BURST = 2;
const AGENT_RATE_PER_SEC = 2;
const AGENT_BURST = 5;
const HARD_PER_SEC = 1; // 每 session 1/s
const HARD_PER_10S = 5; // 每 session 5/10s
const COOLDOWN_MS = 10000;
const COOLDOWN_TRIGGER_REJECTS = 3;
const JOIN_GRACE_MS = 10000;

function createIdrGate(deps) {
  const log = (deps && deps.log) || (() => {});
  // U3：agent 归属校验器（调用方注入，server.js 用 LEA 绑定台账实现）。
  // 未注入时 bind 一律拒绝（fail-closed）——任何调用方都不得在不验证 agent
  // 身份的情况下建立绑定。校验器抛错按未通过处理（不把异常当放行）。
  const verifyAgent = (deps && typeof deps.verifyAgent === 'function') ? deps.verifyAgent : null;
  const sessions = new Map(); // sessionId -> { userId, agentId, maxSeq, bucket, tokensAt, lastForwardMsByReason, hardWindow:[], rejects, cooldownUntil, joinGraceUsed, createdAt, lastSeenAt }
  const agents = new Map(); // agentId -> { tokens, tokensAt }

  function agentVerified(userId, agentId) {
    if (!verifyAgent) return false;
    try { return verifyAgent(userId, agentId) === true; }
    catch (e) { return false; }
  }

  function refill(bucket, rate, burst, nowMs) {
    const elapsedSec = Math.max(0, (nowMs - bucket.at) / 1000);
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * rate);
    bucket.at = nowMs;
  }

  function bind(sessionId, userId, agentId, nowMs) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    // 绑定只认已验证的身份：未注入校验器，或校验未通过，一律拒绝建立
    // （返回 null，调用方按 AGENT_NOT_BOUND 拒绝）。已存在的绑定不受影响。
    if (!agentVerified(userId, agentId)) {
      log({ ev: 'idr-bind-refused', sessionId, agentId, hasVerifier: !!verifyAgent });
      return null;
    }
    sessions.set(sessionId, {
      userId, agentId, maxSeq: 0,
      bucket: { tokens: SESSION_BURST, at: nowMs },
      lastForwardMsByReason: {}, hardWindow: [],
      rejects: 0, cooldownUntil: 0, joinGraceUsed: false, createdAt: nowMs, lastSeenAt: nowMs,
    });
    return sessions.get(sessionId);
  }

  // 闲置过期：丢弃 lastSeenAt 超过 idleMs 的绑定与 agent 令牌桶缓存。
  // 过期后重建须重新走 bind 校验，不复活旧状态（seq/冷却清零）。
  function sweep(nowMs, idleMs) {
    let dropped = 0;
    for (const [sid, st] of sessions) {
      if (nowMs - (st.lastSeenAt || st.createdAt) > idleMs) { sessions.delete(sid); dropped++; }
    }
    for (const [aid, ab] of agents) {
      if (nowMs - ab.at > idleMs) agents.delete(aid);
    }
    if (dropped) log({ ev: 'idr-sweep', dropped });
    return dropped;
  }

  function request(input) {
    const nowMs = Number(input.nowMs);
    const sessionId = String(input.sessionId || '');
    const userId = String(input.userId || '');
    const agentId = String(input.agentId || '');
    const reason = String(input.reason || '');
    const seq = Number(input.seq);
    const st = sessions.get(sessionId);
    if (!st) return { decision: 'rejected', code: 'NO_SESSION', msg: '会话未绑定。' };
    st.lastSeenAt = nowMs;
    // U3 撤权复核：每次请求重验绑定归属——设备换绑/解绑后旧绑定立即失效，
    // 不等过期。校验失败不删绑定（校验器瞬时异常不摧毁 live 会话），只拒绝本次请求。
    if (!agentVerified(st.userId, st.agentId)) {
      log({ ev: 'idr-agent-reverify-failed', sessionId, agentId: st.agentId });
      return { decision: 'rejected', code: 'AGENT_NOT_BOUND', msg: '设备归属校验未通过（可能已换绑或解绑）。' };
    }
    if (st.userId !== userId || st.agentId !== agentId) {
      return { decision: 'rejected', code: 'NOT_BOUND', msg: '会话不属于当前用户/agent。' };
    }
    if (!REASONS.includes(reason)) return { decision: 'rejected', code: 'BAD_REASON', msg: 'reason 非法。' };
    if (!Number.isFinite(seq) || seq <= st.maxSeq) {
      return { decision: 'rejected', code: 'REPLAY', msg: 'seq 非单调递增（重放/乱序）。' };
    }
    if (nowMs < st.cooldownUntil) {
      return { decision: 'rejected', code: 'COOLDOWN', msg: '连续超限冷却中。', retryAfterMs: st.cooldownUntil - nowMs };
    }
    // 同 reason 合并窗口先于硬上限：被合并的请求不产生关键帧，
    // 不消耗硬上限额度；seq 仍消费（防重放窗口前进）。
    const lastFwd = st.lastForwardMsByReason[reason];
    if (typeof lastFwd === 'number' && nowMs - lastFwd < COALESCE_MS[reason]) {
      st.maxSeq = seq;
      log({ ev: 'idr-coalesced', sessionId, reason, seq });
      return { decision: 'coalesced', code: 'COALESCED', msg: '同 reason 合并窗口内，已合并。' };
    }
    // 硬上限：1/s、5/10s（滑动窗口，只统计实际放行的请求）
    st.hardWindow = st.hardWindow.filter((t) => nowMs - t < 10000);
    const last1s = st.hardWindow.filter((t) => nowMs - t < 1000).length;
    if (last1s >= HARD_PER_SEC || st.hardWindow.length >= HARD_PER_10S) {
      return reject(st, 'HARD_LIMIT', '硬上限：关键帧请求过于频繁。', nowMs, sessionId, reason);
    }
    // join 宽限：会话建立后 10s 内首次 join 不占令牌桶
    const joinGrace = reason === 'join' && !st.joinGraceUsed && nowMs - st.createdAt <= JOIN_GRACE_MS;
    if (!joinGrace) {
      // 每 session 令牌桶
      refill(st.bucket, SESSION_RATE_PER_SEC, SESSION_BURST, nowMs);
      if (st.bucket.tokens < 1) {
        return reject(st, 'SESSION_BUCKET', '会话令牌桶已空。', nowMs, sessionId, reason);
      }
      // 每 agent 令牌桶
      let ab = agents.get(agentId);
      if (!ab) { ab = { tokens: AGENT_BURST, at: nowMs }; agents.set(agentId, ab); }
      refill(ab, AGENT_RATE_PER_SEC, AGENT_BURST, nowMs);
      if (ab.tokens < 1) {
        return reject(st, 'AGENT_BUCKET', 'agent 令牌桶已空。', nowMs, sessionId, reason);
      }
      st.bucket.tokens -= 1;
      ab.tokens -= 1;
    } else {
      st.joinGraceUsed = true;
    }
    st.maxSeq = seq;
    st.lastForwardMsByReason[reason] = nowMs;
    st.hardWindow.push(nowMs);
    st.rejects = 0;
    return { decision: 'forward', code: 'OK', msg: '放行。' };
  }

  function reject(st, code, msg, nowMs, sessionId, reason) {
    st.rejects += 1;
    log({ ev: 'idr-rejected', sessionId, reason, code });
    if (st.rejects >= COOLDOWN_TRIGGER_REJECTS) {
      st.cooldownUntil = nowMs + COOLDOWN_MS;
      st.rejects = 0;
      log({ ev: 'idr-cooldown', sessionId, untilMs: st.cooldownUntil });
    }
    return { decision: 'rejected', code, msg };
  }

  return { bind, request, sweep, REASONS, COALESCE_MS };
}

module.exports = { createIdrGate };
