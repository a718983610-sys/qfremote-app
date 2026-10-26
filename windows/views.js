'use strict';
/*
 * QFRemote 持久视图管理（2.3.0 M 线「同框集成」新增）
 * ================================================================
 * 站长口径（2026-10-25 11:18）：点开好友/论坛必须像在同一个软件里，
 * 不许是「跳转新网页」的动态与感觉（独立页面/新窗口/整页重载＋跨源
 * 跳转感）。此前壳里只有一个内容视图，好友/论坛/注册/管理全靠往这
 * 一个视图里 loadURL 换地址：每次点击都整页重载、白屏、且控制台的
 * 滚动位置与已选设备一换即丢；论坛还要走一遍看得见的令牌跳转链。
 *
 * 本模块是纯逻辑层（不碰 Electron），管三件事，main.js 负责把决策
 * 落到真实的 WebContentsView 上：
 *  1) 视图注册表与切换决策：控制台/好友/聊天/论坛四个视图并存，
 *     切换 = 显示目标视图、隐藏其余视图，不产生任何导航。已创建的
 *     视图再次切入时 loadPlan 恒为 'none'（零导航、零重载），这是
 *     「无跳转感」在代码层的硬保证，可单测。
 *  2) 地址归类：任意 URL 归到所属视图（控制台 8443 / 好友与聊天
 *     8445 / 论坛隧道源），供主进程拦截视图内跨页链接——点好友页
 *     顶栏的「聊天」「论坛」是切视图，不是把当前视图导航走。
 *  3) 预加载调度：登录成功后空闲分批创建（好友 → 聊天 → 论坛），
 *     论坛在创建时就在后台完成令牌交接（SSO），用户点击时页面已
 *     是登录态。冷启动路径（登录页出现前）绝不创建任何社交视图，
 *     不拖慢启动。调度节拍由 planPreload 给出，main.js 用定时器
 *     执行并在每次执行前复核「已登录」前提。
 *
 * 导航探针：每次真实导航（loadURL）与每次切换都记进 events，
 * 审计时据此证明「第二次切入同一视图时导航事件为 0」。
 */

// devices/session（2.3.2 收编）：新版设备页与壳内会话视图，与社交视图
// 同级登记；两者的创建/切换由 main.js 专门路径管理（本地页＋会话深链），
// 不进社交预加载序列，loadPlan 不对它们出 create-and-load。
const VIEW_KEYS = ['console', 'friends', 'chat', 'forum', 'home', 'devices', 'session'];

// 地址归类：raw 是任意 URL 字符串；ctx = { consoleUrl, friendsUrl, chatUrl, forumUrl }
// 论坛在隧道源（跨源），按 forumUrl 的主机名＋/forum 路径前缀认；
// 其余按主机＋端口＋路径认。认不出返回 null（外站/本地页，主进程按既有口径处理）。
function classifyUrl(raw, ctx) {
  if (!raw || typeof raw !== 'string') return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const c = ctx || {};
  const sameOrigin = (base) => {
    if (!base) return false;
    try { const b = new URL(base); return u.hostname === b.hostname && u.port === b.port; } catch (e) { return false; }
  };
  // 聊天与好友同源（8445），靠路径分：/chat* 归聊天，其余 8445 归好友
  if (sameOrigin(c.friendsUrl) || sameOrigin(c.chatUrl)) {
    if (u.pathname === '/chat' || u.pathname.startsWith('/chat/')) return 'chat';
    return 'friends';
  }
  if (c.forumUrl) {
    try {
      const f = new URL(c.forumUrl);
      if (u.hostname === f.hostname && u.port === f.port &&
          (u.pathname === f.pathname || u.pathname.startsWith(f.pathname + '/') || u.pathname.startsWith('/api/forum'))) {
        return 'forum';
      }
    } catch (e) { /* ignore */ }
  }
  // 首页视图（2.3.1 阶段 E）：扩展服务同源页面——/home 正本及购买/状态
  // 查询/申诉/客服（壳内打开的自有网页同一落点）。ctx.extUrl 为 /home
  // 地址，只认其源＋白名单路径；同源的 /points、/admin 等不归首页视图
  // （沿用既有打开方式），论坛路径已在上面先行归类。
  if (c.extUrl && sameOrigin(c.extUrl)) {
    const p = u.pathname;
    if (p === '/home' || p === '/purchase' || p === '/license/status' ||
        p === '/appeal' || p === '/support' || p.startsWith('/license/')) {
      return 'home';
    }
  }
  if (sameOrigin(c.consoleUrl)) return 'console';
  return null;
}

// 论坛令牌交接的回跳地址（sso-login）也归论坛视图，但它是一次性
// 中转，归类后主进程不把它当「用户导航」处理（见 loadPlan 的 forum 分支）。
function isForumSsoTransit(raw, ctx) {
  try {
    const u = new URL(raw);
    return u.pathname === '/api/forum/sso-login';
  } catch (e) { return false; }
}

function createViewManager(opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  const views = {}; // key -> { created:bool, loaded:bool, navCount:int, createdAt, lastShownAt }
  for (const k of VIEW_KEYS) views[k] = { created: false, loaded: false, navCount: 0, createdAt: 0, lastShownAt: 0 };
  views.console.created = true; // 控制台视图随主窗创建即存在
  let active = 'console';
  const events = []; // {type:'switch'|'navigate', key, at}
  let preloadStage = 0; // 0 未开始 1 好友 2 聊天 3 论坛 4 全部完成
  let loggedIn = false;

  function state() {
    const v = {};
    for (const k of VIEW_KEYS) v[k] = Object.assign({}, views[k]);
    return { active, views: v, preloadStage, loggedIn };
  }

  function noteLogin() { loggedIn = true; }
  function noteLogout() {
    // 手动退出：社交视图不销毁（销毁再建会闪），但登录态已失效，
    // 下次切入论坛时须重走令牌交接（forumNeedsSso 重新置真由
    // 主进程在论坛视图落回登录态时调用 markForumStale）。
    loggedIn = false;
    preloadStage = 0;
  }

  // 预加载调度：登录后才开始；每一步只推进一个视图，步间间隔由
  // main.js 定时器控制（默认 1200ms），保证空闲分批、不抢启动资源。
  // 返回下一步要创建的视图 key（'friends'|'chat'|'forum'），无下一步返回 null。
  // 注：'home' 视图（2.3.1）不进本调度序列——它要在创建前先做会话 cookie
  // 移植（跨源），由 main.js 在社交视图预加载收尾后单独创建加载；本层
  // 只管它的注册/切换/零导航账本，与其余视图同口径。
  function nextPreload() {
    if (!loggedIn) return null;
    const order = ['friends', 'chat', 'forum'];
    for (const k of order) if (!views[k].created) return k;
    return null;
  }

  // 视图创建登记（主进程真正建好 WebContentsView 后调用）
  function markCreated(key) {
    if (!views[key]) return;
    views[key].created = true;
    views[key].createdAt = now();
    preloadStage = ['friends', 'chat', 'forum'].filter(k => views[k].created).length;
  }

  // 切入某视图时该做什么：
  //  - 未创建 → {action:'create-and-load', url}（含论坛令牌交接由主进程先行）
  //  - 已创建未完成首载 → {action:'wait'}（显示已垫底色的视图，不重复 loadURL）
  //  - 已加载 → {action:'show-only'}（零导航，立即显示）
  function loadPlan(key, urls) {
    const v = views[key];
    if (!v) return { action: 'none', reason: 'unknown-view' };
    if (key === 'console') return { action: 'show-only' };
    if (!v.created) return { action: 'create-and-load', url: (urls || {})[key] || null };
    if (!v.loaded) return { action: 'wait' };
    return { action: 'show-only' };
  }

  // 切换登记：返回 {from,to}；切换本身永不触发导航（审计探针据此核对）。
  function switchTo(key) {
    if (!views[key]) return null;
    const from = active;
    active = key;
    views[key].lastShownAt = now();
    events.push({ type: 'switch', from, to: key, at: now() });
    return { from, to: key };
  }

  // 真实导航登记（主进程每次对视图 loadURL / 视图内 did-navigate 时调用）
  function noteNavigate(key, url) {
    if (!views[key]) return;
    views[key].navCount++;
    events.push({ type: 'navigate', key, url: String(url || ''), at: now() });
  }
  function markLoaded(key) { if (views[key]) views[key].loaded = true; }
  function markUnloaded(key) { if (views[key]) views[key].loaded = false; }

  // 审计用：某视图自某时刻以来的导航次数（证明再次切入零导航）
  function navCountSince(key, since) {
    return events.filter(e => e.type === 'navigate' && e.key === key && e.at >= since).length;
  }

  return {
    state, noteLogin, noteLogout, nextPreload, markCreated,
    loadPlan, switchTo, noteNavigate, markLoaded, markUnloaded, navCountSince,
    events: () => events.slice()
  };
}

// 网页版包装页地址（/qf-wrap.html?t=friends|chat|forum，部署在控制台源）：
// 壳里若有页面把入口指向包装页，壳不进包装页（避免双层框），直接按
// t 参数切到对应保活视图。网页端则由包装页本体完成同框呈现。
function wrapperTarget(raw) {
  try {
    const u = new URL(raw);
    if (u.pathname !== '/qf-wrap.html') return null;
    const t = u.searchParams.get('t');
    return (t === 'friends' || t === 'chat' || t === 'forum') ? t : null;
  } catch (e) { return null; }
}

module.exports = { createViewManager, classifyUrl, isForumSsoTransit, wrapperTarget, VIEW_KEYS };
