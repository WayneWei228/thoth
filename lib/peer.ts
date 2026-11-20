// Remote panel (multi-device plan, PR 4). The main Mac shows and drives the sessions of the owner's
// helper computers. Every connection goes through the cloud: no LAN address, no open port, no SSH.
//
//   helper Mac                         cloud                              main Mac
//   pairing link ──seal(main's key)──▶ brain /api/peer/link ──owner──▶ open(own key) ──▶ link
//   Thoth server ◀──TLS (pinned to the link's pin), inside a relay tunnel──── this file
//
// - The helper's pairing link (the one a remote client scans: pin, token, relay, phone id and secret) is
//   sealed to the main panel's X25519 key, so the brain keeps only ciphertext (brain/peers.py).
// - The main panel joins the relay as that helper's "phone", runs TLS inside the
//   tunnel and checks the certificate's SHA-256 against the link's pin before it sends a byte, as the
//   remote client does. The helper checks the pairing token on every request, as for a remote client.
// - A helper's session has the id `r:<device>:<window id>` on the main panel; its actions and chat
//   requests go to the helper with the helper's own window id.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

import WebSocket from 'ws';

import * as Relay from './relay_client.ts';

// ---------------------------------------------------------------- sealing ----
// seal: an ephemeral X25519 key, ECDH with the recipient's key, HKDF-SHA256, AES-256-GCM.
// blob = base64url(ephemeral public key 32 | nonce 12 | tag 16 | ciphertext)
const INFO = 'thoth-peer-link-v1';

export interface KeyPair {
  pub: string; // base64url, 32 bytes
  priv: string; // base64url, 32 bytes
}

export function newKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { pub: publicKey.export({ format: 'jwk' }).x ?? '', priv: jwk.d ?? '' };
}

/** A public key's id: the first 16 hex characters of SHA-256 of its 32 bytes (brain/peers.py key_id). */
export const keyId = (pub: string): string =>
  crypto.createHash('sha256').update(Buffer.from(pub, 'base64url')).digest('hex').slice(0, 16);

const KEY = /^[\w-]{43}$/;
const pubKey = (x: string): crypto.KeyObject =>
  crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });

function derive(shared: Buffer, eph: Buffer, to: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([eph, to]), INFO, 32));
}

/** Seal `text` to the public key `pub` (base64url). */
export function seal(pub: string, text: string): string {
  if (!KEY.test(pub)) throw new Error('bad public key');
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubKey(pub) });
  const key = derive(shared, ephPub, Buffer.from(pub, 'base64url'));
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([ephPub, nonce, c.getAuthTag(), ct]).toString('base64url');
}

/** Open a blob sealed to `kp`; null when it is not one (wrong key, changed bytes). */
export function open(kp: KeyPair, blob: string): string | null {
  try {
    const b = Buffer.from(blob, 'base64url');
    if (b.length < 61) return null;
    const ephPub = b.subarray(0, 32),
      nonce = b.subarray(32, 44),
      tag = b.subarray(44, 60),
      ct = b.subarray(60);
    const priv = crypto.createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', x: kp.pub, d: kp.priv },
      format: 'jwk',
    });
    const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pubKey(ephPub.toString('base64url')) });
    const d = crypto.createDecipheriv('aes-256-gcm', derive(shared, ephPub, Buffer.from(kp.pub, 'base64url')), nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** This panel's key pair: <home>/peer-key.json (0600), made once. */
export function loadKeyPair(home: string): KeyPair {
  const p = path.join(home, 'peer-key.json');
  try {
    const k = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<KeyPair>;
    if (KEY.test(k.pub ?? '') && KEY.test(k.priv ?? '')) return k as KeyPair;
  } catch {
    /* make one */
  }
  const kp = newKeyPair();
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${p}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(kp) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
  return kp;
}

/** The helper seals its link to every main panel's key: { key id: blob } (POST /api/peer/link). */
export function sealFor(keys: readonly { id?: unknown; key?: unknown }[], link: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys.slice(0, 8)) {
    const pub = typeof k.key === 'string' ? k.key : '';
    if (KEY.test(pub) && k.id === keyId(pub)) out[keyId(pub)] = seal(pub, link);
  }
  return out;
}

// ------------------------------------------------------------------ links ----
export interface PeerLink {
  pin: string;
  token: string;
  name: string;
  relay: { url: string; id: string; secret: string };
  /** the helper's peer secret (lib/remote_new.ts): only in the link sealed for main panels */
  peer: string;
}

/** A pairing link (lib/remote.ts pairingLink) that has a relay; null otherwise. The LAN hosts of the
 * link are never used (owner decision 2026-11-18: devices reach each other only through the cloud). */
export function parseLink(link: unknown): PeerLink | null {
  if (typeof link !== 'string' || !link.startsWith('ccpanel://pair?') || link.length > 3000) return null;
  const q = new URLSearchParams(link.slice('ccpanel://pair?'.length));
  const pin = q.get('pin') ?? '',
    token = q.get('token') ?? '',
    url = q.get('relay') ?? '',
    id = q.get('rid') ?? '',
    secret = q.get('rkey') ?? '';
  if (q.get('v') !== '2' || !/^[\da-f]{64}$/.test(pin) || !/^[\w-]{32,128}$/.test(token)) return null;
  if (!Relay.validUrl(url) || !/^[\w-]{8,64}$/.test(id) || !/^[\w-]{32,128}$/.test(secret)) return null;
  const peer = q.get('peer') ?? '';
  return {
    pin,
    token,
    name: (q.get('name') ?? '').slice(0, 60),
    relay: { url: url.replace(/\/+$/, ''), id, secret },
    peer: /^[\w-]{32,128}$/.test(peer) ? peer : '',
  };
}

/** The header the main panel sends the helper's peer secret in (checked by lib/remote_new.ts). */
export const PEER_HEADER = 'x-thoth-peer';

// -------------------------------------------------------------- remote ids ----
const DEVICE = /^[a-z\d][a-z\d-]{0,30}$/;
export const remoteId = (device: string, id: string): string => `r:${device}:${id}`;
export function parseRemoteId(s: unknown): { device: string; id: string } | null {
  // @<n>: a session; p-<request id>: a new session still preparing (lib/remote_new.ts)
  const m = typeof s === 'string' ? /^r:([a-z\d][a-z\d-]{0,30}):(@\d+|p-[\da-f]{16})$/.exec(s) : null;
  return m ? { device: m[1] ?? '', id: m[2] ?? '' } : null;
}
export const isRemoteId = (s: unknown): boolean => typeof s === 'string' && s.startsWith('r:');

/** Actions the main panel passes to a helper's session (the ones a remote client may use, A4). */
export const ACTIONS = new Set(['send', 'choose', 'interrupt', 'start', 'rename']);
/** GET paths the main panel passes on for a helper's session (`win` = the session): the chat, its
 * images and tool results, and the files Claude sent (previews; checked by the helper against that
 * session's transcript). */
export const READS = new Set(['/api/chat', '/api/media', '/api/toolResult', '/api/sent', '/api/file']);

export type Decision =
  | { forward: true; device: string; path: string; body: Record<string, unknown> }
  | { forward: false; status: number; error: string };

/** What to do with an action for a helper's session: pass it on (with the helper's window id) or
 * refuse it with a message. */
export function decideAction(name: string, args: Record<string, unknown>): Decision {
  const rid = parseRemoteId(args['id']);
  if (!rid) return { forward: false, status: 400, error: 'No such session' };
  // a row still preparing: closing it cancels the request on the helper; nothing else works yet
  if (rid.id.startsWith('p-')) {
    if (name !== 'close') return { forward: false, status: 400, error: 'This session is not ready yet' };
    return { forward: true, device: rid.device, path: '/api/peerCancel', body: { requestId: rid.id.slice(2) } };
  }
  if (!ACTIONS.has(name))
    return { forward: false, status: 400, error: 'This does not work yet for a session on another computer' };
  if (Array.isArray(args['attachments']) && args['attachments'].length > 0)
    return { forward: false, status: 400, error: 'Files cannot be sent yet to a session on another computer' };
  return { forward: true, device: rid.device, path: `/api/${name}`, body: { ...args, id: rid.id } };
}

/** The main panel's status for a helper's answer: 200 stays, a helper error is 502, any other 400. */
export const replyStatus = (status: number): number => (status === 200 ? 200 : status >= 500 ? 502 : 400);

const SAFE_TYPES = ['application/json', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];
/** The content type a helper's read gets on the main panel: one of a fixed list, never the helper's
 * header text (a header like "application/json, text/html" must not pass); anything else is a
 * download. */
export function safeType(type: string): string {
  const bare = (type.split(/[;,]/)[0] ?? '').trim().toLowerCase();
  return SAFE_TYPES.find((t) => t === bare) ?? 'application/octet-stream';
}

/** The headers of a helper's read on the main panel: never a page on the main panel's origin
 * (sandboxed, no sniffing); a PDF or any other file is a download, not shown in the page. */
export function readHeaders(type: string): Record<string, string> {
  const t = safeType(type);
  const h: Record<string, string> = {
    'Content-Type': t,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  };
  if (t === 'application/pdf' || t === 'application/octet-stream') h['Content-Disposition'] = 'attachment';
  return h;
}

/** The main panel's status for a helper's read: the usual ones stay, anything else is 502. */
export const readStatus = (status: number): number => ([200, 304, 400, 403, 404].includes(status) ? status : 502);

/** The path and query for a helper's read: the helper's window id, never a token. null for a
 * `check` request: its answer is a path on the helper's disk, which the main Mac must never open. */
export function readPath(pathname: string, query: URLSearchParams, id: string): string | null {
  if (query.has('check')) return null;
  const q = new URLSearchParams(query);
  q.set('win', id);
  q.delete('token');
  return `${pathname}?${q.toString()}`;
}

/** The order-free fingerprint of the main panels' keys (the brain lists them newest first, and each
 * panel posts its key every minute, so the order changes). */
export const keysFingerprint = (keys: readonly { id?: unknown }[]): string =>
  keys
    .map((k) => (typeof k.id === 'string' ? k.id : ''))
    .toSorted()
    .join(',');

/** The listeners a computer opens: a helper none (it is reached only through the relay). */
export const listenPlanFor = <T>(helper: boolean, plan: T[]): T[] => (helper ? [] : plan);

// the fields of a helper's session the main panel takes, and how much of them
const TEXT = ['name', 'folder', 'sid', 'state', 'last', 'question', 'branch', 'prompt', 'title', 'live', 'agent'];
const MAX_TEXT = 4000,
  MAX_SESSIONS = 200,
  MAX_OPTIONS = 20;
const cut = (v: unknown, n = MAX_TEXT): string => (typeof v === 'string' ? v.slice(0, n) : '');

/** A helper's session with only known fields, each of a bounded size (a helper is not trusted with
 * more than what the panel shows). */
export function cleanSession(s: Record<string, unknown>): StateSession | null {
  if (typeof s['id'] !== 'string' || !/^(@\d+|p-[\da-f]{16})$/.test(s['id'])) return null;
  const out: StateSession = { id: s['id'] };
  // the request id of a session started from the main panel (its preparing row became this session)
  if (typeof s['request'] === 'string' && /^[\da-f]{16}$/.test(s['request'])) out['request'] = s['request'];
  for (const k of TEXT) if (typeof s[k] === 'string') out[k] = cut(s[k]);
  for (const k of ['index', 'activity']) if (typeof s[k] === 'number' && Number.isFinite(s[k])) out[k] = s[k];
  out['running'] = s['running'] === true;
  out['options'] = (Array.isArray(s['options']) ? s['options'] : []).slice(0, MAX_OPTIONS).flatMap((o: unknown) => {
    const x = o as { n?: unknown; label?: unknown } | null;
    return x && typeof x.n === 'number' && Number.isInteger(x.n) ? [{ n: x.n, label: cut(x.label, 300) }] : [];
  });
  const ask = s['ask'] as { tool?: unknown; detail?: unknown } | undefined;
  if (ask && typeof ask === 'object') out['ask'] = { tool: cut(ask.tool, 100), detail: cut(ask.detail, 1000) };
  return out;
}

/** One session as the state message has it: only the fields this file reads or sets. */
export interface StateSession {
  id: string;
  device?: string;
  offline?: boolean;
  [key: string]: unknown;
}

export interface PeerView {
  device: string;
  online: boolean;
  sessions: StateSession[];
}

/** The state message's sessions: this Mac's, then each helper's (by device name) with
 * `id` = r:<device>:<id>, `device` and `offline`. A helper's own remote sessions are left out (no
 * loops between panels). */
export function mergeSessions(local: readonly object[], peers: readonly PeerView[]): StateSession[] {
  const out = [...local] as StateSession[];
  for (const p of [...peers].sort((a, b) => a.device.localeCompare(b.device))) {
    if (!DEVICE.test(p.device)) continue;
    for (const s of p.sessions.slice(0, MAX_SESSIONS)) {
      if (s.device !== undefined) continue;
      const c = cleanSession(s);
      if (!c) continue;
      const row: StateSession = { ...c, id: remoteId(p.device, c.id), device: p.device, offline: !p.online };
      // the app follows its open preparing row to the session it became
      if (typeof c['request'] === 'string') row['preparedAs'] = remoteId(p.device, `p-${c['request']}`);
      out.push(row);
    }
  }
  return out;
}

// ------------------------------------------------------------- connection ----
export interface Reply {
  status: number;
  body: Buffer;
  type: string;
}

/** A TLS socket to the helper through the relay, checked against the pin before it is handed out
 * (so the pairing token in the first request never reaches another server). */
export function tunnel(link: PeerLink, cb: (err: Error | null, s?: tls.TLSSocket) => void): void {
  const ws = new WebSocket(`${link.relay.url}/phone`, {
    headers: { Authorization: `Bearer ${link.relay.id}.${link.relay.secret}` },
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
  });
  let done = false;
  const finish = (err: Error | null, s?: tls.TLSSocket): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(err, s);
  };
  const timer = setTimeout(() => {
    ws.terminate();
    finish(new Error('the relay tunnel did not open in 15 s'));
  }, 15_000);
  timer.unref();
  ws.once('unexpected-response', (_q, res) => {
    res.resume();
    ws.terminate();
    finish(new Error(`the relay answered ${String(res.statusCode)}`));
  });
  ws.once('error', (e) => {
    finish(e);
  });
  ws.once('open', () => {
    const raw = Relay.tunnelStream(ws);
    raw.on('error', () => {});
    const s = tls.connect({ socket: raw, rejectUnauthorized: false, servername: 'thoth' });
    s.once('error', (e: Error) => {
      finish(e);
    });
    s.once('secureConnect', () => {
      const fp = s.getPeerCertificate().fingerprint256.replaceAll(':', '').toLowerCase();
      if (fp !== link.pin) {
        s.destroy();
        ws.terminate();
        finish(new Error('the helper certificate does not match the pin'));
        return;
      }
      finish(null, s);
    });
  });
}

type CreateConnection = (opts: unknown, cb: (err: Error | null, s?: net.Socket) => void) => net.Socket | undefined;

/** An HTTP agent whose connections are pinned TLS tunnels through the relay. Keep-alive, at most
 * 2 at a time (the relay allows 6 tunnels per phone id; a remote client may use the same one). */
export function relayAgent(link: PeerLink): http.Agent {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1, timeout: 60_000 });
  const create: CreateConnection = (_opts, cb) => {
    tunnel(link, cb);
    return undefined;
  };
  (agent as unknown as { createConnection: CreateConnection }).createConnection = create;
  return agent;
}

export interface Peer {
  device: string;
  link: string;
  view: () => PeerView;
  request: (method: string, apiPath: string, body?: unknown) => Promise<Reply>;
  pollNow: () => void;
  stop: () => void;
  error: () => string;
}

export interface PeerOptions {
  device: string;
  link: string;
  everyMs?: number;
  timeoutMs?: number;
  onChange?: () => void;
}

/** A connection to one helper: its state every `everyMs` (GET /api/state), its sessions kept while
 * it is offline (shown grey), and requests on its behalf. */
export function createPeer({ device, link, everyMs = 1500, timeoutMs = 15_000, onChange }: PeerOptions): Peer {
  const parsed = parseLink(link);
  const agent = parsed ? relayAgent(parsed) : null;
  const life = { stopped: false };
  // a function, so the check after an await reads the value of now (stop() can run meanwhile)
  const isStopped = (): boolean => life.stopped;
  let online = false,
    sessions: StateSession[] = [],
    timer: NodeJS.Timeout | undefined,
    lastKey = '',
    lastError = parsed ? '' : 'the link has no relay',
    running = false;

  function request(method: string, apiPath: string, body?: unknown): Promise<Reply> {
    if (!agent || !parsed) return Promise.reject(new Error(lastError));
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          agent,
          host: 'thoth',
          path: apiPath,
          method,
          timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${parsed.token}`,
            ...(parsed.peer ? { [PEER_HEADER]: parsed.peer } : {}),
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 32 * 1024 * 1024) req.destroy(new Error('answer too large'));
            else chunks.push(c);
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks),
              type: res.headers['content-type'] ?? 'application/json',
            });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('the helper did not answer in time')));
      req.on('error', reject);
      req.end(data);
    });
  }

  function changed(): void {
    const key = JSON.stringify([online, sessions]);
    if (key === lastKey) return;
    lastKey = key;
    onChange?.();
  }

  async function poll(): Promise<void> {
    if (life.stopped || running) return;
    running = true;
    clearTimeout(timer);
    try {
      const r = await request('GET', '/api/state');
      if (r.status !== 200) throw new Error(`the helper answered ${String(r.status)}`);
      const j = JSON.parse(r.body.toString()) as { sessions?: unknown };
      sessions = Array.isArray(j.sessions) ? (j.sessions as StateSession[]) : [];
      online = true;
      lastError = '';
    } catch (e) {
      online = false;
      lastError = e instanceof Error ? e.message : String(e);
    }
    running = false;
    changed();
    if (!isStopped()) {
      // offline: try again less often (the relay limits connections per minute)
      timer = setTimeout(() => void poll(), online ? everyMs : Math.max(everyMs, 10_000));
      timer.unref();
    }
  }

  void poll();
  return {
    device,
    link,
    view: () => ({ device, online, sessions }),
    request,
    pollNow: () => {
      setTimeout(() => void poll(), 150).unref();
    },
    stop: () => {
      life.stopped = true;
      clearTimeout(timer);
      agent?.destroy();
    },
    error: () => lastError,
  };
}

export interface PeerSet {
  sync: (list: readonly { device: string; link: string }[]) => void;
  get: (device: string) => Peer | undefined;
  views: () => PeerView[];
  stop: () => void;
}

/** The helpers this panel knows: one connection each; a changed link replaces the connection, a
 * device no longer in the list goes. */
export function createPeerSet(opts: Omit<PeerOptions, 'device' | 'link'> = {}): PeerSet {
  const peers = new Map<string, Peer>();
  return {
    sync(list) {
      const want = new Map(list.filter((x) => DEVICE.test(x.device)).map((x) => [x.device, x.link]));
      let removed = false;
      for (const [d, p] of peers) {
        if (want.get(d) !== p.link) {
          p.stop();
          peers.delete(d);
          removed = true;
        }
      }
      for (const [device, link] of want)
        if (!peers.has(device)) peers.set(device, createPeer({ ...opts, device, link }));
      if (removed) opts.onChange?.();
    },
    get: (device) => peers.get(device),
    views: () => [...peers.values()].map((p) => p.view()),
    stop() {
      for (const p of peers.values()) p.stop();
      peers.clear();
    },
  };
}
