// P0-1 独立聊天页（server/friends/chat/chat.html）导航探测。
// 900–959px：顶部导航 .topnav 与底部页签 .tabbar 至少一路可见可点；对照 899/960。
// 运行：cd server/webapp/tests && npx playwright test p0-chat-standalone.spec.mjs
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHATDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'friends', 'chat');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json' };
const STAGE = process.env.P0_STAGE === 'after' ? 'after' : 'before';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'p0-fix-20261117', STAGE);

let server;
let baseURL;

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url.startsWith('/chat/api/') || url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false })); return;
    }
    let file;
    if (url === '/chat' || url === '/chat/') file = path.join(CHATDIR, 'chat.html');
    else if (url === '/chat/libsodium-sumo.js') file = path.join(CHATDIR, 'node_modules', 'libsodium-sumo', 'dist', 'modules-sumo', 'libsodium-sumo.js');
    else if (url === '/chat/libsodium-wrappers.js') file = path.join(CHATDIR, 'node_modules', 'libsodium-wrappers-sumo', 'dist', 'modules-sumo', 'libsodium-wrappers.js');
    else if (url.startsWith('/chat/')) file = path.join(CHATDIR, url.slice(6));
    else { res.writeHead(404); res.end('not found'); return; }
    if (!file.startsWith(CHATDIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

const PROBE_FN = `() => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      display: cs.display, visibility: cs.visibility,
      inViewport: b.width > 0 && b.height > 0 && b.right > 0 && b.left < innerWidth && b.bottom > 0 && b.top < innerHeight };
  };
  const hit = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return { hitSelf: false, hitTag: null };
    const cx = b.x + Math.min(b.width / 2, b.width - 1), cy = b.y + Math.min(b.height / 2, b.height - 1);
    const t = document.elementFromPoint(cx, cy);
    return { hitSelf: !!(t && (t === el || el.contains(t))), hitTag: t ? (t.tagName + '.' + String(t.className && t.className.baseVal === undefined ? t.className : '').split(' ')[0]) : null };
  };
  const topLinks = Array.from(document.querySelectorAll('.topnav a')).map((el) => ({ text: (el.textContent || '').trim(), rect: r(el), hit: hit(el) }));
  const tabLinks = Array.from(document.querySelectorAll('.tabbar a')).map((el) => ({ text: (el.textContent || '').trim(), rect: r(el), hit: hit(el) }));
  return {
    innerWidth, docScrollW: document.documentElement.scrollWidth,
    overflowX: document.documentElement.scrollWidth > innerWidth,
    bodyClass: document.body.className, bodyDark: document.body.classList.contains('dark'),
    splitHidden: (document.getElementById('splitRoot') || {}).className,
    topnav: r(document.querySelector('.topnav')),
    tabbar: r(document.querySelector('.tabbar')),
    topLinks, tabLinks,
    topVisible: topLinks.filter((l) => l.rect && l.rect.inViewport && l.rect.display !== 'none').length,
    topHitSelf: topLinks.filter((l) => l.hit && l.hit.hitSelf).length,
    tabVisible: tabLinks.filter((l) => l.rect && l.rect.inViewport && l.rect.display !== 'none').length,
    tabHitSelf: tabLinks.filter((l) => l.hit && l.hit.hitSelf).length,
  };
}`;

test('P0-1 独立聊天页导航：多视口 × 双主题', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const rows = [];
  for (const width of [899, 900, 920, 940, 959, 960]) {
    for (const theme of ['light', 'dark']) {
      await page.addInitScript((t) => { try { localStorage.setItem('qf-theme', t); } catch (e) {} }, theme);
      await page.goto(baseURL + '/chat');
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(600);
      // 再测分栏态：强制进入 split（登录态复现需服务端会话，此处仅验证分栏类的导航显隐）。
      const split = await page.evaluate(() => {
        try {
          document.getElementById('splitRoot').classList.remove('hidden');
          if (typeof syncSplit === 'function') syncSplit();
          return { forced: true, bodyClass: document.body.className };
        } catch (e) { return { forced: false, err: String(e).slice(0, 160) }; }
      });
      await page.waitForTimeout(200);
      const probe = await page.evaluate(`(${PROBE_FN})()`);
      rows.push({ width, theme, split, ...probe });
      await page.screenshot({ path: path.join(OUT, `p01-standalone.${theme}-${width}.png`) });
    }
  }
  fs.writeFileSync(path.join(OUT, 'p01-standalone-probe.json'), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows.map(({ width, theme, overflowX, bodyClass, topVisible, topHitSelf, tabVisible, tabHitSelf }) => (
    { width, theme, overflowX, bodyClass, topVisible, topHitSelf, tabVisible, tabHitSelf })), null, 1));
  for (const row of rows) {
    const anyVisible = row.topVisible + row.tabVisible;
    expect(anyVisible, `${row.width}px/${row.theme} 至少一路导航可见`).toBeGreaterThan(0);
    expect(row.topHitSelf + row.tabHitSelf, `${row.width}px/${row.theme} 可命中导航数`).toBe(anyVisible);
    expect(row.overflowX, `${row.width}px/${row.theme} 横向溢出`).toBe(false);
  }
  expect(errors).toEqual([]);
});
