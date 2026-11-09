'use strict';
/*
 * QFRemote 收编设备页与会话视图——纯逻辑层（2.3.2 收编 Windows 线新增）
 * ================================================================
 * 站长口径（2026-10-26 11:41–11:47）：旧版底层与功能收进新版，界面必须
 * 符合新版、能融合、不许一旧一新；主要功能不许藏深——点设备直达桌面，
 * 设备页首行「连接」主按钮＋「文件管理」带字次按钮、终端等带字跟随；
 * 主链 ≤3 下、零二次登录；旧版页面在产品内不再出现。
 *
 * 本模块只管三件事（不碰 Electron，main.js 负责落到真实视图上）：
 *  1) 会话深链：复用既有会话通道（控制台源 control/relay 不动），
 *     地址形态与抢修定版一致——/?node=<裸节点id>&viewmode=<页签>
 *     （10 设备页 / 11 桌面 / 12 终端 / 13 文件）；gotonode 冷链在本
 *     构建不可达，永不生成（抢修 PATCH-NOTE 留档口径）。
 *  2) 设备清单模型：控制台控制通道（/control.ashx）nodes 应答的归一
 *     化——分组、名称、在线/电源状态；取不到的字段不冒充。
 *  3) 探针与归一同源：控制通道探针由主进程以函数源码串（buildProbeCall，
 *     与 autologin.js 的 DETECT_JS 同手法）注入已登录的控制台视图执行，
 *     应答回主进程用本模块 normalizeNodes 归一后下发设备页——全程只有
 *     一份协议实现。本地页直连 WS 握手带不上会话 cookie、会被服务端
 *     以 noauth 关闭（2026-10-26 真环境实测），故不走页面直连。
 *
 * 点击计量（主链）：登录后落设备页（0）→ 点设备卡片（1）→ 点「连接」
 * （2）→ 桌面在壳内会话视图打开。全程不整页跳原生页、不二次登录。
 */

const CONTROL_WS_PATH = '/control.ashx';
const PROBE_RESPONSE_ID = 'qf-nodes-probe';
const PROBE_ACTION = 'nodes';

// 会话页签（MeshCentral 原生页签号，抢修实测 10/11/12 冷启绑定；
// 13=文件与原生页 p13 文件面板同号，冷启绑定待真环境复核）
const VIEWMODES = { device: 10, desktop: 11, terminal: 12, files: 13 };
const MODE_LABELS = { desktop: '远程桌面', terminal: '远程终端', files: '文件管理', device: '设备信息' };

// 节点 id 归一：控制通道与锁桥给的都是 node// 前缀全形，深链只认裸 id
function bareNodeId(id) {
  const s = String(id == null ? '' : id);
  return s.replace(/^node\/\//, '');
}

// 会话深链：base 为控制台源（含尾斜杠与否都可），mode 见 VIEWMODES。
// 非法 mode / 空 id 一律返回 null（调用方据此停手，不生成坏链）。
function sessionUrl(base, nodeId, mode) {
  const vm = VIEWMODES[mode];
  const bare = bareNodeId(nodeId);
  if (!vm || !bare) return null;
  let b = String(base || '');
  if (!b) return null;
  if (!/\/$/.test(b)) b += '/';
  return b + '?node=' + encodeURIComponent(bare) + '&viewmode=' + vm;
}

/*
 * 控制通道 nodes 应答归一（页面与主进程共用同一份实现，见 buildPageLib）。
 * 入参 grouped：{ <分组id>: [节点, ...] }；meshes：{ <分组id>: {name} }（可缺）。
 * 节点字段按 MeshCentral 实际下发取：_id / name / rname / host / conn / pwr / desc。
 * W-30：conn 严格 ===1 才是在线；conn 为真但非 1（如 2=连接中）记 connecting，
 * 在线计数只算 ===1；字段缺失不猜、不冒充。status ∈ online | connecting | offline。
 * 本函数必须自包含（不引用模块作用域），因为要被序列化进页面执行。
 */
function normalizeNodes(grouped, meshes) {
  const groups = [];
  let total = 0;
  let onlineCount = 0;
  const g = (grouped && typeof grouped === 'object') ? grouped : {};
  const m = (meshes && typeof meshes === 'object') ? meshes : {};
  for (const gid of Object.keys(g)) {
    const arr = Array.isArray(g[gid]) ? g[gid] : [];
    const devices = [];
    for (const n of arr) {
      if (!n || !n._id) continue;
      const fullId = String(n._id);
      const dev = {
        id: fullId.replace(/^node\/\//, ''),
        fullId,
        name: String(n.name || n.rname || ''),
        host: String(n.host || ''),
        desc: String(n.desc || ''),
        online: n.conn === 1,
        status: n.conn === 1 ? 'online' : (n.conn ? 'connecting' : 'offline'),
        power: (typeof n.pwr === 'number') ? n.pwr : null
      };
      devices.push(dev);
      total++;
      if (dev.online) onlineCount++;
    }
    devices.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const gname = (m[gid] && m[gid].name) ? String(m[gid].name) : '';
    groups.push({ id: String(gid), name: gname, devices });
  }
  groups.sort((a, b) => {
    if (a.devices.length !== b.devices.length) return b.devices.length - a.devices.length;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });
  return { groups, total, onlineCount };
}

/*
 * 控制通道探针（在设备页里执行，与网页版控制台 fetchControlNodes 同协议）：
 * 连 wss://<控制台源>/control.ashx（页面所在分区会话自动带控制台 cookie，
 * 即单点登录的既有会话，不产生第二次登录），发 nodes 探针，按
 * responseid 收应答；超时/出错安静返回 null，页面据此给重试态，不冒充空列表。
 * 本函数必须自包含（不引用模块作用域），因为要被序列化进页面执行。
 */
function probeNodes(wsUrl, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let ws = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { if (ws) ws.close(); } catch (e) { /* ignore */ }
      resolve(v || null);
    };
    let timer = null;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) { resolve(null); return; }
    timer = setTimeout(() => finish(null), (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 6000);
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ action: 'nodes', responseid: 'qf-nodes-probe' })); }
      catch (e) { clearTimeout(timer); finish(null); }
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.responseid === 'qf-nodes-probe') {
        clearTimeout(timer);
        finish({ nodes: msg.nodes || {}, meshes: msg.meshes || {} });
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onclose = () => { clearTimeout(timer); finish(null); };
  });
}

// 页面库源码串：与单测同一份实现（normalizeNodes＋probeNodes）的序列化
// 形态，备其它页面上下文复用。
function buildPageLib() {
  return '(function(){' +
    'var normalizeNodes = ' + normalizeNodes.toString() + ';' +
    'var probeNodes = ' + probeNodes.toString() + ';' +
    'window.qfDevLib = { normalizeNodes: normalizeNodes, probeNodes: probeNodes };' +
    '})();';
}

// 探针调用串：主进程把 probeNodes 注入「已登录的控制台视图」页面上下文
// 执行——同源上下文自带控制台会话（本地 file:// 页的 WS 握手带不上会话
// cookie、会被服务端以 noauth 关闭，2026-10-26 真环境实测），这与网页版
// 控制台在自家页面里发探针是同一条路。返回 Promise<{nodes,meshes}|null>。
function buildProbeCall(wsUrl, timeoutMs) {
  return '(' + probeNodes.toString() + ')(' + JSON.stringify(String(wsUrl || '')) + ',' +
    ((typeof timeoutMs === 'number' && timeoutMs > 0) ? Math.floor(timeoutMs) : 6000) + ')';
}

// 主链点击计量（自验与督导终审共用口径）：登录完成落设备页之后的步数。
// 任一步增加都必须在本表显形，不许把点击藏进菜单/分栏。
function mainChain() {
  return [
    { step: 'land-devices', label: '登录后落新版设备页', clicks: 0 },
    { step: 'pick-device', label: '点设备卡片（详情在本页展开，不跳页）', clicks: 1 },
    { step: 'connect', label: '点「连接」，桌面在壳内会话视图打开', clicks: 1 }
  ];
}
function mainChainClicks() {
  return mainChain().reduce((s, x) => s + x.clicks, 0);
}

module.exports = {
  CONTROL_WS_PATH, PROBE_RESPONSE_ID, PROBE_ACTION, VIEWMODES, MODE_LABELS,
  bareNodeId, sessionUrl, normalizeNodes, probeNodes, buildPageLib, buildProbeCall,
  mainChain, mainChainClicks
};
