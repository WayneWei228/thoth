// Crash restore of the web panel (the app: MainWindow.swift LastPage and refresh, Composer.swift drafts,
// SessionDetailViewController.swift draftKey). Rules that need no DOM; app.ts uses them and
// a test tests them.

import type { Page } from './pages.js';

/** The page saved on every change (MainWindow.swift LastPage), with the session's transcript id. */
export interface LastPage {
  page: Page['name'];
  id?: string;
  sid?: string;
}
export const LAST_PAGE_KEY = 'lastPage';

/** What LastPage.save stores for page `p`. `known`: the transcript id the session has now. A session
 * without one keeps the id saved before for the same window. */
export function lastPageFor(p: Page, known: string, saved: LastPage | null): LastPage {
  if (p.name !== 'session') return { page: p.name };
  const sid = known !== '' ? known : saved?.page === 'session' && saved.id === p.id ? (saved.sid ?? '') : '';
  return { page: 'session', id: p.id, sid };
}

/** The saved page read back (JSON from localStorage), or null when it is not one. */
export function parseLastPage(text: string | null): LastPage | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  const page = str(o['page']);
  if (page === 'home' || page === 'sessions' || page === 'devices') return { page };
  if (page === 'session') return { page, id: str(o['id']), sid: str(o['sid']) };
  return null;
}

/** LastPage.load: the page to open at launch. A session only with a tmux window id (it starts with @). */
export function startPage(saved: LastPage | null): Page {
  if (!saved) return { name: 'home' };
  if (saved.page === 'session')
    return saved.id?.startsWith('@') === true ? { name: 'session', id: saved.id } : { name: 'home' };
  return { name: saved.page };
}

/** LastPage.savedSid: the transcript id saved with window `id`, if the saved page is that window. */
export function savedSid(saved: LastPage | null, id: string): string | null {
  const sid = saved?.page === 'session' && saved.id === id ? (saved.sid ?? '') : '';
  return sid === '' ? null : sid;
}

/** The launch wait of a saved session page (MainWindow.swift restorePending / restoreUntil). */
export interface RestoreWait {
  pending: boolean; // launched on a saved session page; not connected yet
  until: number | null; // the wait ends at this time (8 s after the first connection)
}
export const WAIT_MS = 8000;

export type RestoreStep =
  | { kind: 'open'; id: string } // the saved conversation is in another window now: open that one
  | { kind: 'sessions' } // the session is gone: All Sessions
  | { kind: 'wait' } // look again in 1 s (the server still builds the windows)
  | { kind: 'stay'; confirm: boolean }; // keep the page; confirm: save it as the last page

export interface RestoreInput {
  id: string; // window id of the open session page
  sessions: readonly { id: string; sid?: string | undefined }[];
  connected: boolean;
  restoring: boolean; // the state says the server builds the saved windows again
  saved: LastPage | null;
  now: number;
}

/** MainWindow.swift refresh() for a session page. Returns the step and the new wait. */
export function restoreStep(inp: RestoreInput, w: RestoreWait): { step: RestoreStep; wait: RestoreWait } {
  let { pending, until } = w;
  if (pending && inp.connected) {
    pending = false;
    until = inp.now + WAIT_MS;
  }
  const waiting = pending || inp.restoring || (until !== null && inp.now < until);
  const here = inp.sessions.find((s) => s.id === inp.id);
  const hereSid = here?.sid ?? '';
  // tmux restarted: window ids are given out again, so the saved transcript id decides which window
  // holds the conversation (the same id may now be another conversation)
  const want = savedSid(inp.saved, inp.id);
  const launching = pending || until !== null; // until the saved page is confirmed
  const done = (step: RestoreStep): { step: RestoreStep; wait: RestoreWait } => ({ step, wait: { pending, until } });
  // also while the server rebuilds the windows with the panel open (tmux died): a window id may be
  // another conversation's for a moment
  if (inp.connected && want !== null && (!here || ((launching || inp.restoring) && hereSid !== want))) {
    const s = inp.sessions.find((x) => x.sid === want);
    if (s) {
      until = null;
      return done({ kind: 'open', id: s.id });
    }
    if (waiting) return done({ kind: 'wait' });
    until = null;
    if (!here || hereSid !== '') return done({ kind: 'sessions' });
  }
  if (!here && inp.connected) {
    if (waiting) return done({ kind: 'wait' });
    until = null;
    return done({ kind: 'sessions' });
  }
  const confirm = !!here && (!launching || want === null || hereSid === want || !waiting);
  if (confirm) until = null;
  return done({ kind: 'stay', confirm });
}

/** SessionDetailViewController.draftKey: drafts follow the conversation (transcript id), not the tmux
 * window id; after tmux restarts, window ids are new and could point at another session's draft. */
export const draftKeyFor = (id: string, sid: string | undefined): string =>
  sid !== undefined && sid !== '' ? `sid.${sid}` : id;

/** The storage keys of a draft (Composer.swift: "draft.<key>" text, "draftFiles.<key>" attached files). */
export const textKey = (k: string): string => `draft.${k}`;
export const filesKey = (k: string): string => `draftFiles.${k}`;

/** The attached files saved with a draft (a JSON list of paths), or [] when there are none. */
export function parseFiles(text: string | null): string[] {
  if (text === null) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  } catch {
    return [];
  }
}

/** The few localStorage calls the draft rules need (a fake one in the tests). */
export interface DraftStore {
  get: (k: string) => string | null;
  set: (k: string, v: string | null) => void;
}

/**
 * Composer.moveDraft: the draft in the box moves to a new key (the session got its transcript id).
 * Returns what the box does next; the old keys are removed here.
 * - load: show the draft saved under the new key. An empty box (opened before the server state came);
 *   or the session already has a saved draft (a restore), which wins over the box; or the old key is
 *   another conversation's (sid. to sid.: nothing is moved); or, right after a tmux restart
 *   (`afterRestart`), the box holds a draft saved under a window id that this page load did not write
 *   and that the saved last page does not own: window ids are given out again, so it may be another
 *   conversation's (it is removed, never carried);
 * - carry: the box's draft is saved under the new key (the caller saves it) and removed from the old one.
 * `typed`: the box changed in this page load. `saved`: the last page saved before this page load.
 */
export function moveDraft(
  st: DraftStore,
  m: { old: string; key: string; boxEmpty: boolean; typed: boolean; saved: LastPage | null; afterRestart: boolean },
): 'none' | 'load' | 'carry' {
  const { old, key } = m;
  if (old === key) return 'none';
  if (m.boxEmpty) return 'load';
  // another conversation: its draft stays where it is
  if (old.startsWith('sid.') && key.startsWith('sid.')) return 'load';
  const drop = (): void => {
    st.set(textKey(old), null);
    st.set(filesKey(old), null);
  };
  const win = old.startsWith('@');
  if (st.get(textKey(key)) !== null || st.get(filesKey(key)) !== null) {
    if (win) drop();
    return 'load';
  }
  // a window-id draft from storage right after a tmux restart (the launch restore, or the server
  // reports restoring): only the session that was open when the page was left owns it
  const owned = m.saved?.page === 'session' && m.saved.id === old && (m.saved.sid ?? '') === '';
  if (win && m.afterRestart && !m.typed && !owned) {
    drop();
    return 'load';
  }
  drop();
  return 'carry';
}

/** The draft key a session page opens with. At launch on the saved page with a transcript id, that
 * conversation's key: a window-id draft is not shown while the panel waits for the server, and the
 * draft stays the same when the restore moves to the conversation's new window. */
export function openKey(id: string, sid: string | undefined, saved: LastPage | null): string {
  if (sid !== undefined && sid !== '') return draftKeyFor(id, sid);
  return draftKeyFor(id, savedSid(saved, id) ?? undefined);
}

/** Write the last page only when it changes, and from a session page only for its own window: the
 * transcript id came, or the launch restore confirmed the page. Another tab's choice is kept. */
export function shouldSave(next: LastPage, saved: LastPage | null, launching: boolean): boolean {
  if (JSON.stringify(next) === JSON.stringify(saved)) return false;
  return launching || (saved?.page === 'session' && saved.id === next.id);
}
