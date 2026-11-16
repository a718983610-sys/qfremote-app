'use strict';
/*
 * QFRemote 聊天 C-4 单测（S-079／S-084／S-085／S-086，2026-11-15）
 * 不依赖 MeshCentral：预置好友文件＋会话令牌＋钥匙目录，直驱
 * createChatHandler；发消息只用占位密文（nonce/cipher 为不透明字符串，
 * 服务端只做形态校验、不解密）。
 * 用法：node server/friends/chat/test-chat-c4.js
 * 退出码 0 = 全部通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createChatHandler } = require('./chat-server');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

let failures = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? '  ok  ' : ' FAIL ') + name + (extra !== undefined ? ' — ' + extra : ''));
  if (!cond) failures++;
}

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'qfchat-c4-')); }

function seed(dir, opts) {
  const o = opts || {};
  fs.mkdirSync(path.join(dir, 'data', 'provider-mirror', 'license'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'provider-mirror', 'license', 'status.json'), '{}');
  fs.writeFileSync(path.join(dir, 'friends.json'), JSON.stringify({ pairs: [['alice', 'bob']] }));
  const data = {
    keys: { alice: { pub: 'alice-pub' }, bob: { pub: 'bob-pub' } },
    sessions: {},
    messages: {}, graveyard: {}, vault: {}, readMarks: {}, traces: {},
    events: [], eventSeq: 0, inbox: {}, inboxFloor: {},
  };
  data.sessions[sha256('tok-alice')] = { user: 'alice', exp: Date.now() + 3600e3 };
  data.sessions[sha256('tok-bob')] = { user: 'bob', exp: Date.now() + 3600e3 };
  if (o.extraData) Object.assign(data, o.extraData);
  fs.writeFileSync(path.join(dir, 'data', 'chat-data.json'), JSON.stringify(data));
  return {
    dataFile: path.join(dir, 'data', 'chat-data.json'),
    friendsFile: path.join(dir, 'friends.json'),
    logFile: path.join(dir, 'data', 'chat.log'),
    sessionMasterKeyFile: path.join(dir, 'data', 'session-master.key'),
    inboxCap: o.inboxCap || 2000,
    pollPageSize: o.pollPageSize || 500,
  };
}

async function startServer(cfg) {
  const handler = createChatHandler(cfg);
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const api = async (token, method, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-qfchat-token'] = token;
    const r = await fetch('http://127.0.0.1:' + port + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  };
  return { srv, api, close: () => new Promise((r) => srv.close(r)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---------- A 组：S-086 发送字段与去重 ----------
  {
    const dir = tmpdir();
    const { srv, api, close } = await startServer(seed(dir));
    const cmid = 'cm-' + 'a'.repeat(32);
    const r1 = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n1', cipher: 'c1', clientMessageId: cmid });
    check('A1_send_ok', r1.status === 200 && r1.body.id && r1.body.seq === 1, JSON.stringify(r1.body));
    check('A2_send_echo_cmid', r1.body.clientMessageId === cmid);
    const byId = await api('tok-alice', 'GET', '/chat/api/message/by-client-id?clientMessageId=' + cmid);
    check('A3_by_client_id', byId.status === 200 && byId.body.message.id === r1.body.id
      && byId.body.message.type === 'text' && byId.body.message.edited === false
      && byId.body.message.clientMessageId === cmid, JSON.stringify(byId.body.message));
    const r2 = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n1', cipher: 'c1', clientMessageId: cmid });
    check('A4_resend_duplicate', r2.status === 200 && r2.body.duplicate === true && r2.body.id === r1.body.id, JSON.stringify(r2.body));
    const conv = await api('tok-alice', 'GET', '/chat/api/conversations');
    check('A5_only_one_message', conv.body.conversations.length === 1 && conv.body.conversations[0].count === 1, JSON.stringify(conv.body.conversations));
    const badCmid = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n', cipher: 'c', clientMessageId: 'x' });
    check('A6_bad_cmid_400', badCmid.status === 400, badCmid.status);
    const badReply = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n', cipher: 'c', replyTo: 'nope' });
    check('A7_bad_replyTo_400', badReply.status === 400, badReply.status);
    const badType = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n', cipher: 'c', type: 'image' });
    check('A8_bad_type_400', badType.status === 400, badType.status);
    const r3 = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n2', cipher: 'c2', replyTo: r1.body.id });
    check('A9_reply_ok', r3.status === 200 && r3.body.seq === 2, JSON.stringify(r3.body));
    const byId3 = await api('tok-alice', 'GET', '/chat/api/message/by-client-id?clientMessageId=' + 'cm-' + 'b'.repeat(32));
    check('A10_by_client_id_404', byId3.status === 404, byId3.status);
    const otherCmid = await api('tok-bob', 'GET', '/chat/api/message/by-client-id?clientMessageId=' + cmid);
    check('A11_other_user_cannot_lookup', otherCmid.status === 404, otherCmid.status);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- B 组：S-086 编辑 ----------
  {
    const dir = tmpdir();
    const { srv, api, close } = await startServer(seed(dir));
    const cmid = 'cm-' + 'c'.repeat(32);
    const r1 = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n1', cipher: 'c1', clientMessageId: cmid });
    const noPerm = await api('tok-bob', 'POST', '/chat/api/edit', { msgId: r1.body.id, nonce: 'n9', cipher: 'c9' });
    check('B1_edit_non_sender_403', noPerm.status === 403, noPerm.status);
    const missing = await api('tok-alice', 'POST', '/chat/api/edit', { msgId: 'nope', nonce: 'n9', cipher: 'c9' });
    check('B2_edit_missing_404', missing.status === 404, missing.status);
    const ed = await api('tok-alice', 'POST', '/chat/api/edit', { msgId: r1.body.id, nonce: 'n2', cipher: 'c2' });
    check('B3_edit_ok', ed.status === 200 && ed.body.seq === 2 && ed.body.editedAt, JSON.stringify(ed.body));
    const byId = await api('tok-alice', 'GET', '/chat/api/message/by-client-id?clientMessageId=' + cmid);
    check('B4_edited_fields', byId.body.message.edited === true && byId.body.message.cipher === 'c2'
      && byId.body.message.editedAt === ed.body.editedAt, JSON.stringify(byId.body.message));
    const poll = await api('tok-bob', 'GET', '/chat/api/poll?since=0');
    check('B5_poll_has_edit_event', poll.body.events.some((e) => e.type === 'edit' && e.msgId === r1.body.id && e.cipher === 'c2'),
      JSON.stringify(poll.body.events.map((e) => e.type)));
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- C 组：S-084 表态 ----------
  {
    const dir = tmpdir();
    const { srv, api, close } = await startServer(seed(dir));
    const r1 = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n1', cipher: 'c1' });
    const bad = await api('tok-bob', 'POST', '/chat/api/reaction', { msgId: r1.body.id, emoji: '<b>' });
    check('C1_bad_emoji_400', bad.status === 400, bad.status);
    const missing = await api('tok-bob', 'POST', '/chat/api/reaction', { msgId: 'nope', emoji: '👍' });
    check('C2_react_missing_404', missing.status === 404, missing.status);
    const on = await api('tok-bob', 'POST', '/chat/api/reaction', { msgId: r1.body.id, emoji: '👍' });
    check('C3_react_on', on.status === 200 && on.body.reactions && on.body.reactions.bob === '👍', JSON.stringify(on.body));
    const poll = await api('tok-alice', 'GET', '/chat/api/poll?since=0');
    check('C4_poll_has_reaction_event', poll.body.events.some((e) => e.type === 'reaction' && e.msgId === r1.body.id && e.emoji === '👍'),
      JSON.stringify(poll.body.events.map((e) => e.type)));
    const off = await api('tok-bob', 'POST', '/chat/api/reaction', { msgId: r1.body.id, emoji: '👍' });
    check('C5_react_toggle_off', off.status === 200 && (!off.body.reactions || !off.body.reactions.bob), JSON.stringify(off.body));
    const swap = await api('tok-bob', 'POST', '/chat/api/reaction', { msgId: r1.body.id, emoji: '❤️' });
    check('C6_react_swap', swap.status === 200 && swap.body.reactions.bob === '❤️', JSON.stringify(swap.body));
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- D 组：S-085 typing 与 presence ----------
  {
    const dir = tmpdir();
    const { srv, api, close } = await startServer(seed(dir));
    const nonFriend = await api('tok-alice', 'POST', '/chat/api/typing', { with: 'carol', typing: true });
    check('D1_typing_nonfriend_403', nonFriend.status === 403, nonFriend.status);
    const t1 = await api('tok-alice', 'POST', '/chat/api/typing', { with: 'bob', typing: true });
    check('D2_typing_set', t1.status === 200, t1.status);
    const poll = await api('tok-bob', 'GET', '/chat/api/poll?since=0');
    check('D3_poll_ephemeral_typing', Array.isArray(poll.body.ephemeral)
      && poll.body.ephemeral.some((e) => e.type === 'typing' && e.from === 'alice' && e.typing === true),
      JSON.stringify(poll.body.ephemeral));
    const t2 = await api('tok-alice', 'POST', '/chat/api/typing', { with: 'bob', typing: false });
    const poll2 = await api('tok-bob', 'GET', '/chat/api/poll?since=0');
    check('D4_typing_cleared', t2.status === 200 && poll2.body.ephemeral.length === 0, JSON.stringify(poll2.body.ephemeral));
    await api('tok-alice', 'POST', '/chat/api/typing', { with: 'bob', typing: true });
    await sleep(7000);
    const poll3 = await api('tok-bob', 'GET', '/chat/api/poll?since=0');
    check('D5_typing_expires_6s', poll3.body.ephemeral.length === 0, JSON.stringify(poll3.body.ephemeral));
    const badStatus = await api('tok-alice', 'POST', '/chat/api/presence', { status: 'busy' });
    check('D6_bad_presence_400', badStatus.status === 400, badStatus.status);
    await api('tok-alice', 'POST', '/chat/api/presence', { status: 'online' });
    await api('tok-bob', 'POST', '/chat/api/presence', { status: 'away' });
    const pres = await api('tok-alice', 'GET', '/chat/api/presence?users=alice,bob,carol');
    check('D7_presence_values', pres.status === 200 && pres.body.presence.alice === 'online'
      && pres.body.presence.bob === 'away' && pres.body.presence.carol === 'offline', JSON.stringify(pres.body));
    const many = await api('tok-alice', 'GET', '/chat/api/presence?users=' + Array.from({ length: 60 }, (_, i) => 'u' + i).join(','));
    check('D8_presence_cap_50', Object.keys(many.body.presence).length === 50, Object.keys(many.body.presence).length);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- E 组：S-079 分片持久化 ----------
  {
    const dir = tmpdir();
    const cfg = seed(dir);
    const { srv, api, close } = await startServer(cfg);
    const r1 = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n1', cipher: 'c1' });
    const r2 = await api('tok-bob', 'POST', '/chat/api/send', { to: 'alice', nonce: 'n2', cipher: 'c2' });
    check('E1_two_sends', r1.status === 200 && r2.status === 200, r1.status + '/' + r2.status);
    const inboxDir = path.join(dir, 'data', 'inbox', 'by-user');
    const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter((f) => f.endsWith('.jsonl')) : [];
    check('E2_shard_files_exist', files.length === 2, files.join(','));
    const aliceShard = path.join(inboxDir, sha256('alice') + '.jsonl');
    const bobShard = path.join(inboxDir, sha256('bob') + '.jsonl');
    const aliceLines = fs.readFileSync(aliceShard, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bobLines = fs.readFileSync(bobShard, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('E3_shard_contents', aliceLines.length === 2 && bobLines.length === 2
      && aliceLines[0].seq === 1 && aliceLines[1].seq === 2, 'alice=' + aliceLines.length + ' bob=' + bobLines.length);
    const saved = JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8'));
    check('E4_chat_data_has_no_inbox_array', !Object.prototype.hasOwnProperty.call(saved, 'inbox'), Object.keys(saved).join(','));
    check('E5_clientMsgIndex_persisted', saved.clientMsgIndex && typeof saved.clientMsgIndex === 'object');
    await close();
    // 重启：同一 dataFile 再起，分片须恢复 inbox，poll 仍能拉到两条。
    const s2 = await startServer(cfg);
    const poll = await s2.api('tok-bob', 'GET', '/chat/api/poll?since=0');
    check('E6_restart_loads_shards', poll.status === 200 && poll.body.events.length === 2
      && poll.body.events[0].type === 'msg' && poll.body.events[1].type === 'msg',
      JSON.stringify(poll.body.events.map((e) => e.type)));
    await s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- F 组：S-079 剪枝与 gap（cap 下限夹 50，故用 cap 50 发 55 条） ----------
  {
    const dir = tmpdir();
    const cfg = seed(dir, { inboxCap: 50 });
    const { srv, api, close } = await startServer(cfg);
    for (let i = 0; i < 55; i++) {
      const r = await api('tok-alice', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n' + i, cipher: 'c' + i });
      if (r.status !== 200) throw new Error('send failed: ' + JSON.stringify(r.body));
    }
    const inboxDir = path.join(dir, 'data', 'inbox', 'by-user');
    const bobLines = fs.readFileSync(path.join(inboxDir, sha256('bob') + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('F1_shard_pruned_to_cap', bobLines.length === 50 && bobLines[0].seq === 6 && bobLines[49].seq === 55,
      bobLines.length + ' lines, first=' + (bobLines[0] && bobLines[0].seq));
    const pollGap = await api('tok-bob', 'GET', '/chat/api/poll?since=1');
    check('F2_gap_true_for_pruned_since', pollGap.body.gap === true && pollGap.body.earliestSeq === 6, JSON.stringify({ gap: pollGap.body.gap, earliest: pollGap.body.earliestSeq }));
    const pollOk = await api('tok-bob', 'GET', '/chat/api/poll?since=6');
    check('F3_no_gap_at_floor', pollOk.body.gap === false && pollOk.body.events.length === 49, JSON.stringify({ gap: pollOk.body.gap, n: pollOk.body.events.length }));
    const saved = JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8'));
    check('F4_floor_persisted', saved.inboxFloor && saved.inboxFloor.bob === 6, JSON.stringify(saved.inboxFloor));
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- G 组：S-079 旧单文件迁移 ----------
  {
    const dir = tmpdir();
    const m1 = { id: 'm1', from: 'alice', to: 'bob', conv: '["alice","bob"]', at: 1000, nonce: 'n1', cipher: 'c1', seq: 1 };
    const m2 = { id: 'm2', from: 'bob', to: 'alice', conv: '["alice","bob"]', at: 2000, nonce: 'n2', cipher: 'c2', seq: 2 };
    const cfg = seed(dir, {
      extraData: {
        messages: { m1, m2 },
        events: [
          { type: 'msg', msg: m1, seq: 1 },
          { type: 'msg', msg: m2, seq: 2 },
        ],
        eventSeq: 2,
        inbox: { alice: [{ type: 'msg', msg: m1, seq: 1 }, { type: 'msg', msg: m2, seq: 2 }], bob: [{ type: 'msg', msg: m1, seq: 1 }, { type: 'msg', msg: m2, seq: 2 }] },
        inboxFloor: {},
      },
    });
    const { srv, api, close } = await startServer(cfg);
    const inboxDir = path.join(dir, 'data', 'inbox', 'by-user');
    check('G1_legacy_inbox_migrated_to_shards',
      fs.existsSync(path.join(inboxDir, sha256('alice') + '.jsonl'))
      && fs.existsSync(path.join(inboxDir, sha256('bob') + '.jsonl')),
      fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).join(',') : 'no dir');
    const poll = await api('tok-bob', 'GET', '/chat/api/poll?since=0');
    check('G2_poll_after_migration', poll.body.events.length === 2, JSON.stringify(poll.body.events.map((e) => e.seq)));
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? `\n全部通过（${total} 项）` : `\n失败 ${failures}/${total} 项`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
