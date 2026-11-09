'use strict';
// Minimal RFC6455 WebSocket client for Node (zero dependencies, no browser).
// Supports: TLS (wss) with self-signed certs, client frame masking,
// fragmentation reassembly, ping->pong, 16/64-bit payload lengths.
//
// Provenance: adapted from mc-direct/ws.js (2026-10-29 live-proven against
// app.qfremote.top:8443). Byte-level behaviour unchanged; only the header
// comment and the User-Agent string are bridge-specific.
const https = require('https');
const crypto = require('crypto');

function connect(urlStr, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const key = crypto.randomBytes(16).toString('base64');
        const req = https.request({
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method: 'GET',
            rejectUnauthorized: false,
            headers: Object.assign({
                'Connection': 'Upgrade',
                'Upgrade': 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': key,
            }, headers),
        });
        req.on('upgrade', (res, socket, head) => {
            if (res.statusCode !== 101) { reject(new Error('WS upgrade failed: ' + res.statusCode)); socket.destroy(); return; }
            const ws = new WS(socket, head);
            resolve(ws);
        });
        req.on('response', (res) => { reject(new Error('WS upgrade refused, HTTP ' + res.statusCode)); });
        req.on('error', reject);
        req.end();
    });
}

class WS {
    constructor(socket, head) {
        this.socket = socket;
        this.buf = (head && head.length) ? head : Buffer.alloc(0);
        this.fragOpcode = -1;
        this.fragChunks = [];
        this.onmessage = null; // (data, isBinary)
        this.onclose = null;
        this.closed = false;
        socket.on('data', (d) => this._feed(d));
        socket.on('close', () => this._emitClose());
        socket.on('error', () => this._emitClose());
        if (this.buf.length) { const b = this.buf; this.buf = Buffer.alloc(0); this._feed(b); }
    }
    _emitClose() { if (!this.closed) { this.closed = true; if (this.onclose) this.onclose(); } }
    _feed(d) {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
            if (this.buf.length < 2) return;
            const b0 = this.buf[0], b1 = this.buf[1];
            const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f, off = 2;
            if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (this.buf.length < 10) return; const v = this.buf.readBigUInt64BE(2); if (v > BigInt(64 * 1024 * 1024)) { this.socket.destroy(); return; } len = Number(v); off = 10; }
            let maskKey = null;
            if (masked) { if (this.buf.length < off + 4) return; maskKey = this.buf.slice(off, off + 4); off += 4; }
            if (this.buf.length < off + len) return;
            let payload = this.buf.slice(off, off + len);
            this.buf = this.buf.slice(off + len);
            if (maskKey) { const p = Buffer.alloc(len); for (let i = 0; i < len; i++) p[i] = payload[i] ^ maskKey[i & 3]; payload = p; }
            if (opcode === 9) { this._sendFrame(10, payload); continue; } // ping -> pong
            if (opcode === 10) { continue; } // pong
            if (opcode === 8) { this._emitClose(); try { this.socket.end(); } catch (e) {} return; }
            if (opcode === 0) { // continuation
                this.fragChunks.push(payload);
                if (fin) { const full = Buffer.concat(this.fragChunks); const op = this.fragOpcode; this.fragChunks = []; this.fragOpcode = -1; this._deliver(full, op); }
                continue;
            }
            // opcode 1 (text) or 2 (binary)
            if (!fin) { this.fragOpcode = opcode; this.fragChunks = [payload]; continue; }
            this._deliver(payload, opcode);
        }
    }
    _deliver(payload, opcode) {
        if (!this.onmessage) return;
        if (opcode === 1) this.onmessage(payload.toString('utf8'), false);
        else this.onmessage(payload, true);
    }
    _sendFrame(opcode, payload) {
        if (this.closed) return;
        if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
        const mask = crypto.randomBytes(4);
        const len = payload.length;
        let head;
        if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
        else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
        else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
        head[0] = 0x80 | opcode;
        const masked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
        try { this.socket.write(Buffer.concat([head, mask, masked])); } catch (e) {}
    }
    sendText(str) { this._sendFrame(1, Buffer.from(String(str), 'utf8')); }
    sendBinary(buf) { this._sendFrame(2, buf); }
    close() { try { this._sendFrame(8, Buffer.alloc(0)); } catch (e) {} try { this.socket.end(); } catch (e) {} this._emitClose(); }
}

module.exports = { connect };
