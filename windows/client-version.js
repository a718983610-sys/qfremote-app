'use strict';
/*
 * QFRemote 客户端版本头 —— 统一出口（2.3.2，决策 #41/#42 互联窗第一步）
 * ================================================================
 * 口径：壳向自家服务发请求时统一带请求头 x-qf-client-version，值取
 * 运行时应用版本。服务端本版只记录观察、不据此拒绝（拒服留下版开启）。
 *
 * 纪律（不许散落硬编码）：
 *   - 版本值只有一个来源：主进程启动时以 app.getVersion() 注入
 *     setClientVersion()；未注入时回落 package.json 的 version 字段
 *     （Electron 的 app.getVersion() 本就取自 package.json，两者同源）。
 *     任何模块都不许自己写死版本字符串。
 *   - 各请求出口（main.js 的 extRequest/探活、svc-urls、lock、autologin、
 *     update）一律经本模块取头，不许各自拼头名/头值。
 *   - 头名只有一个常量 HEADER_NAME，改名只改这一处。
 */
const HEADER_NAME = 'x-qf-client-version';

function isVersionString(v) {
  return typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v.trim());
}

function fallbackVersion() {
  try {
    const pkg = require('./package.json');
    if (pkg && isVersionString(pkg.version)) return pkg.version.trim();
  } catch (e) { /* ignore */ }
  try {
    const info = require('./build-info.json');
    if (info && isVersionString(info.version)) return info.version.trim();
  } catch (e) { /* ignore */ }
  return '';
}

let currentVersion = fallbackVersion();

// 主进程启动时注入运行时版本（app.getVersion()）。非法值忽略、保留现值。
function setClientVersion(v) {
  if (isVersionString(v)) currentVersion = String(v).trim();
  return currentVersion;
}

function getClientVersion() { return currentVersion; }

// 解析「字符串 | 函数 | 空」形态的版本来源（各模块 opts.clientVersion 用）：
// 函数则调用取返回值；解析不出合法版本时回落全局当前版本。
function resolveVersion(source) {
  try {
    const v = (typeof source === 'function') ? source() : source;
    if (isVersionString(v)) return String(v).trim();
  } catch (e) { /* ignore */ }
  return currentVersion;
}

// 生成只含版本头的对象（无合法版本时返回空对象，调用方照常发请求、不许因此失败）
function clientVersionHeaders(source) {
  const v = resolveVersion(source);
  if (!v) return {};
  const h = {};
  h[HEADER_NAME] = v;
  return h;
}

// 把版本头并入既有 headers 对象（不覆盖调用方已显式设置的同名头），返回同一对象
function withClientVersion(headers, source) {
  const h = headers || {};
  const v = resolveVersion(source);
  if (v && h[HEADER_NAME] === undefined && h['X-Qf-Client-Version'] === undefined) {
    h[HEADER_NAME] = v;
  }
  return h;
}

module.exports = {
  HEADER_NAME,
  isVersionString,
  setClientVersion,
  getClientVersion,
  resolveVersion,
  clientVersionHeaders,
  withClientVersion
};
