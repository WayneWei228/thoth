'use strict';
// Device pairing. A device joins with a one-time
// code (15 min, single use; only its hash is stored) and gets its own token (only its hash is
// stored). The brain's device listener accepts nothing but join and push.
const crypto = require('crypto');
const Remote = require('./remote');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
const CODE_TTL = 15 * 60_000;

function newCode() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += ALPHA[b % ALPHA.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function sameHash(a, b) {
  const A = Buffer.from(a || ''), B = Buffer.from(b || '');
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Addresses devices can reach this machine on: private LAN IPv4 and Tailscale (never public). */
function deviceAddresses(ifaces) {
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4') continue;
      const [x, y] = a.address.split('.').map(Number);
      const priv = x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
      if (priv || Remote.isTailscaleAddress(a.address)) out.push(a.address);
    }
  }
  // Tailscale first: it works away from home and is encrypted
  return [...new Set(out)].sort((p, q) => Remote.isTailscaleAddress(q) - Remote.isTailscaleAddress(p));
}

/** One copy-paste line for sh, bash and zsh (macOS and Linux).
 * Download, then run: with 'curl | sh' a failed download still exits 0 (an empty script), so the
 * user and scripts would think the device joined (found in the Docker pairing test).
 * The file is a new mktemp file of this user, never a fixed name in /tmp: a second user on the same
 * computer could not overwrite the first user's file, and nobody can prepare the path.
 * It runs in its own sh -c (so it is the same in every login shell, and $f stays out of the user's
 * shell); "$0" is the script's URL and "$@" the arguments, so more arguments (a device name) can be
 * added at the end of the line. Exit code: the failed step's or the script's. The file is removed. */
function posixJoin(scriptUrl, args) {
  return `sh -c 'f=$(mktemp) && curl -fsSL "$0" -o "$f" && sh "$f" "$@"; r=$?; rm -f "$f"; exit $r' ${scriptUrl} ${args}`;
}

function commands(address, code, name) {
  return {
    posix: posixJoin(`http://${address}/join.sh`, `${code} ${name}`),
    windows: `& ([scriptblock]::Create((iwr -UseBasicParsing http://${address}/join.ps1).Content)) ${code} ${name}`,
  };
}

/** Start pairing for a device in the setup state. Returns the code (shown once). */
function startPair(state, name, now = Date.now()) {
  const d = state.devices.find((x) => x.name === name && !x.self);
  if (!d) throw new Error(`"${name}" is not one of your other devices`);
  const code = newCode();
  d.pair = { codeHash: hash(code), expires: now + CODE_TTL };
  return { code, expires: d.pair.expires, device: d.name };
}

/** Redeem a code: returns { device, token } or null. Single use. */
function redeem(state, code, host = '', now = Date.now()) {
  const h = hash(String(code || '').trim().toUpperCase());
  const d = state.devices.find((x) => x.pair && x.pair.expires > now && sameHash(h, x.pair.codeHash));
  if (!d) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  d.tokenHash = hash(token);
  d.connected = true; d.revoked = false; d.joinedAt = now; d.host = String(host).slice(0, 80);
  delete d.pair;
  return { device: d.name, token };
}

function byToken(state, token) {
  if (!token) return null;
  const h = hash(token);
  return state.devices.find((x) => x.tokenHash && sameHash(h, x.tokenHash)) || null;
}

function revoke(state, name) {
  const d = state.devices.find((x) => x.name === name && !x.self);
  if (!d) throw new Error(`"${name}" is not one of your other devices`);
  delete d.tokenHash; delete d.pair;
  d.connected = false; d.revoked = true;
  return d;
}

// ------------------------------------------------ add / remove after setup ----
// The All Devices page: the user adds a computer or removes one at any time, not only in the wizard.
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const OSES = ['macos', 'linux', 'windows'];
function checkNewDevice(name, os) {
  if (!NAME.test(name)) throw new Error(`Computer name "${name}" is not allowed: use small letters, digits and "-" (up to 31)`);
  if (!OSES.includes(os)) throw new Error('Choose macOS, Linux or Windows');
}

/** Add a computer to a brain on this computer: list it and start pairing. `taken` = names the
 * brain already has that are not in this list (for example a computer it reads over SSH).
 * A listed computer that never connected gets a new code. Returns { code, expires, device }. */
function addDevice(state, name, os, taken = [], now = Date.now()) {
  checkNewDevice(name, os);
  const old = state.devices.find((x) => x.name === name);
  if (old && old.self) throw new Error(`"${name}" is this computer. Give the other computer another name`);
  if (old && old.connected) throw new Error(`"${name}" is already connected. To connect it again, remove it first`);
  if (!old && taken.includes(name)) throw new Error(`Your brain already has a computer called "${name}". Choose another name, or remove that one first`);
  if (old) old.os = os; else state.devices.push({ name, os });
  return startPair(state, name, now);
}

/** Remove a computer from the list: its token and any open code go with it, so it cannot send
 * data again. Returns true when it was in the list. This computer and the brain computer stay. */
function removeDevice(state, name) {
  const d = state.devices.find((x) => x.name === name);
  if (d && d.self) throw new Error('This computer cannot be removed from its own panel');
  if (d && state.brain === name) throw new Error(`"${name}" is your brain. Choose another brain first (setup page: Change the brain)`);
  state.devices = state.devices.filter((x) => x.name !== name);
  return !!d;
}

// ------------------------------------------------- the brain computer moved ----
// A home network gives this computer a new address from time to time. A joined computer must then
// find it again by itself, and must not send its token to another machine that answers on the
// old or a new address. So this computer PROVES that it is the one the device joined: both sides
// know the hash of the device's token (the device has the token, this side stores only the hash).
// proof = HMAC-SHA256(key: token hash, message: the device's random nonce). No secret is sent.
function prove(state, name, nonce) {
  nonce = String(nonce || '');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(nonce)) return null;
  const d = state.devices.find((x) => x.name === name && !x.self && x.tokenHash);
  if (!d) return null;
  return crypto.createHmac('sha256', d.tokenHash).update(nonce).digest('hex');
}

/** Start pairing again for a computer that is already listed (it lost its way, or was set up
 * again). Its sessions in the brain stay; the new code gives it a new token. */
function reconnect(state, name, now = Date.now()) {
  const d = state.devices.find((x) => x.name === name && !x.self);
  if (!d) throw new Error(`"${name}" did not join this panel with a code, so it has no join command here`);
  return startPair(state, name, now);
}

/** How long a joined computer may be silent before the page says so. It sends every 5 minutes. */
const SILENT_MS = 20 * 60_000;

/** The state without secrets (hashes), for the page. */
function publicView(state) {
  const s = JSON.parse(JSON.stringify(state));
  for (const d of s.devices) {
    if (d.pair) d.pairing = { expires: d.pair.expires };
    delete d.pair; delete d.tokenHash;
  }
  return s;
}

// ------------------------------------------------------------ cloud brain ----
// the design: devices ask the cloud brain to join (POST /api/join); the owner
// (this panel, with the owner token) sees them as "wants to join" and decides.

/** Join commands for a cloud brain. No code: the device asks and waits for Approve. The brain's
 * address is passed too, so the cloud brain can serve join.sh/join.ps1 as plain static files. */
function cloudCommands(url, code = '', name = '') {
  const args = [code, name].filter(Boolean).join(' ');
  return {
    posix: posixJoin(`${url}/join.sh`, `--hub ${url}${args ? ' ' + args : ''}`),
    windows: `& ([scriptblock]::Create((iwr -UseBasicParsing ${url}/join.ps1).Content)) -HubUrl ${url}${args ? ' ' + args : ''}`,
  };
}

const LATER_MS = 60 * 60_000;   // "Later": ask again in an hour (or after a restart of the decision)
/** GET /api/devices of the cloud brain -> lists for the page. `later` = { id: until }. */
function cloudView(list, { later = {}, selfName = '', now = Date.now() } = {}) {
  const out = { pending: [], later: [], approved: [], ignored: [], revoked: [] };
  for (const d of Array.isArray(list) ? list : []) {
    const id = String(d.id ?? d.name ?? '');
    if (!id) continue;
    // the real brain also lists devices it pulls itself (its own machine): show them only when they
    // have sessions, and never offer decisions for them
    const joined = !d.transport || d.transport === 'cloud';
    if (!joined && !Number(d.sessions)) continue;
    const ls = Number(d.last_seen || d.lastSeen || 0);
    const item = { id, name: String(d.name || id), os: String(d.os || '').toLowerCase(), host: String(d.host || ''),
      status: String(d.status || 'approved'), sessions: Number(d.sessions || 0), lastSeen: ls && ls < 1e12 ? ls * 1000 : ls,
      error: String(d.last_error || d.error || ''), self: !!selfName && d.name === selfName, joined };
    if (item.status === 'pending') (later[id] > now ? out.later : out.pending).push(item);
    else if (out[item.status]) out[item.status].push(item);
  }
  return out;
}

/** A failed connect (link, network, certificate, key) in plain words, with what to check. */
function connectError(kind, host = '') {
  const E = {
    link: { title: 'This is not a connect link',
      error: 'A connect link starts with ccbrain:// and ends with a long key after #. Copy the whole line again.',
      steps: ['On your server, find the line the install printed: ccbrain://…/#…', 'Copy all of it, with nothing before or after it.', 'Paste it here and choose Connect.'] },
    unreachable: { title: 'Your cloud brain does not answer',
      error: `Nothing answers at ${host}. The server may be off, or the install has not finished.`,
      steps: ['Check that the server is switched on.', 'Check that the install on the server finished and printed the link.', 'Check that this computer is online, then try again.'] },
    certificate: { title: 'The server has a certificate problem',
      error: `${host} answers, but its security certificate is not valid. The panel does not send your key to it.`,
      steps: ['Wait two minutes after the install: the server gets its certificate by itself.', 'Check that the address in the link is the server\'s own address.', 'Try again. If it still fails, run the install on the server again.'] },
    notbrain: { title: 'This is not a Thoth brain',
      error: `Something answers at ${host}, but it is not a Thoth brain.`,
      steps: ['Check that the address in the link is your brain server.', 'Copy the link again from the install output on the server.'] },
    refused: { title: 'The brain refused the key',
      error: 'The server is your brain, but it did not accept the key in this link. The link may be old.',
      steps: ['Copy the newest link from your server.', 'If the key was changed on the server, use the new link it printed.'] },
  };
  return { kind, ...E[kind] };
}
const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|ERR_TLS|SSL|EPROTO/i;
/** Network error code (ECONNREFUSED, CERT_HAS_EXPIRED, ...) -> connectError kind. */
/**
 * One computer, one identity on the cloud brain. This computer can hold two device files: the
 * panel's own (<panel home>/cloud-device.json) and the device agent's (~/.cc-brain/device.json,
 * from the join command). When the agent's file is for the same brain, it is the identity of this
 * computer: the panel uses it too, and does not push when the agent pushes on its own schedule
 * (its log changed in the last AGENT_ACTIVE_MS). Otherwise the panel's own file.
 * own, agent: parsed files or null. hub: the brain the panel is connected to.
 * Returns { which: 'agent' | 'own', conf, push } or null.
 */
const AGENT_ACTIVE_MS = 15 * 60_000;
function pickIdentity({ own, agent, hub, agentLogAge = Infinity }) {
  const ok = (c) => c && c.token && c.mode === 'cloud';
  if (ok(agent) && hub && agent.hub === hub) return { which: 'agent', conf: agent, push: !(agentLogAge < AGENT_ACTIVE_MS) };
  if (ok(own)) return { which: 'own', conf: own, push: true };
  return null;
}

/** A device name from this computer's host name (a-z, 0-9, -; same rule as device_agent.own_name). */
function hostName(host = require('os').hostname()) {
  const n = String(host).split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
  return n || 'computer';
}
function errorKind(code) { return CERT_CODES.test(String(code || '')) ? 'certificate' : 'unreachable'; }

module.exports = { pickIdentity, AGENT_ACTIVE_MS, hostName, prove, reconnect, SILENT_MS, addDevice, removeDevice, checkNewDevice, cloudCommands, cloudView, connectError, errorKind, LATER_MS, newCode, hash, sameHash, deviceAddresses, commands, startPair, redeem, byToken, revoke, publicView, CODE_TTL };
