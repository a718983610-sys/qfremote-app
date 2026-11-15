'use strict';
/*
 * RC-06 发版门回归自检（3.0.0，全进 3.0）：
 *   正向：v4 真实产物（外层／内层 exe、app.7z、payload、nsis7z.dll
 *   源文件）走 gate 全绿；另一次全量跑 release.json 签名＋key_id 一致。
 *   反向：故意改错任一项画像（nsis7z 大小／哈希、app.7z 固实、
 *   版本号、安装器目标 x86、makensis 日志无 amd64 行、签名 key_id
 *   不符），gate 必须非零退出并点名该项。反向用小夹具跑（快）；
 *   小夹具的探针 exe 无版本资源，PE FileVersion 项会附带失败——
 *   断言只认目标项关键字，不认“仅该项失败”，故不影响判定。
 * 运行：node windows/test/release-gate-test.js（退出码 0=通过）。
 * 注意：正向用例读 v4 真实产物（只读不写）；反向用例只改临时副本。
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TREE = path.resolve(__dirname, '..', '..');
const GATE = path.join(TREE, 'windows', 'tools', 'release-gate.js');
const MRJ = path.join(TREE, 'server', 'ext', 'make-release-json.js');
const GEN = path.join(TREE, 'windows', 'tools', 'gen_file_manifest.py');
const V4 = path.join(os.homedir(), 'workspace', 'qfremote', 'local-agent', 'testpkg-3.0.0-r15-rework-v4');
const DLL_SRC = path.join(os.homedir(), 'workspace', 'qfremote', 'auto-maintain', '20261107-hotfix-242', 'winbuild', 'extract241', 'nsis7z.dll');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-gate-'));
let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, extra || ''); }
}
function run(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
}
function runGate(args) {
  return run(process.execPath, [GATE].concat(args));
}
function pluginsDirWith(dllPath) {
  const p = fs.mkdtempSync(path.join(dir, 'plugins-'));
  fs.copyFileSync(dllPath, path.join(p, 'nsis7z.dll'));
  return p;
}
// 小夹具：探针 exe（amd64-unicode 目标编译）＋小 payload（含清单）＋
// 正确参数打的小 7z。pefile 在探针 exe 上读不到版本资源（NOVERSION，
// 附带失败），断言只认目标项关键字。
function smallFixtures() {
  const fx = fs.mkdtempSync(path.join(dir, 'fx-'));
  const nsi = path.join(fx, 'probe.nsi');
  const exe = path.join(fx, 'probe.exe');
  fs.writeFileSync(nsi, 'Unicode true\nName "probe"\nOutFile "' + exe.replace(/\\/g, '/') + '"\nSection\nSectionEnd\n');
  const mk = run('makensis', ['-XTarget amd64-unicode', nsi]);
  if (mk.status !== 0) throw new Error('探针编译失败：' + mk.stderr);
  const payload = path.join(fx, 'payload');
  fs.mkdirSync(path.join(payload, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'QFRemote.exe'), Buffer.from('MZ-fake-pe-placeholder'));
  fs.writeFileSync(path.join(payload, 'sub', 'a.txt'), 'hello\n'.repeat(50));
  const gen = run('python3', [GEN, '--payload', payload]);
  if (gen.status !== 0) throw new Error('夹具清单生成失败：' + gen.stderr);
  const app7z = path.join(fx, 'app.7z');
  const pack = run('7z', ['a', '-t7z', '-m0=BCJ', '-m1=LZMA2:d=20', '-ms=off', app7z, '*'], { cwd: payload });
  if (pack.status !== 0) throw new Error('夹具 7z 打包失败：' + pack.stderr);
  return { exe, inner: exe, pluginsDir: pluginsDirWith(DLL_SRC), app7z, payloadDir: payload };
}
function gateArgs(fx, overrides) {
  const a = {
    '--version': '3.0.0',
    '--exe': fx.exe,
    '--inner': fx.inner,
    '--plugins-dir': fx.pluginsDir,
    '--app-7z': fx.app7z,
    '--payload-dir': fx.payloadDir
  };
  Object.assign(a, overrides || {});
  const flat = [];
  Object.keys(a).forEach((k) => { flat.push(k, a[k]); });
  return flat;
}

try {
  // 0. 前置：v4 真实产物与 nsis7z 源文件在位（缺失即环境问题，如实报）。
  const pre = ['QFRemote-Setup-v3.0.0-r15-rework-v4.exe', 'QFRSetupAdmin-v4.exe', 'app300r15-rework-v4.7z'].every((f) => fs.existsSync(path.join(V4, f)))
    && fs.existsSync(path.join(V4, 'payload300r15-rework-v4', 'file-manifest.txt'))
    && fs.existsSync(DLL_SRC);
  t('前置：v4 真实产物与 nsis7z 源文件在位', pre);
  if (!pre) throw new Error('v4 产物缺失，无法跑门测试');

  // 1. 正向：v4 真实产物全绿（全量，约 2 分钟）。
  const v4fx = {
    exe: path.join(V4, 'QFRemote-Setup-v3.0.0-r15-rework-v4.exe'),
    inner: path.join(V4, 'QFRSetupAdmin-v4.exe'),
    pluginsDir: pluginsDirWith(DLL_SRC),
    app7z: path.join(V4, 'app300r15-rework-v4.7z'),
    payloadDir: path.join(V4, 'payload300r15-rework-v4')
  };
  const r1 = runGate(gateArgs(v4fx));
  t('正向：v4 真实产物走 gate 全绿', r1.status === 0, r1.stdout + r1.stderr);

  const fx = smallFixtures();

  // 2. 反向：nsis7z.dll 改一个字节（大小不变、哈希变）-> 失败并点名。
  const dllBad = Buffer.from(fs.readFileSync(DLL_SRC));
  dllBad[100] ^= 0xff;
  const badShaDll = path.join(dir, 'badsha.dll');
  fs.writeFileSync(badShaDll, dllBad);
  const r2 = runGate(gateArgs(fx, { '--plugins-dir': pluginsDirWith(badShaDll) }));
  t('反向：nsis7z.dll 哈希被改即失败', r2.status === 1 && (r2.stdout + r2.stderr).includes('nsis7z'), r2.stdout + r2.stderr);

  // 3. 反向：nsis7z.dll 截短（大小变）-> 失败并点名。
  const badSizeDll = path.join(dir, 'badsize.dll');
  fs.writeFileSync(badSizeDll, fs.readFileSync(DLL_SRC).subarray(0, 1000));
  const r3 = runGate(gateArgs(fx, { '--plugins-dir': pluginsDirWith(badSizeDll) }));
  t('反向：nsis7z.dll 大小被改即失败', r3.status === 1 && (r3.stdout + r3.stderr).includes('nsis7z'), r3.stdout + r3.stderr);

  // 4. 反向：app.7z 打成固实（-ms=on）-> 失败并点名。
  const solid7z = path.join(dir, 'solid.7z');
  const packSolid = run('7z', ['a', '-t7z', '-m0=BCJ', '-m1=LZMA2:d=20', '-ms=on', solid7z, '*'], { cwd: fx.payloadDir });
  if (packSolid.status !== 0) throw new Error('固实 7z 打包失败：' + packSolid.stderr);
  const r4 = runGate(gateArgs(fx, { '--app-7z': solid7z }));
  t('反向：app.7z 固实即失败', r4.status === 1 && (r4.stdout + r4.stderr).includes('app.7z'), r4.stdout + r4.stderr);

  // 5. 反向：--version 与树内版本不一致 -> 失败并点名版本。
  const r5 = runGate(gateArgs(fx, { '--version': '9.9.9' }));
  t('反向：版本号不符即失败', r5.status === 1 && (r5.stdout + r5.stderr).includes('版本'), r5.stdout + r5.stderr);

  // 6. 反向：x86-unicode 目标编出的安装器（无 -X Target）-> 失败并点名 amd64。
  const nsi86 = path.join(dir, 'probe-x86.nsi');
  const exe86 = path.join(dir, 'probe-x86.exe');
  fs.writeFileSync(nsi86, 'Unicode true\nName "probe"\nOutFile "' + exe86.replace(/\\/g, '/') + '"\nSection\nSectionEnd\n');
  const mk86 = run('makensis', [nsi86]);
  if (mk86.status !== 0) throw new Error('x86 探针编译失败：' + mk86.stderr);
  const r6 = runGate(gateArgs(fx, { '--exe': exe86 }));
  t('反向：x86-unicode 安装器即失败', r6.status === 1 && (r6.stdout + r6.stderr).includes('amd64-unicode'), r6.stdout + r6.stderr);

  // 7. 反向：makensis 日志无 amd64 行 -> 失败。
  const badLog = path.join(dir, 'bad-makensis.log');
  fs.writeFileSync(badLog, 'Processed 1 file, writing output (x86-unicode):\n');
  const r7 = runGate(gateArgs(fx, { '--makensis-log-inner': badLog }));
  t('反向：makensis 日志无 amd64 行即失败', r7.status === 1 && (r7.stdout + r7.stderr).includes('makensis'), r7.stdout + r7.stderr);

  // 8. release.json：临时密钥现签，key_id 一致通过（全量 v4 跑一次）。
  const kp = crypto.generateKeyPairSync('ed25519');
  const privPem = path.join(dir, 'test-sign.pem');
  fs.writeFileSync(privPem, kp.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const pubB64 = kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const apk = path.join(dir, 'QFRemote-v3.0.0.apk');
  fs.writeFileSync(apk, crypto.randomBytes(1024 * 1024 + 45));
  const docPath = path.join(dir, 'release.json');
  const gen = run(process.execPath, [MRJ, '--exe', v4fx.exe, '--apk', apk, '--version', '3.0.0', '--min-usable', '3.0.0', '--sign-key', privPem, '--out', docPath]);
  if (gen.status !== 0) throw new Error('release.json 生成失败：' + gen.stderr);
  const r8 = runGate(gateArgs(v4fx, { '--release-json': docPath, '--apk': apk, '--verify-key': pubB64 }));
  t('release.json：签名＋key_id 一致时 gate 通过', r8.status === 0, r8.stdout + r8.stderr);

  // 9. release.json：key_id 不符即失败（小夹具跑，快）。
  const docPath2 = path.join(dir, 'release2.json');
  const gen2 = run(process.execPath, [MRJ, '--exe', fx.exe, '--apk', apk, '--version', '3.0.0', '--min-usable', '3.0.0', '--sign-key', privPem, '--out', docPath2]);
  if (gen2.status !== 0) throw new Error('release.json 生成失败：' + gen2.stderr);
  const r9 = runGate(gateArgs(fx, { '--release-json': docPath2, '--apk': apk, '--verify-key': pubB64, '--expect-key-id': 'release-2' }));
  t('release.json：签名 key_id 不符时 gate 失败', r9.status === 1 && (r9.stdout + r9.stderr).includes('key_id'), r9.stdout + r9.stderr);
} catch (e) {
  failed++;
  console.log('FAIL- 异常：' + e.message);
} finally {
  console.log(JSON.stringify({ pass: failed === 0, passed, failed }));
  process.exit(failed === 0 ? 0 : 1);
}
