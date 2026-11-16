'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { trustedClientIp, readRebindForm } = require('./request-context');

test('M-026: neither XFF position can forge the client identity', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' } };
  assert.equal(trustedClientIp(req), '127.0.0.1');
  req.headers['cf-connecting-ip'] = '2001:db8::1';
  assert.equal(trustedClientIp(req), '2001:db8::1');
  req.headers['cf-connecting-ip'] = '1:2:3';
  assert.equal(trustedClientIp(req), '127.0.0.1');
  req.socket.remoteAddress = '::ffff:203.0.113.5';
  req.headers['cf-connecting-ip'] = '198.51.100.1';
  assert.equal(trustedClientIp(req), '203.0.113.5');
});

test('M-123: bounded rebind form works over real HTTP, without URL identifiers', async (t) => {
  const server = http.createServer(async (req, res) => {
    const result = await readRebindForm(req);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...result, requestUrl: req.url }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/license/rebind';
  const response = await fetch(url, { method: 'POST', body: new URLSearchParams({ dc: 'device-fixture', platform: 'pc', ch: 'windows' }) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.value, { deviceCode: 'device-fixture', platform: 'pc', channel: 'windows' });
  assert.equal(payload.requestUrl, '/license/rebind');
  for (const body of ['dc=a&dc=b&platform=pc', 'dc=a&platform=unknown', 'dc=a%00b&platform=pc']) {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).status, 400);
  }
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(4097) })).status, 413);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 415);
});
