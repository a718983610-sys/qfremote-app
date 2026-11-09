'use strict';
// Offline tests: audit chain (DESIGN §8.1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AuditLog, textDetail, keyDetail, mouseDetail, snapshotDetail } = require('../audit');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-')); }

test('audit: append + verify chain passes', () => {
    const dir = tmpdir();
    const a = new AuditLog(dir);
    a.append('session-opened', { sessionId: 's1' });
    a.append('snapshot', { sessionId: 's1', ...snapshotDetail(Buffer.from('fakejpeg')) });
    a.append('session-closed', { sessionId: 's1', reason: 'assistant-close' });
    const v = a.verify();
    assert.equal(v.ok, true);
    assert.equal(v.rows, 3);
});

test('audit: tamper is detected (edited row)', () => {
    const dir = tmpdir();
    const a = new AuditLog(dir);
    a.append('session-opened', { sessionId: 's1' });
    a.append('snapshot', { sessionId: 's1' });
    const f = path.join(dir, 'audit-' + new Date().toISOString().slice(0, 10) + '.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const row = JSON.parse(lines[1]);
    row.event = 'snapshot-FORGED';
    lines[1] = JSON.stringify(row);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const a2 = new AuditLog(dir);
    const v = a2.verify();
    assert.equal(v.ok, false);
    assert.match(v.error, /hash mismatch/);
});

test('audit: deletion is detected (missing row breaks prev chain)', () => {
    const dir = tmpdir();
    const a = new AuditLog(dir);
    a.append('a', {});
    a.append('b', {});
    a.append('c', {});
    const f = path.join(dir, 'audit-' + new Date().toISOString().slice(0, 10) + '.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    lines.splice(1, 1); // delete the middle row
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const v = new AuditLog(dir).verify();
    assert.equal(v.ok, false);
});

test('audit: anchor round-trips', () => {
    const dir = tmpdir();
    const a = new AuditLog(dir);
    a.append('a', {});
    a.append('b', {});
    const anchor = a.writeAnchor();
    assert.equal(anchor.rows, 2);
    assert.equal(anchor.firstPrev, 'GENESIS');
    assert.equal(anchor.lastHash.length, 64);
});

test('audit: semantic redaction never carries content', () => {
    const t = textDetail('你好世界 secret password 123');
    assert.equal(t.textLen, 24); // JS String.length counts UTF-16 code units
    assert.equal(t.textSha256.length, 64);
    assert.ok(!JSON.stringify(t).includes('你好'));
    const k = keyDetail('vk:13');
    assert.equal(k.keyName, 'vk:13');
    const kp = keyDetail('a', { printable: true });
    assert.equal(kp.keyClass, 'printable');
    assert.ok(!('keyName' in kp));
    const m = mouseDetail('top-left', 'click');
    assert.deepEqual(m, { action: 'click', zone: 'top-left' });
    const s = snapshotDetail(Buffer.from('jpegbytes'));
    assert.equal(s.bytes, 9);
    assert.equal(s.sha256.length, 64);
});

test('audit: purgeOld removes only old days', () => {
    const dir = tmpdir();
    const a = new AuditLog(dir, { retentionDays: 90 });
    const oldDate = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const oldFile = path.join(dir, 'audit-' + oldDate + '.jsonl');
    fs.writeFileSync(oldFile, '{"ts":1}\n');
    const today = path.join(dir, 'audit-' + new Date().toISOString().slice(0, 10) + '.jsonl');
    fs.writeFileSync(today, '{"ts":2}\n');
    const removed = a.purgeOld();
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(today), true);
});
