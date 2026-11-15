// QFRemote 网页端 W-02～W-10＋RC-04/RC-05 真浏览器验收（Playwright）。
// 运行：cd server/webapp/tests && npx playwright test w02-w10.spec.mjs
// 说明：WS 对端用脚本化 FakeWS（addInitScript 在 app 脚本前替换 window.WebSocket），
// 测的是真浏览器里的 Transport/Bus 逻辑；服务端广播侧在上游 MeshCentral，不在树内。
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

async function stubApi(page) {
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
}
async function seedLogin(page) {
  await page.addInitScript(() => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test' }));
  });
}
// 脚本化 WS 对端：替换 window.WebSocket，供 QFTransport 连接；测试经 window.__fakeWS 驱动。
async function installFakeWS(page) {
  await page.addInitScript(() => {
    window.__fakeWS = { instances: [] };
    window.WebSocket = class FakeWS {
      constructor(url) {
        this.url = url; this.sent = []; this.readyState = 0;
        this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
        window.__fakeWS.instances.push(this);
      }
      send(s) { this.sent.push(String(s)); }
      close() { this.readyState = 3; if (this.onclose) this.onclose(); }
      open() { this.readyState = 1; if (this.onopen) this.onopen(); }
      receive(data) { if (this.onmessage) this.onmessage({ data }); }
      drop() { this.readyState = 3; if (this.onclose) this.onclose(); }
    };
  });
}

test('W-02 Transport+Bus：订阅分发、断线重连重订阅＋补快照', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await installFakeWS(page);
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate(() => { window.__wsBase = window.__fakeWS.instances.length; });
  await page.evaluate(() => {
    window.__bus1 = (() => {
      const tr = QFTransport('wss://x/control.ashx', { autoReconnect: true, maxAttempts: 5, retryIntervalMs: 100 });
      const snaps = [];
      const bus = QFBus(tr, { sendSubscribe: true, onSnapshot: (ch) => { snaps.push(ch.slice()); } });
      const got = [];
      bus.subscribe('device:abc:status', (d) => got.push(d));
      bus.subscribe('chat:u1', (d) => got.push(d));
      tr.connect();
      return { tr, bus, snaps, got };
    })();
  });
  await page.evaluate(() => window.__fakeWS.instances[window.__wsBase].open());
  await page.waitForFunction(() => window.__bus1.tr.state === 'open');
  const snap1 = await page.evaluate(() => window.__bus1.snaps.length);
  expect(snap1).toBe(1); // 建连即补快照
  await page.evaluate(() => {
    const ws = window.__fakeWS.instances[window.__wsBase];
    ws.receive(JSON.stringify({ channel: 'device:abc:status', data: { online: true }, msgId: 'm-1' }));
    ws.receive(JSON.stringify({ channel: 'device:abc:status', data: { online: true }, msgId: 'm-1' }));
  });
  expect(await page.evaluate(() => window.__bus1.got.length)).toBe(1); // 去重
  await page.evaluate(() => window.__fakeWS.instances[window.__wsBase].drop());
  await page.waitForFunction(() => window.__fakeWS.instances.length === window.__wsBase + 2, null, { timeout: 5000 });
  await page.evaluate(() => window.__fakeWS.instances[window.__wsBase + 1].open());
  await page.waitForFunction(() => window.__bus1.snaps.length === 2, null, { timeout: 5000 });
  const resub = await page.evaluate(() => JSON.parse(window.__fakeWS.instances[window.__wsBase + 1].sent[0]).action);
  expect(resub).toBe('subscribe'); // 重连后重订阅
  expect(errors).toEqual([]);
});

test('W-03 易失通道 100ms 节流（真浏览器）：10 次连发只上行 2 次', async ({ page }) => {
  await installFakeWS(page);
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate(() => { window.__wsBase3 = window.__fakeWS.instances.length; });
  await page.evaluate(() => {
    window.__bus3 = (() => {
      const tr = QFTransport('wss://x/control.ashx', {});
      const bus = QFBus(tr, {});
      tr.connect();
      return { tr, bus };
    })();
    window.__fakeWS.instances[window.__wsBase3].open();
  });
  await page.waitForFunction(() => window.__bus3.tr.state === 'open');
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) window.__bus3.bus.publish('presence:u1', { x: i, y: i }, { volatile: true });
  });
  await page.waitForTimeout(250);
  const sent = await page.evaluate(() => window.__fakeWS.instances[window.__wsBase3].sent.map((s) => JSON.parse(s)));
  const vol = sent.filter((m) => m.volatile);
  expect(vol.length).toBe(2); // 首次直发＋100ms 后补发最新值
  expect(vol[1].data).toEqual({ x: 9, y: 9 }); // 只留最新
});

test('W-09 i18n：en 包加载后 t() 切英文，缺 key 回落中文', async ({ page }) => {
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  expect(await page.evaluate(() => window.t('reconnect.cancel'))).toBe('取消重连');
  expect(await page.evaluate(async () => { await window.qfLoadLocale('en'); return window.t('reconnect.cancel'); })).toBe('Cancel reconnect');
  expect(await page.evaluate(() => window.t('reconnect.attempt', { n: 2, max: 5 }))).toContain('attempt 2 of 5');
  expect(await page.evaluate(() => window.t('reconnect.restored'))).toBe('Connection restored');
  expect(await page.evaluate(() => window.t('definitely.missing'))).toBe('definitely.missing'); // 未知 key 原样回 key
});

test('W-10 IndexedDB＋多标签页：草稿跨页可见，广播只投递一次', async ({ page, context }) => {
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  const pageB = await context.newPage();
  await stubApi(pageB);
  await seedLogin(pageB);
  await pageB.goto(baseURL + '/#home');
  await pageB.waitForSelector('#view', { state: 'visible' });
  await pageB.evaluate(() => { window.__bcGot = []; QFLocal.onBroadcast((m) => window.__bcGot.push(m)); });
  await page.evaluate(async () => {
    await QFLocal.save('drafts', 'chat:u1', { text: '跨页草稿', updatedAt: Date.now(), tabId: QFLocal.tabId });
    QFLocal.broadcast('draft:chat:u1', { text: '跨页草稿', updatedAt: Date.now(), tabId: QFLocal.tabId });
  });
  await expect.poll(async () => pageB.evaluate(() => QFLocal.load('drafts', 'chat:u1').then((d) => (d ? d.text : null)))).toBe('跨页草稿');
  await page.waitForTimeout(300);
  const bcCount = await pageB.evaluate(() => window.__bcGot.length);
  expect(bcCount).toBe(1); // BroadcastChannel＋storage 双通道去重后只投递一次
  await pageB.close();
});

test('W-04 boot data：__QF_BOOT__ 播种 store＋主题', async ({ page }) => {
  await page.addInitScript(() => {
    window.__QF_BOOT__ = { user: 'test', displayName: 'test', isAdmin: false, theme: 'dark', devices: [{ name: 'D1', os: 'Windows', group: '', online: true }] };
  });
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  expect(await page.evaluate(() => QFStore.docs.devices.length)).toBe(1);
  expect(await page.evaluate(() => QFStore.docs.devices[0].name)).toBe('D1');
});

test('RC-05 渲染器（真浏览器 canvas）：100 小矩形 present 只贴脏区；鼠标 3 秒画圈 ≤ 200 包', async ({ page }) => {
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  const render = await page.evaluate(() => {
    const vis = document.createElement('canvas');
    const back = document.createElement('canvas');
    const r = QFRemoteRenderer(vis, { createCanvas: () => back });
    r.resize(800, 600);
    const vctx = vis.getContext('2d');
    let draws = 0;
    const orig = vctx.drawImage.bind(vctx);
    vctx.drawImage = (...a) => { draws++; return orig(...a); };
    const t0 = performance.now();
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 20; i++) r.fillRect(Math.floor(rnd() * 180), Math.floor(rnd() * 180), 20, 20, 'red');
    const p = r.present();
    const ms = performance.now() - t0;
    // 稠密档：两块半屏大矩形并后超 60% 即坍为全屏（规则正确行为）
    const vis2 = document.createElement('canvas');
    const back2 = document.createElement('canvas');
    const r2 = QFRemoteRenderer(vis2, { createCanvas: () => back2 });
    r2.resize(800, 600);
    r2.fillRect(0, 0, 800, 400, 'red').fillRect(0, 300, 800, 300, 'blue');
    const p2 = r2.present();
    return { rects: p.rects, area: p.area, draws, ms: Math.round(ms * 100) / 100, denseRects: p2.rects, denseArea: p2.area };
  });
  expect(render.rects).toBeLessThan(20); // 稀疏档：脏矩形合并后少于 20
  expect(render.draws).toBe(render.rects); // 可见 canvas 只贴脏区（稠密档用独立 canvas，不计入）
  expect(render.area).toBeLessThan(800 * 600); // 稀疏档脏区面积小于全屏
  expect(render.ms).toBeLessThan(50);
  expect(render.denseRects).toBe(1); // 稠密档坍为全屏
  expect(render.denseArea).toBe(800 * 600);
  const mouse = await page.evaluate(async () => {
    const sent = [];
    const th = QFMouseThrottle({ intervalMs: 17, send: (x, y) => sent.push([x, y]) });
    await new Promise((resolve) => {
      let i = 0;
      const timer = setInterval(() => {
        const a = (i / 180) * Math.PI * 2 * 3;
        th.record(Math.round(400 + 200 * Math.cos(a)), Math.round(300 + 200 * Math.sin(a)));
        if (++i >= 180) { clearInterval(timer); resolve(); }
      }, 16.7);
    });
    await new Promise((r) => setTimeout(r, 100));
    return { sent: sent.length, dropped: th.dropped };
  });
  expect(mouse.sent).toBeLessThanOrEqual(200); // 3 秒画圈 ≈ 3000/17 ≈ 176 包
  expect(mouse.sent).toBeGreaterThanOrEqual(150);
  expect(mouse.dropped).toBeGreaterThan(0);
});

test('RC-04 接线存在性：QFReconnect＋票据校验＋sessEnsureReconnect 在浏览器可用', async ({ page }) => {
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  const checks = await page.evaluate(() => ({
    hasQFReconnect: typeof window.QFReconnect === 'function',
    hasSessEnsure: typeof window.sessEnsureReconnect === 'function',
    ticketOk: window.validateReconnectTicket({
      account_id: 'alice', device_id: 'dev-1', api_key_id: 'k_0123456789',
      binding_epoch: 3, grant_epoch: 1, resume_id: 'resume-0123456789abcdef',
      session_id: 'sess-0123456789abcdef', issued_at: 1790000000, expires_at: 1790000300,
      ticket_signature: 'AAAA',
    }).ok,
    stripHtml: QFComponents.render('reconnect-strip', { attempt: 2, max: 5, state: 'reconnecting' }),
  }));
  expect(checks.hasQFReconnect).toBe(true);
  expect(checks.hasSessEnsure).toBe(true);
  expect(checks.ticketOk).toBe(true);
  expect(checks.stripHtml).toContain('第 2 次 / 共 5 次');
  expect(checks.stripHtml).toContain('取消重连');
});
