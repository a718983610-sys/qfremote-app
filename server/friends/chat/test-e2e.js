'use strict';
/*
 * QFRemote 友聊 二期端到端自测（本地，真实服务＋真实 MeshCentral 测试实例）
 * 覆盖验收项：
 *  1 两账号互发，三端同一页逻辑（本脚本即页面 chat-client.js 的同款调用链）
 *  2 服务器侧抽查：数据文件里只有密文（明文/私钥原件/保险库钥匙原件全查无）
 *  3 删一条 → 传送行与双方保险库都没了，墓碑到达对端
 *  4 换端登录（全新客户端状态）→ 用密码解开钥匙包 → 历史自动加载一致
 *  5 删好友 → 再发被拒（403）；非好友对象 → 拒发
 *  6 密码被重置的后果链：新密码解不开旧包装（记录作废语义）；记得旧密码
 *    可恢复并换包装（用户自改密码不丢记录）；登录错密码 → 401
 * 前置：本机测试 MeshCentral 在 18443（alice01test/bob002test 两账号）。
 * 用法：node test-e2e.js   （自行拉起 chat-server 子进程，跑完自动收）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./crypto-core');

const TESTDIR = '/tmp/qfchat-test';
const BASE = 'http://127.0.0.1:18446';
const ALICE = 'alice01test', ALICE_PW = 'AlicePass123';
const BOB = 'bob002test', BOB_PW = 'BobPass12345';
const MARK1 = '你好 bob，这是第一条加密消息 qftest-marker-001';
const MARK2 = '收到！这是 bob 的回复 qftest-marker-002';

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}

// ---- 与 chat-client.js 同款的最小客户端（一个实例 = 一台设备） ----
class Client {
  constructor(user, password) { this.user = user; this.password = password; this.token = ''; this.priv = ''; this.vaultKey = ''; this.lastSeq = 0; this.pubCache = {}; }
  async api(method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['x-qfchat-token'] = this.token;
    const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
      this.priv = id.privB64; this.vaultKey = vk; this.freshSetup = true;
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
  }
  async poll() {
    const r = await this.api('GET', '/chat/api/poll?since=' + this.lastSeq);
    const out = { msgs: [], tombs: [] };
    for (const ev of r.events) {
      this.lastSeq = Math.max(this.lastSeq, ev.seq);
      if (ev.type === 'msg') {
        const m = ev.msg; const other = m.from === this.user ? m.to : m.from;
        const key = await this.convKey(other);
        const text = C.openMessage(key, m.nonce, m.cipher);
        out.msgs.push({ id: m.id, from: m.from, text });
        if (m.from !== this.user) await this.vault(m.id, other, 'in', m.at, text);
      } else if (ev.type === 'tomb') out.tombs.push(ev);
    }
    return out;
  }
  async history() {
    const r = await this.api('GET', '/chat/api/vault');
    return r.entries.map(e => ({ id: e.msgId, with: e.with, dir: e.dir, text: C.openVault(this.vaultKey, e.nonce, e.cipher) }));
  }
}

(async () => {
  await C.ready();
  fs.rmSync(TESTDIR, { recursive: true, force: true });
  fs.mkdirSync(TESTDIR + '/data/provider-mirror/license', { recursive: true });
  fs.writeFileSync(TESTDIR + '/data/provider-mirror/license/status.json', '{}');
  fs.writeFileSync(TESTDIR + '/data/friends.json', JSON.stringify({ pairs: [[ALICE, BOB]] }));
  const cfg = {
    port: 18446, bind: '127.0.0.1', mcUrl: 'wss://127.0.0.1:18443/control.ashx',
    dataFile: TESTDIR + '/data/chat-data.json', friendsFile: TESTDIR + '/data/friends.json', logFile: TESTDIR + '/data/chat.log'
  };
  fs.writeFileSync(TESTDIR + '/config.json', JSON.stringify(cfg, null, 2));
  const srv = spawn('node', [path.join(__dirname, 'chat-server.js')], { env: Object.assign({}, process.env, { QFCHAT_CONFIG: TESTDIR + '/config.json' }), stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    // 等服务就绪＋页面可达
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { try { const r = await fetch(BASE + '/chat/health'); up = r.ok; } catch (e) { await new Promise(r => setTimeout(r, 300)); } }
    check('服务起来了', up);
    const page = await (await fetch(BASE + '/chat')).text();
    check('聊天页可达且是同一套页面', page.includes('QFRemote 好友聊天') && page.includes('chat-client.js'));
    const sodiumSize = (await (await fetch(BASE + '/chat/libsodium-wrappers.js')).text()).length;
    check('加密库经服务本地下发（不走外网）', sodiumSize > 100000, sodiumSize + ' bytes');

    console.log('— 登录与钥匙 —');
    const alicePhone = new Client(ALICE, ALICE_PW); await alicePhone.login();
    check('alice 登录＋首次建钥匙', !!alicePhone.priv && !!alicePhone.vaultKey);
    const bobPhone = new Client(BOB, BOB_PW); await bobPhone.login();
    check('bob 登录＋首次建钥匙', !!bobPhone.priv && !!bobPhone.vaultKey);
    let wrongPwStatus = 0;
    try { await new Client(ALICE, 'WrongPass999').api('POST', '/chat/api/login', { username: ALICE, password: 'WrongPass999' }); }
    catch (e) { wrongPwStatus = e.status; }
    check('错密码登录被拒（走控制通道验密）', wrongPwStatus === 401, 'HTTP ' + wrongPwStatus);

    console.log('— 互发与解密 —');
    const s1 = await alicePhone.send(BOB, MARK1);
    const bobGot = await bobPhone.poll();
    check('bob 收到并解开 alice 的消息', bobGot.msgs.length === 1 && bobGot.msgs[0].text === MARK1);
    const s2 = await bobPhone.send(ALICE, MARK2);
    const aliceGot = await alicePhone.poll();
    check('alice 收到并解开 bob 的回复', aliceGot.msgs.some(m => m.text === MARK2));

    console.log('— 服务器侧密文抽查（站长视角：翻数据文件） —');
    const raw = fs.readFileSync(TESTDIR + '/data/chat-data.json', 'utf8');
    check('数据文件里没有消息明文', !raw.includes(MARK1) && !raw.includes(MARK2) && !raw.includes('qftest-marker'));
    check('数据文件里没有 alice 私钥原件', !raw.includes(alicePhone.priv));
    check('数据文件里没有 alice 保险库钥匙原件', !raw.includes(alicePhone.vaultKey));
    const parsed = JSON.parse(raw);
    check('传送行存的是密文字段', Object.values(parsed.messages).every(m => m.cipher && m.nonce && !('text' in m)));

    console.log('— 换端登录：历史自动加载 —');
    const aliceTablet = new Client(ALICE, ALICE_PW); await aliceTablet.login();
    const hist = await aliceTablet.history();
    check('新设备解开钥匙包并加载全部历史', hist.length === 2 && hist.some(h => h.text === MARK1 && h.dir === 'out') && hist.some(h => h.text === MARK2 && h.dir === 'in'), '共 ' + hist.length + ' 条');

    console.log('— 删除同步（服务端删＋墓碑） —');
    await bobPhone.api('POST', '/chat/api/delete', { msgId: s1.id });
    const alicePoll2 = await alicePhone.poll();
    check('alice 收到墓碑', alicePoll2.tombs.some(t => t.msgIds.includes(s1.id)));
    const raw2 = JSON.parse(fs.readFileSync(TESTDIR + '/data/chat-data.json', 'utf8'));
    check('传送行已删', !raw2.messages[s1.id]);
    check('双方保险库条目都已删', [ALICE, BOB].every(u => !(raw2.vault[u] || []).some(e => e.msgId === s1.id)));
    const histAfter = await aliceTablet.history();
    check('另一端再加载，历史里也没了这条', !histAfter.some(h => h.id === s1.id) && histAfter.length === 1);

    console.log('— 好友闸口 —');
    fs.writeFileSync(TESTDIR + '/data/friends.json', JSON.stringify({ pairs: [] }));
    let notFriendStatus = 0;
    try { await alicePhone.send(BOB, '删好友后不该发得出'); } catch (e) { notFriendStatus = e.status; }
    check('删好友后停发', notFriendStatus === 403, 'HTTP ' + notFriendStatus);
    let strangerStatus = 0;
    try { await alicePhone.api('POST', '/chat/api/send', { to: 'mallory00x', nonce: 'AAAA', cipher: 'AAAA' }); } catch (e) { strangerStatus = e.status; }
    check('非好友拒发（直打发送接口验闸口）', strangerStatus === 403, 'HTTP ' + strangerStatus);
    fs.writeFileSync(TESTDIR + '/data/friends.json', JSON.stringify({ pairs: [[ALICE, BOB]] }));

    console.log('— 系统联系人（客服）预留位 —');
    const fr = await alicePhone.api('GET', '/chat/api/friends');
    check('客服号默认在好友列表首位', fr.friends[0] === 'qf-support' && fr.peers[0].name === 'qf-support' && fr.peers[0].type === 'system');
    let supportStatus = 0;
    try { await alicePhone.api('POST', '/chat/api/send', { to: 'qf-support', nonce: 'AAAA', cipher: 'AAAA' }); } catch (e) { supportStatus = e.status; }
    check('给客服号发消息过闸口（未建号止步钥匙目录 409，不是好友拦截 403）', supportStatus === 409, 'HTTP ' + supportStatus);
    const convs = await alicePhone.api('GET', '/chat/api/conversations');
    check('普通对端类型仍是 user', convs.conversations.every(c => c.type === 'user'));

    console.log('— 密码那条线（A 案代价与恢复） —');
    const keysNow = await bobPhone.api('GET', '/chat/api/keys/me');
    const withNewPw = C.unwrapWithPassword(keysNow.keys.wrappedPriv, 'BrandNewPass777');
    check('密码被重置后，新密码解不开旧钥匙包（记录作废语义成立）', withNewPw === null);
    const rewrapped = C.rewrap(keysNow.keys.wrappedPriv, BOB_PW, 'BrandNewPass777');
    check('记得旧密码可换包装（用户自改密码不丢记录）', rewrapped !== null && C.unwrapWithPassword(rewrapped, 'BrandNewPass777') === bobPhone.priv);
  } catch (e) {
    console.error('自测中途出错：', e);
    failures++;
  } finally {
    srv.kill('SIGTERM');
  }
  console.log(failures === 0 ? '\n全部通过 ✔' : '\n有 ' + failures + ' 项没过 ✘');
  process.exit(failures === 0 ? 0 : 1);
})();
