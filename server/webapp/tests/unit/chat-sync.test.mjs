// tests/unit/chat-sync.test.mjs — S-087 聊天同步纯逻辑核（qf-runtime）单测。
// 纯逻辑：游标推进／分页决策／pending 合并，不碰 DOM、不碰网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWebapp } from './load-webapp.mjs';

const ctx = loadWebapp();
const Q = ctx.__qf;

test('S-087 游标只进不退，坏事件不推进', () => {
  assert.equal(Q.qfChatSyncAdvanceCursor([], 5), 5);
  assert.equal(Q.qfChatSyncAdvanceCursor([{ seq: 3 }, { seq: 7 }, { seq: 6 }], 5), 7);
  assert.equal(Q.qfChatSyncAdvanceCursor([{ seq: 2 }], 9), 9);
  assert.equal(Q.qfChatSyncAdvanceCursor([null, {}, { seq: 'x' }, { seq: NaN }, { seq: 11 }], 10), 11);
  assert.equal(Q.qfChatSyncAdvanceCursor([{ seq: 4 }], undefined), 4);
});

test('S-087 分页决策：gap 有 maxSeq 才 catchup', () => {
  const p1 = Q.qfChatSyncPlanPage({ gap: true, maxSeq: 42, hasMore: false, nextSince: 42, events: [{ seq: 1 }] }, 10);
  assert.equal(p1.needCatchup, true);
  assert.equal(p1.catchupMaxSeq, 42);
  assert.equal(p1.hasMore, false);
  assert.equal(p1.nextSince, 42);
  assert.equal(p1.events.length, 1);
  const p2 = Q.qfChatSyncPlanPage({ gap: true, hasMore: true, nextSince: 7, events: [] }, 3);
  assert.equal(p2.needCatchup, false); // 无 maxSeq：不得推游标，不 catchup
  assert.equal(p2.catchupMaxSeq, null);
  assert.equal(p2.hasMore, true);
  assert.equal(p2.nextSince, 7);
  const p3 = Q.qfChatSyncPlanPage(null, 8);
  assert.equal(p3.needCatchup, false);
  assert.equal(p3.hasMore, false);
  assert.equal(p3.nextSince, 8);
  assert.equal(p3.events.length, 0); // 跨 vm 沙箱：不用 deepEqual 比数组（realm 原型不同会误判）
  const p4 = Q.qfChatSyncPlanPage({ gap: false, maxSeq: 9, hasMore: false, events: [{ seq: 9 }] }, 9);
  assert.equal(p4.needCatchup, false); // gap=false 时不 catchup，哪怕 maxSeq 在前
});

test('S-087 pending 合并保序，计数分明', () => {
  const m = Q.qfChatSyncMergePending([{ seq: 1 }], [{ seq: 2 }, { seq: 3 }]);
  assert.equal(JSON.stringify(m.bucket.map((e) => e.seq)), JSON.stringify([1, 2, 3]));
  assert.equal(m.pendingCount, 1);
  assert.equal(m.freshCount, 2);
  const m2 = Q.qfChatSyncMergePending(null, null);
  assert.equal(m2.bucket.length, 0);
});

test('S-087 重放队列上限 200，超了丢最旧', () => {
  const pending = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1 }));
  const next = Q.qfChatSyncRequeue(pending, { seq: 201 }, 200);
  assert.equal(next.length, 200);
  assert.equal(next[0].seq, 2); // 最旧的 seq=1 被丢掉
  assert.equal(next[199].seq, 201);
  const small = Q.qfChatSyncRequeue([{ seq: 1 }], { seq: 2 });
  assert.equal(JSON.stringify(small.map((e) => e.seq)), JSON.stringify([1, 2]));
});
