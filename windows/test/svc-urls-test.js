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
        forumUrl: 'https://example.com/forum',
        registerUrl: 'https://example.com/register',
        friendsUrl: 'https://example.com/friends',
        adminUrl: 'https://example.com/admin',
        pointsUrl: 'https://example.com/points'
      }
    };
    let saved = null;
    const a = createSvcUrls({ fetchJson: async () => fake, loadCache: () => null, saveCache: (o) => { saved = o; } });
    const ra = await a.refresh();
    ok('A_refresh_ok', ra.ok === true);
    ok('A_values', a.get('forumUrl') === 'https://example.com/forum' && a.get('pointsUrl') === 'https://example.com/points', a.all());
    ok('A_points_api', a.pointsApi('me') === 'https://example.com/points/api/me' && a.pointsApi('heartbeat') === 'https://example.com/points/api/heartbeat');
    ok('A_admin_api', a.adminApi('users') === 'https://example.com/admin/api/users');
    ok('A_admin_login', a.adminLoginUrl('a b') === 'https://example.com/admin/login?token=a%20b');
    ok('A_cached', !!saved && saved.pointsUrl === 'https://example.com/points');

    // B
    const cache = { forumUrl: 'https://cache.example/forum', pointsUrl: 'https://cache.example/points', registerUrl: 'https://cache.example/register', friendsUrl: 'https://cache.example/friends', adminUrl: 'https://cache.example/admin' };
    const b = createSvcUrls({ fetchJson: async () => { throw new Error('连不上'); }, loadCache: () => cache, saveCache: () => {} });
    const rb = await b.refresh();
    ok('B_fallback_cache', rb.ok === false && b.get('forumUrl') === 'https://cache.example/forum' && b.get('pointsUrl') === 'https://cache.example/points', b.all());

    // C
    const c = createSvcUrls({ fetchJson: async () => { throw new Error('连不上'); }, loadCache: () => null, saveCache: () => {} });
    const rc = await c.refresh();
    ok('C_fallback_hardcoded', rc.ok === false && c.get('forumUrl') === FALLBACKS.forumUrl && c.get('pointsUrl') === FALLBACKS.pointsUrl, c.all());
    const parsed = parseProductJson({ web: { forumUrl: 'http://bad.example/forum', pointsUrl: 'https://ok.example/points/', adminUrl: 42 } });
    ok('C_bad_values_dropped', !parsed.forumUrl && parsed.pointsUrl === 'https://ok.example/points' && !parsed.adminUrl, parsed);

    result.pass = Object.values(result.cases).every(x => x.pass);
  } catch (e) {
    result.fatal = e.message;
  } finally {
    try { fs.mkdirSync(require('path').dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    process.exit(result.pass ? 0 : 1);
  }
})();
