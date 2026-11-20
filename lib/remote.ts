// Remote access for a remote client.
// Extra listeners bind ONLY to private LAN addresses (TLS only) and Tailscale addresses (TLS or
// plain HTTP: Tailscale encrypts itself), and need a pairing token on every request. Anyone who
// reaches the panel can type into the terminals, so this is off by default.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ne } from './truthy.ts';

export type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** Tailscale's ranges: 100.64.0.0/10 (CGNAT) and fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(ip: unknown): boolean {
  if (typeof ip !== 'string') return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 100 && b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(ip);
}

/** Tailscale addresses of this machine, from os.networkInterfaces(). */
export function tailscaleAddresses(ifaces: Interfaces | null | undefined): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces ?? {})) {
    for (const a of list ?? []) if (!a.internal && isTailscaleAddress(a.address)) out.push(a.address);
  }
  return [...new Set(out)];
}

/** A private LAN address the phone can reach on the same Wi-Fi: RFC 1918 IPv4 or an IPv6 unique
 * local address (fc00::/7) that is not Tailscale's. Link-local (169.254/16, fe80::/10) is left out:
 * a link-local address needs the phone's own interface name, so it cannot go in a pairing link. */
export function isLanAddress(ip: unknown): boolean {
  if (typeof ip !== 'string' || isTailscaleAddress(ip)) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^f[cd][\da-f]{2}:/i.test(ip);
}

/** Private LAN addresses of this machine (IPv4 first). */
export function lanAddresses(ifaces: Interfaces | null | undefined): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces ?? {})) {
    for (const a of list ?? []) if (!a.internal && isLanAddress(a.address)) out.push(a.address);
  }
  return [...new Set(out)].toSorted((p, q) => Number(p.includes(':')) - Number(q.includes(':')));
}

export interface ListenEntry {
  ip: string;
  plain: boolean;
}

/** The listeners to open: every LAN address (TLS only) and every Tailscale address (TLS or plain).
 * `testHost` (CC_PANEL_REMOTE_TEST_HOST) replaces them with one address that acts like Tailscale;
 * `testLanHost` (CC_PANEL_REMOTE_TEST_LAN_HOST) adds one address that acts like the LAN. */
export function listenPlan(
  ifaces: Interfaces | null | undefined,
  { testHost, testLanHost }: { testHost?: string | undefined; testLanHost?: string | undefined } = {},
): ListenEntry[] {
  if (ne(testHost) || ne(testLanHost)) {
    return [
      ...(ne(testHost) ? [{ ip: testHost, plain: true }] : []),
      ...(ne(testLanHost) ? [{ ip: testLanHost, plain: false }] : []),
    ];
  }
  return [
    ...lanAddresses(ifaces).map((ip) => ({ ip, plain: false })),
    ...tailscaleAddresses(ifaces).map((ip) => ({ ip, plain: true })),
  ];
}

export interface Cert {
  key: string;
  cert: string;
  pin: string;
}

/** The certificate's key is P-256 by name (not explicit curve parameters). */
function namedP256(certPem: string): boolean {
  // a named-curve P-256 SubjectPublicKeyInfo is 91 bytes and names the curve by its OID 1.2.840.10045.3.1.7;
  // with explicit parameters it is much longer (node still reports namedCurve for both)
  try {
    const spki = new crypto.X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
    return spki.length === 91 && spki.includes(Buffer.from('06082a8648ce3d030107', 'hex'));
  } catch {
    return false;
  }
}

/** SHA-256 of the certificate (DER), lowercase hex: what the phone pins. */
export function certPin(certPem: string): string {
  return crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).raw).digest('hex');
}

/** The TLS identity of this install: a self-signed P-256 certificate, made once (key 0600). The
 * phone pins the certificate's SHA-256 (it comes in the pairing link), so no CA is involved.
 * `rotate` makes a new one (every paired phone must pair again). */
export function loadCert(home: string, rotate = false): Cert {
  const dir = path.join(home, 'remote-tls');
  const keyPath = path.join(dir, 'key.pem'),
    certPath = path.join(dir, 'cert.pem');
  if (!rotate) {
    try {
      const key = fs.readFileSync(keyPath, 'utf8'),
        cert = fs.readFileSync(certPath, 'utf8');
      crypto.createPrivateKey(key);
      // a key with explicit curve parameters (LibreSSL `-pkeyopt`, before 2026-11-16) is replaced:
      // Apple's TLS cannot decode such a certificate (alert "decode error", -9859)
      if (namedP256(cert)) return { key, cert, pin: certPin(cert) };
    } catch {
      /* create */
    }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmpKey = keyPath + '.new',
    tmpCert = certPath + '.new';
  fs.rmSync(tmpKey, { force: true });
  // the key: P-256 with the named curve (node makes it; written 0600), then openssl signs the certificate
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(tmpKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.chmodSync(tmpKey, 0o600);
  execFileSync(
    fs.existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl',
    [
      'req',
      '-x509',
      '-new',
      '-key',
      tmpKey,
      '-sha256',
      '-days',
      '3650',
      '-subj',
      '/CN=Thoth remote access',
      '-out',
      tmpCert,
    ],
    { stdio: 'ignore', timeout: 20_000 },
  );
  fs.renameSync(tmpKey, keyPath);
  fs.renameSync(tmpCert, certPath);
  const key = fs.readFileSync(keyPath, 'utf8'),
    cert = fs.readFileSync(certPath, 'utf8');
  return { key, cert, pin: certPin(cert) };
}

/** The Mac's name for the phone's screen ("Wi-Fi · <name>"): the computer name, else the host name.
 * CC_PANEL_COMPUTER_NAME wins (tests and evals), as for the server's state message. */
export function macName(env: NodeJS.ProcessEnv = process.env): string {
  const given = (env['CC_PANEL_COMPUTER_NAME'] ?? '').trim();
  if (given) return given.slice(0, 60);
  try {
    if (process.platform === 'darwin') {
      const n = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (n) return n.slice(0, 60);
    }
  } catch {
    /* fall back */
  }
  return os
    .hostname()
    .replace(/\.local$/, '')
    .slice(0, 60);
}

export interface RelayPairing {
  url?: string;
  phoneId: string;
  phoneSecret: string;
}

/** The pairing link:
 * ccpanel://pair?v=2&hosts=<a,b>&port=<p>&pin=<sha256 hex>&token=<t>[&name=<Mac name>][&relay=<wss url>&rid=<id>&rkey=<secret>] */
export function pairingLink({
  hosts,
  port,
  pin,
  token,
  relay,
  name,
}: {
  hosts: string[];
  port: number | string;
  pin: string;
  token: string;
  relay?: RelayPairing | null | undefined;
  name?: string | null | undefined;
}): string {
  const q = new URLSearchParams({ v: '2', hosts: hosts.join(','), port: String(port), pin, token });
  if (ne(name)) q.set('name', name.slice(0, 60));
  if (relay && ne(relay.url)) {
    q.set('relay', relay.url);
    q.set('rid', relay.phoneId);
    q.set('rkey', relay.phoneSecret);
  }
  return `ccpanel://pair?${q.toString()}`;
}

export function enabled(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CC_PANEL_REMOTE'] === '1' || fs.existsSync(path.join(home, 'remote-enabled'));
}

/** The pairing token: created once (0600); `rotate` makes a new one. */
export function loadToken(home: string, rotate = false): string {
  const p = path.join(home, 'remote-token');
  if (!rotate) {
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t.length >= 32) return t;
    } catch {
      /* create */
    }
  }
  fs.mkdirSync(home, { recursive: true });
  const t = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(p, t + '\n', { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return t;
}

export interface TokenRequest {
  headers?: IncomingHttpHeaders | null;
  url?: string | undefined;
}

/** Token from `Authorization: Bearer <t>` or `?token=<t>` (WebSockets cannot always set headers). */
export function requestToken(req: TokenRequest): string {
  const h = req.headers?.authorization;
  if (ne(h) && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  try {
    return new URL(req.url ?? 'undefined', 'http://x').searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

export function authorized(req: TokenRequest, token: string | null | undefined): boolean {
  const got = Buffer.from(requestToken(req));
  const want = Buffer.from(token ?? '');
  return want.length >= 32 && got.length === want.length && crypto.timingSafeEqual(got, want);
}
