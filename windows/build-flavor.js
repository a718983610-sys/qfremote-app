'use strict';
// 构建期风味（A16-S2 TEST 隔离，GPT 2026-11-18 定夺 §1.1）。
// 本文件是提交进仓的默认值：'production'。
// TEST 构建由 windows/scripts/build-test-main.js 在 staging 副本里
// 改写为 'test'（并写入 TEST 客户端期望 SHA），绝不改仓内本文件。
// main.js 只认本文件的常量，不读任何环境变量决定 TEST 身份；
// 未知／缺失风味一律按 'production' 处理（test-policy.js）。
module.exports = {
  BUILD_FLAVOR: 'production',
  // TEST 客户端 qf-lea-client.exe 的期望 SHA-256（小写 hex）。
  // 生产构建恒为空；TEST 构建由打包脚本在 staging 时填入，
  // 运行时 test-policy.js 逐字节核对，不符即拒绝进入登录流程。
  TEST_CLIENT_SHA256: ''
};
