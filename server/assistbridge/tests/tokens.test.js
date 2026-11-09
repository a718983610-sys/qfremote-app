'use strict';
// Offline tests: token store (DESIGN §5).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TokenStore, extractToken } = require('../tokens');

function tmpfile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tok-')), 'tokens.json'); }

test('tokens: generate/verify round-trip, wrong token fails', () => {
    const f = tmpfile();
    fs.writeFileSync(f, JSON.stringify({ tokens: [] }));
    const store = new TokenStore(f);
    const { plaintext, record } = TokenStore.generate('assistant');
    store.add(record);
    const rec = store.verify(plaintext);
    assert.ok(rec);
    assert.equal(rec.role, 'assistant');
    assert.equal(rec.id, record.id);
    assert.equal(store.verify(plaintext + 'x'), null);
    assert.equal(store.verify(''), null);
    assert.equal(store.verify(null), null);
    // The file holds only the hash, never the plaintext.
    const raw = fs.readFileSync(f, 'utf8');
    assert.ok(!raw.includes(plaintext));
    assert.ok(raw.includes(record.sha256));
});

test('tokens: revoke blocks verification', () => {
    const f = tmpfile();
    fs.writeFileSync(f, JSON.stringify({ tokens: [] }));
    const store = new TokenStore(f);
    const { plaintext, record } = TokenStore.generate('owner');
    store.add(record);
    assert.ok(store.verify(plaintext));
    assert.equal(store.revoke(record.id), true);
    assert.equal(store.verify(plaintext), null);
    assert.equal(store.revoke(record.id), false); // already revoked
});

test('tokens: reload picks up external edits (mtime)', () => {
    const f = tmpfile();
    fs.writeFileSync(f, JSON.stringify({ tokens: [] }));
    const store = new TokenStore(f);
    const { plaintext, record } = TokenStore.generate('view');
    // Simulate another process adding a token: rewrite the file directly.
    fs.writeFileSync(f, JSON.stringify({ tokens: [record] }));
    const rec = store.verify(plaintext);
    assert.ok(rec);
    assert.equal(rec.role, 'view');
});

test('tokens: extractToken from Bearer and X-Bridge-Token', () => {
    assert.equal(extractToken({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
    assert.equal(extractToken({ headers: { 'x-bridge-token': 'xyz' } }), 'xyz');
    assert.equal(extractToken({ headers: {} }), null);
    assert.equal(extractToken({ headers: { authorization: 'Basic abc' } }), null);
});
