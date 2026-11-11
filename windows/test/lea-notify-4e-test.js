'use strict';
/*
 * 4e 路径登录不通知 LEA 修复自检（2026-11-11，纯 Node，不需要 Electron/真服务器）：
 *  根因——页内导航登录成功时 location.hash 已是 '#home'，直接赋值不产生
 *  导航，did-navigate-in-page 不触发，processAuthPage 看不到本次登录，
 *  notifyLeaLogin 永不跑（r6 实证：登录 #3 无 LEA 日志、无 boot log，
 *  绑定留 UNBOUND、epoch 不推进；冷启动表单登录正常）。
 *  修法——Electron 主进程监听 /qf-login 响应头（onHeadersReceived）：
 *  POST＋200 且 x-qf-login-result 不是 frozen／banned／locked 时，调度
 *  processAuthPage 补跑（500ms 首跑、2500ms 补跑）。processAuthPage 是
 *  状态驱动、幂等：跑到时若页面已是控制台壳即通知 LEA；若仍是登录表单
 *  （密码错等），console 分支不跑、无副作用。
 *  注意——webapp 读完响应头即 cancel 响应体，故不用 onCompleted（取消后
 *  不保证触发），用 onHeadersReceived。密码错与成功都回 200 且无
 *  x-qf-login-result 头，无法在头部区分——无妨，误触发只是一次廉价的
 *  processAuthPage 空转（console 分支以页面状态为准）。
 *  断言：
 *  Q1 main.js 含 /qf-login onHeadersReceived 接线，调
 *      shouldScheduleLoginNotifyCheck＋scheduleLoginNotifyCheck；
 *  Q2 scheduleLoginNotifyCheck 含 500ms 与 2500ms 两档、调 processAuthPage；
 *  Q3 shouldScheduleLoginNotifyCheck：POST 200 无头 -> true；
 *  Q4 shouldScheduleLoginNotifyCheck：POST 200 头 'ok' -> true；
 *  Q5 shouldScheduleLoginNotifyCheck：POST 200 头 'frozen' -> false；
 *  Q6 shouldScheduleLoginNotifyCheck：POST 200 头 'banned' -> false；
 *  Q7 shouldScheduleLoginNotifyCheck：POST 200 头 'locked' -> false；
 *  Q8 shouldScheduleLoginNotifyCheck：GET 200 -> false；
 *  Q9 shouldScheduleLoginNotifyCheck：POST 401 -> false；
 *  Q10 shouldScheduleLoginNotifyCheck：头名大小写不敏感（'X-QF-Login-Result'
 *      值为 frozen）-> false；
 *  Q11 shouldScheduleLoginNotifyCheck：头值为数组 ['frozen'] -> false；
 *  Q12 shouldScheduleLoginNotifyCheck：null／空对象 -> false；
 *  Q13 scheduleLoginNotifyCheck 行为（vm＋mock 计时器）：两次回调分别在
 *      500ms 与 2500ms，触发后各调一次 processAuthPage；
 *  Q14 scheduleLoginNotifyCheck 行为：第二次调度清掉第一次的计时器。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。跑法：node windows/test/lea-notify-4e-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr300/lea-notify-4e-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// Q1：/qf-login onHeadersReceived 接线。
{
  const hook = mainJs.includes("ses.webRequest.onHeadersReceived({ urls: ['*://' + ALLOWED_HOST + '/qf-login*'] }");
  const call = mainJs.includes('if (shouldScheduleLoginNotifyCheck(details)) scheduleLoginNotifyCheck();');
  ok('Q1_login_hook_wired', hook && call, { hook, call });
}
// Q2：调度器含两档延迟、调 processAuthPage。
{
  const at = mainJs.indexOf('function scheduleLoginNotifyCheck()');
  const endMark = '// ---- end scheduleLoginNotifyCheck ----';
  const end = at >= 0 ? mainJs.indexOf(endMark, at) : -1;
  const body = at >= 0 && end > at ? mainJs.slice(at, end) : '';
  const d500 = body.includes('}, 500)');
  const d2500 = body.includes('}, 2500)');
  const calls = body.includes('processAuthPage().catch(() => {})');
  ok('Q2_scheduler_two_delays', d500 && d2500 && calls, { d500, d2500, calls });
}

// 抽取判定函数（vm 行为测试用）。
function extractFn(src, startMark, endMark) {
  const at = src.indexOf(startMark);
  const end = at >= 0 ? src.indexOf(endMark, at) : -1;
  return at >= 0 && end > at ? src.slice(at, end) : '';
}
const decideSrc = extractFn(mainJs, 'function shouldScheduleLoginNotifyCheck(details) {', '// ---- end shouldScheduleLoginNotifyCheck ----');

function runDecide(details) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(decideSrc, sandbox);
  return vm.runInContext('shouldScheduleLoginNotifyCheck(DETAILS);', Object.assign(sandbox, { DETAILS: details }));
}

// Q3–Q12：判定函数行为。
ok('Q3_post200_no_header', runDecide({ method: 'POST', statusCode: 200, responseHeaders: {} }) === true, {});
ok('Q4_post200_ok_header', runDecide({ method: 'POST', statusCode: 200, responseHeaders: { 'x-qf-login-result': ['ok'] } }) === true, {});
ok('Q5_post200_frozen', runDecide({ method: 'POST', statusCode: 200, responseHeaders: { 'x-qf-login-result': ['frozen'] } }) === false, {});
ok('Q6_post200_banned', runDecide({ method: 'POST', statusCode: 200, responseHeaders: { 'x-qf-login-result': 'banned' } }) === false, {});
ok('Q7_post200_locked', runDecide({ method: 'POST', statusCode: 200, responseHeaders: { 'x-qf-login-result': ['locked'] } }) === false, {});
ok('Q8_get200', runDecide({ method: 'GET', statusCode: 200, responseHeaders: {} }) === false, {});
ok('Q9_post401', runDecide({ method: 'POST', statusCode: 401, responseHeaders: {} }) === false, {});
ok('Q10_header_name_case_insensitive', runDecide({ method: 'POST', statusCode: 200, responseHeaders: { 'X-QF-Login-Result': ['frozen'] } }) === false, {});
ok('Q11_header_array_frozen', runDecide({ method: 'POST', statusCode: 200, responseHeaders: { 'x-qf-login-result': ['frozen'] } }) === false, {});
ok('Q15_header_empty_array_is_no_value', runDecide({ method: 'POST', statusCode: 200, responseHeaders: { 'x-qf-login-result': [] } }) === true, {});
{
  const a = runDecide(null);
  const b = runDecide({});
  const c = runDecide({ method: 'POST', statusCode: 200 });
  ok('Q12_null_or_empty', a === false && b === false && c === true, { a, b, c });
}

// Q13/Q14：调度器行为（vm＋mock 计时器）。
function runScheduler(times) {
  const schedSrc = extractFn(mainJs, 'let loginNotifyCheckTimers = [];', '// ---- end scheduleLoginNotifyCheck ----');
  const timers = [];
  const cleared = [];
  let calls = 0;
  let nextId = 1;
  const sandbox = {
    setTimeout: (cb, ms) => { const id = nextId++; timers.push({ id, cb, ms }); return id; },
    clearTimeout: (id) => { cleared.push(id); const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    processAuthPage: () => { calls++; return Promise.resolve(); },
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(schedSrc, sandbox);
  for (let i = 0; i < times; i++) vm.runInContext('scheduleLoginNotifyCheck();', sandbox);
  return { sandbox, timers, cleared, get calls() { return calls; } };
}
{
  const r = runScheduler(1);
  const delays = r.timers.map((t) => t.ms).sort((a, b) => a - b);
  // 触发两档回调，各调一次 processAuthPage。
  const cbs = r.timers.slice();
  for (const t of cbs) t.cb();
  ok('Q13_two_delays_call_auth_page', JSON.stringify(delays) === JSON.stringify([500, 2500]) && r.calls === 2, { delays, calls: r.calls });
}
{
  const r = runScheduler(2);
  // 第二次调度清掉了第一次的两枚计时器，只剩第二次的两枚。
  const live = r.timers.map((t) => t.ms).sort((a, b) => a - b);
  ok('Q14_second_schedule_clears_first', r.cleared.length === 2 && JSON.stringify(live) === JSON.stringify([500, 2500]), { cleared: r.cleared, live });
}

result.pass = Object.values(result.cases).every((c) => c.pass);
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
