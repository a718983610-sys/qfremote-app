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
 *       pkg3 #6（M-C 中组）：status.json 本身完全信任被控机文件，机主与公钥
 *       另有服务端 pin（createDevicePinStore）：机主 pin 失配判非机主，
 *       公钥 pin 失配时 arm/reset 拒绝把一次性密码加密给未 pin 的公钥。
 * 投递：调度 Ed25519 签名信封 → 经投递服务账号 qf-locksvc 的 control 通道
 *       用 runcommands 把信封写进设备 inbox → 触发 qf-lockctl apply →
 *       轮询 status.json 对账（30 秒超时）。status 读取同样走 runcommands+Base64 回传。
 *       （本机部署的 meshrelay 文件通道实测无法配对，证据见交接记录；
 *         信封格式/签名/对账语义与契约完全一致，仅字节搬运通道不同。）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let WebSocket;
try { WebSocket = require('/opt/meshcentral/node_modules/ws'); } catch (e) { WebSocket = require('ws'); }
const envelope = require('./lock-envelope');
// C 线（定夺 §4.2／§4.3／§4.4）：服务端锁状态机、对账、幂等与操作挑战，见 CONTRACT.md。
const lockState = require('./lock-state');

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
  challengeRequired: '请先打开确认窗口再提交关闭操作（缺少操作确认信息）。',
  challengeInvalid: '操作确认信息无效或已被使用，请重新打开确认窗口。',
  challengeExpired: '操作确认信息已过期（5 分钟），请重新打开确认窗口。',
  challengeMismatch: '操作确认信息与本次操作不符，请重新打开确认窗口。',
  revisionStale: '设备状态已变化，请重新打开确认窗口核对后再提交。',
  stateConflict: '这台电脑的锁状态存在冲突，须先完成状态恢复再操作。',
  stepUpRequired: '本次解锁风险较高，请重新输入登录密码完成验证后再试。',
  agentGrantInvalid: 'AI 代理解锁授权无效或已过期，请由设备所有者重新签发授权。',
  repairNotAvailable: '受控修复发布路径尚未启用，锁组件更新仍处于暂停中。',
};
const RECONCILE_MS = 30000;
const UPDATE_RECONCILE_MS = 240000; // 下载+替换+重启服务+回滚余量
const STATUS_TTL_MS = 15000;              // 机主设备状态展示缓存（原 10s；只用于 GET /lock/devices 读路径）
const STATUS_TTL_NONOWNER_MS = 60000;     // 非机主判定缓存（2.4.5：300s→60s）：只用于「过滤掉别人的设备」，永不下发；
// 旧 300s 时刚授权/刚改名后 5 分钟内仍判非机主，60s 后变化即生效；过滤仍省读。
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
// P3-05 R-3（契约 §5）：disable 等待谓词与 classifyDeviceStatus 同口径——
// disarm 事件优先按 lockId 匹配（本次锁记录的 lock_id），不命中才回落时间
// 窗口（事件时间 ≥ disarm 信封签发时间 - 5s）；无 lockId 也无可解析时间
// 的事件一律不放行。旧谓词只用时间窗口且 `!ev.time` 使无时间戳事件也放
// 行，旧 disarm 事件可能放行新 disarm。
// lockId 为空（无服务端记录的基线情形）时只走时间窗口。
function disarmWaitPredicate(lockId, since) {
  return (st) => st.state === 'Off' && hasEvent(st, 'disarm', (ev) => {
    if (ev.fields && lockId && (ev.fields.lockId === lockId || ev.fields.id === lockId)) return true;
    const t = eventTime(ev);
    return !!t && Date.parse(t) >= since;
  });
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

/* ---------- 设备 pin：机主＋公钥指纹服务端 pin（pkg3 #6，M-C 中组） ----------
   问题：机主判定与 devicePublicKey 完全信任被控机 status.json——本机
   SYSTEM/管理员改 ownerUsername 可伪造机主、换 devicePublicKey 可让一次
   性密码加密给攻击者公钥（DS-REVIEW §3.3 #6）。
   两层 pin（查哪层都以指纹比对，不存公钥原文）：
   ① 运维 pin 表（权威，优先于首次所见）：/opt/qfremote-lock/device-pins.json，
      与 owner-alias.json 同款运维维护格式——
        { "pins": { "<nodeId>": { "owner": "<账号现名>",
                                  "publicKeySha256": "<指纹 hex 64 位>" } } }
      文件缺失＝无运维 pin（常态降级）；内容损坏＝保留上次好表＋日志，绝不抛错。
      owner / publicKeySha256 可只填其一（只 pin 填了的那项）；运维在装机后
      以 /lock/owner-check 核对登记名、用 status.json 的 devicePublicKey
      算指纹填表（指纹算法见 fingerprintPublicKey）。
   ② 首次所见 pin（TOFU，进程内）：首个带齐机主＋公钥的 fresh status 到达即
      记下，之后同一台 status 与 pin 不符即拒绝。固有限制：装机前已被控的
      机器 pin 到的就是攻击值——运维 pin 可覆盖纠正，组件重装换钥后须重启
      服务端（清 TOFU）或以运维 pin 重新登记。
   判定语义（check 返回 state）：
     ok ＝与 pin 一致；no-pin ＝无 pin（本次已 TOFU 记下，或 status 缺字段）；
     owner-mismatch / key-mismatch ＝与 pin 不符。
   强制点：机主 pin 失配 → isOwner 判非机主（读写路径都挡）；公钥 pin 失配
   → arm/reset 加密前 409 拒绝（绝不加密给未 pin 的公钥），读路径只记日志
   不挡列表（避免组件重装换钥后设备直接消失）。 */
function fingerprintPublicKey(pem) {
  if (typeof pem !== 'string' || !pem.trim()) return null;
  return crypto.createHash('sha256').update(pem.replace(/\s+/g, '')).digest('hex');
}
function foldPinName(s) { return typeof s === 'string' ? s.trim().toLowerCase() : ''; }
function createDevicePinStore(opts) {
  const o = opts || {};
  const pinPath = o.pinPath || '/opt/qfremote-lock/device-pins.json';
  const readFile = o.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const statFile = o.statFile || ((p) => fs.statSync(p));
  // ownerMatches(recorded, owner)：status 登记名是否属于 pin 的机主。
  // 默认 fold 相等；桥内传入别名感知版（现名直认或曾用名别名）。
  const ownerMatches = o.ownerMatches || ((recorded, owner) => foldPinName(recorded) === foldPinName(owner));
  const logFn = o.log || (() => {});
  const nowFn = typeof o.now === 'function' ? o.now : Date.now; // 可注入时钟（单测控 mtime 窗口）
  const OPS_RELOAD_MS = 30000;
  let opsPins = new Map(); // nodeId -> { owner, publicKeySha256 }
  let opsMtimeMs = -1;
  let opsLastCheck = 0;
  const seen = new Map(); // TOFU：nodeId -> { owner, publicKeySha256 }
  function loadOpsPins(force) {
    const now = nowFn();
    if (!force && (now - opsLastCheck) < OPS_RELOAD_MS) return;
    opsLastCheck = now;
    let st;
    try { st = statFile(pinPath); } catch (e) {
      if (opsMtimeMs !== -1) { opsPins = new Map(); opsMtimeMs = -1; }
      return;
    }
    if (!force && opsMtimeMs === st.mtimeMs) return;
    try {
      const raw = JSON.parse(readFile(pinPath));
      const src = (raw && typeof raw === 'object' && raw.pins && typeof raw.pins === 'object' && !Array.isArray(raw.pins)) ? raw.pins : raw;
      const next = new Map();
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        for (const nodeId of Object.keys(src)) {
          const p = src[nodeId];
          if (!p || typeof p !== 'object') continue;
          const owner = foldPinName(p.owner);
          const fp = typeof p.publicKeySha256 === 'string' ? p.publicKeySha256.trim().toLowerCase() : '';
          if (!owner && !/^[0-9a-f]{64}$/.test(fp)) continue;
          next.set(String(nodeId), { owner, publicKeySha256: /^[0-9a-f]{64}$/.test(fp) ? fp : '' });
        }
      }
      opsPins = next;
      opsMtimeMs = st.mtimeMs;
    } catch (e) {
      logFn('device-pins-bad', '设备 pin 表读取失败（保留上次好表继续服务）：' + (e && e.message));
    }
  }
  function pinOf(nodeId) { loadOpsPins(false); return opsPins.get(String(nodeId)) || seen.get(String(nodeId)) || null; }
  function check(nodeId, status) {
    if (!status || typeof status !== 'object') return { state: 'no-pin' };
    const pin = pinOf(nodeId);
    const owner = typeof status.ownerUsername === 'string' ? status.ownerUsername : '';
    const fp = fingerprintPublicKey(status.devicePublicKey);
    if (!pin) {
      if (owner && fp) {
        seen.set(String(nodeId), { owner: foldPinName(owner), publicKeySha256: fp });
        // 首次 pin 必须留痕，不得静默信任（DS #6 复审 round 1）：TOFU 的固有
        // 边界是装机前已被控的机器 pin 到的就是攻击值，服务端无法仅凭首见
        // 区分合法装机与首次伪造——首次登记记一条审计日志（机主哈希＋指纹
        // 前 12 位，不记明文），运维凭 /lock/owner-check 核对，发现不对即
        // 以运维 pin 表覆盖纠正；pin 建立后的一切伪造（换机主／换钥）一律拒绝。
        logFn('device-pin-first', '设备 pin 首次登记（TOFU）：node=' + String(nodeId)
          + ' 机主哈希=' + crypto.createHash('sha256').update(foldPinName(owner)).digest('hex').slice(0, 16)
          + ' 公钥指纹=' + fp.slice(0, 12) + '…（首次所见信任，运维 pin 可覆盖）');
      }
      return { state: 'no-pin' };
    }
    if (owner && pin.owner && !ownerMatches(owner, pin.owner)) return { state: 'owner-mismatch' };
    if (fp && pin.publicKeySha256 && fp !== pin.publicKeySha256) return { state: 'key-mismatch' };
    return { state: 'ok' };
  }
  return { check, loadOpsPins, fingerprintPublicKey };
}

// pkg3 #10（低，L-C）：从 runcommands 回包里提取 status.json 的 Base64。
// PS_READ_STATUS 只输出 status.json 的 Base64，但回包可能夹杂 PowerShell
// 警告/错误文本；旧写法先去全部空白再取首个 ≥80 字符的 Base64 串——
// 去空白会把相邻词拼成假长串，首个命中也可能是警告里的串，解码失败
// 即整读判空。现改为逐个候选验证：先按空白切 token（整 token 全 Base64
// 字符、尾部最多两个 =、长度≥80 且为 4 的倍数），再把去空白后的整串
// 当作候选（兜住传输中被折行的真 Base64）；每个候选都解码＋JSON.parse，
// 只采信解出 {state:string} 的那一个，全都不中即返回 null（不猜）。
function extractStatusPayload(out) {
  const text = String(out || '');
  const candidates = [];
  for (const tok of text.split(/\s+/)) { if (tok) candidates.push(tok); }
  const stripped = text.replace(/\s+/g, '');
  const merged = stripped.match(/[A-Za-z0-9+/=]{80,}/g);
  if (merged) for (const s of merged) { if (candidates.indexOf(s) === -1) candidates.push(s); }
  for (const cand of candidates) {
    if (cand.length < 80 || cand.length % 4 !== 0) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cand)) continue;
    let parsed = null;
    try { parsed = JSON.parse(Buffer.from(cand, 'base64').toString('utf8')); } catch (e) { continue; }
    if (parsed && typeof parsed.state === 'string') return parsed;
  }
  return null;
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

  /* ---------- C 线：锁状态机／对账／幂等／操作挑战（定夺 §4.2／§4.3／§4.4） ----------
     recordStore：锁记录（lock_id／revision／desired／actual／心跳／审计），
       默认落盘到 friends stateFile 同级 lock-records.json（服务可写目录，
       原子 tmp＋rename）；deps.lockRecordsPath 可注入（单测传临时路径，
       传 null 即纯内存）。load 失败只记日志、不中断服务。
     challengeStore：短期操作挑战（5 分钟、单次、绑定账号＋设备＋操作）。
     opStore：成功结果幂等缓存（24h）；失败不缓存，同一 operationId 可重试。
     unlockAuthLimiter：/lock/disable 短时重新认证（登录密码）的独立限流表，
       与 reset 限流分开记，避免两路互相锁死。 */
  const lockRecordsPath = deps.lockRecordsPath !== undefined
    ? deps.lockRecordsPath
    : (cfg && cfg.stateFile ? path.join(path.dirname(cfg.stateFile), 'lock-records.json') : '/opt/qfremote-lock/lock-records.json');
  const lockRecordStore = lockState.createLockRecordStore({
    filePath: lockRecordsPath,
    log: (tag, msg) => log('lock', msg),
  });
  lockRecordStore.load();
  const challengeStore = lockState.createChallengeStore();
  const opStore = lockState.createOperationStore();
  const unlockAuthLimiter = createResetPwLimiter();
  // P3-03：增强保护（用户自选，运维文件登记；缺省关闭）与 AI 代理解锁
  // 独立授权（内存表，服务重启即失效—— fail-closed，见 lock-state.js）。
  const enhancedAuthStore = lockState.createEnhancedAuthStore({
    filePath: deps.enhancedAuthPath || '/opt/qfremote-lock/enhanced-auth.json',
    log: (tag, msg) => log('lock', msg),
  });
  const agentGrantStore = lockState.createAgentGrantStore();

  // 读路径对账（确认式）：只有拿到新鲜设备 status 才并入记录；读不到（null）
  // 不动记录（不因一次瞬时失败把 LOCKED 翻成 UNKNOWN，避免轮询抖动冲掉
  // 进行中的确认弹窗 revision）。写路径超时翻 UNKNOWN 由各写分支显式做。
  // 返回 {record}（无记录且有 status 时以设备自报建基线并落盘）。
  function reconcileFromRead(nodeId, status) {
    if (!status) return { record: lockRecordStore.get(nodeId) };
    const prev = lockRecordStore.get(nodeId);
    const r = lockState.reconcileRecord(prev, status, { device_id: nodeId });
    if (r.changed || !prev) lockRecordStore.upsert(r.record);
    return { record: r.record, decision: r.decision, reason: r.reason };
  }
  // 写路径对账：写操作对账窗口内读不到设备 → 记录翻 UNKNOWN（不判 UNLOCKED）。
  function markRecordUnknown(nodeId, reason) {
    const prev = lockRecordStore.get(nodeId);
    if (!prev || prev.actual_state === 'UNKNOWN') return prev;
    const r = lockState.transition(prev, 'UNKNOWN', { action: 'write-path:unreachable', reason: reason || 'timeout' });
    if (!r.ok) return prev;
    return lockRecordStore.upsert(r.record);
  }

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

  // pkg3 #6：设备 pin（机主＋公钥指纹服务端 pin，见模块顶 createDevicePinStore）。
  // ownerMatches 语义：status 登记名属于 pin 的机主（现名直认或曾用名别名）。
  // pin 表路径可由 deps.devicePinPath 注入（单测用临时路径）；缺省运维表。
  const devicePinStore = createDevicePinStore({
    pinPath: deps.devicePinPath || '/opt/qfremote-lock/device-pins.json',
    ownerMatches: (recorded, owner) => ownerNameMatches(owner, recorded),
    log: (tag, msg) => log('lock', msg),
  });

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
      status = extractStatusPayload(out);
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
  // 缓存是否对「本请求者」仍然有效：机主设备 15s（展示用），非机主 60s（仅过滤用），
  // 读不到 5s（尽快重试）。因此归属判定的最长陈旧窗口＝15s（机主）/60s（非机主）。
  function statusFresh(entry, me) {
    if (!entry) return false;
    let ttl;
    if (!entry.status) ttl = STATUS_MISS_TTL_MS;
    else if (entry.status.ownerUsername && ownerNameMatches(me, entry.status.ownerUsername)) ttl = STATUS_TTL_MS;
    else ttl = STATUS_TTL_NONOWNER_MS;
    return (Date.now() - entry.at) < ttl;
  }
  // 下发结构（字段名/顺序/含义严格照契约，与改造前逐字一致；C 线新增
  // lockState/lockId/revision/lastHeartbeat/degraded 五字段，旧客户端忽略即兼容）。
  // locked 仍为布尔快照（actual_state==='LOCKED'），权威状态以 lockState 为准。
  function deviceFromNode(node, status, record) {
    const lockStateValue = record ? record.actual_state : lockState.mapLegacyState(status ? status.state : null);
    return {
      id: node._id,
      name: node.name || '',
      owner: true,
      locked: lockStateValue === 'LOCKED',
      lockState: lockStateValue,
      lockId: record ? record.lock_id : null,
      revision: record ? record.revision : 0,
      lastHeartbeat: record ? record.last_heartbeat : null,
      degraded: record ? (record.degraded || null) : null,
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
          if (!released && isOwner(me, node, st)) {
            const rec = reconcileFromRead(node._id, st).record;
            found.set(node._id, deviceFromNode(node, st, rec));
          }
          if (done === nodes.length) release();
        }
      };
      const n = Math.min(READ_PATH_CONCURRENCY, nodes.length);
      for (let i = 0; i < n; i++) worker();
    });
  }

  async function deliverEnvelope(nodeId, env) {
    // P3-01 第二道拦截（GPT 三项定夺 §1）：即使某条未来代码路径绕过了 HTTP
    // 层的暂停守卫，arm/update 信封也到不了设备。disable/reset 不受影响。
    // 抛错后由 handle 外层 catch 转 503，不产生任何安装副作用。
    if (env && (env.op === 'arm' || env.op === 'update') && lockState.isLockRemediationPaused()) {
      throw new Error('lock-remediation-paused');
    }
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
  // P3-03 会话指纹（GPT 三项定夺 §3.3）：操作挑战绑定“已认证会话”。
  // 取请求 Cookie 头的 SHA-256（只存哈希、只比哈希，绝不记原文）：
  // qfr_frd 会话签发／退出登录／xid 变化都会改变指纹，旧挑战即失效。
  // 鉴权层只返回账号名、无独立会话 id，指纹是本层可用的最强会话绑定。
  function sessionKeyForRequest(req) {
    const raw = (req && req.headers && typeof req.headers.cookie === 'string') ? req.headers.cookie : '';
    return crypto.createHash('sha256').update(raw).digest('hex');
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
  // pkg3 #6：机主 pin 失配 → 判非机主（读写路径都挡）；公钥 pin 失配 → 读路径
  // 只记日志（加密使用点另有 409 硬挡），不让组件换钥直接抹掉设备列表。
  function isOwner(me, node, status) {
    if (!(status && status.ownerUsername && ownerNameMatches(me, status.ownerUsername))) return false;
    const pin = devicePinStore.check(node._id, status);
    if (pin.state === 'owner-mismatch') {
      logThrottled('pin-owner-mismatch-' + node._id,
        'lock 设备 pin 失配（机主）：node=' + node._id + ' 登记名与服务端 pin 不符，已判非机主。', 60000);
      return false;
    }
    if (pin.state === 'key-mismatch') {
      logThrottled('pin-key-mismatch-' + node._id,
        'lock 设备 pin 失配（公钥）：node=' + node._id + ' devicePublicKey 指纹与服务端 pin 不符，arm/reset 将拒绝加密。', 60000);
    }
    return true;
  }

  /* ---------- HTTP 小工具 ---------- */
  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
  function fail(res, code, text) { sendJson(res, code, { error: text }); }
  // C 线：带机器可读 code 的失败（新路径用；旧路径保持只含 error 的原格式）。
  function failCode(res, code, text, errCode) { sendJson(res, code, { error: text, code: errCode }); }
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
     B-2 只对「缓存未命中/过期」的节点实读，非机主节点按 60s TTL 不再每 10s 重读；
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
        if (isOwner(me, node, e.status)) {
          const rec = reconcileFromRead(node._id, e.status).record;
          found.set(node._id, deviceFromNode(node, e.status, rec));
        } else if (e.status) logOwnerMismatch(me, node, e.status);
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
        // pkg3 #6：顺带回 pin 状态，供运维核对／登记 pin 表（ok / no-pin /
        // owner-mismatch / key-mismatch），不含公钥原文与指纹。
        const pinState = devicePinStore.check(node._id, status).state;
        log('lock', 'owner-check：nodeid=' + node._id + ' 登记名哈希=' + ownerNameHash(recorded) + ' matches=' + matches + ' pin=' + pinState);
        sendJson(res, 200, { ok: true, nodeId: node._id, name: node.name || '', recordedOwner: recorded || null, recordedOwnerHash: ownerNameHash(recorded), matches, pin: pinState, reachable: true });
        return true;
      }
      // C 线 · GET /lock/challenge?id=&op=disarm（定夺 §4.4）：
      // 签发短期操作挑战：5 分钟有效、单次、绑定请求账号＋设备＋操作。
      // 挑战本身不是重新认证（见 /lock/disable 的 loginPassword 路径），
      // 它提供新鲜性＋防重放：确认弹窗打开时取一次，提交时随操作编号、
      // revision 一并校验。签发值只回给本次请求的机主，日志不记其值。
      if (req.method === 'GET' && p === '/lock/challenge') {
        const id = u.searchParams.get('id') || '';
        const op = u.searchParams.get('op') || '';
        if (!id || op !== 'disarm') { fail(res, 400, ERR.badReq); return true; }
        const got = await getDeviceOrFail(res, id, me);
        if (!got) return true;
        // P3-03：挑战绑定锁实例＋状态版本＋操作编号＋已认证会话。
        // 先经 reconcileFromRead 建／取服务端锁记录（读路径同款，无新副作用），
        // 再签发；opId 由确认弹窗在打开时生成并随取挑战请求带来（不带则不绑
        // 定该字段，旧客户端兼容）。签发值只回给本次请求的机主，日志不记其值。
        const opIdParam = u.searchParams.get('opId') || '';
        const recForChallenge = reconcileFromRead(got.node._id, got.status).record;
        const issued = challengeStore.issue({
          account: me, deviceId: got.node._id, op,
          lockId: recForChallenge ? recForChallenge.lock_id : null,
          revision: recForChallenge ? recForChallenge.revision : 0,
          operationId: opIdParam || null,
          sessionKey: sessionKeyForRequest(req),
        });
        if (!issued) { fail(res, 503, ERR.notReady); return true; }
        log('lock', '操作挑战已签发：' + got.node.name + ' by ' + me + '（op=' + op + '，5 分钟有效）');
        sendJson(res, 200, { ok: true, challenge: issued.challenge, expiresAt: issued.expiresAt, op, deviceId: got.node._id, lockId: recForChallenge ? recForChallenge.lock_id : null, revision: recForChallenge ? recForChallenge.revision : 0 });
        return true;
      }
      // P3-01 暂停审计（GPT 三项定夺 §1.2：统一错误标识＋结构化审计）。
      // 只记日志，不放行、不改判；拒绝本身仍由下方阶段 1 四行守卫（enable）
      // 与新增 update 守卫执行。顺序在鉴权＋封禁之后：未登录先 401，
      // 不因暂停机制向未授权请求泄露设备存在与否。
      if (req.method === 'POST' && (p === '/lock/enable' || p === '/lock/update')) {
        log('lock', 'lock-remediation-paused op=' + p + ' account=' + me + ' code=lock-remediation-paused');
      }
      // LOCK-P0 pause (2026-11-19, GPT lock-bug ruling s1.1): new privacy-lock activations paused for maintenance.
      // Only /lock/enable is stopped; /lock/disable, /lock/reset, /lock/devices and normal remote control are unaffected.
      // Rollback: delete this block, then restart qfremote-friends.service.
      if (req.method === 'POST' && p === '/lock/enable') { fail(res, 503, '隐私锁功能正在维护，暂时无法开启新的锁定。已锁定的设备仍可正常关闭。'); return true; }
      // P3-01：/lock/update 与 /lock/enable 同步冻结（GPT 三项定夺 §1，同款语义）。
      // 无白名单例外：站长账号、API 调用者一律拒绝；只读诊断、紧急停止、
      // 受控安全恢复不受影响（它们不走本分支）；受控修复走独立的
      // /lock/repair 占位，绝不经此放开通用 /lock/update。
      if (req.method === 'POST' && p === '/lock/update') { failCode(res, 503, '隐私锁组件更新正在维护暂停，暂时无法更新锁组件。已锁定的设备仍可正常关闭。', 'lock-remediation-paused'); return true; }
      // P3-01 受控修复发布路径占位（GPT 三项定夺 §1.3）：只留接口，不实现放行逻辑。
      // 正式路径须另行实现组件签名、版本与哈希核验、严格授权、审计、回滚方案与
      // 目标设备范围；未启用前一律 503，绝不经此放开通用 /lock/update。
      if (req.method === 'POST' && p === '/lock/repair') {
        log('lock', 'lock-repair-not-available account=' + me + ' code=lock-repair-not-available');
        failCode(res, 503, ERR.repairNotAvailable, 'lock-repair-not-available'); return true;
      }
      // P3-03 AI 代理解锁独立授权（GPT 三项定夺 §3.3）：签发与撤销只认设备所有者本人。
      // 授权单设备、仅 disarm、15 分钟内单次有效、可撤销；grantId 是凭证，
      // 日志只记设备与账号，绝不记 grantId 原文。
      if (req.method === 'POST' && p === '/lock/agent-grant') {
        const grantBody = await readJsonBody(req);
        if (!grantBody || typeof grantBody.id !== 'string') { fail(res, 400, ERR.badReq); return true; }
        const got = await getDeviceOrFail(res, grantBody.id, me);
        if (!got) return true;
        const g = agentGrantStore.issue({ account: me, deviceId: got.node._id, op: 'disarm', by: me });
        if (!g) { fail(res, 503, ERR.notReady); return true; }
        log('lock', 'agent-grant 已签发：' + got.node.name + ' by ' + me + '（单次、15 分钟有效，仅 disarm）');
        sendJson(res, 200, { ok: true, grantId: g.grantId, deviceId: got.node._id, op: 'disarm', expiresAt: g.expiresAt });
        return true;
      }
      if (req.method === 'POST' && p === '/lock/agent-grant/revoke') {
        const revokeBody = await readJsonBody(req);
        const gid = revokeBody && typeof revokeBody.grantId === 'string' ? revokeBody.grantId : '';
        const revoked = gid ? agentGrantStore.revokeForCaller(gid, me) : false;
        if (revoked) log('lock', 'agent-grant 已撤销：account=' + me);
        sendJson(res, 200, { ok: true, revoked: !!revoked });
        return true;
      }
      if (req.method === 'POST' && (p === '/lock/enable' || p === '/lock/disable' || p === '/lock/reset' || p === '/lock/update')) {
        const body = await readJsonBody(req);
        if (!body || typeof body.id !== 'string') { fail(res, 400, ERR.badReq); return true; }
        // C 线 · /lock/disable 提交前校验（定夺 §4.4，顺序有讲究）：
        // ① 幂等重放先查（不耗挑战、不碰设备）：同一 operationId 的成功结果
        //    直接返回，不产生第二次真实解锁；
        // ② 操作挑战校验（单次、5 分钟、绑定账号＋设备＋disarm）：验过即消费，
        //    缺挑战／过期／错绑一律拒绝，旧客户端的裸 disable 到此为止；
        // ③ 设备实读与机主核对（getDeviceOrFail）之后再做 revision 校验与
        //    可选的登录密码重新认证（见 disable 分支）。
        // 失败不缓存 operationId：超时／拒绝后同一编号可重试真操作（须取新挑战）。
        let disableOpId = null;
        let agentGrantUsed = false; // P3-03：本请求是否出示并验过 AI 代理解锁授权（供成功审计用）
        if (p === '/lock/disable') {
          if (typeof body.operationId !== 'string' || !body.operationId) {
            failCode(res, 409, ERR.challengeRequired, 'operation-required'); return true;
          }
          disableOpId = body.operationId;
          const replayed = opStore.lookup(disableOpId);
          if (replayed) {
            log('lock', 'disarm 幂等重放：op=' + disableOpId + ' by ' + me + '（返回首次成功结果，未再次操作设备）');
            sendJson(res, 200, Object.assign({ ok: true, replayed: true }, replayed));
            return true;
          }
          if (typeof body.challenge !== 'string' || !body.challenge) {
            failCode(res, 409, ERR.challengeRequired, 'challenge-required'); return true;
          }
          // P3-03：挑战全绑定校验（账号＋设备＋操作＋锁实例＋revision＋操作编号
          // ＋已认证会话；revision 不一致单独映射为 revision-stale，前端刷新快照）。
          // 校验在设备读取之前：记录只读内存表，无设备副作用；绑定失败不消费挑战。
          const rec0pre = lockRecordStore.get(body.id);
          const chk = challengeStore.verify({
            challenge: body.challenge, account: me, deviceId: body.id, op: 'disarm',
            lockId: rec0pre ? rec0pre.lock_id : null,
            revision: rec0pre ? rec0pre.revision : 0,
            operationId: disableOpId, sessionKey: sessionKeyForRequest(req),
          });
          if (!chk.ok) {
            const text = chk.reason === 'challenge-expired' ? ERR.challengeExpired
              : chk.reason === 'challenge-revision-mismatch' ? ERR.revisionStale
              : chk.reason === 'challenge-binding-mismatch' ? ERR.challengeMismatch
              : ERR.challengeInvalid;
            const code = chk.reason === 'challenge-revision-mismatch' ? 'revision-stale' : chk.reason;
            failCode(res, 409, text, code); return true;
          }
          // P3-03：AI 代理解锁独立授权——出示时须另验（单次、15 分钟、单设备、
          // 仅 disarm）；不出示走正常用户路径。授权验过即消费，失败不继续。
          if (typeof body.agentGrantId === 'string' && body.agentGrantId) {
            const g = agentGrantStore.verify({ grantId: body.agentGrantId, account: me, deviceId: body.id, op: 'disarm' });
            if (!g.ok) { failCode(res, 409, ERR.agentGrantInvalid, g.reason || 'agent-grant-invalid'); return true; }
            agentGrantUsed = true;
          }
        }
        const got = await getDeviceOrFail(res, body.id, me);
        if (!got) return true;
        const { node, status } = got;
        if (!status) { fail(res, 503, ERR.unreachable); return true; }
        if (status.state === 'Fault') { fail(res, 409, ERR.fault); return true; }

        if (p === '/lock/enable') {
          if (typeof body.password !== 'string' || body.password.length < 4 || body.password.length > 64) { fail(res, 400, ERR.badPw); return true; }
          if (status.state === 'Locked') { fail(res, 409, ERR.alreadyLocked); return true; }
          if (!status.devicePublicKey) { fail(res, 409, ERR.fault); return true; }
          // pkg3 #6：公钥 pin 失配时绝不把一次性密码加密给未 pin 的公钥。
          if (devicePinStore.check(node._id, status).state === 'key-mismatch') { fail(res, 409, ERR.fault); return true; }
          const env = envelope.buildEnvelope(dispatcherKey, { op: 'arm', nodeId: node._id, by: me, password: body.password, devicePublicKeyPem: status.devicePublicKey });
          await deliverEnvelope(node._id, env);
          const r = await reconcile(node._id, env, (st) => st.state === 'Locked' && hasEvent(st, 'arm', (ev) => ev.fields && ev.fields.armId === env.id));
          if (!r.ok) {
            if (r.reason === 'timeout') markRecordUnknown(node._id, 'arm-timeout');
            fail(res, r.reason === 'timeout' ? 504 : 409, r.reason === 'timeout' ? ERR.unreachable : ERR.rejected); return true;
          }
          log('lock', 'arm 成功：' + node.name + ' by ' + me);
          // C 线：arm 成功即建／更新锁记录（lock_id＝本次信封 id，供后续
          // disarm 事件对账；暂停期内本分支到不了，只在解除暂停后生效）。
          try {
            const stAfter = await readStatus(node._id, true);
            let rec = lockRecordStore.get(node._id);
            if (!rec) {
              rec = lockState.createLockRecord({
                device_id: node._id, lock_id: env.id,
                boot_id: stAfter ? stAfter.boot_id : null,
                session_id: stAfter ? stAfter.session_id : null,
                sid: stAfter ? stAfter.sid : null,
                desired_state: 'LOCKED', actual_state: 'LOCKING',
              });
            } else {
              rec = Object.assign({}, rec, { lock_id: env.id, desired_state: 'LOCKED' });
            }
            const fin = lockState.reconcileRecord(rec, stAfter, { op_id: env.id, by: me });
            lockRecordStore.upsert(fin.record);
          } catch (e) { /* 记录落盘失败不影响已确认的 arm 结果，只记日志 */ log('lock', 'arm 记录落盘失败：' + node.name + '（' + (e && e.message) + '）'); }
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (p === '/lock/disable') {
          // revision 校验：提交前弹窗冻结的 revision 须与服务端当前一致，
          // 否则说明期间状态变过（他处解锁／重置／对账翻转），拒绝并让前端重取。
          const rec0 = lockRecordStore.get(node._id);
          if (typeof body.revision !== 'number') { fail(res, 400, ERR.badReq); return true; }
          if (rec0 && body.revision !== rec0.revision) {
            failCode(res, 409, ERR.revisionStale, 'revision-stale'); return true;
          }
          // P3-03 分级重新认证（GPT 三项定夺 §3.2／§3.3）：风险分级在 revision
          // 校验之后、密码验密之前判定。
          //   normal：会话＋挑战＋操作编号＋revision 四重校验即可，免重复输密码；
          //   enhanced（用户自选增强保护）／high（锁记录 UNKNOWN／RECOVERY_REQUIRED
          //   等）：必须完成登录密码升级认证，否则拒绝，绝不降级为普通确认。
          //   特别：UNKNOWN 记录不许经正常路径直接清状态——重新认证只证明
          //   操作者身份，不证明设备实际锁状态；放行仍须设备侧强证据对账。
          const risk = lockState.classifyUnlockRisk({ record: rec0, enhancedProtection: enhancedAuthStore.isEnhanced(me) });
          const hasLoginPw = typeof body.loginPassword === 'string' && body.loginPassword;
          if (risk.requiresStepUp && !hasLoginPw) {
            log('lock', 'disarm 升级认证缺失：' + node.name + ' by ' + me + '（risk=' + risk.level + '，reasons=' + risk.reasons.join(',') + '）');
            failCode(res, 403, ERR.stepUpRequired, 'step-up-required'); return true;
          }
          // 可选的短时重新认证（定夺 §4.4“敏感解锁建议增加短时重新认证”）：
          // 前端确认弹窗提供登录密码栏；填了就验（走 mcConnect 真登录，
          // 独立限流 5 次／15 分钟），不填则走“会话＋挑战＋操作编号＋revision”
          // 四重校验。验密失败记限流、不消耗挑战之外的任何东西。
          if (hasLoginPw) {
            const lk = unlockAuthLimiter.check(me);
            if (lk.locked) { fail(res, 429, ERR.tooManyAttempts); return true; }
            if (!unlockAuthLimiter.tryBegin(me)) { fail(res, 429, ERR.tooManyAttempts); return true; }
            let verified = false;
            try {
              const sess = await deps.mcConnect(cfg, me, body.loginPassword);
              verified = true;
              try { if (sess && sess.ws) sess.ws.close(); } catch (e) {}
            } catch (e) { verified = false; } finally { unlockAuthLimiter.end(me); }
            if (!verified) {
              const noted = unlockAuthLimiter.noteFail(me);
              log('lock', 'disarm 重新认证失败：' + node.name + ' by ' + me + '（累计 ' + noted.fails + ' 次' + (noted.locked ? '，已锁定 15 分钟' : '') + '）');
              fail(res, 403, ERR.badLoginPw); return true;
            }
            unlockAuthLimiter.clear(me);
          }
          // 设备已报 Off：以对账结论为准，不把它当作新的设备故障——
          // 强证据（disarm 事件／重启）→ 幂等成功；无证明 → 状态冲突 409。
          if (status.state !== 'Locked') {
            const r0 = lockState.reconcileRecord(rec0, status, { op_id: disableOpId, by: me });
            if (r0.record) lockRecordStore.upsert(r0.record);
            if (r0.decision === 'to-unlocked' && r0.evidence === 'strong') {
              const out = { lockState: 'UNLOCKED', revision: r0.record.revision, alreadyUnlocked: true };
              opStore.store(disableOpId, out);
              log('lock', 'disarm 幂等：设备已确认解锁（' + r0.reason + '），op=' + disableOpId + ' by ' + me + '（risk=' + risk.level + '，agentGrant=' + (agentGrantUsed ? 'yes' : 'no') + '）');
              sendJson(res, 200, Object.assign({ ok: true }, out));
              return true;
            }
            if (r0.decision === 'to-recovery' || r0.decision === 'revision-conflict') {
              failCode(res, 409, ERR.stateConflict, 'state-conflict'); return true;
            }
            fail(res, 409, ERR.alreadyOff); return true;
          }
          // 记录意图：LOCKED→UNLOCKING（desired UNLOCKED），审计带操作编号。
          let rec = rec0;
          if (!rec) {
            rec = lockState.reconcileRecord(null, status, { device_id: node._id }).record;
            rec = Object.assign({}, rec, { lock_id: rec.lock_id, desired_state: 'UNLOCKED' });
            lockRecordStore.upsert(rec);
          }
          const going = lockState.transition(rec, 'UNLOCKING', {
            op_id: disableOpId, by: me, action: 'disarm:start', reason: 'user-disable', desired_state: 'UNLOCKED',
          });
          if (going.ok) { rec = lockRecordStore.upsert(going.record); }
          const env = envelope.buildEnvelope(dispatcherKey, { op: 'disarm', nodeId: node._id, by: me });
          await deliverEnvelope(node._id, env);
          const since = Date.parse(env.issuedAt) - 5000;
          // P3-05 R-3：等待谓词与 classifyDeviceStatus 同口径（lockId 优先，
          // 见 disarmWaitPredicate）；旧谓词只用时间窗口、无时间戳也放行。
          const r = await reconcile(node._id, env, disarmWaitPredicate(rec.lock_id, since));
          if (!r.ok) {
            if (r.reason === 'timeout') {
              // 写路径超时：记录翻 UNKNOWN（不判 UNLOCKED），操作编号不缓存、可重试。
              markRecordUnknown(node._id, 'disarm-timeout');
              fail(res, 504, ERR.unreachable); return true;
            }
            const rej = lockState.transition(lockRecordStore.get(node._id) || rec, 'RECOVERY_REQUIRED', {
              op_id: disableOpId, by: me, action: 'disarm:rejected', reason: r.reason || 'rejected',
            });
            if (rej.ok) lockRecordStore.upsert(rej.record);
            fail(res, 409, ERR.rejected); return true;
          }
          // 对账已证明设备 Off＋disarm 事件：记录落 UNLOCKED（两步审计），缓存成功结果。
          const cur = lockRecordStore.get(node._id) || rec;
          const fin = lockState.applyCorrection(cur, {
            op_id: disableOpId, by: me, to_state: 'UNLOCKED',
            reason: 'disarm-reconciled:' + env.id, evidence: 'strong',
          });
          const finalRec = fin.ok ? lockRecordStore.upsert(fin.record) : cur;
          const out = { lockState: 'UNLOCKED', revision: finalRec.revision };
          opStore.store(disableOpId, out);
          log('lock', 'disarm 成功：' + node.name + ' by ' + me + '（op=' + disableOpId + '，risk=' + risk.level + '，stepUp=' + (hasLoginPw ? 'yes' : 'no') + '，agentGrant=' + (agentGrantUsed ? 'yes' : 'no') + '）');
          sendJson(res, 200, Object.assign({ ok: true }, out));
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
        // pkg3 #6：公钥 pin 失配时绝不把一次性密码加密给未 pin 的公钥。
        if (devicePinStore.check(node._id, status).state === 'key-mismatch') { fail(res, 409, ERR.fault); return true; }
        const env = envelope.buildEnvelope(dispatcherKey, { op: 'reset', nodeId: node._id, by: me, password: body.newPassword, devicePublicKeyPem: status.devicePublicKey });
        await deliverEnvelope(node._id, env);
        const r = await reconcile(node._id, env, (st) => st.state === 'Locked' && hasEvent(st, 'remote-reset', (ev) => ev.fields && ev.fields.id === env.id));
        if (!r.ok) { fail(res, r.reason === 'timeout' ? 504 : 409, r.reason === 'timeout' ? ERR.unreachable : ERR.rejected); return true; }
        log('lock', 'remote-reset 成功：' + node.name + ' by ' + me);
        // C 线：密码已换，状态仍为 LOCKED；只加审计＋revision+1，让进行中的
        // 关闭确认弹窗重新校验（旧 revision 即失效）。
        try {
          const rec = lockRecordStore.get(node._id);
          if (rec) lockRecordStore.upsert(lockState.appendAudit(rec, { op_id: env.id, by: me, action: 'remote-reset', reason: 'password-rotated' }));
        } catch (e) { log('lock', 'reset 记录审计失败：' + node.name + '（' + (e && e.message) + '）'); }
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
    // P3-03：会话撤销／封禁联动／退出登录时，未使用的操作挑战与 AI 解锁授权
    // 必须立即失效（GPT 三项定夺 §3.3）。已缓存的成功操作结果不吊销：
    // 它只能原样返回首次成功结果，不产生新的真实操作，且重放仍须先过鉴权。
    const chRevoked = challengeStore.revokeForAccount(target);
    const grRevoked = agentGrantStore.revokeForAccount(target);
    if (chRevoked || grRevoked) log('lock', 'purgeUser 已吊销未用挑战 ' + chRevoked + ' 个、AI 解锁授权 ' + grRevoked + ' 个：' + target);
    return n;
  }

  return { handle, purgeUser, _stores: { challengeStore, opStore, lockRecordStore, agentGrantStore } };
}

module.exports = { createLockBridge, _test: { eventName, eventTime, normalizeEvent, findRejectedEvent, hasEvent, disarmWaitPredicate, extractStatusPayload, STATUS_TTL_NONOWNER_MS, READ_PATH_BUDGET_MS, createResetPwLimiter, RESET_PW_MAX_FAILS, RESET_PW_WINDOW_MS, RESET_PW_LOCK_MS, createDevicePinStore, fingerprintPublicKey, LOCK_PAUSE_CODE: lockState.LOCK_REMEDIATION_PAUSE.code, isLockRemediationPaused: lockState.isLockRemediationPaused } };
