'use strict';
/*
 * QFRemote 扩展服务 · 站长 API 事件队列（站长 2026-10-25 #22 定版、#31 扩围）
 * ================================================================
 * 软件内全部审核队列统一入队并落库：付款订单（一审）、申诉、换绑
 * 申请、设备异常待复核、论坛待审、客服转人工工单——一切进审核队列
 * 的事项都生成事件，助手凭专用令牌按自增游标增量拉取、看详情、经
 * 既有双通道裁定入口回写结论（执行者留痕「助手接口」，防双判沿用
 * 各队列原机制，本模块只做事件簿记，不另起裁定逻辑）。
 *
 * 令牌：服务端只存 SHA-256 哈希；明文仅在生成/重置时写入服务器
 * 文件 assistant-api-token.txt（0600）供助手经 SSH 自取，绝不进
 * 任何接口响应与日志。管理面可生成/重置/吊销并看状态与最近调用。
 * 本组只读高频接口（游标拉取）不得被限流误伤：ext 本无全局 IP
 * 限流，nginx 侧亦不给 /assistant-api/ 挂 limit_req（部署口径）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENT_TYPES = ['order', 'appeal', 'rebind', 'device_review', 'forum', 'support'];
const TYPE_NAMES = {
  order: '付款订单', appeal: '申诉', rebind: '换绑申请',
  device_review: '设备异常待复核', forum: '论坛待审', support: '客服工单',
};
const MAX_EVENTS = 3000;

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function createEventsCore(deps) {
  const dataDir = deps.dataDir;
  const log = deps.log || (() => {});
  const file = path.join(dataDir, 'events.json');
  const tokenMetaFile = path.join(dataDir, 'assistant-token.json');
  const tokenPlainFile = deps.tokenPlainFile || '/opt/qfremote-ext/assistant-api-token.txt';
  const ownerTokenPlainFile = deps.ownerTokenPlainFile || '/opt/qfremote-ext/owner-api-token.txt';
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}

  // EV-1 兜底：可选销账前置断言（deps.resolveGuard），返回 false 或抛错即拒绝
  // 销账；未注入时行为与旧版逐字一致。guard 只决定「能不能标 done」，不参与
  // 裁定本身（补丁源 verify-ev1-20261026，DS 门一 2026-10-29 裁定部署）。
  const resolveGuard = typeof deps.resolveGuard === 'function' ? deps.resolveGuard : null;
  // EV-2/EV-3（DS 门一成稿，ds-p1-rest-20261029）：三态加载——ENOENT 静默空启；
  // 读/解析/形状异常一律告警＋原件改名隔离后空启，原件永不被后续 save() 覆盖；
  // seq 高水位恢复为 max(seq, max(id))，防重号与游标回退；元素逐个验对象＋数值 id。
  let store = { seq: 0, items: [] };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!v || !Array.isArray(v.items) || !v.items.every((entry) => entry && typeof entry === 'object' && typeof entry.id === 'number' && !Number.isNaN(entry.id))) {
      throw new Error('events store shape invalid');
    }
    store = v;
    const maxId = v.items.reduce((acc, e) => Math.max(acc, e.id), 0);
    const parsedSeq = (typeof v.seq === 'number' && !Number.isNaN(v.seq)) ? v.seq : 0;
    const targetSeq = Math.max(parsedSeq, maxId);
    if (targetSeq !== v.seq) {
      log({ ev: 'review-events-seq-adjusted', oldSeq: (v.seq === undefined ? null : v.seq), newSeq: targetSeq });
      store.seq = targetSeq;
    }
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) {
      log({ ev: 'review-events-load-error', err: String((e && e.message) || e) });
      const corrupt = file + '.corrupt-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      try { fs.renameSync(file, corrupt); } catch (renameErr) { log({ ev: 'review-events-load-isolate-failed', err: String((renameErr && renameErr.message) || renameErr) }); }
    }
  }
  function save() {
    if (store.items.length > MAX_EVENTS) {
      const done = store.items.filter((e) => e.status === 'done');
      const keep = store.items.filter((e) => e.status !== 'done')
        .concat(done.slice(-Math.max(0, MAX_EVENTS - store.items.filter((e) => e.status !== 'done').length)));
      store.items = keep.sort((a, b) => a.id - b.id);
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function enqueue(type, refId, summary) {
    if (!EVENT_TYPES.includes(type) || !refId) return null;
    const open = store.items.find((e) => e.type === type && e.refId === String(refId) && e.status === 'pending');
    if (open) return open; // 同单只挂一条待处理事件
    const ev = {
      id: ++store.seq, type, typeName: TYPE_NAMES[type], refId: String(refId),
      summary: summary || {}, createdAt: Date.now(),
      status: 'pending', handledBy: null, handledAt: null, result: null,
    };
    store.items.push(ev); save();
    log({ ev: 'review-event-enqueued', type, refId: ev.refId, eventId: ev.id });
    return ev;
  }
  function resolve(type, refId, actor, result) {
    const ev = store.items.find((e) => e.type === type && e.refId === String(refId) && e.status === 'pending');
    if (!ev) return null;
    if (resolveGuard) {
      let ok = false;
      try { ok = resolveGuard(type, ev.refId, actor, result) !== false; } catch (e) { ok = false; }
      if (!ok) { log({ ev: 'review-event-resolve-blocked', type, refId: ev.refId, eventId: ev.id, actor: actor || null }); return null; }
    }
    ev.status = 'done'; ev.handledBy = actor || null; ev.handledAt = Date.now(); ev.result = result || null;
    save();
    log({ ev: 'review-event-resolved', type, refId: ev.refId, eventId: ev.id, actor: ev.handledBy, result: ev.result });
    return ev;
  }
  function list(after, opts) {
    const o = opts || {};
    const lim = Math.min(200, Math.max(1, Number(o.limit) || 50));
    let items = store.items.filter((e) => e.id > (Number(after) || 0));
    if (o.type && EVENT_TYPES.includes(o.type)) items = items.filter((e) => e.type === o.type);
    if (o.status === 'pending' || o.status === 'done') items = items.filter((e) => e.status === o.status);
    items = items.slice(0, lim);
    return { events: items, nextCursor: items.length ? items[items.length - 1].id : (Number(after) || 0) };
  }
  function getById(id) { return store.items.find((e) => e.id === Number(id)) || null; }
  function counts() {
    const c = {}; for (const t of EVENT_TYPES) c[t] = 0;
    for (const e of store.items) if (e.status === 'pending' && c[e.type] !== undefined) c[e.type] += 1;
    return c;
  }
  function recentDone(limit) {
    return store.items.filter((e) => e.status === 'done')
      .sort((a, b) => (b.handledAt || 0) - (a.handledAt || 0)).slice(0, Math.min(50, Number(limit) || 20));
  }

  // ---------- 接口令牌（只存哈希；明文只落 600 文件） ----------
  // 双槽并存：顶层四字段＝助手槽（qfa_，行为不变）；owner 子对象＝站长
  // 全开槽（qfo_，decide 不受订单阶段限制），两槽独立生成/吊销。
  // 单写者约束（DS-R26-③）：assistant-token.json 只许运行中的 ext 进程
  // 经本模块读写，外部工具一律经管理端点生成/吊销，禁直改文件；meta 为
  // 读-改-写整文件，writeTokenMeta 的 tmp 用 pid 后缀隔离多进程误并发写。
  function readTokenMeta() {
    try { const v = JSON.parse(fs.readFileSync(tokenMetaFile, 'utf8')); if (v && typeof v === 'object') return v; } catch (e) {}
    return { status: 'none', hash: null, createdAt: null, lastUsedAt: null };
  }
  function writeTokenMeta(m) {
    const tmp = tokenMetaFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, tokenMetaFile);
  }
  function ownerSlot(m) {
    return (m.owner && typeof m.owner === 'object') ? m.owner : null;
  }
  function tokenStatus() {
    const m = readTokenMeta();
    const owner = ownerSlot(m) || { status: 'none', createdAt: null, lastUsedAt: null };
    return {
      status: m.status, createdAt: m.createdAt, lastUsedAt: m.lastUsedAt, plainFile: tokenPlainFile,
      owner: { status: owner.status, createdAt: owner.createdAt, lastUsedAt: owner.lastUsedAt, plainFile: ownerTokenPlainFile },
    };
  }
  function generateToken() {
    // 读-改-写单槽：顶层四字段＝助手槽，owner 子对象原样保留（旧版整对象覆写会抹掉 owner 槽）
    const m = readTokenMeta();
    const plain = 'qfa_' + crypto.randomBytes(32).toString('hex');
    m.status = 'active'; m.hash = sha256(plain); m.createdAt = Date.now(); m.lastUsedAt = null;
    writeTokenMeta(m);
    fs.writeFileSync(tokenPlainFile, plain + '\n', { mode: 0o600 });
    try { fs.chmodSync(tokenPlainFile, 0o600); } catch (e) {}
    log({ ev: 'assistant-token-generated' });
    return { ok: true, status: 'active', plainFile: tokenPlainFile };
  }
  function revokeToken() {
    const m = readTokenMeta();
    m.status = 'revoked'; m.hash = null; // createdAt/lastUsedAt 保留（与旧版语义一致）
    writeTokenMeta(m);
    try { fs.unlinkSync(tokenPlainFile); } catch (e) {}
    log({ ev: 'assistant-token-revoked' });
    return { ok: true, status: 'revoked' };
  }
  function generateOwnerToken() {
    const m = readTokenMeta();
    const plain = 'qfo_' + crypto.randomBytes(32).toString('hex');
    const owner = ownerSlot(m) || {};
    owner.status = 'active'; owner.hash = sha256(plain); owner.createdAt = Date.now(); owner.lastUsedAt = null;
    m.owner = owner;
    writeTokenMeta(m);
    fs.writeFileSync(ownerTokenPlainFile, plain + '\n', { mode: 0o600 });
    try { fs.chmodSync(ownerTokenPlainFile, 0o600); } catch (e) {}
    log({ ev: 'owner-token-generated' });
    return { ok: true, status: 'active', plainFile: ownerTokenPlainFile };
  }
  function revokeOwnerToken() {
    const m = readTokenMeta();
    const owner = ownerSlot(m) || {};
    owner.status = 'revoked'; owner.hash = null; // createdAt/lastUsedAt 保留
    m.owner = owner;
    writeTokenMeta(m);
    try { fs.unlinkSync(ownerTokenPlainFile); } catch (e) {}
    log({ ev: 'owner-token-revoked' });
    return { ok: true, status: 'revoked' };
  }
  function isSha256Hex(v) { return typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v); }
  let lastUsedWriteAssistant = 0;
  let lastUsedWriteOwner = 0;
  function verifyTokenRole(plain) {
    if (!plain) return null;
    const m = readTokenMeta();
    const candidate = Buffer.from(sha256(plain), 'hex');
    let role = null;
    let changed = false;
    if (m.status === 'active' && isSha256Hex(m.hash)) {
      const buf = Buffer.from(m.hash, 'hex');
      if (buf.length === candidate.length && crypto.timingSafeEqual(candidate, buf)) {
        role = 'assistant';
        const now = Date.now();
        if (now - lastUsedWriteAssistant > 30000) { lastUsedWriteAssistant = now; m.lastUsedAt = now; changed = true; }
      }
    }
    const owner = ownerSlot(m);
    if (owner && owner.status === 'active' && isSha256Hex(owner.hash)) {
      const buf = Buffer.from(owner.hash, 'hex');
      if (buf.length === candidate.length && crypto.timingSafeEqual(candidate, buf)) {
        role = 'owner';
        const now = Date.now();
        if (now - lastUsedWriteOwner > 30000) { lastUsedWriteOwner = now; owner.lastUsedAt = now; changed = true; }
      }
    }
    if (changed) { try { writeTokenMeta(m); } catch (e) {} }
    return role;
  }
  function verifyToken(plain) {
    return verifyTokenRole(plain) !== null;
  }

  return {
    EVENT_TYPES, TYPE_NAMES,
    enqueue, resolve, list, getById, counts, recentDone,
    tokenStatus, generateToken, revokeToken, verifyToken,
    generateOwnerToken, revokeOwnerToken, verifyTokenRole,
    tokenPlainFile, ownerTokenPlainFile,
  };
}

module.exports = { createEventsCore, EVENT_TYPES, TYPE_NAMES };
