'use strict';
/*
 * LEA 下发真客户端单测（S3 回归）· Node 无依赖 + mingw + wine64
 * 运行：node test/test-lea-realclient.js
 *   （在 server/ext/lea/ 目录下，或任意目录）
 *
 * 做法：从源码现编真 qf-lea-client.exe（mingw 交叉编译）与管道替身
 * pipe_server.exe（windows/lea/test/pipe_server.c，只接一个连接），
 * 在 wine64 下跑起来；服务端 dispatchEnvelope 的 mock 通道把服务端
 * 生成的命令串真的交给客户端执行（powershell 写 inbox 步按字节等价
 * 执行），管道替身把收到的原文落盘；断言落盘内容 == buildEnvelope
 * 的原信封 JSON，且客户端 stdout == 管道响应、dispatchEnvelope ok。
 * 覆盖：dispatch 小信封、apply 大信封、dispatch 坏 base64／缺参／
 * apply 缺文件时客户端 exit 2 且管道收不到任何东西（fail-closed）。
 *
 * 环境：需 x86_64-w64-mingw32-gcc 与 wine64（PATH 中的 wine64 或
 * /usr/lib/wine/wine64，即只有 wine64 的 64 位沙箱）。缺任一时 SKIP
 * 退出 0（不谎称通过、不谎称失败）。wine 前缀默认复用
 * ~/.cache/qfr-lea-test/wineprefix（首次创建约 700MB、约 10~20s，
 * /tmp 在本沙箱只有 512MB 故不用 tmpdir）；可用环境变量
 * LEA_TEST_WINEPREFIX / LEA_TEST_WINE64 覆盖。
 * 单次运行约 1~3 分钟（wine 启动开销），不并入 test-lea.js 的快测。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { createLeaCore } = require('../lea-core');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('ok  -', name); }
  else { fail++; failures.push(name); console.log('FAIL-', name, extra ? String(extra).slice(0, 500) : ''); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const ROOT = path.resolve(__dirname, '..', '..', '..', '..'); // work-recovery241
const CLIENT_SRC = path.join(ROOT, 'windows', 'lea', 'qf-lea-client.c');
const CRYPTO_SRC = path.join(ROOT, 'windows', 'lea', 'lea_crypto.c');
const SERVER_SRC = path.join(ROOT, 'windows', 'lea', 'test', 'pipe_server.c');

function findWine() {
  if (process.env.LEA_TEST_WINE64 && fs.existsSync(process.env.LEA_TEST_WINE64)) return process.env.LEA_TEST_WINE64;
  for (const p of ['/usr/lib/wine/wine64', '/usr/bin/wine64']) if (fs.existsSync(p)) return p;
  const r = spawnSync('which', ['wine64'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}
function haveMingw() {
  return spawnSync('which', ['x86_64-w64-mingw32-gcc'], { encoding: 'utf8' }).status === 0;
}

async function main() {
  const wine = findWine();
  if (!wine || !haveMingw()) {
    console.log('SKIP: 真客户端单测需 x86_64-w64-mingw32-gcc + wine64（本机缺 '
      + (!haveMingw() ? 'mingw ' : '') + (!wine ? 'wine64' : '') + '），未跑，不计通过。');
    return;
  }
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-realclient-'));
  const prefix = process.env.LEA_TEST_WINEPREFIX
    || path.join(os.homedir(), '.cache', 'qfr-lea-test', 'wineprefix');
  const wineEnv = Object.assign({}, process.env, {
    WINEPREFIX: prefix, WINEDEBUG: '-all', WINEARCH: 'win64',
  });
  const driveC = path.join(prefix, 'drive_c');
  const clientWinDir = path.join(driveC, 'Program Files', 'QFR', 'LEA');
  const inboxWinDir = path.join(driveC, 'ProgramData', 'QFR', 'LEA', 'inbox');
  const captureWinDir = path.join(driveC, 'lea-capture');
  for (const d of [clientWinDir, inboxWinDir, captureWinDir]) fs.mkdirSync(d, { recursive: true });

  function runWine(args, timeoutMs) {
    return spawnSync(wine, args, { encoding: 'utf8', timeout: timeoutMs || 120000, env: wineEnv });
  }
  function wineKillAll() {
    try { spawnSync(wine, ['wineserver', '-k'], { env: wineEnv, timeout: 15000 }); } catch (e) {}
  }

  // ---------- 现编真客户端 + 管道替身 ----------
  const clientExe = path.join(buildDir, 'qf-lea-client.exe');
  const serverExe = path.join(buildDir, 'pipe_server.exe');
  let r = spawnSync('x86_64-w64-mingw32-gcc', ['-O2', '-Wall', '-Wextra', '-o', clientExe, CLIENT_SRC, CRYPTO_SRC],
    { encoding: 'utf8', timeout: 120000 });
  t('现编真客户端 qf-lea-client.exe（mingw 零警告）', r.status === 0, r.stderr);
  r = spawnSync('x86_64-w64-mingw32-gcc', ['-O2', '-Wall', '-Wextra', '-o', serverExe, SERVER_SRC],
    { encoding: 'utf8', timeout: 120000 });
  t('现编管道替身 pipe_server.exe（mingw 零警告）', r.status === 0, r.stderr);
  if (fail) { finish(); return; }
  fs.copyFileSync(clientExe, path.join(clientWinDir, 'qf-lea-client.exe'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lea-test-'));
  const core = createLeaCore({ dir: tmpDir, enableSweeps: false });
  const DEV = 'node//test-device-1';
  const USER = 'alice';
  core.grantMuse(USER, 'owner'); // H06：建 Key 须先有授权
  const gen = core.generateKey(USER, { device_scope: DEV });
  let seq = 0;

  function splitCmd(cmd) {
    const out = [];
    let cur = '', q = false;
    for (const ch of cmd) {
      if (ch === '"') { q = !q; continue; }
      if (!q && /\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  // mock 通道：powershell 写 inbox 按字节等价执行；其余命令真的跑客户端。
  let serverProc = null;
  let captureLinux = null;
  async function startPipeServer(captureName, responseJson, chunkBytes) {
    const captureWin = 'C:\\lea-capture\\' + captureName;
    const readyWin = 'C:\\lea-capture\\' + captureName + '.ready';
    captureLinux = path.join(captureWinDir, captureName);
    const readyLinux = path.join(captureWinDir, captureName + '.ready');
    for (const f of [captureLinux, readyLinux]) try { fs.unlinkSync(f); } catch (e) {}
    const args = [serverExe, captureWin, responseJson, readyWin];
    if (chunkBytes) args.push(String(chunkBytes)); // T24：分 chunk 写响应，逼出短读
    serverProc = spawn(wine, args, { env: wineEnv, stdio: 'ignore' });
    const t0 = Date.now();
    while (!fs.existsSync(readyLinux)) {
      if (Date.now() - t0 > 90000) throw new Error('pipe server 未就绪（90s）');
      if (serverProc.exitCode !== null) throw new Error('pipe server 异常退出 code=' + serverProc.exitCode);
      await sleep(500);
    }
    return captureLinux;
  }
  function stopPipeServer() {
    try { if (serverProc && serverProc.exitCode === null) serverProc.kill('SIGKILL'); } catch (e) {}
    serverProc = null;
    wineKillAll();
  }

  const calls = [];
  const mockChannel = {
    async runCommand(nodeId, cmd, timeoutMs) {
      calls.push({ nodeId, cmd, timeoutMs });
      if (cmd.includes('WriteAllBytes')) {
        const fm = cmd.match(/inbox\\([^'\\]+\.json)/);
        const bm = cmd.match(/FromBase64String\('([^']+)'\)/);
        if (!fm || !bm) throw new Error('写 inbox 命令解析失败: ' + cmd.slice(0, 200));
        fs.writeFileSync(path.join(inboxWinDir, fm[1]), Buffer.from(bm[1], 'base64'));
        return '';
      }
      const argv = splitCmd(cmd);
      argv[0] = clientExe; // 服务端命令串里的 exe 路径映射为现编的真客户端
      const res = runWine(argv, 120000);
      if (res.error) throw res.error;
      return res.stdout || '';
    },
    async nodeOnline() { return true; },
    async listNodes() { return [{ _id: DEV, conn: 1 }]; },
  };

  function mkEnv(requestId, command, params) {
    return core.buildEnvelope({
      requestId, batchId: null, seq: ++seq, deviceId: DEV, accountId: USER,
      keyId: gen.record.key_id, bindingEpoch: 1, grantEpoch: 1, idempotencyKey: 'idem-' + requestId,
      command, params: params || {}, timeoutMs: 5000,
    });
  }

  try {
    // ---------- 1) dispatch 小信封：真客户端 → 管道原文 == 原信封 ----------
    calls.length = 0;
    const env = mkEnv('req-real-1', 'sys.info', {});
    const resp1 = JSON.stringify({ ok: true, code: 'done', request_id: 'req-real-1' });
    const cap1 = await startPipeServer('recv-1.txt', resp1);
    const d1 = await core.dispatchEnvelope(mockChannel, env, { timeoutMs: 5000 });
    stopPipeServer();
    await sleep(500);
    const got1 = fs.existsSync(cap1) ? fs.readFileSync(cap1, 'utf8') : null;
    t('dispatch：服务端只发 1 条命令', calls.length === 1);
    t('dispatch：命令是 dispatch <base64>', calls[0].cmd.includes(' dispatch '));
    t('dispatch：真客户端经管道发出的原文 == 原信封 JSON', got1 === JSON.stringify(env), got1);
    t('dispatch：客户端 stdout 回传管道响应', d1.ok === true && d1.result.code === 'done' && d1.result.request_id === 'req-real-1');

    // ---------- 2) apply 大信封：写 inbox + 真客户端读文件 → 管道原文 == 原信封 ----------
    calls.length = 0;
    const bigEnv = mkEnv('req-real-2', 'ui.input', { text: 'x'.repeat(9000) });
    const resp2 = JSON.stringify({ ok: true, code: 'done', request_id: 'req-real-2' });
    const cap2 = await startPipeServer('recv-2.txt', resp2);
    const d2 = await core.dispatchEnvelope(mockChannel, bigEnv, { timeoutMs: 5000 });
    stopPipeServer();
    await sleep(500);
    const got2 = fs.existsSync(cap2) ? fs.readFileSync(cap2, 'utf8') : null;
    t('apply：服务端发 2 条命令（写 inbox + apply）', calls.length === 2);
    t('apply：第二条是 apply + inbox 全路径', calls[1].cmd.includes(' apply "C:\\ProgramData\\QFR\\LEA\\inbox\\req-real-2.json"'));
    t('apply：真客户端经管道发出的原文 == 原信封 JSON', got2 === JSON.stringify(bigEnv), got2 ? got2.slice(0, 120) : got2);
    t('apply：客户端 stdout 回传管道响应', d2.ok === true && d2.result.code === 'done');

    // ---------- 3) T24：响应分多 chunk 到达（短读）仍须读全 ----------
    // 旧客户端在首个短读（16 字节、无换行）后即判完成，只拿到截断 JSON，
    // dispatchEnvelope 解析失败；修后须读到换行才停，整行回传。
    calls.length = 0;
    const env5 = mkEnv('req-real-5', 'sys.info', {});
    const resp5 = JSON.stringify({ ok: true, code: 'done', request_id: 'req-real-5', pad: 'x'.repeat(60) });
    const cap5 = await startPipeServer('recv-5.txt', resp5, 16);
    const d5 = await core.dispatchEnvelope(mockChannel, env5, { timeoutMs: 5000 });
    stopPipeServer();
    await sleep(500);
    t('T24 分 chunk 响应仍读全（request_id 对上）', d5.ok === true && d5.result.request_id === 'req-real-5' && d5.result.code === 'done', JSON.stringify(d5).slice(0, 300));

    // ---------- 4) 负例：dispatch 坏 base64 → exit 2，管道收不到任何东西 ----------
    const cap3 = await startPipeServer('recv-3.txt', JSON.stringify({ ok: true }));
    const bad = runWine([clientExe, 'dispatch', '!!!not-b64!!!'], 120000);
    const cap3Exists = fs.existsSync(cap3);
    stopPipeServer();
    await sleep(500);
    t('负例 dispatch 坏 base64：exit 2', bad.status === 2, 'status=' + bad.status);
    t('负例 dispatch 坏 base64：stdout 报 QFR_LEA_CLIENT_BAD_DISPATCH', bad.stdout.includes('QFR_LEA_CLIENT_BAD_DISPATCH'), bad.stdout);
    t('负例 dispatch 坏 base64：管道未收到任何东西', !cap3Exists);

    // ---------- 5) 负例：dispatch 缺参／apply 缺文件 → exit 2（不连管道） ----------
    const noArg = runWine([clientExe, 'dispatch'], 120000);
    t('负例 dispatch 缺参：exit 2 且不把动词当信封', noArg.status === 2 && noArg.stdout.includes('QFR_LEA_CLIENT_NO_INPUT'), noArg.stdout);
    const noFile = runWine([clientExe, 'apply', 'C:\\ProgramData\\QFR\\LEA\\inbox\\no-such.json'], 120000);
    t('负例 apply 缺文件：exit 2 报 FILE_READ_FAILED', noFile.status === 2 && noFile.stdout.includes('QFR_LEA_CLIENT_FILE_READ_FAILED'), noFile.stdout);
    // 旧形态对照：裸文件名 apply 应解析到 inbox（写一个文件再读）。
    fs.writeFileSync(path.join(inboxWinDir, 'bare-1.json'), JSON.stringify({ version: 1, request_id: 'bare-1', command: 'sys.info' }));
    const cap4 = await startPipeServer('recv-4.txt', JSON.stringify({ ok: true, code: 'done', request_id: 'bare-1' }));
    const bare = runWine([clientExe, 'apply', 'bare-1.json'], 120000);
    stopPipeServer();
    await sleep(500);
    const got4 = fs.existsSync(cap4) ? fs.readFileSync(cap4, 'utf8') : null;
    t('兼容 apply 裸文件名：解析到 inbox 并发出原文', bare.status === 0 && got4 === JSON.stringify({ version: 1, request_id: 'bare-1', command: 'sys.info' }), got4);
  } catch (e) {
    t('真客户端流程无异常', false, e && e.stack || String(e));
    stopPipeServer();
  } finally {
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    wineKillAll();
  }
  finish();
  function finish() {
    console.log(fail === 0 ? `\n通过 ${pass} / ${pass}；失败 0` : `\n通过 ${pass}；失败 ${fail}：${failures.join('；')}`);
    if (fail) process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
