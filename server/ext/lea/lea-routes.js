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
 *   POST /api/lea/v1/login-attestation  签发登录证明（控制台会话；v3 P0-4 第二层，供客户端随 session.login_changed 发给本机 QFRLEA 验签）
 */
const crypto = require('crypto');
const { bareNodeId, nodeMatchesId } = require('./lea-channel');

const BODY_LIMIT = 1024 * 1024; // 执行请求体上限 1MB（信封 params 含文本时用）
const MAX_BATCH_STEPS = 50;
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
      device_id: deviceId, api_key_id: key.key_id, key_prefix: core.maskKey(key.prefix),
      binding_epoch: key.binding_epoch, command, idempotency_key: idemKey, ip: clientIp(req),
    };
    // 幂等：已完成返回缓存结果不重复执行；执行中返回 DUPLICATE_IN_PROGRESS。
    const prev = core.idemLookup(key.account_id, key.key_id, idemKey, core.IDEM_NS.EXEC);
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
    core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'RUNNING', job_id: job.job_id, dangerous: spec.dangerous }, core.IDEM_NS.EXEC);
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
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'SUCCEEDED', job_id: job.job_id, dangerous: spec.dangerous, result: { job_id: job.job_id, result: disp.result } }, core.IDEM_NS.EXEC);
      auditCall(Object.assign({}, baseAudit, { result: 'ok', job_id: job.job_id, duration_ms: durationMs }));
      try { core.audit('lea-deliver', Object.assign({}, baseAudit, { job_id: job.job_id, direction: 'reply', duration_ms: durationMs })); } catch (e) {}
      return sendJson(res, 200, { ok: true, request_id: requestId, job_id: job.job_id, result: disp.result, duration_ms: durationMs });
    }
    if (disp.timeout) {
      // 同步等待 5s 超时 → 202 + job_id，长任务异步（结果 UNKNOWN，须查 job/快照确认）。
      core.updateJob(job.job_id, { status: 'UNKNOWN', error_code: ERR.UNKNOWN });
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'RUNNING', job_id: job.job_id, dangerous: spec.dangerous }, core.IDEM_NS.EXEC);
      auditCall(Object.assign({}, baseAudit, { result: 'timeout-async', job_id: job.job_id, error_code: ERR.UNKNOWN, duration_ms: durationMs }));
      return sendJson(res, 202, { ok: true, async: true, request_id: requestId, job_id: job.job_id, status: 'UNKNOWN', code: ERR.UNKNOWN, msg: '执行超时，已转异步任务；结果未知，请用 job_id 查询或快照确认，勿直接重试危险操作。' });
    }
    // r9：客户端已回包且执行失败（ok:false）时透传其真实 code（如
    // QFR_USH_FAILED），不再一律谎报 bad-client-output；job／幂等记
    // 该真实码，调用方据此排查而非重查下发通道。
    if (disp.clientResult && typeof disp.clientResult.code === 'string' && /^QFR_[A-Z0-9_]+$/.test(disp.clientResult.code)) {
      const ccode = disp.clientResult.code;
      const cdetail = typeof disp.clientResult.detail === 'string' ? disp.clientResult.detail : '';
      core.updateJob(job.job_id, { status: 'FAILED', error_code: ccode, result: disp.clientResult });
      core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, dangerous: spec.dangerous, result: { job_id: job.job_id, code: ccode, result: disp.clientResult } }, core.IDEM_NS.EXEC);
      auditCall(Object.assign({}, baseAudit, { result: 'client-failed', job_id: job.job_id, error_code: ccode, duration_ms: durationMs }));
      return fail(res, 502, ccode, '执行失败：' + ccode + (cdetail ? '（' + cdetail + '）' : ''));
    }
    core.updateJob(job.job_id, { status: 'FAILED', error_code: 'QFR_LEA_DISPATCH_FAILED' });
    core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, dangerous: spec.dangerous, result: { job_id: job.job_id, code: 'QFR_LEA_DISPATCH_FAILED' } }, core.IDEM_NS.EXEC);
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
    // H13（DS 复查）：steps 指纹——UNKNOWN 重试时若 steps 内容变了，步级
    // 缓存按位置复用会误用旧结果。指纹随批量级幂等记录；重试时指纹不一致
    // 即不复用步级缓存，全部步重跑。
    const stepsFp = crypto.createHash('sha256').update(JSON.stringify(steps)).digest('hex');
    // H13：批量级幂等——重复提交去重（此前批量级键只要求不记录，步级键
    // 也不写入 idemSeen，重复提交重跑全部步骤）。UNKNOWN 不拦重放
    //（H14 推进器已把失联 RUNNING 转 UNKNOWN），继续执行并覆盖记录。
    const prevBatch = core.idemLookup(key.account_id, key.key_id, idemKey, core.IDEM_NS.BATCH);
    if (prevBatch && prevBatch.status === 'RUNNING') return fail(res, 409, ERR.DUPLICATE, '同一幂等键的批量任务正在执行中。');
    if (prevBatch && prevBatch.status === 'SUCCEEDED') {
      return sendJson(res, 200, Object.assign({ ok: true, duplicate: true, request_id: requestId }, prevBatch.result || {}));
    }
    if (prevBatch && prevBatch.status === 'FAILED') {
      return sendJson(res, 200, Object.assign({ ok: false, duplicate: true, request_id: requestId }, prevBatch.result || {}));
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
    const batchDangerous = steps.some((st) => {
      const s = core.COMMANDS[String((st && st.command) || '')];
      return !!(s && s.dangerous);
    });
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
      const stepKey = (i) => idemKey + '-' + (i + 1);
      for (let i = 0; i < steps.length; i++) {
        const cur = core.getJob(job.job_id);
        if (cur && cur.status === 'CANCELLED') { results.push({ seq: i + 1, cancelled: true }); break; }
        const st = steps[i] || {};
        const command = String(st.command || '');
        const spec = core.COMMANDS[command];
        if (!spec) { results.push({ seq: i + 1, command, ok: false, code: ERR.VALIDATION }); failed = true; break; }
        const adm = core.admit({ key, deviceId, command, requestId, ip: clientIp(req) });
        if (!adm.ok) { results.push({ seq: i + 1, command, ok: false, code: adm.code }); failed = true; break; }
        // H13：步级幂等——已成功的步不再重跑，复用缓存结果（仅当 steps
        // 指纹一致；UNKNOWN 重试改了 steps 时不复用，见 reuseSteps）。
        const prevStep = core.idemLookup(key.account_id, key.key_id, stepKey(i), core.IDEM_NS.STEP);
        if (reuseSteps && prevStep && prevStep.status === 'SUCCEEDED') {
          results.push({ seq: i + 1, command, ok: true, result: prevStep.result || null, duplicate: true });
          core.updateJob(job.job_id, { results, steps_done: i + 1 });
          continue;
        }
        core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'RUNNING', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous }, core.IDEM_NS.STEP);
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
          setJobTerminalUnlessCancelled(job.job_id, { status: 'UNKNOWN', error_code: ERR.UNKNOWN, results, steps_done: i + 1 });
          core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'UNKNOWN', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous }, core.IDEM_NS.STEP);
          core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'UNKNOWN', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status: 'UNKNOWN', results, steps_done: i + 1 } }, core.IDEM_NS.BATCH);
          return;
        }
        if (!disp.ok) {
          // r9：客户端已回包的终态失败透传其真实 code（与单条 handleExecute 同口径）。
          const bcode = (disp.clientResult && typeof disp.clientResult.code === 'string' && /^QFR_[A-Z0-9_]+$/.test(disp.clientResult.code))
            ? disp.clientResult.code : 'QFR_LEA_DISPATCH_FAILED';
          results.push({ seq: i + 1, command, ok: false, code: bcode });
          setJobTerminalUnlessCancelled(job.job_id, { status: 'FAILED', error_code: bcode, results, steps_done: i + 1 });
          core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'FAILED', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous, result: { job_id: job.job_id, code: bcode } }, core.IDEM_NS.STEP);
          core.idemRecord(key.account_id, key.key_id, idemKey, { status: 'FAILED', job_id: job.job_id, batch_id: batchId, dangerous: batchDangerous, steps_fp: stepsFp, result: { job_id: job.job_id, batch_id: batchId, status: 'FAILED', results, steps_done: i + 1 } }, core.IDEM_NS.BATCH);
          return;
        }
        results.push({ seq: i + 1, command, ok: true, result: disp.result });
        core.idemRecord(key.account_id, key.key_id, stepKey(i), { status: 'SUCCEEDED', job_id: job.job_id, batch_id: batchId, dangerous: spec.dangerous, result: disp.result }, core.IDEM_NS.STEP);
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
    return sendJson(res, 200, { ok: true, device_id: out.device_id, account_id: out.account_id, binding_epoch: out.binding_epoch, revoked_keys: out.revoked_keys, revoked_key_ids: out.revoked_key_ids || [], revocations, revocation_generation: revocations.generation, ticket: out.ticket });
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
    const revocM = p.match(/^\/api\/lea\/v1\/devices\/([^/]+)\/revocations$/);
    const revokeM = p.match(/^\/api\/lea\/v1\/keys\/([^/]+)\/revoke$/);
    try {
      if (req.method === 'POST' && p === '/api/lea/v1/execute') { await handleExecute(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/batches') { await handleBatches(req, res); return true; }
      if (req.method === 'GET' && jobM) { await handleGetJob(req, res, decodeURIComponent(jobM[1])); return true; }
      if (req.method === 'POST' && cancelM) { await handleCancelJob(req, res, decodeURIComponent(cancelM[1])); return true; }
      if (req.method === 'GET' && devM) { await handleDeviceStatus(req, res, decodeURIComponent(devM[1])); return true; }
      if (req.method === 'GET' && revocM) { await handleRevocations(req, res, decodeURIComponent(revocM[1])); return true; }
      if (req.method === 'POST' && rebindM) { await handleRebind(req, res, decodeURIComponent(rebindM[1])); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/keys') { await handleCreateKey(req, res); return true; }
      if (req.method === 'GET' && p === '/api/lea/v1/keys') { await handleListKeys(req, res); return true; }
      if (req.method === 'POST' && revokeM) { await handleRevokeKey(req, res, decodeURIComponent(revokeM[1])); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/keys/revoke-all') { await handleRevokeAllKeys(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/grants') { await handleGrants(req, res); return true; }
      if (req.method === 'POST' && p === '/api/lea/v1/login-attestation') { await handleLoginAttestation(req, res); return true; }
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
