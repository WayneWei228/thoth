// Helper update: the main Mac sees which Thoth build each helper runs and updates an older one through
// the peer channel of lib/peer.ts (cloud relay, pinned TLS, pairing token and peer secret). No LAN path.
//
//   main Mac                                                     helper Mac
//   updateHelper {device} ── answers at once with an update id
//   job: its own code as a .tgz (git archive of HEAD, product files only; or a tar of the installed
//        copy) + SHA-256
//        POST /api/peerUpdate {updateId, commit, time, sha256, bundle} ──▶ checks who asks, the
//                                     SHA-256 and the bundle's file list; answers at once; then
//                                     scripts/self-update.sh runs detached: unpack next to the copy,
//                                     swap, npm install, restart (launchd job, or a plain restart)
//   the helper's state (polled every 1.5 s) shows `build` and `update`: the row says "updating" until
//   the helper is back with the new commit, or shows the error the helper wrote.
//
// Build: a git checkout reads `git log -1`; a copy made by git archive (a release bundle, a GitHub zip
// download, an update from the main Mac) has the file BUILD, which git fills in (export-subst).
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface Build {
  version: string;
  /** 40 hex, '' when not known */
  commit: string;
  /** commit time, seconds since 1970; 0 when not known */
  time: number;
}

const SHA = /^[\da-f]{40}$/;
export const UPDATE_ID = /^[\da-f]{16}$/;
export const newUpdateId = (): string => crypto.randomBytes(8).toString('hex');
/** The largest update bundle (bytes). The product is about 2 MB. */
export const MAX_BUNDLE = 30 * 1024 * 1024;
export const MAX_BODY = Math.ceil((MAX_BUNDLE * 4) / 3) + 64 * 1024;
/** The folder name inside every update bundle. */
export const PREFIX = 'claude-panel/';
export const STATUS_FILE = 'update.json';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** "<commit> <time>" from BUILD; null when git did not fill it in (a checkout) or it is broken. */
export function parseBuildFile(text: string | null): { commit: string; time: number } | null {
  const m = /^([\da-f]{40}) (\d{1,12})\s*$/.exec(text ?? '');
  return m ? { commit: m[1] ?? '', time: Number(m[2]) } : null;
}

/** The build of the copy in `root`: git when it is a checkout, else BUILD. */
export function readBuild(root: string, version: string): Build {
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%H %ct'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const b = parseBuildFile(out);
      if (b) return { version, ...b };
    } catch {
      /* not readable: unknown */
    }
    return { version, commit: '', time: 0 };
  }
  let text: string | null;
  try {
    text = fs.readFileSync(path.join(root, 'BUILD'), 'utf8');
  } catch {
    text = null; // an older copy: unknown
  }
  return { version, ...(parseBuildFile(text) ?? { commit: '', time: 0 }) };
}

/** A build from another computer, with only known fields of a known shape; null when it has none. */
export function cleanBuild(v: unknown): Build | null {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  if (!o) return null;
  const time = typeof o['time'] === 'number' && Number.isInteger(o['time']) && o['time'] > 0 ? o['time'] : 0;
  const commit = SHA.test(str(o['commit'])) ? str(o['commit']) : '';
  return { version: str(o['version']).slice(0, 40), commit, time: commit ? time : 0 };
}

/** Does the helper run an older Thoth than this Mac? A helper that does not say its commit is older
 * (it is from before this check). When this Mac does not know its own commit, nothing is compared. */
export function behind(own: Build, helper: Build | null): boolean {
  if (!own.commit) return false;
  if (helper === null || helper.commit === '') return true;
  if (helper.commit === own.commit) return false;
  return helper.time < own.time;
}

/** The text for a helper's 404 "Unknown action" (an action it does not have yet), else null. */
export function olderHelperError(device: string, status: number, json: unknown): string | null {
  const e = typeof json === 'object' && json !== null ? str((json as Record<string, unknown>)['error']) : '';
  return status === 404 && e === 'Unknown action' ? `${device} runs an older Thoth: update it` : null;
}

// ----------------------------------------------------------- helper side ----
/** The helper's update status file (<home>/update.json), written by scripts/self-update.sh. */
export interface Status {
  id: string;
  /** installing | restarting | done | failed */
  state: string;
  error: string;
  commit: string;
}
const STATES = new Set(['installing', 'restarting', 'done', 'failed']);

export function readStatus(home: string): Status | null {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(home, STATUS_FILE), 'utf8')) as Record<string, unknown>;
    const s: Status = {
      id: str(o['id']),
      state: str(o['state']),
      error: str(o['error']).slice(0, 300),
      commit: str(o['commit']),
    };
    return UPDATE_ID.test(s.id) && STATES.has(s.state) ? s : null;
  } catch {
    return null;
  }
}

export function writeStatus(home: string, s: Status): void {
  fs.mkdirSync(home, { recursive: true });
  const p = path.join(home, STATUS_FILE);
  const tmp = `${p}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/** At server start: the update that restarted this server is done when it runs the commit the update
 * brought; any other result is a failure the main Mac shows. Returns the status to keep (or null). */
export function settleAfterStart(s: Status | null, own: Build): Status | null {
  if (s?.state !== 'restarting') return s;
  return s.commit === own.commit
    ? { ...s, state: 'done', error: '' }
    : {
        ...s,
        state: 'failed',
        error: `after the restart this computer still runs ${own.commit.slice(0, 12) || 'an unknown build'}`,
      };
}

/** The helper's status, read again when it is older than `everyMs` (the update script writes the
 * file while this server runs). `reset()` makes the next call read the file. */
export function statusReader(
  home: string,
  everyMs = 1000,
): { get: (now?: number) => Status | null; reset: () => void } {
  let at = -Infinity,
    status: Status | null = null;
  return {
    get(now = Date.now()) {
      if (now - at >= everyMs) {
        status = readStatus(home);
        at = now;
      }
      return status;
    },
    reset() {
      at = -Infinity;
    },
  };
}

/** The status the helper shows in its state (`update`): only a known one. */
export const statusView = (s: Status | null): { id: string; state: string; error: string } | null =>
  s ? { id: s.id, state: s.state, error: s.error } : null;

export interface UpdateRequest {
  updateId: string;
  commit: string;
  time: number;
  bundle: Buffer;
}

/** POST /api/peerUpdate: every field checked; the bundle must match its SHA-256. */
export function parseRequest(body: Record<string, unknown>): UpdateRequest {
  const updateId = str(body['updateId']);
  if (!UPDATE_ID.test(updateId)) throw new Error('Bad update id');
  const commit = str(body['commit']);
  if (!SHA.test(commit)) throw new Error('Bad commit');
  const time = body['time'];
  if (typeof time !== 'number' || !Number.isInteger(time) || time <= 0) throw new Error('Bad commit time');
  const b64 = str(body['bundle']);
  if (b64 === '' || b64.length > MAX_BODY || !/^[A-Za-z\d+/]+={0,2}$/.test(b64)) throw new Error('Bad bundle');
  const bundle = Buffer.from(b64, 'base64');
  if (bundle.length > MAX_BUNDLE) throw new Error('The bundle is too large');
  const want = str(body['sha256']);
  if (!/^[\da-f]{64}$/.test(want)) throw new Error('Bad checksum');
  if (crypto.createHash('sha256').update(bundle).digest('hex') !== want)
    throw new Error('The bundle does not match its checksum: nothing was installed');
  return { updateId, commit, time, bundle };
}

/** The file list of a bundle (`tar -tzf`): every entry under claude-panel/, no absolute path, no '..',
 * and the files a Thoth copy needs. Returns the error, or '' when the list is good. */
export function checkList(list: readonly string[], verbose: readonly string[] = []): string {
  // no symlink or hard link entries (`tar -tvzf`: a mode starting with l or h, or "link to"); the
  // product has none, so nothing can point out of the folder
  const link = verbose.find((l) => /^[hl]/.test(l) || l.includes(' link to '));
  if (link !== undefined) return `The bundle has a link: ${link.slice(0, 120)}`;
  if (list.length === 0) return 'The bundle is empty';
  for (const e of list) {
    if (!e.startsWith(PREFIX) || e.startsWith('/') || e.split('/').includes('..') || e.includes('\\'))
      return `The bundle has a bad path: ${e.slice(0, 120)}`;
  }
  const have = new Set(list);
  for (const f of ['server.ts', 'package.json', 'scripts/self-update.sh', 'lib/self_update.ts'])
    if (!have.has(PREFIX + f)) return `The bundle is not a Thoth copy (no ${f})`;
  return '';
}

/** Why this copy cannot replace itself, or ''. A git checkout is updated with git, never replaced. */
export function cannotUpdate(root: string, platform: string = process.platform): string {
  // macOS (launchd) and Linux, WSL included (systemd user units of scripts/services.sh, or a plain restart)
  if (platform !== 'darwin' && platform !== 'linux')
    return 'Remote updates work on macOS and Linux helpers only: update this computer by hand';
  if (fs.existsSync(path.join(root, '.git')))
    return 'This computer runs Thoth from a git checkout: update it with git there';
  if (!fs.existsSync(path.join(root, 'scripts', 'self-update.sh'))) return 'This copy has no update script';
  return '';
}

/** The launchd job that runs this server (XPC_SERVICE_NAME), when it is a Thoth server job. */
export function launchdLabel(env: NodeJS.ProcessEnv): string {
  const l = env['XPC_SERVICE_NAME'] ?? '';
  return /^com\.claudepanel\.server(\.[\w-]{1,40})?$/.test(l) ? l : '';
}

/** The systemd user unit that runs this server (scripts/services.sh: claude-panel-server.service), from
 * the text of /proc/self/cgroup: the last part of the cgroup path (v2 "0::", or v1 "name=systemd"). */
export function systemdUnit(cgroup: string): string {
  for (const line of cgroup.split('\n')) {
    const m = /^\d+:(?:name=systemd)?:(.*)$/.exec(line);
    const last = m?.[1]?.split('/').pop() ?? '';
    if (/^claude-panel-server(\.[\w-]{1,40})?\.service$/.test(last)) return last;
  }
  return '';
}

/** How scripts/self-update.sh restarts this server: a launchd label (macOS), a systemd unit name
 * (Linux, ends in ".service"), or '' (stop and start the process). */
export function serviceLabel(env: NodeJS.ProcessEnv, platform: string = process.platform, cgroup?: string): string {
  if (platform === 'darwin') return launchdLabel(env);
  if (platform !== 'linux') return '';
  let text = cgroup;
  if (text === undefined) {
    try {
      text = fs.readFileSync('/proc/self/cgroup', 'utf8');
    } catch {
      text = '';
    }
  }
  return systemdUnit(text);
}

/** Starts scripts/self-update.sh detached (own session and process group: launchd's restart of the
 * server job does not stop it; on Linux it stays in the server unit's cgroup, and the unit's
 * KillMode=process stops only the server on `systemctl --user restart`). It never blocks the server. */
export function startInstall(o: {
  root: string;
  bundle: string;
  home: string;
  updateId: string;
  commit: string;
  time: number;
  label: string;
  node: string;
  serverPid: number;
}): void {
  const log = fs.openSync(path.join(o.home, 'update.log'), 'a', 0o600);
  const child = spawn(
    '/bin/bash',
    [
      path.join(o.root, 'scripts', 'self-update.sh'),
      o.root,
      o.bundle,
      path.join(o.home, STATUS_FILE),
      o.updateId,
      o.commit,
      String(o.time),
      o.label,
      o.node,
      String(o.serverPid),
    ],
    { detached: true, stdio: ['ignore', log, log], cwd: path.dirname(o.root) },
  );
  // the script could not start at all: the main Mac sees the failure
  child.on('error', (e) => {
    writeStatus(o.home, {
      id: o.updateId,
      state: 'failed',
      error: `the update script did not start: ${e.message}`,
      commit: o.commit,
    });
  });
  child.unref();
  fs.closeSync(log);
}

// -------------------------------------------------------------- main side ----
/** This Mac's code as an update bundle (.tgz with the folder claude-panel/), and its SHA-256. A git
 * checkout: git archive of `commit` (the commit the server runs and the update names, not a HEAD that
 * moved since; product files only, when the list of what is not the product is there; git fills in BUILD). An
 * installed copy: a tar of its files without packages and build caches. */
export function makeBundle(root: string, out: string, commit = 'HEAD'): Promise<string> {
  return new Promise((resolve, reject) => {
    const git = fs.existsSync(path.join(root, '.git'));
    const args = git
      ? ['archive', '--format=tar.gz', `--prefix=${PREFIX}`, '-o', out, commit, '--', '.', ...productExcludes(root)]
      : [
          '-czf',
          out,
          '--exclude=./node_modules',
          '--exclude=./macos/.build',
          '--exclude=./.git',
          '--exclude=./dist',
          '-s',
          `,^\\.,${PREFIX.slice(0, -1)},`,
          '.',
        ];
    const p = spawn(git ? 'git' : 'tar', args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c: Buffer) => {
      err += c.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`cannot make the update bundle: ${err.trim().slice(0, 300) || `exit ${String(code)}`}`));
        return;
      }
      const h = crypto.createHash('sha256');
      fs.createReadStream(out)
        .on('data', (c) => h.update(c))
        .on('error', reject)
        .on('end', () => {
          resolve(h.digest('hex'));
        });
    });
  });
}

/** git pathspecs that leave out what is not the product (NOT_PRODUCT in the scripts folder's product-paths.sh). */
export function productExcludes(root: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'scripts', 'product-paths.sh'), 'utf8');
  } catch {
    return [];
  }
  const m = /NOT_PRODUCT=\(([\s\S]*?)\)/.exec(text);
  return (m?.[1] ?? '')
    .split('\n')
    .flatMap((line) => line.replace(/#.*$/, '').trim().split(/\s+/))
    .filter((x) => /^[\w./-]+$/.test(x))
    .map((x) => `:(exclude)${x}`);
}

export interface Job {
  updateId: string;
  device: string;
  /** sending (bundle on its way) | installing (the helper has it) | done | failed */
  state: 'sending' | 'installing' | 'done' | 'failed';
  error: string;
  /** the commit the helper will run */
  commit: string;
  at: number;
}

export interface Jobs {
  get: (device: string) => Job | undefined;
  /** a new update of `device`; the same update id, or a running update of that device, starts nothing */
  start: (device: string, updateId: string, commit: string, work: () => Promise<void>) => Job;
  /** what the helper's state says: back with the new commit (done) or its update failed */
  follow: (device: string, build: Build | null, status: { id: string; state: string; error: string } | null) => void;
}

export function createJobs(onChange: () => void = () => undefined): Jobs {
  const jobs = new Map<string, Job>();
  const set = (j: Job, state: Job['state'], error = ''): void => {
    if (j.state === state && j.error === error) return;
    j.state = state;
    j.error = error;
    onChange();
  };
  return {
    get: (device) => jobs.get(device),
    start(device, updateId, commit, work) {
      if (!UPDATE_ID.test(updateId)) throw new Error('Bad update id');
      const old = jobs.get(device);
      if (old && (old.updateId === updateId || old.state === 'sending' || old.state === 'installing')) return old;
      const job: Job = { updateId, device, state: 'sending', error: '', commit, at: Date.now() };
      jobs.set(device, job);
      onChange();
      void work().then(
        () => {
          if (jobs.get(device) === job && job.state === 'sending') set(job, 'installing');
        },
        (e: unknown) => {
          if (jobs.get(device) === job) set(job, 'failed', (e instanceof Error ? e.message : String(e)).slice(0, 300));
        },
      );
      return job;
    },
    follow(device, build, status) {
      const j = jobs.get(device);
      if (!j || (j.state !== 'installing' && j.state !== 'sending')) return;
      if (status?.id === j.updateId && status.state === 'failed') set(j, 'failed', status.error || 'the update failed');
      // also while still sending: the helper can be back with the new commit before the answer arrives
      else if (build?.commit === j.commit) set(j, 'done');
    },
  };
}

/** What the sidebar shows for a helper: `update` = needed | updating | failed | '' and the error. */
export function peerStatus(own: Build, build: Build | null, job: Job | undefined): { update: string; error: string } {
  if (job && (job.state === 'sending' || job.state === 'installing')) return { update: 'updating', error: '' };
  const old = behind(own, build);
  // a failed update shows its error while the helper is still older (a later manual update clears it)
  if (job?.state === 'failed' && old) return { update: 'failed', error: job.error };
  return { update: old ? 'needed' : '', error: '' };
}
