'use strict';
/*
 * QFRemote 官网留言通道（自家通道，2026-10-24 分家落地）
 * ================================================================
 * 背景：此前官网留言借用 QFClash 的账号 Worker 收件。用户亲令两项目
 * 分家后，改走 QFRemote 自家通道：本模块挂在论坛服务进程内新增
 * POST /api/feedback（经本机 nginx 反代 + 临时通道对外），与论坛
 * 业务互不相干，只是同进程承载。
 *
 * 口径（与官网留言表单字段完全一致，用户无感切换）：
 *  - 先入库：留言先 append 落盘 data/feedback.jsonl，落盘成功才回 ok；
 *  - 再转发：异步转发到站长邮箱；失败进待发状态，进程内每 5 分钟
 *    重试，状态落 feedback-mail-state.json，每次尝试写
 *    logs/feedback-mail.log，不丢件、可查账。
 *  - 转发走本机 Postfix 的回环 SMTP（127.0.0.1:25，postfix 现配置
 *    inet_interfaces=loopback-only）：本服务 systemd 单元开了
 *    NoNewPrivileges＋ProtectSystem=strict，进程内直接调 sendmail
 *    会被 postdrop 的 setgid 与只读 spool 双重挡死（2026-10-24 实证），
 *    故不用 sendmail 落盘、改走 SMTP 投递，服务自身不碰邮件队列目录。
 *  - 注意：当前服务器出站 SMTP 被云厂商限制（25 端口连接超时），
 *    邮件会停在本机 Postfix 队列里等放行/改走域名发信；入库不受影响。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const ADMIN_EMAIL = 'a718983610@gmail.com';
const MAX_CONTENT = 2000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 5;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;

function mailDomain() {
  try {
    const s = fs.readFileSync('/etc/mailname', 'utf8').trim();
    if (s) return s;
  } catch (e) {}
  return os.hostname();
}

function encWord(s) {
  return '=?UTF-8?B?' + Buffer.from(String(s), 'utf8').toString('base64') + '?=';
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function createFeedback(opts) {
  const dataDir = opts.dataDir;
  const logDir = opts.logDir;
  const storeFile = path.join(dataDir, 'feedback.jsonl');
  const stateFile = path.join(dataDir, 'feedback-mail-state.json');
  const mailLogFile = path.join(logDir, 'feedback-mail.log');

  function loadState() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return {}; }
  }
  function saveState(st) {
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(st));
    fs.renameSync(stateFile + '.tmp', stateFile);
  }
  function mailLog(line) {
    try { fs.appendFileSync(mailLogFile, new Date().toISOString() + ' ' + line + '\n'); } catch (e) {}
  }
  function loadItems() {
    try {
      return fs.readFileSync(storeFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) { return []; }
  }

  function buildMessage(item) {
    const from = 'qfremote-feedback@' + mailDomain();
    const subjRaw = '[QFRemote 官网留言] ' + item.content.replace(/\s+/g, ' ').slice(0, 40);
    const when = new Date(item.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const lines = [
      'From: ' + encWord('QFRemote 官网留言') + ' <' + from + '>',
      'To: ' + ADMIN_EMAIL,
      'Subject: ' + encWord(subjRaw),
      'Content-Type: text/plain; charset=utf-8',
      'X-QFRemote-Feedback-Id: ' + item.id,
      '',
      '官网收到一条新留言：',
      '',
      item.content,
      '',
      '——',
      '联系方式：' + (item.contact || '（未留）'),
      '来源平台：' + (item.platform || '-') + ' / ' + (item.source || '-'),
      '版本：' + (item.appVersion || '-'),
      '设备标识：' + (item.deviceHash || '-'),
      '提交时间：' + when + '（北京时间）',
      '留言编号：' + item.id,
    ];
    return { from, text: lines.join('\n') + '\n' };
  }

  // 经回环 SMTP 把信投给本机 Postfix（250=已受理进队列）
  function smtpSubmit(from, text, cb) {
    const sock = net.connect(25, '127.0.0.1');
    sock.setTimeout(20000);
    let buf = '', step = 0, done = false;
    const dataPayload = text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.\r\n';
    const steps = [
      null, // 等 220 问候
      'EHLO qfremote-feedback\r\n',
      'MAIL FROM:<' + from + '>\r\n',
      'RCPT TO:<' + ADMIN_EMAIL + '>\r\n',
      'DATA\r\n',
      dataPayload,
      'QUIT\r\n',
    ];
    const finish = (ok, info) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} cb(ok, info); };
    sock.on('timeout', () => finish(false, 'smtp timeout'));
    sock.on('error', e => finish(false, 'smtp ' + (e && e.message || e)));
    sock.on('data', d => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!/^\d{3}-/.test(line)) { // 多行回复只认最后一行
          const code = parseInt(line.slice(0, 3), 10);
          if (step === 0) { if (code !== 220) return finish(false, 'greeting ' + line); }
          else if (step <= 4) { if (code >= 400) return finish(false, 'step' + step + ' ' + line); }
          else if (step === 5) { if (code >= 400) return finish(false, 'data ' + line); return finish(true, line); }
          step++;
          if (steps[step]) sock.write(steps[step]);
        }
      }
    });
  }

  let sending = false;
  function trySend(item, done) {
    const st = loadState();
    const rec = st[item.id] || { status: 'pending', attempts: 0 };
    const msg = buildMessage(item);
    smtpSubmit(msg.from, msg.text, (ok, info) => {
      rec.attempts++; rec.lastAttemptAt = Date.now();
      if (ok) {
        rec.status = 'queued'; rec.lastError = '';
        mailLog(item.id + ' submitted-to-mta attempt=' + rec.attempts + ' ' + info);
      } else {
        rec.status = 'submit-failed'; rec.lastError = String(info || '').slice(0, 200);
        mailLog(item.id + ' submit-failed ' + rec.lastError);
      }
      st[item.id] = rec; saveState(st);
      done && done(ok);
    });
  }

  function flushOutbox() {
    if (sending) return;
    const st = loadState();
    const pending = loadItems().filter(it => {
      const r = st[it.id];
      return !r || r.status === 'pending' || r.status === 'submit-failed';
    });
    if (!pending.length) return;
    sending = true;
    const next = () => {
      const it = pending.shift();
      if (!it) { sending = false; return; }
      trySend(it, () => next());
    };
    next();
  }
  const timer = setInterval(flushOutbox, RETRY_INTERVAL_MS);
  if (timer.unref) timer.unref();
  setTimeout(flushOutbox, 30000).unref();

  // ---- 限频（按来源 IP，进程内计数）----
  const hits = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX_PER_WINDOW) { hits.set(ip, arr); return true; }
    arr.push(now); hits.set(ip, arr);
    return false;
  }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  function sendJson(res, code, obj) {
    cors(res);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function handleOptions(req, res) {
    cors(res);
    res.writeHead(204);
    res.end();
  }

  function handlePost(req, res) {
    const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (rateLimited(ip)) return sendJson(res, 429, { ok: false, message: '提交过于频繁，请稍后再试。' });
    let body = '';
    let tooBig = false;
    req.on('data', c => { body += c; if (body.length > 16384) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return sendJson(res, 413, { ok: false, message: '留言内容过长，请删减后再提交。' });
      let j;
      try { j = JSON.parse(body || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, message: '提交格式不正确，请检查后重试。' }); }
      const content = clean(j.content, MAX_CONTENT);
      if (!content) return sendJson(res, 400, { ok: false, message: '请先填写留言内容后再提交。' });
      const item = {
        id: 'fb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        ts: Date.now(),
        content,
        contact: clean(j.contact, 200),
        platform: clean(j.platform, 40),
        source: clean(j.source, 60),
        appVersion: clean(j.appVersion, 40),
        deviceHash: clean(j.deviceHash, 80),
        ip,
      };
      try {
        fs.appendFileSync(storeFile, JSON.stringify(item) + '\n');
      } catch (e) {
        return sendJson(res, 500, { ok: false, message: '服务器暂时出现问题，请稍后再试。' });
      }
      // 先入库已完成，再转发（异步，不挡用户）
      trySend(item, () => {});
      return sendJson(res, 200, { ok: true });
    });
  }

  return { handlePost, handleOptions };
}

module.exports = { createFeedback };
