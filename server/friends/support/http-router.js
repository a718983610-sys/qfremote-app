'use strict';
/*
 * QFRemote 智能客服 · HTTP 路由（框架无关，挂载点见 INTEGRATION.md）
 * ================================================================
 * 宿主注入：
 *  - authenticate(req)      → 已登录用户名或 null（复用宿主既有会话校验，
 *                             含 2.3.0 单次登录口径；本模块不自建登录）
 *  - authenticateAdmin(req) → 站长身份布尔（回复台用）
 * 会话凭不透明令牌（Cookie qfr_sup 或请求头 x-support-session）。
 * 未登录（anon）会话限频更严；身份核对另有失败锁定（引擎内）。
 */
const crypto = require('crypto');

function createSupportRouter(deps) {
  const engine = deps.engine;
  const store = deps.store;
  const limits = Object.assign({
    anonMsgPerHour: 30, userMsgPerHour: 120, verifyPerHour: 10, handoffPerDay: 5
  }, deps.limits || {});

  const buckets = new Map(); // key -> [timestamps]
  function hit(key, max, windowMs) {
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { buckets.set(key, arr); return false; }
    arr.push(now); buckets.set(key, arr); return true;
  }
  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }
  function readBody(req) {
    return new Promise(resolve => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 65536) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
      req.on('close', () => resolve({}));
    });
  }
  function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return String(req.socket.remoteAddress || '');
  }
  function sessionToken(req, body) {
    if (body && body.session) return String(body.session);
    const h = req.headers['x-support-session'];
    if (h) return String(h);
    const ck = String(req.headers.cookie || '');
    const m = ck.match(/(?:^|;\s*)qfr_sup=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  const tokens = new Map(); // token -> sessionId
  function issueToken(sessionId) {
    const t = crypto.randomBytes(24).toString('hex');
    tokens.set(t, sessionId);
    return t;
  }
  function loadSession(req, body) {
    const t = sessionToken(req, body);
    if (!t) return null;
    const sid = tokens.get(t);
    if (!sid) return null;
    return store.getSession(sid);
  }

  async function handler(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    if (!p.startsWith('/support/api')) return false;
    const sub = p.slice('/support/api'.length);
    const ip = clientIp(req);

    if (req.method === 'POST' && sub === '/session') {
      const body = await readBody(req);
      const user = deps.authenticate ? await deps.authenticate(req) : null;
      const sess = engine.newSession(user ? 'user' : 'anon', user);
      store.putSession(sess);
      const token = issueToken(sess.id);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Set-Cookie': 'qfr_sup=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'
      });
      res.end(JSON.stringify({ ok: true, session: token, kind: sess.kind, welcome: engine.welcome(sess) }));
      return true;
    }

    if (req.method === 'POST' && sub === '/message') {
      const body = await readBody(req);
      const sess = loadSession(req, body);
      if (!sess) { sendJson(res, 401, { ok: false, msg: '会话不存在或已过期，请重新进入客服。' }); return true; }
      const max = sess.kind === 'anon' ? limits.anonMsgPerHour : limits.userMsgPerHour;
      if (!hit('msg:' + sess.id, max, 3600000) || !hit('msgip:' + ip, max * 3, 3600000)) {
        sendJson(res, 429, { ok: false, msg: '咨询过于频繁，请稍后再试。' }); return true;
      }
      let replies;
      if (body.pick) replies = await engine.handlePick(sess, String(body.pick));
      else replies = await engine.handleText(sess, String(body.text || ''));
      sendJson(res, 200, { ok: true, replies });
      return true;
    }

    if (req.method === 'POST' && sub === '/verify') {
      const body = await readBody(req);
      const sess = loadSession(req, body);
      if (!sess) { sendJson(res, 401, { ok: false, msg: '会话不存在或已过期，请重新进入客服。' }); return true; }
      if (!hit('verify:' + sess.id, limits.verifyPerHour, 3600000) || !hit('verifyip:' + ip, limits.verifyPerHour * 2, 3600000)) {
        sendJson(res, 429, { ok: false, msg: '核对过于频繁，请稍后再试。' }); return true;
      }
      const r = await engine.verifyIdentity(sess, String(body.account || ''), String(body.password || ''));
      sendJson(res, 200, { ok: r.ok, reason: r.reason || null, text: r.text || null, follow: r.follow || null });
      return true;
    }

    // —— 站长回复台（客服收件箱） ——
    if (sub.startsWith('/admin')) {
      const isAdmin = deps.authenticateAdmin ? await deps.authenticateAdmin(req) : false;
      if (!isAdmin) { sendJson(res, 403, { ok: false, msg: '需要站长身份。' }); return true; }
      if (req.method === 'GET' && sub === '/admin/tickets') {
        const list = Object.values(store.allTickets())
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(t => ({ id: t.id, status: t.status, anon: t.anon, user: t.user, verifiedAccount: t.verifiedAccount, email: t.email, description: t.description, createdAt: t.createdAt, updatedAt: t.updatedAt, messages: t.messages }));
        sendJson(res, 200, { ok: true, tickets: list });
        return true;
      }
      if (req.method === 'POST' && sub === '/admin/reply') {
        const body = await readBody(req);
        const t = store.getTicket(String(body.ticketId || ''));
        if (!t || t.status !== 'open') { sendJson(res, 404, { ok: false, msg: '工单不存在或已关闭。' }); return true; }
        const text = String(body.text || '').trim();
        if (!text) { sendJson(res, 400, { ok: false, msg: '回复内容不能为空。' }); return true; }
        t.messages.push({ role: 'agent', name: '人工客服', text, ts: Date.now() });
        t.updatedAt = Date.now(); store.putTicket(t);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'POST' && sub === '/admin/close') {
        const body = await readBody(req);
        const t = store.getTicket(String(body.ticketId || ''));
        if (!t) { sendJson(res, 404, { ok: false, msg: '工单不存在。' }); return true; }
        t.status = 'closed'; t.updatedAt = Date.now(); store.putTicket(t);
        const sess = store.getSession(t.sessionId);
        if (sess && sess.ticketId === t.id) { sess.ticketId = null; store.putSession(sess); }
        sendJson(res, 200, { ok: true });
        return true;
      }
      sendJson(res, 404, { ok: false, msg: '接口不存在。' });
      return true;
    }

    // 用户侧拉取本会话内人工回复
    if (req.method === 'GET' && sub === '/ticket') {
      const sess = loadSession(req, {});
      if (!sess) { sendJson(res, 401, { ok: false, msg: '会话不存在或已过期。' }); return true; }
      const t = sess.ticketId ? store.getTicket(sess.ticketId) : store.openTicketOf(sess.id);
      sendJson(res, 200, { ok: true, ticket: t ? { id: t.id, status: t.status, messages: t.messages } : null });
      return true;
    }

    sendJson(res, 404, { ok: false, msg: '接口不存在。' });
    return true;
  }

  return handler;
}

module.exports = { createSupportRouter };
