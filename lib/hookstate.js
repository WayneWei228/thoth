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
//
// Codex (codex-cli 0.167) sends the same events with the same payload fields (session_id,
// tool_name), plus Interrupt when the user presses Esc → idle. It has no Notification event.
//
// Claude sends NO hook when the user presses Esc (an interrupted turn, a cancelled question).
// cmux settles such a turn from terminal activity; we use the screen: when the screen has shown
// an idle input box for SETTLE_MS since the last hook, the session is idle.
'use strict';

const SETTLE_MS = 3000;
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** The state after one hook event, or null when the event does not change the state. */
function hookState(event, payload = {}) {
  switch (event) {
    case 'SessionStart': return 'idle';
    case 'UserPromptSubmit': return 'working';
    case 'PreToolUse': return ASKS.has(payload.tool_name) ? 'needs' : 'working';
    case 'PostToolUse': return 'working';
    case 'PermissionRequest': return 'needs';
    case 'Notification': return /^(permission_prompt|elicitation_dialog)$/.test(payload.notification_type || '') ? 'needs' : null;
    case 'Stop': case 'StopFailure': return 'idle';
    case 'Interrupt': return 'idle'; // Codex only: Esc on a turn or on an approval menu
    case 'SessionEnd': return 'stopped';
    default: return null;
  }
}

/** Apply one event to a record { state, at, sid }. Returns the new record (or the old one). */
function applyHook(rec, event, payload = {}, now = Date.now()) {
  const state = hookState(event, payload);
  if (!state) return rec || null;
  return { state, at: now, sid: payload.session_id || (rec && rec.sid) || '' };
}

/**
 * The state the panel shows.
 *   running:     the agent process runs in the pane (tmux)
 *   screen:      parseScreen() result ({ state, options })
 *   rec:         the hook record of this window, or null (a session started before hooks)
 *   idleSince:   since when the screen has shown 'idle' without a break (ms), or 0
 */
function combine({ running, screen, rec, idleSince = 0, now = Date.now() }) {
  if (!running) return 'stopped';
  if (!rec || rec.state === 'stopped') return screen.state;      // no hooks in this session: the screen
  if (screen.options && screen.options.length >= 2) return 'needs';  // a real menu (key hint + selection)
  if (rec.state === 'idle') return 'idle';
  // working / needs: Esc sends no hook. A screen that stayed idle since the last hook ends it.
  if (idleSince && now - Math.max(idleSince, rec.at) >= SETTLE_MS) return 'idle';
  return rec.state;
}

module.exports = { hookState, applyHook, combine, SETTLE_MS };
