// RC-05 渲染器＋鼠标节流单测（假 canvas/手动时钟）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWebapp, ManualScheduler } from './load-webapp.mjs';

function stubCtx() {
  const calls = [];
  return {
    calls,
    fillStyle: '',
    fillRect(x, y, w, h) { calls.push(['fillRect', x, y, w, h, this.fillStyle]); },
    drawImage(...a) { calls.push(['drawImage', ...a]); },
    clearRect(x, y, w, h) { calls.push(['clearRect', x, y, w, h]); },
  };
}
function stubCanvas() {
  const ctx = stubCtx();
  return { width: 0, height: 0, _ctx: ctx, getContext: () => ctx };
}

test('RC-05 脏矩形合并：重叠两块并为一块；不重叠各自保留；超 60% 坍为全屏', () => {
  const ctx = loadWebapp({});
  const qf = ctx.__qf;
  const vis = stubCanvas();
  const back = stubCanvas();
  const r = qf.QFRemoteRenderer(vis, { createCanvas: () => back });
  r.resize(100, 100);
  r.fillRect(10, 10, 20, 20, 'red').fillRect(25, 10, 20, 20, 'blue'); // 重叠
  assert.equal(r.dirtyCount(), 1);
  r.fillRect(70, 70, 10, 10, 'green'); // 不重叠
  assert.equal(r.dirtyCount(), 2);
  const p = r.present();
  assert.equal(p.rects, 2);
  assert.equal(p.area, 35 * 20 + 10 * 10); // 并后矩形 35×20＋10×10
  assert.equal(r.dirtyCount(), 0); // present 后清脏区
  // 超 60% 面积坍为全屏
  r.fillRect(0, 0, 80, 80, 'red');
  assert.equal(r.dirtyCount(), 1);
  const p2 = r.present();
  assert.equal(p2.rects, 1);
  assert.equal(p2.area, 10000);
  assert.equal(r.stats.collapsedFull, 1);
});

test('RC-05 绘制队列保序：fill/blit 按入队顺序落到后备缓冲', () => {
  const ctx = loadWebapp({});
  const qf = ctx.__qf;
  const vis = stubCanvas();
  const back = stubCanvas();
  const src = stubCanvas();
  const r = qf.QFRemoteRenderer(vis, { createCanvas: () => back });
  r.resize(200, 100);
  r.fillRect(0, 0, 10, 10, 'red').blit(src, 0, 0, 50, 50, 100, 0).fillRect(5, 5, 10, 10, 'blue');
  assert.equal(r.flush(), 3);
  const kinds = back._ctx.calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['fillRect', 'drawImage', 'fillRect']); // 顺序与入队一致
  assert.equal(r.stats.flushedOps, 3);
  // present 只贴脏区：可见 canvas 的 drawImage 按脏矩形数调用
  const before = vis._ctx.calls.length;
  const p = r.present();
  assert.equal(vis._ctx.calls.length - before, p.rects);
  assert.ok(p.area < 200 * 100); // 脏区面积显著小于全屏
});

test('RC-05 鼠标 17ms 节流：10 秒 60Hz 画圈上行包数 ≤ 600', () => {
  const ctx = loadWebapp({});
  const qf = ctx.__qf;
  const sched = new ManualScheduler();
  const sent = [];
  const th = qf.QFMouseThrottle({ intervalMs: 17, send: (x, y) => sent.push([x, y]), scheduler: sched });
  // 模拟 10 秒、每 16.7ms 一次 mousemove（约 60Hz，共 600 次原始事件）
  for (let i = 0; i < 600; i++) {
    const a = (i / 600) * Math.PI * 2;
    th.record(Math.round(400 + 200 * Math.cos(a)), Math.round(300 + 200 * Math.sin(a)));
    sched.advance(16.7);
  }
  sched.advance(100); // 尾部待发 flush
  assert.ok(sent.length <= 600, `上行包数 ${sent.length} 应 ≤ 600`);
  assert.ok(sent.length >= 500, `节流后仍应保持跟手性，实发 ${sent.length}`);
  assert.ok(th.dropped > 0); // 确实节流过（原始 600 次事件有丢弃）
  // 最后发出的是最新位置（跟手性：最后一个点即圆的终点附近）
  const last = sent[sent.length - 1];
  assert.ok(Math.abs(last[0] - (400 + 200 * Math.cos((599 / 600) * Math.PI * 2))) <= 2);
});

test('RC-05 鼠标节流：静止时不发包；首包立即发', () => {
  const ctx = loadWebapp({});
  const qf = ctx.__qf;
  const sched = new ManualScheduler();
  const sent = [];
  const th = qf.QFMouseThrottle({ intervalMs: 17, send: (x, y) => sent.push([x, y]), scheduler: sched });
  assert.equal(th.record(10, 10), 'sent');
  assert.equal(sent.length, 1);
  assert.equal(th.record(11, 11), 'throttled');
  sched.advance(17);
  assert.equal(sent.length, 2); // 窗口到后补发最新位置
  assert.deepEqual(sent[1], [11, 11]);
});
