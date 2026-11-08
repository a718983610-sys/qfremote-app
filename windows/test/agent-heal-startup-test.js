'use strict';
/*
 * 客户端启动自愈兜底（2.4.4，windows/agent-heal.js）纯逻辑单测：
 *  A. parseMsh：过期／已正确／缺行／BOM／CRLF；
 *  B. candidateMshPaths：优先级 PF → PFx86 → ProgramData；
 *  C. resolveMshFromImagePath：带引号＋参数／无引号／无 .exe／空；
 *  D. parseScQuery：RUNNING／STOPPED／不存在；
 *  E. decideAction：无服务／缺文件／过期／停着／陈旧配置／无需修复；
 *  F. shouldAttempt：首尝／同日计数／满 3 次／隔天／换版本；
 *  G. buildElevatedCommand：Start-Process -Verb RunAs、单引号转义；
 *  H. parseHealLog：最后一条 RESULT 胜出、无则 null；
 *  I. isHealInProgress：120 秒内启动且无 RESULT＝进行中；
 *  J. healOutcomeMessage：失败有人话、成功／无需修复为 null；
 *  K. resolveHealScriptPath：resources 优先、找不到为 null。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 * 说明：提权真路（UAC＋PS1＋服务重启）本机无 Windows/pwsh 跑不了，
 * 与 2.4.3 同口径留站长真机验收；本文件只验纯逻辑与命令拼装。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr244/agent-heal-startup-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const heal = require('../agent-heal');
const TARGET = 'wss://app.qfremote.top:8443/agent.ashx';
const OLD = 'wss://54.248.9.192:8443/agent.ashx';

function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

try {
  // ---- A. parseMsh ----
  ok('A1-stale', heal.parseMsh('MeshServer=' + OLD + '\r\nServerID=x\r\n').meshServer === OLD);
  ok('A2-correct', heal.parseMsh('MeshServer=' + TARGET + '\r\nServerID=x\r\n').meshServer === TARGET);
  ok('A3-missing', heal.parseMsh('ServerID=x\r\nMeshName=y\r\n').meshServer === null);
  ok('A4-bom', heal.parseMsh('\uFEFFMeshServer=' + TARGET + '\r\n').meshServer === TARGET);
  ok('A5-lf', heal.parseMsh('MeshServer=' + OLD + '\nServerID=x\n').meshServer === OLD);
  ok('A6-empty', heal.parseMsh('').meshServer === null);

  // ---- B. candidateMshPaths ----
  const cands = heal.candidateMshPaths({
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData'
  });
  ok('B1-order', cands.length === 3 &&
    cands[0] === path.join('C:\\Program Files', 'Mesh Agent', 'MeshAgent.msh') &&
    cands[1] === path.join('C:\\Program Files (x86)', 'Mesh Agent', 'MeshAgent.msh') &&
    cands[2] === path.join('C:\\ProgramData', 'Mesh Agent', 'MeshAgent.msh'));
  ok('B2-missing-env-skipped', heal.candidateMshPaths({}).length === 0);

  // ---- C. resolveMshFromImagePath ----
  // 注：反斜杠路径的 path.join 只在 Windows 上有意义；Linux 侧用正斜杠
  // 验提取＋拼接逻辑，真机路径形态由 Wine 夹具（REPORT）与站长验收覆盖。
  ok('C1-quoted-with-args',
    heal.resolveMshFromImagePath('"C:/Program Files/Mesh Agent/MeshAgent.exe" -service') ===
    path.join('C:/Program Files/Mesh Agent', 'MeshAgent.msh'));
  ok('C2-unquoted',
    heal.resolveMshFromImagePath('C:/Agent/MeshAgent.exe') ===
    path.join('C:/Agent', 'MeshAgent.msh'));
  ok('C3-no-exe', heal.resolveMshFromImagePath('C:\\foo\\bar.txt') === null);
  ok('C4-empty', heal.resolveMshFromImagePath('') === null);
  ok('C5-null', heal.resolveMshFromImagePath(null) === null);

  // ---- D. parseScQuery ----
  const qRun = heal.parseScQuery('SERVICE_NAME: Mesh Agent\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  RUNNING\r\n');
  ok('D1-running', qRun.exists === true && qRun.status === 'RUNNING');
  const qStop = heal.parseScQuery('        STATE              : 1  STOPPED\r\n');
  ok('D2-stopped', qStop.exists === true && qStop.status === 'STOPPED');
  ok('D3-missing', heal.parseScQuery('').exists === false && heal.parseScQuery('').status === null);
  ok('D4-1060-text', heal.parseScQuery('[SC] OpenService FAILED 1060:\r\n').exists === false);

  // ---- E. decideAction ----
  const svcRun = { exists: true, status: 'RUNNING' };
  const svcStop = { exists: true, status: 'STOPPED' };
  const svcNo = { exists: false, status: null };
  const t0 = new Date(2026, 10, 9, 1, 0, 0);
  const t1 = new Date(2026, 10, 9, 1, 5, 0);
  ok('E1-no-service', heal.decideAction({ msh: { found: true, meshServer: OLD }, service: svcNo }) === 'none');
  ok('E2-missing-file', heal.decideAction({ msh: { found: false }, service: svcRun }) === 'fix');
  ok('E3-stale', heal.decideAction({ msh: { found: true, meshServer: OLD }, service: svcRun }) === 'fix');
  ok('E4-stopped', heal.decideAction({ msh: { found: true, meshServer: TARGET }, service: svcStop }) === 'start-service');
  ok('E5-restart-stale', heal.decideAction({ msh: { found: true, meshServer: TARGET }, service: svcRun, mshMtime: t1, procStart: t0 }) === 'restart-stale');
  ok('E6-none', heal.decideAction({ msh: { found: true, meshServer: TARGET }, service: svcRun, mshMtime: t0, procStart: t1 }) === 'none');
  ok('E7-none-no-procstart', heal.decideAction({ msh: { found: true, meshServer: TARGET }, service: svcRun }) === 'none');

  // ---- F. shouldAttempt ----
  const now = new Date(2026, 10, 9, 12, 0, 0);
  const todayISO = new Date(2026, 10, 9, 8, 0, 0).toISOString();
  const yesterdayISO = new Date(2026, 10, 8, 8, 0, 0).toISOString();
  ok('F1-first', heal.shouldAttempt({}, now, '2.4.4') === true);
  ok('F2-same-day-2', heal.shouldAttempt({ lastAttemptISO: todayISO, attemptsToday: 2, lastVersion: '2.4.4' }, now, '2.4.4') === true);
  ok('F3-same-day-3-blocked', heal.shouldAttempt({ lastAttemptISO: todayISO, attemptsToday: 3, lastVersion: '2.4.4' }, now, '2.4.4') === false);
  ok('F4-next-day', heal.shouldAttempt({ lastAttemptISO: yesterdayISO, attemptsToday: 3, lastVersion: '2.4.4' }, now, '2.4.4') === true);
  ok('F5-version-change', heal.shouldAttempt({ lastAttemptISO: todayISO, attemptsToday: 3, lastVersion: '2.4.3' }, now, '2.4.4') === true);
  ok('F6-bad-timestamp', heal.shouldAttempt({ lastAttemptISO: 'not-a-date', attemptsToday: 3 }, now, '2.4.4') === true);

  // ---- G. buildElevatedCommand ----
  const cmd = heal.buildElevatedCommand('C:\\Users\\Wayne\\AppData\\Local\\Temp\\qf-agent-heal.ps1');
  ok('G1-command', cmd.command === 'powershell.exe' && Array.isArray(cmd.args) &&
    cmd.args[0] === '-NoProfile' && cmd.args[2] === 'Bypass' && cmd.args[3] === '-Command');
  ok('G2-inner-runAs', cmd.args[4].includes('Start-Process') && cmd.args[4].includes('-Verb RunAs') &&
    cmd.args[4].includes('qf-agent-heal.ps1'));
  const cmdQ = heal.buildElevatedCommand("C:\\Temp\\a'b\\qf-agent-heal.ps1");
  ok('G3-quote-escaped', cmdQ.args[4].includes("a''b"));

  // ---- H. parseHealLog ----
  ok('H1-last-wins', heal.parseHealLog('2026-11-09 01:00:00 RESULT: fixed\n2026-11-09 01:05:00 RESULT: denied\n') === 'denied');
  ok('H2-none', heal.parseHealLog('2026-11-09 01:00:00 QFRemote agent heal start\n') === null);
  ok('H3-empty', heal.parseHealLog('') === null);
  ok('H4-paren', heal.parseHealLog('RESULT: no_agent (MeshAgent.msh not found)\n') === 'no_agent');

  // ---- I. isHealInProgress ----
  const start30 = fmtLocal(new Date(now.getTime() - 30000));
  const start300 = fmtLocal(new Date(now.getTime() - 300000));
  const startFuture30 = fmtLocal(new Date(now.getTime() + 30000));
  const startFuture300 = fmtLocal(new Date(now.getTime() + 300000));
  ok('I1-recent-start-no-result',
    heal.isHealInProgress(start30 + ' QFRemote agent heal start\n', now) === true);
  ok('I2-recent-start-with-result',
    heal.isHealInProgress(start30 + ' QFRemote agent heal start\n' + fmtLocal(now) + ' RESULT: fixed\n', now) === false);
  ok('I3-old-start',
    heal.isHealInProgress(start300 + ' QFRemote agent heal start\n', now) === false);
  ok('I4-no-start',
    heal.isHealInProgress(fmtLocal(now) + ' APP: startup check: action=fix\n', now) === false);
  ok('I5-unparseable-start',
    heal.isHealInProgress('not-a-timestamp QFRemote agent heal start\n', now) === false);
  ok('I6-future-start-small-skew',
    heal.isHealInProgress(startFuture30 + ' QFRemote agent heal start\n', now) === true);
  ok('I7-future-start-big-skew',
    heal.isHealInProgress(startFuture300 + ' QFRemote agent heal start\n', now) === false);
  ok('I8-old-then-recent',
    heal.isHealInProgress(start300 + ' QFRemote agent heal start\n' + fmtLocal(new Date(now.getTime() - 200000)) + ' RESULT: fixed\n' + start30 + ' QFRemote agent heal start\n', now) === true);
  ok('I9-empty-log', heal.isHealInProgress('', now) === false);

  // ---- J. healOutcomeMessage ----
  ok('J1-denied', (heal.healOutcomeMessage('denied') || '').includes('点了否'));
  ok('J2-restart-failed', (heal.healOutcomeMessage('service_restart_failed') || '').includes('重启一次电脑'));
  ok('J3-unknown', (heal.healOutcomeMessage('unknown') || '').includes('重启一次电脑'));
  ok('J4-fixed-null', heal.healOutcomeMessage('fixed') === null);
  ok('J5-already-correct-null', heal.healOutcomeMessage('already_correct') === null);
  ok('J6-no-code', (heal.healOutcomeMessage('denied') || '').indexOf('1223') === -1 &&
    (heal.healOutcomeMessage('unknown') || '').indexOf('1060') === -1);

  // ---- K. resolveHealScriptPath ----
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-heal-'));
  const ps1Path = path.join(tmpDir, 'qf-agent-heal.ps1');
  fs.writeFileSync(ps1Path, '# dummy\n');
  ok('K1-found', heal.resolveHealScriptPath({ resourcesPath: tmpDir, dirname: '', tempDir: '' }) === ps1Path);
  ok('K2-not-found', heal.resolveHealScriptPath({ resourcesPath: tmpDir + '-nope', dirname: '', tempDir: '' }) === null);
  ok('K3-read-log-is-string', typeof heal.readHealLogText() === 'string');

  // ---- L. 打包完整性（2.4.4 深查实证修复） ----
  // main.js 顶层 require('./agent-heal')，但 agent-heal.js 一度漏进
  // package.json build.files——asar 里缺它，App 启动即 MODULE_NOT_FOUND
  // 崩溃。本组断言 main.js 引用的全部本地模块都在 build.files 里。
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const buildFiles = (pkg.build && pkg.build.files) || [];
  const required = [...new Set([...mainSrc.matchAll(/require\('\.\/([A-Za-z0-9_-]+(?:\.js|\.json)?)'\)/g)].map((m) => m[1]))];
  const missing = required.filter((f) => !buildFiles.includes(f.endsWith('.js') || f.endsWith('.json') ? f : f + '.js'));
  ok('L1-agent-heal-packaged', buildFiles.includes('agent-heal.js'));
  ok('L2-all-main-requires-packaged', missing.length === 0, { required, missing });

  result.pass = Object.values(result.cases).every((c) => c.pass);
} catch (e) {
  result.error = String(e && e.stack || e);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
if (!result.pass) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log('agent-heal-startup-test: all ' + Object.keys(result.cases).length + ' cases pass');
