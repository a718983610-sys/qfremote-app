'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLicenseCore } = require('./license-core');

test('M-004: report only explicit public ban reason, never internal evidence', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-public-reason-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const core = createLicenseCore({ dir, mirrorFile: path.join(dir, 'mirror.json') });
  const now = Date.now();
  core.applyBan({ targetType: 'account', target: 'fixture-a', code: 'B8', permanent: false, endsAt: null, evidence: 'private moderation fixture' }, now);
  const legacy = core.evaluate('fixture-a', now, { channel: 'software' });
  assert.equal(legacy.banCategory, null);
  assert.ok(!JSON.stringify(legacy).includes('private moderation'));
  core.applyBan({ targetType: 'account', target: 'fixture-b', code: 'B9', permanent: true, publicReason: '已告知用户的事由\n说明', evidence: 'not public' }, now);
  const publicResult = core.evaluate('fixture-b', now, { channel: 'software' });
  assert.equal(publicResult.banCategory, '已告知用户的事由 说明');
  assert.ok(!JSON.stringify(publicResult).includes('not public'));
});
