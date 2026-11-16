'use strict';
// L5 RC-07 自检：中继宣告白名单＋三级回退（QF-RELAY-1）。
// 运行：node server/ext/test-l5-relay.js（无外部依赖，退出码 0=通过）。
const { announceRelays, isAllowedRelay, pickRelay } = require('./relay-core');

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, extra || ''); }
}

// 1) 未配置时只宣告本源 tier-1，不写死域名/IP
const def = announceRelays({}, 'https://app.qfremote.top');
t('default-announces-one-tier1', def.length === 1 && def[0].tier === 1 && def[0].id === 'qfremote-primary', JSON.stringify(def));
t('default-url-derives-from-origin', def[0] && def[0].url === 'https://app.qfremote.top/console-engine/');
// 2) 配置驱动：tier 排序、非法条目剔除、上限 32
const cfg = { relays: [
  { id: 'b', url: 'https://relay2.example.com/r/', tier: 2, priority: 50 },
  { id: 'a', url: 'https://relay1.example.com/r/', tier: 1, priority: 10 },
  { id: 'bad1', url: 'ftp://x.example.com/', tier: 1 },
  { id: 'bad2', url: 'https://x.example.com/', tier: 9 },
  { id: 'a', url: 'https://dup.example.com/', tier: 1 },
  { id: 'c', url: 'not-a-url', tier: 3 },
] };
const list = announceRelays(cfg, 'https://app.qfremote.top');
t('config-tier-order', list.length === 2 && list[0].id === 'a' && list[1].id === 'b', JSON.stringify(list.map((e) => e.id)));
t('config-ttl-default-600', list[0].ttlSec === 600);
// 3) 白名单：列表内放行（同 origin＋路径前缀），列表外拒绝
t('allow-listed', isAllowedRelay('https://relay1.example.com/r/session/abc', list) === true);
t('deny-forged-relay', isAllowedRelay('https://evil.example.com/r/', list) === false);
t('deny-other-path-same-origin', isAllowedRelay('https://relay1.example.com/other/', list) === false);
t('deny-non-http', isAllowedRelay('ftp://relay1.example.com/r/', list) === false);
t('deny-empty-list', isAllowedRelay('https://relay1.example.com/r/', []) === false);
// 4) 三级回退：tier-1 故障 → tier-2；全故障 → 降级态
const three = announceRelays({ relays: [
  { id: 't1', url: 'https://r1.example.com/', tier: 1 },
  { id: 't2', url: 'https://r2.example.com/', tier: 2 },
  { id: 't3', url: 'https://r3.example.com/', tier: 3 },
] }, 'https://app.qfremote.top');
let p = pickRelay(three, []);
t('pick-primary', p.relay && p.relay.id === 't1' && p.tier === 1, JSON.stringify(p));
p = pickRelay(three, ['t1']);
t('fallback-to-tier2', p.relay && p.relay.id === 't2' && p.tier === 2 && p.reason === 'fallback-after-failure', JSON.stringify(p));
p = pickRelay(three, ['t1', 't2']);
t('fallback-to-tier3', p.relay && p.relay.id === 't3' && p.tier === 3, JSON.stringify(p));
p = pickRelay(three, ['t1', 't2', 't3']);
t('all-exhausted-degraded', p.relay === null && p.degraded === true && p.reason === 'all-tiers-exhausted', JSON.stringify(p));
// 5) 在途上限：某级满了跳过该级，不算失败
p = pickRelay(three, [], { inFlightByTier: { 1: 8 } });
t('inflight-cap-skips-tier', p.relay && p.relay.id === 't2', JSON.stringify(p));
p = pickRelay(three, [], { inFlightByTier: { 1: 8, 2: 8, 3: 8 } });
t('inflight-all-full-degraded', p.relay === null && p.degraded === true && p.reason === 'tier-inflight-full', JSON.stringify(p));
// 6) 上限 32
const many = { relays: Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i, url: 'https://r' + i + '.example.com/', tier: 1 })) };
t('cap-32', announceRelays(many, 'https://app.qfremote.top').length === 32);

console.log(`\nRC-07: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
