// QFRemote 无障碍门（W-07，真浏览器 axe-core）。
// 运行：cd server/webapp/tests && npx playwright test axe.spec.mjs
// axe-core 已装进 tests/node_modules/axe-core（npm install --no-save）。
// 断言：登录页与壳首页 0 个 critical/serious 违规。
// WAVE 需 API key/浏览器扩展，无法在沙箱跑——发版门人工项，见 EVIDENCE-L4.md W-07。
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AXE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
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

async function runAxe(page) {
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(() => axe.run(document, { resultTypes: ['violations'] }));
  const bad = res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  const summary = res.violations.map((v) => `${v.id}(${v.impact}): ${v.nodes.length} 节点`);
  return { bad, summary, total: res.violations.length };
}

test('axe 登录页：0 个 critical/serious 违规', async ({ page }) => {
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.goto(baseURL + '/');
  await page.waitForSelector('#authRoot:not([hidden])', { timeout: 10000 });
  const { bad, summary, total } = await runAxe(page);
  console.log('登录页 axe 违规：', JSON.stringify(summary), '合计', total);
  expect(bad).toEqual([]);
});

test('axe 壳首页（#home，浅色）：0 个 critical/serious 违规', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test', isAdmin: false }));
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  const { bad, summary, total } = await runAxe(page);
  console.log('壳首页 axe 违规：', JSON.stringify(summary), '合计', total);
  expect(bad).toEqual([]);
});
