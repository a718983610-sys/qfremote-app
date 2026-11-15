// W-01 基线/复核：抓双主题下关键元素的计算样式（颜色类属性＋自定义属性值）。
// 用法：node theme-baseline.mjs <out.json> [light|dark|both]
// 在改 CSS 前后各跑一次，diff 必须为空（除有意改动外）。
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const OUT = process.argv[2] || '/tmp/qf-l4-tools/theme-baseline.json';
const THEMES = process.argv[3] === 'light' ? ['light'] : process.argv[3] === 'dark' ? ['dark'] : ['light', 'dark'];

const FIXTURE = `
<div id="qf-theme-fixture" style="position:absolute;left:-9999px;top:0">
  <div class="side"><div class="brand"></div></div>
  <div class="top"></div>
  <nav class="bnav"><button>首</button><button class="on">设</button></nav>
  <div class="drawer"></div><div class="dscrim"></div>
  <div class="acctmenu open"><a href="#">x</a></div>
  <div class="card"></div>
  <button class="btn">按</button><button class="btn black">黑</button><button class="btn ghost">描</button>
  <button class="btn grey">灰</button><button class="btn danger">险</button><button class="btn" disabled>禁</button>
  <button class="qf-switch" aria-checked="true"></button><button class="qf-switch" aria-checked="false"></button>
  <div class="tabs"><button>页</button><button class="on">页</button></div>
  <div class="msg"><div class="bub">hi</div><small>10:00</small></div>
  <div class="msg me"><div class="bub">hi</div><small>10:00</small></div>
  <span class="cht-badge">3</span><span class="tag">标</span>
  <span class="pill ok">好</span><span class="pill warn">警</span><span class="pill err">错</span>
  <span class="pill brand">牌</span><span class="pill off">关</span>
  <div class="uava">我</div>
  <div class="viewer"><div class="vbar">栏</div><iframe></iframe><span class="kbd">K</span>
    <button class="sv-iconbtn" data-act="disconnect">断</button>
    <button class="sv-btn--danger">险</button>
    <div class="sv-wall"></div><div class="sv-wall__tag">墙</div>
    <button class="sv-seg__btn" aria-selected="true">段</button>
    <button class="sv-iconbtn--brand">品</button>
    <div class="sv-opt" aria-checked="true"><span class="sv-opt__ic">选</span></div>
  </div>
  <div class="step"><b>1</b><b class="on">2</b></div>
  <div class="plan">套</div><div class="paycard">卡</div><div class="framebox">框</div>
  <div class="planitem">项</div><div class="kfrow">行</div>
  <div class="paytab">付</div><div class="paytab on">付</div>
  <span class="fr-bdg">2</span><span class="fr-cnt">2</span>
  <div class="cht-av">头</div><div class="cht-av sys">系</div><div class="cht-av av1">一</div>
  <div class="cht-msg me"><div class="cht-bub">气泡</div></div>
  <div class="cht-msg"><div class="cht-bub">气泡</div></div>
  <div class="cht-comp"><textarea>草</textarea></div>
  <div class="field"><input value="x"><div class="ferr">错</div></div>
  <div class="auth"><div class="authlinks"><a href="#">链</a></div></div>
  <a class="txtlink" href="#">链</a><a class="boot-link" href="#">链</a><span class="cht-recall">撤</span>
  <span class="pf-off">关</span><span class="pf-t-pend">审</span><span class="pf-t-rej">拒</span>
  <a class="nav nav-danger" href="#">险<span class="logout-icon">出</span></a>
  <div class="search"><input placeholder="搜"></div>
  <div class="row"><span class="chev">›</span></div>
  <div class="skel"></div>
</div>`;

const SELECTORS = [
  'body', '.side', '.top', '.bnav', '.bnav button', '.bnav button.on', '.drawer', '.dscrim',
  '.acctmenu', '.card', '.btn', '.btn.black', '.btn.ghost', '.btn.grey', '.btn.danger', '.btn:disabled',
  '.qf-switch', '.qf-switch::after', '.qf-switch[aria-checked="true"]', '.qf-switch[aria-checked="true"]::after',
  '.tabs button', '.tabs button.on', '.msg .bub', '.msg.me .bub', '.msg small', '.msg.me small',
  '.cht-badge', '.tag', '.pill.ok', '.pill.warn', '.pill.err', '.pill.brand', '.pill.off',
  '.uava', '.viewer', '.viewer .vbar', '.viewer iframe', '.kbd',
  '.viewer .sv-iconbtn[data-act="disconnect"]', '.viewer .sv-btn--danger',
  '.sv-wall', '.sv-wall__tag', '.sv-seg__btn[aria-selected="true"]',
  '.sv-iconbtn--brand', '.sv-opt[aria-checked="true"] .sv-opt__ic',
  '.step b', '.step b.on', '.plan', '.paycard', '.framebox', '.planitem', '.kfrow',
  '.paytab', '.paytab.on', '.fr-bdg', '.fr-cnt',
  '.cht-av', '.cht-av.sys', '.cht-av.av1', '.cht-msg.me .cht-bub', '.cht-msg .cht-bub',
  '.cht-comp textarea', '.field input', '.field .ferr::before',
  '.auth', '.authlinks a', '.txtlink', '.boot-link', '.cht-recall',
  '.pf-off', '.pf-t-pend', '.pf-t-rej', '.nav.nav-danger', '.nav.nav-danger .logout-icon',
  '.search input::placeholder', '.row .chev', '.skel', '.side .brand::after',
];
const PROPS = ['color', 'backgroundColor', 'borderColor', 'borderTopColor', 'outlineColor', 'boxShadow', 'textDecorationColor', 'caretColor'];
const CUSTOM_PROPS = ['--amber-txt', '--green-txt', '--red-txt', '--canvas-0', '--canvas-1', '--canvas-2',
  '--on-brand', '--on-danger', '--danger-solid', '--paper', '--auth-bg', '--bub-bg', '--me-meta',
  '--line-on-brand', '--av-sys-bg', '--sv-canvas', '--sv-bar-bg', '--sv-bar-fg', '--scrim',
  '--drawer-shadow', '--drawer-shadow-desk', '--focus-ring', '--disconnect-fg', '--disconnect-bg',
  '--alert-bg', '--link', '--chrome-bg', '--bnav-bg', '--wall-glow-1', '--wall-glow-2', '--wall-glow-3',
  '--wall-grid', '--mask-black', '--glass-10', '--glass-16', '--glass-08', '--mark-bg', '--mark-fg', '--seg-sel-fg'];

async function capture(page, theme) {
  return page.evaluate(({ sels, props, customs }) => {
    const out = {};
    const splitSel = (s) => {
      const m = s.match(/^(.*)::(after|before|placeholder)$/);
      return m ? [m[1], m[2]] : [s, null];
    };
    for (const s of sels) {
      const [base, pseudo] = splitSel(s);
      // W-01：只在 fixture 内查——app 自身 DOM 里也有 .top/.bnav 等同名元素，
      // document 全局查询会抓到 app 元素（还受 app 动态状态影响），基线不可复现。
      const el = base === 'body' ? document.body : document.getElementById('qf-theme-fixture').querySelector(base);
      if (!el) { out[s] = null; continue; }
      const cs = getComputedStyle(el, pseudo ? `::${pseudo}` : null);
      const rec = {};
      for (const p of props) { const v = cs[p]; if (v && v !== 'none' && v !== 'rgba(0, 0, 0, 0)' && v !== 'rgb(0, 0, 0)') rec[p] = v; }
      if (Object.keys(rec).length) out[s] = rec;
    }
    const root = getComputedStyle(document.documentElement);
    out[':root-custom-props'] = {};
    for (const c of customs) { const v = root.getPropertyValue(c).trim(); if (v) out[':root-custom-props'][c] = v; }
    const viewer = document.getElementById('qf-theme-fixture').querySelector('.viewer');
    if (viewer) {
      const vs = getComputedStyle(viewer);
      out['.viewer-custom-props'] = {};
      for (const c of customs) { const v = vs.getPropertyValue(c).trim(); if (v) out['.viewer-custom-props'][c] = v; }
    }
    return out;
  }, { sels: SELECTORS, props: PROPS, customs: CUSTOM_PROPS });
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(WEBAPP, url === '/' ? 'index.html' : url);
  if (!file.startsWith(WEBAPP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const result = {};
for (const theme of THEMES) {
  const page = await browser.newPage({ colorScheme: theme });
  await page.addInitScript((t) => localStorage.setItem('qf-theme', t), theme);
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) }));
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
  await page.addInitScript(() => localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test' })));
  await page.goto(base + '/?t=base#home');
  await page.waitForSelector('#view', { state: 'visible' });
  await page.evaluate((fx) => { document.body.insertAdjacentHTML('beforeend', fx); }, FIXTURE);
  await page.waitForTimeout(300);
  result[theme] = await capture(page, theme);
  await page.close();
}
await browser.close();
server.close();
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
const n = Object.values(result).reduce((a, t) => a + Object.keys(t).length, 0);
console.log(`wrote ${OUT} (${n} selector records across ${THEMES.join(',')})`);
