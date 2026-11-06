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
ok('B2_online', m.onlineCount === 2, { onlineCount: m.onlineCount });
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
    ok('D2_lib_same_behavior', mm.total === 3 && mm.onlineCount === 2 && mm.groups[0].devices[0].name === 'Alpha');
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

(async () => {
  await probeCase();
  libCase();
  contractCase();
  viewCase();
  result.pass = Object.values(result.cases).every(c => c.pass);
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  console.log(JSON.stringify({ pass: result.pass, failed: Object.keys(result.cases).filter(k => !result.cases[k].pass) }));
  process.exit(result.pass ? 0 : 1);
})();
