// tests/unit/boot-data.test.mjs — W-04 服务端 boot data 注入单测。
// 覆盖：白名单清洗、敏感值剔除、安全序列化、渲染、处理器、与真实客户端
// 消费端 qfApplyBootData 的对齐。跑在 tests/run.mjs 门禁内（node --test）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QF_BOOT_VERSION, QF_BOOT_PLACEHOLDER,
  qfBuildBootData, qfBootDataHasSensitive, qfBootDataJson, qfBootDataScript,
  qfRenderIndexHtml, qfIsIndexPath, createBootDataHandler, createBootServer,
} from '../../boot-data.mjs';
import { loadWebapp } from './load-webapp.mjs';

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = '<!doctype html><html><head><title>T</title><!-- QF_BOOT_DATA --></head><body>x</body></html>';

// 哨兵敏感值：生产快照里绝不该出现的串，断言它们永不进 boot data 与 HTML。
const CANARY = {
  apiKey: 'CANARY-APIKEY-9f3a7c',
  token: 'CANARY-TOKEN-51bd02',
  password: 'CANARY-PW-77aa10',
  ticket: 'CANARY-TICKET-0be913',
  sessionToken: 'CANARY-SESSION-44f2c8',
  leaKey: 'CANARY-LEAKEY-k_abcdefghij',
};

function fixtureSnapshot() {
  return {
    user: 'test',
    displayName: 'Test User',
    isAdmin: false,
    theme: 'dark',
    license: {
      planName: 'QFRemote 永久套餐', displayStatus: '正常', statusNote: 'ok',
      maskedKey: 'ABCD-****-WXYZ', hasKey: true, webEnabled: true, webBy: 'paid',
      trialExpiresMs: null, keyExpiresMs: 1893456000000, keyPlan: 'permanent',
      keyLifecycle: 'activated', keyDurationHours: null, remainText: '永久有效',
      slots: { pc: 1, mobile: 0, pcUsed: 1, pcMax: 5, mobileUsed: 0, mobileMax: 2, extra: 9 },
      everBanned: false,
      activeBan: null,
      // 以下即使上游误传也必须丢弃：
      username: 'test', keyId: 'key_abcdef123456', keyCreatedAt: 1700000000000,
      keySource: 'paid', decision: { allow: true, code: 'OK' }, forceLogout: true,
      apiKey: CANARY.apiKey,
    },
    devices: [
      { id: 'node-1', name: 'D1', os: 'Windows 11', group: '办公', online: true, stale: false,
        lastAgentPong: 1763155200000, lastAgentPongAgeMs: 12000, agentConnectedAt: 1763150000000,
        nodeid: 'node//abc', onlineUnknown: false, host: '10.0.0.9', ip: '10.0.0.9', secret: CANARY.token },
      { name: 'D2', os: 'macOS', group: '', online: false },
      { os: 'Linux' }, // 无名，丢弃
    ],
    presence: {
      'node-1': { online: true, lastAgentPong: 1763155200000, nested: { x: 1 }, list: [1] },
      'node-2': { online: false },
      bad: 'not-an-object',
    },
    // 顶层敏感值全部丢弃：
    apiKey: CANARY.apiKey, token: CANARY.token, password: CANARY.password,
    ticket: CANARY.ticket, sessionToken: CANARY.sessionToken, leaKey: CANARY.leaKey,
    api_key: CANARY.apiKey, secret: CANARY.token,
  };
}

test('build：白名单字段逐项保留，其余丢弃', () => {
  const boot = qfBuildBootData(fixtureSnapshot());
  assert.equal(boot.v, QF_BOOT_VERSION);
  assert.equal(boot.user, 'test');
  assert.equal(boot.displayName, 'Test User');
  assert.equal(boot.isAdmin, false);
  assert.equal(boot.theme, 'dark');
  assert.equal(boot.license.planName, 'QFRemote 永久套餐');
  assert.equal(boot.license.displayStatus, '正常');
  assert.equal(boot.license.maskedKey, 'ABCD-****-WXYZ');
  assert.equal(boot.license.hasKey, true);
  assert.equal(boot.license.webBy, 'paid');
  assert.equal(boot.license.keyExpiresMs, 1893456000000);
  assert.equal(boot.license.slots.pcMax, 5);
  assert.equal(boot.license.slots.extra, undefined);
  assert.equal(boot.license.activeBan, undefined);
  assert.equal(boot.devices.length, 2);
  assert.equal(boot.devices[0].name, 'D1');
  assert.equal(boot.devices[0].id, 'node-1');
  assert.equal(boot.devices[0].nodeid, 'node//abc');
  assert.equal(boot.devices[0].host, undefined);
  assert.equal(boot.devices[0].ip, undefined);
  assert.equal(boot.devices[1].name, 'D2');
  assert.equal(boot.presence['node-1'].online, true);
  assert.equal(boot.presence['node-1'].nested, undefined);
  assert.equal(boot.presence['node-1'].list, undefined);
  assert.equal(boot.presence['node-2'].online, false);
  assert.equal(boot.presence.bad, undefined);
  // 顶层键集合与客户端消费端一致（v 除外，消费端忽略）。
  assert.deepEqual(
    Object.keys(boot).sort(),
    ['devices', 'displayName', 'isAdmin', 'license', 'presence', 'theme', 'user', 'v'],
  );
});

test('build：敏感哨兵值永不进 boot data', () => {
  const boot = qfBuildBootData(fixtureSnapshot());
  const flat = JSON.stringify(boot);
  for (const c of Object.values(CANARY)) assert.ok(!flat.includes(c), '哨兵值泄露：' + c);
  assert.equal(boot.apiKey, undefined);
  assert.equal(boot.token, undefined);
  assert.equal(boot.password, undefined);
  assert.equal(boot.ticket, undefined);
  assert.equal(boot.sessionToken, undefined);
  assert.equal(boot.license.apiKey, undefined);
  assert.equal(boot.license.decision, undefined);
  assert.equal(boot.license.forceLogout, undefined);
  assert.equal(boot.license.keyId, undefined);
  assert.equal(boot.license.username, undefined);
  assert.deepEqual(qfBootDataHasSensitive(boot), []);
});

test('build：非法输入返回 null；只有主题不注入', () => {
  assert.equal(qfBuildBootData(null), null);
  assert.equal(qfBuildBootData('x'), null);
  assert.equal(qfBuildBootData({}), null);
  assert.equal(qfBuildBootData({ theme: 'dark' }), null);
  assert.equal(qfBuildBootData({ user: '  ' }), null);
  assert.notEqual(qfBuildBootData({ user: 'u' }), null);
  assert.notEqual(qfBuildBootData({ devices: [{ name: 'D' }] }), null);
});

test('build：theme 只认 dark/light；devices/presence 非法即丢；上限截断', () => {
  assert.equal(qfBuildBootData({ user: 'u', theme: 'blue' }).theme, undefined);
  assert.equal(qfBuildBootData({ user: 'u', theme: 123 }).theme, undefined);
  assert.equal(qfBuildBootData({ user: 'u', theme: 'light' }).theme, 'light');
  assert.equal(qfBuildBootData({ user: 'u', devices: 'nope' }).devices, undefined);
  assert.equal(qfBuildBootData({ user: 'u', presence: [] }).presence, undefined);
  assert.equal(qfBuildBootData({ user: 'u', isAdmin: 'yes' }).isAdmin, undefined);
  const many = { user: 'u', devices: Array.from({ length: 501 }, (_, i) => ({ name: 'D' + i })) };
  assert.equal(qfBuildBootData(many).devices.length, 500);
  const manyP = { user: 'u', presence: {} };
  for (let i = 0; i < 501; i++) manyP.presence['k' + i] = { online: true };
  assert.equal(Object.keys(qfBuildBootData(manyP).presence).length, 500);
  // 与上游快照脱钩：改上游不影响已建 boot。
  const snap = { user: 'u', devices: [{ name: 'D' }] };
  const boot = qfBuildBootData(snap);
  snap.devices[0].name = 'MUTATED';
  assert.equal(boot.devices[0].name, 'D');
});

test('自检：敏感键名被扫出，maskedKey 豁免', () => {
  assert.deepEqual(qfBootDataHasSensitive({ apiKey: 'x' }), ['apiKey']);
  assert.deepEqual(qfBootDataHasSensitive({ devices: [{ token: 'x' }] }), ['devices[0].token']);
  assert.deepEqual(qfBootDataHasSensitive({ license: { maskedKey: 'AB****CD' } }), []);
  assert.deepEqual(qfBootDataHasSensitive({ v: 1, user: 'u' }), []);
});

test('序列化：</script> 逃逸与特殊字符', () => {
  const evil = 'x</script><script>alert(1)</script><b>&a\u2028b\u2029c';
  const boot = qfBuildBootData({ user: 'u', displayName: evil });
  const script = qfBootDataScript(boot);
  // 全串只剩结尾一个字面 </script>（注入脚本自身的闭合标签）。
  assert.equal(script.match(/<\/script>/g).length, 1);
  assert.ok(script.startsWith('<script>window.__QF_BOOT__ = '));
  assert.ok(!script.includes('</script><script>'));
  const payload = script.slice('<script>window.__QF_BOOT__ = '.length, -'</script>'.length - 1);
  assert.equal(JSON.parse(payload).displayName, evil);
  assert.ok(!qfBootDataJson(boot).includes('<'));
});

test('渲染：占位替换一次；无占位退到 </head>；无 boot 原样返回', () => {
  const boot = qfBuildBootData(fixtureSnapshot());
  const out = qfRenderIndexHtml(TEMPLATE, boot);
  assert.equal(out.match(/window\.__QF_BOOT__ =/g).length, 1);
  assert.ok(!out.includes(QF_BOOT_PLACEHOLDER));
  assert.ok(out.indexOf('window.__QF_BOOT__') < out.indexOf('</head>'));
  const twice = qfRenderIndexHtml(TEMPLATE + QF_BOOT_PLACEHOLDER, boot);
  assert.equal(twice.match(/window\.__QF_BOOT__ =/g).length, 1);
  assert.ok(twice.endsWith(QF_BOOT_PLACEHOLDER));
  const noPh = qfRenderIndexHtml('<html><head></head><body></body></html>', boot);
  assert.ok(noPh.indexOf('window.__QF_BOOT__') < noPh.indexOf('</head>'));
  const noHead = qfRenderIndexHtml('<html><body><script src="a.js"></script></body></html>', boot);
  assert.ok(noHead.indexOf('window.__QF_BOOT__') < noHead.indexOf('<script src='));
  assert.equal(qfRenderIndexHtml(TEMPLATE, null), TEMPLATE);
  assert.equal(qfRenderIndexHtml(TEMPLATE, 'x'), TEMPLATE);
  assert.ok(qfIsIndexPath('/'));
  assert.ok(qfIsIndexPath('/index.html'));
  assert.ok(!qfIsIndexPath('/app.js'));
  assert.ok(!qfIsIndexPath('/api/x'));
});

function fakeReq(url, method, headers) {
  return { url, method: method || 'GET', headers: headers || {} };
}
function fakeRes() {
  const r = { status: null, headers: null, body: null,
    writeHead(s, h) { r.status = s; r.headers = h; },
    end(b) { r.body = b; } };
  return r;
}

test('处理器：登录态注入一次＋no-store；匿名原样；非 index 不接管', async () => {
  const handler = createBootDataHandler({
    getSnapshot: async (req) => ((req.headers.cookie || '').includes('qf-boot-test=1') ? fixtureSnapshot() : null),
    readTemplate: () => TEMPLATE,
  });
  const res1 = fakeRes();
  assert.equal(await handler(fakeReq('/', 'GET', { cookie: 'qf-boot-test=1' }), res1), true);
  assert.equal(res1.status, 200);
  assert.equal(res1.headers['cache-control'], 'no-store');
  assert.equal(res1.headers.vary, 'Cookie');
  assert.equal(res1.body.match(/window\.__QF_BOOT__ =/g).length, 1);
  for (const c of Object.values(CANARY)) assert.ok(!res1.body.includes(c), '哨兵值进 HTML：' + c);
  const res2 = fakeRes();
  assert.equal(await handler(fakeReq('/', 'GET', {}), res2), true);
  assert.equal(res2.body, TEMPLATE); // 匿名不注入，字节一致
  const res3 = fakeRes();
  assert.equal(await handler(fakeReq('/app.js', 'GET', {}), res3), false);
  const res4 = fakeRes();
  assert.equal(await handler(fakeReq('/', 'POST', { cookie: 'qf-boot-test=1' }), res4), false);
});

test('处理器：快照获取抛错时 fail-closed 出静态页', async () => {
  const errors = [];
  const handler = createBootDataHandler({
    getSnapshot: async () => { throw new Error('auth down'); },
    readTemplate: () => TEMPLATE,
    onError: (e) => errors.push(String(e)),
  });
  const res = fakeRes();
  assert.equal(await handler(fakeReq('/', 'GET', {}), res), true);
  assert.equal(res.status, 200);
  assert.equal(res.body, TEMPLATE);
  assert.equal(errors.length, 1);
});

test('参考服务器：注入页＋静态文件＋404', async () => {
  const server = createBootServer({
    webappDir: WEBAPP,
    getSnapshot: async (req) => ((req.headers.cookie || '').includes('qf-boot-test=1') ? fixtureSnapshot() : null),
    readTemplate: () => TEMPLATE,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const withCookie = await (await fetch(base + '/', { headers: { cookie: 'qf-boot-test=1' } })).text();
    assert.equal(withCookie.match(/window\.__QF_BOOT__ =/g).length, 1);
    for (const c of Object.values(CANARY)) assert.ok(!withCookie.includes(c));
    const anon = await (await fetch(base + '/')).text();
    assert.ok(!anon.includes('__QF_BOOT__'));
    const doc = await fetch(base + '/BOOT-DATA.md');
    assert.equal(doc.status, 200);
    assert.ok((await doc.text()).includes('W-04'));
    assert.equal((await fetch(base + '/no-such-file')).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('对齐真实消费端：内置 boot 经 qfApplyBootData 播种 store 与 S', () => {
  const boot = qfBuildBootData(fixtureSnapshot());
  const sb = loadWebapp();
  sb.__QF_BOOT__ = boot;
  const ret = sb.__qf.qfApplyBootData();
  assert.equal(ret, boot);
  assert.equal(sb.__qf.S.user, 'test');
  assert.equal(sb.__qf.S.displayName, 'Test User');
  assert.equal(sb.__qf.S.isAdmin, false);
  assert.equal(sb.__qf.S.license.planName, 'QFRemote 永久套餐');
  assert.equal(sb.__qf.S.license.keyId, undefined);
  assert.equal(sb.__qf.QFStore.docs.devices.length, 2);
  assert.equal(sb.__qf.QFStore.docs.devices[0].name, 'D1');
  assert.equal(sb.__qf.QFStore.docs.devices[1].name, 'D2');
  assert.equal(sb.__qf.QFStore.presence['node-1'].online, true);
  assert.equal(sb.__qf.QFStore.presence['node-2'].online, false);
  // S.auth 不动：登录态仍由 checkSession 校验（消费端原有语义）。
  assert.equal(sb.__qf.S.auth, 'unknown');
});
