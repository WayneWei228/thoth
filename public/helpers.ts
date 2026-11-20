// A helper computer's sessions in the web panel (lib/peer.ts; the Mac app: Models.swift Session.isRemote /
// isOffline, SessionDetailViewController.reload, SessionsViewController.section, HomeViewController,
// main.swift notifications, ChatBridge "openSent"). Pure rules, no DOM, so a unit test can import them.

export interface HelperSession {
  device?: string | undefined;
  offline?: boolean | undefined;
  state: string;
  running: boolean;
  folder: string;
}

/** A new session on a helper that has not started yet (preparing) or did not start (failed): it can
 * only be closed, which cancels it there (Models.swift Session.isPending; lib/remote_new.ts). */
export const isPending = (s: { state: string }): boolean => s.state === 'preparing' || s.state === 'failed';

/** A session on one of the owner's helper computers (it has the device's name). */
export const isRemote = (s: { device?: string | undefined }): boolean => (s.device ?? '') !== '';
/** The helper does not answer now: its last known state, shown grey. */
export const isOffline = (s: { offline?: boolean | undefined }): boolean => s.offline === true;

/** The helper computer of a chat window id `r:<device>:<window>` (lib/peer.ts parseRemoteId), else ''. */
export function helperOf(win: string): string {
  return /^r:([a-z\d][a-z\d-]{0,30}):/.exec(win)?.[1] ?? '';
}

/** What the Session page shows for a session (SessionDetailViewController.reload). */
export interface DetailView {
  chatOnly: boolean; // no Chat / Terminal switch, no terminal: a helper's session is Chat only
  localOnly: boolean; // Show in Finder and VS Code: only for this Mac's session
  close: boolean; // not for an offline helper (a pending row on a helper: closing it cancels it)
  rename: boolean; // a row still preparing cannot be renamed
  start: boolean;
  stop: boolean;
  composer: boolean;
  choices: boolean;
}
export function detailView(s: HelperSession, mode: 'chat' | 'terminal'): DetailView {
  const remote = isRemote(s),
    off = isOffline(s),
    pending = isPending(s);
  const chat = mode === 'chat' || remote;
  return {
    chatOnly: remote,
    localOnly: !remote,
    close: !off || pending,
    rename: !pending,
    start: !s.running && !off && !pending,
    stop: s.state === 'working' && !off,
    composer: chat && s.running && !off,
    choices: chat && !off,
  };
}

/** The path line: "on <device>  ·  <folder>" for a helper's session, else this Mac's short path. */
export function placeText(s: HelperSession, short: (p: string) => string): string {
  if (!isRemote(s)) return short(s.folder);
  return s.folder ? `on ${s.device ?? ''}  ·  ${s.folder}` : `on ${s.device ?? ''}`;
}

/** The notice of a helper that does not answer (it replaces the state notice). */
export const offlineNotice = (device: string): string =>
  `${device} does not answer now (asleep, off, or no network). This is the last state it sent. Thoth connects again by itself.`;

/** Home's "Needs you" and notifications leave out an offline helper's session: it cannot answer. */
export const needsYou = (s: HelperSession): boolean => s.state === 'needs' && !isOffline(s);
export const mayNotify = (s: HelperSession): boolean => !isOffline(s);

/** All Sessions groups by folder; a helper's folder is its own group (same path, other computer). */
export const groupKey = (s: HelperSession): string => (isRemote(s) ? `${s.device ?? ''}\u0000` : '') + s.folder;

/** A section's path line (SessionsViewController.section): "on <device> · offline  ·  <folder>". */
export function sectionPlace(folder: string, items: HelperSession[], short: (p: string) => string): string {
  const device = items[0]?.device ?? '';
  if (device === '') return short(folder);
  const off = items.every((s) => isOffline(s));
  return `on ${device}${off ? ' · offline' : ''}  ·  ${folder}`;
}

/** The sidebar row's tooltip: "<device>: <folder>" for a helper's session. */
export const rowTip = (s: HelperSession, short: (p: string) => string): string =>
  isRemote(s) ? `${s.device ?? ''}: ${s.folder}` : short(s.folder);

/** A file Claude sent in a helper's session is on that computer: never opened here (ChatBridge).
 * The toast for a click on a sent file in chat window `win`; null = this Mac's file (open it). */
export function sentFileToast(win: string): string | null {
  const device = helperOf(win);
  return device ? `This file is on ${device}` : null;
}

/** The notice of a new session on a helper that is preparing or did not start (`last` has the error). */
export function pendingNotice(s: { state: string; device?: string | undefined; last?: string | undefined }): string {
  const where = s.device !== undefined && s.device !== '' ? s.device : 'the other computer';
  if (s.state === 'preparing')
    return `Thoth is copying this project to ${where} (a new worktree, a clone, or a copy of this folder). The session starts there by itself and shows here. Close it to cancel.`;
  if (s.state === 'failed')
    return `The session did not start on ${where}: ${s.last ?? ''}\nClose it to remove this row.`;
  return '';
}

/** The pending row's one menu item after "Open" (SessionMenu: preparing = Cancel, failed = Remove). */
export const pendingMenuLabel = (state: string): string => (state === 'preparing' ? 'Cancel' : 'Remove');

/** "Computer:" in New Session (NewSessionController.loadPeers): this Mac, then each helper; an offline
 * helper is shown "(offline)" and cannot be chosen. value '' = this Mac. */
export function computerOptions(
  here: string,
  peers: readonly { device: string; online: boolean }[],
): { value: string; label: string; disabled: boolean }[] {
  return [
    { value: '', label: here, disabled: false },
    ...peers.map((p) => ({
      value: p.device,
      label: p.online ? p.device : `${p.device} (offline)`,
      disabled: !p.online,
    })),
  ];
}

/** The history line when a helper is chosen: no previous conversations there. */
export const helperHistoryText = (device: string): string =>
  `A new conversation starts on ${device}, in a copy of this project.`;

/** POST /api/new for New Session: a helper only for a new conversation (no sid); its request id makes a
 * second click start nothing new (lib/remote_new.ts). */
export function newBody(
  folder: string,
  sid: string,
  agent: string,
  device: string,
  requestId: string,
): Record<string, string> {
  const body: Record<string, string> = { folder, sid, agent };
  if (device !== '' && sid === '') {
    body['device'] = device;
    body['requestId'] = requestId;
  }
  return body;
}

/** The open page shows a preparing row that became its session (preparedAs): that session's id. */
export function preparedSession(
  list: readonly { id: string; preparedAs?: string | undefined }[],
  open: string,
): string | null {
  if (list.some((s) => s.id === open)) return null;
  return list.find((s) => s.preparedAs === open)?.id ?? null;
}
