'use strict';
/*
 * QFRemote 智能客服 · 存储层
 * 会话与工单落 JSON 文件（tmp+rename 原子写），消息与未命中留痕走 jsonl 追加。
 * 与现行 social-svc 各服务的落盘习惯一致，不引入数据库。
 */
const fs = require('fs');
const path = require('path');

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
function readJson(file, fallback) {
  // F-2（发版前全量审 P3）：原实现解析失败静默回退空数据，下一次 save 即覆盖
  // 损坏原件、无痕灭失。改与 events-core 隔离口径对齐并按 DS 门一收紧：
  // ENOENT（首跑无文件）才静默回退；解析失败先改名隔离 .corrupt-* 留痕再回退；
  // 非 ENOENT 读错误与隔离改名失败一律抛错硬停，禁止以空数据启动后写回覆盖。
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    console.error(JSON.stringify({ ev: 'support-store-load-error', file, err: String((e && e.message) || e) }));
    throw e;
  }
  try { const v = JSON.parse(raw); return v == null ? fallback : v; }
  catch (e) {
    const corrupt = file + '.corrupt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    try { fs.renameSync(file, corrupt); }
    catch (renameErr) {
      console.error(JSON.stringify({ ev: 'support-store-isolate-failed', file, err: String((renameErr && renameErr.message) || renameErr) }));
      throw renameErr;
    }
    console.error(JSON.stringify({ ev: 'support-store-corrupt-isolated', file, corrupt }));
    return fallback;
  }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function appendJsonl(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 }); } catch (e) {}
}

function createStore(dataDir) {
  ensureDir(dataDir);
  const sessionsFile = path.join(dataDir, 'support-sessions.json');
  const ticketsFile = path.join(dataDir, 'support-tickets.json');
  const messagesFile = path.join(dataDir, 'support-messages.jsonl');
  const unhitsFile = path.join(dataDir, 'support-unhits.jsonl');

  let sessions = readJson(sessionsFile, {});
  let tickets = readJson(ticketsFile, {});

  return {
    getSession(id) { return sessions[id] || null; },
    putSession(s) { sessions[s.id] = s; writeJson(sessionsFile, sessions); },
    allSessions() { return sessions; },
    getTicket(id) { return tickets[id] || null; },
    putTicket(t) { tickets[t.id] = t; writeJson(ticketsFile, tickets); },
    allTickets() { return tickets; },
    appendMessage(m) { appendJsonl(messagesFile, m); },
    appendUnhit(u) { appendJsonl(unhitsFile, u); },
    // 账号注销/封禁后清除客服数据：alive 为当前仍存在的账号集合（小写登录名）。
    // 覆盖范围（总线裁定口径）：会话/工单两表＋可归属的 jsonl 留痕行。
    // 归属判定：两表认会话/工单上记录的账号（user 或 verifiedAccount）；
    // messages.jsonl 认 sessionId 属于被清会话；unhits.jsonl 认 user 字段为
    // 已消失账号。不可归属的行（纯未登录未核对会话、无账号字段、解析失败的
    // 行）一律保留。安全闸：alive 为空集时整体跳过——存活集合来自官方
    // users 命令，空集只可能是异常，绝不能据此清空全部客服数据。
    purgeAccountsNotIn(alive) {
      let ns = 0, nt = 0, nm = 0, nu = 0; const deadSessions = new Set();
      if (!alive || alive.size === 0) return { sessions: 0, tickets: 0, messageLines: 0, unhitLines: 0 };
      for (const s of Object.values(sessions)) {
        const acct = s.user || s.verifiedAccount;
        if (acct && !alive.has(String(acct).toLowerCase())) { deadSessions.add(s.id); delete sessions[s.id]; ns++; }
      }
      for (const t of Object.values(tickets)) {
        const acct = t.user || t.verifiedAccount;
        if ((acct && !alive.has(String(acct).toLowerCase())) || deadSessions.has(t.sessionId)) { delete tickets[t.id]; nt++; }
      }
      if (ns) writeJson(sessionsFile, sessions);
      if (nt) writeJson(ticketsFile, tickets);
      // jsonl 过滤重写：逐行判定归属，命中已消失账号的行删除，其余原样保留。
      const filterJsonl = (file, drop) => {
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return 0; }
        const lines = raw.split('\n').filter(l => l.length > 0);
        const kept = []; let removed = 0;
        for (const line of lines) {
          let rec = null;
          try { rec = JSON.parse(line); } catch (e) { rec = null; }
          if (rec && drop(rec)) { removed++; } else { kept.push(line); }
        }
        if (removed) {
          const tmp = file + '.tmp';
          fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
          fs.renameSync(tmp, file);
        }
        return removed;
      };
      if (deadSessions.size) {
        nm = filterJsonl(messagesFile, rec => deadSessions.has(rec.sessionId));
      }
      nu = filterJsonl(unhitsFile, rec => rec.user && !alive.has(String(rec.user).toLowerCase()));
      return { sessions: ns, tickets: nt, messageLines: nm, unhitLines: nu };
    },
    openTicketOf(sessionId) {
      for (const t of Object.values(tickets)) {
        if (t.sessionId === sessionId && t.status === 'open') return t;
      }
      return null;
    }
  };
}

module.exports = { createStore };
