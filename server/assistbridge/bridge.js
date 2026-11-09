'use strict';
// Assistant control bridge — main service (DESIGN §5, §8).
//
// Loopback-only HTTP+JSON service (UDS preferred, TCP 127.0.0.1 fallback).
// No public listener. Authenticated by bridge tokens (sha256 hashes only,
// see tokens.js). One session at a time, whitelist-only target, fail-closed
// notify gate at open, full audit + replay record per session.
//
// State machine: idle -> opening -> live -> closing -> idle.
// The open check-and-set happens SYNCHRONOUSLY before the first await, so
// two concurrent opens cannot both pass the single-session check.
// Idle timeout 120 s (no input/snapshot call), absolute max 30 min, cooling
// 5 min after local-kill / owner-remote-kill. /kill also writes the
// persistent DISABLED flag (clearing it requires a human deleting the file).
//
// Control surface (mouse/key) is CLOSED in this build: controlEnabled=false
// by default and /mouse /key return 409 until 0d passes AND an explicit,
// recorded decision flips the flag (P5 gate). /text returns 403 always
// (textEnabled=false; DESIGN §5 default-disabled).
//
// Nothing in this file logs a credential, cookie, or token value.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadConfig, DEFAULTS } = require('./config');
const { TokenStore, extractToken } = require('./tokens');
const { AuditLog, textDetail, keyDetail, mouseDetail, snapshotDetail } = require('./audit');
const { Outbox } = require('./notify');
const { SessionReplay } = require('./replay');
const { KvmSession } = require('./kvm');
const { zoneOf, snapshotResponse } = require('./frame-assembler');
const mcSession = require('./mc-session');

const VERSION = '1.0.0-p1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bridge {
    constructor(cfg, deps = {}) {
        // Fill any missing key from DEFAULTS: a caller that builds cfg by
        // hand (tests, minimal config files) must never leave a path
        // undefined — _persistCooling would silently write nowhere.
        this.cfg = Object.assign({}, DEFAULTS, cfg);
        this.tokens = new TokenStore(cfg.tokensPath);
        this.audit = new AuditLog(cfg.auditDir);
        this.outbox = new Outbox(cfg.outboxPath, cfg.acksPath);
        this.kvmFactory = deps.kvmFactory || ((opts) => new KvmSession(opts));
        this.session = null;          // null | {id, nodeId, tokenId, state, kvm, replay, openedAt, lastActivityAt, counters, observeTokenId}
        this.coolingUntil = 0;
        this._restoreCooling(); // a restart must not dodge the cooling window
        this.startedAt = Date.now();
        this.snapshotChain = Promise.resolve(); // serialize snapshots (global concurrency 1)
        this.lastSnapshotAt = 0;
        this._timer = null;
    }

    // ---------- lifecycle ----------
    start() {
        this.audit.purgeOld();
        SessionReplay.purgeOld(this.cfg.replayDir, this.cfg.replayRetentionDays);
        // Remove a stale UDS socket from a previous run.
        try { if (fs.existsSync(this.cfg.sockPath)) fs.unlinkSync(this.cfg.sockPath); } catch (e) {}
        this.server = http.createServer((req, res) => this._handle(req, res));
        this.server.on('error', (e) => { console.error('[bridge] server error', e.message); process.exit(1); });
        this.server.listen(this.cfg.sockPath, () => {
            try { fs.chmodSync(this.cfg.sockPath, 0o600); } catch (e) {}
            console.log('[bridge] listening on UDS ' + this.cfg.sockPath);
        });
        this.tcpServer = http.createServer((req, res) => this._handle(req, res));
        this.tcpServer.on('error', (e) => { console.error('[bridge] tcp server error', e.message); process.exit(1); });
        this.tcpServer.listen(this.cfg.tcpPort, '127.0.0.1', () => {
            console.log('[bridge] listening on loopback 127.0.0.1:' + this.cfg.tcpPort);
        });
        this._timer = setInterval(() => this._tick(), 10000);
        this.audit.append('bridge-started', { version: VERSION, controlEnabled: !!this.cfg.controlEnabled, whitelistCount: (this.cfg.whitelist || []).length });
    }

    async stop() {
        clearInterval(this._timer);
        if (this.session) await this._closeSession('bridge-stop');
        this.audit.writeAnchor();
        try { this.server && this.server.close(); } catch (e) {}
        try { this.tcpServer && this.tcpServer.close(); } catch (e) {}
        try { if (fs.existsSync(this.cfg.sockPath)) fs.unlinkSync(this.cfg.sockPath); } catch (e) {}
    }

    _tick() {
        if (!this.session || this.session.state !== 'live') return;
        const now = Date.now();
        if (now - this.session.openedAt > this.cfg.maxSessionMs) { this._closeSession('max-duration').catch(() => {}); return; }
        if (now - this.session.lastActivityAt > this.cfg.idleTimeoutMs) { this._closeSession('idle-timeout').catch(() => {}); return; }
    }

    _isDisabled() { return fs.existsSync(this.cfg.disabledPath); }
    _isCooling() { return Date.now() < this.coolingUntil; }
    // Cooling survives restarts: the deadline is written to disk on every
    // kill and re-read at boot. (Found by the 2026-11-09 acceptance: a plain
    // restart used to clear the in-memory window.)
    _persistCooling() {
        try { fs.writeFileSync(this.cfg.coolingPath, JSON.stringify({ coolingUntil: this.coolingUntil }) + '\n', { mode: 0o600 }); } catch (e) {}
    }
    _restoreCooling() {
        try {
            const doc = JSON.parse(fs.readFileSync(this.cfg.coolingPath, 'utf8'));
            if (doc.coolingUntil && doc.coolingUntil > Date.now()) this.coolingUntil = doc.coolingUntil;
        } catch (e) { /* no cooling file yet */ }
    }

    // ---------- HTTP plumbing ----------
    async _readBody(req, limit = 65536) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let total = 0;
            req.on('data', (c) => { total += c.length; if (total > limit) { req.destroy(); reject(new Error('body too large')); } else chunks.push(c); });
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (!raw) return resolve({});
                try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
            });
            req.on('error', reject);
        });
    }
    _json(res, code, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    }
    _err(res, code, error, extra = {}) { this._json(res, code, { ok: false, error, ...extra }); }

    _auth(req, roles) {
        const tok = extractToken(req);
        if (!tok) return { ok: false, code: 401, error: 'missing-token' };
        const rec = this.tokens.verify(tok);
        if (!rec) return { ok: false, code: 401, error: 'bad-token' };
        if (roles && !roles.includes(rec.role)) return { ok: false, code: 403, error: 'role-forbidden', role: rec.role };
        return { ok: true, rec };
    }

    async _handle(req, res) {
        try {
            const u = new URL(req.url, 'http://bridge');
            const p = u.pathname;
            if (p === '/status' && req.method === 'GET') return this._routeStatus(req, res);
            if (p === '/session/open' && req.method === 'POST') return this._routeOpen(req, res);
            if (p === '/kill' && req.method === 'POST') return this._routeKill(req, res);
            if (p === '/observe/kill' && req.method === 'POST') return this._routeOwnerKill(req, res);
            if (p === '/ack' && req.method === 'POST') return this._routeAck(req, res);
            if (p === '/events/pending' && req.method === 'GET') return this._routePending(req, res);
            const m = p.match(/^\/session\/([^/]+)\/(snapshot|mouse|key|text|close|status)$/);
            if (m) {
                const id = decodeURIComponent(m[1]);
                const action = m[2];
                if (action === 'snapshot' && req.method === 'GET') return this._routeSnapshot(req, res, id, u);
                if (action === 'mouse' && req.method === 'POST') return this._routeMouse(req, res, id);
                if (action === 'key' && req.method === 'POST') return this._routeKey(req, res, id);
                if (action === 'text' && req.method === 'POST') return this._routeText(req, res, id);
                if (action === 'close' && req.method === 'POST') return this._routeClose(req, res, id);
                if (action === 'status' && req.method === 'GET') return this._routeSessionStatus(req, res, id);
            }
            const om = p.match(/^\/observe\/([^/]+)\/stream$/);
            if (om && req.method === 'GET') return this._routeObserveStream(req, res, decodeURIComponent(om[1]));
            return this._err(res, 404, 'not-found');
        } catch (e) {
            console.error('[bridge] handler error', e && e.message);
            if (!res.headersSent) this._err(res, 500, 'internal-error');
        }
    }

    // ---------- routes ----------
    _routeStatus(req, res) {
        const a = this._auth(req);
        if (!a.ok) return this._err(res, a.code, a.error);
        this._json(res, 200, {
            ok: true, version: VERSION, uptimeMs: Date.now() - this.startedAt,
            state: this.session ? this.session.state : 'idle',
            sessionId: this.session ? this.session.id : null,
            controlEnabled: !!this.cfg.controlEnabled,
            textEnabled: !!this.cfg.textEnabled,
            disabled: this._isDisabled(),
            coolingUntil: this.coolingUntil,
        });
    }

    async _routeOpen(req, res) {
        const a = this._auth(req, ['assistant']);
        if (!a.ok) return this._err(res, a.code, a.error);
        let body;
        try { body = await this._readBody(req); } catch (e) { return this._err(res, 400, e.message); }
        const nodeId = body.nodeId;
        // --- synchronous check-and-set BEFORE the first await (single-session) ---
        if (this._isDisabled()) { this.audit.append('session-open-refused', { reason: 'disabled' }); return this._err(res, 503, 'bridge-disabled'); }
        if (this._isCooling()) { this.audit.append('session-open-refused', { reason: 'cooling', coolingUntil: this.coolingUntil }); return this._err(res, 503, 'cooling', { coolingUntil: this.coolingUntil }); }
        if (this.session) { this.audit.append('session-open-refused', { reason: 'session-exists', existing: this.session.id }); return this._err(res, 409, 'session-exists', { sessionId: this.session.id }); }
        if (!nodeId || !(this.cfg.whitelist || []).includes(nodeId)) {
            this.audit.append('session-open-refused', { reason: 'node-not-whitelisted' });
            return this._err(res, 403, 'node-not-whitelisted');
        }
        const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex');
        this.session = { id: sessionId, nodeId, tokenId: a.rec.id, state: 'opening', kvm: null, replay: null, openedAt: Date.now(), lastActivityAt: Date.now(), counters: { mouse: 0, key: 0, text: 0, snapshot: 0 } };
        // --- fail-closed notify gate (E1/E3): the owner must be told and ACK
        // before ANY connection to the device is made. ---
        const ev = this.outbox.write('session-request', { sessionId, nodeId, openedBy: a.rec.id });
        this.audit.append('session-request-notified', { sessionId, nodeId, eventId: ev.eventId });
        const acked = await this.outbox.waitAck(ev.eventId, { timeoutMs: this.cfg.ackTimeoutMs, pollMs: this.cfg.ackPollMs });
        if (!acked) {
            this.audit.append('session-open-refused', { sessionId, nodeId, reason: 'notify-ack-timeout', eventId: ev.eventId });
            this.session = null; // a late ACK never retroactively allows this open
            return this._err(res, 503, 'notify-ack-required', { eventId: ev.eventId });
        }
        // --- connect to the device (control-channel double-check inside) ---
        try {
            const creds = mcSession.loadServiceCreds(this.cfg.secretStorePath);
            const replay = new SessionReplay(this.cfg.replayDir, sessionId, { maxBytes: this.cfg.replayMaxBytesPerSession, retentionDays: this.cfg.replayRetentionDays });
            const headerHash = replay.writeMeta({ sessionId, nodeId, openedBy: a.rec.id, credFingerprint: creds.fingerprint });
            const kvm = this.kvmFactory({
                nodeid: nodeId, creds, unicodeLE: !!this.cfg.unicodeLE,
                onTile: (t) => { if (this.session && this.session.replay && t.changed && t.x === 0 && t.y === 0) this.session.replay.recordFrame(t.hash, t.jpeg.length); },
                onEvent: (e) => { if (this.session && this.session.replay) this.session.replay.recordAction('kvm-event', { ev: e.ev }); },
            });
            this.session.kvm = kvm;
            this.session.replay = replay;
            this.session.headerHash = headerHash;
            await kvm.connect(30000);
            await kvm.settleInitialFrame();
            const snap = kvm.snapshot();
            this.session.state = 'live';
            this.session.lastActivityAt = Date.now();
            // Issue a view-only observe token bound to this session.
            const obs = TokenStore.generate('view', { idPrefix: 'obs' });
            obs.record.sessionId = sessionId;
            this.tokens.add(obs.record);
            this.session.observeTokenId = obs.record.id;
            this.audit.append('session-opened', { sessionId, nodeId, screenW: kvm.screenW, screenH: kvm.screenH, frameComplete: snap.frameComplete, screenState: kvm.screenState() });
            return this._json(res, 200, {
                ok: true, sessionId, observeToken: obs.plaintext,
                screen: { width: kvm.screenW, height: kvm.screenH },
                screenState: kvm.screenState(), frameComplete: snap.frameComplete,
            });
        } catch (e) {
            this.audit.append('session-open-failed', { sessionId, nodeId, error: e.message.slice(0, 200) });
            await this._closeSession('open-failed');
            return this._err(res, 502, 'kvm-connect-failed', { detail: e.message.slice(0, 200) });
        }
    }

    _getSession(id) {
        if (!this.session || this.session.id !== id) return null;
        return this.session;
    }
    _touch(sess) { sess.lastActivityAt = Date.now(); }

    _routeSessionStatus(req, res, id) {
        const a = this._auth(req);
        if (!a.ok) return this._err(res, a.code, a.error);
        const sess = this._getSession(id);
        if (!sess) return this._err(res, 404, 'session-not-found');
        const kvm = sess.kvm;
        this._json(res, 200, {
            ok: true, sessionId: id, state: sess.state, nodeId: sess.nodeId,
            openedAt: sess.openedAt, lastActivityAt: sess.lastActivityAt,
            counters: sess.counters,
            screen: kvm ? { width: kvm.screenW, height: kvm.screenH } : null,
            screenState: kvm ? kvm.screenState() : 'unknown',
            inputLocked: kvm ? kvm.inputLocked : null,
            frameComplete: kvm ? kvm.snapshot().frameComplete : false,
            controlEnabled: !!this.cfg.controlEnabled,
        });
    }

    async _routeSnapshot(req, res, id, u) {
        const a = this._auth(req, ['assistant', 'view']);
        if (!a.ok) return this._err(res, a.code, a.error);
        const sess = this._getSession(id);
        if (!sess) return this._err(res, 404, 'session-not-found');
        if (a.rec.role === 'view' && a.rec.sessionId && a.rec.sessionId !== id) return this._err(res, 403, 'observe-token-bound-elsewhere');
        if (sess.state !== 'live') return this._err(res, 409, 'session-not-live', { state: sess.state });
        if (this._isDisabled()) return this._err(res, 503, 'bridge-disabled');
        const maxw = u.searchParams.get('maxw') ? parseInt(u.searchParams.get('maxw'), 10) : null;
        const q = u.searchParams.get('q') ? parseInt(u.searchParams.get('q'), 10) : null;
        if ((maxw != null && (isNaN(maxw) || maxw < 480 || maxw > 2560)) || (q != null && (isNaN(q) || q < 30 || q > 90))) {
            return this._err(res, 400, 'bad-snapshot-params');
        }
        // Global concurrency 1 + per-session rate limit (2/s).
        const run = this.snapshotChain.then(async () => {
            const now = Date.now();
            const minGap = Math.floor(1000 / (this.cfg.snapshotRatePerSec || 2));
            const wait = this.lastSnapshotAt + minGap - now;
            if (wait > 0) await sleep(wait);
            this.lastSnapshotAt = Date.now();
            const kvm = sess.kvm;
            if (!kvm) throw new Error('no-kvm');
            await kvm.refresh();
            const snap = kvm.snapshot();
            this._touch(sess);
            sess.counters.snapshot++;
            this.audit.append('snapshot', { sessionId: id, ...snapshotDetail(snap.jpeg), frameComplete: snap.frameComplete });
            if (sess.replay && snap.jpeg) sess.replay.recordFrame(snap.hash, snap.jpeg.length);
            const resp = snapshotResponse(snap, { maxw, q });
            return resp;
        });
        this.snapshotChain = run.catch(() => {});
        let resp;
        try { resp = await run; } catch (e) { return this._err(res, 502, 'snapshot-failed', { detail: e.message.slice(0, 120) }); }
        if (!resp.jpeg) return this._err(res, 503, 'no-frame-yet');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': resp.jpeg.length, ...resp.headers });
        res.end(resp.jpeg);
    }

    async _routeMouse(req, res, id) {
        const a = this._auth(req, ['assistant']);
        if (!a.ok) return this._err(res, a.code, a.error);
        const sess = this._getSession(id);
        if (!sess) return this._err(res, 404, 'session-not-found');
        if (sess.tokenId !== a.rec.id) return this._err(res, 403, 'session-owned-by-other-token');
        if (!this.cfg.controlEnabled) return this._err(res, 409, 'control-disabled', { reason: 'P5 gate: 0d has not passed' });
        if (sess.state !== 'live') return this._err(res, 409, 'session-not-live', { state: sess.state });
        if (this._isDisabled()) return this._err(res, 503, 'bridge-disabled');
        let body;
        try { body = await this._readBody(req); } catch (e) { return this._err(res, 400, e.message); }
        const x = Number(body.x), y = Number(body.y);
        const action = String(body.action || 'click');
        const button = String(body.button || 'left');
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || !['click', 'move', 'down', 'up'].includes(action)) {
            return this._err(res, 400, 'bad-mouse-params');
        }
        const kvm = sess.kvm;
        if (!kvm || !kvm.input) return this._err(res, 502, 'no-input-channel');
        const btnDown = button === 'right' ? 0x08 : 0x02;
        const btnUp = button === 'right' ? 0x10 : 0x04;
        const before = kvm.snapshot();
        const changeP = kvm.waitChange(null, 3000);
        if (action === 'move') kvm.input.move(x, y);
        else if (action === 'down') kvm.input.down(btnDown, x, y);
        else if (action === 'up') kvm.input.up(btnUp, x, y);
        else kvm.input.click(x, y, btnDown, btnUp);
        const changed = await changeP;
        const after = kvm.snapshot();
        this._touch(sess);
        sess.counters.mouse++;
        const zone = zoneOf(x, y, kvm.screenW, kvm.screenH);
        this.audit.append('mouse', { sessionId: id, ...mouseDetail(zone, action), changed: !!changed });
        if (sess.replay) sess.replay.recordAction('mouse', { action, zone, changed: !!changed });
        this._json(res, 200, { ok: true, changed: !!changed, frameComplete: after.frameComplete, at: changed ? { x: changed.x, y: changed.y } : null });
    }

    async _routeKey(req, res, id) {
        const a = this._auth(req, ['assistant']);
        if (!a.ok) return this._err(res, a.code, a.error);
        const sess = this._getSession(id);
        if (!sess) return this._err(res, 404, 'session-not-found');
        if (sess.tokenId !== a.rec.id) return this._err(res, 403, 'session-owned-by-other-token');
        if (!this.cfg.controlEnabled) return this._err(res, 409, 'control-disabled', { reason: 'P5 gate: 0d has not passed' });
        if (sess.state !== 'live') return this._err(res, 409, 'session-not-live', { state: sess.state });
        if (this._isDisabled()) return this._err(res, 503, 'bridge-disabled');
        let body;
        try { body = await this._readBody(req); } catch (e) { return this._err(res, 400, e.message); }
        const kvm = sess.kvm;
        if (!kvm || !kvm.input) return this._err(res, 502, 'no-input-channel');
        const before = kvm.snapshot();
        const changeP = kvm.waitChange(null, 3000);
        const kind = String(body.kind || 'tap');
        if (kind === 'tap' && Number.isInteger(body.vk)) {
            kvm.input.keyTap(body.vk, { extended: !!body.extended });
        } else if (kind === 'combo' && Array.isArray(body.modifiers) && Number.isInteger(body.vk)) {
            kvm.input.keyCombo(body.modifiers, body.vk);
        } else if (kind === 'unicode' && typeof body.char === 'string' && body.char.length === 1) {
            kvm.input.keyUnicodeChar(body.char);
        } else {
            return this._err(res, 400, 'bad-key-params');
        }
        const changed = await changeP;
        const after = kvm.snapshot();
        this._touch(sess);
        sess.counters.key++;
        const printable = kind === 'unicode';
        this.audit.append('key', { sessionId: id, ...keyDetail(kind === 'tap' ? ('vk:' + body.vk) : kind, { printable }) });
        if (sess.replay) sess.replay.recordAction('key', { kind, changed: !!changed });
        this._json(res, 200, { ok: true, changed: !!changed, frameComplete: after.frameComplete });
    }

    async _routeText(req, res, id) {
        const a = this._auth(req, ['assistant']);
        if (!a.ok) return this._err(res, a.code, a.error);
        const sess = this._getSession(id);
        if (!sess) return this._err(res, 404, 'session-not-found');
        // /text is disabled by default (DESIGN §5) and stays disabled in this
        // build regardless of controlEnabled: text is the highest-risk input
        // (paste / IME) and is only reconsidered after the 0d unicode proof.
        this.audit.append('text-refused', { sessionId: id, reason: 'text-input-disabled' });
        return this._err(res, 403, 'text-input-disabled');
    }

    async _routeClose(req, res, id) {
        const a = this._auth(req, ['assistant']);
        if (!a.ok) return this._err(res, a.code, a.error);
        const sess = this._getSession(id);
        if (!sess) return this._json(res, 200, { ok: true, closed: true, already: true }); // idempotent
        if (sess.tokenId !== a.rec.id) return this._err(res, 403, 'session-owned-by-other-token');
        const rec = await this._closeSession('assistant-close');
        return this._json(res, 200, { ok: true, closed: true, close: rec });
    }

    async _routeKill(req, res) {
        const a = this._auth(req, ['assistant']);
        if (!a.ok) return this._err(res, a.code, a.error);
        const rec = await this._closeSession('local-kill');
        // Persistent DISABLED flag: clearing it requires a human deleting the
        // file on the server. Also starts the 5-minute cooling window.
        fs.writeFileSync(this.cfg.disabledPath, JSON.stringify({ by: a.rec.id, at: Date.now(), reason: 'local-kill' }) + '\n', { mode: 0o600 });
        this.coolingUntil = Date.now() + this.cfg.coolingMs;
        this._persistCooling();
        this.audit.append('bridge-killed', { by: a.rec.id, disabled: true, coolingUntil: this.coolingUntil });
        return this._json(res, 200, { ok: true, killed: true, disabled: true, close: rec });
    }

    async _routeOwnerKill(req, res) {
        const a = this._auth(req, ['owner']);
        if (!a.ok) return this._err(res, a.code, a.error);
        const rec = await this._closeSession('owner-remote-kill');
        this.coolingUntil = Date.now() + this.cfg.coolingMs;
        this._persistCooling();
        this.audit.append('owner-remote-kill', { by: a.rec.id, coolingUntil: this.coolingUntil });
        return this._json(res, 200, { ok: true, killed: true, close: rec });
    }

    async _routeAck(req, res) {
        const a = this._auth(req, ['assistant']);
        if (!a.ok) return this._err(res, a.code, a.error);
        let body;
        try { body = await this._readBody(req); } catch (e) { return this._err(res, 400, e.message); }
        if (!body.eventId) return this._err(res, 400, 'missing-eventId');
        const ack = this.outbox.ack(body.eventId, a.rec.id);
        if (!ack) return this._err(res, 404, 'event-not-found');
        this.audit.append('notify-acked', { eventId: body.eventId, by: a.rec.id });
        return this._json(res, 200, { ok: true, ack });
    }

    _routePending(req, res) {
        const a = this._auth(req, ['assistant']);
        if (!a.ok) return this._err(res, a.code, a.error);
        return this._json(res, 200, { ok: true, pending: this.outbox.pending() });
    }

    // View-only observe stream (DESIGN §5): MJPEG multipart over the
    // session-bound view token. Read-only by construction — no input route
    // accepts a view token. ~1 frame/s; ends when the session closes.
    async _routeObserveStream(req, res, tok) {
        const rec = this.tokens.verify(tok);
        if (!rec || rec.role !== 'view' || !rec.sessionId) return this._err(res, 401, 'bad-observe-token');
        const sess = this._getSession(rec.sessionId);
        if (!sess || sess.state !== 'live') return this._err(res, 404, 'session-not-live');
        const boundary = 'bridgeframe-' + crypto.randomBytes(6).toString('hex');
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=' + boundary,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        let closed = false;
        const timer = setInterval(() => {
            if (closed) return;
            const s = this.session;
            if (!s || s.id !== sess.id || s.state !== 'live' || !s.kvm) { end(); return; }
            const snap = s.kvm.snapshot();
            if (!snap.jpeg) return;
            try {
                res.write('--' + boundary + '\r\nContent-Type: image/jpeg\r\nContent-Length: ' + snap.jpeg.length + '\r\nX-Bridge-Frame-Complete: ' + snap.frameComplete + '\r\n\r\n');
                res.write(snap.jpeg);
                res.write('\r\n');
            } catch (e) { end(); }
        }, 1000);
        const end = () => {
            if (closed) return; closed = true;
            clearInterval(timer);
            try { res.write('--' + boundary + '--\r\n'); res.end(); } catch (e) {}
        };
        req.on('close', end);
        this.audit.append('observe-stream-opened', { sessionId: sess.id, tokenId: rec.id });
    }

    // ---------- session close (C4 close record) ----------
    async _closeSession(reason) {
        const sess = this.session;
        if (!sess) return null;
        this.session = null; // synchronous state change first
        sess.state = 'closing';
        try { if (sess.kvm) await sess.kvm.close(); } catch (e) {}
        // Revoke the session's observe token.
        if (sess.observeTokenId) { try { this.tokens.revoke(sess.observeTokenId); } catch (e) {} }
        let rec = null;
        if (sess.replay) {
            rec = sess.replay.close(reason, { ...sess.counters });
        }
        this.audit.append('session-closed', {
            sessionId: sess.id, nodeId: sess.nodeId, reason,
            openedAt: sess.openedAt, closedAt: Date.now(),
            counters: { ...sess.counters },
            closeAnchor: rec ? rec.closeAnchor : null,
            replayIncomplete: rec ? rec.incomplete : null,
        });
        return rec;
    }
}

// ---------- boot ----------
if (require.main === module) {
    const cfg = loadConfig();
    const bridge = new Bridge(cfg);
    bridge.start();
    const shutdown = async () => { try { await bridge.stop(); } catch (e) {} process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

module.exports = { Bridge, VERSION };
