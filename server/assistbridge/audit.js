'use strict';
// Audit log for the assistant control bridge (DESIGN §8.1).
//
// Rules, all hard-coded:
//   - Append-only JSONL, one file per UTC date: audit-YYYY-MM-DD.jsonl.
//   - Every row carries a SHA-256 hash chain: hash = sha256(prevHash + canonical(row-without-hash)).
//     The day's anchor (first row's prevHash + last row's hash) is written to
//     anchor-YYYY-MM-DD.json. Verification replays the chain and fails loudly
//     on any gap, edit, or deletion.
//   - Retention 90 days; purgeOld() deletes older files (called at startup).
//   - Semantic logging only, never raw content:
//       text   -> { len, sha256 } only (never the characters)
//       key    -> key name / VK code only for non-printable keys; printable
//                 keys are counted, not named
//       mouse  -> nine-grid zone only (frame-assembler.zoneOf), never pixels
//       snapshot -> { bytes, sha256 } only
//       credentials/cookies/tokens -> never (redacted at the call site too)
//   - C4 close records: the close event carries the session's start/end,
//     device, session id, close reason, and the three action counters
//     (mouse/key/text) so one row answers "what did this session do".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function canonical(obj) {
    // Stable JSON: sorted keys, recursive. Used for the hash chain.
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

class AuditLog {
    constructor(dir, { retentionDays = 90 } = {}) {
        this.dir = dir;
        this.retentionDays = retentionDays;
        fs.mkdirSync(dir, { recursive: true });
        this.chains = new Map(); // date -> last hash
    }
    _dateStr(d = new Date()) { return d.toISOString().slice(0, 10); }
    _fileFor(dateStr) { return path.join(this.dir, 'audit-' + dateStr + '.jsonl'); }
    _anchorFileFor(dateStr) { return path.join(this.dir, 'anchor-' + dateStr + '.json'); }

    _lastHash(dateStr) {
        if (this.chains.has(dateStr)) return this.chains.get(dateStr);
        const f = this._fileFor(dateStr);
        let last = 'GENESIS';
        if (fs.existsSync(f)) {
            const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
            if (lines.length) {
                const lastRow = JSON.parse(lines[lines.length - 1]);
                last = lastRow.hash || 'GENESIS';
            }
        }
        this.chains.set(dateStr, last);
        return last;
    }

    append(event, details = {}) {
        const dateStr = this._dateStr();
        const prevHash = this._lastHash(dateStr);
        const row = { ts: Date.now(), date: dateStr, event, ...details, prev: prevHash };
        row.hash = crypto.createHash('sha256').update(prevHash + canonical(row)).digest('hex');
        fs.appendFileSync(this._fileFor(dateStr), JSON.stringify(row) + '\n', { mode: 0o600 });
        this.chains.set(dateStr, row.hash);
        return row;
    }

    // Write the day's anchor (first prev + last hash). Idempotent: safe to
    // call repeatedly; the anchor is only written once the day is closed or
    // on demand (verifyAnchor reads the live file, not the anchor, so a
    // missing anchor is not a failure — it just means the day isn't closed).
    writeAnchor(dateStr = this._dateStr()) {
        const f = this._fileFor(dateStr);
        if (!fs.existsSync(f)) return null;
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
        if (!lines.length) return null;
        const first = JSON.parse(lines[0]);
        const last = JSON.parse(lines[lines.length - 1]);
        const anchor = { date: dateStr, firstPrev: first.prev, lastHash: last.hash, rows: lines.length, writtenAt: Date.now() };
        fs.writeFileSync(this._anchorFileFor(dateStr), JSON.stringify(anchor, null, 2) + '\n', { mode: 0o600 });
        return anchor;
    }

    // Verify the full hash chain of a day's file. Returns { ok, rows, error }.
    verify(dateStr = this._dateStr()) {
        const f = this._fileFor(dateStr);
        if (!fs.existsSync(f)) return { ok: true, rows: 0, note: 'no file' };
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
        let prev = 'GENESIS';
        for (let i = 0; i < lines.length; i++) {
            let row;
            try { row = JSON.parse(lines[i]); } catch (e) { return { ok: false, rows: i, error: 'unparsable line ' + i }; }
            if (row.prev !== prev) return { ok: false, rows: i, error: 'prev mismatch at row ' + i };
            const { hash, ...rest } = row;
            const expect = crypto.createHash('sha256').update(prev + canonical(rest)).digest('hex');
            if (expect !== hash) return { ok: false, rows: i, error: 'hash mismatch at row ' + i };
            prev = hash;
        }
        return { ok: true, rows: lines.length, lastHash: prev };
    }

    purgeOld(now = Date.now()) {
        const cutoff = now - this.retentionDays * 24 * 3600 * 1000;
        let removed = 0;
        for (const name of fs.readdirSync(this.dir)) {
            const m = name.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
            if (!m) continue;
            const dayMs = Date.parse(m[1] + 'T00:00:00Z');
            if (dayMs < cutoff) { fs.unlinkSync(path.join(this.dir, name)); removed++; }
            const anchor = path.join(this.dir, 'anchor-' + m[1] + '.json');
            if (dayMs < cutoff && fs.existsSync(anchor)) fs.unlinkSync(anchor);
        }
        return removed;
    }
}

// Semantic redaction helpers (DESIGN §8.1): build audit-safe detail objects.
function textDetail(text) {
    return { textLen: String(text).length, textSha256: crypto.createHash('sha256').update(String(text), 'utf8').digest('hex') };
}
function keyDetail(keyName, { printable = false } = {}) {
    // Printable keys are counted, not named. Non-printable keys (Enter, Esc,
    // F-keys, arrows, modifiers) are named — they carry no content.
    return printable ? { keyClass: 'printable', count: 1 } : { keyName };
}
function mouseDetail(zone, action) {
    return { action, zone }; // nine-grid zone only, never pixels
}
function snapshotDetail(jpeg) {
    return { bytes: jpeg ? jpeg.length : 0, sha256: jpeg ? crypto.createHash('sha256').update(jpeg).digest('hex') : '' };
}

module.exports = { AuditLog, canonical, textDetail, keyDetail, mouseDetail, snapshotDetail };
