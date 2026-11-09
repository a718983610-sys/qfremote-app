'use strict';
// Notification poller for the assistant control bridge (P2, scheme A).
//
// Runs on the assistant side (sandbox / cron), NOT on the server:
//   node notify-poller.js --list            -> print pending outbox events (JSON)
//   node notify-poller.js --ack <eventId>   -> ACK one event via the bridge
//
// The poller only READS the outbox/acks files over SSH (cat) and ACKs through
// the bridge's own authenticated /ack endpoint (UDS via a python one-liner
// over SSH). It never writes server files directly and never prints a token.
//
// The bridge token is read from the local secure file
//   ~/workspace/qfremote/assistant-api/bridge-token.txt  (0600)
// via the BRIDGE_TOKEN_FILE env var. The token value is never printed.
//
// Cron wiring (parent creates the cron): every 1 minute run --list; if it
// reports pending events, tell the owner in chat, then run --ack for each
// event told. The ACK is what unblocks a waiting session open (fail-closed).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOKYO_SSH = path.join(process.env.HOME, 'workspace/qfremote/tokyo-ssh.sh');
const OUTBOX = '/opt/qfremote-bridge/outbox.jsonl';
const ACKS = '/opt/qfremote-bridge/acks.jsonl';
// The poller runs as the ubuntu SSH user, so it reaches the bridge over the
// TCP loopback port (127.0.0.1:18081); the UDS socket is 0600 qfbridge and is
// for local bridge-user processes only.

function sshOut(args, input) {
    return execFileSync(TOKYO_SSH, args, { encoding: 'utf8', timeout: 60000, input });
}

function readLines(text) {
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

function listPending() {
    const raw = sshOut(['cat ' + OUTBOX + '; echo ---ACKS---; cat ' + ACKS]);
    const [outPart, ackPart] = raw.split('---ACKS---');
    const events = readLines(outPart || '');
    const acks = readLines(ackPart || '');
    const acked = new Set(acks.map((a) => a.eventId));
    return events.filter((e) => !acked.has(e.eventId));
}

function loadToken() {
    const p = process.env.BRIDGE_TOKEN_FILE || path.join(process.env.HOME, 'workspace/qfremote/assistant-api/bridge-token.txt');
    const tok = fs.readFileSync(p, 'utf8').trim();
    if (!tok) throw new Error('bridge token file is empty: ' + p);
    return tok;
}

function ackEvent(eventId) {
    const token = loadToken();
    const py = [
        'import socket, json, sys',
        'body = json.dumps({"eventId": sys.argv[1]}).encode()',
        'req = (b"POST /ack HTTP/1.1\r\nHost: bridge\r\nContent-Type: application/json\r\nAuthorization: Bearer " + sys.argv[2].encode() + b"\r\nContent-Length: " + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)',
        's = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
        's.settimeout(15)',
        "s.connect(('127.0.0.1', 18081))",
        's.sendall(req)',
        'data = b""',
        'while True:',
        '    chunk = s.recv(65536)',
        '    if not chunk: break',
        '    data += chunk',
        'print(data.decode("utf-8", "replace"))',
    ].join('\n');
    // Token travels as an argv element to the remote python (in the SSH
    // channel only); it is never printed by this script. The python code
    // goes via stdin (python3 -) because the SSH wrapper joins argv into
    // one remote shell command, where newlines would split the -c program.
    const out = sshOut(['python3', '-', eventId, token], py);
    return out;
}

function main() {
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === '--list') {
        const pending = listPending();
        console.log(JSON.stringify({ pending, count: pending.length }, null, 2));
        return;
    }
    if (cmd === '--ack') {
        if (!arg) { console.error('usage: notify-poller.js --ack <eventId>'); process.exit(2); }
        const out = ackEvent(arg);
        console.log(out);
        return;
    }
    console.error('usage: notify-poller.js --list | --ack <eventId>');
    process.exit(2);
}

if (require.main === module) main();
module.exports = { listPending, ackEvent };
