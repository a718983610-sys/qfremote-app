'use strict';
/*
 * 构建期风味检查（A16-S2 TEST 隔离，GPT 2026-11-18 定夺 §1.1/§1.2）。
 * ================================================================
 * 用法：
 *   node tools/check-build-flavor.js --flavor production [--windows-dir <dir>]
 *   node tools/check-build-flavor.js --flavor test [--windows-dir <dir>] --lea-client <path>
 *   （--windows-dir 缺省为本文件上一级的 windows/ 目录；
 *    TEST 构建由 scripts/build-test-main.js 对 staging 副本调用，
 *    --windows-dir 指向 staging 目录。）
 * 生产构建由 package.json 的 predist 自动跑（npm run dist 前）；
 * TEST 构建由 build-test-main.js 在 pack asar 前跑。
 * 任一检查不过即 exit 1，不许打包、不许发布。
 *
 * 检查项：
 *  1. build-flavor.js 的 BUILD_FLAVOR 与 --flavor 一致；
 *     production 时 TEST_CLIENT_SHA256 须为空；
 *     test 时 TEST_CLIENT_SHA256 须为 64 位 hex，且与 --lea-client
 *     文件的实测 SHA 一致。
 *  2. 仓内不存在“环境变量决定 TEST 身份”的开关：
 *     process.env.QFR_TEST_MODE / process.env.QFREMOTE_TEST 在
 *     main.js / test-policy.js / build-flavor.js 中零命中。
 *  3. main.js 在 TEST 下禁用 PREVIEW（`const PREVIEW = IS_TEST ? '' : PREVIEW_RAW;`）。
 *  4. package.json build.files 含 build-flavor.js 与 test-policy.js
 *    （否则 TEST 身份进不了 asar）。
 *  5. production 时：build-flavor.js 须为仓内默认值（production＋空 SHA），
 *     且 main.js 不含 TEST 专用配置（BUILD_FLAVOR='test' 字面量零命中）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(msg) { console.error('check-build-flavor: FAIL ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('check-build-flavor: ok ' + msg); }

const args = process.argv.slice(2);
let flavor = '';
let windowsDir = path.join(__dirname, '..');
let leaClient = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--flavor') flavor = args[++i] || '';
  else if (args[i] === '--windows-dir') windowsDir = args[++i] || windowsDir;
  else if (args[i] === '--lea-client') leaClient = args[++i] || '';
}
if (flavor !== 'production' && flavor !== 'test') {
  console.error('usage: node tools/check-build-flavor.js --flavor production|test [--windows-dir <dir>] [--lea-client <path>]');
  process.exit(2);
}

let failures = 0;
const check = (cond, msg) => { if (cond) ok(msg); else { failures++; fail(msg); } };

// 1. build-flavor.js
const flavorPath = path.join(windowsDir, 'build-flavor.js');
let flavorMod = null;
try {
  delete require.cache[require.resolve(flavorPath)];
  flavorMod = require(flavorPath);
} catch (e) {
  failures++; fail('build-flavor.js 读不到：' + (e && e.message || String(e)));
}
if (flavorMod) {
  check(flavorMod.BUILD_FLAVOR === flavor, 'BUILD_FLAVOR=' + flavorMod.BUILD_FLAVOR + '（期望 ' + flavor + '）');
  const sha = (typeof flavorMod.TEST_CLIENT_SHA256 === 'string') ? flavorMod.TEST_CLIENT_SHA256 : '';
  if (flavor === 'production') {
    check(sha === '', '生产构建 TEST_CLIENT_SHA256 为空');
  } else {
    check(/^[0-9a-f]{64}$/.test(sha), 'TEST 构建 TEST_CLIENT_SHA256 为 64 位 hex');
    if (!leaClient) { failures++; fail('TEST 构建须传 --lea-client（A+ TEST 客户端路径）以核对 SHA'); }
    else if (!fs.existsSync(leaClient)) { failures++; fail('--lea-client 不存在：' + leaClient); }
    else {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(leaClient)).digest('hex');
      check(actual === sha.toLowerCase(), 'TEST 客户端 SHA 与 build-flavor.js 一致（' + actual.slice(0, 12) + '…）');
    }
  }
}

// 2. 无环境变量 TEST 开关
for (const name of ['main.js', 'test-policy.js', 'build-flavor.js']) {
  const p = path.join(windowsDir, name);
  if (!fs.existsSync(p)) { failures++; fail(name + ' 不存在'); continue; }
  const src = fs.readFileSync(p, 'utf8');
  const hits = (src.match(/process\.env\.(QFR_TEST_MODE|QFREMOTE_TEST)/g) || []).length;
  check(hits === 0, name + ' 无 process.env QFR_TEST_MODE/QFREMOTE_TEST（命中 ' + hits + '）');
}

// 3. TEST 下禁用 PREVIEW
{
  const p = path.join(windowsDir, 'main.js');
  const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  check(src.includes("const PREVIEW = IS_TEST ? '' : PREVIEW_RAW;"),
    'main.js 在 TEST 下强制 PREVIEW 为空（IS_TEST ? \'\' : PREVIEW_RAW）');
}

// 4. build.files 含两文件
{
  const p = path.join(windowsDir, 'package.json');
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* ignore */ }
  const files = (pkg && pkg.build && Array.isArray(pkg.build.files)) ? pkg.build.files : [];
  check(files.includes('build-flavor.js'), 'package.json build.files 含 build-flavor.js');
  check(files.includes('test-policy.js'), 'package.json build.files 含 test-policy.js');
}

// 5. 生产反向门禁
if (flavor === 'production') {
  const p = path.join(windowsDir, 'main.js');
  const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  // main.js 只在 test-policy 层读风味；此处只查“硬编码 test 风味”字面量
  // 不得出现在 main.js（TEST 身份只由 build-flavor.js 注入）。
  check(!src.includes("BUILD_FLAVOR: 'test'"), '生产构建 main.js 不含 TEST 专用配置字面量');
}

if (failures) { console.error('check-build-flavor: ' + failures + ' 项未通过'); process.exit(1); }
console.log('check-build-flavor: PASS flavor=' + flavor);
