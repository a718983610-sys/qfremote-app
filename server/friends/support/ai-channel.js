'use strict';
/*
* QFRemote 智能客服 · AI 大脑通道（#27，站长 2026-10-25 定版）
* ================================================================
* 智谱 GLM（OpenAI 兼容接口）通道层，只负责「把一组 messages 发出去、
* 拿回一段文本」，不做任何业务判断（答什么、何时用 AI 由 support.js
* 引擎决定）。
*
* 通道策略（定版）：
* - 主模型 glm-4.7-flash → 拥挤（错误码 1305）/超时/5xx/网络错 →
* 自动退备模型 glm-4-flash-250414（同为免费档）→ 再失败由引擎回落
* 知识库。4xx 非 1305 不重试同模型（本层从不对同一模型重试，
* 失败即换下一个模型），直接降级。
* - 免费档并发 1：本通道单飞排队——同一时刻最多一个在途请求，
* 后到者 FIFO 排队；排队过久/队列已满时明确以 {ok:false} 返回，
* 由引擎回落知识库，绝不把错误抛给用户。
*
* 配置与密钥（定版）：
* - 配置文件默认 /opt/qfremote-ext/ai-config.json
* {enabled, baseUrl, models, timeoutMs}，路径可经 deps.configPath
* 或环境变量 QFREMOTE_AI_CONFIG_PATH 注入。
* - 密钥文件默认 /opt/qfremote-ext/glm-api-key.txt，路径可经
* deps.keyPath 或环境变量 QFREMOTE_GLM_KEY_FILE 注入；也可用
* deps.readKey 函数注入（本地测试用假钥）。
* - 配置与密钥都在每次调用时重新读取（热配置：改文件即生效，
* 无需重启）。总开关 enabled 默认 false；未配钥/未启用/配置
* 缺失 → enabled() 为 false、ask() 返回 {ok:false}，引擎据此
* 纯知识库工作，绝不向用户报错。
* - 密钥绝不进日志、绝不进返回值、绝不进错误信息：
* 本层所有 reason 都是固定短串（不拼响应体、不拼请求头、
* 不透传底层异常 message）。
*/
const fs = require('fs');

const DEFAULT_CONFIG_PATH = '/opt/qfremote-ext/ai-config.json';
const DEFAULT_KEY_PATH = '/opt/qfremote-ext/glm-api-key.txt';
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODELS = ['glm-4.7-flash', 'glm-4-flash-250414'];
const DEFAULT_TIMEOUT_MS = 25000; // 单模型单次尝试超时（AbortController）
const DEFAULT_QUEUE_WAIT_MS = 120000; // 排队最长等待：免费档串行，两个模型最坏约 50s/问，留足两问深度
const DEFAULT_MAX_WAITING = 8; // 等待队列上限（不含在途的 1 个）：满了立即降级，不无限积压

function posInt(v, fallback) {
const n = Number(v);
return Number.isFinite(n) && n > 0? Math.floor(n): fallback;
}
function nonNegInt(v, fallback) {
const n = Number(v);
return Number.isFinite(n) && n >= 0? Math.floor(n): fallback;
}

function createAiChannel(deps) {
const d = deps || {};
const fetchImpl = d.fetchImpl || (typeof fetch === 'function'? fetch: null);
const configPath = d.configPath || process.env.QFREMOTE_AI_CONFIG_PATH || DEFAULT_CONFIG_PATH;
const keyPath = d.keyPath || process.env.QFREMOTE_GLM_KEY_FILE || DEFAULT_KEY_PATH;

// 每次调用现读配置：deps.config 可为对象或返回对象的函数（测试注入），
// 否则读配置文件；读不到/解析失败按「未配置」处理（enabled=false）。
function loadConfig() {
let raw = null;
if (typeof d.config === 'function') { try { raw = d.config();} catch (e) { raw = null;}}
else if (d.config && typeof d.config === 'object') raw = d.config;
else { try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));} catch (e) { raw = null;}}
const c = raw && typeof raw === 'object'? raw: {};
return {
enabled: c.enabled === true,
baseUrl: String(c.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
models: (Array.isArray(c.models) && c.models.length? c.models: DEFAULT_MODELS).map(m => String(m)).filter(Boolean),
timeoutMs: posInt(d.timeoutMs!= null? d.timeoutMs: c.timeoutMs, DEFAULT_TIMEOUT_MS),
queueWaitMs: posInt(d.queueWaitMs!= null? d.queueWaitMs: c.queueWaitMs, DEFAULT_QUEUE_WAIT_MS),
maxWaiting: nonNegInt(d.maxWaiting!= null? d.maxWaiting: c.maxWaiting, DEFAULT_MAX_WAITING),
keyFile: c.keyFile? String(c.keyFile): null
};
}

// 每次调用现读密钥（支持轮换/热配）。读不到返回空串。
function readKeyNow(cfg) {
if (typeof d.readKey === 'function') {
try { return String(d.readKey() || '').trim();} catch (e) { return '';}
}
const p = (cfg && cfg.keyFile) || keyPath;
try { return fs.readFileSync(p, 'utf8').trim();} catch (e) { return '';}
}

function enabled() {
const cfg = loadConfig();
return!!(cfg.enabled && cfg.models.length && readKeyNow(cfg));
}

function endpoint(cfg) {
return cfg.baseUrl.endsWith('/chat/completions')? cfg.baseUrl: cfg.baseUrl + '/chat/completions';
}

// 单个模型尝试一次。返回值只含固定短串 reason，绝不带响应体/异常原文。
async function attempt(cfg, key, model, messages) {
if (!fetchImpl) return { ok: false, reason: 'no-fetch'};
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
try {
const res = await fetchImpl(endpoint(cfg), {
method: 'POST',
headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key},
body: JSON.stringify({ model, messages, stream: false}),
signal: ctrl.signal
});
if (res.ok) {
let data = null;
try { data = await res.json();} catch (e) { data = null;}
const msg = data && data.choices && data.choices[0] && data.choices[0].message;
let text = msg? msg.content: null;
if (Array.isArray(text)) text = text.map(p => (p && p.text) || '').join('');
text = String(text || '').trim();
if (!text) return { ok: false, reason: 'empty-response'};
return { ok: true, text, model};
}
// 非 2xx：只取错误码/状态码分类，不保留响应体原文。
let code = null;
try {
const errBody = await res.json();
if (errBody && errBody.error && errBody.error.code!= null) code = String(errBody.error.code);
} catch (e) { /* 响应体不可解析时只按状态码分类 */}
if (code === '1305') return { ok: false, reason: 'code-1305'};
if (res.status >= 500) return { ok: false, reason: 'http-5xx'};
return { ok: false, reason: 'http-' + res.status};
} catch (e) {
if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return { ok: false, reason: 'timeout'};
return { ok: false, reason: 'network'};
} finally {
clearTimeout(timer);
}
}

// 逐模型尝试：主 → 备，任一成功即返回；全失败返回最后一个 reason。
async function execute(messages) {
const cfg = loadConfig();
if (!cfg.enabled) return { ok: false, reason: 'disabled'};
if (!cfg.models.length) return { ok: false, reason: 'no-model'};
const key = readKeyNow(cfg);
if (!key) return { ok: false, reason: 'no-key'};
let last = 'error';
for (const model of cfg.models) {
const r = await attempt(cfg, key, model, messages);
if (r.ok) return r;
last = r.reason;
}
return { ok: false, reason: last};
}

// —— 单飞队列：running 至多 1 个在途，waiting FIFO ——
let running = false;
const waiting = [];
function pump() {
if (running) return;
while (waiting.length) {
const job = waiting.shift();
if (job.settled) continue;
running = true;
job.settled = true;
if (job.timer) clearTimeout(job.timer);
execute(job.messages).then(
r => { running = false; job.resolve(r); pump();},
() => { running = false; job.resolve({ ok: false, reason: 'error'}); pump();}
);
return;
}
}

function ask(messages) {
if (!Array.isArray(messages) ||!messages.length) {
return Promise.resolve({ ok: false, reason: 'bad-messages'});
}
const cfg = loadConfig();
// 队列满只在「已有在途请求」时判定：空闲时第一个请求直接执行。
if (running && waiting.filter(j =>!j.settled).length >= cfg.maxWaiting) {
return Promise.resolve({ ok: false, reason: 'queue-full'});
}
return new Promise(resolve => {
const job = { messages, resolve, settled: false, timer: null};
job.timer = setTimeout(() => {
if (job.settled) return;
job.settled = true;
const i = waiting.indexOf(job);
if (i >= 0) waiting.splice(i, 1);
resolve({ ok: false, reason: 'queue-timeout'});
}, cfg.queueWaitMs);
waiting.push(job);
pump();
});
}

return { enabled, ask};
}

module.exports = {
createAiChannel,
DEFAULT_CONFIG_PATH, DEFAULT_KEY_PATH, DEFAULT_BASE_URL, DEFAULT_MODELS,
DEFAULT_TIMEOUT_MS, DEFAULT_QUEUE_WAIT_MS, DEFAULT_MAX_WAITING
};
