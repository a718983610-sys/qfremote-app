// W-02/W-03/RC-04 纯函数单测（qf-schema.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWebapp, plain } from './load-webapp.mjs';

const qf = loadWebapp().__qf;

test('W-02 频道名：device/chat/session/presence 拼写与解析', () => {
  assert.equal(qf.qfChannel('device', 'abc123'), 'device:abc123:status');
  assert.equal(qf.qfChannel('chat', 'u1'), 'chat:u1');
  assert.equal(qf.qfChannel('session', 's1'), 'session:s1:frame-meta');
  assert.equal(qf.qfChannel('device', 'a:b c'), 'device:abc:status'); // 冒号/空白剔除，防拼出歧义
  assert.equal(qf.qfChannel('', 'x'), '');
  assert.deepEqual(plain(qf.qfParseChannel('device:abc123:status')), { kind: 'device', id: 'abc123', suffix: 'status' });
  assert.equal(qf.qfParseChannel('not-a-channel'), null);
});

test('W-03 确定性合并：version 大者胜、相等 nonce 小者胜、本地编辑优先、墓碑不复活', () => {
  const local = [
    { id: 'a', version: 2, versionNonce: 10, name: '本地新' },
    { id: 'b', version: 1, versionNonce: 5, name: '本地' },
    { id: 'c', version: 3, versionNonce: 9, name: '本地编辑中' },
    { id: 'd', version: 2, versionNonce: 1, isDeleted: true },
  ];
  const remote = [
    { id: 'a', version: 3, versionNonce: 99, name: '远端更新' }, // version 大 → 远端胜
    { id: 'b', version: 1, versionNonce: 3, name: '远端' }, // version 等、nonce 小 → 远端胜
    { id: 'c', version: 3, versionNonce: 1, name: '远端同版' }, // 本地编辑中 → 本地胜
    { id: 'd', version: 2, versionNonce: 1, name: '远端复活' }, // 墓碑同版同 nonce → 本地墓碑留
    { id: 'e', version: 1, versionNonce: 1, name: '远端新增' },
  ];
  const out = qf.reconcileRecords(local, remote, new Set(['c']));
  const byId = new Map(out.map((r) => [r.id, r]));
  assert.equal(byId.get('a').name, '远端更新');
  assert.equal(byId.get('b').name, '远端');
  assert.equal(byId.get('c').name, '本地编辑中');
  assert.equal(byId.get('d').isDeleted, true); // 删除不复活
  assert.equal(byId.get('e').name, '远端新增');
  assert.equal(out.map((r) => r.id).join(','), 'a,b,c,d,e'); // 按 id 排序（跨 realm 数组用 join 比对）
  assert.equal(local[0].name, '本地新'); // 不改输入
});

test('W-10 qfIsNewer：updatedAt 大者胜，相等时 tabId 大者胜', () => {
  assert.equal(qf.qfIsNewer({ updatedAt: 2, tabId: 'a' }, { updatedAt: 1, tabId: 'z' }), true);
  assert.equal(qf.qfIsNewer({ updatedAt: 1, tabId: 'a' }, { updatedAt: 1, tabId: 'z' }), false);
  assert.equal(qf.qfIsNewer({ updatedAt: 1, tabId: 'z' }, { updatedAt: 1, tabId: 'a' }), true);
});

function validTicket() {
  return {
    account_id: 'alice', device_id: 'test-device-1', api_key_id: 'k_0123456789',
    binding_epoch: 3, grant_epoch: 1, resume_id: 'resume-0123456789abcdef',
    session_id: 'sess-0123456789abcdef', issued_at: 1790000000, expires_at: 1790000300,
    ticket_signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  };
}

test('RC-04 票据形状校验：合法票据通过，逐项非法拒绝', () => {
  assert.equal(qf.validateReconnectTicket(validTicket()).ok, true);
  const bad = (mut) => { const t = validTicket(); mut(t); return qf.validateReconnectTicket(t); };
  assert.equal(bad((t) => { delete t.ticket_signature; }).ok, false);
  assert.equal(bad((t) => { t.extra = 1; }).ok, false); // 未知顶层字段拒绝
  assert.equal(bad((t) => { t.resume_id = 'resume-XYZ'; }).ok, false);
  assert.equal(bad((t) => { t.session_id = 'sess-0123'; }).ok, false);
  assert.equal(bad((t) => { t.expires_at = 1790000301; }).ok, false); // TTL 必须恰好 300
  assert.equal(bad((t) => { t.binding_epoch = -1; }).ok, false);
  assert.equal(bad((t) => { t.api_key_id = 'x_0123456789'; }).ok, false);
  assert.equal(bad((t) => { t.account_id = ''; }).ok, false);
  assert.equal(qf.validateReconnectTicket(null).ok, false);
  assert.equal(qf.validateReconnectTicket('x').ok, false);
});

test('RC-04 规范串：10 行 LF、无结尾换行；session_id 格式', () => {
  const s = qf.qfReconnectTicketCanonical(validTicket());
  const lines = s.split('\n');
  assert.equal(lines.length, 10);
  assert.equal(lines[0], 'qfr-lea-reconnect-v1');
  assert.equal(lines[5], '1'); // grant_epoch 最短十进制
  assert.equal(s.endsWith('\n'), false);
  assert.match(qf.qfNewSessionId(), /^sess-[0-9a-f]{16}$/);
  assert.notEqual(qf.qfNewSessionId(), qf.qfNewSessionId());
});

test('S-054 客户端消息 ID：cm-＋32 位小写 hex，每次不同', () => {
  const a = qf.qfNewClientMessageId();
  const b = qf.qfNewClientMessageId();
  assert.match(a, /^cm-[0-9a-f]{32}$/);
  assert.match(b, /^cm-[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('RC-04 凭据类失败码：8 码命中即停，其余不停', () => {
  for (const c of ['QFR_API_KEY_REVOKED', 'QFR_TICKET_REUSED', 'QFR_TICKET_EXPIRED', 'QFR_BINDING_CHANGED', 'QFR_GRANT_REVOKED', 'QFR_SCOPE_DENIED', 'QFR_LEA_NOT_BOUND', 'QFR_TICKET_INVALID']) {
    assert.equal(qf.qfIsCredentialFailure(c), true, c);
  }
  assert.equal(qf.qfIsCredentialFailure('HTTP_502'), false);
  assert.equal(qf.qfIsCredentialFailure(''), false);
});
