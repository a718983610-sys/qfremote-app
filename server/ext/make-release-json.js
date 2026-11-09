#!/usr/bin/env node
/*
 * W-15：release.json 生成器/校验器（2.4.5）。
 *
 * 背景：release.json 过去是手写，version/size/sha256/minUsable 全凭人工
 * 对齐，出错即客户端误判更新或下错包。本脚本把对齐机械化：
 *   size  = 实测文件字节数（不手写），sha256 = 实算（不手写），
 *   url   = https://app.qfremote.top/dl/<文件名> 固定模板，
 *   minUsable 默认等于 version（翻牌时由协调人显式传入，不得默抬）。
 *
 * 用法（在工作树根目录或任意目录运行）：
 *   生成：node server/ext/make-release-json.js \
 *           --exe  QFRemote-Setup-v2.4.5.exe \
 *           --apk  QFRemote-v2.4.5.apk \
 *           --version 2.4.5 [--min-usable 2.4.5] \
 *           [--notes "……"] [--notes-android "……"] \
 *           [--out server/meshcentral/public/release.json]
 *         不传 --out 时只打印到 stdout，不写文件（默认安全）。
 *   校验：node server/ext/make-release-json.js \
 *           --check server/meshcentral/public/release.json \
 *           QFRemote-Setup-v2.4.5.exe QFRemote-v2.4.5.apk
 *         逐项比对 size/sha256/url 文件名/version/minUsable，
 *         全部一致 exit 0，任一不一致 exit 1 并逐项报错。
 *
 * 注意：本脚本只生成文件内容，不翻线上 release.json、不改 minUsable
 * 的翻牌决策；翻牌由协调人在包建好验过后做。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(msg) { console.error('make-release-json: ' + msg); process.exit(1); }

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function parseArgs(argv) {
  const a = { exe: null, apk: null, version: null, minUsable: null, notes: '', notesAndroid: '', out: null, check: null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => { if (i + 1 >= argv.length) fail('参数 ' + t + ' 缺少值'); return argv[++i]; };
    if (t === '--exe') a.exe = next();
    else if (t === '--apk') a.apk = next();
    else if (t === '--version') a.version = next();
    else if (t === '--min-usable') a.minUsable = next();
    else if (t === '--notes') a.notes = next();
    else if (t === '--notes-android') a.notesAndroid = next();
    else if (t === '--out') a.out = next();
    else if (t === '--check') a.check = next();
    else if (t === '--help' || t === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 31).join('\n')); process.exit(0); }
    else if (t.startsWith('-')) fail('未知参数：' + t);
    else a.files.push(t);
  }
  return a;
}

function buildDoc(a) {
  if (!a.version) fail('生成模式须传 --version');
  if (!/^\d+\.\d+\.\d+$/.test(a.version)) fail('version 须为 x.y.z 形，如 2.4.5，实测：' + a.version);
  const minUsable = a.minUsable || a.version;
  if (!/^\d+\.\d+\.\d+$/.test(minUsable)) fail('minUsable 须为 x.y.z 形，实测：' + minUsable);
  if (!a.exe || !a.apk) fail('生成模式须同时传 --exe 与 --apk');
  const exeName = path.basename(a.exe), apkName = path.basename(a.apk);
  const exeStat = fs.statSync(a.exe);
  const apkStat = fs.statSync(a.apk);
  if (!exeStat.isFile()) fail('--exe 不是文件：' + a.exe);
  if (!apkStat.isFile()) fail('--apk 不是文件：' + a.apk);
  return {
    version: a.version,
    notes: a.notes || (a.version + ' 正式版。'),
    url: 'https://app.qfremote.top/dl/' + exeName,
    sha256: sha256File(a.exe),
    size: exeStat.size,
    minUsable,
    android: {
      version: a.version,
      notes: a.notesAndroid || (a.version + ' 正式版：稳定性与体验优化。退出应用后重新打开将自动完成更新。'),
      url: 'https://app.qfremote.top/dl/' + apkName,
      sha256: sha256File(a.apk),
      size: apkStat.size,
      minUsable
    },
    interop: { window: 2, minVersion: a.version }
  };
}

function verifySelf(doc, a) {
  // 生成后自校验：重算 size/sha256，与刚生成的文档逐项比对。
  const problems = [];
  const exeSize = fs.statSync(a.exe).size, apkSize = fs.statSync(a.apk).size;
  if (doc.size !== exeSize) problems.push('exe size 不一致：文档 ' + doc.size + ' vs 实测 ' + exeSize);
  if (doc.android.size !== apkSize) problems.push('apk size 不一致：文档 ' + doc.android.size + ' vs 实测 ' + apkSize);
  if (doc.sha256 !== sha256File(a.exe)) problems.push('exe sha256 不一致');
  if (doc.android.sha256 !== sha256File(a.apk)) problems.push('apk sha256 不一致');
  if (!doc.url.endsWith('/' + path.basename(a.exe))) problems.push('exe url 文件名与 --exe 不符：' + doc.url);
  if (!doc.android.url.endsWith('/' + path.basename(a.apk))) problems.push('apk url 文件名与 --apk 不符：' + doc.android.url);
  return problems;
}

function checkMode(a) {
  if (!a.check) fail('--check 须给 release.json 路径');
  if (a.files.length !== 2) fail('--check 模式须再给 exe 与 apk 两个文件路径（顺序：exe apk）');
  const doc = JSON.parse(fs.readFileSync(a.check, 'utf8'));
  const [exeP, apkP] = a.files;
  const problems = [];
  const expect = (label, got, want) => { if (got !== want) problems.push(label + '：文档 ' + JSON.stringify(got) + ' vs 实测 ' + JSON.stringify(want)); };
  expect('exe size', doc.size, fs.statSync(exeP).size);
  expect('exe sha256', doc.sha256, sha256File(exeP));
  expect('apk size', doc.android && doc.android.size, fs.statSync(apkP).size);
  expect('apk sha256', doc.android && doc.android.sha256, sha256File(apkP));
  expect('exe url 文件名', doc.url && path.basename(doc.url), path.basename(exeP));
  expect('apk url 文件名', doc.android && doc.android.url && path.basename(doc.android.url), path.basename(apkP));
  expect('version', doc.version, doc.android && doc.android.version);
  if (doc.minUsable !== doc.version) problems.push('minUsable(' + doc.minUsable + ')与 version(' + doc.version + ')不一致——翻牌前请确认是有意为之');
  if (problems.length) {
    console.error('校验失败（' + problems.length + ' 项）：');
    problems.forEach(p => console.error('  - ' + p));
    process.exit(1);
  }
  console.log('校验通过：' + a.check + ' 与两个包的 size/sha256/url/version 全部一致（version ' + doc.version + '，minUsable ' + doc.minUsable + '）。');
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.check) return checkMode(a);
  const doc = buildDoc(a);
  const problems = verifySelf(doc, a);
  if (problems.length) { problems.forEach(p => console.error('自校验失败：' + p)); process.exit(1); }
  const text = JSON.stringify(doc, null, 2) + '\n';
  if (a.out) {
    fs.writeFileSync(a.out, text);
    console.log('已写入 ' + a.out + '（version ' + doc.version + '，minUsable ' + doc.minUsable + '，exe ' + doc.size + ' B，apk ' + doc.android.size + ' B，自校验通过）。');
  } else {
    process.stdout.write(text);
    console.error('（未写文件：未传 --out。发版时显式传 --out 指向 server/meshcentral/public/release.json。）');
  }
}
main();
