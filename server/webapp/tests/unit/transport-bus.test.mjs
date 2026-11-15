// W-02/W-03 Transport＋Bus 单测（假 WS＋手动时钟）。
// 注意：被测代码跑在 node:vm 沙箱（另一 realm），跨 realm 对象须经 plain() 归一化再 deepEqual。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWebapp, ManualScheduler, plain } from './load-webapp.mjs';

class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeWS.instances.push(this);
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
  }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  receive(data) { if (this.onmessage) this.onmessage({ data }); }
  drop() { this.readyState = 3; if (this.onclose) this.onclose(); }
}
FakeWS.instances = [];

function ctxWithClock() {
  const sched = new ManualScheduler();
  const ctx = loadWebapp({ WebSocket: FakeWS });
  return { ctx, sched };
}

test('W-02 Transport：连接/发送/断线入队/重连补发/5 次耗尽失败', () => {
  FakeWS.instances = [];
  const { ctx, sched } = ctxWithClock();
  const qf = ctx.__qf;
  const tr = qf.QFTransport('wss://example.test/control.ashx', {
    WebSocketCtor: FakeWS, autoReconnect: true, maxAttempts: 5, retryIntervalMs: 5000,
    scheduler: sched,
  });
  const states = [];
  tr.onState((s) => states.push(s));
  assert.equal(tr.send({ a: 1 }), 'queued'); // 未连接先入队
  tr.connect();
  assert.equal(tr.state, 'connecting');
  const ws = FakeWS.instances[0];
  ws.open();
  assert.equal(tr.state, 'open');
  assert.equal(ws.sent.length, 1); // 入队消息建连后补发
  assert.equal(tr.send({ b: 2 }), 'sent');
  ws.drop(); // 掉线
  assert.equal(tr.state, 'reconnecting');
  assert.equal(tr.attempts, 1);
  assert.equal(tr.send({ c: 3 }), 'queued');
  sched.advance(5000);
  assert.equal(FakeWS.instances.length, 2);
  FakeWS.instances[1].open();
  assert.equal(tr.state, 'open');
  assert.equal(FakeWS.instances[1].sent.length, 1); // 断线期间消息补发
  // 连续连接被拒 6 次耗尽：每次新 socket 立即掉线（不 open），第 5 次 attempts 到顶、第 6 次 onclose 即 failed
  for (let i = 0; i < 6; i++) {
    const cur = FakeWS.instances[FakeWS.instances.length - 1];
    cur.drop();
    if (tr.state !== 'failed') sched.advance(5000);
  }
  assert.equal(tr.state, 'failed');
  assert.equal(tr.attempts, 5);
  assert.ok(states.includes('failed'));
  tr.close();
});

test('W-02 Bus：订阅分发/重连重订阅＋补快照/可靠消息去重', async () => {
  FakeWS.instances = [];
  const { ctx, sched } = ctxWithClock();
  const qf = ctx.__qf;
  const tr = qf.QFTransport('wss://example.test/control.ashx', {
    WebSocketCtor: FakeWS, autoReconnect: true, scheduler: sched,
  });
  let snapshots = [];
  const bus = qf.QFBus(tr, {
    sendSubscribe: true,
    onSnapshot: (channels) => { snapshots.push(plain(channels)); return Promise.resolve(); },
  });
  const got = [];
  bus.subscribe('device:abc:status', (d) => got.push(['status', plain(d)]));
  bus.subscribe('chat:u1', (d) => got.push(['chat', plain(d)]));
  tr.connect();
  FakeWS.instances[0].open();
  assert.deepEqual(snapshots, [['device:abc:status', 'chat:u1']]); // 建连即补快照
  const ws = FakeWS.instances[0];
  assert.equal(JSON.parse(ws.sent[0]).action, 'subscribe'); // 上行订阅消息
  ws.receive(JSON.stringify({ channel: 'device:abc:status', data: { online: true }, msgId: 'm-1' }));
  ws.receive(JSON.stringify({ channel: 'device:abc:status', data: { online: true }, msgId: 'm-1' })); // 重复投递
  ws.receive(JSON.stringify({ channel: 'chat:u1', data: { text: 'hi' }, msgId: 'm-2' }));
  assert.deepEqual(got, [['status', { online: true }], ['chat', { text: 'hi' }]]); // 去重后各一次
  // 断线重连：重订阅＋再补快照
  snapshots = [];
  ws.drop();
  sched.advance(5000);
  FakeWS.instances[1].open();
  assert.deepEqual(snapshots, [['device:abc:status', 'chat:u1']]);
  assert.equal(JSON.parse(FakeWS.instances[1].sent[0]).action, 'subscribe');
  tr.close();
});

test('W-03 Bus 双通道：可靠断线入队重连补发；易失 100ms 节流只留最新', () => {
  FakeWS.instances = [];
  const { ctx, sched } = ctxWithClock();
  const qf = ctx.__qf;
  const tr = qf.QFTransport('wss://example.test/control.ashx', {
    WebSocketCtor: FakeWS, autoReconnect: true, scheduler: sched,
  });
  const bus = qf.QFBus(tr, { scheduler: sched });
  // 可靠：断线入队
  assert.equal(bus.publish('chat:u1', { text: 'a' }), 'queued');
  tr.connect();
  const ws = FakeWS.instances[0];
  ws.open();
  assert.equal(ws.sent.length, 1);
  assert.equal(JSON.parse(ws.sent[0]).data.text, 'a');
  // 易失：100ms 内多次只发第一次＋节流后补发最新值
  assert.equal(bus.publish('presence:u1', { x: 1, y: 1 }, { volatile: true }), 'sent');
  assert.equal(bus.publish('presence:u1', { x: 2, y: 2 }, { volatile: true }), 'throttled');
  assert.equal(bus.publish('presence:u1', { x: 3, y: 3 }, { volatile: true }), 'throttled');
  sched.advance(100); // 节流窗到，补发最新值
  const volatileSent = ws.sent.slice(1).map((s) => plain(JSON.parse(s)));
  assert.equal(volatileSent.length, 2); // 首次直发＋节流后补发
  assert.deepEqual(volatileSent[0].data, { x: 1, y: 1 });
  assert.deepEqual(volatileSent[1].data, { x: 3, y: 3 }); // 只留最新，中间值丢弃
  // 易失断线即丢：掉线后、节流窗外再发 → 直接 dropped，不入队、不补发
  ws.drop();
  sched.advance(150);
  assert.equal(bus.publish('presence:u1', { x: 9, y: 9 }, { volatile: true }), 'dropped');
  sched.advance(5000);
  FakeWS.instances[1].open();
  const afterReconnect = FakeWS.instances[1].sent.map((x) => JSON.parse(x));
  assert.equal(afterReconnect.filter((m) => m.volatile).length, 0); // 丢弃的值重连后也不补发
  tr.close();
});
