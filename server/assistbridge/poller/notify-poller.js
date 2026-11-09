'use strict';
// Notification poller for the assistant control bridge (P2, scheme A).
//
// Runs on the assistant side (sandbox / cron), NOT on the server:
//   node notify-poller.js --list            -> print pending outbox events (JSON)
//   node notify-poller.js --ack <eventId>   -> ACK one event via the bridge
//
// Both operations go through the bridge's own authenticated HTTP API over
// the TCP loopback port (127.0.0.1:18081, reached via a python one-liner over
// SSH). The outbox/acks files are 0600 qfbridge and are NOT readable over
// the ubuntu SSH channel — the API is the only read path, and the ACK is
// only ever written through the bridge's /ack endpoint (never by editing
// server files directly). The poller never prints a token.
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
// Latency (2026-11-09): reuse one SSH connection for repeat bridge calls.
// A fresh ssh through the sandbox proxy costs ~1.9 s per call; multiplexed
// calls cost ~0.4 s while the master lives. If the proxy kills the master,
// ssh falls back to a fresh connection automatically (stale socket).
process.env.QF_SSH_MUX = '1';
// The poller runs as the ubuntu SSH user, so it reaches the bridge over the
// TCP loopback port (127.0.0.1:18081); the UDS socket is 0600 qfbridge and is
// for local bridge-user processes only.

function sshOut(args, input) {
    return execFileSync(TOKYO_SSH, args, { encoding: 'utf8', timeout: 60000, input });
}

function loadToken() {
    const p = process.env.BRIDGE_TOKEN_FILE || path.join(process.env.HOME, 'workspace/qfremote/assistant-api/bridge-token.txt');
    const tok = fs.readFileSync(p, 'utf8').trim();
    if (!tok) throw new Error('bridge token file is empty: ' + p);
    return tok;
}

// One authenticated bridge call over SSH+TCP-loopback. Returns the parsed
// JSON body. The python program goes via stdin (python3 -) because the SSH
// wrapper joins argv into one remote shell command, where newlines would
// split a -c program; the body travels base64 (shell-safe argv).
function bridgeCall(method, urlPath, bodyObj, token) {
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const py = [
        'import socket, sys',
        'method, path, token = sys.argv[1], sys.argv[2], sys.argv[3]',
        "body = '' if sys.argv[4] == '-' else __import__('base64').b64decode(sys.argv[4]).decode()",
        "b = body.encode() if body else b''",
        "h = method + ' ' + path + ' HTTP/1.1\\r\\nHost: bridge\\r\\nContent-Type: application/json\\r\\n'",
        "if token: h += 'Authorization: Bearer ' + token + '\\r\\n'",
        "h += 'Content-Length: ' + str(len(b)) + '\\r\\nConnection: close\\r\\n\\r\\n'",
        'req = h.encode() + b',
        's = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
        's.settimeout(30)',
        "s.connect(('127.0.0.1', 18081))",
        's.sendall(req)',
        'data = b""',
        'while True:',
        '    chunk = s.recv(65536)',
        '    if not chunk: break',
        '    data += chunk',
        'raw = data.decode("utf-8", "replace")',
        'print(raw.split("\\r\\n\\r\\n", 1)[1] if "\\r\\n\\r\\n" in raw else raw)',
    ].join('\n');
    const bodyB64 = body ? Buffer.from(body, 'utf8').toString('base64') : '-';
    const out = sshOut(['python3', '-', method, urlPath, token || '-', bodyB64], py);
    return JSON.parse(out);
}

function listPending() {
    const doc = bridgeCall('GET', '/events/pending', null, loadToken());
    return doc.pending || [];
}

function ackEvent(eventId) {
    const doc = bridgeCall('POST', '/ack', { eventId }, loadToken());
    if (!doc.ok) throw new Error('ack failed: ' + JSON.stringify(doc));
    return doc;
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
        console.log(JSON.stringify(ackEvent(arg), null, 2));
        return;
    }
    console.error('usage: notify-poller.js --list | --ack <eventId>');
    process.exit(2);
}

if (require.main === module) main();
module.exports = { listPending, ackEvent };
