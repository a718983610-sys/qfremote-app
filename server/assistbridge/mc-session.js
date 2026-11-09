'use strict';
// MeshCentral session layer for the assistant control bridge.
// Adapted from mc-direct/mc.js (login + control/relay connect) and the
// bridge-harness KvmSession.connect() flow (2026-10-30 Step 0 §五 0b定论集):
//   login -> control.ashx -> authcookie -> nodes (read-only visibility check)
//   -> meshrelay.ashx (browser=1&p=2&nodeid&id&auth) -> tunnel msg -> 'c' pair.
// The bridge runs on the MeshCentral host itself, so all of this goes over
// server loopback (127.0.0.1:8443), never the public internet.
//
// Security: credentials are read from the secret store at open time and kept
// only in process memory. Nothing in this module prints a credential, cookie,
// or token. Callers must use the provided `redact()` before logging anything.
const fs = require('fs');
const https = require('https');
const wsmod = require('./ws-client');

const BASE = 'https://127.0.0.1:8443';
const ORIGIN = 'https://127.0.0.1:8443';

function httpReq(method, path, { cookie, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(BASE + path);
        const req = https.request({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search,
            method, rejectUnauthorized: false,
            headers: Object.assign({ 'Origin': ORIGIN, 'User-Agent': 'qf-assistbridge/1.0' }, headers, cookie ? { 'Cookie': cookie } : {}),
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function collectCookies(setCookieHeaders) {
    const jar = new Map();
    for (const sc of (setCookieHeaders || [])) {
        const pair = sc.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
    }
    return jar;
}
function jarToHeader(jar) { return Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; '); }

async function login(user, pass) {
    const form = 'action=login&username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass) + '&urlargs=';
    const res = await httpReq('POST', '/login', {
        body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    });
    const jar = collectCookies(res.headers['set-cookie']);
    return { status: res.status, jar, cookieHeader: jarToHeader(jar), location: res.headers.location || null };
}

async function connectControl(cookieHeader) {
    return wsmod.connect('wss://127.0.0.1:8443/control.ashx', { 'Cookie': cookieHeader, 'Origin': ORIGIN, 'User-Agent': 'qf-assistbridge/1.0' });
}

async function connectRelay(cookieHeader, nodeid, tunnelid, authCookie) {
    const qs = '?browser=1&p=2&nodeid=' + encodeURIComponent(nodeid) + '&id=' + tunnelid + (authCookie ? ('&auth=' + authCookie) : '');
    return wsmod.connect('wss://127.0.0.1:8443/meshrelay.ashx' + qs, { 'Cookie': cookieHeader, 'Origin': ORIGIN, 'User-Agent': 'qf-assistbridge/1.0' });
}

// Load the bridge service-account credentials from the secret store.
// Returns { user, pass, fingerprint } where fingerprint is sha256(pass)[0:12]
// for audit cross-checks (the password itself is never returned to callers
// that do not need it, and is never logged).
function loadServiceCreds(secretStorePath) {
    const doc = JSON.parse(fs.readFileSync(secretStorePath, 'utf8'));
    const pass = doc.pass || doc.password;
    if (!pass) throw new Error('secret store doc has no pass field');
    const crypto = require('crypto');
    const fingerprint = crypto.createHash('sha256').update(String(pass)).digest('hex').slice(0, 12);
    return { user: doc.user || 'qf-assistsvc', pass: String(pass), fingerprint };
}

function redact(obj) {
    if (Array.isArray(obj)) return obj.map(redact);
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const k of Object.keys(obj)) {
            if (/cookie|auth|pass|token|secret/i.test(k)) { const v = obj[k]; out[k] = '<redacted len=' + (v ? String(v).length : 0) + '>'; }
            else out[k] = redact(obj[k]);
        }
        return out;
    }
    return obj;
}

module.exports = { BASE, ORIGIN, httpReq, login, connectControl, connectRelay, loadServiceCreds, redact, jarToHeader };
