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
  if (screen.options && screen.options.length >= 2) return 'needs'; // a real menu (key hint + selection)
  if (rec.state === 'idle') return 'idle';
  // working / needs: Esc sends no hook. A screen that stayed idle since the last hook ends it.
  if (idleSince && now - Math.max(idleSince, rec.at) >= SETTLE_MS) return 'idle';
  return rec.state;
}
