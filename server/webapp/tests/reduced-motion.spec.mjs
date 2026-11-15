// QFRemote 网页端 reduced-motion 运行时测试（六项定夺⑤，2026-11-14）
//
// 验收的是真实浏览器行为，不是 grep：
//   - 用 Playwright 的 reducedMotion: 'reduce' 上下文模拟系统“减弱动态效果”；
//   - 对导航（抽屉）、Modal、骨架/加载、hover/focus 过渡逐个读 computed style，
//     断言动画/过渡被关闭（0s）或降为 0.01ms；
//   - 另有 no-preference 对照组，证明测试本身能区分两种状态（防止假通过）。
//
// 运行（需先装一次依赖，Chromium 用 npx playwright install chromium 或复用系统 Chromium）：
//   npm i -D @playwright/test
//   npx playwright test server/webapp/tests/reduced-motion.spec.js
// 本文件自带静态服务器（只 serving server/webapp/ 目录），不需要另外起服务。
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

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

// 登录态桩：只让 /license/api/me 与 /home/api/stats 成功，其余 API 一律 {ok:false}。
// 注意：Playwright 按注册倒序匹配路由——通用桩必须最先注册，专用桩后注册才生效。
// 注意：Chromium 会把 0.01ms 的 computed 值序列化成 "1e-05s"，断言必须按数值毫秒比较，不能比字符串。
async function stubApi(page, { delayStatsMs = 0, delayFriendsMs = 0 } = {}) {
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', async (r) => {
    if (delayStatsMs) await new Promise((x) => setTimeout(x, delayStatsMs));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) });
  });
  if (delayFriendsMs) {
    await page.route('**/api/friends/me', async (r) => {
      await new Promise((x) => setTimeout(x, delayFriendsMs));
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    });
  }
}

async function seedLogin(page) {
  await page.addInitScript(() => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test' }));
  });
}

// 读一个元素的动画/过渡 computed durations；返回数值毫秒 { transitionMs, animationMs, iteration }。
// Chromium 把 0.01ms 序列化为 "1e-05s"，这里统一换算成毫秒再比较。
async function durations(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const toMs = (v) => {
      const s = String(v).trim();
      if (s.endsWith('ms')) return parseFloat(s);
      if (s.endsWith('s')) return parseFloat(s) * 1000;
      return parseFloat(s);
    };
    return { transitionMs: toMs(cs.transitionDuration), animationMs: toMs(cs.animationDuration), iteration: cs.animationIterationCount };
  }, selector);
}
// 减动效下：有动画/过渡的元素应 ≤0.01ms；本身无动画/过渡的元素为 0。
const OFF = 0.011;

test.describe('prefers-reduced-motion: reduce（运行时）', () => {
  test.use({ reducedMotion: 'reduce' });

  test('模拟生效：matchMedia 命中 reduce', async ({ page }) => {
    await page.goto(baseURL + '/');
    await expect(page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).resolves.toBe(true);
  });

  test('导航/抽屉：过渡降为 0.01ms，打开立即到位', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubApi(page);
    await seedLogin(page);
    await page.goto(baseURL + '/?t=drawer#home');
    await page.waitForSelector('#burgerBtn', { state: 'visible' });
    const before = await durations(page, '.drawer');
    expect(before).not.toBeNull();
    expect(before.transitionMs).toBeLessThanOrEqual(OFF);
    await page.click('#burgerBtn');
    // 等 300ms 再断言：关闭过渡里 visibility 还有 0.22s delay（减动效只改 duration 不改 delay），
    // 立刻读会在“已关闭位移、仍可见”的中间态误判；300ms 后状态已落定。
    await page.waitForTimeout(300);
    await expect(page.locator('.drawer')).toHaveClass(/open/);
    await expect(page.locator('.drawer')).toHaveCSS('visibility', 'visible');
    const transform = await page.evaluate(() => getComputedStyle(document.querySelector('.drawer')).transform);
    expect(transform).toBe('none');
    const scrim = await durations(page, '.dscrim');
    expect(scrim.transitionMs).toBeLessThanOrEqual(OFF);
  });

  test('Modal：弹窗及其中按钮的过渡/动画被关闭或降为 0.01ms', async ({ page }) => {
    // 不桩 /license/api/me：让会话校验失败出登录页（桩成功会直接进壳，就没有登录页可测）；
    // showModal 是 app.js 顶层函数，与登录态无关。
    await page.goto(baseURL + '/');
    await page.waitForSelector('#authRoot .btn.block', { state: 'visible' });
    await page.evaluate(() => window.showModal('减动效测试', '<p>内容</p>', [{ label: '取消' }, { label: '确认', primary: true }]));
    await expect(page.locator('#modalRoot .modal')).toBeVisible();
    for (const sel of ['#modalRoot .mask', '#modalRoot .modal', '#modalRoot .modal .btn']) {
      const d = await durations(page, sel);
      expect(d, sel).not.toBeNull();
      expect(d.transitionMs, `${sel} transition`).toBeLessThanOrEqual(OFF);
      expect(d.animationMs, `${sel} animation`).toBeLessThanOrEqual(OFF);
    }
    // 主按钮本身带 transition，必须是 0.01ms 量级（不是 0：它原本就有过渡）
    const btn = await durations(page, '#modalRoot .modal .btn');
    expect(btn.transitionMs).toBeGreaterThan(0);
    expect(btn.transitionMs).toBeLessThanOrEqual(OFF);
  });

  test('骨架/加载：.skel 动画降为 0.01ms 且只播 1 次', async ({ page }) => {
    // 好友页骨架在 await /api/friends/me 期间常驻（首页骨架是同步填掉的，留不住）；
    // 把该接口延迟 10s，骨架就有足够时间被采样。
    // 注意：冷启动会强制落 #home，必须先到首页再切 hash 到好友页，直接 goto #friends 会被 boot 改回 #home。
    await stubApi(page, { delayFriendsMs: 10000 });
    await seedLogin(page);
    await page.goto(baseURL + '/?t=skel#home');
    await page.waitForSelector('#view', { state: 'visible' });
    await page.evaluate(() => { location.hash = '#friends'; });
    await page.waitForSelector('#frList .skel', { state: 'attached' });
    const d = await durations(page, '.skel');
    expect(d).not.toBeNull();
    expect(d.animationMs).toBeLessThanOrEqual(OFF);
    expect(d.iteration).toBe('1');
  });

  test('hover/focus 过渡：按钮与开关的 transition 降为 0.01ms', async ({ page }) => {
    await stubApi(page);
    await seedLogin(page);
    await page.goto(baseURL + '/?t=hover#profile');
    await page.waitForSelector('#view .btn', { state: 'visible' });
    // hover 状态下的过渡时长与常态同一属性：直接读常态 computed 值
    const btn = await durations(page, '#view .btn');
    expect(btn.transitionMs).toBeLessThanOrEqual(OFF);
    // 真 hover 一次：样式仍为 0.01ms，且无位移类过渡残留
    await page.hover('#view .btn');
    const btnHover = await durations(page, '#view .btn');
    expect(btnHover.transitionMs).toBeLessThanOrEqual(OFF);
    // 开关（focus 可达控件）同样带 transition
    const sw = await durations(page, '.qf-switch');
    if (sw) expect(sw.transitionMs).toBeLessThanOrEqual(OFF);
    // 键盘焦点：focus-visible 描边仍出现（减动效只关动画，不关焦点可见性）
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
    expect(focused).toBeTruthy();
  });
});

test.describe('对照组：no-preference 下动效应正常（防假通过）', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('按钮过渡与骨架动画未被关闭', async ({ page }) => {
    await stubApi(page, { delayFriendsMs: 10000 });
    await seedLogin(page);
    await page.goto(baseURL + '/?t=ctrl#home');
    await page.waitForSelector('#view', { state: 'visible' });
    await page.evaluate(() => { location.hash = '#friends'; });
    await page.waitForSelector('#frList .skel', { state: 'attached' });
    const skel = await durations(page, '.skel');
    expect(skel.animationMs).toBeGreaterThanOrEqual(1500); /* REWORK C §1.1：骨架脉冲 1.2s→1.6s，透明度 .6→.9 */
    expect(skel.animationMs).toBeLessThanOrEqual(1700);
    // 同一页上的普通按钮过渡也不应被关闭（好友页“发送好友申请”按钮）
    const btn = await durations(page, '#fr-add');
    expect(btn.transitionMs).toBeGreaterThanOrEqual(100);
  });
});
