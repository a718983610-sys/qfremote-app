'use strict';
/*
 * QFRemote Windows 运行端 — RC-09 画质四档＋探针＋ACK＋背压（3.0.0）
 * ==================================================================
 * 依据：QF-QUALITY-1 客户端协议规范 v1（server/ext/QF-QUALITY-1-CLIENT-SPEC.md）
 * 全文。服务端判定见 server/ext/quality-core.js；路由见 server/ext/server.js
 * （POST /license/api/session/probe、/quality/upgrade、/quality/ack）。
 *
 * 档位表（规范 §1，服务端默认值；config.json 可覆盖，客户端以探针响应
 * 的 tier 与决策的 hot/reconfig 为准，不用快照推断档位，规范 §6.6）：
 *   smooth 800kbps/15fps/fec5%/0.5x/h264；balanced 2500/30/10%/0.75x/h264
 *   （默认档）；clear 5000/30/15%/1.0x/h264；original 12000/60/20%/1.0x/hevc。
 * 参数分两类：热可调（targetKbps/maxFps/fecRepairPercent，关键帧/块边界
 * 生效）与需重建（resolutionScale/encoderPreference，触发 IDR＋接收端
 * 清旧参考帧）。不再宣称“全部即时无感”。
 *
 * 探针（规范 §2.3）：正常 1s；弱网或档位切换后 10s 内 500ms；页面/应用
 * 隐藏时 5s。lossPct 指观看端下行（服务端→观看端）丢包，1s 窗口且
 * lossSamples ≥ 50 才采信；不足 50 包服务端只记降权日志、不直接拒收。
 * 探针缺 rttMs/lossPct/jitterMs 任一（非有限数）→ 服务端 probe-incomplete、
 * 该样本不入库——客户端先校验再上报（规范 §6.5：不得依赖服务端清洗）。
 * 值域外字段服务端只记降权日志、样本仍入库；客户端同样先校验、记本地
 * 降权日志再上报。
 *
 * 降档/升档（规范 §3–§4）：判定在服务端（原始样本判定，EWMA 只作遥测）；
 * 客户端只执行。收到 downgrade-to / upgrade-to 后：先执行 hot，再执行
 * reconfig（needsIdr 为真时发 IDR reason=quality-change 并清旧参考帧），
 * 执行完成后 5s 内 ACK（mustAckByMs）。执行失败时保持旧档位、记本地
 * 日志，不伪造 ACK（规范 §4.3：ACK 只有“收到并执行”一种语义，没有
 * “执行失败”分支）。ACK 超时只记日志、不重发（规范 §6.4：服务端
 * sweepAcks 只记 quality-ack-timeout 并清除待 ACK 项，不重发决策；
 * 客户端不得等服务端重发，须自己在 mustAckByMs 前 ACK）。
 * 网络恢复后不自动升档（须用户手动升档，见 requestUpgrade）。
 * 档位切换不重连会话。
 *
 * 背压（规范 §5）：L1 reduce-fps → L2 reduce-resolution-bitrate →
 * L3 drop-to-keyframe＋受控 IDR（reason=loss，进 QF-VIDEO-1 限流）。
 * 仅客户端自报堆积不触发背压（level null）：客户端不得擅自降档。
 * 背压不是档位决策，不产生 decisionId、不须 ACK。
 *
 * 跨协议待定项（规范 §6.1）：档位表 fecRepairPercent 10%/15% 在 FEC 层
 * 没有对应档位（QF-VIDEO-1 只有 5% 与 20% 两档）。映射见 qf-fec.js 的
 * fecTierForRepairPercent：≤5% 用 k=20/m=1，≥20% 用 k=10/m=2，中间值
 * 待定——本模块收到中间值时记本地日志、保持当前 FEC 档位，不发明第
 * 三种 (k,m) 组合。
 */
const fecMod = require('./qf-fec');
const PROBE_PATH = '/license/api/session/probe';
const UPGRADE_PATH = '/license/api/session/quality/upgrade';
const ACK_PATH = '/license/api/session/quality/ack';
const TIERS = ['smooth', 'balanced', 'clear', 'original'];
const DEFAULT_TIER = 'balanced';
const DEFAULT_TIER_TABLE = {
  smooth: { targetKbps: 800, maxFps: 15, fecRepairPercent: 5, resolutionScale: 0.5, encoderPreference: 'h264' },
  balanced: { targetKbps: 2500, maxFps: 30, fecRepairPercent: 10, resolutionScale: 0.75, encoderPreference: 'h264' },
  clear: { targetKbps: 5000, maxFps: 30, fecRepairPercent: 15, resolutionScale: 1.0, encoderPreference: 'h264' },
  original: { targetKbps: 12000, maxFps: 60, fecRepairPercent: 20, resolutionScale: 1.0, encoderPreference: 'hevc' }
};
const HOT_KEYS = ['targetKbps', 'maxFps', 'fecRepairPercent'];
const RECONFIG_KEYS = ['resolutionScale', 'encoderPreference'];
const BAD = { rttMs: 300, lossPct: 5, jitterMs: 50 };
const SEVERE = { rttMs: 800, lossPct: 20, decodeLagMs: 500 };
const HEALTHY = { rttMs: 150, lossPct: 1, jitterMs: 30, decodeLagMs: 150 };
const ACK_TIMEOUT_MS = 5000;
const PROBE_INTERVAL_MS = { normal: 1000, weak: 500, hidden: 5000 };
const WEAK_WINDOW_AFTER_SWITCH_MS = 10000; // 档位切换后 10s 内探针 500ms
const UPGRADE_REFUSAL_MESSAGES = {
  AT_TOP: '已是最高档',
  FORBIDDEN: '会话不属于当前用户',
  NO_HEALTH_WINDOW: '健康窗口样本不足（需 20s 健康样本，≥5 个）',
  NOT_HEALTHY: '网络未持续健康 20s，暂不升档',
  PINGPONG_COOLDOWN: '该档近期反复升降，冷却中'
};

// 档位切换拆分（与服务端 splitTierChange 同款逻辑）。
function splitTierChange(fromParams, toParams) {
  const hot = {};
  const reconfig = {};
  for (const k of HOT_KEYS) if (fromParams[k] !== toParams[k]) hot[k] = toParams[k];
  for (const k of RECONFIG_KEYS) if (fromParams[k] !== toParams[k]) reconfig[k] = toParams[k];
  return { hot, reconfig };
}
function isHealthyProbe(p) {
  if (!p || typeof p !== 'object') return false;
  if (!(Number(p.rttMs) < HEALTHY.rttMs)) return false;
  if (!(Number(p.lossPct) < HEALTHY.lossPct)) return false;
  if (!(Number(p.jitterMs) < HEALTHY.jitterMs)) return false;
  if (Number.isFinite(Number(p.decodeLagMs)) && !(Number(p.decodeLagMs) < HEALTHY.decodeLagMs)) return false;
  return true;
}
// 探针周期（规范 §2.3）：隐藏 5s > 弱网/切换后 10s 内 500ms > 正常 1s。
function probeIntervalMs(state) {
  const s = state || {};
  if (s.hidden) return PROBE_INTERVAL_MS.hidden;
  if (s.weak) return PROBE_INTERVAL_MS.weak;
  return PROBE_INTERVAL_MS.normal;
}

// 探针客户端校验（规范 §2.3／§6.5）：缺必填字段（rttMs/lossPct/
// jitterMs 任一非有限数）→ 不发（服务端会判 probe-incomplete、不入库）；
// 值域外或 lossSamples<50 → 仍发，但记 downweighted（服务端同样只记
// 降权日志、不钳制、不丢弃）。lossPct 只报观看端下行丢包，不取上下行平均。
function validateProbe(p) {
  if (!p || typeof p !== 'object') return { ok: false, reason: 'probe-incomplete' };
  const rttMs = Number(p.rttMs);
  const lossPct = Number(p.lossPct);
  const jitterMs = Number(p.jitterMs);
  if (!Number.isFinite(rttMs) || !Number.isFinite(lossPct) || !Number.isFinite(jitterMs)) {
    return { ok: false, reason: 'probe-incomplete' };
  }
  const downweighted = [];
  if (!(rttMs >= 0 && rttMs <= 10000)) downweighted.push('rttMs');
  if (!(lossPct >= 0 && lossPct <= 100)) downweighted.push('lossPct');
  if (!(jitterMs >= 0 && jitterMs <= 5000)) downweighted.push('jitterMs');
  if (Number.isFinite(Number(p.decodeLagMs)) && !(Number(p.decodeLagMs) >= 0 && Number(p.decodeLagMs) <= 10000)) downweighted.push('decodeLagMs');
  if (Number.isFinite(Number(p.pendingFrames)) && !(Number(p.pendingFrames) >= 0 && Number(p.pendingFrames) <= 10000)) downweighted.push('pendingFrames');
  if (Number.isFinite(Number(p.serverQueueBytes)) && !(Number(p.serverQueueBytes) >= 0 && Number(p.serverQueueBytes) <= 64 * 1024 * 1024)) downweighted.push('serverQueueBytes');
  if (Number.isFinite(Number(p.lossSamples)) && Number(p.lossSamples) < 50) downweighted.push('lossSamples<50');
  return { ok: true, downweighted };
}

function createQualityClient(opts) {
  const o = opts || {};
  if (typeof o.request !== 'function') throw new Error('qf-quality: request 注入缺失');
  if (typeof o.baseUrl !== 'string' || !o.baseUrl) throw new Error('qf-quality: baseUrl 缺失');
  const request = o.request;
  const baseUrl = String(o.baseUrl).replace(/\/+$/, '');
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const timer = o.timer || { setTimeout: setTimeout, clearTimeout: clearTimeout };
  // idrSender：qf-idr.js 实例（L3 缺省接线时由 qf-protocol.js 注入；
  // 未注入时 needsIdr 的 IDR 发不出去——记日志、不静默当作已发）。
  const idrSender = o.idrSender || null;
  // applyParams(kind, params)：编码器参数执行器（agent 侧/渲染层注入；
  // 未注入时只记本地已应用参数，不碰编码器、不假装已生效）。
  // 返回 true=执行成功，false=执行失败（编码器拒绝重配）。
  const applyParams = typeof o.applyParams === 'function'
    ? o.applyParams
    : (kind, params) => { appliedParams[kind] = Object.assign({}, appliedParams[kind], params); return true; };
  const onClearReferenceFrames = typeof o.onClearReferenceFrames === 'function' ? o.onClearReferenceFrames : () => {};
  const onDropToKeyframe = typeof o.onDropToKeyframe === 'function' ? o.onDropToKeyframe : () => {};
  const onTierChange = typeof o.onTierChange === 'function' ? o.onTierChange : () => {};

  let sessionId = typeof o.sessionId === 'string' ? o.sessionId : '';
  let tier = TIERS.indexOf(o.initialTier) >= 0 ? o.initialTier : DEFAULT_TIER;
  let appliedParams = { hot: {}, reconfig: {}, backpressure: {} };
  // F-WIN-05（2026-11-15）：初始档 balanced 的 fecRepairPercent=10 在
  // fecTierForRepairPercent 里无映射（规范 §6.1 待定），初始化回落
  // 'high'（k=10/m=2，20% 保护）与档位表宣称的 10% 不符——初始化
  // 时即记日志，不只在收到 hot 参数时才记。
  const _initFec = fecMod.fecTierForRepairPercent(DEFAULT_TIER_TABLE[tier].fecRepairPercent);
  let appliedFecTier = _initFec.ok ? _initFec.tier : 'high';
  if (!_initFec.ok) log('quality.fec-repair-unmapped init tier=' + tier + ' pct=' + DEFAULT_TIER_TABLE[tier].fecRepairPercent + ' keep=' + appliedFecTier);
  let pendingAck = null; // { decisionId, mustAckByMs, kind, timer }
  let ackedUnknown = new Set(); // UNKNOWN_DECISION 的 id，不再重试
  let lastSwitchAt = 0;
  let lastProbeAt = 0;
  let lastProbeHealthy = false;
  let lastBackpressure = null;
  let lastDecision = null;
  let lastUpgradeError = null; // { code, message, retryAfterMs }
  let probeTimer = null;
  let hidden = false;

  function errorCodeOf(json) {
    if (json && typeof json.code === 'string' && json.code) return json.code;
    return '';
  }

  // ACK 超时本地清扫：只记日志、不重发（规范 §6.4）。
  function clearPendingAckTimeout() {
    if (pendingAck && pendingAck.timer !== null && pendingAck.timer !== undefined) {
      try { timer.clearTimeout(pendingAck.timer); } catch (e) { /* ignore */ }
    }
  }
  function armAckTimeout() {
    clearPendingAckTimeout();
    if (!pendingAck) return;
    const wait = Math.max(0, pendingAck.mustAckByMs - nowMs());
    pendingAck.timer = timer.setTimeout(() => {
      const timedOut = pendingAck;
      pendingAck = null;
      log('quality.ack-timeout decisionId=' + timedOut.decisionId);
    }, wait);
    if (pendingAck.timer && typeof pendingAck.timer.unref === 'function') {
      try { pendingAck.timer.unref(); } catch (e) { /* ignore */ }
    }
  }

  async function sendAck(decisionId) {
    if (!decisionId || ackedUnknown.has(decisionId)) {
      return { ok: false, kind: 'unknown-decision', code: 'UNKNOWN_DECISION' };
    }
    let res;
    try {
      res = await request('POST', baseUrl + ACK_PATH, { sessionId, decisionId });
    } catch (e) {
      return { ok: false, kind: 'network' };
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 503 && json && json.code === 'L5_UNAVAILABLE') return { ok: false, kind: 'unavailable', code: 'L5_UNAVAILABLE' };
    if (status === 200 && json && json.ok === true) {
      if (pendingAck && pendingAck.decisionId === decisionId) {
        clearPendingAckTimeout();
        pendingAck = null;
      }
      return { ok: true, tier: json.tier, kind: json.kind, rttMs: json.rttMs };
    }
    const code = errorCodeOf(json);
    if (code === 'UNKNOWN_DECISION') {
      // 未知 decisionId：不得重试同一 decisionId。
      ackedUnknown.add(decisionId);
      if (pendingAck && pendingAck.decisionId === decisionId) {
        clearPendingAckTimeout();
        pendingAck = null;
      }
      return { ok: false, kind: 'unknown-decision', code };
    }
    return { ok: false, kind: 'rejected', code };
  }

  // 执行一条档位决策（downgrade-to / upgrade-to）：hot 先行、reconfig
  // 其后、needsIdr 时发 IDR 并清旧参考帧、最后 5s 内 ACK。执行失败
  // （编码器拒绝重配）时保持旧档位、不发 ACK（规范 §4.3）。
  async function executeDecision(d) {
    if (!d || (d.decision !== 'downgrade-to' && d.decision !== 'upgrade-to')) {
      return { ok: false, kind: 'bad-decision' };
    }
    // 收到新决策前先把旧决策的 ACK 发掉，不得堆积多个未 ACK 决策。
    if (pendingAck && pendingAck.decisionId !== d.decisionId) {
      await sendAck(pendingAck.decisionId);
    }
    const from = tier;
    const to = TIERS.indexOf(d.to) >= 0 ? d.to : tier;
    const hot = (d.hot && typeof d.hot === 'object') ? d.hot : {};
    const reconfig = (d.reconfig && typeof d.reconfig === 'object') ? d.reconfig : {};
    // hot 参数：下一关键帧/块边界生效。
    if (Object.keys(hot).length) {
      if (applyParams('hot', hot) === false) {
        log('quality.apply-failed kind=hot tier=' + from);
        return { ok: false, kind: 'apply-failed', tier: from };
      }
    }
    // fecRepairPercent 中间值映射待定（规范 §6.1）：10%/15% 不发明 (k,m)。
    if (Number.isFinite(Number(hot.fecRepairPercent))) {
      const mapped = fecMod.fecTierForRepairPercent(Number(hot.fecRepairPercent));
      if (mapped.ok) appliedFecTier = mapped.tier;
      else log('quality.fec-repair-unmapped pct=' + hot.fecRepairPercent + ' keep=' + appliedFecTier);
    }
    // reconfig 参数：编码器重配；needsIdr 时发 IDR 并清旧参考帧。
    if (Object.keys(reconfig).length) {
      if (applyParams('reconfig', reconfig) === false) {
        log('quality.apply-failed kind=reconfig tier=' + from);
        return { ok: false, kind: 'apply-failed', tier: from };
      }
    }
    tier = to;
    lastSwitchAt = nowMs();
    lastDecision = { decision: d.decision, decisionId: d.decisionId, from, to, at: lastSwitchAt };
    if (d.needsIdr) {
      try { onClearReferenceFrames({ from, to }); } catch (e) { /* ignore */ }
      if (idrSender && typeof idrSender.sendQualityChange === 'function') {
        const r = await idrSender.sendQualityChange();
        if (!r.ok) log('quality.idr-not-sent kind=' + r.kind + ' code=' + (r.code || ''));
      } else {
        log('quality.idr-missing-sender needsIdr=true');
      }
    }
    try { onTierChange({ from, to, decision: d.decision }); } catch (e) { /* ignore */ }
    // 执行完成后 5s 内 ACK（mustAckByMs 为准）。
    if (d.decisionId) {
      pendingAck = { decisionId: d.decisionId, mustAckByMs: Number(d.mustAckByMs) || nowMs() + ACK_TIMEOUT_MS, kind: d.decision === 'downgrade-to' ? 'downgrade' : 'upgrade', timer: null };
      armAckTimeout();
      const ackRes = await sendAck(d.decisionId);
      return { ok: true, tier, ack: ackRes };
    }
    return { ok: true, tier };
  }

  // 背压执行（规范 §5）：L1 降帧率 → L2 降分辨率/码率 → L3 丢弃到
  // 关键帧＋受控 IDR；level null（仅自报堆积）时不擅自降档。
  async function executeBackpressure(bp) {
    lastBackpressure = bp || null;
    if (!bp || !bp.level) return { ok: true, kind: 'none' };
    if (bp.level === 'L1') {
      applyParams('backpressure', { action: 'reduce-fps' });
      return { ok: true, kind: 'L1', action: 'reduce-fps' };
    }
    if (bp.level === 'L2') {
      // 降分辨率/码率：按档位表下一档的 resolutionScale / targetKbps 执行。
      const idx = TIERS.indexOf(tier);
      const lower = idx > 0 ? TIERS[idx - 1] : tier;
      const params = {
        action: 'reduce-resolution-bitrate',
        resolutionScale: DEFAULT_TIER_TABLE[lower].resolutionScale,
        targetKbps: DEFAULT_TIER_TABLE[lower].targetKbps
      };
      applyParams('backpressure', params);
      return { ok: true, kind: 'L2', action: 'reduce-resolution-bitrate', params };
    }
    if (bp.level === 'L3') {
      try { onDropToKeyframe({}); } catch (e) { /* ignore */ }
      if (idrSender && typeof idrSender.sendLoss === 'function') {
        const r = await idrSender.sendLoss();
        if (!r.ok) log('quality.l3-idr-not-sent kind=' + r.kind + ' code=' + (r.code || ''));
      } else {
        log('quality.l3-idr-missing-sender');
      }
      return { ok: true, kind: 'L3', action: 'drop-to-keyframe' };
    }
    return { ok: true, kind: 'none' };
  }

  // 探针发送（规范 §2）：只上报观测值，不带密钥/grants/签名材料。
  // lossPct 是观看端下行丢包（不取上下行平均）。
  async function submitProbe(probe, serverSignal) {
    if (!sessionId) return { ok: false, kind: 'no-session' };
    const v = validateProbe(probe);
    if (!v.ok) return { ok: false, kind: 'probe-incomplete', reason: v.reason };
    if (v.downweighted.length) log('quality.probe-downweighted ' + v.downweighted.join(','));
    lastProbeHealthy = isHealthyProbe(probe);
    lastProbeAt = nowMs();
    const body = { sessionId, tier, probe };
    if (serverSignal && typeof serverSignal === 'object') body.serverSignal = serverSignal;
    let res;
    try {
      res = await request('POST', baseUrl + PROBE_PATH, body);
    } catch (e) {
      return { ok: false, kind: 'network' };
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 503 && json && json.code === 'L5_UNAVAILABLE') return { ok: false, kind: 'unavailable', code: 'L5_UNAVAILABLE' };
    if (status !== 200 || !json || json.ok !== true) {
      return { ok: false, kind: 'rejected', code: errorCodeOf(json) };
    }
    const out = { ok: true, tier, decision: json.decision || null, backpressure: json.backpressure || null };
    if (json.decision && json.decision.decision) {
      // 有决策时：先把 tier 复位到决策的 from（服务端 tier 已是决策后的
      // 值；执行失败时须保持旧档位，不得先采纳新档位——见 E 组回归）。
      if (TIERS.indexOf(json.decision.from) >= 0) tier = json.decision.from;
      out.executed = await executeDecision(json.decision);
      out.tier = tier;
    } else if (TIERS.indexOf(json.tier) >= 0) {
      tier = json.tier;
      out.tier = tier;
    }
    if (json.backpressure) {
      out.backpressureExecuted = await executeBackpressure(json.backpressure);
    }
    return out;
  }

  // 手动升档（规范 §4.2）：一次只升一档；拒绝时展示服务端 code 对应的原因。
  async function requestUpgrade() {
    if (!sessionId) return { ok: false, kind: 'no-session' };
    let res;
    try {
      res = await request('POST', baseUrl + UPGRADE_PATH, { sessionId });
    } catch (e) {
      return { ok: false, kind: 'network' };
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 503 && json && json.code === 'L5_UNAVAILABLE') return { ok: false, kind: 'unavailable', code: 'L5_UNAVAILABLE' };
    if (status === 200 && json && json.ok === true && json.decision === 'upgrade-to') {
      lastUpgradeError = null;
      const executed = await executeDecision(json);
      // S-016（R-W2）：执行失败不得顶层 ok:true 藏起来——executed.ok===false
      // 时透传失败（网页端 upgrade() 同款修法），调用方据此展示失败、不升档。
      if (executed && executed.ok === false) {
        return { ok: false, kind: 'apply-failed', code: executed.code || 'APPLY_FAILED', tier, decision: json, executed };
      }
      return { ok: true, tier, decision: json, executed };
    }
    const code = errorCodeOf(json);
    lastUpgradeError = {
      code,
      message: UPGRADE_REFUSAL_MESSAGES[code] || ('升档被拒：' + (code || '未知')),
      retryAfterMs: Number.isFinite(Number(json && json.retryAfterMs)) ? Number(json.retryAfterMs) : 0
    };
    return { ok: false, kind: 'refused', code, message: lastUpgradeError.message, retryAfterMs: lastUpgradeError.retryAfterMs };
  }

  // 探针定时发送：measureFn() → probe 对象（由会话层注入真实采集；
  // 本模块不伪造 RTT/丢包/抖动）。周期按 §2.3：隐藏 5s、弱网/切换后
  // 10s 内 500ms、正常 1s。
  function currentIntervalMs() {
    // 弱网 = 最近一次探针不健康，或档位切换后 10s 内；尚未探针时按正常 1s
    //（无证据不假定弱网），隐藏时 5s。
    const weak = (nowMs() - lastSwitchAt) < WEAK_WINDOW_AFTER_SWITCH_MS || (lastProbeAt > 0 && !lastProbeHealthy);
    return probeIntervalMs({ hidden, weak });
  }
  function startProbing(measureFn) {
    if (typeof measureFn !== 'function') throw new Error('qf-quality: measureFn 注入缺失');
    stopProbing();
    const tick = async () => {
      probeTimer = null;
      let probe = null;
      try { probe = measureFn(); } catch (e) { probe = null; }
      if (probe) {
        try { await submitProbe(probe); } catch (e) { /* ignore */ }
      }
      probeTimer = timer.setTimeout(tick, currentIntervalMs());
      if (probeTimer && typeof probeTimer.unref === 'function') { try { probeTimer.unref(); } catch (e) { /* ignore */ } }
    };
    probeTimer = timer.setTimeout(tick, currentIntervalMs());
    if (probeTimer && typeof probeTimer.unref === 'function') { try { probeTimer.unref(); } catch (e) { /* ignore */ } }
  }
  function stopProbing() {
    if (probeTimer !== null && probeTimer !== undefined) {
      try { timer.clearTimeout(probeTimer); } catch (e) { /* ignore */ }
      probeTimer = null;
    }
    clearPendingAckTimeout();
    pendingAck = null;
  }
  function setHidden(v) { hidden = !!v; }

  function bind(ids) {
    if (ids && typeof ids.sessionId === 'string') sessionId = ids.sessionId;
    if (ids && typeof ids.initialTier === 'string' && TIERS.indexOf(ids.initialTier) >= 0) tier = ids.initialTier;
  }
  function unbind() {
    stopProbing();
    sessionId = '';
    tier = DEFAULT_TIER;
    pendingAck = null;
    lastDecision = null;
    lastUpgradeError = null;
    lastBackpressure = null;
  }

  // 手动升档入口提示（规范 §7）：仅在健康时可点——本地最近一次探针
  // 健康即提示可点；最终以服务端健康窗口裁决为准，拒绝时展示 code。
  function canRequestUpgrade() {
    if (tier === 'original') return { can: false, reason: '已是最高档' };
    if (!lastProbeAt) return { can: false, reason: '尚未上报探针' };
    if (!lastProbeHealthy) return { can: false, reason: '网络未持续健康，暂不升档' };
    return { can: true, reason: '' };
  }

  function getUiState() {
    return {
      tier,
      appliedFecTier,
      appliedParams: JSON.parse(JSON.stringify(appliedParams)),
      pendingAck: pendingAck ? { decisionId: pendingAck.decisionId, mustAckByMs: pendingAck.mustAckByMs, kind: pendingAck.kind } : null,
      lastDecision,
      lastBackpressure,
      lastUpgradeError,
      lastProbeHealthy,
      canUpgrade: canRequestUpgrade(),
      probing: probeTimer !== null,
      probeIntervalMs: currentIntervalMs()
    };
  }

  return {
    bind,
    unbind,
    submitProbe,
    requestUpgrade,
    sendAck,
    executeDecision,
    executeBackpressure,
    startProbing,
    stopProbing,
    setHidden,
    currentIntervalMs,
    canRequestUpgrade,
    getUiState,
    getTier: () => tier,
    getSessionId: () => sessionId,
    getAppliedFecTier: () => appliedFecTier
  };
}

module.exports = {
  PROBE_PATH,
  UPGRADE_PATH,
  ACK_PATH,
  TIERS,
  DEFAULT_TIER,
  DEFAULT_TIER_TABLE,
  HOT_KEYS,
  RECONFIG_KEYS,
  BAD,
  SEVERE,
  HEALTHY,
  ACK_TIMEOUT_MS,
  PROBE_INTERVAL_MS,
  UPGRADE_REFUSAL_MESSAGES,
  splitTierChange,
  isHealthyProbe,
  probeIntervalMs,
  validateProbe,
  createQualityClient
};
