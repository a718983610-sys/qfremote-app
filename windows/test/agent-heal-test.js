'use strict';
/*
 * 本机 agent 自愈（2.4.3/2.4.4）本地自检：
 *  A. installer.nsi 静态断言：预检函数在位、装后段接线、runas 提权只走
 *     助手脚本、安装器本体仍为 user 级（不动既有安装/静默更新口径）、
 *     预检函数内无 Abort（fail-soft）、目录页与 InstallDirRegKey 未动；
 *  B. qf-agent-heal.ps1 静态断言：目标地址、.qfbak 备份守卫、只改
 *     MeshServer 行、重启 Mesh Agent 服务、fail-soft（静默继续＋
 *     try/catch＋恒 exit 0）、不含旧 IP；
 *  C. 改写算法等价夹具（与 PS1 同款正则/规则的 JS 实现）：过期行只换
 *     该行、其余行逐字保留、已正确不改动、缺行追加、换行格式保留；
 *  D. 目标地址双文件一致（NSIS 预检与 PS1 逐字同值）。
 *  E. 2.4.4 安装器加固断言：.msh 定位兜底（PFx86＋ImagePath）、
 *     runas 失败换方式重试、修复后复读验证、失败留痕（安装器日志，
 *     2.4.5 W-09①起统一追加进 %TEMP%\qf-agent-heal.log，模式 "a"＋
 *     FileSeek 0 END 显式定位到尾，绝不用 "w" 截断）、服务状态查法
 *     （StrStr 以返回串判、不用 IfErrors）、跳过本身留痕；
 *  F. 2.4.4 PS1 v2 断言：启动行（供 App 进行中守卫识别）、RESULT 全集、
 *     已正确仍管服务、服务重启重试、定位兜底、陈旧配置检测。
 *  G. 2.4.5 断言：安装器 Detect 委托、锁 Section、版本 2.4.5、IfErrors
 *     紧跟解压、卸载提示、PS1 Mode/Detect/pending/写校验、三处分类码
 *     表一致（JS HEAL_CODES／PS1 Detect-Code／NSI Detect 分支）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 * 说明：PS1 本体只能在 Windows 提权环境真跑，本机无 pwsh；C 组验的是
 * 与 PS1 同款规则的改写逻辑，真机提权重写留发布日站长真机验收。
 * 安装器加固的真路（Wine 夹具 .msh 四场景）见 REPORT，不在本文件。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr243/agent-heal-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const NSI = fs.readFileSync(path.join(__dirname, '..', 'installer.nsi'), 'utf8');
const PS1 = fs.readFileSync(path.join(__dirname, '..', 'qf-agent-heal.ps1'), 'utf8');
const TARGET = 'wss://app.qfremote.top:8443/agent.ashx';
const OLD_IP = '54.248.9.192';

function segment(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) return '';
  const b = src.indexOf(endMarker, a + startMarker.length);
  return b < 0 ? src.slice(a) : src.slice(a, b);
}

try {
  // ---- A. installer.nsi ----
  ok('A1-heal-function-present', NSI.includes('Function QFHealAgentMsh'));
  const secMain = segment(NSI, 'Section "QFRemote" SEC_MAIN', 'SectionEnd');
  ok('A2-heal-called-in-section', secMain.includes('Call QFHealAgentMsh'));
  ok('A3-helper-staged-in-section',
    secMain.includes('File "/oname=$TEMP\\qf-agent-heal.ps1" "qf-agent-heal.ps1"'));
  ok('A4-call-after-registry-writes',
    secMain.indexOf('Call QFHealAgentMsh') > secMain.indexOf('WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QFRemote" "InstallLocation"'));
  ok('A5-runas-only-for-helper',
    (NSI.match(/ExecShell "runas"/g) || []).length === 1 &&
    NSI.includes('ExecShell "runas" "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File \'$TEMP\\qf-agent-heal.ps1\'"'));
  ok('A6-installer-stays-user-level',
    NSI.includes('RequestExecutionLevel user') && !NSI.includes('RequestExecutionLevel admin'));
  const healFn = segment(NSI, 'Function QFHealAgentMsh', 'FunctionEnd');
  ok('A7-heal-function-no-abort', !/Abort/.test(healFn));
  ok('A8-heal-delegates-to-ps1-detect',
    healFn.includes("-Mode Detect") &&
    healFn.includes('nsExec::ExecToStack') &&
    !healFn.includes('sc query "Mesh Agent"'));
  ok('A9-no-target-hardcoded-in-nsi',
    !healFn.includes('MeshServer=wss://') && PS1.includes(TARGET));
  ok('A10-directory-page-and-regkey-intact',
    NSI.includes('MUI_PAGE_DIRECTORY') && NSI.includes('InstallDirRegKey HKCU'));
  ok('A11-heal-skips-when-correct',
    healFn.includes('alreadyCorrect:') &&
    healFn.includes('INSTALLER: skip already correct and running'));
  ok('A12-heal-skips-when-no-agent',
    healFn.includes('noAgent:') && healFn.includes('noMsh:') &&
    healFn.includes('INSTALLER: skip, no Mesh Agent service') &&
    healFn.includes('INSTALLER: skip, no agent msh found'));
  // 2.4.5：行尾剥离是 PS1 的活（Detect-Code 内处理）；NSI 侧断言
  // 中间态（W-06）等 10 秒再 Detect，最多 2 次，仍 pending 拉起 Repair。
  ok('A13-heal-pending-waits-and-retries',
    healFn.includes('pendingWait:') &&
    healFn.includes('INSTALLER: service pending, wait 10s and re-detect') &&
    healFn.includes('IntCmp $R3 2 launchHelper'));

  // ---- B. qf-agent-heal.ps1 ----
  ok('B1-ps1-target', PS1.includes("'" + TARGET + "'") || PS1.includes(TARGET));
  ok('B2-ps1-qfbak-guard',
    PS1.includes(".qfbak") && PS1.includes("if (-not (Test-Path -LiteralPath $bak))"));
  ok('B3-ps1-only-meshserver-line',
    PS1.includes("(?m)^MeshServer=[^\\r\\n]*") && PS1.includes('MeshServer='));
  ok('B4-ps1-restarts-service',
    PS1.includes("Restart-Service -Name 'Mesh Agent'"));
  ok('B5-ps1-fail-soft',
    PS1.includes("$ErrorActionPreference = 'SilentlyContinue'") &&
    PS1.includes('try {') && PS1.includes('} catch {'));
  ok('B6-ps1-always-exit-0', (PS1.match(/exit 0/g) || []).length >= 3);
  ok('B7-ps1-no-old-ip', !PS1.includes(OLD_IP));
  ok('B8-ps1-logs-result', PS1.includes('qf-agent-heal.log'));

  // ---- C. 改写算法等价夹具 ----
  // 与 PS1 同款规则：行首 MeshServer= 整行替换（不吞行尾回车），无此行追加。
  function healTransform(raw) {
    // 逐行精确比对（与 PS1 的 (?m)^MeshServer=...\\r?$ 等价）
    const lines = raw.split('\n');
    const hasTarget = lines.some((l) => l.replace(/\r$/, '') === 'MeshServer=' + TARGET);
    if (hasTarget) return { changed: false, out: raw };
    if (/^MeshServer=/m.test(raw)) {
      return { changed: true, out: raw.replace(/^MeshServer=[^\r\n]*/m, 'MeshServer=' + TARGET) };
    }
    const nl = raw.includes('\r\n') ? '\r\n' : '\n';
    let out = raw;
    if (out !== '' && !out.endsWith('\n')) out += nl;
    return { changed: true, out: out + 'MeshServer=' + TARGET + nl };
  }

  const stale = 'MeshServer=wss://54.248.9.192:8443/agent.ashx\r\nServerID=01234567-89ab-cdef-0123-456789abcdef\r\nMeshName=DESKTOP-D39ABOL\r\n';
  const r1 = healTransform(stale);
  ok('C1-stale-only-that-line-changes', r1.changed &&
    r1.out === 'MeshServer=' + TARGET + '\r\nServerID=01234567-89ab-cdef-0123-456789abcdef\r\nMeshName=DESKTOP-D39ABOL\r\n');
  const good = 'MeshServer=' + TARGET + '\r\nServerID=01234567-89ab-cdef-0123-456789abcdef\r\n';
  const r2 = healTransform(good);
  ok('C2-already-correct-untouched', !r2.changed && r2.out === good);
  const missing = 'ServerID=01234567-89ab-cdef-0123-456789abcdef\r\nMeshName=DESKTOP-D39ABOL\r\n';
  const r3 = healTransform(missing);
  ok('C3-missing-appended', r3.changed &&
    r3.out === missing + 'MeshServer=' + TARGET + '\r\n');
  const staleLf = 'MeshServer=wss://54.248.9.192:8443/agent.ashx\nServerID=x\n';
  const r4 = healTransform(staleLf);
  ok('C4-lf-endings-preserved', r4.changed && !r4.out.includes('\r') &&
    r4.out === 'MeshServer=' + TARGET + '\nServerID=x\n');
  const r5 = healTransform('');
  ok('C5-empty-file-appended', r5.changed && r5.out === 'MeshServer=' + TARGET + '\n');

  // ---- D. 目标地址唯一来源（2.4.5：NSI 不再自写目标地址，以 PS1 为准） ----
  ok('D1-target-in-ps1-only', PS1.includes(TARGET) && !NSI.includes('MeshServer=' + TARGET));

  // ---- E. 2.4.4 安装器加固 ----
  // 2.4.3 根因：预检跳过或 runas 静默失败时零留痕（%TEMP% 只有脚本、
  // 没有 qf-agent-heal.log）。本组断言两条路都被堵住。
  ok('E1-detect-delegate',
    healFn.includes("nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -File") &&
    healFn.includes("-Mode Detect"));
  ok('E2-detect-codes-covered',
    ['DETECT: local-ok', 'DETECT: service-missing', 'DETECT: msh-missing',
     'DETECT: service-pending', 'DETECT: msh-wrong-target', 'DETECT: stale-config',
     'DETECT: service-stopped'].every((s) => healFn.includes(s)));
  ok('E3-runas-fallback-start-process',
    healFn.includes('nsExec::ExecToStack "powershell -NoProfile -Command') &&
    healFn.includes('Start-Process') && healFn.includes('-Verb RunAs'));
  ok('E4-verify-poll-after-fix',
    healFn.includes('Sleep 5000') &&
    healFn.includes('INSTALLER: msh verified correct') &&
    healFn.includes('INSTALLER: msh verify failed after retries'));
  // 2.4.5 W-09①：安装器日志统一追加进 %TEMP%\qf-agent-heal.log
  //（与 PS1/App 同一份），模式 "a"＋FileSeek 0 END 显式定位到尾；
  // 独立文件 qf-agent-heal-installer.log 已废弃，绝不用 "w" 打开
  // 统一日志（"w" 会截断 PS1/App 已写的内容）。
  ok('E5-installer-log-unified-append',
    healFn.includes('FileOpen $R0 "$TEMP\\qf-agent-heal.log" a') &&
    healFn.includes('FileSeek $R0 0 END') &&
    !healFn.includes('qf-agent-heal-installer.log') &&
    !healFn.includes('"$TEMP\\qf-agent-heal.log" w'));
  ok('E6-no-self-written-sc-query',
    !healFn.includes('sc query "Mesh Agent"') &&
    healFn.includes('${StrStr} $R2 $R1 "DETECT: local-ok"') &&
    healFn.includes('DETECT: local-ok'));
  ok('E7-skip-itself-logged',
    healFn.includes('INSTALLER: skip, no agent msh found') &&
    healFn.includes('INSTALLER: skip already correct and running') &&
    healFn.includes('INSTALLER: skip, no Mesh Agent service'));
  ok('E8-verify-phase-re-detects',
    healFn.includes('verifyParse:') &&
    healFn.includes('verifyOk:') &&
    healFn.includes('launchVerify:'));
  ok('E9-strfunc-declared',
    NSI.includes('!include "StrFunc.nsh"') &&
    NSI.includes('${Using:StrFunc} StrLoc') &&
    NSI.includes('${Using:StrFunc} StrStr'));
  ok('E10-pending-exhausted-still-heals',
    healFn.includes('pendingWait:') &&
    healFn.includes('IntCmp $R3 2 launchHelper'));

  // ---- F. 2.4.4 PS1 v2 ----
  ok('F1-ps1-start-line-for-guard',
    PS1.includes("'QFRemote agent heal start'"));
  ok('F2-ps1-result-set-complete',
    ['RESULT: fixed', 'RESULT: already_correct', 'RESULT: service_started',
     'RESULT: service_restarted', 'RESULT: restarted_stale_config',
     'RESULT: service_restart_failed', 'RESULT: msh_write_failed',
     'RESULT: no_agent'].every((s) => PS1.includes(s)));
  ok('F3-ps1-correct-still-handles-service',
    PS1.includes('MeshServer already correct, no file change') &&
    PS1.includes("Start-Service -Name 'Mesh Agent'"));
  ok('F4-ps1-service-retry-once',
    PS1.includes('retrying once after 5s'));
  ok('F5-ps1-locate-fallbacks',
    PS1.includes('ImagePath') && PS1.includes('ProgramData'));
  ok('F6-ps1-stale-config-detection',
    PS1.includes('LastWriteTime') && PS1.includes('StartTime'));

  // ---- G. 2.4.5 ----
  const lockSec = segment(NSI, 'Section "隐私锁组件" SEC_LOCK', 'SectionEnd');
  ok('G1-lock-section-required',
    NSI.includes('Section "隐私锁组件" SEC_LOCK') && lockSec.includes('SectionIn RO'));
  ok('G2-lock-files-shipped',
    ['privacy-lock\\install.ps1', 'privacy-lock\\uninstall.ps1',
     'privacy-lock\\app\\QFLockService.exe', 'privacy-lock\\app\\QFLockUI.exe',
     'privacy-lock\\app\\qf-lockctl.exe', 'privacy-lock\\app\\qf-lockupdater.exe']
      .every((s) => lockSec.includes('File "' + s + '"')) &&
    lockSec.includes('DetailPrint "隐私锁组件 v2.0.3'));
  ok('G3-version-245',
    NSI.includes('QFRemote-Setup-v2.4.5.exe') &&
    NSI.includes('VIProductVersion "2.4.5.0"') &&
    NSI.includes('"DisplayVersion" "2.4.5"') &&
    NSI.includes('"DisplayName" "QFRemote 2.4.5"'));
  ok('G4-iferrors-right-after-extract',
    secMain.indexOf('Nsis7z::Extract') < secMain.indexOf('IfErrors 0 +2') &&
    secMain.indexOf('IfErrors 0 +2') < secMain.indexOf('Delete "$PLUGINSDIR\\app.7z"'));
  ok('G5-wait-old-process-before-extract',
    secMain.includes('waitOldProc:') &&
    secMain.includes('tasklist /FI "IMAGENAME eq QFRemote.exe"') &&
    secMain.indexOf('waitOldProcDone:') < secMain.indexOf('Nsis7z::Extract'));
  ok('G6-uninstall-warns-login-data',
    NSI.includes('MUI_UNCONFIRMPAGE_TEXT_TOP') &&
    NSI.includes('将同时清除本机保存的登录信息与设置'));
  ok('G7-ps1-detect-mode',
    PS1.includes('param(') && PS1.includes('$Mode') &&
    PS1.includes("if ($Mode -eq 'Detect')") &&
    PS1.includes('DETECT: ') &&
    PS1.includes('Get-CimInstance Win32_Service') &&
    PS1.includes('StartPending') && PS1.includes('StopPending') &&
    PS1.includes('msh_write_failed') &&
    PS1.includes('PS1: '));
  // 三处分类码表一致：JS HEAL_CODES／PS1 Detect-Code／NSI Detect 分支
  const healJs = fs.readFileSync(path.join(__dirname, '..', 'agent-heal.js'), 'utf8');
  const codes = ['local-ok', 'service-missing', 'service-pending', 'msh-missing',
    'msh-wrong-target', 'stale-config', 'service-stopped'];
  ok('G8-code-table-consistent',
    codes.every((c) => healJs.includes("'" + c + "'") && PS1.includes("'" + c + "'") && healFn.includes('DETECT: ' + c)));
  // W-09②/观察项②：Detect 判定优先级统一为服务缺失优先——PS1
  // Detect-Code 内 service-missing 的 return 先于 msh-missing 的 return
  // 出现；JS localCode 同顺序（M8 双缺失用例见 agent-heal-startup-test.js）。
  const detectFn = segment(PS1, 'function Detect-Code {', '$detectCode = Detect-Code');
  ok('G11-detect-order-service-first',
    detectFn.includes("return 'service-missing'") &&
    detectFn.includes("return 'msh-missing'") &&
    detectFn.indexOf("return 'service-missing'") < detectFn.indexOf("return 'msh-missing'"));
  // W-06：pending 强制重启失败分支（$okPending 为假）必有一行
  // RESULT: service_restart_failed，不再只写 done 即 exit 0。
  const pendingBlk = segment(PS1, 'service still pending after wait, forcing restart', "Write-HealLog 'QFRemote agent heal done'");
  ok('G12-pending-fail-has-result',
    pendingBlk.includes('$okPending = Restart-AgentServiceOnce') &&
    pendingBlk.includes('RESULT: service_restart_failed'));
  const uninst = segment(NSI, 'Section "Uninstall"', 'SectionEnd');
  ok('G9-uninstall-stops-helper-services',
    uninst.includes("sc stop QFLockSvc") && uninst.includes("sc delete QFLockSvc") &&
    uninst.includes("sc stop QFSysHelper") && uninst.includes("sc delete QFSysHelper"));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const buildFiles = (pkg.build && pkg.build.files) || [];
  ok('G10-helper-and-heal-packaged',
    ['qf-agent-heal.ps1', 'sys-helper.js', 'install-system-services.ps1',
     'syshelper/QFSysHelper.exe', 'syshelper/whitelist.json']
      .every((f) => buildFiles.includes(f)) && pkg.version === '2.4.5');

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
console.log('agent-heal-test: all ' + Object.keys(result.cases).length + ' cases pass');
