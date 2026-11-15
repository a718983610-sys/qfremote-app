#!/usr/bin/env node
/*
 * D-04（3.0.0，全进 3.0）：QFRemote Windows 便携版（ZIP）打包器。
 *
 * 与安装包同一份 payload（即 app.7z 的内容）并行出 ZIP：
 *   node windows/tools/make-portable-zip.js \
 *     --payload <payload-dir> --version 3.0.0 \
 *     [--out QFRemote-v3.0.0-portable.zip]
 *
 * 做法：复制 payload 到临时 staging → 写入 install-mode.txt=portable
 * （更新逻辑凭此判定便携版：只提示＋下 ZIP，不静默装、不转安装版）
 * 与 README-便携版.txt → 7z -tzip -mx=9 打包 → 7z t 校验。
 * 打包前先跑 gen_file_manifest.py --check（清单与 payload 逐件一致，
 * 与发版门同一口径）；payload 里若已有 install-mode.txt 即失败
 * （防旧标记混入）。不改 payload 原目录、不写注册表、不装服务。
 *
 * 产物只供发版流程（make-release-json.js --zip）与 L7 重打时用；
 * 本脚本不发布、不上传、不翻 release.json。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const README_PORTABLE = [
  'QFRemote 便携版（解压即运行）',
  '================================',
  '用法：解压到任意文件夹，双击 QFRemote.exe 即可运行。',
  '- 不写注册表、不装系统服务、不设开机自启；',
  '- 不自动更新：发现新版时只提示，给新便携包下载链接；',
  '- 完整功能（含本地代理服务）请用安装版。',
  '本包由 windows/tools/make-portable-zip.js 与安装包同一份 payload 打出，',
  'install-mode.txt=portable 标识本包为便携版。',
  ''
].join('\n');

function fail(msg) { console.error('make-portable-zip: ' + msg); process.exit(1); }

function parseArgs(argv) {
  const a = { payload: null, out: null, version: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => { if (i + 1 >= argv.length) fail('参数 ' + t + ' 缺少值'); return argv[++i]; };
    if (t === '--payload') a.payload = next();
    else if (t === '--out') a.out = next();
    else if (t === '--version') a.version = next();
    else if (t === '--help' || t === '-h') { console.log('用法：node windows/tools/make-portable-zip.js --payload <payload-dir> --version <x.y.z> [--out <zip>]'); process.exit(0); }
    else if (t.startsWith('-')) fail('未知参数：' + t);
    else fail('未知位置参数：' + t);
  }
  return a;
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

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  if (r.error) fail('无法执行 ' + cmd + '：' + r.error.message);
  return r;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.payload) fail('须传 --payload <payload-dir>（app.7z 的内容目录）');
  if (!a.version || !/^\d+\.\d+\.\d+$/.test(a.version)) fail('--version 须为 x.y.z 形，实测：' + a.version);
  const payload = path.resolve(a.payload);
  if (!fs.statSync(payload, { throwIfNoEntry: false }) || !fs.statSync(payload).isDirectory()) fail('payload 目录不存在：' + payload);
  if (!fs.existsSync(path.join(payload, 'QFRemote.exe'))) fail('payload 缺 QFRemote.exe：' + payload);
  if (!fs.existsSync(path.join(payload, 'file-manifest.txt'))) fail('payload 缺 file-manifest.txt（须先跑 gen_file_manifest.py 生成）：' + payload);
  if (fs.existsSync(path.join(payload, 'install-mode.txt'))) fail('payload 已含 install-mode.txt（旧标记混入，请先清掉再打）');

  // 打包前：清单与 payload 逐件一致（与发版门同一口径）。
  const gen = path.join(__dirname, 'gen_file_manifest.py');
  const chk = run('python3', [gen, '--payload', payload, '--check']);
  if (chk.status !== 0) fail('file-manifest --check 未通过：' + (chk.stderr || chk.stdout || ''));

  const out = path.resolve(a.out || ('QFRemote-v' + a.version + '-portable.zip'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-portable-'));
  try {
    fs.cpSync(payload, stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'install-mode.txt'), 'portable\n');
    fs.writeFileSync(path.join(stage, 'README-便携版.txt'), README_PORTABLE);
    const pack = run('7z', ['a', '-tzip', '-mx=9', out, '*'], { cwd: stage });
    if (pack.status !== 0) fail('7z 打包失败：' + (pack.stderr || pack.stdout || ''));
    const test = run('7z', ['t', out]);
    if (test.status !== 0) fail('7z t 校验失败：' + (test.stderr || test.stdout || ''));
    const list = run('7z', ['l', out]);
    if (list.status !== 0 || !list.stdout.includes('install-mode.txt')) fail('产物缺 install-mode.txt，拒绝出包');
    const st = fs.statSync(out);
    console.log('便携包已生成：' + out + '（' + st.size + ' B，SHA-256 ' + sha256File(out) + '，install-mode=portable，7z t 通过）。');
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}
main();
