'use strict';
// Token verification for the assistant control bridge (DESIGN §5).
//
// Tokens are stored ONLY as SHA-256 hashes in the tokens file
// (bridge-tokens.json, 0600, owned by the bridge user):
//   { "tokens": [ { "id": "tok_…", "role": "assistant"|"view"|"owner",
//                   "sha256": "<hex>", "created": <ms>, "revoked": false } ] }
// Plaintext tokens exist only in the operator's secure store (same rule as
// the station-master assistant token) and are NEVER logged, printed, or
// written to any other file. Revocation = set revoked:true (or delete the
// entry) and reload — no bridge restart needed (reload() is called on every
// verify if the file mtime changed).
//
// Roles:
//   assistant — full bridge API (open/snapshot/input/close/kill/ack).
//   view      — snapshot + observe stream only, bound to one session.
//   owner     — owner-remote-kill only (station-master independent auth).
// Session tokens: each session records the token id that opened it; a token
// may not operate another session's resources.
const fs = require('fs');
const crypto = require('crypto');

function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

class TokenStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.mtimeMs = 0;
        this.tokens = []; // [{id, role, sha256, created, revoked}]
        this._load(true);
    }
    _load(force = false) {
        let st;
        try { st = fs.statSync(this.filePath); } catch (e) { this.tokens = []; this.mtimeMs = 0; return; }
        if (!force && st.mtimeMs === this.mtimeMs) return;
        this.mtimeMs = st.mtimeMs;
        const doc = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.tokens = Array.isArray(doc.tokens) ? doc.tokens : [];
    }
    reload() { this._load(true); }
    // Returns the token record on success, null on failure. Uses a
    // timing-safe comparison against every stored hash (no early exit on id).
    verify(plaintext) {
        if (!plaintext || typeof plaintext !== 'string') return null;
        this._load();
        const want = sha256hex(plaintext);
        const wantBuf = Buffer.from(want, 'hex');
        let found = null;
        for (const t of this.tokens) {
            if (t.revoked) continue;
            if (typeof t.sha256 !== 'string' || t.sha256.length !== 64) continue;
            const haveBuf = Buffer.from(t.sha256, 'hex');
            if (haveBuf.length === wantBuf.length && crypto.timingSafeEqual(haveBuf, wantBuf)) found = t;
        }
        return found;
    }
    // Generate a new token: returns { plaintext, record }. The caller must
    // deliver `plaintext` to the operator's secure store and NEVER log it.
    // This method only writes the HASH to the tokens file.
    static generate(role, { idPrefix = 'tok' } = {}) {
        const plaintext = crypto.randomBytes(32).toString('base64url');
        const record = { id: idPrefix + '_' + crypto.randomBytes(6).toString('hex'), role, sha256: sha256hex(plaintext), created: Date.now(), revoked: false };
        return { plaintext, record };
    }
    add(record) {
        this._load(true);
        this.tokens.push(record);
        this._save();
    }
    revoke(id) {
        this._load(true);
        let changed = false;
        for (const t of this.tokens) { if (t.id === id && !t.revoked) { t.revoked = true; changed = true; } }
        if (changed) this._save();
        return changed;
    }
    _save() {
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ tokens: this.tokens }, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, this.filePath);
        this.mtimeMs = fs.statSync(this.filePath).mtimeMs;
    }
    list() { this._load(); return this.tokens.map((t) => ({ id: t.id, role: t.role, created: t.created, revoked: !!t.revoked })); }
}

// Extract a bearer token from a request: Authorization: Bearer <tok>, or
// X-Bridge-Token: <tok>. Returns the plaintext (never logged by callers).
function extractToken(req) {
    const h = req.headers || {};
    const auth = h.authorization || h.Authorization || '';
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    if (h['x-bridge-token']) return String(h['x-bridge-token']).trim();
    return null;
}

module.exports = { TokenStore, sha256hex, extractToken };
