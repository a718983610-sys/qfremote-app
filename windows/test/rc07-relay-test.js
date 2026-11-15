'use strict';
/*
 * RC-07 Windows 中继白名单＋三级回退测试（QF-RELAY-1 规范 v1，3.0.0）：
 *  A. isAllowedRelay 与服务端 relay-core.js 对拍：同 origin 同路径
 *     前缀放行、同 origin 不同路径拒绝、不同 origin 拒绝、非 http(s)
 *     拒绝、空列表拒绝、路径补齐末尾 /。
 *  B. pickRelay 与服务端对拍：tier 升序、priority 降序、id 字典序；
 *     失败 id 不再试；在途已满跳过该级、不算失败；三级耗尽降级原因
 *     all-tiers-exhausted vs tier-inflight-full。
 *  C. 宣告列表获取与缓存：GET /license/api/relays、ttlSec 过期重取、
 *     空列表不建连、请求失败不建连、不得用硬编码地址兜底。
 *  D. 伪造中继拒绝：checkDialUrl 拒绝拨号、不进 failedIds、只记 URL
 *     与时间一条日志、可继续选下一条列表内中继。
 *  E. 三级回退循环：首选失败→次选成功、在途计数增减、全部失败进降级
 *     态（只保留已建会话、不新开桌面会话）、重试入口清空 failedIds
 *     并重取列表、不自动循环重试。
 *  F. 降级态 UI 快照：degraded 文案、canRetry、canStartNewSession、
 *     不宣称已部署多级中继。
 * tier-2/3 真实中继主机目前不存在（规范 §4.1），本测试用假宣告列表
 * 覆盖选路逻辑，不宣称多级中继已部署。结果写 JSON 到 QFTEST_OUT，
 * 退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const relayMod = require('../qf-relay');
const serverRelay = require('../../server/ext/relay-core');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-rc07-relay/rc07-relay-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const LIST = [
  { id: 'r1', url: 'https://relay1.example.com/r/', tier: 1, priority: 100, ttlSec: 600, issuedAt: 1790000000000 },
  { id: 'r2', url: 'https://relay2.example.com/r/', tier: 2, priority: 90, ttlSec: 600, issuedAt: 1790000000000 },
  { id: 'r3', url: 'https://relay3.example.com/r/', tier: 3, priority: 80, ttlSec: 600, issuedAt: 1790000000000 }
];

(async () => {
  // ---------- A. isAllowedRelay 对拍 ----------
  {
    const cases = [
      ['https://relay1.example.com/r/session/abc', LIST, true],
      ['https://relay1.example.com/r/', LIST, true],
      ['https://relay1.example.com/other/', LIST, false],
      ['https://evil.example.com/r/', LIST, false],
      ['ftp://relay1.example.com/r/', LIST, false],
      ['https://relay1.example.com/r/session/abc', [], false],
      ['not-a-url', LIST, false]
    ];
    cases.forEach(([url, list, expect], i) => {
      const mine = relayMod.isAllowedRelay(url, list);
      const srv = serverRelay.isAllowedRelay(url, list);
      ok('A' + (i + 1) + '_allowed-' + expect, mine === expect && srv === expect && mine === srv);
    });
    ok('A8_path-no-trailing-slash', relayMod.isAllowedRelay('https://relay1.example.com/r', LIST) === true);
  }

  // ---------- B. pickRelay 对拍 ----------
  {
    const shuffled = [LIST[2], LIST[0], LIST[1]];
    const mine = relayMod.pickRelay(shuffled, [], {});
    const srv = serverRelay.pickRelay(shuffled, [], {});
    ok('B1_order_tier-priority', mine.relay.id === 'r1' && srv.relay.id === 'r1' && mine.reason === 'primary');
    const m2 = relayMod.pickRelay(LIST, ['r1'], {});
    ok('B2_failed-skipped', m2.relay.id === 'r2' && m2.reason === 'fallback-after-failure');
    const m3 = relayMod.pickRelay(LIST, [], { inFlightByTier: { 1: 8, 2: 0, 3: 0 } });
    ok('B3_inflight-full_skips-tier', m3.relay.id === 'r2' && m3.tier === 2);
    const m4 = relayMod.pickRelay(LIST, [], { inFlightByTier: { 1: 8, 2: 8, 3: 8 } });
    ok('B4_all-inflight-full_degraded', m4.degraded === true && m4.reason === 'tier-inflight-full');
    const m5 = relayMod.pickRelay(LIST, ['r1', 'r2', 'r3'], {});
    ok('B5_all-failed_exhausted', m5.degraded === true && m5.reason === 'all-tiers-exhausted');
    const m6 = relayMod.pickRelay(LIST, [], { inFlightByTier: { 1: 8 } });
    const s6 = serverRelay.pickRelay(LIST, [], { inFlightByTier: { 1: 8 } });
    ok('B6_matches-server', JSON.stringify(m6) === JSON.stringify(s6));
    // 同级 priority 降序、id 字典序。
    const sameTier = [
      { id: 'b', url: 'https://b.example.com/r/', tier: 1, priority: 50 },
      { id: 'a', url: 'https://a.example.com/r/', tier: 1, priority: 50 },
      { id: 'c', url: 'https://c.example.com/r/', tier: 1, priority: 200 }
    ];
    ok('B7_priority-then-id', relayMod.pickRelay(sameTier, [], {}).relay.id === 'c');
    ok('B8_id-tiebreak', relayMod.pickRelay(sameTier, ['c'], {}).relay.id === 'a');
  }

  // ---------- C. 宣告列表获取与缓存 ----------
  {
    const mkSelector = (fake) => {
      const calls = [];
      let now = 1790000000000;
      const request = async (method, url, body) => { calls.push({ method, url }); return fake(); };
      const sel = relayMod.createRelaySelector({ request, baseUrl: 'https://app.qfremote.top', nowMs: () => now, log: () => {} });
      return { sel, calls, setNow: (v) => { now = v; }, getNow: () => now };
    };
    {
      const { sel, calls } = mkSelector(() => ({ status: 200, json: { ok: true, relays: LIST } }));
      const r = await sel.fetchList();
      ok('C1_fetch-ok', r.ok === true && r.relays.length === 3 && calls[0].url === 'https://app.qfremote.top/license/api/relays' && calls[0].method === 'GET');
      const r2 = await sel.ensureList();
      ok('C2_cached_no-refetch', r2.ok === true && r2.cached === true && calls.length === 1);
    }
    {
      const { sel, calls, setNow, getNow } = mkSelector(() => ({ status: 200, json: { ok: true, relays: LIST } }));
      await sel.fetchList();
      setNow(getNow() + 600 * 1000 + 1); // ttlSec 600 过期
      const r = await sel.ensureList();
      ok('C3_expired_refetch', r.ok === true && !r.cached && calls.length === 2);
    }
    {
      const { sel } = mkSelector(() => ({ status: 200, json: { ok: true, relays: [] } }));
      const r = await sel.fetchList();
      ok('C4_empty-list_no-dial', r.ok === false && r.kind === 'empty-list' && sel.getList() === null);
    }
    {
      const { sel } = mkSelector(() => { throw new Error('net down'); });
      const r = await sel.fetchList();
      ok('C5_fetch-network-fail', r.ok === false && r.kind === 'network');
    }
    {
      const { sel } = mkSelector(() => ({ status: 503, json: { ok: false, code: 'L5_UNAVAILABLE' } }));
      const r = await sel.fetchList();
      ok('C6_l5-unavailable', r.ok === false && r.kind === 'unavailable');
    }
    {
      // 无效条目跳过：tier 4、无 id、非法 URL、同 id 只留第一条、上限 32。
      const dirty = [
        { id: 'x1', url: 'https://x1.example.com/r/', tier: 4, priority: 1 },
        { id: '', url: 'https://x2.example.com/r/', tier: 1 },
        { id: 'x3', url: 'htp://bad', tier: 1 },
        { id: 'dup', url: 'https://dup1.example.com/r/', tier: 1, priority: 10 },
        { id: 'dup', url: 'https://dup2.example.com/r/', tier: 1, priority: 99 },
        { id: 'good', url: 'https://good.example.com/r/', tier: 2 }
      ];
      const cleaned = relayMod.cleanRelayList(dirty);
      ok('C7_clean-list', cleaned.length === 2 && cleaned[0].id === 'dup' && cleaned[0].url === 'https://dup1.example.com/r/' && cleaned[1].id === 'good');
    }
  }

  // ---------- D. 伪造中继拒绝 ----------
  {
    const logs = [];
    let now = 1790000000000;
    const sel = relayMod.createRelaySelector({
      request: async () => ({ status: 200, json: { ok: true, relays: LIST } }),
      baseUrl: 'https://app.qfremote.top', nowMs: () => now, log: (m) => logs.push(m)
    });
    await sel.fetchList();
    const r = sel.checkDialUrl('https://evil.example.com/r/session/abc');
    ok('D1_forged_refused', r.ok === false && r.kind === 'forged' && r.code === 'RELAY_NOT_ANNOUNCED' && r.message === '该中继不在服务端宣告列表内，已拒绝连接');
    ok('D2_forged_not-in-failedIds', sel.getFailedIds().length === 0);
    ok('D3_forged_logged_url-only', logs.length === 1 && logs[0].indexOf('evil.example.com') >= 0 && logs[0].indexOf('qfremote') < 0);
    const r2 = sel.checkDialUrl('https://relay1.example.com/r/session/abc');
    ok('D4_listed_allowed', r2.ok === true);
    const r3 = sel.checkDialUrl('https://relay1.example.com/other/');
    ok('D5_same-origin-other-path_refused', r3.ok === false && r3.kind === 'forged');
    // 无列表时一律拒绝。
    const sel2 = relayMod.createRelaySelector({
      request: async () => ({ status: 200, json: { ok: true, relays: LIST } }),
      baseUrl: 'https://app.qfremote.top', nowMs: () => now, log: () => {}
    });
    ok('D6_no-list_refused', sel2.checkDialUrl('https://relay1.example.com/r/').ok === false);
  }

  // ---------- E. 三级回退循环 ----------
  {
    const mkSel = (dialResults) => {
      const dialCalls = [];
      let now = 1790000000000;
      const sel = relayMod.createRelaySelector({
        request: async () => ({ status: 200, json: { ok: true, relays: LIST } }),
        baseUrl: 'https://app.qfremote.top', nowMs: () => now, log: () => {}
      });
      const dialFn = async (relay, url) => { dialCalls.push(relay.id); return dialResults[relay.id]; };
      return { sel, dialFn, dialCalls };
    };
    {
      const { sel, dialFn, dialCalls } = mkSel({ r1: false, r2: true, r3: false });
      const r = await sel.selectRelay(dialFn);
      ok('E1_fallback-to-tier2', r.ok === true && r.relay.id === 'r2' && r.reason === 'fallback-after-failure' && dialCalls.join(',') === 'r1,r2');
      ok('E2_failedIds_tracked', sel.getFailedIds().join(',') === 'r1');
      ok('E3_inflight_released', JSON.stringify(sel.getInFlightByTier()) === JSON.stringify({ 1: 0, 2: 0, 3: 0 }));
    }
    {
      const { sel, dialFn, dialCalls } = mkSel({ r1: false, r2: false, r3: false });
      const r = await sel.selectRelay(dialFn);
      ok('E4_all-fail_degraded', r.ok === false && r.degraded === true && r.reason === 'all-tiers-exhausted' && dialCalls.join(',') === 'r1,r2,r3');
      const ui = sel.getUiState();
      ok('E5_degraded-ui', ui.degraded === true && ui.message === '中继全部不可用，已保留现有会话' && ui.canRetry === true && ui.canStartNewSession === false);
    }
    {
      // 重试入口：清空 failedIds、重取列表、r1 恢复后选中首选；不自动循环。
      let fetchCount = 0;
      let now = 1790000000000;
      const sel = relayMod.createRelaySelector({
        request: async () => { fetchCount += 1; return { status: 200, json: { ok: true, relays: LIST } }; },
        baseUrl: 'https://app.qfremote.top', nowMs: () => now, log: () => {}
      });
      const dialCalls = [];
      await sel.selectRelay(async (relay) => { dialCalls.push(relay.id); return false; });
      const r = await sel.retry(async (relay) => { dialCalls.push('retry:' + relay.id); return relay.id === 'r1'; });
      ok('E6_retry_clears-failed-refetch', r.ok === true && r.relay.id === 'r1' && sel.getFailedIds().length === 0 && fetchCount === 2 && dialCalls.indexOf('retry:r1') >= 0);
    }
    {
      // 在途已满的级被跳过、不算失败。
      const { sel } = mkSel({ r1: true });
      await sel.fetchList();
      sel.markDialStart(1);
      sel.markDialStart(1);
      // 8 次在途才满；先确认 2 次在途不影响首选。
      const p = sel.pickNext();
      ok('E7_inflight-partial_still-primary', p.relay.id === 'r1');
      for (let i = 0; i < 6; i++) sel.markDialStart(1);
      const p2 = sel.pickNext();
      ok('E8_inflight-full_skips-tier1', p2.relay.id === 'r2' && sel.getFailedIds().length === 0);
    }
  }

  // ---------- F. 降级态 UI 快照 ----------
  {
    let now = 1790000000000;
    const sel = relayMod.createRelaySelector({
      request: async () => ({ status: 200, json: { ok: true, relays: LIST } }),
      baseUrl: 'https://app.qfremote.top', nowMs: () => now, log: () => {}
    });
    await sel.fetchList();
    const ui = sel.getUiState();
    ok('F1_healthy-ui', ui.degraded === false && ui.canStartNewSession === true && ui.relaysTotal === 3 && ui.tiersAnnounced.join(',') === '1,2,3');
    // 不宣称已部署多级中继：快照只报“列表里实际宣告的 tier”，无部署断言字段。
    ok('F2_no-deployment-claim', !('deployed' in ui) && JSON.stringify(ui).indexOf('已部署') < 0);
  }

  const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
  result.pass = failed.length === 0;
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ pass: result.pass, failed }));
  process.exit(result.pass ? 0 : 1);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
