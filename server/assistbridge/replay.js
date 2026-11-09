'use strict';
// Session replay record for the assistant control bridge (P3, DESIGN §8.3 C7).
//
// Per session, a record directory holds:
//   meta.json      — session id, node id, openedAt, opener token id, header
//                    hash (sha256 of the canonical open record; anchors the
//                    whole session's chain).
//   frames.jsonl   — one line per recorded frame: {t (monotonic ms since
//                    open), sha256 (of the frame JPEG bytes), bytes}.
//                    Frame BYTES are not stored (no screen content at rest);
//                    the hash chain is what proves continuity.
//   actions.jsonl  — one line per semantic action: {t (monotonic), kind,
//                    detail} where detail is audit-safe (zone / key name /
//                    text length+hash — same redaction as the audit log).
//   close.json     — close anchor: sha256(headerHash + framesHash + actionsHash)
//                    plus start/end, close reason, action counters (C4).
// Retention 7 days, per-session hard cap 500 MB of *record metadata* (the
// frames/actions files are small by construction — frame bytes are never
// stored — so the cap is a guard, not a routine limit). If the cap is hit,
// frame recording stops, actions keep logging, and the record is marked
// incomplete ("回放不完整") — the session is NOT force-closed for it.
// Monotonic clock: Date.now() at open is the anchor; all t values are
// ms-since-open, so a wall-clock jump cannot reorder the record.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonical } = require('./audit');

function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

class SessionReplay {
    constructor(replayDir, sessionId, { maxBytes = 500 * 1024 * 1024, retentionDays = 7 } = {}) {
        this.dir = path.join(replayDir, sessionId);
        this.maxBytes = maxBytes;
        this.retentionDays = retentionDays;
        fs.mkdirSync(this.dir, { recursive: true });
        this.openedAt = Date.now();
        this.incomplete = false;
        this.frameCount = 0;
        this.actionCount = 0;
        this.bytesWritten = 0;
    }
    writeMeta(meta) {
        this.meta = { ...meta, openedAt: this.openedAt };
        this.headerHash = sha256hex(canonical(this.meta));
        const p = path.join(this.dir, 'meta.json');
        fs.writeFileSync(p, JSON.stringify({ ...this.meta, headerHash: this.headerHash }, null, 2) + '\n', { mode: 0o600 });
        return this.headerHash;
    }
    _append(name, row) {
        const line = JSON.stringify(row) + '\n';
        const p = path.join(this.dir, name);
        fs.appendFileSync(p, line, { mode: 0o600 });
        this.bytesWritten += Buffer.byteLength(line);
        return row;
    }
    _overCap() { return this.bytesWritten >= this.maxBytes; }
    recordFrame(frameSha256, bytes) {
        if (this._overCap()) { this.incomplete = true; return false; }
        this.frameCount++;
        this._append('frames.jsonl', { t: Date.now() - this.openedAt, sha256: frameSha256, bytes });
        return true;
    }
    recordAction(kind, detail) {
        this.actionCount++;
        this._append('actions.jsonl', { t: Date.now() - this.openedAt, kind, detail });
        return true;
    }
    // Close the record: compute the close anchor and write close.json.
    // Returns the close record (also the C4 audit payload).
    close(reason, counters) {
        const framesHash = this._fileHash('frames.jsonl');
        const actionsHash = this._fileHash('actions.jsonl');
        const closeAnchor = sha256hex(this.headerHash + framesHash + actionsHash);
        const rec = {
            sessionId: path.basename(this.dir),
            closedAt: Date.now(), openedAt: this.openedAt,
            reason, counters,
            frames: this.frameCount, actions: this.actionCount,
            incomplete: this.incomplete,
            headerHash: this.headerHash, framesHash, actionsHash, closeAnchor,
        };
        fs.writeFileSync(path.join(this.dir, 'close.json'), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
        return rec;
    }
    _fileHash(name) {
        const p = path.join(this.dir, name);
        if (!fs.existsSync(p)) return sha256hex('');
        return sha256hex(fs.readFileSync(p));
    }
    static purgeOld(replayDir, retentionDays = 7) {
        if (!fs.existsSync(replayDir)) return 0;
        const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
        let removed = 0;
        for (const name of fs.readdirSync(replayDir)) {
            const dir = path.join(replayDir, name);
            if (!fs.statSync(dir).isDirectory()) continue;
            const meta = path.join(dir, 'meta.json');
            let mtime = 0;
            try { mtime = fs.statSync(meta).mtimeMs; } catch (e) { mtime = fs.statSync(dir).mtimeMs; }
            if (mtime < cutoff) { fs.rmSync(dir, { recursive: true, force: true }); removed++; }
        }
        return removed;
    }
}

module.exports = { SessionReplay };
