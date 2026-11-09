'use strict';
// KVM session for the assistant control bridge.
//
// Adapted from mc-direct/desktop-test.js and the Step-0 fixture harness
// lib/bridge-harness.js (both live-proven against app.qfremote.top:8443 on
// 2026-10-29). Bridge-specific additions:
//   - full-frame tracking: the (0,0) tile is the agent's full-screen JPEG
//     (verified 1920x1088 on recorded 2026-10-29 tiles); snapshot() returns
//     that frame as-is (server has no JPEG codec, so no rescale/re-encode
//     in this build — see frame-assembler.js; maxw/q are validated and the
//     actual width/quality are reported in the response headers).
//   - screenState heuristic (unknown/locked/desktop), conservative: any
//     doubt reads as non-desktop and input stays off.
//   - input lock query is sent at init (viewer parity); cmd 87 replies are
//     parsed per the viewer source (5 bytes, lock = byte 4 != 0) and tracked
//     as inputLocked (null until the first reply arrives).
//   - onTile/onEvent callbacks feed the audit/replay recorders.
//
// Input discipline (DESIGN §6.1/§6.2, harness-proven byte vectors):
//   - move 50 ms throttle, keep-last-point; any down/up/click/key first
//     synchronously flushes the pending move (F27).
//   - click = flush + down + up, serial.
//   - key sequences end with a forced keyup sweep of all modifier VKs.
//   - KEYUNICODE cmd 85: UTF-16 code unit, big-endian by default; the
//     byte order is UNPROVEN until the fixture single-char test (0d) —
//     flip with unicodeLE=true only on fixture evidence.
const crypto = require('crypto');
const mc = require('./mc-session');
const wsmod = require('./ws-client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hashBuf(b) { return crypto.createHash('md5').update(b).digest('hex'); }

const B = (...bytes) => Buffer.from(bytes);
const shortBE = (x) => B((x >> 8) & 0xFF, x & 0xFF);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

// ---------------- protocol encoders (pure; offline-tested) ----------------
function makeEnc(unicodeLE) {
    return {
        compression: () => Buffer.concat([B(0x00, 0x05, 0x00, 0x0A, 1, 50), shortBE(1024), shortBE(100)]), // JPEG q50 / scale 1024 / frame timer 100ms
        unpause: () => B(0x00, 0x08, 0x00, 0x05, 0x00),
        inputLockQuery: () => B(0x00, 87, 0x00, 0x05, 0x02),
        getDisplays: () => B(0x00, 0x0E, 0x00, 0x04),
        refresh: () => B(0x00, 0x06, 0x00, 0x04),
        key: (up, kc) => B(0x00, 0x01, 0x00, 0x06, up, kc), // up: 0 down, 1 up, 3 ex-up, 4 ex-down
        keyUnicode: (action, codeUnit) => { // action: 0 down, 1 up; codeUnit: UTF-16 code unit
            const cu = unicodeLE ? B(codeUnit & 0xFF, (codeUnit >> 8) & 0xFF) : shortBE(codeUnit);
            return Buffer.concat([B(0x00, 85, 0x00, 0x07, action), cu]);
        },
        mouse: (btn, x, y) => Buffer.concat([B(0x00, 0x02, 0x00, 0x0A, 0x00, btn), shortBE(x), shortBE(y)]),
    };
}
const VK = { SHIFT: 16, CTRL: 17, ALT: 18, LWIN: 91, RWIN: 92, ENTER: 13, ESC: 27, TAB: 9, SPACE: 32, BACKSPACE: 8, F12: 123 };
const MODIFIER_VKS = [VK.SHIFT, VK.CTRL, VK.ALT, VK.LWIN, VK.RWIN];

// ---------------- input channel (§6.1 throttle + F27 flush) ----------------
class InputChannel {
    constructor(sendBinary, { throttleMs = 50, screenW = 1920, screenH = 1080, unicodeLE = false, onEmit = null } = {}) {
        this.send = sendBinary; this.throttleMs = throttleMs;
        this.screenW = screenW; this.screenH = screenH;
        this.pendingMove = null; this.timer = null; this.onEmit = onEmit;
        this.enc = makeEnc(unicodeLE);
    }
    _emit(kind, buf) { if (this.onEmit) this.onEmit(kind, buf); this.send(buf); }
    _emitMove(m) { this._emit('move', this.enc.mouse(0x00, clamp(m.x, 0, this.screenW - 1), clamp(m.y, 0, this.screenH - 1))); }
    move(x, y) {
        this.pendingMove = { x, y }; // keep-last-point
        if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.throttleMs);
    }
    flush() { // F27: flush pending move before any key-class action
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.pendingMove) { const m = this.pendingMove; this.pendingMove = null; this._emitMove(m); }
    }
    down(btn, x, y) { this.flush(); this._emit('down', this.enc.mouse(btn, clamp(x, 0, this.screenW - 1), clamp(y, 0, this.screenH - 1))); }
    up(btn, x, y) { this.flush(); this._emit('up', this.enc.mouse(btn, clamp(x, 0, this.screenW - 1), clamp(y, 0, this.screenH - 1))); }
    click(x, y, btn = 0x02, upBtn = 0x04) { this.down(btn, x, y); this.up(upBtn, x, y); } // click = move(flush)+down+up serial
    key(up, kc) { this.flush(); this._emit('key', this.enc.key(up, kc)); }
    keyTap(kc, { extended = false } = {}) { this.key(extended ? 4 : 0, kc); this.key(extended ? 3 : 1, kc); }
    keyCombo(modVks, kc) { // modifiers down (caller order) -> main key tap -> modifiers up (reverse)
        for (const m of modVks) this.key(m === VK.LWIN || m === VK.RWIN ? 4 : 0, m);
        this.keyTap(kc);
        for (const m of [...modVks].reverse()) this.key(m === VK.LWIN || m === VK.RWIN ? 3 : 1, m);
        this.releaseAllModifiers();
    }
    keyUnicodeChar(ch) { this.flush(); const cu = ch.charCodeAt(0); this._emit('unicode', this.enc.keyUnicode(0, cu)); this._emit('unicode', this.enc.keyUnicode(1, cu)); }
    typeUnicode(str) { for (const ch of str) this.keyUnicodeChar(ch); this.releaseAllModifiers(); } // per UTF-16 code unit (agent pairs surrogates)
    releaseAllModifiers() { for (const kc of MODIFIER_VKS) this._emit('key', this.enc.key(1, kc)); } // §6.2 forced sweep at sequence end
}

// ---------------- KVM session ----------------
class KvmSession {
    constructor({ nodeid, creds, throttleMs = 50, unicodeLE = false, onTile = null, onEvent = null } = {}) {
        if (!nodeid || !/^node\/\//.test(nodeid)) throw new Error('nodeid must be a full node// id');
        this.nodeid = nodeid;
        this.creds = creds;
        this.throttleMs = throttleMs;
        this.unicodeLE = unicodeLE;
        this.onTile = onTile;   // (tile) => void; tile = {x, y, jpeg, hash, seq, t}
        this.onEvent = onEvent; // (event) => void; event = {t, ev, ...}
        this.enc = makeEnc(unicodeLE);
        this.tiles = new Map(); // "x,y" -> {x, y, hash, seq, jpegLen}
        this.fullFrame = null;  // {jpeg: Buffer, hash, w, h, t} — the (0,0) tile, i.e. the whole screen
        this.tileSeq = 0; this.tileMsgs = 0; this.tileBytes = 0;
        this.lastTileAt = 0; this.firstTileAt = 0; this.lastFullRefreshAt = 0;
        this.screenW = 0; this.screenH = 0;
        this.paired = false; this.closed = false; this.closeAt = 0;
        this.inputLocked = null; // null = not yet reported by the agent; true/false once cmd 87 arrives
        this.changeWaiters = [];
        this.input = null;
        this.carry = Buffer.alloc(0); // binary reassembly buffer (also usable pre-connect, e.g. in tests)
    }
    _log(ev, extra = {}) { if (this.onEvent) this.onEvent({ t: Date.now(), ev, ...extra }); }

    async connect(timeoutMs = 30000) {
        const login = await mc.login(this.creds.user, this.creds.pass);
        if (!login.jar.size) throw new Error('AUTH_FAIL: login issued no xid');
        this.cookieHeader = login.cookieHeader;
        this.ctrl = await mc.connectControl(this.cookieHeader);
        this.authCookie = ''; this.relayCookie = '';
        this.ctrlWaiters = [];
        this.ctrl.onmessage = (data, isBinary) => {
            if (isBinary) return; let m; try { m = JSON.parse(data); } catch (e) { return; }
            if (m.action === 'ping') { this.ctrl.sendText(JSON.stringify({ action: 'pong' })); return; }
            if (m.action === 'authcookie') { this.authCookie = m.cookie || ''; this.relayCookie = m.rcookie || ''; }
            for (let i = this.ctrlWaiters.length - 1; i >= 0; i--) { if (this.ctrlWaiters[i].pred(m)) { this.ctrlWaiters[i].res(m); this.ctrlWaiters.splice(i, 1); } }
        };
        this.ctrlPing = setInterval(() => { try { this.ctrl.sendText(JSON.stringify({ action: 'ping' })); } catch (e) {} }, 29000); // control channel 29 s (0b)
        this.ctrl.sendText(JSON.stringify({ action: 'authcookie' }));
        const dl = Date.now() + 8000;
        while (!this.authCookie && Date.now() < dl) await sleep(100);
        if (!this.authCookie) throw new Error('CONTROL_FAIL: no authcookie');
        // Nodes list, read-only: confirm the target is in the visible set
        // (the bridge-side double-check; the account itself only sees its
        // own devices, so an empty/invisible target here is a hard stop).
        this.ctrl.sendText(JSON.stringify({ action: 'nodes' }));
        const nodesMsg = await new Promise((res) => { this.ctrlWaiters.push({ pred: (m) => m.action === 'nodes', res }); setTimeout(() => res(null), 8000); });
        this.nodesSeen = (nodesMsg && nodesMsg.nodes) ? Object.keys(nodesMsg.nodes) : [];
        if (!this.nodesSeen.includes(this.nodeid)) throw new Error('NODE_NOT_VISIBLE: target nodeid not in control-channel visible set');
        // Relay connect (four steps, mc-direct README §3).
        const tunnelid = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
        this.relay = await mc.connectRelay(this.cookieHeader, this.nodeid, tunnelid, this.authCookie);
        try { this.relay.sendText(JSON.stringify({ ctrlChannel: 102938, type: 'rtt', time: Date.now() })); } catch (e) {}
        const rurl = '*/meshrelay.ashx?p=2&nodeid=' + this.nodeid + '&id=' + tunnelid + (this.relayCookie ? ('&rauth=' + this.relayCookie) : '');
        this.ctrl.sendText(JSON.stringify({ action: 'msg', type: 'tunnel', nodeid: this.nodeid, value: rurl, usage: 2 }));
        this.carry = Buffer.alloc(0); this.rttWaiters = new Map();
        this.relay.onmessage = (data, isBinary) => this._onRelay(data, isBinary);
        this.relay.onclose = () => { this.closed = true; this.closeAt = Date.now(); this._log('relay-closed'); };
        this.rttKeepalive = setInterval(() => { // relay 10 s rtt probe (0b); missing it drops the session after ~51 s
            const t = Date.now(); if (!this.rttWaiters.has(t)) this.rttWaiters.set(t, () => {});
            try { this.relay.sendText(JSON.stringify({ ctrlChannel: 102938, type: 'rtt', time: t })); } catch (e) {}
        }, 10000);
        const pairDl = Date.now() + timeoutMs;
        while ((!this.paired || !this.screenW) && Date.now() < pairDl) await sleep(100);
        if (!this.paired) throw new Error('RELAY_TIMEOUT: agent never paired (device offline?)');
        if (!this.screenW) throw new Error('RELAY_TIMEOUT: no screen size');
        this.input = new InputChannel((buf) => this.relay.sendBinary(buf), { throttleMs: this.throttleMs, screenW: this.screenW, screenH: this.screenH, unicodeLE: this.unicodeLE });
        this._log('connected', { screenW: this.screenW, screenH: this.screenH, nodesSeen: this.nodesSeen.length });
        return this;
    }

    _onRelay(data, isBinary) {
        if (!isBinary) {
            const s = String(data);
            if (s === 'c' || s === 'cr') {
                if (!this.paired) { this.paired = true; this.relay.sendText(JSON.stringify({ type: 'options' })); this.relay.sendText('2'); }
                return;
            }
            if (s[0] === '~') { this._log('module-text', { text: s.slice(0, 100) }); return; }
            try {
                const m = JSON.parse(s);
                if (m && m.ctrlChannel === '102938') {
                    if (m.type === 'rtt' && this.rttWaiters.has(m.time)) { const r = this.rttWaiters.get(m.time); this.rttWaiters.delete(m.time); r(Date.now()); }
                    else if (m.type === 'ping') { this.relay.sendText('{"ctrlChannel":"102938","type":"pong"}'); }
                    else if (m.type === 'console') { this._log('console', { msg: String(m.msg).slice(0, 160) }); }
                }
            } catch (e) { /* non-JSON text ignored */ }
            return;
        }
        this._feedBinary(data);
    }

    _feedBinary(data) {
        this.carry = Buffer.concat([this.carry, data]);
        for (;;) {
            if (this.carry.length < 4) return;
            const cmd = (this.carry[0] << 8) + this.carry[1], size = (this.carry[2] << 8) + this.carry[3];
            if (cmd === 27 && size === 8) { // jumbo wrapper
                if (this.carry.length < 12) return;
                const realSize = (this.carry[5] << 16) + (this.carry[6] << 8) + this.carry[7];
                if (this.carry.length < realSize + 8) return;
                const inner = this.carry.slice(8, 8 + realSize);
                const icmd = (this.carry[8] << 8) + this.carry[9];
                this._handleCommand(inner, icmd, realSize);
                this.carry = this.carry.slice(8 + realSize); continue;
            }
            if (size < 4 || size > this.carry.length) {
                if (size > this.carry.length && size < 8 * 1024 * 1024) return; // wait for more (fragmented command)
                this.carry = Buffer.alloc(0); return; // padding/garbage: drop
            }
            const view = this.carry.slice(0, size);
            this._handleCommand(view, cmd, size);
            this.carry = this.carry.slice(size);
            if (this.carry.length >= 4) { const nz = (this.carry[2] << 8) + this.carry[3]; if (nz === 0 && this.carry.slice(0, Math.min(8, this.carry.length)).every((b) => b === 0)) { this.carry = this.carry.slice(Math.min(8, this.carry.length)); } }
        }
    }

    _handleCommand(view, cmd, cmdsize) {
        if (cmd === 3) { // tile
            const x = (view[4] << 8) + view[5], y = (view[6] << 8) + view[7];
            const jpeg = view.slice(8, cmdsize);
            const h = hashBuf(jpeg); const key = x + ',' + y;
            const prev = this.tiles.get(key);
            const changed = !prev || prev.hash !== h;
            if (changed || !prev) {
                this.tiles.set(key, { x, y, hash: h, seq: this.tileSeq, jpegLen: jpeg.length });
                if (x === 0 && y === 0) {
                    // The (0,0) tile is the agent's full-screen frame.
                    this.fullFrame = { jpeg: Buffer.from(jpeg), hash: h, w: this.screenW, h: this.screenH, t: Date.now() };
                }
            }
            this.tileSeq++; this.tileMsgs++; this.tileBytes += jpeg.length; this.lastTileAt = Date.now();
            if (!this.firstTileAt) this.firstTileAt = this.lastTileAt;
            if (this.onTile) this.onTile({ x, y, jpeg, hash: h, seq: this.tileSeq - 1, t: this.lastTileAt, changed });
            if (changed) this._notifyChange(x, y, this.lastTileAt);
            return;
        }
        if (cmd === 7) { // screen size -> init sequence (viewer parity)
            this.screenW = (view[4] << 8) + view[5]; this.screenH = (view[6] << 8) + view[7];
            if (!this.initSent) {
                this.initSent = true;
                const rk = this.relay;
                rk.sendBinary(this.enc.compression()); rk.sendBinary(this.enc.unpause()); rk.sendBinary(this.enc.inputLockQuery());
                for (const kc of [16, 17, 18, 91, 92, 16]) rk.sendBinary(this.enc.key(1, kc));
                rk.sendBinary(this.enc.getDisplays());
            }
            return;
        }
        if (cmd === 17) { this._log('agent-message', { text: view.slice(4, cmdsize).toString('utf8').slice(0, 160) }); return; }
        if (cmd === 65) { this._log('agent-alert', { text: view.slice(4, cmdsize).toString('utf8').slice(0, 160) }); return; }
        if (cmd === 87) { // MNG_KVM_INPUT_LOCK — viewer-proven (agent-desktop-0.0.2.js:304-310):
            // reply is exactly 5 bytes; lock state is byte 4 (non-zero = locked).
            if (cmdsize === 5) {
                const locked = view[4] !== 0;
                if (this.inputLocked !== locked) { this.inputLocked = locked; this._log('input-lock-changed', { locked }); }
            } else { this._log('input-lock-reply', { len: cmdsize }); }
            return;
        }
        if (cmd === 11 || cmd === 12 || cmd === 14 || cmd === 18 || cmd === 82 || cmd === 88) return; // known, ignore
        this._log('other-cmd', { cmd, size: cmdsize });
    }

    _notifyChange(x, y, t) {
        for (let i = this.changeWaiters.length - 1; i >= 0; i--) {
            const w = this.changeWaiters[i];
            if (w.region && !w.region(x, y)) continue;
            this.changeWaiters.splice(i, 1); w.res({ t, x, y });
        }
    }
    waitChange(region, timeoutMs) {
        return new Promise((res) => {
            const w = { region, res }; this.changeWaiters.push(w);
            setTimeout(() => { const i = this.changeWaiters.indexOf(w); if (i >= 0) { this.changeWaiters.splice(i, 1); res(null); } }, timeoutMs);
        });
    }
    async settle(quietMs, maxMs) {
        const start = Date.now();
        while (Date.now() - start < maxMs) { await sleep(100); if (Date.now() - this.lastTileAt >= quietMs) break; }
    }
    async refresh() {
        if (!this.relay) throw new Error('not connected');
        this.lastFullRefreshAt = Date.now();
        this.relay.sendBinary(this.enc.refresh());
        await this.settle(2000, 12000);
    }
    // Wait for the initial full frame to settle, then force a refresh so the
    // first snapshot is a complete, quiet frame (0c baseline).
    async settleInitialFrame() {
        const dl = Date.now() + 30000;
        while (Date.now() < dl) { if (this.tiles.has('0,0') && Date.now() - this.lastTileAt >= 2500) break; await sleep(150); }
        await this.refresh();
    }

    // Snapshot semantics (P4, view-only): the latest full-frame (0,0) tile.
    // frameComplete = a (0,0) frame exists AND the tile stream has been quiet
    // for >= quietMs (default 1500 ms). If not complete, the caller still gets
    // the latest frame but frameComplete=false — never a fabricated frame.
    snapshot({ quietMs = 1500 } = {}) {
        const f = this.fullFrame;
        const quiet = this.lastTileAt ? (Date.now() - this.lastTileAt) : Infinity;
        return {
            jpeg: f ? f.jpeg : null,
            hash: f ? f.hash : null,
            width: this.screenW, height: this.screenH,
            frameComplete: !!(f && quiet >= quietMs),
            capturedAt: f ? f.t : null,
            lastTileAt: this.lastTileAt || null,
            lastFullRefreshAt: this.lastFullRefreshAt || null,
            tileCount: this.tiles.size, tileMsgs: this.tileMsgs, tileBytes: this.tileBytes,
        };
    }

    // Conservative screen-state heuristic (DESIGN §5). Any doubt -> non-desktop.
    // 'unknown': no frame yet. 'locked': frame is (near-)uniform black.
    // 'desktop': a non-uniform frame exists. Input is gated off independently
    // until P5, so this never authorises an action by itself.
    screenState() {
        const f = this.fullFrame;
        if (!f) return 'unknown';
        const b = f.jpeg;
        // Sample the frame bytes: a locked/off screen compresses to a tiny,
        // near-uniform JPEG. Threshold is deliberately conservative.
        if (b.length < 4000) {
            let distinct = 0; const seen = new Set();
            for (let i = 0; i < b.length; i += 97) { seen.add(b[i]); if (seen.size > 24) break; }
            distinct = seen.size;
            if (distinct <= 24) return 'locked';
        }
        return 'desktop';
    }

    async close() {
        try { this.input && this.input.releaseAllModifiers(); } catch (e) {}
        try { this.relay && this.relay.sendText('{"ctrlChannel":"102938","type":"close"}'); } catch (e) {}
        clearInterval(this.rttKeepalive); clearInterval(this.ctrlPing);
        try { this.relay && this.relay.close(); } catch (e) {}
        try { this.ctrl && this.ctrl.close(); } catch (e) {}
        this.closed = true; this.closeAt = Date.now();
        await sleep(200);
    }
}

module.exports = { makeEnc, VK, MODIFIER_VKS, InputChannel, KvmSession, hashBuf };
