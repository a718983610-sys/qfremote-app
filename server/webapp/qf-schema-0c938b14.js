/* qf-schema.js — W-05 机械拆分（2026-11-15，全进 3.0）
 * 层：核心库/模式层。只放纯数据（常量表/菜单/阶段映射）与纯函数（转义、格式化、头像校验）。
 * 禁止依赖：qf-runtime / qf-ui / app.js 的任何标识（见 tests/lint-no-cycles.mjs）。
 * 加载顺序第 1 位；经典脚本，与其它文件共享全局词法环境。 */
'use strict';

/* QFRemote 新控制台（影子版）——单页壳同框切换。
   交互口径：《交互规格-QFClash移植.md》六项 + #32 登录落点/单一顶栏 + #34 主菜单次序。
   数据口径：只消费既有服务端接口；购买/订单走 N-1、积分/福利走 N-2（均已上线接真）。 */

/* ---------------- 图标 ----------------
   图标设计规范（2026-11-13 黑白化重画，参照 Linear / Raycast / Apple / Stripe 线性图标）：
   · 24×24 网格，内容收进 2..22 安全区（2px 呼吸边）；描边 1.5（见 app.css svg.ic 与
     session.css .viewer svg，两处已统一；原 app.css 1.9/1.8 与 session.css 1.5 不一致已收敛）。
   · 圆头圆角（linecap/linejoin round，由 CSS 统一），矩形角半径 ≥1.5px，视觉重量均衡：
     闭合形与开放形混排时按“墨量”而非几何尺寸对齐（如 home 加门、cart 轮子实心）。
   · 全部单色：只用 currentColor（fill:none 继承）；实心圆点（cart 轮、award 芯）用
     fill="currentColor" stroke="none"，随文字色走（浅黑 / 深白），无彩色。
   · 逐图标 verdict 见 WEB-MONOCHROME-REPORT.md §图标：重画 7 个（gear 太阳→真齿轮、
     cart 轮子出界、forum 直角、key 单齿、users 副人弧线、phone 空屏、refresh 箭头脱节），
     其余微调或达标保留。 */
const ICONS = {
  home: '<path d="M4 11.2 12 4.2l8 7"/><path d="M6 9.8V20a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.8"/><path d="M10 21v-5.5h4V21"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M12 16.5V20.5"/><path d="M8.5 20.5h7"/>',
  users: '<circle cx="9" cy="8" r="3.4"/><path d="M3.5 20v-.8A4.7 4.7 0 0 1 8.2 14.5h1.6a4.7 4.7 0 0 1 4.7 4.7v.8"/><circle cx="17" cy="9" r="2.7"/><path d="M16.5 14.6a4.2 4.2 0 0 1 4 4.1v1.3"/>',
  chat: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L4 21l1.5-4.1A8.5 8.5 0 1 1 20.5 12z"/>',
  forum: '<path d="M6.5 4h10a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5v-3.5H6.5A2.5 2.5 0 0 1 4 15.5v-9A2.5 2.5 0 0 1 6.5 4z"/>',
  headset: '<path d="M4.5 13.5a7.5 7.5 0 0 1 15 0"/><rect x="3" y="13" width="4" height="6.5" rx="2"/><rect x="17" y="13" width="4" height="6.5" rx="2"/><path d="M19.5 19.5v.5a2 2 0 0 1-2 2h-2"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.3"/><path d="M10.8 12.2 20.5 2.5"/><path d="M15.5 7.5l2.4 2.4"/><path d="M18 5l2.2 2.2"/>',
  cart: '<path d="M2.5 3.5h2.2l2.5 11.7a1.8 1.8 0 0 0 1.8 1.4h7.9a1.8 1.8 0 0 0 1.8-1.5l1.6-7.2"/><path d="M5.6 7.5h14.7"/><circle cx="9.5" cy="20" r="1.5" fill="currentColor" stroke="none"/><circle cx="17.5" cy="20" r="1.5" fill="currentColor" stroke="none"/>',
  award: '<circle cx="12" cy="8.5" r="5.5"/><circle cx="12" cy="8.5" r="2" fill="currentColor" stroke="none"/><path d="M8.9 13.2 7.6 20.5l4.4-2.4 4.4 2.4-1.3-7.3"/>',
  user: '<circle cx="12" cy="7.8" r="3.8"/><path d="M5 20.5v-.4a7 7 0 0 1 14 0v.4"/>',
  shield: '<path d="M12 3.2 18.8 5.7v5.1c0 4.9-2.9 8.3-6.8 10.1-3.9-1.8-6.8-5.2-6.8-10.1V5.7z"/><path d="M8.9 11.8l2.3 2.3 4.2-4.6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  folder: '<path d="M3.5 7.5v-2A1.5 1.5 0 0 1 5 4h3.8l2 2.5h8.7A1.5 1.5 0 0 1 21 8v11.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 20.5 20.5"/>',
  bell: '<path d="M18 8.5a6 6 0 1 0-12 0c0 6.8-2.6 7.7-2.6 7.7h17.2S18 15.3 18 8.5"/><path d="M13.8 20a2 2 0 0 1-3.6 0"/>',
  moon: '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7z"/>', // G8：深色模式行图标（与现有描边风格一致）
  chevR: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  file: '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M13.5 3v5.5H19"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1L20.5 8.1"/><path d="M20.5 3.2v4.9h-4.9"/>',
  logout: '<path d="M14.5 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8.5"/><path d="M10.5 12h10"/><path d="M17 8l4 4-4 4"/>',
  menu: '<path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h15"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.5 3.7 5.3 3.7 8.5s-1.3 6-3.7 8.5c-2.4-2.5-3.7-5.3-3.7-8.5s1.3-6 3.7-8.5z"/>',
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7.5 9.5 10.5 12l-3 2.5"/><path d="M13 15h4.5"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  power: '<path d="M12 3v7.5"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>',
  phone: '<rect x="7.5" y="2.5" width="9" height="19" rx="2.5"/><path d="M10.8 5.5h2.4"/><path d="M11 18.5h2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10.2 10h.01M13.8 10h.01M17.5 10h.01"/><path d="M6.5 14h.01M17.5 14h.01"/><path d="M9.5 14h5"/>',
  send: '<path d="M20.8 3.2 10.5 13.5"/><path d="M20.8 3.2 14.2 20.8l-3.7-7.3-7.3-3.7z"/>',
  x: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
  check: '<path d="M4.5 12.5l4.5 4.5L19.5 6.5"/>',
  mute: '<path d="M4 10v4h3.2L12 18.2V5.8L7.2 10z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>'
};
const ic = n => `<svg class="ic" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r) => (r || document).querySelector(s);
const fmtDate = ms => { if (!ms) return '—'; const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

/* ---------------- 接口层：正式失败提示、超时兜底、失败按白名单重试一次 ---------------- */
/* 超时兜底（perf 线定版，与下述白名单融合）：单项默认上限见 API_TIMEOUT_MS，
   AbortController 到点中止并以 timeout 标记返回；调用方显式传 opts.retry 时
   以显式为准（lockApi 等既有调用点口径不改）。 */
/* 网络层自动重试白名单——只有「重复提交不会产生第二次业务效果」的请求才
   允许自动重发：
   · 全部 GET/HEAD：安全方法，服务端仅读；
   · POST /appeal/status：只读查询（服务端契约）；
   · POST /chat/api/vault：按 msgId 幂等（服务端契约：同 msgId 重复提交
     直接返回 {ok:true, dup:true} 不重复落账）；
   · POST /chat/api/read：按会话写 marks[我]=max(原值, uptoSeq)，单调幂等。
   其余一概不自动重发——尤其 POST /appeal：服务端按提交次数计数（永久
   封禁 2 次/其他 3 次），「已落库但响应丢失」时重发会白白消耗一次额度；
   POST /chat/api/send 会重复投递消息，同样不在白名单内。 */
const API_TIMEOUT_MS = 30000;   // 默认单项上限【施工偏差 D1：DS 稿 12000 → 30000；现行本无超时，截图上传等大 POST 弱网可合法超 12s，关键路径另有显式超时（lockApi 表等），抬高默认值只防回归】
const API_RETRY_DELAY_MS = 600; // 与原文案一致的退避间隔
const API_RETRY_SAFE = [
  ['POST', '/appeal/status'],
  ['POST', '/chat/api/vault'],
  ['POST', '/chat/api/read']
];
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
/* 问候语按本机时段分段（原写死「下午好」，任何时段打开都错） */
function greetWord() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}
function fmtRemain(expMs) {
  const ms = Number(expMs) - Date.now();
  if (!expMs || ms <= 0) return '已过期';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return '剩余 ' + Math.max(mins, 1) + ' 分钟';
  const h = Math.floor(mins / 60), m = mins % 60;
  return '剩余 ' + h + ' 小时' + (m ? ' ' + m + ' 分钟' : '');
}

/* ---------------- 个人资料（2.3.2：统一档案 ext /profile/*） ----------------
   契约（ext 定版）：GET /profile/api/me 回 {ok, username, nickname,
   effectiveNickname, defaultNickname, hasAvatar, avatarMime,
   avatarUpdatedAt, avatarUrl}；POST /profile/mod/submit 一次只提一项
   {nickname} 或 {avatar:{mime,dataBase64}|null}，200 回
   {ok,kind,applied,reviewId,category,msg?,profile}（机审驳回 applied=false
   且 category 只给大类）；输入校验错误 400 {ok:false,code,msg}（msg 原样
   回显，不改写）；GET /profile/mod/records（本人近 50 条）；
   POST /profile/mod/<id>/appeal {note}（说明 ≤200 字，每行至多一次）。
   登录账号名与昵称是两套东西：界面分行分称，登录名行文案恒为
   「登录账号名（不可修改，如需变更请联系官方客服）」。 */
const AVATAR_MAX_BYTES = 200 * 1024;
const AVATAR_HARD_MAX_BYTES = 20 * 1024 * 1024; // 选图硬顶（核对 D5）：超此值不读文件、直接报定版文案
const AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const AVATAR_TOO_LARGE_TEXT = '头像太大了，请先压缩到 200KB 以内再上传';
const PROFILE_BUSY_TEXT = '系统繁忙，请稍后再试';   // GET /profile/api/me 最近一次回包（统一档案正本视图）
function b64OfBytes(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + 0x8000)); return btoa(s); }
function avatarFormatOk(mime) { return AVATAR_MIMES.indexOf(mime) >= 0; }
function avatarDirectOk(size, mime) { return size <= AVATAR_MAX_BYTES && avatarFormatOk(mime); }
function avatarQualitySteps() { const out = []; let q = 0.85; while (q >= 0.4) { out.push(Math.round(q * 100) / 100); q = Math.round((q - 0.15) * 100) / 100; } return out; }

/* ---------------- 屏幕锁（隐私锁）桥：与软件端同一条 8445/lock 桥 ----------------
   契约照双壳正本（app-src/lock.js、安卓 LockClient）：同源路径 /lock/*，
   凭控制台会话（xid）鉴权，服务端按账号逐台核对机主；密码只在提交瞬间
   过桥，不存、不记。GET /lock/devices 回 [{id,name,owner,locked,component}]，
   其中 id 为 MeshCentral 节点 id；非机主设备由服务端直接过滤、不下发。 */
/* 超时口径对齐服务端语义：读路径 8s（服务端冷查 ≤3s，留推进余量）；
   写路径必须覆盖服务端对账窗口（RECONCILE 30s / UPDATE_RECONCILE 240s）+ 余量，
   否则客户端先超时、服务端还在对账，会出现「客户端说失败、服务端记成功」。 */
const LOCK_TIMEOUTS = { '/devices': 8000, '/enable': 45000, '/disable': 45000, '/reset': 45000, '/update': 260000 };

/* ---------------- 设备间文件发送（N-3 端点组，会话鉴权） ---------------- */
const FILE_MAX_BYTES = 200 * 1024 * 1024;

/* ---------------- 导航（#34：主菜单组严格次序，三容器同序） ---------------- */
const MENU34 = [
  { icon: 'home', label: '首页', route: 'home' },
  { icon: 'user', label: '我的账户', route: 'profile' },
  { icon: 'folder', label: '我的文件', route: 'files' },
  { icon: 'users', label: '好友', route: 'friends' },
  { icon: 'forum', label: '论坛', route: 'forum' },
  // H26/QF-33/三端入口（站长 13:34 定）：API 生成入口放侧边栏，一打开就能看到。
  { icon: 'key', label: 'API 密钥', route: 'apikeys' }
];
const FUNC = [
  { icon: 'monitor', label: '我的设备', route: 'devices' },
  { icon: 'chat', label: '聊天', route: 'chat' },
  { icon: 'headset', label: '智能客服', route: 'support' },
  { icon: 'cart', label: '购买密钥', route: 'purchase' },
  { icon: 'award', label: '积分与福利', route: 'points' }
];
const BTABS = [
  { icon: 'home', label: '首页', route: 'home' },
  { icon: 'monitor', label: '设备', route: 'devices' },
  { icon: 'chat', label: '消息', route: 'chat' },
  { icon: 'user', label: '我的', route: 'profile' }
];

/* 引擎同源入口（CANON）：会话融合视图的 iframe 与预热框都挂在本站同源的
   /console-engine 反代路径下（2026-10-28 域名修复口径）。旧「点设备顶层跳原生页」
   动线已于 2.4.0 退役：深链只在框内使用（/?node=<裸 id>&viewmode=<11|12|13>
   &qfm=frame&hide=31，见会话融合视图段）；顶层打开仅保留为哨兵错误卡里用户
   主动触发的兼容模式。viewmode 10＝原生设备页，融合视图永不使用。 */
const QF_CANON_ORIGIN = location.origin + '/console-engine'; // 2026-10-28 域名修复：原写死裸 IP 8443 废止，改同源 /console-engine（nginx 同源反代到原生页），桌面会话全程留在当前域名
/* 官网入口（站长 2026-10-26 11:12 令补）：三容器登出上方独立行＋「我的」页独立行，
   不进 MENU34、不占 BTABS，#34 次序不动；新标签打开官网。 */
const QF_WEBSITE_URL = 'https://qfremote.top/'; // 2026-10-28 域名修复：官网已迁 qfremote.top，不再跳 GitHub Pages 临时站
const websiteNavHtml = (cls) => `<a class="${cls || 'nav'}" href="${QF_WEBSITE_URL}" target="_blank" rel="noopener">${ic('globe')}<span>官方网站</span></a>`;
/* 站长管理入口补齐（站长 2026-10-26 12:58 亲报「网页版找不到站长管理」）：该入口原仅在
   桌面侧边栏（#sidebar）渲染，≤760px 时侧边栏整体隐藏，抽屉/账户菜单/底部标签/「我的」页
   均无此入口，站长手机端无路可达。按官网入口同例补为逻辑同位：仅 S.isAdmin 时在抽屉、
   账户菜单与「我的」页各补一行（导航容器互为同位呈现，不构成 #20 重复入口）；不进
   MENU34、不占 BTABS，#34 次序不动；目标为 SPA 内站长管理页（route=admin），服务端
   /home/api/stats 的 isAdmin 判定（账号===ADMIN_EMAIL 且 siteadmin 全权）未动。 */
/* ================= 会话融合视图（2.4.0：会话直达＋旧页关闭＋会话 UI 大改版） =================
   定稿依据：redesign-v2 FREEZE（站长 2026-10-26 点头冻结）＋ DS-DESIGN 适配 A1–A10
   ＋ phase-0 更正证据（E6–E9）。形态：#/session 单 iframe 同源融合——八入口点设备
   直达会话，MeshCentral 原生设备列表/详情退出用户路径（前置翻牌随 2.4.0 组装执行）。
   深链（E7 实测）：引擎根 /?node=<裸 id>&viewmode=<11|12|13>&qfm=frame&hide=31，
   hide=31 位掩码隐引擎外壳；形态切换走框内 go(vm)（463ms 实测），换 src 会断控制
   通道、禁用作常态路径。父页双层守卫：框内注入 CSS 压制 go() 复现的子导航条，
   URL 规范化守卫把框内逃逸拉回 hide 形态。
   id 解析序（根除 900ms 竞态）：入口数据携带 data-nodeid → 页内节点缓存 →
   ext 只读端点 GET /api/device/resolve 兜底；全程不回落老列表。
   预热（E8 承重项）：登录后隐藏框预热引擎源，会话打开时同设备同形态直接收编。 */
const QF_SESSION_VM = { desktop: 11, terminal: 12, files: 13 };
const QF_SESSION_KIND = { 11: 'desktop', 12: 'terminal', 13: 'files' };
/* 发送到手机的会话邀请走 #25 暂存通道（服务端零改动，toNode 为不透明字符串键）：
   本版寻址＝账号级 ctrl 邮箱（ctrl:account），同账号任一实例在「我的文件·待接收」
   可领取并打开会话；实例级 ctrl:<instanceId> 精确寻址待壳端实例注册表立项后深化。
   本机实例 id 键名登记：localStorage.qfCtrlInstanceId（≥128bit 随机，防未来撞键）。 */
const QF_CTRL_MAILBOX = 'ctrl:account';
const STAGE_TEXT = {
  preflight: '正在检查设备在线状态…',
  resolving: '正在解析设备…',
  'iframe-attach': '正在加载控制台…',
  'webapp-ready': '正在启动控制台…',
  'peer-connecting': '正在连接设备…',
  'video-ready': '正在建立画面通道…',
};
/* C §2.2 加载阶段（6 阶段，百分比由阶段权重计算，不手写假进度） */
const QF_STAGE_ORDER = ['init', 'resolve', 'auth', 'channel', 'codec', 'firstframe'];
const QF_STAGE_MAP = { preflight: 0, resolving: 1, 'iframe-attach': 0, 'iframe-load': 1, 'webapp-ready': 2, 'peer-connecting': 3, 'video-ready': 4 };

/* 设定 sheet 能力项（G4：原生能力一项不丢；驱动桥见 sessApplyCap） */
const QF_CAP_DEFS = [
  { key: 'lock', name: '键鼠锁定', desc: '锁定被控端本地键鼠', icon: 'lock', def: true },
  { key: 'mute', name: '静音', desc: '关闭会话声音', icon: 'mute', def: false },
  { key: 'bell', name: '通知', desc: '被控端通知转发', icon: 'bell', def: true },
  { key: 'lang', name: '语言（输入法）', desc: '远端输入法切换', icon: 'globe', def: true },
  { key: 'reg', name: '注册表', desc: '远程注册表编辑', icon: 'file', def: false },
  { key: 'apps', name: '软件管理', desc: '被控端软件列表与卸载', icon: 'folder', def: false },
  { key: 'events', name: '事件日志', desc: '被控端系统事件查看', icon: 'file', def: false },
];
/* DS P2-5：邀请载荷校验未通过的文件 id——本页生命周期内按普通文件
   展示，不再凭文件名当邀请渲染。 */
const QF_INVITE_REJECTED = new Set();
/* 申诉结果块白名单净化（C-01）：垫片返回整页 HTML，组件只取结果块再入 DOM，
   入 DOM 前一律经此净化——标签/属性白名单＋站内链接白名单，杜绝把组件安全
   寄托于垫片一侧的转义纪律：
   · 丢弃子树的高危标签（脚本/样式/框架/表单/媒体/foreign content）；
   · 非白名单标签拆壳保内容，避免信息静默丢失；
   · 仅保留 /appeal/status 与 /appeal/reset 两类站内链接，且强制 rel="noreferrer"；
   · 其余属性（on* 事件、style、id、data-*、src 等）一律不复制。 */
const APPEAL_OK_TAGS = new Set(['DIV', 'P', 'SPAN', 'B', 'STRONG', 'EM', 'I', 'U', 'SMALL', 'BR', 'HR',
  'UL', 'OL', 'LI', 'A', 'H3', 'H4', 'H5', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CODE', 'PRE']);
const APPEAL_DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED',
  'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'MATH',
  'IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'CANVAS', 'TEMPLATE', 'NOSCRIPT']);
/* ---- W-05 收敛：纯函数（无外部依赖，只读 schema 自身） ---- */


function stateBox(title, text, retryFn) {
  return `<div class="card"><div class="statebox"><b>${esc(title)}</b><p>${esc(text)}</p>${retryFn ? '<button class="btn sm" data-retry="1">重新加载</button>' : ''}</div></div>`;
}
function brandBlock() {
  return `<div class="brand"><span class="mark"><svg viewBox="0 0 240 240" aria-hidden="true"><rect x="0" y="0" width="240" height="240" rx="56" style="fill:var(--mark-bg)"/><path d="M 197.2 130.9 A 78 78 0 1 1 161.3 53.9" fill="none" style="stroke:var(--mark-fg)" stroke-width="25" stroke-linecap="round"/><circle cx="190.1" cy="85.8" r="16" style="fill:var(--mark-fg)"/></svg></span><span><b class="brand-name">QFRemote</b><br><small class="brand-sub">REMOTE CONTROL</small></span></div>`;
}
function statusSummary(j) {
  /* P2-031：status/query 的状态字段嵌在 view 下（/me 才是平铺），两形状兼容取数 */
  const v = (j && j.view) || j || {};
  const parts = [];
  if (v.planName) parts.push('套餐：' + v.planName);
  if (v.maskedKey && v.maskedKey !== '—') parts.push('密钥：' + v.maskedKey);
  if (v.displayStatus) parts.push('状态：' + v.displayStatus);
  if (v.keyExpiresMs) parts.push('到期：' + fmtDate(v.keyExpiresMs));
  else if (v.remainText) parts.push('有效期：' + v.remainText);
  if (typeof v.webEnabled === 'boolean') parts.push('网页版：' + (v.webEnabled ? (v.webBy === 'trial' ? '已开通（试用期内）' : '已开通') : '未开通'));
  return parts.length ? parts.join(' · ') : '已查询到您的密钥状态。';
}
/* QFHooks — 晚绑定钩子（W-05 分层收敛）：早层（schema/runtime/ui）不得直接引用应用壳
 * （app.js）的函数，须经此表调用；app.js 在 boot 首行注册真实实现。默认值全部 fail-safe：
 * 通知/清理类为空操作，会话校验默认失败（fail-closed），导航默认只改 hash。 */
const QFHooks = {
  toast: () => {},
  showShell: () => {},
  showAuth: () => {},
  sessionDied: () => {},
  forceGate: () => {},
  doLogout: () => {},
  checkSessionInner: async () => false,
  teardownSession: () => {},
  invalidateNodeMap: () => {},
  chatResetAll: () => {},
  renderAppeal: () => {},
  showSupportGuest: () => {},
  navigate: (name) => { try { location.hash = '#' + name; } catch (e) {} },
};

/* ---- W-02/W-03/RC-04 纯函数（无外部依赖，只读 schema 自身） ---- */

/* W-02：频道名。Grafana Live 式 pub/sub：一条 WS 按频道订阅，服务端只广播。
 * 频道命名：device:{id}:status（设备上下线）、chat:{id}（聊天）、
 * session:{id}:frame-meta（会话帧元数据）、presence:{id}（光标/正在输入）。
 * id 段禁冒号与空白，防频道名拼出歧义。 */
function qfChannel(kind, id) {
  const k = String(kind || '');
  const i = String(id || '').replace(/[:\s]/g, '');
  if (!k || !i) return '';
  return k + ':' + i + (k === 'device' ? ':status' : (k === 'session' ? ':frame-meta' : ''));
}
function qfParseChannel(name) {
  const m = /^([a-z]+):([^:]+)(?::([a-z-]+))?$/.exec(String(name || ''));
  if (!m) return null;
  return { kind: m[1], id: m[2], suffix: m[3] || '' };
}

/* W-03：确定性合并（抄 Excalidraw reconcileElements）。每条共享记录带稳定 id＋
 * 单调递增 version＋随机 versionNonce；本地正在编辑的优先、version 大者胜、
 * 相等时 versionNonce 小者胜；删除用墓碑 isDeleted 而非真删（断线重连后删掉
 * 的记录不再复活，tldraw 5.6.0 同款修复）。返回按 id 排序的新数组，不改输入。 */
function reconcileRecords(local, remote, editingIds) {
  const editing = editingIds instanceof Set ? editingIds : new Set(editingIds || []);
  const out = new Map();
  const put = (rec) => {
    if (!rec || rec.id == null) return;
    const cur = out.get(rec.id);
    if (!cur) { out.set(rec.id, rec); return; }
    if (editing.has(rec.id) && cur === rec) return;
    const lv = Number(cur.version) || 0, rv = Number(rec.version) || 0;
    if (rv > lv) { out.set(rec.id, rec); return; }
    if (rv < lv) return;
    const ln = Number(cur.versionNonce) || 0, rn = Number(rec.versionNonce) || 0;
    if (rn < ln) out.set(rec.id, rec);
  };
  (local || []).forEach(put);
  // 本地正在编辑的记录：远端同 id 同 version 时本地胜（编辑优先），其余按规则
  (remote || []).forEach((rec) => {
    if (!rec || rec.id == null) return;
    const cur = out.get(rec.id);
    if (cur && editing.has(rec.id) && Number(rec.version || 0) === Number(cur.version || 0)) return;
    put(rec);
  });
  return Array.from(out.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/* W-10：多标签页“本地是否更新”判定（抄 Excalidraw isBrowserStorageStateNewer）。
 * updatedAt 大者胜；相等时 tabId 字典序大者胜，保证两端判定一致、不互相覆盖。 */
function qfIsNewer(a, b) {
  const ta = Number((a && a.updatedAt) || 0), tb = Number((b && b.updatedAt) || 0);
  if (ta !== tb) return ta > tb;
  return String((a && a.tabId) || '') > String((b && b.tabId) || '');
}

/* RC-04：凭据/授权类失败码（规范 §5.2＋§4；命中即立即停重试）。
 * 8 码：规范 §5.2 表列 7 码；第 8 码 QFR_TICKET_INVALID 为服务端实际返回
 * （规范 §4 验签/查表/有效期步骤均回该码；lea-core.js:1327 票据未找到／
 * 过期、:1712 起形状校验），Windows reconnect-policy.js 与安卓端枚举亦
 * 为 8 码。缺此码会把凭据失败误判为网络失败、走 legacy 尝试并重试满 5 次。 */
const QF_RECONNECT_CREDENTIAL_CODES = new Set([
  'QFR_API_KEY_REVOKED', 'QFR_TICKET_REUSED', 'QFR_TICKET_EXPIRED',
  'QFR_BINDING_CHANGED', 'QFR_GRANT_REVOKED', 'QFR_SCOPE_DENIED', 'QFR_LEA_NOT_BOUND',
  'QFR_TICKET_INVALID'
]);
function qfIsCredentialFailure(code) { return QF_RECONNECT_CREDENTIAL_CODES.has(String(code || '')); }

/* RC-04：重连票据形状校验（规范 §1，纯校验、不验签名——签名由服务端核验）。
 * 10 个字段齐全、类型正确、无未知顶层字段；resume_id/session_id 正则；
 * expires_at - issued_at 必须恰好等于 TTL 300 秒；缺 ticket_signature 即拒绝。 */
const QF_RECONNECT_TICKET_TTL_S = 300;
const QF_RECONNECT_TICKET_FIELDS = ['account_id', 'device_id', 'api_key_id', 'binding_epoch', 'grant_epoch', 'resume_id', 'session_id', 'issued_at', 'expires_at', 'ticket_signature'];
function qfIdFieldOk(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > 127) return false;
  for (let i = 0; i < v.length; i++) { if (v.charCodeAt(i) < 0x20 || v.charCodeAt(i) === 0x7f) return false; }
  return true;
}
function validateReconnectTicket(ticket) {
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'not-an-object' };
  for (const k of Object.keys(ticket)) {
    if (QF_RECONNECT_TICKET_FIELDS.indexOf(k) < 0) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'unknown-field:' + k };
  }
  for (const k of QF_RECONNECT_TICKET_FIELDS) {
    if (ticket[k] === undefined || ticket[k] === null) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'missing:' + k };
  }
  if (!qfIdFieldOk(ticket.account_id) || !qfIdFieldOk(ticket.device_id)) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'bad-id-field' };
  if (typeof ticket.api_key_id !== 'string' || !/^k_.{10}$/.test(ticket.api_key_id)) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'bad-api-key-id' };
  const be = ticket.binding_epoch, ge = ticket.grant_epoch;
  if (!Number.isSafeInteger(be) || be < 0 || !Number.isSafeInteger(ge) || ge < 0) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'bad-epoch' };
  if (!/^resume-[0-9a-f]{16}$/.test(String(ticket.resume_id))) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'bad-resume-id' };
  if (!/^sess-[0-9a-f]{16}$/.test(String(ticket.session_id))) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'bad-session-id' };
  if (!Number.isSafeInteger(ticket.issued_at) || !Number.isSafeInteger(ticket.expires_at)) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'bad-timestamp' };
  if (ticket.expires_at - ticket.issued_at !== QF_RECONNECT_TICKET_TTL_S) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'bad-ttl' };
  if (typeof ticket.ticket_signature !== 'string' || !ticket.ticket_signature) return { ok: false, code: 'QFR_TICKET_INVALID', reason: 'missing-signature' };
  return { ok: true };
}
/* RC-04 规范 §1.2：10 行规范串（签名原文），行尾 LF、无结尾换行；仅供测试与
 * 调试对照，浏览器端不签名（签名在服务端）。 */
function qfReconnectTicketCanonical(ticket) {
  return ['qfr-lea-reconnect-v1', ticket.account_id, ticket.device_id, ticket.api_key_id,
    String(ticket.binding_epoch), String(ticket.grant_epoch), ticket.resume_id, ticket.session_id,
    String(ticket.issued_at), String(ticket.expires_at)].join('\n');
}
/* RC-04 规范 §1：session_id 由客户端在首次建立会话时生成（sess-＋16 位小写 hex）。 */
function qfNewSessionId() {
  let hex = '';
  try {
    const b = new Uint8Array(8);
    if (window.crypto && crypto.getRandomValues) { crypto.getRandomValues(b); hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
  } catch (e) {}
  if (!hex) { for (let i = 0; i < 16; i++) hex += Math.floor(Math.random() * 16).toString(16); }
  return 'sess-' + hex;
}
/* S-054：客户端消息 ID——发送端每次发送生成一个，永不复用，随消息提交给
 * 服务端，用于去重与客户端对账。格式 cm-＋32 位小写 hex（与 clientMessageId
 * 字段名是 C-3/C-4 两边的契约；服务端存索引＋按 id 查询接口由 C-4 的 S-086
 * 落地，见 server/friends/chat/chat-server.js 的 send 处理）。 */
function qfNewClientMessageId() {
  let hex = '';
  try {
    const b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) { crypto.getRandomValues(b); hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
  } catch (e) {}
  if (!hex) { for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16); }
  return 'cm-' + hex;
}

/* ================= L5 客户端协议纯函数（RC-03/RC-07/RC-09/RC-10） ================
 * 依据工作树 server/ext/ 下五份 QF-*-1-CLIENT-SPEC.md v1 实现；数值与
 * 枚举与服务端 server/ext/*-core.js 一致。只含纯函数，不碰网络/DOM。 */

/* ---- RC-07 QF-RELAY-1：中继宣告＋三级回退（客户端本地选路） ---- */
const QF_RELAY_MAX_RELAYS = 32;
const QF_RELAY_DEFAULT_TTL_SEC = 600;
const QF_RELAY_MAX_INFLIGHT_PER_TIER = 8;
function qfRelayNormalizeUrl(u) {
  try {
    const parsed = new URL(String(u || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    let pathname = parsed.pathname || '/';
    if (!pathname.endsWith('/')) pathname += '/';
    return { origin: parsed.origin, pathname, href: parsed.origin + pathname };
  } catch (e) { return null; }
}
/* 宣告列表是否过期：issuedAt（毫秒）＋ ttlSec（秒）须统一单位（规范 §4.4）。 */
function qfRelayListExpired(list, nowMs) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const first = list[0];
  if (!first || !Number.isFinite(Number(first.issuedAt))) return true;
  const ttl = Number(first.ttlSec) > 0 ? Number(first.ttlSec) : QF_RELAY_DEFAULT_TTL_SEC;
  return now >= Number(first.issuedAt) + ttl * 1000;
}
/* 白名单校验（规范 §3）：origin 相等且路径是条目路径的前缀；空列表一律拒绝。 */
function qfIsAllowedRelay(url, list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const n = qfRelayNormalizeUrl(url);
  if (!n) return false;
  for (const e of list) {
    if (!e || !e.url) continue;
    const en = qfRelayNormalizeUrl(e.url);
    if (!en) continue;
    if (n.origin === en.origin && n.pathname.startsWith(en.pathname)) return true;
  }
  return false;
}
/* 三级回退选路（规范 §2.1，与服务端 pickRelay 同款逻辑）：
 * 候选按 tier 升序、priority 降序、id 字典序；某级在途满时跳过该级（不算失败）；
 * 无候选时 degraded:true，reason 为 tier-inflight-full 或 all-tiers-exhausted。 */
function qfPickRelay(list, failedIds, opts) {
  const o = opts || {};
  const failed = new Set(Array.isArray(failedIds) ? failedIds.map(String) : []);
  const inFlight = (o.inFlightByTier && typeof o.inFlightByTier === 'object') ? o.inFlightByTier : {};
  const maxInflight = Number(o.maxInflightPerTier) > 0 ? Number(o.maxInflightPerTier) : QF_RELAY_MAX_INFLIGHT_PER_TIER;
  const sorted = (Array.isArray(list) ? list.slice() : [])
    .filter((e) => e && e.id && !failed.has(String(e.id)))
    .sort((a, b) => (a.tier - b.tier) || (b.priority - a.priority) || (String(a.id) < String(b.id) ? -1 : 1));
  for (const e of sorted) {
    const cur = Number(inFlight[e.tier]) || 0;
    if (cur >= maxInflight) continue;
    return { relay: e, tier: e.tier, reason: failed.size ? 'fallback-after-failure' : 'primary' };
  }
  return { relay: null, tier: 0, degraded: true, reason: sorted.length ? 'tier-inflight-full' : 'all-tiers-exhausted' };
}

/* ---- RC-03 QF-VIDEO-1：FEC（RS over GF(256)）解码端 ---- */
const QF_FEC_VERSION = 1;
const QF_FEC_TIERS = { high: { k: 10, m: 2 }, low: { k: 20, m: 1 } };
/* 块头校验（规范 §1.3，与服务端 validateBlockHeader 一字一致）：
 * 任一条件成立即非法，整块丢弃。 */
function qfValidateFecHeader(h) {
  if (!h || typeof h !== 'object') return { ok: false, reason: 'not-an-object' };
  if (h.fecVersion !== QF_FEC_VERSION) return { ok: false, reason: 'bad-version' };
  if (h.m !== 1 && h.m !== 2) return { ok: false, reason: 'bad-m' };
  if (h.k !== 10 && h.k !== 20) return { ok: false, reason: 'bad-k' };
  if (h.symbolCount !== h.k + h.m) return { ok: false, reason: 'bad-symbol-count' };
  if (!Number.isSafeInteger(h.symbolIndex) || h.symbolIndex < 0 || h.symbolIndex >= h.symbolCount) return { ok: false, reason: 'bad-symbol-index' };
  if (!Number.isSafeInteger(h.symbolLength) || h.symbolLength <= 0) return { ok: false, reason: 'bad-symbol-length' };
  if (!Number.isSafeInteger(h.lastSymbolPadding) || h.lastSymbolPadding < 0 || h.lastSymbolPadding >= h.symbolLength) return { ok: false, reason: 'bad-padding' };
  return { ok: true };
}
/* FEC 档位映射（QF-QUALITY-1 §6.1 跨协议待定项）：≤5% 用 k=20/m=1，
 * ≥20% 用 k=10/m=2，中间值（10%/15%）无映射，返回 null，不得自创第三档。 */
function qfFecTierForRepairPercent(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return null;
  if (p <= 5) return 'low';
  if (p >= 20) return 'high';
  return null;
}
/* GF(256)：本原多项式 0x11d，生成元 2；校验行系数 Vandermonde (j+1)^i。 */
const QF_GF_EXP = new Uint8Array(512);
const QF_GF_LOG = new Uint8Array(256);
(function qfGfBuildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    QF_GF_EXP[i] = x; QF_GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) QF_GF_EXP[i] = QF_GF_EXP[i - 255];
})();
function qfGfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return QF_GF_EXP[QF_GF_LOG[a] + QF_GF_LOG[b]];
}
function qfGfDiv(a, b) {
  if (b === 0) throw new Error('gf-div-zero');
  if (a === 0) return 0;
  return QF_GF_EXP[(QF_GF_LOG[a] - QF_GF_LOG[b] + 255) % 255];
}
function qfGfInv(a) {
  if (a === 0) throw new Error('gf-inv-zero');
  return QF_GF_EXP[255 - QF_GF_LOG[a]];
}
function qfGfPow(a, e) {
  if (e === 0) return 1;
  if (a === 0) return 0;
  return QF_GF_EXP[(QF_GF_LOG[a] * e) % 255];
}
function qfFecParityCoef(j, i) { return qfGfPow(j + 1, i); }
/* GF(256) 小方阵求逆（高斯-约当消元）；奇异返回 null。 */
function qfGfInvertMatrix(mat) {
  const n = mat.length;
  const a = mat.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = col; r < n; r++) { if (a[r][col] !== 0) { pivot = r; break; } }
    if (pivot === -1) return null;
    if (pivot !== col) { const tmp = a[pivot]; a[pivot] = a[col]; a[col] = tmp; }
    const invPivot = qfGfInv(a[col][col]);
    for (let j = 0; j < 2 * n; j++) a[col][j] = qfGfMul(a[col][j], invPivot);
    for (let r = 0; r < n; r++) {
      if (r === col || a[r][col] === 0) continue;
      const factor = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] ^= qfGfMul(factor, a[col][j]);
    }
  }
  return a.map((row) => row.slice(n));
}
/* RS 编码：dataShards 为 k 个等长 Uint8Array，返回 { data, parity }（各 m 个）。
 * 仅供测试与对照（生产编码在 agent 侧）；与服务端 fec-ref.js 同参数。 */
function qfRsEncode(dataShards, k, m) {
  if (m !== 1 && m !== 2) throw new Error('fec-m-range');
  if (!Array.isArray(dataShards) || dataShards.length !== k) throw new Error('fec-k-mismatch');
  const shardLen = Math.max.apply(null, dataShards.map((b) => b.length).concat([1]));
  const data = dataShards.map((b) => {
    if (b.length === shardLen) return new Uint8Array(b);
    const p = new Uint8Array(shardLen); p.set(b); return p;
  });
  const parity = [];
  for (let j = 0; j < m; j++) {
    const p = new Uint8Array(shardLen);
    for (let i = 0; i < k; i++) {
      const c = qfFecParityCoef(j, i);
      if (c === 0) continue;
      const d = data[i];
      if (c === 1) { for (let b = 0; b < shardLen; b++) p[b] ^= d[b]; }
      else { for (let b = 0; b < shardLen; b++) p[b] ^= qfGfMul(c, d[b]); }
    }
    parity.push(p);
  }
  return { data, parity, shardLen };
}
/* RS erasure 解码：shards 为 k+m 个 Uint8Array 或 null（丢失）；lengths 为 k 个
 * 数据分片真实长度。返回恢复后的 k 个数据分片（按真实长度裁剪），丢失数 > m
 * 或可用校验行不足时返回 null（不可恢复，触发受控 IDR）。 */
function qfRsDecode(shards, k, m, lengths) {
  if (m !== 1 && m !== 2) throw new Error('fec-m-range');
  if (!Array.isArray(shards) || shards.length !== k + m) throw new Error('fec-shard-count');
  const missing = [];
  for (let i = 0; i < k; i++) if (!shards[i]) missing.push(i);
  if (missing.length === 0) {
    return shards.slice(0, k).map((b, i) => b.slice(0, lengths[i]));
  }
  if (missing.length > m) return null;
  const availParity = [];
  for (let j = 0; j < m; j++) if (shards[k + j]) availParity.push(j);
  if (availParity.length < missing.length) return null;
  const missCount = missing.length;
  const shardLen = (shards.find((s) => s) || new Uint8Array(0)).length;
  const rows = availParity.slice(0, missCount);
  const mat = rows.map((j) => missing.map((i) => qfFecParityCoef(j, i)));
  const inv = qfGfInvertMatrix(mat);
  if (!inv) return null;
  const out = missing.map(() => new Uint8Array(shardLen));
  for (let b = 0; b < shardLen; b++) {
    const rhs = rows.map((j) => {
      let v = shards[k + j][b];
      for (let i = 0; i < k; i++) {
        if (missing.indexOf(i) >= 0) continue;
        const c = qfFecParityCoef(j, i);
        if (c !== 0) v ^= qfGfMul(c, shards[i][b]);
      }
      return v;
    });
    for (let r = 0; r < missCount; r++) {
      let v = 0;
      for (let c = 0; c < missCount; c++) v ^= qfGfMul(inv[r][c], rhs[c]);
      out[r][b] = v;
    }
  }
  const result = shards.slice(0, k).map((s) => (s ? new Uint8Array(s) : null));
  missing.forEach((idx, r) => { result[idx] = out[r].slice(0, lengths[idx]); });
  return result.map((b, i) => b.slice(0, lengths[i]));
}

/* ---- RC-09 QF-QUALITY-1：画质四档＋判定阈值 ---- */
const QF_QUALITY_TIERS = ['smooth', 'balanced', 'clear', 'original'];
const QF_QUALITY_DEFAULT_TIER = 'balanced';
const QF_QUALITY_TIER_TABLE = {
  smooth: { targetKbps: 800, maxFps: 15, fecRepairPercent: 5, resolutionScale: 0.5, encoderPreference: 'h264' },
  balanced: { targetKbps: 2500, maxFps: 30, fecRepairPercent: 10, resolutionScale: 0.75, encoderPreference: 'h264' },
  clear: { targetKbps: 5000, maxFps: 30, fecRepairPercent: 15, resolutionScale: 1.0, encoderPreference: 'h264' },
  original: { targetKbps: 12000, maxFps: 60, fecRepairPercent: 20, resolutionScale: 1.0, encoderPreference: 'hevc' },
};
const QF_QUALITY_HOT_KEYS = ['targetKbps', 'maxFps', 'fecRepairPercent'];
const QF_QUALITY_RECONFIG_KEYS = ['resolutionScale', 'encoderPreference'];
/* 探针样本分类（规范 §3，判定用原始样本）：
 * severe：rtt>800 或 loss>20 或 decodeLag>500；
 * bad：rtt>300 或 loss>5 或 jitter>50；
 * healthy：rtt<150 且 loss<1 且 jitter<30 且（decodeLag 缺省或 <150）；
 * 缺必填字段（rtt/loss/jitter 非有限数）→ 'unknown'；其余 → 'neutral'。 */
function qfQualityClassify(s) {
  if (!s || typeof s !== 'object') return 'unknown';
  const rtt = Number(s.rttMs), loss = Number(s.lossPct), jit = Number(s.jitterMs);
  if (!Number.isFinite(rtt) || !Number.isFinite(loss) || !Number.isFinite(jit)) return 'unknown';
  const lag = (s.decodeLagMs === undefined || s.decodeLagMs === null) ? null : Number(s.decodeLagMs);
  if (rtt > 800 || loss > 20 || (lag !== null && Number.isFinite(lag) && lag > 500)) return 'severe';
  if (rtt > 300 || loss > 5 || jit > 50) return 'bad';
  if (rtt < 150 && loss < 1 && jit < 30 && (lag === null || lag < 150)) return 'healthy';
  return 'neutral';
}
/* 档位切换拆分（规范 §4.3）：hot 为热可调变化，reconfig 为需重建变化；
 * reconfig 非空时 needsIdr=true。未知档位回退默认档。 */
function qfSplitTierChange(fromTier, toTier) {
  const from = QF_QUALITY_TIER_TABLE[fromTier] || QF_QUALITY_TIER_TABLE[QF_QUALITY_DEFAULT_TIER];
  const to = QF_QUALITY_TIER_TABLE[toTier] || QF_QUALITY_TIER_TABLE[QF_QUALITY_DEFAULT_TIER];
  const hot = {}, reconfig = {};
  QF_QUALITY_HOT_KEYS.forEach((k) => { if (from[k] !== to[k]) hot[k] = to[k]; });
  QF_QUALITY_RECONFIG_KEYS.forEach((k) => { if (from[k] !== to[k]) reconfig[k] = to[k]; });
  return { hot, reconfig, needsIdr: Object.keys(reconfig).length > 0 };
}

/* ---- RC-10 QF-REC-1：录像事件流 ---- */
const QF_REC_SEEK_INTERVAL_MS = 10000;
const QF_REC_EVENT_TYPES = ['session-start', 'input', 'clipboard', 'frame-marker', 'quality-change', 'session-end', 'seek-index'];
/* 事件白名单清洗（规范 §1.1，服务端 sanitizeEvent 同款语义）：
 * 只保留白名单字段；clipboard 只记 bytes（content 丢弃）；key 截断 32 字符；
 * kind 非法按 mouse 计；x/y 缺省为 0；非法类型返回 null。 */
function qfRecSanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
  if (QF_REC_EVENT_TYPES.indexOf(ev.type) < 0) return null;
  const at = Number.isFinite(Number(ev.at)) ? Number(ev.at) : Date.now();
  if (ev.type === 'input') {
    const kind = (ev.kind === 'key' || ev.kind === 'touch') ? ev.kind : 'mouse';
    const out = { type: 'input', at, kind, x: Number.isFinite(Number(ev.x)) ? Number(ev.x) : 0, y: Number.isFinite(Number(ev.y)) ? Number(ev.y) : 0 };
    if (kind === 'key' && typeof ev.key === 'string') out.key = ev.key.slice(0, 32);
    return out;
  }
  if (ev.type === 'clipboard') {
    return { type: 'clipboard', at, bytes: Number.isFinite(Number(ev.bytes)) ? Math.max(0, Math.floor(Number(ev.bytes))) : 0 };
  }
  if (ev.type === 'frame-marker') {
    return { type: 'frame-marker', at, frameId: Number.isFinite(Number(ev.frameId)) ? Math.floor(Number(ev.frameId)) : 0, isKeyframe: ev.isKeyframe === true };
  }
  if (ev.type === 'quality-change') {
    return { type: 'quality-change', at, from: String(ev.from || '').slice(0, 32), to: String(ev.to || '').slice(0, 32) };
  }
  return { type: ev.type, at };
}
/* seek 锚点：取 t ≤ T 的最后一个锚点；无则返回 null（回放器从头读）。 */
function qfRecSeekAnchor(index, tMs) {
  if (!Array.isArray(index) || index.length === 0) return null;
  let best = null;
  for (const a of index) {
    if (!a || !Number.isFinite(Number(a.t))) continue;
    if (Number(a.t) <= tMs) best = a;
    else break;
  }
  return best;
}
/* JSONL 解析：只解析完整行（以 \n 结尾），尾部半行不消费（边下边播用）。
 * 返回 { events, consumedBytes, skipped }；非法行跳过记 skipped。 */
function qfRecParseJsonl(text, fromByte) {
  const start = typeof fromByte === 'number' && fromByte > 0 ? fromByte : 0;
  const events = [];
  let skipped = 0;
  let pos = start;
  let consumed = start;
  while (true) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) break;
    const line = text.slice(pos, nl);
    pos = nl + 1;
    consumed = pos;
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch (e) { skipped++; }
  }
  return { events, consumedBytes: consumed, skipped };
}
