'use strict';
// Notification outbox for the assistant control bridge (P2, DESIGN §5 /
// ASSESSMENT §5 scheme A: lightweight polling ACK, no sentinel revival).
//
// Model:
//   - The bridge NEVER pushes to the owner. It writes events to an append-only
//     outbox JSONL (one line per event) and waits for an ACK.
//   - A poller (my side, 1-minute cron) reads the outbox, tells the owner in
//     chat, then ACKs via POST /ack. The ACK is what unblocks the bridge.
//   - Fail-closed (E3): a session open writes a `session-request` event and
//     waits up to ackTimeoutMs for its ACK. No ACK -> open is REFUSED and the
//     refusal is audited. A late ACK never retroactively allows a refused open.
//   - Events are immutable lines; ACKs are separate lines in acks.jsonl
//     {eventId, ackedAt, ackedBy}. "Pending" = outbox events with no ACK line.
//   - The poller reads outbox+acks over SSH (read-only) and ACKs through the
//     bridge's own authenticated /ack endpoint — no direct file writes from
//     outside the bridge process.
//   - Event payloads are summaries only: no screen content, no keystrokes,
//     no tokens, no credentials.
const fs = require('fs');
const crypto = require('crypto');

function newEventId() { return 'ev_' + crypto.randomBytes(8).toString('hex'); }

class Outbox {
    constructor(outboxPath, acksPath) {
        this.outboxPath = outboxPath;
        this.acksPath = acksPath;
        for (const p of [outboxPath, acksPath]) {
            const dir = require('path').dirname(p);
            fs.mkdirSync(dir, { recursive: true });
            if (!fs.existsSync(p)) fs.writeFileSync(p, '', { mode: 0o600 });
        }
    }
    write(type, summary) {
        const ev = { eventId: newEventId(), type, createdAt: Date.now(), ...summary };
        fs.appendFileSync(this.outboxPath, JSON.stringify(ev) + '\n', { mode: 0o600 });
        return ev;
    }
    // Read all ACKs into a Map(eventId -> ack).
    readAcks() {
        const map = new Map();
        const raw = fs.readFileSync(this.acksPath, 'utf8');
        for (const line of raw.split('\n').filter(Boolean)) {
            try { const a = JSON.parse(line); if (a.eventId) map.set(a.eventId, a); } catch (e) { /* skip corrupt line */ }
        }
        return map;
    }
    readEvents() {
        const out = [];
        const raw = fs.readFileSync(this.outboxPath, 'utf8');
        for (const line of raw.split('\n').filter(Boolean)) {
            try { out.push(JSON.parse(line)); } catch (e) { /* skip corrupt line */ }
        }
        return out;
    }
    pending() {
        const acks = this.readAcks();
        return this.readEvents().filter((e) => !acks.has(e.eventId));
    }
    isAcked(eventId) { return this.readAcks().has(eventId); }
    // Append an ACK line. Returns the ack record, or null if the event does
    // not exist in the outbox (ACKs for unknown events are refused).
    ack(eventId, ackedBy) {
        const exists = this.readEvents().some((e) => e.eventId === eventId);
        if (!exists) return null;
        const ack = { eventId, ackedAt: Date.now(), ackedBy: ackedBy || 'poller' };
        fs.appendFileSync(this.acksPath, JSON.stringify(ack) + '\n', { mode: 0o600 });
        return ack;
    }
    // Wait for an event's ACK, polling every pollMs up to timeoutMs.
    // Resolves true on ACK, false on timeout. Never throws on timeout.
    async waitAck(eventId, { timeoutMs = 75000, pollMs = 2000 } = {}) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.isAcked(eventId)) return true;
            await new Promise((r) => setTimeout(r, pollMs));
        }
        return this.isAcked(eventId);
    }
}

module.exports = { Outbox, newEventId };
