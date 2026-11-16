'use strict';
const net = require('net');

function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  const ip = value.trim().replace(/^::ffff:/i, '');
  return net.isIP(ip) ? ip.toLowerCase() : '';
}

// Only the local reverse proxy can supply the Cloudflare edge header. Never
// derive identity, audit attribution, or rate-limit buckets from raw XFF.
function trustedClientIp(req) {
  const remote = normalizeIp(req.socket && req.socket.remoteAddress);
  if (remote === '127.0.0.1' || remote === '::1') {
    return normalizeIp((req.headers || {})['cf-connecting-ip']) || remote;
  }
  return remote;
}

// The device identifier travels in a bounded POST body, not browser history,
// request URLs, reverse-proxy access logs, or Referer headers (M-123).
function readRebindForm(req) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(String((req.headers || {})['content-type'] || ''))) {
    return Promise.resolve({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
  }
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 4096) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > 4096) return finish({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const fields = ['dc', 'platform', 'ch'];
      if (fields.some((field) => form.getAll(field).length > 1)) return finish({ status: 400, code: 'VALIDATION' });
      const deviceCode = form.get('dc') || '';
      const platform = form.get('platform') || '';
      const channel = form.get('ch') || 'web';
      if (!deviceCode || deviceCode.length > 512 || /[\x00-\x1f\x7f]/.test(deviceCode)
        || !['pc', 'mobile'].includes(platform) || !['web', 'windows', 'android', 'software'].includes(channel)) {
        return finish({ status: 400, code: 'VALIDATION' });
      }
      finish({ status: 200, value: { deviceCode, platform, channel } });
    });
    req.on('aborted', () => finish({ status: 400, code: 'REQUEST_ABORTED' }));
    req.on('error', () => finish({ status: 400, code: 'REQUEST_ERROR' }));
  });
}

module.exports = { trustedClientIp, readRebindForm };
