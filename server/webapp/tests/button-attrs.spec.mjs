// QFRemote button attrs 转义验收（S-057，真浏览器，Playwright）。
// 覆盖：对象/字符串两种 attrs 形态——白名单外属性（on*、style、href、
// formaction）一律丢弃，属性值一律 esc() 转义；合法 data-*/aria-*/type/
// title 保留；注入的 onclick 点了也不执行。
// 运行：cd server/webapp/tests && npx playwright test button-attrs.spec.mjs
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

async function openPage(page) {
  await page.addInitScript(() => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test' }));
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate(() => {
    let el = document.getElementById('__attrs');
    if (!el) {
      el = document.createElement('div');
      el.id = '__attrs';
      document.getElementById('view').appendChild(el);
    }
  });
}

async function renderButton(page, args) {
  return page.evaluate((args) => {
    const el = document.getElementById('__attrs');
    el.innerHTML = QFComponents.render('button', args);
    return el.innerHTML;
  }, args);
}

test('S-057 对象 attrs：on*/style/href 丢弃，合法属性保留，值被转义', async ({ page }) => {
  await openPage(page);
  const html = await renderButton(page, {
    label: '测试',
    attrs: {
      onclick: 'window.__pwned=1', onmouseover: 'window.__pwned=2',
      style: 'color:red', href: 'javascript:alert(1)', formaction: '/x',
      'data-go': 'device-1', 'aria-label': '连接', type: 'submit', title: 'a"b<c',
    },
  });
  expect(html).not.toContain('onclick');
  expect(html).not.toContain('onmouseover');
  expect(html).not.toContain('style=');
  expect(html).not.toContain('href=');
  expect(html).not.toContain('formaction');
  expect(html).toContain('data-go="device-1"');
  expect(html).toContain('aria-label="连接"');
  expect(html).toContain('type="submit"');
  expect(html).toContain('title="a&quot;b&lt;c"');
  // 注入的属性不存在于 DOM 上（不只是字符串层面）
  const dom = await page.evaluate(() => {
    const b = document.querySelector('#__attrs button');
    return { onclick: b.getAttribute('onclick'), style: b.getAttribute('style'), href: b.getAttribute('href'), dataGo: b.getAttribute('data-go') };
  });
  expect(dom.onclick).toBeNull();
  expect(dom.style).toBeNull();
  expect(dom.href).toBeNull();
  expect(dom.dataGo).toBe('device-1');
});

test('S-057 字符串 attrs：onclick 丢弃、data-x 保留；点击不执行注入', async ({ page }) => {
  await openPage(page);
  await renderButton(page, { label: '测试', attrs: 'onclick="window.__pwned=1" data-x="1"' });
  const before = await page.evaluate(() => window.__pwned);
  expect(before).toBeUndefined();
  await page.locator('#__attrs button').click();
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.querySelector('#__attrs button').getAttribute('data-x'))).toBe('1');
  expect(await page.evaluate(() => !!document.querySelector('#__attrs script'))).toBe(false);
});

test('S-057 字符串 attrs：disabled 保留（按钮不可点，Playwright 不点 disabled 元素）', async ({ page }) => {
  await openPage(page);
  await renderButton(page, { label: '测试', attrs: 'onclick="window.__pwned=1" data-x="1" disabled' });
  expect(await page.evaluate(() => document.querySelector('#__attrs button').disabled)).toBe(true);
  expect(await page.evaluate(() => document.querySelector('#__attrs button').getAttribute('onclick'))).toBeNull();
  expect(await page.evaluate(() => document.querySelector('#__attrs button').getAttribute('data-x'))).toBe('1');
});

test('S-057 label 含标签时被转义，不产生真实元素', async ({ page }) => {
  await openPage(page);
  await renderButton(page, { label: '<img src=x onerror="window.__pwned=1">' });
  expect(await page.evaluate(() => !!document.querySelector('#__attrs img'))).toBe(false);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.querySelector('#__attrs button').textContent)).toContain('<img src=x');
});
