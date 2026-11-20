// The Windows side of a WSL helper (Windows helper plan, W1+W2). Inside WSL, Windows programs run
// through interop by their .exe names. This file holds the parts that need no process: the commands
// to run and how to read their output. The callers run them with a short timeout.

/** The OS value a WSL computer sends in its heartbeat and its join request. */
export const WSL_OS = 'windows-wsl';

/** The system of this computer for the heartbeat: macos, windows, linux, or windows-wsl. */
export function systemOs(platform: string, wsl: boolean): string {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return wsl ? WSL_OS : 'linux';
}

/** How long a Windows program may run from WSL (powershell.exe starts in about 1 s). */
export const TIMEOUT_MS = 5000;

const ps = (command: string): [string, string[]] => [
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', command],
];

/** Read the Windows power state at most this often (powershell.exe costs about 1 s of CPU; the
 * power source rarely changes, and the busy rule can wait 2 minutes to see it). */
export const AC_EVERY_MS = 2 * 60_000;

/** One line per battery: its BatteryStatus number. No line: the PC has no battery. */
export const BATTERY_CMD = ps('Get-CimInstance Win32_Battery | ForEach-Object { $_.BatteryStatus }');

/** The Windows build number (22631 for Windows 11 23H2). */
export const BUILD_CMD = ps('[System.Environment]::OSVersion.Version.Build');

/** WSL 2 needs Windows 10 version 2004 (build 19041) or newer. */
export const MIN_BUILD = 19_041;

// Win32_Battery BatteryStatus: 1 discharging, 2 on AC (not charging), 3 fully charged, 4 low,
// 5 critical, 6-9 charging, 10 undefined, 11 partially charged. 3, 10 and 11 do not say where the
// power comes from.
const AC = new Set([2, 6, 7, 8, 9]);
const BATTERY = new Set([1, 4, 5]);

/** The output of BATTERY_CMD -> true (on AC), false (on battery), null (cannot tell).
 * null output = the command failed. No battery = a desktop PC = on AC. */
export function onAcFromBattery(out: string | null): boolean | null {
  if (out === null) return null;
  const codes = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map(Number);
  if (codes.length === 0) return true;
  if (codes.some((c) => AC.has(c))) return true;
  if (codes.some((c) => BATTERY.has(c))) return false;
  return null;
}

/** The output of BUILD_CMD -> the build number, or null. */
export function buildFrom(out: string | null): number | null {
  const m = /^\s*(\d{4,6})\s*$/.exec(out ?? '');
  return m ? Number(m[1]) : null;
}
