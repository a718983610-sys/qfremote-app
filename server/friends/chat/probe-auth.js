'use strict';
/* 仅限本地测试。凭据从 QFCHAT_PROBE_USER / QFCHAT_PROBE_PASSWORD 注入。
 * 探针 v2：服务器认证成功后会主动下发 {action:'userinfo', userinfo:{...}}
 * （meshuser.js:667）。据此判定三种情况的真实行为。只连本机测试实例。 */
const WebSocket = require('ws');
const URL = 'wss://127.0.0.1:18443/control.ashx';

function probe(user, pass) {
  return new Promise((resolve) => {
    const events = [];
    const auth = Buffer.from(user).toString('base64') + ',' + Buffer.from(pass).toString('base64');
    const ws = new WebSocket(URL, { rejectUnauthorized: false, headers: { 'x-meshauth': auth } });
    let finished = false;
    const finish = () => { if (!finished) { finished = true; clearTimeout(timer); try { ws.close(); } catch (e) {} resolve(events); } };
    const timer = setTimeout(() => { events.push('TIMEOUT'); finish(); }, 4000);
    ws.on('open', () => events.push('OPEN'));
    ws.on('message', (d) => { events.push('MSG:' + d.toString().slice(0, 220)); });
    ws.on('error', (e) => { events.push('ERROR:' + e.message); });
    ws.on('close', (code) => { events.push('CLOSE:' + code); finish(); });
  });
}
(async () => {
  const user = process.env.QFCHAT_PROBE_USER;
  const pass = process.env.QFCHAT_PROBE_PASSWORD;
  if (!user || !pass) throw new Error('Set QFCHAT_PROBE_USER and QFCHAT_PROBE_PASSWORD for the local test instance.');
  console.log('== credential probe ==');
  console.log((await probe(user, pass)).join('\n'));
})().catch(() => { console.error('Local authentication probe failed.'); process.exitCode = 1; });
