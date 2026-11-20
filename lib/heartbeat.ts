// Device heartbeat (multi-device plan, PR 3). Every 30 s this computer's server tells the brain how
// it is: online, role (main/helper), on AC power, CPU load, running sessions, the projects it has
// (git remote + path), whether claude/codex are available, and the Thoth version. Outgoing HTTPS only;
// the brain (brain/heartbeat.py) keeps the newest one and calls a device offline after 90 s.
// This file holds the parts that need no server: what to send, where, and how to read git and pmset.
import fs from 'node:fs';
import path from 'node:path';

export const EVERY_MS = 30_000;
/** The brain has no /api/heartbeat (an older brain): ask again after this long, not every 30 s. */
export const OLD_BRAIN_RETRY_MS = 10 * 60_000;
/** The brain refused the token (removed or revoked device) or limits this address: wait this long.
 * Every refused token counts in the brain's wrong-token limit (20 in 10 minutes for the whole
 * address), so a dead token sent every 30 s would lock out the owner's other computers. */
export const REFUSED_RETRY_MS = 60 * 60_000;

/** How long to wait before the next heartbeat after the brain answered with this status. */
export function waitAfter(status: number): number {
  if (status === 404) return OLD_BRAIN_RETRY_MS;
  if (status === 401 || status === 403 || status === 429) return REFUSED_RETRY_MS;
  return 0;
}

/** A pause for one brain only: a new target (another brain, a new token) is not held back. */
export interface Pause {
  key: string;
  until: number;
}
export const paused = (p: Pause | null, key: string, now: number): boolean =>
  p !== null && p.key === key && now < p.until;

/** The name to send with the owner token: the brain's own name for this computer exactly as the
 * brain has it (devices.json; the brain accepts it even when it breaks the new-device name rule), so
 * the heartbeat joins that device; the host name when the brain's name is not known. */
export const deviceName = (brainName: string, hostName: string): string =>
  brainName !== '' && brainName.length <= 100 ? brainName : hostName;
export const MAX_PROJECTS = 200;
export const PROJECT_SCAN_MS = 10 * 60_000;

/** Scan the projects again: every PROJECT_SCAN_MS, or at once when the session folders changed. */
export function rescan(last: { at: number; key: string }, folders: readonly string[], now: number): string | null {
  const key = [...new Set(folders)].toSorted().join('\n');
  return key !== last.key || now - last.at > PROJECT_SCAN_MS ? key : null;
}

export interface Project {
  path: string;
  remote: string;
}

export interface Heartbeat {
  role: 'main' | 'helper';
  on_ac: boolean | null;
  cpu_load: number;
  cpus: number;
  running_sessions: number;
  working_sessions: number;
  projects: Project[];
  claude: boolean;
  codex: boolean;
  thoth_version: string;
  device?: string;
}

export interface HeartbeatInput {
  role: unknown;
  onAc: boolean | null;
  load: number;
  cpus: number;
  sessionStates: readonly string[];
  projects: readonly Project[];
  claude: boolean;
  codex: boolean;
  version: string;
}

export function build(i: HeartbeatInput): Heartbeat {
  return {
    role: i.role === 'helper' ? 'helper' : 'main',
    on_ac: i.onAc,
    cpu_load: Math.round(i.load * 100) / 100,
    cpus: i.cpus,
    running_sessions: i.sessionStates.length,
    working_sessions: i.sessionStates.filter((s) => s === 'working').length,
    projects: i.projects.slice(0, MAX_PROJECTS),
    claude: i.claude,
    codex: i.codex,
    thoth_version: i.version,
  };
}

/** `pmset -g batt` -> true (AC power), false (battery), null (cannot tell). */
export function onAcPower(pmsetOut: string | null | undefined): boolean | null {
  const m = /drawing from '([^']+)'/.exec(pmsetOut ?? '');
  if (!m) return null;
  if (m[1] === 'AC Power') return true;
  if (m[1] === 'Battery Power') return false;
  return null;
}

/** A git remote without secrets: no user name or password (https://user:token@host/x, or
 * user:pw@host:path; up to the LAST '@' before the path, so an unencoded '@' in a password goes too),
 * then no query or fragment (?access_token=...). Surrounding quotes go first. 'git@host:path' keeps
 * its 'git' (no password there). */
export function safeRemote(url: string): string {
  let u = url.trim();
  if (u.length >= 2 && u.startsWith('"') && u.endsWith('"')) u = u.slice(1, -1);
  return u
    .replace(/^([a-z][a-z\d+.-]*:\/\/)[^/]*@/i, '$1')
    .replace(/^[^/:@]*:[^/]*@/, '')
    .replace(/[?#].*$/, '');
}

/** A git config value: a quoted part without its quotes and with \" \\ unescaped; an unquoted
 * ';' or '#' starts a comment (git-config(1)). */
export function gitValue(raw: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] ?? '';
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[++i] ?? '';
      out += n === 't' ? '\t' : n === 'n' ? '\n' : n;
    } else if (c === '"') quoted = !quoted;
    else if (!quoted && (c === ';' || c === '#')) break;
    else out += c;
  }
  return out.trim();
}

/** The origin URL in a git config file (else the first remote's), without credentials; '' if none. */
export function remoteFromConfig(config: string): string {
  let section = '';
  const urls: Record<string, string> = {};
  const order: string[] = [];
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    const sec = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (sec) {
      section = sec[1] ?? '';
      continue;
    }
    if (line.startsWith('[')) {
      section = '';
      continue;
    }
    const kv = /^url\s*=\s*(.+)$/.exec(line);
    if (section && kv && !(section in urls)) {
      urls[section] = gitValue(kv[1] ?? '');
      order.push(section);
    }
  }
  const pick = urls['origin'] ?? (order[0] === undefined ? '' : urls[order[0]]);
  return safeRemote(pick ?? '');
}

/** Minimal file access, so tests can use a fake folder tree. */
export interface Files {
  read: (p: string) => string | null;
  isDir: (p: string) => boolean;
  list: (p: string) => string[];
}
export const realFiles: Files = {
  read: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  isDir: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  list: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
};

/** The git config of a repository folder: .git/config, or for a worktree (.git is a file
 * "gitdir: <main>/.git/worktrees/<name>") the main repository's config. null = not a repository. */
export function gitConfig(dir: string, f: Files): string | null {
  const dotGit = path.join(dir, '.git');
  if (f.isDir(dotGit)) return f.read(path.join(dotGit, 'config')) ?? '';
  const link = /^gitdir:\s*(.+)$/m.exec(f.read(dotGit) ?? '');
  if (!link) return null;
  const gitdir = path.resolve(dir, (link[1] ?? '').trim());
  const common = (f.read(path.join(gitdir, 'commondir')) ?? '').trim();
  return f.read(path.join(common ? path.resolve(gitdir, common) : gitdir, 'config')) ?? '';
}

/** Folders where people keep their projects; their direct subfolders are checked. */
export const PROJECT_ROOTS = ['code', 'Code', 'Developer', 'projects', 'Projects', 'src', 'repos', 'git', 'workspace'];

/** The git repositories on this computer: the folders of the open sessions (anywhere; or the
 * repository above one, up to home) and the direct subfolders of the PROJECT_ROOTS in home. Sorted by path. */
export function findProjects(home: string, sessionFolders: readonly string[], f: Files = realFiles): Project[] {
  const seen = new Map<string, string>();
  const add = (dir: string): boolean => {
    if (seen.has(dir)) return true;
    const conf = gitConfig(dir, f);
    if (conf === null) return false;
    seen.set(dir, remoteFromConfig(conf));
    return true;
  };
  for (const folder of sessionFolders) {
    let dir = path.resolve(folder);
    if (add(dir)) continue;
    // the repository that holds the session's folder; never above home or the file system root
    dir = path.dirname(dir);
    while (dir.startsWith(home + path.sep) && !add(dir)) dir = path.dirname(dir);
  }
  // only the names home really has: on a case-insensitive disk (macOS) ~/code and ~/Code are one folder
  const inHome = new Set(f.list(home));
  for (const root of PROJECT_ROOTS.filter((x) => inHome.has(x))) {
    const r = path.join(home, root);
    if (!f.isDir(r)) continue;
    for (const name of f.list(r).toSorted()) {
      if (seen.size >= MAX_PROJECTS) break;
      if (!name.startsWith('.') && f.isDir(path.join(r, name))) add(path.join(r, name));
    }
  }
  return [...seen]
    .map(([p, remote]) => ({ path: p, remote }))
    .toSorted((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_PROJECTS);
}

/** A device file (the panel's own or the device agent's), the fields read here. */
export interface DeviceConf {
  token?: unknown;
  mode?: unknown;
  hub?: unknown;
}
export interface Target {
  url: string;
  token: string;
  /** set when the token is the owner's (the brain then needs the name); a device token names itself */
  device?: string;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** https, or http only to this computer: a token never goes over the network in clear text. */
export function secureUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/**
 * Where this computer sends its heartbeat, or null.
 * 1. its identity on the cloud brain (a device token; the token names the device);
 * 2. outside test instances: the device agent's file, when the panel is not connected to a cloud
 *    brain itself (a helper computer that joined with a code has a device token, no owner token);
 * 3. the brain the panel uses (cloud with the owner token, or the local brain with its write token),
 *    with this computer's name.
 */
export function target({
  identity,
  agent,
  brain,
  hostName,
  test,
}: {
  identity: DeviceConf | null;
  agent: DeviceConf | null;
  brain: { url: string; token: string; cloud: boolean } | null;
  hostName: string;
  test: boolean;
}): Target | null {
  const cloud = (c: DeviceConf | null): Target | null =>
    c && c.mode === 'cloud' && str(c.token) && secureUrl(str(c.hub))
      ? { url: str(c.hub).replace(/\/+$/, ''), token: str(c.token) }
      : null;
  const own = cloud(identity);
  if (own) return own;
  const fromAgent = test ? null : cloud(agent);
  if (fromAgent && brain?.cloud !== true) return fromAgent;
  if (brain && brain.token !== '' && secureUrl(brain.url))
    return { url: brain.url.replace(/\/+$/, ''), token: brain.token, device: hostName };
  return null;
}
