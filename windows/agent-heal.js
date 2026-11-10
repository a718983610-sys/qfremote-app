'use strict';
/*
 * QFRemote 本机 agent 自愈 · 客户端启动兜底（2.4.5）
 * ================================================================
 * 背景（2.4.3 真机验收失败，2026-11-09）：
 *   2.4.3 只在安装器装后段做自愈。站长笔记本上升 2.4.3 后仍离线，
 *   且 %TEMP% 里没有 qf-agent-heal.log——PS1 根本没被拉起执行，
 *   安装器预检悄悄跳过（.msh 不在预期路径、或误判已正确），
 *   runas 也没弹过 UAC。失败全程零留痕，事后无从查起。
 *
 * 2.4.5 重设计（任务书 D 项＋深查 W-04）：
 *   自愈判官只认服务端一个接口 GET /api/device/presence?nodeid=，
 *   出参 {ok, code, nodeid, name, online, fresh, lastAgentPong,
 *   lastAgentPongAgeMs, serverTime}，code 为 ONLINE/STALE/OFFLINE/
 *   NOT_FOUND/TIMEOUT/UNKNOWN。already_correct 只有 code:ONLINE 且
 *   fresh:true 才允许，否则报 unverified，绝不静默退出。
 *   阶梯：本地四查 → DNS → TCP(:8443) → TLS(8443) → 服务端确认，
 *   每级失败给分类码；每动一次修复回问服务端，最多 3 轮，轮轮写
 *   bootLog＋%TEMP%\qf-agent-heal.log。判官触发：年龄>180 秒且
 *   两次查询结果一致才认定离线/陈旧。
 *
 * 本文件刻意不依赖 Electron：纯逻辑可直接 node 单测；main.js 只负责
 * 在启动后调用 checkAgentState / runHealLadder 并接提示框与设置落盘。
 * 提权真路（UAC＋PS1＋服务重启）本机无 Windows/pwsh 跑不了，
 * 与 2.4.3 同口径留站长真机验收，测试只覆盖纯逻辑与命令拼装。
 * 2.4.5 新增 SYSTEM helper（QFSysHelper 服务，见 syshelper/）后，
 * 提权优先走 helper 命名管道（零 UAC），helper 不可用时回落 runas。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const net = require('net');
const tls = require('tls');
const childProcess = require('child_process');

const TARGET = 'wss://app.qfremote.top:8443/agent.ashx';
const SERVICE_NAME = 'Mesh Agent';
const HEAL_LOG_NAME = 'qf-agent-heal.log';
const HEAL_SCRIPT_NAME = 'qf-agent-heal.ps1';
const MAX_ATTEMPTS_PER_DAY = 3;
const PRESENCE_HOST = 'app.qfremote.top';
const PRESENCE_PORT = 8443;
// 上报给服务端的取值（白名单，日志与清单回带只认这些；其余一律记 unknown）。
// 2.4.5：扩到全部阶梯分类码（W-04/W-14），no_agent 也回带。
const REPORTABLE = [
  'fixed', 'already_correct', 'service_started', 'service_restarted',
  'restarted_stale_config', 'no_agent', 'denied', 'service_restart_failed',
  'unknown', 'unverified', 'msh_write_failed',
  'dns-fail', 'tcp-fail', 'tls-fail', 'server-unconfirmed',
  'service-pending', 'stale-config', 'msh-wrong-target',
  'service-stopped', 'service-missing', 'msh-missing'
];
// 本地四查＋阶梯的共享分类码表（三处防线共用：JS / PS1 Detect / 安装器）。
// PS1 与安装器须与本表逐字一致（见 agent-heal-test.js G 组静态断言）。
const HEAL_CODES = {
  LOCAL_OK: 'local-ok',
  SERVICE_MISSING: 'service-missing',
  SERVICE_STOPPED: 'service-stopped',
  SERVICE_PENDING: 'service-pending',
  MSH_MISSING: 'msh-missing',
  MSH_WRONG_TARGET: 'msh-wrong-target',
  STALE_CONFIG: 'stale-config',
  DNS_FAIL: 'dns-fail',
  TCP_FAIL: 'tcp-fail',
  TLS_FAIL: 'tls-fail',
  SERVER_UNCONFIRMED: 'server-unconfirmed',
  ONLINE: 'online',
  NOT_FOUND: 'not-found'
};
// 判官触发阈值（任务书定案）：fresh ≤120 秒、STALE 120–300 秒、
// OFFLINE >300 秒或 conn=0；自愈判官触发 180 秒＋两次查询一致。
const FRESH_MS = 120000;
const JUDGE_TRIGGER_MS = 180000;

// ---------- 纯逻辑（可直接单测） ----------

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// 从 .msh 文本解析 MeshServer 行；找不到返回 null（缺行＝需追加）。
function parseMsh(text) {
  const t = stripBom(String(text || ''));
  const m = t.match(/^MeshServer=(.*)$/m);
  if (!m) return { meshServer: null };
  return { meshServer: m[1].replace(/\r$/, '') };
}

// .msh 候选路径（按优先级；env 注入便于单测）。
function candidateMshPaths(env) {
  const e = env || process.env;
  const out = [];
  if (e.ProgramFiles) out.push(path.join(e.ProgramFiles, 'Mesh Agent', 'MeshAgent.msh'));
  if (e['ProgramFiles(x86)']) out.push(path.join(e['ProgramFiles(x86)'], 'Mesh Agent', 'MeshAgent.msh'));
  if (e.ProgramData) out.push(path.join(e.ProgramData, 'Mesh Agent', 'MeshAgent.msh'));
  return out;
}

// 从服务 ImagePath（如 "C:\Program Files\Mesh Agent\MeshAgent.exe" -args）
// 推出 .msh 路径；解析不出返回 null。
function resolveMshFromImagePath(imagePath) {
  if (!imagePath) return null;
  const m = String(imagePath).match(/^(.*?\.exe)/i);
  if (!m) return null;
  const exe = m[1].replace(/^"+|"+$/g, '').trim();
  if (!exe) return null;
  return path.join(path.dirname(exe), 'MeshAgent.msh');
}

// 解析 `sc query "Mesh Agent"` 输出：{ exists, status }。
// 服务不存在时 sc 以 1060 报错，调用方按错误码处理；此处只解析文本。
// 中文 Windows 上 STATE 行仍为英文（sc 输出不本地化状态名，真机待核实，见 W-06）。
function parseScQuery(text) {
  const t = String(text || '');
  const m = t.match(/STATE\s*:\s*\d+\s+(\S+)/i);
  return { exists: /STATE/i.test(t), status: m ? m[1].toUpperCase() : null };
}

// 解析 powershell 吐回的 ISO 时间；解析不出返回 null（该分支直接跳过）。
function parseProcessStartTime(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// 决策：本次启动是否需要拉起提权修复。
// msh: { found, meshServer }；service: { exists, status }；
// procStart/mshMtime: Date|null（取不到按 null＝该分支不触发）。
// W-06：START_PENDING/STOP_PENDING 不再当正常放行，判 service-pending。
function decideAction(o) {
  const msh = o.msh || {};
  const svc = o.service || {};
  if (!svc.exists) return 'none'; // 无 agent 服务：修文件也无意义，不弹提示
  if (svc.status === 'START_PENDING' || svc.status === 'STOP_PENDING') return 'service-pending';
  if (!msh.found) return 'fix'; // 服务在、文件不在候选路径：让 PS1 按 ImagePath 找
  if (msh.meshServer !== TARGET) return 'fix';
  if (svc.status === 'STOPPED') return 'start-service';
  if (o.mshMtime && o.procStart && o.mshMtime > o.procStart) return 'restart-stale';
  return 'none';
}

// 本地四查的共享分类码（JS / PS1 Detect / 安装器三处同一张表）：
// 由 decideAction 映射；'none' 且服务在、文件对 → local-ok。
// W-09② 判定优先级：服务缺失优先于文件缺失——两者同缺时返
// service-missing（PS1 Detect-Code 同顺序，见 qf-agent-heal.ps1）。
function localCode(state) {
  const s = state || {};
  const svc = s.service || {};
  const msh = s.msh || {};
  if (!svc.exists) return HEAL_CODES.SERVICE_MISSING;
  const a = decideAction(s);
  if (a === 'service-pending') return HEAL_CODES.SERVICE_PENDING;
  if (a === 'start-service') return HEAL_CODES.SERVICE_STOPPED;
  if (a === 'restart-stale') return HEAL_CODES.STALE_CONFIG;
  if (a === 'fix') return msh.found ? HEAL_CODES.MSH_WRONG_TARGET : HEAL_CODES.MSH_MISSING;
  return HEAL_CODES.LOCAL_OK;
}

// 服务端 presence 出参解析（唯一判官口径，见文件头）：
// 输入服务端 JSON（或 null），返回 { code, online, fresh, ageMs, verdict }，
// verdict ∈ online | stale | offline | not-found | unknown。
// already_correct 只有 verdict==='online' 才允许。
function parsePresenceResponse(json) {
  if (!json || typeof json !== 'object') return null;
  const code = typeof json.code === 'string' ? json.code.toUpperCase() : 'UNKNOWN';
  let ageMs = null;
  if (typeof json.lastAgentPongAgeMs === 'number') ageMs = json.lastAgentPongAgeMs;
  else if (typeof json.lastAgentPong === 'number' && typeof json.serverTime === 'number') {
    ageMs = json.serverTime - json.lastAgentPong;
  }
  const fresh = json.fresh === true && (ageMs === null || ageMs <= FRESH_MS);
  const online = json.online === true;
  let verdict = 'unknown';
  if (code === 'ONLINE' && fresh && online) verdict = 'online';
  else if (code === 'STALE') verdict = 'stale';
  else if (code === 'OFFLINE') verdict = 'offline';
  else if (code === 'NOT_FOUND') verdict = 'not-found';
  else verdict = 'unknown';
  return { code, online, fresh, ageMs, verdict };
}

// 判官触发判定：年龄超过 180 秒且两次查询 verdict 一致才认定。
// queries: 最近两次 parsePresenceResponse 的结果（数组，旧→新）。
function judgeTriggered(queries) {
  if (!Array.isArray(queries) || queries.length < 2) return false;
  const a = queries[queries.length - 2];
  const b = queries[queries.length - 1];
  if (!a || !b) return false;
  if (a.verdict === 'online' || b.verdict === 'online') return false;
  if (a.verdict !== b.verdict) return false;
  if (a.verdict === 'unknown' || a.verdict === 'not-found') return false;
  const age = (b.ageMs != null) ? b.ageMs : a.ageMs;
  return age != null && age > JUDGE_TRIGGER_MS;
}

// 当天提权尝试守门：state 来自设置落盘 { lastAttemptISO, attemptsToday,
// lastOutcome, lastVersion }；now 注入便于单测。
function shouldAttempt(state, now, version) {
  const s = state || {};
  const n = now instanceof Date ? now : new Date();
  if (!s.lastAttemptISO) return true;
  if (s.lastVersion && s.lastVersion !== version) return true; // 换版本给新机会
  const last = new Date(s.lastAttemptISO);
  if (isNaN(last.getTime())) return true;
  if (last.toDateString() !== n.toDateString()) return true; // 隔天重算
  return (s.attemptsToday || 0) < MAX_ATTEMPTS_PER_DAY;
}

// 提权拉起命令（纯拼装，可单测）：外层 powershell 不提权，
// 内层 Start-Process -Verb RunAs 弹一次 UAC 拉起 PS1。
function buildElevatedCommand(ps1Path, extraArgs) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    String(ps1Path).replace(/'/g, "''")];
  if (Array.isArray(extraArgs)) {
    for (const a of extraArgs) args.push(String(a).replace(/'/g, "''"));
  }
  const inner = "Start-Process -FilePath 'powershell.exe' -ArgumentList " +
    args.map((a) => "'" + a + "'").join(',') + " -Verb RunAs -WindowStyle Hidden";
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inner]
  };
}

// 从日志文本取最后一条 RESULT: 结果；无则返回 null。
function parseHealLog(text) {
  const lines = String(text || '').split(/\r?\n/);
  let last = null;
  for (const ln of lines) {
    const m = ln.match(/RESULT:\s*(\S+)/);
    if (m) last = m[1].trim();
  }
  return last;
}

// 读回自愈日志全文；读不到返回 ''（不抛错）。
function readHealLogText() {
  try { return fs.readFileSync(healLogPath(), 'utf8'); } catch (e) { return ''; }
}

// 进行中守卫（纯逻辑，可单测）：日志里最近一次 PS1 启动行
// （'QFRemote agent heal start'，带本地时间戳）在 120 秒内、
// 且其后尚无 RESULT 行 → 视为一次自愈正在进行中。
// 用途：安装器刚拉起 PS1、App 启动兜底别跟着再弹一次 UAC；
// 下次启动时 PS1 已写 RESULT，守卫自动放行。
// now 注入便于单测；无日志／无启动行／已出结果 → false。
// W-24：时间戳统一本地时间解析（JS 写日志也用本地时间，见 appendHealLog）。
function isHealInProgress(logText, now) {
  const n = now instanceof Date ? now : new Date();
  const lines = String(logText || '').split(/\r?\n/);
  let lastStartIdx = -1;
  let lastStartTime = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('QFRemote agent heal start') === -1) continue;
    const m = lines[i].match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    const d = m ? new Date(m[1]) : null;
    if (d && !isNaN(d.getTime())) { lastStartIdx = i; lastStartTime = d; }
  }
  if (lastStartIdx < 0 || !lastStartTime) return false;
  for (let i = lastStartIdx + 1; i < lines.length; i++) {
    if (/RESULT:\s*\S+/.test(lines[i])) return false;
  }
  const diff = n.getTime() - lastStartTime.getTime();
  return diff <= 120000 && diff >= -60000;
}

// 人话提示（失败才有文案；成功／无需修复返回 null＝不打扰）。
// W-13：unknown 不再让用户重启电脑背锅；unverified 给 server 端口径文案。
function healOutcomeMessage(outcome, code) {
  if (outcome === 'denied') return '远程服务配置没修好：刚才的确认框点了否。下次打开软件时还会再问一次，点“是”就能修好。';
  if (outcome === 'service_restart_failed') return '本机远程服务配置改好了，但服务没重启起来，设备可能仍显示离线。重启一次电脑试试；如果还是离线，请联系客服。';
  if (outcome === 'unknown') return '本机远程服务配置没修好，设备可能仍显示离线。下次打开软件时会再试一次；如果还是离线，请联系客服。';
  if (outcome === 'unverified') {
    // F2（深查发现）：unverified 有两个成因，文案须区分——DS-7 分支
    // （本地判服务缺失、服务端 presence 却在线）是“本机检测与服务端
    // 矛盾”，旧文案“服务器那边还没看到这台设备在线”与事实相反。
    if (code === 'service-missing') return '本机没检测到远程服务，但服务器那边显示这台设备在线，可能是本机检测有误。下次打开软件时会再确认；如果一直这样，请联系客服。';
    return '本机远程服务看着正常，但服务器那边还没看到这台设备在线。请确认网络正常、稍后再试；如果一直离线，请联系客服。';
  }
  if (outcome === 'msh_write_failed') return '本机远程服务配置文件写不进去（可能是只读或权限不足），设备可能仍显示离线。请检查后重试，或联系客服。';
  if (outcome === 'dns-fail') return '连不上服务器：域名解析失败，请检查本机网络或 DNS 后重试。';
  if (outcome === 'tcp-fail') return '连不上服务器：网络不通（8443 端口），请检查本机网络或防火墙后重试。';
  if (outcome === 'tls-fail') return '连不上服务器：安全连接失败，可能是证书或时间不对，请检查本机时间后重试。';
  return null;
}

// 自愈助手脚本的运行时路径：打包后 resources/ 下的松散文件优先，
// 其次 __dirname（开发态）、最后 %TEMP%（安装器备的那份）。
// F1：__dirname／resourcesPath 在打包形态下指向 app.asar 内，PowerShell
// 读不到 asar 路径；package.json 的 asarUnpack 把本脚本解到
// resources/app.asar.unpacked/（同相对路径），故每个候选先试解包变体，
// 再试原路径（开发态无解包目录，原样返回）。纯字符串变换＋existsSync
// 探针，与 main.js 的 unpackedAppPath 同款逻辑（两处各一份，防循环依赖）。
function unpackedAppPath(p) {
  if (typeof p !== 'string' || !p) return p;
  const parts = p.split(path.sep);
  const i = parts.indexOf('app.asar');
  if (i < 0) return p;
  parts[i] = 'app.asar.unpacked';
  return parts.join(path.sep);
}
function resolveHealScriptPath(o) {
  const cands = [];
  const push = (p) => {
    if (!p) return;
    const u = unpackedAppPath(p);
    if (u !== p) cands.push(u);
    cands.push(p);
  };
  if (o.resourcesPath) push(path.join(o.resourcesPath, HEAL_SCRIPT_NAME));
  if (o.dirname) push(path.join(o.dirname, HEAL_SCRIPT_NAME));
  if (o.tempDir) cands.push(path.join(o.tempDir, HEAL_SCRIPT_NAME));
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

function healLogPath() {
  return path.join(os.tmpdir(), HEAL_LOG_NAME);
}

// W-24：日志时间戳统一本地时间（此前 JS 用 toISOString 的 UTC，与 PS1
// 的本地时间差 8 小时）；行首来源标记 APP: 保留。
function formatLocalTs(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function appendHealLog(line) {
  try {
    const ts = formatLocalTs(new Date());
    fs.appendFileSync(healLogPath(), ts + ' APP: ' + line + '\n');
  } catch (e) { /* ignore */ }
}

// ---------- 连通性探测（DNS → TCP → TLS，可注入假依赖单测） ----------

function withTimeout(promise, ms, error) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(error || new Error('timeout')), ms); })
  ]).then((v) => { clearTimeout(timer); return v; },
    (e) => { clearTimeout(timer); throw e; });
}

function defaultLookup(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, (err, address) => (err ? reject(err) : resolve(address)));
  });
}

function defaultTcp(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    sock.once('connect', () => { try { sock.destroy(); } catch (e) { /* ignore */ } resolve(true); });
    sock.once('error', reject);
  });
}

function defaultTls(host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host });
    sock.once('secureConnect', () => {
      const ok = !!sock.authorized;
      const err = sock.authorizationError || null;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      if (ok) resolve({ authorized: true });
      else reject(new Error('CERT:' + (err && err.code ? err.code : 'NOT_AUTHORIZED')));
    });
    sock.once('error', reject);
  });
}

// 阶梯探测：DNS → TCP(:8443) → TLS(8443, SNI=app.qfremote.top)。
// 返回 { ok, stage: 'dns'|'tcp'|'tls'|'ok', code: null|'dns-fail'|
// 'tcp-fail'|'tls-fail', detail }。deps 可注入 { lookup, tcp, tls, timeoutMs }。
async function probeConnectivity(deps) {
  const d = deps || {};
  const timeoutMs = d.timeoutMs || 5000;
  const lookup = d.lookup || defaultLookup;
  const tcp = d.tcp || defaultTcp;
  const tlsFn = d.tls || defaultTls;
  try {
    await withTimeout(Promise.resolve().then(() => lookup(PRESENCE_HOST)), timeoutMs, new Error('dns-timeout'));
  } catch (e) {
    return { ok: false, stage: 'dns', code: HEAL_CODES.DNS_FAIL, detail: (e && e.code) || (e && e.message) || 'dns-fail' };
  }
  try {
    await withTimeout(Promise.resolve().then(() => tcp(PRESENCE_HOST, PRESENCE_PORT)), timeoutMs, new Error('tcp-timeout'));
  } catch (e) {
    return { ok: false, stage: 'tcp', code: HEAL_CODES.TCP_FAIL, detail: (e && e.code) || (e && e.message) || 'tcp-fail' };
  }
  try {
    await withTimeout(Promise.resolve().then(() => tlsFn(PRESENCE_HOST, PRESENCE_PORT)), timeoutMs, new Error('tls-timeout'));
  } catch (e) {
    return { ok: false, stage: 'tls', code: HEAL_CODES.TLS_FAIL, detail: (e && e.code) || (e && e.message) || 'tls-fail' };
  }
  return { ok: true, stage: 'ok', code: null, detail: 'ok' };
}

// ---------- 运行时助手（Electron 侧调用，可注入假依赖单测） ----------

function execFileAsync(file, args, opts) {
  return new Promise((resolve, reject) => {
    const spawnFn = (opts && opts.spawn) || childProcess.spawn;
    const child = spawnFn(file, args, { windowsHide: true });
    let out = '';
    let err = '';
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    if (child.stderr) child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

// 启动时自检：只读检查，返回 { action, msh, service, procStart, mshMtime }。
// 任何一步查不到都按「不触发该分支」处理，绝不抛错、不拦启动。
async function checkAgentState(deps) {
  const d = deps || {};
  const f = d.fs || fs;
  const env = d.env || process.env;
  const execFn = d.execFile || execFileAsync;
  const result = {
    action: 'none',
    msh: { found: false, path: null, meshServer: null },
    service: { exists: false, status: null },
    procStart: null,
    mshMtime: null
  };
  // 1. 候选路径逐个读
  let mshPath = null;
  let mshText = null;
  for (const p of candidateMshPaths(env)) {
    try {
      mshText = f.readFileSync(p, 'utf8');
      mshPath = p;
      break;
    } catch (e) { /* try next */ }
  }
  // 2. 候选路径都没找到：按服务 ImagePath 再找一次
  if (!mshPath) {
    try {
      const qc = await execFn('sc', ['qc', SERVICE_NAME], {});
      const img = (qc.stdout.match(/BINARY_PATH_NAME\s*:\s*(.+)/i) || [])[1];
      const alt = resolveMshFromImagePath(img ? img.trim() : null);
      if (alt) {
        try {
          mshText = f.readFileSync(alt, 'utf8');
          mshPath = alt;
        } catch (e) { /* not found */ }
      }
    } catch (e) { /* ignore */ }
  }
  if (mshPath) {
    const parsed = parseMsh(mshText);
    result.msh = { found: true, path: mshPath, meshServer: parsed.meshServer };
    try { result.mshMtime = f.statSync(mshPath).mtime; } catch (e) { /* ignore */ }
  }
  // 3. 服务状态（sc query；1060＝服务不存在）
  try {
    const q = await execFn('sc', ['query', SERVICE_NAME], {});
    result.service = parseScQuery(q.stdout || '');
    if (q.code === 1060 || /FAILED 1060/.test(q.stdout + q.stderr)) {
      result.service = { exists: false, status: null };
    }
  } catch (e) {
    result.service = { exists: false, status: null };
  }
  // 4. 只有可能需要动手时，才查 agent 进程启动时间（mtime 对比用）。
  // W-05：不再 Get-Process -First 1——改取服务 PID（Win32_Service.ProcessId）
  // 再按 PID 取启动时间；服务未运行（ProcessId 为 0/空）时该分支直接跳过。
  const prelim = decideAction({
    msh: result.msh,
    service: result.service,
    procStart: null,
    mshMtime: result.mshMtime
  });
  if (prelim === 'none' && result.msh.found && result.msh.meshServer === TARGET &&
      result.service.status === 'RUNNING') {
    try {
      const ps = await execFn('powershell.exe',
        ['-NoProfile', '-Command',
         "(Get-Process -Id (Get-CimInstance Win32_Service -Filter \"Name='Mesh Agent'\").ProcessId -ErrorAction SilentlyContinue).StartTime.ToString('o')"], {});
      result.procStart = parseProcessStartTime(ps.stdout || '');
    } catch (e) { /* ignore */ }
  }
  result.action = decideAction({
    msh: result.msh,
    service: result.service,
    procStart: result.procStart,
    mshMtime: result.mshMtime
  });
  return result;
}

// 提权拉起 PS1 并等结果：
//  - UAC 被拒：拉起器退出码 1223（ERROR_CANCELLED，最可靠）或 stderr 含
//    英文 'canceled by the user' 或中文「用户取消/操作被用户取消」
//    任一命中即 'denied'（W-13，中文系统实测原文待真机核实，1223 为主信号）；
//  - 拉起成功：轮询日志等 RESULT 行（最长 90 秒），超时记 'unknown'。
// 绝不抛错；返回 { outcome, denied }。
async function runHealElevated(ps1Path, opts) {
  const o = opts || {};
  const spawnFn = (o.spawn) || childProcess.spawn;
  const logPath = o.logPath || healLogPath();
  const pollMs = o.pollMs || 2000;
  const timeoutMs = o.timeoutMs || 90000;
  let logBefore = '';
  try { logBefore = fs.readFileSync(logPath, 'utf8'); } catch (e) { logBefore = ''; }
  const cmd = buildElevatedCommand(ps1Path, o.extraArgs);
  const outcome = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawnFn(cmd.command, cmd.args, { windowsHide: true });
    } catch (e) {
      finish({ outcome: 'unknown', denied: false });
      return;
    }
    let errText = '';
    if (child.stderr) child.stderr.on('data', (d) => { errText += d; });
    child.on('error', () => finish({ outcome: 'unknown', denied: false }));
    child.on('close', (code) => {
      if (code === 1223 || /canceled by the user/i.test(errText) ||
          /用户取消|操作被用户取消|操作已被用户取消/.test(errText)) {
        finish({ outcome: 'denied', denied: true });
        return;
      }
      // 拉起成功：轮询日志等 RESULT 行
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        let cur = '';
        try { cur = fs.readFileSync(logPath, 'utf8'); } catch (e) { cur = ''; }
        const tail = cur.length > logBefore.length ? cur.slice(logBefore.length) : cur;
        const r = parseHealLog(tail);
        if (r) {
          clearInterval(timer);
          finish({ outcome: r, denied: false });
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          finish({ outcome: 'unknown', denied: false });
        }
      }, pollMs);
    });
    setTimeout(() => finish({ outcome: 'unknown', denied: false }), timeoutMs + 30000);
  });
  return outcome;
}

// ---------- 自愈阶梯（W-04，deps 全可注入，单测不碰真网络/真提权） ----------
// deps: {
//   checkState: async () => checkAgentState() 结果,
//   probeConnectivity: async () => probeConnectivity() 结果,
//   queryPresence: async () => parsePresenceResponse() 结果或 null,
//   runRepair: async (code) => { outcome }（提权拉起 PS1 或走 SYSTEM helper），
//   log: (line) => void,
//   maxRounds: number（默认 3）
// }
// 返回 { outcome, code, rounds }；outcome ∈ REPORTABLE。
// already_correct 只有 presence verdict==='online' 才返回。
async function runHealLadder(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const maxRounds = d.maxRounds || 3;
  const checkState = d.checkState || checkAgentState;
  const probeFn = d.probeConnectivity || probeConnectivity;
  const queryPresence = d.queryPresence || (async () => null);
  const runRepair = d.runRepair || (async () => ({ outcome: 'unknown' }));
  let rounds = 0;

  let state = await checkState();
  let code = localCode(state);
  log('ladder local code=' + code + ' action=' + (state.action || ''));
  if (code === HEAL_CODES.SERVICE_MISSING) {
    // DS-7（低，L-C）：本地判服务缺失≠服务端判无 agent。先问一次服务端
    // presence：服务端仍 fresh/online 说明本机 nodeid 在线，本地检测
    // 口径（服务名/检测路径）可能有误，此时不下 no_agent 结论，改报
    // unverified（码仍带 service-missing，供日志与清单定位）；其余
    // verdict（stale/offline/not-found）与本地缺失一致、或问不到
    // （null/抛错）无法确认，仍按原口径报 no_agent。
    let presence = null;
    try { presence = await queryPresence(); } catch (e) { presence = null; }
    if (presence && presence.verdict === 'online') {
      log('ladder service-missing but presence online, hold no_agent');
      return { outcome: 'unverified', code, rounds };
    }
    return { outcome: 'no_agent', code, rounds };
  }
  // 本地需修：最多 3 轮，每轮修完重查本地
  while (code !== HEAL_CODES.LOCAL_OK && rounds < maxRounds) {
    rounds++;
    const r = await runRepair(code);
    log('ladder repair round ' + rounds + ' code=' + code + ' outcome=' + (r && r.outcome));
    if (r && r.outcome === 'denied') return { outcome: 'denied', code, rounds };
    if (r && r.skipped) return { outcome: 'unverified', code, rounds };
    state = await checkState();
    code = localCode(state);
    log('ladder local recheck code=' + code);
  }
  if (code !== HEAL_CODES.LOCAL_OK) {
    return { outcome: 'unverified', code, rounds };
  }
  // 连通性阶梯：DNS → TCP → TLS
  const conn = await probeFn();
  log('ladder connectivity stage=' + conn.stage + ' code=' + (conn.code || 'ok'));
  if (!conn.ok) {
    if (conn.code === HEAL_CODES.DNS_FAIL) {
      return { outcome: 'unverified', code: conn.code, rounds };
    }
    // TCP/TLS 失败：服务侧可能假死，重启一次服务再测一轮
    if (rounds < maxRounds) {
      rounds++;
      const r = await runRepair(conn.code);
      log('ladder repair round ' + rounds + ' code=' + conn.code + ' outcome=' + (r && r.outcome));
      if (r && r.outcome === 'denied') return { outcome: 'denied', code: conn.code, rounds };
      if (r && r.skipped) return { outcome: 'unverified', code: conn.code, rounds };
      const conn2 = await probeFn();
      log('ladder connectivity recheck stage=' + conn2.stage + ' code=' + (conn2.code || 'ok'));
      if (!conn2.ok) return { outcome: 'unverified', code: conn2.code, rounds };
    } else {
      return { outcome: 'unverified', code: conn.code, rounds };
    }
  }
  // 服务端确认：两次查询一致＋年龄>180 秒才认定离线/陈旧
  const queries = [];
  const p1 = await queryPresence();
  if (!p1 || p1.verdict === 'unknown') {
    return { outcome: 'unverified', code: HEAL_CODES.SERVER_UNCONFIRMED, rounds };
  }
  if (p1.verdict === 'online') {
    // 故障注入观察项①：本轮已执行过修复（rounds>0＝runRepair 被调用过，
    // 如 PS1 Repair 被拉起/服务被重启/.msh 被重写），即使 presence 首次
    // 查询即 ONLINE，也报 fixed 而非 already_correct——修过就是修过，
    // 否则服务端 ?heal= 日志会把「修过」记成「本来就对」。
    // 只有本轮未执行任何修复（rounds===0）且 presence 确认在线时，
    // 才报 already_correct。
    return { outcome: rounds > 0 ? 'fixed' : 'already_correct', code: HEAL_CODES.ONLINE, rounds };
  }
  if (p1.verdict === 'not-found') {
    return { outcome: 'unverified', code: HEAL_CODES.NOT_FOUND, rounds };
  }
  queries.push(p1);
  log('ladder presence verdict=' + p1.verdict + ' code=' + p1.code + ' ageMs=' + p1.ageMs);
  let lastCode = p1.code;
  // 补-中（M-C 中组，DS-REVIEW §3.4）：p1 单次 stale/offline 不得直接调
  // runRepair——文件头口径是“年龄>180s 且两次查询结果一致才认定离线/陈旧”，
  // 一次瞬时陈旧就重启 Mesh Agent 服务属于误判。先二次查询确认：
  // 回 online 按 online 处理；verdict 不一致／年龄未过 180s／无确认 →
  // unverified，不修。两次一致且 judgeTriggered 才进修复循环。
  const p1b = await queryPresence();
  if (!p1b || p1b.verdict === 'unknown') {
    return { outcome: 'unverified', code: HEAL_CODES.SERVER_UNCONFIRMED, rounds };
  }
  if (p1b.verdict === 'online') {
    return { outcome: rounds > 0 ? 'fixed' : 'already_correct', code: HEAL_CODES.ONLINE, rounds };
  }
  if (p1b.verdict === 'not-found') {
    return { outcome: 'unverified', code: HEAL_CODES.NOT_FOUND, rounds };
  }
  queries.push(p1b);
  log('ladder presence confirm verdict=' + p1b.verdict + ' code=' + p1b.code + ' ageMs=' + p1b.ageMs);
  lastCode = p1b.code;
  if (!judgeTriggered(queries)) {
    log('ladder judge not triggered, skip repair');
    return { outcome: 'unverified', code: lastCode, rounds };
  }
  while (rounds < maxRounds) {
    rounds++;
    const r = await runRepair('presence-' + p1.verdict);
    log('ladder repair round ' + rounds + ' presence=' + p1.verdict + ' outcome=' + (r && r.outcome));
    if (r && r.outcome === 'denied') return { outcome: 'denied', code: lastCode, rounds };
    if (r && r.skipped) return { outcome: 'unverified', code: lastCode, rounds };
    const p2 = await queryPresence();
    if (!p2 || p2.verdict === 'unknown') {
      return { outcome: 'unverified', code: HEAL_CODES.SERVER_UNCONFIRMED, rounds };
    }
    if (p2.verdict === 'online') return { outcome: 'fixed', code: HEAL_CODES.ONLINE, rounds };
    if (p2.verdict === 'not-found') {
      return { outcome: 'unverified', code: HEAL_CODES.NOT_FOUND, rounds };
    }
    queries.push(p2);
    log('ladder presence recheck verdict=' + p2.verdict + ' code=' + p2.code + ' ageMs=' + p2.ageMs);
    lastCode = p2.code;
    if (judgeTriggered(queries)) {
      return { outcome: 'unverified', code: lastCode, rounds };
    }
  }
  return { outcome: 'unverified', code: lastCode, rounds };
}

module.exports = {
  TARGET,
  SERVICE_NAME,
  HEAL_LOG_NAME,
  HEAL_SCRIPT_NAME,
  MAX_ATTEMPTS_PER_DAY,
  REPORTABLE,
  HEAL_CODES,
  FRESH_MS,
  JUDGE_TRIGGER_MS,
  stripBom,
  parseMsh,
  candidateMshPaths,
  resolveMshFromImagePath,
  parseScQuery,
  parseProcessStartTime,
  decideAction,
  localCode,
  parsePresenceResponse,
  judgeTriggered,
  shouldAttempt,
  buildElevatedCommand,
  parseHealLog,
  readHealLogText,
  isHealInProgress,
  healOutcomeMessage,
  unpackedAppPath,
  resolveHealScriptPath,
  healLogPath,
  formatLocalTs,
  appendHealLog,
  probeConnectivity,
  checkAgentState,
  runHealElevated,
  runHealLadder
};
