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
 *   deps.verifyMfa(username, code) -> Promise<boolean>（可选；
 *     未注入时表示本站暂无 MFA 校验入口，生成 Key 仅凭密码二次确认，
 *     见 README「未完成/须联调」）
 *   deps.resolveConsoleAuth(req) -> Promise<{user, siteadmin}|null>
 *     （控制台会话校验，复用 validateConsoleCookie）
 *   deps.isSiteAdmin(auth) -> boolean（复用 isAdmin）
 * deps 缺失时对应接口 fail-closed（503/401），绝不放行。
 *
 * 路由（DESIGN §8.1）：
 *   POST /api/lea/v1/execute            单条命令
 *   POST /api/lea/v1/batches            批量
 *   GET  /api/lea/v1/jobs/{job_id}      查长任务
 *   POST /api/lea/v1/jobs/{job_id}/cancel 取消任务
 *   GET  /api/lea/v1/devices/{device_id}/status 查设备状态
 *   POST /api/lea/v1/keys               生成 Key（控制台会话＋密码二次确认）
 *   GET  /api/lea/v1/keys               列表（只显 key_id/前缀/时间/状态）
 *   POST /api/lea/v1/keys/{key_id}/revoke 吊销单个
 *   POST /api/lea/v1/keys/revoke-all    一键吊销全部
 *   POST /api/lea/v1/grants             站长授予/撤销 muse.execute
 *   POST /api/lea/v1/devices/{device_id}/rebind 换绑（触发旧 Key 失效）
 */
const crypto = require('crypto');

const BODY_LIMIT = 1024 * 1024; // 执行请求体上限 1MB（信封 params 含文本时用）
const MAX_BATCH_STEPS = 50;

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
  function clientIp(req) {
    const xff = req.headers && req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || null;
  }
  function auditCall(fields) { try { core.audit('lea-call', fields); } catch (e) {} }

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
      device_id: deviceId, api_key_id: key.key_id, key_prefix: key.prefix ? key.prefix.slice(0, 8) + '…' + key.prefix.slice(-4) : '',
      binding_epoch: key.binding_epoch, command, idempotency_key: idemKey, ip: clientIp(req),
    };
    // 幂等：已完成返回缓存结果不重复执行；执行中返回 DUPLICATE_IN_PROGRESS。
    const prev = core.idemLookup(key.account_id, key.key_id, idemKey);
    if (prev && prev.status === 'RUNNING') return fail(res, 409, ERR.DUPLICATE, '同一幂等键的命令正在执行中。');
    if (prev && prev.status === 'SUCCEEDED') {
      return sendJson(res, 200, Object.assign({ ok: true, duplicate: true, request_id: requestId }, prev.result || {}));
    }
    if (prev && prev.status === 'FAILED') {
      return sendJson(res, 200, Object.assign({ ok: false, duplicate: true, request_id: requestId }, prev.result || {}));
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
    // timeout_ms 显式存在但非法（null、非数字、非整数、<1、>上限）即 400，
    // 不得 clamp 成合法值再签名（规范 §2.2）；缺失时取命令默认值。
    // 显式存在判定用 !== undefined：null 是显式非法值，不是缺失。
    let timeoutMs = spec.timeoutMs;
    if (body.timeout_ms !== undefined) {
      if (typeof body.timeout_ms !== 'number' || !Number.isInteger(body.timeout_ms) || body.timeout_ms < 1 || body.timeout_ms > spec.maxTimeoutMs) {
        return fail(res, 400, ERR.VALIDATION, 'timeout_ms 须为 1..' + spec.maxTimeoutMs + ' 的整数。');
      }
      timeoutMs = body.timeout_ms;
    }
    const job = core.createJob({
      account_id: key.account_id, device_id: deviceId, api_key_id: key.key_id,
      command, request_id: requestId, idempotency_key: idemKey, status: 'RUNNING',
    });
    core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'RUNNING', job_id: job.job_id, dangerous: spec.dangerous });
    const env = core.buildEnvelope({
      requestId, batchId: null, seq: 1, deviceId, accountId: key.account_id,
      keyId: key.key_id, bindingEpoch: adm.binding.binding_epoch,
      idempotencyKey: idemKey, command, params, timeoutMs,
    });
    const t0 = Date.now();
    let disp;
    try {
      disp = channel ? await core.dispatchEnvelope(channel, env, { timeoutMs: 5000 }) : { ok: false, error: new Error('no-channel') };
    } catch (e) { disp = { ok: false, error: e }; }
    const durationMs = Date.now() - t0;
    if (disp.ok) {
      core.updateJob(job.job_id, { status: 'SUCCEEDED', result: disp.result });
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'SUCCEEDED', job_id: job.job_id, dangerous: spec.dangerous, result: { job_id: job.job_id, result: disp.result } });
      auditCall(Object.assign({}, baseAudit, { result: 'ok', job_id: job.job_id, duration_ms: durationMs }));
      try { core.audit('lea-deliver', Object.assign({}, baseAudit, { job_id: job.job_id, direction: 'reply', duration_ms: durationMs })); } catch (e) {}
      return sendJson(res, 200, { ok: true, request_id: requestId, job_id: job.job_id, result: disp.result, duration_ms: durationMs });
    }
    if (disp.timeout) {
      // 同步等待 5s 超时 → 202 + job_id，长任务异步（结果 UNKNOWN，须查 job/快照确认）。
      core.updateJob(job.job_id, { status: 'UNKNOWN', error_code: ERR.UNKNOWN });
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'RUNNING', job_id: job.job_id, dangerous: spec.dangerous });
      auditCall(Object.assign({}, baseAudit, { result: 'timeout-async', job_id: job.job_id, error_code: ERR.UNKNOWN, duration_ms: durationMs }));
      return sendJson(res, 202, { ok: true, async: true, request_id: requestId, job_id: job.job_id, status: 'UNKNOWN', code: ERR.UNKNOWN, msg: '执行超时，已转异步任务；结果未知，请用 job_id 查询或快照确认，勿直接重试危险操作。' });
    }
    core.updateJob(job.job_id, { status: 'FAILED', error_code: 'QFR_LEA_DISPATCH_FAILED' });
    core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, dangerous: spec.dangerous, result: { job_id: job.job_id, code: 'QFR_LEA_DISPATCH_FAILED' } });
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
    // 步级 request_id／幂等键为基础值加 '-N' 后缀：基础值须给后缀留出长度，
    // 否则步级键超 128 字符、buildEnvelope 抛错变 500（如 128 字符基础键 + '-2' = 130）。
    const batchSuffixLen = 1 + String(steps.length).length;
    if (idemKey.length + batchSuffixLen > 128 || requestId.length + batchSuffixLen > 128) {
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
    const batchId = 'batch_' + crypto.randomBytes(8).toString('hex');
    const job = core.createJob({
      account_id: key.account_id, device_id: deviceId, api_key_id: key.key_id,
      batch_id: batchId, request_id: requestId, idempotency_key: idemKey,
      status: 'RUNNING', steps_total: steps.length, steps_done: 0, results: [],
    });
    // 后台顺序执行；同步等待 5s，超时即 202 + job_id（继续后台跑完）。
    const startedAt = Date.now();
    const run = (async () => {
      const results = [];
      for (let i = 0; i < steps.length; i++) {
        const cur = core.getJob(job.job_id);
        if (cur && cur.status === 'CANCELLED') { results.push({ seq: i + 1, cancelled: true }); break; }
        const st = steps[i] || {};
        const command = String(st.command || '');
        const spec = core.COMMANDS[command];
        if (!spec) { results.push({ seq: i + 1, command, ok: false, code: ERR.VALIDATION }); break; }
        const adm = core.admit({ key, deviceId, command, requestId, ip: clientIp(req) });
        if (!adm.ok) { results.push({ seq: i + 1, command, ok: false, code: adm.code }); break; }
        const env = core.buildEnvelope({
          // 步级 request_id／幂等键用 '-' 连接步号：':' 不合 token 规则
          //（C 端解析层拒绝），旧 ':' 形态的批量信封到 LEA 即被拒。
          requestId: requestId + '-' + (i + 1), batchId, seq: i + 1, deviceId,
          accountId: key.account_id, keyId: key.key_id, bindingEpoch: adm.binding.binding_epoch,
          idempotencyKey: idemKey + '-' + (i + 1), command, params: st.params || {},
          timeoutMs: st.timeout_ms !== undefined ? st.timeout_ms : spec.timeoutMs,
        });
        let disp;
        try { disp = channel ? await core.dispatchEnvelope(channel, env, { timeoutMs: 5000 }) : { ok: false, error: new Error('no-channel') }; }
        catch (e) { disp = { ok: false, error: e }; }
        if (disp.timeout) {
          results.push({ seq: i + 1, command, ok: false, code: ERR.UNKNOWN });
          core.updateJob(job.job_id, { status: 'UNKNOWN', error_code: ERR.UNKNOWN, results, steps_done: i + 1 });
          return;
        }
        if (!disp.ok) {
          results.push({ seq: i + 1, command, ok: false, code: 'QFR_LEA_DISPATCH_FAILED' });
          core.updateJob(job.job_id, { status: 'FAILED', error_code: 'QFR_LEA_DISPATCH_FAILED', results, steps_done: i + 1 });
          return;
        }
        results.push({ seq: i + 1, command, ok: true, result: disp.result });
        core.updateJob(job.job_id, { results, steps_done: i + 1 });
        // 撤销检查：批内每步开始前核 grant_epoch（§6.2）——admit 已每步重查。
      }
      const cur = core.getJob(job.job_id);
      if (cur && cur.status === 'RUNNING') {
        core.updateJob(job.job_id, { status: 'SUCCEEDED', results });
      }
    })();
    run.catch((e) => {
      try { core.updateJob(job.job_id, { status: 'FAILED', error_code: 'QFR_LEA_DISPATCH_FAILED' }); } catch (e2) {}
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
    if (key.device_scope && key.device_scope !== deviceId) {
      return fail(res, 403, ERR.SCOPE_DENIED, '该 Key 不能操作此设备。');
    }
    const binding = core.getBinding(deviceId);
    let online = null;
    try { online = channel ? await channel.nodeOnline(deviceId) : null; } catch (e) { online = null; }
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
  async function passwordConfirm(req, res, user) {
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
    if (typeof deps.verifyMfa === 'function') {
      let mfaOk = false;
      try { mfaOk = await deps.verifyMfa(user, String(body.mfa_code || '')); } catch (e) { mfaOk = false; }
      if (!mfaOk) { fail(res, 401, 'BAD_MFA', 'MFA 校验未通过。'); return null; }
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
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s) => s === 'muse.execute' || s === DANGEROUS_SCOPE) : ['muse.execute'];
    const out = core.generateKey(a.user, {
      device_scope: deviceScope, scopes,
      expires_in_days: Number.isFinite(Number(body.expires_in_days)) ? Number(body.expires_in_days) : undefined,
      ip: clientIp(req), userAgent: String((req.headers && req.headers['user-agent']) || ''),
      confirmMethod: typeof deps.verifyMfa === 'function' ? 'password+mfa' : 'password',
    });
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
    const rec = core.findKeyById(keyId);
    if (!rec || rec.account_id !== a.user) return fail(res, 404, 'NOT_FOUND', 'Key 不存在。');
    const out = core.revokeKey(keyId, a.user, 'user-revoke');
    return sendJson(res, 200, { ok: true, record: out.record });
  }
  async function handleRevokeAllKeys(req, res) {
    const a = await consoleAuth(req, res);
    if (!a) return;
    const body = await passwordConfirm(req, res, a.user);
    if (!body) return;
    const out = core.revokeAllKeys(a.user, a.user, 'revoke-all');
    return sendJson(res, 200, { ok: true, revoked_count: out.revoked_count, msg: '该账号全部 Key 已吊销，Muse 再调用将返回 401 QFR_API_KEY_REVOKED。' });
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
      const out = core.grantMuse(target, a.user);
      return sendJson(res, 200, { ok: true, account_id: target, grant_epoch: out.grant_epoch });
    }
    if (action === 'revoke') {
      const out = core.revokeGrant(target, a.user);
      if (!out.ok) return fail(res, 404, 'NOT_FOUND', '该账号没有在效授权。');
      return sendJson(res, 200, { ok: true, account_id: target, grant_epoch: out.grant_epoch });
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
    const out = core.recordBinding(deviceId, accountId, 'manual-rebind');
    return sendJson(res, 200, { ok: true, device_id: out.device_id, account_id: out.account_id, binding_epoch: out.binding_epoch, revoked_keys: out.revoked_keys, ticket: out.ticket });
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
    const revokeM = p.match(/^\/api\/lea\/v1\/keys\/([^/]+)\/revoke$/);
    try {
      if (req.method === 'POST' && p === '/api/lea/v1/execute') { await handleExecute(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/batches') { await handleBatches(req, res); return true; }
      if (req.method === 'GET' && jobM) { await handleGetJob(req, res, decodeURIComponent(jobM[1])); return true; }
      if (req.method === 'POST' && cancelM) { await handleCancelJob(req, res, decodeURIComponent(cancelM[1])); return true; }
      if (req.method === 'GET' && devM) { await handleDeviceStatus(req, res, decodeURIComponent(devM[1])); return true; }
      if (req.method === 'POST' && rebindM) { await handleRebind(req, res, decodeURIComponent(rebindM[1])); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/keys') { await handleCreateKey(req, res); return true; }
      if (req.method === 'GET' && p === '/api/lea/v1/keys') { await handleListKeys(req, res); return true; }
      if (req.method === 'POST' && revokeM) { await handleRevokeKey(req, res, decodeURIComponent(revokeM[1])); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/keys/revoke-all') { await handleRevokeAllKeys(req, res); return true; }
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
