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
import fs from 'node:fs';
import path from 'node:path';

export interface HookCommand {
  type: string;
  command: string;
  timeout: number;
}
export interface HookGroup {
  hooks: HookCommand[];
  [key: string]: unknown;
}
export type Hooks = Record<string, HookGroup[]>;

interface Settings {
  remoteControlAtStartup?: boolean;
  hooks?: Hooks;
  [key: string]: unknown;
}

const shq = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`;

/** Add the hook groups of `add` ({ Event: [group, ...] }) to `hooks`, after the groups already there. */
export function mergeHooks(hooks: Hooks | null | undefined, add: Hooks | null | undefined): Hooks {
  const out: Hooks = { ...hooks };
  for (const [event, groups] of Object.entries(add ?? {})) out[event] = [...(out[event] ?? []), ...groups];
  return out;
}

export interface SettingsOptions {
  remoteOff?: boolean;
  hooks?: Hooks | null;
}

/**
 * One settings file in the instance's state folder: `base` (a settings JSON file, or '') plus
 *   - remoteOff: Remote Control off (a test instance)
 *   - hooks:     hook groups to add (the panel's state hooks, lib/hookstate.ts)
 * The base file is never changed.
 */
export function settingsFile(
  base: string,
  home: string,
  { remoteOff = false, hooks = null }: SettingsOptions = {},
): string {
  let settings: Settings = {};
  if (base) {
    try {
      settings = (JSON.parse(fs.readFileSync(base, 'utf8')) as Settings | null) ?? {};
    } catch {
      settings = {};
    }
  }
  if (remoteOff) settings.remoteControlAtStartup = false;
  if (hooks) settings.hooks = mergeHooks(settings.hooks, hooks);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, remoteOff ? 'claude-test-settings.json' : 'claude-settings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}
export const testSettingsFile = (base: string, home: string): string => settingsFile(base, home, { remoteOff: true });

export interface BrainFiles {
  mcp: string;
  settings: string;
}

/**
 * brain: { mcp, settings } (paths of the brain's session files) or null.
 * inst:  the instance (lib/instance.ts): { test, home }.
 * hooks: hook groups to add ({ Event: [group] }), or null.
 * Returns the text to put after `claude` (starts with a space, or is empty).
 */
export function claudeArgs(
  brain: BrainFiles | null | undefined,
  inst: { test?: string; home: string } | null | undefined,
  hooks: Hooks | null = null,
): string {
  let settings = brain ? brain.settings : '';
  const remoteOff = Boolean(inst?.test);
  if (remoteOff || hooks) settings = settingsFile(settings, inst?.home ?? '', { remoteOff, hooks });
  return (brain ? ` --mcp-config ${shq(brain.mcp)}` : '') + (settings ? ` --settings ${shq(settings)}` : '');
}

/**
 * The panel's state hooks: every event of lib/hookstate.ts is sent to this server's /api/hook.
 * curl gives up after 1 s and the hook always succeeds, so a stopped server never slows Claude
 * down or shows a hook error. Sync (not async) so the events arrive in order.
 */
// PostToolUseFailure: no state change; its error text can name a missing macOS permission (lib/permneed.ts)
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
];
export function stateHooks(port: number | string, events: readonly string[] = HOOK_EVENTS): Hooks {
  const out: Hooks = {};
  for (const e of events) {
    const command =
      `curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' -H "X-Pane: $TMUX_PANE" ` +
      `--data-binary @- 'http://127.0.0.1:${String(Number(port))}/api/hook?event=${e}' || true`;
    out[e] = [{ hooks: [{ type: 'command', command, timeout: 3 }] }];
  }
  return out;
}
