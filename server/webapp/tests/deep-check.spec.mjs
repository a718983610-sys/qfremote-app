// QFRemote 20 条深查清单运行时用例（W-07，真浏览器）。
// 运行：cd server/webapp/tests && npx playwright test deep-check.spec.mjs
// 覆盖的可运行时验证项（清单来源：evidence-r13-verify-20261112/r13-retest/
// drawer-miss-investigation-20261113/REPORT.md §五，编号 DC-01～DC-16）：
// DC-03 四视口×双主题、DC-04 交互态全覆盖、DC-05 数项数、DC-06 颜色对比、
// DC-10 抽屉与头像菜单分开点名。DC-01/02/11/12/13/14/15/16 属流程项，映射到
// lint＋单测＋证据文件，不进运行时用例（见 EVIDENCE-L4.md W-07）。
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json' };
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test-results', 'deep-check');

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

async function openShell(page, isAdmin) {
  await page.addInitScript((admin) => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test', isAdmin: !!admin }));
  }, isAdmin);
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: !!isAdmin, devices: [] }) }));
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.waitForSelector('#acctChip', { state: 'visible' });
}

// DC-06 对比度：页面内算相对亮度＋对比度（WCAG 公式），文本色 vs 有效背景色。
const CONTRAST_FN = `() => {
  const lum = (r, g, b) => {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (s) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  // 有效背景：自下而上逐层 alpha 合成（半透明层须与下层混合，不得当不透明取）
  const effBg = (el) => {
    let acc = null;
    let n = el;
    while (n) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0) {
        if (!acc) acc = { r: bg.r, g: bg.g, b: bg.b, a: bg.a };
        else {
          const a = bg.a + acc.a * (1 - bg.a);
          acc = { r: (bg.r * bg.a + acc.r * acc.a * (1 - bg.a)) / a, g: (bg.g * bg.a + acc.g * acc.a * (1 - bg.a)) / a, b: (bg.b * bg.a + acc.b * acc.a * (1 - bg.a)) / a, a };
        }
        if (acc.a >= 0.999) break;
      }
      n = n.parentElement;
    }
    if (!acc) return { r: 255, g: 255, b: 255, a: 1 };
    if (acc.a < 1) { // 顶层仍半透明：与白底合成
      return { r: acc.r * acc.a + 255 * (1 - acc.a), g: acc.g * acc.a + 255 * (1 - acc.a), b: acc.b * acc.a + 255 * (1 - acc.a), a: 1 };
    }
    return acc;
  };
  const check = (root) => {
    const bad = [];
    let n = 0, min = 99, minEl = '';
    root.querySelectorAll('*').forEach((el) => {
      const txt = (el.childNodes.length && Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.textContent.trim())) ? el.textContent.trim() : '';
      if (!txt) return;
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg) return;
      const bg = effBg(el);
      const l1 = lum(fg.r, fg.g, fg.b), l2 = lum(bg.r, bg.g, bg.b);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      n++;
      if (ratio < min) { min = ratio; minEl = el.tagName + '.' + (el.className && el.className.baseVal === undefined ? String(el.className).split(' ')[0] : '') + ' "' + txt.slice(0, 20) + '"'; }
      if (ratio < 3.0) bad.push({ el: el.tagName + ' "' + txt.slice(0, 30) + '"', ratio: Math.round(ratio * 100) / 100 });
    });
    return { checked: n, min: Math.round(min * 100) / 100, minEl, bad };
  };
  return { check };
}`;

test('DC-03 四视口×双主题加载无报错', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openShell(page, false);
  for (const width of [390, 820, 1440, 1920]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => applyTheme(t), theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `dc03-home.${theme}-${width}.png`) });
    }
  }
  expect(errors).toEqual([]);
});

test('DC-04 交互态全覆盖：头像菜单、抽屉、底部导航、弹窗、遮罩逐个打开截图', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openShell(page, false);
  await page.setViewportSize({ width: 1440, height: 900 });
  // 头像菜单
  await page.locator('#acctChip').click();
  await expect(page.locator('#acctMenu')).toHaveClass(/open/);
  await page.screenshot({ path: path.join(OUT, 'dc04-acctmenu.png') });
  await page.keyboard.press('Escape');
  // 抽屉＋遮罩（汉堡只在 ≤760px 可见，见 app.css @media(max-width:760px)）
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.locator('#burgerBtn').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect(page.locator('#drawerScrim')).toHaveClass(/on/);
  await page.screenshot({ path: path.join(OUT, 'dc04-drawer.png') });
  // 遮罩点须落在抽屉外：390 宽下抽屉约 320px，点右缘 (380,400)
  await page.locator('#drawerScrim').click({ position: { x: 380, y: 400 } });
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  await page.keyboard.press('Escape');
  // 弹窗（modalRoot）
  await page.evaluate(() => showModal('深查测试', '<p>测试弹窗内容</p>', [{ label: '知道了' }]));
  await expect(page.locator('#modalRoot .modal')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'dc04-modal.png') });
  await page.keyboard.press('Escape');
  // 底部导航（390 视口，.bnav 只在 ≤760px 显示）
  await expect(page.locator('#bnav')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'dc04-bnav-390.png') });
  expect(errors).toEqual([]);
});

test('DC-05 数项数：非管理员账号菜单 8 项、抽屉 13 项，逐项列出', async ({ page }) => {
  await openShell(page, false);
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('#acctMenu a')).map((a) => a.textContent.trim()));
  expect(menu).toEqual(['首页', '我的账户', '我的文件', '好友', '论坛', 'API 密钥', '官方网站', '登出']);
  const drawer = await page.evaluate(() => Array.from(document.querySelectorAll('#drawer [data-nav]')).map((el) => el.getAttribute('data-nav')));
  // profile＋MENU34 6 项＋FUNC 5 项＋登出＝13（此前计划写 12 有误，实测为准）
  expect(drawer).toEqual(['profile', 'home', 'profile', 'files', 'friends', 'forum', 'apikeys', 'devices', 'chat', 'support', 'purchase', 'points', 'logout']);
  expect(drawer.length).toBe(13);
});

test('DC-05 管理员：账号菜单 9 项（多站长管理）、抽屉 14 项', async ({ page }) => {
  await openShell(page, true);
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('#acctMenu a')).map((a) => a.textContent.trim()));
  expect(menu.length).toBe(9);
  expect(menu).toContain('站长管理');
  const drawer = await page.evaluate(() => Array.from(document.querySelectorAll('#drawer [data-nav]')).map((el) => el.getAttribute('data-nav')));
  expect(drawer.length).toBe(14);
  expect(drawer).toContain('admin');
});

test('DC-06 颜色对比：打开态菜单/抽屉内每个文本元素对比度 ≥3.0', async ({ page }) => {
  await openShell(page, false);
  await page.setViewportSize({ width: 1440, height: 900 });
  const menuRes = await page.evaluate((fnSrc) => {
    const lib = eval('(' + fnSrc + ')()');
    document.querySelector('#acctChip').click();
    return lib.check(document.querySelector('#acctMenu'));
  }, CONTRAST_FN);
  expect(menuRes.checked).toBeGreaterThan(0);
  expect(menuRes.bad).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const drawerRes = await page.evaluate((fnSrc) => {
    const lib = eval('(' + fnSrc + ')()');
    document.querySelector('#burgerBtn').click();
    return lib.check(document.querySelector('#drawer'));
  }, CONTRAST_FN);
  expect(drawerRes.checked).toBeGreaterThan(0);
  expect(drawerRes.bad).toEqual([]);
  // 双主题各跑一次（深色）
  await page.evaluate(() => applyTheme('dark'));
  await page.waitForTimeout(300);
  const darkRes = await page.evaluate((fnSrc) => {
    const lib = eval('(' + fnSrc + ')()');
    return lib.check(document.querySelector('#drawer'));
  }, CONTRAST_FN);
  expect(darkRes.bad).toEqual([]);
});

test('DC-10 抽屉与头像菜单分开点名：两者独立开关、互不干扰', async ({ page }) => {
  await openShell(page, false);
  // 抽屉只在 ≤760px 可开（汉堡按钮桌面隐藏），本测试全程 390 视口
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  // 只开抽屉：头像菜单须保持关闭
  await page.locator('#burgerBtn').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  expect(await page.evaluate(() => document.querySelector('#acctMenu').classList.contains('open'))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  // 只开头像菜单：抽屉须保持关闭
  await page.locator('#acctChip').click();
  await expect(page.locator('#acctMenu')).toHaveClass(/open/);
  expect(await page.evaluate(() => document.querySelector('#drawer').classList.contains('open'))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('#acctMenu')).not.toHaveClass(/open/);
});
