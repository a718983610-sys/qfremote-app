'use strict';
// Self-contained regressions: production HTTP handler + isolated fake MeshCentral.
// The fake control channel authenticates test identities only; no external service/data.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { WebSocketServer } = require('ws');
const { createChatHandler, meshTlsOptions } = require('./chat-server');
const { FriendsGate } = require('./friends-gate');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function seed(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfchat-completeness-'));
  const cfg = { dataFile: path.join(dir, 'data.json'), friendsFile: path.join(dir, 'friends.json'), logFile: path.join(dir, 'chat.log') };
  const mirror = path.join(dir, 'provider-mirror', 'license', 'status.json');
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  fs.writeFileSync(mirror, '{}');
  fs.writeFileSync(cfg.friendsFile, JSON.stringify({ pairs: [['alice', 'bob']] }));
  const sessions = {};
  for (const [token, user] of [['alice-current', 'alice'], ['alice-other', 'alice'], ['bob-current', 'bob']]) sessions[hash(token)] = { user, exp: Date.now() + 3600000 };
  fs.writeFileSync(cfg.dataFile, JSON.stringify({ keys: { alice: { pub: 'alice-original' }, bob: { pub: 'bob-original' } }, sessions, ...extra }));
  return { dir, cfg, mirror, data: () => JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8')) };
}
async function start(cfg) {
  const server = http.createServer(createChatHandler(cfg));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (token, method, route, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-qfchat-token'] = token;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { request, close: () => new Promise(resolve => server.close(resolve)) };
}
async function fixture(t, extra) {
  const state = seed(extra);
  t.after(() => fs.rmSync(state.dir, { recursive: true, force: true }));
  const service = await start(state.cfg);
  t.after(() => service.close());
  return { ...state, ...service };
}

test('M-002 force setup cannot destroy an existing identity', async t => {
  const f = await fixture(t);
  const r = await f.request('alice-current', 'POST', '/chat/api/keys/setup', { force: true, pub: 'replacement', wrappedPriv: {}, wrappedVault: {} });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'KEYS_ALREADY_CONFIGURED');
  assert.equal(f.data().keys.alice.pub, 'alice-original');
});

test('M-003 missing, malformed and invalid-shape mirrors reject authentication without false ban claims', async t => {
  const f = await fixture(t);
  for (const contents of [null, '{broken', '[]', 'null']) {
    if (contents === null) fs.unlinkSync(f.mirror); else fs.writeFileSync(f.mirror, contents);
    const r = await f.request('alice-current', 'GET', '/chat/api/friends');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'ACCOUNT_STATUS_UNAVAILABLE');
  }
  fs.writeFileSync(f.mirror, '{}');
  assert.equal((await f.request('alice-current', 'GET', '/chat/api/friends')).status, 200);
  fs.writeFileSync(f.mirror, JSON.stringify({ alice: { banLink: true } }));
  assert.equal((await f.request('alice-current', 'GET', '/chat/api/friends')).status, 401);
});

test('M-005 revocation invalidates other sessions and preserves current and other users', async t => {
  const f = await fixture(t);
  const r = await f.request('alice-current', 'POST', '/chat/api/sessions/revoke-others', {});
  assert.equal(r.status, 200); assert.equal(r.body.count, 1);
  assert.equal((await f.request('alice-other', 'GET', '/chat/api/friends')).status, 401);
  assert.equal((await f.request('alice-current', 'GET', '/chat/api/friends')).status, 200);
  assert.equal((await f.request('bob-current', 'GET', '/chat/api/friends')).status, 200);
});

test('M-005 remembered login expires within seven days and ordinary login within twelve hours', async t => {
  const state = seed();
  t.after(() => fs.rmSync(state.dir, { recursive: true, force: true }));
  const mc = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => mc.on('listening', resolve));
  mc.on('connection', (socket, req) => {
    const username = Buffer.from(String(req.headers['x-meshauth']).split(',')[0], 'base64').toString('utf8');
    socket.send(JSON.stringify({ action: 'userinfo', userinfo: { _id: 'user/test/' + username } }));
  });
  t.after(() => new Promise(resolve => mc.close(resolve)));
  const service = await start({ ...state.cfg, mcUrl: `ws://127.0.0.1:${mc.address().port}/control.ashx` });
  t.after(() => service.close());
  for (const remember of [true, false]) {
    const before = Date.now();
    const r = await service.request('', 'POST', '/chat/api/login', { username: 'alice', password: 'isolated-test-credential', remember });
    assert.equal(r.status, 200);
    const session = state.data().sessions[hash(r.body.token)];
    const max = remember ? 7 * 86400000 : 12 * 3600000;
    assert.ok(session.exp >= before + max && session.exp <= Date.now() + max);
  }
});

test('M-035 conversation deletion emits one complete tombstone batch', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) assert.equal((await f.request('alice-current', 'POST', '/chat/api/send', { to: 'bob', nonce: 'opaque-nonce', cipher: 'opaque-cipher' })).status, 200);
  const r = await f.request('alice-current', 'POST', '/chat/api/delete-conversation', { with: 'bob' });
  assert.equal(r.status, 200); assert.equal(r.body.count, 12);
  const stored = f.data();
  assert.equal(stored.eventSeq, 13); assert.equal(Object.keys(stored.messages).length, 0);
  const poll = await f.request('bob-current', 'GET', '/chat/api/poll?since=12');
  assert.equal(poll.body.events.length, 1);
  assert.equal(poll.body.events[0].type, 'tomb'); assert.equal(poll.body.events[0].msgIds.length, 12);
});

test('M-036 expired sessions and retention metadata are pruned, fresh tombstones retained', async t => {
  const expired = { [hash('expired')]: { user: 'alice', exp: Date.now() - 1 } };
  const old = Date.now() - 91 * 86400000;
  const f = await fixture(t, { sessions: expired, graveyard: { old: { at: old }, recent: { at: old, deletedAt: Date.now() } }, traces: { conv: [{ at: old }, { at: Date.now() }] } });
  const d = f.data();
  assert.equal(Object.keys(d.sessions).length, 0); assert.equal(d.graveyard.old, undefined);
  assert.ok(d.graveyard.recent); assert.equal(d.traces.conv.length, 1);
});

test('M-041 send quotas survive a service restart', async t => {
  const f = seed({ sendWindows: { alice: Array.from({ length: 60 }, () => Date.now()) } });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  for (let i = 0; i < 2; i++) {
    const service = await start(f.cfg);
    try { assert.equal((await service.request('alice-current', 'POST', '/chat/api/send', { to: 'bob', nonce: 'n', cipher: 'c' })).status, 429); }
    finally { await service.close(); }
  }
});

test('M-039 unchanged friend files are cached and replacements invalidate the cache', t => {
  const f = seed(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const gate = new FriendsGate(f.cfg.friendsFile);
  const read = fs.readFileSync; let reads = 0;
  fs.readFileSync = function(file, ...args) { if (file === f.cfg.friendsFile) reads++; return read.call(fs, file, ...args); };
  try { assert.equal(gate.areFriends('alice', 'bob'), true); gate.listFriends('alice'); assert.equal(reads, 0); }
  finally { fs.readFileSync = read; }
  fs.writeFileSync(f.cfg.friendsFile + '.tmp', '{"pairs":[]}'); fs.renameSync(f.cfg.friendsFile + '.tmp', f.cfg.friendsFile);
  assert.equal(gate.areFriends('alice', 'bob'), false);
});

test('M-034 no new localStorage key fallback; legacy copies can migrate before removal', () => {
  const source = fs.readFileSync(path.join(__dirname, 'chat-client.js'), 'utf8');
  const code = source.slice(source.indexOf('function localDeviceKey('), source.indexOf('// 为一份秘密原件'));
  const values = new Map(); let writes = 0;
  const context = { localStorage: { getItem: k => values.get(k) || null, setItem: (k, v) => { writes++; values.set(k, v); }, removeItem: k => values.delete(k) } };
  vm.createContext(context); vm.runInContext(code, context);
  assert.equal(context.localDeviceKey(true), null); assert.equal(writes, 0);
  values.set('qfchat-device-key-v1', 'legacy-material');
  assert.equal(context.localDeviceKey(false), 'legacy-material');
  context.clearLegacyDeviceKey(); assert.equal(values.size, 0);
});

test('M-048 non-loopback MeshCentral verifies TLS and rejects unencrypted transport', () => {
  assert.equal(meshTlsOptions('wss://mc.example/control.ashx').rejectUnauthorized, true);
  assert.equal(meshTlsOptions('wss://127.0.0.1:8443/control.ashx').rejectUnauthorized, false);
  assert.throws(() => meshTlsOptions('ws://mc.example/control.ashx'), /requires-tls/);
});
