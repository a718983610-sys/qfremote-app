'use strict';
// Regression test for the 2026-11-09 token leak: the bridge token reached
// local exec logs because it travelled in argv of a failed command (error
// output echoes the command line), and it was briefly visible in the
// server's process list. The token must ride on stdin as the first line of
// the python program and never appear in argv.
const assert = require('node:assert');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { buildBridgeCall } = require('../poller/notify-poller');

const TOKEN = 'tok_TEST_' + 'x'.repeat(40);

test('token never appears in argv', () => {
    const { args } = buildBridgeCall('GET', '/status', null, TOKEN);
    assert.deepStrictEqual(args, ['python3', '-', 'GET', '/status', '-']);
    for (const a of args) assert(!a.includes(TOKEN), 'token leaked into argv');
    const { args: args2 } = buildBridgeCall('POST', '/ack', { eventId: 'ev_1' }, TOKEN);
    for (const a of args2) assert(!a.includes(TOKEN), 'token leaked into argv');
});

test('program carries the token on line 1 and parses as Python', () => {
    const { program } = buildBridgeCall('POST', '/ack', { eventId: 'ev_1' }, TOKEN);
    const lines = program.split('\n');
    assert.strictEqual(lines[0], 'TOKEN = ' + JSON.stringify(TOKEN));
    assert(lines[1].startsWith('import socket'));
    assert(program.includes('Authorization: Bearer \' + TOKEN'));
    // Syntax check only — never executed (it would dial the bridge).
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: program, encoding: 'utf8' });
});

test('empty token yields an empty TOKEN assignment', () => {
    const { program } = buildBridgeCall('GET', '/events/pending', null, '');
    assert(program.startsWith('TOKEN = ""\n'));
});
