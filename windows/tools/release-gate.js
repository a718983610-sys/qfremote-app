#!/usr/bin/env node
/*
 * RC-06（3.0.0，全进 3.0）：发版门——“包内容校验”，打包画像验收脚本强制门。
 *
 * 来源：MeshCentral release.yml＋check-releases.js（版本号一动即先校验包
 * 内容）、RustDesk（元数据＋Ed25519 离线验签＋SHA-256 双重校验）、
 * scrcpy（客户端与服务端版本号严格一致）。此前画像验收是人工核对，
 * 现改为本脚本强制门：任一项不对即 exit 1、不许发版。
 *
 * 用法（在工作树根目录或任意目录运行）：
 *   node windows/tools/release-gate.js \
 *     --version 3.0.0 \
 *     --exe QFRemote-Setup-v3.0.0-r15-rework-v5.exe \
 *     --inner QFRSetupAdmin.exe \
 *     --plugins-dir windows/build/installer-work/plugins \
 *     --app-7z windows/build/installer-work/app.7z \
 *     --payload-dir <payload-dir> \
 *     [--release-json server/meshcentral/public/release.json --apk QFRemote-v3.0.0.apk] \
 *     [--makensis-log-inner <log> --makensis-log-outer <log>] \
 *     [--expect-key-id release-1] [--verify-key <base64 SPKI>] \
 *     [--tree <工作树根目录，默认本脚本所在树的根>]
 *
 * 核对项（打包画像定版，与真机装通的 2.3.0 一致）：
 *   1. makensis 3.09（`makensis -VERSION` → v3.09-4）；
 *   2. 内外层安装器均为 amd64-unicode 目标编译（`file` 须为 PE32+ x86-64；
 *      编译命令须带 -X"Target amd64-unicode"，日志有该行时另核）；
 *   3. nsis7z.dll 为 543,232 B 那版（大小＋SHA-256 双核）；
 *   4. app.7z 非固实＋BCJ＋LZMA2、字典 2^20（`7z l -slt` Method 含
 *      LZMA2:20 与 BCJ、Solid 为 -；`7z t` exit 0）；
 *   5. 版本严格一致：installer.nsi／installer-outer.nsi 的
 *      VIProductVersion、package.json version 均等于 --version
 *      （安装包自报版本必须等于发版版本，D-02）；
 *   6. file-manifest.txt 与 payload 逐件一致（gen_file_manifest.py --check）；
 *   7. stage-asar-unpacked.py 用 copy2（保留时间戳）；
 *   8. PE FileVersion（pefile 可用时）：内外层 exe 与 payload 内
 *      QFRemote.exe 均为 <version>.0；pefile 未装时跳过并警告（不记失败）；
 *   9. release.json（给了才核）：make-release-json.js --check
 *      --require-signature --expect-key-id 逐项比对＋验签（D-02，
 *      签名 key_id 须为当前轮换代次）。
 *
 * 本脚本只核对、不写文件、不改 release.json、不部署、不发版。
 * 故意改错任一项画像，脚本必须非零退出（见 windows/test/release-gate-test.js）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 打包画像定版（与真机装通的 2.3.0 一致）：
const EXPECTED_MAKENSIS = /^v3\.09/;
const EXPECTED_NSIS7Z_SIZE = 543232;
const EXPECTED_NSIS7Z_SHA256 = '3136e5bf77a6094c43639ad6667740bb35dbaffda88cb263ae982829713fa19c';

let failures = 0;
let warnings = 0;
function ok(label, detail) { console.log('ok  - ' + label + (detail ? '（' + detail + '）' : '')); }
function bad(label, detail) { failures++; console.log('FAIL- ' + label + (detail ? '（' + detail + '）' : '')); }
function warn(label, detail) { warnings++; console.log('WARN- ' + label + (detail ? '（' + detail + '）' : '')); }

function fail(msg) { console.error('release-gate: ' + msg); process.exit(1); }

function parseArgs(argv) {
  const a = { version: null, exe: null, inner: null, pluginsDir: null, app7z: null, payloadDir: null, releaseJson: null, apk: null, logInner: null, logOuter: null, expectKeyId: 'release-1', verifyKey: null, tree: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => { if (i + 1 >= argv.length) fail('参数 ' + t + ' 缺少值'); return argv[++i]; };
    if (t === '--version') a.version = next();
    else if (t === '--exe') a.exe = next();
    else if (t === '--inner') a.inner = next();
    else if (t === '--plugins-dir') a.pluginsDir = next();
    else if (t === '--app-7z') a.app7z = next();
    else if (t === '--payload-dir') a.payloadDir = next();
    else if (t === '--release-json') a.releaseJson = next();
    else if (t === '--apk') a.apk = next();
    else if (t === '--makensis-log-inner') a.logInner = next();
    else if (t === '--makensis-log-outer') a.logOuter = next();
    else if (t === '--expect-key-id') a.expectKeyId = next();
    else if (t === '--verify-key') a.verifyKey = next();
    else if (t === '--tree') a.tree = next();
    else if (t === '--help' || t === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 31).join('\n')); process.exit(0); }
    else if (t.startsWith('-')) fail('未知参数：' + t);
    else fail('未知位置参数：' + t);
  }
  return a;
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  if (r.error) return { status: -1, stdout: '', stderr: r.error.message };
  return r;
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    do { n = fs.readSync(fd, buf, 0, buf.length, null); if (n > 0) h.update(buf.subarray(0, n)); } while (n > 0);
    return h.digest('hex');
  } finally { fs.closeSync(fd); }
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }

function checkMakensisVersion() {
  const r = run('makensis', ['-VERSION']);
  const v = (r.stdout || '').trim();
  if (r.status !== 0) { bad('makensis 可执行', 'makensis -VERSION 失败：' + (r.stderr || '')); return; }
  if (EXPECTED_MAKENSIS.test(v)) ok('makensis 版本', v);
  else bad('makensis 版本', '实测 ' + v + '，期望 v3.09-4');
}

function checkInstallerTarget(label, exePath) {
  if (!fileExists(exePath)) { bad('安装器在位：' + label, exePath + ' 不存在'); return; }
  const r = run('file', [exePath]);
  const out = r.stdout || '';
  if (out.includes('PE32+') && out.includes('x86-64')) ok('安装器目标 amd64-unicode：' + label, path.basename(exePath) + ' 为 PE32+ x86-64');
  else bad('安装器目标 amd64-unicode：' + label, path.basename(exePath) + ' 实测：' + out.trim() + '（须用 -X"Target amd64-unicode" 编译）');
}

function checkNsis7z(pluginsDir) {
  const dll = path.join(pluginsDir, 'nsis7z.dll');
  if (!fileExists(dll)) { bad('nsis7z.dll 在位', dll + ' 不存在'); return; }
  const size = fs.statSync(dll).size;
  const sha = sha256File(dll);
  if (size === EXPECTED_NSIS7Z_SIZE && sha === EXPECTED_NSIS7Z_SHA256) ok('nsis7z.dll 画像', size + ' B，SHA-256 ' + sha.slice(0, 12) + '…');
  else bad('nsis7z.dll 画像', '实测 ' + size + ' B／SHA-256 ' + sha + '，期望 543232 B／' + EXPECTED_NSIS7Z_SHA256);
}

function checkApp7z(app7z) {
  if (!fileExists(app7z)) { bad('app.7z 在位', app7z + ' 不存在'); return; }
  const l = run('7z', ['l', '-slt', app7z]);
  // 注意：7z l -slt 先出档案头（Path/Type/Method/Solid/Blocks），再逐文件；
  // 档案级 Method/Solid 是全文首个匹配项——不按行数截断取（行数随版本变）。
  const method = /^Method\s*=\s*(.*)$/m.exec(l.stdout || '');
  const solid = /^Solid\s*=\s*(.*)$/m.exec(l.stdout || '');
  const methodOk = method && method[1].includes('LZMA2:20') && method[1].includes('BCJ');
  const solidOk = solid && solid[1].trim() === '-';
  if (methodOk && solidOk) ok('app.7z 画像', 'Method ' + method[1].trim() + '、Solid -（非固实＋BCJ＋LZMA2、字典 2^20）');
  else bad('app.7z 画像', '实测 Method=' + (method ? method[1].trim() : '?') + '、Solid=' + (solid ? solid[1].trim() : '?') + '，期望 Method 含 LZMA2:20 与 BCJ、Solid 为 -');
  const t = run('7z', ['t', app7z]);
  if (t.status === 0) ok('app.7z 完整性', '7z t exit 0');
  else bad('app.7z 完整性', '7z t exit ' + t.status);
}

function checkVersions(a, tree) {
  const want = a.version + '.0';
  const nsi = fs.readFileSync(path.join(tree, 'windows', 'installer.nsi'), 'utf8');
  const outer = fs.readFileSync(path.join(tree, 'windows', 'installer-outer.nsi'), 'utf8');
  const m1 = /VIProductVersion\s+"([^"]+)"/.exec(nsi);
  const m2 = /VIProductVersion\s+"([^"]+)"/.exec(outer);
  if (m1 && m1[1] === want) ok('installer.nsi 自报版本', m1[1]);
  else bad('installer.nsi 自报版本', '实测 ' + (m1 ? m1[1] : '未找到') + '，期望 ' + want);
  if (m2 && m2[1] === want) ok('installer-outer.nsi 自报版本', m2[1]);
  else bad('installer-outer.nsi 自报版本', '实测 ' + (m2 ? m2[1] : '未找到') + '，期望 ' + want);
  const pkg = JSON.parse(fs.readFileSync(path.join(tree, 'windows', 'package.json'), 'utf8'));
  if (pkg.version === a.version) ok('package.json 版本', pkg.version);
  else bad('package.json 版本', '实测 ' + pkg.version + '，期望 ' + a.version);
  const buildInfo = path.join(tree, 'windows', 'build-info.json');
  if (fileExists(buildInfo)) {
    const bi = JSON.parse(fs.readFileSync(buildInfo, 'utf8'));
    if (bi.version === a.version) ok('build-info.json 版本', bi.version);
    else bad('build-info.json 版本', '实测 ' + bi.version + '，期望 ' + a.version);
  }
}

function checkManifest(payloadDir) {
  const gen = path.join(__dirname, 'gen_file_manifest.py');
  const r = run('python3', [gen, '--payload', payloadDir, '--check']);
  if (r.status === 0) ok('file-manifest 与 payload 一致', (r.stdout || '').trim());
  else bad('file-manifest 与 payload 一致', (r.stderr || r.stdout || '').trim());
}

function checkStageCopy2(tree) {
  const src = fs.readFileSync(path.join(tree, 'windows', 'tools', 'stage-asar-unpacked.py'), 'utf8');
  if (src.includes('shutil.copy2')) ok('stage-asar-unpacked.py 用 copy2', '保留时间戳');
  else bad('stage-asar-unpacked.py 用 copy2', '未找到 shutil.copy2（须用 copy2 保留时间戳）');
}

function checkMakensisLog(label, logPath) {
  if (!logPath) return;
  if (!fileExists(logPath)) { bad('makensis 日志在位：' + label, logPath + ' 不存在'); return; }
  const text = fs.readFileSync(logPath, 'utf8');
  if (text.includes('writing output (amd64-unicode)')) ok('makensis 日志目标：' + label, 'writing output (amd64-unicode)');
  else bad('makensis 日志目标：' + label, '日志无 writing output (amd64-unicode)');
}

function checkPeFileVersion(a) {
  const probe = run('python3', ['-c', 'import pefile']);
  if (probe.status !== 0) { warn('PE FileVersion（pefile 未装，跳过）', '重打机须装 pefile 才能核此项'); return; }
  const targets = [
    ['外层安装器', a.exe],
    ['内层安装器', a.inner],
    ['payload QFRemote.exe', path.join(a.payloadDir, 'QFRemote.exe')]
  ];
  const want = a.version + '.0';
  const code = [
    'import pefile, sys',
    'for p in sys.argv[1:]:',
    '    try:',
    '        pe = pefile.PE(p)',
    '        ffi = pe.VS_FIXEDFILEINFO[0]',
    '        ms, ls = ffi.FileVersionMS, ffi.FileVersionLS',
    '        print(p + " => " + f"{ms>>16}.{ms&0xffff}.{ls>>16}.{ls&0xffff}")',
    '    except Exception:',
    '        print(p + " => NOVERSION")'
  ].join('\n');
  const r = run('python3', ['-c', code].concat(targets.map((t) => t[1])));
  if (r.status !== 0) { bad('PE FileVersion 读取', (r.stderr || '').trim()); return; }
  const lines = (r.stdout || '').trim().split('\n');
  targets.forEach((t, i) => {
    const line = lines[i] || '';
    const ver = (line.split('=>')[1] || '').trim();
    if (ver === want) ok('PE FileVersion：' + t[0], ver);
    else bad('PE FileVersion：' + t[0], '实测 ' + (ver || '?') + '，期望 ' + want);
  });
}

function checkReleaseJson(a) {
  if (!a.releaseJson) return;
  if (!a.apk) { bad('release.json 校验', '传了 --release-json 却未传 --apk'); return; }
  const mrj = path.join(__dirname, '..', '..', 'server', 'ext', 'make-release-json.js');
  const args = ['--check', a.releaseJson, '--require-signature', '--expect-key-id', a.expectKeyId];
  if (a.verifyKey) args.push('--verify-key', a.verifyKey);
  args.push(a.exe, a.apk);
  const r = run(process.execPath, [mrj].concat(args));
  if (r.status === 0) ok('release.json 校验', 'size/sha256/url/version 一致，签名有效（key_id=' + a.expectKeyId + '）');
  else bad('release.json 校验', ((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(0, 5).join(' / '));
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.version || !/^\d+\.\d+\.\d+$/.test(a.version)) fail('--version 须为 x.y.z 形');
  for (const k of ['exe', 'inner', 'pluginsDir', 'app7z', 'payloadDir']) {
    if (!a[k]) fail('须传 --' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
  }
  const tree = a.tree ? path.resolve(a.tree) : path.resolve(__dirname, '..', '..');
  console.log('release-gate：version ' + a.version + '，tree ' + tree);
  checkMakensisVersion();
  checkInstallerTarget('外层', a.exe);
  checkInstallerTarget('内层', a.inner);
  checkNsis7z(a.pluginsDir);
  checkApp7z(a.app7z);
  checkVersions(a, tree);
  checkManifest(a.payloadDir);
  checkStageCopy2(tree);
  checkMakensisLog('内层', a.logInner);
  checkMakensisLog('外层', a.logOuter);
  checkPeFileVersion(a);
  checkReleaseJson(a);
  console.log(JSON.stringify({ pass: failures === 0, failures, warnings }));
  if (failures) { console.error('release-gate：' + failures + ' 项未通过，不许发版。'); process.exit(1); }
  console.log('release-gate：全部通过。');
}
main();
