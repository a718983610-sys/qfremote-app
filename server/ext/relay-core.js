'use strict';
/*
 * QFRemote 扩展服务 · L5 画面与传输：中继宣告与选路（RC-07，协议 QF-RELAY-1）
 * =====================================================================
 * 来源：RustDesk rendezvous_mediator.rs（REPORTED_RELAYS 上限 32 条、
 * TTL 600 秒；UDP 打洞→TCP 打洞→中继三级回退；PunchPool 在途上限）。
 * 只学思路，不复用代码（AGPL）。
 *
 * 本模块是纯函数（无 IO、无状态），供 ext 服务挂端点与三端客户端
 * 共用同一份判定逻辑：
 *   - announceRelays(config, origin)：服务端宣告可用中继列表。
 *     未配置时只宣告一条 tier-1：本源 /console-engine/（由请求
 *     origin 派生，不写死域名/IP）。tier-2/3 是策略位＋选路逻辑
 *     先行——真实备用中继主机目前不存在，待有备用主机时在
 *     config.json 的 relays 里加一条即生效，不改代码。
 *   - isAllowedRelay(url, list)：白名单精确校验（origin＋路径
 *     前缀），非列表地址一律拒绝。客户端建连前必调。
 *   - pickRelay(list, failedIds, opts)：三级回退选路，按
 *     tier→priority 顺序试，每级在途建连上限默认 8；三级耗尽
 *     后进降级态（只保留已建会话＋文件暂存通道，不新开桌面会话）。
 *
 * 不做的事：不在 nginx 层加动态白名单（nginx 只有静态 upstream）；
 * 不改 MeshCentral meshrelay.js（上游，不在树内）。
 */
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

function announceRelays(config, origin) {
  const now = Date.now();
  const list = [];
  const cfgRelays = (config && Array.isArray(config.relays)) ? config.relays : [];
  for (const r of cfgRelays) {
    if (list.length >= MAX_RELAYS) break;
    if (!r || typeof r !== 'object') continue;
    const id = String(r.id || '').trim().slice(0, 80);
    const n = normalizeUrl(r.url);
    const tier = Number(r.tier);
    if (!id || !n) continue;
    if (!(tier === 1 || tier === 2 || tier === 3)) continue;
    if (list.some((e) => e.id === id)) continue;
    list.push({
      id, url: n.href, tier,
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
      ttlSec: Number(r.ttlSec) > 0 ? Number(r.ttlSec) : DEFAULT_TTL_SEC,
      issuedAt: now,
    });
  }
  if (list.length === 0) {
    // 未配置：只宣告本源 tier-1（由请求 origin 派生）。
    const base = normalizeUrl(String(origin || '') + '/console-engine/');
    if (base) {
      list.push({ id: 'qfremote-primary', url: base.href, tier: 1, priority: 100, ttlSec: DEFAULT_TTL_SEC, issuedAt: now });
    }
  }
  list.sort((a, b) => (a.tier - b.tier) || (b.priority - a.priority) || (a.id < b.id ? -1 : 1));
  return list;
}

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

function pickRelay(list, failedIds, opts) {
  const o = opts || {};
  const failed = new Set(Array.isArray(failedIds) ? failedIds.map(String) : []);
  const inFlight = o.inFlightByTier && typeof o.inFlightByTier === 'object' ? o.inFlightByTier : {};
  const maxInflight = Number(o.maxInflightPerTier) > 0 ? Number(o.maxInflightPerTier) : DEFAULT_MAX_INFLIGHT_PER_TIER;
  const sorted = (Array.isArray(list) ? list.slice() : [])
    .filter((e) => e && e.id && !failed.has(String(e.id)))
    .sort((a, b) => (a.tier - b.tier) || (b.priority - a.priority) || (String(a.id) < String(b.id) ? -1 : 1));
  for (const e of sorted) {
    const cur = Number(inFlight[e.tier]) || 0;
    if (cur >= maxInflight) continue; // 该级在途已满，跳过（不算失败）
    return { relay: e, tier: e.tier, reason: failed.size ? 'fallback-after-failure' : 'primary' };
  }
  return { relay: null, tier: 0, degraded: true, reason: sorted.length ? 'tier-inflight-full' : 'all-tiers-exhausted' };
}

module.exports = { announceRelays, isAllowedRelay, pickRelay, MAX_RELAYS, DEFAULT_TTL_SEC, DEFAULT_MAX_INFLIGHT_PER_TIER };
