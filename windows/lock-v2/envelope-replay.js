'use strict';
/*
 * QFRemote 隐私锁 v2 · 信封去重守卫（B 线，阶段 3 P3-04 #8）
 * ================================================================
 * 镜像旧 Go ProcessEnvelope 的去重语义（envelope.go，只读参考，
 * 绝不打补丁；本模块是 v2 新组件的 JS 实现）：
 *   - 校验顺序：重放先查 → 签名/时效/节点 → 分发执行。
 *   - 已处理信封 id 记入集合（上限 64 条，超限丢弃最旧的，与 Go
 *     ProcessedEnvelopeIDs 的 64 条上限同口径）。
 *   - 重复信封必拒：返回 { replay: true }，调用方必须不执行任何
 *     副作用，并写一条 envelope-rejected（reason=replay）审计事件。
 *   - 只有执行成功（r.OK）后才记 id：失败的信封不记，同一 id 可重试
 *     （与 Go remember() 只在 r.OK 时调用同口径；失败重试不算重放）。
 *   - 本守卫只管“同一信封 id 是否已成功执行过”；状态机本身另有
 *     第二道防线（disarm 只在 LOCKED/LOCKING 时产生副作用，已解锁
 *     时返回幂等 disarm_idempotent，不重复改状态、不升 revision）。
 */
const MAX_SEEN = 64;

const CODE_REPLAY = 'E_ENVELOPE_REPLAY';

class EnvelopeReplayGuard {
  constructor(opts) {
    const o = opts || {};
    this.maxSeen = o.maxSeen || MAX_SEEN;
    this.seen = []; // 按成功顺序记 id
  }

  has(id) {
    if (!id) return false;
    return this.seen.includes(id);
  }

  // 执行前调用：已见过 → 必拒，调用方不得执行副作用。
  check(id) {
    if (!id) return { replay: false, reason: 'no-id' };
    if (this.has(id)) return { replay: true, reason: 'replay', code: CODE_REPLAY };
    return { replay: false };
  }

  // 执行成功后调用：记下 id。失败不记（可重试）。
  remember(id) {
    if (!id) return false;
    if (this.has(id)) return false;
    this.seen.push(id);
    if (this.seen.length > this.maxSeen) this.seen = this.seen.slice(-this.maxSeen);
    return true;
  }

  count() { return this.seen.length; }
  ids() { return this.seen.slice(); }
}

module.exports = { EnvelopeReplayGuard, MAX_SEEN, CODE_REPLAY };
