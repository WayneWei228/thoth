// thoth server: a mouse-friendly web UI over a tmux session ("cc") that holds
// Claude Code sessions. tmux keeps sessions alive; this server only watches and
// controls them. Binds to 127.0.0.1 only.
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import pty from 'node-pty';
import { WebSocketServer, type WebSocket } from 'ws';

import * as Attachments from './lib/attachments.ts';
import * as Brief from './lib/brief.ts';
import * as Commands from './lib/commands.ts';
import { TranscriptFile, ChatRevisions, wasSent, wasSentFile, pendingEchoes } from './lib/chat.ts';
import { claudeArgs, stateHooks } from './lib/claude_args.ts';
import * as Codex from './lib/codex.ts';
import * as Copies from './lib/copies.ts';
import * as Devices from './lib/devices.ts';
import { readRecords, outsideHolders, paneSessions, paneRunning, isBlocked, migrationPlan } from './lib/elsewhere.ts';
import * as Firewall from './lib/firewall.ts';
import { highlight } from './lib/highlight.ts';
import * as Heartbeat from './lib/heartbeat.ts';
import * as HookState from './lib/hookstate.ts';
import { instance as makeInstance, guardedFolder } from './lib/instance.ts';
import * as Media from './lib/media.ts';
import * as Pairing from './lib/pairing.ts';
import * as Peer from './lib/peer.ts';
import * as Permissions from './lib/permissions.ts';
import * as PermNeed from './lib/permneed.ts';
import * as RelayConfig from './lib/relay_client.ts';
import * as Remote from './lib/remote.ts';
import { createRemoteListeners } from './lib/remote_listen.ts';
import * as Restore from './lib/restore.ts';
import * as router from './lib/router.ts';
import { parseScreen, ANSI, inputBoxText, type MenuOption } from './lib/screen.ts';
import * as Setup from './lib/setup.ts';
import * as SetupFix from './lib/setup_fix.ts';
import * as SetupOutside from './lib/setup_outside.ts';
import * as Thumb from './lib/thumb.ts';
import * as Tidy from './lib/tidy.ts';

const ROOT = import.meta.dirname;
const env = (name: string): string => process.env[name] ?? '';
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errCode = (e: unknown): unknown => (e instanceof Error && 'code' in e ? e.code : undefined);
/** A JSON value as an object whose fields can be read, or null. */
type Json = Record<string, unknown>;
const truthy = (v: unknown): boolean => Boolean(v);
/** A non-empty string (strict-boolean-expressions: '' and null/undefined handled in one place). */
const has = (v: string | null | undefined): v is string => v !== undefined && v !== null && v !== '';
/** An error's stack (for the log), else the value itself. */
const errStack = (e: unknown): unknown => (e instanceof Error && has(e.stack) ? e.stack : e);
/** A request field that must be text: the string, or null. */
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asObj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
/** A request field as text: strings as they are, numbers as digits, anything else ''. */
const asText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
};
/** An action error: `status` is informational, `extra` goes to the client as `problem`. */
interface ActionError extends Error {
  status?: number;
  extra?: unknown;
}
const fail = (message: string, status = 400, extra?: unknown): ActionError =>
  Object.assign(new Error(message), { status, ...(extra === undefined ? {} : { extra }) });

const INST = makeInstance();
type Agent = 'claude' | 'codex';
const AGENTS = new Set(['claude', 'codex']);
const agentOf = (a: unknown): Agent => (a === 'codex' ? 'codex' : 'claude');
const PORT = INST.port;
const BRAIN_PORT = Number(env('CC_BRAIN_PORT') || 7879);
const HOST = '127.0.0.1';
const S = 'cc';
const HOME = os.homedir();
// This computer's name for people (the phone shows it; the state message carries it with HOME).
// macOS: the name in System Settings, read once and not waited for; until then, and on other
// systems, the host name. CC_PANEL_COMPUTER_NAME wins (tests and evals).
let COMPUTER = env('CC_PANEL_COMPUTER_NAME').trim() || os.hostname().replace(/\.local$/, '');
if (!env('CC_PANEL_COMPUTER_NAME').trim() && process.platform === 'darwin') {
  execFile('scutil', ['--get', 'ComputerName'], { timeout: 3000 }, (err, out) => {
    const n = out.trim();
    if (!err && n) COMPUTER = n;
  });
}
const PROJECTS = path.join(HOME, '.claude', 'projects');
const CONF = path.join(INST.home, 'sessions.conf');
const PUBLIC = path.join(ROOT, 'public');
const ORIGINS = new Set([`http://${HOST}:${String(PORT)}`, `http://localhost:${String(PORT)}`]);

// ---------- helpers ----------
function tmux(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tmux', [...INST.tmuxArgs, ...args], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      resolve(err ? null : out);
    });
  });
}
function tmuxSync(args: string[]): string | null {
  try {
    return execFileSync('tmux', [...INST.tmuxArgs, ...args], { encoding: 'utf8' });
  } catch {
    return null;
  }
}
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
/** poll() again in `ms` (after an action, a hook event, a choice). */
function pollSoon(ms: number): void {
  setTimeout(() => {
    void poll();
  }, ms);
}
// Claude Code names a project folder after the folder's real path (symlinks
// resolved, e.g. /var -> /private/var), so resolve before building the slug.
const slugOf = (folder: string): string => {
  let real = folder;
  try {
    real = fs.realpathSync(folder);
  } catch {
    /* folder gone: use as given */
  }
  return real.replace(/[^A-Za-z0-9]/g, '-');
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', '-zsh', 'login']);

// ---------- bootstrap tmux session ----------
async function waitForPrompt(target: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const t = await tmux(['capture-pane', '-p', '-t', target]);
    if (has(t?.trim())) return;
    await sleep(200);
  }
}

interface NewWindow {
  name: string;
  folder: string;
  sid?: string;
  run?: boolean;
  mcp?: string;
  agent?: string;
}
async function createWindow({
  name,
  folder,
  sid = '',
  run = true,
  mcp = '',
  agent: agentIn = 'claude',
}: NewWindow): Promise<string> {
  const agent = agentOf(agentIn);
  // One tmux command list: the window never exists without its options. (Separate set-option
  // calls let a poll see a Codex window without @agent and treat it as Claude: a flaky user
  // journey under load, 2026-11-10.) A unique temporary name targets it inside the list.
  const tmp = `cc-new-${String(process.pid)}-${crypto.randomBytes(4).toString('hex')}`;
  const t = `${S}:=${tmp}`;
  const opts: [string, string][] = [
    ['@folder', folder],
    ['@label', name],
    ['@created', String(Math.floor(Date.now() / 1000))],
    ...(sid ? [['@sid', sid] as [string, string]] : []),
    ...(mcp === 'brain' ? [['@mcp', 'brain'] as [string, string]] : []),
    ...(agent === 'codex' ? [['@agent', 'codex'] as [string, string]] : []),
  ];
  const out = await tmux([
    'new-window',
    '-d',
    '-P',
    '-F',
    '#{window_id}',
    '-t',
    `${S}:`,
    '-n',
    tmp,
    '-c',
    folder,
    ...opts.flatMap(([k, v]) => [';', 'set-option', '-w', '-t', t, k, v]),
    ';',
    'rename-window',
    '-t',
    t,
    name,
  ]);
  if (!has(out)) throw new Error('tmux new-window failed');
  const id = out.trim();
  await waitForPrompt(id);
  await tmux(['send-keys', '-t', id, 'C-l']);
  if (run) {
    // the delivery queue must not start Claude a second time while this one boots
    starting.add(id);
    setTimeout(() => starting.delete(id), 30000);
    await startAgent(id, sid, agent);
  }
  return id;
}

// Every session the panel starts gets the central brain (architecture):
// the brain MCP tools and a UserPromptSubmit hook that sends each prompt through the brain
// first, so the brain can add context. Passed with --mcp-config / --settings: the user's
// own Claude config is not changed. Files are written by `brain.py session-files`.
const BRAIN_DIR = env('CC_BRAIN_DIR') || path.join(HOME, '.config', 'cc-brain');
const brainToken = (): string => {
  try {
    return fs.readFileSync(path.join(BRAIN_DIR, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
};
function brainSessionFiles(): { mcp: string; settings: string } | null {
  // the brain's session files (MCP tools + prompt hook), or null
  try {
    execFileSync('python3', ['-I', path.join(ROOT, 'brain', 'brain.py'), 'session-files'], {
      stdio: 'ignore',
      timeout: 10000,
    });
    return { mcp: path.join(BRAIN_DIR, 'session-mcp.json'), settings: path.join(BRAIN_DIR, 'session-settings.json') };
  } catch {
    return null;
  }
}

async function startClaude(id: string, sid: string): Promise<void> {
  // brain files when the brain is in use; a test instance also turns Remote Control off (lib/claude_args.ts)
  // + the state hooks (lib/hookstate.ts): Claude reports its state to /api/hook (CC_PANEL_NO_HOOKS turns them off)
  const extra = claudeArgs(
    env('CC_PANEL_NO_BRAIN') ? null : brainSessionFiles(),
    INST,
    env('CC_PANEL_NO_HOOKS') ? null : stateHooks(PORT),
  );
  const cmd = (sid ? `claude --resume ${sid}` : 'claude') + extra;
  await tmux(['send-keys', '-t', id, 'C-u']);
  await tmux(['send-keys', '-t', id, '-l', '--', cmd]);
  await tmux(['send-keys', '-t', id, 'Enter']);
}

// Codex in a panel window (lib/codex.ts): the brain's MCP tools and prompt hook are
// passed with -c (the user's ~/.codex/config.toml is not changed). @started tells poll() from when
// to look for the session's record (Codex writes it with the first message).
async function startCodex(id: string, sid: string): Promise<void> {
  const brain = env('CC_PANEL_NO_BRAIN') ? null : brainSessionFiles();
  await tmux(['set-option', '-w', '-t', id, '@started', String(Date.now())]);
  await tmux(['send-keys', '-t', id, 'C-u']);
  const hooks = env('CC_PANEL_NO_HOOKS') ? null : stateHooks(PORT, Codex.STATE_EVENTS);
  await tmux(['send-keys', '-t', id, '-l', '--', Codex.command(isUuid(sid) ? sid : '', brain, hooks)]);
  await tmux(['send-keys', '-t', id, 'Enter']);
}
function startAgent(id: string, sid: string, agent: unknown): Promise<void> {
  return agentOf(agent) === 'codex' ? startCodex(id, sid) : startClaude(id, sid);
}

// After a restart of the Mac (no tmux session yet): build the windows again and resume the
// sessions that were running before (lib/restore.ts). Until that is done, poll does not write
// windows.json, so a half-built list cannot replace the saved one.
//
// The tmux session option @restored marks a finished restore. A session without it was built by
// a restore that was cut off (the server was killed half-way, 2026-11-17 19:32: the next server
// found the session with only its first window, skipped the restore and saved that one window
// over windows.json). Such a session gets the missing windows on the next start. When tmux dies
// while the server runs, poll calls this again and the windows come back.
const WINDOWS_FILE = path.join(INST.home, 'windows.json');
const lastRun = new Map<string, number>(); // window id -> last time an agent ran in it
let restoring = false;
let restored = false; // the tmux session holds every saved window: poll may write windows.json
function ensureSession(): void {
  if (restoring) return;
  let fresh = false;
  let home = ''; // the shell window tmux needs to create the session; closed once a saved window exists
  if (tmuxSync(['has-session', '-t', S]) === null) {
    restored = false;
    const made = tmuxSync(['new-session', '-d', '-P', '-F', '#{window_id}', '-s', S, '-n', 'home', '-c', HOME]);
    if (made === null) return; // no tmux: try at the next poll
    home = made.trim();
    fresh = true;
  } else if ((tmuxSync(['show-options', '-qv', '-t', S, '@restored']) ?? '').trim() === '1') {
    restored = true;
    return;
  }
  const saved = Restore.load(WINDOWS_FILE);
  let conf = '';
  try {
    conf = fs.readFileSync(CONF, 'utf8');
  } catch {
    /* none */
  }
  restoring = true;
  void (async () => {
    try {
      await scanElsewhere(); // a session open in VS Code or a terminal is not started a second time
      let windows = Restore.plan(saved as Parameters<typeof Restore.plan>[0], conf, (sid) => elsewhere.has(sid));
      if (!fresh) {
        const rows = await tmux([
          'list-windows',
          '-t',
          S,
          '-F',
          '#{@sid}\t#{@label}\t#{window_name}\t#{@folder}\t#{pane_current_path}',
        ]);
        windows = Restore.missing(windows, Restore.presentWindows(rows));
        if (windows.length > 0)
          console.log(`restore: the tmux session misses ${String(windows.length)} saved window(s); building them`);
      }
      let built = 0;
      for (const w of windows) {
        try {
          await createWindow({ name: w.name, folder: w.folder, sid: w.sid, run: w.run, agent: w.agent });
          built++;
          if (w.run) console.log(`restore: resumed ${w.name} (${w.sid})`);
        } catch (e) {
          console.log(`restore: ${w.name}: ${errMsg(e)}`);
        }
      }
      if (home && built > 0) await tmux(['kill-window', '-t', home]);
      await tmux(['set-option', '-t', S, '@restored', '1']);
      restored = true;
    } finally {
      restoring = false;
    }
  })();
}

// ---------- state detection ----------
// Messages sent from the chat composer that the transcript does not show yet (lib/chat.ts
// pendingEchoes). window id -> [{ text, at, phase }]; phase: 'sending' (keys typed), 'brain' (the
// prompt hook runs: the brain looks for context), 'working' (no brain). The chat view shows them.
// a type, not an interface: lib/chat.ts Echo has an index signature
type Echo = { text: string; at: number; phase: string };
type ChatItems = Parameters<typeof pendingEchoes>[1];
const echoes = new Map<string, Echo[]>();
function echoesFor(win: string, items: ChatItems): Echo[] {
  const list = echoes.get(win);
  if (!list) return [];
  const left = pendingEchoes(list, items);
  if (left.length) echoes.set(win, left);
  else echoes.delete(win);
  return left.map(({ text, at, phase }) => ({ text, at, phase }));
}
const ATTACH_DIR = path.join(INST.home, 'attachments');
// attachments (lib/attachments.ts): the types Claude Code reads by path, the upload rules
const { IMAGE_EXT, ATTACH_EXT, withAttachments } = Attachments;
const CLAUDE_SESSIONS = path.join(HOME, '.claude', 'sessions');

// branch cache
const branchCache = new Map<string, { t: number; v: string }>();
function gitBranch(folder: string): string {
  const c = branchCache.get(folder);
  if (c && Date.now() - c.t < 30000) return c.v;
  let v: string;
  try {
    v = execFileSync('git', ['-C', folder, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    v = '';
  }
  branchCache.set(folder, { t: Date.now(), v });
  return v;
}

// folders that have a Claude process running OUTSIDE the panel (e.g. VS Code)
// conversations held by a Claude process OUTSIDE the panel: sessionId -> process record
// (lib/elsewhere.ts; records come from ~/.claude/sessions/<pid>.json)
type Holders = ReturnType<typeof outsideHolders>;
type Holder = Holders extends Map<string, infer R> ? R : never;
let elsewhere: Holders = new Map<string, Holder>();
let paneSid = new Map<string, string>(); // pane pid -> session id of the Claude running in it (exact)
async function scanElsewhere(): Promise<void> {
  const panes = new Set(
    ((await tmux(['list-panes', '-s', '-t', S, '-F', '#{pane_pid}'])) ?? '').split('\n').filter(Boolean),
  );
  const out = await new Promise<string>((r) => {
    execFile('ps', ['-axo', 'pid=,ppid='], (e, o) => {
      r(e ? '' : o);
    });
  });
  const parent = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) parent.set(m[1], m[2]);
  }
  const inPanel = (pid: string): boolean => {
    let p: string | undefined = pid;
    for (let i = 0; i < 30 && p !== undefined && p !== '' && p !== '1'; i++) {
      if (panes.has(p)) return true;
      p = parent.get(p);
    }
    return false;
  };
  const records = readRecords(CLAUDE_SESSIONS);
  elsewhere = outsideHolders(records, inPanel);
  paneSid = paneSessions(records, parent, panes);
  // Codex sessions open outside the panel (a terminal, VS Code): same map, rec.agent = 'codex'
  try {
    for (const r of Codex.outsideRecords(inPanel))
      if (!elsewhere.has(r.sessionId)) elsewhere.set(r.sessionId, { ...r });
  } catch {
    /* ps/lsof failed */
  }
}

// Move a conversation that is open outside the panel into window `id` (user decision,
// 2026-11-09): an interactive process is stopped with SIGTERM (Claude saves the transcript)
// and the same session is resumed here; a background job is attached instead of stopped.
async function migrateHere(id: string, sid: string): Promise<boolean> {
  if (adoptions.has(id)) return true; // the outside session is already moving here by itself (/panel)
  await scanElsewhere();
  const plan = migrationPlan(elsewhere.get(sid));
  if (plan.kind === 'none') return false;
  starting.add(id);
  setTimeout(() => starting.delete(id), 30000);
  if (plan.kind === 'attach') {
    await tmux(['send-keys', '-t', id, 'C-u']);
    await tmux(['send-keys', '-t', id, '-l', '--', `claude attach ${plan.jobId}`]);
    await tmux(['send-keys', '-t', id, 'Enter']);
    console.log(`migrate: ${id} attached to background job ${plan.jobId}`);
    return true;
  }
  try {
    process.kill(plan.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 50 && alive(plan.pid); i++) await sleep(200);
  const rec = elsewhere.get(sid);
  if (alive(plan.pid)) {
    starting.delete(id);
    throw new Error(
      `The other ${rec?.agent === 'codex' ? 'Codex' : 'Claude'} (pid ${String(plan.pid)}) did not stop; close it there and try again`,
    );
  }
  elsewhere.delete(sid);
  await tmux(['send-keys', '-t', id, 'C-l']);
  await startAgent(id, sid, rec?.agent);
  console.log(`migrate: ${id} stopped outside pid ${String(plan.pid)} and resumed ${sid.slice(0, 8)} here`);
  return true;
}

type ScreenOption = MenuOption;
/** A screen as poll() reads it: parseScreen() / Codex.parseScreen(), or 'stopped' for a pane without an agent. */
interface ScreenParse {
  state: string;
  last: string;
  options: ScreenOption[];
  question: string;
  live?: string;
  selected?: number;
}
interface Session {
  id: string;
  index: number;
  name: string;
  folder: string;
  sid: string;
  running: boolean;
  agent: Agent;
  started: number;
  state: string;
  last: string;
  options: ScreenOption[];
  question: string;
  live: string;
  branch: string;
  prompt: string;
  title: string;
  activity: number;
  ask?: { tool: string; detail: string };
}
interface Snapshot {
  sessions: Session[];
  ts: number;
  down?: boolean;
  restoring?: boolean;
  routes?: RouteRecord[];
  defaultFolder?: string;
  computer?: string;
  home?: string;
  platform?: string;
}
let snapshot: Snapshot = { sessions: [], ts: 0 };
// the owner's helper computers (lib/peer.ts): their sessions join the state message
const peerSet = Peer.createPeerSet({
  onChange: () => {
    broadcast();
  },
});
/** The state message: this Mac's sessions, then each helper's (id r:<device>:<window>, `device`, `offline`). */
function stateOut(): Omit<Snapshot, 'sessions'> & { sessions: object[] } {
  const views = peerSet.views();
  return views.length ? { ...snapshot, sessions: Peer.mergeSessions(snapshot.sessions, views) } : snapshot;
}
const prevState = new Map<string, string>();

// ---------- hook state (lib/hookstate.ts) ----------
// window id -> { state, at, sid } from the last hook event. Saved in the state folder, so a server
// restart keeps the state of running sessions (the next event would also fix it).
type HookRec = NonNullable<ReturnType<typeof HookState.applyHook>>;
const HOOK_FILE = path.join(INST.home, 'hook-state.json');
const hookRecs = new Map<string, HookRec>(
  Object.entries(
    ((): Record<string, HookRec> => {
      try {
        return JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8')) as Record<string, HookRec>;
      } catch {
        return {};
      }
    })(),
  ),
);
const idleSince = new Map<string, number>(); // window id -> since when the screen has shown 'idle' (ms)
const paneWindow = new Map<string, string>(); // tmux pane id (%N) -> window id, from poll()
let hookSave: NodeJS.Timeout | undefined;
function saveHookRecs(): void {
  clearTimeout(hookSave);
  hookSave = setTimeout(() => {
    try {
      fs.mkdirSync(INST.home, { recursive: true });
      fs.writeFileSync(HOOK_FILE, JSON.stringify(Object.fromEntries(hookRecs)));
    } catch {
      /* next change saves again */
    }
  }, 500);
}
type HookPayload = HookState.HookEventPayload;
// A session's tool says a macOS permission is missing: check the real state, then ask the app to
// show its guide (PermissionGuide.swift), once per permission in 30 min (lib/permneed.ts)
const permAsked = new Map<string, number>();
async function onPermNeed(event: string, pane: string, payload: HookPayload): Promise<void> {
  const ids = PermNeed.wanted(event, payload as Parameters<typeof PermNeed.wanted>[1]);
  if (!ids.length) return;
  const st = await Permissions.state({ tmuxArgs: INST.tmuxArgs });
  const missing = Permissions.checks(st).filter((c) => !c.ok && ids.includes(c.id));
  const id = paneWindow.get(pane);
  const session = snapshot.sessions.find((x) => x.id === id)?.name ?? '';
  for (const c of missing) {
    if (!PermNeed.shouldAsk(permAsked, c.id)) continue;
    const msg = JSON.stringify({
      type: 'permAsk',
      perm: { id: c.id, name: c.name, pane: c.pane },
      app: c.app,
      session,
    });
    for (const ws of stateClients) if (ws.readyState === 1) ws.send(msg);
  }
}

let hookPoll: NodeJS.Timeout | null = null;
async function onHook(event: string, pane: string, payload: HookPayload): Promise<void> {
  if (!/^%\d+$/.test(pane)) return;
  let id = paneWindow.get(pane) ?? '';
  if (!id) id = ((await tmux(['display-message', '-p', '-t', pane, '#{window_id}'])) ?? '').trim();
  if (!/^@\d+$/.test(id)) return;
  if (event === 'UserPromptSubmit') {
    // Claude got the prompt; its prompt hooks run now (the brain's takes seconds)
    const e = (echoes.get(id) ?? []).find((x) => x.phase === 'sending');
    if (e) e.phase = env('CC_PANEL_NO_BRAIN') ? 'working' : 'brain';
  }
  const rec = HookState.applyHook(hookRecs.get(id) ?? null, event, payload);
  if (!rec || rec === hookRecs.get(id)) return;
  hookRecs.set(id, rec);
  saveHookRecs();
  // show the change now, not at the next 1.5 s poll (several events in a row: one poll)
  hookPoll ??= setTimeout(() => {
    hookPoll = null;
    void poll();
  }, 50);
}

/** What poll() shows for a session's last turn: the transcript's (Claude Code) or the record's (Codex). */
interface TInfo {
  reply: string;
  prompt: string;
  title: string;
  mtime: number;
  lastMsg: number;
  busy?: boolean;
}

async function poll(): Promise<void> {
  const fmt =
    '#{window_id}\t#{window_index}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}\t#{@folder}\t#{@sid}\t#{window_activity}\t#{@label}\t#{pane_pid}\t#{@created}\t#{@agent}\t#{@started}\t#{pane_id}';
  const out = await tmux(['list-windows', '-t', S, '-F', fmt]);
  if (out === null) {
    // the tmux session is gone while the server runs (tmux crashed or was killed): build the
    // windows again from windows.json and resume them, as after a Mac restart
    ensureSession();
    snapshot = { sessions: [], ts: Date.now(), down: true, restoring, computer: COMPUTER, home: HOME };
    broadcast();
    return;
  }
  const sessions: Session[] = [];
  const rows = out.split('\n').filter(Boolean);
  // Codex session ids already known (a new Codex window must not take another window's record)
  const codexClaimed = new Set(
    rows
      .map((r) => r.split('\t'))
      .filter((c) => c[11] === 'codex' && isUuid(c[6]))
      .map((c) => c[6] ?? ''),
  );
  for (const row of rows) {
    const [
      id = '',
      index = '',
      winName = '',
      cmd = '',
      cwd = '',
      folderOpt = '',
      sidOpt = '',
      ,
      label = '',
      panePid = '',
      createdOpt = '',
      agentOpt = '',
      started = '',
      paneId = '',
    ] = row.split('\t');
    let sid = sidOpt;
    let created = createdOpt;
    if (paneId) paneWindow.set(paneId, id);
    const agent = agentOf(agentOpt);
    // tmux 3.5 has no #{window_created}: the panel records it (first sight for older windows)
    if (!created) {
      created = String(Math.floor(Date.now() / 1000));
      void tmux(['set-option', '-w', '-t', id, '@created', created]);
    }
    if (winName === 'home') continue;
    const name = label || winName;
    const folder = folderOpt || cwd;
    const running = paneRunning(cmd, panePid, paneSid, SHELLS);
    const screen = (await tmux(['capture-pane', '-p', '-J', '-t', id, '-S', '-200'])) ?? '';
    const parsed: ScreenParse = running
      ? agent === 'codex'
        ? Codex.parseScreen(screen)
        : parseScreen(screen)
      : { state: 'stopped', last: '', options: [], question: '' };
    let state = parsed.state;
    let last = parsed.last;
    let live = parsed.live ?? '';
    if (!running) {
      const m = screen.replace(ANSI, '').match(/⏺\s*(.+)/g);
      if (m) last = (m.at(-1) ?? '').replace(/^⏺\s*/, '');
    }
    // the session id comes from the Claude process in this pane (exact); it also corrects a wrong id
    if (agent === 'codex') {
      // a new Codex window: its SessionStart hook names the session (first message); without
      // hooks, its record appears with the first message (folder + start time)
      const hr = hookRecs.get(id);
      if (running && !isUuid(sid) && hr && isUuid(hr.sid) && !codexClaimed.has(hr.sid)) {
        await tmux(['set-option', '-w', '-t', id, '@sid', hr.sid]);
        sid = hr.sid;
        codexClaimed.add(hr.sid);
      }
      if (running && !isUuid(sid) && Number(started)) {
        const found = Codex.discover(folder, Number(started), codexClaimed);
        if (found) {
          await tmux(['set-option', '-w', '-t', id, '@sid', found]);
          sid = found;
          codexClaimed.add(found);
        }
      }
    } else {
      const exact = running ? (paneSid.get(panePid) ?? '') : '';
      if (exact && exact !== sid) {
        await tmux(['set-option', '-w', '-t', id, '@sid', exact]);
        sid = exact;
      }
    }
    // The state from hooks (Claude Code and Codex), with the screen where hooks are silent (lib/hookstate.ts)
    if (state === 'idle') {
      if (!idleSince.has(id)) idleSince.set(id, Date.now());
    } else idleSince.delete(id);
    let hooked: boolean;
    let ask: { tool: string; detail: string } | null = null;
    {
      let rec = hookRecs.get(id) ?? null;
      // a process that ended takes its record with it (a Claude started by hand has no hooks)
      if (rec && !running) {
        hookRecs.delete(id);
        saveHookRecs();
        rec = null;
      }
      if (rec && rec.sid && isUuid(sid) && rec.sid !== sid) rec = null; // another session in this window
      hooked = !!rec && rec.state !== 'stopped';
      state = HookState.combine({
        running,
        screen: { state, options: parsed.options },
        rec,
        idleSince: idleSince.get(id) ?? 0,
      });
      if (state !== 'working') live = '';
      else if (!live) live = 'Working';
      // what the session asks permission for (the tool and its command or file), from the hook:
      // the screen gives only the question text and the options
      if (state === 'needs' && rec?.ask) ask = { tool: asText(rec.ask.tool), detail: asText(rec.ask.detail) };
    }
    const blocked = isBlocked({ running, sid }, elsewhere);
    const tinfo: TInfo | null = agent === 'codex' ? Codex.info(sid) : transcriptInfo(folder, sid);
    // Codex: a turn that its record says is still running is "working", even when the screen
    // shows no spinner for a moment (record written in the last 30 minutes, so a crash cannot pin it)
    // (only without hooks: with hooks, Stop and Interrupt say when the turn ends)
    if (
      agent === 'codex' &&
      !hooked &&
      running &&
      state === 'idle' &&
      tinfo?.busy === true &&
      Date.now() - tinfo.mtime < 30 * 60000
    ) {
      state = 'working';
      live = live || 'Working';
    }
    if (tinfo && (!last || !running)) last = tinfo.reply || last;
    sessions.push({
      id,
      index: Number(index),
      name,
      folder,
      sid,
      running,
      agent,
      started: Number(started) || 0,
      state: blocked ? 'elsewhere' : state,
      last,
      options: parsed.options,
      question: parsed.question,
      live,
      branch: gitBranch(folder),
      prompt: tinfo ? tinfo.prompt : '',
      title: tinfo ? tinfo.title : '',
      // like Claude.ai / ChatGPT: the time of the last message in the conversation, not terminal
      // output or transcript bookkeeping. Opening or viewing a session must not move it.
      activity: lastMessageTime(tinfo, created),
      ...(ask && !blocked ? { ask } : {}),
    });
    prevState.set(id, state);
  }
  snapshot = {
    sessions,
    ts: Date.now(),
    restoring,
    routes: routes.slice(0, 30),
    defaultFolder: defaultFolder(),
    computer: COMPUTER,
    home: HOME,
    // the web panel offers "Choose…" (a macOS folder dialog on the server's screen) only on macOS
    platform: process.platform,
  };
  if (restored && !restoring) Restore.save(WINDOWS_FILE, Restore.record(sessions, lastRun));
  broadcast();
  void flushPending();
}

// A fresh session gets its transcript id once Claude writes the file.

// ---------- message delivery queue ----------
// Messages wait here until their session is ready (running and idle).
interface Pending {
  text: string;
  routeId: string | null;
  typedAt?: number;
}
const pending = new Map<string, Pending[]>(); // window id -> [{ text, routeId }]
const starting = new Set<string>();
let flushing = false;
async function flushPending(): Promise<void> {
  if (flushing || !pending.size) return;
  flushing = true;
  try {
    for (const [id, queue] of pending) {
      const s = snapshot.sessions.find((x) => x.id === id);
      if (!s) {
        for (const q of queue) setRoute(q.routeId, { status: 'error', error: 'Session closed' });
        pending.delete(id);
        continue;
      }
      if (s.state === 'stopped') {
        if (!starting.has(id)) {
          starting.add(id);
          await startAgent(id, isUuid(s.sid) ? s.sid : '', s.agent);
          setTimeout(() => starting.delete(id), 30000);
        }
        continue;
      }
      const q = queue[0];
      if (s.state !== 'idle' || !q) continue;
      if (s.agent === 'codex') {
        // Codex shows its start-up menus (hook review, MCP) a few seconds after the input box: wait
        // 8 s after start. A message typed before such a menu is kept by Codex and runs after it, so
        // before typing again, look in the record: if it arrived, it was sent (a test run:
        // the first task ran twice).
        if (s.started && Date.now() - s.started < 8000) continue;
        if (q.typedAt !== undefined && codexReceived(s.sid, q.text, q.typedAt)) {
          queue.shift();
          if (!queue.length) pending.delete(id);
          setRoute(q.routeId, { status: 'sent' });
          continue;
        }
        q.typedAt = q.typedAt ?? Date.now();
      }
      const result = await typeMessage(id, q.text, s.agent);
      if (result === 'menu') {
        // a menu came up: leave the message queued; it is typed again once the session is idle
        // (typeMessage clears any text left in the input box first)
        continue;
      }
      queue.shift();
      if (!queue.length) pending.delete(id);
      setRoute(
        q.routeId,
        result === 'sent'
          ? { status: 'sent' }
          : {
              status: 'error',
              error: `The message was typed but ${s.agent === 'codex' ? 'Codex' : 'Claude'} did not take it; press Enter in the session`,
            },
      );
    }
  } finally {
    flushing = false;
  }
}
/** Did a Codex session's record get this user message at or after `since` (ms)? */
function codexReceived(sid: string, text: string, since: number): boolean {
  if (!isUuid(sid)) return false;
  const want = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return Codex.chat(sid).items.some(
    (it) =>
      it.role === 'user' &&
      Date.parse(it.ts ?? '') >= since - 2000 &&
      it.text.replace(/\s+/g, ' ').trim().slice(0, 200) === want,
  );
}
// Returns 'sent', 'menu' (a menu appeared: nothing was submitted, Enter was NOT pressed on it)
// or 'stuck'. Never press Enter while a menu shows: on Claude's folder-trust prompt the default
// is "No, exit" (2026-11-09 e2e: Claude quit when an Enter meant for the task hit that prompt).
// Screen parser and input-box reader for a session's agent (Claude Code or Codex).
interface ScreenReader {
  parse: (screen: string) => ScreenParse;
  box: (screen: string) => string;
}
const screenOf = (agent: unknown): ScreenReader =>
  agentOf(agent) === 'codex'
    ? { parse: Codex.parseScreen, box: Codex.inputBoxText }
    : { parse: parseScreen, box: inputBoxText };
async function screenState(id: string, agent: unknown): Promise<string> {
  return screenOf(agent).parse((await tmux(['capture-pane', '-p', '-J', '-t', id])) ?? '').state;
}
async function typeMessage(id: string, text: string, agent: Agent = 'claude'): Promise<'sent' | 'menu' | 'stuck'> {
  const { parse, box: boxText } = screenOf(agent);
  const one = text.replaceAll(/[\r\n]+/g, ' ');
  if ((await screenState(id, agent)) !== 'idle') return 'menu';
  // clear anything left in the input box (e.g. a copy typed before a menu appeared). For Claude
  // always: a copy typed while Claude was starting can still be on its way to the box, which then
  // looks empty here, and the two copies joined ("/context/context" was no command any more;
  // a test run, 2026-11-17). Keys arrive in order, so the C-u also clears that late copy.
  if (agentOf(agent) !== 'codex' || boxText((await tmux(['capture-pane', '-p', '-J', '-t', id])) ?? '')) {
    await tmux(['send-keys', '-t', id, 'C-u']);
  }
  await tmux(['send-keys', '-t', id, '-l', '--', one]);
  // A brand-new Claude draws its input box before it reads keys: the typed text shows up
  // 1–3 s later and an Enter sent before that is lost, while the box still looks empty, so it
  // looked "sent" (2026-11-10: 2 of 5 new sessions kept the request in the box until the user
  // pressed Enter). Wait until the box shows the text; an empty box only counts as sent after that.
  const typedAt = Date.now();
  let echoed = false;
  while (Date.now() - typedAt < 10000) {
    const screen = (await tmux(['capture-pane', '-p', '-J', '-t', id])) ?? '';
    if (parse(screen).state === 'needs') return 'menu';
    if (boxText(screen)) {
      echoed = true;
      break;
    }
    await sleep(100);
  }
  // A long message is handled like a paste; an Enter sent too soon is swallowed and the
  // text stays in the input box (found in the real handoff test, 2026-11-09). Wait by
  // length, press Enter, then check the box is empty and press again if it is not.
  await sleep(Math.max(0, Math.min(3000, 150 + one.length / 2) - (Date.now() - typedAt)));
  // Right after a menu (e.g. folder trust) Claude may still be starting and ignore Enter
  // (found in an end-to-end test, 2026-11-09: 1 run of 6 left the task in the box). Keep
  // trying for about 15 s with growing waits.
  // A Claude Code command can open its own dialog (/model, /resume): a menu right after the Enter
  // is the command's answer. The command was sent; typing it again later would run it twice.
  const command = agentOf(agent) !== 'codex' && Commands.parse(text) !== null;
  let pressed = false;
  for (const wait of [700, 1000, 1500, 2000, 2500, 3000, 3000]) {
    if ((await screenState(id, agent)) === 'needs') return Commands.menuAfterEnter({ command, pressed, echoed });
    await tmux(['send-keys', '-t', id, 'Enter']);
    pressed = true;
    await sleep(wait);
    const screen = (await tmux(['capture-pane', '-p', '-J', '-t', id])) ?? '';
    if (parse(screen).state === 'needs') return Commands.menuAfterEnter({ command, pressed, echoed });
    const box = boxText(screen);
    if (!box) {
      if (echoed) return 'sent';
      continue;
    }
    echoed = true;
    if (!one.startsWith(box.slice(0, 20)) && !box.includes(one.slice(0, 20))) return 'sent';
  }
  return 'stuck';
}
async function deliver(id: string, text: string, routeId: string | null): Promise<void> {
  const s = snapshot.sessions.find((x) => x.id === id);
  if (!s) throw new Error('No such session');
  if (s.state === 'elsewhere') await migrateHere(id, s.sid);
  let queue = pending.get(id);
  if (!queue) {
    queue = [];
    pending.set(id, queue);
  }
  queue.push({ text, routeId });
  setRoute(routeId, { status: s.state === 'idle' ? 'sending' : 'queued', target: id, targetName: s.name });
  void flushPending();
}

// ---------- adoption (thoth adopt / the /panel command) ----------
const adoptions = new Map<string, { sid: string; pid: number; until: number; agent: Agent }>(); // window id -> { sid, pid, until }
let adoptTimer: NodeJS.Timeout | null = null;
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
}
async function checkAdoptions(): Promise<void> {
  for (const [id, a] of adoptions) {
    if (alive(a.pid)) {
      if (Date.now() > a.until) adoptions.delete(id); // still running elsewhere: leave the Resume button
      continue;
    }
    adoptions.delete(id);
    if (starting.has(id)) continue; // already started (e.g. by migrateHere)
    await tmux(['send-keys', '-t', id, 'C-l']);
    await startAgent(id, a.sid, a.agent);
    pollSoon(300);
  }
  if (!adoptions.size && adoptTimer) {
    clearInterval(adoptTimer);
    adoptTimer = null;
  }
}
function watchAdoptions(): void {
  if (adoptTimer) return;
  adoptTimer = setInterval(() => {
    void checkAdoptions();
  }, 300);
}

// ---------- router: one entry point for all requests ----------
type RouterDecision = ReturnType<typeof router.splitTasks>[number];
interface RouteRecord {
  id: string;
  ts: number;
  text: string;
  status?: string | undefined;
  error?: string | undefined;
  target?: string | undefined;
  targetName?: string | undefined;
  decided?: string | undefined;
  reason?: string | undefined;
  confidence?: number | undefined;
  choices?: { id: string; name: string }[] | undefined;
  folder?: string | undefined;
  newName?: string | undefined;
  defaultFolder?: string | undefined;
  agent?: string | undefined;
  action?: string | undefined;
  device?: string | undefined;
  sid?: string | undefined;
  busy?: string | undefined;
  briefFrom?: string[] | undefined;
  handoffId?: string | undefined;
  tasks?: string[] | undefined;
  plan?: unknown[] | undefined;
  task?: string | undefined;
  parent?: string | undefined;
  part?: string | undefined;
  command?: boolean | undefined;
}
type RoutePatch = Partial<Omit<RouteRecord, 'id' | 'ts'>>;
// an instance with its own state folder keeps routes.json there; a test server on another port
// without one keeps its own request list next to the user's
const ROUTES_FILE = path.join(
  INST.home,
  env('CC_PANEL_HOME') || PORT === 7878 ? 'routes.json' : `routes-${String(PORT)}.json`,
);
let routes: RouteRecord[] = [];
try {
  routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')) as RouteRecord[];
} catch {
  routes = [];
}
const commandLists = Commands.cache(); // the Ask box's command lists by folder (lib/commands.ts)
let routeSeq = Date.now();
const nextRouteId = (): string => `r${String(++routeSeq)}`;
function saveRoutes(): void {
  try {
    fs.writeFileSync(ROUTES_FILE, JSON.stringify(routes.slice(0, 50), null, 1));
  } catch {
    /* ignore */
  }
}
function setRoute(rid: string | null, patch: RoutePatch): void {
  const r = routes.find((x) => x.id === rid);
  if (!r) return;
  Object.assign(r, patch);
  saveRoutes();
  snapshot.routes = routes.slice(0, 30);
  broadcast();
}

// Test scope: while set (by the verify skill), the router only sees these
// sessions, so test requests can never reach a real session. Expires by itself.
let testScope: { ids: Set<string>; until: number } | null = null;
function routable(): Session[] {
  const scope = testScope;
  if (scope && Date.now() < scope.until) return snapshot.sessions.filter((s) => scope.ids.has(s.id));
  testScope = null;
  return snapshot.sessions;
}

// Default folder for new work that fits no session or project (the Ask box never forces a
// folder choice). Set "defaultFolder" in <state folder>/settings.json or CC_PANEL_DEFAULT_FOLDER.
// ~/code, not ~/Desktop/...: the Desktop is synced to iCloud (user's decision, 2026-11-09).
function defaultFolder(): string {
  let f = env('CC_PANEL_DEFAULT_FOLDER');
  if (!f) {
    try {
      f = asText(asObj(JSON.parse(fs.readFileSync(path.join(INST.home, 'settings.json'), 'utf8')))?.['defaultFolder']);
    } catch {
      /* none */
    }
  }
  f = (f || path.join(HOME, 'code')).replace(/^~(?=\/|$)/, HOME);
  if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true });
  return f;
}

/** Short session name for a new task: the router's name, else the first words of the request. */
function taskName(name: string | undefined, text: string): string {
  const n = (name ?? '').trim();
  if (n) return n.slice(0, 30);
  const words = text.replace(/\s+/g, ' ').trim().slice(0, 24);
  return words || 'task';
}

/** Sort key for Recent: time of the last message in the conversation, else when the window was created. */
function lastMessageTime(tinfo: TInfo | null, created: string): number {
  if (tinfo && tinfo.lastMsg) return tinfo.lastMsg;
  return Number(created) * 1000 || 0;
}

function routerSessions(): (Session & { queued: number; topics: string[] })[] {
  return routable().map((s) => ({
    ...s,
    queued: queuedCount(s.id),
    topics: history(s.folder)
      .slice(0, 5)
      .map((h) => h.title || h.first.slice(0, 60)),
  }));
}

// ---------- central brain (cross-device sessions) ----------
// Where the brain is: <panel home>/brain.json { url, owner_token } for a cloud brain
// else the local brain/brain.py on 127.0.0.1:7879 (as before).
const BRAIN_MCP = path.join(ROOT, 'brain', 'mcp_server.py');
let LOCAL_DEVICE = '';
interface BrainTarget {
  cloud: boolean;
  url: URL;
  token: string;
}
function brainTarget(): BrainTarget {
  const loc = Setup.loadBrainLocation(INST.home);
  if (loc) return { cloud: true, url: new URL(loc.url), token: loc.owner_token };
  return { cloud: false, url: new URL(`http://127.0.0.1:${String(BRAIN_PORT)}`), token: brainToken() };
}
type Requester = (opts: http.RequestOptions, cb: (res: http.IncomingMessage) => void) => http.ClientRequest;
/** Request options for the brain: the cloud brain gets the owner token on every call; the local
 * brain gets its write token on POSTs (reads are open on 127.0.0.1). */
function brainOptions(
  t: BrainTarget,
  method: string,
  apiPath: string,
  timeout: number,
): { request: Requester; opts: http.RequestOptions } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if ((t.cloud || method === 'POST') && t.token) headers['Authorization'] = 'Bearer ' + t.token;
  const secure = t.url.protocol === 'https:';
  return {
    request: secure ? https.request : http.request,
    opts: { host: t.url.hostname, port: t.url.port || (secure ? 443 : 80), path: apiPath, method, headers, timeout },
  };
}
interface BrainReply {
  status: number;
  json: unknown;
}
/** One brain call -> { status, json }. Rejects on network/certificate errors (err.code kept). */
function brainRequest(
  method: string,
  apiPath: string,
  body: object | null | undefined,
  { target = brainTarget(), timeout = 30000 }: { target?: BrainTarget; timeout?: number } = {},
): Promise<BrainReply> {
  return new Promise((resolve, reject) => {
    const { request, opts } = brainOptions(target, method, apiPath, timeout);
    const req = request(opts, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => {
        data += c.toString();
      });
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(data || 'null');
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Object.assign(new Error('brain timeout'), { code: 'ETIMEDOUT' })));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function brainCall(method: string, apiPath: string, body?: object): Promise<unknown> {
  const r = await brainRequest(method, apiPath, body);
  if (r.json === undefined) throw new Error('bad brain reply');
  return r.json;
}
/** A device in the brain's list (GET /api/devices). */
interface BrainDevice {
  id?: string;
  name: string;
  transport?: string;
  status?: string;
  last_sync?: unknown;
  last_seen?: unknown;
  sessions?: unknown;
}
/** The brain's device list, or null when the answer is not a list (e.g. the cloud brain refused the owner token). */
const deviceArray = (v: unknown): BrainDevice[] | null => (Array.isArray(v) ? (v as BrainDevice[]) : null);
async function brainUp(): Promise<boolean> {
  try {
    const devs = deviceArray(await brainCall('GET', '/api/devices'));
    if (!devs) return false; // e.g. the cloud brain refused the owner token
    const cd = cloudDevice();
    const local = cd ? { name: confDevice(cd) } : devs.find((d) => d.transport === 'local');
    if (local) LOCAL_DEVICE = local.name;
    return true;
  } catch {
    return false;
  }
}

// This computer as a device of the cloud brain: it joins when the owner connects, and pushes its
// sessions over HTTPS (outbound only) with device/device_agent.py every 5 minutes.
const CLOUD_DEVICE_FILE = path.join(INST.home, 'cloud-device.json');
// the device agent's file (device/join.sh); CC_DEVICE_AGENT_FILE moves it in tests
const AGENT_DEVICE_FILE = env('CC_DEVICE_AGENT_FILE') || path.join(os.homedir(), '.cc-brain', 'device.json');
const readJson = Devices.readJson;
/** This computer's identity on the cloud brain (lib/devices.ts pickIdentity), or null. */
function cloudIdentity(): (NonNullable<ReturnType<typeof Devices.pickIdentity>> & { file: string }) | null {
  const loc = Setup.loadBrainLocation(INST.home);
  let agentLogAge = Infinity;
  try {
    agentLogAge = Date.now() - fs.statSync(path.join(path.dirname(AGENT_DEVICE_FILE), 'device-agent.log')).mtimeMs;
  } catch {
    /* no agent log */
  }
  const id = Devices.pickIdentity({
    own: readJson(CLOUD_DEVICE_FILE) as Devices.DeviceConf | null,
    agent: readJson(AGENT_DEVICE_FILE) as Devices.DeviceConf | null,
    hub: loc?.url ?? null,
    agentLogAge,
  });
  return id && { ...id, file: id.which === 'agent' ? AGENT_DEVICE_FILE : CLOUD_DEVICE_FILE };
}
/** The device name in a device file. */
const confDevice = (c: Devices.DeviceConf | null): string => asText(c?.['device']);
function cloudDevice(): Devices.DeviceConf | null {
  const id = cloudIdentity();
  return id ? id.conf : null;
}
interface SelfPushResult {
  at: number;
  ok: boolean;
  message: string;
  sessions: number | undefined;
}
const selfPush: { running: boolean; last: SelfPushResult | null } = { running: false, last: null };
function pushSelf(): Promise<SelfPushResult | null> {
  const id = cloudIdentity();
  // the device agent pushes this computer's sessions on its own schedule: one pusher per computer
  if (selfPush.running || !id || !id.push || env('CC_PANEL_NO_CLOUD_PUSH')) return Promise.resolve(selfPush.last);
  selfPush.running = true;
  return new Promise((resolve) => {
    const hub = id.conf.hub ?? '';
    execFile(
      'python3',
      ['-I', path.join(ROOT, 'device', 'device_agent.py'), 'push'],
      {
        env: { ...process.env, CC_DEVICE_CONF: id.file, CC_DEVICE_NO_REJOIN: '1' },
        timeout: 600000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, out, errOut) => {
        void (async () => {
          let text = (out || errOut || (err ? err.message : '')).trim().split('\n').pop() ?? '';
          const m = /the brain has (\d+)/.exec(text);
          // exit 7: cloud-device.json was copied from another computer (Migration Assistant). The agent
          // moved it aside; this computer joins with its own name (lib/devices.ts hostName).
          if (err?.code === 7) {
            try {
              const e = await joinCloudSelf(setupState(), hub, Devices.hostName());
              text =
                e ??
                `This computer's device file came from another computer. It joined the cloud brain again as '${confDevice(cloudDevice())}'.`;
              console.log('cloud push: ' + text);
            } catch (e) {
              text = `This computer could not join the cloud brain again: ${errMsg(e)}`;
            }
          }
          selfPush.last = {
            at: Date.now(),
            ok: !err,
            message: text.slice(0, 300),
            sessions: m ? Number(m[1]) : undefined,
          };
          selfPush.running = false;
          resolve(selfPush.last);
        })();
      },
    );
  });
}
setInterval(() => {
  void pushSelf();
}, 5 * 60_000).unref();
setTimeout(() => {
  void pushSelf();
}, 5000).unref();

// Device heartbeat (lib/heartbeat.ts, brain/heartbeat.py): every 30 s this computer tells the brain
// it is online, its role, power, load, sessions, projects and tools. Outgoing only. The project scan
// and the claude/codex checks run less often. After a 404 (an older brain) the same brain is asked
// again in 10 minutes; after 401/403/429 (a refused token) in an hour (Heartbeat.waitAfter).
// CC_PANEL_NO_BRAIN or CC_PANEL_NO_HEARTBEAT turn it off.
const THOTH_VERSION = ((): string => {
  const v = (readJson(path.join(ROOT, 'package.json')) as { version?: unknown } | null)?.version;
  return typeof v === 'string' ? v : '';
})();
const beat = {
  projects: { at: 0, key: '\u0000', list: [] as Heartbeat.Project[] },
  tools: { at: 0, claude: false, codex: false },
  pause: null as Heartbeat.Pause | null,
  lastLog: '',
};
function heartbeatTarget(): Heartbeat.Target | null {
  const id = cloudIdentity();
  const loc = Setup.loadBrainLocation(INST.home);
  // a test instance uses only its own brain (verify's plan_brain sets CC_BRAIN_PORT), never the user's
  const local =
    INST.test && !env('CC_BRAIN_PORT')
      ? null
      : { url: `http://127.0.0.1:${String(BRAIN_PORT)}`, token: brainToken(), cloud: false };
  return Heartbeat.target({
    identity: id ? id.conf : null,
    agent: readJson(AGENT_DEVICE_FILE) as Heartbeat.DeviceConf | null,
    brain: loc ? { url: loc.url, token: loc.owner_token, cloud: true } : local,
    hostName: Devices.hostName(),
    test: Boolean(INST.test),
  });
}
function pmsetBatt(): Promise<string> {
  if (process.platform !== 'darwin') return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'batt'], { timeout: 5000 }, (_e, out) => {
      resolve(out || '');
    });
  });
}
/** Is the codex CLI there? Async (never blocks the server, unlike Codex.availability). */
function codexInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('codex', ['--version'], { timeout: 10_000 }, (e) => {
      resolve(!e);
    });
  });
}
function heartbeatLog(text: string): void {
  if (text === beat.lastLog) return;
  beat.lastLog = text;
  console.log('heartbeat: ' + text);
}
async function sendHeartbeat(now: number = Date.now()): Promise<void> {
  if (env('CC_PANEL_NO_BRAIN') || env('CC_PANEL_NO_HEARTBEAT')) return;
  const t = heartbeatTarget();
  if (!t) return;
  const key = `${t.url} ${Devices.hash(t.token)}`;
  if (Heartbeat.paused(beat.pause, key, now)) return;
  // with the owner token: the brain's own name for this computer (devices.json), when known
  if (t.device !== undefined && !LOCAL_DEVICE) await brainUp();
  const device = t.device === undefined ? undefined : Heartbeat.deviceName(LOCAL_DEVICE, t.device);
  const live = snapshot.sessions.filter((x) => x.running);
  const folders = live.map((x) => x.folder);
  const scanKey = Heartbeat.rescan(beat.projects, folders, now);
  if (scanKey !== null)
    beat.projects = { at: now, key: scanKey, list: Heartbeat.findProjects(HOME, [...new Set(folders)]) };
  if (now - beat.tools.at > 5 * 60_000) {
    beat.tools = { at: now, claude: Setup.which('claude') !== null, codex: await codexInstalled() };
  }
  const hb = Heartbeat.build({
    role: setupState()['role'],
    onAc: Heartbeat.onAcPower(await pmsetBatt()),
    load: os.loadavg()[0] ?? 0,
    cpus: os.cpus().length,
    sessionStates: live.map((x) => x.state),
    projects: beat.projects.list,
    claude: beat.tools.claude,
    codex: beat.tools.codex,
    version: THOTH_VERSION,
  });
  const target: BrainTarget = { cloud: true, url: new URL(t.url), token: t.token };
  try {
    const r = await brainRequest('POST', '/api/heartbeat', device === undefined ? hb : { ...hb, device }, {
      target,
      timeout: 15000,
    });
    const wait = Heartbeat.waitAfter(r.status);
    beat.pause = wait ? { key, until: now + wait } : null;
    if (r.status === 404)
      heartbeatLog(`the brain at ${target.url.host} has no heartbeat API (an older brain); trying again in 10 minutes`);
    else if (wait)
      heartbeatLog(`the brain at ${target.url.host} refused (${String(r.status)}); trying again in an hour`);
    else heartbeatLog(r.status === 200 ? `sent to ${target.url.host}` : `the brain answered ${String(r.status)}`);
  } catch (error) {
    heartbeatLog(`cannot reach the brain at ${target.url.host}: ${errMsg(error)}`);
  }
}
let heartbeatRunning = false;
function heartbeatTick(): void {
  if (heartbeatRunning) return;
  heartbeatRunning = true;
  void sendHeartbeat().finally(() => {
    heartbeatRunning = false;
  });
}
setInterval(heartbeatTick, Heartbeat.EVERY_MS).unref();
setTimeout(heartbeatTick, 3000).unref();

/** A handoff in the brain's list (GET /api/handoffs). */
interface Handoff {
  id: string;
  status: string;
  result?: string;
  target_path?: string;
}
/** Router decided "handoff": the brain moves the work here and opens a panel session. When this
 * computer has the newest copy of the session itself (lib/copies.ts), it is resumed here instead. */
async function handoffRoute(rid: string, device: string, sid: string, text: string): Promise<void> {
  let here: ReturnType<typeof Copies.newestHere> = null;
  try {
    here = Copies.newestHere(
      (await brainCall('GET', `/api/session?sid=${encodeURIComponent(sid)}&count=1`)) as Parameters<
        typeof Copies.newestHere
      >[0],
      LOCAL_DEVICE,
    );
  } catch {
    /* no brain answer: hand off */
  }
  const hereSid = here?.['sid'];
  const hereCwd = asText(here?.['cwd']);
  if (here && isUuid(hereSid) && isDir(hereCwd)) {
    const open = snapshot.sessions.find((x) => x.sid === hereSid);
    const id = open
      ? open.id
      : (
          await newSession({
            folder: hereCwd,
            sid: hereSid,
            name: (asText(here['title']) || path.basename(hereCwd)).slice(0, 30),
            agent: here['agent'] === 'codex' ? 'codex' : 'claude',
          })
        ).id;
    await poll();
    setRoute(rid, {
      decided: 'auto-resume',
      reason: `The session ${hereSid.slice(0, 8)} on ${device} has its newest copy on this computer too, so it is resumed here (no handoff).`,
    });
    await deliver(id, text, rid);
    return;
  }
  setRoute(rid, { status: 'handing-off', targetName: device });
  const started = asObj(
    await brainCall('POST', '/api/handoff', {
      device,
      sid,
      run: 'panel',
      panel_url: `http://${HOST}:${String(PORT)}`,
      notes: `The user asked: ${text}`,
    }),
  );
  const hid = asText(started?.['id']);
  if (!hid) throw new Error(asText(started?.['error']) || 'brain did not start the handoff');
  setRoute(rid, { handoffId: hid });
  for (let i = 0; i < 300; i++) {
    await sleep(2000);
    const list = (await brainCall('GET', '/api/handoffs?limit=30')) as Handoff[] | null;
    const h = (list ?? []).find((x) => x.id === hid);
    if (!h || h.status === 'running' || h.status === 'prepared') continue;
    let res: { panel_session?: string; result?: string } = {};
    try {
      res = JSON.parse(h.result ?? '{}') as typeof res;
    } catch {
      /* keep {} */
    }
    const panelSession = res.panel_session ?? '';
    if (h.status !== 'ran' || !panelSession)
      throw new Error('handoff failed: ' + (res.result ?? h.result ?? '').slice(0, 300));
    await poll();
    const s = snapshot.sessions.find((x) => x.id === panelSession);
    setRoute(rid, {
      status: 'queued',
      decided: 'auto-handoff',
      target: panelSession,
      targetName: s ? s.name : 'handoff',
      reason: `${device} → ${LOCAL_DEVICE || 'this Mac'}: code copied to ${String(h.target_path)}; Claude gets the handoff after you approve the folder.`,
    });
    return;
  }
  throw new Error('handoff took too long');
}

/**
 * Messages waiting for a session: the panel's delivery queue, plus Claude Code's own queue
 * (messages typed into the session page while Claude works; read from the transcript).
 */
function queuedCount(id: string): number {
  const s = snapshot.sessions.find((x) => x.id === id);
  let own = 0;
  if (s && (s.state === 'working' || s.state === 'needs') && isUuid(s.sid)) {
    own = Brief.claudeQueue(Brief.readTail(path.join(PROJECTS, slugOf(s.folder), s.sid + '.jsonl'), 512 * 1024));
  }
  return (pending.get(id) ?? []).length + own;
}

/**
 * Start a new session for a request and send it the request. When `sources` (sessions) are given,
 * the new session first gets a brief written from their recent conversations (lib/brief.ts).
 */
async function newWithBrief(
  rid: string,
  {
    folder,
    name,
    text,
    sources = [],
    patch = {},
    agent = 'claude',
  }: { folder: string; name?: string; text: string; sources?: Session[]; patch?: RoutePatch; agent?: string },
): Promise<void> {
  const id = await createWindow({ name: taskName(name, text), folder, sid: '', run: true, agent });
  await poll();
  let message = text;
  let briefFrom: string[] = [];
  if (sources.length) {
    setRoute(rid, { ...patch, status: 'briefing', folder });
    const withDialogue = sources.map((s) => ({
      name: s.name,
      folder: s.folder,
      dialogue: !isUuid(s.sid)
        ? []
        : s.agent === 'codex'
          ? codexDialogue(s.sid)
          : Brief.readDialogue(path.join(PROJECTS, slugOf(s.folder), s.sid + '.jsonl')),
    }));
    const brief = await Brief.runBrief(text, withDialogue);
    if (brief) {
      briefFrom = withDialogue.filter((s) => s.dialogue.length).map((s) => s.name);
      message = Brief.withBrief(text, brief, briefFrom);
    }
  }
  setRoute(rid, { ...patch, status: 'queued', folder, briefFrom });
  await deliver(id, message, rid);
}

/** The recent user/assistant turns of a Codex session, for a brief ({role, text}[], like Brief.readDialogue). */
function codexDialogue(sid: string): Brief.Turn[] {
  return Codex.chat(sid, 40)
    .items.map((it) => ({
      role: it.role,
      text:
        it.role === 'user'
          ? it.text
          : it.blocks
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n'),
    }))
    .filter((t) => t.text && t.text.trim())
    .map((t) => ({ ...t, text: t.text.slice(0, 1500) }))
    .slice(-12);
}

interface NewSessionPrefs {
  folder?: string;
  agent?: string;
}
/** Carry out one routing decision `d` for the request `text` (route record `rid`).
 * `prefs`: the folder and agent the user chose for a NEW session; a decision that sends the
 * request to an existing session does not use them (lib/router.ts newSessionChoice). */
async function runDecision(
  rid: string,
  d: RouterDecision,
  textIn: string,
  dry: boolean,
  prefs: NewSessionPrefs = {},
): Promise<void> {
  let text = textIn;
  // the router picks the agent for a new session (Codex only when the request asks for it)
  let newAgent: string = d.agent === 'codex' && Codex.availability().available ? 'codex' : 'claude';
  // no agent given for the overflow of a busy session: keep that session's agent
  if (!has(d.agent) && d.action === 'new') {
    const busy = (d.context_from ?? [])
      .map((cid) => routable().find((x) => x.id === cid))
      .find((x) => x !== undefined && x.folder === d.folder && router.isBusy(x, queuedCount(x.id)));
    if (busy?.agent === 'codex' && Codex.availability().available) newAgent = 'codex';
  }
  // the request without the words that only chose the agent ("用 codex …"): a Codex session
  // took "用 codex" as "start the Codex CLI" (a test run, 2026-11-10)
  if (
    typeof d.task === 'string' &&
    d.task.trim() &&
    d.task.trim().length >= Math.min(20, text.length * 0.3) &&
    d.task.trim() !== text.trim()
  ) {
    // the router's words, with the attached files of the request (it may leave their paths out)
    text = Attachments.keepAttachments(text, d.task.trim(), ATTACH_DIR);
    setRoute(rid, { task: text });
  }
  // "new" without a usable folder goes to the default folder
  if (d.action === 'new' && (!has(d.folder) || !fs.existsSync(d.folder))) d.folder = defaultFolder();
  if (d.action === 'new') {
    const c = router.newSessionChoice(prefs, d.folder ?? '', newAgent);
    // the router's reason names the folder it picked: say where the session really starts
    if (c.chosen && c.folder !== d.folder)
      d.reason = `${d.reason ?? ''} It starts in ${path.basename(c.folder)}, the folder you chose.`.trim();
    d.folder = c.folder;
    newAgent = c.agent;
  }
  const pool = routable();
  const target = pool.find((s) => s.id === d.target);
  const choices = [...new Set([d.target, ...(d.alternatives ?? [])])]
    .map((id) => pool.find((s) => s.id === id))
    .filter((s): s is Session => s !== undefined)
    .map((s) => ({ id: s.id, name: s.name }));
  const base: RoutePatch = {
    reason: d.reason ?? '',
    confidence: d.confidence,
    choices,
    folder: d.folder ?? '',
    newName: d.name ?? '',
    defaultFolder: defaultFolder(),
  };
  // sessions the router named as background for a new session (never the new session itself)
  const contextFrom = [...new Set(d.context_from ?? [])]
    .map((id) => pool.find((s) => s.id === id))
    .filter((s): s is Session => s !== undefined)
    .slice(0, 3);
  if (dry) {
    setRoute(rid, {
      ...base,
      status: 'dry',
      agent: newAgent,
      action: d.action,
      target: d.target ?? '',
      targetName: target ? target.name : '',
      device: d.device ?? '',
      sid: d.sid ?? '',
    });
    return;
  }
  if (
    d.action === 'handoff' &&
    !testScope &&
    has(d.device) &&
    has(d.sid) &&
    d.device !== LOCAL_DEVICE &&
    (d.confidence ?? 0) >= 0.75
  ) {
    setRoute(rid, { ...base, decided: 'handoff' });
    await handoffRoute(rid, d.device, d.sid, text);
  } else if (
    d.action === 'send' &&
    target &&
    (d.confidence ?? 0) >= 0.75 &&
    router.isBusy(target, queuedCount(target.id)) &&
    !testScope
  ) {
    // The user's rule: never make a request wait for a session that is still working or has a
    // queue. Start a new session in its folder and give it the busy session's background (and any
    // other session the router named).
    const n = queuedCount(target.id);
    const why = target.state === 'working' ? 'is still working' : `has ${String(n)} messages waiting`;
    const { folder, agent } = router.newSessionChoice(
      prefs,
      fs.existsSync(target.folder) ? target.folder : defaultFolder(),
      target.agent,
    );
    await newWithBrief(rid, {
      folder,
      name: has(d.name) && d.name !== target.name ? d.name : `${target.name} 2`,
      text,
      agent,
      sources: [target, ...contextFrom.filter((s) => s.id !== target.id)],
      patch: {
        ...base,
        decided: 'auto-new-busy',
        busy: target.id,
        agent,
        reason:
          `${target.name} ${why}, so a new session in ${path.basename(folder)} with its background. ${d.reason ?? ''}`.trim(),
      },
    });
  } else if (d.action === 'send' && target && (d.confidence ?? 0) >= 0.75) {
    setRoute(rid, { ...base, decided: 'auto' });
    await deliver(target.id, text, rid);
  } else if (
    d.action === 'new' &&
    !testScope &&
    has(d.folder) &&
    fs.existsSync(d.folder) &&
    (d.confidence ?? 0) >= 0.75
  ) {
    await newWithBrief(rid, {
      folder: d.folder,
      ...(d.name === undefined ? {} : { name: d.name }),
      text,
      agent: newAgent,
      sources: contextFrom,
      patch: { ...base, decided: 'auto-new', agent: newAgent },
    });
  } else if (!testScope) {
    // The router is not sure. The user's rule: do not ask, use the default — a new session in the default folder.
    // The folder is the project the request most likely belongs to (the router's folder, else its
    // best-guess session's folder); the default folder only when nothing fits.
    // A folder the user chose for a new session wins over all of them.
    const guess = router.unsureFolder(d, pool, defaultFolder(), (f) => isDir(f));
    const { folder, agent, chosen } = router.newSessionChoice(prefs, guess.folder, newAgent);
    let why = '';
    if (chosen) why = ' (the folder you chose)';
    else if (guess.from !== null && guess.from !== '') why = ` (the project of ${guess.from})`;
    else if (guess.from === null) why = ' (the default folder)';
    await newWithBrief(rid, {
      folder,
      ...(d.name === undefined ? {} : { name: d.name }),
      text,
      sources: contextFrom,
      agent,
      patch: {
        ...base,
        folder,
        decided: 'auto-new',
        agent,
        reason: `Not sure which session, so a new session in ${path.basename(folder)}${why}. ${d.reason ?? ''}`.trim(),
      },
    });
  } else {
    setRoute(rid, { ...base, status: 'ask' }); // a test scope cannot start sessions
  }
}

/** `prefs`: the folder and agent the user chose in case the request starts a NEW session ({} = the server chooses). */
function route(text: string, dry = false, prefs: NewSessionPrefs = {}): string {
  const rid = nextRouteId();
  routes.unshift({ id: rid, ts: Date.now(), text, status: 'routing' });
  setRoute(rid, {});
  void (async () => {
    try {
      await poll();
      if (!routable().length && !testScope) {
        // nothing to route to yet: start the work in the default folder (or the folder the user chose)
        const { folder, agent } = router.newSessionChoice(prefs, defaultFolder(), 'claude');
        const id = await createWindow({ name: taskName('', text), folder, sid: '', run: true, agent });
        await poll();
        setRoute(rid, {
          status: 'queued',
          decided: 'auto-new',
          folder,
          agent,
          reason: `No sessions yet, so a new session in ${path.basename(folder)}.`,
        });
        await deliver(id, text, rid);
        return;
      }
      const brain = !testScope && (await brainUp());
      const d = await router.runRouter(
        text,
        routerSessions(),
        recentFolders().map((f) => f.folder),
        {
          brainMcp: brain ? BRAIN_MCP : null,
          localDevice: LOCAL_DEVICE,
          defaultFolder: defaultFolder(),
          codexOk: Codex.availability().available,
        },
      );
      const plan = router.splitTasks(d, routable());
      const only = plan.length === 1 ? plan[0] : undefined;
      if (only) {
        await runDecision(rid, only, text, dry, prefs);
        return;
      }
      // Several jobs: one route record per task, listed right under the request, each delivered
      // on its own (its own session, its own background), at the same time.
      const n = plan.length;
      const parts: RouteRecord[] = plan.map((t, i) => ({
        id: nextRouteId(),
        ts: Date.now(),
        text: t.task ?? '',
        status: 'routing',
        parent: rid,
        part: `${String(i + 1)}/${String(n)}`,
      }));
      routes.splice(routes.findIndex((x) => x.id === rid) + 1, 0, ...parts);
      setRoute(rid, {
        status: dry ? 'dry' : 'split',
        tasks: parts.map((p) => p.id),
        reason: `Split into ${String(n)} tasks. ${d.reason ?? ''}`.trim(),
        ...(dry
          ? {
              plan: plan.map((t) => ({
                action: t.action,
                target: t.target ?? '',
                folder: t.folder ?? '',
                name: t.name ?? '',
                agent: t.agent ?? '',
                context_from: t.context_from ?? [],
                task: t.task,
                confidence: t.confidence,
                reason: t.reason,
              })),
            }
          : {}),
      });
      await Promise.all(
        parts.map((p, i) => {
          const t = plan[i];
          if (!t) return Promise.resolve();
          return runDecision(p.id, t, t.task ?? '', dry, prefs).catch((e: unknown) => {
            console.error(`route ${p.id} failed:`, errStack(e));
            setRoute(p.id, { status: 'error', error: errMsg(e) });
          });
        }),
      );
    } catch (e) {
      console.error(`route ${rid} failed:`, errStack(e)); // the message alone did not say where (2026-11-10)
      setRoute(rid, { status: 'error', error: errMsg(e) });
    }
  })();
  return rid;
}

// ---------- transcript tail (last reply / last prompt) ----------
/** A line of a Claude Code transcript (.jsonl): only the fields the server reads. */
interface TranscriptLine {
  type?: string;
  cwd?: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  timestamp?: string;
  message?: { content?: string | ({ type?: string; text?: string } | null)[] };
}
/** The text of a message: a string, or the text parts of a list joined with spaces. */
function messageText(content: NonNullable<TranscriptLine['message']>['content']): unknown {
  if (Array.isArray(content)) return content.map((x) => (x?.type === 'text' ? x.text : '')).join(' ');
  return content;
}
const tailCache = new Map<string, { mtime: number; v: TInfo }>();
function transcriptInfo(folder: string, sid: string): TInfo | null {
  if (!isUuid(sid)) return null;
  const file = path.join(PROJECTS, slugOf(folder), sid + '.jsonl');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const c = tailCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.v;
  const size = st.size;
  const len = Math.min(size, 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  let reply = '';
  let prompt = '';
  let title = '';
  let lastMsg = 0;
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0 && (!reply || !prompt || !title); i--) {
    let j: TranscriptLine;
    try {
      j = JSON.parse(lines[i] ?? '') as TranscriptLine;
    } catch {
      continue;
    }
    if (!title && j.type === 'custom-title' && has(j.customTitle)) title = j.customTitle;
    if (!title && j.type === 'ai-title' && has(j.aiTitle)) title = j.aiTitle;
    if (!prompt && j.type === 'last-prompt' && has(j.lastPrompt))
      prompt = j.lastPrompt.replace(/\s+/g, ' ').slice(0, 200);
    // time of the newest real message; Claude Code also writes bookkeeping lines (bridge-session,
    // cost-state, file-history-snapshot, …) that change the file time without a new message
    if (!lastMsg && (j.type === 'user' || j.type === 'assistant') && has(j.timestamp))
      lastMsg = Date.parse(j.timestamp) || 0;
    const m = j.message;
    if (!m) continue;
    const raw = messageText(m.content);
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!reply && j.type === 'assistant') reply = text.slice(0, 300);
    if (!prompt && j.type === 'user' && !/^<|^\[Request interrupted/.test(text)) prompt = text.slice(0, 200);
  }
  const v = { reply, prompt, title, mtime: st.mtimeMs, lastMsg };
  tailCache.set(file, { mtime: st.mtimeMs, v });
  return v;
}

function requireCodex(): void {
  const a = Codex.availability();
  if (!a.available) throw fail(a.reason ?? '');
}
/** The coding agents this panel can start (GET /api/agents). */
function agentsView(): object[] {
  const c = Codex.availability();
  return [
    { id: 'claude', name: 'Claude Code', available: true },
    {
      id: 'codex',
      name: 'Codex',
      available: c.available,
      ...(has(c.reason) ? { reason: c.reason } : {}),
      ...(has(c.version) ? { version: c.version } : {}),
    },
  ];
}

// ---------- history (previous sessions per folder) ----------
function readHead(file: string, bytes = 64 * 1024): string {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(bytes);
  const n = fs.readSync(fd, buf, 0, bytes, 0);
  fs.closeSync(fd);
  return buf.subarray(0, n).toString('utf8');
}
function summarize(file: string): { title: string; first: string; cwd: string } {
  let title = '';
  let first = '';
  let cwd = '';
  try {
    const head = readHead(file);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let j: TranscriptLine;
      try {
        j = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }
      if (!cwd && has(j.cwd)) cwd = j.cwd;
      if (j.type === 'custom-title' && has(j.customTitle)) title = j.customTitle;
      if (!first && j.type === 'user' && j.message) {
        const c = messageText(j.message.content);
        if (typeof c === 'string' && !/^<(local-command|command-|system)/.test(c.trim()))
          first = c.replace(/\s+/g, ' ').slice(0, 140);
      }
      if (first && cwd) break;
    }
  } catch {
    /* unreadable */
  }
  return { title, first, cwd };
}
interface HistoryItem {
  sid: string;
  mtime: number;
  title: string;
  first: string;
  agent: string;
}
/** Claude Code and Codex conversations of a folder, newest first (each item has `agent`). */
function history(folder: string): HistoryItem[] {
  let codex: HistoryItem[];
  try {
    codex = Codex.history(folder);
  } catch {
    codex = [];
  }
  return [...claudeHistory(folder).map((h) => ({ ...h, agent: 'claude' })), ...codex]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 30);
}
function claudeHistory(folder: string): { sid: string; mtime: number; title: string; first: string; cwd: string }[] {
  const dir = path.join(PROJECTS, slugOf(folder));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const p = path.join(dir, f);
      return { sid: f.slice(0, -6), mtime: fs.statSync(p).mtimeMs, file: p };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 25)
    .map(({ sid, mtime, file }) => ({ sid, mtime, ...summarize(file) }))
    .filter((x) => x.first || x.title);
}
function recentFolders(): { folder: string; mtime: number }[] {
  if (!fs.existsSync(PROJECTS)) return [];
  const res = new Map<string, number>();
  for (const d of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, d);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    const newest = files.map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
    if (!newest) continue;
    const { cwd } = summarize(path.join(dir, newest.f));
    if (!cwd || cwd.startsWith('/private/tmp') || cwd.startsWith('/tmp')) continue;
    if (INST.test && guardedFolder(cwd)) continue; // a verify app would ask for Desktop access on every run
    if (!fs.existsSync(cwd)) continue;
    const seen = res.get(cwd);
    if (seen === undefined || seen < newest.m) res.set(cwd, newest.m);
  }
  return [...res.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([folder, mtime]) => ({ folder, mtime }));
}

// ---------- actions ----------
async function findSession(id: unknown): Promise<Session | undefined> {
  await poll();
  return snapshot.sessions.find((s) => s.id === id);
}

// ---------- first-run setup wizard (lib/setup.ts) ----------
// An install that already has panel data counts as set up (existing users do not see the wizard).
type SetupState = ReturnType<typeof Setup.load>;
type BrainLocation = Setup.BrainLocation;
/** Devices the user put off with "Later": id -> when to ask again (ms). */
const cloudLater = (s: SetupState): Record<string, number> => (asObj(s['cloudLater']) ?? {}) as Record<string, number>;
function setupState(): SetupState {
  const s = Setup.load(INST.home);
  if (
    !s.done &&
    !fs.existsSync(path.join(INST.home, 'setup.json')) &&
    ['sessions.conf', 'routes.json'].some((f) => fs.existsSync(path.join(INST.home, f)))
  ) {
    s.done = true;
    s.step = 5;
    s['migrated'] = true;
    Setup.save(INST.home, s);
  }
  return s;
}
async function setupView(s = setupState()): Promise<object> {
  const loc = Setup.loadBrainLocation(INST.home);
  const cloud = loc ? await cloudSetupView(s, loc) : null;
  let brainOk: boolean | null;
  if (cloud) brainOk = cloud.up;
  else if (env('CC_PANEL_NO_BRAIN')) brainOk = null;
  else brainOk = await brainUp().catch(() => false);
  return {
    ...Devices.publicView(s),
    keepOn: { ack: s.keepOn, check: Setup.keepOnCheck() },
    // macOS permissions are not part of setup: Thoth asks for one only when a session needs it (onPermNeed)
    checks: Setup.checks({
      brainUp: brainOk,
      otherDevices: s.devices.some((d) => d.self !== true),
      cloudHost: cloud ? cloud.host : '',
    }),
    local: s.devices.find((d) => d.self === true)?.name,
    cloud,
  };
}
/** The cloud brain for the page: host, up, the devices by status (wants to join, connected,
 * ignored), this computer's own pushes, and the join commands. No tokens. */
async function cloudSetupView(
  s: SetupState,
  loc: BrainLocation,
): Promise<{ host: string; up: boolean } & Record<string, unknown>> {
  const host = new URL(loc.url).host;
  const me = cloudDevice();
  const view = {
    host,
    url: loc.url,
    up: false,
    error: '' as string | undefined,
    commands: Devices.cloudCommands(loc.url),
    self: {
      device: confDevice(me),
      joined: !!me,
      error: asText(s['cloudSelfError']),
      push: selfPush.last,
      pushing: selfPush.running,
    },
  };
  let devices: ReturnType<typeof Devices.cloudView> | null = null;
  try {
    const r = await brainRequest('GET', '/api/devices', null, { timeout: 15000 });
    const list = deviceArray(r.json);
    if (r.status === 200 && list) {
      view.up = true;
      if (me) LOCAL_DEVICE = confDevice(me);
      devices = Devices.cloudView(list, { later: cloudLater(s), selfName: confDevice(me) });
    } else
      view.error =
        r.status === 401 || r.status === 403
          ? Devices.connectError('refused').error
          : `The cloud brain answered with an error (${String(r.status)}).`;
  } catch (e) {
    view.error = Devices.connectError(Devices.errorKind(errCode(e)), host).error;
  }
  return { ...view, ...devices };
}
type ConnectLink = NonNullable<ReturnType<typeof Setup.parseConnectLink>>;
type ConnectProblem = ReturnType<typeof Devices.connectError>;
/** Check a connect link: health (is it a brain?) then an owner call (does it take the key?). */
async function checkCloudLink(link: unknown): Promise<{ fail: ConnectProblem } | { ok: ConnectLink }> {
  const p = Setup.parseConnectLink(link);
  if (!p) return { fail: Devices.connectError('link') };
  const target = { cloud: true, url: new URL(p.url), token: p.token };
  try {
    const h = await brainRequest('GET', '/api/health', null, { target, timeout: 15000 });
    if (h.status !== 200 || asObj(h.json)?.['ok'] !== true) return { fail: Devices.connectError('notbrain', p.host) };
    const d = await brainRequest('GET', '/api/devices', null, { target, timeout: 15000 });
    if (d.status === 401 || d.status === 403) return { fail: Devices.connectError('refused', p.host) };
    if (d.status !== 200 || !Array.isArray(d.json)) return { fail: Devices.connectError('notbrain', p.host) };
  } catch (e) {
    return { fail: Devices.connectError(Devices.errorKind(errCode(e)), p.host) };
  }
  return { ok: p };
}
/** The `error` of a brain reply, else its status ("status 500" when `withWord`). */
const replyError = (r: BrainReply, withWord = false): string =>
  asText(asObj(r.json)?.['error']) || (withWord ? `status ${String(r.status)}` : String(r.status));
/** This computer joins the cloud brain as the owner's own device: a pre-approved code made with
 * the owner token, then the normal join. The device token goes to cloud-device.json (0600). */
async function joinCloudSelf(s: SetupState, url: string, name?: string): Promise<string | null> {
  const self = s.devices.find((d) => d.self === true);
  const meName = name ?? self?.name ?? '';
  const old = cloudDevice();
  if (old && old.hub === url) return null; // already joined (a new link to the same brain)
  // the name can be taken (for example by an earlier connect of this Mac): then name-2, name-3, ...
  const code = (i: number): Promise<BrainReply> =>
    brainRequest('POST', '/api/codes', {
      device_name: i === 1 ? meName : `${meName.slice(0, 28)}-${String(i)}`,
    });
  let c = await code(1);
  for (let i = 2; i <= 5 && c.status === 409; i++) c = await code(i);
  const cj = asObj(c.json);
  const joinCode = asText(cj?.['code']);
  if (c.status !== 200 || !joinCode) return `The cloud brain did not make a code for this computer (${replyError(c)}).`;
  const target = { cloud: true, url: new URL(url), token: '' };
  const j = await brainRequest(
    'POST',
    '/api/join',
    { name: meName, os: self?.os, host: os.hostname(), code: joinCode },
    { target },
  );
  const jj = asObj(j.json);
  const token = asText(jj?.['token']);
  if (j.status !== 200 || !token) return `This computer could not join the cloud brain (${replyError(j)}).`;
  fs.rmSync(path.join(INST.home, 'cloud-device-collector-state.json'), { force: true });
  Setup.writeSecret(CLOUD_DEVICE_FILE, {
    hub: url,
    device: asText(jj?.['device']) || asText(cj?.['device']) || meName,
    token,
    mode: 'cloud',
  });
  return null;
}
// Step 5: what the brain has per device and the Claude sessions running outside the panel
// (lib/setup_outside.ts). Moving one in reuses actions.new (stops the outside interactive copy and
// resumes it here; a background job is attached, never stopped).
const isDir = (f: string): boolean => {
  try {
    return fs.statSync(f).isDirectory();
  } catch {
    return false;
  }
};
async function setupOutsideView(): Promise<object> {
  await scanElsewhere();
  const s = setupState();
  let brain: object | null = null;
  if (!env('CC_PANEL_NO_BRAIN')) {
    const t = brainTarget();
    try {
      const list = deviceArray(await brainCall('GET', '/api/devices'));
      if (!list) throw new Error('refused');
      // a cloud brain also lists devices that only asked to join, or were ignored: not part of the brain
      brain = {
        up: true,
        cloud: t.cloud,
        devices: SetupOutside.brainDevices(
          s.devices,
          list.filter((d) => !has(d.status) || d.status === 'approved'),
        ),
      };
    } catch {
      brain = t.cloud
        ? {
            up: false,
            cloud: true,
            error: `Your cloud brain at ${t.url.host} does not answer.`,
            fix: 'Check that the server is switched on, then reload this page.',
          }
        : {
            up: false,
            error: 'The brain is not answering on this computer.',
            fix: 'Start it: python3 brain/brain.py serve',
          };
    }
  }
  const titleOf = (folder: string, sid: string): string => {
    try {
      const t = transcriptInfo(folder, sid) ?? Codex.info(sid);
      return t ? t.title || t.prompt : '';
    } catch {
      return '';
    }
  };
  return {
    brain,
    outside: SetupOutside.outsideList(elsewhere, { exists: isDir, titleOf, home: HOME }),
    inPanel: snapshot.sessions.length,
  };
}
/** The computers of the brain for the All Devices page: the brain's list, plus what the page needs
 * to tell the user about a computer that went silent. A joined computer sends every 5 minutes;
 * `silent` = nothing for 20 minutes (it is off or asleep, or it cannot find the brain).
 * `reconnect` = this panel can make a new join command for it. null = the brain does not answer. */
async function deviceList(): Promise<object[] | null> {
  let list: BrainDevice[] | null;
  try {
    list = deviceArray(await brainCall('GET', '/api/devices'));
  } catch {
    return null;
  }
  if (!list) return null;
  const s = setupState();
  const cloud = !!Setup.loadBrainLocation(INST.home);
  const now = Date.now();
  return list
    .filter((d) => !has(d.status) || d.status === 'approved')
    .map((d) => {
      const sends = d.transport === 'push' || d.transport === 'cloud';
      const last = Number(d.last_sync ?? 0) * 1000;
      return {
        ...d,
        silent: sends && now - last > Devices.SILENT_MS,
        reconnect: !cloud && s.devices.some((x) => x.name === d.name && x.self !== true),
      };
    });
}
type Body = Record<string, unknown>;
function setupChange(fn: (s: SetupState, b: Body) => void): (body: Body) => Promise<object> {
  return async (body) => {
    const s = setupState();
    try {
      fn(s, body);
    } catch (e) {
      throw fail(errMsg(e));
    }
    Setup.save(INST.home, s);
    return setupView(s);
  };
}

/** Actions that answer only on the local listener (127.0.0.1), never to a remote client. */
const LOCAL_ONLY = new Set([
  'pairPhone',
  'pairPhoneOff',
  'pairPhoneStatus',
  'pairPhoneReload',
  'pairRelayOff',
  'pairRelayOn',
]);
/** "Away from home" for pairing: the relay's URL, its live state and why it is not
 * connected (lib/relay_client.ts status; the reason is one of the relay's keys), and whether the
 * user turned it off. */
function relayView(): object {
  const st = relayClient.status;
  const c = RelayConfig.readConfig(INST.home);
  return {
    url: c ? c.url : '',
    open: c?.open === true,
    state: c ? st.state : 'off',
    reason: c ? st.reason : '',
    error: c ? st.error : '',
    retryAt: c ? st.retryAt : 0,
    off: RelayConfig.isOff(INST.home),
    canTurnOn: !c && !!(RelayConfig.isOff(INST.home) || RelayConfig.defaultUrl()),
  };
}
/** The answer of pairPhone (and of pairRelayOn, which makes a new link). */
async function pairView(): Promise<object> {
  const p = Pairing.pairing(INST.home, { port: Number(env('CC_PANEL_REMOTE_PORT') || PORT) });
  syncRemote();
  return {
    on: true,
    reachable: p.reachable,
    link: p.link,
    name: p.name,
    hosts: p.hosts,
    port: p.port,
    pin: p.pin,
    wifi: p.lan.length > 0,
    tailscale: p.tailscale.length > 0,
    relay: p.relay ? p.relay.url : null,
    relayState: relayClient.status.state,
    relayInfo: relayView(),
    phoneSeen: remote.phoneSeen,
    firewall: Pairing.firewallView(await Firewall.blocksNode({ maxAge: 0 }), p), // the sheet opens: ask now
    ...(p.reachable
      ? {}
      : { message: `${Pairing.NO_NETWORK} ${Pairing.NO_NETWORK_FIX}, then choose pairing again.` }),
  };
}
// a pre-approved one-time code: the device joins at once, without "wants to join"
async function setupCloudCode(nameIn: unknown): Promise<{
  code: string;
  device: string;
  expires: number;
  commands: ReturnType<typeof Devices.cloudCommands>;
}> {
  const loc = Setup.loadBrainLocation(INST.home);
  if (!loc) throw new Error('This panel is not connected to a cloud brain');
  const name = asText(nameIn).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name))
    throw new Error(`Computer name "${name}" is not allowed: use small letters, digits and "-" (up to 31)`);
  const r = await brainRequest('POST', '/api/codes', { device_name: name });
  const rj = asObj(r.json);
  const code = asText(rj?.['code']);
  if (r.status !== 200 || !code) throw new Error(`The cloud brain did not make a code: ${replyError(r, true)}`);
  const expires = Number(rj?.['expires'] ?? 0) || Date.now() + Devices.CODE_TTL;
  return {
    code,
    device: name,
    expires: expires < 1e12 ? expires * 1000 : expires,
    commands: Devices.cloudCommands(loc.url, code, name),
  };
}
/** A new panel session (POST /api/new): a folder, optionally a session to resume, its agent. */
/** The fields of POST /api/new, as sent (checked here). */
interface NewSessionArgs {
  folder?: unknown;
  sid?: unknown;
  name?: unknown;
  mcp?: unknown;
  agent?: unknown;
}
async function newSession({
  folder,
  sid,
  name,
  mcp,
  agent,
}: NewSessionArgs): Promise<{ id: string; already?: boolean }> {
  if (typeof folder !== 'string' || !folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
    throw new Error('Folder not found');
  if (truthy(sid) && !isUuid(sid)) throw new Error('Bad session id');
  const sidText = isUuid(sid) ? sid : '';
  if (agent !== undefined && agent !== null && agent !== '' && !AGENTS.has(asText(agent)))
    throw new Error('Unknown agent');
  const label = (asText(name) || path.basename(folder)).slice(0, 30);
  if (agentOf(agent) === 'codex') {
    // a Codex conversation already open in the panel: show that window instead of a second copy
    requireCodex();
    if (sidText) {
      await poll();
      const open = snapshot.sessions.find((x) => x.sid === sidText && x.agent === 'codex' && x.running);
      if (open) return { id: open.id, already: true };
      // the conversation is open outside the panel: stop it there first, then resume it here
      await scanElsewhere();
      const out = elsewhere.get(sidText);
      if (out?.agent === 'codex') {
        try {
          process.kill(out.pid, 'SIGTERM');
        } catch {
          /* gone */
        }
        for (let i = 0; i < 50 && alive(out.pid); i++) await sleep(200);
        if (alive(out.pid))
          throw new Error(`The other Codex (pid ${String(out.pid)}) did not stop; close it there and try again`);
        elsewhere.delete(sidText);
      }
      const stopped = snapshot.sessions.find((x) => x.sid === sidText && x.agent === 'codex');
      if (stopped) {
        await tmux(['send-keys', '-t', stopped.id, 'C-l']);
        await startCodex(stopped.id, sidText);
        return { id: stopped.id };
      }
    }
    const id = await createWindow({ name: label, folder, sid: sidText, run: true, agent: 'codex' });
    return { id };
  }
  if (sidText) await scanElsewhere();
  const plan = sidText ? migrationPlan(elsewhere.get(sidText)) : { kind: 'none' as const };
  if (plan.kind === 'stop') {
    // the conversation is open outside the panel: stop it there first, then resume it here
    try {
      process.kill(plan.pid, 'SIGTERM');
    } catch {
      /* gone */
    }
    for (let i = 0; i < 50 && alive(plan.pid); i++) await sleep(200);
    if (alive(plan.pid))
      throw new Error(`The other Claude (pid ${String(plan.pid)}) did not stop; close it there and try again`);
  }
  if (plan.kind === 'attach') {
    const id = await createWindow({
      name: label,
      folder,
      sid: sidText,
      run: false,
      mcp: mcp === 'brain' ? 'brain' : '',
    });
    await migrateHere(id, sidText);
    return { id };
  }
  const id = await createWindow({ name: label, folder, sid: sidText, run: true, mcp: mcp === 'brain' ? 'brain' : '' });
  return { id };
}
type Action = (body: Body) => unknown;
const actions: Record<string, Action> = {
  /** "pairing" in the Mac app: turns remote access on and
   * returns the pairing link for the QR code. The same function as the pairing command (lib/pairing.ts);
   * it never makes a new token or certificate. Local only (LOCAL_ONLY, checked where actions run). */
  pairPhone() {
    return pairView();
  },
  /** "Away from home" off: the relay leaves the pairing link, the
   * client disconnects and the open relay tunnels end. Remembered: the default relay is not set up
   * again. The answer is the new link (Wi-Fi only). Local only. */
  pairRelayOff() {
    RelayConfig.turnOff(INST.home);
    return pairView();
  },
  /** "Away from home" on again: a new relay credential for the phone, so it must scan the new code.
   * Local only. */
  pairRelayOn() {
    if (!RelayConfig.turnOn(INST.home))
      throw fail('No relay to use: this Thoth has no default relay (CC_PANEL_RELAY_DEFAULT is empty).');
    return pairView();
  },
  /** "Turn off remote access" (as the pairing command's `--off`): the remote listeners close now, and the
   * phones that are connected are dropped. The token stays: turning it on again needs no new pairing. */
  pairPhoneOff() {
    Pairing.turnOff(INST.home);
    syncRemote();
    return { on: Remote.enabled(INST.home) }; // still on only when CC_PANEL_REMOTE=1 forces it
  },
  /** For the open "pairing: is remote access on, when did a paired phone last make a
   * request (ms; 0 = not since the server started), and does the macOS firewall block the phone
   * (lib/firewall.ts: the answer is kept for 5 s and read without blocking). It changes nothing. */
  async pairPhoneStatus() {
    return {
      on: Remote.enabled(INST.home),
      phoneSeen: remote.phoneSeen,
      relayInfo: relayView(),
      firewall: Pairing.firewallView(await Firewall.blocksNode(), Pairing.ways(INST.home)),
    };
  },
  /** The pairing command after it changed something (--rotate, --new-cert, --off, the relay): read the
   * files now, not at the next 30 s check. A new token or certificate ends the open remote
   * connections (`changed`: true). It makes nothing new and returns no secret. Local only. */
  pairPhoneReload() {
    const r = syncRemote();
    return { on: Remote.enabled(INST.home), changed: r.changed, closed: r.closed };
  },
  setupDevices: setupChange((s, b) => {
    Setup.setDevices(s, b['devices']);
  }),
  setupStep: setupChange((s, b) => {
    Setup.setStep(s, b['step']);
  }),
  setupBrain: setupChange((s, b) => {
    Setup.setBrain(s, asText(b['device']));
    Setup.clearBrainLocation(INST.home); // a computer is the brain again: forget the cloud brain
    syncDeviceListener();
  }),
  // step 3, cloud: paste the connect link; the panel checks it, keeps { url, owner_token } (0600),
  // and this computer joins the cloud brain and starts pushing its sessions
  async setupCloudConnect({ link }) {
    const r = await checkCloudLink(link);
    if ('fail' in r) throw fail(r.fail.error ?? '', 400, r.fail);
    Setup.saveBrainLocation(INST.home, { url: r.ok.url, owner_token: r.ok.token });
    const s = setupState();
    Setup.setCloud(s, r.ok.host);
    try {
      s['cloudSelfError'] = (await joinCloudSelf(s, r.ok.url)) ?? '';
    } catch (e) {
      s['cloudSelfError'] = `This computer could not join the cloud brain: ${errMsg(e)}`;
    }
    if (!truthy(s['cloudSelfError'])) delete s['cloudSelfError'];
    Setup.save(INST.home, s);
    syncDeviceListener();
    void pushSelf();
    return setupView(s);
  },
  // a device of the cloud brain: approve / ignore / unignore / revoke (the brain decides), or later (ask again)
  async setupCloudDevice({ id: idIn, decision: decisionIn }) {
    const id = asText(idIn);
    const decision = asText(decisionIn);
    if (!id || id.length > 100) throw new Error('No device given');
    if (!Setup.loadBrainLocation(INST.home)) throw new Error('This panel is not connected to a cloud brain');
    const s = setupState();
    if (decision === 'later') {
      s['cloudLater'] = { ...cloudLater(s), [id]: Date.now() + Devices.LATER_MS };
    } else if (['approve', 'ignore', 'unignore', 'revoke'].includes(decision)) {
      const r = await brainRequest('POST', `/api/devices/${encodeURIComponent(id)}/${decision}`, {});
      if (r.status !== 200)
        throw new Error(`The cloud brain did not ${decision} this computer: ${replyError(r, true)}`);
      if (truthy(s['cloudLater']))
        s['cloudLater'] = Object.fromEntries(Object.entries(cloudLater(s)).filter(([k]) => k !== id));
    } else throw new Error('Choose Approve, Ignore, Later, Unignore or Disconnect');
    Setup.save(INST.home, s);
    return setupView(s);
  },
  setupCloudCode({ name }) {
    return setupCloudCode(name);
  },
  setupKeepOn: setupChange((s, b) => {
    Setup.ackKeepOn(s, b['ack']);
  }),
  setupFinish: setupChange((s) => {
    Setup.finish(s);
  }),
  setupPair({ device }) {
    const s = setupState();
    if (s.brain === Setup.CLOUD)
      throw fail('Your brain is in the cloud: your other computers join it with the cloud join command');
    let p: ReturnType<typeof Devices.startPair>;
    try {
      p = Devices.startPair(s, asText(device));
    } catch (e) {
      throw fail(errMsg(e));
    }
    Setup.save(INST.home, s);
    syncDeviceListener();
    const addresses = hubAddresses();
    const first = addresses[0];
    if (first === undefined)
      throw fail('This computer has no local network or Tailscale address, so other devices cannot reach it');
    return { ...p, addresses, commands: Devices.commands(first, p.code, p.device) };
  },
  setupRevoke: setupChange((s, b) => {
    Devices.revoke(s, asText(b['device']));
  }),
  // ---- All Devices page: add or remove a computer at any time (lib/devices.ts) ----
  // Add: a one-time code and one command to run on the new computer. Works for a brain on this
  // computer (the computer joins this panel's device listener) and for a cloud brain.
  async deviceAdd({ name: nameIn, os: osIn }) {
    const name = asText(nameIn).trim().toLowerCase();
    const dos = asText(osIn).trim().toLowerCase();
    try {
      Devices.checkNewDevice(name, dos);
    } catch (e) {
      throw fail(errMsg(e));
    }
    const pick = (c: { windows: string; posix: string }): string => (dos === 'windows' ? c.windows : c.posix);
    if (Setup.loadBrainLocation(INST.home)) {
      let r: Awaited<ReturnType<typeof setupCloudCode>>;
      try {
        r = await setupCloudCode(name);
      } catch (e) {
        throw fail(errMsg(e));
      }
      return {
        mode: 'cloud',
        device: r.device,
        os: dos,
        code: r.code,
        expires: r.expires,
        command: pick(r.commands),
        firewall: null,
      };
    }
    const addresses = hubAddresses();
    const first = addresses[0];
    if (first === undefined)
      throw fail(
        'This computer has no local network or Tailscale address, so other computers cannot reach it. Connect it to your network, then try again',
      );
    let taken: string[] = [];
    try {
      const list = deviceArray(await brainCall('GET', '/api/devices'));
      if (list) taken = list.map((d) => d.name);
    } catch {
      /* the brain is down: the list in setup.json decides */
    }
    const s = setupState();
    let p: ReturnType<typeof Devices.addDevice>;
    try {
      p = Devices.addDevice(s, name, dos, taken);
    } catch (e) {
      throw fail(errMsg(e));
    }
    Setup.save(INST.home, s);
    syncDeviceListener();
    const fw = Setup.checks({ otherDevices: true }).find((c) => c.id === 'firewall' && !c.ok);
    return {
      mode: 'local',
      device: p.device,
      os: dos,
      code: p.code,
      expires: p.expires,
      command: pick(Devices.commands(first, p.code, p.device)),
      firewall: fw ? { cause: fw.cause, fix: fw.fix } : null,
    };
  },
  // Has the computer joined, and has the brain got its sessions? (the Add sheet asks every 2 s)
  async deviceStatus({ name: nameIn }) {
    const name = asText(nameIn);
    if (Setup.loadBrainLocation(INST.home)) {
      const list = await brainCall('GET', '/api/devices').catch(() => []);
      const d = (deviceArray(list) ?? []).find(
        (x) => x.name === name && ((x.status ?? '') || 'approved') === 'approved',
      );
      return {
        joined: !!d,
        sessions: d ? Number(d.sessions ?? 0) : 0,
        pushed: d !== undefined && (truthy(d.last_seen) || truthy(d.last_sync)),
      };
    }
    const d = setupState().devices.find((x) => x.name === name && x.self !== true);
    return {
      joined: d?.connected === true,
      sessions: d ? Number(d['sessions'] ?? 0) : 0,
      pushed: truthy(d?.['lastSeen']),
      lastSeen: d ? Number(d['lastSeen'] ?? 0) : 0,
      waiting: !!(d?.pair && d.pair.expires > Date.now()),
    };
  },
  // A computer that stopped sending (it cannot find this computer, or it was set up again): a new
  // one-time command for it. Its sessions in the brain stay. Only for a brain on this computer; a
  // cloud brain has a fixed address, so its computers do not lose it.
  deviceReconnect({ name: nameIn }) {
    const name = asText(nameIn).trim();
    if (Setup.loadBrainLocation(INST.home))
      throw fail(
        'Your brain is in the cloud. Its address does not change; check that the other computer is on and online',
      );
    const addresses = hubAddresses();
    const first = addresses[0];
    if (first === undefined)
      throw fail(
        'This computer has no local network or Tailscale address, so other computers cannot reach it. Connect it to your network, then try again',
      );
    const s = setupState();
    let p: ReturnType<typeof Devices.reconnect>;
    try {
      p = Devices.reconnect(s, name);
    } catch (e) {
      throw fail(errMsg(e));
    }
    const dos = s.devices.find((d) => d.name === name)?.os;
    Setup.save(INST.home, s);
    syncDeviceListener();
    const c = Devices.commands(first, p.code, p.device);
    const fw = Setup.checks({ otherDevices: true }).find((x) => x.id === 'firewall' && !x.ok);
    return {
      mode: 'local',
      device: p.device,
      os: dos,
      code: p.code,
      expires: p.expires,
      since: Date.now(),
      command: dos === 'windows' ? c.windows : c.posix,
      firewall: fw ? { cause: fw.cause, fix: fw.fix } : null,
    };
  },
  // Remove: the computer can no longer send data (token gone), and the brain deletes its sessions
  // and memory files. Nothing on the removed computer itself changes.
  async deviceRemove({ name: nameIn }) {
    const name = asText(nameIn).trim();
    if (!name || name.length > 100) throw fail('No computer given');
    const s = setupState();
    const me = cloudDevice();
    if (
      s.devices.some((d) => d.self === true && d.name === name) ||
      (me !== null && confDevice(me) === name) ||
      name === LOCAL_DEVICE
    )
      throw fail('This computer cannot be removed from its own panel');
    const cloud = !!Setup.loadBrainLocation(INST.home);
    // a test instance (verify) that talks to the user's own brain must never delete from it
    if (INST.test && !cloud && !env('CC_BRAIN_PORT'))
      throw fail('A test instance cannot remove a computer from your real brain');
    const before = JSON.stringify(s.devices);
    let listed: ReturnType<typeof Devices.removeDevice>;
    try {
      listed = Devices.removeDevice(s, name);
    } catch (e) {
      throw fail(errMsg(e));
    }
    const keep = (): void => {
      if (JSON.stringify(s.devices) !== before) {
        Setup.save(INST.home, s);
        syncDeviceListener();
      }
    };
    let r: BrainReply;
    try {
      r = await brainRequest('POST', '/api/devices/remove', { name });
    } catch {
      throw fail(
        cloud
          ? 'Your cloud brain does not answer, so nothing was removed. Try again when it is up'
          : 'The brain is not answering on this computer, so nothing was removed. Start it, then try again',
        502,
      );
    }
    const msg = replyError(r, true);
    if (r.status === 200) {
      keep();
      const rj = asObj(r.json);
      return {
        ok: true,
        device: name,
        sessions: Number(rj?.['sessions'] ?? 0),
        memories: Number(rj?.['memories'] ?? 0),
      };
    }
    if (r.status === 404 && /no device called/.test(msg)) {
      if (!listed) throw fail(`There is no computer called "${name}"`, 404);
      keep();
      return { ok: true, device: name, sessions: 0, memories: 0 }; // listed, but it never sent anything
    }
    if (r.status === 404) {
      // a brain from before this feature: it can disconnect, not delete
      if (cloud) {
        const list = await brainCall('GET', '/api/devices').catch(() => []);
        const d = (deviceArray(list) ?? []).find((x) => x.name === name && has(x.id));
        if (d && has(d.id)) await brainRequest('POST', `/api/devices/${encodeURIComponent(d.id)}/revoke`, {});
        keep();
        return {
          ok: true,
          device: name,
          partial: true,
          note: `"${name}" is disconnected, but your cloud brain is an older version and kept its sessions. Update the brain on the server, then remove "${name}" again.`,
        };
      }
      throw fail(
        'The brain on this computer is an older version and cannot remove a computer. Restart the brain, then try again',
        409,
      );
    }
    throw fail(`The brain did not remove "${name}": ${msg}`, r.status === 409 ? 400 : 502);
  },
  // guided fixes (lib/setup_fix.ts): open System Settings, a password prompt, or Terminal, on THIS Mac
  async setupFix({ id }) {
    const r = await SetupFix.runFix(asText(id), { app: Permissions.lastApp() });
    Firewall.forget(); // a fix may have changed the firewall: the next check asks again
    return r;
  },
  async setupMoveIn({ sid }) {
    if (!isUuid(sid)) throw new Error('Bad session id');
    await scanElsewhere();
    const args = SetupOutside.moveInArgs(elsewhere.get(sid), isDir);
    const { id } = await newSession(args);
    return { id, sid, name: args.name };
  },
  upload({ name, data }) {
    // web panel and remote client: base64 image or document -> a file in the attachments folder
    const { path: file } = Attachments.saveUpload(ATTACH_DIR, { name, data } as Attachments.Upload);
    return { path: file };
  },
  async highlight({ code, lang }) {
    if (typeof code !== 'string' || code.length > 200000) throw new Error('Bad code');
    return { html: await highlight(code, asText(lang)) };
  },
  // Take over a Claude Code or Codex session that runs in another terminal (VS Code etc.).
  // The panel prepares a window and resumes the conversation as soon as the
  // outside process has exited, so one conversation never runs in two places.
  async adopt({ sid, folder, pid, name, agent: agentIn }) {
    if (!isUuid(sid)) throw new Error('Bad session id');
    if (agentIn !== undefined && agentIn !== null && agentIn !== '' && !AGENTS.has(asText(agentIn)))
      throw new Error('Unknown agent');
    const agent = agentOf(agentIn);
    if (agent === 'codex') {
      requireCodex();
      if (!has(Codex.rolloutFile(sid))) throw new Error(`No Codex conversation ${sid} in ~/.codex/sessions`);
    }
    if (typeof folder !== 'string' || !folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
      throw new Error('Folder not found');
    const outside = Number(pid);
    if (!Number.isInteger(outside) || outside <= 1) throw new Error('Bad pid');
    await poll();
    const s = snapshot.sessions.find((x) => x.sid === sid);
    if (s?.running === true) return { id: s.id, already: true };
    let id = s?.id;
    if (!has(id)) {
      const info = agent === 'codex' ? Codex.info(sid) : transcriptInfo(folder, sid);
      const label = (asText(name) || (info ? info.title : '') || path.basename(folder)).slice(0, 30);
      id = await createWindow({ name: label, folder, sid, run: false, agent });
    }
    adoptions.set(id, { sid, pid: outside, until: Date.now() + 120000, agent });
    watchAdoptions();
    return { id };
  },
  testScope({ ids, ttlSec }) {
    if (!Array.isArray(ids) || !ids.length) {
      testScope = null;
      return { scope: null };
    }
    testScope = {
      ids: new Set(ids.map((x) => asText(x))),
      until: Date.now() + Math.min(Number(ttlSec) || 600, 1800) * 1000,
    };
    return { scope: [...testScope.ids], until: testScope.until };
  },
  // `folder`, `agent`: what the user chose for a NEW session (the phone's New task sheet). Used only
  // when the request starts a new session; a request that goes to an existing session ignores them.
  route({ text: textIn, dry, attachments, folder, agent }) {
    const text = withAttachments(textOrNull(textIn), attachments);
    if (!text) throw new Error('Empty request');
    const prefs: NewSessionPrefs = {};
    if (folder !== undefined && folder !== null && folder !== '') {
      if (typeof folder !== 'string' || !isDir(folder)) throw new Error('Folder not found');
      prefs.folder = folder;
    }
    if (agent !== undefined && agent !== null && agent !== '') {
      if (typeof agent !== 'string' || !AGENTS.has(agent)) throw new Error('Unknown agent');
      if (agent === 'codex') requireCodex();
      prefs.agent = agent;
    }
    return { routeId: route(text, truthy(dry), prefs) };
  },
  async routeTo({ routeId, target, folder: folderIn, name, agent }) {
    const r = routes.find((x) => x.id === routeId);
    if (!r) throw new Error('Request not found');
    let id = asText(target);
    if (!id) {
      const folder = asText(folderIn) || defaultFolder(); // "New session" without a folder choice
      if (!fs.existsSync(folder)) throw new Error('Folder not found');
      if (agentOf(agent) === 'codex') requireCodex();
      id = await createWindow({
        name: taskName(asText(name) || r.newName, r.text),
        folder,
        sid: '',
        run: true,
        agent: asText(agent),
      });
      await poll();
    }
    const ts = snapshot.sessions.find((x) => x.id === id);
    setRoute(r.id, { decided: 'manual', reason: `You chose ${ts ? ts.name : 'a new session'}.`, choices: [] });
    await deliver(id, r.task ?? r.text, r.id);
    return { id };
  },
  // A Claude Code command from the Ask box ("/compact", "/code-review high"). The user chose where it
  // runs: `target` (a session) or a new session in `folder` (none = the default folder). It never
  // goes through the router and gets no background text: the session must get the command as typed.
  async command({ text: textIn, target, folder: folderIn, attachments }) {
    const text = withAttachments(textOrNull(textIn), attachments); // files become arguments of the command
    const keys = Commands.typed(text);
    const cmd = Commands.parse(text);
    if (keys === null || cmd === null) throw new Error('Not a command. A command starts with /name');
    await poll();
    let id = asText(target);
    let name = 'a new session';
    let folder = '';
    if (id) {
      const s = snapshot.sessions.find((x) => x.id === id);
      if (!s) throw new Error('No such session');
      if (agentOf(s.agent) === 'codex') throw new Error('Claude Code commands do not run in a Codex session');
      name = s.name;
    } else {
      folder = asText(folderIn) || defaultFolder();
      if (!isDir(folder)) throw new Error('Folder not found');
      id = await createWindow({ name: taskName('', `/${cmd.name}`), folder, sid: '', run: true, agent: 'claude' });
      await poll();
    }
    const rid = nextRouteId();
    routes.unshift({ id: rid, ts: Date.now(), text: text.trim(), status: 'routing', command: true });
    setRoute(rid, { decided: 'manual', reason: `You chose ${name}.`, ...(folder ? { folder } : {}) });
    await deliver(id, keys, rid);
    return { routeId: rid, id };
  },
  // Queue a message for a session: sent when Claude there is ready (e.g. after the
  // folder-trust prompt). Used by cross-device handoff (brain/handoff.py --run panel).
  // `attachments`: files a remote client uploaded first (only files in the attachments folder).
  async queue({ id, text: textIn, attachments }) {
    const text = withAttachments(textOrNull(textIn), attachments, { onlyIn: ATTACH_DIR });
    if (!text) throw new Error('Empty message');
    await poll();
    await deliver(asText(id), text, null);
    return {};
  },
  dismissRoute({ routeId }) {
    routes = routes.filter((x) => x.id !== routeId);
    saveRoutes();
    snapshot.routes = routes.slice(0, 30);
    broadcast();
    return {};
  },
  new(body) {
    return newSession(body);
  },
  async start({ id }) {
    const s = await findSession(id);
    if (!s) throw new Error('No such session');
    if (s.running) return {};
    if (s.state === 'elsewhere' && (await migrateHere(s.id, s.sid))) return {};
    await tmux(['send-keys', '-t', s.id, 'C-l']);
    await startAgent(s.id, isUuid(s.sid) ? s.sid : '', s.agent);
    return {};
  },
  async interrupt({ id }) {
    await tmux(['send-keys', '-t', asText(id), 'Escape']);
    return {};
  },
  async choose({ id, n }) {
    const s = await findSession(id);
    if (!s || !s.options.length) throw new Error('No choice is waiting');
    const screen = (await tmux(['capture-pane', '-p', '-J', '-t', s.id])) ?? '';
    const cur = screenOf(s.agent).parse(screen).selected ?? 0;
    const target = Number(n);
    if (!s.options.some((o) => o.n === target)) throw new Error('Bad option');
    // positions in the list (Codex numbers its options; Claude's are 1..n already)
    const pos = (k: number): number => s.options.findIndex((o) => o.n === k) + 1;
    const delta = pos(target) - (cur > 0 ? Math.max(1, pos(cur)) : 1);
    const key = delta > 0 ? 'Down' : 'Up';
    for (let i = 0; i < Math.abs(delta); i++) {
      await tmux(['send-keys', '-t', s.id, key]);
      await sleep(40);
    }
    await tmux(['send-keys', '-t', s.id, 'Enter']);
    pollSoon(300);
    return {};
  },
  async send({ id: idIn, text, attachments }) {
    const id = asText(idIn);
    const full = withAttachments(textOrNull(text), attachments);
    if (!full) throw new Error('Empty message');
    // the chat shows the message now, not when Claude writes it to the transcript (after its prompt hooks)
    const shown =
      asText(text).trim() ||
      (Array.isArray(attachments) ? attachments : []).map((p) => path.basename(asText(p))).join(' ');
    const echo: Echo = { text: shown, at: Date.now(), phase: 'sending' };
    echoes.set(id, [...(echoes.get(id) ?? []), echo]);
    const typed = await tmux(['send-keys', '-t', id, '-l', '--', full.replace(/\r?\n/g, ' ')]);
    if (typed === null) {
      echoes.set(
        id,
        (echoes.get(id) ?? []).filter((x) => x !== echo),
      );
      return {};
    }
    await sleep(80);
    await tmux(['send-keys', '-t', id, 'Enter']);
    return {};
  },
  async rename({ id: idIn, name }) {
    const id = asText(idIn);
    if (typeof name !== 'string' || !name.trim()) throw new Error('Empty name');
    const n = name.trim().slice(0, 30);
    // @label is the user's name; it survives programs that rename tmux windows
    await tmux(['set-option', '-w', '-t', id, '@label', n]);
    await tmux(['rename-window', '-t', id, n]);
    return {};
  },
  // AI tidy (lib/tidy.ts): which sessions to close. Only a suggestion; the app ticks them in select mode.
  async tidy({ keep }) {
    await poll();
    const list = snapshot.sessions;
    if (!list.length) return { sessions: [] };
    const answer = await Tidy.runTidy(list);
    return { sessions: Tidy.normalize(answer, list, Array.isArray(keep) ? keep.map((k) => asText(k)) : []) };
  },
  async close({ id: idIn }) {
    const id = asText(idIn);
    const s = await findSession(id);
    if (s?.running === true) {
      await tmux(['send-keys', '-t', id, 'Escape']);
      await sleep(150);
      await tmux(['send-keys', '-t', id, '-l', '--', s.agent === 'codex' ? '/quit' : '/exit']);
      // Codex opens its command list first; an Enter sent at once is lost (a test run)
      await sleep(600);
      await tmux(['send-keys', '-t', id, 'Enter']);
      for (let i = 0; i < 25; i++) {
        await sleep(200);
        const cmd = ((await tmux(['display-message', '-p', '-t', id, '#{pane_current_command}'])) ?? '').trim();
        if (SHELLS.has(cmd)) break;
      }
    }
    // the last window: keep the session with a 'home' shell, so closing every session does not
    // end the tmux session (a missing session is rebuilt from windows.json as after a crash)
    if (Restore.isLastWindow(await tmux(['list-windows', '-t', S, '-F', '#{window_id}']), id)) {
      await tmux(['new-window', '-d', '-t', `${S}:`, '-n', 'home', '-c', HOME]);
    }
    await tmux(['kill-window', '-t', id]);
    return {};
  },
  async pickFolder() {
    const out = await new Promise<string>((r) => {
      execFile(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Choose a project folder for Claude Code")'],
        (e, o) => {
          r(e ? '' : o);
        },
      );
    });
    return { folder: out.trim().replace(/\/$/, '') };
  },
  reveal({ folder, app }) {
    if (typeof folder !== 'string' || !fs.existsSync(folder)) throw new Error('Folder not found');
    // only a folder of a session on this Mac: `open` launches an app or script it is given, and a
    // helper computer's session (lib/peer.ts) names folders of another computer
    if (!snapshot.sessions.some((s) => s.folder === folder) || !fs.statSync(folder).isDirectory())
      throw new Error('Not a folder of a session on this Mac');
    const args = app === 'code' ? ['-a', 'Visual Studio Code', folder] : [folder];
    execFile('open', args);
    return {};
  },
};

// ---------- http ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};
const STATIC: Record<string, string> = {
  '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
  '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js',
  '/vendor/marked-katex.js': 'node_modules/marked-katex-extension/lib/index.umd.js',
  '/vendor/katex.js': 'node_modules/katex/dist/katex.min.js',
  '/vendor/katex.css': 'node_modules/katex/dist/katex.min.css',
  '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js',
  '/vendor/mermaid.js': 'node_modules/mermaid/dist/mermaid.min.js',
};
const STATIC_DIRS: Record<string, string> = { '/vendor/fonts/': 'node_modules/katex/dist/fonts/' };

// The web UI is TypeScript (public/*.ts). A request for /x.js gets public/x.ts with its types
// stripped (node:module stripTypeScriptTypes, the same stripping Node does for the server's own
// files): no build step and no build output. Cached until the file changes.
const browserCode = new Map<string, { mtime: number; code: string }>();
function browserScript(tsFile: string): string {
  const mtime = fs.statSync(tsFile).mtimeMs;
  const hit = browserCode.get(tsFile);
  if (hit?.mtime === mtime) return hit.code;
  const code = stripTypeScriptTypes(fs.readFileSync(tsFile, 'utf8'), { mode: 'strip' });
  browserCode.set(tsFile, { mtime, code });
  return code;
}

// chat items for one session, read from its transcript
type Chat = ReturnType<typeof Codex.chat>;
type ChatFile = InstanceType<typeof TranscriptFile> & { out?: Chat };
const chatCache = new Map<string, ChatFile>();
function chatFor(win: string): Chat | null {
  const s = snapshot.sessions.find((x) => x.id === win);
  if (!s) return null;
  if (!isUuid(s.sid)) return { sid: '', mtime: 0, items: [] };
  if (s.agent === 'codex') return Codex.chat(s.sid);
  const file = path.join(PROJECTS, slugOf(s.folder), s.sid + '.jsonl');
  // the file is read as it grows: a change costs the new lines only (lib/chat.ts TranscriptFile)
  let t = chatCache.get(file);
  if (!t) {
    t = new TranscriptFile(file, { limit: 300 });
    chatCache.set(file, t);
  }
  let r: ReturnType<ChatFile['read']>;
  try {
    r = t.read();
  } catch {
    chatCache.delete(file);
    return { sid: s.sid, mtime: 0, items: [] };
  }
  if (t.out?.items !== r.items) t.out = { sid: s.sid, mtime: r.mtime, items: r.items };
  return t.out;
}

// the phone's chat revisions per transcript (GET /api/chat?media=1&rev=); the 50 used last
/** A chat item as the phone gets it (lib/media.ts phoneView): every item keeps its id. */
type PhoneItem = Record<string, unknown> & { id: string };
const chatRevisions = new Map<string, ChatRevisions<PhoneItem>>();
function revisionsFor(sid: string): ChatRevisions<PhoneItem> {
  let r = chatRevisions.get(sid);
  if (r) chatRevisions.delete(sid);
  else r = new ChatRevisions<PhoneItem>();
  chatRevisions.set(sid, r);
  if (chatRevisions.size > 50) {
    const oldest = chatRevisions.keys().next();
    if (oldest.done !== true) chatRevisions.delete(oldest.value);
  }
  return r;
}

// the phone's view of a chat (lib/media.ts): images by id, file cards, tool details; cached per items array
type PhoneView = ReturnType<typeof Media.phoneView>;
const phoneViews = new WeakMap<object, PhoneView>();
function phoneViewFor(c: Chat): PhoneView {
  let v = phoneViews.get(c.items);
  if (!v) {
    v = Media.phoneView(c.items, { home: os.homedir(), allowDirs: [ATTACH_DIR] });
    phoneViews.set(c.items, v);
  }
  return v;
}
// headers for a served file or image: never run as a page on this server's origin (an HTML or SVG
// file that Claude wrote could otherwise call the panel's actions)
const SAFE_FILE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
};
const SAFE_IMAGE_MIME = /^image\/(png|jpeg|gif|webp|heic|heif)$/;

/** Copies the open file `fd` to a private temp file and calls fn(copy); the copy is removed after. */
async function withCopy<T>(fd: number, ext: string, fn: (copy: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfile-'));
  const copy = path.join(dir, 'f.' + ext);
  try {
    const out = fs.openSync(copy, 'w', 0o600);
    const buf = Buffer.alloc(1 << 20);
    let n: number;
    let pos = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      fs.writeSync(out, buf, 0, n);
      pos += n;
    }
    fs.closeSync(out);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  try {
    return await fn(copy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sendThumb(res: http.ServerResponse, file: string): void {
  res.writeHead(200, {
    'Content-Type': file.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    'Cache-Control': 'private, max-age=86400',
    ...SAFE_FILE_HEADERS,
  });
  fs.createReadStream(file).pipe(res);
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function sendEmpty(res: http.ServerResponse, code: number): void {
  res.writeHead(code);
  res.end();
}
/** The JSON error answer of a failed action. */
function errorReply(e: unknown): { error: string; problem?: unknown } {
  const extra = e instanceof Error && 'extra' in e ? e.extra : undefined;
  return { error: errMsg(e), ...(extra !== undefined && extra !== null ? { problem: extra } : {}) };
}
const LOCAL_ADDRESS = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const fromThisMac = (req: http.IncomingMessage): boolean => LOCAL_ADDRESS.test(req.socket.remoteAddress ?? '');
/** Requests that came in through a remote listener or the relay (a remote client). */
const viaRemote = new WeakSet<http.IncomingMessage>();

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${String(PORT)}`);
  // Central brain (brain.json's cloud URL, else brain/brain.py on 127.0.0.1:7879): sessions from every device.
  // Read-only proxy so the app talks to one port. GET /api/brain/<x> -> /api/<x>; POST /api/brain/sync.
  if (url.pathname.startsWith('/api/brain/')) {
    const origin = req.headers.origin;
    if (req.method === 'POST' && has(origin) && !ORIGINS.has(origin)) {
      sendJson(res, 403, { error: 'Bad origin' });
      return;
    }
    const sub = url.pathname.slice('/api/brain/'.length);
    if (!/^(health|devices|projects|sessions|sync|handoffs|handoff)$/.test(sub)) {
      sendJson(res, 404, { error: 'Unknown brain path' });
      return;
    }
    const isPost = sub === 'sync' || sub === 'handoff';
    if (isPost !== (req.method === 'POST')) {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    // the brain's tokens stay on this machine; the server adds them for the app (local brain: the
    // write token on POSTs; cloud brain: the owner token on every call, see brainOptions)
    const target = brainTarget();
    const { request, opts } = brainOptions(target, req.method ?? 'GET', `/api/${sub}${url.search}`, 60000);
    const preq = request(opts, (pres) => {
      res.writeHead(pres.statusCode ?? 502, { 'Content-Type': 'application/json' });
      pres.pipe(res);
    });
    preq.on('error', () => {
      sendJson(res, 503, {
        error: target.cloud
          ? `Your cloud brain at ${target.url.host} does not answer.`
          : 'Central brain is not running. Start it: python3 brain/brain.py serve',
      });
    });
    preq.on('timeout', () => preq.destroy());
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
        if (body.length > 1e5) req.destroy();
      });
      req.on('end', () => {
        if (sub === 'handoff') {
          // tell the brain which panel to open the session in (this server)
          try {
            const j = asObj(JSON.parse(body || '{}')) ?? {};
            j['panel_url'] = `http://${HOST}:${String(PORT)}`;
            body = JSON.stringify(j);
          } catch {
            body = '{}';
          }
        }
        preq.end(body);
      });
      return;
    }
    preq.end();
    return;
  }
  // Claude Code hooks of the panel's sessions (lib/claude_args.ts stateHooks): only from this Mac
  if (req.method === 'POST' && url.pathname === '/api/hook') {
    if (!fromThisMac(req) || has(req.headers.origin)) {
      sendJson(res, 403, { error: 'Local hooks only' });
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      let payload: Json;
      try {
        payload = asObj(JSON.parse(body || '{}')) ?? {};
      } catch {
        payload = {};
      }
      const event = (url.searchParams.get('event') ?? '') || asText(payload['hook_event_name']);
      const pane = asText(req.headers['x-pane']);
      onHook(event, pane, payload as HookPayload).catch(() => undefined);
      onPermNeed(event, pane, payload as HookPayload).catch(() => undefined);
      sendJson(res, 200, {});
    });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (has(origin) && !ORIGINS.has(origin)) {
      sendJson(res, 403, { error: 'Bad origin' });
      return;
    }
    let body = '';
    // an upload carries a file (base64, up to 20 MB); every other action is small
    const max = url.pathname === '/api/upload' ? Attachments.MAX_UPLOAD_BODY + 4096 : 1e6;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      body += c.toString();
      if (body.length > max) {
        tooLarge = true;
        body = '';
        res.on('finish', () => req.destroy());
        sendJson(res, 413, {
          error: url.pathname === '/api/upload' ? 'The file is larger than 20 MB' : 'Request too large',
        });
      }
    });
    req.on('end', () => {
      void (async () => {
        if (tooLarge) return;
        const name = url.pathname.slice(5);
        const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
        if (!action) {
          sendJson(res, 404, { error: 'Unknown action' });
          return;
        }
        // fixes act on this Mac's screen (System Settings, password prompt): only for a request from this Mac
        if (name === 'setupFix' && !fromThisMac(req)) {
          sendJson(res, 403, { error: 'Fixes run only from this computer' });
          return;
        }
        // the pairing secrets and the remote access switch are only for this Mac's own app or page:
        // never for a request that came in through a remote listener or the relay (viaRemote)
        if (LOCAL_ONLY.has(name) && (viaRemote.has(req) || !fromThisMac(req))) {
          sendJson(res, 403, { error: 'Pairing runs only on this computer' });
          return;
        }
        try {
          const parsed: unknown = body ? JSON.parse(body) : {};
          const args = asObj(parsed) ?? {};
          // a session on a helper computer (lib/peer.ts): the action goes to that computer
          if (Peer.isRemoteId(args['id'])) {
            const r = await peerAction(name, args);
            sendJson(res, r.status, r.json);
            return;
          }
          const result = await action(args);
          pollSoon(200);
          sendJson(res, 200, result ?? {});
        } catch (e) {
          sendJson(res, 400, errorReply(e));
        }
      })();
    });
    return;
  }
  if (url.pathname === '/api/history') {
    sendJson(res, 200, history(url.searchParams.get('folder') ?? ''));
    return;
  }
  if (url.pathname === '/api/folders') {
    sendJson(res, 200, recentFolders());
    return;
  }
  if (url.pathname === '/api/agents') {
    sendJson(res, 200, agentsView());
    return;
  }
  // the Ask box's command list: Claude Code's commands for a new session (the default folder) and
  // for the folders of the open Claude sessions (lib/commands.ts)
  if (url.pathname === '/api/commands') {
    const folders = snapshot.sessions
      .filter((s) => agentOf(s.agent) !== 'codex' && isDir(s.folder))
      .map((s) => s.folder);
    try {
      sendJson(res, 200, { commands: await commandLists.list(defaultFolder(), folders) });
    } catch (error) {
      sendJson(res, 200, { commands: [], error: errMsg(error) });
    }
    return;
  }
  if (url.pathname === '/api/state') {
    sendJson(res, 200, stateOut());
    return;
  }
  if (url.pathname === '/api/setup') {
    sendJson(res, 200, await setupView());
    return;
  }
  if (url.pathname === '/api/deviceList') {
    sendJson(res, 200, await deviceList());
    return;
  }
  if (url.pathname === '/api/setupOutside') {
    sendJson(res, 200, await setupOutsideView());
    return;
  }
  // the app's permission guide checks the state here (PermissionGuide.swift)
  if (url.pathname === '/api/permissions') {
    sendJson(res, 200, { checks: Permissions.checks(await Permissions.state({ tmuxArgs: INST.tmuxArgs })) });
    return;
  }
  if (url.pathname === '/api/setupDiagnostics') {
    const brainOk = env('CC_PANEL_NO_BRAIN') ? null : await brainUp().catch(() => false);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(Setup.diagnostics({ home: INST.home, logFile: path.join(INST.home, 'server.log'), brainUp: brainOk }));
    return;
  }
  if (url.pathname === '/' && !setupState().done) {
    res.writeHead(302, { Location: '/setup.html' });
    res.end();
    return;
  }
  if (Peer.READS.has(url.pathname) && Peer.isRemoteId(url.searchParams.get('win'))) {
    await peerRead(url, res);
    return;
  }
  if (url.pathname === '/api/chat') {
    const win = url.searchParams.get('win') ?? '';
    const c = chatFor(win);
    if (!c) {
      sendJson(res, 404, { error: 'No such session' });
      return;
    }
    const waiting = echoesFor(win, c.items);
    if (Number(url.searchParams.get('since')) === c.mtime && c.mtime) {
      sendJson(res, 200, { unchanged: true, mtime: c.mtime, pending: waiting });
      return;
    }
    // media=1 (a remote client): base64 images replaced by ids, file cards and tool details (lib/media.ts)
    if (url.searchParams.get('media') === '1') {
      // rev=<token of the client's last answer>: only the items changed since then (lib/chat.ts ChatRevisions)
      const items = phoneViewFor(c).items as PhoneItem[];
      const revs = revisionsFor(c.sid).update(items);
      const rev = url.searchParams.get('rev');
      const changed = rev === null ? null : revs.since(rev);
      if (changed) {
        sendJson(res, 200, {
          sid: c.sid,
          mtime: c.mtime,
          rev: revs.token,
          delta: true,
          first: items[0]?.id ?? '',
          items: changed,
          pending: waiting,
        });
        return;
      }
      sendJson(res, 200, { sid: c.sid, mtime: c.mtime, rev: revs.token, items, pending: waiting });
      return;
    }
    sendJson(res, 200, { ...c, pending: waiting });
    return;
  }
  if (url.pathname === '/api/media') {
    // an image of this session's transcript by its content id (GET /api/chat?media=1); size=thumb: small JPEG
    const c = chatFor(url.searchParams.get('win') ?? '');
    const m = c ? phoneViewFor(c).media.get(url.searchParams.get('id') ?? '') : undefined;
    if (!m) {
      sendJson(res, 404, { error: 'No such image in this session' });
      return;
    }
    const id = Media.mediaId(m.b64);
    const mime = SAFE_IMAGE_MIME.test(m.mime) ? m.mime : 'application/octet-stream';
    const data = Buffer.from(m.b64, 'base64');
    const full = (): void => {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': data.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
        ...SAFE_FILE_HEADERS,
      });
      res.end(data);
    };
    const px = url.searchParams.get('size') === 'thumb' ? Number(url.searchParams.get('px')) || 480 : 0;
    const dim = Media.imageSize(data);
    if (!px || data.length < 48 * 1024 || (dim && Math.max(dim.w, dim.h) <= px)) {
      full();
      return;
    }
    const src = path.join(Thumb.CACHE, `media-${id}.${((mime.split('/')[1] ?? '') || 'png').replace('jpeg', 'jpg')}`);
    try {
      if (!fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(src), { recursive: true });
        fs.writeFileSync(src, data);
      }
    } catch {
      full();
      return;
    }
    Thumb.imageThumb(src, px).then((out) => {
      sendThumb(res, out);
    }, full);
    return;
  }
  if (url.pathname === '/api/file') {
    // a file this session's transcript names (attached, sent, written, read, or a path in Claude's text),
    // of an allowed type, not hidden or secret, a regular file (lib/media.ts checkFile)
    const c = chatFor(url.searchParams.get('win') ?? '');
    if (!c) {
      sendJson(res, 404, { error: 'No such session' });
      return;
    }
    // check=1 (the Mac app, before it opens a file Claude sent): only a sent file; its real path and
    // whether to open it or show it in Finder, no content (lib/media.ts checkOpen)
    if (url.searchParams.get('check') === '1') {
      const k = Media.checkOpen(
        url.searchParams.get('path') ?? '',
        (p) => wasSentFile(c.items, p),
        phoneViewFor(c).named,
        { home: os.homedir(), allowDirs: [ATTACH_DIR] },
      );
      if ('error' in k) sendJson(res, k.code, { error: k.error });
      else sendJson(res, 200, k);
      return;
    }
    const r = Media.checkFile(url.searchParams.get('path') ?? '', phoneViewFor(c).named, {
      home: os.homedir(),
      allowDirs: [ATTACH_DIR],
    });
    if ('error' in r) {
      sendJson(res, r.code, { error: r.error });
      return;
    }
    const thumbPx = url.searchParams.get('thumb');
    const ext = Media.extOf(r.real);
    if (has(thumbPx)) {
      const image = Media.IMAGE_EXT.has(ext);
      const id = `${r.real}\0${String(r.mtime)}\0${String(r.size)}`;
      const hit = Thumb.cachedThumb(id, thumbPx, image);
      if (hit) {
        fs.close(r.fd, () => undefined);
        sendThumb(res, hit);
        return;
      }
      // the preview is made from a private copy of the opened file, never from the path again
      withCopy(r.fd, ext, (copy) =>
        (image ? Thumb.imageThumb(copy, thumbPx, id) : Thumb.thumbnail(copy, thumbPx, id)).then((out) => {
          sendThumb(res, out);
        }),
      )
        .catch(() => {
          sendJson(res, 404, { error: 'No preview' });
        })
        .finally(() => {
          fs.close(r.fd, () => undefined);
        });
      return;
    }
    // HTML, SVG and XML go out as plain text: the phone shows them by the file's name, a browser never runs them
    const mime = /^(text\/html|image\/svg|text\/xml)/.test(r.mime) ? 'text/plain; charset=utf-8' : r.mime;
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': r.size,
      'Cache-Control': 'private, max-age=60',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(r.real))}`,
      ...SAFE_FILE_HEADERS,
    });
    // with an fd, the path argument is not used
    fs.createReadStream('', { fd: r.fd, autoClose: true }).pipe(res);
    return;
  }
  if (url.pathname === '/api/toolResult') {
    // the whole result (and written text, diff) of one tool call, for the phone's "Show all"
    const c = chatFor(url.searchParams.get('win') ?? '');
    const id = url.searchParams.get('id') ?? '';
    let t: ToolBlock | null = null;
    for (const it of c?.items ?? []) for (const b of blocksOf(it)) if (b.type === 'tool' && b.id === id) t = b;
    if (!t) {
      sendJson(res, 404, { error: 'No such tool call' });
      return;
    }
    const input = asObj(t.input) ?? {};
    const out: { result: unknown; write?: string; patch?: unknown[] } = {
      result: typeof t.fullResult === 'string' ? t.fullResult : truthy(t.result) ? t.result : '',
    };
    const content = input['content'];
    if (t.name === 'Write' && typeof content === 'string') out.write = content.slice(0, 512 * 1024);
    const sp = asObj(t.toolUseResult)?.['structuredPatch'];
    if (Array.isArray(sp))
      out.patch = (sp as PatchHunk[]).slice(0, 200).map((h) => ({
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: (h.lines ?? []).slice(0, 5000),
      }));
    sendJson(res, 200, out);
    return;
  }
  if (url.pathname === '/api/thumb') {
    // first-page preview of an attached document (attachments folder only)
    const p = path.resolve(url.searchParams.get('path') ?? '');
    if (!p.startsWith(ATTACH_DIR + path.sep) || !ATTACH_EXT.test(p)) {
      sendEmpty(res, 403);
      return;
    }
    Thumb.thumbnail(p, url.searchParams.get('size') ?? undefined).then(
      (png) => {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
        fs.createReadStream(png).pipe(res);
      },
      () => {
        sendEmpty(res, 404);
      },
    );
    return;
  }
  if (url.pathname === '/api/sent') {
    // an image that the session's Claude sent with SendUserFile; no other path is served
    const c = chatFor(url.searchParams.get('win') ?? '');
    const p = path.resolve(url.searchParams.get('path') ?? '');
    if (!c || !IMAGE_EXT.test(p) || !wasSent(c.items, p)) {
      sendEmpty(res, 403);
      return;
    }
    fs.readFile(p, (err, data) => {
      if (err) {
        sendEmpty(res, 404);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/' + path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg'),
        'Cache-Control': 'max-age=3600',
      });
      res.end(data);
    });
    return;
  }
  if (url.pathname === '/api/attachment') {
    // only files in the attachments folder are served
    const p = path.resolve(url.searchParams.get('path') ?? '');
    if (!p.startsWith(ATTACH_DIR + path.sep) || !IMAGE_EXT.test(p)) {
      sendEmpty(res, 403);
      return;
    }
    fs.readFile(p, (err, data) => {
      if (err) {
        sendEmpty(res, 404);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/' + path.extname(p).slice(1).replace('jpg', 'jpeg'),
        'Cache-Control': 'max-age=3600',
      });
      res.end(data);
    });
    return;
  }

  const dirKey = Object.keys(STATIC_DIRS).find((k) => url.pathname.startsWith(k));
  const dirPath = dirKey === undefined ? undefined : STATIC_DIRS[dirKey];
  const staticPath = STATIC[url.pathname];
  let file: string;
  if (dirPath !== undefined) file = path.join(ROOT, dirPath, path.basename(url.pathname));
  else if (staticPath !== undefined) file = path.join(ROOT, staticPath);
  else file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(ROOT)) {
    sendEmpty(res, 403);
    return;
  }
  // a browser script of the web UI: public/<name>.ts, served as JavaScript
  const tsFile = file.endsWith('.js') && file.startsWith(PUBLIC + path.sep) ? file.slice(0, -3) + '.ts' : '';
  if (tsFile && fs.existsSync(tsFile)) {
    let code: string;
    try {
      code = browserScript(tsFile);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`cannot serve ${path.basename(tsFile)}: ${errMsg(e)}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(code);
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}
type ChatItem = Chat['items'][number];
/** A tool call of an assistant message, with the fields /api/toolResult reads. */
interface ToolBlock {
  type: string;
  id?: string;
  name?: string;
  result?: unknown;
  fullResult?: unknown;
  input?: unknown;
  toolUseResult?: unknown;
}
interface PatchHunk {
  oldStart?: number;
  newStart?: number;
  lines?: string[];
}
/** The blocks of a chat item (assistant messages have them; user messages do not). */
const blocksOf = (it: ChatItem): ToolBlock[] => ('blocks' in it ? (it.blocks as ToolBlock[]) : []);
const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

// ---------- websockets ----------
const stateClients = new Set<WebSocket>();
function broadcast(): void {
  const msg = JSON.stringify({ type: 'state', ...stateOut() });
  for (const ws of stateClients) if (ws.readyState === 1) ws.send(msg);
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
  const origin = req.headers.origin;
  if (origin === undefined || !ORIGINS.has(origin)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/** A WebSocket message as text. */
const messageString = (raw: Buffer | ArrayBuffer | Buffer[]): string => {
  if (Buffer.isBuffer(raw)) return raw.toString();
  if (Array.isArray(raw)) return Buffer.concat(raw).toString();
  return Buffer.from(raw).toString();
};

let viewSeq = 0;
wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${String(PORT)}`);
  if (url.pathname === '/ws/state') {
    stateClients.add(ws);
    ws.send(JSON.stringify({ type: 'state', ...stateOut() }));
    ws.on('close', () => stateClients.delete(ws));
    return;
  }
  if (url.pathname === '/ws/term') {
    // the raw terminal is for this Mac's own page only: never for a remote client (a remote client
    // has no terminal view; the remote upgrade handler refuses it before this point)
    if (viaRemote.has(req)) {
      ws.close(1008, 'local only');
      return;
    }
    const win = url.searchParams.get('win') ?? '';
    if (!/^@\d+$/.test(win)) {
      ws.close();
      return;
    }
    const cols = Math.max(20, Math.min(500, Number(url.searchParams.get('cols')) || 120));
    const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 40));
    // A grouped session gives this view its own current window without moving other viewers.
    const view = `ccview-${String(process.pid)}-${String(++viewSeq)}`;
    const term = pty.spawn(
      'tmux',
      [
        ...INST.tmuxArgs,
        'new-session',
        '-t',
        S,
        '-s',
        view,
        ';',
        'set-option',
        '-t',
        view,
        'destroy-unattached',
        'on',
        ';',
        'set-option',
        '-t',
        view,
        'status',
        'off',
        ';',
        'set-option',
        '-t',
        view,
        'mouse',
        'on',
        ';',
        'set-option',
        '-t',
        view,
        'history-limit',
        '50000',
        ';',
        'select-window',
        '-t',
        `${view}:${win}`,
      ],
      {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: HOME,
        env: { ...process.env, TERM: 'xterm-256color', LANG: env('LANG') || 'en_US.UTF-8' },
      },
    );
    term.onData((d) => {
      if (ws.readyState === 1) ws.send(d);
    });
    term.onExit(() => {
      try {
        ws.close();
      } catch {
        /* closed */
      }
    });
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const msg = messageString(raw);
      if (msg.startsWith('\x00resize:')) {
        const [c, r] = msg.slice(8).split(',').map(Number);
        if (c !== undefined && r !== undefined && c > 0 && r > 0) term.resize(Math.min(c, 500), Math.min(r, 200));
        return;
      }
      term.write(msg);
    });
    ws.on('close', () => {
      try {
        term.kill();
      } catch {
        /* gone */
      }
      void tmux(['kill-session', '-t', view]);
    });
    return;
  }
  ws.close();
});

// ---------- main ----------
ensureSession();
// Clean up view sessions left by processes that are gone. View sessions carry their
// owner's pid (ccview-<pid>-<n> from a server, ccview-native-<pid> from the app);
// several servers and apps can run at once (e.g. a worktree's dev copy), so only
// kill views whose owner is dead.
void (async () => {
  const out = (await tmux(['list-sessions', '-F', '#{session_name}'])) ?? '';
  // only views of servers that are gone: another server may share this tmux server
  for (const s of out.split('\n')) {
    const m = /^ccview-(?:native-)?(\d+)/.exec(s);
    if (m && !alive(Number(m[1]))) await tmux(['kill-session', '-t', s]);
  }
})();
void tmux(['set-option', '-g', '-t', S, 'history-limit', '50000']);
setInterval(() => {
  void poll();
}, 1500);
setInterval(() => {
  void scanElsewhere();
}, 5000);
void scanElsewhere().then(poll);
server.listen(PORT, HOST, () => {
  console.log(`thoth on http://${HOST}:${String(PORT)}`);
});

// ---------- remote access for a remote client ----------
// Off by default. When on, extra listeners bind ONLY to private LAN addresses (TLS only, with this
// install's self-signed certificate that the phone pins) and Tailscale addresses (TLS or plain), and
// every request / WebSocket needs the pairing token (the pairing command prints the pairing link).
const remote = { token: '', pin: '', phoneSeen: 0 };
function remoteGate(req: http.IncomingMessage): boolean {
  if (!Remote.authorized(req, remote.token)) return false;
  remote.phoneSeen = Date.now(); // pairing shows that a phone connected
  // never pass the token on (e.g. to the brain proxy, which forwards the query string)
  const u = new URL(req.url ?? '/', 'http://x');
  u.searchParams.delete('token');
  req.url = u.pathname + (u.search || '');
  return true;
}
const remoteListeners = createRemoteListeners({
  handler: (req, res) => {
    if (!remoteGate(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    viaRemote.add(req);
    void handleRequest(req, res);
  },
  upgrade: (req, socket, head) => {
    if (!remoteGate(req)) {
      socket.destroy();
      return;
    }
    viaRemote.add(req);
    // no raw terminal for a remote client (LAN TLS, Tailscale, relay), with the token too: the
    // phone works through the actions (queue, send, choose, interrupt), not a shell on the Mac
    if (new URL(req.url ?? '/', 'http://x').pathname === '/ws/term') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  },
  log: (m) => {
    console.log(m);
  },
});
// away from home: an outbound connection to the user's relay (lib/relay_client.ts, <home>/relay.json);
// relay tunnels go into the same TLS server, token required as on the LAN
const relayClient = RelayConfig.createRelayClient({
  connect: (stream) => remoteListeners.connect(stream),
  log: (m) => {
    console.log(m);
  },
});
/** Match the listeners, the token, the certificate and the relay to the files in the panel home.
 * A token or a certificate that is not the one of the last check (`pair.ts --rotate`, `--new-cert`)
 * ends every open remote connection: a WebSocket that was authorized with the old token must not
 * stay open (a lost phone). The listeners stay. Returns { changed, closed }. */
function syncRemote(): { changed: boolean; closed: number } {
  // a helper computer (setup role "helper", lib/peer.ts): reachable through the relay only, always
  const helper = isHelper();
  if (helper) {
    try {
      Pairing.turnOn(INST.home);
      RelayConfig.ensureDefault(INST.home);
    } catch (e) {
      console.log(`helper: cannot set up the relay: ${errMsg(e)}`);
    }
  }
  if (!Remote.enabled(INST.home)) {
    remoteListeners.closeAll();
    relayClient.sync(INST.home, false);
    return { changed: false, closed: 0 };
  }
  const token = Remote.loadToken(INST.home);
  let cert: ReturnType<typeof Remote.loadCert> | null = null;
  try {
    cert = Remote.loadCert(INST.home);
  } catch (e) {
    console.log(`remote TLS certificate: ${errMsg(e)}`);
  }
  const changed =
    (remote.token !== '' && token !== remote.token) || (remote.pin !== '' && !!cert && cert.pin !== remote.pin);
  remote.token = token;
  if (cert) {
    remoteListeners.setCert(cert);
    remote.pin = cert.pin;
  }
  let closed = 0;
  if (changed) {
    closed = remoteListeners.dropConnections();
    relayClient.dropTunnels();
    console.log(`remote access: new pairing token or certificate; closed ${String(closed)} open connection(s)`);
  }
  const port = Number(env('CC_PANEL_REMOTE_PORT') || PORT);
  // a helper opens no listener on any address: devices reach each other only through the cloud
  void remoteListeners.sync(
    Peer.listenPlanFor(
      helper,
      Remote.listenPlan(os.networkInterfaces(), {
        testHost: process.env['CC_PANEL_REMOTE_TEST_HOST'],
        testLanHost: process.env['CC_PANEL_REMOTE_TEST_LAN_HOST'],
      }),
    ),
    port,
  );
  relayClient.sync(INST.home, true);
  return { changed, closed };
}
syncRemote();
setInterval(syncRemote, 30000);

// ---------- remote panel (lib/peer.ts, brain/peers.py; multi-device plan PR 4) ----------
// A helper computer seals its pairing link to the main panel's key and leaves it on the brain; the
// main panel (the one with the owner token) opens it and reaches the helper through the relay, TLS
// pinned, like a remote client. No LAN address, no open port, no SSH.
function isHelper(): boolean {
  return setupState()['role'] === 'helper';
}
/** This computer as a cloud device: the panel's own device file, else the device agent's. */
function helperIdentity(): { hub: string; token: string } | null {
  const own = cloudIdentity();
  const c = own ? own.conf : (readJson(AGENT_DEVICE_FILE) as Devices.DeviceConf | null);
  const hub = asText(c?.hub),
    token = asText(c?.token);
  return c?.mode === 'cloud' && /^https?:\/\//.test(hub) && token ? { hub, token } : null;
}
const peerLog = { last: '' };
function peerNote(text: string): void {
  if (text === peerLog.last) return;
  peerLog.last = text;
  console.log('remote panel: ' + text);
}
const published = { key: '', at: 0, skipUntil: 0 };
/** Helper: put this computer's link, sealed to each main panel's key, on the brain (when it changed,
 * and every 10 minutes). */
async function publishPeerLink(now = Date.now()): Promise<void> {
  if (!isHelper() || env('CC_PANEL_NO_BRAIN') || now < published.skipUntil) return;
  const id = helperIdentity();
  const relay = RelayConfig.pairingInfo(INST.home);
  if (!id || !relay || !remote.token || !remote.pin) return;
  const target: BrainTarget = { cloud: true, url: new URL(id.hub), token: id.token };
  try {
    const k = await brainRequest('GET', '/api/peer/keys', null, { target, timeout: 15000 });
    if (k.status === 404) {
      published.skipUntil = now + 10 * 60_000;
      peerNote(`the brain at ${target.url.host} has no remote panel API (an older brain)`);
      return;
    }
    const keys = asObj(k.json)?.['keys'];
    if (k.status !== 200 || !Array.isArray(keys)) throw new Error(`the brain answered ${String(k.status)}`);
    const link = Remote.pairingLink({
      hosts: [],
      port: PORT,
      pin: remote.pin,
      token: remote.token,
      relay,
      name: COMPUTER,
    });
    const key = crypto
      .createHash('sha256')
      .update(link + Peer.keysFingerprint(keys as { id?: unknown }[]))
      .digest('hex');
    if (key === published.key && now - published.at < 10 * 60_000) return;
    const sealed = Peer.sealFor(keys as { id?: unknown; key?: unknown }[], link);
    const r = await brainRequest('POST', '/api/peer/link', { sealed }, { target, timeout: 15000 });
    if (r.status !== 200) throw new Error(`the brain answered ${String(r.status)}`);
    published.key = key;
    published.at = now;
    peerNote(`link for ${String(Object.keys(sealed).length)} main panel(s) on ${target.url.host}`);
  } catch (e) {
    peerNote(`cannot publish the link: ${errMsg(e)}`);
  }
}
const peerFetch = { skipUntil: 0 };
/** Main panel: post this panel's public key, read the helpers' sealed links, connect to each. */
async function syncPeers(now = Date.now()): Promise<void> {
  const loc = Setup.loadBrainLocation(INST.home);
  if (!loc || env('CC_PANEL_NO_BRAIN') || isHelper()) {
    peerSet.sync([]);
    return;
  }
  if (now < peerFetch.skipUntil) return;
  try {
    const kp = Peer.loadKeyPair(INST.home);
    // the key on every round: the brain drops keys that were not posted for a while (and the 8th
    // newest), so a panel that was away gets its key back at once
    const k = await brainRequest('POST', '/api/peer/key', { key: kp.pub }, { timeout: 15000 });
    if (k.status === 404) {
      peerFetch.skipUntil = now + 10 * 60_000;
      peerNote(`the brain has no remote panel API (an older brain)`);
      return;
    }
    if (k.status !== 200) throw new Error(`the brain answered ${String(k.status)}`);
    const r = await brainRequest('GET', `/api/peer/links?key=${Peer.keyId(kp.pub)}`, null, { timeout: 15000 });
    const links = asObj(r.json)?.['links'];
    if (r.status !== 200 || !Array.isArray(links)) throw new Error(`the brain answered ${String(r.status)}`);
    const self = confDevice(cloudDevice());
    const list: { device: string; link: string }[] = [];
    for (const x of links) {
      const o = asObj(x);
      const device = asText(o?.['device']);
      const link = Peer.open(kp, asText(o?.['blob']));
      if (device && device !== self && link !== null && Peer.parseLink(link)) list.push({ device, link });
    }
    peerSet.sync(list);
    peerNote(`${String(list.length)} helper computer(s)`);
  } catch (e) {
    peerNote(`cannot read the helpers: ${errMsg(e)}`);
  }
}
const PEER_EVERY = Number(env('CC_PANEL_PEER_EVERY_MS')) || 60_000;
setInterval(() => {
  void publishPeerLink();
  void syncPeers();
}, PEER_EVERY).unref();
setTimeout(() => {
  void publishPeerLink();
  void syncPeers();
}, 2500).unref();

/** An action for a helper's session: sent to that helper with its own window id. */
async function peerAction(name: string, args: Json): Promise<{ status: number; json: unknown }> {
  const d = Peer.decideAction(name, args);
  if (!d.forward) return { status: d.status, json: { error: d.error } };
  const p = peerSet.get(d.device);
  if (!p) return { status: 400, json: { error: `${d.device} is not one of your helper computers` } };
  try {
    const r = await p.request('POST', d.path, d.body);
    p.pollNow();
    let json: unknown;
    try {
      json = JSON.parse(r.body.toString() || '{}');
    } catch {
      json = { error: `${d.device} answered ${String(r.status)}` };
    }
    return { status: Peer.replyStatus(r.status), json };
  } catch (e) {
    return { status: 502, json: { error: `${d.device} does not answer: ${errMsg(e)}` } };
  }
}
/** A chat read for a helper's session (GET /api/chat, /api/media, /api/toolResult): from that helper. */
async function peerRead(url: URL, res: http.ServerResponse): Promise<void> {
  const rid = Peer.parseRemoteId(url.searchParams.get('win'));
  const p = rid ? peerSet.get(rid.device) : undefined;
  if (!rid || !p) {
    sendJson(res, 404, { error: 'No such session' });
    return;
  }
  const pathQ = Peer.readPath(url.pathname, url.searchParams, rid.id);
  if (pathQ === null) {
    // /api/file?check=1 answers a path to open: a path on the helper is never opened on this Mac
    sendJson(res, 403, { error: `This file is on ${rid.device}` });
    return;
  }
  try {
    const r = await p.request('GET', pathQ);
    // a fixed content type, sandboxed: nothing of the helper runs as a page on this Mac's origin
    res.writeHead(Peer.readStatus(r.status), Peer.readHeaders(r.type));
    res.end(r.body);
  } catch (e) {
    sendJson(res, 502, { error: `${rid.device} does not answer: ${errMsg(e)}` });
  }
}

// ---------- device listener (lib/devices.ts) ----------
// Other devices join with a one-time code and push their sessions with their own token. Bound to
// private LAN and Tailscale addresses only, and only while setup lists other devices. It serves
// nothing else: no panel, no state.
const DEVICE_PORT = Number(env('CC_PANEL_DEVICE_PORT') || 7870);
const devListen = new Map<string, http.Server>();
const joinFails: number[] = [];
const proveHits: number[] = [];
function deviceListenAddresses(): string[] {
  const test = env('CC_PANEL_DEVICE_TEST_HOST');
  return test ? [test] : Devices.deviceAddresses(os.networkInterfaces());
}
/** Every address a device can reach this computer on, now ("ip:port"; Tailscale first). A device
 * keeps the list, so it has more than one way back when one address changes. */
function hubAddresses(): string[] {
  return deviceListenAddresses().map((a) => `${a}:${String(DEVICE_PORT)}`);
}
function readBody(req: http.IncomingMessage, max: number): Promise<Body> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(asObj(JSON.parse(Buffer.concat(chunks).toString() || '{}')) ?? {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}
/** Drop the times older than a minute from a rate-limit list. */
function forgetOld(list: number[], now: number): void {
  while (list.length && (list[0] ?? now) < now - 60_000) list.shift();
}
const DEVICE_FILES: Record<string, string> = {
  '/join.sh': 'device/join.sh',
  '/join.ps1': 'device/join.ps1',
  '/device/collector.py': 'brain/collector.py',
  '/device/device_agent.py': 'device/device_agent.py',
};
/** The brain's answer to /api/ingest (or the error of the call). */
interface Ingest {
  error?: string;
  sessions?: number;
  updated?: unknown;
  dialogue?: unknown;
}
async function deviceRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const served = DEVICE_FILES[url.pathname];
  if (req.method === 'GET' && served !== undefined) {
    let body = fs.readFileSync(path.join(ROOT, served), 'utf8');
    if (url.pathname.startsWith('/join.')) body = body.replace('__HUB__', `http://${String(req.headers.host)}`);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/join') {
    const now = Date.now();
    forgetOld(joinFails, now);
    if (joinFails.length >= 10) {
      sendJson(res, 429, { error: 'Too many wrong codes; wait a minute' });
      return;
    }
    let b: Body;
    try {
      b = await readBody(req, 10_000);
    } catch (e) {
      sendJson(res, 400, { error: errMsg(e) });
      return;
    }
    const s = setupState();
    const r = Devices.redeem(s, b['code'], b['host']);
    if (!r) {
      joinFails.push(now);
      sendJson(res, 403, { error: 'The code is wrong, used or expired. Make a new one on the setup page' });
      return;
    }
    Setup.save(INST.home, s);
    console.log(`device joined: ${r.device}`);
    sendJson(res, 200, { ...r, addresses: hubAddresses() });
    return;
  }
  // "Are you the brain I joined?" (lib/devices.ts prove). A device asks this before it sends its
  // token, and when it looks for this computer on a new address. Nothing secret is in the answer.
  if (req.method === 'POST' && url.pathname === '/api/hub/prove') {
    const now = Date.now();
    forgetOld(proveHits, now);
    if (proveHits.length >= 600) {
      sendJson(res, 429, { error: 'Too many requests; wait a minute' });
      return;
    }
    proveHits.push(now);
    let b: Body;
    try {
      b = await readBody(req, 2_000);
    } catch (e) {
      sendJson(res, 400, { error: errMsg(e) });
      return;
    }
    const proof = Devices.prove(setupState(), asText(b['device']), b['nonce']);
    if (!has(proof)) {
      sendJson(res, 403, { error: 'refused: this device is unknown here' });
      return;
    }
    sendJson(res, 200, { proof, addresses: hubAddresses() });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/device/push') {
    const s = setupState();
    const d = Devices.byToken(s, Remote.requestToken(req));
    if (!d) {
      sendJson(res, 403, { error: 'refused: this device is revoked or unknown; pair again from the setup page' });
      return;
    }
    let b: Body;
    try {
      b = await readBody(req, 50_000_000);
    } catch (e) {
      sendJson(res, 400, { error: errMsg(e) });
      return;
    }
    const ingest = async (): Promise<Ingest | null> =>
      (await brainCall('POST', '/api/ingest', { device: d.name, doc: b['doc'] ?? {} }).catch((e: unknown) => ({
        error: errMsg(e),
      }))) as Ingest | null;
    let r = await ingest();
    if (r && /token/.test(r.error ?? '')) r = await ingest();
    if (!r || has(r.error)) {
      sendJson(res, 502, { error: `the brain did not accept the data: ${r?.error ?? 'no answer'}` });
      return;
    }
    const s2 = setupState();
    const d2 = s2.devices.find((x) => x.name === d.name);
    if (d2) {
      d2['sessions'] = r.sessions;
      d2['lastSeen'] = Date.now();
      Setup.save(INST.home, s2);
    }
    sendJson(res, 200, {
      ok: true,
      sessions: r.sessions,
      updated: r.updated,
      dialogue: truthy(r.dialogue),
      addresses: hubAddresses(),
    });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}
function syncDeviceListener(): void {
  const st = setupState(); // a cloud brain: other computers connect out to it, never to this one
  const want = st.devices.some((d) => d.self !== true) && st.brain !== Setup.CLOUD ? deviceListenAddresses() : [];
  for (const [ip, srv] of devListen)
    if (!want.includes(ip)) {
      srv.close();
      devListen.delete(ip);
    }
  for (const ip of want) {
    if (devListen.has(ip)) continue;
    const srv = http.createServer((req, res) => {
      deviceRequest(req, res).catch((e: unknown) => {
        sendJson(res, 500, { error: errMsg(e) });
      });
    });
    srv.on('error', (e) => {
      console.log(`device listener ${ip}:${String(DEVICE_PORT)}: ${e.message}`);
      devListen.delete(ip);
    });
    srv.listen(DEVICE_PORT, ip, () => {
      console.log(`device listener on ${ip}:${String(DEVICE_PORT)} (join + push only)`);
    });
    devListen.set(ip, srv);
  }
}
syncDeviceListener();
setInterval(syncDeviceListener, 30000);
