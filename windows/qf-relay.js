'use strict';
/*
 * QFRemote Windows 运行端 — RC-07 中继白名单＋三级回退（3.0.0）
 * ==============================================================
 * 依据：QF-RELAY-1 客户端协议规范 v1（server/ext/QF-RELAY-1-CLIENT-SPEC.md）
 * §1（宣告端点）／§2（三级回退与在途上限）／§3（白名单校验）。选路纯
 * 函数与服务端 server/ext/relay-core.js 的 announceRelays /
 * isAllowedRelay / pickRelay 同款逻辑（本文件是客户端本地移植；排序、
 * 默认值、降级原因枚举与服务端一致，测试用服务端原模块对拍）。
 *
 * 规则要点：
 *   - 宣告列表：GET /license/api/relays；排序 tier 升序 → priority
 *     降序 → id 字典序；上限 32 条；ttlSec 默认 600；列表过期
 *     （issuedAt + ttlSec*1000）后须重新取，不得用过期列表建连。
 *     本地过期判定取列表内最小 ttlSec（最保守：任一条目过期即整表
 *     重取；服务端逐条 ttlSec 可能不同，取最小值永不超期使用）。
 *   - pickRelay：失败过的 id 不再试；在途上限每级默认 8（在途已满
 *     跳过该级、不算失败、不进 failedIds）；三级耗尽进降级态。
 *   - isAllowedRelay：只接受 http:/https:；origin 相等且路径是列表
 *     条目路径的前缀；空列表一律拒绝（空列表 ≠ 全部放行）。
 *   - 伪造中继（§3）：拒绝拨号（不发任何建连包）；界面提示“该中继
 *     不在服务端宣告列表内，已拒绝连接”；记本地诊断日志（只记 URL
 *     与时间，不记密钥/会话口令）；不把它当作可重试的普通失败、不
 *     加入 failedIds；继续选下一条列表内中继，无候选则进降级态。
 *   - 降级态（§2.3）：只保留已建会话＋文件暂存通道，不新开桌面会
 *     话；UI 须明确显示降级态并提供“重试”入口（重试 = 清空
 *     failedIds、重新取宣告列表、重走选路；不得无间隔自动循环重试）。
 *   - 列表为空或请求失败 → 不建连，界面报错，不得用硬编码地址兜底。
 *
 * 诚实边界（规范 §4.1）：tier-2/3 真实中继主机目前不存在，选路逻辑
 * 与策略位先行；本模块不在 UI 文案里宣称“已部署多级中继”。
 * 宣告列表没有每中继健康度/延迟字段，客户端不得按延迟自选排序。
 */
const RELAYS_PATH = '/license/api/relays';
const MAX_RELAYS = 32;
const DEFAULT_TTL_SEC = 600;
const DEFAULT_MAX_INFLIGHT_PER_TIER = 8;

function normalizeUrl(u) {
  try {
    const parsed = new URL(String(u || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    let pathname = parsed.pathname || '/';
    if (!pathname.endsWith('/')) pathname += '/';
    return { origin: parsed.origin, pathname, href: parsed.origin + pathname };
  } catch (e) {
    return null;
  }
}

// 与服务端 isAllowedRelay 同款逻辑（relay-core.js）。
function isAllowedRelay(url, list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const n = normalizeUrl(url);
  if (!n) return false;
  for (const e of list) {
    const en = normalizeUrl(e && e.url);
    if (!en) continue;
    if (n.origin === en.origin && n.pathname.startsWith(en.pathname)) return true;
  }
  return false;
}

function sortRelays(list) {
  return (Array.isArray(list) ? list.slice() : [])
    .sort((a, b) => (a.tier - b.tier) || (b.priority - a.priority) || (String(a.id) < String(b.id) ? -1 : 1));
}

// 与服务端 pickRelay 同款逻辑（relay-core.js）。
function pickRelay(list, failedIds, opts) {
  const o = opts || {};
  const failed = new Set(Array.isArray(failedIds) ? failedIds.map(String) : []);
  const inFlight = o.inFlightByTier && typeof o.inFlightByTier === 'object' ? o.inFlightByTier : {};
  const maxInflight = Number(o.maxInflightPerTier) > 0 ? Number(o.maxInflightPerTier) : DEFAULT_MAX_INFLIGHT_PER_TIER;
  const sorted = sortRelays(Array.isArray(list) ? list : [])
    .filter((e) => e && e.id && !failed.has(String(e.id)));
  for (const e of sorted) {
    const cur = Number(inFlight[e.tier]) || 0;
    if (cur >= maxInflight) continue; // 该级在途已满，跳过（不算失败）
    return { relay: e, tier: e.tier, reason: failed.size ? 'fallback-after-failure' : 'primary' };
  }
  return { relay: null, tier: 0, degraded: true, reason: sorted.length ? 'tier-inflight-full' : 'all-tiers-exhausted' };
}

// 服务端宣告条目的客户端清洗：tier 只接受 1/2/3，其他值条目直接跳过；
// 无 id / URL 非法跳过；同 id 只留第一条；上限 32 条。
function cleanRelayList(relays) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(relays) ? relays : [])) {
    if (out.length >= MAX_RELAYS) break;
    if (!r || typeof r !== 'object') continue;
    const id = String(r.id || '').trim().slice(0, 80);
    const n = normalizeUrl(r.url);
    const tier = Number(r.tier);
    if (!id || !n) continue;
    if (!(tier === 1 || tier === 2 || tier === 3)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, url: n.href, tier,
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
      ttlSec: Number(r.ttlSec) > 0 ? Number(r.ttlSec) : DEFAULT_TTL_SEC,
      issuedAt: Number(r.issuedAt) || 0
    });
  }
  return sortRelays(out);
}

function createRelaySelector(opts) {
  const o = opts || {};
  if (typeof o.request !== 'function') throw new Error('qf-relay: request 注入缺失');
  if (typeof o.baseUrl !== 'string' || !o.baseUrl) throw new Error('qf-relay: baseUrl 缺失');
  const request = o.request;
  const baseUrl = String(o.baseUrl).replace(/\/+$/, '');
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const maxInflightPerTier = Number(o.maxInflightPerTier) > 0 ? Number(o.maxInflightPerTier) : DEFAULT_MAX_INFLIGHT_PER_TIER;

  let list = null; // 清洗后的宣告列表
  let listIssuedAt = 0;
  let listTtlSec = DEFAULT_TTL_SEC;
  let failedIds = new Set();
  let inFlightByTier = { 1: 0, 2: 0, 3: 0 };
  let degradedReason = '';
  let lastFetchAt = 0;

  function listExpiresAt() {
    if (!list) return 0;
    return listIssuedAt + listTtlSec * 1000;
  }
  function isListExpired(now) {
    if (!list || !list.length) return true;
    return (Number(now) || nowMs()) >= listExpiresAt();
  }

  // 取宣告列表（GET /license/api/relays）。失败或空列表 → 不建连，
  // 不得用硬编码地址兜底（规范 §2.2 第 1 步）。
  async function fetchList() {
    let res;
    try {
      res = await request('GET', baseUrl + RELAYS_PATH, null);
    } catch (e) {
      return { ok: false, kind: 'network' };
    }
    const status = (res && typeof res.status === 'number') ? res.status : 0;
    const json = (res && res.json) || null;
    if (status === 503 && json && json.code === 'L5_UNAVAILABLE') {
      return { ok: false, kind: 'unavailable', code: 'L5_UNAVAILABLE' };
    }
    if (status !== 200 || !json || json.ok !== true || !Array.isArray(json.relays)) {
      return { ok: false, kind: status === 0 ? 'network' : 'unknown', status };
    }
    const cleaned = cleanRelayList(json.relays);
    if (!cleaned.length) return { ok: false, kind: 'empty-list' };
    list = cleaned;
    listIssuedAt = Math.min.apply(null, cleaned.map((r) => r.issuedAt || nowMs()));
    listTtlSec = Math.min.apply(null, cleaned.map((r) => r.ttlSec || DEFAULT_TTL_SEC));
    lastFetchAt = nowMs();
    degradedReason = '';
    return { ok: true, relays: cleaned, expiresAt: listExpiresAt() };
  }

  async function ensureList() {
    if (!isListExpired()) return { ok: true, cached: true };
    return fetchList();
  }

  // 拨号前必调的白名单校验（规范 §3）。伪造地址 → 拒绝拨号、不发任何
  // 建连包、不进 failedIds、只记 URL 与时间一条诊断日志。
  function checkDialUrl(url) {
    if (!list || !list.length) return { ok: false, kind: 'no-list', code: 'RELAY_NOT_ANNOUNCED' };
    if (isAllowedRelay(url, list)) return { ok: true };
    log('relay.forged url=' + String(url));
    return {
      ok: false, kind: 'forged', code: 'RELAY_NOT_ANNOUNCED',
      message: '该中继不在服务端宣告列表内，已拒绝连接'
    };
  }

  // 选下一条候选（不拨号）：返回 { relay, tier, reason } 或
  // { degraded:true, reason }。在途已满的级被跳过、不算失败。
  function pickNext() {
    if (!list || !list.length) return { relay: null, tier: 0, degraded: true, reason: 'all-tiers-exhausted' };
    const picked = pickRelay(list, Array.from(failedIds), { inFlightByTier, maxInflightPerTier });
    if (picked.degraded) degradedReason = picked.reason;
    return picked;
  }

  function markDialStart(tier) {
    const t = Number(tier);
    if (t === 1 || t === 2 || t === 3) inFlightByTier[t] += 1;
  }
  function markDialEnd(tier, ok, relayId) {
    const t = Number(tier);
    if (t === 1 || t === 2 || t === 3) inFlightByTier[t] = Math.max(0, inFlightByTier[t] - 1);
    if (!ok && relayId) failedIds.add(String(relayId));
    if (ok) degradedReason = '';
  }

  // 完整选路循环：取表 → 选候选 → 白名单校验 → 拨号（dialFn 注入，
  // (relay, dialUrl) => Promise<boolean>）→ 失败则回退下一条。
  // 列表内条目校验不通过（服务端列表自不一致，理论上不应发生）按
  // “该条不可用”处理：进 failedIds、试下一条（这与伪造地址不同：
  // 伪造地址来自列表外渠道，checkDialUrl 单独处理、永不进 failedIds）。
  async function selectRelay(dialFn) {
    if (typeof dialFn !== 'function') throw new Error('qf-relay: dialFn 注入缺失');
    const ensured = await ensureList();
    if (!ensured.ok) {
      degradedReason = 'all-tiers-exhausted';
      return { ok: false, kind: ensured.kind, degraded: true, reason: 'all-tiers-exhausted', message: '中继列表不可用，无法建立连接' };
    }
    for (;;) {
      const picked = pickNext();
      if (!picked.relay) {
        return { ok: false, kind: 'degraded', degraded: true, reason: picked.reason, message: '中继全部不可用，已保留现有会话' };
      }
      const dialUrl = picked.relay.url;
      if (!isAllowedRelay(dialUrl, list)) {
        // 列表内条目却通不过白名单：服务端列表自不一致，该条不可用。
        log('relay.list-entry-not-allowed id=' + picked.relay.id);
        failedIds.add(String(picked.relay.id));
        continue;
      }
      markDialStart(picked.tier);
      let dialOk = false;
      try {
        dialOk = await dialFn(picked.relay, dialUrl) === true;
      } catch (e) {
        dialOk = false;
      }
      markDialEnd(picked.tier, dialOk, picked.relay.id);
      if (dialOk) return { ok: true, relay: picked.relay, tier: picked.tier, reason: picked.reason };
      // 失败（超时/拒绝/不可达）→ id 进 failedIds，选下一条。
      log('relay.dial-failed id=' + picked.relay.id);
    }
  }

  // 降级态重试入口（UI“重试”按钮调）：清空 failedIds、重新取宣告
  // 列表、重走选路。不得无间隔自动循环重试——本函数只在显式调用时跑。
  async function retry(dialFn) {
    failedIds = new Set();
    inFlightByTier = { 1: 0, 2: 0, 3: 0 };
    degradedReason = '';
    list = null;
    return selectRelay(dialFn);
  }

  function getUiState() {
    const degraded = !!degradedReason || (!list || !list.length);
    return {
      degraded,
      reason: degradedReason || (!list ? 'all-tiers-exhausted' : ''),
      message: degraded ? '中继全部不可用，已保留现有会话' : '',
      canRetry: degraded,
      canStartNewSession: !degraded,
      relaysTotal: list ? list.length : 0,
      failedCount: failedIds.size,
      inFlightByTier: Object.assign({}, inFlightByTier),
      listExpiresAt: listExpiresAt(),
      // 不宣称已部署多级中继：只报列表里实际宣告的 tier 分布。
      tiersAnnounced: list ? Array.from(new Set(list.map((r) => r.tier))).sort() : []
    };
  }

  return {
    fetchList,
    ensureList,
    checkDialUrl,
    pickNext,
    markDialStart,
    markDialEnd,
    selectRelay,
    retry,
    getUiState,
    isListExpired,
    listExpiresAt,
    getList: () => (list ? list.slice() : null),
    getFailedIds: () => Array.from(failedIds),
    getInFlightByTier: () => Object.assign({}, inFlightByTier),
    lastFetchAt: () => lastFetchAt
  };
}

module.exports = {
  RELAYS_PATH,
  MAX_RELAYS,
  DEFAULT_TTL_SEC,
  DEFAULT_MAX_INFLIGHT_PER_TIER,
  normalizeUrl,
  isAllowedRelay,
  pickRelay,
  sortRelays,
  cleanRelayList,
  createRelaySelector
};
