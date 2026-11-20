// `thoth always-on`: keep this Mac on as a helper computer (multi-device plan, PR 2).
//   - launchd user services run the Thoth server (with its relay client) and the brain without the
//     app, start them at login and restart them when they stop (scripts/services.sh install).
//   - On AC power the Mac does not sleep (`pmset -c sleep 0`); the display may still turn off.
//     `autorestart 1`: start again after a power failure. With --lid also `disablesleep 1`, so the
//     Mac keeps running with the lid closed.
//   - The pmset values from before are saved in <state>/always-on.json, and --undo puts them back.
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
}

/** The pmset values this command changes. null: pmset did not show the setting. */
export interface PowerValues {
  acSleep: string | null;
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
  lid: boolean;
}

export const STATE_FILE = 'always-on.json';

/** The command line: the action, or an error (an unknown option, or options that do not go together). */
export function parseArgs(
  args: readonly string[],
): { action: 'enable' | 'undo' | 'status' | 'help'; lid: boolean } | { error: string } {
  const known = new Set(['--lid', '--undo', '--status', '-h', '--help']);
  const unknown = args.find((a) => !known.has(a));
  if (unknown !== undefined) return { error: `unknown option ${unknown}` };
  const has = (a: string): boolean => args.includes(a);
  if (has('--undo') && (has('--status') || has('--lid'))) return { error: '--undo goes alone' };
  if (has('--status') && has('--lid')) return { error: '--status goes alone' };
  if (has('-h') || has('--help')) return { action: 'help', lid: false };
  if (has('--undo')) return { action: 'undo', lid: false };
  if (has('--status')) return { action: 'status', lid: false };
  return { action: 'enable', lid: has('--lid') };
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
  const live = d.run(d.pmset, ['-g']);
  // a guess here would be saved as the value from before, and --undo would set it
  if (live.code !== 0) throw new Error(`pmset -g failed: ${live.stderr.trim()}`);
  const liveText = live.stdout;
  return {
    acSleep: ac['sleep'] ?? null,
    // a desktop Mac shows autorestart; a laptop usually does not have it
    autorestart: ac['autorestart'] ?? parseLive(liveText, 'autorestart'),
    // shown only while it is set
    disablesleep: parseLive(liveText, 'SleepDisabled') ?? '0',
  };
}

/** One pmset call: the scope flag, the key, the value. */
export interface PmsetChange {
  scope: '-a' | '-c';
  key: 'sleep' | 'autorestart' | 'disablesleep';
  value: string;
}

/** The pmset calls that make `now` always-on. A value that is already right needs no call. */
export function changesFor(now: PowerValues, lid: boolean): PmsetChange[] {
  const out: PmsetChange[] = [];
  if (now.acSleep !== '0') out.push({ scope: '-c', key: 'sleep', value: '0' });
  // null: this Mac has no autorestart (most laptops); asking pmset for it every run would only fail
  if (now.autorestart !== null && now.autorestart !== '1') out.push({ scope: '-a', key: 'autorestart', value: '1' });
  if (lid && now.disablesleep !== '1') out.push({ scope: '-a', key: 'disablesleep', value: '1' });
  return out;
}

/** The pmset calls that put `before` back. A setting pmset did not show before is set to 0 when it
 * shows now (it was off); one that is still not shown is left alone. */
export function restoreFor(now: PowerValues, before: PowerValues): PmsetChange[] {
  const out: PmsetChange[] = [];
  const want = (b: string | null, n: string | null): string | null => {
    if (b === null) return n === null || n === '0' ? null : '0';
    return b === n ? null : b;
  };
  const sleep = want(before.acSleep, now.acSleep);
  if (sleep !== null) out.push({ scope: '-c', key: 'sleep', value: sleep });
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
  if (v.version !== 1 || !b || !ok(b.acSleep) || !ok(b.autorestart) || !ok(b.disablesleep)) {
    throw bad;
  }
  return {
    version: 1,
    savedAt: String(v.savedAt),
    before: b,
    servicesBefore: v.servicesBefore === true,
    lid: v.lid === true,
  };
}

function writeSaved(d: Deps, s: SavedState): void {
  fs.mkdirSync(d.stateDir, { recursive: true });
  const file = path.join(d.stateDir, STATE_FILE);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** Runs the pmset calls with sudo. The password is asked once (`sudo -v`), before the first call. */
function applyPmset(d: Deps, changes: readonly PmsetChange[]): void {
  if (changes.length === 0) return;
  d.log('Changing power settings needs your password once (sudo).');
  if (d.run(d.sudo, ['-v'], true).code !== 0) throw new Error('sudo was not allowed; nothing was changed');
  try {
    for (const c of changes) {
      const r = d.run(d.sudo, ['-n', d.pmset, c.scope, c.key, c.value]);
      if (r.code !== 0) throw new Error(`sudo pmset ${c.scope} ${c.key} ${c.value} failed: ${r.stderr.trim()}`);
      d.log(`  pmset ${c.scope} ${c.key} ${c.value}`);
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

/** `thoth always-on [--lid]`. Safe to run again: the saved values stay those from the first run. */
export function enable(d: Deps, opts: { lid: boolean }): void {
  macOnly(d);
  const saved = readSaved(d);
  const now = readPower(d);
  const servicesBefore = saved ? saved.servicesBefore : servicesInstalled(d);
  // save before changing anything, so --undo works even when a later step fails
  writeSaved(d, {
    version: 1,
    savedAt: saved?.savedAt ?? new Date().toISOString(),
    before: saved?.before ?? now,
    servicesBefore,
    lid: opts.lid || (saved?.lid ?? false),
  });
  d.log('1. Services: the Thoth server and brain run without the app, start at login, restart when they stop.');
  if (d.run(d.services, ['install'], true).code !== 0) {
    throw new Error(
      'installing the services failed (see above). Run: thoth doctor, then thoth always-on again, or thoth always-on --undo',
    );
  }
  d.log('2. Power: no sleep on AC power (the display may turn off), start again after a power failure.');
  if (opts.lid) d.log('   --lid: the Mac also keeps running with the lid closed. It can get warm in a bag.');
  applyPmset(d, changesFor(now, opts.lid));
  const after = readPower(d);
  if (after.acSleep !== '0') throw new Error(`AC sleep is still ${show(after.acSleep)} after pmset`);
  if (after.autorestart !== '1')
    d.log('   This Mac does not support autorestart (most laptops): after a power failure, press the power button.');
  if (opts.lid && after.disablesleep !== '1') throw new Error('disablesleep is still off after pmset');
  if (onAC(d) === false) d.log('   This Mac runs on battery now: connect power, or it still sleeps.');
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
  applyPmset(d, restoreFor(readPower(d), saved.before));
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
  d.log(`always-on: ${saved ? `on since ${saved.savedAt}${saved.lid ? ' (with --lid)' : ''}` : 'off'}`);
  d.log(`services: ${servicesInstalled(d) ? 'installed' : 'not installed'}`);
  d.log(`AC sleep: ${show(now.acSleep)} (0 = never)`);
  d.log(`autorestart: ${show(now.autorestart)}`);
  d.log(`disablesleep (lid closed): ${show(now.disablesleep)}`);
  const ac = onAC(d);
  d.log(`power source: ${ac === null ? 'unknown' : ac ? 'AC' : 'battery'}`);
  d.log(`reboot: ${rebootNote(d)}`);
}
