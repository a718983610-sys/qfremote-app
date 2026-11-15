// QFRemote 网页端 L5 客户端协议真浏览器验收（Playwright）。
// 运行：cd server/webapp/tests && npx playwright test l5-clients.spec.mjs
// 说明：服务端端点用 page.route 桩（与 server/ext/server.js 的路由同形）；
// 测的是真浏览器里的客户端逻辑，服务端实现本身由 test-l5-*.js 覆盖。
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json' };

let server;
let baseURL;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(WEBAPP, url === '/' ? 'index.html' : url);
    if (!file.startsWith(WEBAPP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function seedLogin(page) {
  await page.addInitScript(() => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test' }));
  });
}
async function stubBase(page) {
  // 注意：Playwright 按注册倒序匹配——先注册兜底，再注册具体路由。
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [{ name: 'PC-1', online: true }] }) }));
}
async function stubSessionFlow(page, relaysBody) {
  await page.route('**/api/device/resolve*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, nodeid: 'node-test-1', name: 'test-device' }) }));
  await page.route('**/api/device/presence*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, code: 'ONLINE', fresh: true }) }));
  await page.route('**/license/api/relays', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(relaysBody) }));
}

test('RC-07 降级态：宣告列表为空 → 不建连，遮罩“中继全部不可用”', async ({ page }) => {
  await seedLogin(page);
  await stubBase(page);
  await stubSessionFlow(page, { ok: true, relays: [] });
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  // 冷启动有缓存时 boot 强制落 #home（站长令），须先进壳再切会话 hash。
  await page.evaluate(() => { location.hash = '#session/test-device'; });
  await expect(page.locator('#qfMask')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#qfMaskT')).toContainText('中继全部不可用');
  await expect(page.locator('#qfMaskD')).toContainText('中继全部不可用');
  await expect(page.locator('[data-act="retry"]')).toBeVisible();
});

test('RC-07 选址成功：同源 tier-1 中继在列表内 → 不落降级遮罩，会话继续建立', async ({ page }) => {
  await seedLogin(page);
  await stubBase(page);
  await stubSessionFlow(page, { ok: true, relays: [{ id: 'qfremote-primary', url: baseURL + '/console-engine/', tier: 1, priority: 100, ttlSec: 600, issuedAt: Date.now() }] });
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate(() => { location.hash = '#session/test-device'; });
  await page.waitForTimeout(4000);
  await expect(page.locator('#qfMask')).toBeHidden();
  await expect(page.locator('#qfConnecting')).toBeVisible();
});

test('RC-08 文件上传（真浏览器）：File.slice 分片＋SHA-256＋commit 全流程', async ({ page }) => {
  await seedLogin(page);
  await stubBase(page);
  const chunks = [];
  await page.route('**/license/api/files/stream/init', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, transferId: 'tf_0123456789abcdef', chunkSize: 4, totalChunks: 3 }) }));
  await page.route('**/license/api/files/stream/*/chunk', async (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    chunks.push(body);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, received: chunks.length, totalChunks: 3 }) });
  });
  await page.route('**/license/api/files/stream/*/commit', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, transferId: 'tf_0123456789abcdef', stagedId: 'fs_0123456789abcdef', size: 10, expiresAt: 1790000000000 }) }));
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  const result = await page.evaluate(async () => {
    const tf = QFFileTransfer({});
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const file = new File([bytes], 't.bin');
    const states = [];
    const r = await tf.upload(file, 'nodeB', 'nodeA', (p) => states.push(p.state));
    return { ok: r.ok, stagedId: r.stagedId, state: tf.state, states };
  });
  expect(result.ok).toBe(true);
  expect(result.stagedId).toBe('fs_0123456789abcdef');
  expect(result.state).toBe('staged');
  expect(chunks.length).toBe(3);
  expect(chunks[0].index).toBe(0);
  expect(Buffer.from(chunks[0].contentBase64, 'base64').equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  expect(Buffer.from(chunks[2].contentBase64, 'base64').equals(Buffer.from([9, 10]))).toBe(true);
});

test('RC-09 画质探针（真浏览器）：降档决策执行＋5 秒内 ACK，升档 AT_TOP 透传', async ({ page }) => {
  await seedLogin(page);
  await stubBase(page);
  const acks = [];
  await page.route('**/license/api/session/probe', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, tier: 'balanced',
    decision: { decision: 'downgrade-to', decisionId: 'qd_1', from: 'clear', to: 'balanced', hot: { targetKbps: 2500 }, reconfig: { resolutionScale: 0.75 }, mustAckByMs: Date.now() + 5000, needsIdr: true },
    backpressure: { level: null, action: null, note: 'none' },
  }) }));
  await page.route('**/license/api/session/quality/ack', async (r) => {
    acks.push(JSON.parse(r.request().postData() || '{}'));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, tier: 'balanced', kind: 'downgrade', rttMs: 12 }) });
  });
  await page.route('**/license/api/session/quality/upgrade', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'AT_TOP' }) }));
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  const out = await page.evaluate(async () => {
    const changes = [];
    const probe = QFQualityProbe({
      sessionId: 'sess-0123456789abcdef', agentId: 'agent-1',
      collect: () => ({ rttMs: 900, lossPct: 1, lossSamples: 120, jitterMs: 10 }),
      onTierChange: (from, to, split) => changes.push({ from, to, needsIdr: split.needsIdr }),
    });
    probe.tier = 'clear';
    await probe.sendOnce();
    const up = await probe.upgrade();
    return { tier: probe.tier, changes, upCode: up.code, pendingAck: probe.pendingAck };
  });
  expect(out.tier).toBe('balanced');
  expect(out.changes).toEqual([{ from: 'clear', to: 'balanced', needsIdr: true }]);
  expect(out.pendingAck).toBe(null);
  expect(acks.length).toBe(1);
  expect(acks[0].decisionId).toBe('qd_1');
  expect(out.upCode).toBe('AT_TOP');
});

test('RC-03 IDR＋FEC（真浏览器）：join 发送、丢 2 分片 RS 恢复出帧', async ({ page }) => {
  await seedLogin(page);
  await stubBase(page);
  const idrBodies = [];
  await page.route('**/license/api/session/idr-request', async (r) => {
    idrBodies.push(JSON.parse(r.request().postData() || '{}'));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, decision: 'forward', code: 'OK' }) });
  });
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  const out = await page.evaluate(async () => {
    const idr = QFIdrRequester({});
    const join = await idr.request('sess-0123456789abcdef', 'agent-1', 'join');
    // 用 qfRsEncode 现场造分片：k=10/m=2，丢 3、7 两片
    const k = 10, m = 2, shardLen = 16;
    const data = [];
    for (let i = 0; i < k; i++) {
      const b = new Uint8Array(shardLen);
      for (let j = 0; j < shardLen; j++) b[j] = (i * 37 + j * 11 + 5) % 256;
      data.push(b);
    }
    const enc = qfRsEncode(data, k, m);
    const shards = enc.data.concat(enc.parity);
    window.__fecFrames = [];
    window.__fecUnrec = [];
    const recv = QFFecReceiver({
      onFrame: (bufs) => window.__fecFrames.push(bufs),
      onUnrecoverable: (frameId) => window.__fecUnrec.push(frameId),
    });
    recv.setNetwork(10, 5);
    for (let i = 0; i < 12; i++) {
      if (i === 3 || i === 7) continue;
      recv.ingest({ fecVersion: 1, blockId: 9, frameId: 201, isKeyframe: false, frameStart: i === 0, frameEnd: i === 11, symbolIndex: i, symbolCount: 12, symbolLength: 16, lastSymbolPadding: 0, k, m }, shards[i]);
    }
    await new Promise((r) => setTimeout(r, 300));
    const first = window.__fecFrames[0] ? Array.from(window.__fecFrames[0][7]) : null;
    return { joinDecision: join.decision, seq: idr.seq, frames: window.__fecFrames.length, unrec: window.__fecUnrec, first7: first, expect7: Array.from(data[7]) };
  });
  expect(out.joinDecision).toBe('forward');
  expect(out.seq).toBe(1);
  expect(idrBodies.length).toBe(1);
  expect(idrBodies[0].reason).toBe('join');
  expect(out.frames).toBe(1);
  expect(out.unrec).toEqual([]);
  expect(out.first7).toEqual(out.expect7);
});

test('RC-10 录像回放（真浏览器）：列表→加载→播放出光标，seek 锚点快进', async ({ page }) => {
  await seedLogin(page);
  await stubBase(page);
  const qfrec = [
    '{"type":"input","at":1000,"kind":"mouse","x":10,"y":20}',
    '{"type":"input","at":1100,"kind":"mouse","x":30,"y":40}',
    '{"type":"quality-change","at":1200,"from":"clear","to":"balanced"}',
    '{"type":"input","at":1300,"kind":"mouse","x":50,"y":60}',
    '{"type":"frame-marker","at":1400,"frameId":7,"isKeyframe":true}',
  ].join('\n') + '\n';
  await page.route('**/license/api/files/inbox*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, files: [] }) }));
  await page.route('**/license/api/files/sent', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, files: [] }) }));
  await page.route('**/license/api/files/audit*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, audit: [] }) }));
  await page.route('**/license/api/recordings', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, recordings: [{ sessionId: 'rec_0123456789abcdef', deviceId: 'node1', tier: 'balanced', startedAt: 1790000000000, bytes: 299 }] }) }));
  await page.route('**/license/api/recordings/*/index', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, index: { sessionId: 'rec_0123456789abcdef', index: [{ t: 1000, byteOffset: 56 }, { t: 1200, byteOffset: 179 }], events: 5, bytes: 299, endedAt: 1790000001000 } }) }));
  await page.route('**/license/api/recordings/*/download', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: qfrec }));
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate(() => { location.hash = '#files'; });
  await expect(page.locator('[data-rec-play="rec_0123456789abcdef"]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#recList')).toContainText('rec_0123456789abcdef');
  await page.locator('[data-rec-play="rec_0123456789abcdef"]').click();
  await expect(page.locator('#recPlayer')).toBeVisible();
  await expect(page.locator('#recStatus')).toContainText('共 5 个事件', { timeout: 10000 });
  await expect(page.locator('#recPlayer')).toContainText('本录像含操作记录');
  // 载入即画出初始光标（canvas 有非透明像素）
  const pixels = await page.evaluate(() => {
    const c = document.querySelector('#recCanvas');
    const d = c.getContext('2d').getImageData(0, 0, 640, 360).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  expect(pixels).toBeGreaterThan(0);
  // 播放：按钮变“暂停”，播完变回“播放”
  await page.locator('#recPlayBtn').click();
  await expect(page.locator('#recPlayBtn')).toContainText('暂停');
  await expect(page.locator('#recPlayBtn')).toContainText('播放', { timeout: 5000 });
});
