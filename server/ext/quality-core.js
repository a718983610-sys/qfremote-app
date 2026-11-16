'use strict';
/*
 * QFRemote 扩展服务 · L5 RC-09：画质四档＋弱网自降档＋服务端背压（协议 QF-QUALITY-1）
 * =================================================================================
 * 大肥鱼复核裁决（2026-11-15，原文 l5-evidence/ds-review-rc03-rc09-20261115.md）：
 * “连续 2 次变差即降档”过于敏感；探针周期/判定窗口未定义；pendingFrames
 * 客户端自报不可作为唯一背压依据；drop-to-keyframe 不应优先于 reduce-fps；
 * 手动升档需要滞回和冷却；“档位切换即时不重连”对编码器偏好/分辨率是错误假设。
 *
 * 落地数值（全部来自复核意见原文）：
 *   - 探针周期：正常 1s；弱网/切换后 10s 内 500ms；页面隐藏 5s（周期由客户
 *     端执行，服务端只按收到样本的时间戳判定）。
 *   - rtt/loss 用 EWMA（α=0.3）；lossPct 须 1s 窗口且 ≥50 包，区分上行/下行。
 *   - 一般坏（rtt>300 或 loss>5% 或 jitter>50ms）：5s 窗口内 ≥3 样本且
 *     持续 ≥3s 才降档；严重坏（rtt>800 或 loss>20% 或 decodeLag>500ms）：
 *     连续 2 样本即降档；降档冷却 5s（连续恶化时每 3s 最多降一档）。
 *   - 恢复不自动升档；手动升档健康条件 rtt<150、loss<1%、jitter<30ms、
 *     decodeLag<150ms 持续 20s，一次只升一档，升档后 10s 观察窗；同一
 *     目标档 60s 内 2 次“升档后 10s 内被降回”则该档冷却 60s。
 *   - 背压分级：L1 reduce-fps 优先 → L2 降分辨率/码率 → L3
 *     drop-to-keyframe＋受控 IDR（进 RC-03 限流）。决策须服务端独立
 *     信号（WS bufferedAmount/发送队列高水位）与客户端上报交叉验证，
 *     或连续 3 样本异常；客户端自报单字段不直接触发；异常上报降权并记录。
 *   - 档位参数分“热可调”（目标码率、帧率上限、FEC repairPercent，关键帧/
 *     块边界切换）与“需重建”（分辨率缩放、编码器偏好，切换触发 IDR、
 *     接收端清旧参考帧）。不再宣称“全部即时无感”。
 *   - config.json 档位表须 schema 校验＋版本＋默认回退＋每会话参数快照；
 *     未知档位回退默认档并告警；downgrade-to 须客户端执行＋ACK（含超时）。
 *
 * 本模块是纯状态机（时间由调用方注入 nowMs）；不直接碰编码器——决策
 * 由调用方（server.js / agent 通道）执行，客户端 ACK 由调用方回填。
 */
const TIERS = ['smooth', 'balanced', 'clear', 'original'];
const DEFAULT_TIER = 'balanced';
const QUALITY_CONFIG_VERSION = 1;
const EWMA_ALPHA = 0.3;
// 档位默认参数（config.json 可覆盖；数值是服务端默认值，非实测最优）
const DEFAULT_TIER_TABLE = {
  smooth: { targetKbps: 800, maxFps: 15, fecRepairPercent: 5, resolutionScale: 0.5, encoderPreference: 'h264' },
  balanced: { targetKbps: 2500, maxFps: 30, fecRepairPercent: 10, resolutionScale: 0.75, encoderPreference: 'h264' },
  clear: { targetKbps: 5000, maxFps: 30, fecRepairPercent: 15, resolutionScale: 1.0, encoderPreference: 'h264' },
  original: { targetKbps: 12000, maxFps: 60, fecRepairPercent: 20, resolutionScale: 1.0, encoderPreference: 'hevc' },
};
const HOT_KEYS = ['targetKbps', 'maxFps', 'fecRepairPercent'];
const RECONFIG_KEYS = ['resolutionScale', 'encoderPreference'];

const BAD = { rttMs: 300, lossPct: 5, jitterMs: 50 };
const SEVERE = { rttMs: 800, lossPct: 20, decodeLagMs: 500 };
const HEALTHY = { rttMs: 150, lossPct: 1, jitterMs: 30, decodeLagMs: 150 };
const HEALTHY_WINDOW_MS = 20000;
const DOWNGRADE_COOLDOWN_MS = 5000;
const DOWNGRADE_MIN_INTERVAL_MS = 3000;
const UPGRADE_OBSERVE_MS = 10000;
const PINGPONG_WINDOW_MS = 60000;
const PINGPONG_COOLDOWN_MS = 60000;
const ACK_TIMEOUT_MS = 5000;
// 服务端独立背压信号阈值（WS bufferedAmount 字节数，可配）
const SERVER_QUEUE_HIGH_BYTES = 512 * 1024;
const CLIENT_PENDING_HIGH = 30;

function validateTierTable(table) {
  const problems = [];
  if (!table || typeof table !== 'object') return { ok: false, table: DEFAULT_TIER_TABLE, problems: ['tier-table-missing'] };
  if (table.version !== QUALITY_CONFIG_VERSION) problems.push('version-mismatch');
  const out = {};
  for (const tier of TIERS) {
    const row = table[tier];
    if (!row || typeof row !== 'object') { problems.push('tier-missing:' + tier); out[tier] = Object.assign({}, DEFAULT_TIER_TABLE[tier]); continue; }
    const r = Object.assign({}, DEFAULT_TIER_TABLE[tier]);
    for (const k of ['targetKbps', 'maxFps', 'fecRepairPercent', 'resolutionScale']) {
      if (Number.isFinite(Number(row[k])) && Number(row[k]) > 0) r[k] = Number(row[k]);
      else problems.push('tier-bad-value:' + tier + '.' + k);
    }
    if (typeof row.encoderPreference === 'string' && row.encoderPreference) r.encoderPreference = row.encoderPreference;
    out[tier] = r;
  }
  return { ok: problems.length === 0, table: out, problems };
}

// 档位切换拆分：返回 { hot: {...}, reconfig: {...} }；reconfig 非空时
// 调用方须触发 IDR＋接收端清旧参考帧（不能宣称无感）。
function splitTierChange(fromParams, toParams) {
  const hot = {};
  const reconfig = {};
  for (const k of HOT_KEYS) if (fromParams[k] !== toParams[k]) hot[k] = toParams[k];
  for (const k of RECONFIG_KEYS) if (fromParams[k] !== toParams[k]) reconfig[k] = toParams[k];
  return { hot, reconfig };
}

function createQualitySession(opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const tableCheck = validateTierTable(o.tierTable);
  if (tableCheck.problems.length) log({ ev: 'quality-config-fallback', problems: tableCheck.problems });
  const table = tableCheck.table;
  let tier = TIERS.includes(o.initialTier) ? o.initialTier : DEFAULT_TIER;
  const snapshot = JSON.parse(JSON.stringify(table[tier])); // 每会话参数快照
  const samples = []; // { at, rttMs, lossPct, lossSamples, jitterMs, decodeLagMs, pendingFrames, serverQueueBytes, dir }
  let ewma = { rttMs: null, lossPct: null, jitterMs: null };
  let lastDowngradeAt = 0;
  let lastDecisionAt = 0;
  let severeStreak = 0;
  let badSince = 0; // 一般坏条件首次满足的时间戳
  let lastUpgradeAt = 0;
  let upgradeTarget = null;
  let upgradeObserveUntil = 0;
  let bounceCount = {}; // tier -> { count, windowStart }
  let pingpongCooldownUntil = {}; // tier -> timestamp
  let pendingAcks = new Map(); // decisionId -> { tier, at, kind }
  let decisionSeq = 0;

  function isBad(s) {
    return s.rttMs > BAD.rttMs || s.lossPct > BAD.lossPct || s.jitterMs > BAD.jitterMs;
  }
  function isSevere(s) {
    return s.rttMs > SEVERE.rttMs || s.lossPct > SEVERE.lossPct || (Number.isFinite(s.decodeLagMs) && s.decodeLagMs > SEVERE.decodeLagMs);
  }
  function isHealthy(s) {
    return s.rttMs < HEALTHY.rttMs && s.lossPct < HEALTHY.lossPct && s.jitterMs < HEALTHY.jitterMs
      && (!Number.isFinite(s.decodeLagMs) || s.decodeLagMs < HEALTHY.decodeLagMs);
  }
  function prune(nowMs) {
    while (samples.length && nowMs - samples[0].at > 30000) samples.shift();
  }
  // 校验上报值范围；异常上报降权（记日志，不直接采信）
  function sanitize(p) {
    const s = {
      rttMs: Number(p.rttMs), lossPct: Number(p.lossPct),
      lossSamples: Number(p.lossSamples), jitterMs: Number(p.jitterMs),
      decodeLagMs: Number(p.decodeLagMs), pendingFrames: Number(p.pendingFrames),
      serverQueueBytes: Number(p.serverQueueBytes),
    };
    const bad = [];
    if (!(s.rttMs >= 0 && s.rttMs <= 10000)) bad.push('rttMs');
    if (!(s.lossPct >= 0 && s.lossPct <= 100)) bad.push('lossPct');
    if (!(s.jitterMs >= 0 && s.jitterMs <= 5000)) bad.push('jitterMs');
    if (Number.isFinite(s.decodeLagMs) && !(s.decodeLagMs >= 0 && s.decodeLagMs <= 10000)) bad.push('decodeLagMs');
    if (Number.isFinite(s.pendingFrames) && !(s.pendingFrames >= 0 && s.pendingFrames <= 10000)) bad.push('pendingFrames');
    if (Number.isFinite(s.serverQueueBytes) && !(s.serverQueueBytes >= 0 && s.serverQueueBytes <= 64 * 1024 * 1024)) bad.push('serverQueueBytes');
    if (Number.isFinite(s.lossSamples) && s.lossSamples < 50) bad.push('lossSamples<50');
    return { s, bad };
  }

  function ingestProbe(p, nowMs) {
    const { s, bad } = sanitize(p);
    if (bad.length) log({ ev: 'quality-probe-downweighted', bad });
    if (!Number.isFinite(s.rttMs) || !Number.isFinite(s.lossPct) || !Number.isFinite(s.jitterMs)) {
      return { decision: null, reason: 'probe-incomplete' };
    }
    samples.push(Object.assign({ at: nowMs }, s));
    prune(nowMs);
    for (const k of ['rttMs', 'lossPct', 'jitterMs']) {
      ewma[k] = ewma[k] === null ? s[k] : EWMA_ALPHA * s[k] + (1 - EWMA_ALPHA) * ewma[k];
    }
    // 判定用原始样本：去抖靠“计数＋持续时间＋冷却”（≥3 坏样本且持续
    // ≥3s / 严重连续 2 样本），不靠 EWMA 压阈值——EWMA 平滑会让严重
    // 值永远到不了阈值（实测教训）。EWMA 只作遥测（ewma() 暴露）。
    // 严重坏：连续 2 样本即降档
    if (isSevere(s)) {
      severeStreak += 1;
    } else {
      severeStreak = 0;
    }
    if (isBad(s)) {
      if (!badSince) badSince = nowMs;
    } else {
      badSince = 0;
    }
    // 升档观察窗内被降档 → 记一次乒乓
    const downgrade = decideDowngrade(nowMs, s);
    if (downgrade) return downgrade;
    return { decision: null, reason: 'hold' };
  }

  function decideDowngrade(nowMs, eff) {
    if (tier === 'smooth') return null;
    const recent5s = samples.filter((x) => nowMs - x.at <= 5000);
    const badCount = recent5s.filter((x) => isBad(x)).length;
    const severeReady = severeStreak >= 2;
    const generalReady = badCount >= 3 && badSince && nowMs - badSince >= 3000;
    if (!severeReady && !generalReady) return null;
    const minInterval = severeReady ? DOWNGRADE_MIN_INTERVAL_MS : DOWNGRADE_COOLDOWN_MS;
    if (nowMs - lastDowngradeAt < minInterval) return null;
    // 升档观察窗内被降档 → 乒乓计数
    if (upgradeTarget && nowMs < upgradeObserveUntil) {
      const b = bounceCount[upgradeTarget] || { count: 0, windowStart: nowMs };
      if (nowMs - b.windowStart > PINGPONG_WINDOW_MS) { b.count = 0; b.windowStart = nowMs; }
      b.count += 1;
      bounceCount[upgradeTarget] = b;
      if (b.count >= 2) {
        pingpongCooldownUntil[upgradeTarget] = nowMs + PINGPONG_COOLDOWN_MS;
        log({ ev: 'quality-pingpong-cooldown', tier: upgradeTarget, untilMs: pingpongCooldownUntil[upgradeTarget] });
      }
      upgradeTarget = null;
      upgradeObserveUntil = 0;
    }
    const from = tier;
    tier = TIERS[TIERS.indexOf(tier) - 1];
    lastDowngradeAt = nowMs;
    lastDecisionAt = nowMs;
    const split = splitTierChange(table[from], table[tier]);
    const id = 'qd_' + (++decisionSeq);
    pendingAcks.set(id, { tier, at: nowMs, kind: 'downgrade' });
    log({ ev: 'quality-downgrade', from, to: tier, severe: severeReady, hot: split.hot, reconfig: split.reconfig });
    return {
      decision: 'downgrade-to', decisionId: id, from, to: tier,
      hot: split.hot, reconfig: split.reconfig,
      mustAckByMs: nowMs + ACK_TIMEOUT_MS,
      needsIdr: Object.keys(split.reconfig).length > 0,
    };
  }

  function requestUpgrade(nowMs) {
    if (tier === 'original') return { ok: false, code: 'AT_TOP', msg: '已是最高档。' };
    const target = TIERS[TIERS.indexOf(tier) + 1];
    if (nowMs < (pingpongCooldownUntil[target] || 0)) {
      return { ok: false, code: 'PINGPONG_COOLDOWN', msg: '该档近期反复升降，冷却中。', retryAfterMs: pingpongCooldownUntil[target] - nowMs };
    }
    prune(nowMs);
    const window = samples.filter((x) => nowMs - x.at <= HEALTHY_WINDOW_MS);
    if (window.length < 5) return { ok: false, code: 'NO_HEALTH_WINDOW', msg: '健康窗口样本不足（需 20s 健康样本）。' };
    if (!window.every(isHealthy)) {
      return { ok: false, code: 'NOT_HEALTHY', msg: '网络未持续健康 20s（rtt<150、loss<1%、jitter<30ms、decodeLag<150ms），暂不升档。' };
    }
    const from = tier;
    tier = target;
    lastUpgradeAt = nowMs;
    upgradeTarget = target;
    upgradeObserveUntil = nowMs + UPGRADE_OBSERVE_MS;
    const split = splitTierChange(table[from], table[tier]);
    const id = 'qd_' + (++decisionSeq);
    pendingAcks.set(id, { tier, at: nowMs, kind: 'upgrade' });
    log({ ev: 'quality-upgrade', from, to: tier });
    return {
      ok: true, decision: 'upgrade-to', decisionId: id, from, to: tier,
      hot: split.hot, reconfig: split.reconfig,
      mustAckByMs: nowMs + ACK_TIMEOUT_MS,
      needsIdr: Object.keys(split.reconfig).length > 0,
    };
  }

  // 背压决策：服务端独立信号＋客户端上报交叉验证，或连续 3 样本异常。
  // serverSignal：{ queueBytes, sendBlockedMs }（服务端实测，如 WS bufferedAmount）。
  function backpressure(client, serverSignal, nowMs) {
    const serverHigh = serverSignal && (
      (Number.isFinite(serverSignal.queueBytes) && serverSignal.queueBytes > SERVER_QUEUE_HIGH_BYTES)
      || (Number.isFinite(serverSignal.sendBlockedMs) && serverSignal.sendBlockedMs > 500));
    const clientHigh = client && (
      (Number.isFinite(client.pendingFrames) && client.pendingFrames > CLIENT_PENDING_HIGH)
      || (Number.isFinite(client.decodeLagMs) && client.decodeLagMs > 300));
    const clientCorrupt = !!(client && client.frameCorrupt);
    const recent = samples.slice(-3);
    const sustained = recent.length >= 3 && recent.every((x) =>
      (Number.isFinite(x.pendingFrames) && x.pendingFrames > CLIENT_PENDING_HIGH)
      || (Number.isFinite(x.decodeLagMs) && x.decodeLagMs > 300));
    if (clientCorrupt && (serverHigh || clientHigh)) {
      return { level: 'L3', action: 'drop-to-keyframe', note: '参考链已损坏，丢弃直到关键帧＋受控 IDR。' };
    }
    if (serverHigh && clientHigh) {
      return { level: 'L2', action: 'reduce-resolution-bitrate', note: '服务端队列高＋客户端堆积，降分辨率/码率。' };
    }
    if (serverHigh || sustained) {
      return { level: 'L1', action: 'reduce-fps', note: '先降生产速率（reduce-fps 优先于 drop-to-keyframe）。' };
    }
    if (clientHigh) {
      log({ ev: 'quality-backpressure-hint-only', note: '仅客户端自报堆积，未达交叉验证，不触发背压。' });
      return { level: null, action: null, note: '仅客户端自报，未交叉验证，不触发。' };
    }
    return { level: null, action: null, note: '无背压。' };
  }

  function ack(decisionId, nowMs) {
    const p = pendingAcks.get(decisionId);
    if (!p) return { ok: false, code: 'UNKNOWN_DECISION' };
    pendingAcks.delete(decisionId);
    return { ok: true, tier: p.tier, kind: p.kind, rttMs: nowMs - p.at };
  }
  function sweepAcks(nowMs) {
    const timedOut = [];
    for (const [id, p] of pendingAcks) {
      if (nowMs - p.at > ACK_TIMEOUT_MS) {
        timedOut.push(id);
        pendingAcks.delete(id);
        log({ ev: 'quality-ack-timeout', decisionId: id, tier: p.tier, kind: p.kind });
      }
    }
    return timedOut;
  }

  return {
    tier: () => tier, params: () => table[tier], snapshot: () => snapshot,
    table: () => table, ewma: () => Object.assign({}, ewma),
    ingestProbe, requestUpgrade, backpressure, ack, sweepAcks,
    pendingAcks: () => Array.from(pendingAcks.keys()),
  };
}

module.exports = {
  createQualitySession, validateTierTable, splitTierChange,
  TIERS, DEFAULT_TIER, DEFAULT_TIER_TABLE, QUALITY_CONFIG_VERSION,
  BAD, SEVERE, HEALTHY,
};
