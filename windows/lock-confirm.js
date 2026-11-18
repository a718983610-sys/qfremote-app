'use strict';
/*
 * QFRemote 隐私锁 · 关闭确认弹窗纯逻辑（C 线，定夺 §4.4，LOCK-P1-01）
 * ================================================================
 * 与 windows/lock.html 内联的弹窗绑定共用同一规则，本模块是不依赖 DOM
 * 的纯逻辑版，供 Node 单测逐项钉死；lock.html 的实现逐条对照此处注释。
 *
 * 规则：
 *  1. 弹窗打开时冻结 device_id／lock_id／revision＋操作挑战＋操作编号；
 *  2. 弹窗是独立状态，不随设备面板重渲染消失，也没有自动过期定时器
 *     （旧实现 3.5 秒自动取消确认态即 LOCK-P1-01 的缺陷根源，已删除）；
 *  3. 提交中按钮禁用，重复提交只产生一次真实请求（第二次返回
 *     already-submitted，调用方不得再发）；
 *  4. 挑战过期（5 分钟）或 revision 变化后，须重新取挑战／刷新冻结快照
 *     才能再次提交，不得用旧快照提交；
 *  5. 超时／掉线／拒绝都由调用方把结果交回 resolve()，弹窗据此决定
 *     关闭或留在原地显示错误——网络超时不改写成“未锁定”。
 */
function createConfirmSession(input) {
  const i = input || {};
  if (!i.deviceId || !i.lockId || typeof i.revision !== 'number'
    || !i.challenge || typeof i.expiresAt !== 'number' || !i.operationId) {
    return null;
  }
  return {
    state: 'open', // open | submitting | done | error
    deviceId: String(i.deviceId),
    lockId: String(i.lockId),
    revision: i.revision,
    challenge: String(i.challenge),
    expiresAt: i.expiresAt,
    operationId: String(i.operationId),
    error: null,
    errorCode: null,
    result: null,
  };
}

function isChallengeExpired(session, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  return now >= session.expiresAt;
}

// 提交：只有 open 态且挑战未过期才能发；发后立即进 submitting，重复调返回拒绝。
function submit(session, nowMs) {
  if (!session || session.state !== 'open') return { ok: false, reason: 'already-submitted' };
  if (isChallengeExpired(session, nowMs)) return { ok: false, reason: 'challenge-expired' };
  session.state = 'submitting';
  return {
    ok: true,
    payload: {
      id: session.deviceId,
      challenge: session.challenge,
      operationId: session.operationId,
      revision: session.revision,
    },
  };
}

// 把服务端返回交回：成功即 done（弹窗可关）；失败留在 error 态，弹窗不消失，
// 由调用方按 code 决定是重试（revision-stale 时刷新快照＋取新挑战）还是仅显示错误。
function resolve(session, result) {
  if (!session) return null;
  const r = result || {};
  if (r.ok) {
    session.state = 'done';
    session.result = r;
    session.error = null;
    session.errorCode = null;
    return session;
  }
  session.state = 'error';
  session.error = r.error || '关闭失败，请稍后再试。';
  session.errorCode = r.code || null;
  session.result = r;
  return session;
}

// revision 变化后刷新冻结快照：弹窗保持打开，状态回 open 等待重新确认，
// 但旧挑战已随提交被服务端消费——须重新取挑战后才能再提交（attachChallenge）。
function refreshFrozen(session, snapshot) {
  if (!session || !snapshot) return null;
  session.lockId = String(snapshot.lockId || session.lockId);
  session.revision = typeof snapshot.revision === 'number' ? snapshot.revision : session.revision;
  session.state = 'needs-challenge';
  session.error = session.error || null;
  return session;
}

function attachChallenge(session, challenge, expiresAt) {
  if (!session || !challenge || typeof expiresAt !== 'number') return null;
  session.challenge = String(challenge);
  session.expiresAt = expiresAt;
  if (session.state === 'needs-challenge') session.state = 'open';
  return session;
}

function cancel(session) {
  if (!session) return null;
  session.state = 'done';
  session.result = { ok: false, cancelled: true };
  return session;
}

module.exports = { createConfirmSession, isChallengeExpired, submit, resolve, refreshFrozen, attachChallenge, cancel };
