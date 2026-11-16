// Extra arguments for the `claude` command that the panel types into a session window.
//
// Two sources:
//   - the brain's session files (MCP tools + the prompt hook), when the brain is in use;
//   - a test instance (verify, CC_PANEL_INSTANCE): its Claude sessions must not start Remote Control.
//     The user's own ~/.claude/settings.json can have "remoteControlAtStartup": true; every Claude
//     that verify started then appeared as a remote session on the user's other devices. A
//     command-line --settings value wins over the user's file (checked with Claude Code 2.1.322:
//     the "/rc" mark in the header is gone), so a test instance passes the switch there.
//     The user's settings file is never changed, and the user's own instance is not affected.
// Claude gets ONE --settings value: for a test instance it is a file in the instance's state
// folder that holds the brain's session settings (if any) plus the switch.
'use strict';
const fs = require('fs');
const path = require('path');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Add the hook groups of `add` ({ Event: [group, ...] }) to `hooks`, after the groups already there. */
function mergeHooks(hooks, add) {
  const out = { ...(hooks || {}) };
  for (const [event, groups] of Object.entries(add || {})) out[event] = [...(out[event] || []), ...groups];
  return out;
}

/**
 * One settings file in the instance's state folder: `base` (a settings JSON file, or '') plus
 *   - remoteOff: Remote Control off (a test instance)
 *   - hooks:     hook groups to add (the panel's state hooks, lib/hookstate.js)
 * The base file is never changed.
 */
function settingsFile(base, home, { remoteOff = false, hooks = null } = {}) {
  let settings = {};
  if (base) {
    try { settings = JSON.parse(fs.readFileSync(base, 'utf8')) || {}; } catch { settings = {}; }
  }
  if (remoteOff) settings.remoteControlAtStartup = false;
  if (hooks) settings.hooks = mergeHooks(settings.hooks, hooks);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, remoteOff ? 'claude-test-settings.json' : 'claude-settings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}
const testSettingsFile = (base, home) => settingsFile(base, home, { remoteOff: true });

/**
 * brain: { mcp, settings } (paths of the brain's session files) or null.
 * inst:  the instance (lib/instance.js): { test, home }.
 * hooks: hook groups to add ({ Event: [group] }), or null.
 * Returns the text to put after `claude` (starts with a space, or is empty).
 */
function claudeArgs(brain, inst, hooks = null) {
  let settings = brain ? brain.settings : '';
  const remoteOff = !!(inst && inst.test);
  if (remoteOff || hooks) settings = settingsFile(settings, inst.home, { remoteOff, hooks });
  return (brain ? ` --mcp-config ${shq(brain.mcp)}` : '') + (settings ? ` --settings ${shq(settings)}` : '');
}

/**
 * The panel's state hooks: every event of lib/hookstate.js is sent to this server's /api/hook.
 * curl gives up after 1 s and the hook always succeeds, so a stopped server never slows Claude
 * down or shows a hook error. Sync (not async) so the events arrive in order.
 */
// PostToolUseFailure: no state change; its error text can name a missing macOS permission (lib/permneed.js)
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
function stateHooks(port, events = HOOK_EVENTS) {
  const out = {};
  for (const e of events) {
    const command = `curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' -H "X-Pane: $TMUX_PANE" ` +
      `--data-binary @- 'http://127.0.0.1:${Number(port)}/api/hook?event=${e}' || true`;
    out[e] = [{ hooks: [{ type: 'command', command, timeout: 3 }] }];
  }
  return out;
}

module.exports = { claudeArgs, testSettingsFile, settingsFile, mergeHooks, stateHooks, HOOK_EVENTS };
