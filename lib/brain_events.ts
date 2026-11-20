// The main panel's event connection to the cloud brain (brain/events.py, GET /api/events).
// The main Mac is behind a router, so the brain cannot connect to it: the panel keeps ONE outbound
// WebSocket with the owner token, and the brain pushes the device list when a computer asks to join
// or a request is decided (and once on every connect). No polling. A dropped connection is opened
// again after 1, 2, 4 … 30 s; a brain that refuses or has no /api/events (an older brain) is asked
// again after 10 minutes (a 5xx while it restarts: like a drop). The brain pings every 25 s; no frame for 75 s means the connection is dead.
import { WebSocket } from 'ws';

export interface EventsTarget {
  url: URL;
  token: string;
}

export const REFUSED_MS = 10 * 60_000;
const DEAD_MS = 75_000;

export function eventsUrl(base: URL): string {
  const u = new URL('/api/events', base);
  u.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

/** The device list of a `devices` message, else null. */
export function parseDevices(text: string): unknown[] | null {
  try {
    const m = JSON.parse(text) as { type?: unknown; devices?: unknown };
    return m.type === 'devices' && Array.isArray(m.devices) ? m.devices : null;
  } catch {
    return null;
  }
}

/** Wait before the next try: `fails` connection drops in a row, `status` of a refused upgrade. */
export function retryAfter(fails: number, status?: number): number {
  // refused (no or wrong token) or no such endpoint (an older brain): asking again soon will not help;
  // a 5xx (Caddy while the brain restarts, a full brain) is like a dropped connection
  if (status !== undefined && [400, 401, 403, 404].includes(status)) return REFUSED_MS;
  return Math.min(30_000, 1000 * 2 ** fails);
}

export class BrainEvents {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dead: NodeJS.Timeout | null = null;
  private fails = 0;
  private on = false;
  private readonly o: {
    target: () => EventsTarget | null;
    onDevices: (list: unknown[]) => void;
    log: (msg: string) => void;
    retry?: (fails: number, status?: number) => number;
    /** no frame for this long = a dead connection (tests make it short) */
    deadMs?: number;
  };
  constructor(o: BrainEvents['o']) {
    this.o = o;
  }

  /** Open the connection (again): call it at start and when the brain location changes. */
  start(): void {
    this.stop();
    this.on = true;
    this.fails = 0;
    this.connect();
  }

  stop(): void {
    this.on = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.dead) clearTimeout(this.dead);
    this.timer = this.dead = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();
    }
  }

  private connect(): void {
    const t = this.o.target();
    if (!this.on || !t) return;
    const ws = new WebSocket(eventsUrl(t.url), { headers: { Authorization: `Bearer ${t.token}` } });
    this.ws = ws;
    let status: number | undefined;
    const alive = (): void => {
      if (this.dead) clearTimeout(this.dead);
      this.dead = setTimeout(() => {
        ws.terminate();
      }, this.o.deadMs ?? DEAD_MS);
      this.dead.unref();
    };
    alive(); // also a connect that never opens
    ws.on('open', () => {
      this.fails = 0;
      alive();
      this.o.log(`connected to ${t.url.host}`);
    });
    ws.on('ping', alive);
    ws.on('message', (data: Buffer) => {
      alive();
      const list = parseDevices(data.toString());
      if (list) this.o.onDevices(list);
    });
    ws.on('unexpected-response', (_req, res) => {
      status = res.statusCode;
      this.o.log(`the brain at ${t.url.host} refused the event connection (${String(status)})`);
      ws.terminate();
    });
    ws.on('error', () => undefined); // 'close' follows
    ws.on('close', () => {
      if (this.ws !== ws || !this.on) return;
      if (this.dead) clearTimeout(this.dead);
      this.ws = null;
      const wait = (this.o.retry ?? retryAfter)(this.fails++, status);
      this.timer = setTimeout(() => {
        this.connect();
      }, wait);
      this.timer.unref();
    });
  }
}
