'use strict';
/*
 * D-09 构建检查测试（绝对路径＋渲染进程沙箱化）：
 *  A. sys-programs 单元：已知程序名解析为 %SystemRoot%\\System32
 *     下绝对路径；未知名字返回 null；裸名/绝对路径判定正确。
 *  B. 全树构建检查：node tools/check-electron-safety.js 对 windows/
 *     根目录跑 runChecks，违规必须为 0（裸程序名 spawn、
 *     nodeIntegration:true、contextIsolation:false、sandbox:false、
 *     webviewTag:true、渲染代码直引 Node/Electron 模块、preload
 *     通用直通桥，任一出现即失败）。
 *  C. 渲染进程沙箱化静态断言：全部窗口创建点都带 sandbox:true；
 *     全树无 nodeIntegration 字面量开启。
 *  D. agent-heal 提权命令走绝对路径（buildElevatedCommand）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const sysPrograms = require('../sys-programs');
const checker = require('../tools/check-electron-safety');
const heal = require('../agent-heal');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr-d09/d09-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const ROOT = path.join(__dirname, '..');

// ---------- A sys-programs ----------
{
  const env = { SystemRoot: 'C:\\Windows' };
  ok('A1_sc_absolute', sysPrograms.scPath(env) === 'C:\\Windows\\System32\\sc.exe');
  ok('A2_reg_absolute', sysPrograms.regPath(env) === 'C:\\Windows\\System32\\reg.exe');
  ok('A3_ps_absolute', sysPrograms.powershellPath(env) === 'C:\\Windows\\System32\\powershell.exe');
  ok('A4_cmd_absolute', sysPrograms.cmdPath(env) === 'C:\\Windows\\System32\\cmd.exe');
  ok('A5_unknown_null', sysPrograms.resolveSystemProgram('evil.exe', env) === null);
  ok('A6_safe_cwd', sysPrograms.safeCwd(env) === 'C:\\Windows\\System32');
  ok('A7_is_absolute', sysPrograms.isAbsoluteProgramPath('C:\\Windows\\System32\\sc.exe') === true);
  ok('A8_bare_detected', sysPrograms.isBareProgramName('powershell.exe') === true && sysPrograms.isBareProgramName('C:\\Windows\\System32\\sc.exe') === false);
  ok('A9_case_insensitive', sysPrograms.resolveSystemProgram('SC.EXE', env) === 'C:\\Windows\\System32\\sc.exe');
}

// ---------- B 全树构建检查 ----------
{
  const violations = checker.runChecks(ROOT);
  ok('B1_zero_violations', violations.length === 0, { violations: violations.slice(0, 5) });
}

// ---------- C 沙箱化静态断言 ----------
{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  // BaseWindow 本无渲染进程、不带 webPreferences，不计入；其余窗口创建点全须 sandbox:true。
  const creations = (mainSrc.match(/new (BrowserWindow|WebContentsView)\(/g) || []).length;
  const sandboxTrue = (mainSrc.match(/sandbox:\s*true/g) || []).length;
  ok('C1_all_windows_sandboxed', creations > 0 && sandboxTrue >= creations, { creations, sandboxTrue });
  ok('C2_no_nodeIntegration_on', !/nodeIntegration\s*:\s*true/.test(mainSrc));
  ok('C3_no_contextIsolation_off', !/contextIsolation\s*:\s*false/.test(mainSrc));
  ok('C4_no_sandbox_off', !/sandbox\s*:\s*false/.test(mainSrc));
  ok('C5_no_webviewTag', !/webviewTag\s*:\s*true/.test(mainSrc));
  // preload 只许 require('electron')
  const preloads = fs.readdirSync(ROOT).filter((n) => /-preload\.js$/.test(n));
  let preloadClean = preloads.length > 0;
  for (const name of preloads) {
    const text = fs.readFileSync(path.join(ROOT, name), 'utf8');
    const reqs = text.match(/require\(\s*['"]([^'"]+)['"]\s*\)/g) || [];
    if (reqs.some((r) => !/require\(\s*['"]electron['"]\s*\)/.test(r))) preloadClean = false;
  }
  ok('C6_preloads_only_electron', preloadClean, { preloadCount: preloads.length });
}

// ---------- D agent-heal 绝对路径 ----------
{
  const cmd = heal.buildElevatedCommand('C:\\Temp\\qf-agent-heal.ps1');
  ok('D1_command_absolute', sysPrograms.isAbsoluteProgramPath(cmd.command), { command: cmd.command });
  ok('D2_inner_absolute', cmd.args[4].includes(sysPrograms.powershellPath()));
  ok('D3_no_bare_inner', !cmd.args[4].includes("'powershell.exe'"));
}

const failed = Object.keys(result.cases).filter((k) => !result.cases[k].pass);
result.pass = failed.length === 0;
result.failed = failed;
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
console.log(JSON.stringify({ pass: result.pass, failed }));
process.exit(result.pass ? 0 : 1);
