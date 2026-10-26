'use strict';
/*
 * QFRemote 软件内更新：安装包拉起（v2.3.0，站长 2026-10-25 10:16 口径）
 * ================================================================
 * 口径钉死，只管「软件内更新」这一条路：
 *   - 只有从网页下载的安装包，双击安装时才走安装向导、可选安装目录
 *     （installer.nsi 的目录页与 InstallDirRegKey 回填就是为那条路留的，
 *     本模块不碰它）；
 *   - 软件内更新一律自动安装：下载并核对通过后，用 NSIS 静默参数拉起
 *     安装包，装回软件当前所在的文件夹——不弹向导、不出现目录页、
 *     用户改不了、也不会装到别处。
 *
 * 静默参数（NSIS 官方口径，见 Docs/Chapter3.html「Command Line Usage」）：
 *   /S     静默运行：不显示任何向导页面；
 *   /D=xx  指定默认安装目录；必须是命令行最后一个参数，且路径不加引号
 *          （用 spawn 数组传参天然满足：参数逐个传递、没有 shell 拼串）。
 * 「当前文件夹」= 正在运行的本应用所在目录 path.dirname(process.execPath)：
 * 已安装的应用就装在那里，静默装回原地即原地升级。另外 installer.nsi 里
 * InstallDirRegKey 还会把上次安装位置回填为默认目录，作双保险（网页下载
 * 路径也受益），两处口径一致、不冲突。
 *
 * 本模块刻意不依赖 Electron，方便单测直接注入假 spawn 验证拉起参数。
 */
const path = require('path');
const childProcess = require('child_process');

// 当前安装目录：已安装的应用，其主程序所在目录就是它装着的文件夹。
function currentInstallDir(execPath) {
  return path.dirname(execPath || process.execPath);
}

// NSIS 静默拉起参数：恰为 ['/S', '/D=<目录>']，/D 必须在最后、路径不加引号。
function buildSilentArgs(installDir) {
  return ['/S', '/D=' + installDir];
}

// 以静默方式拉起安装包（detached：安装程序独立于本应用存活，本应用随后
// 退出交接、放开对自身文件的占用，静默安装才能顺利替换）。
// opts 可注入 { execPath, installDir, spawn }（单测用）。
// 返回 { file, args, installDir }；file 为空时返回 null 且不拉起。
function launchInstallerSilent(file, opts) {
  const o = opts || {};
  if (!file) return null;
  const installDir = o.installDir || currentInstallDir(o.execPath);
  const args = buildSilentArgs(installDir);
  const spawnFn = o.spawn || childProcess.spawn;
  const child = spawnFn(file, args, { detached: true, stdio: 'ignore' });
  if (child) {
    // 拉起失败（如文件被删）走异步 error：吞掉不许把主进程带崩，
    // 调用方该退出的退出、该停留的停留，与既有交接口径一致。
    if (typeof child.on === 'function') child.on('error', () => {});
    if (typeof child.unref === 'function') child.unref();
  }
  return { file, args, installDir };
}

module.exports = { currentInstallDir, buildSilentArgs, launchInstallerSilent };
