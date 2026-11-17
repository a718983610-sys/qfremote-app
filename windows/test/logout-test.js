'use strict';
/*
 * 正式「退出登录」接线自检（2.3.0 M2 线，静态接线 + 语义锚点）：
 *  A. 「我的/关于」页有明确「退出登录」入口，点击走 preload 桥；
 *  B. preload 桥暴露 requestLogout -> ipc 'qf-logout-request'；
 *  C. 主进程确认框文案与站长拟稿逐字一致（正文 + 两按钮，默认/取消
 *     均为「取消」，防误触回车即退）；
 *  D. 确认后走既有手动退出 machinery：terminateSubSessions（级联终止
 *     好友/论坛/管理子会话）+ handleManualLogout（清保险箱/记住标记/
 *     manualLogout 落盘）+ 控制台加载 /logout 回登录页；不另造平行路径；
 *  E. handleManualLogout 本体仍是 A 线语义：manualLogout=true、
 *     rememberDevice=false、credStore.clear()、saveSettings()；
 *  F. 网页皮肤侧同一文案与级联（custom.js）：确认正文逐字一致、含
 *     共享退出纪元与子服务退出端点。
 * 真壳行为（退出→重开→停在登录页不自动重登）由真壳审计架子实走，
 * 不在本单测内。跑法：node test/logout-test.js，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..');
const SKIN = path.join(SRC, '..', 'console-skin');
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const COPY = '退出后将清除本机保存的登录信息，下次使用需重新登录。是否继续？';
const aboutHtml = fs.readFileSync(path.join(SRC, 'about.html'), 'utf8');
const aboutPreload = fs.readFileSync(path.join(SRC, 'about-preload.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const customJs = fs.readFileSync(path.join(SKIN, 'custom.js'), 'utf8');

ok('A1_about_logout_button', /id="logoutBtn"[^>]*>退出登录</.test(aboutHtml));
ok('A2_about_click_uses_bridge', /getElementById\('logoutBtn'\)\.addEventListener\('click'[\s\S]{0,200}qfAbout\.requestLogout\(\)/.test(aboutHtml));
ok('B_preload_bridge', /requestLogout:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('qf-logout-request'\)/.test(aboutPreload));

// F-08（2026-11-14）：main.js 的 IPC 注册已改走 trustedHandle 包装器，定位符同步改名；断言本身不变。
const handlerAt = mainJs.indexOf("trustedHandle('qf-logout-request'");
ok('C0_handler_exists', handlerAt >= 0);
const handler = handlerAt >= 0 ? mainJs.slice(handlerAt, handlerAt + 1600) : '';
ok('C1_confirm_copy_exact', handler.includes("message: '" + COPY + "'"));
ok('C2_confirm_buttons', handler.includes("buttons: ['退出登录', '取消'], defaultId: 1, cancelId: 1"));
ok('C3_cancel_is_noop', /if \(!r \|\| r\.response !== 0\) return \{ ok: false, cancelled: true \};/.test(handler));
ok('D1_cascade_first', handler.indexOf('terminateSubSessions()') >= 0 && handler.indexOf('terminateSubSessions()') < handler.indexOf('handleManualLogout()'));
ok('D2_reuses_manual_logout', handler.includes('handleManualLogout();'));
ok('D3_console_to_logout', handler.includes("loadURL(CONSOLE_URL + 'logout')"));
ok('D4_no_parallel_vault_clear', !/credStore\.clear\(\)/.test(handler));

const mlAt = mainJs.indexOf('function handleManualLogout()');
const ml = mlAt >= 0 ? mainJs.slice(mlAt, mlAt + 700) : '';
ok('E1_manual_flags', ml.includes('settings.auth.manualLogout = true;') && ml.includes('settings.auth.rememberDevice = false;'));
ok('E2_vault_clear', ml.includes('credStore.clear()'));
ok('E3_settings_saved', ml.includes('saveSettings();'));
ok('E4_subsession_cascade_shared', ml.includes('terminateSubSessions()'));

ok('F1_web_copy_exact', customJs.includes("var QF_LOGOUT_TEXT = '" + COPY + "';"));
ok('F2_web_epoch', customJs.includes("localStorage.setItem('qfLogoutEpoch'"));
ok('F3_web_cascade_endpoints', customJs.includes('/api/friends/logout') && customJs.includes('/api/forum/logout') && customJs.includes('/admin/api/logout'));
ok('F4_web_marks_cleared', customJs.includes("localStorage.removeItem('qfCredUser')"));

result.pass = Object.values(result.cases).every(c => c.pass);
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
