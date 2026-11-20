// Device pairing. A device joins with a one-time
// code (15 min, single use; only its hash is stored) and gets its own token (only its hash is
// stored). The brain's device listener accepts nothing but join and push.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

import * as Remote from './remote.ts';
import { ne, text, truthy } from './truthy.ts';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
export const CODE_TTL = 15 * 60_000;

/** One computer in the setup state (setup.json). */
export interface Device {
  name: string;
  os?: string;
  self?: boolean;
  connected?: boolean;
  revoked?: boolean;
  joinedAt?: number;
  host?: string;
  tokenHash?: string;
  pair?: { codeHash: string; expires: number };
  pairing?: { expires: number };
  [key: string]: unknown;
}

/** The part of the setup state that this file reads and changes. */
export interface DeviceState {
  devices: Device[];
  brain?: string | null;
  [key: string]: unknown;
}

export function newCode(): string {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += ALPHA[b % ALPHA.length] ?? '';
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const hash = (t: unknown): string => crypto.createHash('sha256').update(String(t)).digest('hex');
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = Buffer.from(a ?? ''),
    B = Buffer.from(b ?? '');
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Addresses devices can reach this machine on: private LAN IPv4 and Tailscale (never public). */
export function deviceAddresses(ifaces: Remote.Interfaces | null | undefined): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces ?? {})) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      const [x, y = Number.NaN] = a.address.split('.').map(Number);
      const priv = x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
      if (priv || Remote.isTailscaleAddress(a.address)) out.push(a.address);
    }
  }
  // Tailscale first: it works away from home and is encrypted
  return [...new Set(out)].toSorted(
    (p, q) => Number(Remote.isTailscaleAddress(q)) - Number(Remote.isTailscaleAddress(p)),
  );
}

/** One copy-paste line for sh, bash and zsh (macOS and Linux).
 * Download, then run: with 'curl | sh' a failed download still exits 0 (an empty script), so the
 * user and scripts would think the device joined (found in the Docker pairing test).
 * The file is a new mktemp file of this user, never a fixed name in /tmp: a second user on the same
 * computer could not overwrite the first user's file, and nobody can prepare the path.
 * It runs in its own sh -c (so it is the same in every login shell, and $f stays out of the user's
 * shell); "$0" is the script's URL and "$@" the arguments, so more arguments (a device name) can be
 * added at the end of the line. Exit code: the failed step's or the script's. The file is removed. */
function posixJoin(scriptUrl: string, args: string): string {
  return `sh -c 'f=$(mktemp) && curl -fsSL "$0" -o "$f" && sh "$f" "$@"; r=$?; rm -f "$f"; exit $r' ${scriptUrl} ${args}`;
}

export interface JoinCommands {
  posix: string;
  windows: string;
}

export function commands(address: string, code: string, name: string): JoinCommands {
  return {
    posix: posixJoin(`http://${address}/join.sh`, `${code} ${name}`),
    windows: `& ([scriptblock]::Create((iwr -UseBasicParsing http://${address}/join.ps1).Content)) ${code} ${name}`,
  };
}

export interface PairStart {
  code: string;
  expires: number;
  device: string;
}

/** Start pairing for a device in the setup state. Returns the code (shown once). */
export function startPair(state: DeviceState, name: string, now: number = Date.now()): PairStart {
  const d = state.devices.find((x) => x.name === name && x.self !== true);
  if (!d) throw new Error(`"${name}" is not one of your other devices`);
  const code = newCode();
  d.pair = { codeHash: hash(code), expires: now + CODE_TTL };
  return { code, expires: d.pair.expires, device: d.name };
}

/** Redeem a code: returns { device, token } or null. Single use. */
export function redeem(
  state: DeviceState,
  code: unknown,
  host: unknown = '',
  now: number = Date.now(),
): { device: string; token: string } | null {
  const h = hash((truthy(code) ? String(code) : '').trim().toUpperCase());
  const d = state.devices.find((x) => x.pair !== undefined && x.pair.expires > now && sameHash(h, x.pair.codeHash));
  if (!d) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  d.tokenHash = hash(token);
  d.connected = true;
  d.revoked = false;
  d.joinedAt = now;
  d.host = String(host).slice(0, 80);
  delete d.pair;
  return { device: d.name, token };
}

export function byToken(state: DeviceState, token: string | null | undefined): Device | null {
  if (!ne(token)) return null;
  const h = hash(token);
  return state.devices.find((x) => ne(x.tokenHash) && sameHash(h, x.tokenHash)) ?? null;
}

export function revoke(state: DeviceState, name: string): Device {
  const d = state.devices.find((x) => x.name === name && x.self !== true);
  if (!d) throw new Error(`"${name}" is not one of your other devices`);
  delete d.tokenHash;
  delete d.pair;
  d.connected = false;
  d.revoked = true;
  return d;
}

// ------------------------------------------------ add / remove after setup ----
// The All Devices page: the user adds a computer or removes one at any time, not only in the wizard.
const NAME = /^[a-z\d][a-z\d-]{0,30}$/;
const OSES = new Set(['macos', 'linux', 'windows']);
export function checkNewDevice(name: string, os: string): void {
  if (!NAME.test(name))
    throw new Error(`Computer name "${name}" is not allowed: use small letters, digits and "-" (up to 31)`);
  if (!OSES.has(os)) throw new Error('Choose macOS, Linux or Windows');
}

/** Add a computer to a brain on this computer: list it and start pairing. `taken` = names the
 * brain already has that are not in this list (for example a computer it reads over SSH).
 * A listed computer that never connected gets a new code. Returns { code, expires, device }. */
export function addDevice(
  state: DeviceState,
  name: string,
  os: string,
  taken: string[] = [],
  now: number = Date.now(),
): PairStart {
  checkNewDevice(name, os);
  const old = state.devices.find((x) => x.name === name);
  if (old?.self === true) throw new Error(`"${name}" is this computer. Give the other computer another name`);
  if (old?.connected === true) throw new Error(`"${name}" is already connected. To connect it again, remove it first`);
  if (!old && taken.includes(name))
    throw new Error(
      `Your brain already has a computer called "${name}". Choose another name, or remove that one first`,
    );
  if (old) old.os = os;
  else state.devices.push({ name, os });
  return startPair(state, name, now);
}

/** Remove a computer from the list: its token and any open code go with it, so it cannot send
 * data again. Returns true when it was in the list. This computer and the brain computer stay. */
export function removeDevice(state: DeviceState, name: string): boolean {
  const d = state.devices.find((x) => x.name === name);
  if (d?.self === true) throw new Error('This computer cannot be removed from its own panel');
  if (d && state.brain === name)
    throw new Error(`"${name}" is your brain. Choose another brain first (setup page: Change the brain)`);
  state.devices = state.devices.filter((x) => x.name !== name);
  return Boolean(d);
}

// ------------------------------------------------- the brain computer moved ----
// A home network gives this computer a new address from time to time. A joined computer must then
// find it again by itself, and must not send its token to another machine that answers on the
// old or a new address. So this computer PROVES that it is the one the device joined: both sides
// know the hash of the device's token (the device has the token, this side stores only the hash).
// proof = HMAC-SHA256(key: token hash, message: the device's random nonce). No secret is sent.
export function prove(state: DeviceState, name: string, nonce: unknown): string | null {
  const n = truthy(nonce) ? String(nonce) : '';
  if (!/^[\w-]{16,100}$/.test(n)) return null;
  const d = state.devices.find((x) => x.name === name && x.self !== true && ne(x.tokenHash));
  if (!d || !ne(d.tokenHash)) return null;
  return crypto.createHmac('sha256', d.tokenHash).update(n).digest('hex');
}

/** Start pairing again for a computer that is already listed (it lost its way, or was set up
 * again). Its sessions in the brain stay; the new code gives it a new token. */
export function reconnect(state: DeviceState, name: string, now: number = Date.now()): PairStart {
  const d = state.devices.find((x) => x.name === name && x.self !== true);
  if (!d) throw new Error(`"${name}" did not join this panel with a code, so it has no join command here`);
  return startPair(state, name, now);
}

/** How long a joined computer may be silent before the page says so. It sends every 5 minutes. */
export const SILENT_MS = 20 * 60_000;

/** The state without secrets (hashes), for the page. */
export function publicView<S extends DeviceState>(state: S): S {
  const s = JSON.parse(JSON.stringify(state)) as S;
  for (const d of s.devices) {
    if (d.pair) d.pairing = { expires: d.pair.expires };
    delete d.pair;
    delete d.tokenHash;
  }
  return s;
}

// ------------------------------------------------------------ cloud brain ----
// the design: devices ask the cloud brain to join (POST /api/join); the owner
// (this panel, with the owner token) sees them as "wants to join" and decides.

/** Join commands for a cloud brain. No code: the device asks and waits for Approve. The brain's
 * address is passed too, so the cloud brain can serve join.sh/join.ps1 as plain static files. */
export function cloudCommands(url: string, code = '', name = ''): JoinCommands {
  const args = [code, name].filter(Boolean).join(' ');
  return {
    posix: posixJoin(`${url}/join.sh`, `--hub ${url}${args ? ' ' + args : ''}`),
    windows: `& ([scriptblock]::Create((iwr -UseBasicParsing ${url}/join.ps1).Content)) -HubUrl ${url}${args ? ' ' + args : ''}`,
  };
}

export const LATER_MS = 60 * 60_000; // "Later": ask again in an hour (or after a restart of the decision)

/** One row of the cloud brain's GET /api/devices (the fields this code reads). */
export interface CloudDeviceRow {
  id?: unknown;
  name?: unknown;
  transport?: unknown;
  sessions?: unknown;
  last_seen?: unknown;
  lastSeen?: unknown;
  os?: unknown;
  host?: unknown;
  status?: unknown;
  last_error?: unknown;
  error?: unknown;
  online?: unknown;
  last_heartbeat?: unknown;
}

export interface CloudItem {
  id: string;
  name: string;
  os: string;
  host: string;
  status: string;
  sessions: number;
  lastSeen: number;
  error: string;
  self: boolean;
  joined: boolean;
  /** from the brain's heartbeat: true/false, null = no heartbeat data (an old agent) */
  online: boolean | null;
  /** ms; 0 = no heartbeat */
  lastHeartbeat: number;
}

export interface CloudLists {
  pending: CloudItem[];
  later: CloudItem[];
  approved: CloudItem[];
  ignored: CloudItem[];
  revoked: CloudItem[];
}

/** String(a || b || '') of the old code: the first truthy value as text. */
const textOr = (...values: unknown[]): string => {
  const v = values.find((x) => truthy(x));
  return v === undefined ? '' : text(v);
};

/** GET /api/devices of the cloud brain -> lists for the page. `later` = { id: until }. */
export function cloudView(
  list: unknown,
  {
    later = {},
    selfName = '',
    now = Date.now(),
  }: { later?: Record<string, number>; selfName?: string; now?: number } = {},
): CloudLists {
  const out: CloudLists = { pending: [], later: [], approved: [], ignored: [], revoked: [] };
  for (const d of Array.isArray(list) ? (list as CloudDeviceRow[]) : []) {
    const id = text(d.id ?? d.name ?? '');
    if (!id) continue;
    // the real brain also lists devices it pulls itself (its own machine): show them only when they
    // have sessions, and never offer decisions for them
    const joined = !truthy(d.transport) || d.transport === 'cloud';
    if (!joined && !Number(d.sessions)) continue;
    const ls = Number([d.last_seen, d.lastSeen].find((x) => truthy(x)) ?? 0);
    const item: CloudItem = {
      id,
      name: textOr(d.name, id),
      os: textOr(d.os).toLowerCase(),
      host: textOr(d.host),
      status: textOr(d.status, 'approved'),
      sessions: Number(truthy(d.sessions) ? d.sessions : 0),
      lastSeen: ls && ls < 1e12 ? ls * 1000 : ls,
      error: textOr(d.last_error, d.error),
      self: Boolean(selfName) && d.name === selfName,
      joined,
      online: typeof d.online === 'boolean' ? d.online : null,
      lastHeartbeat: Number(d.last_heartbeat ?? 0) * 1000 || 0,
    };
    if (item.status === 'pending') ((later[id] ?? 0) > now ? out.later : out.pending).push(item);
    else if (Object.hasOwn(out, item.status)) out[item.status as keyof CloudLists].push(item);
  }
  return out;
}

export type ConnectErrorKind = 'link' | 'unreachable' | 'certificate' | 'notbrain' | 'refused';

export interface ConnectError {
  kind: string;
  title?: string;
  error?: string;
  steps?: string[];
}

/** A failed connect (link, network, certificate, key) in plain words, with what to check. */
export function connectError(kind: string, host = ''): ConnectError {
  const E: Record<string, { title: string; error: string; steps: string[] }> = {
    link: {
      title: 'This is not a connect link',
      error: 'A connect link starts with ccbrain:// and ends with a long key after #. Copy the whole line again.',
      steps: [
        'On your server, find the line the install printed: ccbrain://…/#…',
        'Copy all of it, with nothing before or after it.',
        'Paste it here and choose Connect.',
      ],
    },
    unreachable: {
      title: 'Your cloud brain does not answer',
      error: `Nothing answers at ${host}. The server may be off, or the install has not finished.`,
      steps: [
        'Check that the server is switched on.',
        'Check that the install on the server finished and printed the link.',
        'Check that this computer is online, then try again.',
      ],
    },
    certificate: {
      title: 'The server has a certificate problem',
      error: `${host} answers, but its security certificate is not valid. The panel does not send your key to it.`,
      steps: [
        'Wait two minutes after the install: the server gets its certificate by itself.',
        "Check that the address in the link is the server's own address.",
        'Try again. If it still fails, run the install on the server again.',
      ],
    },
    notbrain: {
      title: 'This is not a Thoth brain',
      error: `Something answers at ${host}, but it is not a Thoth brain.`,
      steps: [
        'Check that the address in the link is your brain server.',
        'Copy the link again from the install output on the server.',
      ],
    },
    refused: {
      title: 'The brain refused the key',
      error: 'The server is your brain, but it did not accept the key in this link. The link may be old.',
      steps: [
        'Copy the newest link from your server.',
        'If the key was changed on the server, use the new link it printed.',
      ],
    },
  };
  return { kind, ...E[kind] };
}
const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|ERR_TLS|SSL|EPROTO/i;

/** A device file (the panel's own or the device agent's), the fields this code reads. */
export interface DeviceConf {
  token?: string;
  mode?: string;
  hub?: string;
  [key: string]: unknown;
}

/**
 * One computer, one identity on the cloud brain. This computer can hold two device files: the
 * panel's own (<panel home>/cloud-device.json) and the device agent's (~/.cc-brain/device.json,
 * from the join command). When the agent's file is for the same brain, it is the identity of this
 * computer: the panel uses it too, and does not push when the agent pushes on its own schedule
 * (its log changed in the last AGENT_ACTIVE_MS). Otherwise the panel's own file.
 * own, agent: parsed files or null. hub: the brain the panel is connected to.
 * Returns { which: 'agent' | 'own', conf, push } or null.
 */
export const AGENT_ACTIVE_MS = 15 * 60_000;
export function pickIdentity({
  own,
  agent,
  hub,
  agentLogAge = Infinity,
}: {
  own?: DeviceConf | null;
  agent?: DeviceConf | null;
  hub?: string | null;
  agentLogAge?: number;
}): { which: 'agent' | 'own'; conf: DeviceConf; push: boolean } | null {
  const ok = (c: DeviceConf | null | undefined): c is DeviceConf => Boolean(c?.token) && c?.mode === 'cloud';
  if (ok(agent) && ne(hub) && agent.hub === hub)
    return { which: 'agent', conf: agent, push: !(agentLogAge < AGENT_ACTIVE_MS) };
  if (ok(own)) return { which: 'own', conf: own, push: true };
  return null;
}

/** A device name from this computer's host name (a-z, 0-9, -; same rule as device_agent.own_name). */
export function hostName(host: string = os.hostname()): string {
  const n = (host.split('.')[0] ?? '')
    .toLowerCase()
    .replaceAll(/[^a-z\d]/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 31);
  return n || 'computer';
}
/** Network error code (ECONNREFUSED, CERT_HAS_EXPIRED, ...) -> connectError kind. */
export function errorKind(code: unknown): 'certificate' | 'unreachable' {
  return CERT_CODES.test(truthy(code) ? String(code) : '') ? 'certificate' : 'unreachable';
}

/** A JSON file, or null when it is missing or not JSON. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
