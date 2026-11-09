'use strict';
// Offline tests: KVM protocol encoders + input channel (DESIGN §6.1/§6.2).
// Byte vectors are anchored to the viewer source (agent-desktop-0.0.2.js)
// via the Step-0 harness offline-selftest vectors.
const test = require('node:test');
const assert = require('node:assert');
const { makeEnc, VK, InputChannel } = require('../kvm');

test('enc: key/mouse/compression/refresh byte vectors', () => {
    const enc = makeEnc(false);
    assert.deepEqual([...enc.key(0, 0x1B)], [0x00, 0x01, 0x00, 0x06, 0x00, 0x1B]); // Esc down
    assert.deepEqual([...enc.key(1, 0x1B)], [0x00, 0x01, 0x00, 0x06, 0x01, 0x1B]); // Esc up
    assert.deepEqual([...enc.key(4, 0x5B)], [0x00, 0x01, 0x00, 0x06, 0x04, 0x5B]); // LWin ex-down
    assert.deepEqual([...enc.key(3, 0x5B)], [0x00, 0x01, 0x00, 0x06, 0x03, 0x5B]); // LWin ex-up
    assert.deepEqual([...enc.mouse(0x02, 100, 200)], [0x00, 0x02, 0x00, 0x0A, 0x00, 0x02, 0x00, 100, 0x00, 200]); // left down
    assert.deepEqual([...enc.mouse(0x00, 1919, 1079)], [0x00, 0x02, 0x00, 0x0A, 0x00, 0x00, 0x07, 0x7F, 0x04, 0x37]); // move
    assert.deepEqual([...enc.compression()], [0x00, 0x05, 0x00, 0x0A, 0x01, 0x32, 0x04, 0x00, 0x00, 0x64]); // q50, scale 1024, timer 100
    assert.deepEqual([...enc.refresh()], [0x00, 0x06, 0x00, 0x04]);
    assert.deepEqual([...enc.unpause()], [0x00, 0x08, 0x00, 0x05, 0x00]);
    assert.deepEqual([...enc.inputLockQuery()], [0x00, 0x57, 0x00, 0x05, 0x02]); // cmd 87
    assert.deepEqual([...enc.getDisplays()], [0x00, 0x0E, 0x00, 0x04]);
});

test('enc: KEYUNICODE cmd 85 big-endian default, LE flip', () => {
    const be = makeEnc(false);
    // 'A' = U+0041 -> BE bytes 00 41
    assert.deepEqual([...be.keyUnicode(0, 0x41)], [0x00, 0x55, 0x00, 0x07, 0x00, 0x00, 0x41]);
    assert.deepEqual([...be.keyUnicode(1, 0x41)], [0x00, 0x55, 0x00, 0x07, 0x01, 0x00, 0x41]);
    // Chinese char U+4E2D -> BE bytes 4E 2D
    assert.deepEqual([...be.keyUnicode(0, 0x4E2D)], [0x00, 0x55, 0x00, 0x07, 0x00, 0x4E, 0x2D]);
    const le = makeEnc(true);
    assert.deepEqual([...le.keyUnicode(0, 0x4E2D)], [0x00, 0x55, 0x00, 0x07, 0x00, 0x2D, 0x4E]);
});

test('input channel: F27 flush before key, click serial, throttle keeps last point', async () => {
    const sent = [];
    const ch = new InputChannel((buf) => sent.push(Buffer.from(buf)), { throttleMs: 50, screenW: 1920, screenH: 1080 });
    ch.move(10, 10);
    ch.move(20, 20);
    ch.move(30, 30); // only the last point survives the throttle window
    assert.equal(sent.length, 0); // nothing emitted yet (throttled)
    ch.keyTap(VK.ENTER); // F27: pending move flushes BEFORE the key
    assert.equal(sent.length, 1 + 2); // 1 flushed move + key down + key up
    assert.deepEqual([...sent[0]], [0x00, 0x02, 0x00, 0x0A, 0x00, 0x00, 0x00, 30, 0x00, 30]); // last point only
    assert.deepEqual([...sent[1]], [0x00, 0x01, 0x00, 0x06, 0x00, 0x0D]); // Enter down
    assert.deepEqual([...sent[2]], [0x00, 0x01, 0x00, 0x06, 0x01, 0x0D]); // Enter up
    // Click = down + up serial, coordinates clamped to the screen.
    sent.length = 0;
    ch.click(5000, -5);
    assert.equal(sent.length, 2);
    assert.deepEqual([...sent[0]], [0x00, 0x02, 0x00, 0x0A, 0x00, 0x02, 0x07, 0x7F, 0x00, 0x00]); // clamped to 1919,0
    assert.deepEqual([...sent[1]], [0x00, 0x02, 0x00, 0x0A, 0x00, 0x04, 0x07, 0x7F, 0x00, 0x00]);
});

test('input channel: keyCombo order + forced modifier keyup sweep', () => {
    const sent = [];
    const ch = new InputChannel((buf) => sent.push(Buffer.from(buf)), { throttleMs: 50, screenW: 1920, screenH: 1080 });
    ch.keyCombo([VK.CTRL, VK.SHIFT], 0x43); // Ctrl+Shift+C
    const kinds = sent.map((b) => [b[4], b[5]]); // [up, kc]
    assert.deepEqual(kinds.slice(0, 5), [
        [0, 17], // Ctrl down
        [0, 16], // Shift down
        [0, 0x43], // C down
        [1, 0x43], // C up
        [1, 16], // Shift up (reverse order)
    ]);
    // ... then Ctrl up, then the forced sweep releases all 5 modifiers.
    assert.deepEqual(kinds[5], [1, 17]);
    assert.deepEqual(kinds.slice(6), [[1, 16], [1, 17], [1, 18], [1, 91], [1, 92]]);
});

test('input channel: typeUnicode emits down+up per UTF-16 code unit', () => {
    const sent = [];
    const ch = new InputChannel((buf) => sent.push(Buffer.from(buf)), { throttleMs: 50, screenW: 1920, screenH: 1080 });
    ch.typeUnicode('中');
    // '中' = one code unit 0x4E2D: down + up, then the modifier sweep (5 keyups).
    assert.equal(sent.length, 2 + 5);
    assert.deepEqual([...sent[0]], [0x00, 0x55, 0x00, 0x07, 0x00, 0x4E, 0x2D]);
    assert.deepEqual([...sent[1]], [0x00, 0x55, 0x00, 0x07, 0x01, 0x4E, 0x2D]);
});
