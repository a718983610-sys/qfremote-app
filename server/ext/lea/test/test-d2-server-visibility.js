'use strict';
/*
 * D2 server.js 集成测试（2026-11-18）
 * 用真实的合并树 server.js（QFEXT_NO_LISTEN=1，不监听）＋假 MeshCentral
 * ws 服务器，验 listVisibleDeviceIds 的真实行为：
 *  - 按控制台会话 cookie 的 xid 区分账号：alice 的 cookie 只见 DEV1，
 *    bob 的只见 DEV2（数据来自 MeshCentral nodes 回包，非请求体自报）
 *  - 节点经 flattenMeshNodes 去前缀、去重；空回包 → []（路由层 403）
 *  - 无 cookie／会话被拒／MeshCentral 不可达／8 秒无应答 → 抛错（路由层 503）
 *  - 5 秒共享缓存：同一 cookie 第二次调用不再开新连接
 *  - 会话 cookie 原样透传给 MeshCentral 控制通道（Cookie 头实测）
 * 运行：node test-d2-server-visibility.js（在本目录）
 * 注意：MC_URL 在 server.js 加载时读取，故先启动假服务器、设好环境变
 * 量再 require。QFLIC_DIR／QFEXT_DATA_DIR 指向临时空目录，不碰生产数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; failures.push(name); console.log('FAIL-', name, extra ? String(extra).slice(0, 300) : ''); }
}
function sorted(a) { return [...a].sort(); }

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-srv-data-'));
const tmpLic = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-srv-lic-'));

// ---------- 假 MeshCentral ----------
const NODES_ALICE = { 'mesh-alice': [
  { _id: 'node//srv-dev-1', name: 'alice-pc', conn: 1 },
  { _id: 'node//srv-shared', name: 'shared-pc', conn: 1 },
] };
const NODES_BOB = { 'mesh-bob': [
  { _id: 'node//srv-dev-2', name: 'bob-pc', conn: 1 },
  { _id: 'node//srv-shared', name: 'shared-pc', conn: 1 },
],
  'mesh-other': [ // 同一设备在两个分组里出现——flatten 须去重，只留一条
    { _id: 'node//srv-shared', name: 'shared-pc', conn: 1 },
  ] };
let connections = 0;
const seenCookies = [];
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
wss.on('connection', (ws, req) => {
  connections++;
  const cookie = (req.headers && req.headers.cookie) || '';
  seenCookies.push(cookie);
  const jar = {};
  String(cookie).split(';').forEach((part) => { const i = part.indexOf('='); if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim(); });
  const xid = jar.xid || '';
  if (xid === 'bad-xid') { // 会话被拒：立刻回 action=close
    try { ws.send(JSON.stringify({ action: 'close' })); } catch (e) {}
    setTimeout(() => { try { ws.close(); } catch (e) {} }, 50);
    return;
  }
  // 验真成功：服务器主动下发 userinfo
  try { ws.send(JSON.stringify({ action: 'userinfo', userinfo: { name: xid.replace('-xid', ''), userid: 'user/' + xid } })); } catch (e) {}
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || m.action !== 'nodes' || !m.responseid) return;
    if (xid === 'silent-xid') return; // 永远不应答（测 8 秒预算超时）
    let nodes = {};
    if (xid === 'alice-xid') nodes = NODES_ALICE;
    else if (xid === 'bob-xid') nodes = NODES_BOB;
    else if (xid === 'empty-xid') nodes = {};
    else nodes = {};
    try { ws.send(JSON.stringify({ action: 'nodes', responseid: m.responseid, nodes })); } catch (e) {}
  });
});

(async () => {
  await new Promise((resolve) => wss.on('listening', resolve));
  const port = wss.address().port;
  process.env.QFEXT_MC_URL = 'ws://127.0.0.1:' + port + '/control.ashx';
  process.env.QFEXT_NO_LISTEN = '1';
  process.env.QFEXT_DATA_DIR = tmpData;
  process.env.QFLIC_DIR = tmpLic;
  process.env.QFEXT_MC_DATA_DIR = path.join(tmpData, 'mc-data');

  // server.js 在加载时读 MC_URL，故环境变量须在 require 之前设好。
  let srv;
  try {
    srv = require('../../server.js');
  } catch (e) {
    t('真实 server.js 加载成功（QFEXT_NO_LISTEN=1，不监听）', false, e && e.stack);
    console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '；失败 ' + fail);
    process.exit(1);
  }
  t('真实 server.js 加载成功（QFEXT_NO_LISTEN=1，不监听）', !!srv);
  t('server.js 导出 listVisibleDeviceIds', typeof srv.listVisibleDeviceIds === 'function');
  // 注入静态核对：createLeaRoutes 的 deps 里确有本函数（路由层 wiring）
  const srvSrc = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  t('server.js 内 createLeaRoutes deps 注入 listVisibleDeviceIds', srvSrc.includes('listVisibleDeviceIds: (a, req) => listVisibleDeviceIds(a, req)'));
  const listVisibleDeviceIds = srv.listVisibleDeviceIds;
  const reqFor = (cookie) => ({ headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } });

  // 1) alice 的 cookie → 只见自己的设备＋共享设备
  let out = await listVisibleDeviceIds({ user: 'alice', siteadmin: 0 }, reqFor('xid=alice-xid; xid.sig=sig-a'));
  const aliceOut = sorted(out);
  t('alice cookie → [srv-dev-1, srv-shared]（去前缀）', JSON.stringify(aliceOut) === JSON.stringify(['srv-dev-1', 'srv-shared']), JSON.stringify(out));
  // 2) bob 的 cookie → 只见自己的设备＋共享设备（不含 alice 的设备）
  out = await listVisibleDeviceIds({ user: 'bob', siteadmin: 0 }, reqFor('xid=bob-xid; xid.sig=sig-b'));
  const bobOut = sorted(out);
  t('bob cookie → [srv-dev-2, srv-shared]（去前缀、跨分组去重）', JSON.stringify(bobOut) === JSON.stringify(['srv-dev-2', 'srv-shared']), JSON.stringify(out));
  t('双账户隔离：alice 清单不含 srv-dev-2，bob 清单不含 srv-dev-1', !aliceOut.includes('srv-dev-2') && !bobOut.includes('srv-dev-1'));
  // 3) 会话 cookie 原样透传给 MeshCentral（假服务器收到的 Cookie 头含 xid）
  t('会话 cookie 透传给 MeshCentral 控制通道', seenCookies.some((c) => c.includes('xid=alice-xid')) && seenCookies.some((c) => c.includes('xid=bob-xid')));
  // 4) 5 秒共享缓存：同一 cookie 第二次调用不再开新连接
  const connBefore = connections;
  out = await listVisibleDeviceIds({ user: 'alice', siteadmin: 0 }, reqFor('xid=alice-xid; xid.sig=sig-a'));
  t('同一 cookie 第二次调用走缓存（无新连接，结果一致）', connections === connBefore && JSON.stringify(sorted(out)) === JSON.stringify(['srv-dev-1', 'srv-shared']));
  // 换一个 xid（同一账号）→ 缓存键不同，重新取数（新连接；该会话在假服务器上无节点 → []）
  const connBefore2 = connections;
  out = await listVisibleDeviceIds({ user: 'alice', siteadmin: 0 }, reqFor('xid=alice-xid-2; xid.sig=sig-a2'));
  t('不同 xid 重新取数（新连接；未知会话无节点 → []）', connections === connBefore2 + 1 && JSON.stringify(sorted(out)) === JSON.stringify([]));
  // 5) 空节点回包 → []（确认不可见，路由层 403，与故障 503 区分）
  out = await listVisibleDeviceIds({ user: 'carol', siteadmin: 0 }, reqFor('xid=empty-xid; xid.sig=sig-e'));
  t('空节点回包 → []（不抛错）', Array.isArray(out) && out.length === 0);
  // 6) 会话被拒 → 抛错
  let threw = null;
  try { await listVisibleDeviceIds({ user: 'mallory', siteadmin: 0 }, reqFor('xid=bad-xid; xid.sig=sig-x')); } catch (e) { threw = e; }
  t('会话被拒（action=close）→ 抛错', !!threw);
  // 7) 无 cookie → 抛错，且假服务器未收到新连接
  const connBefore3 = connections;
  threw = null;
  try { await listVisibleDeviceIds({ user: 'alice', siteadmin: 0 }, reqFor('')); } catch (e) { threw = e; }
  t('无 cookie → 抛错且未开控制通道', !!threw && connections === connBefore3);
  // 8) 无 auth.user → 抛错
  threw = null;
  try { await listVisibleDeviceIds(null, reqFor('xid=alice-xid; xid.sig=sig-a')); } catch (e) { threw = e; }
  t('无 auth.user → 抛错', !!threw);
  // 9) 8 秒无应答 → 预算内抛错（不无限挂起）
  const t0 = Date.now();
  threw = null;
  try { await listVisibleDeviceIds({ user: 'dave', siteadmin: 0 }, reqFor('xid=silent-xid; xid.sig=sig-s')); } catch (e) { threw = e; }
  const elapsed = Date.now() - t0;
  t('MeshCentral 8 秒无应答 → 抛错（耗时约 8 秒，不挂起）', !!threw && elapsed >= 7000 && elapsed < 20000, 'elapsed=' + elapsed);
  // 10) MeshCentral 不可达 → 抛错（先停假服务器）
  await new Promise((resolve) => wss.close(resolve));
  threw = null;
  try { await listVisibleDeviceIds({ user: 'alice', siteadmin: 0 }, reqFor('xid=down-xid; xid.sig=sig-d')); } catch (e) { threw = e; }
  t('MeshCentral 不可达（连接被拒）→ 抛错', !!threw);

  console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '；失败 ' + fail + (failures.length ? '：' + failures.join('；') : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
