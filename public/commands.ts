// The Ask box's Claude Code commands: the rules and the picker's state that need no DOM
// (CommandMenu.swift CommandPicker). command_menu.ts draws the list; a test tests this.

/** One Claude Code command, from GET /api/commands (lib/commands.ts). */
export interface Command {
  name: string;
  description: string;
  hint: string;
  folders?: string[]; // a project command: only the sessions in these folders have it
}

/** The session fields the session list reads (app.ts Session). */
export interface TargetSession {
  id: string;
  name: string;
  folder: string;
  state: string;
  agent?: string;
  activity?: number;
}

/** A row of the session list. `id` null = a new session in the default folder. */
export interface Target {
  id: string | null;
  title: string;
  detail: string;
}

const NAME_CHAR = /^[\p{L}\p{N}_:.-]+$/u;

/** "/name" or "/name args" → the name; other text (also a file path such as /Users/me/a.txt) → null. */
export function commandName(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const name = /^\S*/.exec(t.slice(1))?.[0] ?? '';
  if (!/^[\p{L}\p{N}]/u.test(name)) return null;
  return NAME_CHAR.test(name) ? name : null;
}

/** The commands for what is typed after "/": the name that is exactly it, names that start with it,
 * then names that contain it, then descriptions that contain it. */
export function matches(all: Command[], query: string): Command[] {
  const q = query.toLowerCase();
  if (q === '') return all;
  const exact: Command[] = []; // the whole name: first, so Enter on a fully typed name sends it
  const starts: Command[] = [];
  const inName: Command[] = [];
  const inText: Command[] = [];
  for (const c of all) {
    const n = c.name.toLowerCase();
    // "brain" finds "superpowers:brainstorming": the part after the plugin name counts as a start
    if (n === q) exact.push(c);
    else if (n.startsWith(q) || (n.split(':').pop() ?? '').startsWith(q)) starts.push(c);
    else if (n.includes(q)) inName.push(c);
    else if (c.description.toLowerCase().includes(q)) inText.push(c);
  }
  return [...exact, ...starts, ...inName, ...inText];
}

/** The command list shows while the text is one word that starts with "/" (and Esc did not close it
 * for this text). */
export const listOpen = (text: string, dismissedFor: string | null): boolean =>
  text.startsWith('/') && !/\s/.test(text) && text !== dismissedFor;

/** A row of the command list: "/name", then the argument hint and the description. */
export const rowOf = (c: Command): { title: string; detail: string } => ({
  title: `/${c.name}`,
  detail: c.hint === '' ? c.description : `${c.hint}  ${c.description}`,
});

// Models.swift SessionState.label
const STATE_LABEL: Record<string, string> = {
  needs: 'Needs you',
  working: 'Working',
  idle: 'Ready',
  stopped: 'Not running',
  elsewhere: 'Open elsewhere',
  preparing: 'Preparing',
  failed: 'Did not start',
};
const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? '';

/** Where a command can run: the Claude sessions (a project command: only those in its folders), the
 * newest first, then "New session" in the default folder (not for a project command). */
export function targets(command: Command, sessions: TargetSession[], defaultFolder: string): Target[] {
  const { folders } = command;
  const out: Target[] = sessions
    .filter((s) => s.agent !== 'codex' && (folders === undefined || folders.includes(s.folder)))
    .toSorted((a, b) => (b.activity ?? 0) - (a.activity ?? 0))
    .map((s) => ({
      id: s.id,
      title: s.name,
      detail: `${baseName(s.folder)} · ${STATE_LABEL[s.state] ?? 'Ready'}`,
    }));
  if (folders === undefined) {
    const folder = baseName(defaultFolder);
    out.push({ id: null, title: 'New session', detail: folder === '' ? 'the default folder' : `in ${folder}` });
  }
  return out;
}

/** What a key does while a list is open; null = the key goes to the text box. `exact`: the selected
 * command is the whole text ("/clear"): Enter then sends it (and asks for the session) instead of
 * only filling the name in. */
export function commandKey(e: {
  key: string;
  shift: boolean;
  composing: boolean;
  mode: 'none' | 'commands' | 'sessions';
  exact: boolean;
}): 'up' | 'down' | 'close' | 'pick' | 'send' | null {
  if (e.mode === 'none' || e.composing) return null;
  switch (e.key) {
    case 'ArrowDown': {
      return 'down';
    }
    case 'ArrowUp': {
      return 'up';
    }
    case 'Escape': {
      return 'close';
    }
    case 'Tab': {
      return 'pick';
    }
    case 'Enter':
    case 'NumpadEnter': {
      if (e.shift) return null;
      return e.mode === 'commands' && e.exact ? 'send' : 'pick';
    }
    default: {
      return null;
    }
  }
}

/** What the picker draws (command_menu.ts: the DOM list; a fake in the tests). */
export interface PickerView {
  show: (items: { title: string; detail: string }[], title: string) => void;
  hide: () => void;
  /** Row `i` is selected; `reveal`: scroll it into view (the keys moved it). */
  select: (i: number, reveal: boolean) => void;
}
export interface PickerDeps {
  view: PickerView;
  text: () => string; // the Ask box's text now
  setText: (t: string) => void;
  clear: () => void;
  submit: () => void; // the Ask box sends again (after the list arrived)
  sessions: () => TargetSession[];
  defaultFolder: () => string;
  toast: (msg: string) => void;
  /** Send the command to `target` (null = a new session in the default folder) and follow it. */
  send: (text: string, files: string[], target: string | null, name: string) => void;
  /** GET /api/commands; an empty list when it fails. */
  fetchList: () => Promise<Command[]>;
  now?: () => number;
}
export interface Picker {
  /** A key in the Ask box; true = the list used it (the caller stops it). */
  key: (e: { key: string; shift: boolean; composing: boolean }) => boolean;
  /** The Ask box is about to send; true = do not send and keep the text (a command waits for its session). */
  sending: (text: string, files: string[]) => boolean;
  textChanged: () => void;
  /** A click on row `i`. */
  pick: (i: number) => void;
  /** The mouse moved over row `i`: it becomes the selected row (Enter then picks it, as a click does). */
  hover: (i: number) => void;
}

type Mode =
  | { kind: 'none' }
  | { kind: 'commands'; found: Command[] }
  | { kind: 'sessions'; text: string; files: string[]; targets: Target[] };

const FRESH_MS = 30_000;

/** The picker (CommandMenu.swift CommandPicker): typing "/" lists the commands; sending a command
 * asks which session runs it. A command never goes through the router. */
export function makePicker(d: PickerDeps): Picker {
  const now = d.now ?? Date.now;
  let mode: Mode = { kind: 'none' };
  let commands: Command[] = [];
  let loadedAt = Number.NEGATIVE_INFINITY;
  let loading = false;
  let waiters: (() => void)[] = [];
  let dismissedFor: string | null = null; // Esc closed the list for this text
  let askedOnSend = false; // the list was asked for once because of a send
  let selected = 0;
  let count = 0;

  /** Calls `done` when the list is here: at once when it is fresh, else after the running (or a new)
   * request for it. Callers that come while a request runs wait for that request. */
  function load(done: () => void): void {
    if (now() - loadedAt < FRESH_MS) {
      done();
      return;
    }
    waiters.push(done);
    if (loading) return;
    loading = true;
    void d
      .fetchList()
      .catch((): Command[] => [])
      .then((list) => {
        if (list.length > 0) {
          commands = list;
          loadedAt = now();
        }
        loading = false;
        const w = waiters;
        waiters = [];
        for (const f of w) f();
      });
  }

  function show(items: { title: string; detail: string }[], title: string): void {
    selected = 0;
    count = items.length;
    d.view.show(items, title);
  }
  function close(): void {
    mode = { kind: 'none' };
    count = 0;
    d.view.hide();
  }
  function select(i: number, reveal: boolean): void {
    if (i < 0 || i >= count || i === selected) return;
    selected = i;
    d.view.select(i, reveal);
  }

  function showCommands(text: string): void {
    const found = matches(commands, text.slice(1));
    if (found.length === 0) {
      close();
      return;
    }
    mode = { kind: 'commands', found };
    show(found.map(rowOf), 'Claude Code commands · ↑↓ to choose · Enter to pick · Esc to close');
  }

  function textChanged(): void {
    const t = d.text();
    if (t !== dismissedFor) dismissedFor = null;
    if (!listOpen(t, dismissedFor)) {
      close();
      return;
    }
    showCommands(t);
    load(() => {
      if (d.text() === t && dismissedFor === null) showCommands(t);
    });
  }

  function pick(i: number): void {
    if (mode.kind === 'commands') {
      const c = mode.found[i];
      if (!c) return;
      close();
      d.setText(`/${c.name} `); // ready for arguments; Enter sends
    } else if (mode.kind === 'sessions') {
      const t = mode.targets[i];
      if (!t) return;
      const { text, files } = mode;
      close();
      d.clear();
      d.send(text, files, t.id, t.title);
    }
  }

  function key(e: { key: string; shift: boolean; composing: boolean }): boolean {
    const exact = mode.kind === 'commands' && `/${mode.found[selected]?.name ?? ''}` === d.text();
    const act = commandKey({ ...e, mode: mode.kind, exact });
    if (act === null) return false;
    if (act === 'send') {
      close(); // the whole name is typed: the box sends it, and the session list opens
      return false;
    }
    if (act === 'down' || act === 'up') {
      if (count > 0) select((selected + (act === 'down' ? 1 : -1) + count) % count, true);
    } else if (act === 'pick') pick(selected);
    else {
      dismissedFor = d.text();
      close();
    }
    return true;
  }

  function sending(text: string, files: string[]): boolean {
    const name = commandName(text);
    if (name === null) return false;
    if (commands.length === 0) {
      if (!askedOnSend) {
        // the list is not here yet (a draft sent right after the page opened): get it, then send again
        askedOnSend = true;
        loadedAt = Number.NEGATIVE_INFINITY;
        load(d.submit);
        return true;
      }
      // still no list (the server could not ask Claude Code): never send a command to the router
      askedOnSend = false;
      d.toast("Could not load Claude Code's commands. Try again in a moment.");
      return true;
    }
    askedOnSend = false;
    const command = commands.find((c) => c.name === name);
    if (!command) return false; // not a command of this user (as the app): an ordinary request
    if (mode.kind === 'sessions') {
      pick(selected);
      return true;
    }
    const list = targets(command, d.sessions(), d.defaultFolder());
    if (list.length === 0) {
      d.toast(`No open session has /${name}`);
      return true;
    }
    mode = { kind: 'sessions', text, files, targets: list };
    show(list, `Run /${name} in · ↑↓ to choose · Enter to send · Esc to cancel`);
    return true;
  }

  load(() => {
    /* ready before the first "/" */
  });
  return {
    key,
    sending,
    textChanged,
    pick,
    hover: (i) => {
      select(i, false);
    },
  };
}

/** Where Try Again sends a command again: a new session that the first try made, while it is still
 * open (so a failed delivery does not make one more session each time); else the first target. */
export function retryTarget(
  target: string | null,
  made: string | undefined,
  sessions: { id: string; name: string }[],
): { id: string; name: string } | null {
  if (target !== null || made === undefined) return null;
  return sessions.find((s) => s.id === made) ?? null;
}
