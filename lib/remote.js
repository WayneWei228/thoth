'use strict';
// Remote access for the iPhone app.
// A second listener binds ONLY to Tailscale addresses and needs a pairing token on every
// request. Anyone who reaches the panel can type into the terminals, so this is off by default.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Tailscale's ranges: 100.64.0.0/10 (CGNAT) and fd7a:115c:a1e0::/48. */
function isTailscaleAddress(ip) {
  if (typeof ip !== 'string') return false;
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 100 && b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(ip);
}

/** Tailscale addresses of this machine, from os.networkInterfaces(). */
function tailscaleAddresses(ifaces) {
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) if (!a.internal && isTailscaleAddress(a.address)) out.push(a.address);
  }
  return [...new Set(out)];
}

function enabled(home, env = process.env) {
  return env.CC_PANEL_REMOTE === '1' || fs.existsSync(path.join(home, 'remote-enabled'));
}

/** The pairing token: created once (0600); `rotate` makes a new one. */
function loadToken(home, rotate = false) {
  const p = path.join(home, 'remote-token');
  if (!rotate) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* create */ }
  }
  fs.mkdirSync(home, { recursive: true });
  const t = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(p, t + '\n', { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return t;
}

/** Token from `Authorization: Bearer <t>` or `?token=<t>` (WebSockets cannot always set headers). */
function requestToken(req) {
  const h = req.headers && req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  try { return new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch { return ''; }
}

function authorized(req, token) {
  const got = Buffer.from(requestToken(req));
  const want = Buffer.from(token || '');
  return want.length >= 32 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = { isTailscaleAddress, tailscaleAddresses, enabled, loadToken, requestToken, authorized };
