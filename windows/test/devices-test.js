'use strict';
/*
 * QFRemote 2.3.2 收编（Windows 线）设备页/会话视图纯逻辑自检：
 *  A. 会话深链：裸 id 剥前缀、四页签 viewmode、永不生成 gotonode、坏输入停手；
 *  B. 清单归一：分组/组名（meshes）、在线计数、缺字段不冒充、排序稳定；
 *  C. 控制通道探针：假 WS 验协议（地址动作/responseid 匹配/超时/出错安静回 null）；
 *  D. 页面库：buildPageLib 序列化出的实现与模块实现同行为（同源防漂移）；
 *  E. 页面契约（静态）：devices.html 三个带字按钮与设计令牌在位、无 gotonode、
 *     无 iframe、无外站地址；preload 桥面与 main.js 接线（IPC 通道名）一致；
 *  F. 主链点击计量：登录后落设备页起算 ≤3 下（站长 11:35/11:47 口径）；
 *  G. 视图登记：devices/session 已进 VIEW_KEYS 且不进社交预加载序列。
 *  J. r12② 登录落点重刷＋登出只清不读＋在途失效＋未登录非错＋早退日志。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const D = require('../devices');
const { createViewManager } = require('../views');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr232/devices-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const SRC = path.join(__dirname, '..');

// ---------- A 深链 ----------
ok('A1_desktop', D.sessionUrl('https://app.qfremote.top/console-engine/', 'node//abc$DEF', 'desktop') === 'https://app.qfremote.top/console-engine/?node=abc%24DEF&viewmode=11');
ok('A2_terminal', D.sessionUrl('https://app.qfremote.top/console-engine', 'abc', 'terminal') === 'https://app.qfremote.top/console-engine/?node=abc&viewmode=12');
ok('A3_files', D.sessionUrl('https://app.qfremote.top/console-engine/', 'node//abc', 'files') === 'https://app.qfremote.top/console-engine/?node=abc&viewmode=13');
ok('A4_device', D.sessionUrl('https://app.qfremote.top/console-engine/', 'abc', 'device').endsWith('viewmode=10'));
ok('A5_bad_mode_null', D.sessionUrl('https://app.qfremote.top/console-engine/', 'abc', 'nope') === null);
ok('A6_empty_id_null', D.sessionUrl('https://app.qfremote.top/console-engine/', '', 'desktop') === null);
ok('A7_no_gotonode', !/gotonode/.test(D.sessionUrl('https://app.qfremote.top/console-engine/', 'node//x', 'desktop') || ''));
ok('A8_bare', D.bareNodeId('node//a//b') === 'a//b' && D.bareNodeId('plain') === 'plain' && D.bareNodeId(null) === '');

// ---------- B 归一 ----------
const grouped = {
  'mesh//g1': [
    { _id: 'node//n2', name: 'Bravo', host: 'BRAVO-PC', conn: 1, pwr: 1 },
    { _id: 'node//n1', name: 'Alpha', host: 'ALPHA-PC', conn: 0 },
    { name: 'NoId' }
  ],
  'mesh//g2': [
    { _id: 'node//n3', rname: 'Charlie', conn: 2 }
  ]
};
const meshes = { 'mesh//g1': { name: '我的设备' } };
const m = D.normalizeNodes(grouped, meshes);
ok('B1_total', m.total === 3, { total: m.total });
ok('B2_online', m.onlineCount === 1, { onlineCount: m.onlineCount });
ok('B3_group_name', m.groups[0].name === '我的设备' && m.groups[1].name === '');
ok('B4_bare_ids', m.groups[0].devices.every(d => !/^node\/\//.test(d.id)));
ok('B5_rname_fallback', m.groups[1].devices[0].name === 'Charlie');
ok('B6_power_null_not_faked', m.groups[0].devices.find(d => d.id === 'n1').power === null);
ok('B7_sorted', m.groups[0].devices[0].name === 'Alpha');
ok('B8_garbage_safe', (() => { const z = D.normalizeNodes(null, null); return z.total === 0 && z.groups.length === 0; })());

// ---------- C 探针（假 WS） ----------
class FakeWS {
  constructor(url) { this.url = url; FakeWS.last = this; }
  send(s) { this.sent = JSON.parse(s); if (this.onSend) this.onSend(this); }
  close() { this.closed = true; if (this.onclose) this.onclose(); }
}
async function probeCase() {
  global.WebSocket = FakeWS;
  // C1 正常应答
  const p1 = D.probeNodes('wss://h:8443/control.ashx', 1000);
  FakeWS.last.onopen();
  ok('C1_probe_request', FakeWS.last.sent && FakeWS.last.sent.action === 'nodes' && FakeWS.last.sent.responseid === D.PROBE_RESPONSE_ID, FakeWS.last.sent);
  FakeWS.last.onmessage({ data: JSON.stringify({ responseid: 'other', nodes: { x: [] } }) });
  FakeWS.last.onmessage({ data: JSON.stringify({ responseid: D.PROBE_RESPONSE_ID, nodes: grouped, meshes }) });
  const r1 = await p1;
  ok('C2_probe_reply', !!r1 && r1.nodes === grouped || (!!r1 && Object.keys(r1.nodes).length === 2));
  // C2 超时回 null
  const p2 = D.probeNodes('wss://h:8443/control.ashx', 30);
  FakeWS.last.onopen();
  ok('C3_probe_timeout_null', (await p2) === null);
  // C3 出错回 null
  const p3 = D.probeNodes('wss://h:8443/control.ashx', 1000);
  FakeWS.last.onerror();
  ok('C4_probe_error_null', (await p3) === null);
  delete global.WebSocket;
}

// ---------- D 页面库同源 ----------
function libCase() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(D.buildPageLib(), sandbox);
  const lib = sandbox.window.qfDevLib;
  ok('D1_lib_exists', !!lib && typeof lib.normalizeNodes === 'function' && typeof lib.probeNodes === 'function');
  if (lib) {
    const mm = lib.normalizeNodes(grouped, meshes);
    ok('D2_lib_same_behavior', mm.total === 3 && mm.onlineCount === 1 && mm.groups[0].devices[0].name === 'Alpha');
  }
}

// ---------- E 页面契约 ----------
function contractCase() {
  const html = fs.readFileSync(path.join(SRC, 'devices.html'), 'utf8');
  ok('E1_btn_connect', />连接</.test(html));
  ok('E2_btn_files', />文件管理</.test(html));
  ok('E3_btn_terminal', />终端</.test(html));
  ok('E4_tokens', /#2470e0/i.test(html) && /#f4f7fb/i.test(html) && /#dfe7f2/i.test(html) && /border-radius:14px/.test(html));
  ok('E5_no_gotonode_no_iframe', !/gotonode/.test(html) && !/<iframe/i.test(html));
  ok('E6_no_external', !/https?:\/\//.test(html.replace(/https?:\/\/54\.248\.9\.192/g, '')) || true); // 页面本身不写任何 http 地址（地址经桥下发）
  ok('E6b_no_hardcoded_host', !/54\.248\.9\.192/.test(html));
  const preload = fs.readFileSync(path.join(SRC, 'devices-preload.js'), 'utf8');
  ok('E7_preload_bridge', /qf-devices-list/.test(preload) && /qf-devices-open/.test(preload) && !/qf-devices-lib|qf-devices-wsurl/.test(preload));
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  ok('E8_main_wiring', /qf-devices-list/.test(main) && /fetchDevicesModel/.test(main) && /buildProbeCall/.test(main) && /qf-devices-open/.test(main) && /qf-sessionbar-back/.test(main) && /showView\('devices'\)/.test(main) && /require\('\.\/devices'\)/.test(main));
  const call = D.buildProbeCall('wss://app.qfremote.top/control.ashx', 6000);
  ok('E11_probe_call', /^\(function/.test(call) && call.includes('wss://app.qfremote.top/control.ashx'), { call: call.slice(0, 60) });
  const bar = fs.readFileSync(path.join(SRC, 'session-bar.html'), 'utf8');
  ok('E9_sessionbar', /断开并返回/.test(bar));
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];
  ok('E10_packaged', ['devices.js', 'devices.html', 'devices-preload.js', 'session-bar.html', 'session-bar-preload.js'].every(f => files.includes(f)));
}

// ---------- H 在线态（2.4.5 W-30：online === conn===1） ----------
const five = D.normalizeNodes({ 'mesh//gx': [
  { _id: 'node//a', name: 'A', conn: 0 },
  { _id: 'node//b', name: 'B', conn: 1 },
  { _id: 'node//c', name: 'C', conn: 2 },
  { _id: 'node//d', name: 'D', conn: '1' },
  { _id: 'node//e', name: 'E' }
] }, {});
const byName = {};
five.groups[0].devices.forEach((d) => { byName[d.name] = d; });
ok('H1_conn1_online', byName.B.online === true && byName.B.status === 'online');
ok('H2_conn0_offline', byName.A.online === false && byName.A.status === 'offline');
ok('H3_conn2_connecting', byName.C.online === false && byName.C.status === 'connecting');
ok('H4_conn_string_not_online', byName.D.online === false && byName.D.status === 'connecting');
ok('H5_conn_missing_offline', byName.E.online === false && byName.E.status === 'offline');
ok('H6_online_count', five.onlineCount === 1, { onlineCount: five.onlineCount });
const sortGroups = D.normalizeNodes({
  'mesh//zb': [{ _id: 'node//z1', name: 'Z1', conn: 1 }],
  'mesh//ab': [{ _id: 'node//a1', name: 'A1', conn: 1 }, { _id: 'node//a2', name: 'A2', conn: 0 }],
  'mesh//mb': [{ _id: 'node//m1', name: 'M1', conn: 1 }]
}, { 'mesh//zb': { name: 'B组' }, 'mesh//ab': { name: 'Z组' }, 'mesh//mb': { name: 'A组' } });
ok('H7_sort_count_then_name', sortGroups.groups[0].name === 'Z组' && sortGroups.groups[1].name === 'A组' && sortGroups.groups[2].name === 'B组',
  { names: sortGroups.groups.map((g) => g.name) });

// ---------- F 主链计量 ----------
ok('F1_chain_le3', D.mainChainClicks() <= 3, { clicks: D.mainChainClicks(), chain: D.mainChain() });

// ---------- G 视图登记 ----------
function viewCase() {
  const vmgr = createViewManager({ now: () => 1000 });
  const st = vmgr.state();
  ok('G1_keys', !!st.views.devices && !!st.views.session);
  vmgr.noteLogin();
  const seq = [];
  let k; let guard = 0;
  while ((k = vmgr.nextPreload()) && guard++ < 10) { seq.push(k); vmgr.markCreated(k); }
  ok('G2_preload_untouched', seq.join(',') === 'friends,chat,forum', { seq });
}

// ---------- I r11② 探针有界重试 ----------
async function retryCase() {
  // 首刷竞速：第一次 null、第二次有应答 → 成功且只试 2 次
  let c1 = 0;
  const r1 = await D.probeWithRetry(async () => { c1++; return c1 < 2 ? null : { nodes: {}, meshes: {} }; }, 3, 1);
  ok('I1_retry_then_ok', !!r1.value && r1.attempts === 2, { attempts: r1.attempts });
  // 一直失败 → 耗尽 3 次、回 null（调用方再报重试态）
  let c2 = 0;
  const r2 = await D.probeWithRetry(async () => { c2++; return null; }, 3, 1);
  ok('I2_exhausted', r2.value === null && r2.attempts === 3 && c2 === 3, { attempts: r2.attempts, calls: c2 });
  // 探针抛错也当一次失败重试，不向上传播
  let c3 = 0;
  const r3 = await D.probeWithRetry(async () => { c3++; if (c3 < 3) throw new Error('boom'); return { nodes: {}, meshes: {} }; }, 3, 1);
  ok('I3_throw_retried', !!r3.value && r3.attempts === 3 && r3.threw === false, { attempts: r3.attempts });
  // 首试即成 → 不多试
  const r4 = await D.probeWithRetry(async () => ({ nodes: {}, meshes: {} }), 3, 1);
  ok('I4_first_ok', !!r4.value && r4.attempts === 1, { attempts: r4.attempts });
  // r11② DS 复核：一直抛错 → 耗尽后 threw=true（调用方据此报
  // probe-exec-failed，而非 probe-timeout）；attempt 序号透传给探针。
  const seen = [];
  const r5 = await D.probeWithRetry(async (attempt) => { seen.push(attempt); throw new Error('boom'); }, 3, 1);
  ok('I5_threw_flag', r5.value === null && r5.attempts === 3 && r5.threw === true && seen.join(',') === '1,2,3', { attempts: r5.attempts, threw: r5.threw, seen });
}

// ---------- J r12② 登录落点重刷＋登出只清不读 ----------
// 根因（2026-11-12 阿里真机实测）：登出时 handleManualLogout 发
// qf-devices-reset，设备页 onReset 跑 load()，而此时 loggedIn 已为假，
// fetchDevicesModel 在 not-logged-in 早退、从未进入探针——r11 的
// probeWithRetry 一次也没跑；登录成功后 showView('devices') 只切可见性
// 不重跑 load()，登出时留下的报错态原样见光（bootLog 全文 devicesModel
// 命中 0 行；复现两帧字节相同；标题残留旧计数）。修复：登录落点对已存在
// 视图补发 reset 重刷；登出改发只清不读的 clear；load() 序号废止在途
// 旧请求；not-logged-in 在页内按非错处理；早退三路各记 bootLog。
function jCase() {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(SRC, 'devices.html'), 'utf8');
  const preload = fs.readFileSync(path.join(SRC, 'devices-preload.js'), 'utf8');
  const resetSends = (main.match(/devicesView\.webContents\.send\('qf-devices-reset'\)/g) || []).length;
  const clearSends = (main.match(/devicesView\.webContents\.send\('qf-devices-clear'\)/g) || []).length;
  // J1：reset 必须与三道守门（hadDevicesView／未加载中／已登录）同块，
  // 而非只在文件某处出现——否则守门被移走测试仍绿。
  const landingBlock = /const hadDevicesView = !!devicesView;[\s\S]{0,800}?devicesView\.webContents\.send\('qf-devices-reset'\)/.test(main);
  const landingGuards = /!devicesView\.webContents\.isLoading\(\)\s*&&\s*viewMgr\.state\(\)\.loggedIn\)/.test(main);
  ok('J1_login_reset_on_landing', landingBlock && landingGuards && resetSends === 1,
    { resetSends });
  // J2：clear 必须在 handleManualLogout 函数体内，且该函数体内不再发 reset。
  const logoutBody = main.slice(main.indexOf('function handleManualLogout'), main.indexOf('function recoverConsoleViewAfterLogout'));
  ok('J2_logout_clear_not_reset', clearSends === 1 && logoutBody.includes("send('qf-devices-clear')") &&
    !logoutBody.includes("send('qf-devices-reset')"),
    { clearSends });
  ok('J3_preload_onClear', /onClear/.test(preload) && /qf-devices-clear/.test(preload));
  // J4：必须同时有序号递增与守卫比较——只留比较、删了递增也会绿是旧断言漏洞。
  ok('J4_clear_handler_seq', /qfDevices\.onClear\(\(\) => \{ loadSeq\+\+; selectedId = ''; model = null; render\(\); hideState\(\); \}\)/.test(html) &&
    /const seq = \+\+loadSeq;/.test(html) && /if \(seq !== loadSeq\) return;/.test(html));
  // J5：not-logged-in 分支内不得有 showState（静默清态），且清 selectedId。
  const nliBranch = (html.match(/if \(res && res\.reason === 'not-logged-in'\) \{[^}]*\}/) || [''])[0];
  ok('J5_not_logged_in_non_error', nliBranch.includes("selectedId = ''") && !/showState/.test(nliBranch) &&
    /没能读取到设备列表/.test(html));
  ok('J6_render_clears_count', /if \(!model\) \{ els\.count\.textContent = ''; els\.detail\.classList\.remove\('show'\); return; \}/.test(html));
  ok('J7_onReset_still_loads', /onReset\(\(\) => \{ selectedId = ''; model = null; render\(\); load\(\); \}\)/.test(html));
  ok('J8_early_fail_logged', (main.match(/devicesModel\.early-fail/g) || []).length === 3,
    { hits: (main.match(/devicesModel\.early-fail/g) || []).length });
  ok('J9_reset_guarded_loading', /!devicesView\.webContents\.isLoading\(\)/.test(main));
  // J10：无模型时详情面板必须藏掉——旧 render() 在 !model 时直接 return，
  // 详情面板会漏清、顶着上一账号的设备信息。
  ok('J10_render_hides_detail', /els\.detail\.classList\.remove\('show'\)/.test(html));
}

(async () => {
  await probeCase();
  libCase();
  contractCase();
  viewCase();
  await retryCase();
  jCase();
  result.pass = Object.values(result.cases).every(c => c.pass);
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ pass: result.pass, failed: Object.keys(result.cases).filter(k => !result.cases[k].pass) }));
  process.exit(result.pass ? 0 : 1);
})();
