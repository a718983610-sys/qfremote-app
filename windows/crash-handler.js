'use strict';
/*
 * QFRemote Windows 运行端 — 崩溃处理（D-06，3.0.0）
 * ================================================================
 * 照搬 OBS Studio 的成体系做法（desktop/REPORT.md §六）：
 *   - 本地 crashes 目录：%userData%/crashes，单份报告上限 150KB
 *     （MAX_CRASH_REPORT_SIZE），超限截断并标注；
 *   - .sentinel 哨兵：启动时创建、干净退出时删除；下次启动残留
 *     即上次非正常退出（崩溃/强杀/断电）；
 *   - 安全模式：残留哨兵时下次启动二选一（正常启动 / 安全模式），
 *     另支持 --safe-mode 启动参数；安全模式下不加载第三方/实验
 *     能力——QFRemote 口径：不做静默登录、不做启动 agent 自愈、
 *     不做自动更新检查、不预加载社交视图、不跑积分心跳；
 *   - 上传：只传最新一份、上传前必须明示隐私政策、用户勾选同意
 *     才传；未同意一律不上传。接收端点见 CRASH-REPORT-SPEC.md
 *    （POST /api/lea/v1/crash-report，匿名接收＋强防护）：
 *     decideUpload 判定放行后由调用方 POST，2xx 才删本地报告，
 *     其它状态／超时一律保留本地文件、不重试、不伪装成功。
 * 报告头：版本号、Windows 版本、崩溃模块名、时间戳；正文为异常
 * 堆栈（已截断到上限）。报告只含技术信息，绝不含账号、密码、令牌、
 * cookie、聊天与屏幕内容。
 * 本模块只做纯文件/纯逻辑操作，可注入 fs/os 做单测；弹窗与
 * app 退出由 main.js 接线。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_CRASH_REPORT_SIZE = 150 * 1024; // OBS 同款：150KB
const SENTINEL_NAME = '.sentinel';
const CRASHES_DIR_NAME = 'crashes';
const MAX_KEPT_REPORTS = 10;
// 服务端接收端点（CRASH-REPORT-SPEC.md）：匿名接收＋强防护。
const CRASH_REPORT_PATH = '/api/lea/v1/crash-report';
// 服务端 stack 字段上限 128KB（本地文件上限 150KB，构造载荷时截断）。
const CRASH_STACK_MAX_BYTES = 128 * 1024;

function crashesDir(userDataDir) {
  return path.join(userDataDir, CRASHES_DIR_NAME);
}
function sentinelPath(userDataDir) {
  return path.join(userDataDir, SENTINEL_NAME);
}

function ensureDir(dir, f) {
  try { f.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; }
}

// 启动时立哨兵。返回 true=本次启动前哨兵已残留（上次非正常退出）。
function markStartup(userDataDir, deps) {
  const f = (deps && deps.fs) || fs;
  const sPath = sentinelPath(userDataDir);
  let existed = false;
  try { existed = f.existsSync(sPath); } catch (e) { existed = false; }
  ensureDir(userDataDir, f);
  try { f.writeFileSync(sPath, 'pid=' + process.pid + ' started=' + new Date().toISOString() + '\n'); } catch (e) { /* 哨兵写失败不拦启动 */ }
  return existed;
}

// 干净退出时拆哨兵（before-quit / will-quit 接线）。
function markCleanShutdown(userDataDir, deps) {
  const f = (deps && deps.fs) || fs;
  try { f.unlinkSync(sentinelPath(userDataDir)); return true; } catch (e) { return false; }
}

function hasSentinel(userDataDir, deps) {
  const f = (deps && deps.fs) || fs;
  try { return f.existsSync(sentinelPath(userDataDir)); } catch (e) { return false; }
}

// 报告头：版本号、Windows 版本、崩溃模块名、时间戳。
function buildReportHeader(info) {
  const i = info || {};
  const lines = [
    'QFRemote crash report',
    'version: ' + (i.version || 'unknown'),
    'platform: ' + (i.platform || process.platform) + ' ' + (i.osRelease || os.release()),
    'os: ' + (i.osVersion || (os.type() + ' ' + os.release())),
    'module: ' + (i.module || 'main'),
    'kind: ' + (i.kind || 'uncaughtException'),
    'time: ' + new Date().toISOString()
  ];
  return lines.join('\n') + '\n\n';
}

// S-092/N-03 堆栈脱敏（与服务端 lea-core.js scrubCrashStack 同口径，
// 客户端先洗一次、服务端落盘前再洗一次）：用户目录前缀掩码＋疑似
// 凭据形态掩码，只留相对路径与行号。
function scrubCrashStack(stack) {
  if (typeof stack !== 'string' || !stack) return stack;
  let s = stack;
  s = s.replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/:\n\r"']+/gi, '$1<redacted>');
  s = s.replace(/(\/(?:home|Users)\/)[^\/:\n\r"']+/g, '$1<redacted>');
  s = s.replace(/(\\\\[^\\:\n\r"']+\\Users\\)[^\\:\n\r"']+/gi, '$1<redacted>');
  s = s.replace(/((?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*['"]?)[^\s'";,}]+/gi, '$1<redacted>');
  return s;
}

// L-10 渲染进程崩溃记报告（供 main.js handleRenderProcessGone 接线：
// 只写本地报告文件，不上传、不弹窗；下次启动走同一哨兵＋同意流程上传。
// 接线点：main.js handleRenderProcessGone 内调一次即可，见 d06 E 节）。
function recordRendererCrash(userDataDir, details, deps) {
  const d = details || {};
  const bits = [
    'reason: ' + String(d.reason || 'unknown'),
    'exitCode: ' + String(d.exitCode === undefined || d.exitCode === null ? 'unknown' : d.exitCode),
  ];
  if (d.view) bits.push('view: ' + String(d.view));
  if (d.url) bits.push('url: ' + String(d.url).slice(0, 256));
  return writeCrashReport(userDataDir, {
    version: (d.version || undefined),
    kind: 'renderProcessGone',
    module: String(d.module || d.view || 'renderer'),
    stack: bits.join('\n'),
  }, deps);
}

// 写一份崩溃报告（截断到 150KB 上限）。返回 { ok, file, truncated, bytes }。
// 文件名含时间戳与 kind；只保留最近 MAX_KEPT_REPORTS 份，旧的删掉。
// L-11：写报告即补立哨兵——崩溃若发生在 whenReady 立哨兵之前（如启动
// 即崩溃），旧逻辑下次启动见不到哨兵、报告永不触发上传；此处写报告时
// 若哨兵缺失即补立，下次启动正常走残留哨兵＋同意上传流程。
function writeCrashReport(userDataDir, info, deps) {
  const f = (deps && deps.fs) || fs;
  const dir = crashesDir(userDataDir);
  ensureDir(dir, f);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const kind = String((info && info.kind) || 'crash').replace(/[^A-Za-z0-9_-]/g, '');
  const file = path.join(dir, 'crash-' + stamp + '-' + kind + '.log');
  const body = buildReportHeader(info) + String((info && info.stack) || (info && info.message) || 'no stack');
  let buf = Buffer.from(body, 'utf8');
  let truncated = false;
  if (buf.length > MAX_CRASH_REPORT_SIZE) {
    buf = buf.subarray(0, MAX_CRASH_REPORT_SIZE);
    truncated = true;
  }
  try {
    f.writeFileSync(file, buf);
  } catch (e) {
    return { ok: false, file: null, truncated, bytes: 0, error: String((e && e.message) || e) };
  }
  // L-11：报告落盘成功即补立哨兵（已存在不覆盖、不改时间戳语义）。
  try { if (!f.existsSync(sentinelPath(userDataDir))) f.writeFileSync(sentinelPath(userDataDir), 'pid=' + process.pid + ' crashed=' + new Date().toISOString() + '\n'); } catch (e) { /* 哨兵写失败不影响报告本身 */ }
  pruneOldReports(dir, f);
  return { ok: true, file, truncated, bytes: buf.length };
}

function pruneOldReports(dir, f) {
  try {
    const files = f.readdirSync(dir)
      .filter((n) => n.startsWith('crash-') && n.endsWith('.log'))
      .map((n) => ({ n, full: path.join(dir, n), mtime: 0 }))
      .sort((a, b) => (a.n < b.n ? -1 : 1));
    while (files.length > MAX_KEPT_REPORTS) {
      const oldest = files.shift();
      try { f.unlinkSync(oldest.full); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

// 列出本地崩溃报告（按时间升序）。返回 [{ file, name, size, mtimeMs }]。
function listCrashReports(userDataDir, deps) {
  const f = (deps && deps.fs) || fs;
  const dir = crashesDir(userDataDir);
  try {
    return f.readdirSync(dir)
      .filter((n) => n.startsWith('crash-') && n.endsWith('.log'))
      .map((n) => {
        const full = path.join(dir, n);
        let st = null;
        try { st = f.statSync(full); } catch (e) { st = null; }
        return { file: full, name: n, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch (e) { return []; }
}

function latestCrashReport(userDataDir, deps) {
  const list = listCrashReports(userDataDir, deps);
  return list.length ? list[list.length - 1] : null;
}

/*
 * 上传守门（OBS 口径：用户勾选同意才传，只传最新一份）。
 *   decideUpload({ consented, endpoint, latest }) ->
 *     { action: 'upload' | 'skip', reason }
 *   - consented !== true：skip/no-consent，绝不发请求；
 *   - 无 endpoint（服务端未提供接收端点）：skip/no-endpoint，绝不发请求；
 *   - 无最新报告：skip/no-report。
 * 真正的 POST 由调用方在 action==='upload' 时执行；本模块不直接发网，
 * 便于单测断言“未同意不上传”且不依赖网络。
 */
function decideUpload(opts) {
  const o = opts || {};
  if (o.consented !== true) return { action: 'skip', reason: 'no-consent' };
  if (!o.endpoint) return { action: 'skip', reason: 'no-endpoint' };
  if (!o.latest) return { action: 'skip', reason: 'no-report' };
  return { action: 'upload', reason: 'ok', file: o.latest.file };
}

// --safe-mode 启动参数判定（另有启动弹窗二选一，见 main.js 接线）。
function safeModeFromArgv(argv) {
  const a = argv || process.argv;
  return Array.isArray(a) && a.indexOf('--safe-mode') >= 0;
}

// 解析本地崩溃报告文本（buildReportHeader 的固定格式）。
// 返回 { version, platform, os, module, kind, time, stack }，格式不对返回 null。
function parseCrashReportText(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split('\n');
  if (lines[0] !== 'QFRemote crash report') return null;
  const head = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break;
    const m = /^([a-z_]+): (.*)$/.exec(line);
    if (!m) return null;
    head[m[1]] = m[2];
  }
  if (!head.version || !head.platform || !head.os || !head.module || !head.kind || !head.time) return null;
  if (Number.isNaN(Date.parse(head.time))) return null;
  return {
    version: head.version, platform: head.platform, os: head.os,
    module: head.module, kind: head.kind, time: head.time,
    stack: lines.slice(i + 1).join('\n'),
  };
}

// 由本地报告文本构造上传载荷（CRASH-REPORT-SPEC.md 的白名单字段）。
// report_id 每份随机 UUID（仅作幂等／去重，不是设备身份）；stack 超
// 128KB 时截断并标注。解析失败返回 null（调用方跳过上传、保留本地文件）。
function buildCrashUploadPayload(text, opts) {
  const parsed = parseCrashReportText(text);
  if (!parsed) return null;
  const o = opts || {};
  let stack = parsed.stack || '';
  // S-092：上传前脱敏（与服务端同口径；服务端落盘前再洗一次作纵深防御）。
  stack = scrubCrashStack(stack);
  if (Buffer.byteLength(stack, 'utf8') > CRASH_STACK_MAX_BYTES) {
    const marker = '\n[truncated to 128KB by client]';
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    stack = Buffer.from(stack, 'utf8').subarray(0, CRASH_STACK_MAX_BYTES - markerBytes).toString('utf8') + marker;
  }
  const uuid = (o.randomUUID && typeof o.randomUUID === 'function') ? o.randomUUID() : crypto.randomUUID();
  return {
    schema_version: 1,
    report_id: uuid,
    app_version: String(o.appVersion || parsed.version),
    platform: parsed.platform,
    os_version: parsed.os,
    arch: String(o.arch || process.arch),
    crash_time: parsed.time,
    exception_type: parsed.kind,
    module: parsed.module,
    exit_code: (o.exitCode === undefined || o.exitCode === null) ? null : o.exitCode,
    stack,
  };
}

module.exports = {
  MAX_CRASH_REPORT_SIZE,
  MAX_KEPT_REPORTS,
  CRASH_REPORT_PATH,
  CRASH_STACK_MAX_BYTES,
  crashesDir,
  sentinelPath,
  markStartup,
  markCleanShutdown,
  hasSentinel,
  buildReportHeader,
  writeCrashReport,
  listCrashReports,
  latestCrashReport,
  decideUpload,
  parseCrashReportText,
  buildCrashUploadPayload,
  scrubCrashStack,
  recordRendererCrash,
  safeModeFromArgv
};
