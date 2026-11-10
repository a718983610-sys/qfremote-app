'use strict';
/*
 * extRequest 有界重试（ext-retry.js，pkg4 DS-8）本地自检：
 *  A. 默认重试次数：GET 补 1、POST 不补；显式 opts.retries 覆盖并钳制 0..3。
 *  B. 退避：500ms、1000ms、1000ms（封顶）。
 *  C. 无响应失败重试、成功即停、HTTP 状态码（哪怕 500）不重试。
 *  D. 耗尽后返回值带 attempts/retried/timeout；超时与普通断网可区分。
 *  E. requestOnce 抛错时不炸（按 status 0 计入重试）。
 * 用假 requestOnce＋假 sleep，不碰真网络、不真等。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const { resolveRetries, retryDelayMs, isRetryableResult, requestWithRetry } = require('../ext-retry');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr230/ext-retry-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

(async () => {
  try {
    // A. 默认与钳制
    ok('A_get_default_1', resolveRetries(undefined, 'GET') === 1 && resolveRetries({}, 'GET') === 1);
    ok('A_post_default_0', resolveRetries(undefined, 'POST') === 0 && resolveRetries({}, 'POST') === 0);
    ok('A_explicit', resolveRetries({ retries: 2 }, 'POST') === 2 && resolveRetries({ retries: 0 }, 'GET') === 0);
    ok('A_clamp', resolveRetries({ retries: 9 }, 'GET') === 3 && resolveRetries({ retries: -2 }, 'GET') === 0);
    ok('A_nan_falls_back', resolveRetries({ retries: NaN }, 'GET') === 1 && resolveRetries({ retries: '2' }, 'GET') === 1);

    // B. 退避
    ok('B_delays', retryDelayMs(0) === 500 && retryDelayMs(1) === 1000 && retryDelayMs(2) === 1000 && retryDelayMs(9) === 1000);

    // C/D. 假时钟＋假请求
    const fakeSleep = (record) => async (ms) => { record.push(ms); };
    const fail0 = () => ({ status: 0, json: null, text: '' });
    const failTimeout = () => ({ status: 0, json: null, text: '', timeout: true });
    const okJson = { status: 200, json: { ok: true }, text: '{}' };

    // C1：两次无响应、第三次成功 → attempts 3、退避 [500,1000]、结果为成功
    let calls = 0;
    const sleeps1 = [];
    const r1 = await requestWithRetry(async () => { calls++; return calls < 3 ? fail0() : okJson; }, { retries: 2 }, 'GET', fakeSleep(sleeps1));
    ok('C1_retry_then_success', r1.status === 200 && r1.json && r1.json.ok === true && r1.attempts === 3 && r1.retried === 2 && calls === 3, { attempts: r1.attempts, sleeps: sleeps1 });
    ok('C1_backoff', sleeps1.length === 2 && sleeps1[0] === 500 && sleeps1[1] === 1000, { sleeps: sleeps1 });

    // C2：HTTP 500 第一次即回 → 不重试，attempts 1、无 sleep
    let calls2 = 0;
    const sleeps2 = [];
    const r2 = await requestWithRetry(async () => { calls2++; return { status: 500, json: null, text: 'err' }; }, { retries: 2 }, 'GET', fakeSleep(sleeps2));
    ok('C2_http_500_no_retry', r2.status === 500 && r2.attempts === 1 && calls2 === 1 && sleeps2.length === 0);

    // C3：第一次即 200 → attempts 1、无 sleep
    const sleeps3 = [];
    const r3 = await requestWithRetry(async () => okJson, { retries: 2 }, 'GET', fakeSleep(sleeps3));
    ok('C3_first_try_success', r3.status === 200 && r3.attempts === 1 && sleeps3.length === 0);

    // C4：GET 默认重试 1 次：失败两次即耗尽
    let calls4 = 0;
    const r4 = await requestWithRetry(async () => { calls4++; return fail0(); }, undefined, 'GET', async () => {});
    ok('C4_get_default_exhausts_2', r4.status === 0 && r4.attempts === 2 && r4.retried === 1 && calls4 === 2);

    // C5：POST 默认不重试：失败一次即回
    let calls5 = 0;
    const r5 = await requestWithRetry(async () => { calls5++; return fail0(); }, undefined, 'POST', async () => {});
    ok('C5_post_default_no_retry', r5.status === 0 && r5.attempts === 1 && calls5 === 1);

    // D. 耗尽后 timeout 透传：最后一次是超时 → timeout true；是普通断网 → false
    const r6 = await requestWithRetry(async () => failTimeout(), { retries: 1 }, 'GET', async () => {});
    ok('D_timeout_flag_true', r6.status === 0 && r6.timeout === true && r6.attempts === 2);
    const r7 = await requestWithRetry(async () => fail0(), { retries: 1 }, 'GET', async () => {});
    ok('D_timeout_flag_false', r7.status === 0 && r7.timeout === false && r7.attempts === 2);

    // E. requestOnce 抛错：不炸，按 status 0 计入重试直至耗尽
    let calls8 = 0;
    const r8 = await requestWithRetry(async () => { calls8++; throw new Error('boom'); }, { retries: 1 }, 'GET', async () => {});
    ok('E_throw_counts_as_failure', r8.status === 0 && r8.attempts === 2 && calls8 === 2);

    // F. 可重试判定：null/无 status/0 可重试；HTTP 状态不可重试
    ok('F_is_retryable', isRetryableResult(null) === true && isRetryableResult({}) === true
      && isRetryableResult({ status: 0 }) === true && isRetryableResult({ status: 200 }) === false
      && isRetryableResult({ status: 500 }) === false);

    // G. main.js 接线静态断言：extRequest 走 requestWithRetry；幂等
    // POST 调用点显式 opt-in；claim 不加 retries（非幂等，见注释）。
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok('G1_main_uses_retry', mainSrc.includes('extRetryMod.requestWithRetry(requestOnce, opts, method)'));
    ok('G2_main_requires_ext_retry', mainSrc.includes("require('./ext-retry')"));
    ok('G3_terminate_opt_in', mainSrc.includes("extRequest('POST', u, {}, { retries: 2 })"));
    ok('G4_heartbeat_opt_in', mainSrc.includes("svcUrls.pointsApi('heartbeat'), { client: 'win' }, { retries: 1 })"));
    ok('G5_device_report_opt_in', mainSrc.includes("svcUrls.licenseApi('device-report'), { deviceCode: code, platform: 'pc' }, { retries: 1 })"));
    ok('G6_cookie_filter_intact', mainSrc.includes('await getConsoleCookieHeader(urlStr)')
      && mainSrc.includes('svcUrlsMod.cookiesHeaderForUrl(cookies, urlStr)'));
    // G7（DS-8 复审 round 1 观察 O2）：extRequest 是 async 函数，非法 URL
    // 走同步 return（async 保证仍为 resolved Promise），调用方 .catch 不抛。
    ok('G7_illegal_url_resolves_not_throws', mainSrc.includes('async function extRequest(')
      && mainSrc.includes("try { u = new URL(urlStr); } catch (e) { return { status: 0, json: null, text: '' }; }"));

    result.pass = Object.values(result.cases).every((c) => c.pass);
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  } finally {
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    process.exit(result.pass ? 0 : 1);
  }
})();
