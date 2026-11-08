'use strict';
/*
 * QFRemote 本机 agent 自愈 · 客户端启动兜底（2.4.4）
 * ================================================================
 * 背景（2.4.3 真机验收失败，2026-11-09）：
 *   2.4.3 只在安装器装后段做自愈。站长笔记本上升 2.4.3 后仍离线，
 *   且 %TEMP% 里没有 qf-agent-heal.log——PS1 根本没被拉起执行，
 *   安装器预检悄悄跳过（.msh 不在预期路径、或误判已正确），
 *   runas 也没弹过 UAC。失败全程零留痕，事后无从查起。
 *
 * 本模块把自愈搬到 App 启动时（安装器之外第二道防线）：
 *   1. 启动后异步自检本机 .msh（只读，不拦启动）：地址过期、
 *      服务停着、或文件比正在跑的 agent 进程还新（文件被外力改过、
 *      服务没重启）时，提权拉起 qf-agent-heal.ps1（弹一次 UAC）。
 *   2. .msh 定位兜底：Program Files → Program Files (x86) →
 *      服务 ImagePath 指向的目录 → ProgramData，找不到不弹提示。
 *   3. 失败留痕：本地日志（与 PS1 同一份 %TEMP%\qf-agent-heal.log）
 *      ＋ 更新检查回带（下次取清单时 ?heal=<结果>，进 Caddy 访问日志，
 *      服务端可查）＋ 人话提示框（不含报错码）。
 *   4. 每天最多提权尝试 3 次（防反复弹 UAC）；成功或换版本后清零。
 *
 * 本文件刻意不依赖 Electron：纯逻辑可直接 node 单测；main.js 只负责
 * 在启动后调用 checkAgentState / runHealElevated 并接提示框与设置落盘。
 * 提权真路（UAC＋PS1＋服务重启）本机无 Windows/pwsh 跑不了，
 * 与 2.4.3 同口径留站长真机验收，测试只覆盖纯逻辑与命令拼装。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

const TARGET = 'wss://app.qfremote.top:8443/agent.ashx';
const SERVICE_NAME = 'Mesh Agent';
const HEAL_LOG_NAME = 'qf-agent-heal.log';
const HEAL_SCRIPT_NAME = 'qf-agent-heal.ps1';
const MAX_ATTEMPTS_PER_DAY = 3;
// 上报给服务端的取值（白名单，日志与清单回带只认这些；其余一律记 unknown）
const REPORTABLE = ['fixed', 'denied', 'service_restart_failed', 'unknown'];

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
function decideAction(o) {
  const msh = o.msh || {};
  const svc = o.service || {};
  if (!svc.exists) return 'none'; // 无 agent 服务：修文件也无意义，不弹提示
  if (!msh.found) return 'fix'; // 服务在、文件不在候选路径：让 PS1 按 ImagePath 找
  if (msh.meshServer !== TARGET) return 'fix';
  if (svc.status === 'STOPPED') return 'start-service';
  if (o.mshMtime && o.procStart && o.mshMtime > o.procStart) return 'restart-stale';
  return 'none';
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
function buildElevatedCommand(ps1Path) {
  const inner = "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','" +
    String(ps1Path).replace(/'/g, "''") + "' -Verb RunAs -WindowStyle Hidden";
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
function healOutcomeMessage(outcome) {
  if (outcome === 'denied') return '远程服务配置没修好：刚才的确认框点了否。下次打开软件时还会再问一次，点“是”就能修好。';
  if (outcome === 'service_restart_failed') return '本机远程服务配置改好了，但服务没重启起来，设备可能仍显示离线。重启一次电脑试试；如果还是离线，请联系客服。';
  if (outcome === 'unknown') return '本机远程服务配置没修好，设备可能仍显示离线。重启一次电脑试试；如果还是离线，请联系客服。';
  return null;
}

// 自愈助手脚本的运行时路径：打包后 resources/ 下的松散文件优先，
// 其次 __dirname（开发态）、最后 %TEMP%（安装器备的那份）。
function resolveHealScriptPath(o) {
  const cands = [];
  if (o.resourcesPath) cands.push(path.join(o.resourcesPath, HEAL_SCRIPT_NAME));
  if (o.dirname) cands.push(path.join(o.dirname, HEAL_SCRIPT_NAME));
  if (o.tempDir) cands.push(path.join(o.tempDir, HEAL_SCRIPT_NAME));
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

function healLogPath() {
  return path.join(os.tmpdir(), HEAL_LOG_NAME);
}

function appendHealLog(line) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(healLogPath(), ts + ' APP: ' + line + '\n');
  } catch (e) { /* ignore */ }
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
  // 4. 只有可能需要动手时，才查 agent 进程启动时间（mtime 对比用）
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
         "(Get-Process -Name MeshAgent -ErrorAction SilentlyContinue | Select-Object -First 1).StartTime.ToString('o')"], {});
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
//  - UAC 被拒：拉起器 stderr 含 canceled by the user → outcome 'denied'；
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
  const cmd = buildElevatedCommand(ps1Path);
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
    child.on('close', () => {
      if (/canceled by the user/i.test(errText)) {
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

module.exports = {
  TARGET,
  SERVICE_NAME,
  HEAL_LOG_NAME,
  HEAL_SCRIPT_NAME,
  MAX_ATTEMPTS_PER_DAY,
  REPORTABLE,
  stripBom,
  parseMsh,
  candidateMshPaths,
  resolveMshFromImagePath,
  parseScQuery,
  parseProcessStartTime,
  decideAction,
  shouldAttempt,
  buildElevatedCommand,
  parseHealLog,
  readHealLogText,
  isHealInProgress,
  healOutcomeMessage,
  resolveHealScriptPath,
  healLogPath,
  appendHealLog,
  checkAgentState,
  runHealElevated
};
