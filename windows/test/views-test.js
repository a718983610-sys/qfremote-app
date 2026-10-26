'use strict';
/*
 * QFRemote 2.3.0 M 线（同框集成）持久视图自检：
 *  A. 地址归类：控制台/好友/聊天/论坛四类 + 外站不归类；
 *  B. 切换零导航：已加载视图再次切入 loadPlan=show-only，switchTo 不产生 navigate 事件；
 *  C. 预加载调度：未登录不调度；登录后按 好友→聊天→论坛 顺序逐个推进；
 *  D. 首载流程：未创建→create-and-load、已创建未加载完→wait、已加载→show-only；
 *  E. 手动退出后预加载复位、论坛需重走交接（由 loadPlan 的 created/loaded 状态决定，
 *     markUnloaded 后切入不再是 create，而是 wait——主进程据此重发 loadURL 的口径在 main 侧，
 *     本层只保证状态机一致：退出不销毁视图登记）。
 * 结果写 JSON 到 QFTEST_OUT，退出码 0=通过。
 */
const fs = require('fs');
const path = require('path');
const { createViewManager, classifyUrl, isForumSsoTransit, wrapperTarget } = require('../views');

const OUT = process.env.QFTEST_OUT || '/tmp/qfr230/views-result.json';
const result = { cases: {}, pass: false };
const ok = (name, cond, extra) => { result.cases[name] = Object.assign({ pass: !!cond }, extra || {}); };

const CTX = {
  consoleUrl: 'https://54.248.9.192:8443/',
  friendsUrl: 'https://54.248.9.192:8445/friends',
  chatUrl: 'https://54.248.9.192:8445/chat',
  forumUrl: 'https://tun.example.com/forum'
};
const URLS = { friends: CTX.friendsUrl, chat: CTX.chatUrl, forum: CTX.forumUrl };

let t = 1000;
const vm = createViewManager({ now: () => t });

// A 地址归类
ok('A1_console', classifyUrl('https://54.248.9.192:8443/', CTX) === 'console');
ok('A2_friends', classifyUrl('https://54.248.9.192:8445/friends', CTX) === 'friends');
ok('A3_chat', classifyUrl('https://54.248.9.192:8445/chat', CTX) === 'chat');
ok('A4_chat_sub', classifyUrl('https://54.248.9.192:8445/chat/room', CTX) === 'chat');
ok('A5_forum', classifyUrl('https://tun.example.com/forum', CTX) === 'forum');
ok('A6_forum_api', classifyUrl('https://tun.example.com/api/forum/posts', CTX) === 'forum');
ok('A7_external_null', classifyUrl('https://example.com/forum', CTX) === null);
ok('A8_file_null', classifyUrl('file:///tmp/x.html', CTX) === null);
ok('A9_sso_transit', isForumSsoTransit('https://tun.example.com/api/forum/sso-login?token=x', CTX) === true);
ok('A10_8445_root_is_friends', classifyUrl('https://54.248.9.192:8445/', CTX) === 'friends');

// C 预加载：未登录不调度
ok('C1_no_preload_before_login', vm.nextPreload() === null);
vm.noteLogin();
ok('C2_first_friends', vm.nextPreload() === 'friends');
vm.markCreated('friends');
ok('C3_then_chat', vm.nextPreload() === 'chat');
vm.markCreated('chat');
ok('C4_then_forum', vm.nextPreload() === 'forum');
vm.markCreated('forum');
ok('C5_done', vm.nextPreload() === null);

// D 首载流程（用新 manager 复演用户点击路径）
const vm2 = createViewManager({ now: () => t });
vm2.noteLogin();
ok('D1_friends_create', vm2.loadPlan('friends', URLS).action === 'create-and-load');
vm2.markCreated('friends');
ok('D2_friends_wait', vm2.loadPlan('friends', URLS).action === 'wait');
vm2.markLoaded('friends');
ok('D3_friends_show_only', vm2.loadPlan('friends', URLS).action === 'show-only');
ok('D4_console_always_show', vm2.loadPlan('console', URLS).action === 'show-only');

// B 切换零导航：切走再切回，navigate 事件不增加
vm2.noteNavigate('friends', URLS.friends); // 首载那一次真实导航
const before = vm2.events().filter(e => e.type === 'navigate').length;
t += 5000;
vm2.switchTo('friends');
vm2.switchTo('console');
vm2.switchTo('friends');
const after = vm2.events().filter(e => e.type === 'navigate').length;
ok('B1_switch_no_navigate', before === after, { before, after });
ok('B2_switch_events_logged', vm2.events().filter(e => e.type === 'switch').length === 3);
ok('B3_nav_since_switch_zero', vm2.navCountSince('friends', t) === 0);
ok('B4_active_is_friends', vm2.state().active === 'friends');

// E 手动退出：视图登记保留（不销毁），预加载阶段复位等重新登录
vm2.noteLogout();
ok('E1_logout_keeps_views', vm2.state().views.friends.created === true);
ok('E2_logout_blocks_preload', vm2.nextPreload() === null);
vm2.noteLogin();
ok('E3_relogin_resumes_preload', vm2.nextPreload() === 'chat'); // 已建的好友不重建，从未建处续上

// W 包装页归类（壳内拦截用）
ok('W1_wrap_friends', wrapperTarget('https://54.248.9.192:8443/qf-wrap.html?t=friends') === 'friends');
ok('W2_wrap_forum', wrapperTarget('https://tun.example.com/qf-wrap.html?t=forum') === 'forum');
ok('W3_wrap_bad_null', wrapperTarget('https://54.248.9.192:8443/qf-wrap.html?t=admin') === null);
ok('W4_non_wrap_null', wrapperTarget('https://54.248.9.192:8443/', CTX) === null);

result.pass = Object.values(result.cases).every(c => c.pass);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
