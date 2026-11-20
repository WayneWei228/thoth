// `thoth always-on` on a Windows helper (WSL2): the Windows branch of lib/always_on.ts (Windows helper
// plan, W3). Same rule as the Mac: the computer never sleeps, on AC power and on battery, lid closed too.
//   - Power, through WSL interop (powercfg.exe), on AC power and on battery: sleep after 0 (never,
//     STANDBYIDLE), hibernate after 0 (never, HIBERNATEIDLE), closing the lid does nothing (LIDACTION 0).
//     Then `powercfg /setactive SCHEME_CURRENT` applies them. Only values that differ are changed.
//   - WSL keeps running: the scheduled task ThothWSL starts `wsl.exe -d <distro> --exec /bin/sleep
//     infinity` at boot, whether the user is logged on or not (S4U, no password stored, for an
//     administrator account; for a standard user Task Scheduler stores that user's password, and the
//     task stops working when that password changes: see taskCommand); and
//     `vmIdleTimeout=-1` in %USERPROFILE%\.wslconfig (other lines stay). The systemd user units
//     (scripts/services.sh, linger) then keep the Thoth server and brain up inside WSL.
//   - The values from before are saved in <state>/always-on.json; --undo puts them back.
//   - A step that needs Windows administrator rights (UAC) is not forced and nothing waits for a UAC
//     prompt: the command ends with the exact PowerShell commands to run as administrator.
// All commands go through `Deps.run`, so the tests use a fake and never call powercfg or schtasks.
import fs from 'node:fs';
import path from 'node:path';

import type { Deps } from './always_on.ts';

export const POWERCFG = 'powercfg.exe';
export const POWERSHELL = 'powershell.exe';
export const SCHTASKS = 'schtasks.exe';
export const WSLPATH = 'wslpath';
export const TASK = 'ThothWSL';
/** The name the task's program runs under in WSL (`exec -a`): a `sleep infinity` that only the task
 * starts, so pgrep finds the task's process and not another sleep (review of PR #191). */
export const KEEPALIVE = 'thoth-keepalive';
/** What the task runs in WSL to keep it open: a process that never ends, named KEEPALIVE. */
export const TASK_PROGRAM = `/bin/bash -c "exec -a ${KEEPALIVE} /bin/sleep infinity"`;
/** That process's command line as pgrep -f sees it. */
export const KEEPALIVE_CMDLINE = `${KEEPALIVE} infinity`;
const STATE_FILE = 'always-on.json';

export type Key = 'STANDBYIDLE' | 'HIBERNATEIDLE' | 'LIDACTION';

export const SETTINGS: readonly { key: Key; sub: 'SUB_SLEEP' | 'SUB_BUTTONS' }[] = [
  { key: 'STANDBYIDLE', sub: 'SUB_SLEEP' },
  { key: 'HIBERNATEIDLE', sub: 'SUB_SLEEP' },
  { key: 'LIDACTION', sub: 'SUB_BUTTONS' },
];

/** One setting's values (seconds for the timeouts; 0-3 for the lid action). */
export interface AcDc {
  ac: number;
  dc: number;
}

/** null: powercfg does not know the setting on this PC. */
export type WinPower = Record<Key, AcDc | null>;

export interface WinSaved {
  version: 1;
  platform: 'wsl';
  savedAt: string;
  servicesBefore: boolean;
  /** the power scheme that was active (a GUID); --undo puts the values back in it */
  scheme: string | null;
  power: WinPower;
  /** %USERPROFILE%\.wslconfig before: did it exist, its vmIdleTimeout under [wsl2] (null: none), and
   * its text (--undo writes it back when only always-on's line changed since) */
  wslconfig: { exists: boolean; vmIdleTimeout: string | null; text?: string };
  /** the task ThothWSL existed before (then --undo leaves it) */
  taskBefore: boolean;
}

/** `powercfg /query <scheme> <sub> <key>` → the current AC and DC values. The labels are in the
 * language of Windows, so only the numbers count: the last two hex numbers are the AC and DC values
 * (the lines before them are the possible minimum, maximum and step). */
export function parseQuery(text: string): AcDc | null {
  const nums = text.match(/0x[0-9a-f]+/gi) ?? [];
  if (nums.length < 2) return null;
  const ac = Number.parseInt(defined(nums[nums.length - 2]), 16);
  const dc = Number.parseInt(defined(nums[nums.length - 1]), 16);
  return Number.isFinite(ac) && Number.isFinite(dc) ? { ac, dc } : null;
}

function defined(s: string | undefined): string {
  return s ?? '';
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The GUID of the active power scheme, or null. */
export function activeScheme(d: Deps): string | null {
  const r = d.run(POWERCFG, ['/getactivescheme']);
  if (r.code !== 0) return null;
  return GUID.exec(r.stdout)?.[0]?.toLowerCase() ?? null;
}

/** The values in `scheme` (default: the plan in use). */
export function readWinPower(d: Deps, scheme = 'SCHEME_CURRENT'): WinPower {
  const out = {} as WinPower;
  for (const s of SETTINGS) {
    const r = d.run(POWERCFG, ['/query', scheme, s.sub, s.key]);
    out[s.key] = r.code === 0 ? parseQuery(r.stdout) : null;
  }
  return out;
}

/** One powercfg value change. */
export interface PowerCall {
  side: 'ac' | 'dc';
  key: Key;
  value: number;
}

/** The changes that make `now` always-on: every known value that is not 0. */
export function powerChanges(now: WinPower): PowerCall[] {
  const out: PowerCall[] = [];
  for (const s of SETTINGS) {
    const v = now[s.key];
    if (!v) continue;
    if (v.ac !== 0) out.push({ side: 'ac', key: s.key, value: 0 });
    if (v.dc !== 0) out.push({ side: 'dc', key: s.key, value: 0 });
  }
  return out;
}

/** The changes that put `before` back. A setting not known then or now is left alone. */
export function powerRestore(now: WinPower, before: WinPower): PowerCall[] {
  const out: PowerCall[] = [];
  for (const s of SETTINGS) {
    const b = before[s.key];
    const n = now[s.key];
    if (!b || !n) continue;
    if (b.ac !== n.ac) out.push({ side: 'ac', key: s.key, value: b.ac });
    if (b.dc !== n.dc) out.push({ side: 'dc', key: s.key, value: b.dc });
  }
  return out;
}

function subOf(key: Key): string {
  return SETTINGS.find((s) => s.key === key)?.sub ?? 'SUB_SLEEP';
}

export function powerArgs(c: PowerCall, scheme: string): string[] {
  return [c.side === 'ac' ? '/setacvalueindex' : '/setdcvalueindex', scheme, subOf(c.key), c.key, String(c.value)];
}

const LID = ['do nothing', 'sleep', 'hibernate', 'shut down'];
const SIDE = { ac: 'on AC power', dc: 'on battery' } as const;

function valueWords(key: Key, v: number): string {
  if (key === 'LIDACTION') return LID[v] ?? `action ${String(v)}`;
  if (v === 0) return 'never';
  return v % 60 === 0 ? `after ${String(v / 60)} min` : `after ${String(v)} s`;
}

const NAME: Record<Key, string> = {
  STANDBYIDLE: 'sleep',
  HIBERNATEIDLE: 'hibernate',
  LIDACTION: 'closing the lid',
};

export function describeCall(c: PowerCall): string {
  return `${NAME[c.key]} ${SIDE[c.side]} is now: ${valueWords(c.key, c.value)}`;
}

/** Runs the powercfg calls, then `/setactive SCHEME_CURRENT`. When the first call fails (usually:
 * no administrator rights), nothing more is tried and the calls come back as PowerShell commands
 * for an administrator. */
function applyPower(d: Deps, calls: readonly PowerCall[], scheme: string, admin: string[]): void {
  if (calls.length === 0) {
    d.log('   Nothing to change: the power settings were already right.');
    return;
  }
  const lines = [...calls.map((c) => powerArgs(c, scheme)), ['/setactive', 'SCHEME_CURRENT']];
  for (const [i, args] of lines.entries()) {
    const r = d.run(POWERCFG, args);
    if (r.code !== 0) {
      d.log(`   powercfg ${args.join(' ')} failed: ${firstLine(r.stderr || r.stdout)}`);
      for (const a of lines.slice(i)) admin.push(`powercfg ${a.join(' ')}`);
      return;
    }
    const c = calls[i];
    if (c) d.log(`   changed: ${describeCall(c)} (powercfg ${args.join(' ')})`);
  }
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0] ?? '';
}

/** The vmIdleTimeout under [wsl2] in a .wslconfig text, or null. */
export function getIdle(text: string): string | null {
  let inWsl2 = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head?.[1] !== undefined) {
      inWsl2 = head[1].trim().toLowerCase() === 'wsl2';
      continue;
    }
    const kv = /^vmIdleTimeout\s*=\s*(.*)$/i.exec(line);
    if (inWsl2 && kv?.[1] !== undefined) return kv[1].trim();
  }
  return null;
}

/** The .wslconfig text with vmIdleTimeout under [wsl2] set to `value` (null: the line removed).
 * Other lines stay as they are, with the file's line ends. */
export function setIdle(text: string, value: string | null): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let inWsl2 = false;
  let wsl2At = -1;
  let found = false;
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head?.[1] !== undefined) {
      inWsl2 = head[1].trim().toLowerCase() === 'wsl2';
      out.push(raw);
      if (inWsl2 && wsl2At < 0) wsl2At = out.length;
      continue;
    }
    if (inWsl2 && /^vmIdleTimeout\s*=/i.test(line)) {
      if (!found && value !== null) out.push(`vmIdleTimeout=${value}`);
      found = true;
      continue;
    }
    out.push(raw);
  }
  if (!found && value !== null) {
    if (wsl2At >= 0) out.splice(wsl2At, 0, `vmIdleTimeout=${value}`);
    else {
      if (out.length > 0 && out[out.length - 1]?.trim() !== '') out.push('');
      out.push('[wsl2]', `vmIdleTimeout=${value}`);
    }
  }
  return out.length === 0 ? '' : out.join(eol) + eol;
}

/** The Windows user: the profile folder (as a WSL path) and the account (DOMAIN\name). */
export function windowsUser(d: Deps): { profile: string; account: string } {
  const r = d.run(POWERSHELL, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    // without the first part Windows PowerShell writes in the OEM code page (CP936 on Chinese
    // Windows), and a name like C:\Users\张三 would come out garbled
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('UserProfile'); [Security.Principal.WindowsIdentity]::GetCurrent().Name",
  ]);
  const [winProfile = '', account = ''] = r.stdout
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim());
  if (r.code !== 0 || !/^[A-Za-z]:\\/.test(winProfile) || account === '') {
    throw new Error(
      `could not ask Windows for the user folder (powershell.exe: ${firstLine(r.stderr) || 'no answer'}). Is WSL interop on? Run: thoth doctor`,
    );
  }
  const p = d.run(WSLPATH, ['-u', winProfile]);
  const profile = p.stdout.trim();
  if (p.code !== 0 || !profile.startsWith('/'))
    throw new Error(`wslpath -u ${winProfile} failed: ${firstLine(p.stderr)}`);
  return { profile, account };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** A PowerShell string in single quotes. PowerShell also ends a string at the curly single quotes
 * (U+2018 to U+201B), and a Windows account name may hold one: they are doubled too. */
function psQuote(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
}

/** The distro name goes into the task's command line, so only plain names. */
export function checkDistro(distro: string | undefined): string {
  if (distro === undefined || !/^[\w.-]+$/.test(distro)) {
    throw new Error(
      `the WSL distro name is missing or unusual (WSL_DISTRO_NAME=${distro ?? ''}); run thoth always-on in a WSL terminal`,
    );
  }
  return distro;
}

/** The PowerShell command that creates the task ThothWSL (it needs administrator rights). First S4U
 * (no password is stored): that works when the account is an administrator. For a standard Windows
 * user Windows refuses S4U ("Access is denied", even from an administrator window; seen on Windows
 * Server 2025, 2026-11-20); then the administrator types that user's password once and the task
 * stores it, which also runs at boot with nobody logged on. Under -NonInteractive (this command run
 * from WSL) the password prompt fails, so the command fails and is printed for an administrator. */
export function taskCommand(distro: string, account: string): string {
  const user = psQuote(account);
  const register = `Register-ScheduledTask -TaskName '${TASK}' -Action $a -Trigger $t`;
  return [
    `$a = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument ${psQuote(`-d ${distro} --exec ${TASK_PROGRAM}`)}`,
    '$t = New-ScheduledTaskTrigger -AtStartup',
    `$p = New-ScheduledTaskPrincipal -UserId ${user} -LogonType S4U`,
    '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden',
    `try { ${register} -Principal $p -Settings $s -Force -ErrorAction Stop | Out-Null } ` +
      // only "Access is denied" means S4U was refused; another error is shown as it is
      `catch { if ("$($_.FullyQualifiedErrorId)" -notmatch '0x80070005') { throw }; ` +
      `$c = Get-Credential -UserName ${user} -Message ${psQuote(`Windows password of ${account}: the task ${TASK} starts WSL as this user at boot`)}; ` +
      `if (-not $c) { throw '${TASK} was not created: no password was given' }; ` +
      `${register} -Settings $s -User $c.UserName -Password $c.GetNetworkCredential().Password -Force | Out-Null }`,
    // start it now too: until it runs, WSL stops when its last window closes (until Windows restarts)
    START_TASK,
  ].join('; ');
}

/** Put before the automatic try of `taskCommand`: without administrator rights the task cmdlets wait
 * about 40 s for CIM before they fail (Windows Server 2025, 2026-11-20); this check takes 0.2 s. */
export const ADMIN_ONLY =
  'if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 5 }; ';

/** Start the task now (an administrator command: schtasks /run may be refused for a standard user). */
const START_TASK = `Start-ScheduledTask -TaskName '${TASK}'`;

/** The task's WSL session runs: its program is a process in this distro. Read in WSL, not from
 * Windows (the task cmdlets wait 40 s without administrator rights; schtasks' status is in the
 * Windows language). */
export function taskRunning(d: Deps): boolean {
  return d.run('pgrep', ['-x', '-f', KEEPALIVE_CMDLINE]).code === 0;
}

export function taskExists(d: Deps): boolean {
  return d.run(SCHTASKS, ['/query', '/tn', TASK]).code === 0;
}

function servicesInstalled(d: Deps): boolean {
  return d.run(d.services, ['installed']).code === 0;
}

const isAcDc = (x: unknown): x is AcDc => {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Partial<AcDc>;
  const n = (y: unknown): boolean => typeof y === 'number' && Number.isInteger(y) && y >= 0 && y < 2 ** 32;
  return n(v.ac) && n(v.dc);
};

export function readWinSaved(d: Deps): WinSaved | null {
  const file = path.join(d.stateDir, STATE_FILE);
  const text = readText(file);
  if (text === null) return null;
  const bad = new Error(`${file} is not valid; remove it or fix it by hand`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad;
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad;
  const v = parsed as Partial<WinSaved>;
  if (v.version !== 1 || v.platform !== 'wsl') throw bad;
  const p = v.power as Partial<WinPower> | undefined;
  const w = v.wslconfig;
  const idleOk = (x: unknown): boolean => x === null || (typeof x === 'string' && /^-?\d{1,12}$/.test(x));
  if (
    !p ||
    !SETTINGS.every((s) => p[s.key] === null || isAcDc(p[s.key])) ||
    !w ||
    typeof w.exists !== 'boolean' ||
    !idleOk(w.vmIdleTimeout) ||
    (w.text !== undefined && typeof w.text !== 'string') ||
    (v.scheme !== null && !(typeof v.scheme === 'string' && GUID.test(v.scheme) && v.scheme.length === 36))
  ) {
    throw bad;
  }
  const power = {} as WinPower;
  for (const s of SETTINGS) power[s.key] = p[s.key] ?? null;
  return {
    version: 1,
    platform: 'wsl',
    savedAt: String(v.savedAt),
    servicesBefore: v.servicesBefore === true,
    scheme: v.scheme ?? null,
    power,
    wslconfig: {
      exists: w.exists,
      vmIdleTimeout: w.vmIdleTimeout,
      ...(typeof w.text === 'string' ? { text: w.text } : {}),
    },
    taskBefore: v.taskBefore === true,
  };
}

function writeWinSaved(d: Deps, s: WinSaved): void {
  fs.mkdirSync(d.stateDir, { recursive: true });
  const file = path.join(d.stateDir, STATE_FILE);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** The error that ends a run when some steps need an administrator. */
function adminError(cmds: readonly string[], again: string): Error {
  return new Error(
    'some steps need Windows administrator rights, and this window does not have them. Those steps were not done. ' +
      'In Windows: open the Start menu, type PowerShell, right-click Windows PowerShell, choose "Run as administrator" ' +
      '(Windows asks you to confirm), and run:\n' +
      cmds.map((c) => `  ${c}\n`).join('') +
      `Then run again in WSL: ${again}`,
  );
}

function powerLines(v: WinPower): string[] {
  return SETTINGS.map((s) => {
    const x = v[s.key];
    const name = s.key === 'LIDACTION' ? 'closing the lid' : `${NAME[s.key]} after`;
    if (!x) return `${name}: not known on this PC`;
    return `${name}: ${valueWords(s.key, x.ac)} on AC power, ${valueWords(s.key, x.dc)} on battery`;
  });
}

function powerOk(v: WinPower): boolean {
  return powerChanges(v).length === 0;
}

/** `thoth always-on` in WSL. Safe to run again: the saved values stay those from the first run. */
export function enableWsl(d: Deps): void {
  const distro = checkDistro(d.distro);
  const saved = readWinSaved(d);
  const user = windowsUser(d);
  const cfgFile = path.join(user.profile, '.wslconfig');
  const cfgText = readText(cfgFile);
  // one plan for every run: the one in use on the first run (saved). A re-run after the user switched
  // plans still changes that plan, the one --undo restores; the admin commands name it too.
  const scheme = saved ? saved.scheme : activeScheme(d);
  const now = readWinPower(d, scheme ?? 'SCHEME_CURRENT');
  const taskNow = taskExists(d);
  const state: WinSaved = saved ?? {
    version: 1,
    platform: 'wsl',
    savedAt: new Date().toISOString(),
    servicesBefore: servicesInstalled(d),
    scheme,
    power: now,
    wslconfig: {
      exists: cfgText !== null,
      vmIdleTimeout: getIdle(cfgText ?? ''),
      ...(cfgText === null ? {} : { text: cfgText }),
    },
    taskBefore: taskNow,
  };
  // save before changing anything, so --undo works even when a later step fails
  writeWinSaved(d, state);
  const admin: string[] = [];
  d.log('1. Services: the Thoth server and brain run as systemd user services in WSL, restart when they stop.');
  if (d.run(d.services, ['install'], true).code !== 0) {
    throw new Error(
      'installing the services failed (see above). Run: thoth doctor, then thoth always-on again, or thoth always-on --undo',
    );
  }
  d.log('2. Power: Windows does not sleep or hibernate, on AC power and on battery, and closing the lid does nothing.');
  applyPower(d, powerChanges(now), scheme ?? 'SCHEME_CURRENT', admin);
  d.log(`3. WSL keeps running: vmIdleTimeout=-1 in ${cfgFile}, and the task ${TASK} starts WSL at boot.`);
  if (getIdle(cfgText ?? '') === '-1') d.log('   .wslconfig: already right.');
  else {
    fs.writeFileSync(cfgFile, setIdle(cfgText ?? '', '-1'));
    d.log('   .wslconfig: changed. It counts from the next start of WSL (after a Windows restart).');
  }
  let task = taskNow;
  if (taskNow) d.log(`   task ${TASK}: already there.`);
  else {
    const cmd = taskCommand(distro, user.account);
    d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `${ADMIN_ONLY}${cmd}`]);
    // decided by the task, not the exit code: when only the start at its end failed, the task is
    // there and only Start-ScheduledTask goes to the administrator (below)
    task = taskExists(d);
    if (task) d.log(`   task ${TASK}: created.`);
    else admin.push(cmd); // it also starts the task
  }
  // the task must run now, not only after the next Windows restart: WSL stops when its last window
  // closes (found on a real Windows Server 2025 helper: offline until a restart)
  if (task) {
    if (taskRunning(d)) d.log(`   task ${TASK}: running, so WSL stays on when this window closes.`);
    else if (d.run(SCHTASKS, ['/run', '/tn', TASK]).code === 0)
      // Windows took the request; whether the program came up is not known yet (no waiting here)
      d.log(`   task ${TASK}: start requested. To see that it runs: thoth always-on --status`);
    else admin.push(START_TASK);
  }
  if (admin.length > 0) throw adminError(admin, 'thoth always-on');
  const after = readWinPower(d, scheme ?? 'SCHEME_CURRENT');
  if (!powerOk(after))
    throw new Error(`the power settings are not right after powercfg: ${powerLines(after).join('; ')}`);
  for (const l of powerLines(after)) d.log(`   ${l}`);
  if (after.STANDBYIDLE && after.LIDACTION)
    d.log(
      '   Note: a closed laptop in a bag stays awake and can get warm. On battery it runs until the battery is empty.',
    );
  d.log(
    `4. Reboot: after a Windows restart the task ${TASK} starts WSL without a login, and systemd starts the Thoth services.`,
  );
  d.log('Done. To undo: thoth always-on --undo');
}

/** `thoth always-on --undo` in WSL. */
export function undoWsl(d: Deps): void {
  const saved = readWinSaved(d);
  if (!saved) {
    d.log('Nothing to undo: thoth always-on was not run on this computer (no saved settings).');
    return;
  }
  const admin: string[] = [];
  // the values were saved from this plan: read and write that one, even when another plan is in use now
  const scheme = saved.scheme ?? 'SCHEME_CURRENT';
  applyPower(d, powerRestore(readWinPower(d, scheme), saved.power), scheme, admin);
  const cfgFile = path.join(windowsUser(d).profile, '.wslconfig');
  const cfgText = readText(cfgFile);
  const original = saved.wslconfig.exists ? (saved.wslconfig.text ?? null) : '';
  if (cfgText !== null && original !== null && cfgText === setIdle(original, '-1')) {
    // only always-on's line changed since: the file exactly as it was (or no file)
    if (saved.wslconfig.exists) fs.writeFileSync(cfgFile, original);
    else fs.rmSync(cfgFile, { force: true });
    d.log('.wslconfig is back to what it was.');
  } else if (cfgText !== null && getIdle(cfgText) !== saved.wslconfig.vmIdleTimeout) {
    // changed by someone else too: only the vmIdleTimeout line goes back
    fs.writeFileSync(cfgFile, setIdle(cfgText, saved.wslconfig.vmIdleTimeout));
    d.log('.wslconfig: vmIdleTimeout is back to what it was.');
  }
  if (!saved.taskBefore && taskExists(d)) {
    if (d.run(SCHTASKS, ['/delete', '/tn', TASK, '/f']).code === 0) {
      d.log(`Task ${TASK} removed.`);
      // removing a task does not stop its running copy: end the keepalive here, so WSL can stop
      // again when its last window closes (review round 2 of PR #191)
      if (d.run('pkill', ['-x', '-f', KEEPALIVE_CMDLINE]).code === 0) d.log(`Its process ${KEEPALIVE} is stopped.`);
    } else admin.push(`Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false`);
  }
  if (admin.length > 0) throw adminError(admin, 'thoth always-on --undo');
  const left = powerRestore(readWinPower(d, scheme), saved.power);
  if (left.length > 0) throw new Error(`the power settings are not back yet: ${left.map(describeCall).join('; ')}`);
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

/** One row of `thoth doctor` (scripts/services.sh shows them). */
export interface DoctorRow {
  kind: 'ok' | 'bad' | 'warn';
  title: string;
  fix: string;
  /** why it matters (a bad row); empty: the power cause that services.sh shows by default */
  cause?: string;
}

/** Each always-on item now, judged against always-on (ok: as always-on wants it). */
function items(d: Deps): DoctorRow[] {
  const rows: DoctorRow[] = [];
  const row = (good: boolean, title: string): void => {
    rows.push({ kind: good ? 'ok' : 'bad', title, fix: good ? '' : 'thoth always-on' });
  };
  const power = readWinPower(d);
  for (const [i, l] of powerLines(power).entries()) {
    const s = SETTINGS[i];
    const v = s ? power[s.key] : null;
    row(v === null || (v.ac === 0 && v.dc === 0), `power: ${l}`);
  }
  let idle: string | null = null;
  let cfg = '%USERPROFILE%\\.wslconfig';
  try {
    cfg = path.join(windowsUser(d).profile, '.wslconfig');
    idle = getIdle(readText(cfg) ?? '');
  } catch {
    // shown as not set
  }
  row(idle === '-1', `${cfg}: vmIdleTimeout ${idle ?? 'not set'} (-1 = WSL never stops when idle)`);
  const task = taskExists(d);
  row(task, `task ${TASK} (starts WSL at boot): ${task ? 'there' : 'missing'}`);
  if (task) {
    // one row for one cause: a missing task is already the row above
    const running = taskRunning(d);
    row(
      running,
      `task ${TASK} keeps WSL running: ${running ? 'yes' : 'no (WSL stops when its last window closes, until Windows restarts)'}`,
    );
  }
  const services = servicesInstalled(d);
  row(services, `services: ${services ? 'installed' : 'not installed'}`);
  return rows;
}

/** The rows of `thoth doctor` in WSL: one warning when always-on is off, else each item. */
export function wslRows(d: Deps): DoctorRow[] {
  if (!readWinSaved(d)) {
    return [
      {
        kind: 'warn',
        title: 'always-on is off: Windows may sleep, and WSL stops when its last window closes',
        fix: 'To keep this helper on: thoth always-on',
      },
    ];
  }
  return items(d);
}

/** `thoth always-on --status` in WSL. */
export function statusWsl(d: Deps): void {
  const saved = readWinSaved(d);
  d.log(`always-on: ${saved ? `on since ${saved.savedAt}` : 'off'}`);
  for (const r of items(d))
    d.log(`${r.title}${saved && r.kind !== 'ok' ? '   (not right; fix: thoth always-on)' : ''}`);
}
