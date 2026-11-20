// Bring the panel's windows back after the Mac restarts.
//
// A restart ends the tmux server and every Claude/Codex in it. The panel keeps a list of its
// windows in windows.json (in its state folder, not in git). When the server starts and finds
// no tmux session, it builds the windows again from that list and resumes the sessions that
// were running before the restart (user request, 2026-11-14). Without the list, it falls back
// to sessions.conf and starts nothing (the old behaviour).
//
// Shutdown can stop Claude a moment before tmux and the server stop. A window that stopped in
// the last GRACE_MS still counts as running, so the last list written before the shutdown
// still says "running".
import fs from 'node:fs';

export const GRACE_MS = 60_000;
const SID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export interface PanelWindow {
  id: string;
  name: string;
  folder: string;
  sid?: string | null;
  agent?: string | null;
  running?: boolean;
}
export interface SavedWindow {
  name: string;
  folder: string;
  sid: string;
  agent: string;
  running: boolean;
}
export interface PlannedWindow {
  name: string;
  folder: string;
  sid: string;
  agent: string;
  run: boolean;
}

/**
 * The list to save from a poll. `sessions` are the panel's windows (snapshot.sessions);
 * `lastRun` (window id -> ms) is updated here: the last time each window had a running agent.
 */
export function record(sessions: PanelWindow[], lastRun: Map<string, number>, now: number = Date.now()): SavedWindow[] {
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of lastRun.keys()) if (!ids.has(id)) lastRun.delete(id);
  return sessions.map((s) => {
    if (s.running === true) lastRun.set(s.id, now);
    const running = s.running === true || now - (lastRun.get(s.id) ?? 0) < GRACE_MS;
    const sid = s.sid ?? '';
    return {
      name: s.name,
      folder: s.folder,
      sid: SID.test(sid) ? sid : '',
      agent: (s.agent ?? '') || 'claude',
      running,
    };
  });
}

/** sessions.conf lines -> windows (none of them run). */
export function fromConf(text: string): SavedWindow[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .map((l) => {
      const [name = '', folder = '', sid = '', agent = ''] = l.split('|').map((x) => x.trim());
      return { name, folder, sid, agent: agent || 'claude', running: false };
    })
    .filter((w) => w.name);
}

export interface WindowLike {
  name?: string | null;
  folder?: string | null;
  sid?: string | null;
  agent?: string | null;
  running?: boolean | null;
}

/**
 * The windows to build after a restart and which of them to resume.
 * saved: the windows.json list, or null. held(sid): true when a live process outside the
 * panel holds that session (VS Code, a terminal): such a window is built but not started.
 */
export function plan(
  saved: (WindowLike | null)[] | null | undefined,
  confText: string | null | undefined,
  held: (sid: string) => boolean = () => false,
  exists: (p: string) => boolean = fs.existsSync,
): PlannedWindow[] {
  const list: (WindowLike | null)[] = Array.isArray(saved) && saved.length > 0 ? saved : fromConf(confText ?? '');
  const out: PlannedWindow[] = [];
  for (const w of list) {
    const name = w?.name ?? '';
    const folder = w?.folder ?? '';
    if (!w || !name || !folder || !exists(folder)) continue;
    const sid = w.sid ?? '';
    out.push({
      name,
      folder,
      sid: SID.test(sid) ? sid : '',
      agent: (w.agent ?? '') || 'claude',
      run: w.running === true && SID.test(sid) && !held(sid),
    });
  }
  return out;
}

/** A window in the tmux session, as the restore compares it with the saved list. */
export interface PresentWindow {
  sid: string;
  name: string;
  folder: string;
}

/** The windows in `tmux list-windows -F '#{@sid}\t#{@label}\t#{window_name}\t#{@folder}\t#{pane_current_path}'`.
 * name: the label, else the window name; folder: @folder, else the pane's folder (as poll records it). */
export function presentWindows(text: string | null): PresentWindow[] {
  return (text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [sid = '', label = '', name = '', folder = '', cwd = ''] = row.split('\t');
      return { sid, name: label || name, folder: folder || cwd };
    });
}

/**
 * The planned windows that the tmux session does not have yet. A restore that was cut off (the
 * server was killed half-way) left some windows; the next start builds only the rest.
 * A window with a session id matches by that id; one without matches by name and folder.
 */
export function missing(windows: PlannedWindow[], present: PresentWindow[]): PlannedWindow[] {
  const sids = new Set(present.map((p) => p.sid).filter(Boolean));
  const named = new Set(present.map((p) => `${p.name}\n${p.folder}`));
  return windows.filter((w) => (w.sid ? !sids.has(w.sid) : !named.has(`${w.name}\n${w.folder}`)));
}

/** Closing window `id` would end the tmux session (it is the only window): a 'home' shell must come first. */
export function isLastWindow(windowIds: string | null, id: string): boolean {
  const ids = (windowIds ?? '').split('\n').filter(Boolean);
  return ids.length === 1 && ids[0] === id;
}

export function load(file: string): unknown[] | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? (v as unknown[]) : null;
  } catch {
    return null;
  }
}

/** Write only when the content changed; write a temporary file first so a crash leaves the old list. */
let lastText = '';
export function save(file: string, list: unknown): boolean {
  const text = JSON.stringify(list, null, 1);
  if (text === lastText) return false;
  try {
    fs.writeFileSync(file + '.tmp', text);
    fs.renameSync(file + '.tmp', file);
    lastText = text;
    return true;
  } catch {
    return false;
  }
}
