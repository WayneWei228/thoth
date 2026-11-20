// Device choice for a NEW session (multi-device plan, PR 6). The router (lib/router.ts) only extracts
// a device the user named ("用家里的电脑", "on the mini") into the decision's "device"; the rules
// here pick the computer, so the choice is testable and predictable:
//   1. the user named a device -> that one;
//   2. the project is on only one device (heartbeat projects, matched by git remote) -> that one;
//   3. this Mac, unless it is busy; then the helper that is online, on AC power, has the agent,
//      and runs the fewest sessions.
// A device that is offline, is not a helper, or lacks the agent is never chosen. The device list
// is the brain's GET /api/devices with the heartbeat fields (brain/heartbeat.py).
import path from 'node:path';

/** One device of the brain's list (the fields this file reads; all may be missing). */
export interface BrainDeviceInfo {
  name?: unknown;
  online?: unknown;
  role?: unknown;
  on_ac?: unknown;
  claude?: unknown;
  codex?: unknown;
  running_sessions?: unknown;
  cpu_load?: unknown;
  cpus?: unknown;
  projects?: unknown;
}

interface DeviceProject {
  path: string;
  remote: string;
}
export interface Device {
  name: string;
  online: boolean;
  helper: boolean;
  onAc: boolean | null;
  claude: boolean;
  codex: boolean;
  running: number;
  load: number;
  projects: DeviceProject[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
// The list comes from the brain, and each heartbeat from a device: names, paths and remotes go into
// the router prompt, so only short values with no control characters or quotes-and-newlines tricks.
const SAFE_NAME = /^[\p{L}\p{N} ._'’-]{1,64}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const safePath = (v: string): boolean => v.length <= 300 && /^[/~]/.test(v) && !CONTROL.test(v);
const safeRemote = (v: string): boolean => v.length <= 300 && !CONTROL.test(v) && !/\s/.test(v);

/** The brain's device list -> devices with fixed types. Rows without a safe name are dropped, and
 * projects without a safe absolute path (a remote that is not safe becomes ''). */
export function readDevices(list: unknown): Device[] {
  if (!Array.isArray(list)) return [];
  const out: Device[] = [];
  for (const raw of list as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const d = raw as BrainDeviceInfo;
    const name = text(d.name).trim();
    if (!SAFE_NAME.test(name)) continue;
    const cpus = num(d.cpus);
    const projects = Array.isArray(d.projects)
      ? (d.projects as unknown[]).flatMap((p) => {
          if (typeof p !== 'object' || p === null) return [];
          const q = p as { path?: unknown; remote?: unknown };
          const at = text(q.path);
          const remote = text(q.remote);
          return safePath(at) ? [{ path: at, remote: safeRemote(remote) ? remote : '' }] : [];
        })
      : [];
    out.push({
      name,
      online: d.online === true,
      helper: d.role === 'helper',
      onAc: typeof d.on_ac === 'boolean' ? d.on_ac : null,
      claude: d.claude === true,
      codex: d.codex === true,
      running: num(d.running_sessions),
      load: cpus > 0 ? num(d.cpu_load) / cpus : 0,
      projects,
    });
  }
  return out;
}

/** A git remote in one form for comparing: host/path, lower case, no scheme, user, port of ssh, ".git"
 * or trailing "/". https://github.com/A/b.git, git@github.com:a/b and ssh://git@github.com/a/b
 * all give "github.com/a/b". '' for no remote. */
export function remoteKey(url: string): string {
  let u = url.trim().toLowerCase();
  if (!u) return '';
  u = u.replace(/^[a-z][a-z\d+.-]*:\/\//, ''); // scheme
  u = u.replace(/^[^/@]*@/, ''); // user (and password)
  if (!url.includes('://')) u = u.replace(/^([^/:]+):(?!\d+\/)/, '$1/'); // scp form host:path
  u = u.replace(/^([^/:]+):\d+\//, '$1/'); // port
  return u.replace(/\/+$/, '').replace(/\.git$/, '');
}

/** This Mac is busy: this many sessions are still working, or the CPU load per core is this high. */
export const BUSY_WORKING = 3;
export const BUSY_LOAD = 0.9;
export const localBusy = (working: number, loadPerCpu: number): boolean =>
  working >= BUSY_WORKING || loadPerCpu >= BUSY_LOAD;

export interface PickInput {
  /** the device the router extracted from the request ('' = none named) */
  named: string;
  /** the folder the new session starts in (a path on this Mac, or a helper's project path) */
  folder: string;
  /** that folder's git remote on this Mac ('' = none or unknown) */
  remote: string;
  /** the folder exists on this Mac */
  folderHere: boolean;
  /** the folder is a git repository on this Mac (a project; a plain folder such as ~/code is not) */
  repo: boolean;
  /** this Mac's device name ('' when unknown) */
  local: string;
  /** this Mac is busy (localBusy) */
  busy: boolean;
  /** the agent the session runs */
  agent: string;
  devices: readonly Device[];
}
type Rule = 'named' | 'project' | 'local' | 'idle' | 'busy';
export interface Pick {
  /** '' = this Mac */
  device: string;
  rule: Rule;
  /** one sentence for the route's reason: why this computer (and why not another) */
  note: string;
}

const squash = (s: string): string => s.toLowerCase().replaceAll(/[\s_\-.'’]/g, '');

/** The device the user named, from the router's word: exact name (any case), then the same
 * letters without spaces and dashes, then the one device whose name contains it ("mini" ->
 * "mac-mini"; never the other way: "mac-mini-home" is not "mac"). null = unknown. */
export function findNamed(named: string, names: readonly string[]): string | null {
  const n = named.trim();
  if (!n) return null;
  const exact = names.find((x) => x.toLowerCase() === n.toLowerCase());
  if (exact !== undefined) return exact;
  const sq = squash(n);
  if (!sq) return null;
  const same = names.find((x) => squash(x) === sq);
  if (same !== undefined) return same;
  const part = names.filter((x) => squash(x).includes(sq));
  return part.length === 1 ? (part[0] ?? null) : null;
}

/** Why a device cannot take a new session ('' = it can). */
function unfit(d: Device, agent: string): string {
  if (!d.online) return 'is offline';
  if (!d.helper) return 'is not a helper computer';
  if (agent === 'codex' ? !d.codex : !d.claude) return `has no ${agent === 'codex' ? 'Codex' : 'Claude Code'}`;
  return '';
}

/** The devices that hold the project: by path, or by git remote. */
function holders(i: PickInput, remotes: readonly Device[]): Device[] {
  const key = remoteKey(i.remote);
  return remotes.filter((d) =>
    d.projects.some((p) => p.path === i.folder || (key !== '' && remoteKey(p.remote) === key)),
  );
}

export function pickDevice(i: PickInput): Pick {
  const here = i.local.toLowerCase();
  const remotes = i.devices.filter((d) => d.name.toLowerCase() !== here || here === '');
  // only this Mac (no helper in the brain's list, or no brain): nothing to choose, nothing to say
  if (!remotes.some((d) => d.helper)) return { device: '', rule: 'local', note: '' };
  const notes: string[] = [];
  // 1. the user named a device
  if (i.named.trim()) {
    const thisMac = ['this mac', 'here', 'local', '本机', '这台', '这台电脑', '这台mac'];
    const name = findNamed(i.named, [...(i.local ? [i.local] : []), ...remotes.map((d) => d.name)]);
    if ((name !== null && name.toLowerCase() === here) || thisMac.includes(i.named.trim().toLowerCase()))
      return { device: '', rule: 'named', note: 'You asked for this Mac.' };
    const d = name === null ? undefined : remotes.find((x) => x.name === name);
    if (d) {
      const why = unfit(d, i.agent);
      // the project is only on that helper: the router may have filled "device" from the Devices list
      // without the user naming it, so say the project rule (the same computer either way)
      const only = holders(i, remotes);
      if (!why && !i.folderHere && only.length === 1 && only[0] === d)
        return { device: d.name, rule: 'project', note: `${path.basename(i.folder)} is only on ${d.name}.` };
      if (!why) return { device: d.name, rule: 'named', note: `You asked for ${d.name}.` };
      notes.push(`${d.name} ${why}.`);
    } else notes.push(`No computer called "${i.named.trim()}".`);
  }
  // 2. the project is on only one computer
  const has = holders(i, remotes);
  const project = path.basename(i.folder);
  if (i.folderHere && i.repo && has.length === 0) {
    const note = i.busy ? `This Mac is busy, but ${project} is only on this Mac.` : '';
    return { device: '', rule: 'project', note: [...notes, note].filter(Boolean).join(' ') };
  }
  if (!i.folderHere && has.length === 1 && has[0]) {
    const d = has[0];
    const why = unfit(d, i.agent);
    if (!why)
      return { device: d.name, rule: 'project', note: [...notes, `${project} is only on ${d.name}.`].join(' ') };
    notes.push(`${project} is only on ${d.name}, but it ${why}.`);
  }
  // 3. this Mac unless it is busy; then the freest helper (for a project: one that has it)
  if (!i.busy) return { device: '', rule: 'local', note: notes.join(' ') };
  const isProject = i.repo || has.length > 0;
  const free = (isProject ? has : remotes)
    .filter((d) => !unfit(d, i.agent) && d.onAc === true)
    .toSorted((a, b) => a.running - b.running || a.load - b.load || a.name.localeCompare(b.name));
  const best = free[0];
  if (best)
    return {
      device: best.name,
      rule: 'idle',
      note: [...notes, `This Mac is busy; ${best.name} is free (${String(best.running)} sessions).`].join(' '),
    };
  const none = isProject ? `no helper with ${project} is free` : 'no helper is free';
  return { device: '', rule: 'busy', note: [...notes, `This Mac is busy, but ${none}.`].join(' ') };
}

// A project name shown to the router: a plain folder name, nothing that reads as a sentence.
const SAFE_PROJECT = /^[\p{L}\p{N}._+-]{1,80}$/u;
const projectName = (p: DeviceProject): string => {
  const n = path.basename(p.path);
  return SAFE_PROJECT.test(n) ? n : '';
};

/** The devices for the router prompt: names, whether each is online, and their project folder
 * NAMES (so a request can name a project that is only on a helper). The paths stay in the server
 * (helperProject). Only when there are helpers. */
export function promptDevices(local: string, devices: readonly Device[]): object[] {
  const here = local.toLowerCase();
  const remotes = devices.filter((d) => d.name.toLowerCase() !== here && d.helper);
  if (!remotes.length) return [];
  return [
    { name: local || 'this Mac', this_mac: true },
    ...remotes.map((d) => ({
      name: d.name,
      online: d.online,
      projects: [...new Set(d.projects.map(projectName).filter(Boolean))].slice(0, 30),
    })),
  ];
}

/** The router's folder for a project only on a helper is the project's NAME from the Devices list:
 * the exact path of that project in the brain's list. The same name for two different repositories
 * (or anything not listed) gives ''. */
export function helperProject(name: string, devices: readonly Device[], local: string): string {
  const here = local.toLowerCase();
  const found = devices
    .filter((d) => d.helper && d.name.toLowerCase() !== here)
    .flatMap((d) => d.projects)
    .filter((p) => projectName(p) !== '' && projectName(p) === name);
  const first = found[0];
  if (!first) return '';
  const key = remoteKey(first.remote);
  return found.every((p) => p.path === first.path || (key !== '' && remoteKey(p.remote) === key)) ? first.path : '';
}

/** The route's reason with the device choice: the router's reason, the rules' note, and, for a
 * helper, that the session starts on this Mac for now (a helper is started only once the panel's
 * POST /api/new takes a device: multi-device PR 5). */
export function routeNote(p: Pick, reason: string): { device: string; rule: Rule; reason: string } {
  const why = [reason, p.note];
  if (p.device) why.push(`Starting on this Mac for now: this panel cannot start a session on ${p.device} yet.`);
  return { device: p.device, rule: p.rule, reason: why.filter(Boolean).join(' ') };
}

/** This Mac's project folders for localCopy, most likely first: the open sessions' folders, then
 * recent folders, then the heartbeat project scan (each folder once). */
export const localFolders = (
  sessions: readonly string[],
  recent: readonly string[],
  scanned: readonly string[],
): string[] => [...new Set([...sessions, ...recent, ...scanned])];

/** A helper's project path the router gave for a project that is on this Mac too (same git remote):
 * this Mac's folder for it, else ''. remoteOf: a folder's git remote on this Mac (null = not a git
 * repository). localFolders: this Mac's known project folders. Several copies: the main checkout
 * (isMain: its .git is a folder, not a worktree's .git file), else the first copy. */
export function localCopy(
  folder: string,
  devices: readonly Device[],
  localFolders: readonly string[],
  remoteOf: (folder: string) => string | null,
  isMain: (folder: string) => boolean = () => false,
): string {
  const remote = devices.flatMap((d) => d.projects).find((p) => p.path === folder)?.remote ?? '';
  const key = remoteKey(remote);
  if (!key) return '';
  const copies = localFolders.filter((f) => remoteKey(remoteOf(f) ?? '') === key);
  return copies.find((f) => isMain(f)) ?? copies[0] ?? '';
}

/** The rules' input for a new session in `folder`, the same for the server and the router eval.
 * here: the folder exists on this Mac; remoteOf: its git remote (null = not a git repository). */
export function inputFor(o: {
  named: string;
  folder: string;
  here: boolean;
  remoteOf: (folder: string) => string | null;
  local: string;
  busy: boolean;
  agent: string;
  devices: readonly Device[];
}): PickInput {
  const remote = o.here ? o.remoteOf(o.folder) : null;
  // not on this Mac: a helper's project, with its remote from the brain's list
  const away = o.devices.flatMap((d) => d.projects).find((p) => p.path === o.folder)?.remote ?? '';
  return {
    named: o.named,
    folder: o.folder,
    remote: o.here ? (remote ?? '') : away,
    folderHere: o.here,
    repo: remote !== null,
    local: o.local,
    busy: o.busy,
    agent: o.agent,
    devices: o.devices,
  };
}
