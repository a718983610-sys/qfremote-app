// tests/boot-data.spec.mjs — W-04 服务端 boot data 注入 Playwright 验收。
// 真浏览器＋createBootServer（server/webapp/boot-data.mjs）：登录态首屏 HTML
// 一次下发 boot data、字段与客户端消费端对齐、敏感值不在其中、匿名不注入、
// 各页读 store（store 内容来自 boot，不来自 /home/api/stats 的空回包）。
// 运行：cd server/webapp/tests && npx playwright test boot-data.spec.mjs
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBootServer } from '../boot-data.mjs';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 哨兵敏感值：绝不该出现在 HTML 响应与 window.__QF_BOOT__ 里。
const CANARY = {
  apiKey: 'CANARY-APIKEY-9f3a7c',
  token: 'CANARY-TOKEN-51bd02',
  password: 'CANARY-PW-77aa10',
  ticket: 'CANARY-TICKET-0be913',
  sessionToken: 'CANARY-SESSION-44f2c8',
};

// 登录态快照（部署线生产接线：resolveAuth → buildHomeStats → buildStatusView）。
// 故意混入敏感值与多余字段，验白名单清洗。
function fixtureSnapshot() {
  return {
    user: 'test',
    displayName: 'Test User',
    isAdmin: true, // 故意与 seedLogin 缓存（无 isAdmin）不同，验 boot 字段不被缓存回填盖掉
    theme: 'dark',
    license: {
      planName: 'QFRemote 永久套餐', displayStatus: '正常', statusNote: 'ok',
      maskedKey: 'ABCD-****-WXYZ', hasKey: true, webEnabled: true, webBy: 'paid',
      trialExpiresMs: null, keyExpiresMs: 1893456000000, keyPlan: 'permanent',
      keyLifecycle: 'activated', keyDurationHours: null, remainText: '永久有效',
      slots: { pc: 1, mobile: 0, pcUsed: 1, pcMax: 5, mobileUsed: 0, mobileMax: 2 },
      everBanned: false, activeBan: null,
      username: 'test', keyId: 'key_abcdef123456',
      decision: { allow: true, code: 'OK' }, forceLogout: true,
      apiKey: CANARY.apiKey,
    },
    devices: [
      { id: 'node-1', name: 'D1', os: 'Windows 11', group: '办公', online: true, stale: false,
        lastAgentPong: 1763155200000, lastAgentPongAgeMs: 12000, agentConnectedAt: 1763150000000,
        nodeid: 'node//abc', secret: CANARY.token },
      { name: 'D2', os: 'macOS', group: '', online: false },
    ],
    presence: {
      'node-1': { online: true, lastAgentPong: 1763155200000 },
      'node-2': { online: false },
    },
    apiKey: CANARY.apiKey, token: CANARY.token, password: CANARY.password,
    ticket: CANARY.ticket, sessionToken: CANARY.sessionToken,
  };
}

let server;
let baseURL;

test.beforeAll(async () => {
  // 测试用“登录态”判定：请求带 qf-boot-test=1 cookie 即下发快照，否则不注入。
  // 生产对应的是真实会话鉴权（resolveAuth），此处只为隔离测试而用 cookie 开关。
  server = createBootServer({
    webappDir: WEBAPP,
    getSnapshot: async (req) => ((req.headers.cookie || '').includes('qf-boot-test=1') ? fixtureSnapshot() : null),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function stubApi(page, opts) {
  // gateMe：/license/api/me 的响应由调用方放行（确定性地卡在“me 回包到达前”），
  // 避免首屏断言与网络时序竞态；放行后 checkSession 按既有流程覆盖 S.license。
  let releaseMe = () => {};
  if (opts && opts.gateMe) {
    let resolver;
    const gate = new Promise((resolve) => { resolver = resolve; });
    releaseMe = () => resolver();
    page.__meGate = gate;
  }
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
  await page.route('**/license/api/me', async (r) => {
    if (opts && opts.gateMe) await page.__meGate;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'test', hasKey: false, planName: '', displayStatus: '正常' }) });
  });
  // 注意：stats 故意回空设备列表——store 里的设备只能来自 boot data，不能来自这里。
  await page.route('**/home/api/stats', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displayName: 'test', isAdmin: false, devices: [] }) }));
  return { releaseMe };
}
async function seedLogin(page) {
  await page.addInitScript(() => {
    localStorage.setItem('qf-console-cache', JSON.stringify({ user: 'test', displayName: 'test' }));
  });
}

test('W-04 服务端注入：登录后首屏 HTML 一次下发 boot data，无敏感值', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const res = await page.request.get(baseURL + '/', { headers: { cookie: 'qf-boot-test=1' } });
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-store');
  const html = await res.text();
  expect(html.match(/window\.__QF_BOOT__ =/g).length).toBe(1); // 只下发一次
  expect(html).not.toContain('<!-- QF_BOOT_DATA -->'); // 占位已被替换
  for (const c of Object.values(CANARY)) expect(html).not.toContain(c);
  expect(html).not.toContain('key_abcdef123456');
  expect(html).toContain('"user":"test"');
  expect(html).toContain('"theme":"dark"');
  expect(html).toContain('"name":"D1"');
  expect(errors).toEqual([]);
});

test('W-04 服务端注入：匿名不注入，页面走原有流程', async ({ page }) => {
  const res = await page.request.get(baseURL + '/');
  expect(res.status()).toBe(200);
  // 注意：index.html 注释里会提到 __QF_BOOT__ 这个名字，判“未注入”以赋值为准。
  expect(await res.text()).not.toContain('window.__QF_BOOT__ =');
  await stubApi(page);
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  expect(await page.evaluate(() => window.__QF_BOOT__)).toBeUndefined();
  expect(await page.evaluate(() => QFStore.docs.devices.length)).toBe(0);
});

test('W-04 服务端注入：字段与客户端消费端对齐，store 来自 boot 而非 stats', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const docs = [];
  page.on('request', (r) => { if (r.resourceType() === 'document') docs.push(r.url()); });
  await page.context().addCookies([{ name: 'qf-boot-test', value: '1', domain: '127.0.0.1', path: '/' }]);
  // /license/api/me 由门控放行：首屏时刻 S.license 只能来自 boot data（先 paint 后对账），
  // 放行后 checkSession 会用 me 回包覆盖它——两段各断言一次，不混为一谈。
  const api = await stubApi(page, { gateMe: true });
  await seedLogin(page);
  await page.goto(baseURL + '/#home');
  await page.waitForSelector('#view', { state: 'visible' });
  // 首屏壳只发一次 document 请求（boot data 随它来）；第 2 个 document 请求是
  // app 既有的 /console-engine/?hide=31&qfm=warm 预热，与注入无关。
  expect(docs.filter((u) => u === baseURL + '/').length).toBe(1);
  expect(docs.filter((u) => u.includes('__QF_BOOT__') || u.includes('boot-data')).length).toBe(0);
  // 消费端对齐：S 与 QFStore 均由 boot 播种（stats 回的是空设备列表）。
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  expect(await page.evaluate(() => window.__QF_BOOT__.user)).toBe('test');
  expect(await page.evaluate(() => window.__QF_BOOT__.displayName)).toBe('Test User');
  expect(await page.evaluate(() => window.__QF_BOOT__.isAdmin)).toBe(true);
  expect(await page.evaluate(() => window.__QF_BOOT__.license.planName)).toBe('QFRemote 永久套餐');
  expect(await page.evaluate(() => window.__QF_BOOT__.license.keyId)).toBeUndefined();
  expect(await page.evaluate(() => QFStore.docs.devices.length)).toBe(2);
  expect(await page.evaluate(() => QFStore.docs.devices.map((d) => d.name).join(','))).toBe('D1,D2');
  expect(await page.evaluate(() => QFStore.docs.devices[0].online)).toBe(true);
  expect(await page.evaluate(() => QFStore.presence['node-1'].online)).toBe(true);
  expect(await page.evaluate(() => QFStore.presence['node-2'].online)).toBe(false);
  expect(await page.evaluate(() => S.user)).toBe('test');
  // 首屏时刻 S.displayName / S.isAdmin / S.license 就是 boot 下发的快照
  // （me 回包还没到；且缓存回填不再盖掉它们，见 app.js boot() 的 W-04 守卫）。
  expect(await page.evaluate(() => S.displayName)).toBe('Test User');
  expect(await page.evaluate(() => S.isAdmin)).toBe(true);
  expect(await page.evaluate(() => S.license.planName)).toBe('QFRemote 永久套餐');
  // 放行 me 回包后 checkSession 按既有流程覆盖 S.license（planName 变回 ''），
  // 证明 boot 只是首屏快照、登录态判定仍以 /license/api/me 为准。
  api.releaseMe();
  await expect.poll(async () => page.evaluate(() => S.license.planName), { timeout: 5000 }).toBe('');
  const bootJson = await page.evaluate(() => JSON.stringify(window.__QF_BOOT__));
  for (const c of Object.values(CANARY)) expect(bootJson).not.toContain(c);
  expect(bootJson).not.toContain('key_abcdef123456');
  expect(errors).toEqual([]);
});
