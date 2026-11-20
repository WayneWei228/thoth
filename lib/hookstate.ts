// Session state from Claude Code hooks (the design of cmux, manaflow-ai/cmux: hook events, not
// the screen). Pure functions, no I/O, so they are tested with event lists.
//
// Event → state (checked with Claude Code 2.1.322):
//   SessionStart → idle         UserPromptSubmit → working     PreToolUse → working
//   PermissionRequest → needs   PostToolUse → working (the user approved; the tool ran)
//   Notification permission_prompt / elicitation_dialog → needs; other types: no change
//   Stop / StopFailure → idle   SessionEnd → stopped           SubagentStop: no change
// PreToolUse of AskUserQuestion / ExitPlanMode → needs (cmux #6606: with permissions skipped,
// Claude sends no PermissionRequest for them).
// A 'needs' record also says what is asked (askOf): the tool and its command, file or address.
//
// Codex (codex-cli 0.167) sends the same events with the same payload fields (session_id,
// tool_name), plus Interrupt when the user presses Esc → idle. It has no Notification event.
//
// Claude sends NO hook when the user presses Esc (an interrupted turn, a cancelled question).
// cmux settles such a turn from terminal activity; we use the screen: when the screen has shown
// an idle input box for SETTLE_MS since the last hook, the session is idle.

export const SETTLE_MS = 3000;
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']);

export type HookStateName = 'idle' | 'working' | 'needs' | 'stopped';

export interface HookEventPayload {
  tool_name?: unknown;
  tool_input?: unknown;
  notification_type?: unknown;
  session_id?: unknown;
  [key: string]: unknown;
}

/** The state after one hook event, or null when the event does not change the state. */
export function hookState(event: string, payload: HookEventPayload = {}): HookStateName | null {
  switch (event) {
    case 'SessionStart': {
      return 'idle';
    }
    case 'UserPromptSubmit': {
      return 'working';
    }
    case 'PreToolUse': {
      return typeof payload.tool_name === 'string' && ASKS.has(payload.tool_name) ? 'needs' : 'working';
    }
    case 'PostToolUse': {
      return 'working';
    }
    case 'PermissionRequest': {
      return 'needs';
    }
    case 'Notification': {
      const type = typeof payload.notification_type === 'string' ? payload.notification_type : '';
      return /^(permission_prompt|elicitation_dialog)$/.test(type) ? 'needs' : null;
    }
    case 'Stop':
    case 'StopFailure': {
      return 'idle';
    }
    case 'Interrupt': {
      return 'idle';
    } // Codex only: Esc on a turn or on an approval menu
    case 'SessionEnd': {
      return 'stopped';
    }
    default: {
      return null;
    }
  }
}

// What a permission request is about: the tool input field a person reads first.
const ASK_DETAIL = new Map<string, string[]>([
  ['Bash', ['command']],
  ['WebFetch', ['url']],
  ['WebSearch', ['query']],
  ['Glob', ['pattern']],
  ['Grep', ['pattern']],
  ...['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].map((t): [string, string[]] => [
    t,
    ['file_path', 'notebook_path'],
  ]),
]);
const ASK_MAX = 2000;

export interface Ask {
  tool: string;
  detail: string;
}

/**
 * What the session asks the user for: { tool, detail }, or null when the event is not a question
 * or does not name its tool. PermissionRequest carries tool_name and tool_input; so does the
 * PreToolUse of the tools in ASKS. `detail` is always a string ('' for a tool not listed above);
 * a Bash command keeps its newlines.
 */
export function askOf(event: string, payload: HookEventPayload = {}): Ask | null {
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || !tool) return null;
  if (event !== 'PermissionRequest' && !(event === 'PreToolUse' && ASKS.has(tool))) return null;
  const input = (
    typeof payload.tool_input === 'object' && payload.tool_input !== null ? payload.tool_input : {}
  ) as Record<string, unknown>;
  const value = (ASK_DETAIL.get(tool) ?? [])
    .map((k) => input[k])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return { tool, detail: (value ?? '').trim().slice(0, ASK_MAX) };
}

export interface HookRecord {
  state: HookStateName;
  at: number;
  sid: string;
  ask?: Ask;
}

/** Apply one event to a record { state, at, sid, ask? }. Returns the new record (or the old one).
 * Only a 'needs' record has `ask`. */
export function applyHook(
  rec: HookRecord | null | undefined,
  event: string,
  payload: HookEventPayload = {},
  now: number = Date.now(),
): HookRecord | null {
  const state = hookState(event, payload);
  if (!state) return rec ?? null;
  const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : '';
  const next: HookRecord = { state, at: now, sid: sid || (rec?.sid ?? '') };
  if (state === 'needs') {
    // Claude Code sends PermissionRequest first and the notification some seconds later, without
    // the tool input: the notification keeps what the request said
    const ask =
      askOf(event, payload) ?? (event === 'Notification' && rec && rec.state === 'needs' ? rec.ask : undefined);
    if (ask) next.ask = ask;
  }
  return next;
}

export interface ScreenLike {
  state: string;
  options?: unknown[] | null;
}

export interface CombineInput {
  running: boolean;
  screen: ScreenLike;
  rec: HookRecord | null | undefined;
  idleSince?: number;
  now?: number;
}

/**
 * The state the panel shows.
 *   running:     the agent process runs in the pane (tmux)
 *   screen:      parseScreen() result ({ state, options })
 *   rec:         the hook record of this window, or null (a session started before hooks)
 *   idleSince:   since when the screen has shown 'idle' without a break (ms), or 0
 */
export function combine({ running, screen, rec, idleSince = 0, now = Date.now() }: CombineInput): string {
  if (!running) return 'stopped';
  if (!rec || rec.state === 'stopped') return screen.state; // no hooks in this session: the screen
  // no input box on screen: Claude cannot take keys, even when a hook said idle (a menu or a running
  // turn from the hooks still wins: a menu replaces the input box)
  if (screen.state === 'starting' && rec.state === 'idle') return 'starting';
  if (screen.options && screen.options.length >= 2) return 'needs'; // a real menu (key hint + selection)
  if (rec.state === 'idle') return 'idle';
  // working / needs: Esc sends no hook. A screen that stayed idle since the last hook ends it.
  if (idleSince && now - Math.max(idleSince, rec.at) >= SETTLE_MS) return 'idle';
  return rec.state;
}

/**
 * Windows whose Claude the panel just started and that have not sent SessionStart yet. Keys typed
 * into such a Claude can be lost, and right after the folder-trust prompt they can stop the window
 * from reading keys at all (staged A->B test, 2026-11-19: the first message of a new remote session
 * was typed 0.2 s after the trust answer, SessionStart came 0.25 s later, and that Claude then ignored
 * every key, also Ctrl-C). Claude runs no hooks before the trust answer, and SessionStart comes when
 * it is ready, so the delivery queue holds messages for these windows until then.
 */
export interface StartGate {
  /** The panel typed `claude` (with the state hooks) into window `id` (at `now`, ms). */
  starting: (id: string, now?: number) => void;
  /** A hook event from window `id`: SessionStart (ready) and SessionEnd (gone) end the hold. */
  hook: (id: string, event: string) => void;
  /**
   * One poll of window `id`. Ends the hold, and returns why, when
   *   - the agent process ended after it ran (the user chose "No, exit" at the trust prompt), or
   *   - the screen has shown the idle input box for `settleMs` (a SessionStart hook that was lost:
   *     the hooks post with a 1 s limit). Returns '' otherwise.
   * A pane that has not run the agent yet is still the shell that `claude` was typed into.
   */
  poll: (id: string, o: { running: boolean; idleSince: number; now?: number }) => string;
  /** Forget the windows that are gone (tmux reuses window ids after its server restarts). `ids` is
   * the window list a poll read at `listedAt`: a window held after that may simply not be in it yet. */
  keep: (ids: ReadonlySet<string>, listedAt: number) => void;
  /** True while nothing may be typed into window `id` yet. */
  waiting: (id: string) => boolean;
}

export function createStartGate(settleMs: number = SETTLE_MS): StartGate {
  const held = new Map<string, { ran: boolean; at: number }>();
  return {
    starting: (id, now = Date.now()) => {
      held.set(id, { ran: false, at: now });
    },
    hook: (id, event) => {
      if (event === 'SessionStart' || event === 'SessionEnd') held.delete(id);
    },
    poll: (id, { running, idleSince, now = Date.now() }) => {
      const h = held.get(id);
      if (!h) return '';
      if (!running) {
        if (!h.ran) return '';
        held.delete(id);
        return 'the agent process ended';
      }
      h.ran = true;
      if (idleSince > 0 && now - idleSince >= settleMs) {
        held.delete(id);
        return `idle for ${String(Math.round((now - idleSince) / 1000))} s without a SessionStart hook`;
      }
      return '';
    },
    keep: (ids, listedAt) => {
      for (const [id, h] of held) if (!ids.has(id) && h.at < listedAt) held.delete(id);
    },
    waiting: (id) => held.has(id),
  };
}

/** What the send action does with a message: a window held for its SessionStart gets it through the
 * delivery queue (typed once Claude is ready); a window whose state is 'starting' (no input box: text
 * typed there waits in the terminal and runs in the shell when Claude exits) is refused; any other
 * window gets it typed now. */
export const sendMode = (gate: StartGate, id: string, state: string): 'queue' | 'refuse' | 'type' =>
  gate.waiting(id) ? 'queue' : state === 'starting' ? 'refuse' : 'type';

/** The send action's check of `tmux send-keys` (null = tmux failed): an error, never an answer that
 * says nothing about a message that was not typed. */
export function checkTyped(out: string | null): void {
  if (out === null) throw new Error('The message could not be typed into this session');
}
