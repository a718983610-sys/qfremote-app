'use strict';
// Configuration for the assistant control bridge.
// Loads /opt/qfremote-bridge/bridge-config.json (BRIDGE_CONFIG env override).
// Every field has a safe default; the file is the only place an operator
// changes behaviour. Two flags are deliberately conservative by default:
//   controlEnabled: false — mouse/key stay 409 until 0d passes AND an
//     explicit, recorded decision flips this to true (P5 gate).
//   unicodeLE: false — KEYUNICODE byte order stays big-endian until the
//     fixture single-char test proves otherwise (0d).
const fs = require('fs');

const LAPTOP_NODEID = 'node//8tVIMXjJh50uyBWFCvfJzyEWfc7PFcmYgL1wMmMf3xiv2cFYhjnn@7WnygBlCSp7';

const DEFAULTS = {
    sockPath: '/opt/qfremote-bridge/bridge.sock',
    tcpPort: 18081,                 // loopback only (127.0.0.1), fallback when UDS is unavailable
    whitelist: [LAPTOP_NODEID],     // first release: only the owner's laptop
    secretStorePath: '/opt/qfremote-bridge/secrets/assistsvc.json',
    tokensPath: '/opt/qfremote-bridge/bridge-tokens.json',
    auditDir: '/opt/qfremote-bridge/audit',
    outboxPath: '/opt/qfremote-bridge/outbox.jsonl',
    acksPath: '/opt/qfremote-bridge/acks.jsonl',
    replayDir: '/opt/qfremote-bridge/replays',
    disabledPath: '/opt/qfremote-bridge/DISABLED',
    coolingPath: '/opt/qfremote-bridge/COOLING',
    idleTimeoutMs: 120000,          // idle (no input/snapshot call) -> close
    maxSessionMs: 30 * 60 * 1000,   // absolute session length -> force close
    coolingMs: 5 * 60 * 1000,       // after local-kill / owner-remote-kill
    ackTimeoutMs: 75000,            // notify-ACK wait at open (fail-closed)
    ackPollMs: 2000,
    controlEnabled: false,          // P5 gate — DO NOT flip without 0d passing
    unicodeLE: false,               // KEYUNICODE byte order — DO NOT flip without fixture evidence
    snapshotRatePerSec: 2,          // per-session snapshot rate limit
    textEnabled: false,             // /text stays disabled (DESIGN §5)
    replayRetentionDays: 7,
    replayMaxBytesPerSession: 500 * 1024 * 1024,
};

function loadConfig() {
    const p = process.env.BRIDGE_CONFIG || '/opt/qfremote-bridge/bridge-config.json';
    let file = {};
    try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* defaults */ }
    const cfg = Object.assign({}, DEFAULTS, file);
    cfg.configPath = p;
    return cfg;
}

module.exports = { loadConfig, DEFAULTS, LAPTOP_NODEID };
