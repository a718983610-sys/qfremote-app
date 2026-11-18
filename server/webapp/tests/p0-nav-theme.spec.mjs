// P0 探测＋核验用例（2026-11-17 P0 修复线）。
// P0-1：聊天页 900–959px 导航可达可点；对照 899/960。
// P0-2：三端主题同步（网页端分叉点）。
// 运行：cd server/webapp/tests && npx playwright test p0-nav-theme.spec.mjs
// 证据：tests/p0-fix-20261117/{before,after}/（截图＋本用例输出 JSON 由用例内写盘；
// 不放 test-results/ 下——Playwright 全量运行会清空 test-results）。
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json' };
const STAGE = process.env.P0_STAGE === 'after' ? 'after' : 'before';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'p0-fix-20261117', STAGE);

let server;
let baseURL;

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
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

async function openShell(page, { storedTheme = null, colorScheme = 'light' } = {}) {
  await page.addInitScript(({ storedTheme: st }) => {
    try { localStorage.clear(); } catch (e) {}
    if (st) { try { localStorage.setItem('qf-theme', st); } catch (e) {} }
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test', isAdmin: false }));
  }, { storedTheme });
  await page.emulateMedia({ colorScheme });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
  await page.route('**/chat/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, peers: [], friends: [] }) }));
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.waitForSelector('#acctChip', { state: 'visible' });
}

async function gotoChat(page) {
  await page.goto(baseURL + '/#chat');
  await page.waitForSelector('.chatwrap', { state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
}

// 聊天页导航探测：侧边栏/底部导航/汉堡三路中，至少一路可见且其按键命中自身。
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
    return { hitSelf: !!(t && (t === el || el.contains(t))), hitTag: t ? (t.tagName + '.' + String(t.className && t.className.baseVal === undefined ? t.className : '').split(' ')[0] + '#' + (t.id || '')) : null, cx: Math.round(cx), cy: Math.round(cy) };
  };
  const sideNavs = Array.from(document.querySelectorAll('#sidebar .nav[data-nav]')).map((el) => ({
    nav: el.getAttribute('data-nav'), label: (el.textContent || '').trim().slice(0, 12), rect: r(el), hit: hit(el) }));
  const bnavBtns = Array.from(document.querySelectorAll('#bnav button')).map((el) => ({
    nav: el.getAttribute('data-nav'), rect: r(el), hit: hit(el) }));
  return {
    innerWidth, docScrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth,
    overflowX: document.documentElement.scrollWidth > innerWidth,
    dataTheme: document.documentElement.getAttribute('data-theme'),
    side: r(document.querySelector('#sidebar')),
    drawer: r(document.querySelector('#drawer')),
    bnav: r(document.querySelector('#bnav')),
    burger: r(document.querySelector('#burgerBtn')),
    top: r(document.querySelector('.top')),
    chatwrap: r(document.querySelector('.chatwrap')),
    chatlist: r(document.querySelector('.chatpane-list')),
    thread: r(document.querySelector('.chatpane-thread')),
    sideNavs, bnavBtns,
    sideNavVisible: sideNavs.filter((n) => n.rect && n.rect.inViewport && n.rect.display !== 'none').length,
    sideNavHitSelf: sideNavs.filter((n) => n.hit && n.hit.hitSelf).length,
  };
}`;

const WIDTHS = [899, 900, 920, 940, 959, 960];

test('P0-1 聊天页导航：多视口 × 双主题可达可点', async ({ page }) => {
  test.setTimeout(120000); // 6 视口 × 双主题＋真实点按，串行探测约 25 秒
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openShell(page);
  const rows = [];
  for (const width of WIDTHS) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await gotoChat(page);
      await page.evaluate((t) => applyTheme(t), theme);
      await page.waitForTimeout(250);
      const probe = await page.evaluate(`(${PROBE_FN})()`);
      // 真实点按：点侧边栏「首页」应跳 #home（只在每宽度浅色做一次，免反复切页）。
      let click = null;
      if (theme === 'light') {
        try {
          await page.locator('#sidebar .nav[data-nav="home"]').click({ timeout: 3000 });
          await page.waitForTimeout(300);
          click = { hash: await page.evaluate(() => location.hash), ok: (await page.evaluate(() => location.hash)) === '#home' };
        } catch (e) { click = { ok: false, err: String(e).slice(0, 200) }; }
        await gotoChat(page);
      }
      rows.push({ width, theme, ...probe, click });
      await page.screenshot({ path: path.join(OUT, `p01-chat.${theme}-${width}.png`) });
    }
  }
  fs.writeFileSync(path.join(OUT, 'p01-probe.json'), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows.map(({ width, theme, overflowX, docScrollW, side, sideNavVisible, sideNavHitSelf, bnav, burger, click }) => (
    { width, theme, overflowX, docScrollW, sideDisplay: side && side.display, sideW: side && side.w, sideNavVisible, sideNavHitSelf, bnavDisplay: bnav && bnav.display, burgerDisplay: burger && burger.display, clickOk: click && click.ok })), null, 1));
  // 断言：900–959 每个宽度 × 双主题，侧边栏导航须可见且命中自身；899/960 对照亦然。
  for (const row of rows) {
    expect(row.sideNavVisible, `${row.width}px/${row.theme} 侧边栏可见导航数`).toBeGreaterThan(0);
    expect(row.sideNavHitSelf, `${row.width}px/${row.theme} 侧边栏可命中导航数`).toBe(row.sideNavVisible);
    expect(row.overflowX, `${row.width}px/${row.theme} 横向溢出`).toBe(false);
    if (row.click) expect(row.click.ok, `${row.width}px 点侧边栏首页应跳转`).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('P0-2 主题：无存储偏好时跟随系统；壳手动优先；壳手动时我的页开关只读', async ({ page }) => {
  const out = {};
  // A：无存储偏好，系统深→浅实时跟随。
  await openShell(page, { storedTheme: null, colorScheme: 'dark' });
  out.A_systemDark = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(400);
  out.A_systemLight = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  // B：壳手动深色推送（Android 式 CustomEvent，无 qfLea）须压过本机浅色存储。
  await page.evaluate(() => { try { localStorage.setItem('qf-theme', 'light'); } catch (e) {} });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('qf-theme-state', { detail: { resolved: 'dark', mode: 'dark' } })));
  await page.waitForTimeout(300);
  out.B_shellManualDark_overStoredLight = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  // C：壳手动态下，我的页主题开关须只读（disabled），否则点按无可见变化（分叉）。
  await page.goto(baseURL + '/#profile');
  await page.waitForSelector('#pf-theme-toggle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  out.C_toggleDisabled_underShellManual = await page.evaluate(() => {
    const b = document.getElementById('pf-theme-toggle');
    if (!b) return 'NO_TOGGLE';
    return { disabled: !!b.disabled, ariaDisabled: b.getAttribute('aria-disabled'), noteHidden: (document.getElementById('pf-theme-shell-note') || {}).hidden };
  });
  out.C_dataTheme_still = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  // D：壳手动态下点开关：主题须保持壳值（不闪回本机偏好），开关若可用则为分叉。
  const before = out.C_dataTheme_still;
  const clickRes = await page.evaluate(() => {
    const b = document.getElementById('pf-theme-toggle');
    if (!b || b.disabled) return { clicked: false };
    b.click();
    return { clicked: true };
  });
  await page.waitForTimeout(300);
  out.D_afterToggleClick = { ...clickRes, dataTheme: await page.evaluate(() => document.documentElement.getAttribute('data-theme')), stored: await page.evaluate(() => { try { return localStorage.getItem('qf-theme'); } catch (e) { return null; } }), before };
  // E：壳切回跟随系统（mode=system，系统浅）＋无本机存储时，须回浅色。
  await page.evaluate(() => { try { localStorage.removeItem('qf-theme'); } catch (e) {} });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('qf-theme-state', { detail: { resolved: 'light', mode: 'system' } })));
  await page.waitForTimeout(300);
  out.E_shellSystem_noStored = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  // F：无 mode 的推送（旧 Windows console-preload 'qf-theme-state' 只带 resolved，cb(t,null)；
  // A10 已修新壳不再发，但旧壳／旧值 'blue' 仍须被正确处理）不得把主题闪回本机偏好/系统：
  // 先置壳手动深色，再发 mode 缺失的 resolved=blue（旧值，读兼容为 light）推送。
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('qf-theme-state', { detail: { resolved: 'dark', mode: 'dark' } })));
  await page.waitForTimeout(200);
  const fBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('qf-theme-state', { detail: { resolved: 'blue' } })));
  await page.waitForTimeout(300);
  out.F_modelessPush = { before: fBefore, after: await page.evaluate(() => document.documentElement.getAttribute('data-theme')) };
  fs.writeFileSync(path.join(OUT, 'p02-probe.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1));
  expect(out.A_systemDark).toBe('dark');
  expect(out.A_systemLight).toBe('light');
  expect(out.B_shellManualDark_overStoredLight).toBe('dark');
  expect(out.C_toggleDisabled_underShellManual && out.C_toggleDisabled_underShellManual.disabled).toBe(true);
  expect(out.C_dataTheme_still).toBe('dark');
  expect(out.D_afterToggleClick.dataTheme).toBe('dark');
  expect(out.E_shellSystem_noStored).toBe('light');
  expect(out.F_modelessPush.after).toBe('dark');
});
