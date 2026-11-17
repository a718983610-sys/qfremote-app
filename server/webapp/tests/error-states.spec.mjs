// QFRemote 错误态验收（S-071 缺口补齐，真浏览器，Playwright）。
// 覆盖：①登录失败错误面——桩 /qf-login＋/license/api/me 401，提交后
// #li-err 显示「账号或密码不正确」，登录按钮恢复可点；②错误 toast——
// err 样式 toast 渲染（role=status）、点击关闭、4 秒自动消失。
// 运行：cd server/webapp/tests && npx playwright test error-states.spec.mjs
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

test('登录失败：#li-err 显示账号或密码不正确，按钮恢复可点', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // /qf-login 回 200 无 x-qf-login-result；/license/api/me 两次 401（doLogin 会等 600ms 重试一轮）。
  await page.route('**/qf-login', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '' }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
  await page.goto(baseURL + '/');
  await page.waitForSelector('#loginForm', { state: 'visible' });
  await page.fill('#li-user', 'wronguser');
  await page.fill('#li-pass', 'wrongpass');
  await page.locator('#loginForm button[type="submit"], #li-btn').first().click();
  await expect(page.locator('#li-err')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#li-err')).toContainText('账号或密码不正确');
  await expect(page.locator('#li-btn')).toBeEnabled();
  await expect(page.locator('#li-btn')).toHaveText('登录');
  expect(errors).toEqual([]);
});

test('错误 toast：err 样式＋role=status，可点关，4 秒自动消失', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test' }));
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate(() => toast('网络暂时不可用，请检查网络后重试。', 'err'));
  const t = page.locator('#toasts .toast.err').first();
  await expect(t).toBeVisible();
  await expect(t).toHaveText('网络暂时不可用，请检查网络后重试。');
  await expect(t).toHaveAttribute('role', 'status');
  // 点击关闭
  await t.click();
  await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 5000 });
  // 再发一条，等自动消失（4 秒＋120ms 退出）
  await page.evaluate(() => toast('登录未完成，请稍后再试。', 'err'));
  await expect(page.locator('#toasts .toast.err')).toBeVisible();
  await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 8000 });
  expect(errors).toEqual([]);
});
