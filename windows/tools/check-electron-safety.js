'use strict';
/*
 * QFRemote Windows 构建检查 — 渲染进程沙箱＋系统程序绝对路径（D-09）
 * =====================================================================
 * 用法：node tools/check-electron-safety.js [--root windows目录]
 * 退出码 0=通过；非零=违规，并逐条打印文件:行与原因。
 * 检查项（来源：draw.io CVE-2026-119333、VS Code electron-sandbox
 * 层边界）：
 *   A. 主进程调系统程序必须用绝对路径：main.js / agent-heal.js /
 *      installer-launch.js 里 spawn/spawnSync/execFile 的第一个
 *      参数不得是裸程序名（sc / sc.exe / reg / reg.exe /
 *      powershell / powershell.exe / cmd / cmd.exe）；必须走
 *      sys-programs.js 解析出的绝对路径，或已是绝对路径的变量。
 *      例外：单测注入的假 spawn（test/ 目录不查）；注释行不查。
 *   B. 渲染进程沙箱化：全部 BrowserWindow / WebContentsView /
 *      BaseWindow 的 webPreferences 不得出现 nodeIntegration:true、
 *      contextIsolation:false、sandbox:false、webviewTag:true。
 *   C. 渲染进程代码（*.html 内联脚本与非 preload 的渲染 JS）不得
 *      直接 require('electron') / require('child_process') /
 *      require('fs') / require('node:*')；Node 能力只许经 preload
 *      的 contextBridge 白名单通道（*-preload.js 除外，且 preload
 *      只许 require('electron')）。
 *   D. preload 桥面审计：每个 *-preload.js 只许暴露固定函数，
 *      不得出现通用 invoke(channel) / send(channel) 直通（grep
 *      ipcRenderer.invoke( / ipcRenderer.send( 且第一个参数不是
 *      字面量通道名的，记为违规）。
 * 本脚本是纯 Node，不依赖 Electron；windows/test/d09-build-check-test.js
 * 调它做断言，L7 发版门可直接跑它。
 */
const fs = require('fs');
const path = require('path');

const BARE_PROGRAMS = ['sc', 'sc.exe', 'reg', 'reg.exe', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe'];
const MAIN_SPAWN_FILES = ['main.js', 'agent-heal.js', 'installer-launch.js'];
const FORBIDDEN_WEB_PREFS = [
  { re: /nodeIntegration\s*:\s*true/, msg: 'nodeIntegration:true（渲染进程不得开 Node 集成）' },
  { re: /contextIsolation\s*:\s*false/, msg: 'contextIsolation:false（必须开上下文隔离）' },
  { re: /sandbox\s*:\s*false/, msg: 'sandbox:false（渲染进程必须沙箱化）' },
  { re: /webviewTag\s*:\s*true/, msg: 'webviewTag:true（不得开 webview 标签）' }
];
const RENDER_FORBIDDEN_REQUIRE = [
  /require\(\s*['"]electron['"]\s*\)/,
  /require\(\s*['"]child_process['"]\s*\)/,
  /require\(\s*['"]fs['"]\s*\)/,
  /require\(\s*['"]node:[^'"]+['"]\s*\)/
];

function stripComments(line) {
  // 只做行级粗 strip：// 注释（不在字符串内时）。块注释跨行不处理，
  // 误报宁可多报一条，由人工复核；本检查宁严勿漏。
  const idx = line.indexOf('//');
  if (idx < 0) return line;
  const before = line.slice(0, idx);
  const quotes = (before.match(/['"]/g) || []).length;
  if (quotes % 2 === 1) return line; // // 在字符串内
  return before;
}

function checkFileBareSpawn(root, file, violations) {
  const full = path.join(root, file);
  let text = '';
  try { text = fs.readFileSync(full, 'utf8'); } catch (e) { return; }
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const line = stripComments(raw);
    if (!/(spawn|spawnSync|execFile)\s*\(/.test(line)) return;
    for (const prog of BARE_PROGRAMS) {
      // spawn('sc.exe' / spawnSync("powershell" / execFile('cmd.exe'
      const re = new RegExp("(spawn|spawnSync|execFile)\\s*\\(\\s*['\"]" + prog.replace('.', '\\.') + "['\"]");
      if (re.test(line)) {
        violations.push({ file, line: i + 1, msg: '裸程序名 spawn：' + prog + '（必须走 sys-programs.js 绝对路径）' });
      }
      // 变量/函数返回的裸名字符串：spawnFn('sc', ...) 在 agent-heal 注入点
      // 以字符串字面量 'sc' 出现即违规（除非该行同时含 Path/绝对路径）。
      const re2 = new RegExp("(execFn|spawnFn|spawn)\\s*\\(\\s*['\"]" + prog.replace('.', '\\.') + "['\"]");
      if (re2.test(line)) {
        violations.push({ file, line: i + 1, msg: '裸程序名调用：' + prog + '（必须走 sys-programs.js 绝对路径）' });
      }
    }
    // Start-Process -FilePath 'powershell.exe'（提权命令内嵌裸名）
    if (/Start-Process\s+-FilePath\s+'powershell\.exe'/.test(line)) {
      violations.push({ file, line: i + 1, msg: "Start-Process 内嵌裸名 powershell.exe（须用绝对路径）" });
    }
  });
}

function checkFileWebPrefs(root, file, violations) {
  const full = path.join(root, file);
  let text = '';
  try { text = fs.readFileSync(full, 'utf8'); } catch (e) { return; }
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const line = stripComments(raw);
    for (const rule of FORBIDDEN_WEB_PREFS) {
      if (rule.re.test(line)) violations.push({ file, line: i + 1, msg: rule.msg });
    }
  });
}

function checkRendererFiles(root, violations) {
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { return; }
  for (const name of entries) {
    const full = path.join(root, name);
    let st = null;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const isPreload = /-preload\.js$/.test(name);
    const isMainSide = ['main.js', 'agent-heal.js', 'installer-launch.js', 'sys-helper.js',
      'watchdog.js', 'update.js', 'views.js', 'svc-urls.js', 'creds.js', 'autologin.js',
      'device-key.js', 'license.js', 'device-code.js', 'devices.js', 'client-version.js',
      'ext-retry.js', 'ipc-trust.js', 'lock.js', 'sys-programs.js', 'crash-handler.js',
      'settings-store.js', 'startup-stages.js', 'reconnect-policy.js', 'reconnect-ticket.js', 'tray-manager.js',
      'qf-fec.js', 'qf-idr.js', 'qf-relay.js', 'qf-transfer.js', 'qf-quality.js', 'qf-recording.js', 'qf-protocol.js'].indexOf(name) >= 0;
    if (name.endsWith('.html')) {
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
      const lines = text.split('\n');
      lines.forEach((raw, i) => {
        for (const re of RENDER_FORBIDDEN_REQUIRE) {
          if (re.test(raw)) violations.push({ file: name, line: i + 1, msg: '渲染页内联脚本直引 Node/Electron 模块' });
        }
        if (/nodeIntegration\s*:\s*true/.test(raw)) violations.push({ file: name, line: i + 1, msg: 'nodeIntegration:true' });
      });
      continue;
    }
    if (!name.endsWith('.js') || isPreload || isMainSide) continue;
    // 其余根目录 JS：若不是 preload/主进程侧模块，按渲染侧处理。
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
    const lines = text.split('\n');
    lines.forEach((raw, i) => {
      for (const re of RENDER_FORBIDDEN_REQUIRE) {
        if (re.test(raw)) violations.push({ file: name, line: i + 1, msg: '非 preload 渲染代码直引 Node/Electron 模块' });
      }
    });
  }
}

function checkPreloadBridge(root, violations) {
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { return; }
  for (const name of entries.filter((n) => /-preload\.js$/.test(n))) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, name), 'utf8'); } catch (e) { continue; }
    const lines = text.split('\n');
    lines.forEach((raw, i) => {
      const line = stripComments(raw);
      // 只许 require('electron')；其它 require 一律违规。
      const reqs = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/g) || [];
      for (const r of reqs) {
        if (!/require\(\s*['"]electron['"]\s*\)/.test(r)) {
          violations.push({ file: name, line: i + 1, msg: 'preload 直引非 electron 模块：' + r });
        }
      }
      // 通用直通桥：invoke/send 第一个参数不是字面量通道名。
      if (/ipcRenderer\.(invoke|send)\s*\(\s*(?![`'"])/.test(line)) {
        violations.push({ file: name, line: i + 1, msg: 'preload 存在通用 invoke/send 直通（通道名须为字面量）' });
      }
    });
  }
}

function runChecks(root) {
  const violations = [];
  for (const f of MAIN_SPAWN_FILES) checkFileBareSpawn(root, f, violations);
  const mainText = (() => { try { return fs.readFileSync(path.join(root, 'main.js'), 'utf8'); } catch (e) { return ''; } })();
  if (mainText) checkFileWebPrefs(root, 'main.js', violations);
  checkRendererFiles(root, violations);
  checkPreloadBridge(root, violations);
  // 去重（同一文件同一行同一原因只报一次）。
  const seen = new Set();
  return violations.filter((v) => {
    const k = v.file + ':' + v.line + ':' + v.msg;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function main() {
  const args = process.argv.slice(2);
  let root = path.resolve(__dirname, '..');
  const ri = args.indexOf('--root');
  if (ri >= 0 && args[ri + 1]) root = path.resolve(args[ri + 1]);
  const violations = runChecks(root);
  if (!violations.length) {
    console.log('check-electron-safety: PASS (0 violations, root=' + root + ')');
    return 0;
  }
  console.log('check-electron-safety: FAIL (' + violations.length + ' violations)');
  for (const v of violations) console.log('  ' + v.file + ':' + v.line + ' ' + v.msg);
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { runChecks, BARE_PROGRAMS };
