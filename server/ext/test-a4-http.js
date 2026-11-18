'use strict';
/*
 * A4 安全修复线（U2/U3/U6）HTTP 端到端交叉负向测试
 * ===================================================
 * 运行：node server/ext/test-a4-http.js（在 a4-fix-20261118 工作副本内）
 * 真起 server.js（127.0.0.1:18449，临时数据目录），两个真实登录会话
 * （sessions.json 预置：alice-a4 / bob-a4），LEA 绑定台账预置
 * （alice-dev-001 归 alice-a4，bob-dev-001 归 bob-a4）。
 * 覆盖 GPT B2 追加验收：A 用 B 的 sessionId、伪造 agentId、过期会话、
 * 已撤权会话（设备换绑＋账号封禁），任一跨账户操作成功即不通过。
 * 退出码：0 全过；1 有失败。临时目录与子进程一律清理。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const EXT = __dirname;
const PORT = 18449;
const BASE = 'http://127.0.0.1:' + PORT;

const ALICE = 'alice-a4';
const BOB = 'bob-a4';
const ALICE_DEV = 'alice-dev-001';
const BOB_DEV = 'bob-dev-001';

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; console.log('FAIL-', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpReq(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(BASE + p, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Cookie: 'qfr_ext=' + token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
      ),
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(chunks); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: chunks });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function b64url(b) { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); }
function unb64url(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

// Ed25519 测试签名密钥（现生成、仅放临时目录，64 字节 seed||pub 的 base64）。
function writeTestSigningKey(mcdataDir) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([unb64url(jwk.d), unb64url(jwk.x)]);
  if (raw.length !== 64) throw new Error('test signing key must be 64 bytes');
  fs.writeFileSync(path.join(mcdataDir, 'lea-signing-key.b64'), raw.toString('base64'), { mode: 0o600 });
}

function bindingsDoc(aliceDevOwner, bobDevOwner) {
  const b = {};
  b[ALICE_DEV] = { device_id: ALICE_DEV, account_id: aliceDevOwner, binding_epoch: 1, state: 'ACTIVE', updated_at: Date.now(), trigger: 'test' };
  b[BOB_DEV] = { device_id: BOB_DEV, account_id: bobDevOwner, binding_epoch: 1, state: 'ACTIVE', updated_at: Date.now(), trigger: 'test' };
  return { bindings: b };
}

async function waitHealth(proc, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await httpReq('GET', '/health');
      if (r.status === 200) return true;
    } catch (e) { /* 未起 */ }
    await sleep(250);
  }
  return false;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-http-'));
  const licDir = path.join(tmp, 'lic');
  const dataDir = path.join(tmp, 'data');
  const leaDir = path.join(tmp, 'lea');
  const mcdataDir = path.join(tmp, 'mcdata');
  const extDir = path.join(tmp, 'extdir');
  for (const d of [licDir, dataDir, leaDir, mcdataDir, extDir]) fs.mkdirSync(d, { recursive: true });
  writeTestSigningKey(mcdataDir);

  // 两个真实登录会话（sessions.json，服务端启动时读入内存）。
  const tokA = crypto.randomBytes(32).toString('hex');
  const tokB = crypto.randomBytes(32).toString('hex');
  const sessions = {};
  sessions[sha256(tokA)] = { user: ALICE, siteadmin: 0, exp: Date.now() + 30 * 24 * 3600 * 1000 };
  sessions[sha256(tokB)] = { user: BOB, siteadmin: 0, exp: Date.now() + 30 * 24 * 3600 * 1000 };
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify(sessions), { mode: 0o600 });
  // LEA 绑定台账。
  fs.writeFileSync(path.join(leaDir, 'bindings.json'), JSON.stringify(bindingsDoc(ALICE, BOB)), { mode: 0o600 });

  const env = Object.assign({}, process.env, {
    QFLIC_DIR: licDir, QFEXT_DATA_DIR: dataDir, QFEXT_LEA_DIR: leaDir,
    QFEXT_MC_DATA_DIR: mcdataDir, QFEXT_DIR: extDir,
    QFEXT_BIND: '127.0.0.1', QFEXT_PORT: String(PORT),
    QFEXT_QUALITY_IDLE_MS: '3000', QFEXT_IDR_IDLE_MS: '3000', QFEXT_L5_SWEEP_MS: '1000',
  });
  delete env.QFEXT_NO_LISTEN;

  const logFile = path.join(tmp, 'server.log');
  const logFd = fs.openSync(logFile, 'w');
  let proc = null;
  async function startServer() {
    proc = spawn('node', [path.join(EXT, 'server.js')], { env, stdio: ['ignore', logFd, logFd] });
    const ok = await waitHealth(proc, 15000);
    t('http:server-up', ok === true);
    return ok;
  }
  function stopServer() {
    if (proc) { try { proc.kill('SIGTERM'); } catch (e) {} proc = null; }
  }
  function showServerLogTail() {
    try {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      console.log('--- server.log tail ---');
      console.log(lines.slice(-25).join('\n'));
    } catch (e) { console.log('(server log unreadable)'); }
  }

  const probe = (tok, sid, p) => httpReq('POST', '/license/api/session/probe', tok, { sessionId: sid, probe: p || { rttMs: 80, lossPct: 0.5, jitterMs: 10, lossSamples: 100 } });
  const upgrade = (tok, sid) => httpReq('POST', '/license/api/session/quality/upgrade', tok, { sessionId: sid });
  const ack = (tok, sid, did) => httpReq('POST', '/license/api/session/quality/ack', tok, { sessionId: sid, decisionId: did });
  const idr = (tok, sid, agent, seq, reason) => httpReq('POST', '/license/api/session/idr-request', tok, { sessionId: sid, agentId: agent, seq, reason });

  try {
    if (!await startServer()) { showServerLogTail(); throw new Error('server did not come up'); }

    // ===== Phase 1：交叉负向（无封禁） =====
    let r = await httpReq('POST', '/license/api/session/probe', null, { sessionId: 'a4-s1', probe: { rttMs: 80, lossPct: 0.5, jitterMs: 10 } });
    t('http:probe-no-cookie-401', r.status === 401 && r.json && r.json.code === 'UNAUTHORIZED', { status: r.status, json: r.json });

    r = await probe(tokA, 'a4-s1');
    t('u2:alice-probe-own-session-ok', r.status === 200 && r.json && r.json.ok === true && r.json.tier === 'balanced', r.json);
    r = await probe(tokB, 'a4-s1');
    t('u2:bob-probe-alice-session-forbidden', r.status === 200 && r.json && r.json.ok === false && r.json.code === 'FORBIDDEN', r.json);
    r = await probe(tokA, 'a4-s1');
    t('u2:alice-probe-still-ok-after-bob-attempt', r.status === 200 && r.json && r.json.ok === true, r.json);
    r = await upgrade(tokB, 'a4-s1');
    t('u2:bob-upgrade-alice-session-forbidden', r.json && r.json.ok === false && r.json.code === 'FORBIDDEN', r.json);
    r = await upgrade(tokA, 'a4-s1');
    t('u2:alice-upgrade-passes-owner-check', r.json && r.json.code === 'NO_HEALTH_WINDOW', r.json);
    r = await ack(tokB, 'a4-s1', 'qd_nope');
    t('u2:bob-ack-alice-session-forbidden', r.json && r.json.ok === false && r.json.code === 'FORBIDDEN', r.json);

    r = await idr(tokA, 'a4-s1', 'node//' + ALICE_DEV, 1, 'join');
    t('u3:alice-idr-own-agent-forward', r.json && r.json.decision === 'forward', r.json);
    r = await idr(tokB, 'a4-s1', BOB_DEV, 1, 'join');
    t('u3:bob-idr-alice-session-not-bound', r.json && r.json.decision === 'rejected' && r.json.code === 'NOT_BOUND', r.json);
    r = await idr(tokA, 'a4-s9', BOB_DEV, 1, 'join');
    t('u3:alice-idr-forged-agent-refused', r.json && r.json.ok === false && r.json.code === 'AGENT_NOT_BOUND', r.json);
    r = await idr(tokA, 'a4-s9', 'ghost-dev-999', 1, 'join');
    t('u3:alice-idr-ghost-agent-refused', r.json && r.json.ok === false && r.json.code === 'AGENT_NOT_BOUND', r.json);
    r = await idr(tokA, 'a4-s9', ALICE_DEV, 1, 'join');
    t('u3:refused-bind-does-not-poison-session', r.json && r.json.decision === 'forward', r.json);
    r = await idr(tokB, 'a4-s2', BOB_DEV, 1, 'join');
    t('u3:bob-idr-own-agent-forward', r.json && r.json.decision === 'forward', r.json);

    // 撤权：alice-dev-001 换绑给 bob → alice 的 IDR 立即被拒；bob 也拿不走 alice 的会话。
    fs.writeFileSync(path.join(leaDir, 'bindings.json'), JSON.stringify(bindingsDoc(BOB, BOB)), { mode: 0o600 });
    r = await idr(tokA, 'a4-s1', ALICE_DEV, 4, 'loss');
    t('u3:alice-idr-after-rebind-refused', r.json && r.json.decision === 'rejected' && r.json.code === 'AGENT_NOT_BOUND', r.json);
    r = await idr(tokB, 'a4-s1', ALICE_DEV, 1, 'join');
    t('u3:bob-cannot-take-over-alice-session-after-rebind', r.json && r.json.decision === 'rejected', r.json);
    fs.writeFileSync(path.join(leaDir, 'bindings.json'), JSON.stringify(bindingsDoc(ALICE, BOB)), { mode: 0o600 });
    await sleep(1200); // 让 1/s 硬上限窗口滑过：恢复断言只验归属，不验限流。
    r = await idr(tokA, 'a4-s1', ALICE_DEV, 5, 'loss');
    t('u3:alice-idr-works-again-after-ledger-restored', r.json && (r.json.decision === 'forward' || r.json.decision === 'coalesced'), r.json);

    // 过期（quality）：连续严重探针降档到 smooth；闲置 5 秒后过期重建回 balanced。
    r = await probe(tokA, 'a4-s3', { rttMs: 900, lossPct: 1, jitterMs: 10, lossSamples: 100 });
    r = await probe(tokA, 'a4-s3', { rttMs: 950, lossPct: 1, jitterMs: 10, lossSamples: 100 });
    t('u2:severe-probes-downgrade-to-smooth', r.json && r.json.ok === true && r.json.tier === 'smooth', r.json);
    await sleep(5000);
    r = await probe(tokA, 'a4-s3');
    t('u2:expired-quality-session-rebuilt-fresh', r.json && r.json.ok === true && r.json.tier === 'balanced', r.json);
    // 过期（IDR）：重建后旧 seq 可再用（新绑定 maxSeq 归零）；未过期时旧 seq 应为 REPLAY。
    r = await idr(tokA, 'a4-s4', ALICE_DEV, 1, 'join');
    t('u3:idr-first-join-forward', r.json && r.json.decision === 'forward', r.json);
    await sleep(5000);
    r = await idr(tokA, 'a4-s4', ALICE_DEV, 1, 'join');
    t('u3:expired-idr-binding-rebuilt-fresh-seq', r.json && r.json.decision === 'forward', r.json);

    // ===== Phase 2：封禁（重启服务端，lic state.json 预置 bob 封禁） =====
    stopServer();
    await sleep(1000);
    fs.writeFileSync(path.join(licDir, 'state.json'), JSON.stringify({
      version: 1,
      bans: [{ id: 'ban-a4-01', status: 'active', targetType: 'account', target: BOB, code: 'B6', permanent: true, createdAt: Date.now() }],
    }), { mode: 0o600 });
    if (!await startServer()) { showServerLogTail(); throw new Error('server did not come up (phase 2)'); }
    r = await probe(tokB, 'a4-s5');
    t('u2:bob-banned-probe-403', r.status === 403 && r.json && r.json.code === 'ACCOUNT_BANNED', { status: r.status, json: r.json });
    r = await probe(tokA, 'a4-s5');
    t('u2:alice-probe-unaffected-by-bob-ban', r.status === 200 && r.json && r.json.ok === true, r.json);
    r = await idr(tokB, 'a4-s5', BOB_DEV, 1, 'join');
    t('u3:bob-banned-idr-403', r.status === 403 && r.json && r.json.code === 'ACCOUNT_BANNED', { status: r.status, json: r.json });
  } catch (e) {
    fail++;
    console.log('FAIL- http:harness-error', String(e && e.stack || e));
    showServerLogTail();
  } finally {
    stopServer();
    try { fs.closeSync(logFd); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('TOTAL pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
}

main();
