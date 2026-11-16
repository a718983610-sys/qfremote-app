'use strict';
/*
 * QFRemote 会话防御 (a) 单测：挂载前控制面会话绑定校验。
 *  目标函数（均取自 server/webapp/app.js 真实源码，brace 抽取后在 vm 沙箱里跑，
 *  测的是发版代码本身，不是副本）：
 *   A. controlNodesContain：分组 nodes 里按裸 id 找目标（纯函数）。
 *   B. probeControlSessionOnce：一条 /control.ashx WS，match/mismatch/unknown
 *      三态（地址、动作、responseid、超时、出错、误 responseid、关闭）。
 *   C. checkSessionIdentity：缓存快路径 → 在途慢探测复用 → 单次 WS 探针。
 *   D. 静态：buildSessionFrame 调用点（W-01 后、t0 前、世代守卫、W-04 门含
 *      identityMismatch）、Sess.identityCheck 字段。
 *   E. 无回归：checkPresence / probeFrame / fetchControlNodes / driveConnect /
 *      frameNodeMatches / applyControlNodes / ensureNodeMap 与 HEAD（b943853）逐字一致（防御 (a) 之外的既有缓解未动）；
 *      startSlowProbe / fetchNodeMap 与 2026-11-13 基线快照逐字一致——网页深查修复「高-1」
 *      代次守卫（nodeMapGen：invalidate 自增，在飞旧代次回包一律丢弃）的直接后果，
 *      报告明言须由归属线更新基线；快照见文件内 BASELINE_20261113，今后改动须同步更新快照并写明原因。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-defense-a/session-defense-a-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
// W-08：app.js 已改名内容 hash 文件，经 ASSETS.json 解析当前文件名（只改读路径）
const WEBAPP_DIR = path.join(__dirname, '..', '..', 'server', 'webapp');
const ASSETS = JSON.parse(fs.readFileSync(path.join(WEBAPP_DIR, 'ASSETS.json'), 'utf8')).files;
const SRC = path.join(WEBAPP_DIR, (ASSETS && ASSETS['app.js']) || 'app.js');
const src = fs.readFileSync(SRC, 'utf8');

// ---------- 抽取函数源码（brace 配对；目标函数内花括号均成对） ----------
function extractFn(source, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('not found: ' + name);
  let start = m.index;
  const before = source.slice(0, start).replace(/\s+$/, '');
  if (before.endsWith('async')) start = before.length - 5; // 含 async 前缀
  let i = source.indexOf('{', m.index);
  if (i < 0) throw new Error('no body: ' + name);
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
function extractConst(source, name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);');
  const m = re.exec(source);
  if (!m) throw new Error('const not found: ' + name);
  return 'const ' + name + ' = ' + m[1] + ';';
}

const fns = ['bareNodeId', 'ensureNodeMap', 'applyControlNodes', 'controlNodesContain', 'probeControlSessionOnce', 'checkSessionIdentity'];
const fnSrc = {};
fns.forEach((n) => { fnSrc[n] = extractFn(src, n); });

// ---------- 沙箱：假 WebSocket + location + 计时器 ----------
function makeSandbox() {
  const instances = [];
  class FakeWS {
    constructor(url) {
      this.url = url; this.sent = []; this.closed = false;
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      instances.push(this);
    }
    send(s) { this.sent.push(s); }
    close() { this.closed = true; }
  }
  const sandbox = {
    console: { debug: () => {}, log: () => {} },
    location: { protocol: 'https:', host: 'app.qfremote.top' },
    WebSocket: FakeWS,
    setTimeout, clearTimeout, Date, JSON, Object, Array, Promise,
    nodeMapCache: null, nodeMapSlowInflight: null,
    __instances: instances,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const prelude = [
    extractConst(src, 'NODE_MAP_TTL_MS'),
    extractConst(src, 'CONTROL_PROBE_MS'),
    'let nodeMapCache = null;',
    'let nodeMapSlowInflight = null;',
    fnSrc.bareNodeId, fnSrc.ensureNodeMap, fnSrc.applyControlNodes,
    fnSrc.controlNodesContain, fnSrc.probeControlSessionOnce, fnSrc.checkSessionIdentity,
  ].join('\n');
  vm.runInContext(prelude, sandbox);
  sandbox.__reset = () => {
    vm.runInContext('nodeMapCache = null; nodeMapSlowInflight = null;', sandbox);
    instances.length = 0;
  };
  sandbox.__setSlowInflight = (p) => { sandbox.nodeMapSlowInflight = p; };
  sandbox.__run = (code) => vm.runInContext(code, sandbox);
  return sandbox;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------- A. controlNodesContain ----------
  {
    const sb = makeSandbox();
    const t = (g, id) => sb.__run('controlNodesContain(' + JSON.stringify(g) + ',' + JSON.stringify(id) + ')');
    const g1 = { 'mesh//g1': [{ _id: 'node//abc', name: 'A' }, { _id: 'node//def', name: 'B' }] };
    ok('A1_match_full', t(g1, 'node//abc') === true);
    ok('A2_match_bare', t(g1, 'abc') === true);
    ok('A3_mismatch', t(g1, 'zzz') === false);
    ok('A4_empty_grouped', t({}, 'abc') === false);
    ok('A5_null_grouped', t(null, 'abc') === false);
    ok('A6_no_id_skipped', t({ g: [{ name: 'NoId' }, { _id: 'node//abc' }] }, 'abc') === true);
    ok('A7_empty_target', t(g1, '') === false);
    ok('A8_multi_group', t({ g1: [{ _id: 'node//x' }], g2: [{ _id: 'node//abc' }] }, 'abc') === true);
  }

  // ---------- B. probeControlSessionOnce ----------
  {
    // B1 match：地址/动作/responseid/关闭
    const sb = makeSandbox();
    const p = sb.__run('probeControlSessionOnce("abc", 500)');
    await sleep(10);
    ok('B1_ws_opened_once', sb.__instances.length === 1);
    const ws = sb.__instances[0];
    ok('B1_ws_url', ws.url === 'wss://app.qfremote.top/control.ashx', { url: ws.url });
    ws.onopen();
    const sent = JSON.parse(ws.sent[0] || '{}');
    ok('B1_sent_action', sent.action === 'nodes' && sent.responseid === 'qf-sess-identity', { sent });
    ws.onmessage({ data: JSON.stringify({ responseid: 'qf-sess-identity', nodes: { g: [{ _id: 'node//abc', name: 'A' }] } }) });
    const r1 = await p;
    ok('B1_match', r1.status === 'match', { status: r1.status });
    ok('B1_ws_closed', ws.closed === true);
    ok('B1_cache_backfilled', sb.__run('ensureNodeMap().byId.has("abc")') === true);
  }
  {
    // B2 mismatch：回包有节点但无目标
    const sb = makeSandbox();
    const p = sb.__run('probeControlSessionOnce("zzz", 500)');
    await sleep(10);
    const ws = sb.__instances[0];
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ responseid: 'qf-sess-identity', nodes: { g: [{ _id: 'node//abc' }] } }) });
    const r = await p;
    ok('B2_mismatch', r.status === 'mismatch', { status: r.status });
    ok('B2_cache_backfilled_other', sb.__run('ensureNodeMap().byId.has("abc")') === true);
  }
  {
    // B3 超时 → unknown（30ms 预算）
    const sb = makeSandbox();
    const t0 = Date.now();
    const r = await sb.__run('probeControlSessionOnce("abc", 30)');
    ok('B3_timeout_unknown', r.status === 'unknown' && (Date.now() - t0) < 500, { status: r.status, ms: Date.now() - t0 });
  }
  {
    // B4 出错 → unknown
    const sb = makeSandbox();
    const p = sb.__run('probeControlSessionOnce("abc", 500)');
    await sleep(10);
    sb.__instances[0].onerror();
    const r = await p;
    ok('B4_error_unknown', r.status === 'unknown', { status: r.status });
  }
  {
    // B5 误 responseid 被忽略，正确回包才结算
    const sb = makeSandbox();
    const p = sb.__run('probeControlSessionOnce("abc", 500)');
    await sleep(10);
    const ws = sb.__instances[0];
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ responseid: 'qf-nodes-probe', nodes: { g: [{ _id: 'node//abc' }] } }) });
    await sleep(10);
    ok('B5_wrong_responseid_ignored', sb.__run('true') === true && ws.closed === false);
    ws.onmessage({ data: JSON.stringify({ responseid: 'qf-sess-identity', nodes: { g: [{ _id: 'node//abc' }] } }) });
    const r = await p;
    ok('B5_then_match', r.status === 'match', { status: r.status });
  }
  {
    // B6 坏 JSON 被忽略，不抛错
    const sb = makeSandbox();
    const p = sb.__run('probeControlSessionOnce("abc", 500)');
    await sleep(10);
    const ws = sb.__instances[0];
    ws.onopen();
    ws.onmessage({ data: '{not json' });
    ws.onmessage({ data: JSON.stringify({ responseid: 'qf-sess-identity', nodes: { g: [{ _id: 'node//abc' }] } }) });
    const r = await p;
    ok('B6_bad_json_ignored', r.status === 'match', { status: r.status });
  }

  // ---------- C. checkSessionIdentity ----------
  {
    // C1 缓存快路径：新鲜缓存含目标 → match，零 WS
    const sb = makeSandbox();
    sb.__run('applyControlNodes({g:[{_id:"node//abc",name:"A"}]}); ensureNodeMap().at = Date.now();');
    const r = await sb.__run('checkSessionIdentity("abc")');
    ok('C1_cache_match', r.status === 'match' && sb.__instances.length === 0, { status: r.status, ws: sb.__instances.length });
  }
  {
    // C2 缓存过期 → 走 WS 探针
    const sb = makeSandbox();
    sb.__run('applyControlNodes({g:[{_id:"node//abc",name:"A"}]}); ensureNodeMap().at = Date.now() - 61000;');
    const p = sb.__run('checkSessionIdentity("abc")');
    await sleep(10);
    ok('C2_stale_cache_probes_ws', sb.__instances.length === 1);
    const ws = sb.__instances[0];
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ responseid: 'qf-sess-identity', nodes: { g: [{ _id: 'node//abc' }] } }) });
    const r = await p;
    ok('C2_stale_cache_match', r.status === 'match', { status: r.status });
  }
  {
    // C3 新鲜缓存无目标 → 不直接判 mismatch，走 WS 复核
    const sb = makeSandbox();
    sb.__run('applyControlNodes({g:[{_id:"node//other",name:"O"}]}); ensureNodeMap().at = Date.now();');
    const p = sb.__run('checkSessionIdentity("abc")');
    await sleep(10);
    ok('C3_fresh_cache_without_target_probes_ws', sb.__instances.length === 1);
    const ws = sb.__instances[0];
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ responseid: 'qf-sess-identity', nodes: { g: [{ _id: 'node//abc' }] } }) });
    const r = await p;
    ok('C3_ws_overrules_cache', r.status === 'match', { status: r.status });
  }
  {
    // C4 在途慢探测复用：不等新 WS，等它填完缓存
    const sb = makeSandbox();
    sb.__run('nodeMapSlowInflight = (async () => { await new Promise(r => setTimeout(r, 20)); applyControlNodes({g:[{_id:"node//abc"}]}); })();');
    const r = await sb.__run('checkSessionIdentity("abc")');
    ok('C4_inflight_reused_match', r.status === 'match' && sb.__instances.length === 0, { status: r.status, ws: sb.__instances.length });
  }
  {
    // C5 在途慢探测填完仍无目标 → mismatch，不另开 WS
    const sb = makeSandbox();
    sb.__run('nodeMapSlowInflight = (async () => { await new Promise(r => setTimeout(r, 20)); applyControlNodes({g:[{_id:"node//other"}]}); })();');
    const r = await sb.__run('checkSessionIdentity("abc")');
    ok('C5_inflight_done_mismatch', r.status === 'mismatch' && sb.__instances.length === 0, { status: r.status, ws: sb.__instances.length });
  }
  {
    // C6 WS 探针失败 → unknown（不拦挂载的降级口径）
    const sb = makeSandbox();
    const p = sb.__run('checkSessionIdentity("abc")');
    await sleep(10);
    sb.__instances[0].onerror();
    const r = await p;
    ok('C6_ws_fail_unknown', r.status === 'unknown', { status: r.status });
  }
  {
    // C7 空 nodeid → mismatch
    const sb = makeSandbox();
    const r = await sb.__run('checkSessionIdentity("")');
    ok('C7_empty_mismatch', r.status === 'mismatch', { status: r.status });
  }

  // ---------- D. 静态：调用点 ----------
  {
    const bsf = extractFn(src, 'buildSessionFrame');
    const iIdentity = bsf.indexOf('await checkSessionIdentity(Sess.nodeid)');
    const iT0 = bsf.indexOf('Sess.t0 = performance.now()');
    const iGen = bsf.indexOf('if (gen0 !== Sess.gen || !Sess.active) return;', iIdentity);
    ok('D1_call_before_t0', iIdentity > 0 && iT0 > iIdentity, { iIdentity, iT0 });
    ok('D2_gen_guard_after_await', iGen > iIdentity, { iGen });
    ok('D3_identityMismatch_in_gate', bsf.indexOf('!identityMismatch') > 0);
    ok('D4_identityCheck_recorded', bsf.indexOf("Sess.identityCheck = identity.status") > 0);
    ok('D5_gate_still_has_w04', bsf.indexOf("QF_PRE.ready === true") > 0 && bsf.indexOf("Sess.lastFailCode") > 0);
    ok('D6_sess_field', src.indexOf("identityCheck: ''") > 0);
    ok('D7_no_new_mask_on_mismatch', bsf.indexOf('identityMismatch') > 0 && !/identityMismatch[\s\S]{0,200}showSessionMask/.test(bsf));
  }

  // ---------- E. 无回归：7 个既有函数与 HEAD 逐字一致；2 个函数与 2026-11-13 基线快照逐字一致 ----------
  // 基线快照（2026-11-13，G11 补齐）：网页深查修复「高-1」代次守卫后的 startSlowProbe / fetchNodeMap
  // 全文，由本文件从当时 server/webapp/app.js 抽取、逐字存入；与快照不符即 fail，改动须同步更新快照。
  const BASELINE_20261113 = {
    startSlowProbe: "function startSlowProbe() {\n  if (nodeMapSlowInflight) return;\n  const gen0 = nodeMapGen; // 高-1：慢源回填前比代次，换账号后旧探测结果不写缓存、不刷设备行\n  nodeMapSlowInflight = fetchControlNodes(CONTROL_PROBE_MS)\n    .then((grouped) => { if (gen0 === nodeMapGen) { applyControlNodes(grouped); refreshDevRowIds(document); } })\n    .catch(() => {})\n    .then(() => { nodeMapSlowInflight = null; });\n}",
    fetchNodeMap: "async function fetchNodeMap(opts) {\n  const force = !!(opts && opts.force);\n  const deferSlow = !!(opts && opts.deferSlow);\n  const gen0 = nodeMapGen; // 高-1：本次取数代次，快源回包与 .then 清位都先比代次\n  // X-05：首屏 defer 过的慢源，在下一次非首屏取数时补起（哪怕本次命中页内缓存\n  // 直接返回，也要把 WS 建起来，否则共享设备 id 会一直缺到 TTL 过期）。\n  if (!deferSlow && nodeMapSlowDeferred && !nodeMapSlowInflight) { nodeMapSlowDeferred = false; startSlowProbe(); }\n  if (nodeMapInflight) return nodeMapInflight;                 // single-flight\n  const nm0 = ensureNodeMap();\n  if (!force && nm0.at && (Date.now() - nm0.at) < NODE_MAP_TTL_MS) return nm0;\n  nodeMapInflight = (async () => {\n    let lockStatus = 'ok', lockError = '';\n    try {\n      // X-14：force 时 /lock/devices 带 ?force=1，跳过服务端非机主缓存与失败抑制实读一次。\n      const lr = await lockApi('GET', force ? '/devices?force=1' : '/devices');\n      // 高-1：快源在飞期间已 invalidate（登出/换账号/强制下线）：旧账号结果\n      // 一个字节都不写缓存——校验必须在 applyLockDevices 之前，否则旧设备\n      // 已落缓存。返回当前缓存（新账号已取到的即新数据，尚未取到的为空壳\n      // 且 at=0，下次调用必重取），旧调用方凭原有守卫丢弃。\n      if (gen0 !== nodeMapGen) return ensureNodeMap();\n      if (lr.status === 200 && lr.json && Array.isArray(lr.json.devices)) {\n        applyLockDevices(lr.json.devices);\n        // X-13：服务端回 partial/pending（读路径预算用尽、部分设备未实读）时\n        // 记在节点图上，锁面板据此明示并补拉，不得静默漏设备。\n        const nm2 = ensureNodeMap();\n        nm2.lockPartial = !!lr.json.partial; nm2.lockPending = lr.json.pending || 0;\n      } else if (lr.status === 401) { lockStatus = 'needlogin'; lockError = apiErrText(lr, '登录状态已失效，请重新登录后再管理屏幕锁。'); }\n      else if (lr.networkError) { lockStatus = 'unreachable'; lockError = '暂时连不上屏幕锁服务，请检查网络后重试。'; }\n      else { lockStatus = 'unavailable'; lockError = apiErrText(lr, '屏幕锁服务暂未开通网页通道，暂时无法在此管理。请通过软件端管理该设备的屏幕锁。'); }\n    } catch (e) { lockStatus = 'unreachable'; lockError = '暂时连不上屏幕锁服务，请检查网络后重试。'; }\n    const nm = ensureNodeMap();\n    nm.lockStatus = lockStatus; nm.lockError = lockError; nm.at = Date.now();\n    // 慢源不阻塞：后台拉控制通道全量 nodes，回来只回填缓存（供后续导航/共享设备用）。\n    // X-05：首屏 deferSlow 时只记待补、不建 WS（见文件头注释）。\n    if (deferSlow) nodeMapSlowDeferred = true;\n    else startSlowProbe();\n    return nm;\n  })().then((v) => { if (gen0 === nodeMapGen) nodeMapInflight = null; return v; },\n            (e) => { if (gen0 === nodeMapGen) nodeMapInflight = null; throw e; });\n  return nodeMapInflight;\n}",
  };
  {
    let head = null;
    try {
      head = execSync('git show HEAD:server/webapp/app.js', { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 15000 });
    } catch (e) { head = null; }
    if (!head) {
      ok('E0_head_available', false, { note: 'git show HEAD 失败，跳过 E 组比对' });
    } else {
      ok('E0_head_available', true);
      ['checkPresence', 'probeFrame', 'fetchControlNodes', 'driveConnect', 'frameNodeMatches', 'applyControlNodes', 'ensureNodeMap'].forEach((n) => {
        let a = null, b = null;
        try { a = extractFn(src, n); } catch (e) { a = null; }
        try { b = extractFn(head, n); } catch (e) { b = null; }
        ok('E_' + n + '_unchanged_vs_head', a !== null && b !== null && a === b);
      });
    }
    // 高-1 基线：逐字比对快照＋语义守卫双重断言（快照被删/改短仍能由守卫断言兜底）。
    ['startSlowProbe', 'fetchNodeMap'].forEach((n) => {
      let a = null;
      try { a = extractFn(src, n); } catch (e) { a = null; }
      ok('E_' + n + '_baseline_20261113', a !== null && a === BASELINE_20261113[n]);
    });
    const ssp = extractFn(src, 'startSlowProbe');
    const fnm = extractFn(src, 'fetchNodeMap');
    ok('E_startSlowProbe_gen_guard', ssp.includes('const gen0 = nodeMapGen') && ssp.includes('if (gen0 === nodeMapGen) { applyControlNodes(grouped)'));
    ok('E_fetchNodeMap_gen_guard', fnm.includes('const gen0 = nodeMapGen') && fnm.indexOf('if (gen0 !== nodeMapGen) return ensureNodeMap();') > 0 && fnm.indexOf('if (gen0 !== nodeMapGen) return ensureNodeMap();') < fnm.indexOf('applyLockDevices(lr.json.devices)') && (fnm.split('if (gen0 === nodeMapGen) nodeMapInflight = null').length - 1) === 2);
  }

  const allPass = Object.values(result.cases).every((c) => c.pass);
  result.pass = allPass;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ pass: allPass, cases: Object.keys(result.cases).length, failed: Object.entries(result.cases).filter(([, c]) => !c.pass).map(([k]) => k) }, null, 2));
  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  result.error = String(e && e.stack || e);
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e2) {}
  console.error(e);
  process.exit(1);
});
