'use strict';
/*
 * ocr-core.js — 付款截图订单号自动识别（提交前回填专用）
 *
 * 设计正本：patrol-20261026/work/ocr-orderno-20261026/DESIGN.md
 *
 * 定位：购买页用户选好账单截图后、提交前，服务端从截图识别订单号，
 * 仅回填前端输入框。识别结果不落单、不改订单状态、不参与审核裁定；
 * 提交后一审/秒审仍按提交值逐字核对（防伪不降级）。
 * 识别通道复用秒审已落地的 GLM glm-4v-flash 提取契约
 * （instant-review.js 导出的 EXTRACT_PROMPT＋parseExtraction）与
 * A12 规范化（NFKC 宽度折叠＋去全部空白）。任何异常一律吞掉回
 * found:false，静默回落手输，绝不拦提交、绝不影响 ext 主进程（A1 隔离）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_MODEL = 'glm-4v-flash';
/* GLM 通道错误码封闭集（日志枚举，门一复核 Q7）：glmExtract 只产出这四码 */
const GLM_ERR_CODES = new Set(['GLM_DISABLED', 'GLM_TIMEOUT', 'GLM_HTTP_ERROR', 'GLM_BAD_JSON']);

/* 限频（内存滑动窗口，三层）：
 * - 账号级粗粒度 60 次/60min（门一 D1 采纳）：置于上下文/解码/缓存之前无条件
 *   计次——同图重放、无效订单、坏图一律消耗，端点的带宽/解码/哈希/日志成本
 *   不再可被不变图洪泛；
 * - GLM 调用面窗口：每单 5 次/60min、每账号 20 次/60min——检查＋扣减在同一
 *   同步段完成（原子），扣减在调用前落账，GLM 失败/超时同样计次（门一 S2）；
 * - 全局闸（门一 D2 部分采纳）：GLM 日配额 400 次/日（Asia/Shanghai 日界）、
 *   并发 4、每分钟启动 30 次，阈值按 GLM 免费额度保守定，依据见 DESIGN §四。
 *   前提：ext 单实例（systemd 单进程，实证见 DESIGN §十）；扩实例前必须先
 *   改共享计数，内存窗口/配额随进程重启清零同为已知边界。 */
const COARSE_ACCOUNT_LIMIT = 60;
const PER_ORDER_LIMIT = 5;
const PER_ACCOUNT_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const GLOBAL_DAILY_LIMIT = 400;
const GLOBAL_CONCURRENCY = 4;
const GLOBAL_PER_MINUTE_LIMIT = 30;
const MINUTE_MS = 60 * 1000;

/* A12 规范化：与秒审同口径——NFKC 宽度折叠＋去全部空白，只折宽度与空白、不折字义 */
function normOrderNo(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '');
}
/* 订单号形状：与 orders-core submitShot 的 6–64 位口径对齐，字符集限数字/字母/连字符 */
function validOrderNo(s) {
  return typeof s === 'string' && s.length >= 6 && s.length <= 64 && /^[0-9A-Za-z-]+$/.test(s);
}

function createOrderOcr(deps) {
  const d = deps || {};
  const payOrders = d.payOrders;
  const log = typeof d.log === 'function' ? d.log : () => {};
  const extDir = d.extDir || '/opt/qfremote-ext';
  const aiConfigPath = d.aiConfigPath || path.join(extDir, 'ai-config.json');
  const glmKeyPath = d.glmKeyPath || path.join(extDir, 'glm-api-key.txt');
  const fetchImpl = d.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const nowFn = typeof d.nowFn === 'function' ? d.nowFn : Date.now;
  const timeoutCapMs = Number.isFinite(Number(d.timeoutMs)) && Number(d.timeoutMs) > 0 ? Math.min(12000, Math.max(500, Math.floor(Number(d.timeoutMs)))) : 12000;

  /* 提取契约复用 instant-review 的导出纯函数；取不到（模块缺失）时识别恒回落 */
  let EXTRACT_PROMPT = null, parseExtraction = null;
  try {
    const ir = require('./instant-review');
    EXTRACT_PROMPT = ir.EXTRACT_PROMPT; parseExtraction = ir.parseExtraction;
  } catch (e) { EXTRACT_PROMPT = null; parseExtraction = null; }
  if (typeof parseExtraction !== 'function' || typeof EXTRACT_PROMPT !== 'string') { parseExtraction = null; EXTRACT_PROMPT = null; }

  /* 限值可经 deps.limits 覆盖（仅测试用），生产恒走上方常量 */
  const pickLim = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0) ? Math.floor(Number(v)) : def;
  const limIn = (d.limits && typeof d.limits === 'object') ? d.limits : {};
  const L = {
    coarse: pickLim(limIn.coarse, COARSE_ACCOUNT_LIMIT),
    perOrder: pickLim(limIn.perOrder, PER_ORDER_LIMIT),
    perAccount: pickLim(limIn.perAccount, PER_ACCOUNT_LIMIT),
    globalDaily: pickLim(limIn.globalDaily, GLOBAL_DAILY_LIMIT),
    globalConcurrency: pickLim(limIn.globalConcurrency, GLOBAL_CONCURRENCY),
    globalPerMinute: pickLim(limIn.globalPerMinute, GLOBAL_PER_MINUTE_LIMIT),
  };

  const coarseByAccount = new Map();   // username -> [ts,...]（D1 粗粒度，进门即计）
  const attemptsByOrder = new Map();   // orderId -> [ts,...]
  const attemptsByAccount = new Map(); // username -> [ts,...]
  const cache = new Map();             // username|orderId|sha256 -> { orderNo, at }
  let glmStartsMinute = [];            // 全局 GLM 启动时刻（1 分钟窗）
  let glmDaily = { day: '', count: 0 }; // 全局 GLM 日配额计数（Asia/Shanghai 日界）
  let glmInFlight = 0;                  // 全局 GLM 并发在飞数

  function prune(map, key, now) {
    const arr = map.get(key);
    if (!arr) return [];
    const kept = arr.filter((t) => now - t < WINDOW_MS);
    if (kept.length) map.set(key, kept); else map.delete(key);
    return kept;
  }
  function quotaLeft(username, orderId, now) {
    const byOrder = prune(attemptsByOrder, orderId, now);
    if (byOrder.length >= L.perOrder) return false;
    const byAcct = prune(attemptsByAccount, username, now);
    if (byAcct.length >= L.perAccount) return false;
    return true;
  }
  function consume(username, orderId, now) {
    const a = prune(attemptsByOrder, orderId, now); a.push(now); attemptsByOrder.set(orderId, a);
    const b = prune(attemptsByAccount, username, now); b.push(now); attemptsByAccount.set(username, b);
  }
  /* D1 粗粒度：检查＋扣减同一同步段完成（原子），任何进入 recognize 的请求先过此关 */
  function consumeCoarse(username, now) {
    const arr = prune(coarseByAccount, username, now);
    if (arr.length >= L.coarse) return false;
    arr.push(now); coarseByAccount.set(username, arr);
    return true;
  }
  function dayKeySh(now) { return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10); }
  /* D2 全局闸：检查＋预留同一同步段完成。放行（已预留日配额/分钟启动/并发名额）
   * 返回 null，调用方必须在 GLM 结束后调 globalEnd 归还并发；拒绝返回细分 code
   * 且不预留。日配额按 GLM 启动计，失败启动同样占用（与 S2 失败计次同口径）。 */
  function globalStart(now) {
    const day = dayKeySh(now);
    if (glmDaily.day !== day) glmDaily = { day, count: 0 };
    if (glmDaily.count >= L.globalDaily) return 'GLOBAL_DAILY_QUOTA';
    glmStartsMinute = glmStartsMinute.filter((t) => now - t < MINUTE_MS);
    if (glmStartsMinute.length >= L.globalPerMinute) return 'GLOBAL_PER_MINUTE';
    if (glmInFlight >= L.globalConcurrency) return 'GLOBAL_CONCURRENCY';
    glmDaily.count++; glmStartsMinute.push(now); glmInFlight++;
    return null;
  }
  function globalEnd() { if (glmInFlight > 0) glmInFlight--; }

  /* 图片解码：与 orders-core submitShot 同口径（剥 data 前缀、base64、魔数 JPG/PNG） */
  function decodeImage(imageBase64) {
    const b64 = String(imageBase64 || '');
    if (!b64) return null;
    let buf;
    try { buf = Buffer.from(b64.replace(/^data:image\/[a-z]+;base64,/i, ''), 'base64'); } catch (e) { return null; }
    if (!buf || !buf.length) return null;
    if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { buf, mime: 'image/jpeg' };
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return { buf, mime: 'image/png' };
    return null;
  }

  /* GLM 视觉提取：与 instant-review glmExtract 同形态；异常带 code 抛出由调用方收口 */
  async function glmExtract(buf, mime) {
    if (!fetchImpl || !parseExtraction) { const e = new Error('extractor unavailable'); e.code = 'GLM_DISABLED'; throw e; }
    let cfg, key;
    try { cfg = JSON.parse(fs.readFileSync(aiConfigPath, 'utf8')); } catch (e) { cfg = null; }
    try { key = fs.readFileSync(glmKeyPath, 'utf8').trim(); } catch (e) { key = ''; }
    if (!cfg || cfg.enabled !== true || !key) { const e = new Error('ai channel disabled or key missing'); e.code = 'GLM_DISABLED'; throw e; }
    const model = cfg.visionModel || DEFAULT_MODEL;
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutCapMs);
    try {
      const r = await fetchImpl(GLM_ENDPOINT, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model, temperature: 0, max_tokens: 256,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } },
            { type: 'text', text: EXTRACT_PROMPT },
          ] }],
        }),
      });
      if (!r || r.status !== 200) { const e = new Error('glm http ' + (r && r.status)); e.code = 'GLM_HTTP_ERROR'; throw e; }
      let j;
      try { j = await r.json(); } catch (e2) { const e = new Error('response not json'); e.code = 'GLM_BAD_JSON'; throw e; }
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof text !== 'string' || !text) { const e = new Error('empty model reply'); e.code = 'GLM_BAD_JSON'; throw e; }
      try { return parseExtraction(text); }
      catch (e2) { const e = new Error(e2.message); e.code = 'GLM_BAD_JSON'; throw e; }
    } catch (e) {
      if (e && e.code) throw e;
      if (ctrl.signal.aborted || (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'))) { const te = new Error('glm aborted (timeout)'); te.code = 'GLM_TIMEOUT'; throw te; }
      const he = new Error(String(e && e.message || e)); he.code = 'GLM_HTTP_ERROR'; throw he;
    } finally { clearTimeout(timer); }
  }

  /*
   * recognize(username, orderId, imageBase64, now)
   * 回形见 DESIGN §三。now 由路由层传入（与同组端点同时钟），缺省取 nowFn。
   */
  async function recognize(username, orderId, imageBase64, now) {
    const t0 = nowFn();
    /* 门一复核 N3：now 须为正数毫秒，null/''/0 等 falsy 数字化结果一律回落本地时钟，
     * 防 at=0 把日界钉死在 1970 年、窗口永不修剪 */
    const at = (typeof now === 'number' && Number.isFinite(now) && now > 0) ? now : t0;
    const done = (out, code, tail4) => {
      try { log({ ev: 'pay-ocr', target: username, orderId, code: code || (out.found ? 'OK' : 'NOT_FOUND'), tail4: tail4 || null, ms: nowFn() - t0 }); } catch (e) {}
      return out;
    };
    try {
      // 0) 账号级粗粒度限频（门一 D1）：先于上下文/解码/缓存无条件原子计次——
      //    同图重放、无效订单、坏图都消耗此额度，洪泛成本被封顶在此关。
      if (!consumeCoarse(username, at)) return done({ ok: false, code: 'OCR_RATE_LIMIT' }, 'COARSE_LIMIT');
      // 1) 订单上下文：本人＋pending_pay＋未过支付时限（统一一形，不分细）
      let o = null;
      try { o = payOrders ? payOrders.getRaw(orderId) : null; } catch (e) { o = null; }
      if (!o || o.username !== username || o.status !== 'pending_pay' || (o.payDeadline && at > o.payDeadline)) {
        return done({ ok: false, code: 'NO_ORDER_CONTEXT' }, 'NO_ORDER_CONTEXT');
      }
      // 2) 图片解码（与 submitShot 同口径）
      const dec = decodeImage(imageBase64);
      if (!dec) return done({ ok: true, found: false }, 'BAD_IMAGE');
      // 3) 同图缓存（不占 GLM 调用面窗口、不调 GLM；粗粒度已在第 0 步计次）
      const hash = crypto.createHash('sha256').update(dec.buf).digest('hex');
      const ckey = username + '|' + orderId + '|' + hash;
      const hit = cache.get(ckey);
      if (hit && at - hit.at >= CACHE_TTL_MS) cache.delete(ckey); // 门一复核 N2：过期即回收，不只判失效
      if (hit && at - hit.at < CACHE_TTL_MS) {
        try { log({ ev: 'pay-ocr-cache-hit', target: username, orderId, tail4: hit.orderNo.slice(-4), ms: nowFn() - t0 }); } catch (e) {}
        return { ok: true, found: true, orderNo: hit.orderNo, tail4: hit.orderNo.slice(-4), cached: true };
      }
      // 4) GLM 调用面限频＋全局闸：窗口检查（quotaLeft）→全局闸预留（globalStart）
      //    →窗口扣减（consume）三步同在一段同步代码内完成（原子，门一 S2）；
      //    扣减/预留都在 GLM 调用之前落账，GLM 超时/异常同样计次，失败不可
      //    无限重试。全局闸拒绝时窗口不扣减；窗口拒绝时全局不预留。
      if (!quotaLeft(username, orderId, at)) return done({ ok: false, code: 'OCR_RATE_LIMIT' }, 'OCR_RATE_LIMIT');
      const gCode = globalStart(at);
      if (gCode) return done({ ok: false, code: 'OCR_RATE_LIMIT' }, gCode);
      consume(username, orderId, at);
      // 5) GLM 提取：只取 orderNo 一字段，其余字段即弃
      let fields;
      try { fields = await glmExtract(dec.buf, dec.mime); }
      catch (e) {
        /* 门一复核 Q7：日志 code 白名单收口——注入 fetch 实现的外来错误码不进枚举 */
        const ec = (e && e.code) || '';
        return done({ ok: true, found: false }, GLM_ERR_CODES.has(ec) ? ec : 'GLM_HTTP_ERROR');
      }
      finally { globalEnd(); }
      if (!fields || fields.isBillDetail !== true) return done({ ok: true, found: false }, 'NOT_BILL');
      const ono = normOrderNo(fields.orderNo);
      if (!validOrderNo(ono)) return done({ ok: true, found: false }, 'NO_ORDERNO');
      cache.set(ckey, { orderNo: ono, at });
      return done({ ok: true, found: true, orderNo: ono, tail4: ono.slice(-4) }, 'OK', ono.slice(-4));
    } catch (e) {
      return done({ ok: true, found: false }, 'INTERNAL');
    }
  }

  return { recognize };
}

module.exports = { createOrderOcr, normOrderNo, validOrderNo, COARSE_ACCOUNT_LIMIT, PER_ORDER_LIMIT, PER_ACCOUNT_LIMIT, WINDOW_MS, GLOBAL_DAILY_LIMIT, GLOBAL_CONCURRENCY, GLOBAL_PER_MINUTE_LIMIT };
