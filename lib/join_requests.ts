// Join requests on the main panel: a computer ran `thoth setup --role helper` (or the join command)
// and waits for the owner's Approve on the cloud brain. The cloud brain pushes its device list to the
// server (lib/brain_events.ts) and the server puts the pending requests in the state message (`joins`); the Mac app
// and the web panel show them at the top of the sidebar, and the Mac app posts one notification per
// request id (the server sends a `joinNotice` message once per id: Notices). Approve / Ignore use the setup page's path (POST /api/setupCloudDevice).
import type { CloudLists } from './devices.ts';

export interface JoinRequest {
  id: string;
  name: string;
  os: string;
  host: string;
  /** "<name> wants to join": the notification's and the sidebar item's title */
  title: string;
  /** the system for people: macOS, Windows, Linux */
  system: string;
  /** when it asked (ms since 1970), 0 when unknown */
  asked: number;
  /** the notification's text and the sidebar item's second line (noticeBody) */
  notice?: string;
}

/** Where the owner approves: printed by `thoth setup` while it waits (exit 6). */
export const WHERE = 'In Thoth on your main Mac: the join request at the top of the sidebar, or File > Set Up Devices…';

const OS: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
export const osLabel = (os: string): string => OS[os.toLowerCase()] ?? (os || 'Unknown system');

export const title = (name: string): string => `${name} wants to join`;

/** The requests to show: pending (not postponed with Later), joined over the cloud, not this computer. */
export function fromLists(lists: CloudLists | null): JoinRequest[] {
  return (lists?.pending ?? [])
    .filter((d) => d.joined && !d.self)
    .map((d) => ({
      id: d.id,
      name: d.name,
      os: d.os,
      host: d.host,
      title: title(d.name),
      system: osLabel(d.os),
      asked: d.asked,
    }))
    .map((r) => ({ ...r, notice: noticeBody(r) }));
}

/** A key that changes when the shown requests change (the server broadcasts only then). */
export const key = (list: JoinRequest[]): string =>
  list
    .map((r) => `${r.id}\u0000${r.name}\u0000${r.os}`)
    .toSorted()
    .join('\u0001');

/** How many notified ids are kept. */
export const SEEN_MAX = 100;

/** The requests to notify about (ids not in `seen`), and the new seen list. Old ids stay (newest
 * last, at most SEEN_MAX): a restarted brain or server first gives no list, and the same request must
 * not be notified again after that. */
export function toNotify(list: JoinRequest[], seen: readonly string[]): { notify: JoinRequest[]; seen: string[] } {
  const was = new Set(seen);
  const notify = list.filter((r) => !was.has(r.id));
  return { notify, seen: [...seen, ...notify.map((r) => r.id)].slice(-SEEN_MAX) };
}

/** The server's notified ids (saved in its state folder): `take` gives the requests to send as a
 * `joinNotice` now. While no panel listens nothing is taken, so the panel that connects later gets it. */
export class Notices {
  private seen: string[];
  private readonly save: (seen: string[]) => void;
  constructor(seen: string[], save: (seen: string[]) => void) {
    this.seen = seen;
    this.save = save;
  }
  take(list: JoinRequest[], listening: boolean): JoinRequest[] {
    if (!listening) return [];
    const r = toNotify(list, this.seen);
    if (r.notify.length > 0) {
      this.seen = r.seen;
      this.save(r.seen);
    }
    return r.notify;
  }
}

/** A counter for the list: a decision bumps it, and a background read that started before is dropped
 * (it would bring the decided request back). */
export class Gen {
  private n = 0;
  now(): number {
    return this.n;
  }
  bump(): void {
    this.n++;
  }
  fresh(at: number): boolean {
    return at === this.n;
  }
}

const two = (n: number): string => String(n).padStart(2, '0');
/** The notification's text: the system (and host), when it asked, and a warning: anyone who can reach
 * the cloud brain can ask to join with any name. */
export function noticeBody(r: JoinRequest): string {
  const host = r.host && r.host !== r.name ? ` · ${r.host}` : '';
  const d = new Date(r.asked);
  const at = r.asked > 0 ? `, asked at ${two(d.getHours())}:${two(d.getMinutes())}` : '';
  return `${r.system}${host}${at}. ${WARNING}`;
}

/** Shown with Approve: the name, system and host are what the asking computer says. */
export const WARNING = 'Approve only a computer you set up yourself.';

/** ms until the first "Later" (setup.json cloudLater: id -> until) runs out, null when none is left.
 * The server then shows the request again from the last pushed list (no poll of the brain). */
export function laterWake(later: Record<string, number>, now = Date.now()): number | null {
  const left = Object.values(later)
    .map((until) => until - now)
    .filter((ms) => ms > 0);
  return left.length > 0 ? Math.min(...left) : null;
}
