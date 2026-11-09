'use strict';
// Integration tests: the bridge HTTP service end-to-end (in-process, fake KVM).
// Real HTTP over loopback TCP; real TokenStore/AuditLog/Outbox/Replay on
// temp dirs. The fake KVM never touches the network — live-agent behaviour
// is covered by the kvm-feed tests + the (pending) fixture runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Bridge } = require('../bridge');
const { TokenStore } = require('../tokens');

const LAPTOP = 'node//8tVIMXjJh50uyBWFCvfJzyEWfc7PFcmYgL1wMmMf3xiv2cFYhjnn@7WnygBlCSp7';
const FAKE_JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0xFF, 0xD9]);

class FakeKvm {
    constructor(opts) {
        this.opts = opts;
        this.screenW = 1920; this.screenH = 1080;
        this.input = { move: () => {}, down: () => {}, up: () => {}, click: () => {}, keyTap: () => {}, keyCombo: () => {}, keyUnicodeChar: () => {}, releaseAllModifiers: () => {} };
        this._tileCb = opts.onTile;
    }
    async connect() { return this; }
    async settleInitialFrame() { if (this._tileCb) this._tileCb({ x: 0, y: 0, jpeg: FAKE_JPEG, hash: 'fakehash', seq: 0, t: Date.now(), changed: true }); }
    snapshot() {
        return { jpeg: FAKE_JPEG, hash: 'fakehash', width: 1920, height: 1080, frameComplete: true, capturedAt: Date.now(), lastTileAt: Date.now(), lastFullRefreshAt: Date.now(), tileCount: 1, tileMsgs: 1, tileBytes: FAKE_JPEG.length };
    }
    screenState() { return 'desktop'; }
    async refresh() {}
    waitChange() { return Promise.resolve(null); }
    async close() {}
}

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-int-'));
    const cfg = {
        sockPath: path.join(dir, 'bridge.sock'),
        tcpPort: 0, // random loopback port
        whitelist: [LAPTOP],
        secretStorePath: path.join(dir, 'assistsvc.json'),
        tokensPath: path.join(dir, 'tokens.json'),
        auditDir: path.join(dir, 'audit'),
        outboxPath: path.join(dir, 'outbox.jsonl'),
        acksPath: path.join(dir, 'acks.jsonl'),
        replayDir: path.join(dir, 'replays'),
        disabledPath: path.join(dir, 'DISABLED'),
        coolingPath: path.join(dir, 'COOLING'),
        idleTimeoutMs: 120000, maxSessionMs: 30 * 60 * 1000, coolingMs: 5 * 60 * 1000,
        ackTimeoutMs: 5000, ackPollMs: 100,
        controlEnabled: false, unicodeLE: false, snapshotRatePerSec: 10,
        textEnabled: false, replayRetentionDays: 7, replayMaxBytesPerSession: 500 * 1024 * 1024,
    };
    fs.writeFileSync(cfg.secretStorePath, JSON.stringify({ user: 'qf-assistsvc', pass: 'test-only-fake-password' }));
    fs.writeFileSync(cfg.tokensPath, JSON.stringify({ tokens: [] }));
    const store = new TokenStore(cfg.tokensPath);
    const assistant = TokenStore.generate('assistant');
    store.add(assistant.record);
    const owner = TokenStore.generate('owner');
    store.add(owner.record);
    const bridge = new Bridge(cfg, { kvmFactory: (opts) => new FakeKvm(opts) });
    bridge.start();
    return { dir, cfg, bridge, assistantTok: assistant.plaintext, ownerTok: owner.plaintext };
}

function httpReq(port, method, p, token, body) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (token) headers.Authorization = 'Bearer ' + token;
        let raw = null;
        if (body !== undefined) { raw = JSON.stringify(body); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(raw); }
        const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (raw) req.write(raw);
        req.end();
    });
}
async function waitPort(bridge) {
    for (let i = 0; i < 50; i++) {
        const addr = bridge.tcpServer && bridge.tcpServer.address();
        if (addr && addr.port) return addr.port;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('tcp server never bound');
}
// ACK all currently pending session-request events (simulates the poller:
// it tells the owner about every pending event, then ACKs each).
async function ackPending(port, token) {
    const list = await httpReq(port, 'GET', '/events/pending', token);
    const pending = JSON.parse(list.body.toString()).pending;
    assert.ok(pending.length >= 1, 'expected a pending session-request event');
    for (const ev of pending) {
        const ack = await httpReq(port, 'POST', '/ack', token, { eventId: ev.eventId });
        assert.equal(ack.status, 200);
    }
}

test('bridge: status auth + open fail-closed without ACK, then open with ACK', async (t) => {
    const { bridge, assistantTok } = setup();
    t.after(async () => { await bridge.stop(); });
    const port = await waitPort(bridge);

    // No token -> 401; wrong token -> 401.
    assert.equal((await httpReq(port, 'GET', '/status', null)).status, 401);
    assert.equal((await httpReq(port, 'GET', '/status', 'bogus')).status, 401);
    const st = await httpReq(port, 'GET', '/status', assistantTok);
    assert.equal(st.status, 200);
    assert.equal(JSON.parse(st.body.toString()).state, 'idle');

    // Non-whitelisted node -> 403.
    const bad = await httpReq(port, 'POST', '/session/open', assistantTok, { nodeId: 'node//other' });
    assert.equal(bad.status, 403);

    // Open with NO ACK: the bridge waits ackTimeoutMs (5s) then refuses 503.
    const start = Date.now();
    const refused = await httpReq(port, 'POST', '/session/open', assistantTok, { nodeId: LAPTOP });
    assert.equal(refused.status, 503);
    assert.equal(JSON.parse(refused.body.toString()).error, 'notify-ack-required');
    assert.ok(Date.now() - start >= 4000, 'open must actually wait for the ACK window');

    // Open WITH an ACK (poller simulation): the session goes live.
    const openP = httpReq(port, 'POST', '/session/open', assistantTok, { nodeId: LAPTOP });
    await new Promise((r) => setTimeout(r, 300));
    await ackPending(port, assistantTok);
    const opened = await openP;
    assert.equal(opened.status, 200);
    const openBody = JSON.parse(opened.body.toString());
    assert.ok(openBody.sessionId.startsWith('sess_'));
    assert.ok(openBody.observeToken);
    assert.equal(openBody.screen.width, 1920);
    assert.equal(openBody.screenState, 'desktop');
    assert.equal(openBody.frameComplete, true);

    // Second open while live -> 409.
    const second = await httpReq(port, 'POST', '/session/open', assistantTok, { nodeId: LAPTOP });
    assert.equal(second.status, 409);

    // Snapshot returns the fake frame as JPEG with honest headers.
    const snap = await httpReq(port, 'GET', '/session/' + openBody.sessionId + '/snapshot', assistantTok);
    assert.equal(snap.status, 200);
    assert.equal(snap.headers['content-type'], 'image/jpeg');
    assert.equal(snap.headers['x-bridge-frame-complete'], 'true');
    assert.equal(snap.headers['x-bridge-frame-scaled'], 'false');
    assert.equal(snap.body[0], 0xFF);
    assert.equal(snap.body[1], 0xD8);

    // Control surface is CLOSED (P5 gate): mouse/key 409, text 403.
    assert.equal((await httpReq(port, 'POST', '/session/' + openBody.sessionId + '/mouse', assistantTok, { x: 100, y: 100, action: 'click' })).status, 409);
    assert.equal((await httpReq(port, 'POST', '/session/' + openBody.sessionId + '/key', assistantTok, { kind: 'tap', vk: 13 })).status, 409);
    assert.equal((await httpReq(port, 'POST', '/session/' + openBody.sessionId + '/text', assistantTok, { text: 'hi' })).status, 403);

    // Observe stream emits at least one MJPEG frame, then close ends it.
    const streamP = new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/observe/' + openBody.observeToken + '/stream', method: 'GET' }, (res) => {
            assert.equal(res.statusCode, 200);
            assert.match(res.headers['content-type'], /multipart\/x-mixed-replace/);
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            setTimeout(() => { try { req.destroy(); } catch (e) {} resolve(Buffer.concat(chunks)); }, 2600);
        });
        req.on('error', () => resolve(Buffer.alloc(0)));
        req.end();
    });
    const streamBuf = await streamP;
    assert.ok(streamBuf.includes(Buffer.from([0xFF, 0xD8])), 'stream must contain a JPEG frame');

    // Close is idempotent; session status then 404s.
    const close1 = await httpReq(port, 'POST', '/session/' + openBody.sessionId + '/close', assistantTok);
    assert.equal(close1.status, 200);
    const close2 = await httpReq(port, 'POST', '/session/' + openBody.sessionId + '/close', assistantTok);
    assert.equal(close2.status, 200);
    assert.equal(JSON.parse(close2.body.toString()).already, true);
    assert.equal((await httpReq(port, 'GET', '/session/' + openBody.sessionId + '/status', assistantTok)).status, 404);
});

test('bridge: /kill writes DISABLED + cooling, and blocks reopen', async (t) => {
    const { dir, cfg, bridge, assistantTok } = setup();
    t.after(async () => { await bridge.stop(); });
    const port = await waitPort(bridge);
    const openP = httpReq(port, 'POST', '/session/open', assistantTok, { nodeId: LAPTOP });
    await new Promise((r) => setTimeout(r, 300));
    await ackPending(port, assistantTok);
    const opened = await openP;
    assert.equal(opened.status, 200);
    const sessionId = JSON.parse(opened.body.toString()).sessionId;

    const kill = await httpReq(port, 'POST', '/kill', assistantTok);
    assert.equal(kill.status, 200);
    assert.equal(JSON.parse(kill.body.toString()).disabled, true);
    assert.ok(fs.existsSync(cfg.disabledPath), 'DISABLED flag file must exist');
    // Reopen is refused while DISABLED (and cooling).
    const reopen = await httpReq(port, 'POST', '/session/open', assistantTok, { nodeId: LAPTOP });
    assert.equal(reopen.status, 503);
    assert.equal(JSON.parse(reopen.body.toString()).error, 'bridge-disabled');
    // Audit chain verifies end-to-end (kill + refusal recorded).
    const { AuditLog } = require('../audit');
    const v = new AuditLog(cfg.auditDir).verify();
    assert.equal(v.ok, true);
    assert.ok(v.rows >= 5);
    // Replay record exists with a close anchor.
    const closeFile = path.join(cfg.replayDir, sessionId, 'close.json');
    assert.ok(fs.existsSync(closeFile));
    const close = JSON.parse(fs.readFileSync(closeFile, 'utf8'));
    assert.equal(close.reason, 'local-kill');
    assert.equal(close.closeAnchor.length, 64);
});

test('bridge: owner-remote-kill needs the owner role', async (t) => {
    const { bridge, assistantTok, ownerTok } = setup();
    t.after(async () => { await bridge.stop(); });
    const port = await waitPort(bridge);
    const openP = httpReq(port, 'POST', '/session/open', assistantTok, { nodeId: LAPTOP });
    await new Promise((r) => setTimeout(r, 300));
    await ackPending(port, assistantTok);
    assert.equal((await openP).status, 200);
    // Assistant token cannot owner-kill.
    assert.equal((await httpReq(port, 'POST', '/observe/kill', assistantTok)).status, 403);
    // Owner token can.
    const ok = await httpReq(port, 'POST', '/observe/kill', ownerTok);
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body.toString()).killed, true);
    // Cooling now blocks reopen (DISABLED not written by owner-kill, so the
    // refusal reason is cooling, not bridge-disabled).
    const reopen = await httpReq(port, 'POST', '/session/open', assistantTok, { nodeId: LAPTOP });
    assert.equal(reopen.status, 503);
    assert.equal(JSON.parse(reopen.body.toString()).error, 'cooling');
});

test('bridge: cooling survives a restart (deadline persisted to disk)', async (t) => {
    const { bridge, assistantTok } = setup();
    t.after(async () => { await bridge.stop(); });
    const port = await waitPort(bridge);
    const kill = await httpReq(port, 'POST', '/kill', assistantTok);
    assert.equal(kill.status, 200);
    const coolingUntil = JSON.parse((await httpReq(port, 'GET', '/status', assistantTok)).body.toString()).coolingUntil;
    assert.ok(coolingUntil > Date.now());
    // Restart the bridge process (new instance, same config dir).
    await bridge.stop();
    const bridge2 = new Bridge(bridge.cfg, { kvmFactory: (opts) => new FakeKvm(opts) });
    bridge2.start();
    t.after(async () => { await bridge2.stop(); });
    const port2 = await waitPort(bridge2);
    const st2 = JSON.parse((await httpReq(port2, 'GET', '/status', assistantTok)).body.toString());
    assert.equal(st2.coolingUntil, coolingUntil, 'cooling deadline must survive the restart');
    // DISABLED is still on disk too, so open is refused as bridge-disabled
    // (which takes precedence over cooling).
    const reopen = await httpReq(port2, 'POST', '/session/open', assistantTok, { nodeId: LAPTOP });
    assert.equal(reopen.status, 503);
    assert.equal(JSON.parse(reopen.body.toString()).error, 'bridge-disabled');
});
