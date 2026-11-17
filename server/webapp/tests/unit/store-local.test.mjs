// W-04/W-10 Store＋IndexedDB＋多标签页单测；W-09 i18n＋W-04 Notifier 单测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWebapp, createFakeIndexedDB, FakeBroadcastChannel, plain } from './load-webapp.mjs';

test('W-10 QFLocal：假 IndexedDB 存取；无 IDB 时回落内存＋localStorage', async () => {
  const fakeIDB = createFakeIndexedDB();
  const ctx = loadWebapp({ indexedDB: fakeIDB });
  const qf = ctx.__qf;
  await qf.QFLocal.save('docs', 'devices', { value: [{ id: 'd1' }], updatedAt: 123 });
  const got = await qf.QFLocal.load('docs', 'devices');
  assert.equal(plain(got).value[0].id, 'd1');
  await qf.QFLocal.del('docs', 'devices');
  assert.equal(await qf.QFLocal.load('docs', 'devices'), null);

  const ctx2 = loadWebapp({}); // 无 indexedDB
  const qf2 = ctx2.__qf;
  await qf2.QFLocal.save('drafts', 'chat:u1', { text: '草稿', updatedAt: 5 });
  const got2 = await qf2.QFLocal.load('drafts', 'chat:u1');
  assert.equal(plain(got2).text, '草稿');
  assert.ok(ctx2.localStorage.getItem('qf-idb-fallback:drafts:chat:u1')); // localStorage 镜像
});

test('W-04/W-10 QFStore：docs 写走 reconcile＋持久化；presence 永不落盘', async () => {
  const ctx = loadWebapp({ indexedDB: createFakeIndexedDB() });
  const qf = ctx.__qf;
  const seen = [];
  qf.QFStore.subscribe('docs', 'devices', (v) => seen.push(plain(v).length));
  qf.QFStore.setDoc('devices', [
    { id: 'a', version: 1, versionNonce: 5, name: 'A' },
    { id: 'b', version: 1, versionNonce: 5, name: 'B' },
  ]);
  assert.deepEqual(seen, [2]);
  // 远端同版低 nonce 胜出、本地高版保留（确定性合并）
  qf.QFStore.setDoc('devices', [
    { id: 'a', version: 1, versionNonce: 3, name: 'A-远端' },
    { id: 'b', version: 2, versionNonce: 9, name: 'B-远端新版' },
  ]);
  const docs = plain(qf.QFStore.docs.devices);
  assert.equal(docs.find((d) => d.id === 'a').name, 'A-远端');
  assert.equal(docs.find((d) => d.id === 'b').name, 'B-远端新版');
  const saved = await qf.QFLocal.load('docs', 'devices');
  assert.equal(plain(saved).value.length, 2); // docs 已持久化
  // presence 只放内存
  qf.QFStore.setPresence('cursor:u1', { x: 1, y: 2 });
  assert.equal(plain(qf.QFStore.presence)['cursor:u1'].x, 1);
  assert.equal(await qf.QFLocal.load('docs', 'presence'), null);
  assert.equal(await qf.QFLocal.load('docs', 'cursor:u1'), null);
});

test('W-10 多标签页：BroadcastChannel 广播带 tabId，他页可收、本页不收', async () => {
  FakeBroadcastChannel.reset();
  const ctxA = loadWebapp({ BroadcastChannel: FakeBroadcastChannel });
  const ctxB = loadWebapp({ BroadcastChannel: FakeBroadcastChannel });
  const gotB = [];
  ctxB.__qf.QFLocal.onBroadcast((m) => gotB.push(plain(m)));
  const gotA = [];
  ctxA.__qf.QFLocal.onBroadcast((m) => gotA.push(plain(m)));
  ctxA.__qf.QFLocal.broadcast('docs:devices', { updatedAt: 7 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gotB.length, 1); // 他页收到
  assert.equal(gotB[0].type, 'docs:devices');
  assert.equal(gotA.length, 0); // 本页不收自己的广播
});

test('W-09 t()：中文兜底、变量插值、en 包加载后切换', async () => {
  const ctx = loadWebapp({
    fetch: async (url) => {
      if (String(url).includes('locales/en.json')) {
        return { ok: true, json: async () => ({ 'reconnect.attempt': 'Connection lost, reconnecting (attempt {n} of {max})' }) };
      }
      return { ok: false };
    },
  });
  const qf = ctx.__qf;
  assert.equal(qf.t('reconnect.attempt', { n: 2, max: 5 }), '连接中断，正在重连（第 2 次 / 共 5 次）');
  assert.equal(qf.t('missing.key'), 'missing.key'); // 未知 key 原样回 key，不造文案
  assert.equal(await qf.qfLoadLocale('en'), true);
  assert.equal(qf.t('reconnect.attempt', { n: 2, max: 5 }), 'Connection lost, reconnecting (attempt 2 of 5)');
  assert.equal(qf.t('reconnect.cancel'), '取消重连'); // en 包没有的 key 回落中文
});

test('W-04 QFNotifier：304 降频、指纹不变降频、变化走 checkSessionInner', async () => {
  const ctx = loadWebapp({});
  const qf = ctx.__qf;
  qf.S.auth = 'in';
  let checked = 0;
  qf.QFHooks.checkSessionInner = async () => { checked++; return true; };
  let calls = 0;
  qf.QFNotifier._fetchFn = async () => {
    calls++;
    if (calls === 1) return { status: 304, headers: { get: () => null } };
    if (calls === 2) return { status: 200, headers: { get: () => '"etag-1"' }, json: async () => ({ username: 'a', planName: 'P', displayStatus: '正常' }) };
    return { status: 200, headers: { get: () => '"etag-1"' }, json: async () => ({ username: 'a', planName: 'P', displayStatus: '正常' }) };
  };
  assert.equal((await qf.QFNotifier.pollOnce()).status, 'not-modified');
  assert.equal(checked, 0);
  assert.equal((await qf.QFNotifier.pollOnce()).status, 'changed');
  assert.equal(checked, 1);
  assert.equal((await qf.QFNotifier.pollOnce()).status, 'unchanged'); // 同指纹不再触发复核
  assert.equal(checked, 1);
  qf.QFNotifier.stop();
});
