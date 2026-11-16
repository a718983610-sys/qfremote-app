'use strict';
// L5 RC-09 自检：画质四档＋弱网自降档＋服务端背压（QF-QUALITY-1，复核修订版）。
// 运行：node server/ext/test-l5-quality.js（无外部依赖，退出码 0=通过）。
const {
  createQualitySession, validateTierTable, splitTierChange, TIERS, DEFAULT_TIER_TABLE,
} = require('./quality-core');

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, extra || ''); }
}
const logs = [];
function sess(initialTier, tierTable) {
  return createQualitySession({ log: (e) => logs.push(e), initialTier, tierTable });
}
function probe(q, at, o) {
  return q.ingestProbe(Object.assign({ rttMs: 60, lossPct: 0.2, lossSamples: 100, jitterMs: 10, decodeLagMs: 40, pendingFrames: 2 }, o || {}), at);
}
// 1) 档位表校验：缺档/坏值回退默认并告警；未知档位回退 balanced
{
  const bad = validateTierTable({ version: 99, smooth: { targetKbps: -5 } });
  t('tier-table-fallback', bad.ok === false && bad.table.smooth.targetKbps === DEFAULT_TIER_TABLE.smooth.targetKbps && bad.problems.length > 0, JSON.stringify(bad.problems));
  const q = sess('nope');
  t('unknown-tier-defaults-balanced', q.tier() === 'balanced');
  t('tier-order', TIERS.join(',') === 'smooth,balanced,clear,original');
}
// 2) 档位切换拆分：热可调 vs 需重建
{
  const split = splitTierChange(DEFAULT_TIER_TABLE.balanced, DEFAULT_TIER_TABLE.clear);
  t('split-hot', split.hot.targetKbps === 5000 && split.hot.fecRepairPercent === 15 && !('maxFps' in split.hot), JSON.stringify(split.hot));
  t('split-reconfig', split.reconfig.resolutionScale === 1.0 && !('encoderPreference' in split.reconfig), JSON.stringify(split));
  const split2 = splitTierChange(DEFAULT_TIER_TABLE.clear, DEFAULT_TIER_TABLE.original);
  t('split-reconfig-encoder', split2.reconfig.encoderPreference === 'hevc', JSON.stringify(split2));
}
// 3) 单次尖峰不降档（去抖）：1 次坏样本＋EWMA 平滑后不触发
{
  const q = sess('clear');
  probe(q, 1000);
  const r = probe(q, 2000, { rttMs: 900 }); // 单次严重尖峰
  t('single-spike-no-downgrade', r.decision === null && q.tier() === 'clear', JSON.stringify(r));
}
// 4) 严重坏连续 2 样本即降档（EWMA 下两次严重样本）
{
  const q = sess('clear');
  probe(q, 1000);
  probe(q, 2000, { rttMs: 900, lossPct: 25 });
  const r = probe(q, 3000, { rttMs: 900, lossPct: 25 });
  t('severe-2-samples-downgrade', r.decision === 'downgrade-to' && r.to === 'balanced', JSON.stringify(r));
  t('downgrade-needs-ack', typeof r.decisionId === 'string' && r.mustAckByMs === 3000 + 5000);
  const a = q.ack(r.decisionId, 3200);
  t('ack-ok', a.ok === true && a.tier === 'balanced', JSON.stringify(a));
}
// 5) 一般坏：5s 窗口 ≥3 样本且持续 ≥3s 才降档；不足 3s 不降
{
  const q = sess('clear');
  probe(q, 1000);
  probe(q, 2000, { rttMs: 350 });
  let r = probe(q, 3000, { rttMs: 350 });
  t('general-bad-under-3s-no-downgrade', r.decision === null && q.tier() === 'clear', JSON.stringify(r));
  r = probe(q, 5000, { rttMs: 350 }); // 坏条件自 2000 起持续 3s，窗口内 3 样本
  t('general-bad-3s-downgrade', r.decision === 'downgrade-to' && r.to === 'balanced', JSON.stringify(r));
}
// 6) 降档冷却：5s 内不连降；弱网序列一路降到 smooth 且会话保持
{
  const q = sess('original');
  let at = 1000;
  let last = null;
  for (let i = 0; i < 40; i++) {
    last = probe(q, at, { rttMs: 900, lossPct: 25 });
    at += 1000;
  }
  t('weak-sequence-reaches-smooth', q.tier() === 'smooth', q.tier());
  t('weak-sequence-no-crash-below-smooth', q.tier() === 'smooth' && last.decision === null, JSON.stringify(last));
}
// 7) 恢复不自动升档
{
  const q = sess('clear');
  probe(q, 1000);
  probe(q, 2000, { rttMs: 900, lossPct: 25 });
  probe(q, 3000, { rttMs: 900, lossPct: 25 }); // 降到 balanced
  for (let i = 0; i < 30; i++) probe(q, 4000 + i * 1000); // 30s 健康
  t('no-auto-upgrade', q.tier() === 'balanced');
}
// 8) 手动升档：须 20s 健康窗口；未满足拒绝；满足后一次一档＋观察窗
{
  const q = sess('balanced');
  let r = q.requestUpgrade(1000);
  t('upgrade-no-window-rejected', r.ok === false && r.code === 'NO_HEALTH_WINDOW', JSON.stringify(r));
  for (let i = 0; i < 25; i++) probe(q, 1000 + i * 1000); // 25s 健康样本
  r = q.requestUpgrade(26000);
  t('upgrade-healthy-ok', r.ok === true && r.to === 'clear', JSON.stringify(r));
  // 升档后 10s 观察窗内被降回 → 记一次乒乓
  probe(q, 27000, { rttMs: 900, lossPct: 25 });
  const d = probe(q, 28000, { rttMs: 900, lossPct: 25 });
  t('upgrade-observe-bounce-downgrade', d.decision === 'downgrade-to' && d.to === 'balanced', JSON.stringify(d));
}
// 9) 背压：仅客户端自报不触发；服务端＋客户端交叉才触发；L1 优先
{
  const q = sess('balanced');
  let b = q.backpressure({ pendingFrames: 80, decodeLagMs: 400 }, { queueBytes: 1000 }, 1000);
  t('backpressure-client-only-no-trigger', b.level === null, JSON.stringify(b));
  b = q.backpressure({ pendingFrames: 80, decodeLagMs: 400 }, { queueBytes: 2 * 1024 * 1024 }, 1000);
  t('backpressure-cross-validated-L2', b.level === 'L2', JSON.stringify(b));
  b = q.backpressure({ pendingFrames: 1, decodeLagMs: 40 }, { queueBytes: 2 * 1024 * 1024 }, 1000);
  t('backpressure-server-only-L1', b.level === 'L1' && b.action === 'reduce-fps', JSON.stringify(b));
  b = q.backpressure({ pendingFrames: 80, decodeLagMs: 400, frameCorrupt: true }, { queueBytes: 2 * 1024 * 1024 }, 1000);
  t('backpressure-corrupt-L3', b.level === 'L3' && b.action === 'drop-to-keyframe', JSON.stringify(b));
  // 连续 3 样本客户端堆积（无服务端信号）→ L1（持续异常才信）
  const q2 = sess('balanced');
  probe(q2, 1000, { pendingFrames: 50 });
  probe(q2, 2000, { pendingFrames: 55 });
  probe(q2, 3000, { pendingFrames: 60 });
  b = q2.backpressure({ pendingFrames: 60 }, { queueBytes: 1000 }, 4000);
  t('backpressure-sustained-client-L1', b.level === 'L1', JSON.stringify(b));
}
// 10) ACK 超时记日志；异常上报降权
{
  const q = sess('clear');
  probe(q, 1000);
  probe(q, 2000, { rttMs: 900, lossPct: 25 });
  const r = probe(q, 3000, { rttMs: 900, lossPct: 25 });
  const timedOut = q.sweepAcks(9000);
  t('ack-timeout-logged', timedOut.includes(r.decisionId) && logs.some((e) => e.ev === 'quality-ack-timeout'));
  probe(q, 10000, { rttMs: -5, lossPct: 500 }); // 非法上报
  t('bad-probe-downweighted', logs.some((e) => e.ev === 'quality-probe-downweighted'));
}
// 11) 乒乓冷却：同一目标档 60s 内 2 次升档后 10s 内被降回 → 冷却 60s
{
  const q = sess('balanced');
  for (let round = 0; round < 2; round++) {
    const base = 1000 + round * 30000;
    for (let i = 0; i < 25; i++) probe(q, base + i * 1000);
    const up = q.requestUpgrade(base + 25000);
    if (!up.ok) { t('pingpong-round-upgrade-' + round, false, JSON.stringify(up)); break; }
    probe(q, base + 26000, { rttMs: 900, lossPct: 25 });
    probe(q, base + 27000, { rttMs: 900, lossPct: 25 });
    if (round === 1) {
      for (let i = 0; i < 25; i++) probe(q, base + 28000 + i * 1000);
      const up2 = q.requestUpgrade(base + 53000);
      t('pingpong-cooldown-blocks-upgrade', up2.ok === false && up2.code === 'PINGPONG_COOLDOWN', JSON.stringify(up2));
    }
  }
}

console.log(`\nRC-09 quality: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
