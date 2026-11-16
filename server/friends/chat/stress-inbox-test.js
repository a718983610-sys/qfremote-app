'use strict';
/*
 * QFRemote 友聊事件流压力测试（S-048/S-053/S-051，C-3 线）
 * ================================================================
 * 目的：实证长离线丢消息已被修掉——收件人 inbox 剪枝后，poll 报 gap，
 * 客户端走 /chat/api/catchup 按 seq 补回错过的消息密文，保险库最终零丢失。
 *
 * 前置：本目录已 npm install（libsodium-wrappers-sumo / ws，见 package.json）。
 * 不需要真实 MeshCentral：脚本内起一个假控制通道（ws 服务），对任意账号
 * 密码回 userinfo；登录、建钥匙、收发全走真实 handler 与真实加解密
 * （crypto-core.js，libsodium）。
 *
 * 规模说明（诚实口径）：生产默认 inboxCap=2000、全局截断 5000，跑满 5000 条
 * 全量落盘太慢；本脚本把 inboxCap 收紧到 50（与生产同一条剪枝/gap/catchup
 * 代码路径，只是阈值不同），发 111 条即触发剪枝。数字全部是本轮实跑结果，
 * 不编。用法：node stress-inbox-test.js（跑完自动收，退出码 0=全过）。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { createChatHandler } = require('./chat-server');
const C = require('./crypto-core');

const TESTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfchat-stress-'));
fs.mkdirSync(path.join(TESTDIR, 'provider-mirror', 'license'), { recursive: true });
fs.writeFileSync(path.join(TESTDIR, 'provider-mirror', 'license', 'status.json'), '{}');
const ALICE = 'alice'; const ALICE_PW = 'AlicePass123';
const BOB = 'bob'; const BOB_PW = 'BobPass12345';
const CAROL = 'carol'; const CAROL_PW = 'CarolPass123';
const INBOX_CAP = 50;      // 测试收紧值（生产默认 2000，同一条代码路径）
const POLL_PAGE = 25;      // 测试收紧值（生产默认 500）
const FLOOD_EACH = 55;     // 每发件人洪水消息数（发送限频 60/分钟/人，55 留余量）
const VAULT_PAGE = 20;     // 保险库分页每页条数

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}

// ---------- 假 MeshCentral 控制通道：任意账号密码都验真 ----------
function startFakeMc() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws, req) => {
      const auth = String((req.headers && req.headers['x-meshauth']) || '');
      const user = Buffer.from((auth.split(',')[0] || ''), 'base64').toString('utf8') || 'alice';
      setTimeout(() => {
        try { ws.send(JSON.stringify({ action: 'userinfo', userinfo: { _id: 'user/domain/' + user, name: user, siteadmin: 0 } })); } catch (e) {}
      }, 5);
    });
    wss.on('listening', () => resolve({ wss, port: wss.address().port }));
  });
}

function startChat(cfgExtra) {
  return new Promise((resolve, reject) => {
    const cfg = Object.assign({
      port: 0, bind: '127.0.0.1',
      mcUrl: 'ws://127.0.0.1:' + cfgExtra.mcPort + '/control.ashx',
      dataFile: path.join(TESTDIR, 'chat-data.json'),
      friendsFile: path.join(TESTDIR, 'friends.json'),
      logFile: path.join(TESTDIR, 'chat.log'),
      inboxCap: INBOX_CAP, pollPageSize: POLL_PAGE,
    }, cfgExtra.overrides || {});
    delete cfg.mcPort; delete cfg.overrides;
    let handler;
    try { handler = createChatHandler(cfg); } catch (e) { return reject(e); }
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port }));
  });
}

// ---------- 与 chat-client.js 同款的最小客户端（一个实例 = 一台设备） ----------
class Client {
  constructor(base, user, password) { this.base = base; this.user = user; this.password = password; this.token = ''; this.priv = ''; this.vaultKey = ''; this.lastSeq = 0; this.pubCache = {}; this.history = {}; }
  async api(method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['x-qfchat-token'] = this.token;
    const r = await fetch(this.base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.msg || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return j;
  }
  async login() {
    const r = await this.api('POST', '/chat/api/login', { username: this.user, password: this.password });
    this.token = r.token;
    const k = await this.api('GET', '/chat/api/keys/me');
    if (!k.keys) {
      const id = C.newIdentity(); const vk = C.newVaultKey();
      await this.api('POST', '/chat/api/keys/setup', { pub: id.pubB64, wrappedPriv: C.wrapWithPassword(id.privB64, this.password), wrappedVault: C.wrapWithPassword(vk, this.password) });
      this.priv = id.privB64; this.vaultKey = vk;
    } else {
      this.priv = C.unwrapWithPassword(k.keys.wrappedPriv, this.password);
      this.vaultKey = C.unwrapWithPassword(k.keys.wrappedVault, this.password);
      if (this.priv === null || this.vaultKey === null) throw new Error('UNWRAP-FAILED');
    }
  }
  async convKey(peer) {
    if (!this.pubCache[peer]) { const r = await this.api('GET', '/chat/api/keys/' + peer); this.pubCache[peer] = r.pub; }
    return C.conversationKey(this.priv, this.pubCache[peer]);
  }
  async send(peer, text) {
    const key = await this.convKey(peer);
    const s = C.sealMessage(key, text);
    const r = await this.api('POST', '/chat/api/send', { to: peer, nonce: s.nonce, cipher: s.cipher });
    await this.vault(r.id, peer, 'out', r.at, text);
    this.lastSeq = Math.max(this.lastSeq, r.seq);
    return r;
  }
  async vault(msgId, withU, dir, at, text) {
    const s = C.sealVault(this.vaultKey, text);
    await this.api('POST', '/chat/api/vault', { msgId, with: withU, dir, at, nonce: s.nonce, cipher: s.cipher });
    this.history[msgId] = { id: msgId, with: withU, dir, at, text };
  }
  async pollOnceRaw() { return this.api('GET', '/chat/api/poll?since=' + this.lastSeq); }
  // 新客户端补齐：gap 时先走 catchup（解密＋写保险库＋进历史），再推游标。
  async catchUp() {
    let since = this.lastSeq; let guard = 0; let got = 0;
    while (guard++ < 20) {
      const r = await this.api('GET', '/chat/api/catchup?since=' + since + '&limit=100');
      for (const id of (r.deletedIds || [])) delete this.history[id];
      for (const m of (r.messages || [])) {
        if (!m || !m.id || this.history[m.id]) continue;
        const other = m.from === this.user ? m.to : m.from;
        const key = await this.convKey(other);
        const text = C.openMessage(key, m.nonce, m.cipher);
        if (text === null) continue;
        const dir = m.from === this.user ? 'out' : 'in';
        await this.vault(m.id, other, dir, m.at, text);
        got++;
      }
      since = Math.max(since, (typeof r.nextSince === 'number' ? r.nextSince : since));
      if (!r.hasMore) break;
    }
    return got;
  }
  // 新客户端轮询：gap 先补齐，再按 hasMore 翻页收事件。
  async pollOnceNew() {
    const r0 = await this.pollOnceRaw();
    let pollDelivered = 0;
    if (r0.gap) {
      const got = await this.catchUp();
      check('gap 后 catchup 补回消息', got > 0, '补回 ' + got + ' 条');
      this.lastSeq = Math.max(this.lastSeq, r0.maxSeq);
    }
    let r = r0; let guard = 0;
    for (;;) {
      for (const ev of (r.events || [])) {
        this.lastSeq = Math.max(this.lastSeq, ev.seq);
        if (ev.type !== 'msg') continue;
        const m = ev.msg; const other = m.from === this.user ? m.to : m.from;
        if (this.history[m.id]) continue;
        const key = await this.convKey(other);
        const text = C.openMessage(key, m.nonce, m.cipher);
        if (text === null) continue;
        const dir = m.from === this.user ? 'out' : 'in';
        await this.vault(m.id, other, dir, m.at, text);
        pollDelivered++;
      }
      if (!r.hasMore || guard++ >= 10) break;
      r = await this.api('GET', '/chat/api/poll?since=' + this.lastSeq);
    }
    return { pollDelivered, first: r0 };
  }
  async vaultAllPaged(limit) {
    const out = []; let cursor = ''; let guard = 0;
    for (;;) {
      const r = await this.api('GET', '/chat/api/vault?limit=' + limit + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      for (const e of (r.entries || [])) out.push(e);
      if (!r.hasMore || guard++ >= 50) break;
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }
}

async function main() {
  await C.ready();
  console.log('测试目录：' + TESTDIR);
  fs.writeFileSync(path.join(TESTDIR, 'friends.json'), JSON.stringify({ pairs: [[ALICE, BOB], [CAROL, BOB]] }));
  const mc = await startFakeMc();
  const chat = await startChat({ mcPort: mc.port });
  console.log('假 MC 端口：' + mc.port + '；聊天服务：' + chat.base);
  const alice = new Client(chat.base, ALICE, ALICE_PW);
  const bob = new Client(chat.base, BOB, BOB_PW);
  const carol = new Client(chat.base, CAROL, CAROL_PW);
  await alice.login(); await bob.login(); await carol.login();
  console.log('登录＋建钥匙完成');

  // 1) 种子消息：bob 收一次，游标 lastSeq=1，随后“离线”（洪水期间不轮询）。
  const seed = await alice.send(BOB, 'stress-seed-000');
  const rSeed = await bob.pollOnceNew();
  check('种子消息到达 bob', bob.history[seed.id] && bob.history[seed.id].text === 'stress-seed-000');
  check('种子轮询后游标=1', bob.lastSeq === 1, 'lastSeq=' + bob.lastSeq);

  // 2) 洪水：alice 55 条＋carol 55 条，全发给 bob；bob 全程离线（不轮询、不发送）。
  const sent = new Map(); // msgId -> 明文
  sent.set(seed.id, 'stress-seed-000');
  for (let i = 1; i <= FLOOD_EACH; i++) {
    const t = 'stress-alice-' + String(i).padStart(3, '0');
    const r = await alice.send(BOB, t); sent.set(r.id, t);
  }
  for (let i = 1; i <= FLOOD_EACH; i++) {
    const t = 'stress-carol-' + String(i).padStart(3, '0');
    const r = await carol.send(BOB, t); sent.set(r.id, t);
  }
  const total = sent.size; // 111
  check('洪水发送完成', total === 1 + FLOOD_EACH * 2, '共 ' + total + ' 条');

  // 3) bob 回来：先只看第一页 poll（旧客户端视角会看到什么）。
  const first = await bob.pollOnceRaw();
  check('长离线后 poll 报 gap=true', first.gap === true, 'gap=' + first.gap + ' earliestSeq=' + first.earliestSeq + ' maxSeq=' + first.maxSeq);
  check('poll 首页 hasMore=true（须翻页）', first.hasMore === true, '首页 ' + first.events.length + ' 条');
  const pollOnlyIds = new Set();
  {
    let r = first; let guard = 0;
    for (;;) {
      for (const ev of (r.events || [])) if (ev.type === 'msg') pollOnlyIds.add(ev.msg.id);
      if (!r.hasMore || guard++ >= 10) break;
      r = await bob.api('GET', '/chat/api/poll?since=' + r.nextSince);
    }
  }
  const missedByPollOnly = [...sent.keys()].filter((id) => !pollOnlyIds.has(id) && id !== seed.id);
  console.log('  （对照）只走 poll 能拿到 ' + pollOnlyIds.size + ' 条事件；若无 catchup 将悄悄丢 ' + missedByPollOnly.length + ' 条');
  check('对照：poll-only 确实会丢消息（缺口真实存在）', missedByPollOnly.length > 0, '丢 ' + missedByPollOnly.length + ' 条');

  // 4) 新客户端完整轮询：gap→catchup→翻页，解密核对每条明文。
  const bob2 = new Client(chat.base, BOB, BOB_PW);
  await bob2.login();
  bob2.lastSeq = 1; // 与洪水前同一游标（旧设备回来）
  bob2.history = { [seed.id]: { id: seed.id, with: ALICE, dir: 'in', at: 0, text: 'stress-seed-000' } };
  const res = await bob2.pollOnceNew();
  check('新客户端轮询后游标推到 maxSeq', bob2.lastSeq === first.maxSeq, 'lastSeq=' + bob2.lastSeq + ' maxSeq=' + first.maxSeq);
  const missing = [...sent.keys()].filter((id) => !bob2.history[id]);
  check('catchup 后历史零丢失', missing.length === 0, '缺 ' + missing.length + ' 条');
  let wrongText = 0;
  for (const [id, text] of sent) { if (bob2.history[id] && bob2.history[id].text !== text) wrongText++; }
  check('补回消息解密明文逐条一致', wrongText === 0, '错 ' + wrongText + ' 条');

  // 5) 保险库分页（S-051）：limit=20 翻页拉全，与发送集逐条对齐。
  const vaultEntries = await bob2.vaultAllPaged(VAULT_PAGE);
  const vaultIds = new Set(vaultEntries.map((e) => e.msgId));
  const vaultMissing = [...sent.keys()].filter((id) => !vaultIds.has(id));
  check('保险库分页拉全 111 条', vaultEntries.length === total, '拉到 ' + vaultEntries.length + ' 条');
  check('保险库与发送集逐条对齐', vaultMissing.length === 0, '缺 ' + vaultMissing.length + ' 条');

  // 6) 旧数据重建：删掉 inbox/inboxBuilt 后重启，poll 仍可用（重建不丢事件）。
  chat.server.close();
  const legacy = JSON.parse(fs.readFileSync(path.join(TESTDIR, 'chat-data.json'), 'utf8'));
  delete legacy.inbox; delete legacy.inboxFloor; delete legacy.inboxBuilt;
  fs.writeFileSync(path.join(TESTDIR, 'chat-data-legacy.json'), JSON.stringify(legacy));
  const chat2 = await startChat({ mcPort: mc.port, overrides: { dataFile: path.join(TESTDIR, 'chat-data-legacy.json') } });
  const bob3 = new Client(chat2.base, BOB, BOB_PW);
  await bob3.login();
  const rLegacy = await bob3.api('GET', '/chat/api/poll?since=0');
  check('旧数据重建后 poll 可用', Array.isArray(rLegacy.events) && rLegacy.events.length > 0, '首屏 ' + rLegacy.events.length + ' 条');
  chat2.server.close();
  mc.wss.close();

  console.log(failures ? '\n压力测试未通过：' + failures + ' 项失败' : '\n压力测试全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('压力测试异常退出：', (e && e.stack) || e); process.exit(2); });
