'use strict';
/* 互联窗观察（2.3.2 线 D）冒烟自测：node test-client-version.js
 * 起一个本服务实例（全路径指向临时目录，端口随机高位），验证：
 *  1) 带 x-qf-client-version 头请求 /license/api/* → jsonl 落一行（username 无会话时为 null）；
 *  2) 不带头请求同一接口 → 不落行，且接口行为不变（同为 401 UNAUTHORIZED）；
 *  3) 带头请求非 /license/api/ 路径（/health）→ 不落行；
 *  4) 落行字段齐全 {ts, username, version, path}。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfext-cv-'));
const cvFile = path.join(tmp, 'client-versions.jsonl');
const PORT = 18448;
const env = Object.assign({}, process.env, {
  QFEXT_BIND: '127.0.0.1',
  QFEXT_PORT: String(PORT),
  QFLIC_DIR: path.join(tmp, 'lic'),
  QFEXT_DATA_DIR: path.join(tmp, 'data'),
  QFEXT_DB_FILE: path.join(tmp, 'no-such.db'),
  QFEXT_LEDGER_FILE: path.join(tmp, 'no-ledger.json'),
  QFEXT_APPEALS_FILE: path.join(tmp, 'no-appeals.json'),
  QFEXT_CLIENT_VERSIONS_FILE: cvFile,
});

function get(p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers: headers || {} }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readLines() {
  try { return fs.readFileSync(cvFile, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)); }
  catch (e) { return []; }
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  try {
    // 等监听就绪
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { const r = await get('/health'); up = r.status === 200; } catch (e) { await sleep(200); } }
    assert.ok(up, '服务未起来: ' + err);

    const withHead = await get('/license/api/me', { 'x-qf-client-version': '2.3.2' });
    assert.strictEqual(withHead.status, 401, '无会话应 401，实际 ' + withHead.status);
    assert.ok(withHead.body.includes('UNAUTHORIZED'), '401 语义不变');
    await sleep(100);
    let lines = readLines();
    assert.strictEqual(lines.length, 1, '带头应落 1 行，实际 ' + lines.length);
    assert.strictEqual(lines[0].version, '2.3.2');
    assert.strictEqual(lines[0].path, '/license/api/me');
    assert.strictEqual(lines[0].username, null);
    assert.ok(typeof lines[0].ts === 'string' && lines[0].ts.length > 0, 'ts 齐全');

    const noHead = await get('/license/api/me');
    assert.strictEqual(noHead.status, 401, '不带头行为不变（401）');
    await sleep(100);
    lines = readLines();
    assert.strictEqual(lines.length, 1, '不带头不应落行，实际 ' + lines.length);

    const other = await get('/health', { 'x-qf-client-version': '2.3.2' });
    assert.strictEqual(other.status, 200);
    await sleep(100);
    lines = readLines();
    assert.strictEqual(lines.length, 1, '非 /license/api/ 不应落行，实际 ' + lines.length);

    console.log('全部通过：带头落行 / 不带头不落 / 非许可路径不落 / 行为不变');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAIL: ' + (e && e.message)); process.exit(1); });
