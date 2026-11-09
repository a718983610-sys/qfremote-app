'use strict';
/* presence（GET /api/device/presence）单元自测：node test-presence.js
 * 覆盖 2.4.5 §4.1/§4.2 的纯函数层（不走网络、不碰 MC）：
 *  1) resolvePresence 的 ONLINE / STALE / OFFLINE / NOT_FOUND / UNKNOWN / TIMEOUT；
 *  2) observeNodesForPresence 打戳（conn&1 记在线，=0 记离线并保留上次在线）；
 *  3) flattenMeshNodes 的 agct 透传（连接建立时间，只作诊断参考）；
 *  4) 越权隔离：A 账号的观测记录绝不用来回答 B 账号的查询（B 查 → NOT_FOUND）；
 *  5) savePointsSoon 的 5 秒合并：同一进程 10 秒内多次调用只落盘 ≤2 次。
 * 路由 HTTP 层（401/403/400）须 MC 才能跑通，沙箱内无法验证，
 * 由协调人在服务端冒烟（见回报），此处不伪造。
 * 运行前置：QFEXT_NO_LISTEN=1（不监听端口）、QFEXT_DATA_DIR 指临时目录。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfext-presence-'));
process.env.QFEXT_NO_LISTEN = '1';
process.env.QFEXT_DATA_DIR = path.join(tmp, 'data');
process.env.QFEXT_DB_FILE = path.join(tmp, 'no-such.db');
process.env.QFEXT_LEDGER_FILE = path.join(tmp, 'no-ledger.json');

const S = require('./server');

let passed = 0, failed = 0;
function t(name, cond) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name); }
}

const T0 = Date.parse('2026-11-10T00:00:00Z');
const mesh = (id, conn, agct) => ({ 'mesh//x': [{ _id: 'node//' + id, name: id, conn, agct }] });
const meshOther = { 'mesh//x': [{ _id: 'node//OTHER', name: 'OTHER', conn: 1 }] };

// 0) 阈值常量与导出齐全
t('阈值常量 fresh=120s stale=300s', S.PRESENCE_FRESH_MS === 120000 && S.PRESENCE_STALE_MS === 300000);
t('导出齐全', typeof S.resolvePresence === 'function' && typeof S.observeNodesForPresence === 'function'
  && typeof S.presenceObsFor === 'function' && typeof S.flattenMeshNodes === 'function'
  && typeof S.savePointsSoon === 'function');

// 1) flattenMeshNodes：conn 位判在线，agct 只透传不参与判定
{
  const list = S.flattenMeshNodes({ 'mesh//x': [
    { _id: 'node//A', name: 'A', conn: 1, agct: 1700000000000 },
    { _id: 'node//B', name: 'B', conn: 0 },
    { _id: 'node//A', name: 'A-dup', conn: 1 }, // 重复去重
  ] });
  t('flatten：conn=1 在线、agct 透传', list.find(d => d.nodeid === 'A').online === true
    && list.find(d => d.nodeid === 'A').agentConnectedAt === 1700000000000);
  t('flatten：conn=0 离线、缺 agct 为 null', list.find(d => d.nodeid === 'B').online === false
    && list.find(d => d.nodeid === 'B').agentConnectedAt === null);
  t('flatten：重复节点去重', list.length === 2);
}

// 2) ONLINE：回包里 conn=1 → ONLINE + fresh，lastAgentPong=观测时刻
{
  S.observeNodesForPresence(mesh('ON-1', 1, T0 - 3600000), 'alice', T0);
  const r = S.resolvePresence(mesh('ON-1', 1, T0 - 3600000), 'ON-1', T0 + 1000, 'alice');
  t('ONLINE：code/online/fresh', r.code === 'ONLINE' && r.online === true && r.fresh === true);
  t('ONLINE：lastAgentPong=观测时刻，age=1s', r.lastAgentPong === T0 && r.lastAgentPongAgeMs === 1000);
  t('ONLINE：agct 随包透传', r.agentConnectedAt === T0 - 3600000);
  t('ONLINE：node// 前缀入参同样命中', S.resolvePresence(mesh('ON-1', 1), 'node//ON-1', T0 + 1000, 'alice').code === 'ONLINE');
}

// 3) OFFLINE：回包里 conn=0 → OFFLINE，但保留上次在线时刻
{
  S.observeNodesForPresence(mesh('OFF-1', 1), 'alice', T0);
  S.observeNodesForPresence(mesh('OFF-1', 0), 'alice', T0 + 60000);
  const r = S.resolvePresence(mesh('OFF-1', 0), 'OFF-1', T0 + 60000, 'alice');
  t('OFFLINE：code/online/fresh', r.code === 'OFFLINE' && r.online === false && r.fresh === false);
  t('OFFLINE：lastAgentPong 保留上次在线', r.lastAgentPong === T0 && r.lastAgentPongAgeMs === 60000);
}

// 4) STALE：回包里缺失、最后在线 120–300 秒前
{
  S.observeNodesForPresence(mesh('ST-1', 1), 'alice', T0);
  const r = S.resolvePresence(meshOther, 'ST-1', T0 + 180000, 'alice');
  t('STALE：回包缺失且最后在线 180s 前', r.code === 'STALE' && r.online === false && r.fresh === false);
  t('STALE：lastAgentPong/age 对得上', r.lastAgentPong === T0 && r.lastAgentPongAgeMs === 180000);
}

// 5) UNKNOWN：回包里缺失、最后在线 ≤120 秒前（刚掉线，尚未判死）
{
  S.observeNodesForPresence(mesh('UN-1', 1), 'alice', T0);
  const r = S.resolvePresence(meshOther, 'UN-1', T0 + 60000, 'alice');
  t('UNKNOWN：回包缺失且最后在线 60s 前', r.code === 'UNKNOWN' && r.online === false && r.fresh === false);
}

// 6) NOT_FOUND：从未观测过、回包里也没有
{
  const r = S.resolvePresence(meshOther, 'NF-1', T0, 'alice');
  t('NOT_FOUND：无观测无回包', r.code === 'NOT_FOUND' && r.online === false && r.lastAgentPong === null);
}

// 7) TIMEOUT：取数失败（nodesByMesh=null）→ TIMEOUT，不冒充离线
{
  const r = S.resolvePresence(null, 'TO-1', T0, 'alice');
  t('TIMEOUT：nodes 取不到', r.code === 'TIMEOUT' && r.online === false && r.fresh === false);
}

// 8) 越权隔离：A 的观测记录绝不回答 B 的查询
{
  S.observeNodesForPresence(mesh('XO-1', 1), 'alice', T0);
  const rb = S.resolvePresence(meshOther, 'XO-1', T0 + 60000, 'bob');
  t('越权隔离：B 查 A 的设备 → NOT_FOUND（不泄露存在性）', rb.code === 'NOT_FOUND' && rb.lastAgentPong === null);
  const obsB = S.presenceObsFor('bob', 'XO-1');
  t('越权隔离：presenceObsFor(B) 无记录', obsB.lastAgentPong === null && obsB.lastAgentPongAgeMs === null);
  const ra = S.resolvePresence(meshOther, 'XO-1', T0 + 60000, 'alice');
  t('越权隔离：A 自己查仍是 UNKNOWN（对照）', ra.code === 'UNKNOWN');
}

// 9) presenceObsFor：打戳后 lastAgentPong 即观测时刻
{
  S.observeNodesForPresence(mesh('OB-1', 1), 'carol', T0 + 5000);
  const o = S.presenceObsFor('carol', 'OB-1');
  t('presenceObsFor：lastAgentPong=观测时刻', o.lastAgentPong === T0 + 5000);
}

// 10) savePointsSoon 的 5 秒合并（异步部分）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pointsFile = path.join(tmp, 'data', 'points.json');
  const first = S.savePointsSoon();
  t('savePointsSoon：首次立即落盘', first.saved === true && first.deferred === false);
  const mtimes = new Set();
  const watch = async () => {
    for (let i = 0; i < 110; i++) {
      try { mtimes.add(fs.statSync(pointsFile).mtimeMs); } catch (e) { /* 未落盘前不存在 */ }
      await sleep(100);
    }
  };
  const calls = [];
  for (let i = 0; i < 5; i++) calls.push(S.savePointsSoon());
  t('savePointsSoon：5 秒内后续调用全部延期', calls.every(c => c.saved === false && c.deferred === true));
  await watch();
  t('savePointsSoon：11 秒内落盘恰好 2 次（立即 1 次＋5 秒窗口补写 1 次）', mtimes.size === 2);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
