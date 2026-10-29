'use strict';
/*
 * QFRemote 扩展服务 · 头像图像审核供给（GLM 视觉，2.3.2）
 * ================================================================
 * 口径：DESIGN §5.4＋督导 O1 裁示。实测（2026-10-26，evidence/
 * O1-glm-vision-test.md）：本站既有 GLM 通道同一把钥可调视觉模型
 * glm-4v-flash（免费档），判定正确，故接为 moderateImage 生产供给。
 * 提示词与类别集逐字镜像 QFClash imagemod.js 定版；异常/超时/回形
 * 不对一律抛错，由 profile-core 的 moderateImage 收口为不可用
 * （fail-closed：不生效、不落驳回行、回「系统繁忙，请稍后再试」，
 * 严禁文本管线冒充——QFClash B4 定版同款红线）。
 *
 * 配置：ai-config.json（与智能客服同一文件）{ enabled, timeoutMs,
 * visionModel? }；钥文件 glm-api-key.txt（0600，只在服务器本机读，
 * 绝不进任何接口响应与日志）。路径可用 env 覆盖：
 * QFPROFILE_AI_CONFIG / QFPROFILE_GLM_KEY。visionModel 缺省
 * glm-4v-flash。
 */
const fs = require('fs');

const IMAGE_MOD_CATEGORIES = ['色情内容', '暴力血腥', '违法与敏感内容', '广告'];
const IMAGE_MOD_PROMPT = [
  'You are a content moderation classifier for public profile avatars.',
  'Decide whether the image is acceptable as a public profile avatar.',
  'It is NOT acceptable if it contains any of: nudity or sexual content; graphic violence or gore;',
  'illegal, extremist or politically sensitive content; advertising text, QR codes or promotional links.',
  'Reply with ONLY a JSON object, no other text:',
  '{"usable": true} or {"usable": false, "category": "色情内容"}',
  'where category is one of: 色情内容 (sexual), 暴力血腥 (violence/gore), 违法与敏感内容 (illegal/sensitive), 广告 (advertising).',
].join(' ');
const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_VISION_MODEL = 'glm-4v-flash';

function parseVerdict(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('imagemod: no JSON in model reply');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!parsed || typeof parsed.usable !== 'boolean') throw new Error('imagemod: bad verdict shape');
  if (parsed.usable) return { usable: true };
  return {
    usable: false,
    category: IMAGE_MOD_CATEGORIES.includes(parsed.category) ? parsed.category : '违规内容',
    rules: ['glm-vision'],
  };
}

function createGlmImageModerator(opts) {
  const o = opts || {};
  const configPath = o.configPath || process.env.QFPROFILE_AI_CONFIG || '/opt/qfremote-ext/ai-config.json';
  const keyPath = o.keyPath || process.env.QFPROFILE_GLM_KEY || '/opt/qfremote-ext/glm-api-key.txt';
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  // F9 修复：config 与 key 文件分别按各自 mtime 判新鲜——只轮换 key 文件
  // （不动 config）也必须触发重读，否则旧钥用到 config 变更或重启为止。
  let cache = { cfgMtime: -1, keyMtime: -1, cfg: null, key: '' };
  function load() {
    const stCfg = fs.statSync(configPath);
    const stKey = fs.statSync(keyPath);
    if (stCfg.mtimeMs !== cache.cfgMtime || stKey.mtimeMs !== cache.keyMtime) {
      cache = {
        cfgMtime: stCfg.mtimeMs, keyMtime: stKey.mtimeMs,
        cfg: JSON.parse(fs.readFileSync(configPath, 'utf8')),
        key: fs.readFileSync(keyPath, 'utf8').trim(),
      };
    }
    return { cfg: cache.cfg, key: cache.key };
  }
  return async function glmImageModerator({ bytes, mime }) {
    if (!fetchImpl) throw new Error('imagemod: no fetch available');
    const { cfg, key } = load();
    if (!cfg || cfg.enabled !== true || !key) throw new Error('imagemod: ai channel disabled or key missing');
    const model = cfg.visionModel || DEFAULT_VISION_MODEL;
    const timeoutMs = Math.max(3000, Number(cfg.timeoutMs) || 12000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
    try {
      const r = await fetchImpl(GLM_ENDPOINT, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model, temperature: 0, max_tokens: 128,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64') } },
            { type: 'text', text: IMAGE_MOD_PROMPT },
          ] }],
        }),
      });
      if (!r || r.status !== 200) throw new Error('imagemod: glm http ' + (r && r.status));
      const j = await r.json();
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof text !== 'string' || !text) throw new Error('imagemod: empty model reply');
      return parseVerdict(text);
    } finally { clearTimeout(timer); }
  };
}

module.exports = { createGlmImageModerator, parseVerdict, IMAGE_MOD_CATEGORIES, IMAGE_MOD_PROMPT, DEFAULT_VISION_MODEL };
