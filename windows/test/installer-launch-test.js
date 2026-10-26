'use strict';
/*
 * 软件内更新静默拉起（installer-launch.js）本地自检（v2.3.0）：
 *  A. 静默参数恰为 ['/S', '/D=<目录>']，/D 在最后、路径不带引号；
 *  B. 当前安装目录 = path.dirname(execPath)；
 *  C. 拉起走注入的 spawn：参数/选项（detached、stdio ignore）原样、
 *     子进程 unref、返回值带回 args 与 installDir；空文件不拉起；
 *  D. 真 spawn 冒烟（非 Windows 沙箱以 /bin/true 冒充安装包，只验拉起
 *     不抛、参数回带——真安装包的静默行为属真机验收项，不在此冒充）；
 *  E. main.js 接线静态断言：require 了共享模块、软更新与强更两个入口
 *     都走 launchDownloadedInstaller、全文件再无 openPath、软更新拉起后
 *     置 'installing' 态并退出交接；
 *  F. 网页下载路径零改动守卫：installer.nsi 仍含 MUI_PAGE_DIRECTORY 与
 *     InstallDirRegKey；关于页/强更页文案已是「安装更新并重启」、
 *     再无「打开安装包」。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { currentInstallDir, buildSilentArgs, launchInstallerSilent } = require('../installer-launch');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr230/installer-launch-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

function segment(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) return '';
  const b = endMarker ? src.indexOf(endMarker, a + startMarker.length) : -1;
  return src.slice(a, b > a ? b : undefined);
}

(() => {
  try {
    const fakeDir = path.join(os.tmpdir(), 'QFRemoteFakeDir');
    const fakeExe = path.join(fakeDir, 'QFRemote.exe');
    const fakeInstaller = path.join(os.tmpdir(), 'QFRemote-Setup-v9.9.9.exe');

    // A
    const args = buildSilentArgs(fakeDir);
    let aExact = false;
    try { assert.deepStrictEqual(args, ['/S', '/D=' + fakeDir]); aExact = true; } catch (e) { /* 记录在下 */ }
    ok('A_args_exact', aExact && args.length === 2 && args[1].startsWith('/D=') && !args[1].includes('"'), { args });

    // B
    ok('B_install_dir_from_execpath', currentInstallDir(fakeExe) === fakeDir, { got: currentInstallDir(fakeExe), want: fakeDir });

    // C
    const calls = [];
    let unrefCalled = false;
    const fakeSpawn = (file, a, opts) => {
      calls.push({ file, args: a, opts });
      return { unref: () => { unrefCalled = true; }, on: () => {} };
    };
    const r = launchInstallerSilent(fakeInstaller, { execPath: fakeExe, spawn: fakeSpawn });
    ok('C1_spawn_args', calls.length === 1 && calls[0].file === fakeInstaller &&
      JSON.stringify(calls[0].args) === JSON.stringify(['/S', '/D=' + fakeDir]),
      { call: calls[0] || null });
    ok('C2_spawn_opts_detached', !!calls[0] && calls[0].opts.detached === true && calls[0].opts.stdio === 'ignore' && unrefCalled === true,
      { opts: calls[0] ? calls[0].opts : null, unrefCalled });
    ok('C3_return_shape', !!r && r.installDir === fakeDir && JSON.stringify(r.args) === JSON.stringify(['/S', '/D=' + fakeDir]),
      { returned: r });
    const rNull = launchInstallerSilent('', { execPath: fakeExe, spawn: fakeSpawn });
    ok('C4_empty_file_no_launch', rNull === null && calls.length === 1);

    // D（仅非 Windows 且 /bin/true 存在时冒烟；参数回带断言与平台无关地校验返回值）
    if (process.platform !== 'win32' && fs.existsSync('/bin/true')) {
      const rd = launchInstallerSilent('/bin/true', { execPath: fakeExe });
      ok('D_real_spawn_smoke', !!rd && JSON.stringify(rd.args) === JSON.stringify(['/S', '/D=' + fakeDir]), { returned: rd });
    } else {
      ok('D_real_spawn_smoke', true, { skipped: 'platform-or-no-true' });
    }

    // E
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok('E1_require_shared', mainSrc.includes("require('./installer-launch')"));
    ok('E2_wrapper_uses_silent', segment(mainSrc, 'function launchDownloadedInstaller', "ipcMain.on('qf-update-open'")
      .includes('launchInstallerSilent') && segment(mainSrc, 'function launchDownloadedInstaller', "ipcMain.on('qf-update-open'")
      .includes('process.execPath'));
    const softSeg = segment(mainSrc, "ipcMain.on('qf-update-open'", '// ---------- v1.0.4');
    ok('E3_soft_uses_shared', softSeg.includes('launchDownloadedInstaller(updateState.download.file)'), {});
    ok('E4_soft_installing_then_quit', softSeg.includes("phase: 'installing'") && softSeg.includes('broadcastUpdate()') && softSeg.includes('app.quit()'), {});
    const forceSeg = segment(mainSrc, "ipcMain.on('qf-force-open'", '// 启动门');
    ok('E5_force_uses_shared', forceSeg.includes('launchDownloadedInstaller(forceState.download.file)'), {});
    ok('E6_force_installing_then_quit', forceSeg.includes("phase: 'installing'") && forceSeg.includes('sendForceState()') && forceSeg.includes('app.quit()'), {});
    ok('E7_no_openpath_anywhere', !mainSrc.includes('openPath'));
    ok('E8_both_entries_only', (mainSrc.match(/launchDownloadedInstaller\(/g) || []).length === 3,
      { count: (mainSrc.match(/launchDownloadedInstaller\(/g) || []).length });

    // F
    const nsi = fs.readFileSync(path.join(__dirname, '..', 'installer.nsi'), 'utf8');
    ok('F1_nsi_directory_page_kept', nsi.includes('MUI_PAGE_DIRECTORY'));
    ok('F2_nsi_regkey_kept', nsi.includes('InstallDirRegKey'));
    const about = fs.readFileSync(path.join(__dirname, '..', 'about.html'), 'utf8');
    const force = fs.readFileSync(path.join(__dirname, '..', 'force-update.html'), 'utf8');
    ok('F3_about_wording', about.includes('安装更新并重启') && about.includes("s.phase === 'installing'") && !about.includes('打开安装包'));
    ok('F4_force_wording', force.includes('安装更新并重启') && force.includes("s.phase === 'installing'") && !force.includes('打开安装包'));
    const pkg = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    ok('F5_packaged_files_include_module', pkg.includes('"installer-launch.js"'));

    result.pass = Object.values(result.cases).every(c => c.pass);
  } catch (e) {
    result.fatal = e.message;
  } finally {
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
    console.log(JSON.stringify({ pass: result.pass, cases: result.cases, fatal: result.fatal || null }));
    process.exit(result.pass ? 0 : 1);
  }
})();
