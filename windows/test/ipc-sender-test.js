'use strict';
/*
 * QFRemote F-08（GPT 第二轮审计）IPC sender 来源统一校验自检：
 *  A. fileUrlMatchesPath（posix）：精确文件、去 query/hash、编码、遍历、UNC；
 *  B. fileUrlMatchesPath（win32）：盘符、大小写不敏感、斜杠混用、遍历；
 *  C. isTrustedConsoleOrigin：https 精确 origin 集合、端口、userinfo；
 *  D. assertTrustedSender 端到端（mock event/窗口树）：合法放行矩阵＋
 *     iframe/错文件/错 origin/销毁 sender/宿主已毁/未登记 channel 一律拒绝；
 *  E. 静态覆盖：main.js 60 处注册全走包装器（无裸 ipcMain.handle/on）、
 *     注册 channel 集与 IPC_CAPABILITIES 键集完全相等、各 preload 的
 *     CAPABILITIES 与其实际 invoke/send 完全一致且与能力表归属一致、
 *     package.json 打包清单含 ipc-trust.js。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const trust = require('../ipc-trust');
const { IPC_CAPABILITIES, assertTrustedSender, assertTrustedIpcSender, validateIpcArgs, IPC_ARG_SPECS, fileUrlMatchesPath, isTrustedConsoleOrigin } = trust;

const OUT = process.env.QFTEST_OUT || '/tmp/qfr232/ipc-sender-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };
const SRC = path.join(__dirname, '..');

// ---------- mock：sender / frame / 窗口树 ----------
function mockSender() {
  return { isDestroyed: () => false, getURL: () => '' };
}
function mockEvent(sender, frameUrl, opts) {
  const o = opts || {};
  return {
    sender,
    senderFrame: (o.noFrame ? undefined : {
      parent: (o.parent === undefined ? null : o.parent),
      url: frameUrl,
      isDestroyed: () => !!o.frameDestroyed
    })
  };
}
// 宿主 BaseWindow：contentView 子树里某 WebContentsView 的 webContents 是 sender
function mockHostWindow(sender, destroyed) {
  return {
    webContents: null,
    contentView: { children: [{ webContents: sender }] },
    isDestroyed: () => !!destroyed
  };
}
// 独立 BrowserWindow（about/lock/force）：自身 webContents 就是 sender
function mockBrowserWindow(sender, destroyed) {
  return {
    webContents: sender,
    contentView: { children: [] },
    isDestroyed: () => !!destroyed
  };
}
const ORIGINS = new Set(['https://app.qfremote.top', 'https://forum.qfremote.top']);
function ctxPosix(wins) {
  return { dirname: '/home/x/windows', platform: 'posix', trustedOrigins: () => ORIGINS, allWindows: () => wins };
}
function ctxWin32(wins) {
  return { dirname: 'C:\\QFRemote\\windows', platform: 'win32', trustedOrigins: () => ORIGINS, allWindows: () => wins };
}
function legitPosix(channel, file, wins) {
  const s = mockSender();
  const w = wins || [mockHostWindow(s)];
  return assertTrustedSender(mockEvent(s, 'file:///home/x/windows/' + file + '?t=dark'), channel, ctxPosix(w));
}
function legitConsole(channel, url, wins) {
  const s = mockSender();
  const w = wins || [mockHostWindow(s)];
  return assertTrustedSender(mockEvent(s, url || 'https://app.qfremote.top/'), channel, ctxPosix(w));
}

// ---------- A. fileUrlMatchesPath（posix） ----------
ok('A1_posix_exact_query', fileUrlMatchesPath('file:///home/x/windows/toolbar.html?t=dark', '/home/x/windows/toolbar.html', 'posix'));
ok('A2_posix_exact_query_hash', fileUrlMatchesPath('file:///home/x/windows/devices.html?t=dark#top', '/home/x/windows/devices.html', 'posix'));
ok('A3_posix_wrong_file', !fileUrlMatchesPath('file:///home/x/windows/about.html', '/home/x/windows/toolbar.html', 'posix'));
ok('A4_posix_devices_not_prefix', !fileUrlMatchesPath('file:///home/x/windows/devices.htmlx', '/home/x/windows/devices.html', 'posix'));
ok('A5_posix_traversal', !fileUrlMatchesPath('file:///home/x/windows/../secret.html', '/home/x/windows/devices.html', 'posix'));
ok('A6_posix_file_host', !fileUrlMatchesPath('file://evil-host/home/x/windows/toolbar.html', '/home/x/windows/toolbar.html', 'posix'));
ok('A7_posix_http', !fileUrlMatchesPath('https://app.qfremote.top/toolbar.html', '/home/x/windows/toolbar.html', 'posix'));
ok('A8_posix_percent_space', fileUrlMatchesPath('file:///home/x/my%20dir/toolbar.html', '/home/x/my dir/toolbar.html', 'posix'));
ok('A9_posix_encoded_vs_literal', !fileUrlMatchesPath('file:///home/x/windows/a%40b.html', '/home/x/windows/a%40b.html', 'posix'));
ok('A10_posix_bad_url', !fileUrlMatchesPath('::not a url::', '/home/x/windows/toolbar.html', 'posix'));

// ---------- B. fileUrlMatchesPath（win32） ----------
ok('B1_win32_exact_query', fileUrlMatchesPath('file:///C:/QFRemote/windows/toolbar.html?t=dark', 'C:\\QFRemote\\windows\\toolbar.html', 'win32'));
ok('B2_win32_case_insensitive', fileUrlMatchesPath('file:///c:/qfremote/windows/TOOLBAR.HTML', 'C:\\QFRemote\\windows\\toolbar.html', 'win32'));
ok('B3_win32_wrong_file', !fileUrlMatchesPath('file:///C:/QFRemote/windows/about.html', 'C:\\QFRemote\\windows\\toolbar.html', 'win32'));
ok('B4_win32_percent_space', fileUrlMatchesPath('file:///C:/QFRemote/windows/my%20dir/toolbar.html', 'C:\\QFRemote\\windows\\my dir\\toolbar.html', 'win32'));
ok('B5_win32_slash_mix', fileUrlMatchesPath('file:///C:/QFRemote/windows/toolbar.html', 'C:/QFRemote/windows\\toolbar.html', 'win32'));
ok('B6_win32_file_host', !fileUrlMatchesPath('file://evil-host/C:/QFRemote/windows/toolbar.html', 'C:\\QFRemote\\windows\\toolbar.html', 'win32'));
ok('B7_win32_traversal', !fileUrlMatchesPath('file:///C:/QFRemote/windows/../secret.html', 'C:\\QFRemote\\windows\\devices.html', 'win32'));
ok('B8_win32_devices_exact', fileUrlMatchesPath('file:///C:/QFRemote/windows/devices.html?t=dark', 'C:\\QFRemote\\windows\\devices.html', 'win32'));

// ---------- C. isTrustedConsoleOrigin ----------
ok('C1_console_exact', isTrustedConsoleOrigin('https://app.qfremote.top/', ORIGINS));
ok('C2_console_path_ok', isTrustedConsoleOrigin('https://app.qfremote.top/console-engine/?node=x', ORIGINS));
ok('C3_console_port443', isTrustedConsoleOrigin('https://app.qfremote.top:443/', ORIGINS));
ok('C4_console_second_origin', isTrustedConsoleOrigin('https://forum.qfremote.top/forum', ORIGINS));
ok('C5_console_http_no', !isTrustedConsoleOrigin('http://app.qfremote.top/', ORIGINS));
ok('C6_console_evil_subdomain_no', !isTrustedConsoleOrigin('https://evil.qfremote.top/', ORIGINS));
ok('C7_console_bad_port_no', !isTrustedConsoleOrigin('https://app.qfremote.top:8443/', ORIGINS));
ok('C8_console_userinfo_no', !isTrustedConsoleOrigin('https://user@app.qfremote.top/', ORIGINS));
ok('C9_console_empty_set_no', !isTrustedConsoleOrigin('https://app.qfremote.top/', new Set()));

// ---------- D. assertTrustedSender 端到端 ----------
// 合法放行
ok('D01_toolbar_nav', legitPosix('qf-nav', 'toolbar.html'));
ok('D02_toolbar_admin', legitPosix('qf-admin-open', 'toolbar.html'));
ok('D03_toolbar_win', legitPosix('qf-win', 'toolbar.html'));
ok('D04_toolbar_autolaunch', legitPosix('qf-autolaunch-set', 'toolbar.html'));
ok('D05_devices_list', legitPosix('qf-devices-list', 'devices.html'));
ok('D06_devices_open', legitPosix('qf-devices-open', 'devices.html'));
ok('D07_gate_claim', legitPosix('qf-gate-claim', 'license-gate.html'));
ok('D08_gate_logout', legitPosix('qf-gate-logout', 'license-gate.html'));
ok('D09_console_deliver', legitConsole('qf-lea-selfbind-deliver', 'https://app.qfremote.top/'));
ok('D10_console_device_info', legitConsole('qf-lea-device-info', 'https://app.qfremote.top/console-engine/'));
ok('D10c_console_theme_state_get', legitConsole('qf-theme-state-get', 'https://app.qfremote.top/chat'));
{
  const s = mockSender();
  ok('D11_about_license_bind', assertTrustedSender(mockEvent(s, 'file:///home/x/windows/about.html?v=3.0.0'), 'qf-license-bind', ctxPosix([mockBrowserWindow(s)])));
  ok('D12_lock_enable', assertTrustedSender(mockEvent(s, 'file:///home/x/windows/lock.html'), 'qf-lock-enable', ctxPosix([mockBrowserWindow(s)])));
  ok('D13_force_release', assertTrustedSender(mockEvent(s, 'file:///home/x/windows/force-update.html?from=3.0.0&to=3.0.1'), 'qf-force-release', ctxPosix([mockBrowserWindow(s)])));
  ok('D14_extbar_back', assertTrustedSender(mockEvent(s, 'file:///home/x/windows/ext-bar.html'), 'qf-extbar-back', ctxPosix([mockHostWindow(s)])));
  ok('D15_sessionbar_back', assertTrustedSender(mockEvent(s, 'file:///home/x/windows/session-bar.html'), 'qf-sessionbar-back', ctxPosix([mockHostWindow(s)])));
  ok('D16_win32_toolbar_nav', assertTrustedSender(mockEvent(s, 'file:///C:/QFRemote/windows/toolbar.html?t=dark'), 'qf-nav', ctxWin32([mockHostWindow(s)])));
  ok('D17_win32_console_renew', assertTrustedSender(mockEvent(s, 'https://app.qfremote.top/chat'), 'qf-lea-selfbind-renew', ctxWin32([mockHostWindow(s)])));
  // frame.url 为空时退到 sender.getURL()
  const s2 = mockSender();
  s2.getURL = () => 'file:///home/x/windows/toolbar.html';
  ok('D18_fallback_getURL', assertTrustedSender({ sender: s2, senderFrame: { parent: null, url: '', isDestroyed: () => false } }, 'qf-nav', ctxPosix([mockHostWindow(s2)])));
}
// 拒绝：能力错配
ok('D19_toolbar_cannot_gate_claim', !legitPosix('qf-gate-claim', 'toolbar.html'));
ok('D20_toolbar_cannot_lea', !legitPosix('qf-lea-selfbind-deliver', 'toolbar.html'));
ok('D21_console_cannot_gate_claim', !legitConsole('qf-gate-claim', 'https://app.qfremote.top/'));
ok('D21b_toolbar_cannot_theme_state_get', !legitPosix('qf-theme-state-get', 'toolbar.html'));
ok('D21c_console_evil_theme_state_get_no', !legitConsole('qf-theme-state-get', 'https://evil.qfremote.top/'));
ok('D22_console_cannot_admin', !legitConsole('qf-admin-open', 'https://app.qfremote.top/'));
ok('D23_about_cannot_admin', (() => { const s = mockSender(); return !assertTrustedSender(mockEvent(s, 'file:///home/x/windows/about.html'), 'qf-admin-open', ctxPosix([mockBrowserWindow(s)])); })());
ok('D24_gate_cannot_license_claim', !legitPosix('qf-license-claim', 'license-gate.html'));
ok('D25_devices_cannot_nav', !legitPosix('qf-nav', 'devices.html'));
// 拒绝：文件不精确
ok('D26_devices2_no', !legitPosix('qf-devices-list', 'devices2.html'));
ok('D27_devices_subpath_no', !legitPosix('qf-devices-list', 'devices.html/evil'));
ok('D28_devices_http_no', (() => { const s = mockSender(); return !assertTrustedSender(mockEvent(s, 'https://app.qfremote.top/devices.html'), 'qf-devices-list', ctxPosix([mockHostWindow(s)])); })());
// 拒绝：帧 / sender / 窗口
{
  const s = mockSender();
  const wins = [mockHostWindow(s)];
  ok('D29_iframe_no', !assertTrustedSender(mockEvent(s, 'file:///home/x/windows/toolbar.html', { parent: {} }), 'qf-nav', ctxPosix(wins)));
  ok('D30_no_frame_no', !assertTrustedSender(mockEvent(s, 'file:///home/x/windows/toolbar.html', { noFrame: true }), 'qf-nav', ctxPosix(wins)));
  ok('D31_frame_destroyed_no', !assertTrustedSender(mockEvent(s, 'file:///home/x/windows/toolbar.html', { frameDestroyed: true }), 'qf-nav', ctxPosix(wins)));
  ok('D32_sender_destroyed_no', (() => { const d = mockSender(); d.isDestroyed = () => true; return !assertTrustedSender(mockEvent(d, 'file:///home/x/windows/toolbar.html'), 'qf-nav', ctxPosix([mockHostWindow(d)])); })());
  ok('D33_sender_not_in_tree_no', !assertTrustedSender(mockEvent(s, 'file:///home/x/windows/toolbar.html'), 'qf-nav', ctxPosix([])));
  ok('D34_host_destroyed_no', !assertTrustedSender(mockEvent(s, 'file:///home/x/windows/toolbar.html'), 'qf-nav', ctxPosix([mockHostWindow(s, true)])));
  ok('D35_unknown_channel_no', !assertTrustedSender(mockEvent(s, 'file:///home/x/windows/toolbar.html'), 'qf-evil-channel', ctxPosix(wins)));
  ok('D36_empty_url_no', !assertTrustedSender(mockEvent(s, ''), 'qf-nav', ctxPosix(wins)));
  ok('D37_null_event_no', !assertTrustedSender(null, 'qf-nav', ctxPosix(wins)));
  ok('D38_console_evil_origin_no', !legitConsole('qf-lea-selfbind-deliver', 'https://evil.qfremote.top/'));
  ok('D39_console_http_no', !legitConsole('qf-lea-selfbind-deliver', 'http://app.qfremote.top/'));
}

// ---------- E. 静态覆盖 ----------
const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
{
  const regHandle = (mainSrc.match(/trustedHandle\('(qf-[^']+)'/g) || []).map((m) => m.match(/'(qf-[^']+)'/)[1]);
  const regOn = (mainSrc.match(/trustedOn\('(qf-[^']+)'/g) || []).map((m) => m.match(/'(qf-[^']+)'/)[1]);
  const registered = regHandle.concat(regOn);
  ok('E1_registered_36_29', regHandle.length === 36 && regOn.length === 29, { handle: regHandle.length, on: regOn.length });
  ok('E2_registered_total_65', registered.length === 65 && new Set(registered).size === 65, { total: registered.length, unique: new Set(registered).size });
  const bareHandle = (mainSrc.match(/ipcMain\.handle\(/g) || []).length;
  const bareOn = (mainSrc.match(/ipcMain\.on\(/g) || []).length;
  ok('E3_no_bare_ipcMain', bareHandle === 1 && bareOn === 1, { handle: bareHandle, on: bareOn });
  ok('E4_wrappers_defined', /function trustedHandle\(channel, listener\)/.test(mainSrc) && /function trustedOn\(channel, listener\)/.test(mainSrc));
  const tableKeys = Object.keys(IPC_CAPABILITIES).sort();
  const regSorted = Array.from(new Set(registered)).sort();
  ok('E5_table_eq_registered', JSON.stringify(tableKeys) === JSON.stringify(regSorted),
    { tableOnly: tableKeys.filter((k) => regSorted.indexOf(k) < 0), regOnly: regSorted.filter((k) => tableKeys.indexOf(k) < 0) });
  ok('E6_table_65_keys', tableKeys.length === 65, { keys: tableKeys.length });
  ok('E7_pkg_files_has_ipc_trust', pkg.build && Array.isArray(pkg.build.files) && pkg.build.files.indexOf('ipc-trust.js') >= 0);
  ok('E8_main_requires_ipc_trust', /require\('\.\/ipc-trust'\)/.test(mainSrc));
}
// 各 preload：CAPABILITIES == 实际 invoke/send；归属与能力表一致
{
  const PRELOADS = {
    'console-preload.js': { kind: 'console' },
    'devices-preload.js': { file: 'devices.html' },
    'license-gate-preload.js': { file: 'license-gate.html' },
    'toolbar-preload.js': { file: 'toolbar.html' },
    'ext-bar-preload.js': { file: 'ext-bar.html' },
    'session-bar-preload.js': { file: 'session-bar.html' },
    'about-preload.js': { file: 'about.html' },
    'force-preload.js': { file: 'force-update.html' },
    'lock-preload.js': { file: 'lock.html' }
  };
  let allOk = true;
  const problems = [];
  for (const [file, expect] of Object.entries(PRELOADS)) {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const capMatch = src.match(/CAPABILITIES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/);
    if (!capMatch) { allOk = false; problems.push(file + ':no-CAPABILITIES'); continue; }
    const declared = (capMatch[1].match(/'([^']+)'/g) || []).map((q) => q.slice(1, -1)).sort();
    const used = Array.from(new Set(Array.from(src.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g), (m) => m[1]))).sort();
    if (JSON.stringify(declared) !== JSON.stringify(used)) {
      allOk = false;
      problems.push(file + ':declared=' + declared.join(',') + ' used=' + used.join(','));
      continue;
    }
    for (const ch of declared) {
      const rules = IPC_CAPABILITIES[ch] || [];
      const match = expect.kind === 'console'
        ? rules.some((r) => r.origin === 'console')
        : rules.some((r) => r.file === expect.file);
      if (!match) { allOk = false; problems.push(file + ':' + ch + ' not-mapped-to-' + (expect.file || 'console')); }
    }
  }
  ok('E9_preload_tables_match', allOk, { problems });
  // 能力表里每条 file 规则指向真实存在的本地页
  const filesOk = Object.values(IPC_CAPABILITIES).flat().every((r) => !r.file || fs.existsSync(path.join(SRC, r.file)));
  ok('E10_table_files_exist', filesOk);
}


// ---------- F. S-020：参数校验（类型／长度／枚举／路径／数字范围） ----------
{
  ok('F1_alias_same_fn', assertTrustedIpcSender === assertTrustedSender);
  ok('F2_win_enum', validateIpcArgs('qf-win', ['min']).ok && validateIpcArgs('qf-win', ['close']).ok &&
    !validateIpcArgs('qf-win', ['rm']).ok && !validateIpcArgs('qf-win', [1]).ok && !validateIpcArgs('qf-win', []).ok);
  ok('F3_nav_enum', validateIpcArgs('qf-nav', ['home']).ok && !validateIpcArgs('qf-nav', ['https://evil/']).ok);
  ok('F4_zoom_enum', validateIpcArgs('qf-zoom', ['reset']).ok && !validateIpcArgs('qf-zoom', ['zoom']).ok);
  ok('F5_key_length', validateIpcArgs('qf-license-bind', ['k'.repeat(512)]).ok && !validateIpcArgs('qf-license-bind', ['k'.repeat(513)]).ok &&
    !validateIpcArgs('qf-license-bind', [123]).ok);
  ok('F6_deliver_shape', validateIpcArgs('qf-lea-selfbind-deliver', [{ ticket: 'sbt_x', challenge: 'c', account_id: 'a', device_id: 'd', nonce: 'n1234567', expires_at: 1790000000 }]).ok &&
    !validateIpcArgs('qf-lea-selfbind-deliver', [{ ticket: 'sbt_x', challenge: 'c', account_id: 'a', device_id: 'd', nonce: 'n1234567', expires_at: 0 }]).ok &&
    !validateIpcArgs('qf-lea-selfbind-deliver', [{ ticket: 'sbt_x', challenge: 'c', account_id: 'a', device_id: 'd', nonce: 'n1234567', expires_at: 1790000000, evil: 1 }]).ok);
  ok('F7_update_settings_keys', validateIpcArgs('qf-update-settings-set', [{ enabled: true }]).ok &&
    !validateIpcArgs('qf-update-settings-set', [{ enabled: 'yes' }]).ok &&
    !validateIpcArgs('qf-update-settings-set', [{ enabled: true, autoUpdate: true }]).ok);
  ok('F8_autolaunch_bool', validateIpcArgs('qf-autolaunch-set', [true]).ok && !validateIpcArgs('qf-autolaunch-set', ['true']).ok);
  ok('F9_devices_open', validateIpcArgs('qf-devices-open', [{ nodeId: 'n1', name: 'pc', mode: 'remote' }]).ok &&
    !validateIpcArgs('qf-devices-open', [{ name: 'pc' }]).ok &&
    !validateIpcArgs('qf-devices-open', [{ nodeId: 'n1', mode: 'remote', extra: 1 }]).ok);
  ok('F10_overflow_menu', validateIpcArgs('qf-overflow-menu', [{ items: ['themeBtn'], x: 10, y: 20 }]).ok &&
    !validateIpcArgs('qf-overflow-menu', [{ items: ['themeBtn'], x: NaN, y: 20 }]).ok &&
    !validateIpcArgs('qf-overflow-menu', [{ items: ['x'.repeat(65)], x: 0, y: 0 }]).ok);
  ok('F11_lock_args', validateIpcArgs('qf-lock-enable', ['id', 'pw']).ok &&
    !validateIpcArgs('qf-lock-enable', ['id', '']).ok &&
    validateIpcArgs('qf-lock-reset', ['id', 'old', 'new']).ok &&
    !validateIpcArgs('qf-lock-reset', ['id', 'old']).ok);
  ok('F12_no_spec_passthrough', validateIpcArgs('qf-version', []).ok && validateIpcArgs('qf-version', ['anything']).ok);
  ok('F13_wrappers_call_validator', /validateIpcArgs\(channel, args\)/.test(mainSrc) &&
    (mainSrc.match(/validateIpcArgs\(channel, args\)/g) || []).length === 2);
  ok('F14_specs_cover_high_risk', ['qf-gate-claim', 'qf-license-bind', 'qf-license-claim', 'qf-lea-selfbind-deliver', 'qf-lea-selfbind-renew', 'qf-lock-enable', 'qf-lock-reset', 'qf-update-settings-set'].every((c) => typeof IPC_ARG_SPECS[c] === 'function'));
}

result.pass = Object.values(result.cases).every((c) => c.pass);
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
console.log(JSON.stringify({ pass: result.pass, failed: Object.keys(result.cases).filter((k) => !result.cases[k].pass) }));
process.exit(result.pass ? 0 : 1);
