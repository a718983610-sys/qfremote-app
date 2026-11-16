'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createProductionBootHandler } = require('./webapp-boot');

test('M-031 production adapter authenticates before seeding, strips secrets and escapes HTML', async () => {
  let authCalls = 0;
  const handler = createProductionBootHandler({
    webappDir: path.resolve(__dirname, '../webapp'),
    resolveAuth: async () => { authCalls++; return { user: 'fixture' }; },
    buildHomeStats: async () => ({ displayName: '</script><img src=x>', isAdmin: true, devices: [] }),
    license: { buildStatusView: () => ({ planName: 'fixture', password: 'must-not-render', apiKey: 'must-not-render' }) },
  });
  const response = () => ({ headers: {}, writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; } });
  const anonymous = response();
  assert.equal(await handler({ method: 'GET', url: '/', headers: {} }, anonymous), true);
  assert.equal(authCalls, 0);
  assert.ok(!anonymous.body.includes('window.__QF_BOOT__ ='));
  const signedIn = response();
  assert.equal(await handler({ method: 'GET', url: '/', headers: { cookie: 'fixture=1' } }, signedIn), true);
  assert.equal(authCalls, 1);
  assert.ok(signedIn.body.includes('fixture'));
  assert.ok(!signedIn.body.includes('</script><img src=x>'));
  assert.ok(!signedIn.body.includes('must-not-render'));
  assert.equal(signedIn.headers['cache-control'], 'no-store');
  assert.equal(signedIn.headers.vary, 'Cookie');
  const head = response();
  await handler({ method: 'HEAD', url: '/', headers: {} }, head);
  assert.equal(head.body, '');
  assert.equal(await handler({ method: 'GET', url: '/health', headers: {} }, response()), false);
});
