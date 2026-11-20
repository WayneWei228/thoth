// The Mac's side of the Thoth relay.
// Keeps one outbound control WebSocket to the relay; for each phone that connects there, opens a data
// WebSocket and feeds its bytes into the remote TLS server (lib/remote_listen.ts connect). The phone's
// TLS session ends here, so the relay only ever carries ciphertext.
// Config: <panel home>/relay.json (0600)
//   { "url": "wss://<server>/relay", "macId": "...", "macSecret": "...", "phone": { "id": "...", "secret": "..." } }
// Two kinds of Mac credential:
//   - "open": true — an open relay (the Thoth relay): this Mac made the secret itself; the Mac id is
//     derived from the secret and the phone id from the Mac id and the phone secret, so the relay
//     needs no account and no other Mac can use these ids.
//   - no "open" — an account on a private relay (`thoth-relay add-mac` on the server).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import WebSocket, { createWebSocketStream } from 'ws';

import { ne, truthy } from './truthy.ts';

export const configPath = (home: string): string => path.join(home, 'relay.json');
const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const ID = /^[\w-]{8,64}$/,
  SECRET = /^[\w-]{32,128}$/;
const rnd = (n: number): string => crypto.randomBytes(n).toString('base64url');
// the same derivations as the relay server (a test checks that they agree)
export const macIdFor = (secret: string): string =>
  crypto.createHash('sha256').update(`thoth-relay-mac-v1:${secret}`).digest('base64url').slice(0, 22);
export const phoneIdFor = (macId: string, hash: string): string =>
  crypto.createHash('sha256').update(`thoth-relay-phone-v1:${macId}:${hash}`).digest('base64url').slice(0, 22);

/** A reason key as the relay sends it; anything else (the relay is not trusted with free text that
 * the Mac shows to its user) is 'unknown'. */
const reasonKey = (r: unknown): string => {
  const s = truthy(r) ? String(r) : '';
  return /^[a-z\d-]{1,40}$/.test(s) ? s : 'unknown';
};

/** What a refusal of the relay means, in words for the user (the keys are the relay's reasons). */
export const WHY: Record<string, string> = {
  auth: 'the relay did not accept this Mac',
  'auth-rate': 'the relay got too many wrong sign-ins from this network; Thoth tries again by itself',
  'request-rate': 'the relay got too many requests from this network; Thoth tries again by itself',
  'mac-connect-rate': 'the relay got too many connections from this network; Thoth tries again by itself',
  'macs-per-ip': 'too many Macs use the relay from this network',
  'macs-per-net': 'too many Macs use the relay from this network',
  'macs-total': 'the relay is full now; Thoth tries again by itself',
  'day-bytes-mac': "this Mac reached the relay's data limit for 24 hours",
  'day-bytes-ip': "this network reached the relay's data limit for 24 hours",
  'day-bytes-total': 'the relay reached its data limit for 24 hours',
  'phone-id': 'the relay refused the phone id (held by another Mac)',
  replaced: "another Thoth server uses this Mac's relay id",
};

export function validUrl(u: unknown): boolean {
  try {
    const x = new URL(u as string);
    // plain ws:// only to loopback (tests); the real relay is behind TLS
    return (
      x.protocol === 'wss:' ||
      (x.protocol === 'ws:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(x.host.replace(/:\d+$/, '')))
    );
  } catch {
    return false;
  }
}

export interface RelayConfig {
  url: string;
  open?: boolean;
  macId: string;
  macSecret: string;
  phone: { id: string; secret: string };
}

export function readConfig(home: string): RelayConfig | null {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(home), 'utf8')) as Partial<RelayConfig>;
    if (!validUrl(c.url) || !ID.test(c.macId ?? '') || !SECRET.test(c.macSecret ?? '')) return null;
    if (!c.phone || !ID.test(c.phone.id || '') || !SECRET.test(c.phone.secret || '')) return null;
    const cfg = c as RelayConfig;
    // an open relay accepts only derived ids: a file that does not fit is no config
    if (
      cfg.open === true &&
      (cfg.macId !== macIdFor(cfg.macSecret) || cfg.phone.id !== phoneIdFor(cfg.macId, sha256(cfg.phone.secret)))
    )
      return null;
    return cfg;
  } catch {
    return null;
  }
}

function writeConfig(home: string, c: RelayConfig): void {
  fs.mkdirSync(home, { recursive: true });
  const p = configPath(home),
    tmp = `${p}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
}

export interface SetupOptions {
  url: string;
  mac?: string | null;
  newPhone?: boolean;
}

/** Set the relay for this Mac. Returns the config.
 * With `mac` ("<id>.<secret>" from `thoth-relay add-mac`): an account on a private relay.
 * Without `mac`: an open relay at `url`; this Mac makes its own secret (kept while the URL stays the
 * same; a secret is never used with a second relay, because a relay sees the secrets of its Macs).
 * The phone credential stays unless `newPhone` (or the Mac credential changed, in open mode, where
 * the phone id is derived from the Mac id); one is made when there is none. */
export function setup(home: string, { url, mac, newPhone = false }: SetupOptions): RelayConfig {
  if (!validUrl(url)) throw new Error('relay URL must be wss://<server>/relay');
  url = url.replace(/\/+$/, '');
  const old = readConfig(home);
  let c: RelayConfig;
  if (mac === undefined || mac === null || mac === '') {
    const keep = old?.open === true && old.url === url;
    const macSecret = keep ? old.macSecret : rnd(32),
      macId = macIdFor(macSecret);
    const secret = keep && !newPhone ? old.phone.secret : rnd(32);
    c = { url, open: true, macId, macSecret, phone: { id: phoneIdFor(macId, sha256(secret)), secret } };
  } else {
    const m = /^([\w-]{8,64})\.([\w-]{32,128})$/.exec(mac.trim());
    if (!m) throw new Error('Mac credential must be <id>.<secret> (from `thoth-relay add-mac` on the server)');
    const phone = !newPhone && old && old.open !== true ? old.phone : { id: rnd(16), secret: rnd(32) };
    c = { url, macId: m[1] ?? '', macSecret: m[2] ?? '', phone };
  }
  writeConfig(home, c);
  return c;
}

export function remove(home: string): void {
  try {
    fs.unlinkSync(configPath(home));
  } catch {
    /* none */
  }
}

/** The relay a Mac uses when its owner set up none: the one the Thoth project runs (open mode). */
export const DEFAULT_URL = 'wss://relay.thoth.build/relay';
/** The default relay for this environment ('' = none). CC_PANEL_RELAY_DEFAULT sets it (empty: none).
 * With the test addresses of lib/pairing.ts (CC_PANEL_REMOTE_TEST_HOST / _LAN_HOST) there is none
 * unless CC_PANEL_RELAY_DEFAULT names one: a test never reaches the project's relay. */
export function defaultUrl(env: NodeJS.ProcessEnv = process.env): string {
  const given = env['CC_PANEL_RELAY_DEFAULT'];
  if (given !== undefined) return validUrl(given) ? given.replace(/\/+$/, '') : '';
  if (env['CC_PANEL_REMOTE_TEST_HOST'] !== undefined || env['CC_PANEL_REMOTE_TEST_LAN_HOST'] !== undefined) return ''; // set, even empty
  return DEFAULT_URL;
}

// "Away from home" turned off by the user: the relay config moves here (0600), so a private relay's
// account is not lost, and its existence means "off" (the default relay is not set up again).
export const offPath = (home: string): string => path.join(home, 'relay.off.json');
export const isOff = (home: string): boolean => fs.existsSync(offPath(home));

/** Set up the default relay when this Mac has no relay and its owner did not turn it off.
 * Returns the config (the one that was there, the new one, or null). */
export function ensureDefault(home: string, env: NodeJS.ProcessEnv = process.env): RelayConfig | null {
  const c = readConfig(home);
  if (c || isOff(home)) return c;
  const url = defaultUrl(env);
  return url ? setup(home, { url }) : null;
}

/** "Away from home" off: no relay in the pairing link; the caller syncs the client (it disconnects
 * and drops the tunnels). Remembered until turnOn. */
export function turnOff(home: string): void {
  const c = readConfig(home);
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${offPath(home)}.${String(process.pid)}.tmp`;
  // an open relay's secret is not kept: turning on again makes a new one (a new scan anyway)
  fs.writeFileSync(tmp, JSON.stringify(c && c.open !== true ? c : {}, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, offPath(home));
  remove(home);
}

/** "Away from home" on again: a private relay that was there gets a new phone credential; else the
 * default relay with a new secret. Either way the phone must scan a new code. Returns the config,
 * or null when there is no relay to use (no default in this environment). */
export function turnOn(home: string, env: NodeJS.ProcessEnv = process.env): RelayConfig | null {
  let old: Partial<RelayConfig> | null = null;
  try {
    old = JSON.parse(fs.readFileSync(offPath(home), 'utf8')) as Partial<RelayConfig> | null;
  } catch {
    /* none */
  }
  let c: RelayConfig | null = null;
  if (old && ne(old.url) && ne(old.macId) && ne(old.macSecret) && old.open !== true && validUrl(old.url))
    c = setup(home, { url: old.url, mac: `${old.macId}.${old.macSecret}`, newPhone: true });
  else if (defaultUrl(env)) {
    remove(home);
    c = setup(home, { url: defaultUrl(env), newPhone: true });
  }
  if (c) {
    try {
      fs.unlinkSync(offPath(home));
    } catch {
      /* gone */
    }
  }
  return c;
}

/** Forget "off" (pair.ts --relay sets a relay by hand). */
export function clearOff(home: string): void {
  try {
    fs.unlinkSync(offPath(home));
  } catch {
    /* none */
  }
}

export interface PairingInfo {
  url: string;
  phoneId: string;
  phoneSecret: string;
}

/** What the pairing link needs: { url, phoneId, phoneSecret } or null. */
export function pairingInfo(home: string): PairingInfo | null {
  const c = readConfig(home);
  return c ? { url: c.url, phoneId: c.phone.id, phoneSecret: c.phone.secret } : null;
}

export interface RetryOptions {
  attempt: number;
  refused?: boolean;
  retryAfterMs?: number;
  maxDelayMs?: number;
  maxRefusedDelayMs?: number;
  random?: () => number;
}

/** The wait before the next connection attempt (ms). Random over the whole range ("full jitter"),
 * so the Macs of a relay that restarted do not all come back in the same second. A refusal of the
 * relay (HTTP status, or its close code "replaced") waits longer, and at least its Retry-After. */
export function retryDelay({
  attempt,
  refused = false,
  retryAfterMs = 0,
  maxDelayMs = 30_000,
  maxRefusedDelayMs = 300_000,
  random = Math.random,
}: RetryOptions): number {
  const cap = refused ? Math.max(maxDelayMs, maxRefusedDelayMs) : maxDelayMs;
  const top = Math.min(cap, 4000 * 2 ** Math.min(attempt, 10));
  const low = Math.min(500, top / 2);
  const wait = low + random() * (top - low);
  // after a Retry-After: that long, plus up to half of it again (still spread out)
  return retryAfterMs > 0 ? Math.max(wait, retryAfterMs * (1 + random() * 0.5)) : wait;
}

type WriteFn = (chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) => void;

/** The Mac's end of a tunnel as a stream. A write is split into frames of at most `maxFrame` bytes:
 * TLS hands over a large answer as one chunk of megabytes, and the relay closes a tunnel that sends
 * a frame over its limit (close 1009). */
export function tunnelStream(d: WebSocket, maxFrame: number = 32 * 1024): Duplex {
  const stream = createWebSocketStream(d);
  const s = stream as unknown as { _write: WriteFn };
  const write = s._write;
  s._write = (chunk, enc, cb) => {
    if (chunk.length <= maxFrame) {
      write.call(stream, chunk, enc, cb);
      return;
    }
    let i = 0;
    const next = (err?: Error | null): void => {
      if (err || i >= chunk.length) {
        cb(err);
        return;
      }
      const part = chunk.subarray(i, i + maxFrame);
      i += maxFrame;
      write.call(stream, part, enc, next);
    };
    next();
  };
  return stream;
}

export interface RelayStatus {
  state: 'off' | 'connecting' | 'connected' | 'limited' | 'error';
  url: string;
  since: number;
  error: string;
  reason: string;
  retryAt: number;
}

export interface RelayClientOptions {
  connect: (stream: Duplex) => boolean;
  log?: (msg: string) => void;
  maxTunnels?: number;
  deadMs?: number;
  maxDelayMs?: number;
  maxRefusedDelayMs?: number;
}

export interface RelayClient {
  sync: (home: string, enabled: boolean) => void;
  stop: () => void;
  dropTunnels: () => number;
  status: RelayStatus;
  tunnels: Set<WebSocket>;
}

interface RelayMessage {
  t?: unknown;
  refused?: unknown[];
  cid?: unknown;
  reason?: unknown;
  retryAfterSec?: unknown;
}

export function createRelayClient({
  connect,
  log = () => {},
  maxTunnels = 8,
  deadMs = 70_000,
  maxDelayMs = 30_000,
  maxRefusedDelayMs = 300_000,
}: RelayClientOptions): RelayClient {
  let cfg: RelayConfig | null = null,
    key = '',
    ws: WebSocket | null = null,
    timer: NodeJS.Timeout | undefined,
    attempt = 0,
    stopped = true,
    lastSeen = 0,
    watchdog: NodeJS.Timeout | undefined,
    limitTimer: NodeJS.Timeout | undefined;
  const tunnels = new Set<WebSocket>();
  // state: off | connecting | connected | limited (connected, but a data limit stops the tunnels) |
  // error (the relay refused this Mac). `reason`: the relay's reason key ('' = none); `error`: the
  // same in words; `retryAt`: when the next attempt is made (ms, 0 = none planned).
  const status: RelayStatus = { state: 'off', url: '', since: 0, error: '', reason: '', retryAt: 0 };
  const set = (state: RelayStatus['state'], error = '', reason = ''): void => {
    status.state = state;
    status.error = error;
    status.reason = reason;
    status.since = Date.now();
  };

  function auth(c: RelayConfig): WebSocket.ClientOptions {
    return {
      headers: { Authorization: `Bearer ${c.macId}.${c.macSecret}` },
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    };
  }

  function openTunnel(c: RelayConfig, cid: string): void {
    if (tunnels.size >= maxTunnels || !/^[\w-]{8,64}$/.test(cid)) return;
    const d = new WebSocket(`${c.url}/data?cid=${encodeURIComponent(cid)}`, auth(c));
    tunnels.add(d);
    d.on('error', () => {});
    d.on('close', () => tunnels.delete(d));
    d.once('open', () => {
      const stream = tunnelStream(d);
      stream.on('error', () => {});
      if (!connect(stream)) d.terminate();
    });
  }

  function dial(): void {
    clearTimeout(timer);
    const c = cfg;
    if (stopped || !c) return;
    status.retryAt = 0;
    if (status.state !== 'error') set('connecting', status.error, status.reason);
    const w = new WebSocket(`${c.url}/mac`, auth(c));
    ws = w;
    let refused = false,
      retryAfterMs = 0,
      openedAt = 0;
    w.on('open', () => {
      openedAt = lastSeen = Date.now();
      w.send(JSON.stringify({ t: 'phones', phones: [{ id: c.phone.id, hash: sha256(c.phone.secret) }] }));
    });
    w.on('ping', () => {
      lastSeen = Date.now();
    });
    w.on('message', (data, isBinary) => {
      lastSeen = Date.now();
      if (isBinary) return;
      let msg: RelayMessage | null;
      try {
        // a text frame: a Buffer with the default binaryType
        const text = Buffer.isBuffer(data)
          ? data.toString()
          : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString();
        msg = JSON.parse(text) as RelayMessage | null;
      } catch {
        return;
      }
      if (!msg) return;
      if (msg.t === 'ok') {
        if (msg.refused && msg.refused.length > 0) {
          set('error', WHY['phone-id'] ?? '', 'phone-id');
          log('relay: phone id refused');
        } else {
          set('connected');
          log(`relay connected (${c.url})`);
        }
      } else if (msg.t === 'open') openTunnel(c, truthy(msg.cid) ? String(msg.cid) : '');
      else if (msg.t === 'limit' && typeof msg.reason === 'string' && status.state !== 'error') {
        // a data limit: the control connection stays, the relay ends and refuses the tunnels until its
        // 24-hour window moves
        const reason = reasonKey(msg.reason);
        if (status.reason !== reason) log(`relay: ${WHY[reason] ?? reason}`);
        set('limited', WHY[reason] ?? `the relay refuses connections (${reason})`, reason);
        clearTimeout(limitTimer);
        const sec = Math.min(3600, Math.max(1, Number(msg.retryAfterSec) || 3600));
        limitTimer = setTimeout(() => {
          if (ws === w && status.state === 'limited') set('connected');
        }, sec * 1000);
        limitTimer.unref();
      }
    });
    w.on('unexpected-response', (_req, res) => {
      const sent = res.headers['x-relay-reason'];
      let reason = '';
      if (sent !== undefined && sent !== '') reason = reasonKey(sent);
      else if (res.statusCode === 401) reason = 'auth';
      refused = true;
      retryAfterMs = Math.min(3600, Math.max(0, Number(res.headers['retry-after']) || 0)) * 1000;
      const code = String(res.statusCode);
      let words = WHY[reason] ?? `the relay answered ${code}${reason ? ` (${reason})` : ''}`;
      if (reason === 'auth')
        words = `${WHY['auth'] ?? ''} (pair a remote client again; for a private relay: pair.ts --relay)`;
      set('error', words, reason || `http-${code}`);
      res.resume();
      w.terminate();
    });
    w.on('error', (e) => {
      if (!refused && status.state !== 'error')
        set('connecting', `cannot reach the relay (${e.message})`, 'unreachable');
    });
    w.on('close', (code) => {
      if (ws !== w) return;
      ws = null;
      clearTimeout(limitTimer);
      if (stopped) return;
      if (code === 4000) {
        refused = true;
        set('error', WHY['replaced'] ?? '', 'replaced');
      } else if (status.state === 'connected' || status.state === 'limited')
        set('connecting', 'the connection to the relay was lost', 'lost');
      // a connection that held for a while starts the backoff again
      if (openedAt && Date.now() - openedAt > 10_000) attempt = 0;
      const delay = retryDelay({ attempt, refused, retryAfterMs, maxDelayMs, maxRefusedDelayMs });
      attempt++;
      status.retryAt = Date.now() + delay;
      timer = setTimeout(dial, delay);
      timer.unref();
    });
  }

  /** Start, restart (config changed) or stop to match `enabled` and the config file. */
  function sync(home: string, enabled: boolean): void {
    const c = enabled ? readConfig(home) : null;
    const k = c ? JSON.stringify(c) : '';
    if (k === key) return;
    stop();
    key = k;
    cfg = c;
    if (!c) {
      set('off');
      return;
    }
    stopped = false;
    attempt = 0;
    status.url = c.url;
    watchdog = setInterval(
      () => {
        // the relay pings every 25 s; a silent connection is dead (sleep, network change)
        if (ws?.readyState === WebSocket.OPEN && Date.now() - lastSeen > deadMs) ws.terminate();
      },
      Math.min(10_000, deadMs / 2),
    );
    watchdog.unref();
    set('connecting');
    dial();
  }

  function stop(): void {
    stopped = true;
    key = '';
    cfg = null;
    clearTimeout(timer);
    clearTimeout(limitTimer);
    clearInterval(watchdog);
    if (ws) {
      const w = ws;
      ws = null;
      try {
        w.terminate();
      } catch {
        /* gone */
      }
    }
    for (const d of tunnels) {
      try {
        d.terminate();
      } catch {
        /* gone */
      }
    }
    tunnels.clear();
    status.retryAt = 0;
    status.url = '';
    set('off');
  }

  /** The pairing token or the certificate changed: the open tunnels end now. The control
   * connection stays (its credential is the Mac's relay credential, not the token). */
  function dropTunnels(): number {
    const n = tunnels.size;
    for (const d of tunnels) {
      try {
        d.terminate();
      } catch {
        /* gone */
      }
    }
    tunnels.clear();
    return n;
  }

  return { sync, stop, dropTunnels, status, tunnels };
}
