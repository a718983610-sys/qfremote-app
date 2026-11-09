'use strict';
// Offline tests: notification outbox + ACK + fail-closed wait (P2).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Outbox } = require('../notify');

function tmpOutbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outbox-'));
    return new Outbox(path.join(dir, 'outbox.jsonl'), path.join(dir, 'acks.jsonl'));
}

test('notify: write -> pending -> ack -> no longer pending', () => {
    const ob = tmpOutbox();
    const ev = ob.write('session-request', { sessionId: 's1', nodeId: 'node//x' });
    assert.ok(ev.eventId.startsWith('ev_'));
    assert.equal(ob.pending().length, 1);
    assert.equal(ob.isAcked(ev.eventId), false);
    const ack = ob.ack(ev.eventId, 'tok_1');
    assert.ok(ack);
    assert.equal(ack.ackedBy, 'tok_1');
    assert.equal(ob.pending().length, 0);
    assert.equal(ob.isAcked(ev.eventId), true);
});

test('notify: ack of an unknown event is refused', () => {
    const ob = tmpOutbox();
    assert.equal(ob.ack('ev_doesnotexist', 'tok_1'), null);
});

test('notify: waitAck resolves true on ACK, false on timeout (fail-closed)', async () => {
    const ob = tmpOutbox();
    const ev = ob.write('session-request', { sessionId: 's1' });
    setTimeout(() => ob.ack(ev.eventId, 'poller'), 100);
    assert.equal(await ob.waitAck(ev.eventId, { timeoutMs: 5000, pollMs: 50 }), true);

    const ev2 = ob.write('session-request', { sessionId: 's2' });
    const start = Date.now();
    assert.equal(await ob.waitAck(ev2.eventId, { timeoutMs: 300, pollMs: 50 }), false);
    assert.ok(Date.now() - start >= 250, 'waitAck must actually wait out the timeout');
    // A late ACK never retroactively allows the refused open: the event is
    // still ACKable (for the record), but the open that timed out is gone.
    ob.ack(ev2.eventId, 'poller');
    assert.equal(ob.isAcked(ev2.eventId), true);
});

test('notify: outbox payloads carry summaries only (no secrets)', () => {
    const ob = tmpOutbox();
    const ev = ob.write('session-request', { sessionId: 's1', nodeId: 'node//x', openedBy: 'tok_abc' });
    const raw = JSON.stringify(ev);
    assert.ok(!/pass|token|secret|cookie/i.test(raw.replace('openedBy', '')));
});
