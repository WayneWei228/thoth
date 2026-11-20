// A new session on a helper computer (multi-device plan, PR 5). The main panel sends one request
// (POST /api/peerNew) through the peer channel of lib/peer.ts (cloud relay, TLS pinned, pairing
// token); the helper makes the folder and starts the session there.
//
//   main Mac                                   helper Mac (under <Thoth home>/remote-work/<id>/)
//   project folder ─┬─ has a git remote ─────▶ the same project here (match by remote)? → git worktree
//                   │                           else                                   → git clone
//                   └─ no remote ── bundle ───▶ git init + fetch the bundle
//   no folder, or not a git repository ── scratch ▶ an empty folder (no code is sent)
//
// - The user's checkouts are never changed: the main Mac's snapshot uses a temporary index and a
//   private ref that is deleted after the bundle is written (brain/collector.py snapshot); on the
//   helper a worktree gets its own new branch `thoth/<id>` and its own folder.
// - The caller never chooses a path on the helper: the helper makes `<work root>/<id>/<name>` with
//   its own random id, and the name is reduced to safe characters.
// - Only the owner's main panel may ask: its sealed link has a secret (`peer`) that a remote client's
//   pairing link does not have; the helper checks it on every /api/peerNew (checkSecret).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Project } from './heartbeat.ts';

/** The largest bundle (raw bytes) sent through the relay (about 1 MB/s per tunnel). */
export const MAX_BUNDLE = 20 * 1024 * 1024;
/** The largest request body of /api/peerNew (the bundle in base64, plus the text). */
export const MAX_BODY = Math.ceil((MAX_BUNDLE * 4) / 3) + 256 * 1024;
const MAX_TEXT = 100_000;

// ------------------------------------------------------------ peer secret ----
const SECRET = /^[\w-]{32,128}$/;

/** The helper's peer secret: <home>/peer-secret (0600), made once. */
export function loadSecret(home: string): string {
  const p = path.join(home, 'peer-secret');
  try {
    const s = fs.readFileSync(p, 'utf8').trim();
    if (SECRET.test(s)) return s;
  } catch {
    /* make one */
  }
  const s = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${p}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, s + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
  return s;
}

/** The link the helper seals for the main panels: its pairing link plus the peer secret. */
export const withSecret = (link: string, secret: string): string => `${link}&peer=${encodeURIComponent(secret)}`;

/** True when `given` (the request's header) is the helper's secret (constant time). */
export function checkSecret(given: unknown, secret: string): boolean {
  if (typeof given !== 'string' || !SECRET.test(given) || !SECRET.test(secret)) return false;
  const a = crypto.createHash('sha256').update(given).digest(),
    b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Whether the helper takes a /api/peerNew: only as a helper, only through the relay or a remote
 * listener (never a page on this computer), and only with the peer secret of the sealed link. */
export const mayStart = (o: { helper: boolean; viaRemote: boolean; header: unknown; secret: string }): boolean =>
  o.helper && o.viaRemote && checkSecret(o.header, o.secret);

// ---------------------------------------------------------------- remotes ----
/** A remote without scheme, user, `.git` and case: `github.com/o/r` for https, ssh and scp forms. */
export function normRemote(url: string): string {
  let u = url.trim().toLowerCase();
  const scheme = /^[a-z][a-z\d+.-]*:\/\//.exec(u);
  if (scheme) u = u.slice(scheme[0].length);
  u = u.replace(/^[^/@]*@/, ''); // user (and password)
  // with a scheme, host:<digits>/ is a port; in the scp form host:path the path may start with digits
  u = scheme ? u.replace(/^([^/:]+):\d+\//, '$1/') : u.replace(/^([^/:]+):/, '$1/');
  return u
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

/** A remote the helper may clone or fetch: https, ssh, or the scp form `user@host:path`. Never a
 * local path, file://, ext::, or anything that git could read as an option. */
export function validRemote(url: string): boolean {
  if (url.length > 500 || /[\s\\]/.test(url) || url.startsWith('-') || url.includes('::')) return false;
  if (/^(https|ssh):\/\/[\w.@:%-]+\/[\w./~%-]+$/i.test(url)) return true;
  return /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url) && !url.includes('..');
}

/** The remote as the main panel sends it: an ssh user stays (git@…), a password goes, https user
 * info goes (a token), no query or fragment; '' when the helper could not use it (a local path,
 * file://, http) — the project then travels as a bundle. */
export function sendableRemote(url: string): string {
  let u = url.trim().replace(/[?#].*$/, '');
  if (/^https:\/\//i.test(u)) u = u.replace(/^(https:\/\/)[^/]*@/i, '$1');
  else u = u.replace(/^(ssh:\/\/[^/:@]+):[^/@]*@/i, '$1@');
  return validRemote(u) ? u : '';
}

/** The local project with the same remote, or null. */
export function findLocal(projects: readonly Project[], remote: string): string | null {
  const want = normRemote(remote);
  if (!want) return null;
  return projects.find((p) => p.remote !== '' && normRemote(p.remote) === want)?.path ?? null;
}

/** True when `p` is `root` or inside it. */
export const isInside = (p: string, root: string): boolean => {
  const r = path.relative(root, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

/** The projects a worktree may be added to: never a folder this helper made for an earlier remote
 * session (<work root>/…), only the user's own checkouts. */
export const ownProjects = (projects: readonly Project[], workRoot: string): Project[] =>
  projects.filter((p) => !isInside(p.path, workRoot));

/** A subfolder of the repository as the main panel sends it: '' or a relative path without `..`,
 * `.git` or an absolute start; anything else is ''. */
export function safeSub(sub: string): string {
  const s = sub.replaceAll('\\', '/').replace(/\/+$/, '');
  if (s === '' || s.length > 300 || s.includes('\0') || path.isAbsolute(s)) return '';
  const parts = s.split('/');
  if (parts.some((x) => x === '' || x === '.' || x === '..' || x.toLowerCase() === '.git')) return '';
  return parts.join('/');
}

/** The folder the session starts in: `sub` of the new checkout when it is there (and stays inside it
 * after links are followed), else the checkout itself. */
export function startFolder(folder: string, sub: string): string {
  const s = safeSub(sub);
  if (!s) return folder;
  const want = path.join(folder, s);
  try {
    const real = fs.realpathSync(want);
    if (fs.statSync(real).isDirectory() && isInside(real, fs.realpathSync(folder))) return want;
  } catch {
    /* not there */
  }
  return folder;
}

// ---------------------------------------------------------------- request ----
export interface PeerNewRequest {
  name: string;
  agent: 'claude' | 'codex';
  text: string;
  remote: string;
  commit: string;
  branch: string;
  dirty: number;
  bundle: Buffer | null;
  /** the request id the main panel chose: the same id never starts a second session */
  requestId: string;
  /** the subfolder of the repository the session starts in ('' = the root) */
  sub: string;
  /** no project: the helper makes an empty folder (no remote, no bundle) */
  scratch: boolean;
}

/** A request id: 16 hex characters. */
export const REQUEST_ID = /^[\da-f]{16}$/;
export const newRequestId = (): string => crypto.randomBytes(8).toString('hex');

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The fields of POST /api/peerNew, checked; throws with a message the main panel shows. */
export function parseRequest(j: Record<string, unknown>): PeerNewRequest {
  const agent = str(j['agent']) || 'claude';
  if (agent !== 'claude' && agent !== 'codex') throw new Error('Unknown agent');
  const text = str(j['text']);
  if (text.length > MAX_TEXT) throw new Error('The request is too long');
  const scratch = j['scratch'] === true;
  const remote = scratch ? '' : str(j['remote']);
  if (remote !== '' && !validRemote(remote)) throw new Error('This git remote cannot be used on the helper');
  const commit = str(j['commit']);
  if (commit !== '' && !/^[\da-f]{40}$/.test(commit)) throw new Error('Bad commit');
  const b64 = scratch ? '' : str(j['bundle']);
  if (b64.length > MAX_BODY || (b64 !== '' && !/^[A-Za-z\d+/]+={0,2}$/.test(b64))) throw new Error('Bad bundle');
  const bundle = b64 === '' ? null : Buffer.from(b64, 'base64');
  if (bundle && bundle.length > MAX_BUNDLE) throw new Error('The project is too large to send without a git remote');
  if (!scratch && !bundle && remote === '') throw new Error('No code: neither a git remote nor a bundle');
  const dirty = Number(j['dirty']);
  const requestId = str(j['requestId']);
  if (!REQUEST_ID.test(requestId)) throw new Error('Bad request id');
  return {
    requestId,
    sub: safeSub(str(j['sub'])),
    name: str(j['name']).slice(0, 30),
    agent,
    text,
    remote,
    commit,
    branch: str(j['branch']).slice(0, 100),
    dirty: Number.isInteger(dirty) && dirty > 0 ? dirty : 0,
    bundle,
    scratch,
  };
}

/** A folder name from the remote or the session name: letters (any script), digits, `.`, `_`, `-` only. */
export function folderName(remote: string, name: string): string {
  const base = remote ? (normRemote(remote).split('/').pop() ?? '') : name;
  const safe = base
    .replaceAll(/[^\p{L}\p{N}_.-]/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 60);
  return safe || 'project';
}

// -------------------------------------------------------------------- git ----
// variables that point git at another repository; inherited by accident they would change the wrong one
const GIT_LOCAL_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of GIT_LOCAL_VARS) Reflect.deleteProperty(e, k);
  // never wait for a password or a host key question: the helper has nobody at the keyboard
  return { ...e, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', ...extra };
}

export interface GitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** stops the git process (the user closed the preparing row); no time limit otherwise */
  signal?: AbortSignal | undefined;
}
export function git(args: readonly string[], { cwd, env = gitEnv(), signal }: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('cancelled'));
      return;
    }
    execFile('git', args, { cwd, env, signal, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (signal?.aborted === true) reject(new Error('cancelled'));
      else if (err) reject(new Error(`git ${args[0] ?? ''}: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout.trim());
    });
  });
}
const gitOk = (args: readonly string[], o: GitOptions): Promise<boolean> =>
  git(args, o).then(
    () => true,
    () => false,
  );

// ------------------------------------------------------------- main side ----
export interface Source {
  root: string;
  /** the chosen folder relative to the root ('' = the root) */
  sub: string;
  remote: string;
  commit: string;
  branch: string;
  dirty: number;
}

/** The main Mac's project: its repository root, remote (sendableRemote; '' = send a bundle), HEAD, branch and the number
 * of changed files. Throws when the folder is not in a git repository. */
export async function sourceInfo(folder: string, signal?: AbortSignal): Promise<Source> {
  const root = await git(['rev-parse', '--show-toplevel'], { cwd: folder, signal }).catch(() => '');
  signal?.throwIfAborted();
  if (!root) throw new Error('The folder is not a git repository: only git projects can start on another computer');
  const o = { cwd: root, signal };
  const remotes = (await git(['remote'], o).catch(() => '')).split('\n').filter(Boolean);
  const name = remotes.includes('origin') ? 'origin' : (remotes[0] ?? '');
  const remote = name ? sendableRemote(await git(['remote', 'get-url', name], o).catch(() => '')) : '';
  const commit = await git(['rev-parse', '--verify', '-q', 'HEAD'], o).catch(() => '');
  const branch = await git(['branch', '--show-current'], o).catch(() => '');
  const status = await git(['status', '--porcelain'], o).catch(() => '');
  signal?.throwIfAborted();
  let sub = '';
  try {
    sub = safeSub(path.relative(fs.realpathSync(root), fs.realpathSync(folder)).split(path.sep).join('/'));
  } catch {
    /* the root */
  }
  return { root, sub, remote, commit, branch, dirty: status ? status.split('\n').length : 0 };
}

/** The source of a project only on the helper (router): its git remote; nothing is read on this Mac
 * (root '' = no "Fetch result" source to save), and the helper starts from its own checkout. */
export const helperSource = (remote: string): Source => ({
  root: '',
  sub: '',
  remote,
  commit: '',
  branch: '',
  dirty: 0,
});

/** The body of POST /api/peerNew: the code of `src` (a bundle when it has no remote), or a scratch
 * request (an empty folder on the helper) when there is no source. */
export function peerNewBody(o: {
  requestId: string;
  name: string;
  agent: string;
  text: string;
  from: string;
  src: Source | null;
  bundle: string;
}): Record<string, unknown> {
  const head = { requestId: o.requestId, name: o.name, agent: o.agent, text: o.text, from: o.from };
  if (!o.src) return { ...head, scratch: true };
  const { remote, commit, branch, dirty, sub } = o.src;
  return { ...head, remote, commit, branch, dirty, sub, bundle: o.bundle };
}

/** sourceInfo for a folder that can send code; null for no folder or a folder outside a git
 * repository (the helper then starts in an empty folder: a scratch request). */
export async function remoteSource(folder: string, signal?: AbortSignal): Promise<Source | null> {
  if (!folder) return null;
  const root = await git(['rev-parse', '--show-toplevel'], { cwd: folder, signal }).catch(() => '');
  signal?.throwIfAborted();
  return root ? sourceInfo(folder, signal) : null;
}

/** A bundle of the work in `root` (commits + staged + unstaged + new files, as .gitignore allows)
 * WITHOUT changing the user's branch, index or working tree: a temporary index builds a commit on the
 * private ref refs/thoth/remote-new/<id>, which is deleted after the bundle is written. */
export async function snapshotBundle(root: string, id: string, tmpDir: string, signal?: AbortSignal): Promise<Buffer> {
  if (!/^[\da-f]{8,32}$/.test(id)) throw new Error('bad id');
  // the bundle holds uncommitted files (maybe secrets): a private folder
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(tmpDir, 0o700);
  const index = path.join(tmpDir, `index-${id}`),
    file = path.join(tmpDir, `bundle-${id}`),
    ref = `refs/thoth/remote-new/${id}`;
  const env = gitEnv({
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'thoth',
    GIT_AUTHOR_EMAIL: 'thoth@localhost',
    GIT_COMMITTER_NAME: 'thoth',
    GIT_COMMITTER_EMAIL: 'thoth@localhost',
  });
  const o = { cwd: root, env, signal };
  try {
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root }).catch(() => '');
    if (head) await git(['read-tree', 'HEAD'], o);
    await git(['add', '-A'], o);
    const tree = await git(['write-tree'], o);
    const commit = await git(
      ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'thoth: snapshot for a helper'],
      o,
    );
    await git(['update-ref', ref, commit], { cwd: root, signal });
    await git(['bundle', 'create', '-q', file, ref], { cwd: root, signal });
    const data = fs.readFileSync(file);
    if (data.length > MAX_BUNDLE) throw new Error('The project is too large to send without a git remote (20 MB)');
    return data;
  } finally {
    await git(['update-ref', '-d', ref], { cwd: root }).catch(() => '');
    for (const p of [index, file]) fs.rmSync(p, { force: true });
  }
}

// ----------------------------------------------------------- helper side ----
export interface Prepared {
  folder: string;
  /** where the session starts: the subfolder the main Mac chose when it is there, else `folder` */
  start: string;
  branch: string;
  from: 'worktree' | 'clone' | 'bundle' | 'scratch';
  commit: string;
  note: string;
}

export interface PrepareOptions {
  workRoot: string;
  projects: readonly Project[];
  req: PeerNewRequest;
  id?: string | undefined;
  /** extra `git -c` settings for clone and fetch (tests point a remote at a local folder) */
  gitConfig?: readonly string[];
  /** the user closed the preparing row: git stops and the folder is removed */
  signal?: AbortSignal | undefined;
}

// a clone or fetch may only use https and ssh (no file://, ext::, or other helpers)
const NET_ONLY = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always'];

/** Make the helper's folder for a new session (see the top of this file) and return it. */
export async function prepare({
  workRoot,
  projects,
  req,
  id: idIn,
  gitConfig = [],
  signal,
}: PrepareOptions): Promise<Prepared> {
  const p = await prepareCode({ workRoot, projects, req, id: idIn, gitConfig, signal });
  const start = startFolder(p.folder, req.sub);
  const note = req.sub && start === p.folder ? `${p.note}; the subfolder ${req.sub} is not in it` : p.note;
  return { ...p, start, note };
}

async function prepareCode({
  workRoot,
  projects,
  req,
  id: idIn,
  gitConfig = [],
  signal,
}: PrepareOptions): Promise<Omit<Prepared, 'start'>> {
  const id = idIn ?? crypto.randomBytes(4).toString('hex');
  if (!/^[\da-f]{8}$/.test(id)) throw new Error('bad id');
  const base = path.join(workRoot, id);
  const folder = path.join(base, folderName(req.remote, req.name));
  const branch = `thoth/${id}`;
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const net = [...NET_ONLY, ...gitConfig];
  let addedTo = ''; // the helper's checkout that got a worktree (undone on a failure)
  const short = req.commit.slice(0, 8);
  const has = (cwd: string, rev: string): Promise<boolean> =>
    gitOk(['cat-file', '-e', `${rev}^{commit}`], { cwd, signal });
  // every git call of this request stops when the row is closed
  const run = (args: readonly string[], cwd: string): Promise<string> => git(args, { cwd, signal });
  try {
    if (req.scratch) {
      fs.mkdirSync(folder);
      signal?.throwIfAborted();
      return { folder, branch: '', from: 'scratch', commit: '', note: 'an empty folder: no code was sent' };
    }
    if (req.bundle) {
      const file = path.join(base, 'code.bundle');
      fs.writeFileSync(file, req.bundle, { mode: 0o600 });
      fs.mkdirSync(folder);
      await run(['init', '-q'], folder);
      const heads = await run(['bundle', 'list-heads', file], folder);
      const ref = /^[\da-f]{40} (refs\/[\w./-]+)$/m.exec(heads)?.[1] ?? '';
      if (ref === '') throw new Error('The bundle has no branch');
      await run(['fetch', '-q', file, `${ref}:refs/heads/${branch}`], folder);
      await run(['checkout', '-q', branch], folder);
      fs.rmSync(file, { force: true });
      const commit = await run(['rev-parse', 'HEAD'], folder);
      signal?.throwIfAborted();
      return {
        folder,
        branch,
        from: 'bundle',
        commit,
        note: 'a copy of the main Mac’s folder, with its uncommitted work',
      };
    }
    const local = findLocal(ownProjects(projects, workRoot), req.remote);
    if (local !== null) {
      // the same project is here: a new worktree on a new branch; the user's checkout stays as it is
      let start = req.commit;
      let note = `a new worktree of ${local}`;
      if (req.commit && !(await has(local, req.commit))) {
        const remotes = (await run(['remote'], local).catch(() => '')).split('\n').filter(Boolean);
        for (const r of remotes) {
          const url = await run(['remote', 'get-url', r], local).catch(() => '');
          if (normRemote(url) === normRemote(req.remote) || r === 'origin')
            await run([...net, 'fetch', '-q', r], local).catch(() => '');
          if (await has(local, req.commit)) break;
        }
      }
      if (!req.commit || !(await has(local, req.commit))) {
        start = (await has(local, 'origin/HEAD')) ? 'origin/HEAD' : 'HEAD';
        if (req.commit) note += `; the main Mac's commit ${short} is not here, so it starts from ${start}`;
      }
      addedTo = local; // set first: a worktree add stopped half way is undone too
      await run(['worktree', 'add', '-q', '-b', branch, folder, start], local);
      const commit = await run(['rev-parse', 'HEAD'], folder);
      signal?.throwIfAborted();
      return { folder, branch, from: 'worktree', commit, note };
    }
    // not here: clone it (the helper's own git credentials; nobody is asked for a password)
    await run([...net, 'clone', '-q', '--', req.remote, folder], base);
    let note = `a new clone of ${req.remote}`;
    const at = req.commit && (await has(folder, req.commit)) ? req.commit : '';
    if (req.commit && !at)
      note += `; the main Mac's commit ${short} is not on the remote, so it starts from the remote's default branch`;
    await run(['checkout', '-q', '-b', branch, ...(at ? [at] : [])], folder);
    const commit = await run(['rev-parse', 'HEAD'], folder);
    signal?.throwIfAborted();
    return { folder, branch, from: 'clone', commit, note };
  } catch (e) {
    if (addedTo) {
      await git(['worktree', 'remove', '--force', folder], { cwd: addedTo }).catch(() => '');
      await git(['worktree', 'prune'], { cwd: addedTo }).catch(() => '');
      await git(['branch', '-D', branch], { cwd: addedTo }).catch(() => '');
    }
    fs.rmSync(base, { recursive: true, force: true });
    throw e;
  }
}

/** The first lines the new session gets: where it is and how its code came, then the request. */
export function sessionMessage(p: Prepared, req: PeerNewRequest, from: string): string {
  const lines = [
    p.from === 'scratch'
      ? `[Thoth] This session was started from ${from || 'the main Mac'} on this computer, in ${p.start} (${p.note}).`
      : `[Thoth] This session was started from ${from || 'the main Mac'} on this computer, in ${p.start}, branch ${p.branch} (${p.note}). Commit your work on this branch.`,
  ];
  if (req.dirty > 0 && p.from !== 'bundle' && p.from !== 'scratch')
    lines.push(
      `The main Mac had uncommitted changes in ${String(req.dirty)} file(s) there; they are not in this folder.`,
    );
  return req.text ? `${lines.join(' ')}\n\n${req.text}` : '';
}

// ------------------------------------------------------------------- jobs ----
// POST /api/new with a device answers at once. The work (on the main Mac: the brief and the bundle;
// on the helper: the folder) runs as a job, shown as a row in the "preparing" state; a failure stays
// as a "failed" row with the error. The request id is the job's key: the same id never starts a
// second job. Closing the row cancels the job (its git processes stop; the folder goes).
export type JobState = 'preparing' | 'failed' | 'done' | 'cancelled';
export interface Job {
  requestId: string;
  name: string;
  agent: string;
  state: JobState;
  error: string;
  /** the window id of the session the job started ('' until done) */
  windowId: string;
  at: number;
  abort: AbortController;
}
export interface Jobs {
  get: (requestId: string) => Job | undefined;
  /** Starts `work` for a new request id; an id seen before returns its job and starts nothing. */
  start: (
    requestId: string,
    info: { name: string; agent: string },
    work: (signal: AbortSignal) => Promise<string>,
  ) => { job: Job; fresh: boolean };
  /** Closes a preparing or failed row: true when there was one. */
  cancel: (requestId: string) => boolean;
  /** The rows to show: the jobs still preparing and the failed ones. */
  rows: () => Job[];
  /** The request id of the session in window `windowId`, or ''. */
  requestOf: (windowId: string) => string;
  /** Puts back a job saved before a server restart (no work runs); an id already here is kept. */
  restore: (job: Omit<Job, 'abort'>) => void;
}

const MAX_JOBS = 200;

export function createJobs(onChange: () => void = () => undefined): Jobs {
  const jobs = new Map<string, Job>();
  return {
    get: (id) => jobs.get(id),
    start(requestId, info, work) {
      if (!REQUEST_ID.test(requestId)) throw new Error('Bad request id');
      const old = jobs.get(requestId);
      if (old) return { job: old, fresh: false };
      const job: Job = {
        requestId,
        name: info.name,
        agent: info.agent,
        state: 'preparing',
        error: '',
        windowId: '',
        at: Date.now(),
        abort: new AbortController(),
      };
      jobs.set(requestId, job);
      // the oldest finished ones go (a cancelled or done id is kept a while, so a retry starts nothing)
      for (const [k, j] of jobs) {
        if (jobs.size <= MAX_JOBS) break;
        if (j.state !== 'preparing') jobs.delete(k);
      }
      void work(job.abort.signal).then(
        (windowId) => {
          if (job.abort.signal.aborted) return;
          job.state = 'done';
          job.windowId = windowId;
          onChange();
        },
        (e: unknown) => {
          if (job.abort.signal.aborted) return;
          job.state = 'failed';
          job.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
          onChange();
        },
      );
      onChange();
      return { job, fresh: true };
    },
    cancel(requestId) {
      const job = jobs.get(requestId);
      if (!job || (job.state !== 'preparing' && job.state !== 'failed')) return false;
      job.state = 'cancelled';
      job.abort.abort();
      onChange();
      return true;
    },
    rows: () => [...jobs.values()].filter((j) => j.state === 'preparing' || j.state === 'failed'),
    requestOf: (windowId) =>
      [...jobs.values()].find((j) => j.state === 'done' && j.windowId === windowId)?.requestId ?? '',
    restore(saved) {
      if (!REQUEST_ID.test(saved.requestId) || jobs.has(saved.requestId)) return;
      jobs.set(saved.requestId, { ...saved, abort: new AbortController() });
    },
  };
}

// ------------------------------------------------- saved across a restart ----
// The main Mac keeps its jobs for helpers in <Thoth home>/remote-new-jobs.json (0600), written on
// every change: a failed row comes back as it was, and a done or cancelled id still starts nothing.
// The work of a row that was preparing stopped with the old process: it comes back as failed, unless
// the helper's state shows the request (then the helper's row is shown, as before the restart).
export interface SavedJob {
  requestId: string;
  /** the helper the request goes to */
  device: string;
  name: string;
  agent: string;
  state: JobState;
  error: string;
  windowId: string;
  at: number;
  /** the helper's state has shown the request */
  seen: boolean;
}

/** The error of a row that was preparing when the server stopped. */
export const restartedError = (device: string): string =>
  `Thoth restarted before the session started on ${device}; close this row and start it again`;

/** The main Mac's jobs to save, in the order the requests were made. */
export function pendingList(jobs: Jobs, device: ReadonlyMap<string, string>, seen: ReadonlySet<string>): SavedJob[] {
  const out: SavedJob[] = [];
  for (const [requestId, d] of device) {
    const j = jobs.get(requestId);
    if (!j) continue;
    const { name, agent, state, error, windowId, at } = j;
    out.push({ requestId, device: d, name, agent, state, error, windowId, at, seen: seen.has(requestId) });
  }
  return out.slice(-MAX_JOBS);
}

export function savePending(file: string, list: readonly SavedJob[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const STATES: readonly string[] = ['preparing', 'failed', 'done', 'cancelled'];

/** The saved jobs, checked; a job that was preparing is failed now (its work stopped with the old
 * process). A missing or broken file is no jobs. */
export function loadPending(file: string): SavedJob[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SavedJob[] = [];
  for (const v of raw.slice(-MAX_JOBS) as unknown[]) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    const requestId = str(o['requestId']),
      device = str(o['device']),
      state = str(o['state']);
    if (!REQUEST_ID.test(requestId) || !device || !STATES.includes(state)) continue;
    const at = Number(o['at']);
    const was = state as JobState;
    out.push({
      requestId,
      device,
      name: str(o['name']).slice(0, 30),
      agent: str(o['agent']) || 'claude',
      state: was === 'preparing' ? 'failed' : was,
      error: was === 'preparing' ? restartedError(device) : str(o['error']).slice(0, 500),
      windowId: str(o['windowId']),
      at: Number.isFinite(at) ? at : 0,
      seen: o['seen'] === true,
    });
  }
  return out;
}

/** Main Mac: whether closing a row is done here (true) or passed on to the helper (false). The
 * helper has the request when its state showed it, or when it accepted it (the job could not be
 * cancelled here because it is done). */
export const closedHere = (o: { cancelled: boolean; seen: boolean }): boolean => o.cancelled && !o.seen;

/** The id of a preparing row: `p-<request id>` (a session's id is `@<n>`). */
export const rowId = (requestId: string): string => `p-${requestId}`;
export const requestOfRow = (id: string): string => /^p-([\da-f]{16})$/.exec(id)?.[1] ?? '';

/** A job as a row of the state message (the fields the apps read). */
export function jobRow(j: Job, folder = ''): { id: string; [key: string]: unknown } {
  return {
    id: rowId(j.requestId),
    index: 0,
    name: j.name,
    folder,
    sid: '',
    running: false,
    state: j.state,
    last: j.error,
    options: [],
    question: '',
    branch: '',
    activity: j.at,
    agent: j.agent,
  };
}

// ------------------------------------------------------------------ route ----
/** Where POST /api/new goes: this Mac, or a helper. Only this Mac's own app or page may start a
 * session on a helper (never a remote client or a page through the relay); the helper must be known and
 * online. Throws with the message the caller shows. */
export function routeNew(o: {
  device: string;
  localDevice: string;
  fromThisMac: boolean;
  viaRemote: boolean;
  peer: { online: boolean } | undefined;
}): 'local' | 'helper' {
  if (!o.device || o.device === o.localDevice) return 'local';
  if (o.viaRemote || !o.fromThisMac)
    throw new Error('A session on another computer can be started only from this Mac’s own Thoth');
  if (!o.peer) throw new Error(`${o.device} is not one of your helper computers`);
  if (!o.peer.online) throw new Error(`${o.device} does not answer now (asleep, off, or no network)`);
  return 'helper';
}

// A helper keeps the request id of each session a request started in <home>/remote-requests.json
// (window id -> request id and folder), so the id survives a server restart (an update, a crash). The
// main Mac uses it to find the repo the session came from ("Fetch result", lib/fetch_result.ts).
const MAX_SAVED = 200;
export type Saved = Record<string, { request: string; folder: string }>;
export function loadSaved(file: string): Saved {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (j === null || typeof j !== 'object' || Array.isArray(j)) return {};
    const out: Saved = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      const o = v as { request?: unknown; folder?: unknown } | null;
      if (
        /^@\d{1,6}$/.test(k) &&
        typeof o?.request === 'string' &&
        REQUEST_ID.test(o.request) &&
        typeof o.folder === 'string'
      )
        out[k] = { request: o.request, folder: o.folder };
    }
    return out;
  } catch {
    return {};
  }
}
export function saveRequest(file: string, windowId: string, requestId: string, folder: string): void {
  if (!/^@\d{1,6}$/.test(windowId) || !REQUEST_ID.test(requestId) || !path.isAbsolute(folder)) return;
  const all = loadSaved(file);
  Reflect.deleteProperty(all, windowId);
  all[windowId] = { request: requestId, folder };
  const keep = Object.fromEntries(Object.entries(all).slice(-MAX_SAVED));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keep) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
/** The saved request id of window `windowId`, when its folder is still the session's folder (a window
 * id that tmux gave again to another session does not match); '' otherwise. */
export function savedRequest(file: string | Saved, windowId: string, folder: string): string {
  const s = (typeof file === 'string' ? loadSaved(file) : file)[windowId];
  return s && (folder === s.folder || folder.startsWith(s.folder + path.sep)) ? s.request : '';
}

/** What a router start on a helper sends: `folder` (a folder on this Mac: its code when it is in a
 * git repository, else an empty folder there; '' = no project), `remote` (a project only on the
 * helper: its git remote from the helper's project list, so the helper uses its own checkout), or
 * `fallback` (no remote to send: the session starts on this Mac and the note says why). */
export type RoutedCode = { folder: string } | { remote: string } | { fallback: string };

/** The code for the router's `project` (the folder it chose; '' = none). The default folder is not a
 * project the router chose: an empty folder there. A folder here outside a git project cannot travel:
 * the helper gets an empty folder only when the user named it (`named`), else the session stays here.
 * `helperRemote`: the git remote of `project` in a helper's project list ('' = none). */
export function routedCode(o: {
  project: string;
  defaultFolder: string;
  isDir: (folder: string) => boolean;
  isGit: (folder: string) => boolean;
  named: boolean;
  helperRemote: string;
  device: string;
}): RoutedCode {
  if (!o.project || o.project === o.defaultFolder) return { folder: '' };
  const name = path.basename(o.project);
  if (o.isDir(o.project)) {
    if (o.isGit(o.project) || o.named) return { folder: o.project };
    return { fallback: `${name} is not a git project, so its files stay on this Mac and the session starts here.` };
  }
  const remote = sendableRemote(o.helperRemote);
  if (remote) return { remote };
  return { fallback: `${name} on ${o.device} has no git remote this panel can send, so it starts on this Mac.` };
}

/** Where the router's "new" decision starts: on the helper the device rules chose (`device`) when
 * this panel has it online (`remote`: startRemoteNew, a preparing row at once), else on this Mac
 * (`local`) with a note that says why. `ownApp`: the request came from this Mac's own app or page
 * (the same rule as POST /api/new with a device: routeNew), never a remote client or a page through the relay. */
export async function startRouted(o: {
  device: string;
  peer: { online: boolean } | undefined;
  ownApp: boolean;
  code: RoutedCode;
  remote: (code: { folder: string } | { remote: string }) => { id: string; requestId: string };
  /** this Mac; `note` says why a chosen helper did not get it ('' = no helper was chosen) */
  local: (note: string) => Promise<void>;
}): Promise<{ where: 'helper' | 'local'; id: string; note: string }> {
  const { device, peer, code } = o;
  let note = '';
  if (!device) {
    /* no helper chosen: this Mac, no note */
  } else if (!o.ownApp)
    note = `A session on ${device} can be started only from this Mac’s own Thoth, so it starts on this Mac.`;
  else if (!peer) note = `${device} is not connected to this panel, so it starts on this Mac.`;
  else if (!peer.online) note = `${device} does not answer now, so it starts on this Mac.`;
  else if ('fallback' in code) note = code.fallback;
  else return { where: 'helper', id: o.remote(code).id, note: '' };
  await o.local(note);
  return { where: 'local', id: '', note };
}

/** The route record of a router start on a helper: the preparing row is the target; no folder here. */
export const sentPatch = (
  id: string,
  name: string,
): { status: 'sent'; folder: ''; target: string; targetName: string } => ({
  status: 'sent',
  folder: '',
  target: id,
  targetName: name,
});

/** The request for a session the router started on a helper. The request often names the computer
 * and asks for a session ("open a session on X to …"); without this line, Claude on X tried to start
 * yet another session instead of doing the task (staged test, 2026-11-19). */
export const routedText = (device: string, text: string): string =>
  text
    ? `[Thoth] The request below asked for a session on ${device}. This session is that session: do the task here. Do not start another session.\n\n${text}`
    : '';
