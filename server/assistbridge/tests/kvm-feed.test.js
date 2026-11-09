'use strict';
// Offline tests: KVM binary feed against REAL recorded tile bytes (2026-10-29).
// Builds the exact wire messages (cmd 7 screen size, cmd 3 tile) the agent
// sends, feeds them to KvmSession._feedBinary, and proves the frame pipeline
// (full-frame tracking, snapshot, screenState) without a live agent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { KvmSession } = require('../kvm');

const TILES_DIR = process.env.MCDIRECT_TILES || path.resolve(__dirname, '../../../../patrol-20261026/work/qqgame-sidechat-20261026/mc-direct/tiles');
const HAS_TILES = fs.existsSync(path.join(TILES_DIR, 't0000_0_0.jpg'));

function cmd7(w, h) {
    const b = Buffer.alloc(8);
    b.writeUInt16BE(7, 0); b.writeUInt16BE(8, 2); b.writeUInt16BE(w, 4); b.writeUInt16BE(h, 6);
    return b;
}
function cmd3(x, y, jpeg) {
    const inner = Buffer.alloc(8 + jpeg.length);
    inner.writeUInt16BE(3, 0);
    // The inner 16-bit size field cannot hold a full-frame tile; the real
    // protocol leaves it moot inside the jumbo wrapper (the parser reads
    // the 24-bit size from the wrapper instead), so write 0 there when it
    // does not fit.
    inner.writeUInt16BE((8 + jpeg.length) <= 65535 ? (8 + jpeg.length) : 0, 2);
    inner.writeUInt16BE(x, 4); inner.writeUInt16BE(y, 6);
    jpeg.copy(inner, 8);
    if (inner.length > 65535) {
        // Real protocol: large commands ride the cmd-27 jumbo wrapper
        // (the 16-bit size field cannot hold a full-frame tile).
        const outer = Buffer.alloc(8 + inner.length);
        outer.writeUInt16BE(27, 0); outer.writeUInt16BE(8, 2);
        outer.writeUInt8(0, 4); outer.writeUIntBE(inner.length, 5, 3);
        inner.copy(outer, 8);
        return outer;
    }
    return inner;
}

test('kvm feed: screen-size + full-frame tile -> snapshot complete, desktop', { skip: !HAS_TILES }, () => {
    const fullJpeg = fs.readFileSync(path.join(TILES_DIR, 't0000_0_0.jpg'));
    const smallJpeg = fs.readFileSync(path.join(TILES_DIR, 't0001_1824_672.jpg'));
    const sess = new KvmSession({ nodeid: 'node//test', creds: { user: 'u', pass: 'p' } });
    // Stub the relay: cmd 7's init sequence sends on it.
    const sent = [];
    sess.relay = { sendBinary: (b) => sent.push(Buffer.from(b)), sendText: () => {} };
    sess._feedBinary(cmd7(1920, 1080));
    assert.equal(sess.screenW, 1920);
    assert.equal(sess.screenH, 1080);
    assert.ok(sent.length >= 4, 'init sequence sent (compression/unpause/lockquery/getdisplays)');
    assert.deepEqual([...sent[0]].slice(0, 6), [0x00, 0x05, 0x00, 0x0A, 0x01, 0x32]); // compression q50
    sess._feedBinary(cmd3(0, 0, fullJpeg));
    sess._feedBinary(cmd3(1824, 672, smallJpeg));
    assert.equal(sess.tiles.size, 2);
    assert.equal(sess.tileMsgs, 2);
    assert.ok(sess.fullFrame);
    assert.equal(sess.fullFrame.jpeg.length, fullJpeg.length);
    assert.equal(sess.fullFrame.w, 1920);
    const snap = sess.snapshot({ quietMs: 0 });
    assert.equal(snap.frameComplete, true);
    assert.equal(snap.jpeg.length, fullJpeg.length);
    assert.equal(snap.width, 1920);
    assert.equal(snap.height, 1080);
    assert.equal(sess.screenState(), 'desktop');
});

test('kvm feed: fragmented delivery reassembles (split mid-tile)', { skip: !HAS_TILES }, () => {
    const fullJpeg = fs.readFileSync(path.join(TILES_DIR, 't0000_0_0.jpg'));
    const sess = new KvmSession({ nodeid: 'node//test', creds: { user: 'u', pass: 'p' } });
    sess.relay = { sendBinary: () => {}, sendText: () => {} };
    sess._feedBinary(cmd7(1920, 1080));
    const msg = cmd3(0, 0, fullJpeg);
    sess._feedBinary(msg.slice(0, 100)); // first fragment
    assert.equal(sess.tiles.size, 0); // not complete yet
    sess._feedBinary(msg.slice(100)); // remainder
    assert.equal(sess.tiles.size, 1);
    assert.equal(sess.fullFrame.jpeg.length, fullJpeg.length);
});

test('kvm feed: jumbo wrapper (cmd 27) unwraps', () => {
    const sess = new KvmSession({ nodeid: 'node//test', creds: { user: 'u', pass: 'p' } });
    sess.relay = { sendBinary: () => {}, sendText: () => {} };
    const inner = cmd7(1366, 768);
    const outer = Buffer.alloc(8 + inner.length);
    outer.writeUInt16BE(27, 0); outer.writeUInt16BE(8, 2);
    outer.writeUInt8(0, 4); outer.writeUIntBE(inner.length, 5, 3);
    inner.copy(outer, 8);
    sess._feedBinary(outer);
    assert.equal(sess.screenW, 1366);
    assert.equal(sess.screenH, 768);
});

test('kvm feed: no frame yet -> snapshot no-frame, screenState unknown', () => {
    const sess = new KvmSession({ nodeid: 'node//test', creds: { user: 'u', pass: 'p' } });
    sess.relay = { sendBinary: () => {}, sendText: () => {} };
    const snap = sess.snapshot();
    assert.equal(snap.jpeg, null);
    assert.equal(snap.frameComplete, false);
    assert.equal(sess.screenState(), 'unknown');
});

test('kvm feed: cmd 87 input-lock reply parses (viewer-proven 5-byte shape)', () => {
    const sess = new KvmSession({ nodeid: 'node//test', creds: { user: 'u', pass: 'p' } });
    sess.relay = { sendBinary: () => {}, sendText: () => {} };
    assert.equal(sess.inputLocked, null); // unknown until the first reply
    const lockMsg = (locked) => {
        const b = Buffer.alloc(5);
        b.writeUInt16BE(87, 0); b.writeUInt16BE(5, 2); b.writeUInt8(locked ? 1 : 0, 4);
        return b;
    };
    sess._feedBinary(lockMsg(true));
    assert.equal(sess.inputLocked, true);
    sess._feedBinary(lockMsg(false));
    assert.equal(sess.inputLocked, false);
    // Malformed length must not change the state.
    const bad = Buffer.alloc(6);
    bad.writeUInt16BE(87, 0); bad.writeUInt16BE(6, 2); bad.writeUInt8(1, 4);
    sess._feedBinary(bad);
    assert.equal(sess.inputLocked, false);
});

test('kvm: parseVisibleNodes flattens mesh -> node arrays (live-probed shape)', () => {
    const { parseVisibleNodes } = require('../kvm');
    const LAPTOP = 'node//8tVIMXjJh50uyBWFCvfJzyEWfc7PFcmYgL1wMmMf3xiv2cFYhjnn@7WnygBlCSp7';
    const msg = {
        action: 'nodes',
        nodes: {
            'mesh//rH2tWuyUp@0hrso1u46NtoMZ': [
                { type: 'node', mtype: 2, _id: LAPTOP, icon: 2, name: 'DESKTOP-D39ABOL' },
                { type: 'node', mtype: 2, _id: 'node//other@x', icon: 2, name: 'OTHER' },
            ],
            'mesh//second@mesh': [{ type: 'node', _id: 'node//third@x' }],
        },
    };
    assert.deepEqual(parseVisibleNodes(msg), [LAPTOP, 'node//other@x', 'node//third@x']);
    // Edge cases: missing/empty/non-array shapes return [] (fail-closed).
    assert.deepEqual(parseVisibleNodes(null), []);
    assert.deepEqual(parseVisibleNodes({}), []);
    assert.deepEqual(parseVisibleNodes({ action: 'nodes' }), []);
    assert.deepEqual(parseVisibleNodes({ nodes: { 'mesh//m': { _id: 'node//notarray' } } }), []);
    assert.deepEqual(parseVisibleNodes({ nodes: { 'mesh//m': [] } }), []);
});
