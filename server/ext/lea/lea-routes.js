'use strict';
/*
 * LEA 服务端 HTTP 路由 · Stage 1 MVP（DESIGN §8.1）
 * ============================================================
 * 挂在 qfremote-ext（server/ext/server.js）内，只加路由注册行，
 * 不改既有逻辑。本模块不直接读 server.js 的内部函数——
 * 会话校验/密码核验/站长判定由 server.js 以 deps 注入：
 *   deps.sendJson(res, code, obj) / deps.readJsonBody(req, maxBytes)
 *   deps.log(obj)
 *   deps.verifyPassword(username, password) -> Promise<boolean>
 *     （二次确认：重新输入账号密码；MFA 若启用，另见 verifyMfa）
 *   deps.verifyMfa(username, code) -> Promise<boolean>（可选；仅 Key
 *     管理入口的 passwordConfirm 在注入时调用。恢复票据签发不走此处，
 *     改走下方 deps.mfa 全员强制 MFA 门，见 emergency_stop 节）
 *   deps.mfa —— MFA 核心（mfa-core.createMfaCore）：恢复票据签发
 *     的全员强制 MFA 门（GPT 2026-11-18 裁决 §三）。未注入时恢复票据
 *     签发 fail-closed（503 MFA_UNAVAILABLE），绝不降级为只凭密码。
 *     方法：getFactorStatus / beginEnrollment / confirmEnrollment /
 *     verifyCode / createVerification / consumeVerification /
 *     reportLost / resolveCase / getCase / listOpenCases。
 *   deps.resolveConsoleAuth(req) -> Promise<{user, siteadmin}|null>
 *     （控制台会话校验，复用 validateConsoleCookie）
 *   deps.isSiteAdmin(auth) -> boolean（复用 isAdmin）
 *   deps.listVisibleDeviceIds(auth, req) -> Promise<[deviceId]>（强制；D2：
 *     H05 换绑与 login-attestation 的节点可见性校验，返回该账号在
 *     MeshCentral 可见的设备 id 清单。未注入／查询失败／返回异常时对应
 *     接口一律 503 QFR_VISIBILITY_UNAVAILABLE，不得放行；清单取回成功
 *     但不含该设备时按“确认不可见”回 403。server.js 以控制台会话
 *     cookie 查 MeshCentral nodes（auth.user 的账号视角），不得用请求体
 *     自报的设备列表。）
 * deps 缺失时对应接口 fail-closed（503/401），绝不放行。
 *
 * 路由（DESIGN §8.1）：
 *   POST /api/lea/v1/execute            单条命令
 *   POST /api/lea/v1/batches            批量
 *   GET  /api/lea/v1/jobs/{job_id}      查长任务
 *   POST /api/lea/v1/jobs/{job_id}/cancel 取消任务
 *   GET  /api/lea/v1/devices/{device_id}/status 查设备状态
 *   GET  /api/lea/v1/devices/{device_id}/revocations 查本机吊销表应有快照（H21）
 *   POST /api/lea/v1/keys               生成 Key（控制台会话＋密码二次确认）
 *   GET  /api/lea/v1/keys               列表（只显 key_id/前缀/时间/状态）
 *   POST /api/lea/v1/keys/{key_id}/revoke 吊销单个
 *   POST /api/lea/v1/keys/revoke-all    一键吊销全部
 *   POST /api/lea/v1/grants             站长授予/撤销 muse.execute
 *   POST /api/lea/v1/devices/{device_id}/rebind 换绑（触发旧 Key 失效）
 *   POST /api/lea/v1/devices/{device_id}/deregister 卸载注销（设备签名；删绑定＋节点记录，Key 不动）
 * C1 自助绑定（桌面一键链接本机助手）：
 *   POST /api/lea/v1/self-bind/issue    签发一次性绑定票据（控制台会话）
 *   POST /api/lea/v1/self-bind/complete USH 持票据＋设备签名换 Key（明文仅本次返回）
 *   GET  /api/lea/v1/self-bind/status   轮询绑定状态（控制台会话，不含凭据）
 *   POST /api/lea/v1/login-attestation  签发登录证明（控制台会话；v3 P0-4 第二层，供客户端随 session.login_changed 发给本机 QFRLEA 验签）
 *   POST /api/lea/v1/self-bind/renew    设备续期（Bearer Key＋设备签名）
 *   POST /api/lea/v1/self-bind/revoke/{key_id} 吊销自助 Key（控制台会话，无密码）
 *   POST /api/lea/v1/self-bind/revoke-all 吊销全部自助 Key（控制台会话，无密码）
 * RC-04 断线重连票据（server/ext/lea/RC-04-RECONNECT-TICKET-SPEC.md）：
 *   POST /api/lea/v1/reconnect/issue  签发重连票据（Bearer Key 或控制台会话；
 *     200 直接返回票据 JSON 全文，不包 ok 壳——L3 按顶层 10 字段校验）
 *   POST /api/lea/v1/reconnect/resume 票据恢复（body 即票据 JSON 全文，不走
 *     Bearer；成功 200 返回 { ok, session_id, device_id, binding_epoch,
 *     grant_epoch }；握手重建在下一次业务下发时由 ensureHandshake 做，
 *     本端点不下发 sys.handshake，见 RC-04 (d)）
 * 崩溃上报接收（server/ext/lea/CRASH-REPORT-SPEC.md）：
 *   POST /api/lea/v1/crash-report 接收 Windows 端崩溃报告（匿名接收＋
 *     强防护：形状白名单＋200KB 上限＋每 IP 限流＋落盘封顶轮转；
 *     报告只含技术信息，无鉴权要求——上传发生在下次启动，用户未必已登录）
 * emergency_stop（GPT 2026-11-18 裁决问题 1、3、六节）：
 *   POST /api/lea/v1/emergency-stop/sync 同步停控事件（控制台会话＋
 *     设备归属校验；服务端记录停控＋按 device_scope 逐个吊销该设备
 *     全部 Key，返回服务端签名回执供 LEA 验签后改 sync_status）
 *   POST /api/lea/v1/emergency-stop/recovery-ticket 签发专用恢复票据
 *     （控制台会话＋密码二次确认＋全员强制 MFA，GPT 2026-11-18 裁决
 *     §三；未启用 MFA 拒绝直接签发并给安全注册路径；新注册 MFA 有
 *     24 小时冷静期；MFA 丢失走专门恢复流程；MFA 验证与本次请求绑定、
 *     5 分钟内有效；票据明文只本次返回，recovery_epoch 由服务端铸造；
 *     恢复流程两步：①新绑定票据＋新 Key 激活绑定（停控保留），②凭票据
 *     发 emergency_stop.recover 信封；下发时路由层记票据
 *     consumed_pending_clear，设备回 recovered 时改记 recovered＋清
 *     服务端停控记录）
 *   MFA 注册与恢复（同上裁决 §三）：
 *   POST /api/lea/v1/mfa/enroll/begin   开始注册（控制台会话＋密码二次确认）
 *   POST /api/lea/v1/mfa/enroll/confirm 确认注册（凭 TOTP 码证明持有；成功后进冷静期）
 *   POST /api/lea/v1/mfa/verify         验证第二因素，签发 5 分钟内有效的单次验证记录
 *   POST /api/lea/v1/mfa/status         查询本账号 MFA 状态与待处理恢复案件
 *   POST /api/lea/v1/mfa/report-lost    挂失 MFA 因素＋立案（不降低为只输入密码）
 *   POST /api/lea/v1/mfa/recovery/resolve 站长审批恢复案件（仅站长）
 */
const crypto = require('crypto');
const { bareNodeId, nodeMatchesId } = require('./lea-channel');

const BODY_LIMIT = 1024 * 1024; // 执行请求体上限 1MB（信封 params 含文本时用）
// S-089：批量步数上限 50→20（单批 50 步串行下发最坏占设备 400 秒，
// 20 步≈160 秒仍宽裕；超限仍 400，见 handleBatches）。
const MAX_BATCH_STEPS = 20;
// S-089：批量总执行时间上限 10 分钟（步循环顶检查，超时即停、job 记
// UNKNOWN，调用方凭幂等键重试未完成步）；截图结果累计上限 20MB。
const BATCH_MAX_WALL_MS = 10 * 60 * 1000;
const BATCH_SNAPSHOT_BUDGET_BYTES = 20 * 1024 * 1024;
// H06 补：危险 scope 常量（与 lea-core.js 同值；此前 handleCreateKey 引用
// 未定义的 DANGEROUS_SCOPE，生成 Key 的路由一律 500）。
const DANGEROUS_SCOPE = 'muse.execute.dangerous';

function createLeaRoutes(core, channel, deps) {
  deps = deps || {};
  const sendJson = deps.sendJson;
  const readJsonBody = deps.readJsonBody;
  const log = typeof deps.log === 'function' ? deps.log : function () {};
  const ERR = core.ERR;

  function fail(res, status, code, msg) {
    return sendJson(res, status, { ok: false, code, msg: msg || code });
  }
  function requestIdOf(req) {
    const h = req.headers && (req.headers['x-qfr-request-id'] || req.headers['X-QFR-Request-Id']);
    return (typeof h === 'string' && h) ? h : 'req_' + crypto.randomBytes(8).toString('hex');
  }
  // S-091：可信反代层注入的真实 IP（崩溃端点 N-02 修法；与 server.js
  // clientIpFromReq 同口径：socket 须为回环才信任何代理头）。
  // 信任链：ext 服务只听回环，唯一入口是本机 nginx；nginx 经
  // $proxy_add_x_forwarded_for 追加直连方 IP，Cloudflare 边缘追加真实
  // 客户端 IP 并以 CF-Connecting-IP 透传（边缘会覆写该头，客户端自带
  // 的伪造值到边缘即被替换，到不了这里）。
  // 取值顺序：
  //   ① CF-Connecting-IP（合法 IP 才认）；② XFF 自末段起第一个非回环
  //   段——nginx 追加的是 127.0.0.1，倒数第二个非回环段即边缘所见的
  //   真实 IP，攻击者自带的首段伪造值天然被跳过；③ socket IP。
  // 非回环直连（无可信反代在路径上）一律用 socket IP，XFF 全忽略。
  function isLoopbackIp(ip) {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }
  function normalizeIp(ip) {
    if (typeof ip !== 'string') return null;
    const v = ip.trim().replace(/^::ffff:/, '');
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((n) => Number(n) <= 255)) return v;
    if (/^[0-9a-fA-F:]+$/.test(v) && v.includes(':')) return v.toLowerCase();
    return null;
  }
  function trustedClientIp(req) {
    const headers = req.headers || {};
    const remoteRaw = (req.socket && req.socket.remoteAddress) || '';
    const remote = normalizeIp(remoteRaw);
    if (!isLoopbackIp(remoteRaw) && !isLoopbackIp(remote || '')) {
      // 直连（无可信反代）：只信 socket，不认任何代理头。
      return remote || null;
    }
    const cf = normalizeIp(headers['cf-connecting-ip'] || headers['CF-Connecting-IP']);
    if (cf && !isLoopbackIp(cf)) return cf;
    const xff = headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) {
      const segs = xff.split(',').map((s) => normalizeIp(s)).filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        if (!isLoopbackIp(segs[i])) return segs[i];
      }
    }
    return remote || null;
  }
  function clientIp(req) { return trustedClientIp(req); }
  function auditCall(fields) { try { core.audit('lea-call', fields); } catch (e) {} }

  // S-089：LEA 执行限流（按 account / key / device / command class 分别计，
  // 固定分钟窗口，内存计数，重启清零——与崩溃限流同款语义）。
  // command class 取 COMMANDS tier：0 系统（sys.*）、1 普通、2 危险。
  // 额度（每分钟）：execute：account 120、key 60、device 120、IP 300；
  // device 须 ≥ key（单 Key 本就绑单设备，device 额低于 key 额会使
  // key 额永不可达）；危险类另设更低额度 account 10、key 5；
  // batches：account 60、key 30（批量单次可含 20 步，30 次/分钟/Key
  // 已是 600 步/分钟的硬顶；套件内同一 Key 短时十余次 batches 属
  // 正常回归密度，不得误拦）。
  // 设备并发由核心层 B1 在途名额管（每设备 8 条，超限 503 QUEUE_FULL），
  // 路由层不再叠加第二套并发计数。
  const LEA_RATE = {
    EXEC_ACCOUNT_MIN: 120, EXEC_KEY_MIN: 60, EXEC_DEVICE_MIN: 120, EXEC_IP_MIN: 300,
    EXEC_DANGEROUS_ACCOUNT_MIN: 10, EXEC_DANGEROUS_KEY_MIN: 5,
    BATCH_ACCOUNT_MIN: 60, BATCH_KEY_MIN: 30,
  };
  const leaRateBuckets = new Map(); // bucketKey -> { windowStart, count }
  function leaRateCheck(bucketKey, limit, windowMs) {
    const nowMs = Date.now();
    const windowStart = nowMs - (nowMs % windowMs);
    let rec = leaRateBuckets.get(bucketKey);
    if (!rec || rec.windowStart !== windowStart) { rec = { windowStart, count: 0 }; leaRateBuckets.set(bucketKey, rec); }
    if (rec.count >= limit) {
      return { ok: false, retryAfter: Math.ceil((windowStart + windowMs - nowMs) / 1000) };
    }
    rec.count += 1;
    return { ok: true };
  }
  function leaRateCheckExecute(o) {
    // 顺序：先查最细的 key，再 account、device、IP；任一超限即 429。
    const checks = [
      ['key:' + o.keyId, o.dangerous ? LEA_RATE.EXEC_DANGEROUS_KEY_MIN : LEA_RATE.EXEC_KEY_MIN],
      ['account:' + o.accountId, o.dangerous ? LEA_RATE.EXEC_DANGEROUS_ACCOUNT_MIN : LEA_RATE.EXEC_ACCOUNT_MIN],
      ['device:' + o.deviceId, LEA_RATE.EXEC_DEVICE_MIN],
      ['ip:' + (o.ip || 'unknown'), LEA_RATE.EXEC_IP_MIN],
    ];
    for (const [bk, limit] of checks) {
      const r = leaRateCheck('exec:' + bk, limit, 60000);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  function leaRateCheckBatch(o) {
    for (const [bk, limit] of [
      ['key:' + o.keyId, LEA_RATE.BATCH_KEY_MIN],
      ['account:' + o.accountId, LEA_RATE.BATCH_ACCOUNT_MIN],
    ]) {
      const r = leaRateCheck('batch:' + bk, limit, 60000);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  function rateLimited(res, retryAfter, msg) {
    try { if (res && typeof res.setHeader === 'function') res.setHeader('Retry-After', String(retryAfter)); } catch (e) {}
    return fail(res, 429, 'QFR_RATE_LIMITED', msg || '请求过于频繁，请稍后再试。');
  }

  // ---- 崩溃上报限流（内存计数，单 Node 进程；重启即清零，属可接受的
  // 限流语义——fail-closed 只作用于校验与存储，不作用于限流计数） ----
  // 每 IP 5 份/小时、20 份/天；全局 1000 份/天。超限 429＋Retry-After。
  // S-091：全局额度只计通过校验的请求——非法请求（400）走独立桶
  // （每 IP 20 份/小时，不计全局），此前“先计限流、后校验”可被伪造
  // XFF 定向耗尽他人额度、约 50 个伪造 IP 耗尽全局额度。
  // L-05：日切时清旧条目；Map 超 10000 条时删最旧（防只增不减慢涨）。
  const CRASH_RATE_HOUR = 5, CRASH_RATE_DAY = 20, CRASH_RATE_GLOBAL_DAY = 1000;
  const CRASH_INVALID_RATE_HOUR = 20;
  const crashRate = { perIp: new Map(), invalidPerIp: new Map(), globalDayStart: 0, globalDayCount: 0 };
  function crashRateDayRollover(dayStart) {
    if (crashRate.globalDayStart !== dayStart) {
      crashRate.globalDayStart = dayStart; crashRate.globalDayCount = 0;
      crashRate.perIp.clear(); crashRate.invalidPerIp.clear();
    }
  }
  function crashRatePruneMap(map) {
    if (map.size > 10000) {
      for (const k of map.keys()) { map.delete(k); if (map.size <= 10000) break; }
    }
  }
  function crashRateCheckValid(ip) {
    const nowMs = Date.now();
    const hourStart = nowMs - (nowMs % 3600000);
    const dayStart = nowMs - (nowMs % 86400000);
    crashRateDayRollover(dayStart);
    if (crashRate.globalDayCount >= CRASH_RATE_GLOBAL_DAY) return { ok: false, retryAfter: Math.ceil((dayStart + 86400000 - nowMs) / 1000) };
    let rec = crashRate.perIp.get(ip);
    if (!rec || rec.dayStart !== dayStart) rec = { hourStart, hourCount: 0, dayStart, dayCount: 0 };
    if (rec.hourStart !== hourStart) { rec.hourStart = hourStart; rec.hourCount = 0; }
    if (rec.hourCount >= CRASH_RATE_HOUR || rec.dayCount >= CRASH_RATE_DAY) {
      return { ok: false, retryAfter: Math.ceil((hourStart + 3600000 - nowMs) / 1000) };
    }
    rec.hourCount += 1; rec.dayCount += 1;
    crashRate.perIp.set(ip, rec);
    crashRate.globalDayCount += 1;
    crashRatePruneMap(crashRate.perIp);
    return { ok: true };
  }
  function crashInvalidCheck(ip) {
    const nowMs = Date.now();
    const hourStart = nowMs - (nowMs % 3600000);
    const dayStart = nowMs - (nowMs % 86400000);
    crashRateDayRollover(dayStart);
    let rec = crashRate.invalidPerIp.get(ip);
    if (!rec || rec.hourStart !== hourStart) { rec = { hourStart, hourCount: 0 }; crashRate.invalidPerIp.set(ip, rec); }
    if (rec.hourCount >= CRASH_INVALID_RATE_HOUR) {
      return { ok: false, retryAfter: Math.ceil((hourStart + 3600000 - nowMs) / 1000) };
    }
    rec.hourCount += 1;
    crashRatePruneMap(crashRate.invalidPerIp);
    return { ok: true };
  }

  // ---- 崩溃上报接收（匿名＋强防护，见 CRASH-REPORT-SPEC.md） ----
  // 不要求鉴权：上传发生在下次启动，用户未必已登录；报告只含技术信息。
  // 失败语义 fail-closed：校验失败 400、超 200KB 413、Content-Type
  // 不对 415、限流 429、存储满／写失败 503；未落盘＋未审计前绝不回 2xx。
  // 响应只回稳定错误码＋request_id，不回显请求体／堆栈／字段值。
  async function handleCrashReport(req, res) {
    const requestId = requestIdOf(req);
    const ip = clientIp(req);
    const headers = req.headers || {};
    const ct = headers['content-type'] || headers['Content-Type'] || '';
    if (typeof ct !== 'string' || !/^application\/json\s*(;|$)/i.test(ct)) {
      return fail(res, 415, 'QFR_CRASH_UNSUPPORTED_MEDIA', 'Content-Type 须为 application/json。');
    }
    const body = await readJsonBody(req, core.CRASH_BODY_MAX_BYTES);
    if (body && body.__tooLarge) return fail(res, 413, 'QFR_CRASH_TOO_LARGE', '请求体超过 200KB 上限。');
    if (body && Buffer.byteLength(JSON.stringify(body), 'utf8') > core.CRASH_BODY_MAX_BYTES) {
      return fail(res, 413, 'QFR_CRASH_TOO_LARGE', '请求体超过 200KB 上限。');
    }
    // S-091：先校验、后计有效桶——全局 1000/天只计通过校验的请求，
    // 非法请求走独立桶（见下），不再能定向耗尽他人／全局额度。
    const vErr = core.validateCrashReport(body);
    if (vErr) {
      const inv = crashInvalidCheck(ip || 'unknown');
      if (!inv.ok) {
        try { if (res && typeof res.setHeader === 'function') res.setHeader('Retry-After', String(inv.retryAfter)); } catch (e) {}
        try { core.audit('lea-crash-report', { request_id: requestId, ip, result: 'rate-limited' }); } catch (e) {}
        return fail(res, 429, 'QFR_RATE_LIMITED', '崩溃上报过于频繁，请稍后再试。');
      }
      try { core.audit('lea-crash-report', { request_id: requestId, ip, result: 'validation-failed' }); } catch (e) {}
      return fail(res, 400, ERR.VALIDATION, vErr);
    }
    const rl = crashRateCheckValid(ip || 'unknown');
    if (!rl.ok) {
      try { if (res && typeof res.setHeader === 'function') res.setHeader('Retry-After', String(rl.retryAfter)); } catch (e) {}
      try { core.audit('lea-crash-report', { request_id: requestId, ip, result: 'rate-limited' }); } catch (e) {}
      return fail(res, 429, 'QFR_RATE_LIMITED', '崩溃上报过于频繁，请稍后再试。');
    }
    let out;
    try {
      out = core.storeCrashReport(body);
    } catch (e) {
      if (e && e.code === 'QFR_CRASH_STORAGE_FULL') {
        try { core.audit('lea-crash-report', { request_id: requestId, ip, result: 'storage-full' }); } catch (e2) {}
        return fail(res, 503, 'QFR_CRASH_STORAGE_FULL', '服务端崩溃报告存储已满，请稍后再试。');
      }
      try { core.audit('lea-crash-report', { request_id: requestId, ip, result: 'storage-error' }); } catch (e2) {}
      return fail(res, 503, 'QFR_CRASH_STORAGE_ERROR', '服务端暂存崩溃报告失败。');
    }
    const bytes = out.duplicate ? 0 : (Buffer.byteLength(JSON.stringify(body), 'utf8'));
    // L-08：审计先于 200 返回；审计写失败回 503（报告已落盘，客户端
    // 重试将按去重回 200，不丢数据）。此前审计失败只记日志、仍回 200。
    let audited = null;
    try { audited = core.audit('lea-crash-report', { request_id: requestId, ip, report_id: body.report_id, bytes, result: out.duplicate ? 'duplicate' : 'stored' }); } catch (e) { audited = null; }
    if (!audited) {
      return fail(res, 503, 'QFR_CRASH_AUDIT_FAILED', '服务端审计写入失败，请稍后重试。');
    }
    return sendJson(res, 200, { ok: true, report_id: body.report_id, stored: !out.duplicate, duplicate: !!out.duplicate });
  }

  // ---- Bearer 认证（共用） ----
  function bearerAuth(req) {
    const a = core.authenticate(req.headers || {});
    if (!a.ok) return a;
    return a;
  }

  // ---- 单条执行 ----
  async function handleExecute(req, res) {
    const requestId = requestIdOf(req);
    const auth = bearerAuth(req);
    if (!auth.ok) {
      auditCall({ request_id: requestId, result: 'denied', error_code: auth.code, ip: clientIp(req) });
      return fail(res, auth.status, auth.code, auth.msg);
    }
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    const deviceId = String(body.device_id || '');
    const command = String(body.command || '');
    // params 须为 JSON 对象：数组／标量不得签出（C 端只接受对象 params_raw）。
    if (body.params != null && (typeof body.params !== 'object' || Array.isArray(body.params))) return fail(res, 400, ERR.VALIDATION, 'params 须为 JSON 对象。');
    const params = (body.params && typeof body.params === 'object') ? body.params : {};
    const idemKey = String(req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || body.idempotency_key || '');
    if (!deviceId || !command) return fail(res, 400, ERR.VALIDATION, '缺少 device_id 或 command。');
    if (!idemKey) return fail(res, 400, ERR.VALIDATION, '缺少 Idempotency-Key（每条命令必须带幂等键）。');
    // 幂等键须合 token 规则（C 端解析层同规则拒绝）：否则签出的信封到 LEA 即被拒。
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idemKey)) return fail(res, 400, ERR.VALIDATION, 'Idempotency-Key 须为 8..128 位 [A-Za-z0-9_-]。');
    // request_id（请求头或自动生成）须合 token 规则，否则 buildEnvelope 抛错变 500。
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) return fail(res, 400, ERR.VALIDATION, 'X-QFR-Request-Id 须为 8..128 位 [A-Za-z0-9_-]。');
    const spec = core.COMMANDS[command];
    if (!spec) return fail(res, 400, ERR.VALIDATION, '未知命令：' + command);
    const key = auth.key;
    const baseAudit = {
      trace_id: requestId, request_id: requestId, account_id: key.account_id,
      device_id: deviceId, api_key_id: key.key_id, key_prefix: core.maskKey(key.prefix),
      binding_epoch: key.binding_epoch, command, idempotency_key: idemKey, ip: clientIp(req),
    };
    // S-089：执行限流（account/key/device/命令类分别计；危险类更低额度），
    // 位置在准入之前、鉴权与基本校验之后；超限 429＋Retry-After。
    const execRl = leaRateCheckExecute({ accountId: key.account_id, keyId: key.key_id, deviceId, ip: clientIp(req), dangerous: !!spec.dangerous });
    if (!execRl.ok) {
      auditCall(Object.assign({}, baseAudit, { result: 'rate-limited', error_code: 'QFR_RATE_LIMITED' }));
      return rateLimited(res, execRl.retryAfter, 'LEA 执行过于频繁，请稍后再试。');
    }
    // timeout_ms 显式存在但非法（null、非数字、非整数、<1、>上限）即 400，
    // 不得 clamp 成合法值再签名（规范 §2.2）；缺失时取命令默认值。
    // 显式存在判定用 !== undefined：null 是显式非法值，不是缺失。
    // FIX1：校验前移到幂等检查之前——请求指纹含有效超时，须先定超时再算指纹。
    let timeoutMs = spec.timeoutMs;
    if (body.timeout_ms !== undefined) {
      if (typeof body.timeout_ms !== 'number' || !Number.isInteger(body.timeout_ms) || body.timeout_ms < 1 || body.timeout_ms > spec.maxTimeoutMs) {
        return fail(res, 400, ERR.VALIDATION, 'timeout_ms 须为 1..' + spec.maxTimeoutMs + ' 的整数。');
      }
      timeoutMs = body.timeout_ms;
    }
    // FIX1：幂等键绑定不可变请求指纹——键＋指纹共同决定复用。
    // 请求指纹 = sha256({ command, params, timeout_ms })：任一变即另一请求。
    const reqFp = crypto.createHash('sha256').update(JSON.stringify({ command, params, timeout_ms: timeoutMs })).digest('hex');
    // 幂等：已完成返回缓存结果不重复执行；执行中返回 DUPLICATE_IN_PROGRESS。
    const prev = core.idemLookup(key.account_id, key.key_id, idemKey, core.IDEM_NS.EXEC);
    if (prev && prev.status === 'RUNNING') return fail(res, 409, ERR.DUPLICATE, '同一幂等键的命令正在执行中。');
    if (prev && (prev.status === 'SUCCEEDED' || prev.status === 'FAILED')) {
      // 指纹不一致（同键换命令／换 params／换超时）或旧记录无指纹（FIX1 前落盘，
      // 无法核对）→ 拒绝复用旧结果，不执行、不回旧成功。
      if (!prev.req_fp || prev.req_fp !== reqFp) {
        return fail(res, 409, ERR.IDEMPOTENT_MISMATCH, '同一幂等键已绑定另一请求内容，拒绝复用旧结果；请换新幂等键重发。');
      }
      return sendJson(res, 200, Object.assign({ ok: prev.status === 'SUCCEEDED', duplicate: true, request_id: requestId }, prev.result || {}));
    }
    // FIX1：危险操作 UNKNOWN 不自动重试——上次结果未知时不得凭同键重发；
    // 须先用 job_id 查询或快照确认，确认后换新幂等键重发。
    if (prev && prev.status === 'UNKNOWN' && spec.dangerous) {
      return fail(res, 409, ERR.UNKNOWN, '危险操作上次执行结果未知，禁止自动重试；请先用 job_id 查询或快照确认，确认后换新幂等键重发。');
    }
    // 准入七项校验（服务端先拦）
    const adm = core.admit({ key, deviceId, command, requestId, ip: clientIp(req) });
    if (!adm.ok) {
      auditCall(Object.assign({}, baseAudit, { result: 'denied', error_code: adm.code }));
      return fail(res, adm.status, adm.code, adm.msg);
    }
    // ① 设备在线（通道 nodes 的 conn 位；通道不可达 → fail-closed 503）
    let online = null;
    try { online = channel ? await channel.nodeOnline(deviceId) : null; } catch (e) { online = null; }
    if (online === false) {
      auditCall(Object.assign({}, baseAudit, { result: 'denied', error_code: ERR.NOT_INSTALLED }));
      return fail(res, 503, ERR.NOT_INSTALLED, '设备未安装 LEA 或不在线。');
    }
    if (online === null) {
      auditCall(Object.assign({}, baseAudit, { result: 'denied', error_code: ERR.NOT_INSTALLED }));
      return fail(res, 503, ERR.NOT_INSTALLED, '下发通道暂时不可达，无法确认设备在线。');
    }
    // （timeout_ms 校验已在幂等检查前完成，见上；此处直接用已定值 timeoutMs。）
    const job = core.createJob({
      account_id: key.account_id, device_id: deviceId, api_key_id: key.key_id,
      command, request_id: requestId, idempotency_key: idemKey, status: 'RUNNING',
    });
    core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'RUNNING', job_id: job.job_id, dangerous: spec.dangerous, req_fp: reqFp }, core.IDEM_NS.EXEC);
    const env = core.buildEnvelope({
      requestId, batchId: null, seq: 1, deviceId, accountId: key.account_id,
      keyId: key.key_id, bindingEpoch: adm.binding.binding_epoch,
      grantEpoch: adm.grant.grant_epoch,
      idempotencyKey: idemKey, command, params, timeoutMs,
    });
    // emergency_stop：恢复信封下发前，把票据记为 consumed_pending_clear
    // （服务端镜像；设备端记录为准）。只记验签通过的票据（防调用方用
    // 伪造 epoch 抬高代次下限）。设备回 recovered 时在成功分支改记
    // recovered＋清停控记录；其他结果不改记录（停控仍在，调用方凭
    // ticket_id 查询后决定是否申请新票）。
    if (command === 'emergency_stop.recover' && params && typeof params.ticket_id === 'string') {
      try {
        if (core.verifyRecoveryTicket(params)) {
          core.recordRecoveryTicketUsed({
            ticket_id: params.ticket_id, stop_event_id: params.stop_event_id,
            account_id: key.account_id, device_id: deviceId,
            recovery_epoch: params.recovery_epoch,
          }, 'consumed_pending_clear');
        }
      } catch (e) { log({ ev: 'lea-recovery-record-failed', err: String(e && e.message) }); }
    }
    const t0 = Date.now();
    let disp;
    try {
      // B1：下发超时用核心 DISPATCH_TIMEOUT_MS（8000），不用写死的 5000
      // （5000 会抢在客户端 8s 上限前杀进程，客户端回不了 timeout JSON）。
      disp = channel ? await core.dispatchEnvelope(channel, env, { timeoutMs: core.DISPATCH_TIMEOUT_MS }) : { ok: false, error: new Error('no-channel') };
    } catch (e) { disp = { ok: false, error: e }; }
    const durationMs = Date.now() - t0;
    if (disp.ok) {
      core.updateJob(job.job_id, { status: 'SUCCEEDED', result: disp.result });
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'SUCCEEDED', job_id: job.job_id, dangerous: spec.dangerous, req_fp: reqFp, result: { job_id: job.job_id, result: disp.result } }, core.IDEM_NS.EXEC);
      auditCall(Object.assign({}, baseAudit, { result: 'ok', job_id: job.job_id, duration_ms: durationMs }));
      try { core.audit('lea-deliver', Object.assign({}, baseAudit, { job_id: job.job_id, direction: 'reply', duration_ms: durationMs })); } catch (e) {}
      // emergency_stop：设备回 recovered 时，服务端记票据 recovered＋清
      // 停控记录（域外锚点解除）。设备回的结果以其回执为准（ticket_id／
      // recovery_epoch 取设备回执内字段，不取请求 params）。
      if (command === 'emergency_stop.recover') {
        try {
          const inner = disp.result && disp.result.result;
          if (inner && inner.recovered === true && inner.ticket_id) {
            core.markRecoveryTicketRecovered(inner.ticket_id);
            core.clearEmergencyStopRecord(key.account_id, deviceId, inner.ticket_id, inner.recovery_epoch);
          }
        } catch (e) { log({ ev: 'lea-recovery-bookkeeping-failed', err: String(e && e.message) }); }
      }
      return sendJson(res, 200, { ok: true, request_id: requestId, job_id: job.job_id, result: disp.result, duration_ms: durationMs });
    }
    // B1：in-flight 名额满（QUEUE_FULL）→ 503，调用方可稍后重试同一幂等键
    // （job 仍为 RUNNING，不建新 job；幂等 RUNNING 拦住重复下发）。
    if (disp.queueFull) {
      auditCall(Object.assign({}, baseAudit, { result: 'queue-full', job_id: job.job_id, error_code: ERR.QUEUE_FULL, duration_ms: durationMs }));
      return fail(res, 503, ERR.QUEUE_FULL, '设备下发通道已满（在途 8 条），请稍后重试。');
    }
    // B1：健康探测失败（节点 DEGRADED 且 ping／reset 均未恢复）→ 503 NOT_INSTALLED。
    if (disp.notInstalled) {
      core.updateJob(job.job_id, { status: 'FAILED', error_code: ERR.NOT_INSTALLED });
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, dangerous: spec.dangerous, req_fp: reqFp, result: { job_id: job.job_id, code: ERR.NOT_INSTALLED } }, core.IDEM_NS.EXEC);
      auditCall(Object.assign({}, baseAudit, { result: 'not-installed', job_id: job.job_id, error_code: ERR.NOT_INSTALLED, duration_ms: durationMs }));
      return fail(res, 503, ERR.NOT_INSTALLED, '设备通道异常（健康探测未恢复），无法下发。');
    }
    // B1：只有 ACK（异步已接纳／结果丢失）→ 202 + job_id。
    // mode=async 是预期内的异步接纳，job 保持 RUNNING；mode=sync 是结果丢失，
    // job 记 UNKNOWN（sweeper 10 秒后转 TIMED_OUT）。
    if (disp.accepted) {
      if (disp.asyncExpected) {
        auditCall(Object.assign({}, baseAudit, { result: 'accepted-async', job_id: job.job_id, duration_ms: durationMs }));
        return sendJson(res, 202, { ok: true, async: true, request_id: requestId, job_id: job.job_id, status: 'RUNNING', msg: '命令已接纳，正在异步执行，请用 job_id 查询。' });
      }
      core.updateJob(job.job_id, { status: 'UNKNOWN', error_code: ERR.UNKNOWN });
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'RUNNING', job_id: job.job_id, dangerous: spec.dangerous, req_fp: reqFp }, core.IDEM_NS.EXEC);
      auditCall(Object.assign({}, baseAudit, { result: 'accepted-no-result', job_id: job.job_id, error_code: ERR.UNKNOWN, duration_ms: durationMs }));
      return sendJson(res, 202, { ok: true, async: true, request_id: requestId, job_id: job.job_id, status: 'UNKNOWN', code: ERR.UNKNOWN, msg: '命令已接纳但结果未回传，已转异步任务；结果未知，请用 job_id 查询或快照确认，勿直接重试危险操作。' });
    }
    if (disp.timeout) {
      // B1：通道超时（下发 8s 未回包）→ job 记 DISPATCH_TIMEOUT（新态，
      // 区别于客户端 timeout JSON 的 TIMED_OUT）；sweeper 10 秒后转 TIMED_OUT。
      core.updateJob(job.job_id, { status: 'DISPATCH_TIMEOUT', error_code: 'QFR_LEA_DISPATCH_TIMEOUT' });
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'RUNNING', job_id: job.job_id, dangerous: spec.dangerous, req_fp: reqFp }, core.IDEM_NS.EXEC);
      auditCall(Object.assign({}, baseAudit, { result: 'timeout-async', job_id: job.job_id, error_code: 'QFR_LEA_DISPATCH_TIMEOUT', duration_ms: durationMs }));
      return sendJson(res, 202, { ok: true, async: true, request_id: requestId, job_id: job.job_id, status: 'DISPATCH_TIMEOUT', code: 'QFR_LEA_DISPATCH_TIMEOUT', msg: '下发超时，已转异步任务；结果未知，请用 job_id 查询或快照确认，勿直接重试危险操作。' });
    }
    // r9：客户端已回包且执行失败（ok:false）时透传其真实 code（如
    // QFR_USH_FAILED），不再一律谎报 bad-client-output；job／幂等记
    // 该真实码，调用方据此排查而非重查下发通道。
    // B1：客户端 timeout JSON（QFR_LEA_TIMEOUT）是超时终态，job 记 TIMED_OUT
    // （不是 FAILED）；其余 QFR_* 码仍记 FAILED。
    if (disp.clientResult && typeof disp.clientResult.code === 'string' && /^QFR_[A-Z0-9_]+$/.test(disp.clientResult.code)) {
      const ccode = disp.clientResult.code;
      const cdetail = typeof disp.clientResult.detail === 'string' ? disp.clientResult.detail : '';
      if (ccode === 'QFR_LEA_TIMEOUT') {
        core.updateJob(job.job_id, { status: 'TIMED_OUT', error_code: ccode, result: disp.clientResult });
        core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, dangerous: spec.dangerous, req_fp: reqFp, result: { job_id: job.job_id, code: ccode, result: disp.clientResult } }, core.IDEM_NS.EXEC);
        auditCall(Object.assign({}, baseAudit, { result: 'client-timeout', job_id: job.job_id, error_code: ccode, duration_ms: durationMs }));
        return fail(res, 502, ccode, '执行超时：' + ccode + (cdetail ? '（' + cdetail + '）' : ''));
      }
      core.updateJob(job.job_id, { status: 'FAILED', error_code: ccode, result: disp.clientResult });
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, dangerous: spec.dangerous, req_fp: reqFp, result: { job_id: job.job_id, code: ccode, result: disp.clientResult } }, core.IDEM_NS.EXEC);
      auditCall(Object.assign({}, baseAudit, { result: 'client-failed', job_id: job.job_id, error_code: ccode, duration_ms: durationMs }));
      return fail(res, 502, ccode, '执行失败：' + ccode + (cdetail ? '（' + cdetail + '）' : ''));
    }
    core.updateJob(job.job_id, { status: 'FAILED', error_code: 'QFR_LEA_DISPATCH_FAILED' });
    core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, dangerous: spec.dangerous, req_fp: reqFp, result: { job_id: job.job_id, code: 'QFR_LEA_DISPATCH_FAILED' } }, core.IDEM_NS.EXEC);
    auditCall(Object.assign({}, baseAudit, { result: 'dispatch-failed', job_id: job.job_id, error_code: 'QFR_LEA_DISPATCH_FAILED', duration_ms: durationMs }));
    return fail(res, 502, 'QFR_LEA_DISPATCH_FAILED', '下发失败：' + String((disp.error && disp.error.message) || 'channel-error'));
  }

  // ---- 批量执行 ----
  async function handleBatches(req, res) {
    const requestId = requestIdOf(req);
    const auth = bearerAuth(req);
    if (!auth.ok) return fail(res, auth.status, auth.code, auth.msg);
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    const deviceId = String(body.device_id || '');
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const idemKey = String(req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || body.idempotency_key || '');
    if (!deviceId || !steps.length) return fail(res, 400, ERR.VALIDATION, '缺少 device_id 或 steps。');
    if (steps.length > MAX_BATCH_STEPS) return fail(res, 400, ERR.VALIDATION, '批量步数上限 ' + MAX_BATCH_STEPS + '。');
    if (!idemKey) return fail(res, 400, ERR.VALIDATION, '缺少 Idempotency-Key（批量必须带幂等键）。');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idemKey)) return fail(res, 400, ERR.VALIDATION, 'Idempotency-Key 须为 8..128 位 [A-Za-z0-9_-]。');
    // request_id 须合 token 规则，否则 buildEnvelope 抛错变 500。
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) return fail(res, 400, ERR.VALIDATION, 'X-QFR-Request-Id 须为 8..128 位 [A-Za-z0-9_-]。');
    // 步级 request_id／幂等键为基础值加后缀：基础值须给后缀留出长度，
    // 否则步级键超 128 字符、buildEnvelope 抛错变 500（如 128 字符基础键 + '-2' = 130）。
    // FIX1：步级幂等键后缀改为 '-N-<12 位步指纹>'（键绑定步内容），request_id 后缀仍为 '-N'。
    const stepSuffixLen = 1 + String(steps.length).length + 1 + 12;
    const reqSuffixLen = 1 + String(steps.length).length;
    if (idemKey.length + stepSuffixLen > 128 || requestId.length + reqSuffixLen > 128) {
      return fail(res, 400, ERR.VALIDATION, '批量基础 request_id／Idempotency-Key 过长，步级后缀后须 ≤128 位。');
    }
    // 各步 params 须为 JSON 对象（数组／标量不得签出）；timeout_ms 显式
    // 非法（非数字、非整数、<1、>该命令上限）即 400，不得 clamp 后签名。
    for (const st of steps) {
      if (st && st.params != null && (typeof st.params !== 'object' || Array.isArray(st.params))) {
        return fail(res, 400, ERR.VALIDATION, '批量某步 params 须为 JSON 对象。');
      }
      if (st && st.timeout_ms !== undefined) {
        const sspec = core.COMMANDS[String(st.command || '')];
        if (sspec && (typeof st.timeout_ms !== 'number' || !Number.isInteger(st.timeout_ms) || st.timeout_ms < 1 || st.timeout_ms > sspec.maxTimeoutMs)) {
          return fail(res, 400, ERR.VALIDATION, '批量某步 timeout_ms 须为 1..' + sspec.maxTimeoutMs + ' 的整数。');
        }
      }
    }
    const key = auth.key;
    // S-089：批量限流（account/key 分别计）；超限 429＋Retry-After。
    const batchRl = leaRateCheckBatch({ accountId: key.account_id, keyId: key.key_id });
    if (!batchRl.ok) {
      return rateLimited(res, batchRl.retryAfter, 'LEA 批量执行过于频繁，请稍后再试。');
    }
    // H13（DS 复查）：steps 指纹——UNKNOWN 重试时若 steps 内容变了，步级
    // 缓存按位置复用会误用旧结果。指纹随批量级幂等记录；重试时指纹不一致
    // 即不复用步级缓存，全部步重跑。
    const stepsFp = crypto.createHash('sha256').update(JSON.stringify(steps)).digest('hex');
    // FIX1：步指纹与派生步级键——步级幂等键 = 基础键 + '-' + 步号 + '-' + 步指纹前 12 位。
    // 同一基础键＋不同 steps 必然得到不同步级键：服务端不再对不同 steps 复用
    // 同一（步级）键；LEA 端另以全指纹核对兜底（见 QFRLEA.c §5）。
    const stepFp = (st) => crypto.createHash('sha256').update(JSON.stringify(st)).digest('hex');
    const stepKey = (i) => idemKey + '-' + (i + 1) + '-' + stepFp(steps[i]).slice(0, 12);
    // H13：批量级幂等——重复提交去重（此前批量级键只要求不记录，步级键
    // 也不写入 idemSeen，重复提交重跑全部步骤）。UNKNOWN 不拦重放
    //（H14 推进器已把失联 RUNNING 转 UNKNOWN），继续执行并覆盖记录。
    const prevBatch = core.idemLookup(key.account_id, key.key_id, idemKey, core.IDEM_NS.BATCH);
    if (prevBatch && prevBatch.status === 'RUNNING') return fail(res, 409, ERR.DUPLICATE, '同一幂等键的批量任务正在执行中。');
    // FIX1：批量级复用须指纹一致——同键换 steps 不得返回旧批次结果。
    // 旧记录无 steps_fp（FIX1 前落盘）时无法核对，同样拒绝复用。
    if (prevBatch && (prevBatch.status === 'SUCCEEDED' || prevBatch.status === 'FAILED')) {
      if (!prevBatch.steps_fp || prevBatch.steps_fp !== stepsFp) {
        return fail(res, 409, ERR.IDEMPOTENT_MISMATCH, '同一幂等键已绑定另一批量内容，拒绝复用旧结果；请换新幂等键重发。');
      }
      return sendJson(res, 200, Object.assign({ ok: prevBatch.status === 'SUCCEEDED', duplicate: true, request_id: requestId }, prevBatch.result || {}));
    }
    // 任一步危险则按 30 天保留（下文 idemRecord 用；提前算出供 UNKNOWN 换 steps 守卫共用）。
    const batchDangerous = steps.some((st) => {
      const s = core.COMMANDS[String((st && st.command) || '')];
      return !!(s && s.dangerous);
    });
    // FIX1：UNKNOWN 批次换 steps 重试时，若新 steps 含危险命令，禁止自动重试——
    // 旧危险步的结果未知，新危险步一旦下发可能与旧步重复执行；须人工确认后换新键重发。
    if (prevBatch && prevBatch.status === 'UNKNOWN' && prevBatch.steps_fp && prevBatch.steps_fp !== stepsFp && batchDangerous) {
      return fail(res, 409, ERR.UNKNOWN, '上批危险步骤执行结果未知，换 steps 后禁止自动重试；请先用 job_id 查询或快照确认，确认后换新幂等键重发。');
    }
    // UNKNOWN 重试：只有 steps 指纹一致才复用已成功步的缓存。
    const reuseSteps = !prevBatch || !prevBatch.steps_fp || prevBatch.steps_fp === stepsFp;
    // H12：批量接口查设备在线（handleExecute 查了，handleBatches 没查）。
    // 离线／通道不可达即拒，不建 job、不记幂等 RUNNING。
    let online = null;
    try { online = channel ? await channel.nodeOnline(deviceId) : null; } catch (e) { online = null; }
    if (online === false) {
      auditCall({ request_id: requestId, account_id: key.account_id, device_id: deviceId, api_key_id: key.key_id, command: 'batches', idempotency_key: idemKey, result: 'denied', error_code: ERR.NOT_INSTALLED, ip: clientIp(req) });
      return fail(res, 503, ERR.NOT_INSTALLED, '设备未安装 LEA 或不在线。');
    }
    if (online === null) {
      auditCall({ request_id: requestId, account_id: key.account_id, device_id: deviceId, api_key_id: key.key_id, command: 'batches', idempotency_key: idemKey, result: 'denied', error_code: ERR.NOT_INSTALLED, ip: clientIp(req) });
      return fail(res, 503, ERR.NOT_INSTALLED, '下发通道暂时不可达，无法确认设备在线。');
    }
    const batchId = 'batch_' + crypto.randomBytes(8).toString('hex');
    const job = core.createJob({
      account_id: key.account_id, device_id: deviceId, api_key_id: key.key_id,
      batch_id: batchId, request_id: requestId, idempotency_key: idemKey,
      status: 'RUNNING', steps_total: steps.length, steps_done: 0, results: [],
    });
    // H13：批量级幂等键写入 idemSeen（RUNNING）；任一步危险则按 30 天保留。
    core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'RUNNING', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp }, core.IDEM_NS.BATCH);
    // 后台顺序执行；同步等待 5s，超时即 202 + job_id（继续后台跑完）。
    const startedAt = Date.now();
    // DC-A-5：取消后终态不得再被覆盖——超时／失败分支曾无条件把 job 置
    // UNKNOWN/FAILED，用户取消后查到的终态是 UNKNOWN/FAILED 而非
    // CANCELLED。只守 job 终态；步级／批量级幂等记录照常（保留 UNKNOWN
    // 可重试、FAILED 可查的语义）。
    function setJobTerminalUnlessCancelled(jobId, patch) {
      const cur = core.getJob(jobId);
      if (cur && cur.status === 'CANCELLED') return;
      core.updateJob(jobId, patch);
    }
    const run = (async () => {
      const results = [];
      let failed = false;
      let snapshotBytes = 0; // S-089：批内截图结果累计字节（超 20MB 即停）
      for (let i = 0; i < steps.length; i++) {
        const cur = core.getJob(job.job_id);
        if (cur && cur.status === 'CANCELLED') { results.push({ seq: i + 1, cancelled: true }); break; }
        // S-089：批量总执行时间上限 10 分钟——超时即停、job 记 UNKNOWN，
        // 调用方凭幂等键重试未完成步（与 disp.timeout 同款终态）。
        if (Date.now() - startedAt > BATCH_MAX_WALL_MS) {
          results.push({ seq: i + 1, command: String((steps[i] && steps[i].command) || ''), ok: false, code: ERR.UNKNOWN });
          setJobTerminalUnlessCancelled(job.job_id, { status: 'UNKNOWN', error_code: ERR.UNKNOWN, results, steps_done: i });
          core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'UNKNOWN', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status: 'UNKNOWN', results, steps_done: i } }, core.IDEM_NS.BATCH);
          return;
        }
        const st = steps[i] || {};
        const command = String(st.command || '');
        const spec = core.COMMANDS[command];
        if (!spec) { results.push({ seq: i + 1, command, ok: false, code: ERR.VALIDATION }); failed = true; break; }
        const adm = core.admit({ key, deviceId, command, requestId, ip: clientIp(req) });
        if (!adm.ok) { results.push({ seq: i + 1, command, ok: false, code: adm.code }); failed = true; break; }
        // H13：步级幂等——已成功的步不再重跑，复用缓存结果（仅当 steps
        // 指纹一致；UNKNOWN 重试改了 steps 时不复用，见 reuseSteps）。
        // FIX1：步级复用另须步指纹一致（步级键已含步指纹前 12 位，此处再以
        // 全指纹核对兜底；旧记录无 step_fp 时不复用）。
        const prevStep = core.idemLookup(key.account_id, key.key_id, stepKey(i), core.IDEM_NS.STEP);
        if (reuseSteps && prevStep && prevStep.status === 'SUCCEEDED' && prevStep.step_fp && prevStep.step_fp === stepFp(steps[i])) {
          results.push({ seq: i + 1, command, ok: true, result: prevStep.result || null, duplicate: true });
          core.updateJob(job.job_id, { results, steps_done: i + 1 });
          continue;
        }
        // FIX1：危险步上次结果 UNKNOWN 时禁止自动重发（同键同 steps 重试亦然）——
        // 须人工确认后换新幂等键重发；LEA 端对 UNKNOWN 键同样拒绝执行（双保险）。
        if (prevStep && prevStep.status === 'UNKNOWN' && spec.dangerous) {
          results.push({ seq: i + 1, command, ok: false, code: ERR.UNKNOWN, detail: 'dangerous-unknown-no-auto-retry' });
          setJobTerminalUnlessCancelled(job.job_id, { status: 'UNKNOWN', error_code: ERR.UNKNOWN, results, steps_done: i + 1 });
          core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'UNKNOWN', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status: 'UNKNOWN', results, steps_done: i + 1 } }, core.IDEM_NS.BATCH);
          return;
        }
        core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'RUNNING', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous, step_fp: stepFp(steps[i]) }, core.IDEM_NS.STEP);
        const env = core.buildEnvelope({
          // 步级 request_id／幂等键用 '-' 连接步号：':' 不合 token 规则
          //（C 端解析层拒绝），旧 ':' 形态的批量信封到 LEA 即被拒。
          requestId: requestId + '-' + (i + 1), batchId, seq: i + 1, deviceId,
          accountId: key.account_id, keyId: key.key_id, bindingEpoch: adm.binding.binding_epoch,
          grantEpoch: adm.grant.grant_epoch,
          idempotencyKey: stepKey(i), command, params: st.params || {},
          timeoutMs: st.timeout_ms !== undefined ? st.timeout_ms : spec.timeoutMs,
        });
        let disp;
        try { disp = channel ? await core.dispatchEnvelope(channel, env, { timeoutMs: core.DISPATCH_TIMEOUT_MS }) : { ok: false, error: new Error('no-channel') }; }
        catch (e) { disp = { ok: false, error: e }; }
        // B1：只有 ACK（结果丢失）或客户端 timeout JSON，均按“步超时／未知”
        // 处理（与 disp.timeout 同款：步 UNKNOWN，批次终止）。
        if (disp.accepted || (disp.clientResult && disp.clientResult.code === 'QFR_LEA_TIMEOUT')) {
          results.push({ seq: i + 1, command, ok: false, code: ERR.UNKNOWN });
          setJobTerminalUnlessCancelled(job.job_id, { status: 'UNKNOWN', error_code: ERR.UNKNOWN, results, steps_done: i + 1 });
          core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'UNKNOWN', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous, step_fp: stepFp(steps[i]) }, core.IDEM_NS.STEP);
          core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'UNKNOWN', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status: 'UNKNOWN', results, steps_done: i + 1 } }, core.IDEM_NS.BATCH);
          return;
        }
        if (disp.timeout) {
          results.push({ seq: i + 1, command, ok: false, code: ERR.UNKNOWN });
          setJobTerminalUnlessCancelled(job.job_id, { status: 'UNKNOWN', error_code: ERR.UNKNOWN, results, steps_done: i + 1 });
          core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'UNKNOWN', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous, step_fp: stepFp(steps[i]) }, core.IDEM_NS.STEP);
          core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'UNKNOWN', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status: 'UNKNOWN', results, steps_done: i + 1 } }, core.IDEM_NS.BATCH);
          return;
        }
        if (!disp.ok) {
          // r9：客户端已回包的终态失败透传其真实 code（与单条 handleExecute 同口径）。
          const bcode = (disp.clientResult && typeof disp.clientResult.code === 'string' && /^QFR_[A-Z0-9_]+$/.test(disp.clientResult.code))
            ? disp.clientResult.code : 'QFR_LEA_DISPATCH_FAILED';
          results.push({ seq: i + 1, command, ok: false, code: bcode });
          setJobTerminalUnlessCancelled(job.job_id, { status: 'FAILED', error_code: bcode, results, steps_done: i + 1 });
          core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'FAILED', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous, step_fp: stepFp(steps[i]), result: { job_id: job.job_id, code: bcode } }, core.IDEM_NS.STEP);
          core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status: 'FAILED', results, steps_done: i + 1 } }, core.IDEM_NS.BATCH);
          return;
        }
        results.push({ seq: i + 1, command, ok: true, result: disp.result });
        // S-089：截图结果累计超 20MB 即停批（防一批截图把内存／带宽打满），
        // 本步已落盘的结果保留，批次记 FAILED，调用方凭幂等键重试后续步。
        if (command === 'ui.snapshot') {
          try { snapshotBytes += Buffer.byteLength(JSON.stringify(disp.result), 'utf8'); } catch (e) {}
          if (snapshotBytes > BATCH_SNAPSHOT_BUDGET_BYTES) {
            core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'SUCCEEDED', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous, step_fp: stepFp(steps[i]), result: disp.result }, core.IDEM_NS.STEP);
            core.updateJob(job.job_id, { results, steps_done: i + 1 });
            setJobTerminalUnlessCancelled(job.job_id, { status: 'FAILED', error_code: 'QFR_LEA_SNAPSHOT_BUDGET', results, steps_done: i + 1 });
            core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status: 'FAILED', results, steps_done: i + 1 } }, core.IDEM_NS.BATCH);
            return;
          }
        }
        core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'SUCCEEDED', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous, step_fp: stepFp(steps[i]), result: disp.result }, core.IDEM_NS.STEP);
        core.updateJob(job.job_id, { results, steps_done: i + 1 });
        // 撤销检查：批内每步开始前核 grant_epoch（§6.2）——admit 已每步重查。
      }
      const cur = core.getJob(job.job_id);
      if (cur && cur.status === 'RUNNING') {
        // 有步失败（未知命令／准入拒绝）时终态为 FAILED，不得把含失败步的
        // 批次谎称为 SUCCEEDED（此前 break 后仍置 SUCCEEDED）。
        const status = failed ? 'FAILED' : 'SUCCEEDED';
        core.updateJob(job.job_id, { status, results });
        core.idemRecord(key.account_id, key.key_id, idemKey, { status, job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status, results, steps_done: results.length } }, core.IDEM_NS.BATCH);
      }
    })();
    run.catch((e) => {
      try { setJobTerminalUnlessCancelled(job.job_id, { status: 'FAILED', error_code: 'QFR_LEA_DISPATCH_FAILED' }); } catch (e2) {}
      try { core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status: 'FAILED' } }, core.IDEM_NS.BATCH); } catch (e2) {}
      log({ ev: 'lea-batch-error', job_id: job.job_id, err: String(e && e.message) });
    });
    // 同步等 5s：跑完直接回 200，否则 202 + job_id。
    const done = await Promise.race([
      run.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 5000)),
    ]);
    const cur = core.getJob(job.job_id);
    if (done && cur) {
      return sendJson(res, 200, { ok: true, request_id: requestId, job_id: job.job_id, batch_id: batchId, status: cur.status, results: cur.results || [], steps_done: cur.steps_done || 0 });
    }
    return sendJson(res, 202, { ok: true, async: true, request_id: requestId, job_id: job.job_id, batch_id: batchId, status: 'RUNNING', msg: '批量执行中，请用 job_id 轮询。' });
  }

  // DC-A-3：设备状态／吊销快照只许“绑定归属账号的 Key”读——此前
  // device_scope 为空的任意有效 Key 可读任意设备的绑定账号／在线态／
  // 吊销 key_id（跨账号信息泄露，与桥 V-1 同源）。D2：device_scope
  // 匹配不再单独放行，须同时是绑定归属账号（scope 是归属之内的进一
  // 步收窄，不是归属的替代）。未绑定设备一律 403（不以 404 区分“不存
  // 在”与“非本人设备”，防存在性预言）。
  function deviceVisibleTo(key, deviceId) {
    // D2（全面复审 §二.1／整改第 2 步）：读路径归属必验。设备须当前绑
    // 定到该 Key 的账号；device_scope 若已设定须同时匹配（未设定时归属
    // 匹配即足够，兼容 DC-A-1 之前无 scope 旧 Key）。归一后比对：Key 的
    // device_scope 可能为全形，URL 来的 deviceId 可能为裸形。
    const binding = core.getBinding(deviceId);
    if (!binding || binding.account_id !== key.account_id) return false;
    if (key.device_scope && bareNodeId(key.device_scope) !== bareNodeId(deviceId)) return false;
    return true;
  }

  // ---- 查 job / 取消 job ----
  function jobOwnedBy(job, key) {
    return job && job.account_id === key.account_id;
  }
  async function handleGetJob(req, res, jobId) {
    const auth = bearerAuth(req);
    if (!auth.ok) return fail(res, auth.status, auth.code, auth.msg);
    const job = core.getJob(jobId);
    if (!job || !jobOwnedBy(job, auth.key)) return fail(res, 404, 'NOT_FOUND', '任务不存在。');
    return sendJson(res, 200, { ok: true, job });
  }
  async function handleCancelJob(req, res, jobId) {
    const auth = bearerAuth(req);
    if (!auth.ok) return fail(res, auth.status, auth.code, auth.msg);
    const job = core.getJob(jobId);
    if (!job || !jobOwnedBy(job, auth.key)) return fail(res, 404, 'NOT_FOUND', '任务不存在。');
    if (job.status === 'RUNNING' || job.status === 'PENDING') {
      core.updateJob(jobId, { status: 'CANCELLED' });
      try { core.audit('lea-job-cancel', { account_id: auth.key.account_id, device_id: job.device_id, api_key_id: auth.key.key_id, job_id: jobId }); } catch (e) {}
      return sendJson(res, 200, { ok: true, job_id: jobId, status: 'CANCELLED', msg: '已取消尚未开始的步骤；已发出的 runcommands 无法撤回。' });
    }
    return sendJson(res, 200, { ok: true, job_id: jobId, status: job.status, msg: '任务已结束，无法取消。' });
  }

  // ---- 查设备状态 ----
  async function handleDeviceStatus(req, res, deviceId) {
    const auth = bearerAuth(req);
    if (!auth.ok) return fail(res, auth.status, auth.code, auth.msg);
    const key = auth.key;
    if (!deviceVisibleTo(key, deviceId)) {
      return fail(res, 403, ERR.SCOPE_DENIED, '该 Key 不能查看此设备状态。');
    }
    const binding = core.getBinding(deviceId);
    let online = null;
    try { online = channel ? await channel.nodeOnline(deviceId) : null; } catch (e) { online = null; }
    // C1：在线即记设备最后在线（60 秒节流，见 touchDeviceSeen）。
    if (online === true) { try { core.touchDeviceSeen(deviceId); } catch (e) {} }
    return sendJson(res, 200, {
      ok: true, device_id: deviceId,
      bound: !!(binding && binding.state === 'ACTIVE'),
      account_id: binding ? binding.account_id : null,
      binding_epoch: binding ? binding.binding_epoch : 0,
      binding_state: binding ? binding.state : 'UNBOUND',
      online, // true 在线 / false 离线 / null 通道不可达（未知，不谎称）
      grant: core.hasGrant(key.account_id),
      signing_mode: core.signingInfo().mode,
    });
  }

  // ---- 控制台会话校验（Key 管理入口共用） ----
  async function consoleAuth(req, res) {
    if (typeof deps.resolveConsoleAuth !== 'function') {
      fail(res, 503, 'LEA_UNAVAILABLE', '本站未接入控制台会话校验，Key 管理暂不可用。');
      return null;
    }
    let a = null;
    try { a = await deps.resolveConsoleAuth(req); } catch (e) { a = null; }
    if (!a || !a.user) { fail(res, 401, 'UNAUTHORIZED', '请先登录。'); return null; }
    return a;
  }
  async function passwordConfirm(req, res, user, opts) {
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) { fail(res, 400, ERR.VALIDATION, '请求体过大。'); return null; }
    const password = String(body.password || '');
    if (!password) { fail(res, 400, ERR.VALIDATION, '生成/管理 Key 须重新输入账号密码作二次确认。'); return null; }
    if (typeof deps.verifyPassword !== 'function') {
      fail(res, 503, 'LEA_UNAVAILABLE', '本站未接入密码核验，Key 管理暂不可用。');
      return null;
    }
    let ok = false;
    try { ok = await deps.verifyPassword(user, password); } catch (e) { ok = false; }
    if (!ok) { fail(res, 401, 'BAD_PASSWORD', '密码不正确。'); return null; }
    // MFA 若启用则走 MFA（deps.verifyMfa 未注入 = 本站暂无 MFA 校验入口，
    // 此时仅凭密码二次确认；见 README 未完成项）。
    // 注意：恢复票据签发不走此处（opts.skipMfa），改走下方的全员强制
    // MFA 门 requireRecoveryMfa（GPT 2026-11-18 裁决 §三）；Key 管理
    // 入口保持原有口径（仅注入了 verifyMfa 时才校验 MFA）。
    if (!opts || !opts.skipMfa) {
      if (typeof deps.verifyMfa === 'function') {
        let mfaOk = false;
        try { mfaOk = await deps.verifyMfa(user, String(body.mfa_code || '')); } catch (e) { mfaOk = false; }
        if (!mfaOk) { fail(res, 401, 'BAD_MFA', 'MFA 校验未通过。'); return null; }
      }
    }
    return body;
  }

  // ---- Key 管理 ----
  async function handleCreateKey(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const body = await passwordConfirm(req, res, a.user);
    if (!body) return;
    const deviceScope = body.device_id ? String(body.device_id) : null;
    // D2-K1：路由层参数校验——显式 device_id 格式非法时直接 400（Core 层
    // 同规则再拦一次，防直接调 generateKey 的旁路；真正的归属准入在 Core）。
    if (deviceScope && typeof core.isValidDeviceIdFormat === 'function' && !core.isValidDeviceIdFormat(deviceScope)) {
      return fail(res, 400, ERR.VALIDATION, 'device_id 格式非法。');
    }
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s) => s === 'muse.execute' || s === DANGEROUS_SCOPE) : ['muse.execute'];
    // H06：dangerous scope 须站长先授 dangerous 授权（/grants），自助选即
    // 403；无 muse.execute 授权时生成 Key 亦拒绝（core.generateKey 同拦，
    // 此处先给明确文案，core 抛错时再按码转 403）。
    if (scopes.includes(DANGEROUS_SCOPE) && !core.hasDangerousGrant(a.user)) {
      return fail(res, 403, ERR.SCOPE_DENIED, 'muse.execute.dangerous 须站长审批授权后才能生成，请联系站长。');
    }
    let out;
    try {
      out = core.generateKey(a.user, {
        device_scope: deviceScope, scopes,
        expires_in_days: Number.isFinite(Number(body.expires_in_days)) ? Number(body.expires_in_days) : undefined,
        ip: clientIp(req), userAgent: String((req.headers && req.headers['user-agent']) || ''),
        confirmMethod: typeof deps.verifyMfa === 'function' ? 'password+mfa' : 'password',
      });
    } catch (e) {
      if (e && e.code === 'QFR_MUSE_NOT_AUTHORIZED') return fail(res, 403, e.code, '该账号未授权 Muse 操作，请先请站长授予 muse.execute。');
      if (e && e.code === 'QFR_SCOPE_DENIED') {
        // D2-K1：同码两种拒绝须区分——归属拒绝用统一文案（不透露设备属于
        // 谁、不区分“不存在”与“非本人设备”）；dangerous scope 拒绝保留原
        // 有文案。归属拒绝记审计（只记请求账号与请求设备，不记设备实际归属）。
        if (e.reason === 'device-ownership') {
          try { core.audit('lea-key-create-denied', { account_id: a.user, device_id: deviceScope ? core.bareNodeId(deviceScope) : null, reason: 'device-ownership' }); } catch (e) {}
          return fail(res, 403, e.code, '当前账户无权为该设备创建 API Key，请检查设备绑定状态。');
        }
        return fail(res, 403, e.code, 'muse.execute.dangerous 须站长审批授权后才能生成，请联系站长。');
      }
      // D2-K1：绑定确认中（仅当请求方即绑定账号本人时才返回此码）→ 409；
      // 归属权威服务不可用 → 503；设备 id 格式非法 → 400。
      if (e && e.code === 'QFR_LEA_BINDING_PENDING') return fail(res, 409, e.code, '设备绑定确认中，请 1 秒后重试一次。');
      if (e && e.code === 'QFR_VISIBILITY_UNAVAILABLE') return fail(res, 503, e.code, '设备归属验证服务暂不可用，请稍后重试。');
      if (e && e.code === 'VALIDATION') return fail(res, 400, e.code, 'device_id 格式非法。');
      // DC-A-1：无 device_scope 且无法自动取设备（未绑定／绑定多台）时
      // 拒绝发死钥，由调用方明示 device_id（路由层 body.device_id）。
      if (e && e.code === 'QFR_DEVICE_SCOPE_REQUIRED') {
        return fail(res, 400, e.code, e.reason === 'multi-device'
          ? '该账号绑定了多台设备，生成 Key 时须指定 device_id。'
          : '该账号尚未绑定设备，请先在设备上登录 QFRemote 完成绑定后再生成 Key。');
      }
      throw e;
    }
    // 明文仅本次响应返回一次；前端只显示一次，关闭后不再明文展示（§7.2）。
    return sendJson(res, 200, { ok: true, key: out.key, record: out.record, msg: '请立即复制保存：关闭后不再明文展示。' });
  }
  async function handleListKeys(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    return sendJson(res, 200, { ok: true, keys: core.listKeys(a.user) });
  }
  async function handleRevokeKey(req, res, keyId) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    // T30：单 Key 吊销与一键吊销全部同口径，须密码二次确认（此前只凭
    // 控制台登录态；与 handleRevokeAllKeys 一致，走 passwordConfirm，
    // 含 MFA 注入时的 MFA 校验）。
    const body = await passwordConfirm(req, res, a.user);
    if (!body) return;
    const rec = core.findKeyById(keyId);
    if (!rec || rec.account_id !== a.user) return fail(res, 404, 'NOT_FOUND', 'Key 不存在。');
    const out = core.revokeKey(keyId, a.user, 'user-revoke');
    const kick = await kickAfterRevoke(out.revoked_key_ids || [keyId],
      out.record && out.record.device_scope ? [out.record.device_scope] : null, a.user, 'user-revoke');
    return sendJson(res, 200, { ok: true, record: out.record, kick });
  }
  async function handleRevokeAllKeys(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const body = await passwordConfirm(req, res, a.user);
    if (!body) return;
    const out = core.revokeAllKeys(a.user, a.user, 'revoke-all');
    const kick = await kickAfterRevoke(out.revoked_key_ids || [], null, a.user, 'revoke-all');
    return sendJson(res, 200, { ok: true, revoked_count: out.revoked_count, kick, msg: '该账号全部 Key 已吊销，Muse 再调用将返回 401 QFR_API_KEY_REVOKED。' });
  }

  // ---- emergency_stop（GPT 2026-11-18 裁决问题 1、3、六节） ----
  // 同步端点：设备本地停控后，main.js 凭控制台会话上报停控事件，服务
  // 端记录停控（域外防回滚锚点）＋按 device_scope 逐个吊销该设备全部
  // Key，返回服务端签名回执（main.js 交 LEA 验签后改 sync_status）。
  // 口径：控制台会话＋设备归属校验，不做密码二次确认（停控本身已在
  // 本机发生，同步只是把既成事实告诉服务端；恢复票据签发才须强认证）。
  async function handleEmergencyStopSync(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    const deviceId = core.bareNodeId(String(body.device_id || ''));
    if (!deviceId) return fail(res, 400, ERR.VALIDATION, '缺少 device_id。');
    const stopEventId = String(body.stop_event_id || '');
    if (!stopEventId || !/^[A-Za-z0-9_.-]{1,128}$/.test(stopEventId)) return fail(res, 400, ERR.VALIDATION, 'stop_event_id 非法。');
    // 设备归属：绑定须属于当前登录账号（未绑定／绑他人一律按未绑定
    // 当前账号拒绝，不泄露存在性）。
    const binding = core.getBinding(deviceId);
    if (!binding || binding.state !== 'ACTIVE' || binding.account_id !== a.user) {
      return fail(res, 403, ERR.NOT_BOUND, '设备未绑定当前账号。');
    }
    if (Number.isSafeInteger(body.binding_epoch) && body.binding_epoch !== binding.binding_epoch) {
      return fail(res, 409, ERR.BINDING_CHANGED, '绑定代次已变更，请重新登录设备后再同步。');
    }
    let out;
    try {
      out = core.emergencyStopSync({
        accountId: a.user, deviceId,
        stopEventId,
        stopSeq: Number.isSafeInteger(body.stop_seq) ? body.stop_seq : 0,
        scope: String(body.scope || 'device-control'),
        bindingEpoch: binding.binding_epoch,
        grantEpoch: Number.isSafeInteger(body.grant_epoch) ? body.grant_epoch : 0,
        stoppedAt: Number.isSafeInteger(body.stopped_at) ? body.stopped_at : undefined,
      });
    } catch (e) {
      if (e && e.code === 'QFR_VALIDATION') return fail(res, 400, e.code, e.message);
      throw e;
    }
    return sendJson(res, 200, { ok: true, receipt: out.receipt, revoked_key_ids: out.revoked_key_ids });
  }
  // 恢复票据签发端点：签发＝新授权，须控制台会话＋密码二次确认＋
  // 全员强制 MFA（GPT 2026-11-18 裁决 §三）。auth_context 形如
  // password+<totp|passkey>@<verified_at>，只记认证方式＋验证完成时间，
  // 不记密码／MFA 码。票据明文只在本次响应返回一次（与 Key 明文同口径）；
  // recovery_epoch 由服务端铸造（已见最大＋1），调用方不得自选。
  // 恢复流程两步：①用新绑定票据＋新 Key 激活绑定（停控保留，旧 Key
  // 保持吊销）；②凭本票据发 emergency_stop.recover 信封。
  // 全员强制 MFA 门（requireRecoveryMfa）：必须有合格的第二因素，不因
  // 用户未开启而跳过；未启用／冷静期／丢失各有明确拒绝＋安全恢复路径；
  // MFA 验证与本次请求绑定、5 分钟内有效（验证记录单次使用，或同一
  // 请求内联验码）。登录密码＋再次输入同一密码不构成 MFA。
  async function requireRecoveryMfa(req, res, user, body) {
    const mfa = deps.mfa;
    if (!mfa || typeof mfa.getFactorStatus !== 'function') {
      log({ ev: 'lea-mfa-unavailable', msg: 'MFA core not configured; recovery ticket refused' });
      fail(res, 503, 'MFA_UNAVAILABLE', '本站 MFA 未配置，恢复票据暂不可签发。');
      return null;
    }
    let st = null;
    try { st = mfa.getFactorStatus(user); } catch (e) { st = null; }
    if (!st) { fail(res, 503, 'MFA_UNAVAILABLE', 'MFA 状态不可用，恢复票据暂不可签发。'); return null; }
    if (st.status === 'none') {
      try { mfa.audit('lea-mfa-required-block', { account_id: user }); } catch (e) {}
      sendJson(res, 403, { ok: false, code: 'MFA_REQUIRED',
        msg: '该账号未启用 MFA，无法直接签发恢复票据。请先完成可信 MFA 注册（控制台会话＋密码二次确认），新注册的 MFA 须经过 24 小时冷静期后方可用于恢复。',
        recovery_path: { action: 'enroll', enroll_begin: '/api/lea/v1/mfa/enroll/begin', enroll_confirm: '/api/lea/v1/mfa/enroll/confirm', note: '注册须控制台会话＋密码二次确认；新因素启用后有 24 小时冷静期。' } });
      return null;
    }
    if (st.status === 'lost') {
      let openCases = [];
      try { openCases = mfa.listOpenCases(user); } catch (e) {}
      sendJson(res, 403, { ok: false, code: 'MFA_LOST',
        msg: 'MFA 设备已挂失，须走专门的账户恢复流程（站长审批后重新注册新 MFA），不降低为只输入密码。',
        recovery_path: { action: 'account-recovery', report_lost: '/api/lea/v1/mfa/report-lost', open_cases: openCases, note: '挂失后原因素立即失效；恢复须站长审批，重新注册后仍有 24 小时冷静期。' } });
      return null;
    }
    if (st.status === 'cooling-off') {
      sendJson(res, 403, { ok: false, code: 'MFA_COOLDOWN',
        msg: '新注册的 MFA 处于冷静期，冷静期结束前不得用于签发恢复票据。',
        recovery_path: { action: 'wait-cooldown', cooldown_until: st.cooldown_until, cooldown_remaining_s: st.cooldown_remaining_s, note: '新因素启用须经风险核验与通知＋冷静期，防止攻击者注册自己的 MFA 后立刻解除停控。' } });
      return null;
    }
    // 因素 active：凭本次请求的 mfa_code 内联验码，或消费此前 5 分钟内
    // 签发的单次验证记录（mfa_verification_id）。
    const verificationId = String(body.mfa_verification_id || '');
    const code = String(body.mfa_code || '');
    try {
      if (verificationId) return mfa.consumeVerification(user, verificationId);
      if (!code) {
        fail(res, 400, 'MFA_CODE_REQUIRED', '签发恢复票据须提供 MFA 校验码，或先经 /api/lea/v1/mfa/verify 取得 5 分钟内有效的验证记录。');
        return null;
      }
      return mfa.verifyCode(user, code);
    } catch (e) {
      if (e && e.code === 'QFR_MFA_COOLDOWN') {
        return sendJson(res, 403, { ok: false, code: 'MFA_COOLDOWN',
          msg: '新注册的 MFA 处于冷静期，冷静期结束前不得用于签发恢复票据。',
          recovery_path: { action: 'wait-cooldown', cooldown_until: e.cooldown_until || 0, cooldown_remaining_s: e.cooldown_remaining_s || 0 } }), null;
      }
      if (e && e.code === 'QFR_MFA_LOST') {
        return sendJson(res, 403, { ok: false, code: 'MFA_LOST', msg: 'MFA 设备已挂失，须走专门的账户恢复流程。' }), null;
      }
      if (e && e.code === 'QFR_MFA_NOT_ENROLLED') {
        return sendJson(res, 403, { ok: false, code: 'MFA_REQUIRED', msg: '该账号未启用 MFA，无法直接签发恢复票据。' }), null;
      }
      if (e && (e.code === 'QFR_MFA_VERIFICATION_EXPIRED' || e.code === 'QFR_MFA_VERIFICATION_REUSED' || e.code === 'QFR_MFA_VERIFICATION_INVALID')) {
        fail(res, 401, 'BAD_MFA', 'MFA 验证记录无效、已过期（5 分钟）或已被使用，请重新验证。');
        return null;
      }
      if (e && e.code === 'QFR_MFA_BAD_CODE') { fail(res, 401, 'BAD_MFA', 'MFA 校验未通过。'); return null; }
      throw e;
    }
  }
  async function handleRecoveryTicket(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    // 密码二次确认（此处跳过 passwordConfirm 内可选的 MFA——恢复票据
    // 的 MFA 由下方全员强制门单独执行，Key 管理入口口径不受影响）。
    const body = await passwordConfirm(req, res, a.user, { skipMfa: true });
    if (!body) return;
    const deviceId = core.bareNodeId(String(body.device_id || ''));
    if (!deviceId) return fail(res, 400, ERR.VALIDATION, '缺少 device_id。');
    const stopEventId = String(body.stop_event_id || '');
    if (!stopEventId || !/^[A-Za-z0-9_.-]{1,128}$/.test(stopEventId)) return fail(res, 400, ERR.VALIDATION, 'stop_event_id 非法。');
    const binding = core.getBinding(deviceId);
    if (!binding || binding.state !== 'ACTIVE' || binding.account_id !== a.user) {
      return fail(res, 403, ERR.NOT_BOUND, '设备未绑定当前账号。');
    }
    const grant = core.getGrant(a.user);
    if (!grant || grant.revoked_at || grant.scope !== 'muse.execute') {
      return fail(res, 403, ERR.NOT_AUTHORIZED, '该账号未授权 Muse 操作，或授权已被撤销。');
    }
    const mfaAuth = await requireRecoveryMfa(req, res, a.user, body);
    if (!mfaAuth) return;
    const authContext = 'password+' + mfaAuth.method + '@' + mfaAuth.verified_at;
    let ticket;
    try {
      ticket = core.issueRecoveryTicket({
        accountId: a.user, deviceId,
        stopEventId,
        grantEpoch: grant.grant_epoch,
        scope: '',
        authContext,
      });
    } catch (e) {
      if (e && e.code === 'QFR_LEA_NO_ACTIVE_EMERGENCY_STOP') return fail(res, 409, e.code, '该设备当前没有活动的紧急停控，无须恢复票据。');
      if (e && e.code === 'QFR_VALIDATION') return fail(res, 400, e.code, e.message);
      if (e && e.code === 'QFR_LEA_NOT_BOUND') return fail(res, 403, e.code, '设备未绑定当前账号。');
      throw e;
    }
    return sendJson(res, 200, { ok: true, ticket, msg: '恢复票据有效期 1 小时，一次性使用；请先用新绑定票据＋新 Key 激活绑定（停控保留），再发 emergency_stop.recover 信封。' });
  }

  // ---- MFA 注册与恢复（GPT 2026-11-18 裁决 §三） ----
  // 边界：本组端点只服务"恢复票据签发"所需的第二因素；不要求普通用户
  // 每次登录／连接设备时完成 MFA。注册本身须控制台会话＋密码二次确认
  // （额外身份验证要求）；新因素启用后有 24 小时冷静期，冷静期内不得
  // 用于签发恢复票据；丢失走专门恢复流程（挂失立案→站长审批→重新
  // 注册＋冷静期），不降低为只输入密码。
  function mfaOr503(res) {
    if (!deps.mfa || typeof deps.mfa.getFactorStatus !== 'function') {
      fail(res, 503, 'MFA_UNAVAILABLE', '本站 MFA 未配置。');
      return null;
    }
    return deps.mfa;
  }
  function mfaCtx(req) {
    return { ip: clientIp(req), userAgent: String((req.headers && req.headers['user-agent']) || '') };
  }
  async function handleMfaEnrollBegin(req, res) {
    const mfa = mfaOr503(res); if (!mfa) return;
    const a = await consoleAuth(req, res); if (!a) return;
    const body = await passwordConfirm(req, res, a.user, { skipMfa: true }); if (!body) return;
    let out;
    try { out = mfa.beginEnrollment(a.user, mfaCtx(req)); }
    catch (e) {
      if (e && e.code === 'QFR_MFA_ALREADY_ENROLLED') return fail(res, 409, e.code, '该账号已启用 MFA。');
      if (e && e.code === 'QFR_MFA_RECOVERY_REQUIRED') return fail(res, 403, e.code, 'MFA 设备已挂失，须先完成账户恢复流程（站长审批）后再重新注册。');
      throw e;
    }
    return sendJson(res, 200, { ok: true, enrollment_id: out.enrollment_id, method: out.method,
      otpauth_url: out.otpauth_url, secret: out.secret, expires_at: out.expires_at, cooldown_s: out.cooldown_s,
      msg: '请用验证器 App 扫码绑定并确认；secret 只本次返回一次。新注册的 MFA 须经过冷静期后方可用于签发恢复票据。' });
  }
  async function handleMfaEnrollConfirm(req, res) {
    const mfa = mfaOr503(res); if (!mfa) return;
    const a = await consoleAuth(req, res); if (!a) return;
    const body = await passwordConfirm(req, res, a.user, { skipMfa: true }); if (!body) return;
    const enrollmentId = String(body.enrollment_id || '');
    const code = String(body.mfa_code || body.code || '');
    if (!enrollmentId || !code) return fail(res, 400, ERR.VALIDATION, '缺少 enrollment_id 或 MFA 校验码。');
    let out;
    try { out = mfa.confirmEnrollment(a.user, enrollmentId, code, mfaCtx(req)); }
    catch (e) {
      if (e && e.code === 'QFR_MFA_ENROLLMENT_INVALID') return fail(res, 400, e.code, '注册申请不存在或已过期，请重新开始注册。');
      if (e && e.code === 'QFR_MFA_BAD_CODE') return fail(res, 401, 'BAD_MFA', 'MFA 校验码不正确。');
      throw e;
    }
    return sendJson(res, 200, { ok: true, method: out.method, enrolled_at: out.enrolled_at, cooldown_until: out.cooldown_until,
      msg: 'MFA 已启用；冷静期内不得用于签发恢复票据，冷静期结束前请勿删除验证器中的账号。' });
  }
  async function handleMfaVerify(req, res) {
    const mfa = mfaOr503(res); if (!mfa) return;
    const a = await consoleAuth(req, res); if (!a) return;
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    const code = String(body.mfa_code || body.code || '');
    if (!code) return fail(res, 400, 'MFA_CODE_REQUIRED', '缺少 MFA 校验码。');
    let v;
    try { v = mfa.verifyCode(a.user, code); }
    catch (e) {
      if (e && e.code === 'QFR_MFA_NOT_ENROLLED') return fail(res, 403, 'MFA_REQUIRED', '该账号未启用 MFA，请先完成注册。');
      if (e && e.code === 'QFR_MFA_LOST') return fail(res, 403, 'MFA_LOST', 'MFA 设备已挂失，须走账户恢复流程。');
      if (e && e.code === 'QFR_MFA_COOLDOWN') return fail(res, 403, 'MFA_COOLDOWN', '新注册的 MFA 处于冷静期，冷静期结束前不得用于恢复。');
      if (e && e.code === 'QFR_MFA_BAD_CODE') return fail(res, 401, 'BAD_MFA', 'MFA 校验未通过。');
      throw e;
    }
    const rec = mfa.createVerification(a.user, v.method, v.verified_at);
    return sendJson(res, 200, { ok: true, verification_id: rec.verification_id, method: rec.method,
      verified_at: rec.verified_at, expires_at: rec.expires_at, purpose: rec.purpose,
      msg: '验证记录 5 分钟内有效，单次使用；请在有效期内申请恢复票据。' });
  }
  async function handleMfaStatus(req, res) {
    const mfa = mfaOr503(res); if (!mfa) return;
    const a = await consoleAuth(req, res); if (!a) return;
    return sendJson(res, 200, { ok: true, factor: mfa.getFactorStatus(a.user), open_cases: mfa.listOpenCases(a.user) });
  }
  async function handleMfaReportLost(req, res) {
    const mfa = mfaOr503(res); if (!mfa) return;
    const a = await consoleAuth(req, res); if (!a) return;
    const body = await passwordConfirm(req, res, a.user, { skipMfa: true }); if (!body) return;
    let rec;
    try { rec = mfa.reportLost(a.user, mfaCtx(req)); }
    catch (e) {
      if (e && e.code === 'QFR_MFA_NOT_ENROLLED') return fail(res, 400, e.code, '该账号未启用 MFA，无须挂失。');
      throw e;
    }
    return sendJson(res, 200, { ok: true, case_id: rec.case_id, status: rec.status,
      msg: 'MFA 因素已挂失失效。恢复须站长审批通过后重新注册新 MFA（含冷静期），不降低为只输入密码。' });
  }
  async function handleMfaResolve(req, res) {
    const mfa = mfaOr503(res); if (!mfa) return;
    const a = await consoleAuth(req, res); if (!a) return;
    if (typeof deps.isSiteAdmin !== 'function' || !deps.isSiteAdmin(a)) {
      return fail(res, 403, ERR.SCOPE_DENIED, '仅站长可审批 MFA 恢复案件。');
    }
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    const caseId = String(body.case_id || '');
    const decision = String(body.decision || '');
    if (!caseId || (decision !== 'approved' && decision !== 'rejected')) {
      return fail(res, 400, ERR.VALIDATION, 'case_id 与 decision（approved/rejected）必填。');
    }
    let rec;
    try { rec = mfa.resolveCase(caseId, a.user, decision); }
    catch (e) {
      if (e && e.code === 'QFR_MFA_CASE_NOT_FOUND') return fail(res, 404, e.code, '恢复案件不存在。');
      if (e && e.code === 'QFR_MFA_CASE_CLOSED') return fail(res, 409, e.code, '恢复案件已处理。');
      if (e && e.code === 'QFR_VALIDATION') return fail(res, 400, e.code, e.message);
      throw e;
    }
    return sendJson(res, 200, { ok: true, case: { case_id: rec.case_id, account_id: rec.account_id, status: rec.status, resolved_at: rec.resolved_at, resolved_by: rec.resolved_by } });
  }

  // ---- RC-02：吊销即踢在线会话（D7 的 push 升级版） ----
  // 吊销本身已落盘即时生效（admit 立拦）；本 kick 在 5 秒预算内尽力做
  // 设备端踢出（推吊销全集＋发 lea.key_revoked 内部命令）与 job 取消。
  // 设备离线／通道不可达即按台失败记入 kick 摘要，绝不让 kick 失败反噬
  // 吊销响应（吊销已成功）。
  async function kickAfterRevoke(keyIds, deviceIds, accountId, reason) {
    try {
      if (typeof core.kickRevokedSessions !== 'function') return { ok: false, reason: 'kick-unsupported' };
      return await core.kickRevokedSessions(channel, { keyIds, deviceIds, accountId, reason });
    } catch (e) {
      return { ok: false, reason: 'kick-threw', error: String(e && e.message).slice(0, 120) };
    }
  }

  // ---- C1：自助绑定 ----
  // issue：控制台会话签发一次性票据（5 分钟）。不返回 Key 明文。
  async function handleSelfBindIssue(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    const deviceId = String(body.device_id || '');
    const deviceName = String(body.device_name || '');
    const platform = String(body.platform || '');
    const nonce = String(body.nonce || '');
    if (!deviceId) return fail(res, 400, ERR.VALIDATION, '缺少 device_id。');
    let out;
    try {
      out = core.issueSelfBindTicket(a.user, deviceId, { device_name: deviceName, platform, nonce });
    } catch (e) {
      if (e && e.code === 'QFR_LEA_NOT_BOUND') return fail(res, 403, e.code, '该设备尚未绑定到本账号，请先在设备上登录 QFRemote 完成绑定。');
      if (e && e.code === 'QFR_RATE_LIMITED') return fail(res, 429, e.code, '签发过于频繁，请几秒后再试。');
      if (e && e.code === 'QFR_VALIDATION') return fail(res, 400, e.code, e.message);
      throw e;
    }
    return sendJson(res, 200, { ok: true, ticket: out.ticket, challenge: out.challenge, expires_at: out.expires_at, ttl_s: out.ttl_s });
  }
  // complete：只许 USH 调用（票据＋设备 P-256 签名；无控制台会话要求，
  // USH 不是浏览器，没有控制台 cookie）。明文 Key 仅本次响应返回一次。
  async function handleSelfBindComplete(req, res) {
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    let out;
    try {
      out = core.completeSelfBind({
        ticket: String(body.ticket || ''), account_id: String(body.account_id || ''),
        device_id: String(body.device_id || ''), nonce: String(body.nonce || ''),
        device_pubkey: String(body.device_pubkey || ''), signature: String(body.signature || ''),
      });
    } catch (e) {
      if (e && e.code === 'QFR_VALIDATION') return fail(res, 400, e.code, e.message);
      if (e && e.code === 'QFR_TICKET_INVALID') return fail(res, 401, e.code, '绑定票据无效或已过期，请重新点击链接。');
      if (e && e.code === 'QFR_TICKET_REUSED') return fail(res, 401, e.code, '绑定票据已被使用，请重新点击链接。');
      if (e && e.code === 'QFR_TICKET_EXPIRED') return fail(res, 401, e.code, '绑定票据已过期，请重新点击链接。');
      if (e && e.code === 'QFR_TICKET_MISMATCH') return fail(res, 401, e.code, '绑定票据与账号／设备／nonce 不一致。');
      if (e && e.code === 'QFR_DEVICE_SIGNATURE_INVALID') return fail(res, 401, e.code, '设备签名无效。');
      if (e && e.code === 'QFR_MUSE_NOT_AUTHORIZED') return fail(res, 403, e.code, '该账号未授权 Muse 操作。');
      if (e && e.code === 'QFR_DEVICE_SCOPE_REQUIRED') return fail(res, 400, e.code, '设备绑定异常，请重新登录后再链接。');
      throw e;
    }
    return sendJson(res, 200, { ok: true, key: out.key, record: out.record, binding_epoch: out.binding_epoch, msg: '已链接。请妥善保存：凭据只返回这一次。' });
  }
  // status：SPA 轮询（控制台会话）；只返回状态／设备名／有效期，不含凭据。
  async function handleSelfBindStatus(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const u = new URL(req.url, 'http://localhost');
    const deviceId = String(u.searchParams.get('device_id') || '');
    if (!deviceId) return fail(res, 400, ERR.VALIDATION, '缺少 device_id。');
    return sendJson(res, 200, Object.assign({ ok: true }, core.selfBindStatus(a.user, deviceId)));
  }
  // renew：设备续期。Bearer Key 鉴权（含时间戳／nonce 防重放）＋设备签名。
  // 续期时间戳须与 header 时间戳一致（防 body 时间戳与签名时间戳脱钩）。
  async function handleSelfBindRenew(req, res) {
    const auth = bearerAuth(req);
    if (!auth.ok) return fail(res, auth.status, auth.code, auth.msg);
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    const tsHeader = Number(req.headers['x-qfr-timestamp'] || req.headers['X-QFR-Timestamp']);
    const nonceHeader = String(req.headers['x-qfr-nonce'] || req.headers['X-QFR-Nonce'] || '');
    if (!Number.isFinite(tsHeader) || Number(body.timestamp) !== tsHeader) {
      return fail(res, 400, ERR.VALIDATION, 'timestamp 须与 X-QFR-Timestamp 一致。');
    }
    let out;
    try {
      out = core.renewSelfBindKey({
        key_id: auth.key.key_id, device_id: String(body.device_id || ''),
        nonce: nonceHeader, timestamp: tsHeader, signature: String(body.signature || ''),
      });
    } catch (e) {
      if (e && e.code === 'QFR_VALIDATION') return fail(res, 400, e.code, e.message);
      if (e && e.code === 'QFR_SCOPE_DENIED') return fail(res, 403, e.code, e.message);
      if (e && e.code === 'QFR_API_KEY_REVOKED') return fail(res, 401, e.code, 'Key 已吊销或已过期，请重新链接。');
      if (e && e.code === 'QFR_REPLAY_DETECTED') return fail(res, 401, e.code, '请求时间戳超出允许窗口。');
      if (e && e.code === 'QFR_LEA_NOT_BOUND') return fail(res, 403, e.code, '设备绑定或设备密钥缺失，请重新链接。');
      if (e && e.code === 'QFR_GRANT_REVOKED') return fail(res, 403, e.code, '授权已被撤销，请重新链接。');
      if (e && e.code === 'QFR_DEVICE_SIGNATURE_INVALID') return fail(res, 401, e.code, '设备签名无效。');
      if (e && e.code === 'QFR_NOT_RENEWABLE') {
        return sendJson(res, 409, { ok: false, code: e.code, msg: '尚未到续期窗口。', renewable_at: e.renewable_at || null });
      }
      throw e;
    }
    return sendJson(res, 200, { ok: true, record: out.record });
  }
  // 自助吊销（无密码二次确认，只限 self_bind Key；控制台 Key 仍走原密码路径）。
  async function handleSelfBindRevoke(req, res, keyId) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const out = core.revokeSelfBindKey(a.user, keyId);
    if (!out.ok) {
      if (out.code === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Key 不存在。');
      return fail(res, 403, out.code || 'QFR_SCOPE_DENIED', '该 Key 不支持自助吊销（仅自助链接生成的 Key 可在此吊销）。');
    }
    const kick = await kickAfterRevoke(out.revoked_key_ids || [keyId],
      out.record && out.record.device_scope ? [out.record.device_scope] : null, a.user, 'self-bind-revoke');
    return sendJson(res, 200, { ok: true, record: out.record, kick });
  }
  async function handleSelfBindRevokeAll(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const out = core.revokeAllSelfBindKeys(a.user);
    const kick = await kickAfterRevoke(out.revoked_key_ids || [], null, a.user, 'self-bind-revoke-all');
    return sendJson(res, 200, { ok: true, revoked_count: out.revoked_count, kick, msg: '该账号全部自助链接密钥已吊销。' });
  }

  // ---- RC-04：断线重连票据 ----
  // issue：Bearer Key 优先（不强制防重放头：签发本身 5 秒限流＋签发即
  // 作废同 session 旧票（只留最新），重放签发请求只会再得一张新票据，
  // 不扩大授权；L3 经 extRequest 调用时不一定带 X-QFR-Timestamp／Nonce）；无 Authorization 头时接受
  // 有效控制台会话（规范 §3.1 第 1 条）。已出示 Bearer 但无效时不回落
  // 到控制台会话，401 fail-closed。
  // 控制台会话路径下 Key 的确定：取该账号在该设备上最近创建的在用 Key
  // （device_scope 一致；无在用 Key → 403；多张取最新一张——控制台
  // 会话即账号本人，选其名下在用 Key 不扩大授权）。
  async function handleReconnectIssue(req, res) {
    const headers = req.headers || {};
    const hasBearer = typeof headers.authorization === 'string' && /^Bearer\s+/i.test(headers.authorization) ||
      typeof headers.Authorization === 'string' && /^Bearer\s+/i.test(headers.Authorization);
    let accountId, keyId, keySelection;
    if (hasBearer) {
      const auth = core.authenticate(headers, { requireReplayHeaders: false });
      if (!auth.ok) return fail(res, auth.status, auth.code, auth.msg);
      accountId = auth.key.account_id;
      keyId = auth.key.key_id;
      keySelection = 'bearer';
    } else {
      const a = await consoleAuth(req, res);
      if (!a) return;
      accountId = a.user;
      const body0 = await readJsonBody(req, BODY_LIMIT);
      if (body0.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
      req._reconnectIssueBody = body0;
      const did0 = bareNodeId(String(body0.device_id || ''));
      if (!did0) return fail(res, 400, ERR.VALIDATION, '缺少 device_id。');
      const cands = core.listKeys(accountId)
        .filter((k) => k && k.status === 'active' && k.device_scope && bareNodeId(k.device_scope) === did0)
        .sort((x, y) => (y.created_at || 0) - (x.created_at || 0));
      if (!cands.length) return fail(res, 403, ERR.NOT_BOUND, '该设备没有在用的 LEA Key，请先链接后再申领重连票据。');
      keyId = cands[0].key_id;
      // R-复核 (h)：多 Key 并存时取最新一张（控制台会话即账号本人，候选
      // Key 全属该账号该设备，且随后 admit 全量准入，不扩大授权；取哪张
      // 记审计 key_selection，不静默）。改显式 key_id 会断 L3 控制台路径
      // （L3 只带控制台 cookie、无 key_id 可传），故保留自动选择。
      keySelection = 'console-auto-latest';
    }
    const body = req._reconnectIssueBody || await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    const deviceId = String(body.device_id || '');
    const sessionId = String(body.session_id || '');
    if (!deviceId) return fail(res, 400, ERR.VALIDATION, '缺少 device_id。');
    if (!sessionId) return fail(res, 400, ERR.VALIDATION, '缺少 session_id。');
    let ticket;
    try {
      ticket = core.issueReconnectTicket({ accountId, deviceId, keyId, sessionId }, { keySelection });
    } catch (e) {
      if (e && e.code === 'QFR_VALIDATION') return fail(res, 400, e.code, e.message);
      if (e && e.code === 'QFR_RATE_LIMITED') return fail(res, 429, e.code, '签发过于频繁，请几秒后再试。');
      if (e && e.code === 'QFR_SIGNING_NOT_REAL') return fail(res, 503, e.code, '服务端签名能力未就绪，无法签发重连票据。');
      if (e && e.code === 'QFR_API_KEY_REVOKED') return fail(res, 401, e.code, 'Key 已吊销或已过期，请重新链接。');
      if (e && e.code) return fail(res, (e.status && Number.isInteger(e.status)) ? e.status : 403, e.code, e.message);
      throw e;
    }
    // 直接返回票据 JSON 全文（L3 validateTicket 按顶层 10 字段校验，
    // 不包 { ok, ticket } 壳）。票据明文只在此响应出现一次。
    return sendJson(res, 200, ticket);
  }
  // resume：body 即票据 JSON 全文，不走 Bearer（票据本身就是 bearer）。
  // 成功只做票据核验＋返回 epochs；握手重建在下一次业务下发时由
  // ensureHandshake 按核验返回的 epochs 做（RC-04 (d)），本端点不下发
  // sys.handshake（设备可能离线，下发必失败）。失败码按规范 §3.2／§4。
  async function handleReconnectResume(req, res) {
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    let out;
    try {
      out = core.verifyReconnectTicket(body);
    } catch (e) {
      if (e && e.code === 'QFR_TICKET_INVALID') return fail(res, 401, e.code, '重连票据无效，请重新登录。');
      if (e && e.code === 'QFR_TICKET_REUSED') return fail(res, 401, e.code, '重连票据已被使用，请重新登录。');
      if (e && e.code === 'QFR_TICKET_EXPIRED') return fail(res, 401, e.code, '重连票据已过期，请重新登录。');
      if (e && e.code === 'QFR_API_KEY_REVOKED') return fail(res, 401, e.code, 'Key 已吊销或已过期，请重新链接。');
      if (e && e.code === 'QFR_GRANT_REVOKED') return fail(res, 403, e.code, '授权已被撤销，请重新链接。');
      if (e && e.code === 'QFR_BINDING_CHANGED') return fail(res, 409, e.code, '设备已换绑，请重新链接。');
      if (e && e.code === 'QFR_VALIDATION') return fail(res, 400, e.code, e.message);
      throw e;
    }
    return sendJson(res, 200, {
      ok: true, session_id: out.session_id, device_id: out.device_id,
      binding_epoch: out.binding_epoch, grant_epoch: out.grant_epoch,
    });
  }

  // ---- 授权授予/撤销（站长） ----
  async function handleGrants(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    if (typeof deps.isSiteAdmin !== 'function' || !deps.isSiteAdmin(a)) {
      return fail(res, 403, 'FORBIDDEN', '只有站长可以授予/撤销 Muse 操作授权。');
    }
    const body = await readJsonBody(req, BODY_LIMIT);
    const target = String(body.account_id || '');
    const action = String(body.action || '');
    if (!target) return fail(res, 400, ERR.VALIDATION, '缺少 account_id。');
    if (action === 'grant') {
      // H06：站长授予时可带 dangerous: true，一并授予 dangerous 授权
      // （生成 dangerous scope 的 Key 的前置条件）；不带则只授基础授权，
      // 既有 dangerous 值保留（见 grantMuse）。
      const dg = body.dangerous === true ? true : (body.dangerous === false ? false : undefined);
      const out = core.grantMuse(target, a.user, { dangerous: dg });
      return sendJson(res, 200, { ok: true, account_id: target, grant_epoch: out.grant_epoch, dangerous: out.dangerous });
    }
    if (action === 'revoke') {
      const out = core.revokeGrant(target, a.user);
      if (!out.ok) return fail(res, 404, 'NOT_FOUND', '该账号没有在效授权。');
      const kick = await kickAfterRevoke(out.revoked_key_ids || [], null, target, 'grant-revoked');
      return sendJson(res, 200, { ok: true, account_id: target, grant_epoch: out.grant_epoch, kick });
    }
    return fail(res, 400, ERR.VALIDATION, 'action 须为 grant 或 revoke。');
  }

  // ---- 换绑（触发旧 Key 失效，§7.4） ----
  async function handleRebind(req, res, deviceId) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const body = await readJsonBody(req, BODY_LIMIT);
    const accountId = String(body.account_id || a.user);
    const isAdmin = typeof deps.isSiteAdmin === 'function' && deps.isSiteAdmin(a);
    if (accountId !== a.user && !isAdmin) {
      return fail(res, 403, 'FORBIDDEN', '只能绑定自己的账号。');
    }
    // H05：换绑验设备归属／节点可见性（此前只验“绑自己或站长”，任意登录
    // 用户知道 device_id 就能把他人设备抢到自己名下并吊销原账号全部 Key）：
    // ① 节点可见性（D2 强制注入 deps.listVisibleDeviceIds(auth, req)：
    //    返回该账号在 MeshCentral 可见的设备 id 清单，server.js 以控制台
    //    会话 cookie 查 MeshCentral nodes。未注入／查询抛错／返回非数组
    //    时一律 503 QFR_VISIBILITY_UNAVAILABLE，不得放行；清单取回成功
    //    但不含该设备时 403。清单与入参均按裸 id 归一后比对（客户端送裸
    //    id，清单可能含全形 _id；r5 潜伏问题）。
    if (typeof deps.listVisibleDeviceIds !== 'function') {
      try { core.audit('lea-rebind-denied', { device_id: deviceId, account_id: accountId, by: a.user, reason: 'visibility-unavailable' }); } catch (e) {}
      return fail(res, 503, 'QFR_VISIBILITY_UNAVAILABLE', '设备可见性查询未就绪。');
    }
    let visible;
    try { visible = await deps.listVisibleDeviceIds(a, req); } catch (e) { visible = null; }
    if (!Array.isArray(visible)) {
      try { core.audit('lea-rebind-denied', { device_id: deviceId, account_id: accountId, by: a.user, reason: 'visibility-unavailable' }); } catch (e) {}
      return fail(res, 503, 'QFR_VISIBILITY_UNAVAILABLE', '设备可见性查询失败。');
    }
    if (!visible.map((v) => bareNodeId(String(v))).includes(bareNodeId(deviceId))) {
      try { core.audit('lea-rebind-denied', { device_id: deviceId, account_id: accountId, by: a.user, reason: 'not-visible' }); } catch (e) {}
      return fail(res, 403, 'FORBIDDEN', '设备不在该账号可见范围内。');
    }
    // ② 设备须真实存在（svc 通道节点清单里有；未知 id 直接 404，不透露归属）。
    //    比对前统一去 node// 前缀（客户端送裸 id，清单 _id 为全形；修前
    //    只比全形 _id，裸 id 即使节点可见也 404——r5 潜伏问题）。
    //    D2 修订（GPT 六项裁决 D1-2）：通道不可达（known===null）时不得
    //    跳过存在性校验继续换绑——“记审计”不能替代验证；无其他独立可信
    //    权威数据源确认设备归属／存在性时，一律 503
    //    QFR_VISIBILITY_UNAVAILABLE、不换绑（fail-closed）。
    let known = null;
    try {
      const nodes = channel ? await channel.listNodes() : [];
      known = (nodes || []).some((x) => nodeMatchesId(x, deviceId));
    } catch (e) { known = null; }
    if (known === false) {
      return fail(res, 404, 'NOT_FOUND', '设备不存在。');
    }
    if (known === null) {
      try { core.audit('lea-rebind-denied', { device_id: deviceId, account_id: accountId, by: a.user, reason: 'existence-unverifiable-channel-down' }); } catch (e) {}
      return fail(res, 503, 'QFR_VISIBILITY_UNAVAILABLE', '设备存在性无法验证（通道不可达），暂不换绑。');
    }
    // ③ 设备归属：当前已绑定他人账号时，非站长不得换绑（DESIGN §6.1
    //    “不一致则进入待站长授权，防冒领”）；未绑定／绑自己时放行。
    const cur = core.getBinding(deviceId);
    if (cur && cur.account_id !== accountId && !isAdmin) {
      try { core.audit('lea-rebind-denied', { device_id: deviceId, account_id: accountId, by: a.user, current_account_id: cur.account_id, reason: 'bound-to-other' }); } catch (e) {}
      return fail(res, 403, 'FORBIDDEN', '该设备已绑定其他账号，只有站长可以换绑。');
    }
    // H07：hook 传回 LEA 的 PENDING epoch（binding_epoch），服务端只许向前。
    const clientEpoch = Number.isSafeInteger(body.binding_epoch) ? body.binding_epoch : undefined;
    const out = core.recordBinding(deviceId, accountId, 'manual-rebind', { bindingEpoch: clientEpoch });
    // H21：换绑响应带本次吊销的 key_id 与本机吊销表应有的全集快照
    // （调用方／客户端据此核对本机 revoked_keys.txt 是否已同步）。
    // #1 版本化：快照带 generation（revocations.generation，顶层
    // revocation_generation 同值），永不回退（见 lea-core.js
    // getRevocations 高水位）；旧版服务端回包无 generation 字段时，
    // 客户端须按缺失处理（只做无版本并集合并，不推进本机 generation），
    // 绝不把缺失静默当成最新——见 windows/main.js notifyLeaLogin。
    const revocations = core.getRevocations(deviceId);
    // A7-whitelist：rebind 回包带吊销快照签名（C 端 keys.sync-revoked
    // 验签用；只签当前权威台账快照）。签发失败时不带签名、不阻断
    // rebind——C 端缺签即拒绝 sync，H21 推送仍是主同步路径。
    try { revocations.sync_signature = core.signRevokedSync(deviceId); } catch (e) {
      try { core.audit('lea-revocation-sign-failed', { device_id: deviceId, err: String(e && e.message).slice(0, 120) }); } catch (_) {}
    }
    // RC-02：换绑吊销了旧 Key 时即踢其会话（仅有旧 Key 被吊销时才做，
    // 首次绑定／同账号重绑无吊销即不加延迟）。
    const kick = (out.revoked_key_ids && out.revoked_key_ids.length)
      ? await kickAfterRevoke(out.revoked_key_ids, [deviceId], accountId, 'rebind')
      : { ok: true, skipped: 'no-revoked-keys' };
    return sendJson(res, 200, { ok: true, device_id: out.device_id, account_id: out.account_id, binding_epoch: out.binding_epoch, revoked_keys: out.revoked_keys, revoked_key_ids: out.revoked_key_ids || [], revocations, revocation_generation: revocations.generation, ticket: out.ticket, kick });
  }

  // ---- 登录证明（v3 P0-4 第二层，B3 主方案） ----
  // 控制台会话认证；账号恒等于 a.user（无站长代签口子）；设备可见性复用
  // rebind 的①②（节点可见性＋节点存在性）；不做已绑他人检查（证明≠绑
  // 定，绑定决策仍在 rebind）。D2：① 为强制注入，未注入／查询失败时
  // 503 QFR_VISIBILITY_UNAVAILABLE。签名能力非 real 时 503。证明 TTL
  // 120 秒，客户端须立即使用；证明字段原样回给客户端，由客户端 JSON 序
  // 列化后随 login_changed 发给本机 QFRLEA 验签。
  async function handleLoginAttestation(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const body = await readJsonBody(req, BODY_LIMIT);
    const deviceId = bareNodeId(String(body.device_id || ''));
    if (!deviceId) return fail(res, 400, ERR.VALIDATION, 'device_id 必填。');
    // ① 节点可见性（D2 强制注入 deps.listVisibleDeviceIds(auth, req)：
    //    server.js 以控制台会话 cookie 查 MeshCentral nodes。未注入／查
    //    询抛错／返回非数组时一律 503 QFR_VISIBILITY_UNAVAILABLE，不得放
    //    行；清单取回成功但不含该设备时 403。GPT D1–D4 裁决 §三建议依赖
    //    缺失走 503；v3 原契约 403，待 GPT 最终裁决确认（见 D2 报告 §7）。
    if (typeof deps.listVisibleDeviceIds !== 'function') {
      try { core.audit('lea-login-attestation-denied', { device_id: deviceId, account_id: a.user, by: a.user, reason: 'visibility-unavailable' }); } catch (e) {}
      return fail(res, 503, 'QFR_VISIBILITY_UNAVAILABLE', '设备可见性查询未就绪。');
    }
    let visible;
    try { visible = await deps.listVisibleDeviceIds(a, req); } catch (e) { visible = null; }
    if (!Array.isArray(visible)) {
      try { core.audit('lea-login-attestation-denied', { device_id: deviceId, account_id: a.user, by: a.user, reason: 'visibility-unavailable' }); } catch (e) {}
      return fail(res, 503, 'QFR_VISIBILITY_UNAVAILABLE', '设备可见性查询失败。');
    }
    if (!visible.map((v) => bareNodeId(String(v))).includes(bareNodeId(deviceId))) {
      try { core.audit('lea-login-attestation-denied', { device_id: deviceId, account_id: a.user, by: a.user, reason: 'not-visible' }); } catch (e) {}
      return fail(res, 403, 'FORBIDDEN', '设备不在该账号可见范围内。');
    }
    // ② 设备须真实存在（通道节点清单里有；未知 id 直接 404）。
    //    D2 修订（GPT 六项裁决 D1-2）：通道不可达（known===null）时不得
    //    跳过存在性校验继续签发——“记审计”不能替代验证；无其他独立可信
    //    权威数据源确认设备归属／存在性时，一律 503
    //    QFR_VISIBILITY_UNAVAILABLE、不签发（fail-closed）。
    let known = null;
    try {
      const nodes = channel ? await channel.listNodes() : [];
      known = (nodes || []).some((x) => nodeMatchesId(x, deviceId));
    } catch (e) { known = null; }
    if (known === false) {
      return fail(res, 404, 'NOT_FOUND', '设备不存在。');
    }
    if (known === null) {
      try { core.audit('lea-login-attestation-denied', { device_id: deviceId, account_id: a.user, by: a.user, reason: 'existence-unverifiable-channel-down' }); } catch (e) {}
      return fail(res, 503, 'QFR_VISIBILITY_UNAVAILABLE', '设备存在性无法验证（通道不可达），暂不签发证明。');
    }
    let out;
    try {
      out = core.issueLoginAttestation(a.user, deviceId);
    } catch (e) {
      if (e && e.message && String(e.message).startsWith('LEA canonical field invalid')) return fail(res, 400, ERR.VALIDATION, '字段非法。');
      if (e && e.code === 'QFR_SIGNING_UNAVAILABLE') return fail(res, 503, 'LEA_SIGNING_UNAVAILABLE', '服务端签名能力未就绪。');
      throw e;
    }
    return sendJson(res, 200, Object.assign({ ok: true }, out));
  }

  // ---- 卸载注销（2026-11-14 站长亲定；固定契约见 lea-core deregisterDevice） ----
  // 验签（绑定须 ACTIVE、账号匹配、device_id 与路径一致）→ 删绑定＋该设备
  // 自助票据 → 尽力删 MeshCentral 节点记录 → 审计 lea-deregistered。
  // 红线：付费 LEA 密钥、其他设备绑定、账号、grant、审计一律不动；
  // 节点删不掉（通道不可达／节点已不在／权限不足）时登记留着、照常返回
  // 成功，卸载不阻断；已注销过凭墓碑验签后幂等成功。
  async function handleDeregister(req, res, deviceIdPath) {
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body.__tooLarge) return fail(res, 400, ERR.VALIDATION, '请求体过大。');
    const deviceId = bareNodeId(String(body.device_id || ''));
    if (!deviceId || bareNodeId(deviceIdPath) !== deviceId) {
      return fail(res, 400, ERR.VALIDATION, 'device_id 须与路径一致。');
    }
    let out;
    try {
      out = core.deregisterDevice({
        account_id: String(body.account_id || ''), device_id: deviceId,
        nonce: String(body.nonce || ''), timestamp: Number(body.timestamp),
        signature: String(body.signature || ''),
      });
    } catch (e) {
      if (e && e.code === 'QFR_VALIDATION') return fail(res, 400, e.code, e.message);
      if (e && e.code === 'QFR_REPLAY_DETECTED') return fail(res, 401, e.code, '请求时间戳超出允许窗口或 nonce 已使用。');
      if (e && e.code === 'QFR_DEVICE_SIGNATURE_INVALID') return fail(res, 401, e.code, '设备签名无效。');
      throw e;
    }
    // 删 MeshCentral 节点记录（best-effort）：失败只记审计，不改响应。
    // 节点删除走 control.ashx removedevices（见 lea-channel.deleteNode）；
    // 卸载端已先清本地状态，节点断不断开不影响本次 HTTP 响应。
    if (channel && typeof channel.deleteNode === 'function') {
      try {
        const r = await channel.deleteNode(deviceId);
        if (!r || r.ok !== true) {
          try { core.audit('lea-deregistered-node-delete-failed', { account_id: out.account_id, device_id: deviceId, already: out.already, result: String((r && r.result) || 'unknown') }); } catch (e) {}
        }
      } catch (e) {
        try { core.audit('lea-deregistered-node-delete-failed', { account_id: out.account_id, device_id: deviceId, already: out.already, result: 'channel-error:' + String((e && e.message) || e).slice(0, 120) }); } catch (e2) {}
      }
    } else {
      log({ ev: 'lea-deregister-no-delete-node', device_id: deviceId });
    }
    return sendJson(res, 200, { ok: true, deregistered: true });
  }

  // ---- 查本机吊销表应有快照（H21） ----
  // 返回服务端台账里该设备的吊销 key_id 全集＋推送进度；供控制台／客户端
  // 核对本机 revoked_keys.txt。只读，不触发推送（推送发生在下次下发）。
  async function handleRevocations(req, res, deviceId) {
    const auth = bearerAuth(req);
    if (!auth.ok) return fail(res, auth.status, auth.code, auth.msg);
    const key = auth.key;
    if (!deviceVisibleTo(key, deviceId)) {
      return fail(res, 403, ERR.SCOPE_DENIED, '该 Key 不能查看此设备吊销表。');
    }
    return sendJson(res, 200, Object.assign({ ok: true }, core.getRevocations(deviceId)));
  }

  // ---- 总入口：server.js 只调这一处 ----
  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    if (!p.startsWith('/api/lea/v1/')) return false;
    if (!core) { fail(res, 503, 'LEA_UNAVAILABLE', 'LEA 服务端模块未加载。'); return true; }
    const jobM = p.match(/^\/api\/lea\/v1\/jobs\/([^/]+)$/);
    const cancelM = p.match(/^\/api\/lea\/v1\/jobs\/([^/]+)\/cancel$/);
    const devM = p.match(/^\/api\/lea\/v1\/devices\/([^/]+)\/status$/);
    const rebindM = p.match(/^\/api\/lea\/v1\/devices\/([^/]+)\/rebind$/);
    const deregM = p.match(/^\/api\/lea\/v1\/devices\/([^/]+)\/deregister$/);
    const revocM = p.match(/^\/api\/lea\/v1\/devices\/([^/]+)\/revocations$/);
    const revokeM = p.match(/^\/api\/lea\/v1\/keys\/([^/]+)\/revoke$/);
    const sbRevokeM = p.match(/^\/api\/lea\/v1\/self-bind\/revoke\/([^/]+)$/);
    try {
      if (req.method === 'POST' && p === '/api/lea/v1/execute') { await handleExecute(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/batches') { await handleBatches(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/reconnect/issue') { await handleReconnectIssue(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/reconnect/resume') { await handleReconnectResume(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/crash-report') { await handleCrashReport(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/self-bind/issue') { await handleSelfBindIssue(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/login-attestation') { await handleLoginAttestation(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/self-bind/complete') { await handleSelfBindComplete(req, res); return true; }
      if (req.method === 'GET' && p === '/api/lea/v1/self-bind/status') { await handleSelfBindStatus(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/self-bind/renew') { await handleSelfBindRenew(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/self-bind/revoke-all') { await handleSelfBindRevokeAll(req, res); return true; }
      if (req.method === 'POST' && sbRevokeM) { await handleSelfBindRevoke(req, res, decodeURIComponent(sbRevokeM[1])); return true; }
      if (req.method === 'GET' && jobM) { await handleGetJob(req, res, decodeURIComponent(jobM[1])); return true; }
      if (req.method === 'POST' && cancelM) { await handleCancelJob(req, res, decodeURIComponent(cancelM[1])); return true; }
      if (req.method === 'GET' && devM) { await handleDeviceStatus(req, res, decodeURIComponent(devM[1])); return true; }
      if (req.method === 'GET' && revocM) { await handleRevocations(req, res, decodeURIComponent(revocM[1])); return true; }
      if (req.method === 'POST' && rebindM) { await handleRebind(req, res, decodeURIComponent(rebindM[1])); return true; }
      if (req.method === 'POST' && deregM) { await handleDeregister(req, res, decodeURIComponent(deregM[1])); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/keys') { await handleCreateKey(req, res); return true; }
      if (req.method === 'GET' && p === '/api/lea/v1/keys') { await handleListKeys(req, res); return true; }
      if (req.method === 'POST' && revokeM) { await handleRevokeKey(req, res, decodeURIComponent(revokeM[1])); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/keys/revoke-all') { await handleRevokeAllKeys(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/emergency-stop/sync') { await handleEmergencyStopSync(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/emergency-stop/recovery-ticket') { await handleRecoveryTicket(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/mfa/enroll/begin') { await handleMfaEnrollBegin(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/mfa/enroll/confirm') { await handleMfaEnrollConfirm(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/mfa/verify') { await handleMfaVerify(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/mfa/status') { await handleMfaStatus(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/mfa/report-lost') { await handleMfaReportLost(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/mfa/recovery/resolve') { await handleMfaResolve(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/grants') { await handleGrants(req, res); return true; }
      return fail(res, 404, 'NOT_FOUND', '该接口不存在。'), true;
    } catch (e) {
      log({ ev: 'lea-handler-error', err: String(e && e.message) });
      try { fail(res, 500, 'LEA_ERROR', 'LEA 服务暂时出现问题。'); } catch (e2) {}
      return true;
    }
  }

  return { handle };
}

module.exports = { createLeaRoutes };
