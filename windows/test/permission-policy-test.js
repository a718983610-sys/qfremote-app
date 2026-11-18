'use strict';
/*
 * S-003（审计 F-019＋第三份 P2-07）权限 deny-by-default 自检：
 * 摄像头／麦克风／位置一律拒绝；无 allowlist 的权限一律拒绝；allowlist
 * 内的权限须 origin 在列＋用户主动操作才放行；重复安装 no-op；
 * 静态断言 main.js 在全部 persist:qfremote 会话取用点安装策略。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const { ALWAYS_DENY, makeDecider, installPermissionPolicy } = require('../permission-policy');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-c1/permission-policy-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const SRC = path.join(__dirname, '..');

function fakeSession() {
  const s = { reqHandler: null, checkHandler: null,
    setPermissionRequestHandler(h) { this.reqHandler = h; },
    setPermissionCheckHandler(h) { this.checkHandler = h; } };
  return s;
}
function ask(s, permission, url, gesture) {
  let got = null;
  s.reqHandler({}, permission, (v) => { got = v; }, { requestingUrl: url, userGesture: gesture });
  return got;
}

{
  // A. 摄像头／麦克风／位置当前不用：直接拒绝（无论 origin／手势）。
  const decide = makeDecider({});
  ok('A1_camera_denied', decide('camera', 'https://app.qfremote.top/', true) === false);
  ok('A2_microphone_denied', decide('microphone', 'https://app.qfremote.top/', true) === false);
  ok('A3_geolocation_denied', decide('geolocation', 'https://app.qfremote.top/', true) === false);
  ok('A4_notifications_denied', decide('notifications', 'https://app.qfremote.top/', true) === false);
  ok('A5_always_deny_set', ALWAYS_DENY.has('camera') && ALWAYS_DENY.has('microphone') && ALWAYS_DENY.has('geolocation'));
}
{
  // B. 无 allowlist 的权限一律拒绝；allowlist 内须 origin＋手势双满足。
  const decide = makeDecider({ allow: { 'notifications': ['https://app.qfremote.top'] } });
  ok('B1_no_allowlist_denied', decide('fullscreen', 'https://app.qfremote.top/', true) === false);
  ok('B2_allowlist_origin_gesture_ok', decide('notifications', 'https://app.qfremote.top/x', true) === true);
  ok('B3_allowlist_wrong_origin_denied', decide('notifications', 'https://evil.example/', true) === false);
  ok('B4_allowlist_no_gesture_denied', decide('notifications', 'https://app.qfremote.top/', false) === false);
}
{
  // C. 安装：request＋check 两个 handler 都装；重复安装 no-op；回调 fail-closed。
  const s = fakeSession();
  ok('C1_install', installPermissionPolicy(s, {}) === true && typeof s.reqHandler === 'function' && typeof s.checkHandler === 'function');
  ok('C2_install_idempotent', installPermissionPolicy(s, {}) === false);
  ok('C3_request_camera_denied', ask(s, 'camera', 'https://app.qfremote.top/', true) === false);
  ok('C4_check_camera_denied', s.checkHandler({}, 'camera', 'https://app.qfremote.top', {}) === false);
  ok('C5_install_no_session_false', installPermissionPolicy(null, {}) === false);
  const bad = { setPermissionRequestHandler() { throw new Error('x'); } };
  ok('C6_install_throw_false', installPermissionPolicy(bad, {}) === false);
}
{
  // D. 静态：main.js 在全部会话取用点安装策略。分区名由
  // testPolicy.consolePartition() 集中给出（A16-S2：生产
  // 'persist:qfremote'／TEST 'persist:qfremote-test'），故按调用点
  // 计数、不按字面量计数；每个取用点后须紧跟一次安装。
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const sites = (main.match(/session\.fromPartition\(/g) || []).length;
  const installs = (main.match(/installPermissionPolicy\(/g) || []).length;
  ok('D1_all_partition_sites_covered', sites >= 4 && installs >= sites, { sites, installs });
  ok('D2_main_requires_policy', /require\('\.\/permission-policy'\)/.test(main));
  ok('D3_pkg_files_has_policy', JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).build.files.indexOf('permission-policy.js') >= 0);
  ok('D4_no_direct_handler_in_main', main.indexOf('setPermissionRequestHandler(') < 0); // 策略只经 permission-policy.js 安装，main.js 不直调
}

const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
result.pass = failed.length === 0;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ pass: result.pass, failed }));
process.exit(result.pass ? 0 : 1);
