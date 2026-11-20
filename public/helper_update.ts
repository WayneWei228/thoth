// Helper computers in the sidebar and "Update <device>" (MainWindow.swift .device rows, Models.swift
// PeerInfo; server: peersView, updateHelper, lib/self_update.ts). Rules that need no DOM are exported for
// a test; deviceHeader draws one header (app.ts render calls it).

/** A helper computer this panel knows (`peers` in the state message). `update`: needed | updating |
 * failed | '' (lib/self_update.ts peerStatus); `error`: why the last update failed. */
export interface PeerInfo {
  device: string;
  online: boolean;
  update?: string;
  error?: string;
  commit?: string;
}

/** The words after the device name (PeerInfo.note). */
export function peerNote(p: PeerInfo): string | null {
  if (p.update === 'updating') return 'updating…'; // offline for a moment while it restarts
  const parts = p.online ? [] : ['offline'];
  if (p.update === 'needed') parts.push('update needed');
  else if (p.update === 'failed') parts.push('update failed');
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** "Update <device>" is offered: it is older, or its last update failed (not while one runs). */
export const canUpdate = (p: PeerInfo | undefined): boolean => p?.update === 'needed' || p?.update === 'failed';

/** The header colour: red when the update failed, orange when one is needed. */
export const headerTone = (p: PeerInfo | undefined): '' | 'failed' | 'needed' =>
  p?.update === 'failed' ? 'failed' : p?.update === 'needed' ? 'needed' : '';

/** The header shows the Update / Retry button (and the menu item works): it can be updated and it
 * answers now (PeerInfo.showsUpdateButton). */
export const showsUpdateButton = (p: PeerInfo | undefined): boolean => canUpdate(p) && p?.online === true;

/** What stands on the right of the header: the "Update" button, "Retry" after a failure, a spinner
 * while it updates, or nothing. */
export function rightSide(p: PeerInfo | undefined): '' | 'Update' | 'Retry' | 'spinner' {
  if (showsUpdateButton(p)) return p?.update === 'failed' ? 'Retry' : 'Update';
  return p?.update === 'updating' ? 'spinner' : '';
}

/** The header's tooltip: the error of the last update, then why. */
export function headerTitle(p: PeerInfo): string {
  if (!canUpdate(p)) return '';
  const why = p.error !== undefined && p.error !== '' ? `${p.error}\n` : '';
  return why + (p.online ? 'This computer runs an older Thoth than this Mac.' : 'Offline: update it when it is back.');
}

interface SessionLike {
  id: string;
  state: string;
  device?: string;
  offline?: boolean;
}
export interface DeviceGroup<S extends SessionLike> {
  device: string;
  offline: boolean;
  peer: PeerInfo | undefined;
  sessions: S[];
}

// SessionState.rank in Models.swift
const RANK: Record<string, number> = {
  needs: 0,
  failed: 0,
  working: 1,
  preparing: 1,
  idle: 2,
  elsewhere: 3,
  stopped: 4,
};
const rank = (state: string): number => RANK[state] ?? 2;
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every helper computer (also one without sessions: it may need an update) and each one's sessions,
 * as SidebarViewController.reload: devices sorted by name; sessions by state, newer first, then id. */
export function deviceGroups<S extends SessionLike>(
  peers: PeerInfo[],
  sessions: S[],
  orderKey: (id: string) => number,
): DeviceGroup<S>[] {
  const devices = peers.map((p) => p.device);
  for (const s of sessions)
    if (s.device !== undefined && s.device !== '' && !devices.includes(s.device)) devices.push(s.device);
  return devices.toSorted(byCode).map((device) => {
    const items = sessions
      .filter((s) => s.device === device)
      .toSorted((a, b) => rank(a.state) - rank(b.state) || orderKey(b.id) - orderKey(a.id) || byCode(a.id, b.id));
    const peer = peers.find((p) => p.device === device);
    return { device, offline: peer ? !peer.online : items.every((s) => s.offline === true), peer, sessions: items };
  });
}

/** A unique id for one update click (lib/self_update.ts UPDATE_ID; SessionMenu.newFetchId). */
export function newUpdateId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** A helper computer's sidebar header (MainWindow.swift .device cell): icon, name and note, the
 * colour of the update state, the error as tooltip; on the right the Update / Retry button or a
 * spinner. Right-click opens `onMenu`. Text only (no HTML from the server): the name and the error go
 * in as textContent. */
export function deviceHeader<S extends SessionLike>(
  g: DeviceGroup<S>,
  iconSvg: string,
  on: { menu: (x: number, y: number) => void; update: () => void },
): HTMLDivElement {
  const h = document.createElement('div');
  const note = g.peer ? peerNote(g.peer) : g.offline ? 'offline' : null;
  const tone = headerTone(g.peer);
  const right = rightSide(g.peer);
  h.className =
    'side-h side-dev' + (g.offline ? ' off' : '') + (tone ? ` ${tone}` : '') + (right === '' ? '' : ' has-right');
  h.dataset['testid'] = `sidebar.device.${g.device}`;
  h.setAttribute('role', 'heading');
  h.setAttribute('aria-level', '3');
  h.setAttribute('aria-label', note === null ? g.device : `${g.device}, ${note}`);
  h.innerHTML = iconSvg; // a fixed icon from app.ts
  const t = document.createElement('span');
  t.className = 'dn';
  t.textContent = note === null ? g.device : `${g.device} · ${note}`;
  if (g.peer) t.title = headerTitle(g.peer);
  h.append(t);
  if (right === 'spinner') {
    const sp = document.createElement('span');
    sp.className = 'dev-spin';
    sp.dataset['testid'] = `sidebar.device.${g.device}.updating`;
    sp.setAttribute('aria-label', 'Updating');
    h.append(sp);
  } else if (right !== '') {
    const b = document.createElement('button');
    b.className = 'dev-update' + (right === 'Retry' ? ' retry' : '');
    b.textContent = right;
    b.title = `Send this Mac's Thoth to ${g.device}: it installs it and restarts (about 20 seconds)`;
    b.dataset['testid'] = `sidebar.device.${g.device}.updateButton`;
    b.addEventListener('click', () => {
      b.disabled = true; // one click; the header shows "updating…" at the next state message
      on.update();
    });
    h.append(b);
  }
  h.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    on.menu(e.clientX, e.clientY);
  });
  return h;
}
