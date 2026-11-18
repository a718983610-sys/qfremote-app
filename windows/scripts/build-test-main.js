'use strict';
/*
 * TEST 主程序 asar 构建（A16-S2 TEST 隔离，GPT 2026-11-18 定夺 §1）。
 * ================================================================
 * 用法（在沙箱跑，不上腾讯机）：
 *   node windows/scripts/build-test-main.js [--windows-dir <dir>]
 *       [--out-dir <dir>] [--lea-client <path>]
 * 缺省：
 *   windows-dir = 本文件上一级的 windows/（即本 worktree 的 windows/）
 *   out-dir     = ~/workspace/qfremote/a16-s2-20261118/phase-2-closeout/testmain-isolation/staging
 *   lea-client  = windows/lea/out-test/qf-lea-client.exe（在位时优先），
 *                 否则 A+ 证据目录的 qf-lea-client-a16s2-A+-merge-TEST.exe
 *                 （SHA 5d9246fc…，与腾讯机已部署 TEST 客户端一致）。
 * 步骤：
 *   1. 按 package.json build.files 把 windows/ 拷进 staging/asar-src
 *      （缺文件即失败，不静默跳过）。
 *   2. 在 staging 副本里改写 build-flavor.js 为 TEST（BUILD_FLAVOR='test'，
 *      TEST_CLIENT_SHA256=实测 --lea-client SHA）；仓内本文件绝不动。
 *   3. 跑 tools/check-build-flavor.js --flavor test（对 staging 副本）。
 *   4. 用 @electron/asar CLI（test-main/build-tools 装的 4.3.2）pack。
 *   5. 验证：asar 内文件清单与 staging 一致；main.js／test-policy.js／
 *      build-flavor.js asar 内外 SHA 一致；node --check 三文件通过。
 *   6. 写 MANIFEST-test-isolation.txt（各产物 SHA）。
 * 产物：staging/app.asar（TEST 版）。便携组装（Electron 二进制＋unpacked
 * 三件＋LEA 三件）按 test-main/REPORT.md §4.2 配方另行组装，不在本脚本做。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function die(msg) { console.error('build-test-main: FAIL ' + msg); process.exit(1); }
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--windows-dir') o.windowsDir = argv[++i];
    else if (argv[i] === '--out-dir') o.outDir = argv[++i];
    else if (argv[i] === '--lea-client') o.leaClient = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const windowsDir = args.windowsDir || path.join(__dirname, '..');
const outDir = args.outDir || '/home/hatch/workspace/qfremote/a16-s2-20261118/phase-2-closeout/testmain-isolation/staging';
const aplusClient = '/home/hatch/workspace/qfremote/a16-s2-20261118/phase-2-closeout/aplus/qf-lea-client-a16s2-A+-merge-TEST.exe';
let leaClient = args.leaClient || '';
if (!leaClient) {
  const outTest = path.join(windowsDir, 'lea', 'out-test', 'qf-lea-client.exe');
  leaClient = fs.existsSync(outTest) ? outTest : aplusClient;
}
if (!fs.existsSync(leaClient)) die('--lea-client 不存在：' + leaClient);
const clientSha = sha256File(leaClient);
console.log('build-test-main: lea-client=' + leaClient);
console.log('build-test-main: client-sha256=' + clientSha);

const pkg = JSON.parse(fs.readFileSync(path.join(windowsDir, 'package.json'), 'utf8'));
const files = pkg.build.files || [];
const srcDir = path.join(outDir, 'asar-src');
fs.rmSync(srcDir, { recursive: true, force: true });
const missing = [];
for (const f of files) {
  const s = path.join(windowsDir, f);
  if (!fs.existsSync(s)) { missing.push(f); continue; }
  const d = path.join(srcDir, f);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  fs.chmodSync(d, fs.statSync(s).mode);
}
if (missing.length) die('staging 缺文件：' + JSON.stringify(missing));
console.log('build-test-main: staged files=' + files.length);

// TEST 风味只写 staging 副本，仓内 build-flavor.js 保持 production。
const flavorText = `'use strict';
// TEST 构建期风味（由 scripts/build-test-main.js 在 staging 时生成）。
// 正式构建固定为 'production'；本文件只在 TEST asar 里为 'test'。
module.exports = {
  BUILD_FLAVOR: 'test',
  TEST_CLIENT_SHA256: '${clientSha}'
};
`;
fs.writeFileSync(path.join(srcDir, 'build-flavor.js'), flavorText);
console.log('build-test-main: build-flavor.js 已写为 test（仅 staging 副本）');

// 打包前检查（对 staging 副本）。
const check = spawnSync(process.execPath,
  [path.join(windowsDir, 'tools', 'check-build-flavor.js'), '--flavor', 'test',
   '--windows-dir', srcDir, '--lea-client', leaClient],
  { encoding: 'utf8' });
process.stdout.write(check.stdout || '');
process.stderr.write(check.stderr || '');
if (check.status !== 0) die('check-build-flavor --flavor test 未通过');

// asar pack（@electron/asar 4.3.2，test-main 线装的同一份；ESM，用 CLI）。
const asarCli = '/home/hatch/workspace/qfremote/a16-s2-20261118/phase-2-closeout/test-main/build-tools/node_modules/@electron/asar/bin/asar.mjs';
if (!fs.existsSync(asarCli)) die('asar CLI 不存在：' + asarCli);
const asarOut = path.join(outDir, 'app.asar');
fs.mkdirSync(outDir, { recursive: true });
const pack = spawnSync(process.execPath, [asarCli, 'pack', srcDir, asarOut], { encoding: 'utf8' });
process.stdout.write(pack.stdout || '');
process.stderr.write(pack.stderr || '');
if (pack.status !== 0) die('asar pack 失败 exit=' + pack.status);
if (!fs.existsSync(asarOut)) die('asar pack 未产出 ' + asarOut);

// 验证：清单一致＋关键文件 asar 内外 SHA 一致＋node --check。
const list = spawnSync(process.execPath, [asarCli, 'list', asarOut], { encoding: 'utf8' });
if (list.status !== 0) die('asar list 失败 exit=' + list.status);
const listed = list.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  .map((s) => s.replace(/^\//, ''));
const listedSet = new Set(listed);
const missingInAsar = files.filter((f) => !listedSet.has(f));
if (missingInAsar.length) die('asar 内缺文件：' + JSON.stringify(missingInAsar));
console.log('build-test-main: asar files=' + listed.length + '（staging ' + files.length + '，缺 0）');

const extractDir = path.join(outDir, 'asar-verify');
fs.rmSync(extractDir, { recursive: true, force: true });
const extract = spawnSync(process.execPath, [asarCli, 'extract', asarOut, extractDir], { encoding: 'utf8' });
if (extract.status !== 0) die('asar extract 失败 exit=' + extract.status);
for (const f of ['main.js', 'test-policy.js', 'build-flavor.js', 'package.json']) {
  const a = sha256File(path.join(srcDir, f));
  const b = sha256File(path.join(extractDir, f));
  if (a !== b) die('asar 内外 SHA 不一致：' + f);
  console.log('build-test-main: sha-ok ' + f + ' ' + a.slice(0, 12) + '…');
}
for (const f of ['main.js', 'test-policy.js', 'build-flavor.js']) {
  const c = spawnSync(process.execPath, ['--check', path.join(srcDir, f)], { encoding: 'utf8' });
  if (c.status !== 0) die('node --check 未通过：' + f + ' ' + (c.stderr || ''));
}
console.log('build-test-main: node --check main.js/test-policy.js/build-flavor.js 通过');

// 清单。
const asarSha = sha256File(asarOut);
const asarSize = fs.statSync(asarOut).size;
const manifest = [
  '# TEST 主程序 asar 清单（build-test-main.js 生成）',
  '# windows/ 基线：见 git log（本 worktree HEAD）',
  'app.asar ' + asarSha + ' ' + asarSize + ' B',
  'main.js ' + sha256File(path.join(srcDir, 'main.js')),
  'test-policy.js ' + sha256File(path.join(srcDir, 'test-policy.js')),
  'build-flavor.js ' + sha256File(path.join(srcDir, 'build-flavor.js')),
  'qf-lea-client.exe(TEST) ' + clientSha + ' (' + leaClient + ')',
  'asar-files ' + listed.length,
  ''
].join('\n');
fs.writeFileSync(path.join(outDir, 'MANIFEST-test-isolation.txt'), manifest);
console.log('build-test-main: DONE app.asar sha256=' + asarSha + ' size=' + asarSize);
console.log('build-test-main: manifest=' + path.join(outDir, 'MANIFEST-test-isolation.txt'));
