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

/** Where WSL puts the interop socket of each session: <pid>_interop, pid = the session's relay. */
export const INTEROP_DIR = '/run/WSL';

/** The Windows folders that hold the .exe files a WSL shell finds by name (powershell.exe, cmd.exe,
 * explorer.exe). A normal WSL shell also gets the user's own Windows PATH; a service cannot read it. */
export const WIN_DIRS = ['/mnt/c/Windows/System32', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0', '/mnt/c/Windows'];

/** The process the boot task ThothWSL runs to keep WSL open, as /proc/<pid>/cmdline shows it: a
 * `sleep infinity` named thoth-keepalive (lib/always_on_windows.ts KEEPALIVE, PR #191). */
export const TASK_CMDLINE = 'thoth-keepalive\0infinity\0';

/** A WSL session's relay process is named Relay(<pid of the session's first program>). The sockets of
 * WSL's own init processes (1, 2) do not start Windows programs ("Invalid argument"). */
const RELAY = /^Relay\((\d+)\)$/;

/** The environment changes that let Windows programs run from this process and its children.
 * WSL sets WSL_INTEROP and adds the Windows PATH only in a session started by wsl.exe; a systemd
 * service (the Thoth server) has neither, so powershell.exe fails with "Invalid argument". Also a
 * server started from a terminal loses interop when that terminal closes (its socket's relay ends).
 * - WSL_INTEROP: the socket of the boot task's session whenever it lives (its program is
 *   TASK_CMDLINE: it stays open, so windows made with it never lose interop); without one, the
 *   current socket while its relay lives, else the oldest live relay. No live relay: left as it is.
 * - PATH: each Windows folder that is missing (dirs: the ones that exist on this PC).
 * sockets: the names in INTEROP_DIR; comm(pid) / cmdline(pid): that process's /proc files, or null
 * when it is gone. Returns only the keys to change. */
export function interopFix(
  env: { WSL_INTEROP?: string | undefined; PATH?: string | undefined },
  sockets: string[],
  comm: (pid: number) => string | null,
  cmdline: (pid: number) => string | null,
  dirs: string[],
): { WSL_INTEROP?: string; PATH?: string } {
  const out: { WSL_INTEROP?: string; PATH?: string } = {};
  const pidOf = (name: string): number | null => {
    const m = /^(\d+)_interop$/.exec(name);
    return m ? Number(m[1]) : null;
  };
  /** the pid of the relay's first program, or null when pid is not a live relay */
  const program = (pid: number | null): number | null => {
    const m = pid === null ? null : RELAY.exec(comm(pid) ?? '');
    return m ? Number(m[1]) : null;
  };
  const now = env.WSL_INTEROP ?? '';
  const nowName = now.startsWith(`${INTEROP_DIR}/`) ? now.slice(INTEROP_DIR.length + 1) : '';
  const live = sockets
    .map(pidOf)
    .filter((p): p is number => program(p) !== null)
    .sort((a, b) => a - b);
  const task = live.find((p) => cmdline(program(p) ?? 0) === TASK_CMDLINE);
  const keep = program(pidOf(nowName)) !== null;
  const pick = task ?? (keep ? undefined : live[0]);
  const want = pick === undefined ? '' : `${INTEROP_DIR}/${String(pick)}_interop`;
  if (want !== '' && want !== now) out.WSL_INTEROP = want;
  const parts = (env.PATH ?? '').split(':').filter((p) => p !== '');
  const missing = dirs.filter((d) => !parts.includes(d));
  if (missing.length > 0) out.PATH = [...parts, ...missing].join(':');
  return out;
}

/** What applyInteropFix reads and changes (the server passes the real ones; tests pass fakes). */
export interface InteropIo {
  /** the names in a folder; throws when it is not there (not WSL 2) */
  readdir: (dir: string) => string[];
  /** a file's text, or null */
  read: (file: string) => string | null;
  exists: (file: string) => boolean;
  /** the environment to change: the server's process.env */
  env: Record<string, string | undefined>;
  /** set a variable in tmux's global environment (the windows made after it get it) */
  tmuxSet: (key: string, value: string) => void;
}

/** interopFix on the real /run/WSL and /proc, applied to io.env and tmux. Returns what changed. */
export function applyInteropFix(io: InteropIo): Record<string, string> {
  let names: string[];
  try {
    names = io.readdir(INTEROP_DIR);
  } catch {
    return {};
  }
  const proc = (pid: number, file: string): string | null => io.read(`/proc/${String(pid)}/${file}`);
  const fix = interopFix(
    io.env,
    names,
    (pid) => proc(pid, 'comm')?.trim() ?? null,
    (pid) => proc(pid, 'cmdline'),
    WIN_DIRS.filter((d) => io.exists(d)),
  );
  for (const [k, v] of Object.entries(fix)) {
    io.env[k] = v;
    io.tmuxSet(k, v);
  }
  return fix;
}

/** tmux arguments that give a new window or session the server's current WSL_INTEROP and PATH
 * (`-e`, tmux 3.0+), so a window never takes a stale value from tmux's own global environment. */
export function tmuxEnvArgs(env: { WSL_INTEROP?: string | undefined; PATH?: string | undefined }): string[] {
  const out: string[] = [];
  for (const k of ['WSL_INTEROP', 'PATH'] as const) {
    const v = env[k];
    if (v !== undefined && v !== '') out.push('-e', `${k}=${v}`);
  }
  return out;
}
