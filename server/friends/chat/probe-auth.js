'use strict';
/* 探针 v2：服务器认证成功后会主动下发 {action:'userinfo', userinfo:{...}}
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
  console.log('== correct =='); console.log((await probe('alice01test', 'AlicePass123')).join('\n'));
  console.log('== wrong pass =='); console.log((await probe('alice01test', 'WrongPass999')).join('\n'));
  console.log('== no user =='); console.log((await probe('nosuchuser99', 'Whatever123')).join('\n'));
  process.exit(0);
})();
