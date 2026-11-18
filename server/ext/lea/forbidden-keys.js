'use strict';
/*
 * QFRemote 敏感字段禁键表唯一正本（U6；GPT A4 裁决）
 * =====================================================
 * qf-diagnostics.js（正本过滤）与 lea-core.js（加载失败回退）共用同一份
 * 规则，消除“回退表少 4 键”的降级不等价。本文件零依赖（不 require 任何
 * 模块），回退路径引用它不会引入新的加载失败点。
 *
 * 31 键。改动此表须同步跑 server/ext/test-a4-u2-u3-u6.js 的一致性断言
 * （forbidden-keys 与 qf-diagnostics FORBIDDEN_KEYS 逐项相等；回退路径
 * 行为测试须覆盖 credit_card / card_number / ssn / idcard 四键）。
 */
const FORBIDDEN_KEYS = Object.freeze([
  'password', 'passwd', 'pwd', 'cookie', 'cookies', 'api_key', 'apikey',
  'api-key', 'secret', 'private_key', 'privatekey', 'private-key',
  'authorization', 'token', 'access_token', 'refresh_token', 'id_token',
  'input', 'content', 'plaintext', 'plain_text', 'cipher', 'ciphertext',
  'sessioncopy', 'session_copy', 'wrappedpriv', 'wrappedvault',
  'credit_card', 'card_number', 'ssn', 'idcard',
]);

module.exports = { FORBIDDEN_KEYS };
