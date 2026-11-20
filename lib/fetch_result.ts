// Fetch result (multi-device plan, PR 7): the main Mac takes back the work a helper session did.
// Everything goes through the peer channel of lib/peer.ts (cloud relay, TLS pinned, pairing token
// and the peer secret); no LAN path, no SSH.
//
//   main Mac                                                helper Mac
//   fetchResult {id} ── answers at once with a fetch id
//   job: POST /api/peerFetchInfo {win} ────────────────────▶ head, branch, remote, root commits (fast)
//        the matching local repo (remote, else root commit); the main checkout, not a worktree
//        head already here? → only the branch is made
//        POST /api/peerFetch {fetchId, win, have} ─────────▶ answers at once; a job makes the bundle
//        GET  /api/peerFetch?fetchId (every second) ───────▶ making | ready | failed
//        GET  /api/peerFetchData?fetchId ──────────────────▶ the bundle (thin: without what we have)
//        git fetch <bundle> into a private ref, then the branch helper/<device>/<name>
//        POST /api/peerFetchDone {fetchId} ────────────────▶ the bundle file goes
//
// - The helper only reads its checkouts (git bundle create); it writes nothing in them.
// - The main Mac never changes the current branch, the index or the working tree: the bundle goes to
//   a private ref (refs/thoth/fetch/<id>, deleted after), and the branch is set with update-ref (only
//   new, or a fast-forward of a branch that is not checked out anywhere).
// - No time limits: each step stops when the user cancels (AbortSignal); the same fetch id never starts
//   a second fetch.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Project } from './heartbeat.ts';
import { git, gitEnv, normRemote, sendableRemote } from './remote_new.ts';

/** The largest bundle (bytes) that comes back through the relay. */
export const MAX_BUNDLE = 20 * 1024 * 1024;
/** How many commits of the main repo the helper may leave out of the bundle. */
export const MAX_HAVE = 200;
const SHA = /^[\da-f]{40}$/;
export const FETCH_ID = /^[\da-f]{16}$/;
export const newFetchId = (): string => crypto.randomBytes(8).toString('hex');
const WIN = /^@\d{1,6}$/;
// the fetch from a helper's bundle: no gc or maintenance in the user's repository, and git checks
// every object it takes in (a rogue helper cannot slip in malformed objects); set through the
// environment, so an error names the git command
const FETCH_CONFIG = { 'gc.auto': '0', 'maintenance.auto': 'false', 'transfer.fsckObjects': 'true' };
const fetchEnv = (): NodeJS.ProcessEnv => {
  const e = Object.entries(FETCH_CONFIG);
  return gitEnv({
    GIT_CONFIG_COUNT: String(e.length),
    ...Object.fromEntries(
      e.flatMap(([k, v], i) => [
        [`GIT_CONFIG_KEY_${String(i)}`, k],
        [`GIT_CONFIG_VALUE_${String(i)}`, v],
      ]),
    ),
  });
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

// ----------------------------------------------------------- helper side ----
export interface RepoInfo {
  /** the commit the session's folder is at */
  head: string;
  /** its branch ('' = detached HEAD) */
  branch: string;
  /** the remote as the main Mac may compare it ('' = none) */
  remote: string;
  /** the root commits of HEAD (how a repo without a remote is matched) */
  roots: string[];
  /** changed files that are not committed (they are not fetched) */
  dirty: number;
}

/** The session's repository on the helper, read only. Throws a message the main panel shows. */
export async function repoInfo(folder: string, signal?: AbortSignal): Promise<RepoInfo> {
  const o = { cwd: folder, signal };
  const root = await git(['rev-parse', '--show-toplevel'], o).catch(() => '');
  if (!root) throw new Error('The session’s folder is not a git repository');
  const r = { cwd: root, signal };
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], r).catch(() => '');
  if (!SHA.test(head)) throw new Error('The session’s repository has no commit yet');
  const branch = await git(['branch', '--show-current'], r).catch(() => '');
  const remotes = (await git(['remote'], r).catch(() => '')).split('\n').filter(Boolean);
  const name = remotes.includes('origin') ? 'origin' : (remotes[0] ?? '');
  const remote = name ? sendableRemote(await git(['remote', 'get-url', name], r).catch(() => '')) : '';
  const roots = (await git(['rev-list', '--max-parents=0', 'HEAD'], r).catch(() => ''))
    .split('\n')
    .filter((x) => SHA.test(x))
    .slice(0, 5);
  const status = await git(['status', '--porcelain'], r).catch(() => '');
  return { head, branch, remote, roots, dirty: status ? status.split('\n').length : 0 };
}

export interface FetchRequest {
  fetchId: string;
  win: string;
  have: string[];
}

/** The fields of POST /api/peerFetch, checked. */
export function parseFetchRequest(j: Record<string, unknown>): FetchRequest {
  const fetchId = str(j['fetchId']);
  if (!FETCH_ID.test(fetchId)) throw new Error('Bad fetch id');
  const win = str(j['win']);
  if (!WIN.test(win)) throw new Error('No such session');
  const raw = Array.isArray(j['have']) ? j['have'] : [];
  const have = [...new Set(raw.map(str).filter((x) => SHA.test(x)))].slice(0, MAX_HAVE);
  return { fetchId, win, have };
}

export const parseWin = (v: unknown): string => {
  const w = str(v);
  if (!WIN.test(w)) throw new Error('No such session');
  return w;
};

export interface Made {
  /** the commit in the bundle (the session's HEAD when the bundle was made) */
  head: string;
  branch: string;
  dirty: number;
  /** the bundle's ref ('' = no bundle: the main Mac has the commit already) */
  ref: string;
  size: number;
}

/** The bundle of the session's HEAD in `file`, without the commits the main Mac has (`have`). Only
 * reads the repository. When the main Mac has HEAD already, no file is written (`ref` ''). */
export async function makeBundle(o: {
  folder: string;
  have: readonly string[];
  file: string;
  signal?: AbortSignal | undefined;
}): Promise<Made> {
  const info = await repoInfo(o.folder, o.signal);
  const g = { cwd: o.folder, signal: o.signal };
  const known: string[] = [];
  for (const h of o.have) {
    if (!SHA.test(h)) continue;
    if (h === info.head) return { head: info.head, branch: info.branch, dirty: info.dirty, ref: '', size: 0 };
    const ok = await git(['cat-file', '-e', `${h}^{commit}`], g).then(
      () => true,
      () => false,
    );
    if (ok) known.push(h);
  }
  // a commit the main Mac has that already contains HEAD: nothing to send
  for (const h of known) {
    const contains = await git(['merge-base', '--is-ancestor', info.head, h], g).then(
      () => true,
      () => false,
    );
    if (contains) return { head: info.head, branch: info.branch, dirty: info.dirty, ref: '', size: 0 };
  }
  // always HEAD: any branch name works (the main Mac names the branch itself); the bundle records the
  // commit, so a commit made meanwhile does not change what is sent
  const ref = 'HEAD';
  fs.mkdirSync(path.dirname(o.file), { recursive: true, mode: 0o700 });
  await git(['bundle', 'create', '-q', o.file, ref, ...known.map((h) => `^${h}`)], {
    cwd: o.folder,
    env: gitEnv(),
    signal: o.signal,
  });
  const heads = await git(['bundle', 'list-heads', o.file], g);
  const line = heads.split('\n').find((l) => l.endsWith(` ${ref}`)) ?? '';
  const head = line.slice(0, 40);
  if (!SHA.test(head)) throw new Error('The bundle has no commit');
  const size = fs.statSync(o.file).size;
  if (size > MAX_BUNDLE) {
    fs.rmSync(o.file, { force: true });
    throw new Error(
      `The result is too large to fetch through the relay (${String(Math.round(size / 1e6))} MB, max 20 MB)`,
    );
  }
  return { head, branch: info.branch, dirty: info.dirty, ref, size };
}

// ------------------------------------------------------------- main side ----
/** The local repo that holds the helper's work. First `prefer` (the folder this Mac started the
 * session from), when it shares the history; then a project with the same remote; then one that has
 * a root commit. Each is resolved to its main checkout (not a linked worktree). */
export async function pickRepo(
  projects: readonly Project[],
  info: Pick<RepoInfo, 'remote' | 'roots'>,
  signal?: AbortSignal,
  prefer = '',
): Promise<string | null> {
  const want = info.remote ? normRemote(info.remote) : '';
  const hasRoot = async (dir: string): Promise<boolean> => {
    for (const r of info.roots) {
      if (!SHA.test(r)) continue;
      const ok = await git(['cat-file', '-e', `${r}^{commit}`], { cwd: dir, signal }).then(
        () => true,
        () => false,
      );
      if (ok) return true;
    }
    return false;
  };
  if (prefer) {
    const main = await mainCheckout(prefer, signal);
    if (main !== null && (await hasRoot(main))) return main;
  }
  const byRemote = want ? projects.filter((p) => p.remote !== '' && normRemote(p.remote) === want) : [];
  for (const p of byRemote) {
    const main = await mainCheckout(p.path, signal);
    if (main !== null) return main;
  }
  if (info.roots.length === 0) return null;
  // no remote match: projects without a remote first (a helper copy made from a bundle has none)
  const rest = [...projects.filter((p) => p.remote === ''), ...projects.filter((p) => p.remote !== '')];
  const seen = new Set<string>();
  for (const p of rest) {
    const main = await mainCheckout(p.path, signal);
    if (main === null || seen.has(main)) continue;
    seen.add(main);
    if (await hasRoot(main)) return main;
  }
  return null;
}

// ------------------------------------------------- where sessions came from ----
/** Main Mac: the repo each helper session was started from (request id → repo root), kept in
 * <home>/remote-sources.json (0600), the newest 200. A fetch looks there first. */
const MAX_SOURCES = 200;
export function loadSources(file: string): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (j === null || typeof j !== 'object' || Array.isArray(j)) return {};
    return Object.fromEntries(
      Object.entries(j as Record<string, unknown>).filter(
        (e): e is [string, string] => /^[\da-f]{16}$/.test(e[0]) && typeof e[1] === 'string' && path.isAbsolute(e[1]),
      ),
    );
  } catch {
    return {};
  }
}
export function saveSource(file: string, requestId: string, root: string): void {
  if (!/^[\da-f]{16}$/.test(requestId) || !path.isAbsolute(root)) return;
  const all = loadSources(file);
  Reflect.deleteProperty(all, requestId);
  all[requestId] = root;
  writePrivate(file, Object.fromEntries(Object.entries(all).slice(-MAX_SOURCES)));
}

/** Main Mac: helper session (r:<device>:@<n>) → the repo it was started from and its folder on the
 * helper, kept in <home>/remote-session-sources.json (0600). The helper keeps the window → request
 * id link only in memory: after a helper restart its row has no request id, and this link still
 * finds the source (real test 2026-11-19). */
export interface Link {
  root: string;
  folder: string;
}
const SESSION = /^r:[a-z\d][a-z\d-]{0,30}:@\d{1,6}$/;
/** The source of a request id from a helper row (own keys only: the id comes from the helper). */
const sourceByRequest = (sources: Readonly<Record<string, string>>, request: unknown): string | undefined =>
  typeof request === 'string' && /^[\da-f]{16}$/.test(request) && Object.hasOwn(sources, request)
    ? sources[request]
    : undefined;
function writePrivate(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function loadLinks(file: string): Record<string, Link> {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (j === null || typeof j !== 'object' || Array.isArray(j)) return {};
    const out: Record<string, Link> = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      const l = v as Partial<Link> | null;
      if (!SESSION.test(k) || l === null || typeof l !== 'object') continue;
      if (typeof l.root !== 'string' || typeof l.folder !== 'string') continue;
      if (path.isAbsolute(l.root) && path.isAbsolute(l.folder)) out[k] = { root: l.root, folder: l.folder };
    }
    return out;
  } catch {
    return {};
  }
}
export function saveLinks(file: string, links: Record<string, Link>): void {
  writePrivate(file, Object.fromEntries(Object.entries(links).slice(-MAX_SOURCES)));
}
interface Row {
  id: string;
  folder?: unknown;
  request?: unknown;
}
/** The links with every helper row that names a request id this Mac has a source for; null when
 * nothing changed (nothing to save). */
export function linkSessions(
  links: Readonly<Record<string, Link>>,
  sources: Readonly<Record<string, string>>,
  rows: readonly Row[],
): Record<string, Link> | null {
  let out: Record<string, Link> | null = null;
  for (const r of rows) {
    const root = sourceByRequest(sources, r.request);
    const folder = str(r.folder);
    if (root === undefined || !SESSION.test(r.id) || !path.isAbsolute(folder)) continue;
    const old = links[r.id];
    if (old?.root === root && old.folder === folder) continue;
    out ??= { ...links };
    Reflect.deleteProperty(out, r.id);
    out[r.id] = { root, folder };
  }
  return out;
}
/** The repo this Mac started a helper session from: by its request id, else by the saved link when
 * the session is still in the same folder (a window id the helper reused is another session); ''
 * when this Mac did not start it. */
export function sourceOf(
  sources: Readonly<Record<string, string>>,
  links: Readonly<Record<string, Link>>,
  row: Row,
): string {
  const byRequest = sourceByRequest(sources, row.request);
  if (byRequest !== undefined) return byRequest;
  const l = links[row.id];
  return l !== undefined && l.folder === str(row.folder) ? l.root : '';
}

/** The main working tree of the repository that holds `dir` (a linked worktree resolves to the
 * checkout it was added to); null when it is not a git repository or is bare. */
export async function mainCheckout(dir: string, signal?: AbortSignal): Promise<string | null> {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, signal }).catch(
    () => '',
  );
  if (!common) return null;
  if (path.basename(common) === '.git') {
    const top = path.dirname(common);
    return fs.existsSync(top) ? top : null;
  }
  // a separate git dir (or bare): the folder's own top level
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: dir, signal }).catch(() => '');
  return top || null;
}

/** The commits of `repo` the helper may leave out: its branch and remote tips, newest first. */
export async function haves(repo: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(
    [
      'for-each-ref',
      '--sort=-committerdate',
      `--count=${String(MAX_HAVE)}`,
      '--format=%(objectname)',
      'refs/heads',
      'refs/remotes',
    ],
    { cwd: repo, signal },
  ).catch(() => '');
  return [...new Set(out.split('\n').filter((x) => SHA.test(x)))].slice(0, MAX_HAVE);
}

/** A commit id from the helper: 40 hex characters, else ''. */
export const checkSha = (v: unknown): string => (typeof v === 'string' && SHA.test(v) ? v : '');

/** A bundle ref from the helper: HEAD or refs/heads/<name> (no `..`, `//`, `@{`, `.lock` or option). */
export function validRef(ref: string): boolean {
  if (ref === 'HEAD') return true;
  if (ref.length > 250 || !/^refs\/heads\/[\w][\w./-]*$/.test(ref)) return false;
  return (
    !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.') && !/\.lock(\/|$)/.test(ref)
  );
}

/** Bundle files a fetch left behind (a restart or a main Mac that never came back): removed at start. */
export function cleanBundles(dir: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir))
      if (/^(result|fetch)-[\da-f]{16}\.bundle$/.test(f)) {
        fs.rmSync(path.join(dir, f), { force: true });
        n++;
      }
  } catch {
    /* no folder */
  }
  return n;
}

/** The branch name on the main Mac: helper/<device>/<session name>, in safe characters. A name with
 * no such characters (Chinese, emoji) gets session-<window number>, so two sessions never share one. */
export function branchName(device: string, sessionName: string, win = ''): string {
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .replaceAll(/[^\da-z._-]+/g, '-')
      .replaceAll(/\.{2,}/g, '.')
      .replaceAll(/-{2,}/g, '-')
      .replace(/^[.-]+/, '')
      .replace(/[.-]+$/, '')
      .replace(/\.lock$/, '')
      .slice(0, 40)
      .replace(/[.-]+$/, '');
  const dev = slug(device) || 'helper';
  const n = /^@(\d+)$/.exec(win)?.[1];
  const name = slug(sessionName) || (n === undefined ? 'session' : `session-${n}`);
  return `helper/${dev}/${name}`;
}

export interface Applied {
  branch: string;
  commit: string;
  /** what happened: 'new', 'updated' (fast-forward) or 'same' (already there) */
  how: 'new' | 'updated' | 'same';
}

/** Puts the helper's commit `head` on branch `branch` of `repo` (from `file` when it is a bundle,
 * else the commit is already in the repo). Never changes HEAD, the index or the working tree: the
 * bundle goes to a private ref, the branch is set with update-ref, only when it is new or a
 * fast-forward, and never when it is checked out somewhere. */
export async function applyResult(o: {
  repo: string;
  file: string;
  ref: string;
  head: string;
  branch: string;
  id: string;
  message: string;
  signal?: AbortSignal | undefined;
}): Promise<Applied> {
  if (!SHA.test(o.head)) throw new Error('Bad commit');
  if (!/^[\da-f]{8,32}$/.test(o.id)) throw new Error('bad id');
  if (o.file && !validRef(o.ref)) throw new Error('Bad bundle ref');
  const g = { cwd: o.repo, signal: o.signal };
  const ok = (args: readonly string[]): Promise<boolean> =>
    git(args, g).then(
      () => true,
      () => false,
    );
  if (!(await ok(['check-ref-format', `refs/heads/${o.branch}`]))) throw new Error(`Bad branch name ${o.branch}`);
  const tmp = `refs/thoth/fetch/${o.id}`;
  try {
    if (o.file) {
      // the bundle's commits go to a private ref only; FETCH_HEAD is not written
      await git(
        ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', o.file, `+${o.ref}:${tmp}`],
        {
          cwd: o.repo,
          env: fetchEnv(),
          signal: o.signal,
        },
      ).catch((e: unknown) => {
        throw new Error(`The bundle could not be read here: ${errText(e)}`, { cause: e });
      });
      const got = await git(['rev-parse', '--verify', '-q', tmp], g).catch(() => '');
      if (got !== o.head) throw new Error('The bundle does not hold the commit the helper named');
    } else if (!(await ok(['cat-file', '-e', `${o.head}^{commit}`]))) {
      throw new Error('The commit is not in this repository');
    }
    const full = `refs/heads/${o.branch}`;
    const old = await git(['rev-parse', '--verify', '-q', full], g).catch(() => '');
    if (old === o.head) return { branch: o.branch, commit: o.head, how: 'same' };
    if (old && !(await ok(['merge-base', '--is-ancestor', old, o.head])))
      throw new Error(
        `The branch ${o.branch} already has commits that the helper session does not have: rename or delete it, then fetch again`,
      );
    // also for a new name: a worktree on an unborn branch of that name would change under it
    const wt = await git(['worktree', 'list', '--porcelain'], g).catch(() => '');
    if (wt.split('\n').includes(`branch ${full}`))
      throw new Error(`The branch ${o.branch} is checked out here: switch to another branch, then fetch again`);
    o.signal?.throwIfAborted();
    // old value given: it changes only if nobody moved the branch meanwhile
    await git(['update-ref', '-m', o.message, full, o.head, old || '0'.repeat(40)], { cwd: o.repo });
    return { branch: o.branch, commit: o.head, how: old ? 'updated' : 'new' };
  } finally {
    await git(['update-ref', '-d', tmp], { cwd: o.repo }).catch(() => '');
  }
}

// ------------------------------------------------------------------- jobs ----
/** Main Mac: one fetch per helper session at a time. */
export type FetchState = 'fetching' | 'fetched' | 'failed' | 'cancelled';
export interface FetchJob {
  fetchId: string;
  /** the helper session on this panel: r:<device>:@<n> */
  session: string;
  state: FetchState;
  /** what the job does now, or the result in words */
  step: string;
  error: string;
  branch: string;
  commit: string;
  repo: string;
  /** uncommitted files on the helper (not fetched) */
  dirty: number;
  at: number;
  /** when it ended (0 while it runs) */
  ended: number;
  abort: AbortController;
}
export interface FetchResult {
  branch: string;
  commit: string;
  repo: string;
  dirty: number;
  how: Applied['how'];
}
export interface FetchJobs {
  get: (fetchId: string) => FetchJob | undefined;
  /** Starts a fetch for `session`; the same fetch id, or a fetch of that session still running,
   * returns that job and starts nothing. */
  start: (
    fetchId: string,
    session: string,
    work: (signal: AbortSignal, step: (text: string) => void) => Promise<FetchResult>,
  ) => { job: FetchJob; fresh: boolean };
  /** Stops a running fetch: true when there was one. */
  cancel: (fetchId: string) => boolean;
  /** The newest fetch of a session for its row: running, or ended less than SHOW_MS ago (not
   * cancelled). An old result goes from the row by itself. */
  latest: (session: string, now?: number) => FetchJob | undefined;
}

const MAX_FETCH_JOBS = 100;
/** How long a finished fetch stays in its row (the branch stays in git). */
export const SHOW_MS = 10 * 60_000;

export function createFetchJobs(onChange: () => void = () => undefined): FetchJobs {
  const jobs = new Map<string, FetchJob>();
  const running = (session: string): FetchJob | undefined =>
    [...jobs.values()].find((j) => j.session === session && j.state === 'fetching');
  return {
    get: (id) => jobs.get(id),
    start(fetchId, session, work) {
      if (!FETCH_ID.test(fetchId)) throw new Error('Bad fetch id');
      const old = jobs.get(fetchId);
      if (old) {
        if (old.session !== session) throw new Error('This fetch id was used for another session');
        return { job: old, fresh: false };
      }
      const busy = running(session);
      if (busy) return { job: busy, fresh: false };
      const job: FetchJob = {
        fetchId,
        session,
        state: 'fetching',
        step: 'Asking the helper',
        error: '',
        branch: '',
        commit: '',
        repo: '',
        dirty: 0,
        at: Date.now(),
        ended: 0,
        abort: new AbortController(),
      };
      jobs.set(fetchId, job);
      for (const [k, j] of jobs) {
        if (jobs.size <= MAX_FETCH_JOBS) break;
        if (j.state !== 'fetching') jobs.delete(k);
      }
      const step = (text: string): void => {
        if (job.state !== 'fetching' || job.step === text) return;
        job.step = text;
        onChange();
      };
      void work(job.abort.signal, step).then(
        (r) => {
          // the branch was set (update-ref does not stop): shown even when the cancel came too late
          const late = job.abort.signal.aborted;
          Object.assign(job, { state: 'fetched', branch: r.branch, commit: r.commit, repo: r.repo, dirty: r.dirty });
          job.step = r.how === 'same' ? 'Already up to date' : r.how === 'updated' ? 'Branch updated' : 'Branch added';
          if (late) job.step += ' (the cancel came too late)';
          job.ended = Date.now();
          onChange();
        },
        (e: unknown) => {
          if (job.abort.signal.aborted) return;
          job.ended = Date.now();
          job.state = 'failed';
          job.error = errText(e);
          onChange();
        },
      );
      onChange();
      return { job, fresh: true };
    },
    cancel(fetchId) {
      const job = jobs.get(fetchId);
      if (job?.state !== 'fetching') return false;
      job.state = 'cancelled';
      job.ended = Date.now();
      job.abort.abort();
      onChange();
      return true;
    },
    // the newest by start order (the map keeps insertion order; two may start in the same ms)
    latest: (session, now = Date.now()) =>
      [...jobs.values()]
        .filter((x) => x.session === session && x.state !== 'cancelled' && (x.ended === 0 || now - x.ended < SHOW_MS))
        .at(-1),
  };
}

/** A fetch as the `fetch` field of a session row (the apps read it). */
export function fetchView(j: FetchJob): Record<string, unknown> {
  return {
    id: j.fetchId,
    state: j.state,
    step: j.step,
    error: j.error,
    branch: j.branch,
    commit: j.commit.slice(0, 12),
    repo: j.repo,
    dirty: j.dirty,
  };
}

/** Helper: the bundles it made, until the main Mac took them (or cancelled). */
export type MakeState = 'making' | 'ready' | 'failed';
export interface MakeJob {
  fetchId: string;
  state: MakeState;
  error: string;
  file: string;
  made: Made | null;
  at: number;
  abort: AbortController;
}
export interface MakeJobs {
  get: (fetchId: string) => MakeJob | undefined;
  start: (fetchId: string, file: string, work: (signal: AbortSignal) => Promise<Made>) => MakeJob;
  /** The main Mac took the bundle or cancelled: the job stops and its file goes. */
  done: (fetchId: string) => boolean;
}

const MAX_MAKE_JOBS = 20;

export function createMakeJobs(): MakeJobs {
  const jobs = new Map<string, MakeJob>();
  const drop = (j: MakeJob): void => {
    j.abort.abort();
    fs.rmSync(j.file, { force: true });
    jobs.delete(j.fetchId);
  };
  return {
    get: (id) => jobs.get(id),
    start(fetchId, file, work) {
      if (!FETCH_ID.test(fetchId)) throw new Error('Bad fetch id');
      const old = jobs.get(fetchId);
      if (old) return old;
      // a main Mac that never came back: the oldest bundles go
      for (const j of [...jobs.values()].toSorted((a, b) => a.at - b.at)) {
        if (jobs.size < MAX_MAKE_JOBS) break;
        drop(j);
      }
      const job: MakeJob = {
        fetchId,
        state: 'making',
        error: '',
        file,
        made: null,
        at: Date.now(),
        abort: new AbortController(),
      };
      jobs.set(fetchId, job);
      void work(job.abort.signal).then(
        (m) => {
          if (job.abort.signal.aborted) return;
          job.made = m;
          job.state = 'ready';
        },
        (e: unknown) => {
          fs.rmSync(file, { force: true });
          if (job.abort.signal.aborted) return;
          job.state = 'failed';
          job.error = errText(e);
        },
      );
      return job;
    },
    done(fetchId) {
      const j = jobs.get(fetchId);
      if (!j) return false;
      drop(j);
      return true;
    },
  };
}

/** The answer of GET /api/peerFetch for a job. */
export function makeView(j: MakeJob | undefined): Record<string, unknown> {
  if (!j) return { state: 'missing' };
  return {
    state: j.state,
    error: j.error,
    head: j.made?.head ?? '',
    branch: j.made?.branch ?? '',
    dirty: j.made?.dirty ?? 0,
    ref: j.made?.ref ?? '',
    size: j.made?.size ?? 0,
  };
}

/** A wait that the user's cancel ends at once (between two status reads of the helper). */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Where a fetch may run: only from this Mac's own app or page, for a helper's session. */
export function mayFetch(o: { fromThisMac: boolean; viaRemote: boolean; session: string }): void {
  if (o.viaRemote || !o.fromThisMac) throw new Error('A result can be fetched only from this Mac’s own Thoth');
  if (!/^r:[a-z\d][a-z\d-]{0,30}:@\d+$/.test(o.session))
    throw new Error('Only a session on another computer has a result to fetch');
}
