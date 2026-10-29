'use strict';
/*
 * QFRemote 论坛机审引擎（纯逻辑，可单测）
 * ================================================================
 * 口径：方案 forum-service-plan.md 二-4（对标 QFClash 全套 adopt，本站裁剪）：
 *  - 发布瞬间三档：A 直通 / B 直驳 / C 待审。
 *  - 硬规则七类（政治最高优先）：politics illegal porn gambling fraud trade ad abuse spam。
 *  - 擦边同罪；谐音/拼音/拆字/符号规避先归一化再比对。
 *  - 驳回只给大类，绝不透词库（本模块返回的 category 只用于拼大类文案，
 *    matched 细节只进审核日志，不进给用户的响应）。
 *  - 词库按 QFClash 分类骨架新建本站词表（plan §七-5），不拷贝 QFClash 数据；
 *    交易类收窄为卖号与远控诈骗类；词库运行时存数据文件、站长可增删。
 */

// 大类与用户可见文案（只许大类，不许透具体词）
const CATEGORIES = {
  politics: '政治敏感内容',
  illegal: '违法敏感内容',
  porn: '色情低俗内容',
  gambling: '赌博相关内容',
  fraud: '涉嫌诈骗内容',
  trade: '违规交易内容',
  ad: '广告引流内容',
  abuse: '人身攻击与辱骂',
  spam: '刷屏灌水内容',
  mild: '轻度敏感内容'
};
// 硬类判定优先级：政治之首（QFClash 口径），其余按危害序
const HARD_ORDER = ['politics', 'illegal', 'porn', 'gambling', 'fraud', 'trade', 'ad', 'abuse', 'spam'];

// ---------- 归一化 ----------
// 繁简与常见变体还原（只收高频字，避免误伤）
const VARIANT_MAP = {
  '臺': '台', '國': '国', '黨': '党', '習': '习', '澤': '泽', '東': '东', '獨': '独',
  '運': '运', '動': '动', '員': '员', '愛': '爱', '馬': '马', '門': '门', '開': '开',
  '關': '关', '電': '电', '腦': '脑', '網': '网', '號': '号', '賣': '卖', '買': '买',
  '賭': '赌', '錢': '钱', '詐': '诈', '騙': '骗', '黃': '黄', '這': '这', '個': '个',
  '們': '们', '來': '来', '時': '时', '點': '点', '聯': '联', '係': '系', '統': '统',
  '遠': '远', '機': '机', '場': '场', '軟': '软', '體': '体', '盤': '盘', '幣': '币',
  '貸': '贷', '證': '证', '槍': '枪', '麼': '么', '麽': '么', '輪': '轮', '轉': '转'
};
const VARIANT_RE = new RegExp('[' + Object.keys(VARIANT_MAP).join('') + ']', 'g');
function normalizeText(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase();
  t = t.replace(VARIANT_RE, (c) => VARIANT_MAP[c] || c);
  // 去分隔符：只留汉字、字母、数字（拆字/符号规避靠这一步合拢）
  t = t.replace(/[^a-z0-9一-鿿]/g, '');
  return t;
}
// 折叠连续重复字（法法法轮→法轮），抓重复字规避与刷屏变体
function collapseRepeats(t) {
  return String(t || '').replace(/(.)\1+/g, '$1');
}
// 数字→字母的 leet 还原（抓 l33t 式规避），只用于第二遍比对
function deLeet(t) {
  return String(t || '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
}
function normalizeVariants(s) {
  const a = normalizeText(s);
  return { flat: a, collapsed: collapseRepeats(a), leet: deLeet(a), leetCollapsed: collapseRepeats(deLeet(a)) };
}

// ---------- 词库 ----------
// wordsDb: { categories: { <cat>: { level:'hard'|'mild', words:[...] } }, whitelistDomains: [] }
// 返回预处理后的匹配结构（词也走同一套归一化）
function compileWords(wordsDb) {
  const hard = []; // {cat, forms:[...]}
  const mild = [];
  const cats = (wordsDb && wordsDb.categories) || {};
  for (const cat of Object.keys(cats)) {
    const entry = cats[cat] || {};
    const forms = new Set();
    for (const w of entry.words || []) {
      const v = normalizeVariants(w);
      if (v.flat) forms.add(v.flat);
      if (v.collapsed) forms.add(v.collapsed);
    }
    const rec = { cat, forms: [...forms] };
    if (entry.level === 'mild') mild.push(rec); else hard.push(rec);
  }
  hard.sort((x, y) => HARD_ORDER.indexOf(x.cat) - HARD_ORDER.indexOf(y.cat));
  return { hard, mild, whitelistDomains: ((wordsDb && wordsDb.whitelistDomains) || []).map(d => String(d).toLowerCase()) };
}

// ---------- 引流探测（对原文，词库之外） ----------
function detectContactBait(raw, whitelistDomains) {
  const text = String(raw || '').normalize('NFKC'); // 全角数字/字母先还原，否则 \d 抓不到
  const squishedDigits = text.replace(/[^\d]/g, '');
  // 手机号（去分隔后连续 11 位）
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(squishedDigits)) return 'phone';
  // 邮箱明文
  if (/[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(text)) return 'email';
  // QQ 号明示
  if (/(qq|扣扣|企鹅号)\s*[:：]?\s*\d{5,}/i.test(text)) return 'qq';
  // 微信号明示（微信/vx/weixin + 账号串）；wxid 本身就是微信号前缀，单独出现也算
  if (/(微信|weixin|vx|微\s*信)\s*[:：]?\s*[a-zA-Z][a-zA-Z0-9_-]{4,}/i.test(text)) return 'weixin';
  if (/wxid/i.test(text)) return 'weixin';
  // 外链：非白名单一律 ad
  const urlRe = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9-]+\.(com|cn|net|org|io|top|xyz|vip|cc|tv|me|app)(\/[^\s]*)?)/gi;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const host = m[0].replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
    if (!whitelistDomains.some(d => host === d || host.endsWith('.' + d))) return 'url';
  }
  if (/t\.me\/|telegram/i.test(text)) return 'url';
  return null;
}

// ---------- 刷屏结构探测 ----------
function detectSpamStructure(raw, flat) {
  const text = String(raw || '');
  // 同一字符连续重复 ≥10
  if (/(.)\1{9,}/.test(text)) return 'repeat-run';
  // 大段重复：归一化后唯一字符占比过低
  if (flat.length >= 60) {
    const uniq = new Set(flat).size;
    if (uniq / flat.length < 0.08) return 'low-diversity';
  }
  return null;
}

// ---------- 主判定 ----------
// input: { title, body }；compiled: compileWords 结果；
// ctx: { recentSameContent: n, recentSameTitle: n }（同作者 24h 内计数，服务端查）
// 返回 { tier:'A'|'B'|'C', category, detail } detail 只进日志
function reviewContent(input, compiled, ctx) {
  const title = String((input && input.title) || '');
  const body = String((input && input.body) || '');
  const raw = title + '\n' + body;
  const v = normalizeVariants(raw);

  // 1) 硬词类（按优先级）
  for (const rec of compiled.hard) {
    for (const w of rec.forms) {
      if (w && (v.flat.includes(w) || v.collapsed.includes(w) || v.leet.includes(w) || v.leetCollapsed.includes(w))) {
        return { tier: 'B', category: rec.cat, detail: 'word:' + rec.cat };
      }
    }
  }
  // 2) 引流探测 → ad
  const bait = detectContactBait(raw, compiled.whitelistDomains);
  if (bait) return { tier: 'B', category: 'ad', detail: 'bait:' + bait };
  // 3) 刷屏结构 → spam
  const spam = detectSpamStructure(raw, v.flat);
  if (spam) return { tier: 'B', category: 'spam', detail: 'spam:' + spam };
  // 4) 重复发布（服务端给的 24h 计数）
  if (ctx && ((ctx.recentSameContent || 0) >= 1 && (ctx.sameContentWithinHour || 0) >= 1)) {
    return { tier: 'B', category: 'spam', detail: 'spam:duplicate-fast' };
  }
  if (ctx && (ctx.recentSameTitle || 0) >= 2) {
    return { tier: 'B', category: 'spam', detail: 'spam:same-title-3rd' };
  }
  if (ctx && (ctx.recentSameContent || 0) >= 1) {
    return { tier: 'C', category: 'spam', detail: 'spam:duplicate' };
  }
  // 5) 轻度敏感词 → C
  for (const rec of compiled.mild) {
    for (const w of rec.forms) {
      if (w && (v.flat.includes(w) || v.collapsed.includes(w))) {
        return { tier: 'C', category: 'mild', detail: 'mild:' + rec.cat };
      }
    }
  }
  return { tier: 'A', category: null, detail: 'clean' };
}

// ---------- 禁言梯度（纯函数） ----------
// rejectEvents: [ms,...]（该用户全部驳回时刻）→ 当前应处的禁言状态
function muteStateFromRejects(rejectEvents, now) {
  const WIN = 30 * 86400000;
  const recent = (rejectEvents || []).filter(t => now - t < WIN);
  const n = recent.length;
  let muteUntil = null, permanent = false;
  if (n >= 8) permanent = true;
  else if (n >= 5) muteUntil = Math.max(...recent) + 30 * 86400000;
  else if (n >= 3) muteUntil = Math.max(...recent) + 7 * 86400000;
  // 梯度按「最近一次驳回 + 档期」推导：若档期已过则视为已恢复（除非有更新的驳回把它重新顶起，
  // 而那会体现在 recent 的最大值上）。注意：这不等于「驳回后固定禁 N 天从每次驳回起算」——
  // 与 QFClash applyRejectionConsequences 的口径一致：达到档位时把 mute_until 设为当次 +N 天。
  if (!permanent && muteUntil !== null && muteUntil <= now) muteUntil = null;
  return { count30d: n, muteUntil, permanent };
}

// ---------- 时间/频率闸门（纯函数） ----------
function shanghaiDayKey(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
const GATES = {
  newAccountBlockMs: 3600000,        // 新账号 1 小时禁发
  newAccountReviewMs: 7 * 86400000,  // 新号 <7 天首帖待审
  maxPostsPerDay: 10,
  maxRepliesPerDay: 50
};
function gateCheck(opts) {
  // opts: { now, accountCreatedAt, isFirstSubmission, postsToday, repliesToday, kind }
  if (opts.accountCreatedAt && (opts.now - opts.accountCreatedAt) < GATES.newAccountBlockMs) {
    return { ok: false, reason: 'too-new', msg: '新账号注册满 1 小时后才能发帖，请稍后再试。' };
  }
  if (opts.kind === 'post' && opts.postsToday >= GATES.maxPostsPerDay) {
    return { ok: false, reason: 'daily-posts', msg: '今日发帖已达上限（每天最多 10 帖），请明日再试。' };
  }
  if (opts.kind === 'reply' && opts.repliesToday >= GATES.maxRepliesPerDay) {
    return { ok: false, reason: 'daily-replies', msg: '今日回复已达上限（每天最多 50 条），请明日再试。' };
  }
  return { ok: true };
}
function needsFirstPostReview(opts) {
  // opts: { now, accountCreatedAt, isFirstSubmission }
  return !!(opts.isFirstSubmission && opts.accountCreatedAt && (opts.now - opts.accountCreatedAt) < GATES.newAccountReviewMs);
}

module.exports = {
  CATEGORIES, HARD_ORDER, normalizeText, collapseRepeats, deLeet, normalizeVariants,
  compileWords, detectContactBait, detectSpamStructure, reviewContent,
  muteStateFromRejects, shanghaiDayKey, GATES, gateCheck, needsFirstPostReview
};
