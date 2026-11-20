// `thoth always-on`: keep this Mac on as a helper computer (multi-device plan, PR 2).
//   - launchd user services run the Thoth server (with its relay client) and the brain without the
//     app, start them at login and restart them when they stop (scripts/services.sh install).
//   - The Mac does not sleep in any case (owner decision 2026-11-19): `pmset -a sleep 0` (AC and
//     battery) and `disablesleep 1` (also with the lid closed). The display may still turn off.
//     `autorestart 1` where the Mac has it: start again after a power failure. `--lid` is an old
//     option; it is accepted and changes nothing (the lid is always included now).
//   - The pmset values from before are saved in <state>/always-on.json, and --undo puts them back.
//     A file from the old always-on (AC only, lid optional) keeps its values: they are still the ones
//     from before the first run; the battery value it lacks is read on the next run (the old command
//     never changed it).
//   - FileVault (and automatic login) is only reported: after a reboot someone must log in once
//     before the user services run. This code never changes it.
// sudo asks for the password once (`sudo -v`), and only when a pmset value must change. All
// commands go through `Deps.run`, so the tests use a fake and never call sudo or pmset.
import fs from 'node:fs';
import path from 'node:path';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program. `interactive`: the program uses this terminal (the sudo password prompt, the
 * output of services.sh); then stdout and stderr in the result are empty. */
export type Runner = (cmd: string, args: readonly string[], interactive?: boolean) => RunResult;

export interface Deps {
  run: Runner;
  /** the folder for always-on.json (CC_PANEL_HOME or ~/.config/cc-panel) */
  stateDir: string;
  /** scripts/services.sh */
  services: string;
  /** `process.platform` */
  platform: string;
  pmset: string;
  sudo: string;
  log: (line: string) => void;
  /** false: no terminal can ask for the sudo password (for example the shell of Claude Code). Default true. */
  tty?: boolean;
}

/** The pmset values this command changes. null: pmset did not show the setting. */
export interface PowerValues {
  acSleep: string | null;
  /** null: no battery (a desktop Mac). Missing (only in a saved file of the old always-on): not
   * recorded yet, so --undo leaves it alone. */
  batterySleep?: string | null;
  autorestart: string | null;
  disablesleep: string | null;
}

export interface SavedState {
  version: 1;
  savedAt: string;
  /** the values from before the first `thoth always-on` */
  before: PowerValues;
  /** the services were installed before (then --undo leaves them) */
  servicesBefore: boolean;
}

export const STATE_FILE = 'always-on.json';

/** Node sets `isTTY` (true) only on a terminal; on a pipe or /dev/null (the shell of Claude Code) it
 * is missing, not false. */
export function hasTerminal(stdin: { isTTY?: boolean }): boolean {
  return stdin.isTTY === true;
}

/** The command line: the action, or an error (an unknown option, or options that do not go together). */
export function parseArgs(
  args: readonly string[],
): { action: 'enable' | 'undo' | 'status' | 'help' } | { error: string } {
  const known = new Set(['--lid', '--undo', '--status', '-h', '--help']);
  const unknown = args.find((a) => !known.has(a));
  if (unknown !== undefined) return { error: `unknown option ${unknown}` };
  const has = (a: string): boolean => args.includes(a);
  if (has('--undo') && (has('--status') || has('--lid'))) return { error: '--undo goes alone' };
  if (has('--status') && has('--lid')) return { error: '--status goes alone' };
  if (has('-h') || has('--help')) return { action: 'help' };
  if (has('--undo')) return { action: 'undo' };
  if (has('--status')) return { action: 'status' };
  // --lid: the old option for the lid; the lid is always included now, so it changes nothing
  return { action: 'enable' };
}

/** The pmset and sudo programs. CC_ALWAYS_ON_PMSET / CC_ALWAYS_ON_SUDO (fakes for the staged test)
 * count only together with the services test switch CC_SERVICES_TEST_SUFFIX: sudo runs this program
 * as root, so a normal run always uses /usr/bin/pmset and /usr/bin/sudo. */
export function programs(env: NodeJS.ProcessEnv): { pmset: string; sudo: string } {
  const testMode = (env['CC_SERVICES_TEST_SUFFIX'] ?? '') !== '';
  const pick = (name: string, real: string): string => {
    const v = env[name] ?? '';
    return testMode && v !== '' ? v : real;
  };
  return { pmset: pick('CC_ALWAYS_ON_PMSET', '/usr/bin/pmset'), sudo: pick('CC_ALWAYS_ON_SUDO', '/usr/bin/sudo') };
}

/** `pmset -g custom` → { 'AC Power': {sleep: '0', ...}, 'Battery Power': {...} }. */
export function parseCustom(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section: Record<string, string> | null = null;
  for (const line of text.split('\n')) {
    const head = /^(\S.*):\s*$/.exec(line);
    if (head?.[1] !== undefined) {
      section = {};
      out[head[1]] = section;
      continue;
    }
    const kv = /^\s+(\S+)\s+(\S+)/.exec(line);
    if (section && kv?.[1] !== undefined && kv[2] !== undefined) section[kv[1]] = kv[2];
  }
  return out;
}

/** The value of `key` in `pmset -g` (the settings in use), or null. */
export function parseLive(text: string, key: string): string | null {
  for (const line of text.split('\n')) {
    const kv = /^\s+(\S+)\s+(\S+)/.exec(line);
    if (kv?.[1] === key && kv[2] !== undefined) return kv[2];
  }
  return null;
}

export function readPower(d: Deps): PowerValues {
  const custom = d.run(d.pmset, ['-g', 'custom']);
  if (custom.code !== 0) throw new Error(`pmset -g custom failed: ${custom.stderr.trim()}`);
  const s = parseCustom(custom.stdout);
  const ac = s['AC Power'] ?? {};
  const battery = s['Battery Power'];
  const live = d.run(d.pmset, ['-g']);
  // a guess here would be saved as the value from before, and --undo would set it
  if (live.code !== 0) throw new Error(`pmset -g failed: ${live.stderr.trim()}`);
  const liveText = live.stdout;
  return {
    acSleep: ac['sleep'] ?? null,
    batterySleep: battery?.['sleep'] ?? null,
    // a desktop Mac shows autorestart; a laptop usually does not have it
    autorestart: ac['autorestart'] ?? parseLive(liveText, 'autorestart'),
    // shown only while it is set
    disablesleep: parseLive(liveText, 'SleepDisabled') ?? '0',
  };
}

/** One pmset call: the scope flag, the key, the value. */
export interface PmsetChange {
  scope: '-a' | '-c' | '-b';
  key: 'sleep' | 'autorestart' | 'disablesleep';
  value: string;
}

/** The pmset calls that make `now` always-on. A value that is already right needs no call. */
export function changesFor(now: PowerValues): PmsetChange[] {
  const out: PmsetChange[] = [];
  const battery = now.batterySleep ?? null;
  if (now.acSleep !== '0' || (battery !== null && battery !== '0')) out.push({ scope: '-a', key: 'sleep', value: '0' });
  // null: this Mac has no autorestart (most laptops); asking pmset for it every run would only fail
  if (now.autorestart !== null && now.autorestart !== '1') out.push({ scope: '-a', key: 'autorestart', value: '1' });
  if (now.disablesleep !== '1') out.push({ scope: '-a', key: 'disablesleep', value: '1' });
  return out;
}

/** The pmset calls that put `before` back. A setting pmset did not show before is set to 0 when it
 * shows now (it was off); one that is still not shown is left alone. A battery value that was never
 * recorded (undefined: a file of the old always-on) is left alone. */
export function restoreFor(now: PowerValues, before: PowerValues): PmsetChange[] {
  const out: PmsetChange[] = [];
  const want = (b: string | null, n: string | null): string | null => {
    if (b === null) return n === null || n === '0' ? null : '0';
    return b === n ? null : b;
  };
  const sleep = want(before.acSleep, now.acSleep);
  if (sleep !== null) out.push({ scope: '-c', key: 'sleep', value: sleep });
  if (before.batterySleep !== undefined) {
    const bs = want(before.batterySleep, now.batterySleep ?? null);
    if (bs !== null) out.push({ scope: '-b', key: 'sleep', value: bs });
  }
  const ar = want(before.autorestart, now.autorestart);
  if (ar !== null) out.push({ scope: '-a', key: 'autorestart', value: ar });
  const ds = want(before.disablesleep, now.disablesleep);
  if (ds !== null) out.push({ scope: '-a', key: 'disablesleep', value: ds });
  return out;
}

const VALUE = /^\d{1,4}$/;

function readSaved(d: Deps): SavedState | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(d.stateDir, STATE_FILE), 'utf8');
  } catch {
    return null;
  }
  const bad = new Error(`${path.join(d.stateDir, STATE_FILE)} is not valid; remove it or fix it by hand`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad;
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad;
  const v = parsed as Partial<SavedState>;
  const ok = (x: unknown): x is string | null => x === null || (typeof x === 'string' && VALUE.test(x));
  const b = v.before;
  if (
    v.version !== 1 ||
    !b ||
    !ok(b.acSleep) ||
    !ok(b.autorestart) ||
    !ok(b.disablesleep) ||
    (b.batterySleep !== undefined && !ok(b.batterySleep))
  ) {
    throw bad;
  }
  const before: PowerValues = { acSleep: b.acSleep, autorestart: b.autorestart, disablesleep: b.disablesleep };
  if (b.batterySleep !== undefined) before.batterySleep = b.batterySleep;
  return { version: 1, savedAt: String(v.savedAt), before, servicesBefore: v.servicesBefore === true };
}

function writeSaved(d: Deps, s: SavedState): void {
  fs.mkdirSync(d.stateDir, { recursive: true });
  const file = path.join(d.stateDir, STATE_FILE);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

const SCOPE = { '-a': 'on AC power and on battery', '-c': 'on AC power', '-b': 'on battery' } as const;

/** One pmset call in words. */
export function describe(c: PmsetChange): string {
  if (c.key === 'sleep') return `sleep ${SCOPE[c.scope]} is now ${c.value === '0' ? 'never' : `after ${c.value} min`}`;
  const on = c.value === '1' ? 'on' : 'off';
  if (c.key === 'disablesleep') return `keep running with the lid closed (disablesleep) is now ${on}`;
  return `start again after a power failure (autorestart) is now ${on}`;
}

/** The admin accounts of this Mac (not root). The name goes into a command the person copies, so
 * only plain account names are kept. */
function adminNames(d: Deps): string[] {
  const r = d.run('/usr/bin/dscl', ['.', '-read', '/Groups/admin', 'GroupMembership']);
  const names =
    r.code === 0
      ? r.stdout
          .replace(/^GroupMembership:/, '')
          .trim()
          .split(/\s+/)
      : [];
  const admins = names.filter((n) => n !== '' && n !== 'root' && /^[A-Za-z_][\w.-]*$/.test(n));
  return admins;
}

/** This user may not run sudo at all (not an admin): the password would not help. */
function notAdminError(d: Deps, changes: readonly PmsetChange[], again: string): Error {
  const user = d.run('/usr/bin/id', ['-un']).stdout.trim() || 'this user';
  const cmds = changes.map((c) => `sudo ${d.pmset} ${c.scope} ${c.key} ${c.value}`).join(' && ');
  const admins = adminNames(d);
  const admin = admins.length === 1 && admins[0] !== undefined ? admins[0] : '<admin>';
  // pasted unchanged, `<admin>` is a shell redirection: say what to put there
  const pick =
    admin !== '<admin>'
      ? ''
      : admins.length > 0
        ? `Replace <admin> with one of: ${admins.join(', ')}.\n`
        : 'Replace <admin> with the name of an admin account of this Mac.\n';
  return new Error(
    `this user (${user}) is not an admin of this Mac, so it cannot change the power settings. The power settings were not changed. ` +
      `Ask an admin of this Mac to run this in the Terminal app (it asks for the admin's password):\n` +
      `  su ${admin} -c '${cmds}'\n` +
      pick +
      `Then run again: ${again}`,
  );
}

/** Runs the pmset calls with sudo. The password is asked once (`sudo -v`), before the first call.
 * First `sudo -n -v` (no prompt): it works when sudo needs no password now, and it tells a user who
 * may not run sudo at all (not an admin); then the error names the commands for an admin. Without a
 * terminal sudo cannot ask: then the error says to run `again` in the Terminal app (the setup prompt
 * tells the person that). */
function applyPmset(d: Deps, changes: readonly PmsetChange[], again: string): void {
  if (changes.length === 0) {
    d.log('   Nothing to change: the power settings were already right. No password was needed.');
    return;
  }
  const probe = d.run(d.sudo, ['-n', '-v']);
  if (probe.code !== 0) {
    if (/may not run sudo|not in the sudoers/i.test(probe.stderr)) throw notAdminError(d, changes, again);
    if (d.tty === false)
      throw new Error(
        `the power settings need your Mac password, and this window has no terminal to ask for it. The power settings were not changed. Open the Terminal app and run: ${again}`,
      );
    d.log('Changing power settings needs your password once (sudo).');
    if (d.run(d.sudo, ['-v'], true).code !== 0) throw new Error('sudo was not allowed; nothing was changed');
  }
  try {
    for (const c of changes) {
      const r = d.run(d.sudo, ['-n', d.pmset, c.scope, c.key, c.value]);
      if (r.code !== 0) throw new Error(`sudo pmset ${c.scope} ${c.key} ${c.value} failed: ${r.stderr.trim()}`);
      d.log(`   changed: ${describe(c)} (pmset ${c.scope} ${c.key} ${c.value})`);
    }
  } finally {
    // the approval would stay valid in this terminal for minutes (other commands there could use it)
    d.run(d.sudo, ['-k']);
  }
}

export type FileVault = 'on' | 'off' | 'unknown';

export function fileVault(d: Deps): FileVault {
  const r = d.run('/usr/bin/fdesetup', ['status']);
  if (r.code !== 0) return 'unknown';
  if (/FileVault is On/i.test(r.stdout)) return 'on';
  if (/FileVault is Off/i.test(r.stdout)) return 'off';
  return 'unknown';
}

function autoLogin(d: Deps): boolean {
  const r = d.run('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']);
  return r.code === 0 && r.stdout.trim() !== '';
}

/** What happens after a reboot (report only). */
export function rebootNote(d: Deps): string {
  const fv = fileVault(d);
  if (fv === 'on') {
    return 'FileVault is on: after a reboot (for example after a power failure) someone must type the password at this Mac once. Until then the Thoth services do not run. This command does not change FileVault.';
  }
  if (autoLogin(d)) {
    return 'Automatic login is on: after a reboot the Thoth services start by themselves. Note: anyone at this Mac then gets a logged-in session with the running Thoth sessions.';
  }
  // state the fact only: automatic login needs FileVault off and opens the Mac to anyone at it
  return 'After a reboot (for example after a power failure) someone must log in at this Mac once. Then the Thoth services start by themselves.';
}

function onAC(d: Deps): boolean | null {
  const r = d.run(d.pmset, ['-g', 'batt']);
  if (r.code !== 0) return null;
  return r.stdout.includes("'AC Power'");
}

function servicesInstalled(d: Deps): boolean {
  return d.run(d.services, ['installed']).code === 0;
}

function macOnly(d: Deps): void {
  if (d.platform !== 'darwin') throw new Error('thoth always-on works on macOS only in this version');
}

function show(v: string | null): string {
  return v ?? 'not shown';
}

/** The power settings, one line each: what it is called and what the value means. */
function powerLines(v: PowerValues): string[] {
  const battery = v.batterySleep ?? null;
  return [
    `sleep on AC power: ${show(v.acSleep)} (0 = never)`,
    `sleep on battery: ${battery === null ? 'no battery' : `${battery} (0 = never)`}`,
    `disablesleep (keeps running with the lid closed): ${show(v.disablesleep)} (1 = on)`,
    `autorestart (start again after a power failure): ${v.autorestart === null ? 'not supported on this Mac' : `${v.autorestart} (1 = on)`}`,
  ];
}

/** `thoth always-on`. Safe to run again: the saved values stay those from the first run. */
export function enable(d: Deps): void {
  macOnly(d);
  const saved = readSaved(d);
  const now = readPower(d);
  const servicesBefore = saved ? saved.servicesBefore : servicesInstalled(d);
  const before: PowerValues = saved ? { ...saved.before } : now;
  // a file of the old always-on has no battery value; that command never changed it, so it is now's
  if (before.batterySleep === undefined) before.batterySleep = now.batterySleep ?? null;
  // save before changing anything, so --undo works even when a later step fails
  writeSaved(d, { version: 1, savedAt: saved?.savedAt ?? new Date().toISOString(), before, servicesBefore });
  d.log('1. Services: the Thoth server and brain run without the app, start at login, restart when they stop.');
  if (d.run(d.services, ['install'], true).code !== 0) {
    throw new Error(
      'installing the services failed (see above). Run: thoth doctor, then thoth always-on again, or thoth always-on --undo',
    );
  }
  d.log(
    '2. Power: this Mac does not sleep, on AC power and on battery, also with the lid closed. The display may turn off.',
  );
  applyPmset(d, changesFor(now), 'thoth always-on');
  const after = readPower(d);
  const battery = after.batterySleep ?? null;
  if (after.acSleep !== '0') throw new Error(`sleep on AC power is still ${show(after.acSleep)} after pmset`);
  if (battery !== null && battery !== '0') throw new Error(`sleep on battery is still ${battery} after pmset`);
  if (after.disablesleep !== '1') throw new Error('disablesleep is still off after pmset');
  for (const l of powerLines(after)) d.log(`   ${l}`);
  if (after.autorestart !== '1') d.log('   After a power failure, press the power button.');
  if (battery !== null) {
    d.log(
      '   Note: a closed laptop in a bag stays awake and can get warm. On battery it runs until the battery is empty.',
    );
  }
  if (onAC(d) === false)
    d.log('   This Mac runs on battery now: connect power, or it stops when the battery is empty.');
  d.log(`3. Reboot: ${rebootNote(d)}`);
  d.log('Done. To undo: thoth always-on --undo');
}

/** `thoth always-on --undo`: the saved pmset values back; the services removed when this command
 * installed them. */
export function undo(d: Deps): void {
  macOnly(d);
  const saved = readSaved(d);
  if (!saved) {
    d.log('Nothing to undo: thoth always-on was not run on this Mac (no saved settings).');
    return;
  }
  applyPmset(d, restoreFor(readPower(d), saved.before), 'thoth always-on --undo');
  const after = readPower(d);
  if (restoreFor(after, saved.before).length > 0) {
    throw new Error(
      `the power settings are not back yet (now ${JSON.stringify(after)}, before ${JSON.stringify(saved.before)})`,
    );
  }
  d.log('Power settings are back to what they were.');
  if (saved.servicesBefore) {
    d.log(
      'The services were installed before thoth always-on, so they stay (remove them with: thoth services uninstall).',
    );
  } else if (d.run(d.services, ['uninstall'], true).code !== 0) {
    throw new Error('removing the services failed (see above); the saved settings are kept');
  }
  fs.rmSync(path.join(d.stateDir, STATE_FILE), { force: true });
  d.log('Undo done.');
}

/** `thoth always-on --status`: what is set now. */
export function status(d: Deps): void {
  macOnly(d);
  const saved = readSaved(d);
  const now = readPower(d);
  d.log(`always-on: ${saved ? `on since ${saved.savedAt}` : 'off'}`);
  d.log(`services: ${servicesInstalled(d) ? 'installed' : 'not installed'}`);
  for (const l of powerLines(now)) d.log(l);
  const ac = onAC(d);
  d.log(`power source: ${ac === null ? 'unknown' : ac ? 'AC' : 'battery'}`);
  d.log(`reboot: ${rebootNote(d)}`);
}
