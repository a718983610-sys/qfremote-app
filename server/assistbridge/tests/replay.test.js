'use strict';
// Offline tests: session replay record (P3, DESIGN §8.3 C7).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SessionReplay } = require('../replay');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-replay-')); }

test('replay: meta header hash + frames/actions + close anchor chain', () => {
    const dir = tmpdir();
    const r = new SessionReplay(dir, 'sess_test1', {});
    const headerHash = r.writeMeta({ sessionId: 'sess_test1', nodeId: 'node//x', openedBy: 'tok_1' });
    assert.equal(headerHash.length, 64);
    assert.equal(r.recordFrame(crypto.createHash('sha256').update('frame1').digest('hex'), 1024), true);
    assert.equal(r.recordFrame(crypto.createHash('sha256').update('frame2').digest('hex'), 2048), true);
    r.recordAction('mouse', { action: 'click', zone: 'middle-center' });
    r.recordAction('key', { kind: 'tap', changed: true });
    const close = r.close('assistant-close', { mouse: 1, key: 1, text: 0, snapshot: 2 });
    assert.equal(close.frames, 2);
    assert.equal(close.actions, 2);
    assert.equal(close.reason, 'assistant-close');
    assert.equal(close.closeAnchor.length, 64);
    assert.equal(close.incomplete, false);
    // The close anchor is reproducible from the stored files.
    const recompute = crypto.createHash('sha256')
        .update(close.headerHash + close.framesHash + close.actionsHash).digest('hex');
    assert.equal(recompute, close.closeAnchor);
    // Files exist on disk.
    assert.ok(fs.existsSync(path.join(dir, 'sess_test1', 'meta.json')));
    assert.ok(fs.existsSync(path.join(dir, 'sess_test1', 'frames.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'sess_test1', 'actions.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'sess_test1', 'close.json')));
});

test('replay: cap hit stops frame recording but keeps actions, marks incomplete', () => {
    const dir = tmpdir();
    const r = new SessionReplay(dir, 'sess_test2', { maxBytes: 0 }); // zero cap: over cap immediately
    r.writeMeta({ sessionId: 'sess_test2' });
    assert.equal(r.recordFrame('a'.repeat(64), 1024), false); // over cap immediately
    assert.equal(r.recordAction('mouse', { action: 'click' }), true); // actions continue
    const close = r.close('assistant-close', { mouse: 1 });
    assert.equal(close.incomplete, true);
});

test('replay: purgeOld removes only sessions older than retention', () => {
    const dir = tmpdir();
    const old = new SessionReplay(dir, 'sess_old', {});
    old.writeMeta({ sessionId: 'sess_old' });
    const oldMeta = path.join(dir, 'sess_old', 'meta.json');
    const past = Date.now() - 10 * 24 * 3600 * 1000;
    fs.utimesSync(oldMeta, new Date(past), new Date(past));
    const fresh = new SessionReplay(dir, 'sess_new', {});
    fresh.writeMeta({ sessionId: 'sess_new' });
    const removed = SessionReplay.purgeOld(dir, 7);
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(path.join(dir, 'sess_old')), false);
    assert.equal(fs.existsSync(path.join(dir, 'sess_new')), true);
});
