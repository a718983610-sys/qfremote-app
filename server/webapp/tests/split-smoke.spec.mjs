// QFRemote 网页端 W-05 拆分回归冒烟（真实浏览器，Playwright）。
// 覆盖拆分后最易断的点：四脚本按序加载、全局入口仍在、登录页/壳/抽屉/弹窗/主题切换/路由。
// 运行：cd server/webapp/tests && npx playwright test split-smoke.spec.mjs
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

test('四脚本按序加载，全局入口与 window.__qf 均在，无页面报错', async ({ page }) => {
  const errors = [];
  // 只收 JS 异常：静态桩服务器没有 /control.ashx，WS 握手 404 与个别资源 404 是桩环境产物，不是页面错误。
  page.on('pageerror', (e) => errors.push(String(e)));
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/');
  await page.waitForSelector('#view', { state: 'visible' });
  const scripts = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')));
  // W-08：script src 为 ASSETS.json 里的 hash 文件名（无 ?v= 查询串），按层顺序
  const assets = JSON.parse(fs.readFileSync(path.join(WEBAPP, 'ASSETS.json'), 'utf8')).files;
  expect(scripts).toEqual(['qf-schema.js', 'qf-runtime.js', 'qf-ui.js', 'app.js'].map((f) => assets[f]));
  const qf = await page.evaluate(() => ({
    hasShowModal: typeof window.showModal === 'function',
    hasToast: typeof window.toast === 'function',
    hasQf: !!window.__qf && typeof window.__qf.navigate === 'function',
    hasTransport: typeof window.QFTransport === 'function',
  }));
  expect(qf).toEqual({ hasShowModal: true, hasToast: true, hasQf: true, hasTransport: true });
  expect(errors).toEqual([]);
});

test('未登录出登录页；登录缓存进壳出首页', async ({ page }) => {
  await page.goto(baseURL + '/');
  await page.waitForSelector('#authRoot .btn.block', { state: 'visible' });
  await expect(page.locator('#shellRoot')).toBeHidden();
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/?t=2#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await expect(page.locator('#shellRoot')).toBeVisible();
  await expect(page.locator('#sidebar')).toBeVisible(); // 桌面视口：侧栏可见；汉堡按钮只在窄屏出现
});

test('抽屉开合与弹窗（qf-ui 层）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#burgerBtn', { state: 'visible' });
  await page.click('#burgerBtn');
  await expect(page.locator('.drawer')).toHaveClass(/open/);
  await page.evaluate(() => window.showModal('冒烟', '<p>内容</p>', [{ label: '取消' }, { label: '确认', primary: true }]));
  await expect(page.locator('#modalRoot .modal')).toBeVisible();
  await page.evaluate(() => window.closeModal());
  await expect(page.locator('#modalRoot .modal')).toHaveCount(0);
});

test('主题切换（qf-runtime 层）：apply/toggle 落 data-theme 与存储', async ({ page }) => {
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate(() => { window.applyTheme('dark'); });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // applyTheme 不写存储：再 toggle 应按系统（浅色）翻成 dark；写存储 dark 后 toggle 才翻回 light
  await page.evaluate(() => { window.toggleTheme(); });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => { localStorage.setItem('qf-theme', 'dark'); window.toggleTheme(); });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const stored = await page.evaluate(() => localStorage.getItem('qf-theme'));
  expect(stored).toBe('light');
});

test('路由到设备页渲染（app.js 壳）', async ({ page }) => {
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/?t=dev#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate(() => { location.hash = '#devices'; });
  await expect(page.locator('#view h1')).toContainText('我的设备');
});
