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
 *   - 鉴权/绑定：只接受已登录且已绑定该 sessionId 的控制通道；
 *     服务端校验 sessionId 属于当前连接/用户/agent（绑定关系由
 *     调用方（server.js）传入，`boundSessions` 集合）；禁止客户
 *     端指定任意 sessionId。
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
  const sessions = new Map(); // sessionId -> { userId, agentId, maxSeq, bucket, tokensAt, lastForwardMsByReason, hardWindow:[], rejects, cooldownUntil, joinGraceUsed, createdAt }
  const agents = new Map(); // agentId -> { tokens, tokensAt }

  function refill(bucket, rate, burst, nowMs) {
    const elapsedSec = Math.max(0, (nowMs - bucket.at) / 1000);
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * rate);
    bucket.at = nowMs;
  }

  function bind(sessionId, userId, agentId, nowMs) {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        userId, agentId, maxSeq: 0,
        bucket: { tokens: SESSION_BURST, at: nowMs },
        lastForwardMsByReason: {}, hardWindow: [],
        rejects: 0, cooldownUntil: 0, joinGraceUsed: false, createdAt: nowMs,
      });
    }
    return sessions.get(sessionId);
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

  return { bind, request, REASONS, COALESCE_MS };
}

module.exports = { createIdrGate };
