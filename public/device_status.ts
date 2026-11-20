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
