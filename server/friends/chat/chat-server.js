'use strict';
/*
 * QFRemote 友聊服务（二期：端到端加密聊天＋记录同步，A 案）
 * ================================================================
 * 定位：好友服务的聊天模块。与一期好友服务（348653b7 线）的合并契约：
 *  - 本文件只通过 friends-gate.js 的接口查好友关系（areFriends/listFriends），
 *    好友关系正本归一期维护（见 friends-gate.js 文件头与 ../README.md）。
 *  - 合入时把本文件的路由挂进一期服务进程即可；独立运行时是同形态的
 *    小服务（Node 内置模块＋ws，无框架），默认只听本机 8446（原型口径），
 *    对外暴露方式随一期服务与临时通道统一处理，本文件不自作主张开公网。
 *
 * 加密与钥匙托管（2026-10-25 站长令修订，覆盖原 A 案「私钥永不出端」口径）：
 *  - 聊天内容在两端加解密（crypto-core.js，libsodium）；本服务对消息与
 *    记录只存、只中继密文。
 *  - 钥匙原件除密码包裹、设备包裹副本外，另有一份「登录状态托管副本」
 *    （sessionCopy，O 线）：由服务端主密钥包裹后存于本服务（主密钥在
 *    服务器侧生成、存专用密钥文件、权限 600，只在本进程内存中使用，
 *    不进日志、不进任何回报）。凭本人有效会话即可取回钥匙原件，打开
 *    聊天全程静默、无需再输密码。对外表述以此为准：钥匙由登录状态
 *    保管，不再宣称官方无法查看聊天内容。
 *  - 本服务没有任何管理/查询内容的接口：路由表就是全部表面（见文末清单），
 *    站长在任何页面都看不到聊天内容；日志只记账号名与计数，绝不记密码、
 *    明文、密钥材料。
 *  - 非好友不能发消息；删好友即刻停发（发送时实时查闸口）。聊天记录
 *    保留在各自保险库里（属双方各自数据），删除走「服务端删＋墓碑
 *    同步」：删一条，两边的传送行与保险库条目都清掉，各端收到墓碑后
 *    把本地显示也清掉。撤回（发送者对自己消息的操作，2026-10-24 用户
 *    口径）与删除同路清数据，但多留一条系统痕迹（元数据：谁在何时撤回
 *    了原时间为何时的消息，不含内容），双端一致显示，痕迹本身不可撤回。
 *    已脱离服务的副本（截图等）管不到——页面明示。
 *  - 登录验密走 MeshCentral 官方控制通道（用用户自己的账号密码开
 *    control.ashx 连接验真），与注册服务同一条通道；密码只过内存，
 *    不落盘、不进日志。会话令牌随机生成、只存哈希、12 小时过期。
 *
 * 配置（QFCHAT_CONFIG，默认 ./config.json）：
 *  { port, bind, tlsKey, tlsCert, mcUrl, dataFile, friendsFile, logFile,
 *    inboxCap, pollPageSize, inboxDir }
 *  inboxCap：每收件人 inbox 上限（默认 2000，夹 50..10000）；pollPageSize：
 *  每轮 poll 最多返回事件数（默认 500，夹 10..2000）。
 *  inboxDir：inbox 分片目录（默认 <dataFile 同级>/inbox/by-user，S-079）。
 *  clientMsgIndex：clientMessageId 去重索引（S-086）；reactions：每消息表态（S-084）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { FriendsGate, norm, peerType } = require('./friends-gate');
const inboxStore = require('./chat-inbox-store'); // S-079：每收件人持久 inbox 分片
const OWNER_ACCOUNT = '718983610'; // 站长本人账号：限制只约束他人、不约束本人（2026-10-25 站长令）

const CONFIG_PATH = process.env.QFCHAT_CONFIG || path.join(__dirname, 'config.json');
let _WebSocket = null;
function loadWebSocket() {
  if (_WebSocket) return _WebSocket;
  const candidates = ['ws', '/opt/meshcentral/node_modules/ws'];
  for (const c of candidates) { try { _WebSocket = require(c); return _WebSocket; } catch (e) { /* next */ } }
  throw new Error('ws module not found');
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { /* 用默认 */ }
  return Object.assign({
    port: 8446,
    bind: '127.0.0.1',
    tlsKey: '', tlsCert: '',
    mcUrl: 'wss://127.0.0.1:8443/control.ashx',
    dataFile: path.join(__dirname, 'data', 'chat-data.json'),
    friendsFile: path.join(__dirname, 'data', 'friends.json'),
    logFile: path.join(__dirname, 'data', 'chat.log'),
    inboxCap: 2000, // S-048/S-053：每收件人 inbox 上限（夹 50..10000）
    pollPageSize: 500 // S-048/S-053：每轮 poll 最多返回事件数（夹 10..2000）
  }, cfg);
}

// ---------- 数据层（单文件 JSON，原子落盘；体量小，够用） ----------
// S-048/S-053（与 B-08 同一方案，C-3 落地事件流部分）：
//  - 全局 events 仍保留（会话列表 lastSeq 扫描与旧客户端兼容），但不再是
//    轮询的唯一来源；轮询读每收件人持久 inbox（d.inbox[用户]），
//    全局 5000 条截断不再悄悄丢掉长离线用户的消息。
//  - inbox 按用户分桶、上限 inboxCap（默认 2000/人，配置可调）；超限只
//    丢该用户最旧条目，并记 inboxFloor[用户] = 仍保留的最早 seq，供 poll
//    的 gap 判定用。持久化仍走现有 Store.save() 全量落盘（增量写/分片
//    存储是 C-4 的 S-079，不在本处动）。
function emptyData() {
  return { keys: {}, sessions: {}, messages: {}, graveyard: {}, vault: {}, readMarks: {}, traces: {}, events: [], eventSeq: 0, inbox: {}, inboxFloor: {}, clientMsgIndex: {}, reactions: {} };
}
class Store {
  constructor(file) {
    this.file = file;
    // F-2（发版前全量审 P3）：原构造解析失败静默回退空数据，任一后续 save 即
    // 覆盖损坏原件。改与 events-core 隔离口径对齐并按 DS 门一收紧：ENOENT
    // （首跑无文件）才以空数据起；解析失败先改名隔离 .corrupt-* 留痕再起空；
    // 非 ENOENT 读错误与隔离改名失败一律抛错硬停，禁止写回覆盖唯一原件。
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (!(e && e.code === 'ENOENT')) {
        console.error(JSON.stringify({ ev: 'chat-store-load-error', file, err: String((e && e.message) || e) }));
        throw e;
      }
    }
    if (raw === null) { this.data = emptyData(); return; }
    try { this.data = Object.assign(emptyData(), JSON.parse(raw)); }
    catch (e) {
      const corrupt = file + '.corrupt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      try { fs.renameSync(file, corrupt); }
      catch (renameErr) {
        console.error(JSON.stringify({ ev: 'chat-store-isolate-failed', file, err: String((renameErr && renameErr.message) || renameErr) }));
        throw renameErr;
      }
      console.error(JSON.stringify({ ev: 'chat-store-corrupt-isolated', file, corrupt }));
      this.data = emptyData();
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // S-079：inbox 数组不再进单文件（已分片到 inbox/by-user/*.jsonl，
    // 见 chat-inbox-store.js）；序列化时剔除，只留 inboxFloor 等小元数据。
    // messages／vault／graveyard 仍在单文件全量保存（残留，下一阶段分片化）。
    const { inbox, ...rest } = this.data;
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(rest));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
const convOf = (a, b) => JSON.stringify([norm(a), norm(b)].sort());
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- 经官方控制通道验密（用户自己的账号密码） ----------
// 行为基准（MeshCentral 1.3.1 源码 meshuser.js:667 ＋ probe-auth.js 实测）：
//  认证成功 → 服务器在控制连接上主动下发 {action:'userinfo', userinfo:{...}}；
//  密码错误/账号不存在 → WS 升级被拒，只有 error/close，永远等不到 userinfo。
//  据此判定：收到 userinfo = 验真成功；error/close/超时 = 失败。
function verifyMeshCentralPassword(mcUrl, username, password) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} resolve(r); } };
    const WebSocket = loadWebSocket();
    const auth = Buffer.from(username).toString('base64') + ',' + Buffer.from(password).toString('base64');
    try { ws = new WebSocket(mcUrl, { rejectUnauthorized: false, headers: { 'x-meshauth': auth } }); }
    catch (e) { return resolve({ ok: false, why: 'conn-error' }); }
    const timer = setTimeout(() => finish({ ok: false, why: 'timeout' }), 6000);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'userinfo' && m.userinfo) {
        const userid = String(m.userinfo._id || '');
        const login = userid.replace(/^user\/[^/]*\//, '').toLowerCase();
        const name = login || m.userinfo.name || m.userinfo.username;
        finish({ ok: true, name: name ? String(name).toLowerCase() : username, siteadmin: m.userinfo.siteadmin || 0, userid });
      }
    });
    ws.on('error', () => finish({ ok: false, why: 'auth-rejected' }));
    ws.on('close', () => finish({ ok: false, why: 'closed' }));
  });
}

// ---------- 经控制台网页会话 cookie 验真（单点登录，与密码验真同判据） ----------
// 浏览器登录控制台后持有的 xid 会话同样被控制通道接受：带 cookie 开通道，
// 收到服务器下发的 userinfo = 会话有效；无效/过期只有 error/close。
// 会话绑 IP 的转发修复与好友服务同口径（2.3.0 H 线，原理见好友服务
// server.js 的 sessionIpFromCookie 注释）：候选 = 会话自带 IP → 请求来源
// IP → 无转发原样，被秒拒才换下一个，超时不叠试。
function sessionIpFromCookie(cookieHeader) {
  try {
    const jar = {};
    String(cookieHeader || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    if (!jar.xid) return null;
    const obj = JSON.parse(Buffer.from(String(jar.xid), 'base64').toString('utf8'));
    const ip = obj && obj.ip;
    if (typeof ip === 'string' && ip.length <= 64 && /^[0-9a-fA-F.:%[\]]+$/.test(ip)) return ip;
  } catch (e) { /* 解不出就走后备候选 */ }
  return null;
}
function verifyMeshCentralSessionOnce(mcUrl, cookieHeader, fwdIp) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} resolve(r); } };
    if (!cookieHeader || !/(^|;\s*)xid=/.test(cookieHeader)) return resolve({ ok: false, why: 'no-session' });
    const WebSocket = loadWebSocket();
    const headers = { Cookie: cookieHeader, Origin: 'https://127.0.0.1:8443' };
    if (fwdIp) headers['X-Forwarded-For'] = fwdIp;
    try { ws = new WebSocket(mcUrl, { rejectUnauthorized: false, headers }); }
    catch (e) { return resolve({ ok: false, why: 'conn-error' }); }
    const timer = setTimeout(() => finish({ ok: false, why: 'timeout' }), 6000);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m && m.action === 'userinfo' && m.userinfo) {
        const userid = String(m.userinfo._id || '');
        const login = userid.replace(/^user\/[^/]*\//, '').toLowerCase();
        const name = login || m.userinfo.name || m.userinfo.username;
        finish({ ok: true, name: name ? String(name).toLowerCase() : '', siteadmin: m.userinfo.siteadmin || 0, userid });
        return;
      }
      // 服务器对无效/伪造会话立刻回 action=close（实测 0.06 秒）：认这个信号
      // 秒拒，不再干等超时——这正是「验真超时」现象的根源修复（2026-10-25）。
      if (m && m.action === 'close') finish({ ok: false, why: 'session-rejected' });
    });
    ws.on('error', () => finish({ ok: false, why: 'auth-rejected' }));
    ws.on('close', () => finish({ ok: false, why: 'closed' }));
  });
}
async function verifyMeshCentralSession(mcUrl, cookieHeader, clientIpHint) {
  if (!cookieHeader || !/(^|;\s*)xid=/.test(cookieHeader)) return { ok: false, why: 'no-session' };
  const candidates = [];
  const sip = sessionIpFromCookie(cookieHeader);
  if (sip) candidates.push(sip);
  if (clientIpHint && !candidates.includes(clientIpHint)) candidates.push(clientIpHint);
  candidates.push(null);
  let last = { ok: false, why: 'closed' };
  for (const ip of candidates) {
    last = await verifyMeshCentralSessionOnce(mcUrl, cookieHeader, ip);
    if (last.ok) return last;
    if (last.why === 'timeout' || last.why === 'no-session') break;
  }
  return last;
}
// 请求来源 IP（与好友服务 clientIp 同口径：本机回环来的才认 X-Forwarded-For）
function clientIpOf(req) {
  const remote = (req.socket && req.socket.remoteAddress) || '';
  if ((remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return remote.replace(/^::ffff:/, '');
}

function createChatHandler(configOverrides) {
  const cfg = Object.assign(loadConfig(), configOverrides || {});
  const store = new Store(cfg.dataFile);

  // ===== 封禁功能门（P5-010，DS 稿 §5.1）=====
  // DEV-15：镜像路径由 dataFile 同级 provider-mirror 推导（与 friends 本体同源镜像）。
  const BAN_MIRROR_FILE = path.join(path.dirname(cfg.dataFile), 'provider-mirror', 'license', 'status.json');
  let _banMirrorCache = { mtimeMs: -1, size: -1, data: null };
  let _banMirrorErrLogAt = 0;

  function readBanLinkSync(username) {
    const u = String(username || '').trim().toLowerCase();
    if (!u) return false;
    try {
      const st = fs.statSync(BAN_MIRROR_FILE);
      if (st.mtimeMs !== _banMirrorCache.mtimeMs || _banMirrorCache.size !== st.size || !_banMirrorCache.data) { // DEV-18/G-11：缓存键加 size
        _banMirrorCache = { mtimeMs: st.mtimeMs, size: st.size, data: JSON.parse(fs.readFileSync(BAN_MIRROR_FILE, 'utf8')) };
      }
      const _m = _banMirrorCache.data; let rec = _m ? _m[u] : undefined; // DEV-18/G-08：扁平优先、包裹兜底
      if (!rec && _m && _m.accounts && typeof _m.accounts === 'object' && !Array.isArray(_m.accounts)) rec = _m.accounts[u];
      return !!(rec && rec.banLink === true);
    } catch (e) { // DEV-18/G-04：失败可见（60 秒节流）
      const t = Date.now(); if (t - _banMirrorErrLogAt > 60000) { _banMirrorErrLogAt = t; try { log({ ev: 'ban-mirror-read-failed', svc: 'chat', err: String(e && e.message) }); } catch (e2) {} }
      return false; }
  }
  const gate = new FriendsGate(cfg.friendsFile);

  // ---------- 全站统一档案消费（2.3.2，S5 好友/聊天线；S4 审计路线 A＋C） ----------
  // 正本在 ext 服务（本机回环 http://127.0.0.1:${QFEXT_PORT||8448}），本服务只读：
  // 批量 GET /internal/profile/view?usernames=a,b 取显示字段拼进 peers/会话，
  // 头像字节经 GET /internal/profile/:username/avatar 回源、由本服务同源代理。
  // secret 读法照 social 主服务向 ext 推事件的口径（QFLIC_SECRET_FILE 或
  // /opt/qfremote-license/internal.secret）；secret 读不到、ext 超时/断供等
  // 任何失败一律静默软降级：peers/会话原样返回、头像代理回 404，绝不挡聊天。
  // 身份键红线：peers/会话/加密一律仍以账号名为键，昵称只作显示字段附加。
  const EXT_PROFILE_PORT = parseInt(process.env.QFEXT_PORT || '8448', 10) || 8448;
  const PROFILE_VIEW_TTL_MS = 60 * 1000;   // view 缓存 60 秒（按 username）
  const PROFILE_VIEW_TIMEOUT_MS = 800;   // view 请求 800ms 超时
  const PROFILE_VIEW_CACHE_MAX = 2000;   // view 缓存条数上限（核对 D8：防只写不删慢涨）
  const profileViewCache = new Map();    // username -> { view: object|null, fetchedAt }
  // 写缓存并封顶：超上限先清过期条目，仍超则按插入序淘汰最旧（近似 LRU，P3 量级够用）
  function setProfileView(name, v) {
    profileViewCache.set(name, { view: v, fetchedAt: Date.now() });
    if (profileViewCache.size > PROFILE_VIEW_CACHE_MAX) {
      const now2 = Date.now();
      for (const [k, ent] of profileViewCache) { if (now2 - ent.fetchedAt >= PROFILE_VIEW_TTL_MS) profileViewCache.delete(k); }
      while (profileViewCache.size > PROFILE_VIEW_CACHE_MAX) {
        const oldest = profileViewCache.keys().next().value;
        if (oldest === undefined) break;
        profileViewCache.delete(oldest);
      }
    }
  }
  function profileSecret() {
    try { return fs.readFileSync(process.env.QFLIC_SECRET_FILE || '/opt/qfremote-license/internal.secret', 'utf8').trim(); } catch (e) { return ''; }
  }
  function extProfileRequest(pathname, binary) {
    return new Promise((resolve) => {
      const secret = profileSecret();
      if (!secret) return resolve(null);
      let done = false;
      const finish = (x) => { if (!done) { done = true; resolve(x); } };
      let rq;
      try {
        rq = http.request({ hostname: '127.0.0.1', port: EXT_PROFILE_PORT, path: pathname, method: 'GET', timeout: binary ? 3000 : PROFILE_VIEW_TIMEOUT_MS, headers: { 'x-qf-internal-secret': secret } }, (rs) => {
          const chunks = []; let total = 0;
          const cap = binary ? 512 * 1024 : 256 * 1024;
          // 与论坛 #6 同族口径：超限即 destroy 并立即 settle，rs error/close 兜底防 Promise 永挂
          rs.on('data', (c) => { total += c.length; if (total > cap) { try { rq.destroy(); } catch (e) {} finish(null); return; } chunks.push(c); });
          rs.on('end', () => finish({ status: rs.statusCode, headers: rs.headers, body: Buffer.concat(chunks) }));
          rs.on('error', () => finish(null));
          rs.on('close', () => finish(null));
        });
      } catch (e) { return finish(null); }
      rq.on('timeout', () => { try { rq.destroy(); } catch (e) {} finish(null); });
      rq.on('error', () => finish(null));
      rq.end();
    });
  }
  // 批量取 view：缓存新鲜的直接用，缺失/过期的合并成一次批量请求；
  // 请求失败不写缓存（下次可重试），有旧缓存值时继续用旧值。
  async function profileViewsFor(names) {
    const out = {};
    const now = Date.now();
    const stale = [];
    const seen = new Set();
    for (const raw of names || []) {
      const name = norm(raw);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const ent = profileViewCache.get(name);
      if (ent && now - ent.fetchedAt < PROFILE_VIEW_TTL_MS) { if (ent.view) out[name] = ent.view; }
      else stale.push(name);
    }
    if (stale.length) {
      // 核对 D9：ext 批量端点单次上限 50 且整批 URL 有请求头上限 → 按 ≤50 名分批并发；
      // 只缓存响应中实际出现的名——未返回的名不写 null 缓存（否则 >50 名时第 51 名起
      // 被毒化缓存且每轮同序饿死），留待下轮重试。
      const chunks = [];
      for (let off = 0; off < stale.length; off += 50) chunks.push(stale.slice(off, off + 50));
      await Promise.all(chunks.map(async (chunk) => {
        const r = await extProfileRequest('/internal/profile/view?usernames=' + encodeURIComponent(chunk.join(',')));
        let views = null;
        if (r && r.status === 200) {
          try { const j = JSON.parse(r.body.toString('utf8')); if (j && j.views && typeof j.views === 'object') views = j.views; } catch (e) { /* 坏响应按失败降级 */ }
        }
        if (views) {
          for (const name of chunk) {
            if (!Object.prototype.hasOwnProperty.call(views, name)) continue;
            const v = views[name] && typeof views[name] === 'object' ? views[name] : null;
            setProfileView(name, v);
            if (v) out[name] = v;
          }
        } else {
          for (const name of chunk) { const ent = profileViewCache.get(name); if (ent && ent.view) out[name] = ent.view; }
        }
      }));
    }
    return out;
  }
  // 在不改身份键（key 字段）的前提下附加显示字段：有 view 才附。
  async function attachProfile(list, key) {
    const views = await profileViewsFor(list.map(x => x[key]));
    for (const item of list) {
      const v = views[norm(item[key])];
      if (!v) continue;
      item.displayName = v.displayName || v.effectiveNickname || item[key];
      item.hasAvatar = !!v.hasAvatar;
      item.avatarUpdatedAt = v.hasAvatar && v.avatarUpdatedAt != null ? v.avatarUpdatedAt : null;
    }
    return list;
  }

  // ---------- 登录状态托管副本（sessionCopy）的主密钥 ----------
  // 主密钥在服务器侧生成，存专用密钥文件（权限 600），默认与数据文件
  // 同目录（生产为服务数据目录内的 session-master.key），可由配置
  // sessionMasterKeyFile 指定。密钥值只在本进程内存中使用：不写日志、
  // 不进数据文件、不出现在任何接口回报里。包裹构造用 Node 内置
  // AES-256-GCM（随机 IV＋认证标签），格式带版本位以便将来轮换：
  //   { v:1, kind:'server-aesgcm-v1', iv, tag, cipher, updatedAt }
  // 明文是 JSON {p: 身份私钥原件, v: 保险库钥匙原件}（均为 base64）。
  const MASTER_KEY_FILE = cfg.sessionMasterKeyFile || path.join(path.dirname(cfg.dataFile), 'session-master.key');
  let masterKey = null;
  function loadMasterKey() {
    if (masterKey) return masterKey;
    try {
      const k = Buffer.from(fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim(), 'base64');
      if (k.length === 32) { masterKey = k; return masterKey; }
    } catch (e) { /* 文件不存在或不可读：下面生成 */ }
    const fresh = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(MASTER_KEY_FILE), { recursive: true });
      fs.writeFileSync(MASTER_KEY_FILE, fresh.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
      try { fs.chmodSync(MASTER_KEY_FILE, 0o600); } catch (e) {}
      masterKey = fresh;
    } catch (e) {
      // 并发下他人已先写好：回读为准；再失败才用内存值（本次进程内有效）
      try {
        const k2 = Buffer.from(fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim(), 'base64');
        masterKey = k2.length === 32 ? k2 : fresh;
      } catch (e2) { masterKey = fresh; }
    }
    return masterKey;
  }
  function wrapSessionCopy(priv, vault) {
    const key = loadMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plain = Buffer.from(JSON.stringify({ p: String(priv), v: String(vault) }), 'utf8');
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { v: 1, kind: 'server-aesgcm-v1', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), cipher: ct.toString('base64'), updatedAt: Date.now() };
  }
  function unwrapSessionCopy(blob) {
    try {
      if (!blob || blob.kind !== 'server-aesgcm-v1') return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', loadMasterKey(), Buffer.from(String(blob.iv), 'base64'));
      decipher.setAuthTag(Buffer.from(String(blob.tag), 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(String(blob.cipher), 'base64')), decipher.final()]);
      const obj = JSON.parse(plain.toString('utf8'));
      if (!obj || typeof obj.p !== 'string' || typeof obj.v !== 'string') return null;
      return { priv: obj.p, vault: obj.v };
    } catch (e) { return null; }
  }
  // 钥匙原件形态校验（libsodium 32 字节材料的 base64，长度约 44）
  function validRawKeyMaterial(s) { return typeof s === 'string' && /^[A-Za-z0-9+/=_-]{16,256}$/.test(s); }
  function validSessionCopyInput(sc) {
    return !!sc && typeof sc === 'object' && validRawKeyMaterial(sc.priv) && validRawKeyMaterial(sc.vault);
  }
  try { loadMasterKey(); } catch (e) { /* 生成失败不拦服务启动，首次托管操作时再试 */ }
  const sendWindows = {}; // user -> [timestamps]，发送限频 60/分钟（照 QFClash 聊天限频）
  const typingMap = new Map(); // S-085：`${from}\n${to}` -> {from, to, typing, at}，6 秒过期，内存型，不持久化
  const presenceMap = new Map(); // S-085：user -> {status, at}，90 秒无心跳判 offline；与设备探活分开建模（无设备字段、无设备端点）
  const PAGE = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8');
  const CLIENT_JS = fs.readFileSync(path.join(__dirname, 'chat-client.js'), 'utf8');
  const CRYPTO_JS = fs.readFileSync(path.join(__dirname, 'crypto-core.js'), 'utf8');
  let SODIUM_JS = '';
  // 注意：libsodium-wrappers 的 package exports 不暴露 dist 子路径，require.resolve 会失败，按文件路径取
  const sodiumCandidates = [
    path.join(__dirname, 'node_modules', 'libsodium-wrappers-sumo', 'dist', 'modules-sumo', 'libsodium-wrappers.js'),
    '/opt/qfremote-friends/chat/node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
    '/opt/qfremote-social/node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js'
  ];
  for (const cand of sodiumCandidates) { try { SODIUM_JS = fs.readFileSync(cand, 'utf8'); break; } catch (e) { /* next */ } }
  if (!SODIUM_JS) throw new Error('libsodium-wrappers dist not found — run npm install');
  let SODIUM_BASE_JS = '';
  // libsodium-sumo base lib: the wrappers layer needs it loaded first in the browser; without it window.sodium never initializes and login fails silently
  const sodiumBaseCandidates = [
    path.join(__dirname, 'node_modules', 'libsodium-sumo', 'dist', 'modules-sumo', 'libsodium-sumo.js'),
    '/opt/qfremote-friends/chat/node_modules/libsodium-sumo/dist/modules-sumo/libsodium-sumo.js'
  ];
  for (const cand of sodiumBaseCandidates) { try { SODIUM_BASE_JS = fs.readFileSync(cand, 'utf8'); break; } catch (e) { /* next */ } }
  if (!SODIUM_BASE_JS) throw new Error('libsodium-sumo dist not found — run npm install');
  let supportFaq = [];
  try {
    const faqData = JSON.parse(fs.readFileSync(cfg.supportFaqFile || path.join(__dirname, 'support-faq.json'), 'utf8'));
    if (Array.isArray(faqData.items)) supportFaq = faqData.items;
  } catch (e) { /* FAQ 文件缺失时不影响聊天主功能 */ }

  function log(obj) {
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)) + '\n';
    try { fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true }); fs.appendFileSync(cfg.logFile, line); } catch (e) {}
  }
  function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  // —— 手动退出标记（2.3.0 退出语义统一，与好友服务同口径、各自独立）——
  // 手动退出聊天后，同一控制台会话内不再靠单点登录自动带回；标记值是
  // 当时控制台会话 xid 的哈希，控制台重新登录换新会话后自动失效，
  // 或在本页重新输账号密码登录时清除。
  function cookieMap(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(s => { const i = s.indexOf('='); if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim(); });
    return out;
  }
  function xidHashOf(req) {
    const c = cookieMap(req);
    if (!c.xid) return '';
    return sha256(String(c.xid) + '.' + String(c['xid.sig'] || ''));
  }
  function ssoSuppressed(req) {
    const c = cookieMap(req);
    if (!c.qfr_chat_out) return false;
    if (!c.xid) return true;
    return c.qfr_chat_out === xidHashOf(req);
  }
  function setOutCookie(res, req) {
    res.setHeader('Set-Cookie', 'qfr_chat_out=' + (xidHashOf(req) || '1') + '; Path=/; Max-Age=2592000; SameSite=Lax; Secure; HttpOnly');
  }
  function clearOutCookie(res) {
    res.setHeader('Set-Cookie', 'qfr_chat_out=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly');
  }
  function authUser(req) {
    const tok = req.headers['x-qfchat-token'];
    if (!tok) return null;
    const rec = store.data.sessions[sha256(tok)];
    if (!rec || rec.exp < Date.now()) return null;
    // 封禁门（P5-010，DS 稿 §5.2）：每请求判定，已签发令牌封禁后即失效
    if (readBanLinkSync(rec.user)) return null;
    return rec.user;
  }
  function nextEvent(ev) { ev.seq = ++store.data.eventSeq; store.data.events.push(ev); return ev; }
  // S-048/S-053：事件分发唯一入口——全局流与每收件人 inbox 同写。
  // 收件方：msg 事件给 from 与 to 双方；tomb/recall 事件给 parties 双方。
  // S-079：内存 inbox 同写后，再向各收件人的分片文件追加一行（O(1)）；
  // 追加失败只记日志——消息正本在 d.messages 里（随 save 落盘），
  // poll 漏的事件可由 catchup 按 seq 补回，不丢消息。
  function emitEvent(ev) {
    const saved = nextEvent(ev);
    const parties = ev.type === 'msg' ? [ev.msg.from, ev.msg.to] : (Array.isArray(ev.parties) ? ev.parties : []);
    const seen = new Set();
    for (const u of parties) {
      const name = norm(u);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const box = (store.data.inbox[name] = store.data.inbox[name] || []);
      box.push(saved);
      if (!inboxStore.appendInboxEvents(INBOX_DIR, name, [saved])) {
        try { log({ ev: 'chat-inbox-append-failed', user: name, seq: saved.seq }); } catch (e) {}
      }
    }
    pruneEvents();
    return saved;
  }
  function pruneEvents() {
    // 事件流只保留最近 5000 条（墓碑与新消息的增量拉取窗口）；保险库是历史正本，不受影响
    if (store.data.events.length > 5000) store.data.events = store.data.events.slice(-5000);
    // S-048/S-053：每收件人 inbox 各自封顶，超限只丢该用户最旧条目；
    // 丢弃后记 floor（仍保留的最早 seq），poll 靠它判定长离线缺口。
    const cap = Math.max(50, Math.min(10000, parseInt(cfg.inboxCap, 10) || 2000));
    for (const name of Object.keys(store.data.inbox)) {
      const box = store.data.inbox[name];
      if (Array.isArray(box) && box.length > cap) {
        store.data.inbox[name] = box.slice(-cap);
        store.data.inboxFloor[name] = store.data.inbox[name][0] ? store.data.inbox[name][0].seq : (store.data.eventSeq + 1);
        // S-079：内存剪枝后分片文件同步重写（原子 tmp+rename），floor 与分片一致。
        if (!inboxStore.rewriteInbox(INBOX_DIR, name, store.data.inbox[name])) {
          try { log({ ev: 'chat-inbox-rewrite-failed', user: name }); } catch (e) {}
        }
      }
    }
  }
  // S-048/S-053：旧数据文件只有全局 events、无 inbox 时，从全局流重建
  // 各收件人 inbox（只建一次，记 inboxBuilt；重建本身不丢任何事件）。
  function rebuildInboxIfNeeded() {
    const d0 = store.data;
    if (!d0.inbox || typeof d0.inbox !== 'object') d0.inbox = {};
    if (!d0.inboxFloor || typeof d0.inboxFloor !== 'object') d0.inboxFloor = {};
    if (d0.inboxBuilt) return false;
    let added = 0;
    for (const ev of (d0.events || [])) {
      const parties = ev.type === 'msg' ? [ev.msg.from, ev.msg.to] : (Array.isArray(ev.parties) ? ev.parties : []);
      const seen = new Set();
      for (const u of parties) {
        const name = norm(u);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const box = (d0.inbox[name] = d0.inbox[name] || []);
        if (!box.some((e) => e.seq === ev.seq)) { box.push(ev); added++; }
      }
      // S-048/S-053：旧数据消息无 seq 时，从事件流回填（供 catchup 用）。
      if (ev.type === 'msg' && ev.msg && ev.msg.id && d0.messages[ev.msg.id] && typeof d0.messages[ev.msg.id].seq !== 'number') {
        d0.messages[ev.msg.id].seq = ev.seq;
      }
      if ((ev.type === 'tomb' || ev.type === 'recall') && Array.isArray(ev.msgIds)) {
        for (const id of ev.msgIds) { if (d0.graveyard[id] && typeof d0.graveyard[id].seq !== 'number') d0.graveyard[id].seq = ev.seq; }
      }
    }
    const cap = Math.max(50, Math.min(10000, parseInt(cfg.inboxCap, 10) || 2000));
    for (const name of Object.keys(d0.inbox)) {
      const box = d0.inbox[name];
      if (Array.isArray(box) && box.length > cap) d0.inbox[name] = box.slice(-cap);
      if (box.length) d0.inboxFloor[name] = box[0].seq;
    }
    d0.inboxBuilt = true;
    store.save(); // 重建只跑一次：inboxBuilt 标志与 seq 回填须落盘，下次启动不再重建
    return added > 0;
  }
  // S-079：inbox 分片持久化——启动时分片与内存对齐：
  //  - 某用户的分片文件存在时，以分片为准（权威），覆盖内存 inbox，floor 取分片首条 seq；
  //  - 分片不存在、内存 inbox 有内容时（旧单文件数据或上方 legacy 重建结果），
  //    把内存 inbox 写一份分片（一次性迁移），此后只追加写分片。
  //  - 用户集合取 keys／messages／graveyard／sessions／inbox 的并集：
  //    inbox 事件只发给消息的 from／to 双方，该并集覆盖全部可能的 inbox 属主。
  const INBOX_DIR = inboxStore.inboxDirOf(cfg.dataFile, cfg.inboxDir);
  function syncInboxShards() {
    const d0 = store.data;
    const users = new Set();
    const add = (u) => { const n = norm(u); if (n) users.add(n); };
    Object.keys(d0.keys || {}).forEach(add);
    Object.values(d0.messages || {}).forEach((m) => { add(m.from); add(m.to); });
    Object.values(d0.graveyard || {}).forEach((g) => { add(g.from); add(g.to); });
    Object.values(d0.sessions || {}).forEach((s) => { add(s.user); });
    Object.keys(d0.inbox || {}).forEach(add);
    let loaded = 0, migrated = 0, bad = 0;
    for (const name of users) {
      const got = inboxStore.loadInbox(INBOX_DIR, name);
      if (got.exists) {
        d0.inbox[name] = got.events;
        if (got.events.length) d0.inboxFloor[name] = got.events[0].seq;
        else if (d0.inboxFloor[name] === undefined) d0.inboxFloor[name] = d0.eventSeq + 1;
        loaded++;
        bad += got.bad;
      } else {
        const box = Array.isArray(d0.inbox[name]) ? d0.inbox[name] : [];
        if (box.length && inboxStore.rewriteInbox(INBOX_DIR, name, box)) migrated++;
      }
    }
    if (bad) { try { log({ ev: 'chat-inbox-shard-bad-lines', bad }); } catch (e) {} }
    if (loaded || migrated) store.save(); // floor 落盘（inbox 数组本身不进单文件）
  }
  rebuildInboxIfNeeded();
  syncInboxShards();

  async function readBody(req) {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 262144) throw new Error('too-big'); }
    try { return JSON.parse(body || '{}'); } catch (e) { return {}; }
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    // ---------- 静态页（同一套页面：网页/双壳共用） ----------
    if (req.method === 'GET' && (p === '/chat' || p === '/chat/')) {
      // 收编二期收口（2026-10-26）：独立聊天页退役，活路只剩控制台 SPA 的 #chat 视图；
      // /chat/api/*、crypto-core.js 等静态脚本与 poll 通道不在此列、原样保留。
      res.writeHead(302, { 'Location': '/#chat', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && p === '/chat/crypto-core.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(CRYPTO_JS); }
    if (req.method === 'GET' && p === '/chat/chat-client.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(CLIENT_JS); }
    if (req.method === 'GET' && p === '/chat/libsodium-sumo.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(SODIUM_BASE_JS); }
    if (req.method === 'GET' && p === '/chat/libsodium-wrappers.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(SODIUM_JS); }
    if (req.method === 'GET' && p === '/chat/health') return sendJson(res, 200, { ok: true });

    // ---------- 登录（验密走控制通道；本服务不存密码） ----------
    if (req.method === 'POST' && p === '/chat/api/login') {
      const body = await readBody(req);
      const username = norm(body.username);
      const password = String(body.password || '');
      if (!username || !password) return sendJson(res, 400, { ok: false, msg: '请填写账号和密码。' });
      const v = await verifyMeshCentralPassword(cfg.mcUrl, username, password);
      if (!v.ok) { log({ ev: 'login-fail', user: username, why: v.why }); return sendJson(res, 401, { ok: false, msg: '账号或密码不正确，请检查后重试。' }); }
      const canonicalUser = norm(v.name || username);
      const blockedChatUsers = new Set(['718983610', 'qf-regsvc', 'qf-socialsvc']);
      if ((blockedChatUsers.has(canonicalUser) && canonicalUser !== OWNER_ACCOUNT) || (v.siteadmin === 4294967295 && canonicalUser !== OWNER_ACCOUNT)) {
        log({ ev: 'login-blocked-account', user: canonicalUser });
        return sendJson(res, 403, { ok: false, msg: '该账号不能使用聊天功能。' });
      }
      if (readBanLinkSync(canonicalUser)) {
        log({ ev: 'login-banlinked', user: canonicalUser });
        return sendJson(res, 403, { ok: false, code: 'ACCOUNT_BANNED', msg: '该账号已被封禁，请联系站长申诉。' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      store.data.sessions[sha256(token)] = { user: canonicalUser, exp: Date.now() + (body.remember === true ? 30 * 24 * 3600 * 1000 : 12 * 3600 * 1000) }; // 「记住此设备」：30 天
      store.save();
      clearOutCookie(res); // 重新输账号密码登录：清掉手动退出标记
      log({ ev: 'login-ok', user: canonicalUser });
      return sendJson(res, 200, { ok: true, token, user: canonicalUser });
    }

    if (req.method === 'POST' && p === '/chat/api/logout') {
      // 退出登录：作废当前会话令牌（「记住此设备」的持久令牌退出时一并失效），
      // 并落手动退出标记：同一控制台会话内不再靠单点登录自动带回（客户端
      // 同步清掉本地保存的登录令牌，见 chat-client.js 退出处理）。
      const tok = String(req.headers['x-qfchat-token'] || '');
      if (tok && store.data.sessions[sha256(tok)]) { delete store.data.sessions[sha256(tok)]; store.save(); }
      setOutCookie(res, req);
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 控制台单点登录：凭控制台会话 cookie 换发聊天令牌 ----------
    // 只换「进门令牌」；聊天钥匙凭登录状态静默取回（sessionCopy 优先，
    // 设备副本其次），全程不再出现输密码解锁，加密本体不变。
    if (req.method === 'POST' && p === '/chat/api/sso') {
      if (ssoSuppressed(req)) { log({ ev: 'sso-suppressed-manual-logout' }); return sendJson(res, 401, { ok: false, msg: '您已手动退出聊天，请重新输入账号和密码登录。' }); }
      const raw = String(req.headers.cookie || '');
      const parts = [];
      raw.split(';').forEach(s => { const t = s.trim(); if (t.startsWith('xid=') || t.startsWith('xid.sig=')) parts.push(t); });
      const v = await verifyMeshCentralSession(cfg.mcUrl, parts.join('; '), clientIpOf(req));
      if (!v.ok) { log({ ev: 'sso-fail', why: v.why }); return sendJson(res, 401, { ok: false, msg: '未登录控制台。' }); }
      const canonicalUser = norm(v.name || '');
      const blockedChatUsers = new Set(['718983610', 'qf-regsvc', 'qf-socialsvc']);
      if (!canonicalUser || (blockedChatUsers.has(canonicalUser) && canonicalUser !== OWNER_ACCOUNT) || (v.siteadmin === 4294967295 && canonicalUser !== OWNER_ACCOUNT)) {
        log({ ev: 'sso-blocked-account', user: canonicalUser });
        return sendJson(res, 403, { ok: false, msg: '该账号不能使用聊天功能。' });
      }
      if (readBanLinkSync(canonicalUser)) {
        log({ ev: 'sso-banlinked', user: canonicalUser });
        return sendJson(res, 403, { ok: false, code: 'ACCOUNT_BANNED', msg: '该账号已被封禁，请联系站长申诉。' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      store.data.sessions[sha256(token)] = { user: canonicalUser, exp: Date.now() + 12 * 3600 * 1000 };
      store.save();
      log({ ev: 'sso-login', user: canonicalUser });
      return sendJson(res, 200, { ok: true, token, user: canonicalUser });
    }

    const me = authUser(req);
    if (!me) return sendJson(res, 401, { ok: false, msg: '登录已过期，请重新登录。' });
    const d = store.data;

    if (req.method === 'GET' && p === '/chat/api/friends') {
      // friends：纯名字清单（含系统联系人，恒在首位）；peers：同序带类型，客户端打标用；
      // peers 每条附加统一档案显示字段（displayName/hasAvatar/avatarUpdatedAt，
      // 有 view 才附、name 键不动；ext 断供时 peers 原样返回）
      const peers = gate.listPeers(me);
      await attachProfile(peers, 'name');
      return sendJson(res, 200, { ok: true, friends: gate.listFriends(me), peers });
    }
    // ---------- 头像同源代理（2.3.2，S4 审计路线 C） ----------
    // 聊天页对 ext 既无凭据又跨源，头像字节只能经本端点：凭现行聊天会话
    // 鉴权（上方 authUser 已过），服务端持 internal secret 向 ext 内网字节
    // 端点回源，透传 Content-Type/Cache-Control，版本化缓存口径同正本
    // （?v= 对上 immutable、否则 no-store）；ext 无头像/断供一律 404。
    // 核对 D3：pathname 仍是百分号编码形，先捕获原始段再解码校验——否则账号名含
    // + 或 @（编码为 %2B/%40）必不匹配字符类而 404（历史邮箱型账号名亦中招）。
    const avatarMatch = p.match(/^\/chat\/api\/avatar\/([^/]+)$/);
    if (req.method === 'GET' && avatarMatch) {
      let name = '';
      try { name = norm(decodeURIComponent(avatarMatch[1])); } catch (e) { name = ''; }
      if (!/^[a-z0-9@._+\-]{1,80}$/.test(name)) return sendJson(res, 404, { ok: false, msg: 'not found' });
      const vq = u.searchParams.get('v');
      const r = await extProfileRequest('/internal/profile/' + encodeURIComponent(name) + '/avatar' + (vq ? '?v=' + encodeURIComponent(vq) : ''), true);
      if (!r || r.status !== 200) return sendJson(res, 404, { ok: false, msg: 'not found' });
      res.writeHead(200, {
        'Content-Type': r.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': r.headers['cache-control'] || 'no-store',
        'Content-Length': r.body.length,
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(r.body);
    }
    if (req.method === 'GET' && p === '/chat/api/support-faq') {
      // 客服一期固定答复：这是产品预置文案，不是任何用户的聊天内容。
      return sendJson(res, 200, { ok: true, draft: true, items: supportFaq });
    }

    // ---------- 钥匙目录与包装保管（服务器只有密文包） ----------
    // 设备包裹副本（2.3.0 L 线，设备静默解锁）：在密码包裹之外，客户端可
    // 把同一份身份私钥与保险库钥匙再用「只存在于本设备上的设备密钥」包
    // 一份副本上存。服务端仍只见密文：没有那台设备上的设备密钥，副本解
    // 不开；服务端不持有、也无法推导任何设备密钥。副本按设备登记，可
    // 多台并存、可单独撤销；密码改动（rewrap）不影响设备副本的有效性，
    // 因为副本包的是秘密原件本身、与密码无关。
    // 副本格式（客户端生成，服务端只做形态校验、不解析内容）：
    //   { kind:'sodium-secretbox-v1', nonce, cipher }   —— 壳/安卓：设备
    //     密钥为原始字节（壳由 safeStorage/DPAPI 保护、安卓由系统密钥库
    //     保护），用 libsodium crypto_secretbox 包装；
    //   { kind:'webcrypto-aesgcm-v1', iv, cipher }     —— 网页：设备密钥
    //     为 WebCrypto 不可导出密钥（存浏览器 IndexedDB），AES-GCM 包装。
    // platform 字段区分来源：'shell' | 'web' | 'android'，端点三端通用。
    const DEVICE_PLATFORMS = new Set(['shell', 'web', 'android']);
    const DEVICE_MAX_PER_USER = 20;
    function validDeviceId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(id); }
    function validDeviceBlob(b, kind) {
      if (!b || typeof b !== 'object' || b.kind !== kind) return false;
      const tag = kind === 'sodium-secretbox-v1' ? b.nonce : b.iv;
      return typeof tag === 'string' && tag.length >= 8 && tag.length <= 128 &&
        typeof b.cipher === 'string' && b.cipher.length >= 16 && b.cipher.length <= 8192;
    }
    function validDeviceCopy(c) {
      if (!c || typeof c !== 'object' || !DEVICE_PLATFORMS.has(c.platform)) return false;
      const kind = c.wrappedPriv && c.wrappedPriv.kind;
      if (kind !== 'sodium-secretbox-v1' && kind !== 'webcrypto-aesgcm-v1') return false;
      return validDeviceId(c.deviceId) && validDeviceBlob(c.wrappedPriv, kind) && validDeviceBlob(c.wrappedVault, kind);
    }
    function devicesOf(k) { if (!k.devices || typeof k.devices !== 'object') k.devices = {}; return k.devices; }
    function deviceMetaList(k) {
      return Object.keys(devicesOf(k)).map(id => {
        const c = k.devices[id];
        return { deviceId: id, platform: c.platform, kind: c.wrappedPriv && c.wrappedPriv.kind, createdAt: c.createdAt || 0, updatedAt: c.updatedAt || 0 };
      }).sort((a, b) => a.createdAt - b.createdAt);
    }
    function putDeviceCopy(k, c) {
      const devs = devicesOf(k);
      const now = Date.now();
      const prev = devs[c.deviceId];
      if (!prev && Object.keys(devs).length >= DEVICE_MAX_PER_USER) return false;
      devs[c.deviceId] = { platform: c.platform, wrappedPriv: c.wrappedPriv, wrappedVault: c.wrappedVault, createdAt: prev ? (prev.createdAt || now) : now, updatedAt: now };
      return true;
    }
    if (req.method === 'GET' && p === '/chat/api/keys/me') {
      const k = d.keys[me];
      return sendJson(res, 200, { ok: true, keys: k ? { pub: k.pub, wrappedPriv: k.wrappedPriv, wrappedVault: k.wrappedVault, devices: deviceMetaList(k), hasSessionCopy: !!k.sessionCopy, sessionCopyUpdatedAt: k.sessionCopy ? (k.sessionCopy.updatedAt || 0) : 0 } : null });
    }
    if (req.method === 'POST' && p === '/chat/api/keys/setup') {
      const body = await readBody(req);
      if (d.keys[me] && !body.force) return sendJson(res, 409, { ok: false, msg: '该账号已完成聊天加密设置。' });
      // 密码包裹与登录状态托管副本至少有其一：经登录密码建钥匙时同批带
      // 密码包裹＋托管副本；凭单点登录静默建钥匙时可只有托管副本（密码
      // 包裹为 null，其后任一次密码可得时刻由客户端补写/重包）。
      const hasWraps = !!(body.wrappedPriv && body.wrappedVault);
      const hasSc = validSessionCopyInput(body.sessionCopy);
      if (!body.pub || (!hasWraps && !hasSc)) return sendJson(res, 400, { ok: false, msg: '加密材料不完整，请重试。' });
      if (body.sessionCopy !== undefined && body.sessionCopy !== null && !hasSc) return sendJson(res, 400, { ok: false, msg: '加密材料不完整，请重试。' });
      // 首次建钥匙可同批带一份设备副本（静默迁移时机一）；force 重建时
      // 旧设备副本包的仍是旧秘密原件，一并作废，客户端解锁后会重新登记。
      if (body.device !== undefined && body.device !== null && !validDeviceCopy(body.device)) return sendJson(res, 400, { ok: false, msg: '设备加密材料不完整，请重试。' });
      d.keys[me] = { pub: String(body.pub), wrappedPriv: hasWraps ? body.wrappedPriv : null, wrappedVault: hasWraps ? body.wrappedVault : null, devices: {}, updatedAt: Date.now() };
      if (hasSc) d.keys[me].sessionCopy = wrapSessionCopy(body.sessionCopy.priv, body.sessionCopy.vault);
      if (body.device) putDeviceCopy(d.keys[me], body.device);
      store.save(); log({ ev: 'keys-setup', user: me, force: !!body.force, device: !!(body.device), sessionCopy: hasSc });
      return sendJson(res, 200, { ok: true });
    }
    // ---------- 登录状态托管副本（sessionCopy，O 线） ----------
    // 上交：客户端在任一次成功解锁后，经已认证通道把钥匙原件交来，由
    // 服务端主密钥包裹落存（静默迁移，用户无感）。取回：仅限本人有效
    // 会话，服务端在内存中解开后回传原件，客户端只在内存中使用。
    // 无会话在本处理器前置鉴权处即 401，与现行口径一致。
    if (req.method === 'POST' && p === '/chat/api/keys/session-copy') {
      const body = await readBody(req);
      if (!d.keys[me]) return sendJson(res, 404, { ok: false, msg: '该账号尚未完成聊天加密设置。' });
      if (!validSessionCopyInput(body)) return sendJson(res, 400, { ok: false, msg: '加密材料不完整，请重试。' });
      d.keys[me].sessionCopy = wrapSessionCopy(body.priv, body.vault);
      store.save(); log({ ev: 'keys-session-copy-set', user: me });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/chat/api/keys/session-copy') {
      const k = d.keys[me];
      const raw = k && k.sessionCopy ? unwrapSessionCopy(k.sessionCopy) : null;
      if (!raw) return sendJson(res, 404, { ok: false, msg: '该账号尚无登录状态托管副本。' });
      log({ ev: 'keys-session-copy-get', user: me });
      return sendJson(res, 200, { ok: true, priv: raw.priv, vault: raw.vault });
    }
    // 登记/更新一份设备包裹副本（静默迁移时机二：任何已解锁时刻后台补写）
    if (req.method === 'POST' && p === '/chat/api/keys/device') {
      const body = await readBody(req);
      if (!d.keys[me]) return sendJson(res, 404, { ok: false, msg: '该账号尚未完成聊天加密设置。' });
      if (!validDeviceCopy(body)) return sendJson(res, 400, { ok: false, msg: '设备加密材料不完整，请重试。' });
      if (!putDeviceCopy(d.keys[me], body)) return sendJson(res, 409, { ok: false, msg: '已登记的设备数量已达上限，请先撤销不再使用的设备。' });
      store.save(); log({ ev: 'keys-device-setup', user: me, deviceId: body.deviceId, platform: body.platform });
      return sendJson(res, 200, { ok: true });
    }
    // 取自己某台设备的包裹副本（解锁时用；只能取自己的，别人的取不到）
    const deviceGetMatch = p.match(/^\/chat\/api\/keys\/device\/([A-Za-z0-9_-]{8,80})$/);
    if (req.method === 'GET' && deviceGetMatch) {
      const k = d.keys[me];
      const c = k && devicesOf(k)[deviceGetMatch[1]];
      if (!c) return sendJson(res, 404, { ok: false, msg: '该设备尚未登记聊天加密副本。' });
      return sendJson(res, 200, { ok: true, deviceId: deviceGetMatch[1], platform: c.platform, wrappedPriv: c.wrappedPriv, wrappedVault: c.wrappedVault });
    }
    // 撤销某台设备的包裹副本（该设备此后回到例外解锁路径，密码包裹不受影响）
    if (req.method === 'POST' && p === '/chat/api/keys/device/revoke') {
      const body = await readBody(req);
      if (!validDeviceId(body.deviceId)) return sendJson(res, 400, { ok: false, msg: '设备标识不正确。' });
      const k = d.keys[me];
      if (!k || !devicesOf(k)[body.deviceId]) return sendJson(res, 404, { ok: false, msg: '该设备尚未登记聊天加密副本。' });
      delete k.devices[body.deviceId];
      store.save(); log({ ev: 'keys-device-revoke', user: me, deviceId: body.deviceId });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/chat/api/keys/rewrap') {
      const body = await readBody(req);
      if (!d.keys[me]) return sendJson(res, 404, { ok: false, msg: '该账号尚未完成聊天加密设置。' });
      if (!body.wrappedPriv || !body.wrappedVault) return sendJson(res, 400, { ok: false, msg: '加密材料不完整，请重试。' });
      d.keys[me].wrappedPriv = body.wrappedPriv; d.keys[me].wrappedVault = body.wrappedVault; d.keys[me].updatedAt = Date.now();
      store.save(); log({ ev: 'keys-rewrap', user: me });
      return sendJson(res, 200, { ok: true });
    }
    const keyOfMatch = p.match(/^\/chat\/api\/keys\/([a-z0-9@._-]+)$/i);
    if (req.method === 'GET' && keyOfMatch) {
      const other = norm(decodeURIComponent(keyOfMatch[1]));
      const k = d.keys[other];
      if (!k) return sendJson(res, 404, { ok: false, msg: '对方尚未开启聊天，暂时无法发送。' });
      return sendJson(res, 200, { ok: true, pub: k.pub });
    }

    // ---------- 发送（非好友拒发；只存密文） ----------
    if (req.method === 'POST' && p === '/chat/api/send') {
      const body = await readBody(req);
      const to = norm(body.to);
      if (!to || !body.nonce || !body.cipher) return sendJson(res, 400, { ok: false, msg: '消息不完整，请重试。' });
      // 官方客服已迁移至智能客服：原加密会话只读保留，服务端同步拒发，防绕过页面直调接口。
      if (to === 'qf-support') return sendJson(res, 410, { ok: false, msg: '官方客服已迁移至智能客服，本会话保留只读，请从好友页顶部进入智能客服咨询。' });
      if (!gate.areFriends(me, to)) { log({ ev: 'send-rejected-notfriend', user: me, to }); return sendJson(res, 403, { ok: false, msg: '双方还不是好友，无法发送消息。' }); }
      if (!d.keys[to]) return sendJson(res, 409, { ok: false, msg: '对方尚未开启聊天，暂时无法发送。' });
      // S-086：clientMessageId（客户端生成，cm-＋32 位 hex）——先行校验＋
      // 同发送者去重：客户端超时重试重发时返回已有 id/seq，不再建第二条，
      // 且不消耗发送限频额度（去重判定在限频之前）。
      // replyTo 须是同会话已存在消息；type 现阶段只收 text。
      const cmid = body.clientMessageId === undefined ? '' : String(body.clientMessageId);
      if (cmid && !/^[A-Za-z0-9_-]{8,128}$/.test(cmid)) return sendJson(res, 400, { ok: false, msg: '消息标识不正确。' });
      const type = body.type === undefined ? 'text' : String(body.type);
      if (type !== 'text') return sendJson(res, 400, { ok: false, msg: '暂不支持该消息类型。' });
      const replyTo = body.replyTo === undefined ? '' : String(body.replyTo);
      if (replyTo) {
        const target = d.messages[replyTo];
        if (!target || target.conv !== convOf(me, to)) return sendJson(res, 400, { ok: false, msg: '回复的消息不存在。' });
      }
      if (cmid) {
        const prevId = (d.clientMsgIndex || {})[me + '\n' + cmid];
        const prev = prevId ? d.messages[prevId] : null;
        if (prev) return sendJson(res, 200, { ok: true, id: prev.id, seq: prev.seq, at: prev.at, clientMessageId: cmid, duplicate: true });
      }
      const now = Date.now();
      const win = (sendWindows[me] || []).filter(t => now - t < 60000);
      if (win.length >= 60) return sendJson(res, 429, { ok: false, msg: '发送过于频繁，请稍后再试。' });
      win.push(now); sendWindows[me] = win;
      const id = crypto.randomBytes(12).toString('hex');
      // S-086：消息对象带 clientMessageId／replyTo／edited／type；
      // clientMessageId 建 (发送者, 值) -> id 索引（d.clientMsgIndex）。
      const msg = { id, from: me, to, conv: convOf(me, to), at: now, nonce: String(body.nonce), cipher: String(body.cipher), type, edited: false };
      if (cmid) msg.clientMessageId = cmid;
      if (replyTo) msg.replyTo = replyTo;
      d.messages[id] = msg;
      if (cmid) { d.clientMsgIndex = d.clientMsgIndex || {}; d.clientMsgIndex[me + '\n' + cmid] = id; }
      const ev = emitEvent({ type: 'msg', msg });
      msg.seq = ev.seq; // S-048/S-053：消息记事件序号，供 catchup 按 seq 补齐
      store.save();
      log({ ev: 'send', user: me, to, id });
      const out = { ok: true, id, seq: ev.seq, at: now };
      if (cmid) out.clientMessageId = cmid;
      return sendJson(res, 200, out);
    }

    // ---------- 增量拉取（新消息＋墓碑＋已读标记） ----------
    // S-048/S-053：读本人的持久 inbox（不再读全局流）；返回 gap 判定与
    // 分页信息，客户端据此补齐——
    //  - gap=true：since 已早于本 inbox 仍保留的最早 seq（长离线期间 inbox
    //    已剪枝），本页事件不完整；客户端须调 /chat/api/catchup 按 seq
    //    补回错过的消息密文（并重拉保险库取撤回痕迹），再把游标推到
    //    maxSeq，不得静默跳号。
    //  - hasMore=true：本页未取完，按 nextSince 继续拉，直到 hasMore=false。
    // 旧客户端（不认新字段）仍可按原方式消费 events，本次不破坏兼容。
    if (req.method === 'GET' && p === '/chat/api/poll') {
      const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
      const pageSize = Math.max(10, Math.min(2000, parseInt(cfg.pollPageSize, 10) || 500));
      const box = Array.isArray(d.inbox[me]) ? d.inbox[me] : [];
      const earliestSeq = box.length ? box[0].seq : (d.eventSeq + 1);
      const maxSeq = d.eventSeq;
      const gap = since > 0 && since < earliestSeq;
      const fresh = box.filter(e => e.seq > since && (
        (e.type === 'msg' && !d.graveyard[e.msg.id] && (e.msg.from === me || e.msg.to === me)) ||
        (e.type === 'tomb' && e.parties.includes(me)) ||
        (e.type === 'recall' && e.parties.includes(me)) ||
        (e.type === 'edit' && e.parties.includes(me)) || // S-086：编辑事件
        (e.type === 'reaction' && e.parties.includes(me)))); // S-084：表态事件
      const page = fresh.slice(0, pageSize);
      const hasMore = fresh.length > page.length;
      const nextSince = page.length ? page[page.length - 1].seq : since;
      const read = {};
      Object.keys(d.readMarks).forEach(cv => { const pair = JSON.parse(cv); if (pair.includes(me)) read[cv] = d.readMarks[cv]; });
      // S-085：正在输入是 6 秒过期的内存型临时事件，不进 inbox、不持久化，
      // 随 poll 以 ephemeral 下发（不占 seq，客户端不推进游标）。
      const ephemeral = [];
      const nowTs = Date.now();
      for (const [k, t] of typingMap) {
        if (t.to !== me || !t.typing) continue;
        if (nowTs - t.at > 6000) { typingMap.delete(k); continue; }
        ephemeral.push({ type: 'typing', from: t.from, typing: true, at: t.at });
      }
      return sendJson(res, 200, { ok: true, events: page, read, now: maxSeq, earliestSeq, maxSeq, gap, hasMore, nextSince, ephemeral });
    }

    // ---------- 补齐端点（S-048/S-053：poll 报 gap 后走这里补消息） ----------
    // 只返回与我有关的、事件序号在 (since, maxSeq] 内的消息密文（仍存活的）
    // 与已删消息 id（墓碑）。客户端解密后写入保险库与历史，再把游标推到
    // maxSeq。保险库是“已收到的记录副本”，离线期间从未到达的消息不在其
    // 中——只重拉保险库补不回丢消息，必须走本端点按 messages 正本补。
    // 撤回痕迹随保险库重拉取回（vault GET 恒附 traces）。
    if (req.method === 'GET' && p === '/chat/api/catchup') {
      const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
      const limitRaw = parseInt(u.searchParams.get('limit') || '100', 10) || 100;
      const limit = Math.max(1, Math.min(500, limitRaw));
      const maxSeq = d.eventSeq;
      const live = Object.values(d.messages)
        .filter(m => (m.from === me || m.to === me) && (typeof m.seq === 'number' ? m.seq : 0) > since && (typeof m.seq === 'number' ? m.seq : 0) <= maxSeq)
        .sort((a, b) => (a.seq - b.seq) || (a.at - b.at));
      const deletedIds = Object.values(d.graveyard)
        .filter(g => (g.from === me || g.to === me) && (typeof g.seq === 'number' ? g.seq : 0) > since && (typeof g.seq === 'number' ? g.seq : 0) <= maxSeq)
        .sort((a, b) => (a.seq - b.seq))
        .map(g => g.id);
      // 合并分页：消息与墓碑按 seq 统排，页内只取 limit 条（消息优先按 seq；
      // 墓碑只记 id，客户端按 id 清历史）。
      const page = live.slice(0, limit);
      const hasMore = live.length > page.length;
      const nextSince = page.length ? page[page.length - 1].seq : since;
      return sendJson(res, 200, { ok: true, messages: page, deletedIds, maxSeq, hasMore, nextSince });
    }

    // ---------- 保险库（我的记录副本，只有我能取；条目全是密文） ----------
    if (req.method === 'POST' && p === '/chat/api/vault') {
      const body = await readBody(req);
      const msgId = String(body.msgId || '');
      // CF-1：保险库写入只以仍存活的消息为正本；墓碑仅用于 tomb/recall 同步，不作为 vault 重建 origin。
      const origin = d.messages[msgId];
      if (!origin || (origin.from !== me && origin.to !== me)) return sendJson(res, 400, { ok: false, msg: '记录校验未通过，请重试。' });
      if (!body.nonce || !body.cipher) return sendJson(res, 400, { ok: false, msg: '记录不完整，请重试。' });
      const mine = d.vault[me] = d.vault[me] || [];
      if (mine.some(e => e.msgId === msgId)) return sendJson(res, 200, { ok: true, dup: true });
      mine.push({ msgId, conv: origin.conv, with: origin.from === me ? origin.to : origin.from, dir: origin.from === me ? 'out' : 'in', at: origin.at, nonce: String(body.nonce), cipher: String(body.cipher) });
      store.save();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/chat/api/vault') {
      // traces：撤回痕迹（元数据，非内容，可明文下发）；只给与我相关的会话
      const traces = {};
      Object.keys(d.traces || {}).forEach(cv => { const pair = JSON.parse(cv); if (pair.includes(me)) traces[cv] = d.traces[cv]; });
      // S-051：分页参数 limit（1..500）＋ cursor（上一页末条 msgId）。
      // 不传 limit 时沿用旧行为全量返回（旧客户端兼容）；传 limit 时按
      // (at, msgId) 稳定排序分页，客户端按页拉取解密，直到 hasMore=false。
      const all = (d.vault[me] || []).slice().sort((a, b) => (a.at - b.at) || (String(a.msgId) < String(b.msgId) ? -1 : 1));
      const limitRaw = parseInt(u.searchParams.get('limit') || '0', 10) || 0;
      if (!limitRaw) return sendJson(res, 200, { ok: true, entries: all, traces, total: all.length });
      const limit = Math.max(1, Math.min(500, limitRaw));
      const cursor = u.searchParams.get('cursor') || '';
      let start = 0;
      if (cursor) { const ci = all.findIndex((e) => e.msgId === cursor); start = ci >= 0 ? ci + 1 : 0; }
      const page = all.slice(start, start + limit);
      const hasMore = start + page.length < all.length;
      return sendJson(res, 200, { ok: true, entries: page, traces, total: all.length, nextCursor: hasMore ? page[page.length - 1].msgId : '', hasMore });
    }

    // ---------- 已读标记 ----------
    if (req.method === 'POST' && p === '/chat/api/read') {
      const body = await readBody(req);
      const cv = convOf(me, norm(body.with));
      const marks = d.readMarks[cv] = d.readMarks[cv] || {};
      marks[me] = Math.max(marks[me] || 0, parseInt(body.seq, 10) || 0);
      store.save();
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 删除与撤回（服务端删＋墓碑同步；双方的传送行与保险库条目都清） ----------
    // purge：只清数据不发事件；delete 发 tomb 事件（无痕迹），recall 发 recall 事件并留痕迹。
    function purgeMessage(msg) {
      delete d.messages[msg.id];
      // S-086：消息删了，clientMessageId 索引一并释放（否则重发同值会
      // 命中已删消息）；S-084：表态随消息一起清。
      if (msg.clientMessageId && d.clientMsgIndex) delete d.clientMsgIndex[msg.from + '\n' + msg.clientMessageId];
      if (d.reactions) delete d.reactions[msg.id];
      d.graveyard[msg.id] = { id: msg.id, from: msg.from, to: msg.to, conv: msg.conv, at: msg.at };
      [msg.from, msg.to].forEach(u2 => {
        if (d.vault[u2]) d.vault[u2] = d.vault[u2].filter(e => e.msgId !== msg.id);
      });
    }
    function deleteMessage(msg) {
      purgeMessage(msg);
      const ev = emitEvent({ type: 'tomb', conv: msg.conv, parties: [msg.from, msg.to], msgIds: [msg.id], by: me, at: Date.now() });
      if (d.graveyard[msg.id]) d.graveyard[msg.id].seq = ev.seq; // S-048/S-053：墓碑记 seq，供 catchup 补删
      return ev;
    }
    if (req.method === 'POST' && p === '/chat/api/delete') {
      const body = await readBody(req);
      const msg = d.messages[String(body.msgId || '')];
      if (!msg) return sendJson(res, 404, { ok: false, msg: '该消息已不存在。' });
      if (msg.from !== me && msg.to !== me) return sendJson(res, 403, { ok: false, msg: '无权操作该对话。' });
      const ev = deleteMessage(msg);
      store.save();
      log({ ev: 'delete', user: me, id: msg.id });
      return sendJson(res, 200, { ok: true, seq: ev.seq });
    }
    // ---------- 撤回（用户口径：自己发的消息叫「撤回」；双方都看不到，留一条系统痕迹） ----------
    // 只有发送者能撤回；痕迹是元数据（谁、何时、原消息时间），不含内容；痕迹本身不可撤回，
    // 只随「删除整个对话」一并清掉（与整会话清除语义一致）。
    if (req.method === 'POST' && p === '/chat/api/recall') {
      const body = await readBody(req);
      const msg = d.messages[String(body.msgId || '')];
      if (!msg) return sendJson(res, 404, { ok: false, msg: '该消息已不存在。' });
      if (msg.from !== me) return sendJson(res, 403, { ok: false, msg: '只能撤回自己发送的消息。' });
      purgeMessage(msg);
      const trace = { msgId: msg.id, by: me, at: Date.now(), msgAt: msg.at };
      (d.traces[msg.conv] = d.traces[msg.conv] || []).push(trace);
      const ev = emitEvent({ type: 'recall', conv: msg.conv, parties: [msg.from, msg.to], msgIds: [msg.id], by: me, at: trace.at, msgAt: msg.at, trace });
      if (d.graveyard[msg.id]) d.graveyard[msg.id].seq = ev.seq; // S-048/S-053：墓碑记 seq，供 catchup 补删
      store.save();
      log({ ev: 'recall', user: me, id: msg.id });
      return sendJson(res, 200, { ok: true, seq: ev.seq, at: trace.at, msgAt: msg.at });
    }
    if (req.method === 'POST' && p === '/chat/api/delete-conversation') {
      const body = await readBody(req);
      const cv = convOf(me, norm(body.with));
      const ids = [];
      Object.values(d.messages).filter(m => m.conv === cv).forEach(m => { ids.push(m.id); deleteMessage(m); });
      if (d.traces) delete d.traces[cv];
      store.save();
      log({ ev: 'delete-conversation', user: me, with: norm(body.with), count: ids.length });
      return sendJson(res, 200, { ok: true, count: ids.length });
    }

    // ---------- S-086：按 clientMessageId 查询与编辑 ----------
    // 查询只查自己的消息（索引键含发送者，他人值查不到）。
    if (req.method === 'GET' && p === '/chat/api/message/by-client-id') {
      const cmid = String(u.searchParams.get('clientMessageId') || '');
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(cmid)) return sendJson(res, 400, { ok: false, msg: '消息标识不正确。' });
      const id = (d.clientMsgIndex || {})[me + '\n' + cmid];
      const msg = id ? d.messages[id] : null;
      if (!msg) return sendJson(res, 404, { ok: false, msg: '未找到该消息。' });
      return sendJson(res, 200, { ok: true, message: msg });
    }
    // 编辑：只允许发送者改自己的消息；新密文（nonce/cipher）＋我方保险库
    // 副本同步换新（myNonce/myCipher）；对方副本由对方收到 edit 事件后
    // 自行重存，服务端不碰他人保险库。改完发 edit 事件进双方 inbox。
    if (req.method === 'POST' && p === '/chat/api/edit') {
      const body = await readBody(req);
      const msg = d.messages[String(body.msgId || '')];
      if (!msg) return sendJson(res, 404, { ok: false, msg: '该消息已不存在。' });
      if (msg.from !== me) return sendJson(res, 403, { ok: false, msg: '只能编辑自己发送的消息。' });
      if (!body.nonce || !body.cipher) return sendJson(res, 400, { ok: false, msg: '消息不完整，请重试。' });
      msg.nonce = String(body.nonce); msg.cipher = String(body.cipher);
      msg.edited = true; msg.editedAt = Date.now();
      const mine = d.vault[me] || [];
      const entry = mine.find((e) => e.msgId === msg.id);
      if (entry && body.myNonce && body.myCipher) { entry.nonce = String(body.myNonce); entry.cipher = String(body.myCipher); }
      const ev = emitEvent({ type: 'edit', conv: msg.conv, parties: [msg.from, msg.to], msgId: msg.id, nonce: msg.nonce, cipher: msg.cipher, editedAt: msg.editedAt, by: me, at: msg.editedAt });
      store.save();
      log({ ev: 'edit', user: me, id: msg.id });
      return sendJson(res, 200, { ok: true, seq: ev.seq, editedAt: msg.editedAt });
    }

    // ---------- S-084：表态（reaction） ----------
    // 每用户每消息一个表情；重复点同一表情即取消，换表情即替换。
    // 表情为 1–8 字符纯文本（客户端走 textContent 渲染），禁 <>& 与控制符。
    // 表态记 d.reactions[msgId][user]，随消息删除一并清；同时发 reaction
    // 事件进双方 inbox，poll 即达。
    if (req.method === 'POST' && p === '/chat/api/reaction') {
      const body = await readBody(req);
      const msg = d.messages[String(body.msgId || '')];
      if (!msg) return sendJson(res, 404, { ok: false, msg: '该消息已不存在。' });
      if (msg.from !== me && msg.to !== me) return sendJson(res, 403, { ok: false, msg: '无权操作该对话。' });
      const emoji = String(body.emoji || '');
      if (!emoji || emoji.length > 8 || /[<>&]/.test(emoji) || /[\u0000-\u001F\u007F]/.test(emoji)) return sendJson(res, 400, { ok: false, msg: '表情不正确。' });
      const all = (d.reactions[msg.id] = d.reactions[msg.id] || {});
      if (all[me] === emoji) delete all[me]; else all[me] = emoji;
      if (!Object.keys(all).length) delete d.reactions[msg.id];
      const ev = emitEvent({ type: 'reaction', conv: msg.conv, parties: [msg.from, msg.to], msgId: msg.id, by: me, emoji: all[me] || null, at: Date.now() });
      store.save();
      return sendJson(res, 200, { ok: true, seq: ev.seq, reactions: d.reactions[msg.id] || {} });
    }

    // ---------- S-085：正在输入与在线状态 ----------
    // typing：6 秒过期内存型，不进 inbox、不持久化，随 poll 的 ephemeral 下发；
    //   typing=false 即清。只允许发给好友。
    // presence：与设备探活完全分开建模——独立 Map、独立端点、无设备字段；
    //   客户端每 ≤60 秒 POST 心跳一次保活，90 秒无心跳判 offline；服务端
    //   重启后全员 offline，直到下一轮心跳。
    if (req.method === 'POST' && p === '/chat/api/typing') {
      const body = await readBody(req);
      const to = norm(body.with);
      if (!to) return sendJson(res, 400, { ok: false, msg: '会话对象不正确。' });
      if (!gate.areFriends(me, to)) return sendJson(res, 403, { ok: false, msg: '双方还不是好友。' });
      if (body.typing === true) typingMap.set(me + '\n' + to, { from: me, to, typing: true, at: Date.now() });
      else typingMap.delete(me + '\n' + to);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/chat/api/presence') {
      const body = await readBody(req);
      const status = String(body.status || '');
      if (status !== 'online' && status !== 'away' && status !== 'offline') return sendJson(res, 400, { ok: false, msg: '状态不正确。' });
      presenceMap.set(me, { status, at: Date.now() });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/chat/api/presence') {
      const names = String(u.searchParams.get('users') || '').split(',').map((s) => norm(s)).filter(Boolean).slice(0, 50);
      const out = {};
      const nowTs = Date.now();
      for (const name of names) {
        const rec = presenceMap.get(name);
        out[name] = (rec && rec.status !== 'offline' && nowTs - rec.at <= 90000) ? rec.status : 'offline';
      }
      return sendJson(res, 200, { ok: true, presence: out });
    }

    // ---------- 会话列表（页面用；只有计数与序号，没有内容） ----------
    if (req.method === 'GET' && p === '/chat/api/conversations') {
      const convs = {};
      Object.values(d.messages).forEach(m => {
        if (m.from !== me && m.to !== me) return;
        const other = m.from === me ? m.to : m.from;
        const c = convs[m.conv] = convs[m.conv] || { with: other, lastAt: 0, lastSeq: 0, count: 0 };
        c.count++; if (m.at > c.lastAt) { c.lastAt = m.at; }
      });
      (d.vault[me] || []).forEach(e => {
        const c = convs[e.conv] = convs[e.conv] || { with: e.with, lastAt: 0, lastSeq: 0, count: 0 };
        if (e.at > c.lastAt) c.lastAt = e.at;
      });
      // 每会话的最新事件序号（给已读判定用）：扫事件流取 max
      d.events.forEach(e => {
        if (e.type === 'msg' && convs[e.msg.conv]) convs[e.msg.conv].lastSeq = Math.max(convs[e.msg.conv].lastSeq, e.seq);
      });
      const list = Object.values(convs).map(c => {
        const marks = d.readMarks[convOf(me, c.with)] || {};
        return Object.assign(c, { type: peerType(c.with), myRead: marks[me] || 0, peerRead: marks[c.with] || 0 });
      }).sort((a, b) => b.lastAt - a.lastAt);
      // 每条会话按 with 附加统一档案显示字段（同 friends 口径，with 键不动）
      await attachProfile(list, 'with');
      return sendJson(res, 200, { ok: true, conversations: list });
    }

    return sendJson(res, 404, { ok: false, msg: 'not found' });
  }

  const handler = (req, res) => { handle(req, res).catch(() => { try { sendJson(res, 500, { ok: false, msg: '服务器暂时出现问题，请稍后再试。' }); } catch (e) {} }); };
  // 按用户清聊天令牌（ext ban-purge 联动调用；DS 稿 §5.5）
  function purgeUserSessions(username) {
    const target = String(username || '').trim().toLowerCase();
    if (!target) return 0;
    let n = 0;
    for (const h of Object.keys(store.data.sessions)) {
      const rec = store.data.sessions[h];
      if (rec && String(rec.user || '').trim().toLowerCase() === target) { delete store.data.sessions[h]; n += 1; }
    }
    if (n) store.save();
    return n;
  }
  handler.purgeUserSessions = purgeUserSessions;

  return handler;
}

function main() {
  const cfg = loadConfig();
  const handler = createChatHandler(cfg);
  let server;
  if (cfg.tlsKey && cfg.tlsCert) {
    server = https.createServer({ key: fs.readFileSync(cfg.tlsKey), cert: fs.readFileSync(cfg.tlsCert) }, handler);
  } else {
    server = http.createServer(handler);
  }
  server.listen(cfg.port, cfg.bind, () => {
    console.log('qfremote-chat listening on ' + cfg.bind + ':' + cfg.port + (cfg.tlsKey ? ' (https)' : ' (http, loopback prototype)'));
  });
}

if (require.main === module) main();
/*
 * 路由表面清单（全部）：
 *  GET  /chat, /chat/crypto-core.js, /chat/chat-client.js, /chat/libsodium-sumo.js, /chat/libsodium-wrappers.js, /chat/health
 *  POST /chat/api/login | keys/setup | keys/rewrap | keys/device | keys/device/revoke | keys/session-copy | send | vault | read | delete | recall | delete-conversation | edit | reaction | typing | presence
 *  GET  /chat/api/friends | support-faq | keys/me | keys/:user | keys/device/:deviceId | keys/session-copy | poll | vault | catchup | conversations | avatar/:username（同源头像代理，2.3.2）| message/by-client-id | presence
 *  send（S-086）：消息带 clientMessageId／replyTo／edited／type；
 *  同发送者同值去重返已有 id/seq；replyTo 须为同会话已存在消息。
 *  edit（S-086）：发送者改自己消息的密文，记 edited／editedAt，发 edit 事件。
 *  reaction（S-084）：每用户每消息一个表情，重复点取消；发 reaction 事件。
 *  typing／presence（S-085）：typing 6 秒过期内存型，随 poll ephemeral 下发；
 *  presence 独立建模（online/away/offline，90 秒无心跳判 offline）。
 *  inbox（S-079）：每收件人分片持久化 inbox/by-user/<sha256(user)>.jsonl，
 *  发送追加写、剪枝重写；chat-data.json 不再存 inbox 数组。
 *  poll（S-048/S-053）：读本人 inbox，附 earliestSeq / maxSeq / gap /
 *  hasMore / nextSince——gap=true 时客户端调 catchup 补消息再把游标推到 maxSeq；
 *  catchup（S-048/S-053）：GET ?since=<seq>&limit=1..500，返回 (since, maxSeq]
 *  内与我有关的消息密文与已删 id，供客户端解密后写入保险库与历史；
 *  vault（S-051）：支持 ?limit=1..500&cursor=<上一页末条 msgId> 分页，
 *  不传 limit 时全量返回（旧客户端兼容）。
 *  ——没有任何管理端点；聊天内容只以密文经过（support-faq 只返回产品预置
 *    的固定客服文案）。keys/session-copy 是唯一的钥匙原件端点：仅凭本人
 *    有效会话取回本人钥匙，口径见其上方注释。
 */
module.exports = { verifyMeshCentralPassword, verifyMeshCentralSession, sessionIpFromCookie, convOf, createChatHandler, loadConfig };
