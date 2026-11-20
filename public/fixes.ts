// Web panel rules that need no DOM, for the small fixes (app.ts uses them; a test tests them).

/** A state snapshot sent before the server's first tmux poll (server.ts starts with
 * `{ sessions: [], ts: 0 }`; a snapshot with no `platform` is one of tmux being down). Its empty list
 * does not mean the open session went away. */
export const beforeFirstPoll = (m: { ts?: number; platform?: string }): boolean =>
  (m.ts ?? 0) === 0 || m.platform === undefined;

/** Escape on the Session page stops a working session ("Stop (Esc)" in the session menu), when the key
 * is not for the terminal or a text field. (app.ts handles an open dialog or menu first.) Once per
 * working turn, and not on key repeat: two Escapes in a row open Claude Code's rewind menu. */
export const escapeStops = (c: {
  page: string;
  state: string;
  inTerminal: boolean;
  editable: boolean;
  repeat: boolean;
  sent: boolean;
}): boolean => c.page === 'session' && c.state === 'working' && !c.inTerminal && !c.editable && !c.repeat && !c.sent;

/** A session notice shows only when the page is not in front (main.swift post: !NSApp.isActive). A join
 * request's notice shows also when it is (public/joins.ts, main.swift notifyJoin). */
export const showNotice = (p: { hidden: boolean; focused: boolean }): boolean => p.hidden || !p.focused;

export interface Notice {
  title: string;
  body: string;
  id: string;
}
/** The notice for a session whose state changed from `prev` (main.swift notifyChanges), or null. */
export function noticeFor(
  s: { id: string; name: string; state: string; question?: string; last?: string; offline?: boolean },
  prev: string | undefined,
  agent: string,
): Notice | null {
  if (prev === undefined || prev === s.state || s.offline === true) return null;
  if (s.state === 'needs') {
    const q = s.question ?? '';
    return { title: `${s.name} needs you`, body: q === '' ? `${agent} is waiting for your choice.` : q, id: s.id };
  }
  if (prev === 'working' && s.state === 'idle') return { title: `${s.name} is done`, body: s.last ?? '', id: s.id };
  return null;
}

/** The browser has not answered for notices yet: ask it (on the first click, or before the first notice). */
export const mayAskNotices = (permission: string): boolean => permission === 'default';
