// QFRemote 组件画廊视觉验收（W-06/W-07，真浏览器）。
// 运行：cd server/webapp/tests && npx playwright test components.spec.mjs
// 说明：CSF 故事（components/*.stories.mjs）在 Node 侧 import，浏览器侧经
// QFComponents.render 渲染；截图存 tests/test-results/gallery/。Storybook
// dev 服务未跑（重型安装），本画廊为验收手段（见 EVIDENCE-L4.md W-06）。
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as buttonStories from '../components/button.stories.mjs';
import * as emptyStories from '../components/empty-state.stories.mjs';
import * as statStories from '../components/stat-card.stories.mjs';
import * as stripStories from '../components/reconnect-strip.stories.mjs';
import * as shellStories from '../components/app-shell.stories.mjs';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json' };
const GALLERY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test-results', 'gallery');

const STORIES = [
  { component: 'button', name: 'Primary', args: buttonStories.Primary.args },
  { component: 'button', name: 'Grey', args: buttonStories.Grey.args },
  { component: 'button', name: 'GhostSmall', args: buttonStories.GhostSmall.args },
  { component: 'button', name: 'Danger', args: buttonStories.Danger.args },
  { component: 'button', name: 'WithIcon', args: buttonStories.WithIcon.args },
  { component: 'empty-state', name: 'NoDevices', args: emptyStories.NoDevices.args },
  { component: 'empty-state', name: 'NoShared', args: emptyStories.NoShared.args },
  { component: 'stat-card', name: 'Online', args: statStories.Online.args },
  { component: 'stat-card', name: 'Offline', args: statStories.Offline.args },
  { component: 'reconnect-strip', name: 'Attempt2Of5', args: stripStories.Attempt2Of5.args },
  { component: 'reconnect-strip', name: 'Cancelled', args: stripStories.Cancelled.args },
  { component: 'app-shell', name: 'Shell', args: shellStories.Shell.args },
];

let server;
let baseURL;

test.beforeAll(async () => {
  fs.mkdirSync(GALLERY, { recursive: true });
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

async function openGallery(page) {
  await page.addInitScript(() => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test' }));
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate(() => {
    let el = document.getElementById('__gallery');
    if (!el) {
      el = document.createElement('div');
      el.id = '__gallery';
      el.style.padding = '24px';
      document.getElementById('view').appendChild(el);
    }
  });
}
async function renderStory(page, component, args, theme, width) {
  await page.setViewportSize({ width, height: 900 });
  const len = await page.evaluate(({ component, args, theme }) => {
    applyTheme(theme);
    const el = document.getElementById('__gallery');
    el.innerHTML = QFComponents.render(component, args);
    return el.innerHTML.length;
  }, { component, args, theme });
  expect(len).toBeGreaterThan(0);
  await expect(page.locator('#__gallery').first()).toBeVisible();
  return len;
}

for (const story of STORIES) {
  test(`画廊 ${story.component}/${story.name}：1440 浅色＋390 深色`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openGallery(page);
    await renderStory(page, story.component, story.args, 'light', 1440);
    await page.locator('#__gallery').first().screenshot({ path: path.join(GALLERY, `${story.component}-${story.name}.light-1440.png`) });
    await renderStory(page, story.component, story.args, 'dark', 390);
    await page.locator('#__gallery').first().screenshot({ path: path.join(GALLERY, `${story.component}-${story.name}.dark-390.png`) });
    expect(errors).toEqual([]);
  });
}

test('画廊 button/Primary：四视口（390/820/1440/1920）×双主题', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openGallery(page);
  for (const width of [390, 820, 1440, 1920]) {
    for (const theme of ['light', 'dark']) {
      await renderStory(page, 'button', buttonStories.Primary.args, theme, width);
      await page.locator('#__gallery').first().screenshot({ path: path.join(GALLERY, `button-Primary.${theme}-${width}.png`) });
    }
  }
  expect(errors).toEqual([]);
});
