'use strict';
/*
 * extRequest 有界重试（pkg4 DS-8，低，L-C）
 * ================================================================
 * 背景：main.js 的 extRequest 原先固定 8 秒超时、超时即 status:0，
 * 无重试；心跳靠 60 秒下一轮兜底，但 terminateSubSessions（子服务
 * 登出）、device-report 等一次性动作可能因一次瞬时超时静默丢失，
 * 且调用方分不清“超时/断网”和“服务器拒绝”。
 *
 * 口径（DS-8 复查要点，写死在这里，main.js 只调用）：
 *   - 只对“没收到 HTTP 响应”（status 0：超时/断网/DNS 失败）重试；
 *     收到任何 HTTP 状态码（哪怕 500）即服务器已回答，不重试。
 *   - 默认：GET 补 1 次（共 2 试，幂等读操作可安全重发）；POST
 *     默认 0 次（写操作不默认重发，须调用方按幂等性显式 opt-in，
 *     如 terminateSubSessions 登出、heartbeat、device-report）。
 *     opts.retries 可显式覆盖（0..3，超限钳制；NaN/非数字走默认）。
 *   - 退避：500ms、1000ms、1000ms（封顶 1000ms），总耗时有界：
 *     单试 8s 超时 × 最多 4 试 ＋ 退避 ≤ 约 34.5s。
 *   - 返回值在原 {status, json, text} 上追加：
 *       attempts（总试次数）、retried（重试次数）、
 *       timeout（最终失败是否超时引起；成功/HTTP 回答时为 false）。
 *     旧调用方只读 status/json，不受影响。
 *   - claimLicenseKey 等非幂等写操作不走这里的默认重试（盲目重发
 *     可能把“服务端已落单、响应丢了”的成功翻成失败）；须调用方
 *     另做对账补偿，不在本模块内解决。
 *
 * 本模块不碰网络：requestOnce 由调用方注入（main.js 里是单次
 * https/http 请求），sleep 可注入（单测用假时钟，不真等）。
 */
const DEFAULT_RETRIES_GET = 1;
const DEFAULT_RETRIES_OTHER = 0;
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 500;
const RETRY_DELAY_CAP_MS = 1000;

function resolveRetries(opts, method) {
  if (opts && typeof opts.retries === 'number' && Number.isFinite(opts.retries)) {
    return Math.max(0, Math.min(MAX_RETRIES, Math.floor(opts.retries)));
  }
  return method === 'GET' ? DEFAULT_RETRIES_GET : DEFAULT_RETRIES_OTHER;
}

function retryDelayMs(attempt) {
  // attempt=0（第一次重试前）500ms，之后 1000ms 封顶。
  return Math.min(RETRY_DELAY_CAP_MS, RETRY_DELAY_BASE_MS * Math.pow(2, attempt));
}

function isRetryableResult(r) {
  return !r || typeof r.status !== 'number' || r.status === 0;
}

async function requestWithRetry(requestOnce, opts, method, sleep) {
  const retries = resolveRetries(opts, method);
  const doSleep = typeof sleep === 'function'
    ? sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let last = null;
  for (let i = 0; i <= retries; i++) {
    let r;
    try { r = await requestOnce(i); } catch (e) { r = { status: 0, json: null, text: '' }; }
    last = r || { status: 0, json: null, text: '' };
    if (!isRetryableResult(last)) {
      return Object.assign({}, last, { attempts: i + 1, retried: i, timeout: false });
    }
    if (i < retries) await doSleep(retryDelayMs(i));
  }
  return Object.assign({}, last, {
    attempts: retries + 1,
    retried: retries,
    timeout: last.timeout === true
  });
}

module.exports = {
  DEFAULT_RETRIES_GET,
  DEFAULT_RETRIES_OTHER,
  MAX_RETRIES,
  resolveRetries,
  retryDelayMs,
  isRetryableResult,
  requestWithRetry
};
