#!/usr/bin/env node
/*
 * S-098/S-103：版本单一来源校验器——version.json 是唯一 release source。
 *
 * 核对（任一项不一致即 exit 1、不许发版）：
 *   1. windows/package.json version == version.json version
 *   2. android-app/pubspec.yaml version == "<version>+<build>"
 *   3. android-app/lib/build_info.dart kAppVersion == version
 *   4. windows/installer.nsi / installer-outer.nsi 的 VIProductVersion
 *      == "<version>.0"（只读核对；NSIS 内注入 BUILD_VERSION 是 C-1 S-017 的事，
 *      本脚本不改 .nsi，只校验两者一致）
 *   5. windows/build-info.json 如已生成，其 version == version
 *      （生成器 windows/tools/gen_build_info.js 已改读 version.json）
 *
 * 明确不核：server/meshcentral/public/release.json（线上现行清单在翻牌前
 * 仍为 2.4.4，翻牌后才等于新版；它由 .github/workflows/release-check.yml
 * 调 make-release-json.js --check --require-signature 全值比对）。
 *
 * 用法：node tools/check-release-version.js [--root <工作树根目录>]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let root = path.resolve(__dirname, '..');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[i + 1]);
}
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failures = 0;
function ok(label, detail) { console.log('ok  - ' + label + (detail ? '（' + detail + '）' : '')); }
function bad(label, detail) { failures++; console.log('FAIL- ' + label + (detail ? '（' + detail + '）' : '')); }

const ver = JSON.parse(read('version.json'));
if (!/^\d+\.\d+\.\d+$/.test(ver.version) || !Number.isInteger(ver.build)) {
  console.log('FAIL- version.json 格式非法：version 须为 x.y.z，build 须为整数');
  process.exit(1);
}
ok('version.json', 'version=' + ver.version + ' build=' + ver.build);

// 1. windows/package.json
const pkg = JSON.parse(read('windows/package.json'));
if (pkg.version === ver.version) ok('windows/package.json', pkg.version);
else bad('windows/package.json', '为 ' + pkg.version + '，期望 ' + ver.version);

// 2. android-app/pubspec.yaml
const pubspec = read('android-app/pubspec.yaml');
const pm = pubspec.match(/^version:\s*(\d+\.\d+\.\d+)\+(\d+)\s*$/m);
if (pm && pm[1] === ver.version && Number(pm[2]) === ver.build) {
  ok('android-app/pubspec.yaml', pm[1] + '+' + pm[2]);
} else {
  bad('android-app/pubspec.yaml', '为 ' + (pm ? pm[1] + '+' + pm[2] : '未解析到 version') + '，期望 ' + ver.version + '+' + ver.build);
}

// 3. android-app/lib/build_info.dart
const dart = read('android-app/lib/build_info.dart');
const dm = dart.match(/const String kAppVersion = '([^']+)';/);
if (dm && dm[1] === ver.version) ok('android-app/lib/build_info.dart kAppVersion', dm[1]);
else bad('android-app/lib/build_info.dart kAppVersion', '为 ' + (dm ? dm[1] : '未解析到') + '，期望 ' + ver.version);

// 4. installer.nsi / installer-outer.nsi（只读核对）
for (const nsi of ['windows/installer.nsi', 'windows/installer-outer.nsi']) {
  let text;
  try { text = read(nsi); } catch (e) { bad(nsi, '文件缺失'); continue; }
  const m = text.match(/VIProductVersion\s+"([^"]+)"/);
  const expect = ver.version + '.0';
  if (m && m[1] === expect) ok(nsi + ' VIProductVersion', m[1]);
  else bad(nsi + ' VIProductVersion', '为 ' + (m ? m[1] : '未解析到') + '，期望 ' + expect);
}

// 5. windows/build-info.json（如已生成）
const biPath = path.join(root, 'windows/build-info.json');
if (fs.existsSync(biPath)) {
  const bi = JSON.parse(fs.readFileSync(biPath, 'utf8'));
  if (bi.version === ver.version) ok('windows/build-info.json', bi.version);
  else bad('windows/build-info.json', '为 ' + bi.version + '，期望 ' + ver.version);
} else {
  console.log('SKIP- windows/build-info.json 未生成（打包时由 gen_build_info.js 生成）');
}

if (failures > 0) {
  console.log('FAIL-TOTAL ' + failures + ' 处版本不一致：修到与 version.json 一致再发版');
  process.exit(1);
}
console.log('OK 全部版本源与 version.json 一致（version=' + ver.version + ' build=' + ver.build + '）');
