'use strict';
/*
 * TEST 隔离策略（A16-S2，GPT 2026-11-18 定夺 §1；定夺全文见
 * ~/workspace/qfremote/gpt-a16s2-testmain-ruling-20261118.md）。
 * ================================================================
 * 唯一身份源：构建期常量 BUILD_FLAVOR（build-flavor.js，由打包脚本
 * 在 staging 时写入，不可由运行时环境变量覆盖）。
 * 任何环境变量（QFR_TEST_MODE / QFREMOTE_PREVIEW / QFREMOTE_LOCK_MOCK）
 * 都不能改变 TEST 身份；QFR_TEST_MODE 在本仓不存在、也不许引入。
 * 未知／缺失风味一律按 'production' 处理——fail-closed 向生产侧：
 * 绝不在生产构建里误开 TEST 行为；TEST 构建缺失风味文件即按生产
 * 跑，随后被运行时校验（execPath 不符）拦下。
 *
 * 本模块是纯 Node（不 require electron），可在沙箱单测
 * （windows/test/test-policy-test.js）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let flavor = { BUILD_FLAVOR: 'production', TEST_CLIENT_SHA256: '' };
try { flavor = require('./build-flavor'); } catch (e) { /* 缺失即生产默认值 */ }
const BUILD_FLAVOR = (flavor && flavor.BUILD_FLAVOR === 'test') ? 'test' : 'production';
const TEST_CLIENT_SHA256 = (flavor && typeof flavor.TEST_CLIENT_SHA256 === 'string')
  ? flavor.TEST_CLIENT_SHA256.toLowerCase() : '';

const IS_TEST = BUILD_FLAVOR === 'test';

// ---- TEST 身份常量（GPT 定夺 §1.1/§1.2；与 A+ TEST 二进制一致） ----
const TEST_INSTALL_DIR = 'C:\\QFRLEA-TEST';
const TEST_EXE_PATH = 'C:\\QFRLEA-TEST\\QFRemote.exe';
const TEST_LEA_DIR = 'C:\\QFRLEA-TEST\\LEA';
const TEST_CLIENT_EXE = 'C:\\QFRLEA-TEST\\LEA\\qf-lea-client.exe';
const TEST_SERVICE_NAME = 'QFRLEA-TEST';
const TEST_PIPE_NAME = '\\\\.\\pipe\\QFR\\LEA-TEST\\v1';
const TEST_DATA_LEAF = 'LEA-TEST'; // %ProgramData%\QFR\LEA-TEST
const TEST_REG_KEY = 'HKLM\\SOFTWARE\\QFR\\LEA-TEST';
const TEST_USER_DATA_DIR_NAME = 'QFRemote-TEST'; // %APPDATA%\QFRemote-TEST
const TEST_PARTITION = 'persist:qfremote-test';
const TEST_APP_USER_MODEL_ID = 'com.qfremote.desktop.test';
const PROD_APP_USER_MODEL_ID = 'com.qfremote.desktop';
const PROD_PARTITION = 'persist:qfremote';
const TEST_BOOT_LOG_NAME = 'qfremote-boot-test.log';
const PROD_BOOT_LOG_NAME = 'qfremote-boot.log';

function isTestBuild() { return IS_TEST; }
function buildFlavor() { return BUILD_FLAVOR; }
function consolePartition() { return IS_TEST ? TEST_PARTITION : PROD_PARTITION; }
function bootLogFileName() { return IS_TEST ? TEST_BOOT_LOG_NAME : PROD_BOOT_LOG_NAME; }
function appUserModelId() { return IS_TEST ? TEST_APP_USER_MODEL_ID : PROD_APP_USER_MODEL_ID; }
function testInstallDir() { return TEST_INSTALL_DIR; }
function testExePath() { return TEST_EXE_PATH; }
function testLeaDir() { return TEST_LEA_DIR; }
function testClientExePath() { return TEST_CLIENT_EXE; }
function testServiceName() { return TEST_SERVICE_NAME; }
function testPipeName() { return TEST_PIPE_NAME; }
function testDataLeaf() { return TEST_DATA_LEAF; }
function testRegKey() { return TEST_REG_KEY; }
function testUserDataDir(app) {
  try { return path.join(app.getPath('appData'), TEST_USER_DATA_DIR_NAME); } catch (e) { return ''; }
}
function testDataRoot() {
  try { return path.join(process.env.ProgramData || '', 'QFR', TEST_DATA_LEAF); } catch (e) { return ''; }
}

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return ''; }
}

// TEST 客户端期望 SHA 核对（构建期注入；未配置即不通过，不静默放行）。
// fns.expectedClientSha 可覆盖期望值（单测用；生产调用方不传）。
function testClientShaOk(fns) {
  const f = fns || {};
  const read = f.sha256File || sha256File;
  const expected = (typeof f.expectedClientSha === 'string')
    ? f.expectedClientSha.toLowerCase() : TEST_CLIENT_SHA256;
  if (!expected) return false;
  const actual = read(TEST_CLIENT_EXE);
  return !!actual && actual.toLowerCase() === expected;
}

/*
 * TEST 启动时运行时强制校验（GPT 定夺 §1.1）。
 * 任一条件不满足即拒绝进入登录流程，绝不降级为普通生产模式。
 * fns 可注入假 fs 供单测：{ existsSync, realpathSync, sha256File }。
 * 返回 { ok, failures: [] }；failures 为机器可读码＋一句话原因。
 */
function validateTestEnvironment(execPath, fns) {
  const failures = [];
  const f = fns || {};
  const existsSync = f.existsSync || fs.existsSync;
  const realpathSync = f.realpathSync || fs.realpathSync;
  const sha = f.sha256File || sha256File;
  // expectedClientSha 可覆盖（单测用；生产调用方不传，用构建期注入值）。
  const expectedSha = (typeof f.expectedClientSha === 'string')
    ? f.expectedClientSha.toLowerCase() : TEST_CLIENT_SHA256;
  const norm = (s) => String(s || '').replace(/\//g, '\\').toLowerCase();
  // 1. 运行文件须为 C:\QFRLEA-TEST\QFRemote.exe，且无异常重解析点
  //    （realpath 解析符号链接／目录联接后仍须一致）。
  if (!execPath) {
    failures.push('test-exe-missing: execPath 为空');
  } else if (norm(execPath) !== norm(TEST_EXE_PATH)) {
    failures.push('test-exe-path-mismatch: 运行文件不是 ' + TEST_EXE_PATH);
  } else {
    try {
      // 实测路径须与字面 TEST 路径一致：任何符号链接／目录联接
      // 都会让实测路径偏离字面路径，即为“异常重解析点”，直接拒绝。
      const realExe = realpathSync(execPath);
      if (norm(realExe) !== norm(TEST_EXE_PATH)) failures.push('test-exe-reparse: 运行文件经重解析点指向他处（' + realExe + '）');
    } catch (e) {
      failures.push('test-exe-unresolvable: 运行文件无法解析（' + (e && e.message || String(e)) + '）');
    }
  }
  // 2. 同目录存在经 SHA 核验的 TEST 客户端（A+ TEST 版）。
  if (!existsSync(TEST_CLIENT_EXE)) {
    failures.push('test-client-missing: ' + TEST_CLIENT_EXE + ' 不存在');
  } else if (!expectedSha) {
    failures.push('test-client-sha-unconfigured: 构建期未注入 TEST 客户端期望 SHA');
  } else {
    const actual = sha(TEST_CLIENT_EXE);
    if (!actual || actual.toLowerCase() !== expectedSha) {
      failures.push('test-client-sha-mismatch: TEST 客户端 SHA 与构建期期望不一致');
    }
  }
  // 3. TEST 安装目录在位（LEA/ 三件的父目录）。
  if (!existsSync(TEST_LEA_DIR)) failures.push('test-lea-dir-missing: ' + TEST_LEA_DIR + ' 不存在');
  return { ok: failures.length === 0, failures };
}

// TEST 下被禁操作的统一回包（调用方直接返回，不再往下走）。
function testDenied(action) {
  return { ok: false, reason: 'test-mode-denied', action: action || '' };
}

module.exports = {
  BUILD_FLAVOR,
  IS_TEST,
  TEST_INSTALL_DIR,
  TEST_EXE_PATH,
  TEST_LEA_DIR,
  TEST_CLIENT_EXE,
  TEST_SERVICE_NAME,
  TEST_PIPE_NAME,
  TEST_DATA_LEAF,
  TEST_REG_KEY,
  TEST_USER_DATA_DIR_NAME,
  TEST_PARTITION,
  TEST_APP_USER_MODEL_ID,
  PROD_APP_USER_MODEL_ID,
  PROD_PARTITION,
  TEST_BOOT_LOG_NAME,
  PROD_BOOT_LOG_NAME,
  isTestBuild,
  buildFlavor,
  consolePartition,
  bootLogFileName,
  appUserModelId,
  testInstallDir,
  testExePath,
  testLeaDir,
  testClientExePath,
  testServiceName,
  testPipeName,
  testDataLeaf,
  testRegKey,
  testUserDataDir,
  testDataRoot,
  sha256File,
  testClientShaOk,
  validateTestEnvironment,
  testDenied
};
