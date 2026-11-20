// Whether an approved computer is online, from the brain's heartbeat (brain/heartbeat.py attach):
// online true/false, or null when the computer never sent a heartbeat (an old agent). setup.ts uses it;
// a test tests it.

export interface Presence {
  online?: boolean | null;
  /** ms; 0 = no heartbeat */
  lastHeartbeat?: number;
  /** ms; the last session upload */
  lastSeen?: number;
}
export type PresenceState = 'online' | 'offline' | 'unknown';

export function presence(d: Presence): PresenceState {
  if (d.online === true) return 'online';
  return d.online === false ? 'offline' : 'unknown';
}

/** "Online", "Offline · last seen X", or (no heartbeat data) "Last sent X" with no online claim. */
export function presenceText(d: Presence, ago: (t: number) => string): string {
  const p = presence(d);
  if (p === 'online') return 'Online';
  const last = (d.lastHeartbeat ?? 0) || (d.lastSeen ?? 0);
  if (p === 'offline') return last > 0 ? `Offline · last seen ${ago(last)}` : 'Offline';
  return (d.lastSeen ?? 0) > 0 ? `Last sent ${ago(d.lastSeen ?? 0)}` : '';
}

/** A computer in All Devices (GET /api/deviceList; EverywhereViewController.swift BrainDevice). */
export interface BrainDevice {
  name: string;
  transport?: string;
  ok?: number | boolean;
  silent?: boolean;
  error?: string;
  sessions?: number;
  /** seconds */
  last_sync?: number | string;
  /** the brain's heartbeat: true/false; null/absent = no heartbeat data (an old agent) */
  online?: boolean | null;
  /** seconds */
  last_heartbeat?: number | null;
}

/** A device chip's detail line, as EverywhereViewController.renderDevices: `good` = green dot,
 * `warn` = orange text. The brain's own error, when it has one, stays the text ("offline: <error>"). */
export function chipText(d: BrainDevice, ago: (ms: number) => string): { text: string; good: boolean; warn: boolean } {
  const ok = d.ok === 1 || d.ok === true;
  const silent = ok && d.silent === true;
  const offline = d.online === false && d.transport !== 'local' && (ok || (d.error ?? '') === '');
  const n = String(d.sessions ?? 0);
  const sync = d.last_sync === undefined || d.last_sync === '' ? null : Number(d.last_sync);
  const synced = sync === null ? 'never' : ago(sync * 1000);
  const seenAt = d.last_heartbeat ?? sync;
  const seen = seenAt === null ? 'Offline' : `Offline · last seen ${ago(seenAt * 1000)}`;
  const text = offline
    ? `${n} sessions · ${seen}`
    : silent
      ? `${n} sessions · nothing new for ${synced}`
      : ok
        ? `${n} sessions · synced ${synced}`
        : `offline: ${d.error ?? ''}`;
  return { text, good: ok && !silent && !offline, warn: silent || offline };
}
