/* app.js — W-05 机械拆分后：应用壳（2026-11-15，全进 3.0）
 * 视图（Views.*）、会话融合（iframe 外壳＋阶段机）、聊天/论坛/订单等业务页与启动 boot。
 * 本文件保留 windows/test 钉住的函数原样（doLogin/doLogout/checkSessionInner、节点图/
 * 防御(a)函数簇、NODE_MAP_TTL_MS/CONTROL_PROBE_MS），改动须同步更新该线快照。
 * 加载顺序第 4 位（最后）。 */
'use strict';

/* ---------------- 设备节点标识（node id）----------------
   /home/api/stats 的设备只有名称/系统/分组/在线，不带节点 id（服务端口径）。
   节点 id 的真实来源有二：①/lock/devices（机主设备，id 即节点 id）；
   ②控制台引擎同源控制通道（/control.ashx，浏览器凭会话自动鉴权，与原生
   控制台同一通道）的 nodes 应答。两者都取不到的设备不冒充、不许发送。 */
/* ---------------- 设备节点标识（node id）----------------
   修 C3/C6（原 fetchNodeMap 串行：lockApi 6224ms + fetchControlNodes 618ms，且无单飞）：
   ① 快源＝/lock/devices（服务端已做缓存/单飞，命中 <1s），先返回、先可用；
   ② 慢源＝控制通道全量 nodes（补好友共享设备的 id），后台回填同一份缓存，不阻塞导航与面板首屏；
   ③ 全流程 single-flight；页内缓存 60s 有效（原随页生死且永不刷新）。
   X-05：设备页首屏传 {deferSlow:true} 时慢源不在首屏建控制 WS（浏览器直连
   /control.ashx 另开一条 WS 是深查验收「≤1 条新 WS」超标的根源），改为记
   nodeMapSlowDeferred，延迟到下一次非首屏取数（设备详情/锁面板等真正需要
   节点 id 时）再建；首屏缺失的共享设备 id 由 openSession 的服务端 resolve
   端点兜底（5 秒缓存＋单飞，不另开浏览器 WS）。 */
let nodeMapCache = null;
let nodeMapInflight = null;
let nodeMapGen = 0; // 高-1：节点映射代次——invalidate 时自增，在飞请求回来先比代次，旧代次一律不得回填缓存
let nodeMapSlowInflight = null;
let nodeMapSlowDeferred = false; // X-05：首屏 deferSlow 后待补的慢源探测（下次非首屏取数时起）
const NODE_MAP_TTL_MS = 60000;
const CONTROL_PROBE_MS = 1500;      // 控制通道探测上限（原 6000，与慢源定位一致）
/* NAV_LOOKUP_BUDGET_MS（900ms 点按竞态预算）已随 2.4.0 会话直达删除：解析改走
   数据携带→缓存→服务端 resolve 端点的确定序，不再有超时回落老列表这条路。 */

function ensureNodeMap() {
  if (!nodeMapCache) nodeMapCache = { at: 0, byName: new Map(), byId: new Map(), lockDevices: [], lockStatus: 'ok', lockError: '' };
  return nodeMapCache;
}
function applyLockDevices(devices) {
  const nm = ensureNodeMap();
  const list = [];
  (devices || []).forEach(d => {
    const dev = { id: String(d.id || ''), name: String(d.name || ''), owner: !!d.owner, locked: !!d.locked, component: d.component !== false };
    if (!dev.id) return;
    list.push(dev);
    if (dev.name) nm.byName.set(dev.name, dev.id);
    nm.byId.set(dev.id, dev.name);
    nm.byId.set(bareNodeId(dev.id), dev.name);   /* 裸 id 键：邀请/深链等按裸 id 反查设备名 */
  });
  nm.lockDevices = list;
  nm.lockStatus = 'ok'; nm.lockError = '';
  nm.at = Date.now();
  return nm;
}
function applyControlNodes(grouped) {
  const nm = ensureNodeMap();
  Object.values(grouped || {}).forEach(arr => {
    (Array.isArray(arr) ? arr : []).forEach(n => {
      if (!n || !n._id) return;
      const id = String(n._id);
      const nmName = String(n.name || n.rname || '');
      if (nmName && !nm.byName.has(nmName)) nm.byName.set(nmName, id);
      if (!nm.byId.has(id)) nm.byId.set(id, nmName);
      if (!nm.byId.has(bareNodeId(id))) nm.byId.set(bareNodeId(id), nmName);
    });
  });
  // [gate2-delta N6] slow fill renews the TTL only when the lock leg is healthy; on failure backdate so retry happens in ~5s
  nm.at = (nm.lockStatus === 'ok') ? Date.now() : (Date.now() - (NODE_MAP_TTL_MS - 5000));
  return nm;
}
function fetchControlNodes(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve(v || {}); } };
    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + '/control.ashx');
    } catch (e) { resolve({}); return; }
    const timer = setTimeout(() => finish({}), timeoutMs || CONTROL_PROBE_MS);
    ws.onopen = () => { try { ws.send(JSON.stringify({ action: 'nodes', responseid: 'qf-nodes-probe' })); } catch (e) { clearTimeout(timer); finish({}); } };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.responseid === 'qf-nodes-probe') { clearTimeout(timer); finish(m.nodes || {}); }
    };
    ws.onerror = () => { clearTimeout(timer); finish({}); };
    ws.onclose = () => { clearTimeout(timer); finish({}); };
  });
}
/* X-05：慢源探测单入口——开一条浏览器直连 /control.ashx 的 WS 取全量 nodes。
   只在真正需要节点 id 时调用（见 fetchNodeMap 的 deferSlow），设备页首屏不调。 */
function startSlowProbe() {
  if (nodeMapSlowInflight) return;
  const gen0 = nodeMapGen; // 高-1：慢源回填前比代次，换账号后旧探测结果不写缓存、不刷设备行
  nodeMapSlowInflight = fetchControlNodes(CONTROL_PROBE_MS)
    .then((grouped) => { if (gen0 === nodeMapGen) { applyControlNodes(grouped); refreshDevRowIds(document); } })
    .catch(() => {})
    .then(() => { nodeMapSlowInflight = null; });
}
async function fetchNodeMap(opts) {
  const force = !!(opts && opts.force);
  const deferSlow = !!(opts && opts.deferSlow);
  const gen0 = nodeMapGen; // 高-1：本次取数代次，快源回包与 .then 清位都先比代次
  // X-05：首屏 defer 过的慢源，在下一次非首屏取数时补起（哪怕本次命中页内缓存
  // 直接返回，也要把 WS 建起来，否则共享设备 id 会一直缺到 TTL 过期）。
  if (!deferSlow && nodeMapSlowDeferred && !nodeMapSlowInflight) { nodeMapSlowDeferred = false; startSlowProbe(); }
  if (nodeMapInflight) return nodeMapInflight;                 // single-flight
  const nm0 = ensureNodeMap();
  if (!force && nm0.at && (Date.now() - nm0.at) < NODE_MAP_TTL_MS) return nm0;
  nodeMapInflight = (async () => {
    let lockStatus = 'ok', lockError = '';
    try {
      // X-14：force 时 /lock/devices 带 ?force=1，跳过服务端非机主缓存与失败抑制实读一次。
      const lr = await lockApi('GET', force ? '/devices?force=1' : '/devices');
      // 高-1：快源在飞期间已 invalidate（登出/换账号/强制下线）：旧账号结果
      // 一个字节都不写缓存——校验必须在 applyLockDevices 之前，否则旧设备
      // 已落缓存。返回当前缓存（新账号已取到的即新数据，尚未取到的为空壳
      // 且 at=0，下次调用必重取），旧调用方凭原有守卫丢弃。
      if (gen0 !== nodeMapGen) return ensureNodeMap();
      if (lr.status === 200 && lr.json && Array.isArray(lr.json.devices)) {
        applyLockDevices(lr.json.devices);
        // X-13：服务端回 partial/pending（读路径预算用尽、部分设备未实读）时
        // 记在节点图上，锁面板据此明示并补拉，不得静默漏设备。
        const nm2 = ensureNodeMap();
        nm2.lockPartial = !!lr.json.partial; nm2.lockPending = lr.json.pending || 0;
      } else if (lr.status === 401) { lockStatus = 'needlogin'; lockError = apiErrText(lr, '登录状态已失效，请重新登录后再管理屏幕锁。'); }
      else if (lr.networkError) { lockStatus = 'unreachable'; lockError = '暂时连不上屏幕锁服务，请检查网络后重试。'; }
      else { lockStatus = 'unavailable'; lockError = apiErrText(lr, '屏幕锁服务暂未开通网页通道，暂时无法在此管理。请通过软件端管理该设备的屏幕锁。'); }
    } catch (e) { lockStatus = 'unreachable'; lockError = '暂时连不上屏幕锁服务，请检查网络后重试。'; }
    const nm = ensureNodeMap();
    nm.lockStatus = lockStatus; nm.lockError = lockError; nm.at = Date.now();
    // 慢源不阻塞：后台拉控制通道全量 nodes，回来只回填缓存（供后续导航/共享设备用）。
    // X-05：首屏 deferSlow 时只记待补、不建 WS（见文件头注释）。
    if (deferSlow) nodeMapSlowDeferred = true;
    else startSlowProbe();
    return nm;
  })().then((v) => { if (gen0 === nodeMapGen) nodeMapInflight = null; return v; },
            (e) => { if (gen0 === nodeMapGen) nodeMapInflight = null; throw e; });
  return nodeMapInflight;
}
/* raceNodeId（点按 900ms 竞态解析）已随 2.4.0 会话直达整体删除：openSession 的
   解析序＝入口 data-nodeid 数据携带 → nodeIdFor 缓存 → ext /api/device/resolve
   兜底（见会话融合视图段），超时回落原生设备列表的路径不复存在。 */
/* 高-1：清缓存即作废在飞请求——代次自增使旧快源/慢源回包全部丢弃，
 * nodeMapInflight 置空使下次调用不再复用旧 promise；慢源待补标记一并
 * 清掉（旧账号的 deferSlow 不得在新账号下补探）。登出/换账号/强制下线
 * 三处调用点共用此函数，一处修全防住。 */
function invalidateNodeMap() { nodeMapCache = null; nodeMapGen++; nodeMapInflight = null; nodeMapSlowDeferred = false; }

/* 会话猝死统一落点（R5）：返回是否已接管呈现 */
function sessionDied(source) {
  // X-01：登录态死亡时先拆会话帧（帧是 body 级 fixed 节点，藏壳不藏帧；
  // 不拆则被封/被强制下线的账号的远程中继可能继续跑，下次还可能复用旧框）。
  try { teardownSession(); } catch (e) {}
  S.sessGen++; // DS-R49：会话结束＝登出等价落点，递增代数使其余在飞旧响应作废
  if (BanLock.suppress) return false;
  if (BanLock.state === 'expired') return true;
  if (BanLock.state === 'locked') { BanLock.toExpired('locked'); return true; }
  BanLock.toExpired('died');
  return true;
}

async function checkSessionInner(silent, opts) {
  // P1（2026-11-11）：本页内已显式登出（doLogout 置标记）后，心跳/定时器
  // 不得凭残留会话把 S.auth 翻回 'in'（cookie 若未清干净，/me 仍回 ok，
  // 致登出后状态回潮；动态桩测已证实）。冷启时本标记为 falsy，不影响
  // 启动自动恢复；新登录成功时 doLogin 清标记。
  // P1-4a（2026-11-11）：重载后内存标记已丢，持久标记同样守门。
  if (S._manualLogout || ManualLogout.is()) return false;
  const o = opts || {};
  const probe = o.probe;
  if (probe) { try { probe.gated = false; } catch (e) {} }
  const gen = S.sessGen; // DS-R49：发起时捕获身份代数，响应回来时代数已变则整单丢弃
  const me = await api('/license/api/me');
  // W-09：丢弃点只记 gen 新旧值（不记任何会话内容），便于排障时区分「丢弃」与「未返回」。
  if (gen !== S.sessGen) { try { console.debug('[qf-sess] checkSession /me 迟到丢弃：gen ' + gen + ' -> ' + S.sessGen); } catch (e) {} return S.auth === 'in'; } // DS-R49：旧代数迟到响应，不写状态、不作处置
  if (me.status === 200 && me.json && me.json.ok) {
    // 同一响应只走一条路：先 forceLogout（设备门），再 activeBan（封禁锁定）
    if (me.json.forceLogout) {
      if (probe) { try { probe.gated = true; } catch (e) {} }
      forceGate(me.json.gateCode || 'G1');
      return false;
    }
    const isNewAuth = S.auth !== 'in' || S.user !== me.json.username;
    const userSwitched = isNewAuth && !!S.user && S.user !== me.json.username; // DS-R07/S3：检出换账号（他标签切号落到本页）
    S.auth = 'in'; S.user = me.json.username; S.license = me.json;
    if (isNewAuth) S.sessGen++; // DS-R49：仅新建登录身份时递增；同账号周期校验不递增，防误伤在飞心跳
    if (userSwitched) { try { chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断会话检查 */ } } // DS-R07/S3：身份一变立即清本页聊天态与轮询，不等下一次 chatApi（此处 S.user 已是新身份，重签绑定正确）
    const curGen = S.sessGen;
    if (me.json.activeBan) {
      S.displayName = S.displayName || me.json.username;
      BanLock.enter(me.json.activeBan);       // 信号②
      cacheSave();
      return true;
    }
    const st = await api('/home/api/stats', { timeoutMs: 10000 }); // X-02：stats 只是回填展示数据，10 秒不到即用旧值，不必等 30 秒
    if (curGen !== S.sessGen) { try { console.debug('[qf-sess] checkSession /stats 迟到丢弃：gen ' + curGen + ' -> ' + S.sessGen); } catch (e) {} return S.auth === 'in'; } // DS-R49：stats 在飞期间身份已变，旧回填不写入
    if (st.status === 200 && st.json && st.json.ok) { S.stats = st.json; S.displayName = st.json.displayName || me.json.username; S.isAdmin = !!st.json.isAdmin; }
    else { S.displayName = me.json.username; }
    cacheSave();
    return true;
  }
  if (me.status === 401 || me.status === 403) {
    const wasIn = S.auth === 'in';
    S.auth = 'out'; S.license = null; Cache.clear(); clearMyProfile();
    if (wasIn) {
      if (!o.noDied) {
        const handled = sessionDied('session');   // 交给统一「会话已结束」落点
        if (!handled && !silent) toast('登录状态已失效，请重新登录。', 'warn');
      } else if (!silent) {
        toast('登录状态已失效，请重新登录。', 'warn');
      }
    }
    return false;
  }
  // 网络异常等：不把用户踢下线（手感规格：失败给正式提示、不崩页）
  if (!silent) toast('暂时无法确认登录状态，请稍后再试。', 'warn');
  return S.auth === 'in';
}

async function doLogin(username, password, remember) {
  clearMyProfile(); // 核对 S1：新登录先清上一账号档案，防切号串号
  // 登录一律走自家登录垫片 /qf-login（与原生登录页同口径）：垫片负责登录冻结、
  // 许可门与「记住此设备」——带 qfrememberdevice 字段时给会话 cookie 补 30 天
  // 有效期并种 qfrem 标记，不带则清标记。切勿直连 /login：会绕过垫片，
  // 「记住此设备」勾了也不生效（#39 定位结论）。
  // 登录 POST 的响应体是引擎整页（约 1.5MB），拿到响应头（Cookie 已下发）即取消下载，
  // 避免在慢网络上白等整页传输；成败以 /license/api/me 的会话校验为准。
  try {
    const fields = { username, password };
    if (remember) fields.qfrememberdevice = 'on'; // 垫片按原生勾选框口径认 'on' 值
    // X-03：/qf-login 裸 fetch 加 15 秒 Abort 超时（正常登录 3 秒内回头）——
    // 弱网下登录按钮不再无限转圈；超时与网络异常统一回同文案，按钮恢复可点。
    const loginCtl = (typeof AbortController === 'function') ? new AbortController() : null;
    const loginTimer = loginCtl ? setTimeout(() => { try { loginCtl.abort(); } catch (e) {} }, 15000) : null;
    let resp;
    try {
      resp = await fetch('/qf-login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), signal: loginCtl ? loginCtl.signal : undefined });
    } finally { if (loginTimer) clearTimeout(loginTimer); }
    const loginResult = resp.headers.get('x-qf-login-result');
    if (resp.body) { try { await resp.body.cancel(); } catch (e) {} }
    // 2026-10-26 热修（冻结误报）：密码正确但账号被冻结（B1 当日冻结）时，
    // 垫片回冻结提示页并带 X-QF-Login-Result: frozen——此时根本没有会话
    // 可供 /me 校验，若继续走 /me 必 401 并被误报「账号或密码不正确」。
    // 直接回冻结信号，由登录页呈现冻结提示与申诉入口（与垫片冻结弹窗同口径）。
    if (loginResult === 'frozen') return { ok: false, frozen: true };
    // 2026-10-28 热修（封禁误报）：密码正确但账号被封禁（B6/B7/B9 或永久封禁）
    // 或非 B1 冻结（B8/B10）且 MC 锁定位在身时，垫片回封禁门信号与数据。
    // 直接回 banned，由登录页画门，不再误报密码错误。
    if (loginResult === 'banned') {
      const ban = parseBanView(resp.headers.get('x-qf-ban-view'));
      return { ok: false, banned: true, ban };
    }
    // W1-3 残面（2026-10-29）：密码已验过但账号处于锁定漂移态（垫片三查无
    // 活动封禁可确认）时，垫片回 X-QF-Login-Result: locked——呈现中性提示，
    // 不再误报「账号或密码不正确」，也不冒充封禁/冻结。
    if (loginResult === 'locked') return { ok: false, locked: true };
  } catch (e) { return { ok: false, msg: '网络暂时不可用，请检查网络后重试。' }; }
  // 会话校验偶发抖动时多等一轮再判，避免把非密码原因误报成密码错误
  // （2026-10-26 热修：垫片许可门吃会话曾让 /me 必 401 并被一律误报）。
  let me = await api('/license/api/me');
  if (!(me.status === 200 && me.json && me.json.ok)) { await new Promise(r => setTimeout(r, 600)); me = await api('/license/api/me'); }
  if (me.status === 200 && me.json && me.json.ok) {
    S.sessGen++; // DS-R49：主动登录成功即新身份代数，旧在飞响应作废
    S.auth = 'in'; S.user = me.json.username; S.license = me.json;
    // P1（2026-11-11）：凭据提交的新登录成功——清本页内登出标记（恢复
    // 心跳校验），并写 freshLogin 标记供 Electron 主进程识别一次真实
    // 新登录（仅 doLogin 写；checkSession 冷启恢复与缓存恢复不写）。
    S._manualLogout = false;
    ManualLogout.clear(); // P1-4a：凭据提交的新登录成功才清持久登出标记，壳方可再出
    try { sessionStorage.setItem('qfShellFreshLogin', '1'); } catch (e) { /* ignore */ }
    const curGen = S.sessGen; // 批A-A1：捕获本次登录代数，stats 回填前比对（处方同 checkSession）
    const st = await api('/home/api/stats');
    if (curGen === S.sessGen && st.status === 200 && st.json && st.json.ok) { S.stats = st.json; S.displayName = st.json.displayName || S.user; S.isAdmin = !!st.json.isAdmin; }
    cacheSave();
    // 登录即上报一次积分心跳（与软件端口径一致；响应含强制下线信号时立即处理）
    heartbeat();
    return { ok: true };
  }
  if (me.status === 401 || me.status === 403) return { ok: false, msg: '账号或密码不正确，请核对后重试。' };
  return { ok: false, msg: '登录未完成，请稍后再试。' };
} // 凭证静默续期校验
function forceGate(code) {
  S.sessGen++; // DS-R49：强制下线＝登出等价落点，递增代数使其余在飞旧响应作废
  try { teardownSession(); } catch (e) {} // X-01：强制下线先拆会话帧
  BanLock.exit();
  S.auth = 'out'; Cache.clear(); clearMyProfile();
  invalidateNodeMap(); // W1-2：强制下线即清设备映射缓存，防换账号残留
  try { if (typeof chatResetAll === 'function') chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断登出 */ }
  showAuth('gate', { code: code || 'G1' });
  toast('本设备已被退出登录，请重新登录后在「我的 · 兑换 KEY」中处理激活。', 'warn');
}
async function doLogout() {
  confirmModal('退出登录', '退出后将清除本设备的登录状态与记住标记，再次使用需要重新登录。', '退出登录', async () => {
    BanLock.suppress = true;
    S.sessGen++; // DS-R49：登出即身份代数变化，旧在飞响应作废
    const gen0 = S.sessGen; // 扫表 S11：本次登出的代次——8 秒竞速期间若已新登录/被强制下线，收尾不得再把新会话踢回登录页
    try { teardownSession(); } catch (e) {} // X-01：登出请求发出前先拆会话帧，防旧帧又发心跳类请求
    // P1-4a（2026-11-11）：确认的第一时间即写持久登出标记＋内存标记——
    // 必须在 /logout 竞速之前；页面若在登出中途重载，标记已落盘，启动
    // 不复活壳、直接出登录表单。/logout 回来后下面仍会再置一次（幂等）。
    S._manualLogout = true;
    ManualLogout.set();
    try {
      BanLock.exit();
      // P1（2026-11-11）：/logout 请求加 8 秒竞速——旧代码 await api('/logout')
      // 最长约 60 秒（30 秒超时×2 次重试）才放行 showAuth；若请求在 Electron
      // 拦截层挂起，登录表单迟迟不出。8 秒内无回包即放行本地登出，不再等它。
      const lo = await Promise.race([
        api('/logout'),
        new Promise((res) => setTimeout(() => res(null), 8000))
      ]);
      // 批A-W1-6：结果要查——失败也照常本地登出（既定口径），仅 console.warn 留痕、用户无感（DS 门一裁定 (a)）。
      // 判失败只认网络失败/HTTP 错误：/logout 成功回的是页面而非 JSON，不能以 json.ok 判成败（偏差 DEV-1，送门二验收）。
      if (!lo || lo.networkError || lo.status === 0 || lo.status >= 400) console.warn('退出登录请求未成功，已按本地退出处理。', lo && lo.status);
    } finally {
      BanLock.suppress = false;
    }
    if (gen0 !== S.sessGen) return; // 扫表 S11：竞速期间身份已变（新登录/强制下线已接管呈现），旧登出收尾整段作废
    Cache.clear();
    invalidateNodeMap(); // W1-2：主动登出即清设备映射缓存，防换账号残留
    try { if (typeof chatResetAll === 'function') chatResetAll(); } catch (e) { /* 聊天模块异常不得阻断登出 */ }
    try { badgeEpoch++; badgeFlight = null; badgeLastFetch = 0; setFriendBadge(-1); } catch (e) { /* 角标重置异常不得阻断登出 */ }
    S.auth = 'out'; S.user = null; S.displayName = ''; S.isAdmin = false; S.license = null; S.points = null; S.stats = null; clearMyProfile(); // 批A-W1-11：身份字段按 S 默认复位，防换账号残留
    // P1（2026-11-11）：本页内显式登出标记——后续心跳 checkSession 不得凭
    // 残留会话把 S.auth 翻回 'in'（见 checkSessionInner 守门）。
    S._manualLogout = true;
    showAuth('login', { notice: '您已退出登录。' });
    // P1-4a（2026-11-11）兜底改多轮＋真可见性判定：单次 2 秒兜底在 r4 未生效。
    // 表单即便在 DOM 内、authRoot 未 hidden，仍可能因视图层问题不可见；仅判
    // !f/!a/a.hidden 会漏掉“在 DOM 但零尺寸/不可见”的情形。2 秒与 5 秒各查
    // 一次：仍为已登出（S.auth==='out'，防 5 秒内快速重登被冲回登录页）且
    // 表单不存在、authRoot 仍 hidden、或表单零尺寸/display:none/
    // visibility:hidden 即重切一次。
    [2000, 5000].forEach((ms) => {
      setTimeout(() => {
        try {
          if (S.auth !== 'out') return;
          const f = document.getElementById('loginForm');
          const a = document.getElementById('authRoot');
          let vis = false;
          if (f && a && !a.hidden) {
            const r = f.getBoundingClientRect();
            const cs = window.getComputedStyle ? window.getComputedStyle(f) : null;
            vis = r.width > 0 && r.height > 0 && (!cs || (cs.display !== 'none' && cs.visibility !== 'hidden'));
          }
          if (!vis) showAuth('login', { notice: '您已退出登录。' });
        } catch (e) { /* ignore */ }
      }, ms);
    });
  });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setDrawer(false); closeAcctMenu(); closeModal(); } });

/* ---------------- 路由（同框切换，不整页刷新） ---------------- */
const Views = {};
let renderSeq = 0;
function navigate(name, param) {
  const target = '#' + name + (param ? '/' + encodeURIComponent(param) : '');
  if (location.hash === target) { render(); } else { location.hash = target; }
}
function parseRoute() {
  const h = (location.hash || '#home').slice(1);
  const [name, param] = h.split('/');
  let decodedParam = null;
  if (param) {
    try { decodedParam = decodeURIComponent(param); }
    catch (e) { decodedParam = null; } // 批A-W1-9：畸形编码按无参处理，不抛 URIError 中断渲染（DS 门一裁定）
  }
  return { name: name || 'home', param: decodedParam };
}
async function render() {
  if (BanLock.active()) return;   // 锁定 / 会话已结束呈现期间不得渲回主壳
  const seq = ++renderSeq;
  S.route = parseRoute();
  if (S.route.name !== 'session') teardownSession();   // 离开会话路由即拆会话（定时器/监听/预热收编框归位）
  else if (Sess.active && Sess.root && document.contains(Sess.root) && (S.route.param === Sess.name || S.route.param === Sess.nodeid)) return;   // 同会话重复渲染（返回链复位 URL 等）跳过，不重建
  if (S.route.name !== 'forum' && S.route.name !== 'post') { forumListMemo = null; forumMemoArmed = false; }
  if (S._chatStop) { try { S._chatStop(); } catch (e) {} S._chatStop = null; }
  renderNavs();
  const view = $('#view');
  /* F-W3 返工：会话路由单独走 crossfade（B §3.1 D2/E-C）；先摘后挂＋强制回流，同会话切参也重启动画；非会话路由摘掉后回到导航 D3/E-S x+12 */
  view.classList.remove('view-session');
  void view.offsetWidth;
  if (S.route.name === 'session') view.classList.add('view-session');
  const fn = Views[S.route.name] || Views.home;
  view.innerHTML = '';
  try { await fn(view, S.route.param, seq); }
  catch (e) { if (seq === renderSeq) view.innerHTML = stateBox('页面加载失败', '页面组件出现异常，请重新加载。', true), bindRetry(view, render); }
  window.scrollTo(0, 0);
  refreshFriendBadge(false).catch(() => {});
}
window.addEventListener('hashchange', render);

/* ---------------- 壳与未登录区切换 ---------------- */
function showShell() {
  if (BanLock.active()) return;   // 防止 showShell 掀掉锁定界面的 authRoot
  // P1-4a（2026-11-11）：手动登出后（内存或持久标记在），任何路径不得把
  // 壳翻回来——须等一次真实新登录清标记后才能进壳；此处直接出登录表单，
  // 不留空白页。
  if (S._manualLogout || ManualLogout.is()) { showAuth('login', { notice: '您已退出登录。' }); return; }
  $('#authRoot').hidden = true;
  $('#shellRoot').hidden = false;
  var _bf = document.getElementById('bootFail'); if (_bf) _bf.style.display = 'none';   // W4-2 启动兜底隐藏（内联脚本被拦截时的双保险）
  if (!location.hash) location.hash = '#home';
  render();
  startSessionPreheat();   // 登录即预热引擎源（phase-0 E8 承重项，会话打开时收编加速）
}
function showAuth(kind, extra) {
  $('#shellRoot').hidden = true;
  const root = $('#authRoot');
  root.hidden = false;
  var _bf = document.getElementById('bootFail'); if (_bf) _bf.style.display = 'none';   // W4-2 启动兜底隐藏（内联脚本被拦截时的双保险）
  if (kind === 'register') return Views.register(root, extra);
  if (kind === 'gate') return Views.gate(root, extra);
  const lp = Views.login(root, extra);
  if (parseRoute().name === 'appeal') authTool(root, 'appeal');
  return lp;
}

/* ================= 未登录区 ================= */
Views.login = function (root, extra) {
  extra = extra || {};
  root.innerHTML = `<div class="authwrap"><div class="auth">${brandBlock()}
    <h1>登录 QFRemote</h1><p class="psub">使用您的账号和密码登录</p>
    ${extra.notice ? `<div class="note blue">${esc(extra.notice)}</div>` : ''}
    <form id="loginForm">
      <div class="field"><label>账号</label><input id="li-user" autocomplete="username" placeholder="请输入账号"></div>
      <div class="field"><label>密码</label><input id="li-pass" type="password" autocomplete="current-password" placeholder="请输入密码"><p class="ferr" id="li-err" hidden></p></div>
      <label class="check-row check-row-m46 fs-13x5"><input type="checkbox" id="li-rem">记住此设备（30 天内免登录）</label>
      <label class="check-row check-row-m014 fs-13x5"><input type="checkbox" id="li-save">记住账号（下次打开自动填充账号，密码每次手动输入）</label>
      <button class="btn block" id="li-btn" type="submit">登录</button>
    </form>
    <div id="li-freeze" hidden></div>
    <div class="authlinks"><a data-act="go-register">注册新账号</a><a data-act="go-support">忘记密码 / 需要帮助</a></div>
    <div class="note blue">账号被冻结或封禁时，登录后将直接显示原因与申诉入口；试用或密钥到期时，将显示到期时间与购买、激活入口。</div>
    <div id="authTools"></div>
    <button class="kf-btn" data-act="go-support"><span class="tile">${ic('headset')}</span>智能客服<small>未登录也可咨询</small><span class="chev">${ic('chevR')}</span></button>
    <button class="btn block black mt-12" data-act="go-purchase">购买密钥</button>
    <button class="txtlink" data-act="go-status">查询密钥</button>
    <button class="txtlink" data-act="go-rebind">申诉换绑设备</button>
    <div class="foot">勾选「记住此设备」后，登录状态将在本设备保留 30 天</div>
  </div></div>`;
  // #39：恢复两个勾选框的上次状态；存有账号时只回填账号，密码框永不回填（严-1）
  const prefs0 = LoginPrefs.load();
  $('#li-rem', root).checked = prefs0.rem !== false;
  $('#li-save', root).checked = !!prefs0.saveCred;
  if (prefs0.saveCred) { const sc = SavedCred.load(); if (sc) { $('#li-user', root).value = sc.u || ''; } }
  $('#loginForm', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#li-btn', root); const err = $('#li-err', root); const fz = $('#li-freeze', root);
    btn.disabled = true; btn.textContent = '登录中…'; err.hidden = true; if (fz) { fz.hidden = true; fz.innerHTML = ''; }
    const uname = $('#li-user', root).value.trim();
    const remChecked = $('#li-rem', root).checked;
    const saveChecked = $('#li-save', root).checked;
    const r = await doLogin(uname, $('#li-pass', root).value, remChecked);
    if (r.ok) {
      LoginPrefs.save({ rem: remChecked, saveCred: saveChecked });
      if (saveChecked) SavedCred.save(uname); else SavedCred.clear();
    }
    btn.disabled = false; btn.textContent = '登录';
    if (r.ok) {
      const gate = gateFor(S.license);
      if (gate) { showAuth('gate', gate); return; }
      location.hash = '#home';           // #32：登录成功默认落点恒为新首页
      showShell();
      toast('登录成功，欢迎回来。', 'ok');
    } else if (r.frozen && fz) {
      // 账号冻结提示（与垫片冻结弹窗同口径）：写明原因＋申诉入口＋客服指引，
      // 不再让冻结被误显示成「账号或密码不正确」。
      fz.innerHTML = '<div class="note err">该账号今日密码输入错误已超过 5 次，今日不能再试。</div>'
        + '<button class="btn block mt-10" id="li-appeal" type="button">提交申诉</button>'
        + '<p class="hint mt-8">也可以先咨询<a href="#" id="li-fz-support">智能客服</a>，或在客服中申请转人工。</p>';
      fz.hidden = false;
      $('#li-appeal', root).onclick = () => { authTool(root, 'appeal', { user: uname }); const tb = $('#authTools', root); if (tb) tb.scrollIntoView({ block: 'nearest' }); };
      const sup = $('#li-fz-support', root);
      if (sup) sup.onclick = (ev) => { ev.preventDefault(); authTool(root, 'support'); };
    } else if (r.locked && fz) {
      // W1-3：锁定漂移态中性提示（不写封禁/冻结、不露内部原因），给申诉与客服入口。
      fz.innerHTML = '<div class="note err">该账号当前暂时无法登录。</div>'
        + '<div class="hint mt-4">可能是账号状态异常，请稍后再试。</div>'
        + '<button class="btn block mt-10" id="li-lock-appeal" type="button">提交申诉</button>'
        + '<p class="hint mt-8">也可以先咨询<a href="#" id="li-lock-support">智能客服</a>，或在客服中申请转人工。</p>';
      fz.hidden = false;
      $('#li-lock-appeal', root).onclick = () => { authTool(root, 'appeal', { user: uname }); const tb = $('#authTools', root); if (tb) tb.scrollIntoView({ block: 'nearest' }); };
      const lsup = $('#li-lock-support', root);
      if (lsup) lsup.onclick = (ev) => { ev.preventDefault(); authTool(root, 'support'); };
    } else if (r.banned && fz) {
      // 2026-10-28 热修（封禁误报）：账号被封禁或非 B1 冻结且密码正确时，
      // 直接画门：标题/状态/期限/事由/申诉/客服/查询密钥入口，不露原始 code。
      const b = r.ban || { mode: 'banned', permanent: false, endsAt: null };
      const dateStr = b.endsAt ? new Date(b.endsAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '';
      const heading = b.mode === 'frozen' ? '账号已被冻结' : '账号已被封禁';
      let reason = b.mode === 'frozen'
        ? '您的账号已被冻结，当前无法使用本控制台的各项功能。'
        : (b.permanent
            ? '您的账号已被永久封禁，当前无法使用本控制台的各项功能。'
            : '您的账号已被封禁' + (dateStr ? '，预计于 ' + dateStr + ' 解除' : '') + '，当前无法使用本控制台的各项功能。');
      fz.innerHTML = '<div class="note err">' + heading + '</div>'
        + '<div class="note mt-4">' + reason + '</div>'
        + '<div class="hint mt-4">事由：违反平台规则</div>'
        + '<div class="hint mt-8">如您认为该处理存在疑问，可提交申诉或联系智能客服。</div>'
        + '<button class="btn block mt-10" id="li-ban-appeal" type="button">提交申诉</button>'
        + '<p class="hint mt-8">也可以先咨询<a href="#" id="li-ban-support">智能客服</a>，或在客服中申请转人工。'
        + ' <a href="#" id="li-ban-status">查询密钥</a></p>';
      fz.hidden = false;
      $('#li-ban-appeal', root).onclick = () => { authTool(root, 'appeal', { user: uname }); const tb = $('#authTools', root); if (tb) tb.scrollIntoView({ block: 'nearest' }); };
      const sup = $('#li-ban-support', root);
      if (sup) sup.onclick = (ev) => { ev.preventDefault(); authTool(root, 'support'); };
      const st = $('#li-ban-status', root);
      if (st) st.onclick = (ev) => { ev.preventDefault(); authTool(root, 'status', { user: uname }); };
    } else { err.textContent = r.msg; err.hidden = false; }
  });
  root.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', () => {
    const act = el.getAttribute('data-act');
    if (act === 'go-register') showAuth('register');
    if (act === 'go-support') authTool(root, 'support');
    if (act === 'go-purchase') authTool(root, 'purchase');
    if (act === 'go-status') authTool(root, 'status');
    if (act === 'go-rebind') authTool(root, 'rebind');
  }));
};
/* 登录页四入口的同卡工具区（全状态可达：客服/购买/查询/换绑均不要求先登录） */
function authTool(root, kind, opts) {
  const box = $('#authTools', root); if (!box) return;
  if (kind === 'support') { box.innerHTML = ''; Views.support(box, null, 0, { guest: true }); return; }
  if (kind === 'purchase') { box.innerHTML = ''; Views.purchase(box, null, 0, { guest: true }); return; }
  if (kind === 'status') {
    box.innerHTML = `<div class="card mt-16"><h3>查询密钥（账号＋密码核验）</h3>
      <div class="field"><label>账号</label><input id="sq-user"></div>
      <div class="field"><label>密码</label><input id="sq-pass" type="password"></div>
      <button class="btn block" id="sq-btn">查询</button><div class="mt-12" id="sq-out"></div></div>`;
    $('#sq-btn', box).onclick = async () => {
      const r = await api('/license/api/status/query', { method: 'POST', json: { username: $('#sq-user', box).value.trim(), password: $('#sq-pass', box).value } });
      $('#sq-out', box).innerHTML = r.json ? `<div class="note ${r.json.ok ? 'blue' : 'err'}">${esc(r.json.ok ? statusSummary(r.json) : (r.json.msg || '查询失败，请核对账号与密码。'))}</div>` : stateBox('暂时无法查询', '服务暂时不可用，请稍后再试。', false);
    };
    return;
  }
  if (kind === 'rebind') {
    box.innerHTML = `<div class="card mt-16"><h3>申诉换绑设备</h3>
      <p class="text-sub fs-13x5 mb-12">请在<b>新设备</b>上提交：填写账号与密码核验身份，并填写本机设备码。审核通过后，同类槽位的旧设备将被替换，换绑不会被名额已满拦截。</p>
      <div class="field"><label>账号</label><input id="rb-user"></div>
      <div class="field"><label>密码</label><input id="rb-pass" type="password"></div>
      <div class="field"><label>本机设备码</label><input id="rb-dc" placeholder="在新设备的软件端查看"></div>
      <div class="field"><label>设备类型</label><select id="rb-platform"><option value="pc">电脑</option><option value="mobile">手机</option></select></div>
      <div class="field"><label>情况说明</label><textarea id="rb-desc" rows="2" placeholder="例如：更换了新电脑"></textarea></div>
      <button class="btn block" id="rb-btn">提交换绑申诉</button><div class="mt-12" id="rb-out"></div></div>`;
    $('#rb-btn', box).onclick = async () => {
      const r = await api('/license/api/rebind/submit', { method: 'POST', json: { username: $('#rb-user', box).value.trim(), password: $('#rb-pass', box).value, desc: $('#rb-desc', box).value, deviceCode: $('#rb-dc', box).value.trim(), platform: $('#rb-platform', box).value, channel: 'web' } });
      $('#rb-out', box).innerHTML = `<div class="note ${r.json && r.json.ok ? 'ok' : 'err'}">${esc(r.json ? (r.json.msg || (r.json.ok ? '已提交，审核进度可在登录后「我的」中查看。' : '提交失败，请核对信息。')) : '服务暂时不可用，请稍后再试。')}</div>`;
    };
  }
  if (kind === 'appeal') {
    box.innerHTML = '';
    renderAppeal(box, opts || {});
    return;
  }
}
/* 拦截判定：返回 gate 描述或 null（放行进首页） */
function gateFor(me) {
  if (!me || !me.ok) return null;
  if (me.activeBan) return { code: 'BAN', me };
  const d = me.decision || {};
  if (d.allow === false) {
    if (d.code === 'G5' || /过期/.test(d.msg || '')) return { code: 'G5', me };
    if (d.code === 'G2') return { code: 'G2', me };
    if (d.code === 'G4') return { code: 'G4', me };
    if (d.code === 'G1') return null; // #46：未激活只限功能、不限登录——落未激活首页（顶部「尚未激活」条，激活/购买入口可用），与启动恢复会话的落点一致
    return d.code ? { code: d.code, me } : null;
  }
  return null;
}
Views.gate = function (root, extra) {
  extra = extra || {}; const me = extra.me || S.license || {};
  const conf = {
    G1: { t: '尚未激活', b: '本账号还没有激活密钥。在下方输入密钥即可激活；没有密钥可以先购买，或使用积分兑换的密钥。' },
    G2: { t: '试用已到期', b: '免费试用已经结束。激活有效付费密钥后，即可继续使用网页版；积分兑换、赠送等免费来源密钥不包含网页版权益，无法用于开通网页版。' },
    G4: { t: '网页版尚未开通', b: '网页版需要真实付费购买密钥开通（赠送、活动发放与积分兑换等免费来源密钥不含网页版权益）。您仍可在软件端继续使用，或购买付费密钥后回到网页版。' },
    G5: { t: '密钥已过期', b: (typeof me.keyExpiresMs === 'number' && me.keyExpiresMs > 0 ? '您的密钥已于 ' + fmtDate(me.keyExpiresMs) + ' 到期。' : '您的密钥已过期。') + '重新购买或兑换新密钥后即可继续使用。' },
    BAN: { t: '账号已被封禁', b: '封禁事由类别：' + esc((me.activeBan && (me.activeBan.category || me.activeBan.reason)) || '违反平台规则') + '。如有异议，可以提交申诉，审核结果将在申诉进度中显示。' },
    FROZEN: { t: '账号已被冻结', b: '冻结期间暂时无法登录使用，到期后自动解冻；也可以提交申诉提前处理。' }
  }[extra.code] || { t: '暂时无法进入', b: '当前状态下暂时无法进入控制台，请按下方入口处理。' };
  root.innerHTML = `<div class="authwrap"><div class="auth">${brandBlock()}
    <h1>${esc(conf.t)}</h1><p class="psub">${esc(S.displayName || S.user || '')}</p>
    <div class="note ${extra.code === 'BAN' || extra.code === 'FROZEN' ? 'err' : 'blue'}">${conf.b}</div>
    ${(extra.code === 'BAN' || extra.code === 'FROZEN')
      ? `<button class="btn block" id="gt-appeal">提交申诉</button>`
      : `<div class="field"><label>输入激活密钥</label><input id="gt-key" placeholder="粘贴完整密钥串"></div>
         <button class="btn block" id="gt-claim">激活并进入</button>
         <button class="btn block black mt-12" id="gt-buy">购买密钥</button>`}
    <button class="txtlink" id="gt-support">联系智能客服</button>
    <button class="txtlink" id="gt-logout">退出登录</button>
    <div id="gt-tools"></div>
  </div></div>`;
  const claim = $('#gt-claim', root);
  if (claim) claim.onclick = async () => {
    const key = $('#gt-key', root).value.trim();
    if (!key) { toast('请先粘贴密钥。', 'warn'); return; }
    const r = await api('/license/api/transfer/claim', { method: 'POST', json: { key } });
    if (r.json && r.json.ok) { toast('激活成功。', 'ok'); if (await checkSession(true)) { location.hash = '#home'; showShell(); } }
    else toast((r.json && r.json.msg) || '激活失败，请核对密钥后重试。', 'err');
  };
  const buy = $('#gt-buy', root); if (buy) buy.onclick = () => { const b = $('#gt-tools', root); b.innerHTML = ''; Views.purchase(b, null, 0, { guest: S.auth !== 'in' }); };
  const ap = $('#gt-appeal', root);
  if (ap) ap.onclick = () => { const b = $('#gt-tools', root); b.innerHTML = ''; renderAppeal(b, { user: S.user || '' }); };
  $('#gt-support', root).onclick = () => { const b = $('#gt-tools', root); b.innerHTML = ''; Views.support(b, null, 0, { guest: true }); };
  $('#gt-logout', root).onclick = () => doLogout();
};
Views.register = function (root) {
  root.innerHTML = `<div class="authwrap"><div class="auth">${brandBlock()}
    <h1>注册新账号</h1><p class="psub">注册成功后自动开通 3 天免费试用（自注册时刻起满 72 小时）</p>
    <form id="regForm">
      <div class="field"><label>账号</label><input id="rg-user" placeholder="至少 8 位字母与数字组合"><p class="hint">账号注册后不可更改，请谨慎填写。</p></div>
      <div class="field"><label>设置密码</label><input id="rg-pass" type="password" placeholder="请输入密码"></div>
      <div class="field"><label>确认密码</label><input id="rg-pass2" type="password" placeholder="请再次输入密码"></div>
      <label class="check-row check-row-mb14 fs-13x5"><input type="checkbox" id="rg-agree">我已阅读并同意《用户协议》与《隐私说明》</label>
      <div class="note err" id="rg-err" hidden></div>
      <button class="btn block" id="rg-btn" type="submit">注册并开通试用</button>
    </form>
    <div class="authlinks"><span>已有账号？</span><a data-act="back">返回登录</a></div>
    <div class="note warn">同一设备与同一网络地址只能注册一个账号。如提示已注册，请使用原账号登录，或通过申诉处理。</div>
  </div></div>`;
  $('[data-act="back"]', root).onclick = () => showAuth('login');
  $('#regForm', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#rg-err', root); err.hidden = true;
    const u = $('#rg-user', root).value.trim(), p1 = $('#rg-pass', root).value, p2 = $('#rg-pass2', root).value;
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(u)) return fail('账号需为至少 8 位字母与数字组合。');
    if (!p1 || p1.length < 6) return fail('密码长度不足，请设置至少 6 位密码。');
    if (p1 !== p2) return fail('两次输入的密码不一致。');
    if (!$('#rg-agree', root).checked) return fail('请先阅读并同意《用户协议》与《隐私说明》。');
    const btn = $('#rg-btn', root); btn.disabled = true; btn.textContent = '注册中…';
    const r = await api('/api/register', { method: 'POST', json: { username: u, password: p1, password2: p1 } });
    btn.disabled = false; btn.textContent = '注册并开通试用';
    if (r.json && r.json.ok) { toast('注册成功，已开通 3 天免费试用，请登录。', 'ok'); showAuth('login', { notice: '注册成功，请使用新账号登录。' }); }
    else fail((r.json && r.json.msg) || '注册未成功，请稍后再试。');
  });
};

/* ================= 首页（登录落点，#32） ================= */
Views.home = async function (view) {
  const lic = S.license || {};
  const name = esc(S.displayName || S.user || '');
  view.innerHTML = `
    <h1 class="pt">首页</h1><p class="psub">${greetWord()}，${name}。这是您的 QFRemote 总览，点开即在当前页面切换，不再整页跳转。</p>
    <div id="homeLic">${lic.hasKey ? '' : '<div class="skel sk-h46"></div>'}</div>
    <div class="card"><h3>账户安全</h3><div id="homeSec"><div class="skel sk-h52"></div></div></div>
    <div class="card"><h3>我的设备</h3><div id="homeDev"><div class="skel sk-h52"></div></div></div>
    <div class="card"><h3>付费与激活</h3><div id="homePay"><div class="skel sk-h52"></div></div></div>`;
  // 许可条
  const licBox = $('#homeLic', view);
  if (lic.hasKey) {
    const trial = /试用/.test(lic.planName || '');
    const stateTxt = (lic.displayStatus && lic.displayStatus !== '正常') ? lic.displayStatus : (lic.keyLifecycle === 'unactivated' ? '未激活' : (lic.displayStatus || '正常'));
    // #49 首页入口显隐（以 /license/api/me 当前生效钥为准）：永久套餐双入口
    // 皆不显示；时效套餐已激活（keyExpiresMs 已落点）只留「购买叠加」；
    // 试用中与时效未激活（持有未激活钥）按未激活对待，双入口保留。
    const perm = lic.keyPlan === 'permanent' || /永久/.test(lic.planName || '');
    let entries;
    if (perm) entries = '';
    else if (!trial && lic.keyExpiresMs) entries = '<button class="btn sm ghost" data-go="purchase">购买叠加</button>';
    else entries = '<button class="btn sm" data-go="profile">输入密钥激活</button> <button class="btn sm ghost" data-go="purchase">购买密钥</button>';
    licBox.innerHTML = `<div class="note ${trial ? 'blue' : 'ok'}"><b>${esc(lic.planName || '已激活')}</b> · ${esc(stateTxt)}${lic.remainText ? ' · ' + esc(lic.remainText) : (lic.keyExpiresMs ? ' · 到期：' + fmtDate(lic.keyExpiresMs) : '')}${lic.webEnabled ? '' : ' · 网页版购买付费密钥后开通'}${entries ? `<span class="note-ops">${entries}</span>` : ''}</div>`;
  } else {
    licBox.innerHTML = `<div class="note warn"><b>尚未激活</b>　输入密钥激活后即可使用全部功能；没有密钥可以购买，或用积分兑换。<span class="note-ops"><button class="btn sm" data-go="profile">输入密钥激活</button><button class="btn sm ghost" data-go="purchase">购买密钥</button></span></div>`;
  }
  // 账户安全
  // 预取：首页即预热 name→id 映射，避免用户点设备时才冷启（手机每次开页都是冷页）
  fetchNodeMap().catch(() => {});
  const sec = $('#homeSec', view);
  const last = S.stats && S.stats.lastLoginMs ? fmtDate(S.stats.lastLoginMs) : '—';
  sec.innerHTML =
    rowHtml('shield', '账号状态', (lic.displayStatus || '正常') + (lic.everBanned ? ' · 该密钥曾被封禁（已恢复）' : ''), 'profile') +
    rowHtml('lock', '更改密码', '在「我的 · 账号与安全」中修改', 'profile') +
    rowHtml('file', '最近登录', last + ' · 本设备', 'profile');
  // 设备
  const devBox = $('#homeDev', view);
  const devs = (S.stats && S.stats.devices) || [];
  devBox.innerHTML = devs.length ? devs.map(d => devRowHtml(d)).join('') + `<button class="txtlink cardmore" data-go="devices">查看全部设备</button>`
    : deviceEmptyHtml('未添加设备', '未添加设备。被控端安装并上线后会出现在这里。');
  // 付费与激活
  const pay = $('#homePay', view);
  const pts = S.points && (S.points.balance != null ? S.points.balance : (S.points.points != null ? S.points.points : null));
  pay.innerHTML =
    rowHtml('key', '我的密钥', lic.hasKey ? (esc(lic.planName || '') + ' · ' + esc(lic.maskedKey || '')) : '尚未激活', 'profile') +
    rowHtml('cart', '购买密钥', '1 日 2 元 / 7 日 6 元 / 30 日 9.9 元 / 永久 18 元', 'purchase') +
    rowHtml('monitor', '设备名额', `电脑 ${lic.slots ? lic.slots.pc : 0} / ${lic.slots && lic.slots.pcMax ? lic.slots.pcMax : 2} · 手机 ${lic.slots ? lic.slots.mobile : 0} / ${lic.slots && lic.slots.mobileMax ? lic.slots.mobileMax : 1} · 网页版${lic.webEnabled ? '已开通' : '购买付费密钥后开通'}`, 'profile') +
    rowHtml('award', '积分与福利', pts != null ? `当前积分 ${pts} 分 · 200 分兑换 1 日密钥 / 500 分兑换 7 日密钥` : '签到与在线计时赚积分，积分可兑换密钥', 'points');
  view.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => navigate(el.getAttribute('data-go'))));
  bindDevRows(view);
};
function devRowHtml(d) {
  /* 2.4.0 数据携带解析：渲染时能查到节点 id 就直接盖进按钮（data-nodeid），
     点按零等待；查不到的由 refreshDevRowIds 在节点图落地后补盖，再兜底 resolve 端点。
     X-07：共享设备在线态未知时（onlineUnknown）不再写死「离线」——显示
     「状态未知」，且不给远程按钮（未确认在线前不让点进会话）。 */
  const nid = d.nodeid ? bareNodeId(d.nodeid) : nodeIdFor(d.name);
  const nidAttr = nid ? ` data-nodeid="${esc(nid)}"` : '';
  const pill = d.onlineUnknown
    ? '<span class="pill unknown">状态未知</span>'
    : `<span class="pill ${d.online ? 'ok' : 'off'}">${d.online ? '在线' : '离线'}</span>`;
  const ops = d.online
    ? `<button class="btn sm" data-remote="${esc(d.name)}"${nidAttr}>远程桌面</button><button class="btn sm ghost" data-files="${esc(d.name)}"${nidAttr}>文件管理</button>`
    : ''; // 排版深查批2：离线/未知时 .ops 只留详情按钮——此前 ops 内又放一条状态 pill，与外层 pill 重复（「离线」＋「设备离线时不可连接」并列）；状态由外层 pill 承担。
  return `<div class="dev"><span class="devic">${ic('monitor')}</span><span class="devtx"><b>${esc(d.name)}</b><small>${esc(d.os || '')}${d.group ? ' · 分组：' + esc(d.group) : ''}</small></span>${pill}<span class="ops">${ops}<button class="btn sm grey" data-detail="${esc(d.name)}">详情</button></span></div>`;
}
/* 点按反馈：立即置忙＋一句可见文案（本稿唯一新增可见文案，7 字内）＋6s 兜底恢复。
   跳转类（远程桌面/终端）走 CANON 导航，页面会离开，无需回收；导航类（文件/详情）
   走 SPA 内部 navigate，反馈仅作防连点用。 */
function bindDevRows(view) {
  const tap = (el, fn, feedback) => {
    el.onclick = () => {
      if (el.dataset.busy === '1') return; // 防连点重复跳转
      el.dataset.busy = '1';
      let tip = null;
      if (feedback && el.tagName === 'BUTTON') {
        el.disabled = true;
        tip = document.createElement('span');
        tip.className = 'qftap';
        tip.textContent = '正在打开…';
        tip.style.marginLeft = '6px';
        tip.style.opacity = '0.75';
        el.appendChild(tip);
      }
      const release = () => {
        el.dataset.busy = '';
        if (el.tagName === 'BUTTON') el.disabled = false;
        if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
      };
      setTimeout(release, 6000); // 兜底：跳转被拦/失败时恢复可点
      try {
        const r = fn();
        if (r && typeof r.catch === 'function') r.catch(release);
      } catch (e) { release(); }
    };
  };
  view.querySelectorAll('[data-remote]').forEach(el => tap(el, () => openSession('desktop', { name: el.getAttribute('data-remote'), nodeid: el.getAttribute('data-nodeid') }), true));
  view.querySelectorAll('[data-terminal]').forEach(el => tap(el, () => openSession('terminal', { name: el.getAttribute('data-terminal'), nodeid: el.getAttribute('data-nodeid') }), true));
  view.querySelectorAll('[data-files]').forEach(el => tap(el, () => openSession('files', { name: el.getAttribute('data-files'), nodeid: el.getAttribute('data-nodeid') }), true));
  view.querySelectorAll('[data-detail]').forEach(el => tap(el, () => navigate('device', el.getAttribute('data-detail')), false));
}
function ctrlInstanceId() {
  try {
    let v = localStorage.getItem('qfCtrlInstanceId');
    if (!v) {
      const a = new Uint8Array(16);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = Math.floor(Math.random() * 256));
      v = Array.from(a).map(x => x.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('qfCtrlInstanceId', v);
    }
    return v;
  } catch (e) { return ''; }
}
function bareNodeId(id) { return String(id || '').replace(/^node\/\//, '').replace(/^node\//, ''); }
function nodeIdFor(name) {
  if (!name || !nodeMapCache || !nodeMapCache.byName) return '';
  return bareNodeId(nodeMapCache.byName.get(name) || '');
}
/* 节点图落地后把 id 盖进已渲染的设备行按钮（数据携带解析的第一级来源） */
function refreshDevRowIds(root) {
  if (!nodeMapCache) return;
  (root || document).querySelectorAll('[data-remote],[data-terminal],[data-files]').forEach(el => {
    const nm = el.getAttribute('data-remote') || el.getAttribute('data-terminal') || el.getAttribute('data-files');
    const id = nodeIdFor(nm);
    if (id) el.setAttribute('data-nodeid', id);
  });
}
async function resolveDeviceId(name) {
  // W-03：解析独立超时 8 秒、不重试（服务端冷查标称 ≤3 秒）；Views.session
  // 另有 10 秒总闸。默认 30 秒＋GET 自动重试一次最坏拖 60 秒以上。
  const r = await api('/api/device/resolve?name=' + encodeURIComponent(name || ''), { timeoutMs: 8000, retry: false });
  if (r.json && typeof r.json === 'object') return r.json;
  return { ok: false, code: 'TIMEOUT' };
}
function sessionDeepLink(nodeid, vm) {
  return QF_CANON_ORIGIN + '/?node=' + encodeURIComponent(bareNodeId(nodeid)) + '&viewmode=' + vm + '&qfm=frame&hide=31';
}

/* ---------- 预热（phase-0 E8：Chromium 节流冷启 18–39s，预热是承重项） ---------- */
const QF_PRE = { frame: null, nodeid: '', vm: 0, ready: false, t0: 0, warmMs: 0, navGen: 0 };
/* W-08：预热框导航世代号——每次 frameNavigate/location.replace 前 ++navGen，
   onload 闭包捕获当时的世代值，回调首行比对，不符即丢弃（晚到回调不得把正在
   升格的会话框又导航去别的设备）。frameNavigate 本身也 ++navGen（见该函数）。 */
function startSessionPreheat() {
  if (QF_PRE.frame) return;
  const f = document.createElement('iframe');
  f.className = 'qf-preheat'; f.id = 'qfPreheat'; f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
  QF_PRE.t0 = performance.now(); QF_PRE.ready = false;
  f.onload = () => { QF_PRE.ready = true; QF_PRE.warmMs = Math.round(performance.now() - QF_PRE.t0); };
  f.src = QF_CANON_ORIGIN + '/?hide=31&qfm=warm';
  document.body.appendChild(f);
  QF_PRE.frame = f;
}
function upgradePreheat(nodeid, vm) {
  const id = bareNodeId(nodeid);
  /* DS P1-1 硬门禁：会话已升格（Sess.active）或框已非预热态时，设备页的晚到
     回调绝不对活动会话框执行 replace 导航（串设备/断连）。W-14 再加一道：
     路由已切会话即不升级——拦住 teardown→active 之间的 await 窗口。 */
  if (Sess.active || (S && S.route && S.route.name === 'session') || !QF_PRE.frame || !QF_PRE.frame.classList.contains('qf-preheat')) return;
  if (!id) return;
  if (QF_PRE.nodeid === id && QF_PRE.vm === vm) return;
  QF_PRE.nodeid = id; QF_PRE.vm = vm; QF_PRE.ready = false; QF_PRE.t0 = performance.now();
  armFrameLoad(null, null); // W-08：预热导航也带世代校验（只置 ready，不触发 onFrameLoad）
  frameNavigate(sessionDeepLink(id, vm));
}

/* ---------- 会话运行态 ---------- */
const Sess = {
  active: false, gen: 0, root: null, frame: null, adopted: false,
  name: '', nodeid: '', kind: 'desktop', vm: 11, linkedVm: 0, pendingVm: 0, pendingGen: 0,
  state: 'idle', t0: 0, connectMs: 0, reloaded: false, guardN: 0, guardToastShown: false,
  discN: 0, blankSince: 0, timers: [], listeners: [], kbMode: 'auto', trapArmed: false,
  /* W-02 阶段态：iframe-attach → webapp-ready → peer-connecting → video-ready
     （preflight 在 t0 置位前，见 buildSessionFrame；iframe-load 12 秒预算见
     哨兵：onload 后 12 秒 probe 仍为 blank 即 TIMEOUT_IFRAME_LOAD）。
     stageAt 以 performance.now() 计；超时码与文案见 failStage/showSessionMask。 */
  stage: '', stageAt: 0, webappReady: false, preflight: null, maskCode: '', navFallback: '', identityCheck: '',
  sm: null, // S-075：连接状态机（QFSessionSM，纯逻辑；teardown 时清掉）
  forcedConnectN: 0, connectingSince: 0, connectAttempts: [],
  lostSince: 0, lostReloaded: false, reconnectN: 0, lastLostTry: 0,
  /* RC-04：重连会话 id（sess-＋16 hex，首次建连生成，同一会话内复用、新会话
     重置，见 teardownSession）＋重连控制器（QFReconnect，内存态）＋恢复标记。 */
  resumeId: '', reconnectCtl: null, _restoredByReconnect: false,
  /* L5 客户端（RC-03/07/09/10）：中继 id、IDR 请求器、FEC 接收器、画质探针、
     录制控制。只在会话内存活，teardownSession 时全部停掉。 */
  relayId: '', idrCtl: null, fecCtl: null, qualityCtl: null, recCtl: null, backpressureLevel: '',
  lastFailCode: '', lastFailNodeid: '', lastFailVm: 0, morphTries: 0, morphRetryAt: 0, morphTryVm: 0, stageTextSec: -1,
};
let QF_SESS_CTX = null;
function sessOn(target, type, fn, opts) { target.addEventListener(type, fn, opts); Sess.listeners.push([target, type, fn, opts]); }
function teardownSession() {
  Sess.gen++;
  Sess.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
  Sess.timers = [];
  Sess.listeners.forEach(([t, ty, fn, o]) => { try { t.removeEventListener(ty, fn, o); } catch (e) {} });
  Sess.listeners = [];
  if (Sess.frame && Sess.frame === QF_PRE.frame) {
    /* 升格框降格回预热位：只改类名/样式/id（不移动节点、不换 src），文档与连接保持，
       下次同设备打开即零加载收编；异设备由 buildSessionFrame 换 src 一次导航。 */
    const f = Sess.frame;
    f.classList.remove('qf-session-frame'); f.classList.add('qf-preheat');
    f.removeAttribute('style'); f.id = 'qfPreheat'; f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
  }
  // 高-4：遮罩无条件移除——此前只在 frame 是预热框时才移除，全新建的帧走 teardown
  // 会把 #qfSessBackdrop 留在页面上盖住内容且点不透。遮罩是会话级节点，与帧种类无关。
  const bd = document.getElementById('qfSessBackdrop'); if (bd) bd.remove();
  /* W-04/X-01：失败终态的会话降格时，同步清掉预热框的旧身份——失败过的
     nodeid/vm 组合不得被下次复用分支原样升格（否则重进同一设备仍踩旧框）。 */
  if (Sess.state === 'failed' || Sess.lastFailCode) { QF_PRE.nodeid = ''; QF_PRE.vm = 0; QF_PRE.ready = false; }
  Sess.active = false; Sess.trapArmed = false; Sess.root = null; Sess.frame = null; Sess.adopted = false; Sess.state = 'idle';
  Sess.pendingVm = 0;   // DS P2-1：待办形态不跨会话残留
  Sess.stage = ''; Sess.stageAt = 0; Sess.webappReady = false; Sess.stageTextSec = -1;
  Sess.sm = null; // S-075：拆会话即清状态机
  Sess.forcedConnectN = 0; Sess.connectingSince = 0; Sess.connectAttempts = [];
  Sess.lostSince = 0; Sess.lostReloaded = false; Sess.reconnectN = 0; Sess.lastLostTry = 0;
  Sess.morphTries = 0; Sess.morphRetryAt = 0; Sess.morphTryVm = 0;
  /* RC-04：拆会话即作废重连控制器与会话 id——新会话须新 session_id（规范 §1），
     旧票据不得跨会话复用；控制器先停（清定时器、防旧循环在新会话里续跑）。 */
  if (Sess.reconnectCtl) { try { Sess.reconnectCtl.stop('restored', ''); } catch (e) {} Sess.reconnectCtl = null; }
  Sess.resumeId = ''; Sess._restoredByReconnect = false;
  /* L5 客户端全停：探针停、录制 end、FEC 接收器停；控制器置空。 */
  sessStopL5Clients();
}

/* ---------- L5 客户端（RC-03/07/09/10）会话接线 ---------- */
/* RC-07：挂 iframe 之前按宣告列表选址（QF-RELAY-1 §2.2）。
 * 取列表 → pick → 校验待拨 URL（同源 /console-engine/ 深链）→ 异源跳过；
 * 列表为空/取失败/三级耗尽 → 降级态（不建连、不用硬编码地址兜底）。
 * 503 L5_UNAVAILABLE（服务端未加载 L5 模块）同样进降级态。 */
async function sessSelectRelay(view, gen0) {
  let client = null;
  try { client = QFRelayClient({}); } catch (e) { return { ok: false, code: 'L5_UNAVAILABLE' }; }
  const listR = await client.fetchList();
  if (gen0 !== Sess.gen || !Sess.active) return { ok: false, code: 'ABORTED' };
  if (!listR.ok) return { ok: false, code: listR.code === 'L5_UNAVAILABLE' ? 'L5_UNAVAILABLE' : 'RELAY_FETCH_FAILED' };
  const pick = client.pickFor(() => sessionDeepLinkCurrent());
  if (!pick.ok) return { ok: false, code: 'RELAY_DEGRADED', reason: pick.reason };
  Sess.relayId = (pick.relay && pick.relay.id) || '';
  return { ok: true, relay: pick.relay };
}
/* L5 客户端启动（setConnected 后调用）：IDR join、画质探针、FEC 接收器、录制。
 * 各服务失败只影响本功能，不阻断会话；服务端端点未实现时（503）服务返回
 * 码，调用方不伪造成功。 */
function sessStartL5Clients(view) {
  const agentId = bareNodeId(Sess.nodeid || '');
  const sessionId = Sess.resumeId || (Sess.resumeId = qfNewSessionId());
  // RC-03：IDR 请求器＋新观看端 join（绑定后 10s 宽限内发，利用免令牌桶机会）。
  try {
    Sess.idrCtl = QFIdrRequester({});
    if (agentId) Sess.idrCtl.request(sessionId, agentId, 'join').catch(() => {});
  } catch (e) {}
  // RC-03：FEC 接收器（解码端库；分片到达通道在上游帧流内，待捕获埋点落地
  // 后接线 ingest；不可恢复帧触发一次受控 IDR reason=loss）。
  try {
    Sess.fecCtl = QFFecReceiver({
      onUnrecoverable: (frameId) => { try { if (Sess.idrCtl && agentId) Sess.idrCtl.request(sessionId, agentId, 'loss'); } catch (e) {} },
    });
  } catch (e) {}
  // RC-09：画质探针（RTT/丢包/抖动由探针自身往返实测；decodeLag/pendingFrames
  // 取 FEC 接收器待解块数——帧流在 iframe 内，取不到的观测值不填、不伪造）。
  try {
    Sess.qualityCtl = QFQualityProbe({
      sessionId, agentId, idr: Sess.idrCtl,
      collect: () => {
        const q = (Sess.fecCtl && Sess.fecCtl.blocks) ? Sess.fecCtl.blocks.size : 0;
        return { pendingFrames: q };
      },
      onTierChange: (from, to, split) => {
        try { setQualityTierUI(to); } catch (e) {}
        try { if (Sess.fecCtl) Sess.fecCtl.resetOnKeyframe(); } catch (e) {} // 清旧参考帧
        try { if (Sess.recCtl) Sess.recCtl.sendEvent({ type: 'quality-change', at: Date.now(), from, to }); } catch (e) {}
        try { toast(t('quality.autoDown'), 'warn'); } catch (e) {}
      },
      onBackpressure: (level, action) => {
        // 背压执行（QF-QUALITY-1 §5）：L1 降帧率 / L2 降分辨率码率的编码器侧
        // 动作在网页端无法直接执行（画面在 iframe 内）——只记级别、更新画质
        // 行状态，不擅自降档；L3 丢弃到关键帧：清本地参考帧＋受控 IDR。
        Sess.backpressureLevel = level || '';
        try { setQualityBpUI(level, action); } catch (e) {}
        if (level === 'L3') {
          try { if (Sess.fecCtl) Sess.fecCtl.resetOnKeyframe(); } catch (e) {}
          try { if (Sess.idrCtl && agentId) Sess.idrCtl.request(sessionId, agentId, 'loss'); } catch (e) {}
        }
      },
    });
    Sess.qualityCtl.start();
  } catch (e) {}
  // RC-10：录制控制（sessionId 传桌面会话 id 以便关联；POLICY_OFF 默认不录，
  // 不发事件、不提示）。真实输入/剪贴板/关键帧捕获埋点在上游，待落地后接线。
  try {
    Sess.recCtl = QFRecording({});
    Sess.recCtl.start(agentId, '', (Sess.qualityCtl && Sess.qualityCtl.tier) || 'balanced', sessionId).catch(() => {});
  } catch (e) {}
}
function sessStopL5Clients() {
  try { if (Sess.qualityCtl) Sess.qualityCtl.stop(); } catch (e) {}
  Sess.qualityCtl = null;
  try { if (Sess.recCtl && Sess.recCtl.state === 'recording') Sess.recCtl.end().catch(() => {}); } catch (e) {}
  Sess.recCtl = null;
  try { if (Sess.fecCtl) Sess.fecCtl.stop(); } catch (e) {}
  Sess.fecCtl = null;
  Sess.idrCtl = null;
  Sess.relayId = '';
  Sess.backpressureLevel = '';
}
/* 画质设定行更新（设置抽屉内）：当前档位名＋背压级别。 */
function setQualityTierUI(tier) {
  const el = document.getElementById('qfQualityTier');
  if (el) { try { el.textContent = t('quality.tier.' + tier); } catch (e) { el.textContent = tier || ''; } }
}
function setQualityBpUI(level, action) {
  const el = document.getElementById('qfQualityBp');
  if (el) el.textContent = level ? ('背压 ' + level + (action ? ' · ' + action : '')) : '';
}

/* ---------- presence 预检与阶段文案（W-01/W-02/W-12 共用） ---------- */
function fmtAgeMs(ms) {
  if (ms == null || !(ms >= 0)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟前';
  return Math.round(m / 60) + ' 小时前';
}
/* ---------- 防御 (a) 挂载前控制面会话绑定校验（r13 复测阻塞项，DS 定夺发版前必须实现） ----------
   buildSessionFrame 挂 iframe 之前，以控制 WS（/control.ashx，与原生控制台
   同一通道、浏览器凭会话自动鉴权）核对当前会话的可见节点是否包含目标设备。
   W-01 presence 预检只验设备在线、不验会话归属：会话有效但目标不在其可见
   集内时（共享撤销/切号/解析残留），预热框可能仍是旧会话暖页，必须强制走
   W-04 失配重建分支重新导航，不得原样复用。探针本身失败/超时（unknown）
   时不拦挂载（瞬态通道故障不杀会话），挂后 probeFrame/driveConnect 继续兜底。
   预算 CONTROL_PROBE_MS（1500ms，与慢源探测一致）；至多开一条 WS，且在途
   慢探测存在时复用它、不另开（X-05：首屏 WS 数约束）。 */
function controlNodesContain(grouped, nodeid) {
  const want = bareNodeId(nodeid || '');
  if (!want) return false;
  let found = false;
  Object.values(grouped || {}).forEach((arr) => {
    (Array.isArray(arr) ? arr : []).forEach((n) => {
      if (!n || !n._id) return;
      if (bareNodeId(n._id) === want) found = true;
    });
  });
  return found;
}
function probeControlSessionOnce(nodeid, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve(v); } };
    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + '/control.ashx');
    } catch (e) { resolve({ status: 'unknown' }); return; }
    const timer = setTimeout(() => finish({ status: 'unknown' }), timeoutMs || CONTROL_PROBE_MS);
    ws.onopen = () => { try { ws.send(JSON.stringify({ action: 'nodes', responseid: 'qf-sess-identity' })); } catch (e) { clearTimeout(timer); finish({ status: 'unknown' }); } };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.responseid === 'qf-sess-identity') {
        clearTimeout(timer);
        const nodes = m.nodes || {};
        applyControlNodes(nodes); // 回填节点图，不白跑（与慢源探测同款）
        finish({ status: controlNodesContain(nodes, nodeid) ? 'match' : 'mismatch' });
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish({ status: 'unknown' }); };
    ws.onclose = () => { clearTimeout(timer); finish({ status: 'unknown' }); };
  });
}
async function checkSessionIdentity(nodeid) {
  const id = bareNodeId(nodeid || '');
  if (!id) return { status: 'mismatch' };
  const nm = ensureNodeMap();
  if (nm.at && (Date.now() - nm.at) < NODE_MAP_TTL_MS && nm.byId.has(id)) return { status: 'match' };
  if (nodeMapSlowInflight) {
    try { await nodeMapSlowInflight; } catch (e) {}
    return { status: ensureNodeMap().byId.has(id) ? 'match' : 'mismatch' };
  }
  return probeControlSessionOnce(id, CONTROL_PROBE_MS);
}
async function checkPresence(nodeid) {
  const id = bareNodeId(nodeid || '');
  if (!id) return { ok: false, code: 'VALIDATION' };
  try {
    const r = await api('/api/device/presence?nodeid=' + encodeURIComponent(id), { timeoutMs: 8000, retry: false });
    /* W-01：401 判断必须在 JSON 返回之前——通用 api() 对 401 也会解析并
       返回 JSON 体（服务端 presence 路由 401 同回 {ok:false,
       code:'UNAUTHORIZED'}），先认 JSON 会让 AUTH 分支永远走不到，登录
       过期进会话只见 TIMEOUT 遮罩、走不到 sessionDied('preflight')。
       另：JSON 体里 code 为 UNAUTHORIZED 同样当 AUTH（防状态码丢失时漏判）。 */
    if (r && r.status === 401) return { ok: false, code: 'AUTH' };
    if (r && r.json && typeof r.json === 'object') {
      if (r.json.code === 'UNAUTHORIZED') return { ok: false, code: 'AUTH' };
      return r.json;
    }
    return { ok: false, code: 'TIMEOUT' };
  } catch (e) { return { ok: false, code: 'TIMEOUT' }; }
}
function setStage(view, stage) {
  Sess.stage = stage; Sess.stageAt = performance.now();
  const t = STAGE_TEXT[stage] || '正在建立会话…';
  const b = $('#qfBadgeTxt', view); if (b) b.textContent = t.replace(/…$/, '');
  const c = $('#qfConnecting', view);
  if (c) {
    const tt = c.querySelector('.sv-connecting__t'); if (tt) tt.textContent = t;
    const idx = QF_STAGE_MAP[stage];
    const pct = (idx == null) ? null : Math.round(((idx + 1) / QF_STAGE_ORDER.length) * 100);
    Sess.stagePct = pct;
    const items = c.querySelectorAll('#qfStages li');
    items.forEach((li, i) => {
      const st = li.querySelector('.st-t');
      li.classList.toggle('done', idx != null && i < idx);
      li.classList.toggle('now', idx != null && i === idx);
      if (st) st.textContent = (idx != null && i < idx) ? '完成' : (idx != null && i === idx) ? '进行中' : '等待';
    });
    const dev = $('#qfConnDev', view); if (dev) dev.textContent = '目标设备：' + (Sess.name || Sess.nodeid || '') + (pct != null ? ' · ' + pct + '%' : '');
  }
  Sess.stageTextSec = -1;
  try { console.debug('[qf-sess] stage=' + stage); } catch (e) {}
}
/* 每秒刷新一次连接中文案里的已耗时（避免每 250ms 密探都写 DOM）。 */
function refreshStageClock(view) {
  if (!Sess.active || Sess.state !== 'connecting' || !Sess.t0) return;
  const sec = Math.floor((performance.now() - Sess.t0) / 1000);
  if (sec === Sess.stageTextSec) return;
  Sess.stageTextSec = sec;
  const dev = $('#qfConnDev', view);
  if (dev) dev.textContent = '目标设备：' + (Sess.name || Sess.nodeid || '') + ' · 已用 ' + sec + ' 秒' + (Sess.stagePct != null ? ' · ' + Sess.stagePct + '%' : '');
  const now = document.querySelector('#qfStages li.now .st-t');
  if (now) now.textContent = '进行中 · ' + sec + ' s';
}
/* 框内引擎会话对象是否与本会话同一台设备（W-05：probeFrame 的 connected 判定
   与 driveConnect 的 stale 判定共用；currentNode 不存在时不作否定，只认有值且不符）。 */
function frameNodeMatches(w) {
  try {
    const cn = w && w.currentNode;
    if (!cn) return true;
    const id = bareNodeId(cn._id || cn.id || cn.nodeid || '');
    return !id || id === Sess.nodeid;
  } catch (e) { return true; }
}
function frameSessionStale(w, doc) {
  try {
    if (!frameNodeMatches(w)) return true;
    const st = doc && doc.querySelector('#deskstatus');
    const t = st ? String(st.textContent || '') : '';
    if (/disconnect|not connected|断开|未连接/i.test(t)) return true;
  } catch (e) {}
  return false;
}
/* W-08：给预热/会话框装一次带世代校验的 onload（导航前调用）。
   捕获值 g＝下一次导航将产生的 navGen；frameNavigate 里 ++navGen 后两者相等
   才放行。Sess.gen 快照同理——晚到回调拿旧会话世代即丢弃。 */
function armFrameLoad(view, onload) {
  const f = QF_PRE.frame;
  if (!f) return;
  const g = QF_PRE.navGen + 1;
  const sg = Sess.gen;
  f.onload = () => {
    if (g !== QF_PRE.navGen || sg !== Sess.gen) return;
    QF_PRE.ready = true; QF_PRE.warmMs = Math.round(performance.now() - QF_PRE.t0);
    if (typeof onload === 'function') onload();
  };
}

/* 八入口唯一收敛点：kind ∈ desktop/terminal/files；ctx.name 必备，ctx.nodeid 为数据携带 id（可缺） */
function openSession(kind, ctx) {
  ctx = ctx || {};
  const name = ctx.name || '';
  const nodeid = bareNodeId(ctx.nodeid || '') || nodeIdFor(name);
  QF_SESS_CTX = { kind: QF_SESSION_VM[kind] ? kind : 'desktop', name, nodeid };
  try { sessionStorage.removeItem('qfSessClosed'); } catch (e) {}
  if (!name && !nodeid) { navigate('devices'); return; }
  /* 已在会话中再开会话（换设备/邀请打开等）：原地切换，不走 hash 导航——引擎框是
     联合历史的最新导航者时，顶层 hash 赋值会被浏览器回卷并派发 popstate，把导航
     吞回旧会话（影子 rig 实证，联合历史污染即 phase-0 条 12 的本体）。 */
  if (Sess.active && S.route && S.route.name === 'session') {
    const view = $('#view');
    try { history.replaceState(null, '', '#session/' + encodeURIComponent(name || nodeid)); } catch (e) {}
    if (view) { Views.session(view, name || nodeid); return; }
  }
  navigate('session', name || nodeid);
  /* 兜底：hash 导航若仍被联合历史吞掉（会话未在 350ms 内激活），replaceState 复位后直渲 */
  setTimeout(() => {
    if (!Sess.active && QF_SESS_CTX && QF_SESS_CTX.name === name && QF_SESS_CTX.nodeid === nodeid) {
      try { history.replaceState(null, '', '#session/' + encodeURIComponent(name || nodeid)); } catch (e) {}
      render();
    }
  }, 350);
}

function sessionMarkup(name, kind) {
  const capLive = capBridgeLive();
  const capRows = QF_CAP_DEFS.map(c => {
    const on = sessCapOn(c.key);
    const hasPref = typeof sessCaps()[c.key] === 'boolean';
    // X-12（2026-11-14 Q1(a) 新口径）：桥死期开关仍可操作、只记偏好，不置
    // aria-disabled（该属性与可点击矛盾）；aria-checked 反映已记录偏好，
    // 无记录偏好且桥死期时 aria-checked 为 false（不以 def 回落为 ON）；
    // 能力状态由状态文本另行表达：live 时「已开启/已关闭」，死期有记录偏好
    // 时「已记录偏好、能力未接入」，死期无记录偏好时 plain「未接入」。
    const capTxt = capLive ? (on ? '已开启' : '已关闭') : (hasPref ? '已记录偏好、能力未接入' : '未接入');
    const ariaChecked = (capLive || hasPref) ? on : false;
    return `<li><div class="sv-opt sv-opt--set"><span class="sv-opt__ic">${ic(c.icon)}</span><span class="sv-opt__tx"><span class="sv-opt__n">${esc(c.name)}</span><span class="sv-opt__d">${esc(c.desc)}</span></span><span class="sv-opt__s${capLive && on ? ' sv-opt__s--ok' : ''}">${capTxt}</span><button class="sv-opt__k" data-cap="${c.key}" role="switch" aria-checked="${ariaChecked ? 'true' : 'false'}" aria-label="${esc(c.name)}开关"></button></div></li>`;
  }).join('');
  return `<div class="qf-session-layer"><div class="viewer" id="qfViewer" data-morph="${kind}" data-fs="false">
    <header class="sv-bar"><div class="sv-bar__inner">
      <button class="sv-iconbtn" data-act="back" aria-label="返回">${ic('back')}</button>
      <div class="sv-bar__id">
        <span class="sv-title" id="qfTitle">${esc(name || '设备')}</span>
        <span class="sv-badge sv-badge--wait" id="qfBadge" role="status"><i class="sv-badge__dot"></i><span id="qfBadgeTxt">连接中</span></span>
      </div>
      <button class="sv-iconbtn" data-act="fullscreen" aria-label="全屏">${ic('expand')}</button>
      <button class="sv-iconbtn sv-iconbtn--line" data-act="disconnect" aria-label="断开连接">${ic('power')}</button>
    </div></header>
    <main class="sv-stage" id="qfStage">
      <div class="sv-wall" aria-hidden="true"><span class="sv-wall__tag">${ic('monitor')}远程画面</span></div>
      <div class="sv-canvas qf-frame-slot" id="qfFrameSlot" aria-hidden="true"></div>
      <div class="sv-connecting" id="qfConnecting">
        <p class="sv-connecting__t">正在建立会话…</p>
        <p class="sv-connecting__d" id="qfConnDev">目标设备：${esc(name || '')}</p>
        <div class="sv-progress"><div class="sv-progress__bar"></div></div>
        <ol class="sv-stages" id="qfStages">
          <li data-stage="init"><span class="st-dot"></span><span>初始化网络</span><span class="st-t">等待</span></li>
          <li data-stage="resolve"><span class="st-dot"></span><span>解析设备</span><span class="st-t">等待</span></li>
          <li data-stage="auth"><span class="st-dot"></span><span>鉴权</span><span class="st-t">等待</span></li>
          <li data-stage="channel"><span class="st-dot"></span><span>建立通道</span><span class="st-t">等待</span></li>
          <li data-stage="codec"><span class="st-dot"></span><span>协商编码</span><span class="st-t">等待</span></li>
          <li data-stage="firstframe"><span class="st-dot"></span><span>首帧</span><span class="st-t">等待</span></li>
        </ol>
      </div>
      <div class="sv-strip" id="qfStrip" hidden><span class="sv-strip__spin"></span><span class="sv-strip__txt" id="qfStripTxt">连接中断，正在自动重连…</span></div>
      <div class="sv-mask" id="qfMask" hidden><div class="sv-card">
        <h2 class="sv-card__t" id="qfMaskT">无法建立会话</h2>
        <p class="sv-card__d" id="qfMaskD"></p>
        <p class="sv-mask-meta" id="qfMaskMeta"></p>
        <div id="qfMaskCands"></div>
        <div class="sv-card__acts">
          <button class="sv-btn sv-btn--primary" data-act="retry">重试</button>
          <button class="sv-btn" data-act="mask-back">返回设备详情</button>
          <button class="sv-btn" data-act="compat" id="qfCompatBtn" hidden>兼容模式打开</button>
          <button class="sv-btn" data-act="copy-log" id="qfCopyLogBtn">复制诊断日志</button>
        </div>
      </div></div>
    </main>
    <form class="sv-input" id="qfInput" hidden>
      <input class="sv-input__field" id="qfInputField" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="send" placeholder="输入命令，点发送或回车落到终端">
      <button class="sv-iconbtn" type="button" data-act="keyboard" id="qfKbBtn" aria-label="召唤键盘">${ic('keyboard')}</button>
      <button class="sv-iconbtn sv-iconbtn--brand" type="submit" aria-label="发送">${ic('send')}</button>
    </form>
    <footer class="sv-tools">
      <div class="sv-seg" role="tablist" aria-label="会话形态">
        <button class="sv-seg__btn" role="tab" aria-selected="${kind === 'desktop'}" data-morph="desktop">${ic('monitor')}<span>桌面</span></button>
        <button class="sv-seg__btn" role="tab" aria-selected="${kind === 'terminal'}" data-morph="terminal">${ic('terminal')}<span>终端</span></button>
        <button class="sv-seg__btn" role="tab" aria-selected="${kind === 'files'}" data-morph="files">${ic('folder')}<span>文件</span></button>
      </div>
      <div class="sv-acts">
        <button class="sv-iconbtn sv-iconbtn--line sv-actbtn" data-act="settings" aria-label="设定">${ic('gear')}<span class="sv-actbtn__lbl">设定</span></button>
        <button class="sv-iconbtn sv-iconbtn--line sv-actbtn" data-act="send-to-phone" aria-label="发送到手机">${ic('phone')}<span class="sv-actbtn__lbl">发送到手机</span></button>
      </div>
    </footer>
    <button class="sv-fsx" data-act="exit-fullscreen" aria-label="退出全屏">${ic('expand')}<span class="sv-fsx__tx">退出全屏</span></button>
    <div class="sv-scrim" id="qfScrimSend" data-open="false" hidden><div class="sv-sheet" role="dialog" aria-modal="true" aria-labelledby="qfSendTtl">
      <div class="sv-sheet__grab"></div>
      <div class="sv-sheet__h"><div class="sv-sheet__hd"><h3 class="sv-sheet__ttl" id="qfSendTtl">发送到手机</h3></div><button class="sv-sheet__x" data-close="qfScrimSend" aria-label="关闭">${ic('x')}</button></div>
      <div class="sv-sheet__b">
        <div id="qfSendList">
          <ul class="sv-opts"><li><button class="sv-opt" role="radio" aria-checked="true"><span class="sv-opt__ic">${ic('phone')}</span><span class="sv-opt__tx"><span class="sv-opt__n">我的手机</span><span class="sv-opt__d">本账号手机控制器，在「我的文件 · 待接收」领取后打开会话</span></span><span class="sv-opt__r"></span></button></li></ul>
          <div class="sp-h14"></div>
          <button class="sv-btn sv-btn--primary" id="qfSendGo">发送</button>
        </div>
        <div id="qfSendSent" hidden>
          <div class="sv-sheet__ok"><span class="sv-sheet__ok-ic">${ic('check')}</span><p class="sv-sheet__ok-tx">已发送到你的手机，正在打开远程桌面</p></div>
          <div class="sp-h14"></div>
          <button class="sv-btn sv-btn--primary" data-close="qfScrimSend">完成</button>
        </div>
        <div id="qfSendFail" hidden>
          <div class="sv-sheet__fail"><span class="sv-sheet__fail-ic">${ic('x')}</span><p class="sv-sheet__fail-tx" id="qfSendFailTxt">指令未能送达手机，请稍后重试。</p></div>
          <div class="sv-state-acts">
            <button class="sv-btn sv-btn--primary" id="qfSendRetry">重试</button>
            <button class="sv-btn" data-close="qfScrimSend">关闭</button>
          </div>
        </div>
      </div>
    </div></div>
    <div class="sv-scrim" id="qfScrimSettings" data-open="false" hidden><div class="sv-sheet" role="dialog" aria-modal="true" aria-labelledby="qfSetTtl">
      <div class="sv-sheet__grab"></div>
      <div class="sv-sheet__h"><div class="sv-sheet__hd"><h3 class="sv-sheet__ttl" id="qfSetTtl">设定</h3></div><button class="sv-sheet__x" data-close="qfScrimSettings" aria-label="关闭">${ic('x')}</button></div>
      <div class="sv-sheet__b">
        <p class="sv-sheet__lbl">终端键盘</p>
        <ul class="sv-opts">
          <li><button class="sv-opt" data-kbmode="auto" role="radio" aria-checked="${Sess.kbMode !== 'manual'}"><span class="sv-opt__ic">${ic('keyboard')}</span><span class="sv-opt__tx"><span class="sv-opt__n">自动弹出</span><span class="sv-opt__d">点输入行即唤起键盘</span></span><span class="sv-opt__r"></span></button></li>
          <li><button class="sv-opt" data-kbmode="manual" role="radio" aria-checked="${Sess.kbMode === 'manual'}"><span class="sv-opt__ic">${ic('keyboard')}</span><span class="sv-opt__tx"><span class="sv-opt__n">仅点按召唤</span><span class="sv-opt__d">点键盘按钮才唤起，输入行键盘钮实底常亮</span></span><span class="sv-opt__r"></span></button></li>
        </ul>
        <p class="sv-sheet__lbl">${capLive ? '会话能力（全部保留，按新样式重排）' : '会话能力（未接入，仅记录偏好）'}</p>
        <ul class="sv-opts">${capRows}</ul>
        <p class="sv-sheet__lbl">画质</p>
        <p class="sv-sheet__sub"><span id="qfQualityTier">${t('quality.tier.balanced')}</span><span id="qfQualityBp"></span></p>
        <button class="sv-btn" id="qfQualityUpgrade">${t('quality.upgrade')}</button>
        <p class="sv-sheet__sub">网络差时自动降档，恢复后需手动升档；升档须最近 20 秒网络持续健康。</p>
      </div>
    </div></div>
    <div class="sv-scrim" id="qfScrimConfirm" data-open="false" hidden><div class="sv-sheet" role="dialog" aria-modal="true" aria-labelledby="qfCfTtl">
      <div class="sv-sheet__grab"></div>
      <div class="sv-sheet__h"><div class="sv-sheet__hd"><h3 class="sv-sheet__ttl" id="qfCfTtl">断开连接？</h3><p class="sv-sheet__sub">断开后会话将被结束，点底部导航或浏览器返回也会结束会话；你可以随时从设备详情重新连接。</p></div></div>
      <div class="sv-sheet__f">
        <button class="sv-btn sv-btn--danger" id="qfDiscGo">断开并返回</button>
        <button class="sv-btn" data-close="qfScrimConfirm">继续会话</button>
      </div>
    </div></div>
  </div></div>`;
}
function sessCaps() {
  try { return JSON.parse(localStorage.getItem('qfSessCaps') || '{}'); } catch (e) { return {}; }
}
function sessCapOn(key) {
  const c = sessCaps();
  if (typeof c[key] === 'boolean') return c[key];
  const d = QF_CAP_DEFS.find(x => x.key === key);
  return d ? d.def : false;
}
/* 能力驱动桥：优先引擎未来钩子 QFCap(key,on)；其次原生设定对话框控件（选择器映射
   待翻牌日按 phase-0 SELECTORS 纪律实捕后填 QF_CAP_NATIVE_MAP）；都不可用时仅记录
   本地偏好，不假报已生效（DS P1-2）：桥死期状态字三态——有记录偏好时
   「已记录偏好、能力未接入」，无记录偏好时「未接入」；桥活期为「已开启／已关闭」。 */
const QF_CAP_NATIVE_MAP = {};
/* 桥接实况（静态判定）：映射表为空期间桥死期，能力行按有无记录偏好分
   「已记录偏好、能力未接入」／「未接入」两档展示；开关点击时死期只记偏好
   （状态字改「已记录偏好、能力未接入」），活期以 sessApplyCap 的真实返回
   值决定是否翻转状态字（回 false 时不翻、不改、不记）。 */
function capBridgeLive() { return Object.keys(QF_CAP_NATIVE_MAP).length > 0; }
function sessApplyCap(key, on) {
  try {
    const w = Sess.frame && Sess.frame.contentWindow;
    if (w && typeof w.QFCap === 'function') { w.QFCap(key, on); return true; }
    const doc = Sess.frame && Sess.frame.contentDocument;
    const sel = QF_CAP_NATIVE_MAP[key];
    if (doc && sel) { const el = doc.querySelector(sel); if (el) { el.click(); return true; } }
  } catch (e) {}
  return false;
}

/* ---------- 会话视图 ---------- */
Views.session = async function (view, param) {
  teardownSession();
  Sess.active = true; // W-14：active 在 teardown 之后的第一行置位（任何 await 之前），缩窄升级窗口
  const gen = Sess.gen;
  const ctx = (QF_SESS_CTX && (QF_SESS_CTX.name === param || QF_SESS_CTX.nodeid === param)) ? QF_SESS_CTX : null;
  if (!ctx && param) {
    let closed = '';
    try { closed = sessionStorage.getItem('qfSessClosed') || ''; } catch (e) {}
    if (closed && closed === param) { try { sessionStorage.removeItem('qfSessClosed'); } catch (e) {} navigate('devices'); return; }
  }
  const kind = ctx ? ctx.kind : 'desktop';
  let name = ctx ? (ctx.name || '') : '';
  let nodeid = ctx ? bareNodeId(ctx.nodeid || '') : '';
  if (!ctx && param) {
    /* DS P2-3：无 ctx 直达/刷新时 param 可能是裸 nodeid（邀请打开的会话
       URL 规范化为 #session/<nodeid>）——先按 id 反查设备名（byId 映射，
       邀请行同款口径），命中即按 id 定址，不再无条件当设备名解析。 */
    const byIdName = (nodeMapCache && nodeMapCache.byId && nodeMapCache.byId.get(bareNodeId(param))) || '';
    if (byIdName) { nodeid = bareNodeId(param); name = byIdName; }
  }
  if (!name && param && param !== nodeid) name = param;
  if (!nodeid && name) nodeid = nodeIdFor(name);
  Sess.name = name; Sess.nodeid = nodeid; Sess.kind = kind; Sess.vm = QF_SESSION_VM[kind] || 11;
  try { Sess.kbMode = localStorage.getItem('qfKbMode') || 'auto'; } catch (e) { Sess.kbMode = 'auto'; }
  view.innerHTML = sessionMarkup(name, kind);
  const layerEl = view.querySelector('.qf-session-layer');
  if (layerEl) layerEl.classList.add('qf-ext');   // 会话框为 body 级升格框：层转透明让位（见 session.css 正式版补充 3）
  Sess.root = $('#qfViewer', view);
  wireSession(view);
  history.pushState({ qfSessTrap: 1 }, '', location.href);
  Sess.trapArmed = true;
  if (!nodeid && name) {
    // W-03：解析是连接中的第一阶段（文案「正在解析设备…」），总闸 10 秒——
    // 超时即 TIMEOUT 遮罩，不再 await 死等（与 resolve 自身 8 秒叠加最坏 10 秒）。
    setStage(view, 'resolving');
    const r = await Promise.race([
      resolveDeviceId(name).catch(() => ({ ok: false, code: 'TIMEOUT' })),
      new Promise((res2) => setTimeout(() => res2({ ok: false, code: 'TIMEOUT' }), 10000)),
    ]);
    if (gen !== Sess.gen || !Sess.active) return;
    if (r && r.ok && r.nodeid) { nodeid = bareNodeId(r.nodeid); Sess.nodeid = nodeid; if (r.name) { Sess.name = r.name; const t = $('#qfTitle', view); if (t) t.textContent = r.name; } }
    else if (r && r.code === 'NOT_FOUND' && !ctx && param && name === param) {
      /* DS P2-3 兜底：名称解析已确证无此设备名的深链 param 按裸 nodeid
         直达（映射未预热时 byId 反查未命中走此路），不再假报未找到。 */
      nodeid = bareNodeId(param); Sess.nodeid = nodeid;
    }
    else { if (r && r.nodeid) Sess.nodeid = bareNodeId(r.nodeid); showSessionMask(view, (r && r.code) || 'TIMEOUT', r); return; }   // DS P2-2：OFFLINE 等失败响应带 nodeid 时先落 Sess.nodeid，邀请不再必空
  }
  if (!nodeid) { showSessionMask(view, 'NOT_FOUND', null); return; }
  buildSessionFrame(view);
};

function sessionDeepLinkCurrent() { return sessionDeepLink(Sess.nodeid, Sess.vm); }
/* 框导航唯一通道：恒走框内 location.replace —— 框 src 赋值会在联合历史里新增条目，
   且当框的当前条目落后于顶层条目时，提交瞬间把顶层 URL 回卷到框上次导航时的位置
   （影子 rig 实证：会话中切换设备被打回旧会话），replace 只覆写框的当前条目、
   不新增、不回卷（phase-0 条 12「SPA 接管返回语义」的落地式）。 */
function frameNavigate(url) {
  const f = Sess.frame || QF_PRE.frame;
  if (!f) return;
  const sg = Sess.gen; // 扫表 S10：replace 抛错后的 300ms 重试须认会话代次，旧会话的重试不得导航已拆/重建的帧
  QF_PRE.navGen++; // W-08：每次导航递增世代号（armFrameLoad 的闭包据此校验）
  try { f.contentWindow.location.replace(url); return; } catch (e) {
    // X-10：replace 抛错不再无条件回落 src 赋值（src 会在联合历史里新增条目、
    // 把顶层 URL 回卷）。只在帧未挂载（contentWindow 为 null）时才允许 src；
    // 否则先记日志、300ms 后重试一次 replace，两次都失败才 src 并打标记，
    // 供哨兵下一轮 probeFrame 时优先按「可能回卷」处理（即时复位顶层 URL）。
    Sess.navFallback = 'replace-throw';
    try { console.debug('[qf-sess] frameNavigate replace 抛错，300ms 后重试一次。'); } catch (e2) {}
    if (!f.contentWindow) { try { f.src = url; } catch (e2) {} Sess.navFallback = 'src-fallback'; return; }
    setTimeout(() => {
      if (sg !== Sess.gen) return; // 扫表 S10：重试时会话已换代，旧导航作废
      try { f.contentWindow.location.replace(url); }
      catch (e2) { try { f.src = url; } catch (e3) {} Sess.navFallback = 'src-fallback'; }
    }, 300);
  }
}

async function buildSessionFrame(view, preflightResult) {
  Sess.pendingVm = 0; Sess.morphRetryAt = 0; Sess.morphTryVm = 0; // DS P2-1：新一轮构建起算，旧待办形态清零
  Sess.reloaded = false; Sess.guardN = 0; Sess.guardToastShown = false; Sess.discN = 0; Sess.blankSince = 0; Sess.connectN = 0; Sess.lastConnectTry = 0;
  Sess.forcedConnectN = 0; Sess.connectingSince = 0; Sess.connectAttempts = [];
  Sess.lostSince = 0; Sess.lostReloaded = false; Sess.reconnectN = 0; Sess.lastLostTry = 0;
  Sess.maskCode = ''; Sess.navFallback = ''; Sess.preflight = null; Sess.webappReady = false; Sess.identityCheck = '';
  /* W-01 会话建立预检（Sess.t0 置位之前）：先问服务端这台设备在线吗——
     online:false 或 fresh:false（stale）时直接 OFFLINE 遮罩，不挂 iframe；
     预检本身超时/网络失败时回 TIMEOUT 码进遮罩，不静默进框；预检失败不得
     降级为「跳过预检继续建会话」，否则等于没修。结果记入 Sess.preflight
     供哨兵与日志复用。独立总预算 8 秒（checkPresence 内置）。 */
  const gen0 = Sess.gen;
  setStage(view, 'preflight');
  // retryFromMask 已通过的预检可复用（同一 nodeid、刚通过），不重复发请求。
  const pre = (preflightResult && preflightResult.nodeid === Sess.nodeid && preflightResult.code === 'ONLINE')
    ? preflightResult
    : await checkPresence(Sess.nodeid);
  if (gen0 !== Sess.gen || !Sess.active) return;
  Sess.preflight = pre;
  try { console.debug('[qf-sess] preflight node=' + Sess.nodeid + ' code=' + (pre && pre.code)); } catch (e) {}
  if (pre && pre.code === 'AUTH') { sessionDied('preflight'); return; }
  if (!pre || !pre.ok || pre.code === 'TIMEOUT') { Sess.state = 'failed'; showSessionMask(view, 'TIMEOUT', { preflight: pre, stage: 'preflight' }); return; }
  if (pre.code === 'NOT_FOUND') { Sess.state = 'failed'; showSessionMask(view, 'NOT_FOUND', { preflight: pre }); return; }
  if (pre.code === 'OFFLINE' || pre.code === 'STALE' || pre.fresh === false) {
    Sess.state = 'failed';
    showSessionMask(view, 'OFFLINE', { preflight: pre });
    return;
  }
  /* 防御 (a)：W-01 通过后、挂 iframe 之前，以控制 WS 核对会话身份——
     当前会话可见节点含目标设备才算绑定一致；失配（mismatch）时不得复用
     预热框，下方 W-04 门随 identityMismatch 强制走重建分支；探针本身
     失败/超时（unknown）时不拦挂载，记入 Sess.identityCheck 供日志与
     哨兵复用，挂后 probeFrame/driveConnect 继续兜底。 */
  const identity = await checkSessionIdentity(Sess.nodeid);
  if (gen0 !== Sess.gen || !Sess.active) return;
  Sess.identityCheck = identity.status;
  try { console.debug('[qf-sess] identity node=' + Sess.nodeid + ' status=' + identity.status); } catch (e) {}
  const identityMismatch = (identity.status === 'mismatch');
  /* RC-07：挂 iframe 之前按宣告列表选址——列表为空/取失败/三级耗尽时进
     降级态遮罩，不建连、不用硬编码地址兜底（QF-RELAY-1 §2.2/§2.3）。 */
  const relaySel = await sessSelectRelay(view, gen0);
  if (gen0 !== Sess.gen || !Sess.active) return;
  if (!relaySel.ok) {
    if (relaySel.code === 'ABORTED') return;
    Sess.state = 'failed';
    showSessionMask(view, 'RELAY_DEGRADED', { relay: relaySel.code, reason: relaySel.reason || '' });
    return;
  }
  Sess.t0 = performance.now(); Sess.state = 'connecting';
  Sess.sm = QFSessionSM({ now: performance.now() }); // S-075：新会话即建状态机
  setStage(view, 'iframe-attach');
  /* 新一轮构建取代旧终态卡（如从候选列表点选进入）：先收卡，失败再由哨兵重新升卡 */
  const m0 = view.querySelector('#qfMask'); if (m0) m0.hidden = true; Sess.mask = null;
  /* 会话框恒为 body 级永驻框（预热框原地升格）：iframe 换父节点必被浏览器重载
     （影子 rig 微实测证实），故全程不移动节点——同设备同形态直接升格续用，
     异设备只换 src（一次正当导航）。层内 #qfFrameSlot 只作几何标尺。 */
  if (!QF_PRE.frame) startSessionPreheat();
  const f = QF_PRE.frame;
  Sess.linkedVm = Sess.vm;
  /* W-04 复用三重门，缺一即走换 src 重建（不得原样升格失败/未 ready 的旧框）：
     (a) QF_PRE.ready === true；(b) 框内当前文档 href 同时含 node=<id> 与
     qfm=frame（与 probeFrame 的身份口径同款）；(c) 上次会话非 failed 终态
     （同一 nodeid/vm 组合失败过不得复用，见 showSessionMask 的 lastFail 记录）。 */
  let reuseOk = false;
  if (QF_PRE.nodeid === Sess.nodeid && QF_PRE.vm === Sess.vm && QF_PRE.ready === true
      && !identityMismatch // 防御 (a)：控制 WS 核对失配时强制重建，不得原样复用预热框
      && !(Sess.lastFailCode && Sess.lastFailNodeid === Sess.nodeid && Sess.lastFailVm === Sess.vm)) {
    try {
      const href = String(f.contentWindow && f.contentWindow.location.href || '');
      reuseOk = href.indexOf('node=' + Sess.nodeid) >= 0 && href.indexOf('qfm=frame') >= 0;
    } catch (e) { reuseOk = false; }
  }
  if (!reuseOk) {
    QF_PRE.nodeid = Sess.nodeid; QF_PRE.vm = Sess.vm; QF_PRE.ready = false; QF_PRE.t0 = performance.now();
    Sess.frame = f;
    armFrameLoad(view, () => onFrameLoad(view, Sess.gen)); // W-08：换 src 导航带世代校验
    frameNavigate(sessionDeepLinkCurrent());
  } else {
    armFrameLoad(view, () => onFrameLoad(view, Sess.gen));
    onFrameLoad(view, Sess.gen);
  }
  let bd = document.getElementById('qfSessBackdrop');
  if (!bd) { bd = document.createElement('div'); bd.id = 'qfSessBackdrop'; bd.className = 'qf-session-backdrop'; }
  if (bd.nextSibling !== f) f.parentNode.insertBefore(bd, f);
  f.classList.remove('qf-preheat'); f.classList.add('qf-session-frame');
  f.id = 'qfFrame'; f.title = '远程画面'; f.setAttribute('aria-label', '远程画面');
  f.removeAttribute('aria-hidden'); f.tabIndex = 0;
  Sess.frame = f; Sess.adopted = true;
  /* 顶层 URL 规范化：本会话路由应恒为当前会话（防引擎内部历史回卷，条 12） */
  try { const want = '#session/' + encodeURIComponent(Sess.name || Sess.nodeid); if (location.hash !== want) history.replaceState(null, '', want); } catch (e) {}
  syncSessionFrameGeometry();
  setTimeout(() => syncSessionFrameGeometry(), 80);
  startSentinel(view);
}
/* 会话框几何 = 层内标尺槽的视口矩形（槽带 .sv-canvas 类，几何与 DS 画布全等） */
function syncSessionFrameGeometry() {
  const f = Sess.frame, slot = document.getElementById('qfFrameSlot');
  if (!f || !slot || !slot.isConnected) return;
  const r = slot.getBoundingClientRect();
  f.style.left = r.left + 'px'; f.style.top = r.top + 'px';
  f.style.width = Math.max(0, Math.round(r.width)) + 'px'; f.style.height = Math.max(0, Math.round(r.height)) + 'px';
  try { const br = getComputedStyle(slot).borderRadius; if (br) f.style.borderRadius = br; } catch (e) {}
}

function onFrameLoad(view, gen) {
  // W-08：onload 首行双重世代校验（armFrameLoad 的闭包已验过一次，此处再验
  // 直接调用方传的世代——复用分支同步调用时 gen 即当前 Sess.gen）。
  if (gen != null && gen !== Sess.gen) return;
  if (!Sess.active) return;
  injectFrameGuard();
  injectFrameReady(); // §5.1：往框内插 ready 探针脚本（同源才插得进，跨域降级见该函数）
  if (Sess.stage === 'iframe-attach') setStage(view, 'iframe-load');
  setTimeout(() => driveConnect(), 700);
  if (Sess.pendingVm) {
    const pv = Sess.pendingVm, pg = Sess.pendingGen;
    Sess.pendingVm = 0; Sess.morphRetryAt = 0;
    /* DS P2-1：消费时校验世代——待办形态须为当前会话世代登记者，
       跨会话/跨构建残留一律丢弃，不把下一会话切去旧形态。 */
    if (pv !== Sess.linkedVm && pg === Sess.gen) { Sess.linkedVm = pv; if (tryGo(pv)) Sess.morphTries = 0; }
  }
}
function injectFrameGuard() {
  try {
    const doc = Sess.frame && Sess.frame.contentDocument;
    if (!doc || !doc.head || doc.getElementById('qfGuardStyle')) return;
    const st = doc.createElement('style');
    st.id = 'qfGuardStyle';
    st.textContent = '#masthead,#page_leftbar,#topbar,#footer{display:none!important}';
    doc.head.appendChild(st);
  } catch (e) {}
}
/* §5.1 webapp-ready 探针（2.4.5 P1 增强，非必选项的落地）：
   与 injectFrameGuard 同位置、同源检查——往框内插一段小脚本，等引擎出现
   currentNode 或 #deskstatus 即向父层 postMessage qf-remote-webapp-ready。
   父层监听（wireSession 里注册）验 event.source 与 event.origin，防任意页面冒充。
   插不进去（跨域直连 :8443）或 MC 页升级覆盖导致脚本丢失时，不死等消息：
   onFrameLoad 后 15 秒仍按 probe 信号推进（哨兵的 webapp-ready 超时分支里，
   probe 已为 binding 即视为引擎已起、直接进 peer-connecting，不落超时遮罩）。 */
function injectFrameReady() {
  try {
    const f = Sess.frame;
    const doc = f && f.contentDocument;
    if (!doc || !doc.head || doc.getElementById('qfReadyScript')) return;
    const sc = doc.createElement('script');
    sc.id = 'qfReadyScript';
    sc.textContent = '(function(){var done=false;function fire(){if(done)return;done=true;try{window.parent.postMessage({type:"qf-remote-webapp-ready"},location.origin);}catch(e){}}'
      + 'function check(){try{if(window.currentNode||document.getElementById("deskstatus")){fire();return;}}catch(e){}setTimeout(check,300);}'
      + 'if(document.readyState==="complete")check();else window.addEventListener("load",check);setTimeout(check,300);})();';
    doc.head.appendChild(sc);
  } catch (e) { /* 跨域插不进：哨兵按 probe 信号降级，不报错、不卡住 */ }
}
function onWebappReadyMessage(ev) {
  try {
    if (!ev || !ev.data || ev.data.type !== 'qf-remote-webapp-ready') return;
    if (!Sess.active || !Sess.frame) return;
    if (ev.source !== Sess.frame.contentWindow) return;
    if (ev.origin !== location.origin) return;
    if (Sess.webappReady) return;
    Sess.webappReady = true;
    try { console.debug('[qf-sess] webapp-ready 收到。'); } catch (e) {}
    if (Sess.state === 'connecting' && Sess.stage === 'webapp-ready') {
      const view = $('#view');
      if (view) setStage(view, 'peer-connecting');
    }
  } catch (e) {}
}
function tryGo(vm) {
  try {
    const w = Sess.frame && Sess.frame.contentWindow;
    if (w && typeof w.go === 'function') { w.go(vm); return true; }
  } catch (e) {}
  return false;
}

/* 热修 2026-10-30（DS flash 轻审已过，必改项全采纳）：深链直达设备页时引擎不自连
   （自连只在引擎设备列表点击流里），由 SPA 在绑定完成后代为触发引擎连接。
   守卫：仅 connecting/lost 态（W-07：lost 态每 5 秒重连也走本函数）、帧已绑定目标设备
   （与探针同一身份口径）、引擎无对话框；节流 ≥4s、20 秒滚动窗口内 ≤6 次
   （W-06：原单轮总额 6 次耗尽后永久静默，改为窗口滚动计数）。
   contype 取 1（引擎直建分支，与引擎内部调用及 rig 实证一致）：contype 3 对
   agent.id<=4 的设备先走会话查询、框内等不到回执会空转（笔记本实测），故不用；
   直建分支不经会话选择器，无误点面。
   返回值：是否实际调了一次 connect*（哨兵 lost 态据此计真实重连次数）。 */
function driveConnect() {
  try {
    if (!Sess.active || (Sess.state !== 'connecting' && Sess.state !== 'lost') || !Sess.frame) return false;
    const w = Sess.frame.contentWindow, doc = Sess.frame.contentDocument;
    if (!w || !doc) return false;
    const href = String(w.location.href || '');
    if (href.indexOf('node=' + Sess.nodeid) < 0 || href.indexOf('qfm=frame') < 0) return false;
    if (w.xxdialogMode) return false;
    const now = performance.now();
    if (Sess.lastConnectTry && now - Sess.lastConnectTry < 4000) return false;
    // W-06：20 秒滚动窗口内 ≤6 次（窗口外的时间戳清掉），不是单轮总额。
    const attempts = (Sess.connectAttempts || []).filter((t) => now - t < 20000);
    Sess.connectAttempts = attempts;
    if (attempts.length >= 6) return false;
    const st = doc.querySelector('#deskstatus');
    const stTxt = st ? String(st.textContent || '') : '';
    // W-06：引擎自称 connecting 不再是永久免干预——先给 8 秒宽限，超 8 秒仍
    // connecting 且引擎会话对象未建立（或已 stale），SPA 主动补调一次（上限 2 次）。
    if (/connecting|setup|连接中/i.test(stTxt)) {
      if (!Sess.connectingSince) Sess.connectingSince = now;
      if (now - Sess.connectingSince < 8000) return false;
      if ((Sess.forcedConnectN || 0) >= 2) return false;
      if (w.desktop && !frameSessionStale(w, doc)) return false;
      let forced = false;
      if (Sess.vm === 11 && w.currentNode && typeof w.connectDesktop === 'function') { w.connectDesktop(null, 1); forced = true; }
      else if (Sess.vm === 12 && w.currentNode && typeof w.connectTerminal === 'function') { w.connectTerminal(null, 1); forced = true; }
      else if (Sess.vm === 13 && w.currentNode && typeof w.connectFiles === 'function') { w.connectFiles(null); forced = true; }
      if (forced) {
        Sess.lastConnectTry = now; Sess.connectN = (Sess.connectN || 0) + 1; Sess.connectAttempts.push(now);
        Sess.forcedConnectN = (Sess.forcedConnectN || 0) + 1;
        try { console.debug('[qf-sess] 引擎 connecting 超 8 秒，SPA 补调 connect（第 ' + Sess.forcedConnectN + ' 次）。'); } catch (e) {}
        return true;
      }
      return false;
    }
    Sess.connectingSince = 0;
    let acted = false;
    // W-06：!w.desktop 改为 !w.desktop || stale——旧会话对象残留（currentNode
    // 已不是本台、或状态文本已是 disconnect）时也重建，不再认 stale 对象。
    if (Sess.vm === 11 && (!w.desktop || frameSessionStale(w, doc)) && w.currentNode && typeof w.connectDesktop === 'function') { w.connectDesktop(null, 1); acted = true; }
    else if (Sess.vm === 12 && (!w.terminal || frameSessionStale(w, doc)) && w.currentNode && typeof w.connectTerminal === 'function') { w.connectTerminal(null, 1); acted = true; }
    else if (Sess.vm === 13 && (!w.files || frameSessionStale(w, doc)) && w.currentNode && typeof w.connectFiles === 'function') { w.connectFiles(null); acted = true; }
    if (acted) { Sess.lastConnectTry = now; Sess.connectN = (Sess.connectN || 0) + 1; Sess.connectAttempts.push(now); }
    return acted;
  } catch (e) { return false; }
}

/* W-02 阶段超时落点：专用码＋阶段名＋已耗时间＋connectN/重载信息（文案见
   showSessionMask 的 TIMEOUT_* 分支）。同时记 lastFail，供 W-04 复用门禁。 */
function failStage(view, code, stageName) {
  Sess.state = 'failed';
  Sess.lastFailCode = code; Sess.lastFailNodeid = Sess.nodeid; Sess.lastFailVm = Sess.vm;
  showSessionMask(view, code, { stage: stageName, elapsedMs: Math.round(performance.now() - Sess.t0), connectN: Sess.connectN || 0, reloaded: !!Sess.reloaded, preflight: Sess.preflight || null });
}

/* 哨兵：onload＋8 秒同源尺寸/结构观察＋三级错误卡（空白/被拒/无 id），
   兼容模式顶层打开为用户主动触发的第 3 级（DS-DESIGN 哨兵规格）。
   2.4.5（W-02/W-07）：阶段超时阶梯——iframe-attach 8s / iframe-load 12s /
   webapp-ready 15s / peer-connecting 25s / video-ready 20s；总闸 30 秒兜底
   （深查原规格：总闸缩到 30 秒且只重载一次的语义不变——连接 20 秒未完成
   自动重载一次，Sess.reloaded 只许一次，总闸按首次 t0 计、不因重载顺延；
   任一阶段超时或总闸到即按该阶段落专用码遮罩）。
   lost 态（W-07）不再无限挂着：进 lost 记 lostSince，每 5 秒主动重连一次
   （真实次数进条文），30 秒未恢复自动重建一次，重建后仍 lost 满 20 秒落 FAIL。 */
function startSentinel(view) {
  let tickN = 0;
  const tick = () => {
    if (!Sess.active || !Sess.frame) return;
    tickN++;
    Sess.timers.push(setTimeout(tick, tickN < 12 ? 250 : 700));   // 前密后疏：连接建立期 250ms 密探（徽标时延），稳定后 700ms
    /* 顶层 URL 规范化守卫（条 12）：引擎内部历史若把顶层 URL 回卷到别处，
       以 replaceState 静默复位本会话路由（不触发渲染）；用户退出走 popstate
       链与 exitSession（Sess.active 先置假），不被本守卫打架。 */
    try { const want = '#session/' + encodeURIComponent(Sess.name || Sess.nodeid); if (location.hash !== want) history.replaceState(null, '', want); } catch (e) {}
    injectFrameGuard();
    /* URL 规范化守卫：框内逃逸（丢 qfm 标记）拉回 hide 形态，上限 3 次防循环；
       X-18：第 4 次逃逸不再放任，直接落 FAIL 遮罩（不再是裸引擎页、无提示）。 */
    try {
      const href = Sess.frame.contentWindow.location.href;
      if (href && href.indexOf('about:blank') !== 0 && href.indexOf('qfm=') < 0 && Sess.state !== 'failed') {
        if (Sess.guardN < 3) {
          Sess.guardN++;
          armFrameLoad(view, () => onFrameLoad(view, Sess.gen)); // W-08：拉回导航也重装世代校验
          frameNavigate(sessionDeepLinkCurrent());
          if (!Sess.guardToastShown) { Sess.guardToastShown = true; toast('已回到会话界面。', 'info'); }
          return;
        }
        Sess.state = 'failed'; showSessionMask(view, 'FAIL', { reason: 'guard-escape' }); return;
      }
    } catch (e) {}
    const p = probeFrame();
    const now = performance.now();
    if (p === 'reject') { Sess.state = 'failed'; showSessionMask(view, 'REJECT', null); return; }
    if (Sess.state === 'connecting') {
      refreshStageClock(view);
      /* S-075：每 tick 把探针信号喂给连接状态机（QFSessionSM，qf-runtime.js）：
         只有状态机走到 HEALTHY（video 首帧＋input 通道双达标且稳定一周期）
         才显「已连接」；INPUT_READY 段 20 秒未达标即落 TIMEOUT_INPUT_READY。
         其余各段的超时仍由下方 W-02 阶段阶梯执行（与状态机同预算、同码）。 */
      if (Sess.sm) {
        Sess.sm.observe(p, { inputReady: sessInputReady() }, now);
        const to = Sess.sm.checkTimeout(now);
        if (to && to.failed && to.failed.state === 'INPUT_READY') { failStage(view, 'TIMEOUT_INPUT_READY', 'input-ready'); return; }
      }
      if (p === 'connected') { if (!Sess.sm || Sess.sm.state === 'HEALTHY') { setConnected(view); return; } /* 未 HEALTHY：等状态机走完 input 段，不提前显已连接 */ }
      if (p === 'videopending') {
        if (Sess.stage !== 'video-ready') setStage(view, 'video-ready');
        else if (now - Sess.stageAt > 20000) { failStage(view, 'TIMEOUT_VIDEO_READY', 'video-ready'); return; }
      } else if (p === 'binding') {
        if (Sess.stage === 'iframe-load') setStage(view, 'webapp-ready');
        else if (Sess.stage === 'webapp-ready' && Sess.webappReady) setStage(view, 'peer-connecting');
        else if (Sess.stage === 'webapp-ready' && now - Sess.stageAt > 15000) {
          // §5.1 fallback：15 秒没收到 ready 消息、但 probe 已是 binding——
          // 引擎已起（消息丢了或同源注入不可用），按 probe 信号推进，不死等。
          setStage(view, 'peer-connecting');
        }
        driveConnect();
      } else if ((p === 'blank') || (p === 'lost')) {
        driveConnect(); // 帧尚未绑定目标文档时 driveConnect 内部的 href 身份口径会自行拦下
      }
      // 阶段超时阶梯（每阶段只看本阶段内耗时）＋总闸 30 秒兜底（W-02 深查原规格）。
      if (Sess.stage === 'iframe-attach' && now - Sess.stageAt > 8000) { failStage(view, 'TIMEOUT_IFRAME_LOAD', 'iframe-attach'); return; }
      if (Sess.stage === 'iframe-load' && now - Sess.stageAt > 12000) { failStage(view, 'TIMEOUT_IFRAME_LOAD', 'iframe-load'); return; }
      if (Sess.stage === 'webapp-ready' && !Sess.webappReady && now - Sess.stageAt > 15000 && p === 'blank') { failStage(view, 'TIMEOUT_WEBAPP_READY', 'webapp-ready'); return; }
      if (Sess.stage === 'peer-connecting' && now - Sess.stageAt > 25000) { failStage(view, 'TIMEOUT_PEER_CONNECTING', 'peer-connecting'); return; }
      // W-02：连接 20 秒未完成且尚未重载过，自动重载一次（只许一次）：重建帧、
      // 阶段回到 iframe-attach、连接计数清零；总闸按首次 t0 计，不因重载顺延，
      // 重载后最多再给 10 秒（30 秒总闸到即 FAIL）。failStage 经 reloaded 透传，
      // FAIL 遮罩「已自动重载过一次」只在真的重载过时才出现（非死文案）。
      if (!Sess.reloaded && now - Sess.t0 > 20000) {
        Sess.reloaded = true; Sess.connectN = 0; Sess.lastConnectTry = 0; Sess.connectingSince = 0; Sess.connectAttempts = [];
        setStage(view, 'iframe-attach');
        armFrameLoad(view, () => onFrameLoad(view, Sess.gen)); // W-08：重载导航也重装世代校验
        try { frameNavigate(sessionDeepLinkCurrent()); } catch (e) {}
        try { console.debug('[qf-sess] 连接 20 秒未完成，自动重载一次。'); } catch (e2) {}
        return;
      }
      if (now - Sess.t0 > 30000) { failStage(view, 'TIMEOUT', 'connecting'); return; }
    } else if (Sess.state === 'connected') {
      if (p === 'lost') { setLost(view); return; }
      retryPendingMorph(view); // X-11：已连接态待办形态到点自动再试一次 go()（只一次，两次失败才弹确认）
      if (p === 'blank') {
        if (!Sess.blankSince) Sess.blankSince = now;
        else if (now - Sess.blankSince > 16000) { Sess.state = 'failed'; showSessionMask(view, 'FAIL', null); return; }
      } else Sess.blankSince = 0;
    } else if (Sess.state === 'lost') {
      /* S-075：lost 态同样喂状态机（重连恢复须再走一遍 input 段才显已连接）。 */
      if (Sess.sm) Sess.sm.observe(p, { inputReady: sessInputReady() }, now);
      if (p === 'connected') { if (!Sess.sm || Sess.sm.state === 'HEALTHY') { setConnected(view); return; } }
      if (p === 'reject') { Sess.state = 'failed'; showSessionMask(view, 'REJECT', null); return; }
      // RC-04：重连由 QFReconnect 控制器驱动（setLost 起，5 次/5 秒/凭据即停/
      // 取消停循环）；哨兵只负责探针与终态判定，不再无限 driveConnect、不再
      // 30 秒自动重建帧。控制器终态（耗尽/凭据/取消）由 onStop 落遮罩或改条文。
    }
  };
  Sess.timers.push(setTimeout(tick, 250));
}
/* S-075：input 通道是否就位——引擎会话对象在位且 currentNode 是本台。 */
function sessInputReady() {
  try {
    const w = Sess.frame && Sess.frame.contentWindow;
    if (!w) return false;
    const hasEngine = Sess.vm === 11 ? !!w.desktop : Sess.vm === 12 ? !!w.terminal : !!w.files;
    return hasEngine && frameNodeMatches(w);
  } catch (e) { return false; }
}
function probeFrame() {
  let doc = null, w = null;
  try { w = Sess.frame.contentWindow; doc = Sess.frame.contentDocument; } catch (e) { return 'blank'; }
  if (!doc || !doc.body) return 'blank';
  /* 身份先行：框内当前文档必须是本会话目标设备的融合页——预热暖页（qfm=warm）
     本身也带桌面画布与 Connected 字样，帧导航未提交时误判「已连接」即假绿
     （影子 rig 重载荷实证）。非目标文档一律按绑定中处理。 */
  try {
    const href = String(w.location.href || '');
    if (href.indexOf('node=' + Sess.nodeid) < 0 || href.indexOf('qfm=frame') < 0) return 'binding';
  } catch (e) { return 'binding'; }
  try {
    if (/login/i.test(w.location.pathname || '') || doc.querySelector('#loginform, form[action*="login" i]')) return 'reject';
  } catch (e) {}
  const st = doc.querySelector('#deskstatus');
  const stTxt = st ? String(st.textContent || '') : '';
  if (/disconnect|not connected|断开|未连接/i.test(stTxt)) return 'lost';
  const desk = doc.querySelector('#Desk');
  /* W-05：桌面形态的「已连接」须三重成立——状态文本给出完整 Connected（Connecting
     不算）＋画布有尺寸＋引擎会话对象真实存在且 currentNode 是本台设备（只看
     文本与画布会在引擎尚在加载/串设备时假绿）。文本已 Connected 但画布仍为 0
     时回 videopending（引擎已连、画面通道未就绪，走 video-ready 阶段超时）。 */
  if (Sess.vm === 11 && (/^\s*connected\b/i.test(stTxt) || stTxt.indexOf('已连接') >= 0)) {
    if (desk && desk.width > 10 && desk.height > 10 && w.desktop && frameNodeMatches(w)) return 'connected';
    if (desk) return 'videopending'; // 画布元素已在、但尺寸/会话对象未就绪：画面通道未就绪
    // #Desk 元素尚未出现：仍在绑定中，落到下方的 binding/blank 判定
  }
  /* X-19：终端/文件形态不再只看容器 offsetParent（静态容器加载完即存在，与
     通道连通无关）。终端须引擎终端会话对象存在且 currentNode 是本台；文件须
     列表容器已渲染出条目或明确的空目录文案。未达标一律判 binding（继续等），
     宁可晚绿、不假绿。 */
  if (Sess.vm === 12) {
    const p12 = doc.querySelector('#p12');
    if (p12 && p12.offsetParent !== null && (w.terminal || (w.currentNode && frameNodeMatches(w)))) return 'connected';
  }
  if (Sess.vm === 13) {
    const p13 = doc.querySelector('#p13');
    if (p13 && p13.offsetParent !== null) {
      const txt = String(p13.textContent || '').trim();
      const hasEntry = !!p13.querySelector('[data-file], .file, tr, li, a');
      const emptyNote = /空目录|没有文件|暂无文件|empty/i.test(txt);
      if (hasEntry || emptyNote) return 'connected';
    }
  }
  if (desk || doc.querySelector('#p11')) return 'binding';
  return 'blank';
}
function setBadge(view, kind, txt) {
  const b = $('#qfBadge', view); if (!b) return;
  b.className = 'sv-badge' + (kind ? ' sv-badge--' + kind : '');
  const t = $('#qfBadgeTxt', view); if (t) t.textContent = txt;
}
function setConnected(view) {
  Sess.state = 'connected';
  Sess.stage = 'video-ready';
  Sess.connectMs = Math.round(performance.now() - Sess.t0);
  // 成功连上即清失败标记（W-04：下次同设备同形态可正常复用预热框）。
  Sess.lastFailCode = ''; Sess.lastFailNodeid = ''; Sess.lastFailVm = 0;
  Sess.lostSince = 0; Sess.lostReloaded = false; Sess.reconnectN = 0; Sess.lastLostTry = 0;
  /* RC-04：若本次是由重连恢复的，Toast 一声；随后为下次掉线申领一张新票据
     （只存内存，旧票据已消费/过期不复用；部署的服务端未加载该端点时 issue() 回 404，
     控制器记 endpointMissing、走 legacy 路径，不伪造成功）。 */
  const wasReconnected = !!Sess._restoredByReconnect;
  Sess._restoredByReconnect = false;
  if (Sess.reconnectCtl) { try { Sess.reconnectCtl.stop('restored', ''); } catch (e) {} Sess.reconnectCtl = null; }
  if (wasReconnected) { try { toast(t('reconnect.restored'), 'ok'); } catch (e) {} }
  if (Sess.nodeid) {
    try {
      const ctl = QFReconnect({ deviceId: bareNodeId(Sess.nodeid), sessionId: Sess.resumeId || (Sess.resumeId = qfNewSessionId()) });
      Sess.reconnectCtl = ctl;
      ctl.issue().catch(() => {});
    } catch (e) {}
  }
  const c = $('#qfConnecting', view); if (c) c.hidden = true;
  const s = $('#qfStrip', view); if (s) s.hidden = true;
  setBadge(view, '', '已连接');
  /* L5 客户端启动：IDR join、画质探针、FEC 接收器、录制（RC-03/09/10）。 */
  try { sessStartL5Clients(view); } catch (e) {}
  if (Sess.name) { try { localStorage.setItem('qfLastSessionDevice', Sess.name); } catch (e) {} }
  // X-11：连上后若有待办形态切换，重试一次 go()（setMorph 的等待路径）。
  if (Sess.pendingVm && Sess.pendingGen === Sess.gen) {
    const pv = Sess.pendingVm; Sess.pendingVm = 0; Sess.morphRetryAt = 0;
    if (pv !== Sess.linkedVm && tryGo(pv)) { Sess.linkedVm = pv; Sess.morphTries = 0; }
  }
}
function setLost(view) {
  if (Sess.state !== 'lost') { Sess.lostSince = performance.now(); Sess.reconnectN = 0; Sess.lastLostTry = 0; }
  Sess.state = 'lost';
  if (Sess.sm) Sess.sm.reset(performance.now()); // S-075：掉线即重建状态机，恢复须再走完 input 段
  Sess.discN++;
  const s = $('#qfStrip', view); if (s) s.hidden = false;
  const t = $('#qfStripTxt', view); if (t) t.textContent = '连接中断，正在自动重连…';
  setBadge(view, 'retry', '重连中');
  // RC-04：进 lost 即起重连控制器（上限 5 次、间隔 5 秒、凭据失败立即停、
  // 取消按钮停循环；重连期间输入短路）。票据在 setConnected 时已申领，
  // 无票据（端点未加载/申领失败）时走 legacy driveConnect 路径。
  try { sessEnsureReconnect(view); } catch (e) {}
}
/* RC-04 网页客户端重连控制器接线（规范 §5.2，L1 票据规范 v1）。
 * 控制器是 QFReconnect（qf-runtime.js），本函数只做会话视图侧的接线：
 * 次数文案、取消按钮、legacy 尝试（driveConnect，钉住函数原样调用）、
 * 恢复判定（probeFrame() === 'connected'，钉住函数原样调用）、终态落点。 */
function sessEnsureReconnect(view) {
  let ctl = Sess.reconnectCtl;
  if (ctl && ctl.state === 'reconnecting') return; // 已在跑，不重复起
  if (!ctl || ctl.state === 'restored' || ctl.state === 'stopped') {
    ctl = QFReconnect({ deviceId: bareNodeId(Sess.nodeid || ''), sessionId: Sess.resumeId || (Sess.resumeId = qfNewSessionId()) });
    Sess.reconnectCtl = ctl;
  }
  // 取消按钮（只挂一次）：点后停循环，不再自动重连
  const strip = $('#qfStrip', view);
  if (strip && !strip.querySelector('[data-act="reconnect-cancel"]')) {
    const btn = document.createElement('button');
    btn.className = 'sv-btn sm';
    btn.setAttribute('data-act', 'reconnect-cancel');
    btn.textContent = t('reconnect.cancel');
    btn.onclick = () => { try { Sess.reconnectCtl && Sess.reconnectCtl.cancel(); } catch (e) {} };
    strip.appendChild(btn);
  }
  ctl.start({
    onAttempt(n, max) {
      Sess.reconnectN = n;
      const tx = $('#qfStripTxt', view);
      if (tx) tx.textContent = t('reconnect.attempt', { n, max });
    },
    onLegacyAttempt() { return driveConnect(); },
    onLegacyOk() { try { return probeFrame() === 'connected'; } catch (e) { return false; } },
    onRestored() {
      try { driveConnect(); } catch (e) {} // 票据恢复后补调一次引擎连接，探针确认后 setConnected 收尾
      Sess._restoredByReconnect = true;
    },
    onStop(reason, code) { sessReconnectStopped(view, reason, code); }
  });
}
function sessReconnectStopped(view, reason, code) {
  if (reason === 'restored') return; // 内部停（已恢复/拆会话），无终态动作
  if (reason === 'cancelled') {
    const tx = $('#qfStripTxt', view);
    if (tx) tx.textContent = t('reconnect.cancelled');
    setBadge(view, 'retry', '已取消重连');
    return;
  }
  // 凭据失败（吊销/过期/换绑/重授权）与 5 次耗尽：落 FAIL 遮罩，手动重试入口在遮罩上
  if (reason === 'credential') { try { toast(t('reconnect.stoppedCredential'), 'err'); } catch (e) {} }
  else if (reason === 'exhausted') { try { toast(t('reconnect.exhausted'), 'err'); } catch (e) {} }
  Sess.state = 'failed';
  showSessionMask(view, 'FAIL', { reason: 'lost-reconnect' });
}
function showSessionMask(view, code, r) {
  const m = $('#qfMask', view); if (!m) return;
  const T = $('#qfMaskT', view), D = $('#qfMaskD', view), cands = $('#qfMaskCands', view);
  const retry = view.querySelector('[data-act="retry"]'), back = view.querySelector('[data-act="mask-back"]'), compat = $('#qfCompatBtn', view);
  const cn = $('#qfConnecting', view); if (cn) cn.hidden = true;
  if (cands) cands.innerHTML = '';
  if (compat) compat.hidden = true;
  if (retry) retry.className = 'sv-btn sv-btn--primary';
  if (back) back.className = 'sv-btn';
  Sess.maskCode = code;
  const pre = (r && r.preflight) || Sess.preflight || null;
  const lastSeenTxt = pre && pre.lastAgentPong ? ('（最后在线：' + fmtAgeMs(pre.lastAgentPongAgeMs) + '）') : '';
  // W-04：帧级失败（FAIL/TIMEOUT*）记 lastFail——同一 nodeid/vm 组合下次不得复用旧框。
  if (/^(FAIL|TIMEOUT)/.test(code)) { Sess.lastFailCode = code; Sess.lastFailNodeid = Sess.nodeid; Sess.lastFailVm = Sess.vm; }
  if (code === 'REJECT') {
    T.textContent = '无法建立会话';
    D.textContent = '你没有这台设备的远程控制权限，请联系设备管理员为你开通。';
    if (back) back.className = 'sv-btn sv-btn--primary';
    if (retry) retry.className = 'sv-btn';
  } else if (code === 'OFFLINE') {
    T.textContent = '设备当前不在线';
    // W-13：一键修复在手机控笔记本的场景下没有可执行能力（修复脚本是 Windows
    // 侧的 qf-agent-heal.ps1，手机跑不了），绝不放点了没反应的假按钮；改为
    // 文字指引＋重试（重试走 W-12 的 presence 预检路径）。
    D.textContent = '设备离线时无法建立会话' + lastSeenTxt + '。请确认设备已开机联网，或在电脑上重启 Mesh Agent 服务（开始菜单搜索「服务」→找到 Mesh Agent→重新启动），然后点重试。';
    if (back) back.className = 'sv-btn sv-btn--primary';
    if (retry) retry.className = 'sv-btn';
  } else if (code === 'AMBIGUOUS') {
    T.textContent = '找到多台同名设备';
    D.textContent = '请选择要连接的设备：';
    if (cands && r && Array.isArray(r.candidates)) {
      cands.innerHTML = r.candidates.map(c => `<button class="sv-btn m-4-4-0" data-cand="${esc(c.nodeid)}">${esc(c.name || c.nodeid)}${c.online ? '' : '（离线）'}</button>`).join('');
      cands.querySelectorAll('[data-cand]').forEach(b => b.onclick = () => {
        Sess.nodeid = bareNodeId(b.getAttribute('data-cand'));
        m.hidden = true;
        const cn2 = $('#qfConnecting', view); if (cn2) cn2.hidden = false;
        buildSessionFrame(view);
      });
    }
  } else if (code === 'NOT_FOUND') {
    T.textContent = '无法定位这台设备';
    D.textContent = '未能取得设备的连接标识，请稍后重试，或使用兼容模式打开。';
    if (compat) compat.hidden = false;
  } else if (code === 'TIMEOUT_IFRAME_LOAD' || code === 'TIMEOUT_WEBAPP_READY' || code === 'TIMEOUT_PEER_CONNECTING' || code === 'TIMEOUT_VIDEO_READY' || code === 'TIMEOUT_INPUT_READY') {
    // W-02/W-13：阶段超时专用分支（不再落入通用 else）——阶段名＋已耗秒数＋下一步。
    const stageName = (r && r.stage) || '';
    const secs = (r && typeof r.elapsedMs === 'number') ? Math.round(r.elapsedMs / 1000) : null;
    const stageCn = { 'iframe-attach': '加载会话框', 'iframe-load': '加载控制台页面', 'webapp-ready': '启动控制台', 'peer-connecting': '连接设备', 'video-ready': '建立画面通道', 'input-ready': '确认输入可用', preflight: '检查设备在线状态' }[stageName] || '建立连接';
    T.textContent = '连接超时';
    D.textContent = '在「' + stageCn + '」阶段等待' + (secs != null ? '超过 ' + secs + ' 秒' : '') + '仍未完成'
      + (code === 'TIMEOUT_PEER_CONNECTING' ? '：设备可能离线或 agent 未响应，请确认设备在线后重试。' : '，请检查网络后重试。')
      + '（诊断码：' + code + '）';
    if (compat) compat.hidden = false;
  } else if (code === 'TIMEOUT') {
    T.textContent = '连接超时';
    const stageCn = (r && r.stage === 'preflight') ? '检查设备在线状态' : '建立连接';
    const secs = (r && typeof r.elapsedMs === 'number') ? Math.round(r.elapsedMs / 1000) : null;
    D.textContent = '在「' + stageCn + '」阶段等待' + (secs != null ? '超过 ' + secs + ' 秒' : '') + '仍未完成，请检查网络后重试。（诊断码：TIMEOUT）';
    if (compat) compat.hidden = false;
  } else if (code === 'RELAY_DEGRADED') {
    // RC-07 降级态（QF-RELAY-1 §2.3）：只保留已建会话＋文件暂存通道，不新开
    // 桌面会话；重试入口即遮罩重试按钮（清空 failedIds、重新取宣告列表）。
    T.textContent = '中继全部不可用';
    D.textContent = (r && r.relay === 'L5_UNAVAILABLE')
      ? t('relay.unavailable') + '（诊断码：L5_UNAVAILABLE）。'
      : t('relay.degraded') + '（诊断码：RELAY_DEGRADED）。';
    if (retry) retry.className = 'sv-btn sv-btn--primary';
  } else { /* FAIL */
    T.textContent = '会话组件加载失败';
    const detail = [];
    if (r && r.reason === 'guard-escape') detail.push('会话页面多次偏离');
    if (r && r.reason === 'lost-reconnect') detail.push('连接中断且重连失败');
    if (r && typeof r.connectN === 'number') detail.push('已尝试连接 ' + r.connectN + ' 次');
    if (r && r.reloaded) detail.push('已自动重载过一次');
    D.textContent = (detail.length ? detail.join('，') + '。' : '') + '请检查网络与设备状态后重试。（诊断码：FAIL）';
    if (compat) compat.hidden = false;
  }
  /* C §2.5 错误页：错误码＋发生时间＋会话 ID＋已尝试步骤（真实计数，不编） */
  const meta = $('#qfMaskMeta', view);
  if (meta) {
    const d = new Date();
    const ts = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    const tried = [];
    if (r && typeof r.connectN === 'number') tried.push('已尝试连接 ' + r.connectN + ' 次');
    if (r && r.reloaded) tried.push('已自动重载 1 次');
    if (r && r.stage) tried.push('卡在「' + (r.stage || '') + '」阶段');
    meta.textContent = '错误码 ' + code + ' · 发生时间 ' + ts + ' · 会话 ID ' + (Sess.nodeid || '—') + (tried.length ? ' · ' + tried.join('；') : '');
  }
  m.hidden = false;
}

/* ---------- 会话内交互 ---------- */
function wireSession(view) {
  const root = Sess.root;
  const SCRIMS = ['qfScrimSend', 'qfScrimSettings', 'qfScrimConfirm'];
  const openSheet = (id) => SCRIMS.forEach(s => { const el = document.getElementById(s); if (!el) return; if (s === id) { el.hidden = false; void el.offsetWidth; el.dataset.open = 'true'; } else { el.dataset.open = 'false'; el.hidden = true; } });
  const closeSheet = (id) => { const el = document.getElementById(id); if (el) { el.dataset.open = 'false'; el.hidden = true; } };
  const closeAllSheets = () => SCRIMS.forEach(s => closeSheet(s));
  const anySheetOpen = () => SCRIMS.some(s => { const el = document.getElementById(s); return el && el.dataset.open === 'true'; });
  Sess._closeAllSheets = closeAllSheets; Sess._anySheetOpen = anySheetOpen;
  root.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeSheet(b.getAttribute('data-close')));
  root.querySelectorAll('.sv-seg__btn').forEach(b => b.onclick = () => setMorph(view, b.getAttribute('data-morph')));
  const act = (n) => root.querySelector('[data-act="' + n + '"]');
  act('settings').onclick = () => openSheet('qfScrimSettings');
  act('send-to-phone').onclick = () => { resetSendSheet(view); openSheet('qfScrimSend'); };
  act('fullscreen').onclick = () => setFs(view, root.dataset.fs !== 'true');
  act('exit-fullscreen').onclick = () => setFs(view, false);
  act('disconnect').onclick = () => openSheet('qfScrimConfirm');
  act('back').onclick = () => { if (!sessionBackChain(view)) exitSession(); };
  act('retry').onclick = () => retryFromMask(view);
  /* RC-09 手动升档（QF-QUALITY-1 §4.2）：仅在健康时可点，拒绝时展示服务端
     code 对应的原因；升档后 10s 观察窗内被降回记一次乒乓（服务端判定）。 */
  const qUp = $('#qfQualityUpgrade', view);
  if (qUp) qUp.onclick = async () => {
    if (!Sess.qualityCtl) { toast(t('quality.noHealthWindow'), 'warn'); return; }
    qUp.disabled = true;
    try {
      const r = await Sess.qualityCtl.upgrade();
      if (r && r.ok) { setQualityTierUI(Sess.qualityCtl.tier); toast(t('quality.upgraded'), 'ok'); }
      else if (r) {
        const msg = { AT_TOP: t('quality.atTop'), NOT_HEALTHY: t('quality.notHealthy'), NO_HEALTH_WINDOW: t('quality.noHealthWindow'), PINGPONG_COOLDOWN: t('quality.pingpong') }[r.code];
        toast(msg || (r.msg || r.code || ''), 'warn');
      }
    } catch (e) { toast(t('quality.noHealthWindow'), 'warn'); }
    qUp.disabled = false;
  };
  /* MOBILE-FIX 2026-11-14（F-02）：mask-back（失败遮罩里的“返回设备详情”）
     保持直接退出，不另弹确认——它是显式安全出口：遮罩只在会话未能建立时
     出现，此时没有进行中的会话可保护；进行中的会话仍走断开确认（bnav／
     返回／顶栏断开按钮均先弹确认单）。 */
  act('mask-back').onclick = () => exitSession();
  const copyLog = act('copy-log');
  if (copyLog) copyLog.onclick = async () => {
    const meta = $('#qfMaskMeta', view);
    const txt = 'QFRemote 诊断日志\n' + (meta ? meta.textContent : '') + '\n' + ($('#qfMaskD', view) ? $('#qfMaskD', view).textContent : '');
    try { await navigator.clipboard.writeText(txt); toast('诊断日志已复制，包含会话 ID 与错误码。', 'ok'); /* C §5.1 */
    } catch (e) { toast('复制失败，请手动记录错误码。', 'warn'); }
  };
  act('compat').onclick = () => {
    /* 兼容模式＝用户主动触发的顶层打开（哨兵第 3 级），离开融合视图、事后审计有记 */
    const url = Sess.nodeid ? sessionDeepLink(Sess.nodeid, Sess.vm).replace('&qfm=frame&hide=31', '') : QF_CANON_ORIGIN;
    location.assign(url);
  };
  $('#qfDiscGo', view).onclick = () => exitSession();
  wireSendSheet(view);
  /* 设定：终端键盘二选项（DS2 §1.3/§4.3；[data-kb="manual"] 机制，D-11） */
  root.querySelectorAll('[data-kbmode]').forEach(o => o.onclick = () => {
    Sess.kbMode = o.getAttribute('data-kbmode');
    try { localStorage.setItem('qfKbMode', Sess.kbMode); } catch (e) {}
    root.querySelectorAll('[data-kbmode]').forEach(x => x.setAttribute('aria-checked', x === o ? 'true' : 'false'));
    updateKbBtn(view);
  });
  updateKbBtn(view);
  /* 设定：能力开关（偏好持久化＋驱动桥尝试）。DS P1-2：先问驱动桥；
桥未接入时只记偏好，状态字示「已记录偏好、能力未接入」，绝不置「已开启/已关闭」生效态；
桥已接入时 sessApplyCap 返回 false 不翻 aria-checked、不改状态字、不记偏好。 */
  root.querySelectorAll('[data-cap]').forEach(o => o.onclick = () => {
    const key = o.getAttribute('data-cap');
    const on = o.getAttribute('aria-checked') !== 'true';
    // X-12（2026-11-14 Q1(a)）：桥未接入时只记偏好，aria-checked 反映已记录
    // 偏好故随之翻转，状态 chip 改为「已记录偏好、能力未接入」（去掉 --ok 类），
    // 并 toast 明示暂不生效。
    if (!capBridgeLive()) {
      const c0 = sessCaps(); c0[key] = on;
      try { localStorage.setItem('qfSessCaps', JSON.stringify(c0)); } catch (e) {}
      o.setAttribute('aria-checked', on ? 'true' : 'false');
      const chip0 = o.parentElement.querySelector('.sv-opt__s');
      if (chip0) { chip0.textContent = '已记录偏好、能力未接入'; chip0.classList.remove('sv-opt__s--ok'); }
      toast('该能力尚未接入引擎，开关仅记录偏好，暂不生效。', 'info');
      return;
    }
    const applied = sessApplyCap(key, on);
    if (!applied) return; // sessApplyCap 回 false 时不得翻 aria-checked
    o.setAttribute('aria-checked', on ? 'true' : 'false');
    const c = sessCaps(); c[key] = on;
    try { localStorage.setItem('qfSessCaps', JSON.stringify(c)); } catch (e) {}
    const chip = o.parentElement.querySelector('.sv-opt__s');
    if (chip) {
      if (applied) { chip.textContent = on ? '已开启' : '已关闭'; chip.classList.toggle('sv-opt__s--ok', on); }
    }
  });
  /* 终端输入行（bp-form 820 以下、终端形态显示；DS2 §4.3 软键盘 dvh 锁高在下方视口监听） */
  const form = $('#qfInput', view), field = $('#qfInputField', view);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = field.value;
    if (!v) return;
    /* DS P2-4：发送失败必须可见——不清空输入行、明示未送达，不静默吞。 */
    if (sendTermText(v + '\r')) field.value = '';
    else toast('未能送入终端（终端输入未就绪），内容已保留在输入行，连接稳定后请重试。', 'warn');
  });
  $('#qfKbBtn', view).onclick = () => { field.focus(); };
  field.addEventListener('focus', () => { if (Sess.kbMode === 'auto') updateKbBtn(view); });
  /* 返回链（A4 合并）：sheet → 全屏 → 断开确认 → 设备详情（确认已开时再退＝真退出）。
     浏览器返回先于本处理把 URL 改到上一条，链内消化时以 pushState 复位会话 URL
     （伴随的同会话渲染由 render 的活性守卫跳过）；链走完直接 exitSession 收尾。 */
  sessOn(window, 'popstate', () => {
    if (!Sess.active || !Sess.trapArmed) return;
    if (sessionBackChain(view)) {
      history.pushState({ qfSessTrap: 1 }, '', '#session/' + encodeURIComponent(Sess.name || Sess.nodeid));
    } else { Sess.trapArmed = false; exitSession(); }
  });
  sessOn(document, 'fullscreenchange', () => {
    if (!Sess.active) return;
    root.dataset.fs = document.fullscreenElement ? 'true' : 'false';
    setTimeout(() => syncSessionFrameGeometry(), 60);
  });
  sessOn(window, 'resize', () => syncSessionFrameGeometry());
  /* §5.1：webapp-ready 探针消息监听（验 source 与 origin，见 onWebappReadyMessage）；
     sessOn 登记、teardownSession 时随会话一并注销。 */
  sessOn(window, 'message', onWebappReadyMessage);
  sessOn(document, 'keydown', (e) => {
    if (!Sess.active || e.key !== 'Escape') return;
    if (anySheetOpen()) { closeAllSheets(); return; }
    if (root.dataset.fs === 'true') setFs(view, false);
  });
  /* 软键盘弹出时以 visualViewport 高度锁定会话层（dvh 锁高，DS2 §4.3） */
  if (window.visualViewport) {
    const layer = view.querySelector('.qf-session-layer');
    const onVv = () => {
      if (!Sess.active || !layer) return;
      const vv = window.visualViewport;
      if (vv.height < window.innerHeight * 0.78) { layer.style.height = vv.height + 'px'; layer.style.top = vv.offsetTop + 'px'; }
      else { layer.style.height = ''; layer.style.top = ''; }
      syncSessionFrameGeometry();
    };
    sessOn(window.visualViewport, 'resize', onVv);
  }
  applyMorphChrome(view);
}
function sessionBackChain(view) {
  /* 返回 true＝链内消化（留在会话）；false＝链已走完（应退出到设备详情） */
  if (Sess._anySheetOpen && Sess._anySheetOpen()) {
    const c = document.getElementById('qfScrimConfirm');
    /* MOBILE-FIX 2026-11-14（F-02）：确认单已开时再按返回＝关闭确认单、留在
       会话里（即“继续会话”），拦截并消费这次返回；旧写法此处 return false
       直接退出会话，第二次返回绕过了确认（大肥鱼：若真实会话复现应升 P1）。 */
    if (c && c.dataset.open === 'true') { Sess._closeAllSheets(); return true; }
    Sess._closeAllSheets(); return true;
  }
  if (Sess.root && Sess.root.dataset.fs === 'true') { setFs(view, false); return true; }
  const c = document.getElementById('qfScrimConfirm');
  if (c) { c.hidden = false; void c.offsetWidth; c.dataset.open = 'true'; }
  return true;
}
async function retryFromMask(view) {
  const m = $('#qfMask', view); if (m) m.hidden = true;
  const cn = $('#qfConnecting', view); if (cn) cn.hidden = false;
  setBadge(view, 'wait', '连接中');
  const gen = Sess.gen;
  // W-12：重试统一先调 presence 预检（8 秒预算）——在线＋fresh 才重建；
  // 离线/stale 直接重画 OFFLINE 遮罩（带「最后在线 X 分钟前」）；预检超时落
  // TIMEOUT 遮罩。重试成功后 Sess.reloaded 复位为 false（恢复完整额度），
  // 不要像原来那样预先把哨兵的一次重载额度消耗掉。
  if ((Sess.maskCode === 'NOT_FOUND' || Sess.maskCode === 'OFFLINE' || Sess.maskCode === 'TIMEOUT' || Sess.maskCode === 'AMBIGUOUS' || /^TIMEOUT_/.test(Sess.maskCode || '') || Sess.maskCode === 'FAIL') && Sess.name && !Sess.nodeid) {
    resolveDeviceId(Sess.name).then(r => {
      if (gen !== Sess.gen || !Sess.active) return;
      if (r && r.ok && r.nodeid) { Sess.nodeid = bareNodeId(r.nodeid); Sess.reloaded = false; buildSessionFrame(view); }
      else showSessionMask(view, (r && r.code) || 'TIMEOUT', r);
    }).catch(() => { if (gen === Sess.gen) showSessionMask(view, 'TIMEOUT', null); });
    return;
  }
  if (Sess.nodeid) {
    setStage(view, 'preflight');
    const pre = await checkPresence(Sess.nodeid);
    if (gen !== Sess.gen || !Sess.active) return;
    Sess.preflight = pre;
    if (pre && pre.code === 'AUTH') { sessionDied('preflight'); return; }
    if (!pre || !pre.ok || pre.code === 'TIMEOUT') { Sess.state = 'failed'; showSessionMask(view, 'TIMEOUT', { preflight: pre, stage: 'preflight' }); return; }
    if (pre.code === 'NOT_FOUND') { Sess.state = 'failed'; showSessionMask(view, 'NOT_FOUND', { preflight: pre }); return; }
    if (pre.code === 'OFFLINE' || pre.code === 'STALE' || pre.fresh === false) { Sess.state = 'failed'; showSessionMask(view, 'OFFLINE', { preflight: pre }); return; }
    // 预检通过：完整重建（reloaded 复位，阶段与计数清零），不再直接 frameNavigate。
    Sess.reloaded = false;
    buildSessionFrame(view, pre);
    return;
  }
  // 无 nodeid 又无 name：无从重试，回设备列表。
  exitSession();
}
function exitSession() {
  const name = Sess.name;
  teardownSession();
  QF_SESS_CTX = null;
  /* A4 收尾：当前条目 replaceState 为设备详情（不留会话条目）；历史里更深一层的
     旧会话条目以 sessionStorage 关闭标记拦截重开（Views.session 入口校验）。 */
  try { sessionStorage.setItem('qfSessClosed', name || ''); } catch (e) {}
  try { history.replaceState(null, '', name ? ('#device/' + encodeURIComponent(name)) : '#devices'); } catch (e) {}
  render();
  startSessionPreheat();
}
function setFs(view, on) {
  const root = Sess.root; if (!root) return;
  root.dataset.fs = on ? 'true' : 'false';
  setTimeout(() => syncSessionFrameGeometry(), 60);
  try {
    if (on) { const p = root.requestFullscreen && root.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
    else if (document.fullscreenElement) { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); }
  } catch (e) {}
}
function applyMorphChrome(view) {
  const form = $('#qfInput', view);
  if (form) form.hidden = !(Sess.kind === 'terminal' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches);
  if (Sess.kind === 'terminal' && Sess.kbMode === 'auto' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches) {
    const f = $('#qfInputField', view); if (f) setTimeout(() => { try { f.focus({ preventScroll: true }); } catch (e) {} }, 350);
  }
}
/* X-11：形态切换「重建前确认」框（setMorph 第二次失败与哨兵自动重试第二次
   失败共用）：不静默断连，用户点了才 frameNavigate 重建；取消则留在原形态。 */
function askMorphRebuild(view) {
  const kindCn = Sess.kind === 'terminal' ? '终端' : (Sess.kind === 'files' ? '文件管理' : '桌面');
  const gen0 = Sess.gen; // 扫表 S9：确认框等待期间会话已拆/重建（新会话也是 active），旧确认不得重建新会话
  confirmModal('切换形态需要重建会话', '切换到' + kindCn + '需要重建会话，当前画面将中断，是否继续？', '重建会话', () => {
    if (gen0 !== Sess.gen || !Sess.active) return;
    Sess.pendingVm = 0; Sess.morphRetryAt = 0; Sess.linkedVm = Sess.vm; Sess.state = 'connecting'; Sess.t0 = performance.now();
    Sess.sm = QFSessionSM({ now: performance.now() }); // S-075：形态重建即重建状态机
    const cn = $('#qfConnecting', view); if (cn) cn.hidden = false;
    const st = $('#qfStrip', view); if (st) st.hidden = true;
    setBadge(view, 'wait', '连接中');
    setStage(view, 'iframe-attach');
    armFrameLoad(view, () => onFrameLoad(view, Sess.gen));
    frameNavigate(sessionDeepLinkCurrent());
  });
}
/* X-11：已连接态下待办形态的自动再试一次——哨兵每轮复核，到点（setMorph 第一次
   失败后 1.5 秒，给引擎一点就绪时间）才试一次 go()，只试一次：成功即切过去并
   清待办；失败即记第二次失败并弹重建确认框。onFrameLoad/setConnected 的既有
   重试路径不变（帧加载/状态迁移时仍先试）。 */
function retryPendingMorph(view) {
  if (!Sess.pendingVm || Sess.pendingGen !== Sess.gen) return false;
  if (Sess.morphRetryAt && performance.now() < Sess.morphRetryAt) return false;
  Sess.morphRetryAt = 0;
  const pv = Sess.pendingVm;
  // 高-3：计数按目标形态分桶——待办目标变了即重计，A 形态的失败不算到 B 头上
  if (Sess.morphTryVm !== pv) { Sess.morphTries = 0; Sess.morphTryVm = pv; }
  if (pv !== Sess.linkedVm && tryGo(pv)) { Sess.pendingVm = 0; Sess.linkedVm = pv; Sess.morphTries = 0; return true; }
  Sess.morphTries = (Sess.morphTries || 0) + 1;
  if (Sess.morphTries >= 2) { Sess.morphTries = 0; Sess.pendingVm = 0; Sess.morphRetryAt = 0; askMorphRebuild(view); }
  return false;
}
function setMorph(view, kind) {
  if (!QF_SESSION_VM[kind] || kind === Sess.kind) return;
  Sess.kind = kind; Sess.vm = QF_SESSION_VM[kind];
  // 高-3：切换目标形态即重计——新目标的失败次数从 0 起算，不继承旧目标的计数
  if (Sess.morphTryVm !== Sess.vm) { Sess.morphTries = 0; Sess.morphTryVm = Sess.vm; Sess.morphRetryAt = 0; }
  Sess.root.dataset.morph = kind;
  Sess.root.querySelectorAll('.sv-seg__btn').forEach(b => b.setAttribute('aria-selected', b.getAttribute('data-morph') === kind ? 'true' : 'false'));
  applyMorphChrome(view);
  syncSessionFrameGeometry();
  if (Sess.frame && Sess.linkedVm !== Sess.vm) {
    if (tryGo(Sess.vm)) { Sess.linkedVm = Sess.vm; Sess.morphTries = 0; }
    else if (Sess.state === 'connected' || Sess.state === 'lost') {
      /* X-11：go() 不可用时先不重建——记为待办形态并 toast 等待，等 onFrameLoad/
         setConnected 下一轮再试一次 go()；已连接态下既无 frame load 也无状态迁移
         时，由哨兵经 retryPendingMorph 在 1.5 秒后自动再试一次；两次都失败才弹
         确认框，用户点了才 frameNavigate 重建（原来是点一下就直接断连重建，
         无确认、无回退）。 */
      Sess.pendingVm = Sess.vm; Sess.pendingGen = Sess.gen;
      Sess.morphTries = (Sess.morphTries || 0) + 1;
      const kindCn = kind === 'terminal' ? '终端' : (kind === 'files' ? '文件管理' : '桌面');
      if (Sess.morphTries >= 2) {
        Sess.morphTries = 0; Sess.morphRetryAt = 0; Sess.pendingVm = 0; // 高-3：第二次失败即清待办形态，不留半残重试态
        askMorphRebuild(view);
      } else {
        Sess.morphRetryAt = performance.now() + 1500; // 哨兵到点自动再试一次
        toast('正在切换到' + kindCn + '，请稍候…', 'info');
      }
    } else { Sess.pendingVm = Sess.vm; Sess.pendingGen = Sess.gen; }
  }
}
function updateKbBtn(view) {
  const b = $('#qfKbBtn', view);
  if (b) b.classList.toggle('sv-iconbtn--brand', Sess.kbMode === 'manual');
}
/* 终端输入转发：只认框内终端真实输入元（insertText 且查其返回值）；
   引擎终端输入元选择器以翻牌日实捕为准（phase-0 SELECTORS 纪律）。
   DS P2-4/欠账③降级：无真实输入元命中即 return false，绝不向文档盲派
   键盘事件假报成功；失败由调用方明示（输入行保留内容＋提示）。 */
function sendTermText(text) {
  let doc = null;
  try { doc = Sess.frame.contentDocument; } catch (e) { return false; }
  if (!doc) return false;
  try {
    const ta = doc.querySelector('#p12 textarea, #p12 input[type="text"], textarea.xterm-helper-textarea, #termInput');
    if (!ta) return false;
    ta.focus();
    return !!doc.execCommand('insertText', false, text);
  } catch (e) { return false; }
}
/* 发送到手机（会话邀请）：四态 idle/picking/sending/sent/failed，失败文案照 DS2 §2.6 */
function resetSendSheet(view) {
  const l = $('#qfSendList', view), s = $('#qfSendSent', view), f = $('#qfSendFail', view);
  if (l) l.hidden = false; if (s) s.hidden = true; if (f) f.hidden = true;
  const go = $('#qfSendGo', view); if (go) { go.disabled = false; go.textContent = '发送'; }
}
function wireSendSheet(view) {
  const go = $('#qfSendGo', view); if (!go || go._qfWired) return; go._qfWired = true;
  go.onclick = async () => {
    if (!Sess.nodeid) {
      /* DS P2-2：nodeid 未解析（连接中/解析中/离线卡）时不发空邀请，
         提交处直接失败提示，不生成 qf-invite-.json 空载荷。 */
      const l = $('#qfSendList', view), f = $('#qfSendFail', view), ft = $('#qfSendFailTxt', view);
      if (ft) ft.textContent = '设备连接尚未就绪，暂时无法发送邀请，请等会话连接建立后再试。';
      if (l) l.hidden = true; if (f) f.hidden = false;
      return;
    }
    const ft0 = $('#qfSendFailTxt', view); if (ft0) ft0.textContent = '指令未能送达手机，请稍后重试。';
    go.disabled = true; go.textContent = '发送中…';
    const payload = JSON.stringify({ v: 1, kind: 'session', nodeid: Sess.nodeid, vm: Sess.vm, from: ctrlInstanceId(), at: Date.now() });
    let okSend = false;
    try {
      const r = await api('/license/api/files/send', { method: 'POST', json: { filename: 'qf-invite-' + Sess.nodeid + '.json', toNode: QF_CTRL_MAILBOX, fromNode: Sess.nodeid, contentBase64: btoa(payload) } });
      okSend = !!(r.json && r.json.ok);
    } catch (e) { okSend = false; }
    if (!Sess.active) return;
    if (okSend) {
      const l = $('#qfSendList', view), s = $('#qfSendSent', view);
      if (l) l.hidden = true; if (s) s.hidden = false;
    } else {
      const l = $('#qfSendList', view), f = $('#qfSendFail', view);
      if (l) l.hidden = true; if (f) f.hidden = false;
    }
  };
  const rt = $('#qfSendRetry', view); if (rt) rt.onclick = () => resetSendSheet(view);
}

/* ================= 设备 ================= */
Views.devices = async function (view, param, seq) {
  view.innerHTML = `<h1 class="pt">我的设备</h1><p class="psub">设备由站长分配或好友共享给您。在线设备可直接发起远程桌面、文件管理与远程终端。</p>
    <div class="tabs"><button class="on" data-tab="all">全部设备</button><button data-tab="mine">我的设备</button><button data-tab="shared">好友共享</button></div>
    <div id="devList"><div class="card"><div class="skel sk-h52"></div></div></div>
    <div class="note blue">可把文件发送到同账号的另一台设备（单文件上限 200 MB，离线暂存 24 小时）：在「我的文件」页选择「发送文件到其他设备」即可。</div>`;
  // 预取：进页面即并行拉节点映射（快源先回、慢源后台回填），不阻塞列表渲染；
  // 落地后把节点 id 盖进设备行（数据携带解析），并把上次会话设备升级为深链预热。
  // X-05：首屏传 deferSlow——慢源控制 WS 不在首屏并行另开（见 fetchNodeMap），
  // 首屏只剩 /lock/devices＋/home/api/stats＋/api/friends/me 三路 HTTP 取数，
  // 共用服务端 5 秒缓存＋单飞的一条控制 WS；共享设备 id 缺失时由点按的
  // resolve 端点兜底。
  fetchNodeMap({ deferSlow: true }).then(() => {
    if (seq !== renderSeq || S.route.name !== 'devices') return;   // DS P1-1：晚到回调世代校验——已离开设备页/已重渲即整段丢弃，不升级预热框
    refreshDevRowIds(view);
    try { const last = localStorage.getItem('qfLastSessionDevice'); const id = last && nodeIdFor(last); if (id) upgradePreheat(id, 11); } catch (e) {}
  }).catch(() => {});
  const st = await api('/home/api/stats');
  if (seq != null && seq !== renderSeq) return; // 扫表 S7：stats 在飞期间已切页/重渲，旧账号回填不得写 S.stats、不得画旧设备列表
  if (st.status === 200 && st.json && st.json.ok) S.stats = st.json;
  // X-07：stats 失败（非 200 / ok 假 / 网络失败）且无旧缓存可用时，画网络失败态，
  // 不得画「暂无设备」（失败与真空必须分开，否则用户会以为设备被删了去重装 agent）。
  const hasCachedDevs = !!(S.stats && Array.isArray(S.stats.devices) && S.stats.devices.length);
  if (!(st.status === 200 && st.json && st.json.ok) && !hasCachedDevs) {
    netFail($('#devList', view), () => render());
    return;
  }
  const mine = (S.stats && S.stats.devices) || [];
  // W-04：设备列表进单一状态源 QFStore.docs（持久域），各页只读 store；
  // 写操作经 QFLocal 持久化＋跨标签页广播（见 QFStore.setDoc）。
  try { QFStore.setDoc('devices', mine); QFStore._devicesAt = Date.now(); } catch (e) {}
  let shared = [];
  const fm = await api('/api/friends/me');
  if (seq != null && seq !== renderSeq) return; // 扫表 S7：同上，共享列表回包亦然
  if (fm.status === 200 && fm.json) shared = (fm.json.sharesIn || []).map(s => ({ name: s.meshName || '共享设备组', os: '好友共享 · ' + ((s.tier === 'operate' || s.tier === 'B2') ? '可操作' : '只看'), group: s.owner || '', online: false, onlineUnknown: true })); // 批A-A2：档位判法对齐好友页与服务端词表 operate/view；X-07：共享行在线态未知，不得写死离线
  const box = $('#devList', view);
  const paint = (tab) => {
    // 批A-A4：三页签分开渲染——'all' 合并我的与共享；共享行归属读映射字段 group（原误读 d.from 永不显示）
    const mineRows = mine.map(devRowHtml);
    const sharedRows = shared.map(d => devRowHtml({ name: d.name || d.device || '', os: d.os || '好友共享', group: d.group || '', online: !!d.online, onlineUnknown: !!d.onlineUnknown }));
    let rows, emptyHtml;
    if (tab === 'shared') {
      rows = sharedRows;
      emptyHtml = deviceEmptyHtml('暂无好友共享的设备', '好友把设备共享给您后，将显示在这里。');
    } else if (tab === 'mine') {
      rows = mineRows;
      emptyHtml = deviceEmptyHtml('未添加设备', '未添加设备。设备上线后将显示在这里。');
    } else {
      rows = mineRows.concat(sharedRows);
      emptyHtml = deviceEmptyHtml('未添加设备', '未添加设备。设备上线后，或好友将设备共享给您后，将显示在这里。');
    }
    box.innerHTML = `<div class="card">${rows.length ? rows.join('') : emptyHtml}</div>`;
    box.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => navigate(el.getAttribute('data-go'))));
    bindDevRows(box);
  };
  paint('all');
  view.querySelectorAll('[data-tab]').forEach(el => el.onclick = () => {
    view.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('on')); el.classList.add('on'); paint(el.getAttribute('data-tab'));
  });
};
Views.device = async function (view, name, seq) {
  const devs = (S.stats && S.stats.devices) || [];
  const d = devs.find(x => x.name === name) || { name, os: '', group: '', online: false };
  // X-08：离线时三行远程入口初始即置灰不可点（原来头部说「不可连接」，下面三行照点不误）。
  const dis = d.online ? '' : ' disabled';
  view.innerHTML = `<h1 class="pt">设备详情 · ${esc(d.name)}</h1><p class="psub"><a data-back>← 返回我的设备</a></p>
    <div class="card"><div class="dev dev-flat"><span class="devic">${ic('monitor')}</span><span><b class="fs-17">${esc(d.name)}</b><small>${esc(d.os || '')} · ${d.online ? '在线' : '离线'}</small></span><span class="ops" id="devHeadOps">${d.online ? `<button class="btn" data-remote="${esc(d.name)}">连接远程桌面</button>` : '<span class="pill off">设备离线时不可连接</span>'}</span></div></div>
    <div class="grid2"><div class="card" id="devConnCard"><h3>连接</h3>
      <button class="row" data-remote="${esc(d.name)}"${dis}><span class="tile">${ic('monitor')}</span><span><b>远程桌面</b><small>画面与键鼠控制</small></span><span class="chev">${ic('chevR')}</span></button><button class="row" data-files="${esc(d.name)}"${dis}><span class="tile">${ic('folder')}</span><span><b>文件管理</b><small>浏览、上传与下载被控端文件</small></span><span class="chev">${ic('chevR')}</span></button><button class="row" data-terminal="${esc(d.name)}"${dis}><span class="tile">${ic('file')}</span><span><b>远程终端</b><small>命令行会话</small></span><span class="chev">${ic('chevR')}</span></button>
      <p class="flex-row mt-10"><button class="btn sm" data-remote="${esc(d.name)}"${dis}>远程桌面</button><button class="btn sm ghost" data-files="${esc(d.name)}"${dis}>文件管理</button><button class="btn sm grey" data-terminal="${esc(d.name)}"${dis}>远程终端</button></p></div>
    <div class="card"><h3>设备信息</h3><div class="tblwrap fit"><table>
      <tr><th>系统</th><td>${esc(d.os || '—')}</td></tr><tr><th>分组</th><td>${esc(d.group || '默认分组')}</td></tr>
      <tr><th>状态</th><td data-devstatus>${d.online ? '<span class="dot6"></span>在线' : '<span class="dot6 off"></span>离线'}</td></tr>
      <tr><th>页面探针耗时</th><td class="num">—</td></tr><tr><th>码率</th><td class="num">—</td></tr><tr><th>编码</th><td>—</td></tr><tr><th>分辨率</th><td class="num">—</td></tr><tr><th>路径</th><td>—</td></tr>
      <tr><th>共享状态</th><td>以好友页共享设置为准</td></tr><tr><th>屏幕锁</th><td>在本页下方「屏幕锁」面板中管理（仅设备所有者）</td></tr></table><p class="ev-meta">页面探针耗时、码率、编码、分辨率、路径来自会话 telemetry，会话建立后回填；无数据时显示 —，不编造。</p></div></div></div>
    <div class="card" id="lockCard"><h3>屏幕锁</h3><div id="lockBody"><div class="skel sk-h52"></div></div></div>
    <div class="card"><h3>共享与安全</h3>
      ${rowHtml('users', '共享给好友', '在好友页选择好友后共享此设备（只看 / 可操作两档）', 'friends')}
      <button class="row" id="goLockPanel"><span class="tile">${ic('lock')}</span><span><b>屏幕锁</b><small>开启后被控端屏幕熄灭，只保留密码输入框；在本页上方「屏幕锁」面板中管理</small></span><span class="chev">${ic('chevR')}</span></button>
    </div>`;
  $('[data-back]', view).onclick = () => navigate('devices');
  bindDevRows(view);
  view.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => navigate(el.getAttribute('data-go'))));
  const gl = $('#goLockPanel', view);
  if (gl) gl.onclick = () => { const c = $('#lockCard', view); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  initLockPanel(view, d.name);
  // X-08：详情页进页时调一次 presence 预检刷新在线态（8 秒预算），不得只信
  // 60 秒前的 stats 快照；超时则保持旧值并标「状态未知」。
  const pid = nodeIdFor(name);
  if (pid) {
    checkPresence(pid).then((pre) => {
      if (seq !== renderSeq || !view.isConnected) return;
      const on = pre && pre.code === 'ONLINE';
      const off = pre && (pre.code === 'OFFLINE' || pre.code === 'STALE');
      if (!on && !off) { const stCell = view.querySelector('[data-devstatus]'); if (stCell) stCell.textContent = '状态未知'; return; }
      const sd = ((S.stats && S.stats.devices) || []).find(x => x.name === name);
      if (sd) sd.online = on;
      setDevConnState(view, d.name, on);
    }).catch(() => {});
  }
};
/* X-08：详情页连接区在线态原地刷新（行禁用/头部按钮/状态字三处同改）。 */
function setDevConnState(view, name, online) {
  const card = $('#devConnCard', view);
  if (card) card.querySelectorAll('[data-remote],[data-files],[data-terminal]').forEach(b => { b.disabled = !online; });
  const stCell = view.querySelector('[data-devstatus]');
  if (stCell) stCell.textContent = online ? '在线' : '离线';
  const ops = $('#devHeadOps', view);
  if (ops) ops.innerHTML = online ? `<button class="btn" data-remote="${esc(name)}">连接远程桌面</button>` : '<span class="pill off">设备离线时不可连接</span>';
  if (ops) bindDevRows(view);
}
/* 屏幕锁面板（四态：未锁/已锁/未装组件/他人设备；三操作：arm/reset/disarm）。
   形态照安卓 LockPage 与电脑端 lock.html：未锁时点开关先在卡内展开设密码
   表单、提交成功才真正上锁；已锁时可关锁（二次确认）或用登录密码重设。 */
async function initLockPanel(view, deviceName) {
  const body = $('#lockBody', view); if (!body) return;
  let busy = false;
  const nm = await fetchNodeMap();
  if (!body.isConnected) return;
  if (nm.lockStatus === 'needlogin') {
    body.innerHTML = `<div class="statebox"><b>登录状态已失效</b><p>${esc(nm.lockError)}</p></div>`;
    return;
  }
  if (nm.lockStatus !== 'ok') {
    body.innerHTML = `<div class="statebox"><b>屏幕锁暂时不可用</b><p>${esc(nm.lockError)}</p><button class="btn sm" id="lk-retry">重新加载</button></div>`;
    const rb = $('#lk-retry', body); if (rb) rb.onclick = () => { invalidateNodeMap(); fetchNodeMap({ force: true }).catch(() => {}).then(() => initLockPanel(view, deviceName)); };
    return;
  }
  // X-13：/lock/devices 回 partial 时面板顶部明示「正在确认其余设备状态…」
  // （不得把 partial 画成「暂无设备」），5 秒后自动再拉一次（每台设备只补拉一次）。
  const card = $('#lockCard', view);
  if (view.dataset.lockPartialDevice !== deviceName) { view.dataset.lockPartialDevice = deviceName; view.dataset.lockPartialRefetched = ''; }
  let partialNote = card ? $('#lk-partial-note', card) : null;
  if (nm.lockPartial) {
    if (!partialNote && card) {
      partialNote = document.createElement('p');
      partialNote.id = 'lk-partial-note';
      partialNote.className = 'note blue';
      partialNote.style.margin = '0 0 10px';
      partialNote.textContent = '正在确认其余设备状态…';
      const lb = $('#lockBody', view);
      if (lb) card.insertBefore(partialNote, lb);
    }
    if (!view.dataset.lockPartialRefetched) {
      view.dataset.lockPartialRefetched = '1';
      setTimeout(() => { if (view.isConnected) { invalidateNodeMap(); initLockPanel(view, deviceName); } }, 5000);
    }
  } else {
    if (partialNote) partialNote.remove();
    if (view.dataset.lockPartialRefetched) view.dataset.lockPartialRefetched = '';
  }
  const dev = nm.lockDevices.find(x => x.name === deviceName);
  if (!dev) {
    // 他人设备（或未登记机主）：服务端不下发该设备，不显示任何开关。
    body.innerHTML = `<div class="note blue m-0">该设备不在您的屏幕锁管理范围内。仅设备所有者可管理其屏幕锁；好友共享给您的设备，请由设备所有者管理。</div>`;
    return;
  }
  if (!dev.component) {
    body.innerHTML = `<p class="mb-8"><span class="pill warn">未安装组件</span></p><p class="text-sub fs-13x5">这台设备尚未安装屏幕锁组件，暂无法使用屏幕锁。</p>`;
    return;
  }
  const say = (html) => { const m = $('#lk-msg', body); if (m) m.innerHTML = html || ''; };
  const fail = (r, fb) => say(`<div class="note err my-10">${esc(apiErrText(r, fb))}</div>`);
  const setBusy = (on, label) => {
    busy = on;
    body.querySelectorAll('button').forEach(b => { b.disabled = on; });
    if (on) say(`<p class="ordnote" style="color:var(--sub)">${esc(label || '正在处理，请稍候…')}</p>`);
  };
  const refresh = () => { invalidateNodeMap(); initLockPanel(view, deviceName); };
  if (!dev.locked) {
    body.innerHTML = `
      <div class="dev dev-flat2"><span><b>当前状态</b><small>未锁定</small></span><span class="ops"><span class="pill off">未锁定</span><button class="btn sm" id="lk-arm-open">开启屏幕锁</button></span></div>
      <p class="text-sub fs-13x5 mt-8">开启后，这台设备屏幕熄灭，只保留密码输入框，坐在设备前的人无法查看与操作；远程控制不受影响。</p>
      <div id="lk-arm-form" hidden>
        <div class="field"><label>设置本次密码（至少 4 位）</label><input id="lk-pw1" type="password" autocomplete="off"></div>
        <div class="field"><label>请再次输入</label><input id="lk-pw2" type="password" autocomplete="off"></div>
        <p class="text-sub fs-12x5 mb-12">密码只用这一次：在设备本地解锁成功后自动作废，下次开启时重新设置。</p>
        <button class="btn block" id="lk-arm-go">打开屏幕锁</button>
      </div>
      <div id="lk-msg"></div>`;
    $('#lk-arm-open', body).onclick = () => {
      const f = $('#lk-arm-form', body); f.hidden = !f.hidden;
      if (!f.hidden) { const i = $('#lk-pw1', body); if (i) i.focus(); }
    };
    $('#lk-arm-go', body).onclick = async () => {
      if (busy) return;
      const pw = $('#lk-pw1', body).value, pw2 = $('#lk-pw2', body).value;
      const bad = validateLockPw(pw);
      if (bad) { say(`<div class="note err my-10">${esc(bad)}</div>`); return; }
      if (pw !== pw2) { say('<div class="note err my-10">两次输入的密码不一致，请检查后重试。</div>'); return; }
      setBusy(true, '正在开启屏幕锁，请稍候…');
      const r = await lockApi('POST', '/enable', { id: dev.id, password: pw });
      $('#lk-pw1', body).value = ''; $('#lk-pw2', body).value = '';
      if (r.json && r.json.ok) { toast('屏幕锁已开启。', 'ok'); refresh(); }
      else { setBusy(false); fail(r, '开启失败，请稍后再试。'); }
    };
    return;
  }
  // 已锁定：关锁（二次确认）＋忘记密码重设（保持锁定，只换密码）
  body.innerHTML = `
    <div class="dev dev-flat2"><span><b>当前状态</b><small>已锁定 · 远程控制不受影响</small></span><span class="ops"><span class="pill warn">已锁定</span></span></div>
    <p class="flex-row mt-12"><button class="btn danger" id="lk-off">关闭屏幕锁</button><button class="btn grey" id="lk-reset-open">忘记密码？用登录密码重设</button></p>
    <div class="mt-12" id="lk-reset-form" hidden>
      <div class="field"><label>您的 QFRemote 登录密码</label><input id="lk-lp" type="password" autocomplete="current-password"></div>
      <div class="field"><label>新锁密码（至少 4 位）</label><input id="lk-np1" type="password" autocomplete="off"></div>
      <div class="field"><label>请再次输入新锁密码</label><input id="lk-np2" type="password" autocomplete="off"></div>
      <button class="btn block" id="lk-reset-go">重设密码（设备保持锁定）</button>
    </div>
    <div id="lk-msg"></div>`;
  let armed = false, armTimer = null;
  const offBtn = $('#lk-off', body);
  offBtn.onclick = async () => {
    if (busy) return;
    if (!armed) {
      armed = true; offBtn.textContent = '再次点击确认关闭（本次密码立即作废）';
      armTimer = setTimeout(() => { armed = false; offBtn.textContent = '关闭屏幕锁'; }, 3500);
      return;
    }
    clearTimeout(armTimer);
    setBusy(true, '正在关闭屏幕锁，请稍候…');
    const r = await lockApi('POST', '/disable', { id: dev.id });
    if (r.json && r.json.ok) { toast('屏幕锁已关闭，本次密码已作废。', 'ok'); refresh(); }
    else { setBusy(false); offBtn.textContent = '关闭屏幕锁'; armed = false; fail(r, '关闭失败，请稍后再试。'); }
  };
  $('#lk-reset-open', body).onclick = () => {
    const f = $('#lk-reset-form', body); f.hidden = !f.hidden;
    if (!f.hidden) { const i = $('#lk-lp', body); if (i) i.focus(); }
  };
  $('#lk-reset-go', body).onclick = async () => {
    if (busy) return;
    const lp = $('#lk-lp', body).value, np = $('#lk-np1', body).value, np2 = $('#lk-np2', body).value;
    if (!lp) { say('<div class="note err my-10">请输入登录密码。</div>'); return; }
    const bad = validateLockPw(np);
    if (bad) { say(`<div class="note err my-10">${esc(bad)}</div>`); return; }
    if (np !== np2) { say('<div class="note err my-10">两次输入的密码不一致，请检查后重试。</div>'); return; }
    setBusy(true, '正在重设密码，请稍候…');
    const r = await lockApi('POST', '/reset', { id: dev.id, loginPassword: lp, newPassword: np });
    ['#lk-lp', '#lk-np1', '#lk-np2'].forEach(s => { const i = $(s, body); if (i) i.value = ''; });
    if (r.json && r.json.ok) { toast('密码已重设，设备保持锁定状态。', 'ok'); refresh(); }
    else { setBusy(false); fail(r, '重设失败，请稍后再试。'); }
  };
}
/* 发送文件卡（远程会话与「我的文件」共用同一真功能）：
   选本机文件 → 选同账号目标设备（以节点标识为准）→ 上传暂存 → 正式提示。
   opts: { fromName } 预选来源设备（远程会话上下文）。 */
function mountFileSend(container, opts) {
  opts = opts || {};
  container.innerHTML = `
    <div class="field"><label>选择文件（单文件上限 200 MB）</label><input type="file" class="fs-file filepick" id="fsFile"><label for="fsFile" class="btn sm ghost">选择文件</label><div class="hint fs-chosen">尚未选择文件</div></div>
    <div class="grid2">
      <div class="field"><label>来源设备</label><select class="fs-from"></select></div>
      <div class="field"><label>目标设备</label><select class="fs-to"></select></div>
    </div>
    <div class="bar fs-barwrap" hidden><i class="fs-bar" style="width:0%"></i></div>
    <p class="fs-note text-sub fs-13 m-8-0-12"></p>
    <button class="btn fs-go">发送文件</button>
    <button class="btn ghost fs-cancel" hidden>取消</button>
    <div class="fs-out mt-12"></div>`;
  const fileIn = $('.fs-file', container), fromSel = $('.fs-from', container), toSel = $('.fs-to', container);
  const barWrap = $('.fs-barwrap', container), bar = $('.fs-bar', container), note = $('.fs-note', container);
  const goBtn = $('.fs-go', container), cancelBtn = $('.fs-cancel', container), out = $('.fs-out', container);
  /* P2-029：已选文件回显——选中即在卡内显示文件名（多选显示数量＋首名），清空回落提示文案 */
  const chosen = $('.fs-chosen', container);
  const syncChosen = () => {
    const fs = fileIn.files;
    if (!fs || !fs.length) { chosen.textContent = '尚未选择文件'; return; }
    chosen.textContent = fs.length > 1 ? '已选择 ' + fs.length + ' 个文件：' + fs[0].name + ' 等' : '已选择文件：' + fs[0].name;
  };
  fileIn.onchange = syncChosen;
  let nm = null, sending = false;
  (async () => {
    nm = await fetchNodeMap();
    const devs = (S.stats && S.stats.devices) || [];
    const usable = devs.filter(d => nm.byName.has(d.name));
    const optHtml = (list, ph) => (ph ? `<option value="">${ph}</option>` : '') + list.map(d => `<option value="${esc(nm.byName.get(d.name))}">${esc(d.name)}${d.online ? '' : '（离线，暂存待收）'}</option>`).join('');
    fromSel.innerHTML = `<option value="">本设备（网页端）</option>` + optHtml(usable);
    if (opts.fromName && nm.byName.has(opts.fromName)) fromSel.value = nm.byName.get(opts.fromName);
    // 目标列表排除来源设备（来源变更时同步重建），避免来源/目标同机被误判未选。
    const syncTo = () => {
      const fromId = fromSel.value || '';
      const prev = toSel.value;
      const list = usable.filter(d => nm.byName.get(d.name) !== fromId);
      toSel.innerHTML = list.length ? optHtml(list, '请选择目标设备') : '<option value="">暂无其他可接收的设备</option>';
      if (prev && list.some(d => nm.byName.get(d.name) === prev)) toSel.value = prev;
      /* P2-030：候选恰一项时默认选中唯一目标（多项不预选、维持点选） */
      else if (list.length === 1) toSel.value = nm.byName.get(list[0].name);
    };
    fromSel.onchange = syncTo;
    syncTo();
    if (!usable.length) {
      goBtn.disabled = true;
      note.textContent = devs.length ? '暂时无法取得您设备的节点标识，文件发送暂不可用；远程桌面与文件管理不受影响。' : '您的账号下暂无设备，设备上线后即可在此发送文件。';
    } else {
      note.textContent = '文件将暂存于服务器（最长 24 小时），目标设备在「我的文件 · 待接收」中下载后即完成送达。';
    }
  })();
  goBtn.onclick = async () => {
    if (sending) return;
    const f = fileIn.files && fileIn.files[0];
    out.innerHTML = '';
    if (!f) { out.innerHTML = '<div class="note warn m-0">请先选择要发送的文件。</div>'; return; }
    if (f.size > FILE_MAX_BYTES) { out.innerHTML = '<div class="note err m-0">该文件超过单文件上限（200 MB），无法发送。请选择更小的文件。</div>'; return; }
    const toOpt = toSel.options && toSel.selectedIndex >= 0 ? toSel.options[toSel.selectedIndex] : null;
    const toNode = toSel.value || (toOpt ? toOpt.value : '');
    if (!toNode) { out.innerHTML = '<div class="note warn m-0">请选择目标设备。</div>'; return; }
    if (fromSel.value && toNode === fromSel.value) { out.innerHTML = '<div class="note warn m-0">目标设备不能与来源设备相同，请选择另一台设备。</div>'; return; }
    sending = true; goBtn.disabled = true; barWrap.hidden = false; bar.style.width = '0%';
    /* RC-08：新客户端一律走分片流（QF-STREAM-1）——本地算 SHA-256 → init →
       按服务端返回的 chunkSize 切分（File.slice 流式读，不整文件 base64）→
       chunk → commit；断网后 missing 查缺片续传；取消只在 uploading 态可用。 */
    const tf = QFFileTransfer({});
    cancelBtn.hidden = false;
    cancelBtn.onclick = () => { try { tf.cancel(); } catch (e) {} };
    try {
      note.textContent = t('files.hashing');
      const r = await tf.upload(f, toNode, fromSel.value || undefined, (p) => {
        bar.style.width = Math.round((p.sentBytes / Math.max(1, p.size)) * 100) + '%';
        if (p.state === 'interrupted') note.textContent = t('files.resume');
        else if (p.state === 'uploading') note.textContent = t('files.uploading', { r: p.received, n: p.totalChunks });
        else if (p.state === 'committing') note.textContent = t('files.checking');
      });
      bar.style.width = '100%';
      if (r.ok) {
        const toName = (nm && nm.byId.get(toNode)) || '目标设备';
        out.innerHTML = `<div class="note ok m-0">文件已发送到「${esc(toName)}」的待接收列表，有效期至 ${esc(fmtDate(r.expiresAt))}。对方下载完成后，本页「我发出的」将显示已送达。</div>`;
        toast('文件已发送。', 'ok');
        fileIn.value = '';
        syncChosen();
        const cb = container.closest('#view') || document;
        const sentBox = $('#sentList', cb); if (sentBox) loadSentList(cb);
        const inboxBox = $('#inboxList', cb); if (inboxBox) loadInboxList(cb);
      } else if (r.code === 'CANCELLED') {
        out.innerHTML = '<div class="note warn m-0">' + esc(t('files.cancelled')) + '</div>';
      } else if (r.code === 'CORRUPT') {
        out.innerHTML = '<div class="note err m-0">' + esc(t('files.corrupt')) + '（CORRUPT）。</div>';
      } else {
        out.innerHTML = '<div class="note err m-0">' + esc('发送失败' + (r.code ? '（' + r.code + '）' : '') + '，请稍后再试。') + '</div>';
      }
    } catch (e) {
      out.innerHTML = `<div class="note err m-0">${esc((e && e.message) || '发送失败，请稍后再试。')}</div>`;
    }
    cancelBtn.hidden = true;
    note.textContent = '文件将暂存于服务器（最长 24 小时），目标设备在「我的文件 · 待接收」中下载后即完成送达。';
    sending = false; goBtn.disabled = false;
    setTimeout(() => { barWrap.hidden = true; }, 600);
  };
}
async function loadInboxList(root, seq) {
  const box = $('#inboxList', root); if (!box) return;
  // X-09：多步异步加载器的世代守卫——晚到回包不得写已离场的 DOM。
  const stale = () => (seq != null && seq !== renderSeq) || !box.isConnected;
  const nm = await fetchNodeMap();
  if (stale()) return;
  const devs = (S.stats && S.stats.devices) || [];
  const targets = devs.filter(d => nm.byName.has(d.name));
  let all = [];
  for (const d of targets) {
    const r = await api('/license/api/files/inbox?node=' + encodeURIComponent(nm.byName.get(d.name)));
    if (stale()) return;
    if (r.json && r.json.ok && Array.isArray(r.json.files)) all = all.concat(r.json.files.map(f => Object.assign({}, f, { _toName: d.name })));
  }
  /* 2.4.0 发送到手机：ctrl 账号邮箱一并汇总（会话邀请＋发到本机的文件，#25 通道） */
  const ctrlR = await api('/license/api/files/inbox?node=' + encodeURIComponent(QF_CTRL_MAILBOX));
  if (stale()) return;
  if (ctrlR.json && ctrlR.json.ok && Array.isArray(ctrlR.json.files)) all = all.concat(ctrlR.json.files.map(f => Object.assign({}, f, { _toName: '这台手机', _ctrl: true })));
  if (!targets.length && !all.length) { box.innerHTML = '<div class="statebox"><b>暂无可查询的设备</b><p>设备上线并取得节点标识后，待接收文件将显示在这里。</p></div>'; return; }
  if (!all.length) { box.innerHTML = '<div class="statebox"><b>暂无待接收文件</b><p>其他设备发送给您的文件将显示在这里（暂存 24 小时）。</p></div>'; return; }
  box.innerHTML = all.map(f => {
    const fromName = (f.fromNode && nm.byId.get(f.fromNode)) || (f.fromNode ? '其他设备' : '网页端');
    const inv = f._ctrl && !QF_INVITE_REJECTED.has(f.id) && /^qf-invite-([A-Za-z0-9_-]+)\.json$/.exec(f.filename || '');
    if (inv) {
      const targetName = nm.byId.get(inv[1]) || '远程设备';
      return `<div class="dev"><span class="devic">${ic('phone')}</span><span><b>会话邀请：${esc(targetName)}</b><small>来自 ${esc(fromName)} · 发送到这台手机 · ${esc(fmtRemain(f.expiresAt))}</small></span><span class="ops"><button class="btn sm" data-open-invite="${esc(f.id)}" data-inv-node="${esc(inv[1])}">打开会话</button></span></div>`;
    }
    return `<div class="dev"><span class="devic">${ic('file')}</span><span><b>${esc(f.filename)}</b><small>${esc(fmtSize(f.size))} · 来自 ${esc(fromName)} · 接收到 ${esc(f._toName)} · ${esc(fmtRemain(f.expiresAt))}</small></span><span class="ops"><button class="btn sm" data-dl="${esc(f.id)}" data-fn="${esc(f.filename)}">下载</button></span><div class="bar basis-full" data-dlbar="${esc(f.id)}" hidden><i style="width:0%"></i></div></div>`;
  }).join('');
  box.querySelectorAll('[data-open-invite]').forEach(btn => btn.onclick = async () => {
    const id = btn.getAttribute('data-open-invite'), nodeid = bareNodeId(btn.getAttribute('data-inv-node') || '');
    btn.disabled = true; btn.textContent = '校验中…';
    /* DS P2-5：ack 前先取回载荷校验——kind/nodeid/from 须与文件名一致，
       只凭文件名不认邀请；不合法按普通文件处理（登记后重渲为下载行）。 */
    let payload = null;
    try {
      const resp = await fetch('/license/api/files/' + encodeURIComponent(id) + '/download', { credentials: 'include' });
      if (resp.ok) payload = JSON.parse(await resp.text());
    } catch (e) { payload = null; }
    const valid = !!payload && payload.kind === 'session' && bareNodeId(payload.nodeid || '') === nodeid && typeof payload.from === 'string' && !!payload.from;
    if (!valid) {
      QF_INVITE_REJECTED.add(id);
      toast('这条会话邀请的内容校验未通过，已按普通文件处理。', 'warn');
      loadInboxList(root, seq);
      return;
    }
    btn.textContent = '打开中…';
    await api('/license/api/files/' + encodeURIComponent(id) + '/ack', { method: 'POST', json: {} }).catch(() => {});
    openSession('desktop', { name: nm.byId.get(nodeid) || '', nodeid });
  });
  box.querySelectorAll('[data-dl]').forEach(btn => btn.onclick = async () => {
    const id = btn.getAttribute('data-dl'), fn = btn.getAttribute('data-fn');
    const barEl = box.querySelector('[data-dlbar="' + CSS.escape(id) + '"]');
    btn.disabled = true; btn.textContent = '下载中…';
    if (barEl) { barEl.hidden = false; }
    try {
      // RC-08：下载走分片流下载器（Range 续传；服务端回 200 时按全文件处理）。
      const tf = QFFileTransfer({});
      const dl = await tf.download(id, (p) => { if (barEl && p.total > 0) barEl.firstElementChild.style.width = Math.round(p.received / p.total * 100) + '%'; });
      if (!dl.ok) throw new Error(dl.code || '下载失败');
      const url = URL.createObjectURL(dl.blob);
      const a = document.createElement('a');
      a.href = url; a.download = fn || 'file';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      const ack = await api('/license/api/files/' + encodeURIComponent(id) + '/ack', { method: 'POST', json: {} });
      if (ack.json && ack.json.ok) toast('文件已下载，送达回执已确认。', 'ok');
      else toast('文件已下载，但回执确认未成功，请稍后在待接收列表核对。', 'warn');
    } catch (e) {
      toast((e && e.message) || '下载失败，请稍后再试。', 'err');
      btn.disabled = false; btn.textContent = '下载';
      return;
    }
    loadInboxList(root, seq);
    const sentBox = $('#sentList', root); if (sentBox) loadSentList(root, seq);
  });
}
async function loadSentList(root, seq) {
  const box = $('#sentList', root); if (!box) return;
  // X-09：世代守卫同 loadInboxList。
  const stale = () => (seq != null && seq !== renderSeq) || !box.isConnected;
  const nm = await fetchNodeMap();
  if (stale()) return;
  const r = await api('/license/api/files/sent');
  if (stale()) return;
  if (!(r.json && r.json.ok && Array.isArray(r.json.files))) { box.innerHTML = '<div class="statebox"><b>发出记录暂时不可用</b><p>请稍后重新加载。</p></div>'; return; }
  const files = r.json.files;
  if (!files.length) { box.innerHTML = '<div class="statebox"><b>暂无发出记录</b><p>您发送到其他设备的文件及送达状态将显示在这里。</p></div>'; return; }
  const stText = { staged: '待接收', delivered: '已送达', expired: '已过期' };
  box.innerHTML = files.map(f => {
    const toName = (f.toNode && f.toNode.indexOf('ctrl:') === 0) ? '这台手机' : ((f.toNode && nm.byId.get(f.toNode)) || '其他设备');
    const st = stText[f.status] || f.status || '';
    return `<div class="dev"><span class="devic">${ic('file')}</span><span><b>${esc(f.filename)}</b><small>${esc(fmtSize(f.size))} · 发送到 ${esc(toName)} · ${esc(fmtDate(f.createdAt))}${f.status === 'delivered' && f.deliveredAt ? ' · 送达于 ' + esc(fmtDate(f.deliveredAt)) : ''}</small></span><span class="ops"><span class="pill ${f.status === 'delivered' ? 'ok' : (f.status === 'expired' ? 'err' : 'warn')}">${esc(st)}</span></span></div>`;
  }).join('');
}
Views.files = async function (view, name, seq) {
  const devs = (S.stats && S.stats.devices) || [];
  view.innerHTML = `<h1 class="pt">我的文件</h1><p class="psub">浏览单台设备的文件请进入设备详情或远程桌面；把文件发到同账号的另一台设备，可直接在本页发送与接收。</p>
    <div class="card"><h3>选择设备进入文件管理</h3><div id="fileDevs">${devs.length ? devs.map(devRowHtml).join('') : '<div class="statebox"><b>暂无设备</b><p>设备上线后可进入文件管理。</p></div>'}</div></div>
    <div class="card"><h3>发送到我的其他设备</h3><div id="fileSendBox"></div></div>
    <div class="card"><h3>待接收</h3><div id="inboxList"><div class="skel sk-h52"></div></div></div>
    <div class="card"><h3>我发出的</h3><div id="sentList"><div class="skel sk-h52"></div></div></div>
    <div class="card"><h3>${t('files.auditTitle')}</h3><div id="auditList"><div class="skel sk-h52"></div></div></div>
    <div class="card"><h3>${t('rec.title')}</h3><div id="recList"><div class="skel sk-h52"></div></div><div id="recPlayer" hidden></div></div>`;
  bindDevRows(view);
  mountFileSend($('#fileSendBox', view));
  loadInboxList(view, seq);
  loadSentList(view, seq);
  mountAuditList(view, seq);
  mountRecList(view, seq);
  if (name) toast('已定位设备：' + name + '，点「文件管理」进入。', 'info');
};
/* RC-08 传输审计（QF-STREAM-1 §3）：只展示本人记录，result 三态着色。 */
async function mountAuditList(root, seq) {
  const box = $('#auditList', root); if (!box) return;
  const stale = () => (seq != null && seq !== renderSeq) || !box.isConnected;
  const tf = QFFileTransfer({});
  const r = await tf.listAudit(50);
  if (stale()) return;
  if (!r || !r.ok || !Array.isArray(r.audit)) { box.innerHTML = '<div class="statebox"><b>传输记录暂时不可用</b><p>请稍后重新加载。</p></div>'; return; }
  if (!r.audit.length) { box.innerHTML = '<div class="statebox"><b>' + esc(t('files.noAudit')) + '</b></div>'; return; }
  const pill = { completed: 'ok', failed: 'err', cancelled: 'warn' };
  const txt = { completed: t('files.auditCompleted'), failed: t('files.auditFailed'), cancelled: t('files.auditCancelled') };
  box.innerHTML = r.audit.map(a => `<div class="dev"><span class="devic">${ic('file')}</span><span><b>${esc(a.filename || '')}</b><small>${esc(fmtSize(a.size || 0))} · ${esc(fmtDate(a.startedAt))}${a.reason ? ' · ' + esc(a.reason) : ''}</small></span><span class="ops"><span class="pill ${pill[a.result] || ''}">${esc(txt[a.result] || a.result || '')}</span></span></div>`).join('');
}
/* RC-10 录像列表＋回放器（QF-REC-1 §5）：列表、加载、播放、seek、变速、
 * 边下边播、隐私提示。回放的是事件流（光标轨迹＋档位标记），不是视频画面。 */
async function mountRecList(root, seq) {
  const box = $('#recList', root); if (!box) return;
  const stale = () => (seq != null && seq !== renderSeq) || !box.isConnected;
  const rec = QFRecording({});
  const r = await rec.list();
  if (stale()) return;
  if (!r || !r.ok || !Array.isArray(r.recordings)) { box.innerHTML = '<div class="statebox"><b>录像列表暂时不可用</b><p>请稍后重新加载。</p></div>'; return; }
  if (!r.recordings.length) { box.innerHTML = '<div class="statebox"><b>' + esc(t('rec.noRecordings')) + '</b></div>'; return; }
  box.innerHTML = r.recordings.map(v => `<div class="dev"><span class="devic">${ic('monitor')}</span><span><b>${esc(v.sessionId || '')}</b><small>${esc(v.deviceId || '')} · ${esc(v.tier || '')} · ${esc(fmtDate(v.startedAt))} · ${esc(fmtSize(v.bytes || 0))}</small></span><span class="ops"><button class="btn sm" data-rec-play="${esc(v.sessionId)}">${esc(t('rec.play'))}</button></span></div>`).join('');
  box.querySelectorAll('[data-rec-play]').forEach(btn => btn.onclick = () => mountRecPlayer(root, btn.getAttribute('data-rec-play')));
}
function mountRecPlayer(root, sessionId) {
  const wrap = $('#recPlayer', root); if (!wrap || !sessionId) return;
  wrap.hidden = false;
  wrap.innerHTML = `<p class="text-sub fs-13">${esc(t('rec.privacy'))}</p>
    <canvas id="recCanvas" width="640" height="360" style="width:100%;background:var(--bg2)"></canvas>
    <div class="flex-row mt-10"><button class="btn sm" id="recPlayBtn">${esc(t('rec.play'))}</button>
    <input type="range" id="recSeek" min="0" max="1000" value="0" style="flex:1" aria-label="seek">
    <select id="recSpeed" aria-label="speed"><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option></select>
    <span id="recTime" class="fs-13">0:00 / 0:00</span></div>
    <p class="fs-13 text-sub" id="recStatus">${esc(t('rec.loading'))}</p>`;
  const canvas = $('#recCanvas', wrap), playBtn = $('#recPlayBtn', wrap), seekEl = $('#recSeek', wrap),
    speedEl = $('#recSpeed', wrap), timeEl = $('#recTime', wrap), statusEl = $('#recStatus', wrap);
  const ctx2d = canvas.getContext('2d');
  // 画布颜色走 token（lint-no-colors：JS 内不得出现 hex 字面量）：背景由
  // CSS var(--bg2) 承担，前景色运行时从 token 读（F-05：取 --text-1 主文字色；
  // 注册表无 --text，旧写法恒回空串、恒 fallback 到 'CanvasText'）。
  const recFg = () => { try { return (getComputedStyle(document.documentElement).getPropertyValue('--text-1') || '').trim() || 'CanvasText'; } catch (e) { return 'CanvasText'; } };
  const fmtT = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  let maxX = 1920, maxY = 1080; // 远端分辨率未知：先按 1920×1080 归一，载入后按事件最大值重算
  const draw = (player) => {
    if (!ctx2d) return;
    const st = player.state();
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = recFg();
    ctx2d.beginPath();
    ctx2d.arc(Math.max(4, Math.min(canvas.width - 4, st.cursor.x / maxX * canvas.width)), Math.max(4, Math.min(canvas.height - 4, st.cursor.y / maxY * canvas.height)), 6, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.font = '14px sans-serif';
    ctx2d.fillText(st.tier ? ('tier: ' + st.tier) : '', 10, 20);
    if (timeEl) timeEl.textContent = fmtT(st.playheadMs - player.startAt) + ' / ' + fmtT(st.durationMs);
    if (seekEl && st.durationMs > 0) seekEl.value = String(Math.round((st.playheadMs - player.startAt) / st.durationMs * 1000));
  };
  const rec = QFRecording({});
  let player = null, tickTimer = null;
  const stopTick = () => { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } };
  (async () => {
    const idx = await rec.getIndex(sessionId);
    if (!idx || !idx.ok) { if (statusEl) statusEl.textContent = '录像不存在或无权限查看'; return; } // 404 不区分解读（规范 §4.2）
    const dl = await rec.downloadBytes(sessionId);
    if (!dl || !dl.ok) { if (statusEl) statusEl.textContent = '录像不存在或无权限查看'; return; }
    player = QFRecPlayer({ onEvent: () => draw(player) });
    const loaded = player.load(dl.text, idx.index || null);
    // 按事件最大值重算归一化分辨率
    let mx = 0, my = 0;
    player.events.forEach((ev) => { if (ev.type === 'input' && ev.kind === 'mouse') { mx = Math.max(mx, Number(ev.x) || 0); my = Math.max(my, Number(ev.y) || 0); } });
    if (mx > 0) maxX = mx; if (my > 0) maxY = my;
    if (statusEl) statusEl.textContent = '共 ' + loaded.events + ' 个事件';
    draw(player);
    playBtn.onclick = () => {
      if (!player) return;
      if (player.state().playing) { player.pause(); playBtn.textContent = t('rec.play'); stopTick(); }
      else if (player.play()) {
        playBtn.textContent = t('rec.pause');
        tickTimer = setInterval(() => { draw(player); if (!player.state().playing) { playBtn.textContent = t('rec.play'); stopTick(); } }, 200);
      }
    };
    seekEl.oninput = () => {
      if (!player) return;
      player.seek(Math.round(Number(seekEl.value) / 1000 * player.durationMs()));
      draw(player);
    };
    speedEl.onchange = () => { if (player) player.setSpeed(parseFloat(speedEl.value)); };
  })().catch((e) => { try { console.error('[qf-rec-player]', e); } catch (e2) {} if (statusEl) statusEl.textContent = '录像不存在或无权限查看'; });
}
/* ================= 远程桌面（旧跳板路由，2.4.0 起改道会话融合视图） =================
   历史链接/菜单仍可落到 #/remote/<设备名>：不再顶层跳原生页，统一改道 openSession。 */
Views.remote = async function (view, name) {
  openSession('desktop', { name: name || '' });
};

/* ================= 好友 ================= */
let frPaintSeq = 0;   // 好友页 paint 代次，防止旧回包覆盖新渲染
Views.friends = async function (view, param, seq) {
  view.innerHTML = `<h1 class="pt">好友</h1><p class="psub">添加好友后，可将自己的设备组共享给对方协助处理。官方客服为系统联系人，不可删除、不参与设备共享。</p>
    <div class="card"><h3>好友申请 <span class="fr-cnt" id="frReqCnt" hidden></span></h3><div id="frReqs"><div class="skel sk-h52"></div></div></div>
    <div class="grid2"><div class="card chatlist"><h3>好友列表</h3><div id="frList"><div class="skel sk-h52"></div></div>
      <div class="field mt-16"><label>添加好友（输入对方完整账号）</label><input id="fr-q" placeholder="对方账号"></div>
      <button class="btn sm" id="fr-add">发送好友申请</button> <span class="text-sub fs-13" id="fr-msg"></span>
      <div id="frOutReq"></div></div>
    <div class="card"><h3>共享给我的设备组</h3><div id="frIn"><div class="skel sk-h52"></div></div>
      <h3 class="mt-18">我共享出的</h3><div id="frOut"><div class="skel sk-h40"></div></div></div></div>`;
  ensureChatToken(false);
  const paint = async () => {
    const myPaint = ++frPaintSeq;
    // 失败分支（catch 与业务失败共用同一渲染，且都不碰角标）
    const failRender = () => {
      const l = $('#frList', view); if (l) l.innerHTML = '<div class="statebox"><b>好友服务暂时不可用</b><p>请稍后重新加载。</p></div>';
      const rq = $('#frReqs', view); if (rq) rq.innerHTML = '<div class="statebox"><b>好友申请暂时无法加载</b><p>请稍后重新加载。</p></div>';
      const c = $('#frReqCnt', view); if (c) { c.hidden = true; c.textContent = ''; }
      const o = $('#frOutReq', view); if (o) o.innerHTML = '';
      const i2 = $('#frIn', view); if (i2) i2.innerHTML = '';
      const u = $('#frOut', view); if (u) u.innerHTML = '';
    };
    try {
      const r = await api('/api/friends/me');
      if (myPaint !== frPaintSeq) return;                                // 过期回包直接丢弃
      if (seq != null && seq !== renderSeq) return;                     // X-09：已离开好友页/已重渲，晚到回包整段丢弃
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.requestsIn)) { failRender(); return; }
      const j = r.json;
      const reqN = j.requestsIn.length;

      // ---- 角标与标题计数 ----
      badgeEpoch++;
      setFriendBadge(reqN);
      const cnt = $('#frReqCnt', view);
      if (cnt) { if (reqN > 0) { cnt.hidden = false; cnt.textContent = String(reqN); } else { cnt.hidden = true; cnt.textContent = ''; } }

      // ---- 好友申请（独立整幅卡）----
      const reqBox = $('#frReqs', view);
      let rq = '';
      j.requestsIn.forEach(q => { rq += `<div class="row"><span class="tile">${ic('user')}</span><span><b>${esc(q.from)}</b><small>请求添加您为好友</small></span><span class="ops"><button class="btn sm" data-acc="${esc(q.from)}">同意</button><button class="btn sm grey" data-rej="${esc(q.from)}">拒绝</button></span></div>`; });
      if (!reqN) rq = '<div class="statebox"><b>暂无待处理的好友申请</b><p>有新的好友申请时会显示在这里。</p></div>';
      reqBox.innerHTML = rq;
      reqBox.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => { const rr = await api('/api/friends/respond', { method: 'POST', json: { username: b.getAttribute('data-acc'), accept: true } }); if (rr.json && rr.json.ok) { toast((rr.json && rr.json.msg) || '已同意好友申请。', 'ok'); } else toast((rr.json && rr.json.msg) || '操作未成功，请稍后再试。', 'err'); paint(); });
      reqBox.querySelectorAll('[data-rej]').forEach(b => b.onclick = async () => { const rr = await api('/api/friends/respond', { method: 'POST', json: { username: b.getAttribute('data-rej'), accept: false } }); if (rr.json && rr.json.ok) { toast((rr.json && rr.json.msg) || '已拒绝好友申请。', 'info'); } else toast((rr.json && rr.json.msg) || '操作未成功，请稍后再试。', 'err'); paint(); });

      // ---- 好友列表（删去 requestsIn 段，其余逐字不变）----
      const list = $('#frList', view);
      let h = `<button class="row" data-support="1"><span class="tile">${ic('users')}</span><span><b>官方客服</b><small>智能客服与人工客服的统一入口</small></span><span class="tag">系统</span><span class="chev">${ic('chevR')}</span></button>`;
      (j.friends || []).forEach(f => { /* MOBILE-FIX 2026-11-14（C-04）：副文案不再写死“好友”。
        有可用数据时显示在线态／备注／角色／最近活跃；无可用数据时直接去掉
        副文案（后端未返这些字段时不编假信息，字段齐了自动显示）。 */
        const fParts = [];
        if (f.online === true) fParts.push('在线'); else if (f.online === false) fParts.push('离线');
        if (f.remark || f.note) fParts.push(f.remark || f.note);
        if (f.role) fParts.push(f.role);
        const fLast = f.lastActive || f.lastSeen || f.lastActiveMs;
        if (typeof fLast === 'number' && isFinite(fLast) && fLast > 0) fParts.push('最近活跃 ' + fmtDate(fLast < 1e12 ? fLast * 1000 : fLast));
        const fSub = fParts.join(' · ');
        h += `<div class="row"><span class="tile">${ic('user')}</span><span><b>${esc(f.name)}</b>${fSub ? `<small>${esc(fSub)}</small>` : ''}</span><span class="ops"><button class="btn sm ghost" data-share="${esc(f.name)}">共享设备</button><button class="btn sm grey" data-del="${esc(f.name)}">删除</button></span></div>`; });
      if (!(j.friends || []).length) h += '<div class="statebox"><b>暂无好友</b><p>在下方输入对方完整账号发送申请。</p></div>';
      list.innerHTML = h;
      const sup = $('[data-support]', list); if (sup) sup.onclick = () => navigate('support');
      list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
        const gen0 = S.sessGen; // 扫表 S14：确认框等待期间换账号，旧账号的好友删除不得发到新账号头上
        confirmModal('删除好友', '删除后将同时撤销双方的设备共享，确定删除 ' + b.getAttribute('data-del') + ' 吗？', '删除', async () => {
          if (gen0 !== S.sessGen) return;
          const r = await api('/api/friends/remove', { method: 'POST', json: { username: b.getAttribute('data-del') } });
          if (gen0 !== S.sessGen) return;
          if (r.json && r.json.ok) { toast('已删除好友。', 'ok'); paint(); } else { toast((r.json && r.json.msg) || '删除好友未成功，请稍后再试。', 'err'); }
        });
      }); // 批A-A3：查删除结果，失败如实提示且不刷新（DS 门一裁定）
      list.querySelectorAll('[data-share]').forEach(b => b.onclick = () => {
      const groups = (j.myGroups || []);
      const opts = groups.length ? groups.map(g => `<option value="${esc(g.meshid || g.id || g)}">${esc(g.name || g.meshName || g.meshid || g)}</option>`).join('') : '<option value="">（暂无可共享分组）</option>';
      showModal('共享设备给 ' + b.getAttribute('data-share'),
        `<div class="field"><label>设备组</label><select id="sh-g">${opts}</select></div>
         <div class="field"><label>共享档位</label><select id="sh-t"><option value="B">只看</option><option value="B2">可操作</option></select></div>
         <p class="text-sub fs-13">共享方随时可撤销；完整控制档不提供共享。</p>`,
        [{ label: '取消' }, { label: '确认共享', primary: true, onClick: async () => {
          const r2 = await api('/api/friends/share', { method: 'POST', json: { username: b.getAttribute('data-share'), meshid: $('#sh-g').value, tier: $('#sh-t').value === 'B2' ? 'operate' : 'view' } });
          if (r2.json && r2.json.ok) { toast('已共享。', 'ok'); paint(); } else toast((r2.json && r2.json.msg) || '共享未成功，请稍后再试。', 'err');
        } }]);
    });

      // ---- 我发送的申请 ----
      const outBox = $('#frOutReq', view);
      outBox.innerHTML = (Array.isArray(j.requestsOut) && j.requestsOut.length)
        ? `<h3 class="mt-18">我发送的申请</h3>` + j.requestsOut.map(o => `<div class="row"><span class="tile">${ic('user')}</span><span><b>${esc(o.to || '')}</b></span><span class="tag">等待对方同意</span></div>`).join('')
        : '';

      // ---- 共享给我的 / 我共享出的（逐字不变）----
      $('#frIn', view).innerHTML = (j.sharesIn || []).length ? j.sharesIn.map(s => rowInfoHtml('monitor', (s.meshName || '共享设备组') + '（来自 ' + (s.owner || '') + '）', ((s.tier === 'operate' || s.tier === 'B2') ? '可操作' : '只看'))).join('') : '<div class="statebox"><b>暂无共享给我的设备组</b><p>好友共享后将显示在这里。</p></div>';
      $('#frOut', view).innerHTML = (j.sharesOut || []).length ? j.sharesOut.map(s => `<div class="row"><span class="tile">${ic('monitor')}</span><span><b>${esc(s.meshName || '设备组')}</b><small>共享给 ${esc(s.grantee || '')} · ${(s.tier === 'operate' || s.tier === 'B2') ? '可操作' : '只看'}</small></span><span class="ops"><button class="btn sm grey" data-unshare="${esc(s.grantee || '')}|${esc(s.meshid || '')}">撤销</button></span></div>`).join('') : '<div class="statebox"><b>暂无共享出的设备组</b><p>在好友列表中点「共享设备」即可共享。</p></div>';
      view.querySelectorAll('[data-unshare]').forEach(b => b.onclick = async () => { const [g, m] = b.getAttribute('data-unshare').split('|'); const ru = await api('/api/friends/unshare', { method: 'POST', json: { username: g, meshid: m } }); if (ru.json && ru.json.ok) { toast('已撤销共享。', 'ok'); } else toast((ru.json && ru.json.msg) || '撤销未成功，请稍后再试。', 'err'); paint(); });
    } catch (e) {
      if (myPaint === frPaintSeq) failRender();
    }
  };
  $('#fr-add', view).onclick = async () => {
    const q = $('#fr-q', view).value.trim(); const msg = $('#fr-msg', view);
    if (!q) { msg.textContent = '请输入对方完整账号。'; return; }
    const s = await api('/api/friends/search', { method: 'POST', json: { username: q } });
    if (!(s.json && s.json.ok)) { msg.textContent = (s.json && s.json.msg) || '未找到该账号，请核对完整账号。'; return; }
    const r = await api('/api/friends/request', { method: 'POST', json: { username: q } });
    msg.textContent = (r.json && r.json.msg) || (r.json && r.json.ok ? '好友申请已发送。' : '发送未成功，请稍后再试。');
    if (r.json && r.json.ok) paint();
  };
  paint();
};

/* ---------------- 聊天令牌（控制台单点登录换票） ----------------
   聊天服务 /chat/api/* 只认 x-qfchat-token：凭控制台会话（xid）经
   POST /chat/api/sso 换取，服务端每次现签新票（有效期 12 小时、旧票
   并存不作废）。令牌只存内存、随控制台会话生死；接口回 401 时强制
   重换一次再重试，首次 401 的服务端原因不丢弃（重试仍失败时优先显
   示）。换票失败（手动退出聊天／账号不可用聊天／未登录控制台）把
   服务端原因原样交回调用方显示，不许用笼统文案掩盖。并发换票合并
   为一路；换票失败只清本路开始时那张旧票，不误清并发刚换好的新票。 */
let chatTok = '', chatTokAt = 0, chatTokGen = 0, chatTokFlight = null, chatTokUser = ''; // DS-R07/S3 补修：chatTokUser＝当前聊天票的签发身份
/* 登出 / 会话失效被踢时的聊天令牌复位：自增代号使任何在飞的换票请求作废，
   其迟到的成功响应绝不会再把上一个账号的令牌写回 chatTok（C-16）。 */
function qfChatTokenReset() {
  chatTok = ''; chatTokAt = 0; chatTokGen++; chatTokFlight = null; chatTokUser = '';
}
function ensureChatToken(force) {
  /* DS-R07/S3 补修：聊天票绑定签发身份——跨标签切号后本页 S.user 已是新账号而旧票未过期，
     入口先复位，强制以当前控制台会话重新换票，绝不让旧账号的票在本页继续用。 */
  if (chatTok && chatTokUser && S.user && chatTokUser !== S.user) qfChatTokenReset();
  if (!force && chatTok && (Date.now() - chatTokAt) < 11 * 3600 * 1000 && (!chatTokUser || !S.user || chatTokUser === S.user)) return Promise.resolve({ ok: true });
  /* 在飞换票一律合并（含 force）：并发 401 只换一次票，避免多个强制换票
     共享同一 gen0 时，后完成者被 gen 校验误判为「登录状态已变更」（N-1）。
     登出复位由 qfChatTokenReset 置空 flight＋自增 gen，迟到成功仍被丢弃。 */
  if (chatTokFlight) return chatTokFlight;
  const gen0 = chatTokGen;
  const mintUser = S.user || ''; // DS-R07/S3：签发目标身份——换票开始时捕获（sso 回执不含 user 字段，成功时以此记 chatTokUser）
  const flight = (async () => {
    const r = await api('/chat/api/sso', { method: 'POST', json: {} });
    if (r.status === 200 && r.json && r.json.ok && r.json.token) {
      /* 换票期间发生过登出/换账号：此票属于上一个账号，直接丢弃，绝不复活。 */
      if (chatTokGen !== gen0) return { ok: false, msg: '登录状态已变更，请重新打开聊天。' };
      chatTok = r.json.token; chatTokAt = Date.now(); chatTokGen++; chatTokUser = mintUser;
      return { ok: true };
    }
    if (chatTokGen === gen0) { chatTok = ''; chatTokAt = 0; }
    if (r.networkError) return { ok: false, network: true, msg: '网络连接失败，请检查网络后重试。' };
    /* MOBILE-FIX 2026-11-14（C-03）：SSO 换票失败不再一律写“请重新登录后再试”
       ——重登录修不好 SSO 故障；给重试／联系管理员。403 仍走专属文案。 */
    return { ok: false, msg: (r.json && r.json.msg) || (r.status === 403 ? '该账号不能使用聊天功能。' : '聊天服务暂时不可用，请点「重新加载」重试；若一直失败，请联系管理员。') };
  })();
  chatTokFlight = flight;
  const done = () => { if (chatTokFlight === flight) chatTokFlight = null; };
  flight.then(done, done);
  return flight;
}

async function chatApi(path, opts) {
  opts = opts || {};
  const method = String(opts.method || 'GET').toUpperCase();
  let t = await ensureChatToken(false);
  if (!t.ok) return { status: 0, ok: false, json: null, text: '', ssoError: t.msg, networkError: !!t.network };
  const call = () => api(path, Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, { 'x-qfchat-token': chatTok }) }));
  let r = await call();
  /* 401：服务端未执行业务，换票后重发安全（含非幂等 POST）；
     200 但响应体非 JSON 时请求可能已被服务端执行，只对幂等白名单重发，
     否则 POST /chat/api/send 等会被二次投递。 */
  if (r.status === 401 || (r.status === 200 && !r.json && apiRetrySafe(method, path))) {
    const firstMsg = (r.json && (r.json.msg || r.json.error)) || '';
    t = await ensureChatToken(true);
    if (!t.ok) return { status: 0, ok: false, json: null, text: '', ssoError: t.msg, networkError: !!t.network };
    r = await call();
    // CS2-1 修复（DS 门一成稿，候选丙）：首次 401/非 JSON 的原因只作为顶层诊断
    // 字段 firstMsg 保留，绝不改写重试响应的 json——旧回填会把失败伪装成成功
    // （200 非 JSON 被造出 {msg} 而走成功分支）、污染成功载荷、错置真因。
    // 消费方 paintList/cq/apiErrText 只读 json，不读 firstMsg。
    if (firstMsg) r = Object.assign({}, r, { firstMsg });
  }
  return r;
}

/* ================= 聊天对话区（C2 收编二期·变基重建） =================
   对话区改为控制台原生组件，不再内嵌独立聊天页。加密与解锁机制与
   独立页完全一致（同一套 /chat/api/* 接口、同一份 crypto-core 加密
   核心、同一静默解锁主序：托管副本→设备副本→无钥匙静默建钥匙），
   本组件移植独立页已验证的客户端逻辑，仅把页面级 DOM 换成组件内
   元素、把登录/单点登录换成控制台既有的聊天令牌通道（chatApi）。
   服务器只见密文的性质不变；独立 /chat 页在本组件验收后按设计退役。 */
let chatLibsP = null;
function ensureChatLibs() {
  if (window.QFChatCrypto && window.sodium) return Promise.resolve();
  if (chatLibsP) return chatLibsP;
  const load = (src) => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src;
    s.onload = res; s.onerror = () => rej(new Error('lib-load-failed'));
    document.head.appendChild(s);
  });
  chatLibsP = (async () => {
    await load('/chat/libsodium-sumo.js');
    await load('/chat/libsodium-wrappers.js');
    await load('/chat/crypto-core.js');
    await window.QFChatCrypto.ready();
  })();
  chatLibsP.catch(() => { chatLibsP = null; });
  return chatLibsP;
}
const CH = {
  priv: '', vaultKey: '', pubCache: {}, convKeyCache: {},
  currentWith: '', lastEventSeq: 0, rendered: new Set(),
  removedIds: new Set(),   // 已撤回/已删消息 id：防其 msg 事件迟到重处理时复活（见 chHandleEvent）
  history: {}, traces: {}, pollTimer: null, pollBusy: false, sendBusyFor: '',
  locked: false, pendingWith: '', shellDeviceKey: '',
  deviceMeta: [], hasSessionCopy: false, convMeta: {},
  /* C-04：全局轮询游标 lastEventSeq 只由 chPollOnce 实际消费事件后推进；
     已读一律按会话上报（服务端 /read 写 marks[我]=max(原值, uptoSeq)）。 */
  convSeenSeq: {},    // with -> 本端已消费到的该会话最大全局 seq（/read 上报用）
  lastOutSeq: {},     // with -> 我发出的最后一条消息 seq（仅用于「对方已读」显示）
  pendingEvents: [],  // 已取回但暂无法解密/写入的事件，下轮重放（上限 200）
  historyLoaded: false,
  gen: 0              // 账号态代号：登出/复位时自增，在飞异步据此丢弃迟到结果
};
let CHV = null; // { view, hooks } 当前挂载点
let chatBootSeq = 0; // 启动代次：挂载/卸载时自增，迟到的旧 boot 据此收手（N-4）
const chEl = (id) => CHV ? CHV.view.querySelector('#' + id) : null;
const CHC = () => window.QFChatCrypto;
async function cq(method, path, body) {
  const opts = { method };
  if (body !== undefined) opts.json = body;
  const r = await chatApi(path, opts);
  if (r.ssoError) throw new Error(r.ssoError);
  if (r.networkError) throw new Error('网络连接失败，请检查网络后重试。'); // CS2-2：接口自身网络失败走网络文案
  if (!r.json) throw new Error('聊天服务暂时不可用，请稍后再试。');
  if (!r.ok || r.json.ok === false) throw new Error(r.json.msg || ('HTTP ' + r.status));
  return r.json;
}
function chFmt(at) { const d = new Date(at); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function chAvatarIdx(name) { let h = 0; const s = String(name || '?'); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 2; }/* 六项②：头像圆盘二档（av0/av1），颜色由 CSS 按主题取自页面已计灰阶，不另增；深色下深灰盘近乎隐形，仅靠首字母区分 */

/* ---------- 设备密钥与设备包裹副本（移植独立页，语义不变） ---------- */
function chDeviceIdFor(kind) {
  const key = 'qfchat-device-id-' + kind;
  let id = null;
  try { id = localStorage.getItem(key); } catch (e) {}
  if (!id) {
    const bytes = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    id = kind + '-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(key, id); } catch (e) {}
  }
  return id;
}
function chIdbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('indexeddb-unavailable'));
    const rq = indexedDB.open('qfremote-chat', 1);
    rq.onupgradeneeded = () => { try { rq.result.createObjectStore('kv'); } catch (e) {} };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function chIdbGet(key) {
  const db = await chIdbOpen();
  return new Promise((resolve, reject) => {
    const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function chIdbSet(key, val) {
  const db = await chIdbOpen();
  return new Promise((resolve, reject) => {
    const rq = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
    rq.onsuccess = () => resolve();
    rq.onerror = () => reject(rq.error);
  });
}
let _chWebKeyP = null;
function chWebDeviceKey(create) {
  if (!(window.crypto && crypto.subtle && window.indexedDB)) return Promise.resolve(null);
  if (!_chWebKeyP) {
    // 高-2：null 决议不缓存——首次 create=false 取不到 key 时决议为 null，
    // 必须把 _chWebKeyP 复位，否则之后 create=true 也永远拿到缓存的 null，
    // 设备密钥永无生成之日。非 null 决议照常缓存；在飞期间并发调用仍共用
    // 同一份 promise（单飞不变），复位只发生在决议落定之后。
    _chWebKeyP = (async () => {
      let k = null;
      try { k = await chIdbGet('deviceKey'); } catch (e) {}
      if (!k && create) {
        k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        try { await chIdbSet('deviceKey', k); } catch (e) { return null; }
      }
      return k || null;
    })().then((k) => { if (!k) _chWebKeyP = null; return k; }, () => { _chWebKeyP = null; return null; });
  }
  return _chWebKeyP;
}
async function chWebWrap(secretB64, key) {
  const C = CHC();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, C.decBytes(secretB64));
  return { kind: 'webcrypto-aesgcm-v1', iv: C.encBytes(new Uint8Array(iv)), cipher: C.encBytes(new Uint8Array(ct)) };
}
async function chWebUnwrap(blob, key) {
  const C = CHC();
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: C.decBytes(blob.iv) }, key, C.decBytes(blob.cipher));
    return C.encBytes(new Uint8Array(pt));
  } catch (e) { return null; }
}
function chLocalDeviceKey(create) {
  const C = CHC();
  let k = null;
  try { k = localStorage.getItem('qfchat-device-key-v1'); } catch (e) {}
  if (!k && create) {
    k = C.newDeviceKey();
    try { localStorage.setItem('qfchat-device-key-v1', k); } catch (e) {}
  }
  return k;
}
async function chBuildDeviceCopyFor(kind, privB64, vaultB64) {
  const C = CHC();
  try {
    if (kind === 'shell') {
      if (!CH.shellDeviceKey) return null;
      return { deviceId: chDeviceIdFor('shell'), platform: 'shell', wrappedPriv: C.wrapWithKey(privB64, CH.shellDeviceKey), wrappedVault: C.wrapWithKey(vaultB64, CH.shellDeviceKey) };
    }
    if (kind === 'web') {
      const key = await chWebDeviceKey(true);
      if (!key) return null;
      const wp = await chWebWrap(privB64, key);
      const wv = await chWebWrap(vaultB64, key);
      return { deviceId: chDeviceIdFor('web'), platform: 'web', wrappedPriv: wp, wrappedVault: wv };
    }
    if (kind === 'local') {
      const k = chLocalDeviceKey(true);
      if (!k) return null;
      return { deviceId: chDeviceIdFor('local'), platform: 'web', wrappedPriv: C.wrapWithKey(privB64, k), wrappedVault: C.wrapWithKey(vaultB64, k) };
    }
  } catch (e) { /* 设备副本是静默增强，失败不影响主流程 */ }
  return null;
}
async function chBuildFirstDeviceCopy(privB64, vaultB64) {
  if (CH.shellDeviceKey) { const c = await chBuildDeviceCopyFor('shell', privB64, vaultB64); if (c) return c; }
  const w = await chBuildDeviceCopyFor('web', privB64, vaultB64);
  if (w) return w;
  return chBuildDeviceCopyFor('local', privB64, vaultB64);
}
async function chEnrollDeviceCopy() {
  if (!CH.priv || !CH.vaultKey) return false;
  let any = false;
  const put = async (kind) => {
    const copy = await chBuildDeviceCopyFor(kind, CH.priv, CH.vaultKey);
    if (!copy) return false;
    try { await cq('POST', '/chat/api/keys/device', copy); return true; } catch (e) { return false; }
  };
  if (CH.shellDeviceKey) any = (await put('shell')) || any;
  const webOk = await put('web');
  any = webOk || any;
  if (!webOk) any = (await put('local')) || any;
  return any;
}
async function chFetchDeviceCopy(deviceId) {
  try { return await cq('GET', '/chat/api/keys/device/' + encodeURIComponent(deviceId)); } catch (e) { return null; }
}
async function chTryDeviceUnlock() {
  const C = CHC();
  const gen0 = CH.gen; // 扫表 S3：设备副本在飞期间换账号，解出的旧钥匙不得落进新账号
  if (CH.priv && CH.vaultKey) return true;
  const adopt = (p, v) => { if (gen0 !== CH.gen) return false; if (!p || !v) return false; CH.priv = p; CH.vaultKey = v; CH.locked = false; return true; };
  try {
    if (CH.shellDeviceKey) {
      const c = await chFetchDeviceCopy(chDeviceIdFor('shell'));
      if (c && adopt(C.unwrapWithKey(c.wrappedPriv, CH.shellDeviceKey), C.unwrapWithKey(c.wrappedVault, CH.shellDeviceKey))) return true;
    }
  } catch (e) {}
  try {
    const key = await chWebDeviceKey(false);
    if (key) {
      const c = await chFetchDeviceCopy(chDeviceIdFor('web'));
      if (c) { const p = await chWebUnwrap(c.wrappedPriv, key); const v = await chWebUnwrap(c.wrappedVault, key); if (adopt(p, v)) return true; }
    }
  } catch (e) {}
  try {
    const k = chLocalDeviceKey(false);
    if (k) {
      const c = await chFetchDeviceCopy(chDeviceIdFor('local'));
      if (c && adopt(C.unwrapWithKey(c.wrappedPriv, k), C.unwrapWithKey(c.wrappedVault, k))) return true;
    }
  } catch (e) {}
  return false;
}

/* ---------- 登录状态托管副本与静默解锁（主序与独立页钉死一致） ---------- */
async function chFetchSessionCopy() {
  const gen0 = CH.gen; // 扫表 S1：与严-2 同款——取副本在飞期间换账号，旧账号私钥不得写进新账号
  try {
    const r = await cq('GET', '/chat/api/keys/session-copy');
    if (gen0 !== CH.gen) return false;
    if (r && r.priv && r.vault) { CH.priv = r.priv; CH.vaultKey = r.vault; CH.locked = false; CH.hasSessionCopy = true; return true; }
  } catch (e) { /* 无副本或网络问题：走下一顺位 */ }
  return false;
}
async function chUploadSessionCopy() {
  if (!CH.priv || !CH.vaultKey) return false;
  const gen0 = CH.gen; // 扫表 S2：上传在飞期间换账号，不得把旧账号的 hasSessionCopy 标到新账号头上
  try { await cq('POST', '/chat/api/keys/session-copy', { priv: CH.priv, vault: CH.vaultKey }); if (gen0 !== CH.gen) return false; CH.hasSessionCopy = true; return true; }
  catch (e) { return false; }
}
async function chCreateKeysSilently(password) {
  const gen0 = CH.gen; // 严-2：建钥期间登出/换账号，旧钥匙一律不得落进新账号（CH.gen 只在 chatResetAll 自增，变了即已复位）
  const C = CHC();
  const id = C.newIdentity();
  const vaultKey = C.newVaultKey();
  const device = await chBuildFirstDeviceCopy(id.privB64, vaultKey);
  if (gen0 !== CH.gen) return false; // 设备副本在飞期间已换账号：setup 请求根本不发，旧身份不上新账号的服务端
  const body = { pub: id.pubB64, sessionCopy: { priv: id.privB64, vault: vaultKey } };
  if (password) {
    body.wrappedPriv = C.wrapWithPassword(id.privB64, password);
    body.wrappedVault = C.wrapWithPassword(vaultKey, password);
  }
  if (device) body.device = device;
  await cq('POST', '/chat/api/keys/setup', body);
  if (gen0 !== CH.gen) return false; // setup 在飞期间已换账号：一个字节都不写进 CH
  CH.priv = id.privB64; CH.vaultKey = vaultKey; CH.hasSessionCopy = true; CH.locked = false;
  return true;
}
async function chFinishSilentUnlock() {
  const gen0 = CH.gen;
  CH.locked = false;
  chShowUnavail(false);
  try {
    const r = await cq('GET', '/chat/api/keys/me');
    if (gen0 !== CH.gen) return;         // 期间已登出/换账号：旧链就此终止（N-2）
    CH.deviceMeta = r.keys ? (r.keys.devices || []) : [];
    if (r.keys) CH.hasSessionCopy = !!r.keys.hasSessionCopy;
  } catch (e) { /* 设备清单元数据失败不影响本次解锁 */ }
  if (!CH.hasSessionCopy) chUploadSessionCopy().catch(() => {});
  /* 历史失败已在 chLoadHistory 内部可见化并给出重试入口，这里再兜一层，
     保证后续的轮询启动与会话恢复一定执行（C-05/C-07）。 */
  try { await chLoadHistory(); } catch (e) { /* 已在组件内提示 */ }
  if (gen0 !== CH.gen) return;           // 同上：旧账号链不得为新账号启轮询/开会话（N-2）
  chRefreshMeta().catch(() => {});
  chStartPolling();
  const w = CH.pendingWith || CH.currentWith;
  CH.pendingWith = '';
  if (w) chOpenConversation(w);
}
async function chAttemptSilentUnlock() {
  /* C-05：钥匙已在内存（离开再回聊天）时不得直接 return——必须走完 finish，
     重载历史、重启轮询、恢复会话；否则离开期间的新消息永不到达，
     首次历史加载失败后重进也永不重试。finish 可安全重入（chStartPolling
     有定时器在位守卫，监听注册不在此链上）。 */
  if (CH.priv && CH.vaultKey) { await chFinishSilentUnlock(); return true; }
  if (await chFetchSessionCopy()) { await chFinishSilentUnlock(); return true; }
  if (await chTryDeviceUnlock()) { await chFinishSilentUnlock(); return true; }
  try {
    const gen0 = CH.gen; // 扫表 S4：keys/me 在飞期间换账号，旧账号的设备清单不得写进新账号；建钥失败也不替新账号跑 finish
    const r = await cq('GET', '/chat/api/keys/me');
    if (gen0 !== CH.gen) return false;
    CH.deviceMeta = r.keys ? (r.keys.devices || []) : [];
    if (r.keys) CH.hasSessionCopy = !!r.keys.hasSessionCopy;
    if (!r.keys) { const created = await chCreateKeysSilently(''); if (!created || gen0 !== CH.gen) return false; await chFinishSilentUnlock(); return true; }
  } catch (e) { /* 建钥匙失败不冒充成功，落到不可用提示 */ }
  return false;
}

/* ---------- 历史（保险库） ---------- */
async function chPeerPub(user) {
  if (CH.pubCache[user]) return CH.pubCache[user];
  const gen0 = CH.gen;
  const r = await cq('GET', '/chat/api/keys/' + encodeURIComponent(user));
  /* 取钥期间发生登出/换账号时不得回写缓存：旧账号的公钥/派生钥一旦落进
     新账号缓存，该联系人后续全部消息都会用错钥封装（N-3）。 */
  if (gen0 === CH.gen) CH.pubCache[user] = r.pub;
  return r.pub;
}
async function chConvKey(withUser) {
  if (CH.convKeyCache[withUser]) return CH.convKeyCache[withUser];
  const gen0 = CH.gen;
  const pub = await chPeerPub(withUser);
  const k = CHC().conversationKey(CH.priv, pub);
  if (gen0 === CH.gen) CH.convKeyCache[withUser] = k;
  return k;
}
/* C-07：历史加载失败必须被捕获并对用户可见（错误条＋重试），且不得让
   finish/mount 链卡死。取数失败时不清空已有 history；成功时与本端已有
   条目按 id 合并（服务端版本优先）——chVaultAppend 存在「服务端未落账
   但本端已记」的条目，整体替换会把这类已投递消息弄丢且游标已过不再重投。
   错误条为 chMsgs 的同级元素：finish 后续的 chRenderMessages 只重绘
   chMsgs，放在消息区内的提示会被当场冲掉，同级错误条可存活。 */
function chShowHistoryError(msg, retryFn) {
  const box = chEl('chMsgs');
  if (!box || !box.parentElement) return;
  let bar = chEl('chHistErr');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'chHistErr';
    bar.className = 'note err';
    box.parentElement.insertBefore(bar, box);
  }
  bar.textContent = msg;
  if (retryFn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn sm';
    b.textContent = '重新加载聊天记录';
    b.onclick = () => { chHideHistoryError(); retryFn(); };
    bar.appendChild(document.createTextNode(' '));
    bar.appendChild(b);
  }
}
function chHideHistoryError() {
  const b = chEl('chHistErr');
  if (b) b.remove();
}
async function chLoadHistory() {
  const gen0 = CH.gen;
  let r;
  try {
    /* S-051：保险库分页拉取（每页 100 条，cursor 循环直至 hasMore=false）；
     * 不传 limit 的全量拉取在记录多时会超限，分页后 traces 取首页即可
     * （服务端每页都附同一份 traces）。 */
    const entries = [];
    let traces = null;
    let cursor = '';
    let guard = 0;
    while (guard++ < 50) {
      const pr = await cq('GET', '/chat/api/vault?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      if (gen0 !== CH.gen) return false;
      (pr.entries || []).forEach(e => entries.push(e));
      if (traces === null) traces = pr.traces || {};
      if (!pr.hasMore || !pr.nextCursor) break;
      cursor = pr.nextCursor;
    }
    r = { entries, traces: traces || {} };
  } catch (e) {
    if (gen0 !== CH.gen) return false;   // 已登出/换账号：旧账号的失败不落新账号界面（N-2）
    CH.historyLoaded = false;
    chShowHistoryError('聊天记录加载失败：' + (e && e.message ? e.message : '请稍后再试。'), () => {
      chLoadHistory().then(ok => { if (ok) { chRenderMessages(); chMarkRead(); } }).catch(() => {});
    });
    return false;
  }
  if (gen0 !== CH.gen) return false;     // 迟到响应不得回写新账号的 traces/history/UI（N-2）
  const C = CHC();
  const next = {};
  /* traces 与 history 同口径合并（B-3）：服务端版本优先，本端刚产生、
     服务端尚未落账的撤回留证按 msgId 补入，不得被整体替换清掉。 */
  const mergedTraces = r.traces || {};
  Object.keys(CH.traces).forEach(cv => {
    const remote = mergedTraces[cv] || (mergedTraces[cv] = []);
    const seen = new Set(remote.map(t => t.msgId));
    (CH.traces[cv] || []).forEach(t => { if (!seen.has(t.msgId)) remote.push(t); });
  });
  CH.traces = mergedTraces;
  (r.entries || []).forEach(e => {
    if (CH.removedIds.has(e.msgId)) return;   // 本端已知已撤回/已删，不复活
    let text = null;
    try { text = C.openVault(CH.vaultKey, e.nonce, e.cipher); } catch (err) { text = null; }
    if (text !== null) next[e.msgId] = { id: e.msgId, with: e.with, dir: e.dir, at: e.at, text };
  });
  /* 合并而非整体替换：本端已写出但服务端 vault 尚未落账的条目不能在重载
     时丢掉（其事件序号可能已被轮询越过，不会再作为事件回来）。 */
  Object.keys(CH.history).forEach(id => { if (!next[id] && !CH.removedIds.has(id)) next[id] = CH.history[id]; });
  CH.history = next;
  CH.historyLoaded = true;
  chHideHistoryError();
  return true;
}
async function chVaultAppend(msgId, withUser, dir, at, text) {
  if (CH.removedIds.has(msgId)) return;   // 纵深防御：已撤回/已删条目在任何入口都不写回保险库（CF-1 R-5）
  const gen0 = CH.gen;
  const sealed = CHC().sealVault(CH.vaultKey, text);
  try { await cq('POST', '/chat/api/vault', { msgId, with: withUser, dir, at, nonce: sealed.nonce, cipher: sealed.cipher }); } catch (e) { /* 下次打开会从传送通道补 */ }
  /* await 之后必须复核（B-1 TOCTOU）：在飞期间该条可能已被撤回/删除
     （removedIds 已登记），或发生登出/换账号（gen 已变）——两种情形都不得
     再写回本地 history（调用方随后还会据此把消息插回 DOM）。 */
  if (gen0 !== CH.gen || CH.removedIds.has(msgId)) return;
  CH.history[msgId] = { id: msgId, with: withUser, dir, at, text };
}
async function chRefreshMeta() {
  const gen0 = CH.gen;
  try {
    const c = await cq('GET', '/chat/api/conversations');
    if (gen0 !== CH.gen) return;   // 在飞期间已换账号：旧账号会话元数据不得落进新账号（D-4）
    const meta = {};
    (c.conversations || []).forEach(cv => { meta[cv.with] = { lastAt: cv.lastAt || 0, lastSeq: cv.lastSeq || 0, myRead: cv.myRead || 0 }; });
    CH.convMeta = meta;
  } catch (e) { /* 会话元数据失败不影响对话本身 */ }
  if (gen0 !== CH.gen) return;
  if (CHV && CHV.hooks && CHV.hooks.refreshList) CHV.hooks.refreshList();
}

/* ---------- 会话界面 ---------- */
function chShowUnavail(show) {
  const u = chEl('chUnavail'), m = chEl('chMsgs'), c = chEl('chComp');
  if (u) u.hidden = !show;
  if (m) m.style.display = show ? 'none' : '';
  if (c) c.style.display = show ? 'none' : '';
}
function chConvKeyOf(withUser) { return JSON.stringify([S.user || '', withUser].sort()); }
function chTracesFor(withUser) { return CH.traces[chConvKeyOf(withUser)] || []; }
function chAddTrace(conv, t) {
  const list = CH.traces[conv] = CH.traces[conv] || [];
  if (!list.some(x => x.msgId === t.msgId)) list.push(t);
}
function chAppendTraceDom(t) {
  const key = 'trace:' + t.msgId;
  if (CH.rendered.has(key)) return;
  CH.rendered.add(key);
  const div = document.createElement('div');
  div.className = 'cht-sys';
  div.id = 'cht-trace-' + t.msgId;
  div.textContent = t.by === (S.user || '') ? '您撤回了一条消息' : '对方撤回了一条消息';
  chEl('chMsgs').appendChild(div);
}
function chAppendMessageDom(m) {
  if (CH.rendered.has(m.id)) return;
  CH.rendered.add(m.id);
  const box = chEl('chMsgs'); if (!box) return;
  const div = document.createElement('div');
  div.className = 'cht-msg ' + (m.dir === 'out' ? 'me' : 'peer');
  div.id = 'cht-msg-' + m.id;
  const act = m.dir === 'out' ? '<span class="cht-recall" data-recall="' + m.id + '">撤回</span>' : '';
  div.innerHTML = '<div class="cht-bub">' + esc(m.text) + '</div><div class="cht-meta"><span>' + chFmt(m.at) + '</span>' + act + '</div>';
  const actEl = div.querySelector('[data-recall]');
  if (actEl) actEl.onclick = () => chRecallMessage(m.id);
  /* S-050：追加前记是否贴底，仅贴底时滚底；上翻看历史不抢滚动。 */
  const atBottom = chIsAtBottom(box);
  box.appendChild(div);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
/* S-050：贴底判定（24px 容差，抵渲染取整与字体差异）。 */
function chIsAtBottom(box) {
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight <= 24;
}
function chRenderMessages() {
  const box = chEl('chMsgs'); if (!box) return;
  /* S-050：重绘前记是否贴底，仅贴底时重绘后滚底（打开会话时框为空即贴底，照常见底）。 */
  const atBottom = chIsAtBottom(box);
  box.innerHTML = '';
  CH.rendered = new Set();
  const msgs = Object.values(CH.history).filter(m => m.with === CH.currentWith).map(m => ({ at: m.at, msg: m }));
  const trs = chTracesFor(CH.currentWith).map(t => ({ at: t.msgAt != null ? t.msgAt : t.at, trace: t }));
  msgs.concat(trs).sort((a, b) => a.at - b.at).forEach(item => {
    if (item.msg) chAppendMessageDom(item.msg); else chAppendTraceDom(item.trace);
  });
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function chShowThreadPane() {
  if (CHV && CHV.hooks && CHV.hooks.showThread) CHV.hooks.showThread();
}
function chOpenConversation(withUser) {
  if (!withUser) return;
  if (CH.locked) {
    CH.pendingWith = withUser;
    chShowThreadPane();  // C-12：锁定态先切对话面，解锁完成/失败提示都落在对话面
    chAttemptSilentUnlock().then(ok => {
      if (!ok && CH.locked && CH.pendingWith === withUser) chShowUnavail(true);
    }).catch(() => { if (CH.locked) chShowUnavail(true); });
    return;
  }
  CH.currentWith = withUser;
  chShowThreadPane();    // C-12：一切打开会话的路径（含程序化打开）都切对话面
  const isSupport = withUser === 'qf-support';
  const title = chEl('chWith'); if (title) title.textContent = isSupport ? '官方客服' : withUser;
  const cav = chEl('chAvatar');
  if (cav) {
    if (isSupport) { cav.className = 'cht-av sys'; cav.textContent = '客'; }
    else { cav.className = 'cht-av av' + chAvatarIdx(withUser); cav.textContent = withUser.slice(0, 1); }
  }
  const sub = chEl('chSub'); if (sub) sub.textContent = isSupport ? '已迁移至智能客服，本会话只读查看' : '内容经加密传输与保存';
  const banner = chEl('chBanner'); if (banner) banner.hidden = !isSupport;
  const input = chEl('chInput'), send = chEl('chSend');
  if (input) { input.disabled = isSupport; input.placeholder = isSupport ? '本会话保留只读，请从智能客服咨询' : '输入消息…'; }
  if (send) send.disabled = isSupport;
  // W-10：打开会话即恢复本地草稿（断网/刷新不丢）；已有输入内容时不覆盖。
  if (input && !isSupport) {
    try {
      QFLocal.load('drafts', 'chat:' + withUser).then((d) => {
        if (d && d.text && CH.currentWith === withUser && input.isConnected && !input.value) input.value = d.text;
      }).catch(() => {});
    } catch (e) {}
  }
  const rd = chEl('chRead'); if (rd) rd.textContent = '';
  /* C-04：此处不再用 convMeta.lastSeq 提升全局游标 CH.lastEventSeq——那会把
     其他会话序号更低、尚未被 poll 消费的事件永久跳过（被跳消息不入保险库）。
     打开会话的已读改由 chMarkRead 按会话上报该会话的 lastSeq（见下）。 */
  chShowUnavail(false);
  chRenderMessages();
  chMarkRead().then(() => chRefreshMeta()).catch(() => {});
  if (CHV && CHV.hooks && CHV.hooks.markActive) CHV.hooks.markActive(withUser);
}
/* C-16：账号态复位总入口——登出（含会话失效被踢 forceGate）时由 BASE 调用。
   清理边界：
   · 清（账号态，与登录身份绑定）：priv/vaultKey（私钥与保险库钥匙）、
     pubCache/convKeyCache（他人公钥与派生会话钥）、history/traces/rendered
     （已解历史与撤回记录）、convMeta/convSeenSeq/lastOutSeq、currentWith/
     pendingWith/lastEventSeq、deviceMeta/hasSessionCopy（本账号的设备清单
     与副本标记）、shellDeviceKey（壳侧本次会话下发的设备钥匙材料）；
     chatTok 与在飞换票由 qfChatTokenReset 一并作废（BASE 补丁）。
   · 留（设备态）：本机设备 id（localStorage）与 IndexedDB 中的设备包裹
     副本、chDeviceIdFor 的钥匙材料——属「这台设备」的信任，不含账号身份
     信息；服务端按账号隔离存放，下一位登录者仍走自己的服务端数据，
     保留不构成跨账号泄漏，删之反而每次换账号都要重建设备副本。
   · CH.gen 自增：在飞的 poll/发送/换票迟到回调据此丢弃结果。 */
function chatResetAll() {
  CH.gen++;
  chStopPolling();
  chHideHistoryError();
  CH.priv = ''; CH.vaultKey = '';
  CH.pubCache = {}; CH.convKeyCache = {};
  CH.currentWith = ''; CH.lastEventSeq = 0; CH.pollBusy = false; CH.sendBusyFor = '';   // 存疑-1：旧轮在飞标志不得带进新账号
  CH.rendered = new Set(); CH.removedIds = new Set();
  CH.history = {}; CH.traces = {};
  CH.locked = true; CH.pendingWith = '';
  CH.shellDeviceKey = '';
  CH.deviceMeta = []; CH.hasSessionCopy = false; CH.convMeta = {};
  CH.convSeenSeq = {}; CH.lastOutSeq = {}; CH.pendingEvents = [];
  CH.historyLoaded = false;
  CHV = null;
  if (typeof S !== 'undefined' && S) S._chatStop = null;
  if (typeof qfChatTokenReset === 'function') qfChatTokenReset();
}
function chLeaveConversation() {
  CH.currentWith = '';
  const title = chEl('chWith'); if (title) title.textContent = '选择左侧联系人开始聊天';
  const box = chEl('chMsgs');
  if (box) box.innerHTML = '<div class="statebox"><b>尚未选择会话</b><p>从左侧列表选择联系人即可查看对话。</p></div>';
  const input = chEl('chInput'); if (input) { input.disabled = true; input.placeholder = '输入消息…'; }
  const send = chEl('chSend'); if (send) send.disabled = true;
  if (CHV && CHV.hooks && CHV.hooks.markActive) CHV.hooks.markActive('');
}
async function chSendMessage() {
  /* C-06：进入时刻锁定目标会话快照——会话钥、收件方、本地记录与保险库
     归属全程以快照为准，await 之后绝不重读 CH.currentWith（用户在发送
     在飞期间切换会话时，旧写法会把按 A 会话钥封装的密文发给 B）。 */
  const target = CH.currentWith;
  if (!target || target === 'qf-support') return;
  const input = chEl('chInput'); if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  /* F-04：输入框不再提前清空——发送成功后再清，失败时文本保留在框内可直接重发，
     不依赖 300ms 草稿兜底；同一会话在飞发送未完成时不重复投递（防重复点击双发）。 */
  if (CH.sendBusyFor === target) return;
  CH.sendBusyFor = target;
  const gen0 = CH.gen;
  try {
    const key = await chConvKey(target);
    if (gen0 !== CH.gen) return;   // 取钥期间已登出/换账号：不得用旧账号钥替新会话投递（N-3）
    const sealed = CHC().sealMessage(key, text);
    /* S-054：每次发送生成一个 clientMessageId 随消息提交（去重与对账用）；
     * 服务端存索引＋按 id 查询由 C-4 的 S-086 落地，契约字段名 clientMessageId。 */
    const clientMessageId = qfNewClientMessageId();
    const r = await cq('POST', '/chat/api/send', { to: target, nonce: sealed.nonce, cipher: sealed.cipher, clientMessageId });
    if (gen0 !== CH.gen) return;                    // 期间已登出/换账号：迟到结果不写任何状态
    const m = { id: r.id, with: target, dir: 'out', at: r.at, text, clientMessageId };
    await chVaultAppend(r.id, target, 'out', r.at, text);
    // W-10：发送成功才清本地草稿（发送失败草稿保留，可重打）。
    try { const p = QFLocal.del('drafts', 'chat:' + target); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (e) {}
    /* F-04：发送成功才清空输入框；用户在发送在飞期间又打了字时不清空（避免误删新输入）。 */
    if (input.value.trim() === text) input.value = '';
    /* C-04：不再用发送回执提升全局游标（会越过 poll 尚未消费的其他会话
       事件）；回执 seq 只记入本会话的已消费位与「对方已读」判定基准。 */
    if (Number(r.seq) > (CH.convSeenSeq[target] || 0)) CH.convSeenSeq[target] = Number(r.seq) || 0;
    CH.lastOutSeq[target] = Math.max(CH.lastOutSeq[target] || 0, Number(r.seq) || 0);
    if (CH.currentWith === target) { chAppendMessageDom(m); chMarkRead(); }
    chRefreshMeta().catch(() => {});
  } catch (e) { toast(e.message, 'err'); /* F-04：发送失败时文本保留在输入框内，不丢失。 */ }
  finally { if (CH.sendBusyFor === target) CH.sendBusyFor = ''; }
}
async function chRecallMessage(msgId) {
  /* 高-5：照抄邻居 chDeleteConversation——gen0 必须在打开确认框之前捕获，
     确认框等待期间若发生登出/换账号，回调里再取到的已是新账号代次，守卫
     形同虚设；回调开头与请求返回后各验一次，不符直接 return。 */
  const gen0 = CH.gen;
  confirmModal('撤回消息', '撤回后，您和对方都将看不到这条消息，只会留下一条撤回提示。软件之外的副本（如截图）无法撤回。确定撤回吗？', '撤回', async () => {
    if (gen0 !== CH.gen) return;
    try {
      const r = await cq('POST', '/chat/api/recall', { msgId });
      if (gen0 !== CH.gen) return; // 撤回在飞期间已换账号：不得改新账号的界面与撤回留证
      const m = CH.history[msgId];
      chRemoveMessageEverywhere(msgId);
      if (m) chAddTrace(chConvKeyOf(m.with), { msgId, by: S.user || '', at: r.at, msgAt: r.msgAt });
      if (CH.currentWith && (!m || m.with === CH.currentWith)) chRenderMessages();
      chRefreshMeta().catch(() => {});
    } catch (e) { toast(e.message, 'err'); }
  });
}
async function chDeleteConversation() {
  if (!CH.currentWith) return;
  const w = CH.currentWith;
  /* gen0 必须在打开确认框之前捕获（新-1）：确认框等待期间若发生登出/
     换账号，回调里再取到的已是新账号代次，守卫形同虚设——届时请求根本
     不许发，更不许删新账号的同名会话。 */
  const gen0 = CH.gen;
  confirmModal('删除整个对话', '确定删除与 ' + w + ' 的整个对话吗？删除后双方都将看不到。软件之外的副本（如截图）无法删除。', '删除', async () => {
    if (gen0 !== CH.gen) return;
    try {
      const r = await cq('POST', '/chat/api/delete-conversation', { with: w });
      if (gen0 !== CH.gen) return;   // 删除在飞期间已换账号：不得误删新账号同名会话数据（B-2）
      /* 逐个走 chRemoveMessageEverywhere：同时登记 removedIds，防该会话
         迟到的 msg 事件把已删条目写回保险库（CF-1 R-2）。 */
      Object.values(CH.history).filter(m => m.with === w).forEach(m => chRemoveMessageEverywhere(m.id));
      delete CH.traces[chConvKeyOf(w)];
      chRenderMessages();
      chRefreshMeta().catch(() => {});
      toast('已删除，共清除 ' + r.count + ' 条。', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
}
function chRemoveMessageEverywhere(msgId) {
  CH.removedIds.add(msgId);
  delete CH.history[msgId];
  const elx = chEl('cht-msg-' + msgId); if (elx) elx.remove();
  CH.rendered.delete(msgId);
}
async function chMarkRead(withUser) {
  const w = withUser || CH.currentWith;
  if (!w) return;
  /* C-04：已读只按会话上报——取「本端实际消费到的该会话 seq」与「该会话
     已知 lastSeq」的较大者，绝不借全局 poll 游标（旧写法把全局游标报作
     本会话已读位，会越过本会话尚未处理的消息）。服务端 /read 按会话写
     marks[我]=max(原值, uptoSeq)，只影响该会话未读数，不动 poll 游标。 */
  const seen = CH.convSeenSeq[w] || 0;
  const meta = CH.convMeta[w];
  const upto = Math.max(seen, (meta && meta.lastSeq) || 0);
  if (!(upto > 0)) return;
  try { await cq('POST', '/chat/api/read', { with: w, seq: upto }); } catch (e) {}
}
function chSeenTick(withUser, seq) {
  if (!withUser || !seq) return;
  if (seq > (CH.convSeenSeq[withUser] || 0)) CH.convSeenSeq[withUser] = seq;
}

/* ---------- 同步轮询（新消息＋墓碑＋已读） ---------- */
function chStartPolling() {
  if (CH.pollTimer) return;
  CH.pollTimer = setInterval(chPollOnce, 3000);
  chPollOnce();
}
function chStopPolling() {
  if (CH.pollTimer) { clearInterval(CH.pollTimer); CH.pollTimer = null; }
}
async function chPollOnce() {
  /* 在飞互斥（Q-4/B-1 竞态面）：setInterval 不等上一轮结束，慢请求下两轮
     重叠会同批事件双处理、并使「撤回处理与在飞写库交错」成为可能。
     忙时跳过本轮（3 秒后下一轮补上），事件序号不推进、无丢失。 */
  if (CH.pollBusy) return;
  const gen0 = CH.gen;
  CH.pollBusy = true;
  try { await chPollRound(); } catch (e) { /* 单轮异常吞掉，不外溢为未处理拒绝（存疑-2） */ }
  /* 复位必须认代次（新-4）：旧账号一轮的 finally 若无条件清位，会击穿
     新账号正在使用的互斥（chatResetAll 已先行清位让新账号首轮能启动，
     此处旧轮不得再碰）。 */
  finally { if (gen0 === CH.gen) CH.pollBusy = false; }
}
/* S-048/S-053：gap 补齐——按 seq 从 /chat/api/catchup 拉回错过的消息密文，
 * 解密后写入保险库与历史（与 chHandleEvent 同路：已撤回/已删的不复活），
 * 已删 id 直接清历史；最多 10 页，单条失败不卡整批。 */
async function chCatchUp() {
  let since = CH.lastEventSeq;
  let guard = 0;
  while (guard++ < 10) {
    const gen0 = CH.gen;
    let r;
    try { r = await cq('GET', '/chat/api/catchup?since=' + since + '&limit=100'); } catch (e) { return; }
    if (gen0 !== CH.gen || !r || !r.ok) return;
    (r.deletedIds || []).forEach(id => chRemoveMessageEverywhere(id));
    for (const m of (r.messages || [])) {
      if (!m || !m.id || CH.history[m.id] || CH.removedIds.has(m.id)) continue;
      const other = m.from === (S.user || '') ? m.to : m.from;
      try {
        const key = await chConvKey(other);
        if (gen0 !== CH.gen) return;
        const text = CHC().openMessage(key, m.nonce, m.cipher);
        if (text === null) continue;
        const dir = m.from === (S.user || '') ? 'out' : 'in';
        await chVaultAppend(m.id, other, dir, m.at, text);
        if (gen0 !== CH.gen || CH.removedIds.has(m.id) || !CH.history[m.id]) continue;
        if (CH.currentWith === other) chAppendMessageDom(CH.history[m.id]);
      } catch (e) { /* 单条失败不卡整批补齐 */ }
    }
    if (typeof r.nextSince === 'number') since = Math.max(since, r.nextSince);
    if (!r.hasMore) break;
  }
}
async function chPollRound() {
  if (!CHV) return;
  const gen0 = CH.gen;
  let r;
  try { r = await cq('GET', '/chat/api/poll?since=' + CH.lastEventSeq); } catch (e) { return; }
  if (gen0 !== CH.gen || !CHV) return;            // 期间登出/换账号：整批丢弃
  let sawNew = false;
  /* S-048/S-053：gap=true 说明本轮事件不完整（长离线期间 inbox 已剪枝）——
     先走 catchup 按 seq 补回错过的消息密文，再把游标推到 maxSeq，
     不得静默跳号；补齐失败时不卡本轮事件处理，下轮再试。
     决策走 qf-runtime 的 qfChatSyncPlanPage（S-087 纯逻辑核）。 */
  const plan0 = qfChatSyncPlanPage(r, CH.lastEventSeq);
  if (plan0.needCatchup) {
    try { await chCatchUp(); } catch (e) { /* 下轮再试 */ }
    if (gen0 !== CH.gen || !CHV) return;
    if (plan0.catchupMaxSeq > CH.lastEventSeq) CH.lastEventSeq = plan0.catchupMaxSeq;
  }
  /* S-048/S-053：hasMore 时翻页取完本轮事件（每页上限由服务端定），再统一处理。 */
  const fresh = plan0.events.slice();
  let pageGuard = 0;
  let plan = plan0;
  while (plan.hasMore && pageGuard++ < 10) {
    if (gen0 !== CH.gen || !CHV) return;
    try { r = await cq('GET', '/chat/api/poll?since=' + plan.nextSince); } catch (e) { break; }
    if (gen0 !== CH.gen || !CHV) return;
    plan = qfChatSyncPlanPage(r, CH.lastEventSeq);
    fresh.push(...plan.events);
  }
  /* C-04：游标只在本轮「实际取到并即将处理」的位置推进一次。单条处理失败
     不再靠游标原地不动来重试（那会被一条坏事件卡死整条流），而是进
     pendingEvents 下轮重放——消息不会因钥匙未就绪被永久跳过。
     游标推进与 pending 合并走 qfChatSyncAdvanceCursor／qfChatSyncMergePending。 */
  CH.lastEventSeq = qfChatSyncAdvanceCursor(fresh, CH.lastEventSeq);
  const bucket = qfChatSyncMergePending(CH.pendingEvents, fresh).bucket;
  CH.pendingEvents = [];
  for (const ev of bucket) {
    if (gen0 !== CH.gen) return;         // 批处理期间登出/换账号：余下事件整批作废（N-3）
    try {
      if (await chHandleEvent(ev)) sawNew = true;
    } catch (e) {
      /* 失败重放同样认代次（新-5）：事件在飞期间已换账号时，旧账号事件
         不得进新账号的 pendingEvents 被按新身份重放。 */
      if (gen0 === CH.gen) {
        CH.pendingEvents = qfChatSyncRequeue(CH.pendingEvents, ev, 200);  // 上限防无限增长（S-087）
      }
    }
  }
  if (sawNew) chRefreshMeta().catch(() => {});
  if (CH.currentWith) {
    const cv = JSON.stringify([S.user || '', CH.currentWith].sort());
    const marks = (r.read || {})[cv] || {};
    const rd = chEl('chRead');
    /* 「对方已读」以对端在本会话的已读位与我最后发出 seq 比较（旧写法拿
       全局游标比，C-04 删提升后必然失真）。 */
    const mine = CH.lastOutSeq[CH.currentWith] || 0;
    if (rd) rd.textContent = (mine > 0 && (marks[CH.currentWith] || 0) >= mine) ? '对方已读' : '';
  }
}
async function chHandleEvent(ev) {
  if (!ev) return false;
  if (ev.type === 'msg') {
    const m = ev.msg;
    if (!m || !m.id || !m.from || !m.to) return false;   // 异形事件按已消费跳过，不得抛错毒化 pending（新-3/存疑-D）
    const other = m.from === (S.user || '') ? m.to : m.from;
    /* 已撤回/已删的消息即使其 msg 事件迟到（游标未及）也不得再处理：
       本端 history 判重挡不住「已本地删除」的情形，此时重走解密＋入保险库
       会把服务端已清的保险库条目重新写回（服务端按 messages∪graveyard
       验 origin，墓地命中即放行），下次重载历史时消息复活（CF-1）。 */
    if (CH.history[m.id] || CH.removedIds.has(m.id)) { chSeenTick(other, ev.seq); return false; }
    const gen0 = CH.gen;
    const key = await chConvKey(other);              // 抛错 → 事件进 pending 下轮重试
    if (gen0 !== CH.gen) return false;               // 期间登出/换账号：不落新账号状态（N-3）
    const text = CHC().openMessage(key, m.nonce, m.cipher);
    if (text === null) { chSeenTick(other, ev.seq); return false; }   // 锁钥不匹配：与本端无关，视为已消费
    const dir = m.from === (S.user || '') ? 'out' : 'in';
    await chVaultAppend(m.id, other, dir, m.at, text);
    /* 调用侧闭环（新-2）：chVaultAppend 可能因 await 期间被撤回/换账号而
       落空（未写 history）——此时不得再推进已读、不得拿 undefined 渲染，
       否则既污染已读位又会抛错把事件毒化进 pending。 */
    if (gen0 !== CH.gen || CH.removedIds.has(m.id) || !CH.history[m.id]) return false;
    /* 已消费位只在真正处理完后推进：取钥失败进 pending 的事件不得先行
       计入已读并上报（N-5）。 */
    chSeenTick(other, ev.seq);
    if (dir === 'out') CH.lastOutSeq[other] = Math.max(CH.lastOutSeq[other] || 0, ev.seq);
    if (CH.currentWith === other) { chAppendMessageDom(CH.history[m.id]); chMarkRead(); }
    return true;
  }
  if (ev.type === 'tomb') {
    /* msgIds 形态防御（B-4）：字段缺失/异形时不得抛错——抛错会使事件
       进 pending 每轮重放、永不消费。 */
    (Array.isArray(ev.msgIds) ? ev.msgIds : []).forEach(id => chRemoveMessageEverywhere(id));
    return false;
  }
  if (ev.type === 'recall') {
    (Array.isArray(ev.msgIds) ? ev.msgIds : []).forEach(id => chRemoveMessageEverywhere(id));
    if (ev.trace) chAddTrace(ev.conv, ev.trace);
    /* 偏差留证（DEV-1）：DS 稿此处以 ev.conv（会话键字符串）记已消费位，
       与 convSeenSeq 按用户名索引的口径不符，落地改为按对端用户名记。 */
    const peer = Array.isArray(ev.parties) ? ev.parties.find(x => x !== (S.user || '')) : undefined;
    if (peer) chSeenTick(peer, ev.seq);
    if (CH.currentWith && CH.currentWith === peer) chRenderMessages();
    return false;
  }
  return false;
}

/* ---------- 组件挂载 ---------- */
function mountChatThread(view, hooks) {
  chStopPolling();
  CHV = { view, hooks: hooks || {} };
  S._chatStop = () => { chStopPolling(); CHV = null; chatBootSeq++; };
  const send = chEl('chSend'); if (send) send.onclick = chSendMessage;
  const input = chEl('chInput');
  if (input) input.onkeydown = (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chSendMessage(); } }; // S-052：组合输入（IME）中不发送
  // W-10：聊天草稿本地优先——输入即写 IndexedDB（防抖 300ms），发送后清；
  // 多标签页经 QFLocal 广播同步（他页更新只在输入框为空时才接，不覆盖本页正在打的字）。
  if (input) input.oninput = () => {
    const target = CH.currentWith;
    if (!target || target === 'qf-support') return;
    clearTimeout(input._qfDraftTimer);
    input._qfDraftTimer = setTimeout(() => {
      const v = input.value;
      try {
        if (v) {
          const stamp = { text: v, updatedAt: Date.now(), tabId: QFLocal.tabId };
          const p = QFLocal.save('drafts', 'chat:' + target, stamp);
          if (p && typeof p.catch === 'function') p.catch(() => {});
          QFLocal.broadcast('draft:chat:' + target, stamp);
        } else {
          const p = QFLocal.del('drafts', 'chat:' + target);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (e) {}
    }, 300);
  };
  const del = chEl('chDel'); if (del) del.onclick = chDeleteConversation;
  const ub = chEl('chUnavailBack');
  if (ub) ub.onclick = () => { chShowUnavail(false); if (CHV && CHV.hooks && CHV.hooks.backToList) CHV.hooks.backToList(); };
  /* C-07：启动链独立为 chBootChat 并全程兜底——任何一步失败都有可见
     提示与重试入口，不再出现未处理 rejection 后界面卡死的形态；
     重试只重跑 chBootChat，不重跑 mount（监听注册天然幂等亦不重复）。 */
  chatBootSeq++;
  chBootChat().catch(() => {
    const box = chEl('chMsgs');
    if (box) {
      box.innerHTML = stateBox('聊天暂时无法打开', '与服务器的连接出现问题，请检查网络后重新加载。', true);
      bindRetry(box, chBootChat);
    }
  });
}
async function chBootChat() {
  /* N-4：box 在 await 前捕获会过期——卸载重挂后 CHV 是新视图的对象，
     单靠 !CHV 拦不住旧 boot。各检查点以启动代次为准：代次变了（发生过
     卸载/重挂）即收手，失败提示与重试只写当前视图的节点。
     B-5：boot 自身入口即推进代次——重试连点时后起的 boot 自动作废先起
     的一个，同视图内也不会出现两个 boot 并发。 */
  const seq0 = ++chatBootSeq;
  const stale = () => (!CHV || seq0 !== chatBootSeq);
  const box = chEl('chMsgs');
  try { await ensureChatLibs(); }
  catch (e) {
    if (stale()) return;
    if (box) box.innerHTML = stateBox('聊天组件加载失败', '聊天加密组件未能加载，请检查网络后重新打开本页。', false);
    return;
  }
  let t;
  try { t = await ensureChatToken(false); }
  catch (e) { t = { ok: false, msg: '聊天登录失败，请稍后重试。' }; }
  if (stale()) return;
  if (!t || !t.ok) {
    if (t && t.network) { netFail(box, chBootChat); return; }
    if (box) {
      box.innerHTML = stateBox('聊天暂时不可用', (t && t.msg) || '聊天服务暂时不可用，请点「重新加载」重试。', true);
      bindRetry(box, chBootChat);
    }
    return;
  }
  CH.locked = !(CH.priv && CH.vaultKey);
  await chRefreshMeta();                       // 内部已吞错并刷新列表
  if (stale()) return;
  let ok = false;
  try { ok = await chAttemptSilentUnlock(); } catch (e) { ok = false; }
  if (stale()) return;
  if (!ok) {
    if (CH.locked) chShowUnavail(true);
    else chShowHistoryError('聊天记录加载失败，请检查网络后重试。', chBootChat);
  }
}

/* ---------- 软件壳静默解锁通道（与独立页同一组全局入口，语义不变） ---------- */
window.qfChatState = function () {
  let shellId = '', webId = '';
  try { shellId = chDeviceIdFor('shell'); webId = chDeviceIdFor('web'); } catch (e) {}
  const meta = CH.deviceMeta || [];
  return {
    hasToken: !!chatTok, user: S.user || '', locked: !!CH.locked, unlocked: !!(CH.priv && CH.vaultKey),
    shellDeviceId: shellId, webDeviceId: webId,
    hasShellDeviceCopy: meta.some(d => d.deviceId === shellId),
    hasWebDeviceCopy: meta.some(d => d.deviceId === webId),
    hasDeviceCopy: meta.length > 0,
    hasSessionCopy: !!CH.hasSessionCopy
  };
};
window.qfShellDeviceUnlock = async function (deviceKeyB64) {
  try {
    if (!chatTok || !deviceKeyB64) return false;
    const gen0 = CH.gen; // 扫表 S5：与高-6 同款——ensureChatLibs 在飞期间换账号，旧壳钥匙不得登记到新账号
    await ensureChatLibs();
    if (gen0 !== CH.gen) return false;
    CH.shellDeviceKey = String(deviceKeyB64);
    const ok = await chTryDeviceUnlock();
    if (!ok) return false;
    await chFinishSilentUnlock();
    return true;
  } catch (e) { return false; }
};
window.qfShellDeviceEnroll = async function (deviceKeyB64) {
  try {
    if (!deviceKeyB64 || !(CH.priv && CH.vaultKey)) return false;
    const gen0 = CH.gen; // 高-6：await 前捕代次与钥匙快照，await 后重验——代次变了或钥匙换了，旧壳 deviceKey 不得登记到新账号
    const priv0 = CH.priv, vault0 = CH.vaultKey;
    await ensureChatLibs();
    if (gen0 !== CH.gen || CH.priv !== priv0 || CH.vaultKey !== vault0 || !CH.priv || !CH.vaultKey) return false;
    CH.shellDeviceKey = String(deviceKeyB64);
    return await chEnrollDeviceCopy();
  } catch (e) { return false; }
};
window.qfShellUnlock = async function (password) {
  try {
    if (!chatTok || !password) return false;
    const gen0 = CH.gen; // 扫表 S6：与高-6 同款——两处 await 后都要重验代次，旧账号解出的钥匙不得写进新账号
    await ensureChatLibs();
    if (gen0 !== CH.gen) return false;
    const C = CHC();
    const r = await cq('GET', '/chat/api/keys/me');
    if (gen0 !== CH.gen) return false;
    CH.deviceMeta = r.keys ? (r.keys.devices || []) : [];
    if (r.keys) CH.hasSessionCopy = !!r.keys.hasSessionCopy;
    if (!r.keys) {
      await chCreateKeysSilently(password);
    } else {
      const hasWraps = !!(r.keys.wrappedPriv && r.keys.wrappedVault);
      const priv = hasWraps ? C.unwrapWithPassword(r.keys.wrappedPriv, password) : null;
      const vaultKey = hasWraps ? C.unwrapWithPassword(r.keys.wrappedVault, password) : null;
      if (priv === null || vaultKey === null) {
        if (!(await chFetchSessionCopy())) return false;
        try {
          await cq('POST', '/chat/api/keys/rewrap', {
            wrappedPriv: C.wrapWithPassword(CH.priv, password),
            wrappedVault: C.wrapWithPassword(CH.vaultKey, password)
          });
        } catch (e) { /* 重新包装失败不影响本次已解开的状态 */ }
      } else {
        CH.priv = priv; CH.vaultKey = vaultKey;
      }
    }
    if (gen0 !== CH.gen) return false; // rewrap/取副本在飞期间已换账号：不得把旧账号标为已解锁、不得为新账号登记设备副本
    CH.locked = false;
    chEnrollDeviceCopy().catch(() => {});
    if (!CH.hasSessionCopy) chUploadSessionCopy().catch(() => {});
    await chFinishSilentUnlock();
    return true;
  } catch (e) { return false; }
};

/* ================= 聊天（会话列表与对话区均为控制台原生组件） ================= */
Views.chat = async function (view) {
  /* DS-R07/S3 补修：挂载前先同步当前控制台身份（他标签切号时本页 S.user 可能尚未更新），
     把「本页尚未检出切号」的旧票窗口压到近零；同步后若已被踢/锁定则不再挂载。 */
  await checkSession(true).catch(() => {});
  if (BanLock.active() || !S.auth) {
    /* F-03：提前返回前先给提示——render() 已清空视图，不写内容会留空白页。 */
    view.innerHTML = '<h1 class="pt">聊天</h1><div class="statebox"><b>聊天暂时无法打开</b><p>请先登录账号；如账号被锁定或会话已结束，请稍后再试。</p></div>';
    return;
  }
  view.innerHTML = `<h1 class="pt">聊天</h1><p class="psub">好友聊天内容全程加密，钥匙由您的登录状态保管，登录了账号的设备可直接查看记录。左侧选联系人，右侧即对话，不再跳页。</p>
    <div class="grid2 chatwrap chatwrap-cols"><div class="card chatlist chatpane-list"><h3>会话</h3><div id="chList"><div class="skel sk-h52"></div></div></div>
    <div class="card chatpane-thread"><button class="btn sm grey chatback" id="ch-back" type="button">${ic('chevR')} 返回会话列表</button><h3>对话</h3>
    <div id="chThread">
      <div class="cht-head"><span class="cht-av" id="chAvatar"></span><div class="cht-hmain"><b id="chWith">选择左侧联系人开始聊天</b><div class="cht-sub" id="chSub"></div></div><span class="cht-read" id="chRead"></span></div>
      <div class="note warn" id="chBanner" hidden>官方客服已迁移至智能客服，本会话保留只读查看；如需咨询，请使用智能客服。</div>
      <div class="cht-unavail" id="chUnavail" hidden><div class="statebox"><b>聊天暂时无法打开</b><p>系统暂时无法凭您的登录状态打开聊天记录。聊天钥匙由您的登录状态保管，在已登录账号的设备上通常可直接查看记录。如多次尝试仍无法打开，请联系官方客服协助处理。</p><button class="btn sm grey" id="chUnavailBack" type="button">返回会话列表</button></div></div>
      <div class="cht-msgs" id="chMsgs"><div class="statebox"><b>尚未选择会话</b><p>从左侧列表选择联系人即可查看对话。</p></div></div>
      <div class="cht-comp" id="chComp"><textarea id="chInput" rows="2" placeholder="输入消息…" disabled></textarea><button class="btn" id="chSend" disabled>发送</button><button class="btn grey" id="chDel">删除对话</button></div>
    </div>
    <p class="cht-e2e">对话内容经加密传输与保存：聊天钥匙由您的登录状态保管，服务器侧另以加密形式保管一份钥匙副本（由服务器主密钥保护），仅在您本人登录有效时供您的设备取回；打开聊天时在本机静默解锁，不再有单独解锁页；修改或重置密码后，以前的聊天记录仍可正常打开。</p></div></div>`;
  const wrap = view.querySelector('.chatwrap');
  const box = $('#chList', view);
  const paintList = async () => {
    if (!view.isConnected) return;
    const r = await chatApi('/chat/api/friends');
    if (!view.isConnected) return;
    if (r.status === 200 && r.json) {
      const arr = (r.json.peers && r.json.peers.length) ? r.json.peers : (r.json.friends || r.json.list || (Array.isArray(r.json) ? r.json : []));
      const meta = CH.convMeta || {};
      box.innerHTML = arr.length ? arr.map(f => {
        const name = typeof f === 'string' ? f : (f.name || f.username || '');
        const isSys = typeof f !== 'string' && f.type === 'system';
        const label = isSys ? '官方客服' : name;
        const m = meta[name] || {};
        const unread = !!(m.lastSeq && m.lastSeq > (m.myRead || 0) && CH.currentWith !== name);
        return `<button class="row${CH.currentWith === name ? ' act' : ''}" data-peer="${esc(name)}"><span class="tile">${ic('user')}</span><span><b>${esc(label)}</b><small>${isSys ? '已迁移至智能客服，本会话只读查看' : (m.lastAt ? '最近消息 ' + fmtDate(m.lastAt) : '点此打开对话')}</small></span>${unread ? '<span class="cht-udot"></span>' : ''}<span class="chev">${ic('chevR')}</span></button>`;
      }).join('') : '<div class="statebox"><b>暂无会话</b><p>添加好友后即可开始聊天。</p></div>';
      box.querySelectorAll('[data-peer]').forEach(row => row.addEventListener('click', () => {
        const peer = row.getAttribute('data-peer');
        if (wrap) wrap.classList.add('showthread');
        chOpenConversation(peer);
      }));
    } else {
      const net = !!r.networkError; // CS2-2：接口自身网络失败走网络文案，不落兜底句（原兜底与标题重复）
      const title = net ? '网络暂时不可用' : '会话列表加载失败';
      const why = net ? '网络连接失败，请检查网络后重试。' : (r.ssoError || apiErrText(r, '会话列表加载失败，请稍后重试。'));
      /* MOBILE-FIX 2026-11-14（C-03）：手机单栏（≤820px）下对话区默认隐藏，
         未选中会话时不可达，不再承诺“对话区仍可正常使用”；双栏或已选中会话
         时才保留原句。重试入口（#ch-retry）不变。 */
      const threadReachable = !window.matchMedia('(max-width: 820px)').matches || !!CH.currentWith;
      const threadNote = threadReachable ? '对话区仍可正常使用。' : '对话区在手机上需先打开一个会话；请点「重新加载」重试。';
      box.innerHTML = `<div class="statebox"><b>${esc(title)}</b><p>${esc(why)}</p><p>${threadNote}</p><button class="btn sm" id="ch-retry">重新加载</button></div>`;
      const rb = $('#ch-retry', view); if (rb) rb.onclick = () => paintList();
    }
  };
  /* P2-028 手机单栏分屏：点会话行进对话面、返回钮回列表（切换类仅 ≤820px CSS 生效）；
     C2 起行点击同时打开原生对话组件，返回时一并清当前会话 */
  const back = $('#ch-back', view);
  if (back) back.onclick = () => { if (wrap) wrap.classList.remove('showthread'); chLeaveConversation(); paintList(); };
  mountChatThread(view, {
    refreshList: () => { paintList(); },
    markActive: () => { paintList(); },
    backToList: () => { if (wrap) wrap.classList.remove('showthread'); chLeaveConversation(); paintList(); },
    showThread: () => { if (wrap) wrap.classList.add('showthread'); }
  });
  paintList();
};

/* ================= 论坛 ================= */
let forumBoard = null;
Views.forum = async function (view) {
  view.innerHTML = `<h1 class="pt">论坛</h1><p class="psub">使用求助、建议与反馈、官方公告。游客可浏览，登录后发帖；公告帖可评论。</p>
    <div class="tabs" id="foTabs"><div class="skel sk-h34 sk-w240"></div></div>
    <div id="foPosts"><div class="card"><div class="skel sk-h52"></div></div></div>
    <div class="card"><h3>发布新帖</h3>
      <div class="field"><label>标题</label><input id="fo-title" placeholder="请输入标题"></div>
      <div class="field"><label>内容</label><textarea id="fo-body" rows="3" placeholder="请描述您的问题或建议"></textarea></div>
      <button class="btn sm" id="fo-pub">发布</button> <span class="text-sub fs-13" id="fo-msg"></span></div>
    <div class="note warn">帖子与评论先审后发。被禁言时发帖区将直接显示禁言期限与原因。</div>`;
  const boardsR = await api('/api/forum/boards');
  const tabs = $('#foTabs', view);
  if (boardsR.status !== 200 || !boardsR.json) { tabs.innerHTML = ''; $('#foPosts', view).innerHTML = stateBox('论坛暂时不可用', '请稍后重新加载。', true); bindRetry(view, () => Views.forum(view)); return; }
  const boards = boardsR.json.boards || boardsR.json.list || [];
  if (!forumBoard && boards.length) forumBoard = boards[0].id || boards[0].key || boards[0].name;
  tabs.innerHTML = boards.map(b => `<button data-b="${esc(b.id || b.key || b.name)}" class="${(b.id || b.key || b.name) === forumBoard ? 'on' : ''}">${esc(b.name || b.title || b.id)}</button>`).join('');
  tabs.querySelectorAll('[data-b]').forEach(el => el.onclick = () => { forumBoard = el.getAttribute('data-b'); Views.forum(view); });
  const paintPosts = async () => {
    const box = $('#foPosts', view);
    const pr = await api('/api/forum/posts?board=' + encodeURIComponent(forumBoard || ''));
    const posts = (pr.json && (pr.json.posts || pr.json.list)) || [];
    /* MOBILE-FIX 2026-11-14（C-01/C-02）：卡标题用版块 name 不用 raw id；
       meta 各段条件拼接、过滤空值，缺 replyCount 时不留悬空“·”，0 回复照常显示。 */
    const boardHit = boards.find(b => (b.id || b.key || b.name) === forumBoard) || {};
    const boardName = boardHit.name || boardHit.title || forumBoard || '帖子';
    box.innerHTML = `<div class="card"><h3>${esc(boardName)}</h3>${posts.length ? posts.map(p => { const metaParts = [(p.authorName || p.author || p.nickname || ''), (p.createdAt ? fmtDate(p.createdAt) : (p.time || ''))].filter(Boolean); if (p.replyCount != null) metaParts.push(p.replyCount + ' 条回复'); return `<div class="row" data-pid="${esc(p.id || '')}"><span class="tile">${ic('forum')}</span><span><b>${esc(p.title || '')}</b><small>${esc(metaParts.join(' · '))}</small></span>${p.board === 'announcements' ? '<span class="tag">公告</span>' : ''}</div>`; }).join('') : '<div class="statebox"><b>暂无帖子</b><p>来发布第一篇帖子吧。</p></div>'}</div>`;
    box.querySelectorAll('[data-pid]').forEach(el => el.onclick = () => { forumListMemo = { board: forumBoard, scrollY: window.scrollY }; forumMemoArmed = true; navigate('post', el.getAttribute('data-pid')); });
    if (forumMemoArmed && forumListMemo && forumListMemo.board === forumBoard) {
      const y = forumListMemo.scrollY; forumListMemo = null; forumMemoArmed = false;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  };
  paintPosts();
  $('#fo-pub', view).onclick = async () => {
    const msg = $('#fo-msg', view);
    // 发帖前走一次性 SSO 换论坛会话（与现行口径一致）
    const so = await api('/api/forum/sso-token', { method: 'POST', json: {} });
    if (so.json && so.json.loginPath) await api(so.json.loginPath);
    const r = await forumFetch('/api/forum/posts', { method: 'POST', json: { board: forumBoard, title: $('#fo-title', view).value.trim(), body: $('#fo-body', view).value.trim() } });
    msg.textContent = (r.json && (r.json.msg || (r.json.ok ? '已提交，审核通过后显示。' : '发布未成功，请稍后再试。'))) || '发布未成功，请稍后再试。';
    if (r.json && r.json.ok) { $('#fo-title', view).value = ''; $('#fo-body', view).value = ''; paintPosts(); }
  };
};

/* ================= 论坛帖子详情（P2-037） ================= */
var forumListMemo = null;      // {board, scrollY}：帖行点击时写入，返回列表恢复一次
var forumMemoArmed = false;    // 武装标记：仅刚从详情返回的列表渲染可消费 memo
let postReloadSeq = 0;         // 详情整帖重拉序号（防乱序覆盖）

/* 论坛写操作单次请求助手：与 api() 同形、同 init，唯不自动重试——
   发帖/回帖非幂等，网络异常自动重试会重复落库（服务端无幂等键）。 */
async function forumFetch(path, opts) {
  opts = opts || {};
  const init = { credentials: 'include', method: opts.method || 'GET', headers: {} };
  if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  if (opts.headers) Object.assign(init.headers, opts.headers);
  try {
    const r = await fetch(path, init);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应按文本处理 */ }
    return { status: r.status, ok: r.ok, json, text };
  } catch (e) { return { status: 0, ok: false, json: null, text: '', networkError: e }; }
}

/* 论坛会话建立（与发帖流同一对调用）。返回：
   {state:'live', me} 已登录（me 含 muted/accountStatus）｜
   {state:'notice', msg} 只读提示（msg 为服务端原文，可为 null）｜
   {state:'open'} 网络不定态（显示侧 fail-open，终裁在提交回执）。
   onCookieReady 在 sso-login 落 cookie 后回调，详情 GET 须带会话先行。 */
async function forumEnsureSession(onCookieReady) {
  const done = () => { if (onCookieReady) onCookieReady(); };
  const so = await api('/api/forum/sso-token', { method: 'POST', json: {} });
  if (so.status === 0) { done(); return { state: 'open' }; }
  if (!so.json || !so.json.ok) {
    done();
    if (so.json && so.json.msg) return { state: 'notice', msg: so.json.msg };
    return { state: 'open' };
  }
  if (so.json.loginPath) await api(so.json.loginPath);
  done();
  const me = await api('/api/forum/me');
  if (me.status === 0) return { state: 'open' };
  if (me.json && me.json.user) return { state: 'live', me: me.json };
  return { state: 'notice', msg: null };
}

function pfStatusTags(x) {
  let s = '';
  if (x.status === 'pending') s += '<span class="tag pf-t-pend">待审核</span>';
  if (x.status === 'rejected') s += '<span class="tag pf-t-rej">已驳回' + (x.reviewCategory ? '：' + esc(x.reviewCategory) : '') + '</span>';
  if (x.banHidden) s += '<span class="tag pf-t-hid">暂不可见</span>';
  return s;
}
function pfAuthor(x) {
  return esc(x.authorName || x.author || '') + (x.authorOfficial ? ' <span class="tag pf-off">官方</span>' : '');
}

Views.post = async function (view, param, seq) {
  const id = String(param || '');
  view.innerHTML = `<div class="pf-backrow"><button class="btn ghost sm" id="pf-back">← 返回</button></div>
    <div id="pfPost"><div class="card"><div class="skel sk-h52"></div></div></div>
    <div id="pfReplies"></div>
    <div id="pfComposer"><div class="card"><div class="skel sk-h40"></div></div></div>`;
  const backBtn = $('#pf-back', view);
  if (backBtn) backBtn.onclick = () => { if (forumListMemo) forumBoard = forumListMemo.board; navigate('forum'); };
  const alive = () => seq === renderSeq && S.route.name === 'post' && S.route.param === id;
  if (!/^p\d+$/.test(id)) {
    $('#pfPost', view).innerHTML = stateBox('帖子不存在或不可见。', '请返回帖子列表查看其他帖子。', false);
    $('#pfComposer', view).innerHTML = '';
    return;
  }
  let sessState = null;
  let boardNames = null;
  const paintMain = (post, replies) => {
    const boardName = (boardNames && boardNames[post.board]) || post.board || '';
    $('#pfPost', view).innerHTML = `<div class="card"><h2 class="pf-title">${esc(post.title || '')} ${pfStatusTags(post)}</h2>
      <div class="pf-meta">${pfAuthor(post)} · ${esc(boardName)} · ${fmtDate(post.createdAt)} · 浏览 ${post.views || 0} · 回复 ${post.replyCount != null ? post.replyCount : (replies || []).length}</div>
      ${post.mine && post.status === 'pending' ? '<div class="note warn mt-10">本帖正在审核中，审核通过后其他用户可见。</div>' : ''}
      <div class="pf-body">${esc(post.body || '')}</div></div>`;
    const items = replies || [];
    $('#pfReplies', view).innerHTML = `<div class="card"><h3>回复（${items.length}）</h3>${items.length ? items.map(r => `<div class="pf-reply"><div class="pf-meta">${pfAuthor(r)} · ${fmtDate(r.createdAt)} ${pfStatusTags(r)}</div><div class="pf-rbody">${esc(r.body || '')}</div></div>`).join('') : '<div class="statebox"><b>暂无回复</b><p id="pf-empty-sub" hidden>来发表第一条回复吧。</p></div>'}</div>`;
  };
  const reloadPost = async () => {
    const my = ++postReloadSeq;
    const det = await api('/api/forum/posts/' + encodeURIComponent(id));
    if (my !== postReloadSeq || !alive() || det.status !== 200 || !det.json || !det.json.ok) return;
    paintMain(det.json.post, det.json.replies || []);
    const items = view.querySelectorAll('.pf-reply');
    if (items.length) items[items.length - 1].scrollIntoView({ block: 'nearest' });
  };
  const paintComposer = () => {
    const box = $('#pfComposer', view);
    const hint = $('#pf-empty-sub', view);
    const setHint = (on) => { if (hint) hint.hidden = !on; };
    const renderEditor = () => {
      box.innerHTML = `<div class="card"><h3>发表回复</h3>
        <div class="field"><textarea id="pf-text" rows="3" placeholder="请输入回复内容"></textarea><div class="hint">回复内容为 1 至 2000 字，提交后先审后发。</div></div>
        <button class="btn sm" id="pf-send">发表回复</button> <span class="fs-13" id="pf-msg"></span></div>`;
      const btn = $('#pf-send', view), ta = $('#pf-text', view), msg = $('#pf-msg', view);
      let sending = false;
      btn.onclick = async () => {
        if (sending) return;
        const body = (ta.value || '').trim();
        if (!body) { msg.textContent = '请填写回复内容，长度为 1 至 2000 字。'; msg.style.color = 'var(--tx)'; return; }
        sending = true; btn.disabled = true; ta.disabled = true; msg.textContent = '';
        const fail = (text) => { msg.textContent = text; msg.style.color = 'var(--tx)'; };
        try {
          let r = await forumFetch('/api/forum/posts/' + encodeURIComponent(id) + '/replies', { method: 'POST', json: { body } });
          if (r.status === 401) {
            // 无会话 401 发生在服务端落库之前（路由闸门），重交换后可安全单次重提
            const re = await forumEnsureSession();
            if (re.state === 'live') { sessState = re; r = await forumFetch('/api/forum/posts/' + encodeURIComponent(id) + '/replies', { method: 'POST', json: { body } }); }
            else { fail(re.state === 'notice' ? (re.msg || '登录后可回复。') : '网络暂时不可用，请稍后再试。'); return; }
          }
          if (r.status === 0) { fail('网络暂时不可用，请稍后再试。'); return; }
          const j = r.json || {};
          if (j.ok) { msg.textContent = j.msg || '回复成功。'; msg.style.color = 'var(--tx)'; ta.value = ''; reloadPost(); }
          else fail(j.msg || '提交未成功，请稍后再试。');
        } finally { sending = false; btn.disabled = false; ta.disabled = false; }
      };
    };
    if (!sessState || sessState.state === 'open') { renderEditor(); setHint(true); return; }
    if (sessState.state === 'notice') { box.innerHTML = `<div class="card"><div class="note warn m-0">${esc(sessState.msg || '登录后可回复。')}</div></div>`; setHint(false); return; }
    const me = sessState.me || {};
    // 状态呈现顺序与服务端门 runGatesAndReview 一致：账号冻结/封禁先于禁言（DS 实现稿偏离#1 采纳）
    if (me.accountStatus && me.accountStatus !== 'ok') {
      box.innerHTML = `<div class="card"><div class="note err m-0">您的账号已被冻结或封禁，无法发帖。申诉请联系官方客服，或前往官网留言。</div></div>`;
      setHint(false); return;
    }
    if (me.muted) {
      const until = me.muted.permanent ? '永久禁言' : fmtDate(me.muted.until);
      box.innerHTML = `<div class="card"><div class="note warn m-0">您已被论坛禁言（至 ${esc(until)}），仅限制论坛发言，账号与设备不受影响。申诉请联系官方客服，或前往官网留言。</div></div>`;
      setHint(false); return;
    }
    renderEditor(); setHint(true);
  };
  // 会话先行落 cookie，详情 GET 随即带会话发（作者可见自己的待审内容）
  let detResolve;
  const detP = new Promise(r => { detResolve = r; });
  const sessP = forumEnsureSession(() => { api('/api/forum/posts/' + encodeURIComponent(id)).then(detResolve); });
  const boardsP = api('/api/forum/boards');
  const det = await detP;
  if (!alive()) return;
  if (det.status === 0) {
    $('#pfPost', view).innerHTML = stateBox('网络暂时不可用', '与服务器的连接出现问题，请检查网络后重新加载。', true);
    bindRetry(view, () => Views.post(view, param, seq));
    $('#pfComposer', view).innerHTML = '';
    return;
  }
  if (det.status !== 200 || !det.json || !det.json.ok) {
    const is404 = det.status === 404;
    $('#pfPost', view).innerHTML = stateBox((det.json && det.json.msg) || '帖子不存在或不可见。', is404 ? '请返回帖子列表查看其他帖子。' : '请稍后重新加载。', !is404);
    if (!is404) bindRetry(view, () => Views.post(view, param, seq));
    $('#pfComposer', view).innerHTML = '';
    return;
  }
  const bres = await boardsP;
  if (bres.json && (bres.json.boards || bres.json.list)) {
    boardNames = {};
    (bres.json.boards || bres.json.list).forEach(b => { boardNames[b.key || b.id] = b.name || b.title || b.key || b.id; });
  }
  if (!alive()) return;
  paintMain(det.json.post, det.json.replies || []);
  sessState = await sessP;
  if (!alive()) return;
  paintComposer();
};

/* ================= 智能客服（AI 通道 + 知识库兜底 + 转人工） ================= */
Views.support = async function (view, _p, _s, opts) {
  opts = opts || {};
  view.innerHTML = `${opts.guest ? '' : '<h1 class="pt">智能客服</h1><p class="psub">先由智能客服自动回答；解决不了可转人工。未登录、账号被冻结或封禁时也可使用本页。</p>'}
    <div class="note blue">与智能客服的对话不使用与好友聊天相同的加密方式，内容仅用于客服处理。涉及账号状态时，客服只查询您本人的状态；办理类事项会先核验账号与密码，只核验、不登录。</div>
    <div class="card"><h3>智能客服 <span class="tag">AI 通道</span></h3>
    <div id="supMsgs"><div class="skel sk-h40"></div></div>
    <div class="flex-row mb-10" id="supPicks"></div>
    <div class="flex-row"><input class="sup-input" id="sup-in" placeholder="请输入您的问题…"><button class="btn" id="sup-send">发送</button><button class="btn ghost" id="sup-human">转人工</button></div>
    <p class="text-sub fs-12x5 mt-10">AI 通道异常时自动切换为知识库问答，不会无响应。转人工后，处理进度在本页同一会话中显示。</p></div>`;
  const msgs = $('#supMsgs', view);
  let token = null;
  const addMsg = (who, text, mine) => {
    const d = document.createElement('div');
    d.className = 'msg' + (mine ? ' me' : '');
    d.innerHTML = mine ? `<div class="bub">${esc(text)}</div><span class="uava">${esc((S.displayName || '我').slice(0, 1))}</span>` : `<span class="uava">客</span><div class="bub">${esc(text)}<small>智能客服 · 自动回复</small></div>`;
    msgs.appendChild(d); d.scrollIntoView({ block: 'nearest' });
  };
  const setPicks = (picks) => {
    const box = $('#supPicks', view); box.innerHTML = '';
    (picks || []).forEach(p => {
      const b = document.createElement('button'); b.className = 'btn sm ghost';
      b.textContent = (p && (p.label || p.text)) || String(p);
      b.onclick = () => send(null, (p && (p.id || p.value)) || b.textContent);
      box.appendChild(b);
    });
  };
  const renderReplies = (replies) => {
    (replies || []).forEach(rp => {
      if (typeof rp === 'string') addMsg('cs', rp, false);
      else { if (rp.text) addMsg('cs', rp.text, false); if (rp.picks) setPicks(rp.picks); if (rp.options) setPicks(rp.options); if (rp.kind === 'verify-required' || (rp.follow && rp.follow.type === 'verify')) renderVerify(); }
    });
  };
  const renderVerify = () => {
    if ($('#sup-verify', view)) return;
    const d = document.createElement('div');
    d.id = 'sup-verify'; d.className = 'note warn';
    d.innerHTML = `查询账号状态前请核验身份（只核验、不登录）：<div class="flex-row mt-8"><input class="mini-input" id="sv-u" placeholder="账号"><input class="mini-input" id="sv-p" type="password" placeholder="密码"><button class="btn sm" id="sv-b">核验并查询</button></div>`;
    msgs.appendChild(d);
    $('#sv-b', d).onclick = async () => {
      const r = await api('/support/api/verify', { method: 'POST', json: { session: token, account: $('#sv-u', d).value.trim(), password: $('#sv-p', d).value } });
      const j = (r && r.json) || {};
      if (j.ok) {
        // 核对通过：撤表单并回读引擎随核验返回的状态答复（follow），与独立
        // 客服页同一口径；此前这里不读 follow、且把成功也误报「核验未通过」。
        d.remove();
        addMsg('cs', '身份核对已通过，下面按您的账号状态答复。', false);
        if (j.follow) renderReplies(j.follow);
      } else if (j.text) {
        d.remove();
        addMsg('cs', j.text, false);
      } else if (j.reason === 'unavailable') {
        addMsg('cs', '身份核对暂时不可用，无法查询账号状态。您可以先按通用指引处理，或回复「转人工」由人工协助。', false);
      } else if (j.reason === 'locked') {
        addMsg('cs', '核对次数过多，已暂时锁定，请一小时后再试；着急处理可回复「转人工」。', false);
      } else {
        addMsg('cs', '核验未通过，请核对账号与密码后重试。', false);
      }
    };
  };
  const send = async (text, pick) => {
    if (text) addMsg('me', text, true);
    const r = await api('/support/api/message', { method: 'POST', json: { session: token, text: text || undefined, pick: pick || undefined } });
    if (r.status === 200 && r.json && r.json.ok) renderReplies(r.json.replies);
    else addMsg('cs', (r.json && r.json.msg) || '客服暂时不可用，请稍后再试；也可以留下问题转人工处理。', false);
  };
  const sess = await api('/support/api/session', { method: 'POST', json: {} });
  msgs.innerHTML = '';
  if (sess.status === 200 && sess.json && sess.json.ok) {
    token = sess.json.session;
    const w = sess.json.welcome;
    addMsg('cs', typeof w === 'string' ? w : (w && w.text) || '您好，我是 QFRemote 智能客服。软件使用、密钥、积分、订单、换绑与申诉问题都可以问我；日常问题也可以聊。', false);
    if (w && w.picks) setPicks(w.picks);
  } else { addMsg('cs', '客服会话建立失败，请稍后重新进入本页。', false); }
  $('#sup-send', view).onclick = () => { const v = $('#sup-in', view).value.trim(); if (v) { $('#sup-in', view).value = ''; send(v); } };
  $('#sup-in', view).addEventListener('keydown', (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') $('#sup-send', view).click(); }); // S-052：组合输入（IME）中不发送
  $('#sup-human', view).onclick = () => send('转人工');
};

/* ================= 购买与订单（N-1 截图审核付款，决策 #44 抽屉式 / #45 小字） ================= */
const PLANS = [
  { id: 'd1', name: '1 日套餐', price: 2, amt: '2', desc: '自激活起 24 小时有效' },
  { id: 'd7', name: '7 日套餐', price: 6, amt: '6', desc: '自激活起 168 小时有效' },
  { id: 'd30', name: '30 日套餐', price: 9.9, amt: '9.9', desc: '自激活起 720 小时有效' },
  { id: 'permanent', name: '永久套餐', price: 18, amt: '18', desc: '一次购买，终生免费更新' }
];
function fmtSecText(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
}
function payCardUrl(method, amt) { return '/license/pay-cards/pay-' + method + '-' + amt + '.png'; }
function localPayCard(method, amt) { return 'assets/pay-' + method + '-' + amt + '.png'; }
function methodName(m) { return m === 'alipay' ? '支付宝' : '微信支付'; }
/* 收款码放大层（2026-10-26 站长令）：复用站内弹窗层——点任意处、关闭钮、ESC 均可收起；
   纯展示，不触碰订单状态与支付倒计时。支付方式由展开区顶部页签（[data-method]）切换
   （#47 定版结构），下方只独立展示选中方式的一张收款卡，放大热区（.qrzoom）与页签互不干扰。 */
function openQrZoom(o) {
  const amt = String(o.amt == null ? '' : o.amt);
  const fb = /^[0-9.]+$/.test(amt) ? localPayCard(o.method, amt) : '';
  const root = showModal(methodName(o.method), `
    <div class="qrzoom-box">
      <img class="qrzoom-img" src="${esc(o.url || fb)}" alt="${esc(methodName(o.method))}收款码"${fb ? ` onerror="this.onerror=null;this.src='${fb}'"` : ''}>
      <p class="qrzoom-meta">${esc(o.planName || '')} · ¥${esc(amt)}</p>
      <p class="qrzoom-tip">金额已由收款码锁定，无需修改。点击任意处关闭。</p>
    </div>`, [{ label: '关闭', primary: true }]);
  const mask = root.querySelector('.mask');
  if (mask) mask.addEventListener('click', () => closeModal());
}
/* 订单视图模型统一：只用 N-1 回的字段（id/plan/planName/amount/method/status/
   statusText/payDeadline/remainingSec/canCancel/canContinue/canSubmit/canDelete/
   createdAt/submittedAt/orderNo/keyId），不编造字段。 */
function orderPill(o) {
  const cls = (o.status === 'completed' || o.canViewKey) ? 'ok' : (o.status === 'pending_pay' ? 'warn' : (o.status === 'reviewing' ? 'brand' : (o.status === 'rejected' ? 'err' : 'off')));
  return `<span class="pill ${cls}">${esc(o.statusText || o.status || '')}</span>`;
}

Views.purchase = async function (view, param, _s, opts) {
  opts = opts || {};
  const guest = !!opts.guest || S.auth !== 'in';
  const hasPerm = !guest && S.license && /永久/.test(S.license.planName || '');
  // 叠加语境红字提示（站长 2026-10-26 亲令，文案终版逐字）：已激活时效套餐
  // （非试用、非永久、keyExpiresMs 已落点）才显示，位置＝「我的订单」按钮正下方。
  const stackNote = (!guest && !hasPerm && S.license && S.license.keyPlan !== 'permanent' && S.license.keyExpiresMs && !/试用/.test(S.license.planName || ''))
    ? '<p class="text-navy fs-13x5 mb-14">购买叠加的用户，购买后请到我的账户中兑换叠加套餐</p>' : '';
  let expanded = null;                 // 当前展开的套餐 id（单开）
  const byPlan = {};                   // planId -> { order, pay }
  const ensureOrderFlights = {};       // 批A-W3-F1：planId -> true（建单在飞守卫，防收起再展开重复建单）
  const guestMethod = {};              // 游客态各套餐选中的支付方式（页签切换仅换展示，无订单）
  let timer = null;
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  view.innerHTML = `${opts.guest ? '' : '<h1 class="pt">购买密钥</h1><p class="psub">一个密钥可绑定两台电脑与一台手机；购买付费密钥后同时开通网页版。点开任一套餐即可在本页付款，付款后提交账单截图等待审核。</p>'}
    ${guest ? '' : '<p class="mb-14"><button class="btn sm ghost" id="pur-orders">我的订单</button></p>'}
    ${stackNote}
    <div class="planlist" id="purList">${PLANS.map(p => {
      const dis = hasPerm && p.id === 'permanent';
      return `<div class="planitem" data-planitem="${p.id}">
        <button class="planhead" data-plan="${p.id}" aria-expanded="false" ${dis ? 'disabled' : ''}>
          <span><b>${esc(p.name)}</b><small>${dis ? '您已持有永久套餐，不可重复购买' : esc(p.desc)}</small></span>
          <span class="planprice">¥${esc(p.amt)}</span><span class="chev">${ic('chevR')}</span>
        </button>
        <div class="drawerpay" data-drawer="${p.id}" hidden></div>
      </div>`;
    }).join('')}</div>
    <div class="note blue mt-16">待支付订单保留 15 分钟，超时自动取消；可在「我的订单」中继续支付或手动取消。提交账单截图后订单进入审核，审核通过后可在「我的订单」查看并复制密钥，粘贴激活后即可使用。</div>`;
  const ordersBtn = $('#pur-orders', view);
  if (ordersBtn) ordersBtn.onclick = () => navigate('orders');

  function drawerEl(planId) { return view.querySelector('[data-drawer="' + planId + '"]'); }
  function paintHeads() {
    view.querySelectorAll('[data-planitem]').forEach(it => {
      const pid = it.getAttribute('data-planitem');
      it.classList.toggle('open', pid === expanded);
      const head = it.querySelector('[data-plan]');
      if (head) head.setAttribute('aria-expanded', pid === expanded ? 'true' : 'false');
      const dr = it.querySelector('[data-drawer]');
      if (dr) dr.hidden = pid !== expanded;
    });
  }
  function startTimer(planId, deadlineMs) {
    stopTimer();
    const tick = () => {
      const el = view.querySelector('[data-cd="' + planId + '"]');
      if (!el || !el.isConnected || expanded !== planId) { stopTimer(); return; }
      const left = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
      el.textContent = fmtSecText(left);
      if (left <= 0) stopTimer();
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  function renderDrawer(planId) {
    const dr = drawerEl(planId); if (!dr) return;
    const plan = PLANS.find(x => x.id === planId);
    if (guest) {
      const gm = guestMethod[planId] || 'wechat';
      const gUrl = localPayCard(gm, plan.amt);
      dr.innerHTML = `
        <div class="paytabs"><button class="paytab ${gm === 'wechat' ? 'on' : ''}" data-gmethod="wechat">微信支付</button><button class="paytab ${gm === 'alipay' ? 'on' : ''}" data-gmethod="alipay">支付宝</button></div>
        <div class="paycard single"><div class="qrzoom" data-zoom="${gm}" data-zoomurl="${gUrl}"><img src="${gUrl}" alt="${esc(methodName(gm))}收款码"><p class="qrzoom-hint">点击二维码放大</p></div><p>¥${esc(plan.amt)} · 金额已由收款码锁定，无需修改</p></div>
        <div class="drawerops"><button class="btn" data-act="paid">支付成功</button><button class="btn grey" data-act="leave">取消</button></div>
        <div data-out></div>`;
      bindDrawerOps(planId);
      return;
    }
    const st = byPlan[planId];
    if (!st) { dr.innerHTML = '<div class="skel sk-h60"></div><p class="ordnote" style="color:var(--sub)">正在创建订单…</p>'; return; }
    if (st.error) {
      dr.innerHTML = `<div class="note err m-0">${esc(st.error)}</div>
        <div class="drawerops"><button class="btn grey" data-act="leave">取消</button></div>`;
      bindDrawerOps(planId);
      return;
    }
    const o = st.order, pay = st.pay || {};
    // R-W19（2026-11-15）：amt/curMethod 为服务端值，进 HTML/JS 上下文前须校验——
    // amt 只许数字与小数点（与 openQrZoom 同口径），非法时回落静态套餐价；
    // curMethod 只许 wechat/alipay，其余一律回落 wechat（与 methodName 口径一致）。
    // 校验后两值只含 [a-z0-9.]，下方 data-zoom 与 onerror 内插即安全。
    const rawAmt = String(o.amount != null ? o.amount : plan.amt);
    const amt = /^[0-9.]+$/.test(rawAmt) ? rawAmt : String(plan.amt);
    const curMethod = (o.method || pay.method) === 'alipay' ? 'alipay' : 'wechat';
    const wxUrl = curMethod === 'wechat' ? (pay.cardUrl || payCardUrl('wechat', amt)) : (pay.otherCardUrl || payCardUrl('wechat', amt));
    const aliUrl = curMethod === 'alipay' ? (pay.cardUrl || payCardUrl('alipay', amt)) : (pay.otherCardUrl || payCardUrl('alipay', amt));
    const curUrl = curMethod === 'wechat' ? wxUrl : aliUrl;
    if (o.status === 'reviewing') {
      dr.innerHTML = `<div class="note ok m-0-0-10">已提交，正在审核。审核通过后，可在「我的订单」查看并复制密钥，粘贴激活后即可使用。</div>
        <div class="tblwrap"><table><tr><th>本站订单</th><td>${esc(o.id)}</td></tr><tr><th>套餐</th><td>${esc(o.planName || plan.name)} · ¥${esc(amt)}</td></tr><tr><th>状态</th><td>${orderPill(o)}</td></tr></table></div>
        <div class="drawerops"><button class="btn grey" data-act="leave">收起</button><button class="btn sm ghost" data-act="orders">查看我的订单</button></div>`;
      bindDrawerOps(planId);
      return;
    }
    if (o.status !== 'pending_pay') {
      dr.innerHTML = `<div class="note blue m-0-0-10">该订单当前状态：${esc(o.statusText || o.status)}。</div>
        <div class="drawerops"><button class="btn grey" data-act="leave">收起</button><button class="btn sm ghost" data-act="orders">查看我的订单</button></div>`;
      bindDrawerOps(planId);
      return;
    }
    const deadline = o.payDeadline || (Date.now() + (Number(o.remainingSec) || 0) * 1000);
    dr.innerHTML = `
      <p class="text-sub fs-13x5 mb-4">本站订单：${esc(o.id)} · ${orderPill(o)} · 剩余支付时间：<b data-cd="${planId}">${fmtSecText(o.remainingSec)}</b></p>
      <p class="text-sub fs-13x5 mb-12">请扫码付款 <b class="text-navy">¥${esc(amt)}</b>，金额已由收款码锁定，无需修改。在上方选择微信支付或支付宝，下方只显示对应的收款码；切换支付方式沿用原订单与剩余时间。点击二维码可放大查看。</p>
      <div class="paytabs"><button class="paytab ${curMethod === 'wechat' ? 'on' : ''}" data-method="wechat">微信支付</button><button class="paytab ${curMethod === 'alipay' ? 'on' : ''}" data-method="alipay">支付宝</button></div>
      <div class="paycard single"><div class="qrzoom" data-zoom="${curMethod}" data-zoomurl="${esc(curUrl)}"><img src="${esc(curUrl)}" alt="${esc(methodName(curMethod))}收款码" onerror="this.onerror=null;this.src='${localPayCard(curMethod, amt)}'"><p class="qrzoom-hint">点击二维码放大</p></div><p>¥${esc(amt)} · 当前支付方式：${esc(methodName(curMethod))}</p></div>
      <div class="drawerops"><button class="btn" data-act="paid">支付成功</button><button class="btn grey" data-act="leave">取消</button></div>
      <div data-out></div>
      <div data-submit hidden>
        <h3 class="text-navy m-16-0-6">提交付款截图</h3>
        <p class="text-sub fs-13x5 mb-12">请上传付款账单详情截图。<b class="text-navy">截图必须露出完整订单号</b>，并填写截图中的订单号。一个订单号只能兑换一把密钥。</p>
        <img class="pay-example" src="${esc(pay.exampleUrl || '/license/assets/pay-example.jpg')}" alt="账单详情截图示例" onerror="this.style.display='none'">
        <div class="field"><label>订单号</label><input data-ono maxlength="64" placeholder="请填写截图中的完整订单号"></div>
        <div class="field"><label>账单详情截图（JPG / PNG，不超过 12 MB）</label><input type="file" data-shot accept="image/jpeg,image/png" class="filepick" id="payShot"><label for="payShot" class="btn sm ghost">选择截图</label></div>
        <div class="m-2-0-10" data-ocr hidden></div>
        <button class="btn block" data-act="submit">提交审核</button>
        <div class="mt-12" data-subout></div>
      </div>`;
    bindDrawerOps(planId);
    startTimer(planId, deadline);
  }

  function bindDrawerOps(planId) {
    const dr = drawerEl(planId); if (!dr) return;
    // 截图订单号自动识别（选图即触发，仅回填、不拦提交；失败静默回落手输。文案 WEB-0398~0403）
    const ocrFileEl = dr.querySelector('[data-shot]');
    const ocrOnoEl = dr.querySelector('[data-ono]');
    const ocrBox = dr.querySelector('[data-ocr]');
    let ocrInvalidate = null; // 门一 S9：提交动作经此作废在飞识别（下方提交分支调用）
    if (ocrFileEl && ocrOnoEl && ocrBox && !guest) {
      let ocrSeq = 0;
      let ocrTimer = null;
      const OCR_TIMEOUT_MS = 14000; // 门一 D5：客户端本地超时（13–15s 档），超时置未认出文案并作废在飞响应
      const normOno = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ''); // 门一 S8：与服务端 A12 同口径（NFKC＋去空白）后再比较
      const ocrHint = (t) => { ocrBox.hidden = false; ocrBox.innerHTML = `<p class="text-sub fs-13 m-0">${esc(t)}</p>`; };
      const ocrClearTimer = () => { if (ocrTimer) { clearTimeout(ocrTimer); ocrTimer = null; } };
      ocrInvalidate = () => { ocrSeq++; ocrClearTimer(); ocrBox.hidden = true; ocrBox.innerHTML = ''; };
      ocrFileEl.addEventListener('change', async () => {
        const my = ++ocrSeq;
        ocrClearTimer();
        const f = ocrFileEl.files ? ocrFileEl.files[0] : null;
        const st = byPlan[planId];
        if (!f || !st || !st.order) { ocrBox.hidden = true; ocrBox.innerHTML = ''; return; }
        ocrHint('正在识别订单号…');
        ocrTimer = setTimeout(() => {
          ocrTimer = null;
          if (my !== ocrSeq) return;
          ocrSeq++; // 本地超时作废在飞：迟到响应不得再回填
          ocrHint('未能识别订单号，请手动填写。');
        }, OCR_TIMEOUT_MS);
        let j = null;
        try {
          const b64 = await readFileBase64(f);
          const r = await api('/license/api/pay/orders/' + encodeURIComponent(st.order.id) + '/recognize', { method: 'POST', json: { imageBase64: b64 } });
          j = r && r.json ? r.json : null;
        } catch (e) { j = null; }
        if (my !== ocrSeq) return; // 已重选图/已提交/已超时，旧响应作废
        ocrClearTimer();
        if (j && j.ok === false && j.code === 'PAYLOAD_TOO_LARGE') {
          // 门一 D3：超限单独同句提示（与提交侧同文案），不走静默回落；其余 ok:false 码维持静默
          ocrHint(j.msg || '截图文件过大，请上传不超过 12 MB 的 JPG 或 PNG 图片。');
        } else if (j && j.ok && j.found && j.orderNo) {
          const cur = ocrOnoEl.value;
          if (!normOno(cur)) { ocrOnoEl.value = j.orderNo; ocrHint('已自动识别订单号，请核对无误后提交。'); }
          else if (normOno(cur) === j.orderNo) { ocrHint('识别结果与您填写的订单号一致。'); }
          else {
            ocrBox.hidden = false;
            ocrBox.innerHTML = `<p class="text-sub fs-13 mb-8">您填写的订单号与识别结果不一致。</p><button type="button" class="btn sm ghost" data-ocruse>识别到订单号（尾号 ${esc(j.tail4 || String(j.orderNo).slice(-4))}），点击使用识别结果</button>`;
            const useBtn = ocrBox.querySelector('[data-ocruse]');
            if (useBtn) useBtn.onclick = () => { ocrOnoEl.value = j.orderNo; ocrHint('已自动识别订单号，请核对无误后提交。'); };
          }
        } else { ocrHint('未能识别订单号，请手动填写。'); }
      });
    }
    dr.querySelectorAll('[data-zoom]').forEach(z => {
      z.onclick = (e) => {
        e.stopPropagation(); // 放大热区与卡片切换热区分离：点码只放大，不触发支付方式切换
        const plan = PLANS.find(x => x.id === planId);
        const st = byPlan[planId];
        const amt = (!guest && st && st.order && st.order.amount != null) ? String(st.order.amount) : (plan ? plan.amt : '');
        openQrZoom({ method: z.getAttribute('data-zoom'), url: z.getAttribute('data-zoomurl'), planName: plan ? plan.name : '', amt });
      };
    });
    dr.querySelectorAll('[data-gmethod]').forEach(t => {
      t.onclick = () => { // 游客态页签：仅切换展示的收款卡，无订单、不走 continue
        const m = t.getAttribute('data-gmethod');
        if ((guestMethod[planId] || 'wechat') !== m) { guestMethod[planId] = m; renderDrawer(planId); }
      };
    });
    dr.querySelectorAll('[data-method]').forEach(tab => {
      tab.onclick = async () => {
        if (guest) return;
        const st = byPlan[planId]; if (!st || !st.order) return;
        const m = tab.getAttribute('data-method');
        if (m === st.order.method) return;
        const r = await api('/license/api/pay/orders/' + encodeURIComponent(st.order.id) + '/continue', { method: 'POST', json: { method: m } });
        if (r.json && r.json.ok && r.json.pay) { st.pay = r.json.pay; st.order = Object.assign({}, st.order, { method: r.json.pay.method, remainingSec: r.json.pay.remainingSec }); renderDrawer(planId); }
        else toast(apiErrText(r, '切换支付方式失败，请稍后再试。'), 'err');
      };
    });
    dr.querySelectorAll('[data-act]').forEach(el => {
      el.onclick = async () => {
        const act = el.getAttribute('data-act');
        const out = dr.querySelector('[data-out]');
        if (act === 'orders') { navigate('orders'); return; }
        if (act === 'leave') {
          expanded = null; stopTimer(); paintHeads();
          if (!guest) toast('订单已保留为待支付，请在 15 分钟内于「我的订单」继续支付或手动取消。', 'info');
          return;
        }
        if (act === 'paid') {
          if (guest || S.auth !== 'in') { if (out) out.innerHTML = '<div class="note warn mt-12">下单前请先登录；没有账号可以先注册（注册即开通 3 天免费试用）。</div>'; return; }
          const sub = dr.querySelector('[data-submit]');
          if (sub) { sub.hidden = false; sub.style.scrollMarginTop = '132px'; sub.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          return;
        }
        if (act === 'submit') {
          if (ocrInvalidate) ocrInvalidate(); // 门一 S9：提交后在飞识别一律作废，迟到响应不得回填
          const subout = dr.querySelector('[data-subout]');
          const onoEl = dr.querySelector('[data-ono]');
          const fileEl = dr.querySelector('[data-shot]');
          const ono = onoEl ? onoEl.value.trim() : '';
          const f = fileEl && fileEl.files ? fileEl.files[0] : null;
          const fail = m => { if (subout) subout.innerHTML = `<div class="note err m-0">${esc(m)}</div>`; };
          if (!ono) return fail('请填写订单号。');
          if (!f) return fail('请选择账单详情截图。');
          if (f.size > 12 * 1024 * 1024) return fail('截图文件过大，请上传不超过 12 MB 的 JPG 或 PNG 图片。');
          /* F-06：提交前先守卫订单对象——旧写法里 st/st.order 为 undefined 时抛 TypeError，
             会被 catch 误报成“截图读取失败”。与 :4461 另一分支的守卫同口径。 */
          const st = byPlan[planId]; if (!st || !st.order) return fail('订单信息缺失，请重新进入。');
          el.disabled = true; el.textContent = '提交中…';
          try {
            const b64 = await readFileBase64(f);
            const r = await api('/license/api/pay/orders/' + encodeURIComponent(st.order.id) + '/submit', { method: 'POST', json: { orderNo: ono, imageBase64: b64 } });
            el.disabled = false; el.textContent = '提交审核';
            if (r.json && r.json.ok) { st.order = r.json.order || Object.assign({}, st.order, { status: 'reviewing', statusText: '正在审核' }); stopTimer(); renderDrawer(planId); toast('已提交，正在审核。', 'ok'); }
            else fail(apiErrText(r, '提交失败，请稍后再试。'));
          } catch (e) { el.disabled = false; el.textContent = '提交审核'; fail('截图读取失败，请重新选择文件后重试。'); }
        }
      };
    });
  }

  async function ensureOrder(planId) {
    if (guest) { renderDrawer(planId); return; }
    if (byPlan[planId] && byPlan[planId].order) { renderDrawer(planId); return; }
    if (ensureOrderFlights[planId]) { renderDrawer(planId); return; } // 批A-W3-F1：在飞期间重复进入只渲染加载态，不二次建单
    renderDrawer(planId); // 加载态
    ensureOrderFlights[planId] = true;
    try {
      const r = await api('/license/api/pay/orders', { method: 'POST', json: { plan: planId, method: 'wechat' } });
      if (r.json && r.json.ok && r.json.order) byPlan[planId] = { order: r.json.order, pay: r.json.pay || null };
      else if (r.status === 401 || r.status === 403) byPlan[planId] = { error: '登录状态已失效，请重新登录后再购买。' };
      else byPlan[planId] = { error: apiErrText(r, '订单创建未成功，请稍后再试。') };
      if (expanded !== planId) return; // 用户已切换/收起，结果已缓存于 byPlan，重新展开直接用，不再重复建单
      renderDrawer(planId);
    } finally {
      delete ensureOrderFlights[planId];
    }
  }

  view.querySelectorAll('[data-plan]').forEach(el => {
    el.onclick = () => {
      const pid = el.getAttribute('data-plan');
      if (expanded === pid) { expanded = null; stopTimer(); paintHeads(); return; }
      expanded = pid; paintHeads();
      if (guest) renderDrawer(pid); else ensureOrder(pid);
    };
  });

  // 从「我的订单 · 继续支付」进入：param 为订单 id，先 continue 取支付数据再展开对应套餐
  if (param && !guest) {
    const r = await api('/license/api/pay/orders/' + encodeURIComponent(param) + '/continue', { method: 'POST', json: {} });
    if (r.json && r.json.ok && r.json.pay) {
      const pay = r.json.pay;
      const planId = pay.plan;
      if (planId && PLANS.some(p => p.id === planId)) {
        byPlan[planId] = { order: { id: pay.orderId, plan: pay.plan, planName: pay.planName, amount: pay.amount, method: pay.method, status: pay.status || 'pending_pay', statusText: '待支付', remainingSec: pay.remainingSec, payDeadline: Date.now() + (Number(pay.remainingSec) || 0) * 1000, canCancel: true, canContinue: true, canSubmit: true, canDelete: false }, pay };
        expanded = planId; paintHeads(); renderDrawer(planId);
      }
    } else if (r.json) toast(apiErrText(r, '该订单当前不能继续支付。'), 'warn');
    else toast('网络暂时不可用，请检查网络后重试。', 'err'); // 批A-W3-F3：网络失败（json 为空）不再静默
  }
};

Views.orders = async function (view, param, seq) {
  view.innerHTML = `<h1 class="pt">我的订单</h1><p class="psub">待支付订单可在 15 分钟内继续支付，超时自动取消；待审核订单不可取消或删除；已取消、已完成与审核未通过订单可以删除（仅删除您的显示，后台台账保留）。</p>
    <div id="ordList"><div class="card"><div class="skel sk-h52"></div></div></div>`;
  const box = $('#ordList', view);
  const r = await api('/license/api/pay/orders');
  if (seq != null && seq !== renderSeq) return; // 扫表 S8：订单列表在飞期间已切页/重渲，旧账号订单不得画进新页面
  if (r.status === 401 || r.status === 403) {
    box.innerHTML = stateBox('登录状态已失效', '请重新登录后查看我的订单。', false);
    return;
  }
  if (r.networkError || !r.json) { netFail(box, () => Views.orders(view)); return; }
  if (!r.json.ok || !Array.isArray(r.json.orders)) {
    box.innerHTML = `<div class="card"><div class="statebox"><b>订单暂时无法加载</b><p>${esc(apiErrText(r, '请稍后重新加载。'))}</p><button class="btn sm" data-retry="1">重新加载</button></div></div>`;
    bindRetry(box, () => Views.orders(view));
    return;
  }
  const orders = r.json.orders;
  if (!orders.length) {
    box.innerHTML = `<div class="card"><div class="statebox"><b>暂无订单</b><p>购买密钥后，订单将显示在这里。</p><button class="btn sm" data-go="purchase">去购买密钥</button></div></div>`;
    const g = $('[data-go]', box); if (g) g.onclick = () => navigate('purchase');
    return;
  }
  box.innerHTML = orders.map(o => `
    <div class="card" data-order="${esc(o.id)}">
      <div class="dev dev-flat">
        <span><b>${esc(o.planName || o.plan || '')}</b><small>本站订单：${esc(o.id)} · ${esc(methodName(o.method))} · 下单时间：${o.createdAt ? fmtDate(o.createdAt) : '—'}${o.orderNo ? ' · 账单订单号：' + esc(o.orderNo) : ''}</small></span>
        <span class="ops"><b class="text-navy">¥${esc(String(o.amount))}</b> ${orderPill(o)}</span>
      </div>
      ${o.status === 'pending_pay' ? `<p class="ordnote" style="color:var(--sub)">剩余支付时间：<b>${fmtSecText(o.remainingSec)}</b>（到期自动取消）</p>` : ''}
      ${o.status === 'reviewing' && !o.canViewKey ? '<p class="ordnote" style="color:var(--sub)">正在审核，审核通过后可在此查看并复制密钥，粘贴激活后即可使用。待审核订单不可取消或删除。</p>' : ''}
      ${o.status === 'reviewing' && o.canViewKey && o.keyForm !== 'stacked' ? '<p class="ordnote">审核通过：密钥已发放到本账号。点下方「查看密钥」复制完整密钥，粘贴激活后开始使用；本站订单将在站长确认到账后转为已完成。</p>' : ''}
      ${o.status === 'reviewing' && o.canViewKey && o.keyForm === 'stacked' ? '<p class="ordnote">审核通过：本单为叠加购买，所购时长已并入你的密钥，无需再次激活；本站订单将在站长确认到账后转为已完成。</p>' : ''}
      ${o.status === 'completed' && o.keyForm !== 'stacked' ? '<p class="ordnote">已完成：密钥已发放到本账号，可在下方查看密钥，或在「我的」查看密钥状态。</p>' : ''}
      ${o.status === 'completed' && o.keyForm === 'stacked' ? '<p class="ordnote">已完成：本单为叠加购买，所购时长已并入你的密钥。可在下方查看既有密钥，或在「我的」查看密钥状态。</p>' : ''}
      ${o.canViewKey && o.keyForm === 'stacked' ? `<p class="ordnote" style="color:var(--sub)">本单为叠加购买，时长已并入你的密钥${o.keyMasked ? '（' + esc(o.keyMasked) + '）' : ''}${o.keyActivated && o.keyExpiresMs ? '，并入后到期时间：' + esc(fmtDate(o.keyExpiresMs)) : ''}${o.keyActivated === false ? '，该密钥尚未激活，激活时累计时长一并起算' : ''}。</p>` : ''}
      ${o.status === 'cancelled' ? '<p class="ordnote" style="color:var(--sub)">订单已取消。</p>' : ''}
      ${o.status === 'rejected' ? '<p class="ordnote">审核未通过。如有疑问，请联系智能客服处理。</p>' : ''}
      <p class="flex-row mt-12">
        ${o.canContinue ? `<button class="btn sm" data-cont="${esc(o.id)}">继续支付</button>` : ''}
        ${o.canViewKey ? `<button class="btn sm" data-viewkey="${esc(o.id)}">查看密钥</button>` : ''}
        ${o.canCancel ? `<button class="btn sm grey" data-cancel="${esc(o.id)}">取消订单</button>` : ''}
        ${o.canDelete ? `<button class="btn sm danger" data-del="${esc(o.id)}">删除</button>` : ''}
      </p>
      ${o.canViewKey && o.keyStr && o.keyForm !== 'stacked' ? `<div id="ordkey-${esc(o.id)}" style="display:none"><div class="note ok m-0"><div class="text-sub fs-13 mb-6">本单密钥（完整串）</div><b class="keybox">${esc(o.keyStr)}</b><p class="mt-10"><button class="btn sm" data-copykey="${esc(o.id)}">复制密钥</button></p><p class="text-sub fs-12x5 mt-8">复制后到登录激活提示或「兑换 KEY」处粘贴即可激活，激活后开始计时。</p></div></div>` : ''}
      ${o.canViewKey && o.keyStr && o.keyForm === 'stacked' ? `<div id="ordkey-${esc(o.id)}" style="display:none"><div class="note ok m-0"><div class="text-sub fs-13 mb-6">既有密钥（完整串）</div><b class="keybox">${esc(o.keyStr)}</b><p class="mt-10"><button class="btn sm" data-copykey="${esc(o.id)}">复制密钥</button></p>${o.keyActivated ? '<p class="text-sub fs-12x5 mt-8">该密钥已激活，正在计时，无需再次粘贴激活。</p>' : '<p class="text-sub fs-12x5 mt-8">该密钥尚未激活。复制后到登录激活提示或「兑换 KEY」处粘贴激活，本单时长已并入，激活时一并起算。</p>'}</div></div>` : ''}
    </div>`).join('');
  box.querySelectorAll('[data-viewkey]').forEach(el => el.onclick = () => {
    const id = el.getAttribute('data-viewkey');
    const d = document.getElementById('ordkey-' + id);
    if (!d) return;
    const show = d.style.display === 'none';
    d.style.display = show ? 'block' : 'none';
    el.textContent = show ? '收起密钥' : '查看密钥';
  });
  box.querySelectorAll('[data-copykey]').forEach(el => el.onclick = async () => {
    const o = orders.find(x => x.id === el.getAttribute('data-copykey'));
    if (!o || !o.keyStr) return;
    let okCopy = false;
    try { await navigator.clipboard.writeText(o.keyStr); okCopy = true; } catch (e) {}
    if (!okCopy) {
      const ta = document.createElement('textarea');
      ta.value = o.keyStr; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { okCopy = document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
    if (!okCopy) toast('复制失败，请展开密钥后长按手动复制。', 'warn');
    else if (o.keyForm === 'stacked' && o.keyActivated) toast('密钥已复制。该密钥已激活，无需再次粘贴激活。', 'ok');
    else toast('密钥已复制，去粘贴激活吧。', 'ok');
  });
  box.querySelectorAll('[data-cont]').forEach(el => el.onclick = () => navigate('purchase', el.getAttribute('data-cont')));
  box.querySelectorAll('[data-cancel]').forEach(el => el.onclick = () => {
    const id = el.getAttribute('data-cancel');
    const gen0 = S.sessGen; // 扫表 S8：确认框等待期间换账号，旧单取消请求不得发到新账号头上（modal 不随导航关闭，见 showModal）
    confirmModal('取消订单', '确定取消该订单？取消后不能恢复，需要购买时请重新下单。', '取消订单', async () => {
      if (gen0 !== S.sessGen) return;
      const rr = await api('/license/api/pay/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST', json: {} });
      if (gen0 !== S.sessGen) return;
      if (rr.json && rr.json.ok) { toast('订单已取消。', 'ok'); Views.orders(view); }
      else toast(apiErrText(rr, '取消失败，请稍后再试。'), 'err');
    });
  });
  box.querySelectorAll('[data-del]').forEach(el => el.onclick = () => {
    const id = el.getAttribute('data-del');
    const gen0 = S.sessGen; // 扫表 S8：同上，删除确认框亦然
    confirmModal('删除订单', '删除后该订单不再显示（后台台账保留）。确定删除？', '删除', async () => {
      if (gen0 !== S.sessGen) return;
      const rr = await api('/license/api/pay/orders/' + encodeURIComponent(id) + '/delete', { method: 'POST', json: {} });
      if (gen0 !== S.sessGen) return;
      if (rr.json && rr.json.ok) { toast('订单已删除。', 'ok'); Views.orders(view); }
      else toast(apiErrText(rr, '删除失败，请稍后再试。'), 'err');
    });
  });
};

/* ================= 积分与福利（N-2 签到 / 福利兑换 / 待兑换列表） =================
   字段口径以服务端实测为准（与 N-2 文档的差异已记入 PURCHASE-REPORT）：
   - /points/api/me：顶层 points/totalSeconds/displayText 来自 computeMe，
     earn 子对象含 balance/todayGranted/todayCap/checkinDone/usageSecToday/
     usageGrantedToday/deviceGrantedToday/nextPointInSec/ledger。
   - /points/api/checkin：成功回 {ok,balance,earn}（文档所列 todayGranted
     不在顶层、在 earn.todayGranted）；失败回 {ok:false,code,msg}。
   - /points/api/welfare：offers 项为 {plan,planName,cost}（文档写作 points，
     实测为 cost）；records 为扣分台账项 {at,kind,delta,balance,note}。 */
Views.points = async function (view) {
  view.innerHTML = `<h1 class="pt">积分与福利中心</h1><p class="psub">积分由服务器计时，每日上限 10 分，账号与设备任一达到上限当日不再计分。</p>
    <div id="ptsBody"><div class="card"><div class="skel sk-h60"></div></div></div>`;
  const box = $('#ptsBody', view);
  const [r, wr, kr] = [await api('/points/api/me'), await api('/points/api/welfare'), await api('/license/api/mykeys')];
  if (r.status === 401 || r.status === 403) { box.innerHTML = stateBox('登录状态已失效', '请重新登录后查看积分与福利。', false); return; }
  if (r.status !== 200 || !r.json || !r.json.ok) { box.innerHTML = stateBox('积分服务暂时不可用', '请稍后重新加载。', true); bindRetry(box, () => Views.points(view)); return; }
  const j = r.json; if (j.points != null) S.points = j;
  const earn = j.earn || {};
  const balance = earn.balance != null ? earn.balance : (j.points != null ? j.points : 0);
  const hours = j.totalSeconds != null ? (j.totalSeconds / 3600).toFixed(1) : '—';
  const checkinDone = !!earn.checkinDone;
  const todayGranted = earn.todayGranted != null ? earn.todayGranted : 0;
  const todayCap = earn.todayCap != null ? earn.todayCap : 10;
  const offers = (wr.json && wr.json.ok && Array.isArray(wr.json.offers) && wr.json.offers.length) ? wr.json.offers : [{ plan: 'd1', planName: 'QFRemote 1日套餐', cost: 200 }, { plan: 'd7', planName: 'QFRemote 7日套餐', cost: 500 }];
  const records = (wr.json && wr.json.ok && Array.isArray(wr.json.records)) ? wr.json.records : [];
  const mykeys = (kr.json && kr.json.ok && Array.isArray(kr.json.keys)) ? kr.json.keys : [];
  const pendingKeys = mykeys.filter(k => k.canRedeem || k.activated === false || k.lifecycle === 'unactivated');
  const offerCost = o => (o.cost != null ? o.cost : (o.points != null ? o.points : 0));
  const offerName = o => (o.planName || (o.plan === 'd7' ? '7 日密钥' : '1 日密钥'));
  box.innerHTML = `
    <div class="grid2"><div class="card"><h3>我的积分</h3><div class="stat"><div><b id="pt-balance">${esc(String(balance))}</b><span>当前积分</span></div><div><b>${esc(String(hours))}</b><span>累计在线（小时）</span></div><div><b>${esc(String(todayGranted))} / ${esc(String(todayCap))}</b><span>今日已得 / 上限</span></div></div>
      <p class="text-sub fs-13 mt-10">${esc(j.displayText || '')}</p></div>
    <div class="card"><h3>赚取积分</h3>
      ${rowActHtml('award', '每日签到', checkinDone ? '今日已签到' : '每天签到得 1 分', `<button class="btn sm" id="pt-sign" ${checkinDone ? 'disabled' : ''}>${checkinDone ? '今日已签到' : '签到'}</button>`)}
      ${rowActHtml('refresh', '使用软件计时', '软件与服务器保持在线满 1 小时得 1 分', earn.nextPointInSec != null ? `<span class="tag">距下一分约 ${Math.ceil(Number(earn.nextPointInSec) / 60)} 分钟</span>` : '')}
      <div class="mt-10" id="pt-out"></div>
    </div></div>
    <div class="card"><h3>福利中心 · 兑换密钥</h3>
      ${offers.map(o => rowActHtml('key', offerName(o), offerCost(o) + ' 分兑换 · 兑换后进入下方待兑换列表', `<button class="btn sm" data-redeem="${esc(o.plan)}" data-cost="${esc(String(offerCost(o)))}">兑换${o.plan === 'd7' ? ' 7 日' : ' 1 日'}密钥</button>`)).join('')}
      <div class="note warn mt-12">积分兑换的密钥为免费来源，不开通网页版；兑换所得为未激活密钥，自兑换激活时刻起计时。</div>
      <div class="mt-10" id="wf-out"></div></div>
    <div class="card"><h3>待兑换列表</h3><div id="pt-pending">
      ${pendingKeys.length ? pendingKeys.map(k => `<div class="row"><span class="tile">${ic('key')}</span><span><b>${esc(k.planName || '密钥')}</b><small>${esc(k.masked || '')} · 来源：${esc(k.sourceLabel || '')} · ${esc(k.expiresText || '未激活，激活后起算')}</small></span><span class="ops"><button class="btn sm" data-keyredeem="${esc(k.keyId)}">兑换并激活</button></span></div>`).join('') : '<div class="statebox"><b>暂无待兑换密钥</b><p>用积分兑换的密钥将显示在这里，兑换并激活后开始计时。</p></div>'}
    </div></div>
    <div class="card"><h3>兑换记录</h3>
      ${records.length ? '<div class="tblwrap"><table><tr><th>项目</th><th>积分变化</th><th>时间</th></tr>' + records.map(x => `<tr><td>${esc(x.note || '福利兑换')}</td><td>${esc(String(x.delta != null ? x.delta : ''))}</td><td>${x.at ? fmtDate(x.at) : ''}</td></tr>`).join('') + '</table></div>' : '<div class="statebox"><b>暂无兑换记录</b><p>在福利中心兑换密钥后，记录将显示在这里。</p></div>'}
    </div>`;
  const ptOut = $('#pt-out', box);
  const signBtn = $('#pt-sign', box);
  if (signBtn) signBtn.onclick = async () => {
    signBtn.disabled = true; signBtn.textContent = '签到中…';
    const rr = await api('/points/api/checkin', { method: 'POST', json: {} });
    if (rr.json && rr.json.ok) { toast('签到成功，+1 分。', 'ok'); Views.points(view); }
    else {
      signBtn.disabled = false; signBtn.textContent = '签到';
      if (ptOut) ptOut.innerHTML = `<div class="note ${rr.json && rr.json.code === 'ALREADY_CHECKED_IN' ? 'blue' : 'err'} m-0">${esc(apiErrText(rr, '签到失败，请稍后再试。'))}</div>`;
      if (rr.json && rr.json.code === 'ALREADY_CHECKED_IN') Views.points(view);
    }
  };
  box.querySelectorAll('[data-redeem]').forEach(b => {
    b.onclick = () => {
      const plan = b.getAttribute('data-redeem');
      const cost = b.getAttribute('data-cost');
      const gen0 = S.sessGen; // 扫表 S12：确认框等待期间换账号，旧账号的积分兑换不得扣到新账号头上
      confirmModal('兑换密钥', '确认使用 ' + cost + ' 分兑换' + (plan === 'd7' ? ' 7 日' : ' 1 日') + '密钥？兑换后密钥进入待兑换列表。', '确认兑换', async () => {
        if (gen0 !== S.sessGen) return;
        const rr = await api('/points/api/welfare/redeem', { method: 'POST', json: { plan } });
        if (gen0 !== S.sessGen) return;
        const wfOut = $('#wf-out', box);
        if (rr.json && rr.json.ok) { toast(rr.json.msg || '兑换成功。', 'ok'); Views.points(view); }
        else if (wfOut) wfOut.innerHTML = `<div class="note err m-0">${esc(apiErrText(rr, '兑换失败，请稍后再试。'))}</div>`;
      });
    };
  });
  box.querySelectorAll('[data-keyredeem]').forEach(b => {
    b.onclick = async () => {
      const keyId = b.getAttribute('data-keyredeem');
      b.disabled = true; b.textContent = '兑换中…';
      const rr = await api('/license/api/redeem', { method: 'POST', json: { keyId } });
      if (rr.json && rr.json.ok) { toast(rr.json.msg || '兑换成功，密钥已激活。', 'ok'); await checkSession(true); Views.points(view); }
      else { b.disabled = false; b.textContent = '兑换并激活'; toast(apiErrText(rr, '兑换失败，请稍后再试。'), 'err'); }
    };
  });
};

/* ================= API 密钥（LEA 三端入口，站长 13:34/13:45 定） ================= *
 * 侧边栏入口（MENU34）一点即进本页；页内两个操作（站长 13:45 定）：
 *   生成：手动生成 API 密钥（显式授权，须账号密码二次确认；明文只显示一次）；
 *   撤销：吊销单个或全部密钥，吊销后该密钥后续调用一律 401、立即失效。
 * 服务端接口：POST /api/lea/v1/keys、GET /api/lea/v1/keys、
 *   POST /api/lea/v1/keys/{key_id}/revoke、POST /api/lea/v1/keys/revoke-all。
 * 网页／Windows（Electron 载控制台）／安卓（WebView 槽载控制台）三端共用本页；
 * 安卓另在原生「我的」页加同名入口（见 android-app/lib/ui/me_page.dart）。 */
Views.apikeys = async function (view) {
  view.innerHTML = `<h1 class="pt">API 密钥</h1><p class="psub">API 密钥是 Muse 操作本机设备的凭证。密钥必须由你手动生成——生成就是一次显式授权；吊销后密钥立即失效，Muse 再调用会被拒绝。</p>
    <div id="akBody"><div class="card"><div class="skel sk-h60"></div></div></div>`;
  const box = $('#akBody', view);
  const r = await api('/api/lea/v1/keys');
  if (r.status === 401 || r.status === 403) { box.innerHTML = stateBox('登录状态已失效', '请重新登录后查看 API 密钥。', false); return; }
  if (r.status !== 200 || !r.json || !r.json.ok) {
    box.innerHTML = stateBox('API 密钥服务暂时不可用', r.json && r.json.code === 'LEA_UNAVAILABLE' ? 'LEA 服务端模块未加载或密码核验未接入，请稍后再试。' : '请稍后重新加载。', true);
    bindRetry(box, () => Views.apikeys(view)); return;
  }
  const statusText = (s) => ({ active: '使用中', revoked: '已吊销', revoked_by_rebind: '换绑后吊销', expired: '已过期' }[s] || s || '未知');
  const renderList = (keys) => {
    if (!keys.length) return '<div class="statebox"><b>暂无 API 密钥</b><p>还没有生成过密钥。生成后把密钥复制给 Muse，它才能操作你的设备。</p></div>';
    return keys.map(k => `<div class="row"><span class="tile">${ic('key')}</span><span><b>${esc(k.prefix || k.key_id)}</b><small>${esc(k.key_id)} · ${esc(statusText(k.status))} · 生成于 ${k.created_at ? fmtDate(k.created_at) : '—'} · ${k.last_used_at ? '最后使用 ' + fmtDate(k.last_used_at) : '未使用过'}${k.device_scope ? ' · 仅限设备 ' + esc(String(k.device_scope).slice(0, 20)) + '…' : ''}${k.self_bind ? ' · 自助链接' : ''}${k.device_name ? ' · ' + esc(k.device_name) : ''}${k.platform ? '（' + esc(k.platform) + '）' : ''}${k.expires_at ? ' · 到期 ' + fmtDate(k.expires_at) : ''}</small></span>${k.status === 'active' ? `<span class="ops"><button class="btn sm" data-revoke="${esc(k.key_id)}"${k.self_bind ? ' data-selfbind="1"' : ''}${k.device_scope ? ` data-scope="${esc(k.device_scope)}"` : ''}>撤销</button></span>` : ''}</div>`).join('');
  };
  const keys = Array.isArray(r.json.keys) ? r.json.keys : [];
  box.innerHTML = `
    <div class="card"><h3>生成 API 密钥</h3>
      <p class="text-sub fs-13 m-6-0-10">点“生成”即手动授权 Muse 使用你的设备。生成须重新输入账号密码作二次确认；密钥明文只显示一次，请立即复制保存，关闭后不再明文展示。</p>
      <div class="flex-row">
        <input class="mini-input2" id="ak-pw" type="password" placeholder="账号密码（二次确认）" autocomplete="current-password">
        <button class="btn" id="ak-gen">生成 API 密钥</button>
      </div>
      <div class="mt-12" id="ak-new"></div>
      <div class="mt-10" id="ak-out"></div>
    </div>
    <div class="card"><h3>我的密钥</h3><div id="ak-list">${renderList(keys)}</div></div>
    <div class="card"><h3>吊销全部密钥</h3>
      <p class="text-sub fs-13 m-6-0-10">怀疑密钥泄露时点这里：该账号全部密钥立即吊销，Muse 再调用一律被拒绝。吊销不可恢复，需要时重新生成。</p>
      <button class="btn danger" id="ak-revoke-all">吊销全部密钥</button>
      <button class="btn sm ghost" id="ak-revoke-all-selfbind">只吊销自助链接的密钥（无需密码）</button>
      <div class="mt-10" id="ak-all-out"></div>
    </div>`;
  const pwEl = $('#ak-pw', box);
  const outEl = $('#ak-out', box);
  const newEl = $('#ak-new', box);
  const genBtn = $('#ak-gen', box);
  const bindRevoke = (scope) => {
    scope.querySelectorAll('[data-revoke]').forEach(b => {
      b.onclick = () => {
        const keyId = b.getAttribute('data-revoke');
        const isSelfBind = b.getAttribute('data-selfbind') === '1';
        const keyScope = b.getAttribute('data-scope') || '';
        const gen0 = S.sessGen; // 扫表 S13：确认框等待期间换账号，旧账号的密钥吊销不得发到新账号头上
        confirmModal('撤销密钥', '确定吊销该密钥吗？吊销后它立即失效，Muse 再用它调用会被拒绝。', '撤销', async () => {
          if (gen0 !== S.sessGen) return;
          // C1：自助链接的 Key 走无密码吊销接口（控制台会话即够）；
          // 控制台生成的 Key 仍须密码二次确认（T30 不动）。
          let rr;
          if (isSelfBind) {
            rr = await api('/api/lea/v1/self-bind/revoke/' + encodeURIComponent(keyId), { method: 'POST' });
          } else {
            const pw = pwEl ? pwEl.value : '';
            if (!pw) { toast('撤销密钥须先输入账号密码作二次确认。', 'err'); if (pwEl) pwEl.focus(); return; }
            rr = await api('/api/lea/v1/keys/' + encodeURIComponent(keyId) + '/revoke', { method: 'POST', json: { password: pw } });
          }
          if (gen0 !== S.sessGen) return;
          if (rr.json && rr.json.ok) {
            // C1：吊销的是本机自助 Key 时，清本机凭据（USH 内 DPAPI 文件），
            // 否则本机仍拿着一把已吊销的 Key（下次链接会先清掉，但立即清更干净）。
            if (isSelfBind && window.qfLea && keyScope) {
              try {
                const di = await window.qfLea.deviceInfo();
                const bare = (s) => String(s || '').replace(/^node\/\//, '');
                if (di && di.device_id && bare(di.device_id) === bare(keyScope)) {
                  await window.qfLea.clearCredential();
                }
              } catch (e) { /* best-effort：清凭据失败不影响吊销结果 */ }
            }
            toast('密钥已吊销，立即失效。', 'ok'); Views.apikeys(view);
          }
          else toast(apiErrText(rr, '吊销失败，请稍后再试。'), 'err');
        });
      };
    });
  };
  const refreshList = async () => {
    const lr = await api('/api/lea/v1/keys');
    if (lr.json && lr.json.ok) {
      const listEl = $('#ak-list', box);
      if (listEl) { listEl.innerHTML = renderList(Array.isArray(lr.json.keys) ? lr.json.keys : []); bindRevoke(listEl); }
    }
  };
  bindRevoke(box);
  if (genBtn) genBtn.onclick = async () => {
    const pw = pwEl ? pwEl.value : '';
    if (!pw) { toast('请先输入账号密码作二次确认。', 'err'); if (pwEl) pwEl.focus(); return; }
    genBtn.disabled = true; genBtn.textContent = '生成中…';
    const rr = await api('/api/lea/v1/keys', { method: 'POST', json: { password: pw } });
    genBtn.disabled = false; genBtn.textContent = '生成 API 密钥';
    if (pwEl) pwEl.value = '';
    if (rr.json && rr.json.ok && rr.json.key) {
      const plain = rr.json.key;
      newEl.innerHTML = `<div class="note warn m-0">请立即复制保存：关闭后不再明文展示。</div>
        <div class="flex-row mt-8"><input class="mini-input2-sm" id="ak-plain" type="text" readonly value="${esc(plain)}"><button class="btn sm" id="ak-copy">复制</button></div>`;
      const copyBtn = $('#ak-copy', box);
      if (copyBtn) copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(plain); toast('已复制。', 'ok'); }
        catch (e) {
          const input = $('#ak-plain', box);
          if (input) { input.select(); try { document.execCommand('copy'); toast('已复制。', 'ok'); } catch (e2) { toast('复制失败，请手动选中复制。', 'err'); } }
        }
      };
      if (outEl) outEl.innerHTML = '';
      toast('API 密钥已生成。', 'ok');
      // 只刷新列表，不重建整页——明文只显示一次，不能被刷新冲掉。
      refreshList();
    } else if (outEl) {
      outEl.innerHTML = `<div class="note err m-0">${esc(apiErrText(rr, '生成失败，请稍后再试。'))}</div>`;
    }
  };
  const allBtn = $('#ak-revoke-all', box);
  if (allBtn) allBtn.onclick = () => {
    const gen0 = S.sessGen; // 扫表 S13：同上，吊销全部是不可恢复操作，更不得错账号执行
    confirmModal('吊销全部密钥', '确定吊销该账号全部 API 密钥吗？全部密钥立即失效，Muse 立即失权，不可恢复。', '吊销全部', async () => {
      if (gen0 !== S.sessGen) return;
      const pw = pwEl ? pwEl.value : '';
      if (!pw) { toast('吊销全部须先输入账号密码作二次确认。', 'err'); if (pwEl) pwEl.focus(); return; }
      const rr = await api('/api/lea/v1/keys/revoke-all', { method: 'POST', json: { password: pw } });
      if (gen0 !== S.sessGen) return;
      const allOut = $('#ak-all-out', box);
      if (rr.json && rr.json.ok) { toast('全部密钥已吊销（' + (rr.json.revoked_count || 0) + ' 个），Muse 立即失权。', 'ok'); Views.apikeys(view); }
      else if (allOut) allOut.innerHTML = `<div class="note err m-0">${esc(apiErrText(rr, '吊销失败，请稍后再试。'))}</div>`;
    });
  };
  // C1：只吊销自助链接的密钥（控制台会话即够，无需密码）。桌面端吊销
  // 本机那把后，顺带清本机凭据（device_scope 与本机一致时）。
  const allSbBtn = $('#ak-revoke-all-selfbind', box);
  if (allSbBtn) allSbBtn.onclick = () => {
    const gen0 = S.sessGen;
    confirmModal('吊销自助链接密钥', '确定吊销该账号全部自助链接的 API 密钥吗？控制台手动生成的密钥不受影响。吊销后 Muse 立即失权，不可恢复。', '吊销', async () => {
      if (gen0 !== S.sessGen) return;
      const rr = await api('/api/lea/v1/self-bind/revoke-all', { method: 'POST' });
      if (gen0 !== S.sessGen) return;
      const allOut = $('#ak-all-out', box);
      if (rr.json && rr.json.ok) {
        if (window.qfLea) { try { await window.qfLea.clearCredential(); } catch (e) { /* best-effort */ } }
        toast('自助链接密钥已吊销（' + (rr.json.revoked_count || 0) + ' 个）。', 'ok'); Views.apikeys(view);
      }
      else if (allOut) allOut.innerHTML = `<div class="note err m-0">${esc(apiErrText(rr, '吊销失败，请稍后再试。'))}</div>`;
    });
  };
};

/* ================= 我的（我的账户） ================= */
Views.profile = async function (view) {
  const lic = S.license || {};
  /* F-W4 返工（C §2.4，按安卓 license_section 同款）：状态 chip／有效期／席位合计；机器码／许可 ID／最后校验／硬件指纹／排障日志进折叠区，缺失字段显示 —，不编假数字 */
  const licExpiryMs = lic.keyExpiresMs || lic.trialExpiresMs || null;
  const licStatusCls = /过期|失效|封禁|冻结/.test(lic.displayStatus || '') ? 'err' : ((/试用/.test(lic.displayStatus || '') || /试用/.test(lic.planName || '')) ? 'warn' : (lic.hasKey ? 'ok' : 'off'));
  const licDotCls = licStatusCls === 'err' ? 'dot6 off' : (licStatusCls === 'warn' ? 'dot6 warn' : 'dot6');
  const licPc = lic.slots ? (lic.slots.pc || 0) : 0, licPcMax = (lic.slots && lic.slots.pcMax) || 2;
  const licMo = lic.slots ? (lic.slots.mobile || 0) : 0, licMoMax = (lic.slots && lic.slots.mobileMax) || 1;
  view.innerHTML = `<h1 class="pt">我的</h1><p class="psub">账号、密钥与安全设置集中在本页，每项功能只有一个入口。</p>
    <div class="card"><div class="dev dev-flat"><span data-my-avatar="52">${myAvatarHtml(52)}</span><span><b class="fs-17" data-my-nick>${esc(myEffectiveNickname())}</b><small class="text-sub d-block">${esc(lic.displayStatus || '账号状态正常')}</small></span><span class="ops"><button class="btn sm ghost" id="pf-edit">编辑资料</button></span></div></div>
    ${profileCardHtml(MyProfile || { username: S.user, effectiveNickname: S.displayName, defaultNickname: S.user })}
    <div class="card"><a class="row row-link" href="${QF_WEBSITE_URL}" target="_blank" rel="noopener"><span class="tile">${ic('globe')}</span><span><b>官方网站</b><small>打开 QFRemote 官网（软件下载与版本公告）</small></span><span class="chev">${ic('chevR')}</span></a></div>
    ${S.isAdmin ? `<div class="card"><button class="row" id="pf-admin"><span class="tile">${ic('gear')}</span><span><b>站长管理</b><small>待办、审核与账号管理（仅站长账号可见）</small></span><span class="chev">${ic('chevR')}</span></button></div>` : ''}
    <div class="grid2">
    <div class="card"><h3>兑换 KEY</h3>
      <div class="field"><label>输入密钥</label><input id="pf-key" placeholder="粘贴完整密钥串"><p class="hint">他人出售的一手未激活密钥、转赠密钥、积分兑换密钥都在这里兑换；兑换即完成归属转移并激活。</p></div>
      <button class="btn block" id="pf-claim">兑换并激活</button><div class="mt-10" id="pf-claim-out"></div>
      <h4 class="subh">待领取的转赠</h4><div id="pf-transfers"><div class="skel sk-h40"></div></div></div>
    <div class="card"><h3>我的密钥（查询密钥）</h3><div class="tblwrap fit"><table>
      <tr><th>套餐</th><td>${esc(lic.planName || '尚未激活')}</td></tr>
      <tr><th>密钥</th><td><span id="pf-masked">${esc(lic.maskedKey || '—')}</span> <a class="text-brand fw-600 cursor-pointer" id="pf-reveal">查看完整密钥（输密码核验）</a></td></tr>
      <tr><th>状态</th><td><span class="pill ${licStatusCls}"><span class="${licDotCls}"></span>${esc(lic.displayStatus || '—')}</span>${lic.remainText ? ' · ' + esc(lic.remainText) : ''}</td></tr>
      <tr><th>有效期</th><td>${licExpiryMs ? esc(fmtDate(licExpiryMs)) + '（CST）' : '—'}</td></tr>
      <tr><th>设备名额</th><td>电脑 ${licPc} / ${licPcMax} · 手机 ${licMo} / ${licMoMax}</td></tr>
      <tr><th>席位（合计）</th><td>${licPc + licMo} / ${licPcMax + licMoMax}</td></tr>
      <tr><th>网页版</th><td>${lic.webEnabled ? '已开通' : '购买付费密钥后开通'}</td></tr>
      ${lic.everBanned ? '<tr><th>标记</th><td>该密钥曾被封禁（申诉恢复后保留此标记，不影响使用）</td></tr>' : ''}
      </table></div>
      <details class="lic-diag"><summary>排障与硬件信息</summary>
      <div class="tblwrap fit"><table>
      <tr><th>机器码</th><td>—（网页端无机器码接口，不编造）</td></tr>
      <tr><th>许可 ID</th><td><span class="ev-code">${esc(lic.keyId || '—')}</span></td></tr>
      <tr><th>最后校验时间</th><td>—（无校验记录接口）</td></tr>
      <tr><th>硬件指纹</th><td>—（默认折叠，未提供）</td></tr>
      <tr><th>排障日志</th><td>校验时间 — · 接口结果 — · 错误码 —</td></tr>
      </table></div>
      <p class="ev-meta">诊断信息只含本页已显示的真实字段；缺失项显示 —，不编造。</p>
      <button class="btn sm ghost" id="pf-lic-diag">复制诊断信息</button></details>
      ${rowActHtml('key', '转赠密钥', '付费密钥可转赠一次；对方在查询密钥处复制密钥串后，登录时粘贴领取', `<button class="btn sm ghost" id="pf-gift">发起转赠</button><button class="btn sm grey" id="pf-gift-cancel">撤销待领取转赠</button>`)}
      ${rowActHtml('refresh', '申诉换绑设备', '在新设备上提交，审核通过后替换同类旧设备', `<button class="btn sm ghost" id="pf-rebind">提交换绑申诉</button>`)}
    </div></div>
    <div class="card"><h3>账号与安全</h3><div id="pfSec">
      ${rowActHtml('moon', '深色模式', '浅色／深色切换，重启后仍保持', `<button class="qf-switch" id="pf-theme-toggle" type="button" role="switch" aria-checked="false" aria-label="深色模式"></button><span id="pf-theme-shell-note" hidden>由桌面端主题控制，请用工具栏切换。</span>`)}
      ${rowHtml('lock', '更改密码', '修改密码不会使其他设备立即退出登录', null, null, 'change-password')}
      ${rowHtml('file', '查看以前的登录', '最近登录：' + (S.stats && S.stats.lastLoginMs ? fmtDate(S.stats.lastLoginMs) : '—'), null, null, 'login-history')}
      ${rowHtml('headset', '我的申诉与进度', '封禁申诉、换绑申诉都在这里查进度', null, null, 'appeals')}
      ${rowHtml('forum', '意见反馈', '提交后进入处理队列', null, null, 'feedback')}
      ${rowHtml('refresh', '检查更新', '查看当前版本与更新说明', null, null, 'check-update')}
      ${rowHtml('user', '退出登录', '', null, null, 'logout')}
      ${rowHtml('user', '删除账户', '删除后数据按规则清除，此操作不可恢复', null, null, 'delete-account')}
    </div></div>
    <div class="card" id="pf-lea"><h3>本机助手（API 密钥）</h3><div id="pf-lea-body"><div class="skel sk-h40"></div></div></div>`;
  const pfEditBtn = $('#pf-edit', view); if (pfEditBtn) pfEditBtn.onclick = () => { const c = $('#pfProfileCard', view); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  /* F-W4 返工：复制诊断信息（只含真实字段，缺失项为 —，与安卓 _copyDiagnostics 同口径） */
  const pfDiagBtn = $('#pf-lic-diag', view);
  if (pfDiagBtn) pfDiagBtn.onclick = async () => {
    const txt = ['许可状态：' + (lic.displayStatus || '—'), '当前套餐：' + (lic.planName || '—'), '密钥：' + (lic.maskedKey || '—'), '有效期：' + (licExpiryMs ? fmtDate(licExpiryMs) + '（CST）' : '—'), '剩余时长：' + (lic.remainText || '—'), '设备名额：电脑 ' + licPc + ' / ' + licPcMax + ' · 手机 ' + licMo + ' / ' + licMoMax + ' · 合计 ' + (licPc + licMo) + ' / ' + (licPcMax + licMoMax), '机器码：—', '许可 ID：' + (lic.keyId || '—'), '最后校验时间：—'].join('\n');
    try { await navigator.clipboard.writeText(txt); toast('诊断信息已复制，包含许可状态与密钥掩码。', 'ok'); } catch (e) { toast('复制失败，请手动记录。', 'err'); }
  };
  /* ---- 个人资料（2.3.2）：统一档案展示、昵称/头像提交、审核记录与申诉 ---- */
  const pfRender = (p) => {
    if (!p) return;
    /* MOBILE-FIX 2026-11-14（V-07c）：个人资料卡不再放重复大头像，
       头像只在页顶卡一处主展示（52px，paintIdentity 同步更新）。 */
    const en = $('#pfEffNick', view); if (en) en.textContent = p.effectiveNickname || '';
    const dn = $('#pfDefaultNick', view); if (dn) dn.textContent = '默认昵称：' + (p.defaultNickname || p.username || '');
    const ln = $('#pfLoginName', view); if (ln) ln.textContent = p.username || '';
    const ni = $('#pfNick', view); if (ni && document.activeElement !== ni) { ni.value = p.nickname || ''; const cc = $('#pfNickCount', view); if (cc) cc.textContent = String([...ni.value].length); }
  };
  const loadPfRecords = async () => {
    const box = $('#pfRecords', view); if (!box) return;
    const r = await api('/profile/mod/records');
    if (r.status === 200 && r.json && r.json.ok) {
      box.innerHTML = profileRecordsHtml(r.json.records || r.json.list || []);
      box.querySelectorAll('[data-appeal]').forEach(b => { b.onclick = async () => {
        const note = prompt('请输入申诉说明（最多 200 字）');
        if (note == null) return;
        const t = String(note).trim();
        if ([...t].length > 200) { toast('申诉说明最多 200 字。', 'err'); return; }
        const rr = await api('/profile/mod/' + encodeURIComponent(b.getAttribute('data-appeal')) + '/appeal', { method: 'POST', json: { note: t } });
        if (rr.json && rr.json.ok) { toast('申诉已提交。', 'ok'); loadPfRecords(); }
        else toast((rr.json && rr.json.msg) || PROFILE_BUSY_TEXT, 'err');
      }; });
    } else box.innerHTML = '<div class="statebox"><b>审核记录暂时不可用</b><p>请稍后重新加载本页。</p></div>';
  };
  const submitProfileField = async (payload, out, kind) => {
    // 核对 D4 兜底：整体包 try/catch——api() 本身永不 reject，但提交瞬间视图
    // 拆除等非 api 异常也收口到定版繁忙文案，不留未处理 rejection。
    try { await submitProfileFieldInner(payload, out, kind); }
    catch (e) { try { if (out) out.innerHTML = `<div class="note err">${esc(PROFILE_BUSY_TEXT)}</div>`; } catch (e2) {} }
  };
  const submitProfileFieldInner = async (payload, out, kind) => {
    const r = await api('/profile/mod/submit', { method: 'POST', json: payload });
    if (r.status === 200 && r.json && r.json.ok) {
      if (r.json.applied) {
        out.innerHTML = `<div class="note ok">${kind === 'nickname' ? (payload.nickname ? '昵称已保存。' : '昵称已清除。') : (payload.avatar ? '头像已更新。' : '头像已删除。')}</div>`;
        if (r.json.profile) { MyProfile = r.json.profile; S.profile = r.json.profile; if (r.json.profile.effectiveNickname) S.displayName = r.json.profile.effectiveNickname; }
        await refreshMyProfile(); pfRender(MyProfile); paintIdentity();
      } else {
        const cat = (r.json && r.json.category) || '';
        out.innerHTML = `<div class="note err">${esc(kind === 'avatar' ? ('这个头像不能用：包含' + cat + '，请换一个') : ('这个昵称不能用：包含' + cat + '，请换一个'))}</div>`;
      }
      loadPfRecords();
    } else if (r.status === 400 && r.json && r.json.msg) {
      out.innerHTML = `<div class="note err">${esc(r.json.msg)}</div>`;
    } else {
      out.innerHTML = `<div class="note err">${esc(PROFILE_BUSY_TEXT)}</div>`;
    }
  };
  const nickIn = $('#pfNick', view);
  if (nickIn) nickIn.addEventListener('input', () => { const cc = $('#pfNickCount', view); if (cc) cc.textContent = String([...nickIn.value].length); });
  const nickSaveBtn = $('#pf-nick-save', view);
  if (nickSaveBtn) nickSaveBtn.onclick = async () => {
    const out = $('#pfNickOut', view); const val = $('#pfNick', view).value.trim();
    if ([...val].length > 20) { out.innerHTML = '<div class="note err">昵称最多 20 字</div>'; return; }
    await submitProfileField({ nickname: val }, out, 'nickname');
  };
  const nickClearBtn = $('#pf-nick-clear', view);
  if (nickClearBtn) nickClearBtn.onclick = async () => { await submitProfileField({ nickname: '' }, $('#pfNickOut', view), 'nickname'); };
  const avatarUpBtn = $('#pf-avatar-upload', view);
  const avatarFileInput = $('#pfAvatarFile', view); // r13：选图即回显文件名（原原生控件的「No file chosen」回显随控件隐藏而消失）
  if (avatarFileInput) avatarFileInput.addEventListener('change', () => { const n = $('#pfAvatarName', view); if (n) n.textContent = avatarFileInput.files[0] ? ('已选择：' + avatarFileInput.files[0].name) : '尚未选择图片'; });
  if (avatarUpBtn) avatarUpBtn.onclick = async () => {
    const out = $('#pfAvatarOut', view); const f = $('#pfAvatarFile', view).files[0];
    if (!f) { out.innerHTML = '<div class="note warn">请先选择图片文件。</div>'; return; }
    out.innerHTML = '<div class="note blue">正在处理…</div>';
    try {
      const payload = await prepareAvatar(f);
      await submitProfileField({ avatar: payload }, out, 'avatar');
    } catch (e) {
      out.innerHTML = `<div class="note err">${esc(e && e.code === 'AVATAR_TOO_LARGE' ? AVATAR_TOO_LARGE_TEXT : PROFILE_BUSY_TEXT)}</div>`;
    }
  };
  const avatarDelBtn = $('#pf-avatar-del', view);
  if (avatarDelBtn) avatarDelBtn.onclick = async () => { await submitProfileField({ avatar: null }, $('#pfAvatarOut', view), 'avatar'); };
  refreshMyProfile().then(me => pfRender(me));
  loadPfRecords();
  if (S.isAdmin) { const pa = $('#pf-admin', view); if (pa) pa.onclick = () => navigate('admin'); }
  /* G8 深色切换绑定：开关点按即翻 theme，aria-checked 由 applyTheme 全局同步；
     P0-2 遗留双入口收敛：初绘按有效主题（壳手动优先）＋同步开关只读态。 */
  const pfThemeBtn = $('#pf-theme-toggle', view);
  if (pfThemeBtn) { applyEffectiveTheme(); syncPfThemeControl(); pfThemeBtn.onclick = () => { const t = toggleTheme(); toast(t === 'dark' ? '已切换到深色模式。' : '已切换到浅色模式。', 'ok'); }; }
  $('#pf-claim', view).onclick = async () => {
    const key = $('#pf-key', view).value.trim(); const out = $('#pf-claim-out', view);
    if (!key) { out.innerHTML = '<div class="note warn">请先粘贴密钥。</div>'; return; }
    const r = await api('/license/api/transfer/claim', { method: 'POST', json: { key } });
    if (r.json && r.json.ok) { out.innerHTML = '<div class="note ok">兑换成功，密钥已归属本账号并激活。</div>'; await checkSession(true); toast('兑换成功。', 'ok'); }
    else out.innerHTML = `<div class="note err">${esc((r.json && r.json.msg) || '兑换失败，请核对密钥后重试。')}</div>`;
  };
  // 待领取转赠
  const tr = await api('/license/api/transfers');
  const tbox = $('#pf-transfers', view);
  if (tr.status === 200 && tr.json) {
    const arr = tr.json.transfers || tr.json.incoming || (Array.isArray(tr.json) ? tr.json : []);
    const pend = arr.filter(t => (t.status || 'pending') === 'pending' || t.pending);
    tbox.innerHTML = pend.length ? pend.map(t => `<div class="row"><span class="tile">${ic('key')}</span><span><b>${esc(t.planName || '转赠密钥')}</b><small>来自 ${esc(t.from || t.giver || '')} · 在上方输入框粘贴密钥串即可领取</small></span></div>`).join('') : '<div class="statebox"><b>暂无待领取的转赠</b><p>收到转赠时，对方密钥串会显示在查询结果中，复制后在上方粘贴领取。</p></div>';
  } else tbox.innerHTML = '<div class="statebox"><b>转赠列表暂时不可用</b><p>请稍后重新加载本页。</p></div>';
  $('#pf-gift', view).onclick = () => {
    showModal('发起转赠', `<div class="field"><label>对方账号</label><input id="gf-to" placeholder="请输入对方完整账号"></div><p class="text-sub fs-13">转赠发起后，密钥在对方领取前仍归您使用，您可随时撤销；对方领取的那一刻，您的全部会话将被退出登录。待领取有效期 3 天。</p>`,
      [{ label: '取消' }, { label: '发起转赠', primary: true, onClick: async () => {
        const to = $('#gf-to').value.trim();
        const tr = await api('/license/api/transfers');
        const tk = ((tr.json && tr.json.keys) || []).find(x => x.transferable);
        if (!tk) { toast('当前没有可转赠的密钥（仅付费密钥可转赠，每把密钥限转赠一次）。', 'err'); return; }
        const r = await api('/license/api/transfer/initiate', { method: 'POST', json: { toUsername: to, keyId: tk.keyId } });
        if (r.json && r.json.ok) toast('转赠已发起。', 'ok'); else toast((r.json && r.json.msg) || '发起失败，请核对对方账号。', 'err');
      } }]);
  };
  $('#pf-gift-cancel', view).onclick = async () => {
    const tr = await api('/license/api/transfers');
    const pend = ((tr.json && tr.json.outgoing) || []).find(t => t.status === 'pending');
    if (!pend) { toast('当前没有可撤销的转赠。', 'info'); return; }
    const r = await api('/license/api/transfer/cancel', { method: 'POST', json: { transferId: pend.id } });
    toast(r.json && r.json.ok ? '已撤销待领取转赠（不占用转赠次数）。' : ((r.json && r.json.msg) || '当前没有可撤销的转赠。'), r.json && r.json.ok ? 'ok' : 'info');
  };
  $('#pf-rebind', view).onclick = () => {
    showModal('申诉换绑设备', `<div class="field"><label>本机设备码</label><input id="rb2-dc" placeholder="在本机软件端查看"></div>
      <div class="field"><label>设备类型</label><select id="rb2-pf"><option value="pc">电脑</option><option value="mobile">手机</option></select></div>
      <div class="field"><label>账号密码（核验身份）</label><input id="rb2-pw" type="password"></div>
      <div class="field"><label>情况说明</label><textarea id="rb2-desc" rows="2"></textarea></div>`,
      [{ label: '取消' }, { label: '提交', primary: true, onClick: async () => {
        const r = await api('/license/api/rebind/submit', { method: 'POST', json: { username: S.user, password: $('#rb2-pw').value, desc: $('#rb2-desc').value, deviceCode: $('#rb2-dc').value.trim(), platform: $('#rb2-pf').value, channel: 'web' } });
        toast(r.json && r.json.ok ? '换绑申诉已提交，进度可在本页查看。' : ((r.json && r.json.msg) || '提交失败，请核对信息。'), r.json && r.json.ok ? 'ok' : 'err');
      } }]);
  };
  $('#pf-reveal', view).onclick = () => {
    showModal('查看完整密钥', `<div class="field"><label>请输入账号密码核验</label><input id="rv-pw" type="password"></div><div id="rv-out"></div>`,
      [{ label: '取消' }, { label: '核验', primary: true, onClick: async () => {
        const r = await api('/license/api/status/reveal', { method: 'POST', json: { username: S.user, password: $('#rv-pw').value } });
        if (r.json && r.json.ok && r.json.key) { $('#pf-masked', view).textContent = r.json.key; toast('已显示完整密钥。', 'ok'); }
        else toast((r.json && r.json.msg) || '核验失败。', 'err');
      } }]);
  };
  /* MOBILE-FIX 2026-11-14（F-01 P0）：#pfSec 8 行按行身份绑定，不用下标。
     深色模式行是开关行（rowActHtml 的 div，无 data-action），完全排除在
     操作行集合之外；7 个 button 行各按 data-action 精确绑定，删除账户行
     有独立处理。旧写法 acts[7] 按下标绑到 8 行上，致 7 行全错位、删除账户死钮。 */
  const pfSecActions = {
    'change-password': () => toast('更改密码将在新控制台账户安全接口开通后在本页办理；当前可在软件端修改。', 'warn'),
    'login-history': () => toast('登录记录以本页与首页显示的最近登录为准。', 'info'),
    'appeals': () => navigate('appeal'),
    'feedback': () => navigate('forum'),
    'check-update': async () => { const r = await api('/release.json'); toast(r.json ? ('当前控制台版本信息：' + (r.json.version || r.json.latest || '已是最新')) : '暂时无法获取版本信息。', 'info'); },
    'logout': () => doLogout(),
    'delete-account': () => showModal('删除账户', '<p>删除账户为不可恢复操作。如需办理，请通过智能客服转人工提交申请，核验身份后按规则清除数据。</p>', [{ label: '知道了' }, { label: '联系客服', primary: true, onClick: () => navigate('support') }])
  };
  $('#pfSec', view).querySelectorAll('.row[data-action]').forEach((row) => { const fn = pfSecActions[row.getAttribute('data-action')]; if (fn) row.onclick = fn; });
  /* C1：本机助手（API 密钥）卡。桌面端（window.qfLea 在）显示本机链接
   * 态＋一键链接／吊销；纯浏览器显示下载桌面助手＋本账号自助链接列表。
   * 链接流程：issue 票据 → 桥交 USH → USH 设备签名调 complete 换凭据
   * （明文只进 USH）；成功后轮询 status 确认。吊销后清本机凭据。
   * 5 秒状态轮询（D7）：本页打开且已链接时，每 5 秒查一次 status；
   * 别处吊销导致 revoked 时立即清本机凭据并刷新卡片；切出本页即停。 */
  const leaBox = $('#pf-lea-body', view);
  const leaIsDesktop = !!(window.qfLea && window.qfLea.deviceInfo);
  let leaPollTimer = null;
  const leaStopPoll = () => { if (leaPollTimer) { clearTimeout(leaPollTimer); leaPollTimer = null; } };
  const leaNonce = () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[x % 64]).join('');
  };
  const leaLink = async (btn) => {
    btn.disabled = true; btn.textContent = '链接中…';
    try {
      const info = await window.qfLea.deviceInfo();
      if (!info || !info.device_id) { toast('无法读取本机设备信息，请重启桌面软件后重试。', 'err'); return; }
      const ush = await window.qfLea.ushStatus();
      if (!ush || ush.ok !== true) { toast('本机助手未运行，请重启桌面软件后重试。', 'err'); return; }
      const nonce = leaNonce();
      const iss = await api('/api/lea/v1/self-bind/issue', { method: 'POST', json: { device_id: info.device_id, device_name: info.device_name || '', platform: 'windows', nonce } });
      if (!iss.json || !iss.json.ok || !iss.json.ticket) { toast(apiErrText(iss, '签发绑定票据失败，请稍后再试。'), 'err'); return; }
      const res = await window.qfLea.deliverTicket({ ticket: iss.json.ticket, challenge: iss.json.challenge, account_id: S.user, device_id: info.device_id, nonce, device_name: info.device_name || '', platform: 'windows', expires_at: iss.json.expires_at, server_base: window.location.origin });
      if (!res || res.ok !== true) { toast('链接失败：' + ((res && (res.code || res.detail)) || '本机助手无响应'), 'err'); return; }
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await api('/api/lea/v1/self-bind/status?device_id=' + encodeURIComponent(info.device_id));
        if (st.json && st.json.ok && st.json.status === 'active') { toast('已链接：本机助手可以远程控制这台电脑了。', 'ok'); leaRender(); return; }
        if (st.json && st.json.ok && st.json.status === 'revoked') break;
      }
      toast('链接已提交，正在确认，请稍后刷新本页查看。', 'info'); leaRender();
    } catch (e) { toast('链接失败，请稍后再试。', 'err'); }
    finally { btn.disabled = false; btn.textContent = '链接这台电脑'; }
  };
  const leaRevoke = async (btn, keyId) => {
    btn.disabled = true;
    const rr = await api('/api/lea/v1/self-bind/revoke/' + encodeURIComponent(keyId), { method: 'POST' });
    if (rr.json && rr.json.ok) {
      try { await window.qfLea.clearCredential(); } catch (e) { /* best-effort */ }
      toast('本机链接已吊销。', 'ok'); leaRender();
    } else toast(apiErrText(rr, '吊销失败，请稍后再试。'), 'err');
    btn.disabled = false;
  };
  const leaRender = async () => {
    leaStopPoll();
    if (!leaBox || !leaBox.isConnected) return;
    if (!leaIsDesktop) {
      const kr = await api('/api/lea/v1/keys');
      const sb = (kr.json && Array.isArray(kr.json.keys)) ? kr.json.keys.filter((k) => k.self_bind) : [];
      leaBox.innerHTML = `<p class="text-sub fs-13 m-6-0-10">一键链接只在桌面软件里可用：先下载安装桌面助手，登录后在本页点“链接这台电脑”，1 分钟内完成，无需任何手动命令。</p>
        <a class="btn" href="${QF_WEBSITE_URL}" target="_blank" rel="noopener">前往官网下载桌面助手</a>
        <p class="hint lea-mob-note">手机无法安装桌面助手，请在电脑上打开官网下载。</p>
        <h4 class="subh">已链接的设备</h4>${sb.length ? sb.map((k) => `<div class="row"><span class="tile">${ic('key')}</span><span><b>${esc(k.device_name || k.key_id)}</b><small>${esc(k.platform || '')} · ${esc(({ active: '使用中', revoked: '已吊销', expired: '已过期' }[k.status] || k.status || ''))} · 到期 ${k.expires_at ? fmtDate(k.expires_at) : '—'}</small></span></div>`).join('') : '<div class="statebox"><b>暂无已链接的设备</b><p>在桌面软件里链接后，设备会出现在这里。</p></div>'}`;
      return;
    }
    let info = null;
    try { info = await window.qfLea.deviceInfo(); } catch (e) { info = null; }
    if (!info || !info.device_id) {
      leaBox.innerHTML = '<div class="statebox"><b>无法读取本机设备信息</b><p>请重启桌面软件后重新打开本页。</p></div>';
      return;
    }
    const st = await api('/api/lea/v1/self-bind/status?device_id=' + encodeURIComponent(info.device_id));
    if (!st.json || !st.json.ok) {
      leaBox.innerHTML = `<div class="statebox"><b>本机助手服务暂时不可用</b><p>请稍后重新加载本页。</p></div><button class="btn sm" id="pf-lea-retry">重新加载</button>`;
      const rb = $('#pf-lea-retry', leaBox);
      if (rb) rb.onclick = () => leaRender();
      return;
    }
    const s = st.json;
    if (s.status === 'active') {
      leaBox.innerHTML = `<div class="row"><span class="tile">${ic('key')}</span><span><b>已链接：${esc(s.device_name || info.device_name || '本机')}</b><small>本机助手可以远程控制这台电脑 · 到期 ${s.expires_at ? fmtDate(s.expires_at) : '—'} · 到期前 7 天内自动续期</small></span><span class="ops"><button class="btn sm" id="pf-lea-revoke">吊销本机链接</button></span></div>`;
      const rb = $('#pf-lea-revoke', leaBox);
      if (rb) rb.onclick = () => leaRevoke(rb, s.key_id);
      leaPollTimer = setTimeout(async () => {
        if (!leaBox.isConnected) return;
        try {
          const st2 = await api('/api/lea/v1/self-bind/status?device_id=' + encodeURIComponent(info.device_id));
          if (st2.json && st2.json.ok && st2.json.status === 'revoked') {
            try { await window.qfLea.clearCredential(); } catch (e) { /* best-effort */ }
            toast('本机链接已在别处吊销，已清除本机凭据。', 'info');
            leaRender();
          } else leaRender();
        } catch (e) { leaRender(); }
      }, 5000);
    } else if (s.status === 'revoked') {
      try { await window.qfLea.clearCredential(); } catch (e) { /* best-effort */ }
      leaBox.innerHTML = `<div class="row"><span class="tile">${ic('key')}</span><span><b>本机链接已吊销</b><small>凭据已清除。重新链接后，本机助手才能远程控制这台电脑。</small></span><span class="ops"><button class="btn sm" id="pf-lea-link">重新链接</button></span></div>`;
      const lb = $('#pf-lea-link', leaBox);
      if (lb) lb.onclick = () => leaLink(lb);
    } else {
      leaBox.innerHTML = `<div class="row"><span class="tile">${ic('key')}</span><span><b>本机尚未链接</b><small>点一下即可链接：本机助手自动申请 API 密钥并完成绑定，全程约 1 分钟，无需任何手动命令。</small></span><span class="ops"><button class="btn sm" id="pf-lea-link">链接这台电脑</button></span></div>`;
      const lb = $('#pf-lea-link', leaBox);
      if (lb) lb.onclick = () => leaLink(lb);
    }
  };
  leaRender();
};

/* ================= 申诉（C1 收编二期·变基重建） =================
   申诉改为控制台原生组件：提交与进度查询都在本组件内完成，不再打开
   独立页或弹窗内嵌页。服务端接口一字不动——仍按登录垫片的现行契约
   以表单方式提交（POST /appeal 提交、POST /appeal/status 查进度，
   均返回整页 HTML），组件解析返回页中的结果块（.ok/.err/.status）
   后在组件内原生呈现；核验口径不变：仅账号＋密码、失败不透露细节。
   独立 /appeal 页保留为无脚本环境与直达链接的兜底，不在本组件引用。 */
function extractAppealResult(pageHtml) {
  try {
    const doc = new DOMParser().parseFromString(String(pageHtml || ''), 'text/html');
    const ok = doc.querySelector('.ok');
    if (ok) return ok.outerHTML;
    const st = doc.querySelector('.status');
    if (st && st.parentElement) return st.parentElement.innerHTML;
    const err = doc.querySelector('.err');
    if (err) return err.outerHTML;
  } catch (e) { /* 解析失败按无结果处理，调用方给正式提示 */ }
  return '';
}
function appealSafeHref(href) {
  const raw = String(href == null ? '' : href).trim();
  if (!raw || raw.charAt(0) !== '/') return '';          // 只认站内绝对路径（同时挡掉 javascript:/data:）
  if (raw.charAt(1) === '/' || raw.charAt(1) === '\\') return '';   // 挡协议相对 //evil.example
  if (/[\s\\]/.test(raw)) return '';                     // 挡空白 / 反斜杠变形
  const p = raw.split('?')[0].split('#')[0];
  if (p !== '/appeal/status' && p !== '/appeal/reset') return '';   // 只放行两类必要的站内链接
  return raw;
}
function appealSafeClass(v) {
  const s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9_\- ]{1,120}$/.test(s) ? s : '';
}
function appealCopySafe(node, parent) {
  if (!node) return;
  if (node.nodeType === 3) { parent.appendChild(document.createTextNode(String(node.nodeValue || ''))); return; }
  if (node.nodeType !== 1) return;                       // 注释 / 处理指令一律丢弃
  const tag = node.tagName;
  if (APPEAL_DROP_TAGS.has(tag)) return;                 // 整个子树丢弃
  if (!APPEAL_OK_TAGS.has(tag)) {                        // 未知标签：拆壳保留安全子内容
    Array.prototype.slice.call(node.childNodes).forEach(n => appealCopySafe(n, parent));
    return;
  }
  if (tag === 'A') {
    const href = appealSafeHref(node.getAttribute('href'));
    if (!href) {                                         // 非法链接降级为纯文本内容
      Array.prototype.slice.call(node.childNodes).forEach(n => appealCopySafe(n, parent));
      return;
    }
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('rel', 'noreferrer');
    const cls = appealSafeClass(node.getAttribute('class'));
    if (cls) a.setAttribute('class', cls);
    Array.prototype.slice.call(node.childNodes).forEach(n => appealCopySafe(n, a));
    parent.appendChild(a);
    return;
  }
  const el = document.createElement(tag);
  const cls = appealSafeClass(node.getAttribute('class'));
  if (cls) el.setAttribute('class', cls);
  if (tag === 'TD' || tag === 'TH') {
    ['colspan', 'rowspan'].forEach(name => {
      const v = node.getAttribute(name);
      if (v && /^\d{1,3}$/.test(v)) el.setAttribute(name, v);
    });
  }
  Array.prototype.slice.call(node.childNodes).forEach(n => appealCopySafe(n, el));
  parent.appendChild(el);
}
function sanitizeAppealHtml(html) {
  const out = document.createElement('div');
  try {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    Array.prototype.slice.call(tpl.content.childNodes).forEach(n => appealCopySafe(n, out));
  } catch (e) { return ''; }
  return out.innerHTML;
}
function renderAppeal(box, opts) {
  opts = opts || {};
  box.innerHTML = `<div class="card mt-16"><h3>账号申诉</h3>
    <p class="text-sub fs-13x5 mb-12">账号被冻结或封禁时可在此提交申诉。身份核验仅使用账号与密码，核验不会登录账号；核验不通过时不会透露具体原因。申诉次数上限：永久封禁 2 次、其他情形 3 次（同一事项）。</p>
    <div class="tabs mb-14"><button type="button" class="on" id="ap-tab-new">提交申诉</button><button type="button" id="ap-tab-q">申诉进度</button></div>
    <div id="ap-new">
      <div class="field"><label>账号</label><input id="ap-user" autocomplete="username" placeholder="请输入账号"></div>
      <div class="field"><label>账号密码（仅用于核验身份）</label><input id="ap-pass" type="password" autocomplete="current-password" placeholder="请输入密码"></div>
      <div class="field"><label>联系邮箱</label><input id="ap-email" placeholder="用于接收处理结果通知"></div>
      <div class="field"><label>情况说明</label><textarea id="ap-desc" rows="3" placeholder="请说明账号被冻结或封禁的情况"></textarea></div>
      <div class="field"><label>新的证据或补充说明（再次申诉时必填，首次申诉可留空）</label><textarea id="ap-newev" rows="2"></textarea></div>
      <button class="btn block" id="ap-btn" type="button">提交申诉</button>
      <div class="mt-12" id="ap-out"></div>
    </div>
    <div id="ap-q" hidden>
      <div class="field"><label>账号</label><input id="apq-user" placeholder="请输入账号"></div>
      <button class="btn block" id="apq-btn" type="button">查询进度</button>
      <div class="mt-12" id="apq-out"></div>
    </div>
  </div>`;
  const tabNew = $('#ap-tab-new', box), tabQ = $('#ap-tab-q', box);
  const secNew = $('#ap-new', box), secQ = $('#ap-q', box);
  const showSec = (q) => {
    secNew.hidden = !!q; secQ.hidden = !q;
    tabNew.classList.toggle('on', !q); tabQ.classList.toggle('on', !!q);
    if (q) { const u = $('#ap-user', box).value.trim(); if (u && !$('#apq-user', box).value) $('#apq-user', box).value = u; }
  };
  tabNew.onclick = () => showSec(false);
  tabQ.onclick = () => showSec(true);
  if (opts.user) $('#ap-user', box).value = opts.user;
  const wireStatusLinks = (outBox) => {
    outBox.querySelectorAll('a[href^="/appeal/status"]').forEach(a => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        let u = '';
        try { u = new URL(a.getAttribute('href'), location.origin).searchParams.get('u') || ''; } catch (e) { /* 用已填账号兜底 */ }
        if (u) $('#apq-user', box).value = u;
        showSec(true);
        $('#apq-btn', box).click();
      });
    });
  };
  $('#ap-btn', box).onclick = async () => {
    const out = $('#ap-out', box);
    const user = $('#ap-user', box).value.trim();
    const pass = $('#ap-pass', box).value;
    const email = $('#ap-email', box).value.trim();
    const desc = $('#ap-desc', box).value.trim();
    const newev = $('#ap-newev', box).value.trim();
    if (!user || !pass || !email || !desc) { out.innerHTML = '<div class="note err">账号、密码、联系邮箱、情况说明均须填写。</div>'; return; }
    const btn = $('#ap-btn', box); btn.disabled = true; btn.textContent = '正在提交…';
    const r = await api('/appeal', { method: 'POST', form: { username: user, password: pass, email, desc, newev } });
    btn.disabled = false; btn.textContent = '提交申诉';
    if (r.networkError) {
      /* POST /appeal 非幂等且不自动重发（见 api() 白名单），网络中断时提交可能
         已被受理；提示先查进度再决定是否重提，避免白白消耗申诉次数。 */
      out.innerHTML = '<div class="note err">提交结果未知：网络中断，本次提交可能已被服务器受理。请先到「申诉进度」查询，确认未受理后再重新提交，以免消耗申诉次数。</div>';
      return;
    }
    const html = r.text ? extractAppealResult(r.text) : '';
    const safe = html ? sanitizeAppealHtml(html) : '';
    if (safe) { out.innerHTML = safe; wireStatusLinks(out); }
    /* 未能取得明确结果块（5xx/页面形态变化等）：提交可能已受理并计次，
       一律按「结果未知」引导先查进度，不提示直接重提（N-6，C-02 同口径）。 */
    else out.innerHTML = '<div class="note err">提交结果未知：未收到明确的提交结果，本次提交可能已被服务器受理。请先到「申诉进度」查询，确认未受理后再重新提交，以免消耗申诉次数。</div>';
  };
  $('#apq-btn', box).onclick = async () => {
    const out = $('#apq-out', box);
    const user = $('#apq-user', box).value.trim();
    if (!user) { out.innerHTML = '<div class="note err">请输入账号。</div>'; return; }
    const btn = $('#apq-btn', box); btn.disabled = true; btn.textContent = '正在查询…';
    const r = await api('/appeal/status', { method: 'POST', form: { username: user } });
    btn.disabled = false; btn.textContent = '查询进度';
    if (r.networkError) { out.innerHTML = '<div class="note err">查询未完成：网络中断，请检查网络后重试。</div>'; return; }
    const html = r.text ? extractAppealResult(r.text) : '';
    const safe = html ? sanitizeAppealHtml(html) : '';
    out.innerHTML = safe || '<div class="note err">未查询到该账号的申诉记录。</div>';
  };
  if (opts.openQuery) showSec(true);
}
Views.appeal = function (view) {
  view.innerHTML = `<h1 class="pt">申诉与进度</h1><p class="psub">账号被冻结或封禁时在此提交申诉，并可查询处理进度。身份核验仅使用账号与密码。</p><div id="apRoot"></div>`;
  renderAppeal($('#apRoot', view), { user: S.user || '' });
};

/* ================= 站长管理 ================= */
Views.admin = async function (view) {
  if (!S.isAdmin) {
    view.innerHTML = `<h1 class="pt">站长管理</h1><div class="card"><div class="statebox"><b>无权访问</b><p>本页仅站长账号可见。当前账号没有站长权限，相关入口不会出现在导航中。</p></div></div>`;
    return;
  }
  view.innerHTML = `<h1 class="pt">站长管理</h1><p class="psub">仅站长账号可见。本页汇总全部待办，不再分散到多个后台。</p><div id="admBody"><div class="card"><div class="skel sk-h60"></div></div></div>`;
  /* P2-022 修复：原接线按不存在的字段读数（overview.pendingOrders 等、appeals.appeals），
     且从未调用 /admin/api/assistant，导致统计恒显「—」、申诉恒空、API 卡误报未开通。
     现按服务端真实返回对齐：overview={keys,bans,orders,deviceReviews}、appeals={pending,recent}、
     assistant={token,counts,recentDone}、users={users}、orders={orders,enabled}。 */
  /* 2026-11-13 修：原 5 个接口串行 await，GET 各带 30 秒超时×2 次重试，
     最坏 5×60 秒骨架屏才渲染，与 /admin 页「正在加载…」卡死同族。现并行
     拉取、单次尝试（retry:false），最坏 30 秒出结果；api() 本身永不抛，
     下游已按 json 缺失兜底，Promise.all 安全。 */
  const [ov, ap, as, us, od] = await Promise.all([
    api('/admin/api/license/overview', { retry: false }),
    api('/admin/api/appeals', { retry: false }),
    api('/admin/api/assistant', { retry: false }),
    api('/admin/api/users', { retry: false }),
    api('/admin/api/orders', { retry: false }),
  ]);
  const box = $('#admBody', view);
  const oj = ov.json || {};
  const appeals = (ap.json && ap.json.pending) || [];
  const counts = (as.json && as.json.counts) || {};
  const tok = (as.json && as.json.token) || {};
  const recentDone = (as.json && as.json.recentDone) || [];
  const userCount = (us.json && us.json.users) ? us.json.users.length : 0;
  const orderList = (od.json && od.json.orders) || [];
  const pendReview = orderList.filter(x => x.status === 'reviewing').length;
  const dayStr = ts => new Date(ts).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const todayOrders = orderList.filter(x => x.createdAt && dayStr(x.createdAt) === dayStr(Date.now())).length;
  const pendAnomaly = (oj.deviceReviews || []).filter(x => x.status === 'pending').length;
  const tokText = tok.status === 'active' ? '已启用' : (tok.status === 'revoked' ? '已吊销' : '未生成');
  const cntNames = { order: '付款订单', appeal: '申诉', rebind: '换绑申请', device_review: '设备异常', forum: '论坛待审', support: '客服工单' };
  const cntLine = Object.keys(cntNames).map(k => cntNames[k] + ' ' + (counts[k] || 0)).join(' · ');
  const doneHtml = recentDone.slice(0, 5).map(e => `<div class="text-sub fs-13 mt-6">${esc(cntNames[e.type] || e.type || '')} · ${esc(e.refId || '')} · ${esc(e.handledBy || '')} · ${esc(e.result || '')}${e.handledAt ? ' · ' + fmtDate(e.handledAt) : ''}</div>`).join('');
  box.innerHTML = `
    <div class="grid3">
      <div class="card"><h3>待处理</h3><div class="stat"><div><b>${esc(String(pendReview))}</b><span>新订单待一审</span></div><div><b>${esc(String(appeals.length))}</b><span>申诉待裁定</span></div><div><b>${esc(String(counts.support || 0))}</b><span>客服求助</span></div></div></div>
      <div class="card"><h3>今日概览</h3><div class="stat"><div><b>${esc(String(userCount))}</b><span>注册账号</span></div><div><b>${esc(String(todayOrders))}</b><span>今日订单</span></div><div><b>${esc(String(pendAnomaly))}</b><span>异常登录待复核</span></div></div></div>
      <div class="card"><h3>站长 API</h3><p class="text-sub fs-13x5">助手事件接口：新订单、新申诉、异常登录、客服求助、换绑与论坛待审统一入队，助手经接口先审，疑难上交站长。</p><div class="mt-10 fs-13x5">令牌状态：<b>${esc(tokText)}</b>${tok.createdAt ? ' · 生成于 ' + fmtDate(tok.createdAt) : ''}${tok.lastUsedAt ? ' · 最近调用 ' + fmtDate(tok.lastUsedAt) : ' · 尚无调用'}</div><div class="fs-13x5 mt-6">待处理：${esc(cntLine)}</div>${doneHtml}</div>
    </div>
    <div class="card"><h3>待办队列（申诉）</h3>${appeals.length ? '<div class="tblwrap"><table><tr><th>类型</th><th>账号</th><th>内容</th><th>时间</th></tr>' + appeals.slice(0, 10).map(a => `<tr class="cursor-pointer" data-go="__admin" data-anchor="appeals"><td><span class="tag">${esc(a.type === 'rebind' ? '换绑设备' : (a.type || '申诉'))}</span></td><td>${esc(a.username || a.user || '')}</td><td>${esc(a.desc || a.reason || '')}</td><td>${a.createdAt ? fmtDate(a.createdAt) : ''}</td></tr>`).join('') + '</table></div>' : '<div class="statebox"><b>暂无待办申诉</b><p>新的申诉、换绑与异常登录复核将汇总到这里，并同步进入站长 API 事件队列。</p></div>'}</div>
    <div class="grid2"><div class="card"><h3>账号管理</h3>
      ${rowHtml('users', '用户列表与搜索', '改名、改密、冻结、封禁（危险操作均需二次确认并留痕）', '__admin', 'users')}
      ${rowHtml('users', '创建账号', '站长手动开户：填账号与初始密码，创建即发 3 天试用', '__admin', 'create')}
      ${rowHtml('key', '发放密钥', '必须选择来源：付费 / 免费（决定网页版权益），无默认', '__admin', 'lic-user')}
      ${rowHtml('key', '生成密钥（不绑账号）', '生成不绑账号的密钥串，复制交付对方，首个兑换的账号即归属', '__admin', 'genkey')}
      ${rowHtml('shield', '封禁与冻结台账', '含设备封禁与异常登录复核', '__admin', 'lic-overview')}</div>
    <div class="card"><h3>内容与服务审核</h3>
      ${rowHtml('forum', '论坛审核', '待审帖子与评论、禁言管理（与论坛同一队列）', 'forum')}
      ${rowHtml('headset', '客服收件箱', '人工工单回复与关闭', 'support')}
      ${rowHtml('cart', '订单台账', '订单号全局唯一登记，一号一钥', '__admin', 'payOrders')}</div></div>
    <div class="note err">危险操作口径：封禁、回收密钥等操作执行前二次确认，执行后在台账留痕，界面可查。界面用词统一使用「封禁」。</div>`;
  box.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => { const g = el.getAttribute('data-go'); if (g === '__admin') { const an = el.getAttribute('data-anchor'); location.href = '/admin' + (an ? '#' + an : ''); } else { navigate(g); } }));
};

/* 走查/调试钩子（只暴露无副作用的界面动作） */
window.__qf = { toast, navigate, setDrawer: (o) => setDrawer(o), state: () => ({ auth: S.auth, route: S.route, user: S.user }) };

/* ================= 启动 ================= */
(function boot() {
  /* W-05：注册晚绑定钩子（早层经 QFHooks 调应用壳函数，见 qf-schema.js）。 */
  QFHooks.toast = toast; QFHooks.showShell = showShell; QFHooks.showAuth = showAuth;
  QFHooks.sessionDied = sessionDied; QFHooks.forceGate = forceGate; QFHooks.doLogout = doLogout;
  QFHooks.checkSessionInner = checkSessionInner; QFHooks.teardownSession = teardownSession;
  QFHooks.invalidateNodeMap = invalidateNodeMap;
  QFHooks.chatResetAll = () => { try { if (typeof chatResetAll === 'function') chatResetAll(); } catch (e) {} };
  QFHooks.renderAppeal = (box, opts) => { if (typeof renderAppeal === 'function') renderAppeal(box, opts); };
  QFHooks.showSupportGuest = (box) => { if (Views && typeof Views.support === 'function') Views.support(box, null, 0, { guest: true }); };
  QFHooks.navigate = navigate;
  applyEffectiveTheme(); // P0-2（2026-11-17）：接管后按有效主题落 theme（壳手动优先，见 qf-runtime.js）；旧 applyTheme(getTheme()) 绕过壳手动，登录瞬间会把工具栏已切的手动主题闪回本机偏好，须等 getThemeState 异步纠正。首屏防闪白另由 index.html 内联脚本负责。
  // P0-2：壳内运行时向主进程取一次初始主题并订阅推送（工具栏手动模式须立即同步内容页；
  // 纯浏览器下 window.qfLea 不存在，走偏好/系统两层，不受影响）
  try { if (window.qfLea && typeof window.qfLea.onTheme === 'function') { window.qfLea.onTheme((resolved, mode) => onShellTheme(resolved, mode)); } } catch (e) {}
  try { if (window.qfLea && typeof window.qfLea.getThemeState === 'function') { window.qfLea.getThemeState().then((s) => { if (s) onShellTheme(s.resolved, s.mode); }).catch(() => {}); } } catch (e) {}
  $('#burgerBtn').innerHTML = ic('menu');
  $('#bellBtn').innerHTML = ic('bell');
  $('#topSearch').innerHTML = ic('search') + '<input id="topSearchIn" placeholder="搜索功能">'; // r13：手机 390px 下搜索框实测仅 111px、原占位「搜索功能或关键词…」需 204px 被夹断；16px 字号不可缩（iOS 聚焦放大），改短占位＋CSS 隐藏 .grow 后搜索框约 212px、占位完整显示
  $('#burgerBtn').addEventListener('click', () => setDrawer(!drawerOpen));
  $('#bellBtn').addEventListener('click', () => toast('暂无新的通知。版本公告将在论坛官方公告中发布。', 'info'));
  $('#acctChip').addEventListener('click', () => $('#acctMenu').classList.toggle('open'));
  $('#topSearchIn').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim();
    const hit = MENU34.concat(FUNC).concat(S.isAdmin ? [{ icon: 'gear', label: '站长管理', route: 'admin' }] : []).find(i => i.label.includes(q) || q.includes(i.label));
    if (hit) navigate(hit.route); else toast('未找到相关功能，请从主菜单进入。', 'info');
  });
  // W-04：首屏 boot data——服务端在 index.html 里注入 window.__QF_BOOT__
  //（用户/设备列表/在线状态/主题偏好）时直接播种 store，首屏不再多轮请求
  // 才渲染；无注入时 qfApplyBootData() 返回 null，原有缓存＋校验流程不变。
  // 注入点在服务端渲染 index.html 的一侧（nginx 静态根目录 /opt/qfremote-webapp
  // 目前为纯静态文件，注入须由发版/部署线加渲染步）。
  const bootData = qfApplyBootData();
  // W-10：启动时先读 IndexedDB 设备快照播种 store（离线先放行），联网后
  // Views.devices 回填新数据；跨标签页的 docs/草稿更新经 QFLocal 广播同步
  // （只接更新的、输入框为空的草稿，不覆盖本页正在打的字）。W-04 的
  // QFNotifier（ETag 条件轮询）同时启动。
  try {
    QFLocal.load('docs', 'devices').then((snap) => {
      if (snap && Array.isArray(snap.value) && snap.value.length && !bootData) QFStore.seedDocs({ devices: snap.value });
    }).catch(() => {});
    QFLocal.onBroadcast((m) => {
      if (!m || typeof m.type !== 'string' || !m.payload) return;
      if (m.type === 'docs:devices' && Array.isArray(m.payload.value)) {
        if ((m.payload.updatedAt || 0) > (QFStore._devicesAt || 0)) {
          QFStore._devicesAt = m.payload.updatedAt;
          QFStore.seedDocs({ devices: m.payload.value });
          try { const p = QFLocal.save('docs', 'devices', m.payload); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (e) {}
        }
      } else if (m.type.indexOf('draft:chat:') === 0) {
        const peer = m.type.slice('draft:chat:'.length);
        const input = document.getElementById('chInput');
        if (peer && CH && CH.currentWith === peer && input && !input.value && m.payload.text) input.value = m.payload.text;
      }
    });
    QFNotifier.start();
  } catch (e) {}
  const cache = Cache.load();
  if (ManualLogout.is()) {
    // P1-4a（2026-11-11）：上次是手动登出（持久标记在）——页面可能在登出
    // 中途重载过，缓存仍在但内存标记已丢；绝不能按缓存复活壳，直接出登录
    // 表单。标记留到一次真实新登录再清（doLogin），多次重载仍出表单。
    Cache.clear();
    S.auth = 'out'; // 与 doLogout 落点一致：本页即已登出态，不留 'unknown'
    showAuth('login', { notice: '您已退出登录。' });
  } else if (cache && cache.user) {
    // 进门不挡：先按缓存渲染壳，校验在后台进行；冷进入恒落首页，不再恢复上次视图（2026-10-26 站长令）
    S.auth = 'in'; S.user = cache.user;
    // W-04 服务端注入：boot data 比缓存新——注入带了的字段不许缓存回填盖掉。
    // 原写法 S.license = cache.license 在缓存无 license 时会把 qfApplyBootData
    // 刚播种的 boot 快照清成 undefined（isAdmin 同理被 !!cache.isAdmin 清成
    // false）；注入没带的字段才回填。S.user 不动（换账号判定归 checkSession）。
    S.displayName = (bootData && bootData.displayName) ? bootData.displayName : (cache.displayName || cache.user);
    S.isAdmin = (bootData && typeof bootData.isAdmin === 'boolean') ? bootData.isAdmin : !!cache.isAdmin;
    if (!bootData || !bootData.license) S.license = cache.license;
    S.points = cache.points;
    location.hash = '#home';
    showShell();
    checkSession(true, { noDied: true }).then(ok => {
      if (!ok) showAuth('login', { notice: '登录状态已失效，请重新登录。' });
      else render();
    });
  } else {
    checkSession(true).then(ok => { if (ok) { location.hash = '#home'; showShell(); } else showAuth('login'); });
  }
})();
