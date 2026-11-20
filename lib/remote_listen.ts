// The remote listeners for a remote client.
// One TCP listener per address. The first byte of a connection picks the protocol:
//  - 0x16 (a TLS handshake) → TLS with this install's self-signed certificate (lib/remote.ts loadCert)
//  - anything else → plain HTTP, but ONLY on a Tailscale address (`plain: true`; WireGuard encrypts
//    it). A LAN address never serves plain HTTP: the token would cross the Wi-Fi in clear text.
// `connect(stream)` feeds any other byte stream (e.g. a relay tunnel) into the same TLS server.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';

export interface ListenPlanEntry {
  ip: string;
  plain: boolean;
}

export interface RemoteListenerOptions {
  handler: http.RequestListener;
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  log?: (msg: string) => void;
  idleMs?: number;
}

export interface RemoteListeners {
  setCert: (pair: { key: string | Buffer; cert: string }) => void;
  sync: (plan: ListenPlanEntry[], port: number) => Promise<unknown[]>;
  closeAll: () => void;
  dropConnections: () => number;
  connect: (stream: Duplex) => boolean;
  addresses: () => string[];
}

export function createRemoteListeners({
  handler,
  upgrade,
  log = () => {},
  idleMs = 10_000,
}: RemoteListenerOptions): RemoteListeners {
  const servers = new Map<string, { srv: net.Server; plain: boolean }>(); // ip → { srv, plain }
  const open = new Set<Duplex>(); // the connections that are open now (closeAll ends them)
  let tlsServer: https.Server | null = null,
    certPem = '';
  const plainServer = http.createServer(handler);
  plainServer.on('upgrade', upgrade);

  function setCert({ key, cert }: { key: string | Buffer; cert: string }): void {
    if (cert === certPem) return;
    certPem = cert;
    if (tlsServer) {
      tlsServer.setSecureContext({ key, cert, minVersion: 'TLSv1.2' });
    } else {
      tlsServer = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, handler);
      tlsServer.on('upgrade', upgrade);
      tlsServer.on('tlsClientError', (_e, s) => {
        try {
          s.destroy();
        } catch {
          /* gone */
        }
      });
    }
  }

  function onSocket(sock: net.Socket, plain: boolean): void {
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    sock.on('error', () => {});
    // a connection that sends nothing is closed (no idle slots for scanners)
    sock.setTimeout(idleMs, () => sock.destroy());
    sock.once('data', (b: Buffer) => {
      sock.setTimeout(0);
      sock.pause();
      sock.unshift(b);
      if (b[0] === 0x16 && tlsServer) tlsServer.emit('connection', sock);
      else if (plain) plainServer.emit('connection', sock);
      else {
        sock.destroy();
        return;
      }
      process.nextTick(() => sock.resume());
    });
  }

  /** Open listeners for `plan` ([{ ip, plain }]) on `port`; close the others. Resolves when the new
   * listeners are listening (or failed). */
  function sync(plan: ListenPlanEntry[], port: number): Promise<unknown[]> {
    const started: Promise<void>[] = [];
    const want = new Map(plan.map((p) => [p.ip, p]));
    for (const [ip, s] of servers) {
      if (want.get(ip)?.plain !== s.plain) {
        s.srv.close();
        servers.delete(ip);
      }
    }
    for (const { ip, plain } of plan) {
      if (servers.has(ip)) continue;
      const srv = net.createServer((sock) => {
        onSocket(sock, plain);
      });
      started.push(
        new Promise((resolve) => {
          srv.on('error', (e) => {
            log(`remote ${ip}:${String(port)}: ${e.message}`);
            if (servers.get(ip)?.srv === srv) servers.delete(ip);
            resolve();
          });
          srv.listen(port, ip, () => {
            log(
              `remote access on ${ip.includes(':') ? `[${ip}]` : ip}:${String(port)} (${plain ? 'TLS or Tailscale HTTP' : 'TLS only'}, token required)`,
            );
            resolve();
          });
        }),
      );
      servers.set(ip, { srv, plain });
    }
    return Promise.all(started);
  }

  /** Remote access off: no new connections, and the open ones (requests, WebSockets, relay
   * tunnels) end now. A phone that is connected must not stay in after "off". */
  function closeAll(): void {
    for (const [ip, s] of servers) {
      s.srv.close();
      servers.delete(ip);
    }
    dropConnections();
  }

  /** The pairing token or the certificate changed: every open connection ends now (requests,
   * WebSockets, relay tunnels), so a phone that holds the old ones is shut out. The listeners stay:
   * a phone with the new pairing link connects at once. Returns how many connections it ended. */
  function dropConnections(): number {
    const n = open.size;
    for (const sock of open) sock.destroy();
    open.clear();
    return n;
  }

  /** A byte stream from elsewhere (a relay tunnel): TLS only, never plain HTTP, never "local". */
  function connect(stream: Duplex): boolean {
    if (!tlsServer) {
      stream.destroy();
      return false;
    }
    open.add(stream);
    stream.on('close', () => open.delete(stream));
    tlsServer.emit('connection', stream);
    return true;
  }

  return { setCert, sync, closeAll, dropConnections, connect, addresses: () => [...servers.keys()] };
}
