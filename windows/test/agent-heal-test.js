'use strict';
/*
 * 本机 agent 自愈（2.4.3）本地自检：
 *  A. installer.nsi 静态断言：预检函数在位、装后段接线、runas 提权只走
 *     助手脚本、安装器本体仍为 user 级（不动既有安装/静默更新口径）、
 *     预检函数内无 Abort（fail-soft）、目录页与 InstallDirRegKey 未动；
 *  B. qf-agent-heal.ps1 静态断言：目标地址、.qfbak 备份守卫、只改
 *     MeshServer 行、重启 Mesh Agent 服务、fail-soft（静默继续＋
 *     try/catch＋恒 exit 0）、不含旧 IP；
 *  C. 改写算法等价夹具（与 PS1 同款正则/规则的 JS 实现）：过期行只换
 *     该行、其余行逐字保留、已正确不改动、缺行追加、换行格式保留；
 *  D. 目标地址双文件一致（NSIS 预检与 PS1 逐字同值）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 * 说明：PS1 本体只能在 Windows 提权环境真跑，本机无 pwsh；C 组验的是
 * 与 PS1 同款规则的改写逻辑，真机提权重写留发布日站长真机验收。
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
  ok('A8-heal-checks-canonical-msh',
    healFn.includes('"$PROGRAMFILES\\Mesh Agent\\MeshAgent.msh"'));
  ok('A9-heal-target-in-nsi', healFn.includes('"MeshServer=' + TARGET + '"'));
  ok('A10-directory-page-and-regkey-intact',
    NSI.includes('MUI_PAGE_DIRECTORY') && NSI.includes('InstallDirRegKey HKCU'));
  ok('A11-heal-skips-when-correct',
    healFn.includes('StrCmp $R9 1 healReturn'));
  ok('A12-heal-skips-when-no-agent',
    healFn.includes('StrCmp $R7 1 0 healReturn'));
  // 发版前深查修复（2026-11-07）：FileRead 读回行带行尾符，预检全行
  // 比较前必须先剥 CR/LF，否则已正确的机器会被误判、白弹一次 UAC。
  ok('A13-heal-strips-line-endings-before-compare',
    healFn.includes('healTrim:') &&
    healFn.includes('StrCmp $R3 "$\\r" healCut') &&
    healFn.includes('StrCmp $R3 "$\\n" healCut'));

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

  // ---- D. 双文件目标地址一致 ----
  ok('D1-target-agrees', NSI.includes(TARGET) && PS1.includes(TARGET));

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
