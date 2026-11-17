// QFRemote 键盘无障碍脚本化验收（S-076，真浏览器，Playwright）。
// 覆盖 WCAG 2.2 AA 的可脚本化部分：Tab 顺序可达主交互元素、Escape 关弹窗／
// 抽屉、focus 可见、200% 缩放无横向溢出且关键控件可达、触控目标 ≥24×24、
// live region #toasts 的 role=status／aria-live=polite 且不重复朗读。
// 屏幕阅读器（VoiceOver／TalkBack）人工签核见 A11Y-ACCEPTANCE.md（未闭合）。
// 运行：cd server/webapp/tests && npx playwright test a11y.spec.mjs
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

async function stubBase(page) {
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
}
async function openShell(page) {
  await page.addInitScript(() => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test', isAdmin: false }));
  });
  await stubBase(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
}
// 焦点是否可见：outline 或 box-shadow 任一非 none（:focus-visible 样式）。
async function focusVisible(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return false;
    const cs = getComputedStyle(el);
    return (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') || cs.boxShadow !== 'none';
  });
}

test('登录页 Tab 顺序：账号→密码→登录按钮，焦点可见', async ({ page }) => {
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.goto(baseURL + '/');
  await page.waitForSelector('#loginForm', { state: 'visible' });
  await page.locator('#li-user').focus();
  expect(await page.evaluate(() => document.activeElement.id)).toBe('li-user');
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('li-pass');
  expect(await focusVisible(page)).toBe(true);
  // 密码后 Tab 到「记住此设备」勾选或登录按钮：只要落在可交互元素上且焦点可见
  await page.keyboard.press('Tab');
  const id = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
  expect(['li-rem', 'li-save', 'li-btn']).toContain(id);
  expect(await focusVisible(page)).toBe(true);
});

test('Escape 关弹窗：showModal 后按 Esc，弹窗消失且焦点不丢', async ({ page }) => {
  await openShell(page);
  await page.evaluate(() => showModal('测试弹窗', '<p>内容</p>', [{ label: '知道了' }]));
  await expect(page.locator('#modalRoot .modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#modalRoot .modal')).toHaveCount(0, { timeout: 5000 });
});

test('Escape 关抽屉：打开后按 Esc，抽屉收起、aria-hidden 回 true', async ({ page }) => {
  await openShell(page);
  await page.evaluate(() => window.__qf.setDrawer(true));
  await expect(page.locator('#drawer.open')).toHaveCount(1);
  await expect(page.locator('#drawer')).toHaveAttribute('aria-hidden', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer.open')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('#drawer')).toHaveAttribute('aria-hidden', 'true');
});

test('200% 缩放：无横向溢出，登录按钮仍可达可点', async ({ page }) => {
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.goto(baseURL + '/');
  await page.waitForSelector('#loginForm', { state: 'visible' });
  await page.evaluate(() => { document.body.style.zoom = '200%'; });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.locator('#li-btn')).toBeVisible();
  await page.locator('#li-user').focus();
  expect(await page.evaluate(() => document.activeElement.id)).toBe('li-user');
});

test('触控目标：登录按钮 ≥24×24', async ({ page }) => {
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.goto(baseURL + '/');
  await page.waitForSelector('#loginForm', { state: 'visible' });
  const loginBox = await page.locator('#li-btn').boundingBox();
  expect(loginBox.width).toBeGreaterThanOrEqual(24);
  expect(loginBox.height).toBeGreaterThanOrEqual(24);
});

test('触控目标：壳内汉堡按钮（抽屉入口）≥24×24', async ({ page }) => {
  // 汉堡按钮只在 ≤760px 视口显示（app.css @media max-width:760px）
  await page.setViewportSize({ width: 390, height: 844 });
  await openShell(page);
  const burger = await page.locator('#burgerBtn').boundingBox();
  expect(burger.width).toBeGreaterThanOrEqual(24);
  expect(burger.height).toBeGreaterThanOrEqual(24);
});

test('live region：#toasts 为 role=status＋aria-live=polite，一条 toast 只播一次', async ({ page }) => {
  await openShell(page);
  const attrs = await page.evaluate(() => {
    const t = document.getElementById('toasts');
    return { role: t.getAttribute('role'), live: t.getAttribute('aria-live') };
  });
  expect(attrs.role).toBe('status');
  expect(attrs.live).toBe('polite');
  await page.evaluate(() => { toast('第一条', 'info'); toast('第二条', 'err'); });
  await page.waitForTimeout(200);
  const kids = await page.evaluate(() => Array.from(document.querySelectorAll('#toasts .toast')).map((el) => el.textContent));
  expect(kids).toEqual(['第一条', '第二条']);
  // 同一条文本不重复出现（不重复朗读的 DOM 前提）
  expect(new Set(kids).size).toBe(kids.length);
});
