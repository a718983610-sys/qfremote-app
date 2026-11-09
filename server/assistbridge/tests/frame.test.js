'use strict';
// Offline tests: frame assembler + snapshot response headers (P4).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { zoneOf, snapshotResponse, replayTiles } = require('../frame-assembler');

test('frame: nine-grid zones', () => {
    assert.equal(zoneOf(0, 0, 1920, 1080), 'top-left');
    assert.equal(zoneOf(1919, 1079, 1920, 1080), 'bottom-right');
    assert.equal(zoneOf(960, 540, 1920, 1080), 'middle-center');
    assert.equal(zoneOf(100, 100, 0, 0), 'unknown');
});

test('frame: snapshot response headers carry actuals, never pretend scaling', () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
    const snap = { jpeg, hash: 'abc', width: 1920, height: 1080, frameComplete: true, capturedAt: 1000, lastTileAt: 1000, lastFullRefreshAt: 900, tileCount: 1, tileMsgs: 1, tileBytes: 4 };
    const r = snapshotResponse(snap, { maxw: 800, q: 50 });
    assert.equal(r.status, 'complete');
    assert.equal(r.headers['X-Bridge-Frame-Complete'], 'true');
    assert.equal(r.headers['X-Bridge-Frame-Width'], '1920'); // actual, not requested 800
    assert.equal(r.headers['X-Bridge-Frame-Scaled'], 'false');
    assert.equal(r.headers['X-Bridge-Frame-Quality'], '50');
    assert.equal(r.headers['X-Bridge-Requested-Maxw'], '800');
    assert.equal(r.headers['X-Bridge-Frame-Bytes'], '4');
    assert.equal(r.headers['X-Bridge-Frame-Sha256'].length, 64);
    assert.equal(r.jpeg, jpeg);
    const noFrame = snapshotResponse({ ...snap, jpeg: null, hash: null, frameComplete: false });
    assert.equal(noFrame.status, 'no-frame');
    assert.equal(noFrame.jpeg, null);
});

test('frame: replayTiles picks the (0,0) full frame', () => {
    const full = { x: 0, y: 0, jpeg: Buffer.from('FULL') };
    const small = { x: 100, y: 100, jpeg: Buffer.from('small') };
    assert.equal(replayTiles([small, full]), full);
    assert.equal(replayTiles([small]), null);
});

// Real recorded tiles (2026-10-29 mc-direct run). Skipped when the evidence
// dir is absent (e.g. a clean checkout) — the fixture path is an env var.
const TILES_DIR = process.env.MCDIRECT_TILES || path.resolve(__dirname, '../../../../patrol-20261026/work/qqgame-sidechat-20261026/mc-direct/tiles');
test('frame: recorded (0,0) tile is a full-frame JPEG', { skip: !fs.existsSync(path.join(TILES_DIR, 't0000_0_0.jpg')) }, () => {
    const buf = fs.readFileSync(path.join(TILES_DIR, 't0000_0_0.jpg'));
    assert.equal(buf[0], 0xFF);
    assert.equal(buf[1], 0xD8); // JPEG SOI
    assert.ok(buf.length > 50000, 'full frame should be tens of KB, got ' + buf.length);
    const small = fs.readFileSync(path.join(TILES_DIR, 't0001_1824_672.jpg'));
    assert.equal(small[0], 0xFF);
    assert.ok(small.length < 5000, 'delta tile should be small, got ' + small.length);
    const picked = replayTiles([
        { x: 1824, y: 672, jpeg: small },
        { x: 0, y: 0, jpeg: buf },
    ]);
    assert.equal(picked.jpeg, buf);
});
