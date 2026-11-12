'use strict';
/*
 * 客户端启动自愈兜底（2.4.5，windows/agent-heal.js）纯逻辑单测：
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
 *  M. localCode：decideAction → 共享分类码表；
 *  N. parsePresenceResponse＋judgeTriggered：服务端判官（ONLINE/STALE/
 *     OFFLINE/NOT_FOUND/TIMEOUT/UNKNOWN，两次一致＋年龄>180 秒才触发）；
 *  O. formatLocalTs＋probeConnectivity：DNS→TCP→TLS 阶梯（注入 fake；
 *     另用本地 net.Server 做一次真实 TCP 正/反向）；
 *  P. runHealLadder：本地修→连通性→服务端确认全链（注入 fake）。
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

(async function main() {
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
  // W-06：中间态照原样返回，调用方 decideAction 判 service-pending。
  ok('D5-start-pending', heal.parseScQuery('        STATE              : 2  START_PENDING\r\n').status === 'START_PENDING');
  ok('D6-stop-pending', heal.parseScQuery('        STATE              : 3  STOP_PENDING\r\n').status === 'STOP_PENDING');

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
  // W-06：中间态不再当正常放行。
  ok('E8-pending', heal.decideAction({ msh: { found: true, meshServer: TARGET }, service: { exists: true, status: 'START_PENDING' } }) === 'service-pending');
  ok('E9-stop-pending', heal.decideAction({ msh: { found: true, meshServer: TARGET }, service: { exists: true, status: 'STOP_PENDING' } }) === 'service-pending');

  // ---- F. shouldAttempt ----
  const now = new Date(2026, 10, 9, 12, 0, 0);
  const todayISO = new Date(2026, 10, 9, 8, 0, 0).toISOString();
  const yesterdayISO = new Date(2026, 10, 8, 8, 0, 0).toISOString();
  ok('F1-first', heal.shouldAttempt({}, now, '2.4.5') === true);
  ok('F2-same-day-2', heal.shouldAttempt({ lastAttemptISO: todayISO, attemptsToday: 2, lastVersion: '2.4.5' }, now, '2.4.5') === true);
  ok('F3-same-day-3-blocked', heal.shouldAttempt({ lastAttemptISO: todayISO, attemptsToday: 3, lastVersion: '2.4.5' }, now, '2.4.5') === false);
  ok('F4-next-day', heal.shouldAttempt({ lastAttemptISO: yesterdayISO, attemptsToday: 3, lastVersion: '2.4.5' }, now, '2.4.5') === true);
  ok('F5-version-change', heal.shouldAttempt({ lastAttemptISO: todayISO, attemptsToday: 3, lastVersion: '2.4.4' }, now, '2.4.5') === true);
  ok('F6-bad-timestamp', heal.shouldAttempt({ lastAttemptISO: 'not-a-date', attemptsToday: 3 }, now, '2.4.5') === true);

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
  ok('J3-unknown', (heal.healOutcomeMessage('unknown') || '').includes('下次打开软件时会再试一次') &&
    (heal.healOutcomeMessage('unknown') || '').indexOf('重启一次电脑') === -1);
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

  // ---- L. 打包完整性（2.4.4 深查实证修复，2.4.5 续用） ----
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

  // ---- M. localCode（W-04/W-09 共享分类码表） ----
  const st = (msh, service, extra) => Object.assign({ msh, service }, extra || {});
  ok('M1-missing', heal.localCode(st({ found: true, meshServer: TARGET }, { exists: false, status: null })) === 'service-missing');
  ok('M2-pending', heal.localCode(st({ found: true, meshServer: TARGET }, { exists: true, status: 'START_PENDING' })) === 'service-pending');
  ok('M3-stopped', heal.localCode(st({ found: true, meshServer: TARGET }, { exists: true, status: 'STOPPED' })) === 'service-stopped');
  ok('M4-stale', heal.localCode(st({ found: true, meshServer: TARGET }, svcRun, { mshMtime: t1, procStart: t0 })) === 'stale-config');
  ok('M5-wrong-target', heal.localCode(st({ found: true, meshServer: OLD }, svcRun)) === 'msh-wrong-target');
  ok('M6-msh-missing', heal.localCode(st({ found: false }, svcRun)) === 'msh-missing');
  ok('M7-local-ok', heal.localCode(st({ found: true, meshServer: TARGET }, svcRun, { mshMtime: t0, procStart: t1 })) === 'local-ok');
  // W-09②/观察项②：服务与文件双缺失时，JS 与 PS1 均先判 service-missing
  //（PS1 Detect-Code 顺序见 agent-heal-test.js G11）。
  ok('M8-double-missing-service-first', heal.localCode(st({ found: false }, { exists: false, status: null })) === 'service-missing');

  // ---- N. parsePresenceResponse＋judgeTriggered（W-04 服务端判官） ----
  const pr = (j) => heal.parsePresenceResponse(j);
  ok('N1-online', pr({ code: 'ONLINE', fresh: true, online: true, lastAgentPongAgeMs: 1000 }).verdict === 'online');
  ok('N2-online-not-fresh', pr({ code: 'ONLINE', fresh: false, online: true, lastAgentPongAgeMs: 200000 }).verdict === 'unknown');
  ok('N3-online-not-online', pr({ code: 'ONLINE', fresh: true, online: false, lastAgentPongAgeMs: 1000 }).verdict === 'unknown');
  ok('N4-stale', pr({ code: 'STALE', fresh: false, online: false, lastAgentPongAgeMs: 200000 }).verdict === 'stale');
  ok('N5-offline', pr({ code: 'OFFLINE', fresh: false, online: false, lastAgentPongAgeMs: 400000 }).verdict === 'offline');
  ok('N6-not-found', pr({ code: 'NOT_FOUND', fresh: false, online: false }).verdict === 'not-found');
  ok('N7-timeout-unknown', pr({ code: 'TIMEOUT' }).verdict === 'unknown');
  ok('N8-null', pr(null) === null);
  ok('N9-empty', pr({}).verdict === 'unknown' && pr({}).code === 'UNKNOWN');
  ok('N10-age-from-timestamps', pr({ code: 'STALE', online: false, lastAgentPong: 1000000, serverTime: 1200000 }).ageMs === 200000);
  const qStaleOld = { verdict: 'stale', ageMs: 200000 };
  const qStaleYoung = { verdict: 'stale', ageMs: 100000 };
  const qOnline = { verdict: 'online', ageMs: 1000 };
  const qUnknown = { verdict: 'unknown', ageMs: 200000 };
  const qOffline = { verdict: 'offline', ageMs: 400000 };
  ok('N11-judge-triggered', heal.judgeTriggered([qStaleOld, qStaleOld]) === true);
  ok('N12-judge-young', heal.judgeTriggered([qStaleYoung, qStaleYoung]) === false);
  ok('N13-judge-online', heal.judgeTriggered([qOnline, qOnline]) === false);
  ok('N14-judge-mixed', heal.judgeTriggered([qStaleOld, qOffline]) === false);
  ok('N15-judge-unknown', heal.judgeTriggered([qUnknown, qUnknown]) === false);
  ok('N16-judge-single', heal.judgeTriggered([qStaleOld]) === false);

  // ---- O. formatLocalTs＋probeConnectivity ----
  ok('O1-format-local', heal.formatLocalTs(new Date(2026, 10, 9, 1, 2, 3)) === '2026-11-09 01:02:03');
  const net = require('net');
  const okLookup = async () => '93.184.216.34';
  const failLookup = async () => { const e = new Error('getaddrinfo ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; };
  ok('O2-dns-fail', (await heal.probeConnectivity({ lookup: failLookup })).code === 'dns-fail');
  // 真实 TCP 正/反向：本地 net.Server 做目标
  const srv = net.createServer((s) => s.end());
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const localPort = srv.address().port;
  const tcpReal = (host, port) => new Promise((res, rej) => {
    const s = net.connect(localPort, '127.0.0.1', () => { s.end(); res(true); });
    s.on('error', rej);
  });
  const tlsOk = async () => true;
  const probeOk = await heal.probeConnectivity({ lookup: okLookup, tcp: tcpReal, tls: tlsOk, timeoutMs: 3000 });
  ok('O3-tcp-real-ok', probeOk.ok === true && probeOk.stage === 'ok');
  await new Promise((res) => srv.close(res));
  const probeTcpFail = await heal.probeConnectivity({ lookup: okLookup, tcp: tcpReal, tls: tlsOk, timeoutMs: 3000 });
  ok('O4-tcp-real-refused', probeTcpFail.ok === false && probeTcpFail.code === 'tcp-fail');
  const tlsFail = async () => { throw new Error('cert fail'); };
  const probeTlsFail = await heal.probeConnectivity({ lookup: okLookup, tcp: async () => true, tls: tlsFail, timeoutMs: 3000 });
  ok('O5-tls-fail', probeTlsFail.ok === false && probeTlsFail.code === 'tls-fail');

  // ---- r11①：自签证书的 TLS 握手即算通 ----
  // :8443 是 MeshCentral 自签端点（CN=IP、无 app.qfremote.top SAN），
  // 默认 CA 校验恒败；阶梯只测“能不能说上 TLS”，证书信任只记 detail。
  const tlsSelfSigned = async () => ({ authorized: false, certError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  const probeTlsSelfSigned = await heal.probeConnectivity({ lookup: okLookup, tcp: async () => true, tls: tlsSelfSigned, timeoutMs: 3000 });
  ok('O6-tls-selfsigned-ok', probeTlsSelfSigned.ok === true && probeTlsSelfSigned.stage === 'ok' && (probeTlsSelfSigned.detail || '').includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
  // O7：defaultTls 对真自签服务器（CN=54.248.9.192，与东京机 :8443 同款
  // 证书形态）握手成功且记下证书码；旧行为（默认校验）在此直接 error。
  // 证书/私钥为测试专用现签对，与生产密钥无关。
  const SELF_SIGNED_CERT = '-----BEGIN CERTIFICATE-----\nMIIDMTCCAhmgAwIBAgIUICr204oOSSL62YI10RaLxZfhrBgwDQYJKoZIhvcNAQEL\nBQAwFzEVMBMGA1UEAwwMNTQuMjQ4LjkuMTkyMB4XDTI2MTExMjAwMDI0MloXDTI3\nMTExMjAwMDI0MlowFzEVMBMGA1UEAwwMNTQuMjQ4LjkuMTkyMIIBIjANBgkqhkiG\n9w0BAQEFAAOCAQ8AMIIBCgKCAQEApovAOAtdfW/i3L74PcXQ6/Dl6qTsNZ42+wka\n6mur/A9gWIX1lCMDMc4xUF1ZM1oSn0GVTvVLNQzr72a/LJkK+SVRDUYk8ZMPI0VL\nKlCos8xvC7+Q8SJpBSKmCb3CyGNFmmkBLGYYK4JmddHCtJjkhD0jzw+Vzsq53X39\n3JFW2eHiB2FSBT5f7Fpr+fNXR1O4fOxNIPYrHRJls4UqIh/yk03GBD+bCYHbqy3R\nYbOYuDnJHbNITXjYLApMwcPu8InR6E7bOfQqUs1ly38Q+xrgfbVijUrJG9qHkxuk\nCJRb+ywfxFkS2RIAmWG/h3ZkjtRhAxCkf9H0GGS/AnvNcTOswQIDAQABo3UwczAd\nBgNVHQ4EFgQUWStesBaoquyb0IBgJflTwbjAogMwHwYDVR0jBBgwFoAUWStesBao\nquyb0IBgJflTwbjAogMwDwYDVR0TAQH/BAUwAwEB/zAgBgNVHREEGTAXhwQ2+AnA\ngglsb2NhbGhvc3SHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAEF7shvyiuCE2giU\nBKJnhd6h3L98TRzT7TU0kqwJda8xpKOmBCmtudKREG/qX9rY/+iwb3Pr/55JK6By\nM/gFz/1GEJVouMbBk+p+YsnoyLQEwMz3SNuN2sahbHjoGhNg3yW304ob2oZ+Te2j\naFtmm3Y4/NmAO4tD9Dx46bu/xI5g4HssHkeLMWqUdh3upNHU8UI0LQFyJw8PpcZE\n3zSgV1bnlydM/UNW42oYqh+vIe2V781LQAXa5cbStkABmFPwB/kpSgI1NkGPUxio\nv0DHCAG71VpwlyT7tuSZTQbk2TDwKIGQojiuIirSexqOKryxQ0kP3lf97trluy7I\nQjr2ii4=\n-----END CERTIFICATE-----\n';
  const SELF_SIGNED_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCmi8A4C119b+Lc\nvvg9xdDr8OXqpOw1njb7CRrqa6v8D2BYhfWUIwMxzjFQXVkzWhKfQZVO9Us1DOvv\nZr8smQr5JVENRiTxkw8jRUsqUKizzG8Lv5DxImkFIqYJvcLIY0WaaQEsZhgrgmZ1\n0cK0mOSEPSPPD5XOyrndff3ckVbZ4eIHYVIFPl/sWmv581dHU7h87E0g9isdEmWz\nhSoiH/KTTcYEP5sJgdurLdFhs5i4Ockds0hNeNgsCkzBw+7widHoTts59CpSzWXL\nfxD7GuB9tWKNSskb2oeTG6QIlFv7LB/EWRLZEgCZYb+HdmSO1GEDEKR/0fQYZL8C\ne81xM6zBAgMBAAECggEASi95DV3epJfYpXy5Zga+E8MIHxeckhuqIPNC1oXko5AT\n2gq9w+E+tIpExCf4qlumbOMRR40TFYvucoLBiHOZhDZfnrqOjT704MCmhTBNnV1k\nX4bS4N5zilKPREqPP6ScpfW9DJJjlMnuqu+nO7vZGqCDWWH3WJhL54IOORhSaBWy\nSKfWzAnupDvUK2nSgoBUTIC4LXrhy5ZPneD2njprI4n80Sxqa34pdEudG+5bqkJt\ntowrkVJeD+uDDtUj8wqyrHE2a3BgLaoEcMrOu2ZRgJH9UwNKU0xuLTeHw26rXw6v\nUKfygtZn4Icb+/2935g8sKFsUBPDqIVgqF4yLKJBiwKBgQDbQSFtREW+5urZMSCE\nsO4frszt30FBsCL+DxgFA4ziDxOR9FWfkUbud9zC1tjAVcxNGagLMhYflNGtyQgw\n/eVluZyO2p2G+8hxugHqyDMbj8hsfMOgRKV+TFvUsHTftNbC0wAgYRIYsklCy11u\nrg4ArpgXNajT2kCRsyCcpub96wKBgQDCdTgvikQNhNVMiiYcRPLEn3FodDje9+Ou\ny5tyhCm5OxyQa3kWw9/E9UpNA9nByyV3V4ik5sCdo9A3pdbPgcQWQARZpv2LZ0+m\nZ20zrzBar1xPruSjW1ik/i0taMWxciPvgti8xpds9yXq3TRM2GmPCE2yS+RVH7uy\ndAkQpKhZAwKBgQCKrYti/UfQE2Z/sZ8Lzo0O5RUhb5Bq5+l6IDnlEfXOFhMewhhW\nMSFYO+AaLKI0JRBvw8aSLj/oAc0NypWvxyeNS/VGNehlNGP36trDkZUh3bO7Sr7B\nZCn41HtQ77s8s7kSyTrPQBaeIEZORSr3koewzr3MEFiUhvtILLB35Ok9uQKBgBB+\njuiBaupWpR0b7sWhF5KUD7OTgCtxjW+LN8FL8poSqIabhybmMHntcIL925+zkpb/\n5shOBnKYrZW6zHDHihF1FqlgH8uOVNRBm6KxroFStJrRs/UjT26XXM+oPnShwOiV\nCbthgQCuKho07zXBeZq3UpfYFiMeUPZ/HzG5NcpvAoGBAKgglPjKmnFPwtq2OTQh\nFLPP+Z994UBUzYL8zMjLFkhSCfjNOw9cSwnoEX2BEnesPVqVrheByl31m7f9jLEa\n3ASBbhOQmpl2XNxnhiiJzylW+QCrCbuPqaRJILLmZpChbA/AjY2ZdNiOThafyP/l\nrTj3my2+7BlfhSit7vLVFX7/\n-----END PRIVATE KEY-----\n';
  const tlsSrv = require('tls').createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (so) => so.end());
  await new Promise((res) => tlsSrv.listen(0, '127.0.0.1', res));
  const tlsPort = tlsSrv.address().port;
  const tlsReal = await heal.defaultTls('127.0.0.1', tlsPort);
  ok('O7-defaultTls-selfsigned', tlsReal && tlsReal.authorized === false && typeof tlsReal.certError === 'string' && tlsReal.certError.length > 0, { certError: tlsReal && tlsReal.certError });
  await new Promise((res) => tlsSrv.close(res));

  // ---- P. runHealLadder（注入 fake） ----
  const okState = { msh: { found: true, meshServer: TARGET }, service: { exists: true, status: 'RUNNING' }, action: 'none' };
  const staleState = { msh: { found: true, meshServer: TARGET }, service: { exists: true, status: 'RUNNING' }, action: 'restart-stale', mshMtime: t1, procStart: t0 };
  const probePass = async () => ({ ok: true, stage: 'ok', code: null, detail: 'ok' });
  const fixRepair = async () => ({ outcome: 'fixed' });
  const logNoop = () => {};
  const onlinePresence = async () => heal.parsePresenceResponse({ code: 'ONLINE', fresh: true, online: true, lastAgentPongAgeMs: 1000 });
  const rP1 = await heal.runHealLadder({ checkState: async () => okState, probeConnectivity: probePass, queryPresence: onlinePresence, runRepair: fixRepair, log: logNoop });
  ok('P1-already-correct', rP1.outcome === 'already_correct' && rP1.rounds === 0);
  // 补-中（M-C 中组）：p1 单次 stale 不得直接修——须二次查询一致＋年龄>180s
  // 才认定。stale 一次、二次查询回 online＝瞬时陈旧，不修，报 already_correct。
  let pCalls = 0;
  let p2Repairs = 0;
  const staleThenOnline = async () => {
    pCalls++;
    return pCalls === 1
      ? heal.parsePresenceResponse({ code: 'STALE', fresh: false, online: false, lastAgentPongAgeMs: 200000 })
      : heal.parsePresenceResponse({ code: 'ONLINE', fresh: true, online: true, lastAgentPongAgeMs: 1000 });
  };
  const countingRepair = async () => { p2Repairs++; return { outcome: 'fixed' }; };
  const rP2 = await heal.runHealLadder({ checkState: async () => okState, probeConnectivity: probePass, queryPresence: staleThenOnline, runRepair: countingRepair, log: logNoop });
  ok('P2-stale-once-online-no-repair', rP2.outcome === 'already_correct' && rP2.rounds === 0 && p2Repairs === 0 && pCalls === 2);
  // 两次一致 stale（年龄 200s>180s）→ 修一次 → presence online → fixed
  let p2bCalls = 0;
  const staleTwiceThenOnline = async () => {
    p2bCalls++;
    return p2bCalls <= 2
      ? heal.parsePresenceResponse({ code: 'STALE', fresh: false, online: false, lastAgentPongAgeMs: 200000 })
      : heal.parsePresenceResponse({ code: 'ONLINE', fresh: true, online: true, lastAgentPongAgeMs: 1000 });
  };
  let p2bRepairs = 0;
  const rP2b = await heal.runHealLadder({ checkState: async () => okState, probeConnectivity: probePass, queryPresence: staleTwiceThenOnline, runRepair: async () => { p2bRepairs++; return { outcome: 'fixed' }; }, log: logNoop });
  ok('P2b-stale-twice-fixed', rP2b.outcome === 'fixed' && rP2b.rounds === 1 && p2bRepairs === 1);
  // 两次 stale 但年龄 100s 未过 180s → 不认定，不修
  let p2cRepairs = 0;
  const youngStale = async () => heal.parsePresenceResponse({ code: 'STALE', fresh: false, online: false, lastAgentPongAgeMs: 100000 });
  const rP2c = await heal.runHealLadder({ checkState: async () => okState, probeConnectivity: probePass, queryPresence: youngStale, runRepair: async () => { p2cRepairs++; return { outcome: 'fixed' }; }, log: logNoop });
  ok('P2c-stale-young-no-repair', rP2c.outcome === 'unverified' && rP2c.rounds === 0 && p2cRepairs === 0);
  // 补-中（复审 round 1）：judgeTriggered 取较新一次查询的年龄——p1 年龄
  // 200s、p1b 年龄 100s（二次查询已新鲜）→ 不认定，不修。
  let p2dCalls = 0;
  let p2dRepairs = 0;
  const staleOldThenYoung = async () => {
    p2dCalls++;
    return heal.parsePresenceResponse({ code: 'STALE', fresh: false, online: false, lastAgentPongAgeMs: p2dCalls === 1 ? 200000 : 100000 });
  };
  const rP2d = await heal.runHealLadder({ checkState: async () => okState, probeConnectivity: probePass, queryPresence: staleOldThenYoung, runRepair: async () => { p2dRepairs++; return { outcome: 'fixed' }; }, log: logNoop });
  ok('P2d-judge-uses-latest-age', rP2d.outcome === 'unverified' && rP2d.rounds === 0 && p2dRepairs === 0);
  // 本地一直 stale：3 轮耗尽 → unverified
  const rP3 = await heal.runHealLadder({ checkState: async () => staleState, probeConnectivity: probePass, queryPresence: onlinePresence, runRepair: fixRepair, log: logNoop });
  ok('P3-exhausted', rP3.outcome === 'unverified' && rP3.rounds === 3);
  // DNS 失败：直接 unverified，不修
  let repairCalls = 0;
  const rP4 = await heal.runHealLadder({ checkState: async () => okState, probeConnectivity: async () => ({ ok: false, stage: 'dns', code: 'dns-fail' }), queryPresence: onlinePresence, runRepair: async () => { repairCalls++; return { outcome: 'fixed' }; }, log: logNoop });
  ok('P4-dns-unverified', rP4.outcome === 'unverified' && rP4.code === 'dns-fail' && repairCalls === 0);
  // 用户点了否：立即 denied
  const rP5 = await heal.runHealLadder({ checkState: async () => staleState, probeConnectivity: probePass, queryPresence: onlinePresence, runRepair: async () => ({ outcome: 'denied' }), log: logNoop });
  ok('P5-denied', rP5.outcome === 'denied');
  // 每日封顶（skipped）：立即停，不空转
  const rP6 = await heal.runHealLadder({ checkState: async () => staleState, probeConnectivity: probePass, queryPresence: onlinePresence, runRepair: async () => ({ skipped: true }), log: logNoop });
  ok('P6-skipped', rP6.outcome === 'unverified' && rP6.rounds === 1);
  // 服务端无确认：unknown → server-unconfirmed
  const rP7 = await heal.runHealLadder({ checkState: async () => okState, probeConnectivity: probePass, queryPresence: async () => null, runRepair: fixRepair, log: logNoop });
  ok('P7-server-unconfirmed', rP7.outcome === 'unverified' && rP7.code === 'server-unconfirmed');
  // 故障注入观察项①：本地修过一轮（stale→修→local-ok），随后 presence
  // 首次查询即 ONLINE，应报 fixed 而非 already_correct；未修过（P1，
  // rounds===0）仍报 already_correct。修过就是修过。
  let p8Calls = 0;
  const rP8 = await heal.runHealLadder({
    checkState: async () => { p8Calls++; return p8Calls === 1 ? staleState : okState; },
    probeConnectivity: probePass, queryPresence: onlinePresence, runRepair: fixRepair, log: logNoop });
  ok('P8-repaired-then-online-is-fixed', rP8.outcome === 'fixed' && rP8.rounds === 1);
  // ---- DS-7（低，L-C）：SERVICE_MISSING 须先问服务端 presence——
  // 服务端仍 online 时不下 no_agent，改报 unverified；其余 verdict
  // 仍按原口径报 no_agent。生产接线（main.js runStartupAgentHeal）
  // 确有 queryPresence（queryOwnPresence），此分支在真路可达。
  const missingState = { msh: { found: false, meshServer: null }, service: { exists: false, status: null }, action: 'none' };
  let ds7Calls = 0;
  const rP9 = await heal.runHealLadder({ checkState: async () => missingState, probeConnectivity: probePass, queryPresence: async () => { ds7Calls++; return onlinePresence(); }, runRepair: fixRepair, log: logNoop });
  ok('P9-service-missing-online-unverified', rP9.outcome === 'unverified' && rP9.code === 'service-missing' && rP9.rounds === 0 && ds7Calls === 1);
  let ds7bCalls = 0;
  const rP9b = await heal.runHealLadder({ checkState: async () => missingState, probeConnectivity: probePass, queryPresence: async () => { ds7bCalls++; return heal.parsePresenceResponse({ code: 'OFFLINE', fresh: false, online: false, lastAgentPongAgeMs: 400000 }); }, runRepair: fixRepair, log: logNoop });
  ok('P9b-service-missing-offline-no-agent', rP9b.outcome === 'no_agent' && rP9b.code === 'service-missing' && ds7bCalls === 1);
  const rP9c = await heal.runHealLadder({ checkState: async () => missingState, probeConnectivity: probePass, queryPresence: async () => null, runRepair: fixRepair, log: logNoop });
  ok('P9c-service-missing-presence-null-no-agent', rP9c.outcome === 'no_agent' && rP9c.code === 'service-missing');
  const rP9d = await heal.runHealLadder({ checkState: async () => missingState, probeConnectivity: probePass, queryPresence: async () => { throw new Error('presence boom'); }, runRepair: fixRepair, log: logNoop });
  ok('P9d-service-missing-presence-throw-no-agent', rP9d.outcome === 'no_agent' && rP9d.code === 'service-missing');
  // r11①：TLS 段带自签证书 detail（握手通、证书不受信任）时阶梯照常
  // 走到 presence 确认——在线即 already_correct、0 轮修复，不再因
  // tls-fail 白白重启服务、不再弹误报弹窗。
  let p10Repairs = 0;
  const probeTlsUntrusted = async () => ({ ok: true, stage: 'ok', code: null, detail: 'tls-ok-cert-untrusted:UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  const rP10 = await heal.runHealLadder({ checkState: async () => okState, probeConnectivity: probeTlsUntrusted, queryPresence: onlinePresence, runRepair: async () => { p10Repairs++; return { outcome: 'fixed' }; }, log: logNoop });
  ok('P10-tls-untrusted-online-already-correct', rP10.outcome === 'already_correct' && rP10.rounds === 0 && p10Repairs === 0);

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
})().catch((e) => {
  result.error = String(e && e.stack || e);
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  } catch (ignored) { /* ignore */ }
  console.error(result.error);
  process.exit(1);
});
