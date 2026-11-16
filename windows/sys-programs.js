'use strict';
/*
 * QFRemote Windows 运行端 — 系统程序绝对路径（D-09，3.0.0）
 * ================================================================
 * 来源：draw.io CVE-2026-119333——主进程以裸可执行文件名启动
 * powershell/attrib，冷启动时工作目录被劫持导致任意代码执行。
 * 本模块是唯一允许解析系统程序名的地方：
 *   - sc.exe / reg.exe / powershell.exe / cmd.exe 一律解析为
 *     %SystemRoot%\System32 下的绝对路径；
 *   - 调用方 spawn/spawnSync/execFile 只许传这里返回的绝对路径，
 *     并把 cwd 显式设为 SAFE_CWD（System32），不再继承进程 cwd。
 * 非 Windows 平台（沙箱单测）同样返回 Windows 风格的绝对路径，
 * 便于断言；是否真实存在由调用方 spawn 的 error 处理。
 * QFRLEA / QFSysHelper 等自家程序不在此列：它们走安装目录绝对路径
 * （见 main.js 里的 lea exe 定位），同样不许裸名。
 */
const path = require('path');

const KNOWN_SYSTEM_PROGRAMS = Object.freeze({
  'sc.exe': 'sc.exe',
  'sc': 'sc.exe',
  'reg.exe': 'reg.exe',
  'reg': 'reg.exe',
  'powershell.exe': 'powershell.exe',
  'powershell': 'powershell.exe',
  'cmd.exe': 'cmd.exe',
  'cmd': 'cmd.exe',
  'where.exe': 'where.exe',
  'where': 'where.exe'
});

function systemRoot(env) {
  const e = env || process.env;
  const root = (e && (e.SystemRoot || e.SYSTEMROOT || e.windir)) || 'C:\\Windows';
  return String(root).replace(/[\\/]+$/, '');
}

// 安全工作目录：System32。调用方 spawn 时一律显式传 cwd: safeCwd()。
function safeCwd(env) {
  return systemRoot(env) + '\\System32';
}

// name 可为 'sc' / 'sc.exe' / 'powershell.exe' 等；未知名字返回 null
// （调用方不得 spawn 未知名字，必须先登记）。
function resolveSystemProgram(name, env) {
  if (typeof name !== 'string') return null;
  const exe = KNOWN_SYSTEM_PROGRAMS[name.toLowerCase()];
  if (!exe) return null;
  return systemRoot(env) + '\\System32\\' + exe;
}

function scPath(env) { return resolveSystemProgram('sc.exe', env); }
function regPath(env) { return resolveSystemProgram('reg.exe', env); }
function powershellPath(env) { return resolveSystemProgram('powershell.exe', env); }
function cmdPath(env) { return resolveSystemProgram('cmd.exe', env); }

// 判定一次 spawn 调用是否合规：file 必须是绝对路径（Windows 盘符开头
// 或 UNC），且不在“裸程序名”之列。供构建检查与单测共用。
function isAbsoluteProgramPath(file) {
  if (typeof file !== 'string' || !file) return false;
  return /^[A-Za-z]:\\/.test(file) || file.startsWith('\\\\');
}

// 裸名判定：不含路径分隔符、也不是绝对路径。
function isBareProgramName(file) {
  if (typeof file !== 'string' || !file) return false;
  return !/[\\/]/.test(file);
}

module.exports = {
  KNOWN_SYSTEM_PROGRAMS,
  systemRoot,
  safeCwd,
  resolveSystemProgram,
  scPath,
  regPath,
  powershellPath,
  cmdPath,
  isAbsoluteProgramPath,
  isBareProgramName
};
