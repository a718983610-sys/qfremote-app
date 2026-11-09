'use strict';
/*
 * svc-urls 解析本地自检（v2.2.0 新增，不需要真网络）：
 *  A. 假 product.json 全字段 -> 全部采用新值，且拼接出 /points/api/me、/admin/api/users、管理登录地址；
 *  B. 拉不到（fetch 抛错）且有上次缓存 -> 用缓存；
 *  C. 拉不到且无缓存 -> 用写死兜底；product.json 里混入 http/坏值 -> 坏键丢弃走兜底。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const { createSvcUrls, parseProductJson, FALLBACKS } = require('../svc-urls');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr220/svc-urls-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

(async () => {
  try {
    // A
    const fake = {
      web: {
        forumUrl: 'https://svc.qfremote.top/forum',
        registerUrl: 'https://svc.qfremote.top/register',
        friendsUrl: 'https://svc.qfremote.top/friends',
        adminUrl: 'https://svc.qfremote.top/admin',
        pointsUrl: 'https://svc.qfremote.top/points'
      }
    };
    let saved = null;
    const a = createSvcUrls({ fetchJson: async () => fake, loadCache: () => null, saveCache: (o) => { saved = o; } });
    const ra = await a.refresh();
    ok('A_refresh_ok', ra.ok === true);
    ok('A_values', a.get('forumUrl') === 'https://svc.qfremote.top/forum' && a.get('pointsUrl') === 'https://svc.qfremote.top/points', a.all());
    ok('A_points_api', a.pointsApi('me') === 'https://svc.qfremote.top/points/api/me' && a.pointsApi('heartbeat') === 'https://svc.qfremote.top/points/api/heartbeat');
    ok('A_admin_api', a.adminApi('users') === 'https://svc.qfremote.top/admin/api/users');
    ok('A_admin_login', a.adminLoginUrl('a b') === 'https://svc.qfremote.top/admin/login?token=a%20b');
    ok('A_cached', !!saved && saved.pointsUrl === 'https://svc.qfremote.top/points');

    // B
    const cache = { forumUrl: 'https://cache.qfremote.top/forum', pointsUrl: 'https://cache.qfremote.top/points', registerUrl: 'https://cache.qfremote.top/register', friendsUrl: 'https://cache.qfremote.top/friends', adminUrl: 'https://cache.qfremote.top/admin' };
    const b = createSvcUrls({ fetchJson: async () => { throw new Error('连不上'); }, loadCache: () => cache, saveCache: () => {} });
    const rb = await b.refresh();
    ok('B_fallback_cache', rb.ok === false && b.get('forumUrl') === 'https://cache.qfremote.top/forum' && b.get('pointsUrl') === 'https://cache.qfremote.top/points', b.all());

    // C
    const c = createSvcUrls({ fetchJson: async () => { throw new Error('连不上'); }, loadCache: () => null, saveCache: () => {} });
    const rc = await c.refresh();
    ok('C_fallback_hardcoded', rc.ok === false && c.get('forumUrl') === FALLBACKS.forumUrl && c.get('pointsUrl') === FALLBACKS.pointsUrl, c.all());
    const parsed = parseProductJson({ web: { forumUrl: 'http://bad.qfremote.top/forum', pointsUrl: 'https://ok.qfremote.top/points/', adminUrl: 42 } });
    ok('C_bad_values_dropped', !parsed.forumUrl && parsed.pointsUrl === 'https://ok.qfremote.top/points' && !parsed.adminUrl, parsed);

    // D（2.4.5 W-20）：主机名白名单——只接受 app.qfremote.top 及其子域
    const { isAllowedSvcHost, isTrustedSvcUrl } = require('../svc-urls');
    ok('D1_host_allow', isAllowedSvcHost('https://app.qfremote.top/forum') && isAllowedSvcHost('https://x.qfremote.top/points') && isAllowedSvcHost('https://qfremote.top/'));
    ok('D2_host_deny', !isAllowedSvcHost('https://evil.example/forum') && !isAllowedSvcHost('https://qfremote.top.evil.com/forum') && !isAllowedSvcHost('app.qfremote.top') && !isAllowedSvcHost('') && !isAllowedSvcHost(null));
    ok('D3_url_trust', isTrustedSvcUrl('https://app.qfremote.top/forum') && !isTrustedSvcUrl('http://app.qfremote.top/forum') && !isTrustedSvcUrl('https://evil.example/forum'));
    const evil = parseProductJson({ web: { forumUrl: 'https://evil.example/forum', pointsUrl: 'https://app.qfremote.top/points' } });
    ok('D4_evil_host_dropped', !evil.forumUrl && evil.pointsUrl === 'https://app.qfremote.top/points', evil);
    let rejected = [];
    const evil2 = parseProductJson({ web: { forumUrl: 'https://evil.example/forum' } }, (h) => rejected.push(h));
    ok('D5_rejected_reports_host_only', !evil2.forumUrl && rejected.length === 1 && rejected[0] === 'evil.example', { rejected });
    const poison = createSvcUrls({ fetchJson: async () => { throw new Error('连不上'); }, loadCache: () => ({ forumUrl: 'https://evil.example/forum', pointsUrl: 'https://app.qfremote.top/points' }), saveCache: () => {} });
    await poison.refresh();
    ok('D6_cache_poison_dropped', poison.get('forumUrl') === FALLBACKS.forumUrl && poison.get('pointsUrl') === 'https://app.qfremote.top/points', poison.all());

    result.pass = Object.values(result.cases).every(x => x.pass);
  } catch (e) {
    result.fatal = e.message;
  } finally {
    try { fs.mkdirSync(require('path').dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    process.exit(result.pass ? 0 : 1);
  }
})();
