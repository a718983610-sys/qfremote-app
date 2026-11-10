'use strict';
/*
 * QFRemote 隐私锁桥（契约 CONTRACT.md / line-b-shell-seam.md）
 * 挂在 friends 服务(8445) 内，新增 /lock/* 路由，不改好友/聊天既有行为。
 *
 * 鉴权：与好友同一套——优先 qfr_frd 会话；否则用 MeshCentral 的 xid 会话 cookie
 *       经 control 通道校验（强度等同好友 SSO；本桥不签发 qfr_frd 会话）。
 *       注意：站长账号被好友侧的 GUARD 名单挡在门外，但隐私锁的机主恰恰是站长，
 *       所以本桥的 xid 校验不套用好友的 GUARD/管理员拒绝规则，改由逐设备机主核对把关。
 * 机主：请求账号 == 组件 status.json 里登记的 ownerUsername（大小写不敏感），
 *       只认这一条（status 读不到即判非机主，写操作本来也要求先读到 status）。
 * 投递：调度 Ed25519 签名信封 → 经投递服务账号 qf-locksvc 的 control 通道
 *       用 runcommands 把信封写进设备 inbox → 触发 qf-lockctl apply →
 *       轮询 status.json 对账（30 秒超时）。status 读取同样走 runcommands+Base64 回传。
 *       （本机部署的 meshrelay 文件通道实测无法配对，证据见交接记录；
 *         信封格式/签名/对账语义与契约完全一致，仅字节搬运通道不同。）
 */
const fs = require('fs');
const crypto = require('crypto');
let WebSocket;
try { WebSocket = require('/opt/meshcentral/node_modules/ws'); } catch (e) { WebSocket = require('ws'); }
const envelope = require('./lock-envelope');

const ERR = {
  login: '请先登录。',
  notOwner: '仅设备所有者可管理这台电脑的隐私锁。',
  unreachable: '暂时无法连接这台电脑，请确认设备在线后重试。',
  alreadyLocked: '这台电脑已处于锁定状态。',
  alreadyOff: '隐私锁尚未开启。',
  fault: '这台电脑的隐私锁出现异常，请在本机处理或联系管理员。',
  noDevice: '未找到这台设备。',
  badPw: '密码长度须为 4 至 64 位。',
  badLoginPw: '登录密码不正确，请检查后重试。',
  tooManyAttempts: '登录密码连续输错太多次，请 15 分钟后再试。',
  rejected: '这台电脑拒绝了本次操作，请稍后重试。',
  notReady: '隐私锁服务尚未就绪，请稍后重试。',
  badReq: '请求内容不正确，请重试。',
  badUpdate: '更新参数不正确（版本号/下载地址/文件指纹）。',
  notNewer: '目标版本不比这台电脑现在的组件版本高。',
  componentOld: '这台电脑的锁组件版本太旧，不支持远程更新，请先人工升级组件。',
  updateTimeout: '更新超时：这台电脑还没回报新版本号，请稍后查看组件版本确认结果。',
};
const RECONCILE_MS = 30000;
const UPDATE_RECONCILE_MS = 240000; // 下载+替换+重启服务+回滚余量
const STATUS_TTL_MS = 15000;              // 机主设备状态展示缓存（原 10s；只用于 GET /lock/devices 读路径）
const STATUS_TTL_NONOWNER_MS = 60000;     // 非机主判定缓存（2.4.5：300s→60s）：只用于「过滤掉别人的设备」，永不下发；
// 300s 时刚授权/刚改名后 5 分钟内仍判非机主，60s 后变化即生效；过滤仍省读。
const STATUS_MISS_TTL_MS = 5000;          // 读不到（离线/超时）负缓存：短 TTL，尽快重试，不拖死整表

/* 通道快速失败与读路径调参（perf-lockchain 2026-10-26）
   取值理由：
   - SVC_WAIT_MS=400：就绪门。原 svcEnsure(6000) 使每个请求白等 6s（S2）。400ms 足够
     吸收「握手正在完成」的抖动，又保证通道故障时读路径总耗时 ≤0.5s（目标口径要求）。
   - SVC_HANDSHAKE_MS=5000：建链到 userinfo 的上限；超时即判失败进退避，避免半开连接挂住就绪门。
   - 退避 1s 起、×2、封顶 30s；凭据类错误（noauth）封顶 60s，降低对 MC 的认证冲击与日志量。
   - 节点清单 60s 新鲜期 + 旧值先出（stale-while-revalidate）：节点集合变化是低频事件，
     60s 内由服务端推送的 nodes 消息与后台刷新兜住。
   - 读路径单台状态读 1200ms 上限、并发 6、总预算 2400ms：在线机实测数百毫秒可回；
     离线机一律打到上限，靠并发+预算把最坏情况压到 ≤2.4s（目标「冷查 <3s」），
     超预算的台数在后台继续读完并回填缓存，供下次请求命中。 */
const SVC_WAIT_MS = 400;
const SVC_HANDSHAKE_MS = 5000;
const SVC_BACKOFF_MIN_MS = 1000;
const SVC_BACKOFF_MAX_MS = 30000;
const SVC_BACKOFF_AUTH_MAX_MS = 60000;
const NODES_TTL_MS = 60000;
const NODES_REFRESH_MS = 2500;            // 读路径/写路径强制刷新节点清单的等待上限
const READ_PATH_STATUS_TIMEOUT_MS = 1200;
const READ_PATH_CONCURRENCY = 6;
const READ_PATH_BUDGET_MS = 2400;
const DEVICES_DEDUPE_MS = 1000;           // 同账号请求合并窗口（已在飞的 promise 复用）

function eqFold(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- lastEvents 对账读取（组件实际键 ev/ts 为准，兼容旧 type/time） ---------- */
// 组件 Go 侧审计事件写 {ts, ev, fields}（privacy-lock-impl audit.go 的 AuditEvent）；
// 桥旧代码按 {time, type} 读，导致 arm/disarm/reset 的拒绝事件对账读不到
// （线 B 报告 §8）。统一先归一化：以 ev/ts 为准、缺失时回落 type/time，并把
// 两套键都补齐，这样既有 pred（读 ev.time）与新代码（读 ev.ev/ev.ts）都成立。
function eventName(ev) { return ev ? (ev.ev || ev.type) : undefined; }
function eventTime(ev) { return ev ? (ev.ts || ev.time) : undefined; }
function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  const name = eventName(ev);
  const time = eventTime(ev);
  if (ev.ev === name && ev.type === name && ev.ts === time && ev.time === time) return ev;
  return Object.assign({}, ev, { ev: name, type: name, ts: time, time: time });
}
function findRejectedEvent(status, envId) {
  if (!status || !Array.isArray(status.lastEvents)) return null;
  for (const raw of status.lastEvents) {
    const ev = normalizeEvent(raw);
    if (ev && ev.type === 'envelope-rejected' && ev.fields && ev.fields.id === envId) return ev.fields.reason || '';
  }
  return null;
}
function hasEvent(status, type, pred) {
  if (!status || !Array.isArray(status.lastEvents)) return false;
  return status.lastEvents.some((raw) => { const ev = normalizeEvent(raw); return ev && ev.type === type && pred(ev); });
}

/* ---------- H28：/lock/reset 验登录密码速率限制 ----------
// 背景：/lock/reset 验登录密码（deps.mcConnect 向 MeshCentral 做一次真登录）
// 此前无任何限流；持有效会话者可无限次试密码（复审员已降中：持会话已可
// 直接 disarm，reset 暴力破解的边际收益主要是拿 MC 账号密码——但 MC 账号
// 密码一旦到手即全站沦陷，故仍须限流）。
// 策略（进程内内存表，单实例服务适用；多实例部署时各实例独立计数，仍能
// 把单实例攻击速率压到 5 次/15 分钟）：同一账号连续 5 次验密失败即锁 15 分钟，
// 锁内再请求一律 429（不调 mcConnect、不消耗 MC 侧认证）；验密成功即清零。
// 锁的是“该账号的 reset 验密”，不锁账号本身的正常登录/disarm——误锁不扩散。
// MC 侧结论（2026-11-10，见本文件末尾注释与修净报告）：生产 MC 不在沙箱可达
// 范围，且以错密码探针生产账号有误锁站长账号的风险，故未做在线探针；公开
// 资料检索亦未找到 MC 原生登录失败锁定的确切证据——本限流是实际生效的屏障，
// 不依赖 MC 侧是否存在锁定。
*/
const RESET_PW_MAX_FAILS = 5;
const RESET_PW_WINDOW_MS = 15 * 60 * 1000;
const RESET_PW_LOCK_MS = 15 * 60 * 1000;
function createResetPwLimiter(nowFn) {
  const now = typeof nowFn === 'function' ? nowFn : Date.now;
  const table = new Map(); // 账号小写 → { fails, firstFailAt, lockedUntil }
  const inflight = new Set(); // 正在验密的账号小写（防并发多调 mcConnect）
  function keyOf(account) { return String(account || '').trim().toLowerCase(); }
  return {
    // 锁内返回 { locked:true, retryAfterSec }，否则 { locked:false }。
    check(account) {
      const rec = table.get(keyOf(account));
      if (!rec) return { locked: false };
      if (rec.lockedUntil && now() < rec.lockedUntil) {
        return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - now()) / 1000) };
      }
      if (rec.lockedUntil && now() >= rec.lockedUntil) table.delete(keyOf(account));
      return { locked: false };
    },
    // 记一次验密失败；满 5 次即上锁，返回 { locked, fails }。
    noteFail(account) {
      const k = keyOf(account);
      let rec = table.get(k);
      if (!rec || now() - rec.firstFailAt > RESET_PW_WINDOW_MS) rec = { fails: 0, firstFailAt: now(), lockedUntil: 0 };
      rec.fails += 1;
      if (rec.fails >= RESET_PW_MAX_FAILS) rec.lockedUntil = now() + RESET_PW_LOCK_MS;
      table.set(k, rec);
      return { locked: !!rec.lockedUntil && now() < rec.lockedUntil, fails: rec.fails };
    },
    // 验密成功即清零（不让一次手滑累积成锁）。
    clear(account) { table.delete(keyOf(account)); },
    // H28（DS round 1）：同一账号同时只验一个密码。check 与 tryBegin
    // 之间没有 await（JS 单线程），两者连读即原子占位；并发请求看到
    // 占位即 429，不会多调一次 mcConnect，5 次/15 分钟上限对并发也成立。
    // 调用方须在验密结束（成功或失败）后 finally 调 end() 释放占位。
    tryBegin(account) {
      const k = keyOf(account);
      if (inflight.has(k)) return false;
      inflight.add(k);
      return true;
    },
    end(account) { inflight.delete(keyOf(account)); },
  };
}

function createLockBridge(deps) {
  const cfg = deps.cfg;
  const log = typeof deps.log === 'function' ? deps.log : function () {};
  let bridgeCfg = null;
  let dispatcherKey = null;
  try {
    bridgeCfg = JSON.parse(fs.readFileSync(deps.bridgeCfgPath || '/opt/qfremote-lock/bridge-config.json', 'utf8'));
    dispatcherKey = envelope.loadDispatcherKey(fs.readFileSync(bridgeCfg.keyFile, 'utf8'));
  } catch (e) {
    log('lock', '桥配置/调度密钥加载失败，/lock 暂不可用：' + e.message);
    bridgeCfg = null;
  }

  // H28：/lock/reset 验登录密码限流（进程内表，见 createResetPwLimiter）。
  const resetPwLimiter = createResetPwLimiter();

  /* ---------- 投递服务账号的 control 通道（持久连接・就绪门・退避重连） ----------
     根因 A：桥配置里的服务账号口令与账号现行口令不一致 → meshauth 被 MC 拒
     （action:close / cause:noauth / msg:noauth-2d），通道永不就绪。原实现每个
     svcCall 先 svcEnsure(6000) 白等满 6 秒（S2）。现在：
       ① 就绪门 SVC_WAIT_MS：未就绪立刻失败（≤400ms），不再逐请求空等；
       ② 建链→userinfo 有握手超时，半开连接不挂住就绪门；
       ③ 断线/被拒指数退避（1s→…→30s，凭据类封顶 60s），退避窗口内不建链、不刷认证；
       ④ 故障/恢复各打一条明确日志（不含任何口令）；凭据由运维修好后通道自动恢复。 */
  const svc = {
    ws: null, ready: false, connecting: false, pending: new Map(), seq: 0, waiters: [],
    failStreak: 0, downSince: 0, nextAttemptAt: 0, reconnectTimer: null, pendingReason: '',
  };
  let nodeCache = { at: 0, nodes: [], inflight: null, lastError: '' };

  // 节流日志（同一 key 在窗口内只打一条），避免通道故障时日志被逐请求刷爆
  const logSeen = new Map();
  function logThrottled(key, msg, windowMs) {
    const at = logSeen.get(key) || 0;
    if (Date.now() - at < (windowMs || 60000)) return;
    logSeen.set(key, Date.now());
    log('lock', msg);
  }

  /* ---------- 机主登记名别名表（账号改名兼容，lock-devices-empty-20261029） ----------
     组件登记的机主名（被控机 device.json 的 OwnerUsername）在账号改名后成为旧名，
     服务端改名流程动不了被控机本地文件，桥按现名直认必然失配、/lock/devices 回空。
     别名表 /opt/qfremote-lock/owner-alias.json 由运维依据改名记录维护：
       { "aliases": { "<现名>": ["<曾用名>", ...] } }
     判定语义不变（仍只认「登记名属于请求者本人」），仅把请求者的曾用名纳入比对。
     文件缺失＝无别名（常态降级）；内容损坏＝保留上次好表＋节流日志，绝不抛错。 */
  const OWNER_ALIAS_PATH = '/opt/qfremote-lock/owner-alias.json';
  const OWNER_ALIAS_RELOAD_MS = 30000;
  let ownerAliasIndex = new Map(); // fold(登记名) -> fold(现名)
  let ownerAliasMtimeMs = -1;
  let ownerAliasLastCheck = 0;
  let ownerAliasSignature = '';
  function ownerAliasSig(idx) { return String(idx.size) + ':' + Array.from(idx.keys()).sort().join(','); }
  function foldName(s) { return typeof s === 'string' ? s.trim().toLowerCase() : ''; }
  // 登记名哈希（只记前 16 位 hex，不记明文账号）：owner-mismatch 排障日志用。
  function ownerNameHash(s) { return crypto.createHash('sha256').update(foldName(s)).digest('hex').slice(0, 16); }
  // 机主登记失配日志：有 status 但登记名不属于请求者时记一条（节流 60 秒/台），
  // 供站长排障（-Owner 填错时设备直接从列表消失，用户侧无任何可见线索）。
  function logOwnerMismatch(me, node, status) {
    if (!status || !status.ownerUsername) return;
    logThrottled('owner-mismatch-' + node._id,
      'lock 机主登记失配：node=' + node._id + ' 登记名哈希=' + ownerNameHash(status.ownerUsername)
      + '（登记的 -Owner 与请求账号不符；用 GET /lock/owner-check?id= 核对原值）', 60000);
  }
  function loadOwnerAliases(force) {
    const now = Date.now();
    if (!force && (now - ownerAliasLastCheck) < OWNER_ALIAS_RELOAD_MS) return;
    ownerAliasLastCheck = now;
    let st;
    try { st = fs.statSync(OWNER_ALIAS_PATH); } catch (e) {
      if (ownerAliasMtimeMs !== -1) { ownerAliasIndex = new Map(); ownerAliasMtimeMs = -1; }
      return;
    }
    if (!force && ownerAliasMtimeMs === st.mtimeMs) return;
    try {
      const raw = JSON.parse(fs.readFileSync(OWNER_ALIAS_PATH, 'utf8'));
      const src = (raw && typeof raw === 'object' && raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases))
        ? raw.aliases : raw;
      const idx = new Map();
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        for (const cur of Object.keys(src)) {
          const c = foldName(cur);
          const olds = src[cur];
          if (!c || !Array.isArray(olds)) continue;
          for (const o of olds) {
            const k = foldName(o);
            if (!k || k === c) continue;
            const prev = idx.get(k);
            // 【门二 P1】同一曾用名映射到两个不同现名＝表内冲突：整表拒绝（保留上次好表），
            // 绝不 last-wins 静默串扰到另一个账号。
            if (prev && prev !== c) throw new Error('别名表冲突：曾用名 ' + o + ' 同时映射到 ' + prev + ' 与 ' + c + '，本版别名表已拒绝加载');
            idx.set(k, c);
          }
        }
      }
      ownerAliasIndex = idx;
      ownerAliasMtimeMs = st.mtimeMs;
      // X-14：别名表内容一变（改名刚登记），立即失效全部机主判定缓存——
      // 否则非机主条目要等 60 秒 TTL 才重判，刚改名仍看不到设备。
      const sig = ownerAliasSig(idx);
      if (sig !== ownerAliasSignature) {
        ownerAliasSignature = sig;
        if (statusCache.size) { statusCache.clear(); logThrottled('alias-invalidate', 'lock 机主别名表已更新，机主判定缓存已清空（改名/授权即时生效）。', 60000); }
      }
    } catch (e) {
      logThrottled('alias-bad', 'lock 机主别名表读取失败（保留上次好表继续服务）：' + (e && e.message), 60000);
    }
  }
  // 登记名是否属于请求者：现名直认，或登记名是请求者的曾用名（别名表命中）。
  // 直认与别名共用同一 fold 语义（trim+小写），避免与 eqFold 无 trim 的口径漂移（门二存疑 1）。
  function ownerNameMatches(me, recorded) {
    const recFold = foldName(recorded);
    if (recFold && recFold === foldName(me)) return true;
    loadOwnerAliases(false);
    const target = ownerAliasIndex.get(recFold);
    if (target && target === foldName(me)) {
      logThrottled('alias-hit-' + foldName(me), 'lock 机主判定经别名表命中：登记名 ' + recorded + ' → 现名 ' + me + '（账号改名兼容）。', 60000);
      return true;
    }
    return false;
  }

  function svcNotifyReady() {
    const w = svc.waiters.splice(0);
    for (const fn of w) { try { fn(); } catch (e) {} }
  }
  function svcScheduleReconnect(reason) {
    const r = String(reason || 'svc-down');
    if (svc.downSince === 0) svc.downSince = Date.now();
    svc.failStreak++;
    const auth = /noauth|auth-failed|bad-credential/.test(r);
    const cap = auth ? SVC_BACKOFF_AUTH_MAX_MS : SVC_BACKOFF_MAX_MS;
    const base = Math.min(SVC_BACKOFF_MIN_MS * Math.pow(2, Math.min(svc.failStreak - 1, 6)), cap);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4)); // ±20% 抖动，避免固定节奏
    svc.nextAttemptAt = Date.now() + delay;
    if (!svc.reconnectTimer) {
      svc.reconnectTimer = setTimeout(() => { svc.reconnectTimer = null; svcConnect(); }, delay);
    }
    if (svc.failStreak === 1 || svc.failStreak % 10 === 0) {
      log('lock', 'svc 通道不可用（' + r + '，连续失败 ' + svc.failStreak + ' 次）：读路径按快速失败处理，'
        + delay + 'ms 后重连。');
    }
  }
  function svcConnect() {
    if (!bridgeCfg) return;
    if (svc.ws || svc.connecting) return;
    if (Date.now() < svc.nextAttemptAt) { // 退避窗口内：只安排重连，不建链
      if (!svc.reconnectTimer) {
        svc.reconnectTimer = setTimeout(() => { svc.reconnectTimer = null; svcConnect(); },
          Math.max(50, svc.nextAttemptAt - Date.now()));
      }
      return;
    }
    svc.connecting = true;
    const xauth = Buffer.from(bridgeCfg.svcUser).toString('base64') + ',' + Buffer.from(bridgeCfg.svcPass).toString('base64');
    let ws;
    try {
      ws = new WebSocket(bridgeCfg.mcUrl + '/control.ashx', { rejectUnauthorized: false, headers: { 'x-meshauth': xauth, Origin: 'https://127.0.0.1:8443' } });
    } catch (e) {
      svc.connecting = false;
      svcScheduleReconnect('svc-construct-failed');
      return;
    }
    svc.ws = ws;
    const handshakeTimer = setTimeout(() => {
      if (svc.ready) return;
      svc.pendingReason = 'svc-handshake-timeout';
      try { ws.close(); } catch (e) {}
    }, SVC_HANDSHAKE_MS);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m && m.action === 'close') {
        // MeshCentral 明确拒绝（实测 noauth-2d＝口令认证失败）：记原因、断开，交给退避重连。
        // 日志只写 cause/msg，不打印任何口令或凭据。
        const cause = String(m.cause || '') + (m.msg ? '/' + String(m.msg) : '');
        log('lock', 'svc 通道被 MeshCentral 拒绝（' + cause + '）：服务账号凭据可能失效或与账号现行口令不一致，'
          + '请运维核对部署配置中的 svcUser/svcPass；本进程将持续退避重连，读路径按快速失败处理。');
        svc.pendingReason = /noauth/.test(cause) ? 'noauth' : 'auth-failed';
        try { ws.close(); } catch (e) {}
        return;
      }
      if (m && m.action === 'userinfo') {
        const wasDown = svc.downSince;
        svc.ready = true; svc.connecting = false;
        svc.failStreak = 0; svc.downSince = 0; svc.nextAttemptAt = 0; svc.pendingReason = '';
        clearTimeout(handshakeTimer);
        log('lock', 'svc 通道已就绪' + (wasDown ? '（中断 ' + (Date.now() - wasDown) + 'ms 后恢复）' : '') + '。');
        svcNotifyReady();
        return;
      }
      if (m.action === 'nodes') updateNodeCache(m.nodes);
      if (m.responseid && svc.pending.has(m.responseid)) {
        const p = svc.pending.get(m.responseid);
        if (m.action === p.action || typeof m.result === 'string' || m.action === 'nodes' || m.action === 'users') {
          svc.pending.delete(m.responseid);
          clearTimeout(p.timer);
          p.resolve(m);
        }
      }
    });
    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      const reason = svc.pendingReason || (svc.ready ? 'svc-closed' : 'svc-closed-unready');
      svc.pendingReason = '';
      svc.ws = null; svc.connecting = false; svc.ready = false;
      for (const [, p] of svc.pending) { clearTimeout(p.timer); p.reject(new Error('svc-down')); }
      svc.pending.clear();
      svcScheduleReconnect(reason);
    });
    ws.on('error', (e) => {
      logThrottled('svc-err', 'svc 通道连接错误：' + (e && e.message ? e.message : 'unknown') + '（将退避重连）', 30000);
      try { ws.close(); } catch (err) {}
    });
  }
  // 就绪门：就绪立即过；未就绪最多等 SVC_WAIT_MS（≤500ms），到点即失败
  function svcEnsure(timeoutMs) {
    if (svc.ready && svc.ws) return Promise.resolve();
    const waitMs = Math.max(0, Math.min(timeoutMs == null ? SVC_WAIT_MS : timeoutMs, SVC_WAIT_MS));
    svcConnect(); // 退避窗口内只是安排重连，不会建链
    if (!waitMs) return Promise.reject(new Error('svc-down'));
    return new Promise((resolve, reject) => {
      const cb = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => {
        const i = svc.waiters.indexOf(cb);
        if (i >= 0) svc.waiters.splice(i, 1); // 原实现超时后 waiter 泄漏，这里清掉
        reject(new Error('svc-down'));
      }, waitMs);
      svc.waiters.push(cb);
    });
  }
  async function svcCall(obj, timeoutMs) {
    await svcEnsure(SVC_WAIT_MS);
    if (!svc.ws || !svc.ready) throw new Error('svc-down');
    const rid = 'lb-' + (++svc.seq) + '-' + crypto.randomBytes(3).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { svc.pending.delete(rid); reject(new Error('svc-timeout')); }, timeoutMs || 15000);
      svc.pending.set(rid, { resolve, reject, timer, action: obj.action });
      try { svc.ws.send(JSON.stringify(Object.assign({}, obj, { responseid: rid }))); }
      catch (e) { svc.pending.delete(rid); clearTimeout(timer); reject(new Error('svc-down')); }
    });
  }

  function updateNodeCache(nodes) {
    if (!nodes) return;
    let arr = Array.isArray(nodes) ? nodes : Object.values(nodes);
    if (arr.some((v) => Array.isArray(v))) { // 服务器按设备组分组下发 { meshid: [node,...] }，摊平
      const flat = [];
      for (const v of arr) { if (Array.isArray(v)) flat.push(...v); else if (v) flat.push(v); }
      arr = flat;
    }
    // 原地更新（保留 inflight / lastError 字段，不能整体替换对象）
    // 【施工偏差 D2】空回包且旧缓存非空时保留旧节点（防瞬时空回包清表），但仍刷新 at，
    // 否则 60s 内每请求都会再触发一次实打刷新（与 B1 目标相悖）；幽灵节点仍须过
    // status 实读＋机主过滤才会下发，安全口径不变。
    nodeCache.at = Date.now(); nodeCache.lastError = '';
    if (arr.length || nodeCache.nodes.length === 0) nodeCache.nodes = arr;
  }
  // 节点清单刷新：single-flight（并发/重复请求共用一次 svcCall）
  function refreshNodes(timeoutMs) {
    if (nodeCache.inflight) return nodeCache.inflight;
    const p = (async () => {
      try {
        const r = await svcCall({ action: 'nodes' }, timeoutMs || NODES_REFRESH_MS);
        if (r && r.nodes) { updateNodeCache(r.nodes); return nodeCache.nodes; }
        nodeCache.lastError = 'nodes-empty';
      } catch (e) {
        nodeCache.lastError = (e && e.message) || 'nodes-failed';
      } finally {
        nodeCache.inflight = null;
      }
      return nodeCache.nodes;
    })();
    nodeCache.inflight = p;
    return p;
  }
  // 写路径用：清单新鲜就直接用；不新鲜强制刷新一次（失败回落旧值，与原「缓存兜底」一致）
  async function listNodes() {
    if (nodeCache.at && (Date.now() - nodeCache.at) < NODES_TTL_MS) return nodeCache.nodes;
    try { await refreshNodes(NODES_REFRESH_MS); } catch (e) { /* 退回旧值 */ }
    return nodeCache.nodes;
  }
  // 读路径用：清单先出（旧值也出），过期在后台刷新，不阻塞 /lock/devices
  async function listNodesForRead() {
    if (nodeCache.at && (Date.now() - nodeCache.at) < NODES_TTL_MS) return nodeCache.nodes;
    if (nodeCache.at && nodeCache.nodes.length) {
      refreshNodes(NODES_REFRESH_MS).catch(() => {});
      return nodeCache.nodes;
    }
    try { await refreshNodes(NODES_REFRESH_MS); } catch (e) { /* 通道故障时 ~400ms 内返回空清单 */ }
    return nodeCache.nodes;
  }

  // 注：机主判定只认组件 status.json 的登记名（见 isOwner），不查 users 列表——
  // qf-locksvc 保持 siteadmin=0 最小权限，'users' 命令对它本就返回空。

  /* ---------- 设备 status 读取 / 信封投递（runcommands 通道） ---------- */
  const statusCache = new Map();
  const PS_READ_STATUS = 'powershell -NoProfile -NonInteractive -Command "[Console]::Out.Write([Convert]::ToBase64String([IO.File]::ReadAllBytes(\'C:\\ProgramData\\QFRemote\\Lock\\status.json\')))"';
  function psWriteInbox(fileName, b64) {
    return 'powershell -NoProfile -NonInteractive -Command "[IO.File]::WriteAllBytes(\'C:\\ProgramData\\QFRemote\\Lock\\inbox\\' + fileName + '\',[Convert]::FromBase64String(\'' + b64 + '\'))"';
  }
  const CMD_APPLY = '"C:\\Program Files\\QFRemote\\Lock\\qf-lockctl.exe" apply';

  async function runCommand(nodeId, cmd, timeoutMs) {
    // 与 meshctrl 完全同款：cmds 是单个字符串，且必须带 reply:true 服务器才回传输出
    const r = await svcCall({ action: 'runcommands', nodeids: [nodeId], type: 0, cmds: cmd, reply: true, runAsUser: 0 }, timeoutMs || 20000);
    return (r && typeof r.result === 'string') ? r.result : '';
  }
  // fresh=true 一律实读（写路径 / 对账专用，不因缓存跳过）；fresh=false 走分级 TTL。
  // 读不到（离线/超时/通道故障）也写缓存，但记 status=null，按 STATUS_MISS_TTL_MS 短负缓存。
  async function readStatus(nodeId, fresh, opts) {
    const c = statusCache.get(nodeId);
    const ttl = (opts && opts.ttlMs != null) ? opts.ttlMs : (c && c.status ? STATUS_TTL_MS : STATUS_MISS_TTL_MS);
    if (!fresh && c && (Date.now() - c.at) < ttl) return c.status;
    const timeoutMs = (opts && opts.timeoutMs) || 20000;
    let status = null;
    try {
      const out = await runCommand(nodeId, PS_READ_STATUS, timeoutMs);
      const m = out.replace(/\s+/g, '').match(/[A-Za-z0-9+/=]{80,}/);
      if (m) {
        const parsed = JSON.parse(Buffer.from(m[0], 'base64').toString('utf8'));
        if (parsed && typeof parsed.state === 'string') status = parsed;
      }
    } catch (e) { status = null; }
    if (status) {
      statusCache.set(nodeId, { at: Date.now(), status });
    } else if (!(c && c.status)) {
      statusCache.set(nodeId, { at: Date.now(), status: null }); // negative-cache only when no good entry to preserve
    }
    // 【施工偏差 D4】读失败且有旧好值：保留旧条目与时间戳，不被一次失败探活抹掉
    if (statusCache.size > 512) { // 兜底清理，节点规模本是个位数～两位数，正常不会触发
      const cutoff = Date.now() - STATUS_TTL_NONOWNER_MS;
      for (const [k, v] of statusCache) { if (!v || v.at < cutoff) statusCache.delete(k); }
    }
    return status;
  }
  // 缓存是否对「本请求者」仍然有效：机主设备 15s（展示用），非机主 300s（仅过滤用），
  // 读不到 5s（尽快重试）。因此归属判定的最长陈旧窗口＝15s（机主）/300s（非机主）。
  function statusFresh(entry, me) {
    if (!entry) return false;
    let ttl;
    if (!entry.status) ttl = STATUS_MISS_TTL_MS;
    else if (entry.status.ownerUsername && ownerNameMatches(me, entry.status.ownerUsername)) ttl = STATUS_TTL_MS;
    else ttl = STATUS_TTL_NONOWNER_MS;
    return (Date.now() - entry.at) < ttl;
  }
  // 下发结构（字段名/顺序/含义严格照契约，与改造前逐字一致）
  function deviceFromNode(node, status) {
    return {
      id: node._id,
      name: node.name || '',
      owner: true,
      locked: status ? status.state === 'Locked' : false,
      component: !!status,
      version: status ? (status.version || null) : null,
    };
  }
  // 预算内的并发实读：到预算点先返回「已实读确认」的部分，剩余台数后台读完回填缓存。
  // 安全口径不变：没实读到 status 的节点一律不进结果（未核实归属不下发）。
  // 返回值＝预算用尽时尚未读完的台数（X-13：供 /lock/devices 报 partial/pending）。
  function readStatusesBounded(nodes, me, budgetMs, found) {
    return new Promise((resolve) => {
      let idx = 0, released = false, done = 0;
      const release = () => { if (released) return; released = true; clearTimeout(timer); resolve(nodes.length - done); };
      const timer = setTimeout(() => {
        logThrottled('read-budget', 'lock/devices 读路径预算 ' + budgetMs + 'ms 用尽，剩余 '
          + (nodes.length - done) + ' 台状态转后台回填，本次按已实读确认的机主设备返回。', 30000);
        release();
      }, budgetMs);
      const worker = async () => {
        while (idx < nodes.length) {
          const node = nodes[idx++];
          let st = null;
          try { st = await readStatus(node._id, true, { timeoutMs: READ_PATH_STATUS_TIMEOUT_MS }); } catch (e) { st = null; }
          // 【门二必修#2】读路径失败记账（成功即清）；写路径不经此函数，不受抑制影响
          if (st) devicesMissAt.delete(missKey(me, node._id)); else devicesMissAt.set(missKey(me, node._id), Date.now());
          done++;
          // released 之后只回填 statusCache（readStatus 内已写），不再改动本次响应
          if (!released && st && !isOwner(me, node, st)) logOwnerMismatch(me, node, st);
          if (!released && isOwner(me, node, st)) found.set(node._id, deviceFromNode(node, st));
          if (done === nodes.length) release();
        }
      };
      const n = Math.min(READ_PATH_CONCURRENCY, nodes.length);
      for (let i = 0; i < n; i++) worker();
    });
  }

  async function deliverEnvelope(nodeId, env) {
    const b64 = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
    await runCommand(nodeId, psWriteInbox(env.id + '.json', b64));
    try { await runCommand(nodeId, CMD_APPLY); } catch (e) { /* 组件有 inbox 轮询兜底 */ }
  }

  // findRejectedEvent / hasEvent 已提到模块作用域（对账读取统一归一化 ev/ts，见文件上方）。

  /* ---------- 鉴权 ---------- */
  const xidCache = new Map();
  function parseCookies(req) {
    const out = {};
    const raw = (req.headers && req.headers.cookie) || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  async function authUser(req) {
    try {
      const s = deps.sessionUser(req);
      if (s) return s;
    } catch (e) {}
    const cookies = parseCookies(req);
    if (!cookies.xid) return null;
    const cookieHeader = req.headers.cookie || '';
    const key = crypto.createHash('sha256').update(cookieHeader).digest('hex');
    const cached = xidCache.get(key);
    if (cached && (Date.now() - cached.at) < 30000) return cached.user;
    try {
      const sess = await deps.mcConnectCookie(cfg, cookieHeader);
      if (!sess || !sess.userinfo || !sess.userinfo._id) return null;
      let uid = String(sess.userinfo._id);
      const parts = uid.split('/');
      if (parts.length === 3 && parts[0] === 'user') uid = parts[2];
      uid = uid.toLowerCase();
      try { if (sess.ws) sess.ws.close(); } catch (e) {}
      xidCache.set(key, { user: uid, at: Date.now() });
      return uid;
    } catch (e) { return null; }
  }

  /* ---------- 机主判定 ---------- */
  // 只认组件登记机主：status.json 的 ownerUsername 与请求账号大小写不敏感相等。
  // status 读不到或没登记名 → 一律判非机主（保守；写操作本来也要求先读到 status）。
  function isOwner(me, node, status) {
    return !!(status && status.ownerUsername && ownerNameMatches(me, status.ownerUsername));
  }

  /* ---------- HTTP 小工具 ---------- */
  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
  function fail(res, code, text) { sendJson(res, code, { error: text }); }
  function readJsonBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 65536) { try { req.destroy(); } catch (e) {} resolve(null); } });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  async function getDeviceOrFail(res, id, me) {
    // 写路径不许用缓存做机主判定：节点清单可用缓存/刷新兜底，status 一律 fresh 实读（下方 readStatus(..., true)）
    let nodes = await listNodes();
    let node = nodes.find((n) => n && n._id === id);
    if (!node) {
      // 清单可能过期（新建设备/刚授权）：给一次强制刷新，再判
      try { await refreshNodes(NODES_REFRESH_MS); } catch (e) {}
      nodes = nodeCache.nodes;
      node = nodes.find((n) => n && n._id === id);
    }
    if (!node) {
      // 【门二必修#1】清单取不到且通道未就绪：报「连不上」，不误报「未找到设备」（与 D3 同口径，补齐前置分支）
      if (!svc.ready) { fail(res, 503, ERR.unreachable); return null; }
      fail(res, 404, ERR.noDevice); return null;
    }
    const status = await readStatus(node._id, true);
    if (!status) {
      // W-16：status 读不到时离线与无权必须分开——通道未就绪（503）与通道就绪
      // 但 status 读不到（设备离线/组件未回包，503「暂时无法连接这台电脑」）
      // 都不再回 403 notOwner；离线被误报成「非机主」会让用户去纠结账号而不是去开电脑。
      fail(res, 503, ERR.unreachable); return null;
    }
    if (!isOwner(me, node, status)) { fail(res, 403, ERR.notOwner); return null; }
    return { node, status };
  }

  async function reconcile(nodeId, env, checkFn) {
    const deadline = Date.now() + RECONCILE_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      const st = await readStatus(nodeId, true);
      if (!st) continue;
      const rej = findRejectedEvent(st, env.id);
      if (rej != null) return { ok: false, reason: rej };
      if (checkFn(st)) return { ok: true };
    }
    return { ok: false, reason: 'timeout' };
  }

  // update 专用对账：周期更长（下载+停启服务），对账凭据只有一个——
  // status.json 的 version 变成目标版本。组件拒绝（含旧组件的
  // unknown-op / bad-signature）从 lastEvents 里读：事件名键兼容
  // 组件 Go 侧的 `ev` 与桥旧代码用的 `type` 两种形态。
  async function reconcileUpdate(nodeId, env, targetVersion) {
    const deadline = Date.now() + UPDATE_RECONCILE_MS;
    while (Date.now() < deadline) {
      await sleep(3000);
      const st = await readStatus(nodeId, true);
      if (!st) continue;
      if (Array.isArray(st.lastEvents)) {
        for (const raw of st.lastEvents) {
          const ev = normalizeEvent(raw);
          if (!ev || !ev.fields || ev.fields.id !== env.id) continue;
          const name = ev.type;
          if (name === 'envelope-rejected') return { ok: false, reason: ev.fields.reason || '' };
          if (name === 'update-rejected' || name === 'update-launch-failed') {
            return { ok: false, reason: ev.fields.reason || name };
          }
        }
      }
      if (st.version === targetVersion) return { ok: true };
    }
    return { ok: false, reason: 'timeout' };
  }

  /* ---------- /lock/devices 专用读路径 ----------
     B-1 节点清单不再每请求实打（60s 新鲜期 + 旧值先出 + single-flight）；
     B-2 只对「缓存未命中/过期」的节点实读，非机主节点按 300s 长 TTL 不再每 10s 重读；
     B-3 并发 6、单台 1200ms、总预算 2400ms，超预算转后台回填；
     B-4 同账号并发请求合并（客户端实测同页 /lock/devices 连发/被取消 ×3）。
     契约不变：仍返回 200 {devices:[{id,name,owner,locked,component,version}]}。 */
  const devicesInflight = new Map(); // me -> { at, promise }
  const devicesMissAt = new Map(); // 【门二必修#2】读路径专用失败时刻表：离线台在 STATUS_MISS_TTL_MS 内不重复探活；写路径不经此处
  function missKey(me, id) { return String(me) + '|' + id; } // 【门二增量 N2】失败抑制按账号隔离，共享设备不跨账号串扰
  async function buildDevicesForUser(me, opts) {
    const force = !!(opts && opts.force);
    const t0 = Date.now();
    const nodes = await listNodesForRead();
    const cand = nodes.filter((n) => n && n._id);
    const found = new Map(); // _id -> device（保持服务端节点顺序）
    const pending = [];
    let missSuppressed = 0;
    for (const node of cand) {
      const e = statusCache.get(node._id);
      // X-14：?force=1 时跳过非机主缓存与失败抑制，实读一次（前端「重新加载」走这条路）。
      if (e && statusFresh(e, me) && !force) {
        if (isOwner(me, node, e.status)) found.set(node._id, deviceFromNode(node, e.status));
        else if (e.status) logOwnerMismatch(me, node, e.status);
      } else {
        const mAt = devicesMissAt.get(missKey(me, node._id));
        if (!force && mAt && (Date.now() - mAt) < STATUS_MISS_TTL_MS) {
          // 【门二必修#2】刚探活失败过：本轮跳过实读（探活成功前该台不下发，与「不猜机主」一致）
          missSuppressed++;
        } else {
          pending.push(node);
        }
      }
    }
    let budgetRemaining = 0;
    if (pending.length) {
      const budget = Math.max(400, READ_PATH_BUDGET_MS - (Date.now() - t0));
      budgetRemaining = await readStatusesBounded(pending, me, budget, found);
    }
    const devices = [];
    for (const node of cand) { const d = found.get(node._id); if (d) devices.push(d); }
    // X-13：超预算静默漏设备改为明示——partial＋pending，未实读的台数前端据此
    // 显示「正在确认其余设备状态…」并补拉一次，不得再悄悄少一台。
    const pendingCount = budgetRemaining + missSuppressed;
    return { devices, partial: pendingCount > 0, pending: pendingCount };
  }
  function listDevicesFor(me, opts) {
    const force = !!(opts && opts.force);
    if (force) { // force 请求不走同账号合并窗口，实读一次
      const rec = { at: Date.now(), promise: null };
      rec.promise = buildDevicesForUser(me, opts);
      devicesInflight.set(me, rec);
      rec.promise.then(() => { rec.at = Date.now(); }, () => { if (devicesInflight.get(me) === rec) devicesInflight.delete(me); });
      return rec.promise;
    }
    const cur = devicesInflight.get(me);
    if (cur && (Date.now() - cur.at) < DEVICES_DEDUPE_MS) return cur.promise;
    const rec = { at: Date.now(), promise: null };
    rec.promise = buildDevicesForUser(me, opts);
    devicesInflight.set(me, rec);
    rec.promise.then(() => { rec.at = Date.now(); }, () => { if (devicesInflight.get(me) === rec) devicesInflight.delete(me); });
    return rec.promise;
  }

  /* ---------- 路由 ---------- */
  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (!bridgeCfg) { fail(res, 503, ERR.notReady); return true; }
    const me = await authUser(req);
    if (!me) { fail(res, 401, ERR.login); return true; }
    // 封禁门（P5-010，DS 稿 §4.2）：authUser 只验凭证不问许可状态，此处补判定
    if (typeof deps.isBanLinked === 'function' && deps.isBanLinked(me)) {
      fail(res, 403, '账号已被封禁。');
      return true;
    }
    try {
      if (req.method === 'GET' && p === '/lock/devices') {
        // X-14：?force=1 跳过非机主缓存与失败抑制，实读一次（前端「重新加载」）。
        const force = u.searchParams.get('force') === '1';
        const out = await listDevicesFor(me, { force });
        sendJson(res, 200, { devices: out.devices, partial: !!out.partial, pending: out.pending || 0 });
        return true;
      }
      // W-16：站长侧 Owner 登记核对接口（只站长可用；deps.isSiteAdmin 未提供时一律拒绝）。
      // 装机后当场核对 -Owner 是否写对：输入 nodeid，返回组件登记的 ownerUsername
      // 原值与当前请求账号的比对结果。登记错的修复口径：被控机本地改 device.json
      // 的 OwnerUsername 后重启组件（组件侧文件路径与重启方式由组件线书面确认，
      // 本桥不猜路径）。离线/读不到 status 时回 503（unreachable），不得回 403。
      if (req.method === 'GET' && p === '/lock/owner-check') {
        const isAdmin = typeof deps.isSiteAdmin === 'function' ? deps.isSiteAdmin(me) : false;
        if (!isAdmin) { fail(res, 403, '仅站长可用。'); return true; }
        const id = u.searchParams.get('id') || '';
        if (!id) { fail(res, 400, ERR.badReq); return true; }
        let nodes = await listNodes();
        let node = nodes.find((n) => n && n._id === id);
        if (!node) {
          try { await refreshNodes(NODES_REFRESH_MS); } catch (e) {}
          nodes = nodeCache.nodes;
          node = nodes.find((n) => n && n._id === id);
        }
        if (!node) {
          if (!svc.ready) { fail(res, 503, ERR.unreachable); return true; }
          fail(res, 404, ERR.noDevice); return true;
        }
        const status = await readStatus(node._id, true);
        if (!status) { fail(res, 503, ERR.unreachable); return true; }
        const recorded = status.ownerUsername || '';
        const matches = recorded ? ownerNameMatches(me, recorded) : false;
        log('lock', 'owner-check：nodeid=' + node._id + ' 登记名哈希=' + ownerNameHash(recorded) + ' matches=' + matches);
        sendJson(res, 200, { ok: true, nodeId: node._id, name: node.name || '', recordedOwner: recorded || null, recordedOwnerHash: ownerNameHash(recorded), matches, reachable: true });
        return true;
      }
      if (req.method === 'POST' && (p === '/lock/enable' || p === '/lock/disable' || p === '/lock/reset' || p === '/lock/update')) {
        const body = await readJsonBody(req);
        if (!body || typeof body.id !== 'string') { fail(res, 400, ERR.badReq); return true; }
        const got = await getDeviceOrFail(res, body.id, me);
        if (!got) return true;
        const { node, status } = got;
        if (!status) { fail(res, 503, ERR.unreachable); return true; }
        if (status.state === 'Fault') { fail(res, 409, ERR.fault); return true; }

        if (p === '/lock/enable') {
          if (typeof body.password !== 'string' || body.password.length < 4 || body.password.length > 64) { fail(res, 400, ERR.badPw); return true; }
          if (status.state === 'Locked') { fail(res, 409, ERR.alreadyLocked); return true; }
          if (!status.devicePublicKey) { fail(res, 409, ERR.fault); return true; }
          const env = envelope.buildEnvelope(dispatcherKey, { op: 'arm', nodeId: node._id, by: me, password: body.password, devicePublicKeyPem: status.devicePublicKey });
          await deliverEnvelope(node._id, env);
          const r = await reconcile(node._id, env, (st) => st.state === 'Locked' && hasEvent(st, 'arm', (ev) => ev.fields && ev.fields.armId === env.id));
          if (!r.ok) { fail(res, r.reason === 'timeout' ? 504 : 409, r.reason === 'timeout' ? ERR.unreachable : ERR.rejected); return true; }
          log('lock', 'arm 成功：' + node.name + ' by ' + me);
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (p === '/lock/disable') {
          if (status.state !== 'Locked') { fail(res, 409, ERR.alreadyOff); return true; }
          const env = envelope.buildEnvelope(dispatcherKey, { op: 'disarm', nodeId: node._id, by: me });
          await deliverEnvelope(node._id, env);
          const since = Date.parse(env.issuedAt) - 5000;
          const r = await reconcile(node._id, env, (st) => st.state === 'Off' && hasEvent(st, 'disarm', (ev) => !ev.time || Date.parse(ev.time) >= since));
          if (!r.ok) { fail(res, r.reason === 'timeout' ? 504 : 409, r.reason === 'timeout' ? ERR.unreachable : ERR.rejected); return true; }
          log('lock', 'disarm 成功：' + node.name + ' by ' + me);
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (p === '/lock/update') {
          // 组件签名自更新（2.0.3 起）：信封带 {version,url,sha256}，
          // 组件端还会再验版本门/白名单/下载指纹，这里只做快速预检。
          const u = body.update || body;
          if (typeof u.version !== 'string' || typeof u.url !== 'string' ||
              typeof u.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(u.sha256) ||
              !envelope.allowedUpdateUrl(u.url)) { fail(res, 400, ERR.badUpdate); return true; }
          if (!status.version) { fail(res, 409, ERR.notReady); return true; }
          const cmp = envelope.compareVersions(u.version, status.version);
          if (cmp === null) { fail(res, 400, ERR.badUpdate); return true; }
          if (cmp <= 0) { fail(res, 409, ERR.notNewer); return true; }
          const env = envelope.buildEnvelope(dispatcherKey, { op: 'update', nodeId: node._id, by: me, update: { version: u.version, url: u.url, sha256: u.sha256 } });
          await deliverEnvelope(node._id, env);
          const r = await reconcileUpdate(node._id, env, u.version);
          if (!r.ok) {
            if (r.reason === 'unknown-op' || r.reason === 'bad-signature') { fail(res, 409, ERR.componentOld); return true; }
            if (r.reason === 'timeout') { fail(res, 504, ERR.updateTimeout); return true; }
            fail(res, 409, ERR.rejected); return true;
          }
          log('lock', 'update 成功：' + node.name + ' -> ' + u.version + ' by ' + me);
          sendJson(res, 200, { ok: true, version: u.version });
          return true;
        }
        // /lock/reset（恢复路径一：验登录密码后远程重置一次性密码，契约第 6 节）
        if (typeof body.loginPassword !== 'string' || !body.loginPassword) { fail(res, 400, ERR.badReq); return true; }
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 4 || body.newPassword.length > 64) { fail(res, 400, ERR.badPw); return true; }
        if (status.state !== 'Locked') { fail(res, 409, ERR.alreadyOff); return true; }
        // H28：锁内直接 429，不调 mcConnect（不消耗 MC 侧认证、不给重试留口）。
        const lk = resetPwLimiter.check(me);
        if (lk.locked) { fail(res, 429, ERR.tooManyAttempts); return true; }
        // H28（DS round 1）：同一账号同时只验一个密码——并发请求看到
        // 占位即 429，不多调一次 mcConnect（否则并发可绕过 5 次上限）。
        if (!resetPwLimiter.tryBegin(me)) { fail(res, 429, ERR.tooManyAttempts); return true; }
        let verified = false;
        try {
          const sess = await deps.mcConnect(cfg, me, body.loginPassword);
          verified = true;
          try { if (sess && sess.ws) sess.ws.close(); } catch (e) {}
        } catch (e) { verified = false; } finally { resetPwLimiter.end(me); }
        if (!verified) {
          const noted = resetPwLimiter.noteFail(me);
          log('lock', 'remote-reset 验密失败：' + node.name + ' by ' + me + '（累计 ' + noted.fails + ' 次' + (noted.locked ? '，已锁定 15 分钟' : '') + '）');
          fail(res, 403, ERR.badLoginPw); return true;
        }
        resetPwLimiter.clear(me); // 验密成功即清零
        if (!status.devicePublicKey) { fail(res, 409, ERR.fault); return true; }
        const env = envelope.buildEnvelope(dispatcherKey, { op: 'reset', nodeId: node._id, by: me, password: body.newPassword, devicePublicKeyPem: status.devicePublicKey });
        await deliverEnvelope(node._id, env);
        const r = await reconcile(node._id, env, (st) => st.state === 'Locked' && hasEvent(st, 'remote-reset', (ev) => ev.fields && ev.fields.id === env.id));
        if (!r.ok) { fail(res, r.reason === 'timeout' ? 504 : 409, r.reason === 'timeout' ? ERR.unreachable : ERR.rejected); return true; }
        log('lock', 'remote-reset 成功：' + node.name + ' by ' + me);
        sendJson(res, 200, { ok: true });
        return true;
      }
      fail(res, 404, '接口不存在。');
      return true;
    } catch (e) {
      log('lock', '处理异常：' + (e && e.message));
      if (!res.headersSent) fail(res, 503, ERR.unreachable);
      return true;
    }
  }

  loadOwnerAliases(true);
  if (bridgeCfg) svcConnect();
  // 按用户清 xid 桥缓存（ext ban-purge 联动调用；DS 稿 §4.3）
  function purgeUser(username) {
    const target = String(username || '').trim().toLowerCase();
    if (!target) return 0;
    let n = 0;
    for (const [k, v] of xidCache) {
      if (v && String(v.user || '').trim().toLowerCase() === target) { xidCache.delete(k); n += 1; }
    }
    return n;
  }

  return { handle, purgeUser };
}

module.exports = { createLockBridge, _test: { eventName, eventTime, normalizeEvent, findRejectedEvent, hasEvent, STATUS_TTL_NONOWNER_MS, READ_PATH_BUDGET_MS, createResetPwLimiter, RESET_PW_MAX_FAILS, RESET_PW_WINDOW_MS, RESET_PW_LOCK_MS } };
