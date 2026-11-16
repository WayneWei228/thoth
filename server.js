// thoth server: a mouse-friendly web UI over a tmux session ("cc") that holds
// Claude Code sessions. tmux keeps sessions alive; this server only watches and
// controls them. Binds to 127.0.0.1 only.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const INST = require('./lib/instance').instance();
const { claudeArgs, stateHooks } = require('./lib/claude_args');
const HookState = require('./lib/hookstate');
const Codex = require('./lib/codex');
const AGENTS = new Set(['claude', 'codex']);
const agentOf = (a) => (a === 'codex' ? 'codex' : 'claude');
const PORT = INST.port;
const BRAIN_PORT = Number(process.env.CC_BRAIN_PORT || 7879);
const HOST = '127.0.0.1';
const S = 'cc';
const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const CONF = path.join(INST.home, 'sessions.conf');
const PUBLIC = path.join(__dirname, 'public');
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

// ---------- helpers ----------
function tmux(args) {
  return new Promise((resolve) => {
    execFile('tmux', [...INST.tmuxArgs, ...args], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
  });
}
function tmuxSync(args) {
  try { return execFileSync('tmux', [...INST.tmuxArgs, ...args], { encoding: 'utf8' }); } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Claude Code names a project folder after the folder's real path (symlinks
// resolved, e.g. /var -> /private/var), so resolve before building the slug.
const slugOf = (folder) => {
  let real = folder;
  try { real = fs.realpathSync(folder); } catch { /* folder gone: use as given */ }
  return real.replace(/[^A-Za-z0-9]/g, '-');
};
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s || '');
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', '-zsh', 'login']);

// ---------- bootstrap tmux session ----------
async function waitForPrompt(target) {
  for (let i = 0; i < 40; i++) {
    const t = await tmux(['capture-pane', '-p', '-t', target]);
    if (t && t.trim()) return;
    await sleep(200);
  }
}

async function createWindow({ name, folder, sid, run = true, mcp = '', agent = 'claude' }) {
  agent = agentOf(agent);
  // One tmux command list: the window never exists without its options. (Separate set-option
  // calls let a poll see a Codex window without @agent and treat it as Claude: a flaky user
  // journey under load, 2026-11-10.) A unique temporary name targets it inside the list.
  const tmp = `cc-new-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const t = `${S}:=${tmp}`;
  const opts = [['@folder', folder], ['@label', name], ['@created', String(Math.floor(Date.now() / 1000))],
    ...(sid ? [['@sid', sid]] : []), ...(mcp === 'brain' ? [['@mcp', 'brain']] : []), ...(agent === 'codex' ? [['@agent', 'codex']] : [])];
  const out = await tmux(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${S}:`, '-n', tmp, '-c', folder,
    ...opts.flatMap(([k, v]) => [';', 'set-option', '-w', '-t', t, k, v]), ';', 'rename-window', '-t', t, name]);
  if (!out) throw new Error('tmux new-window failed');
  const id = out.trim();
  await waitForPrompt(id);
  await tmux(['send-keys', '-t', id, 'C-l']);
  if (run) {
    // the delivery queue must not start Claude a second time while this one boots
    starting.add(id); setTimeout(() => starting.delete(id), 30000);
    await startAgent(id, sid, agent);
  }
  return id;
}

// Every session the panel starts gets the central brain (architecture):
// the brain MCP tools and a UserPromptSubmit hook that sends each prompt through the brain
// first, so the brain can add context. Passed with --mcp-config / --settings: the user's
// own Claude config is not changed. Files are written by `brain.py session-files`.
const BRAIN_DIR = process.env.CC_BRAIN_DIR || path.join(HOME, '.config', 'cc-brain');
const brainToken = () => { try { return fs.readFileSync(path.join(BRAIN_DIR, 'token'), 'utf8').trim(); } catch { return ''; } };
function brainSessionFiles() {  // the brain's session files (MCP tools + prompt hook), or null
  try {
    execFileSync('python3', ['-I', path.join(__dirname, 'brain', 'brain.py'), 'session-files'], { stdio: 'ignore', timeout: 10000 });
    return { mcp: path.join(BRAIN_DIR, 'session-mcp.json'), settings: path.join(BRAIN_DIR, 'session-settings.json') };
  } catch { return null; }
}

async function startClaude(id, sid) {
  // brain files when the brain is in use; a test instance also turns Remote Control off (lib/claude_args.js)
  // + the state hooks (lib/hookstate.js): Claude reports its state to /api/hook (CC_PANEL_NO_HOOKS turns them off)
  const extra = claudeArgs(process.env.CC_PANEL_NO_BRAIN ? null : brainSessionFiles(), INST,
    process.env.CC_PANEL_NO_HOOKS ? null : stateHooks(PORT));
  const cmd = (sid ? `claude --resume ${sid}` : 'claude') + extra;
  await tmux(['send-keys', '-t', id, 'C-u']);
  await tmux(['send-keys', '-t', id, '-l', '--', cmd]);
  await tmux(['send-keys', '-t', id, 'Enter']);
}

// Codex in a panel window (lib/codex.js): the brain's MCP tools and prompt hook are
// passed with -c (the user's ~/.codex/config.toml is not changed). @started tells poll() from when
// to look for the session's record (Codex writes it with the first message).
async function startCodex(id, sid) {
  const brain = process.env.CC_PANEL_NO_BRAIN ? null : brainSessionFiles();
  await tmux(['set-option', '-w', '-t', id, '@started', String(Date.now())]);
  await tmux(['send-keys', '-t', id, 'C-u']);
  const hooks = process.env.CC_PANEL_NO_HOOKS ? null : stateHooks(PORT, Codex.STATE_EVENTS);
  await tmux(['send-keys', '-t', id, '-l', '--', Codex.command(isUuid(sid) ? sid : '', brain, hooks)]);
  await tmux(['send-keys', '-t', id, 'Enter']);
}
function startAgent(id, sid, agent) {
  return agentOf(agent) === 'codex' ? startCodex(id, sid) : startClaude(id, sid);
}

// After a restart of the Mac (no tmux session yet): build the windows again and resume the
// sessions that were running before (lib/restore.js). Until that is done, poll does not write
// windows.json, so a half-built list cannot replace the saved one.
const Restore = require('./lib/restore');
const WINDOWS_FILE = path.join(INST.home, 'windows.json');
const lastRun = new Map(); // window id -> last time an agent ran in it
let restoring = false;
function ensureSession() {
  if (tmuxSync(['has-session', '-t', S]) !== null) return;
  tmuxSync(['new-session', '-d', '-s', S, '-n', 'home', '-c', HOME]);
  const saved = Restore.load(WINDOWS_FILE);
  let conf = '';
  try { conf = fs.readFileSync(CONF, 'utf8'); } catch { /* none */ }
  restoring = true;
  (async () => {
    try {
      await scanElsewhere(); // a session open in VS Code or a terminal is not started a second time
      const windows = Restore.plan(saved, conf, (sid) => elsewhere.has(sid));
      for (const w of windows) {
        try {
          await createWindow({ name: w.name, folder: w.folder, sid: w.sid, run: w.run, agent: w.agent });
          if (w.run) console.log(`restore: resumed ${w.name} (${w.sid})`);
        } catch (e) { console.log(`restore: ${w.name}: ${e.message}`); }
      }
    } finally { restoring = false; }
  })();
}

// ---------- state detection ----------
const { parseScreen, ANSI, inputBoxText } = require('./lib/screen');
const router = require('./lib/router');
const Brief = require('./lib/brief');
const { parseTranscript, wasSent, pendingEchoes } = require('./lib/chat');
// Messages sent from the chat composer that the transcript does not show yet (lib/chat.js
// pendingEchoes). window id -> [{ text, at, phase }]; phase: 'sending' (keys typed), 'brain' (the
// prompt hook runs: the brain looks for context), 'working' (no brain). The chat view shows them.
const echoes = new Map();
function echoesFor(win, items) {
  const list = echoes.get(win);
  if (!list) return [];
  const left = pendingEchoes(list, items);
  if (left.length) echoes.set(win, left); else echoes.delete(win);
  return left.map(({ text, at, phase }) => ({ text, at, phase }));
}
const { highlight } = require('./lib/highlight');
const { thumbnail } = require('./lib/thumb');
const ATTACH_DIR = path.join(INST.home, 'attachments');
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic)$/i;
// files Claude Code can read by path: images, PDFs, text, data and code
const ATTACH_EXT = /\.(png|jpe?g|gif|webp|heic|pdf|txt|md|csv|tsv|json|ya?ml|xml|html?|log|ipynb|py|js|ts|swift|java|go|rs|c|cpp|h|rb|sh|sql)$/i;

// Attachments are image files; their absolute paths go into the message text,
// which Claude Code reads (tested: a path to a PNG is read and described).
function withAttachments(text, attachments) {
  const paths = (Array.isArray(attachments) ? attachments : []).filter((p) =>
    typeof p === 'string' && path.isAbsolute(p) && ATTACH_EXT.test(p) && fs.existsSync(p) && !/\s/.test(p));
  if (Array.isArray(attachments) && paths.length !== attachments.length) throw new Error('Attachment not found');
  return [String(text || '').trim(), ...paths].filter(Boolean).join(' ');
}
const { readRecords, outsideHolders, paneSessions, paneRunning, isBlocked, migrationPlan } = require('./lib/elsewhere');
const Remote = require('./lib/remote');
const Setup = require('./lib/setup');
const Devices = require('./lib/devices');
const Copies = require('./lib/copies');
const SetupFix = require('./lib/setup_fix');
const Permissions = require('./lib/permissions');
const PermNeed = require('./lib/permneed');
const CLAUDE_SESSIONS = path.join(HOME, '.claude', 'sessions');

// branch cache
const branchCache = new Map();
function gitBranch(folder) {
  const c = branchCache.get(folder);
  if (c && Date.now() - c.t < 30000) return c.v;
  let v = '';
  try {
    v = execFileSync('git', ['-C', folder, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { v = ''; }
  branchCache.set(folder, { t: Date.now(), v });
  return v;
}

// folders that have a Claude process running OUTSIDE the panel (e.g. VS Code)
// conversations held by a Claude process OUTSIDE the panel: sessionId -> process record
// (lib/elsewhere.js; records come from ~/.claude/sessions/<pid>.json)
let elsewhere = new Map();
let paneSid = new Map(); // pane pid -> session id of the Claude running in it (exact)
async function scanElsewhere() {
  const panes = new Set(((await tmux(['list-panes', '-s', '-t', S, '-F', '#{pane_pid}'])) || '').split('\n').filter(Boolean));
  const out = await new Promise((r) => execFile('ps', ['-axo', 'pid=,ppid='], (e, o) => r(e ? '' : o)));
  const parent = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) parent.set(m[1], m[2]);
  }
  const inPanel = (pid) => {
    for (let p = pid, i = 0; i < 30 && p && p !== '1'; i++) { if (panes.has(p)) return true; p = parent.get(p); }
    return false;
  };
  const records = readRecords(CLAUDE_SESSIONS);
  elsewhere = outsideHolders(records, inPanel);
  paneSid = paneSessions(records, parent, panes);
  // Codex sessions open outside the panel (a terminal, VS Code): same map, rec.agent = 'codex'
  try { for (const r of Codex.outsideRecords(inPanel)) if (!elsewhere.has(r.sessionId)) elsewhere.set(r.sessionId, r); } catch { /* ps/lsof failed */ }
}

// Move a conversation that is open outside the panel into window `id` (user decision,
// 2026-11-09): an interactive process is stopped with SIGTERM (Claude saves the transcript)
// and the same session is resumed here; a background job is attached instead of stopped.
async function migrateHere(id, sid) {
  if (adoptions.has(id)) return true; // the outside session is already moving here by itself (/panel)
  await scanElsewhere();
  const plan = migrationPlan(elsewhere.get(sid));
  if (plan.kind === 'none') return false;
  starting.add(id); setTimeout(() => starting.delete(id), 30000);
  if (plan.kind === 'attach') {
    await tmux(['send-keys', '-t', id, 'C-u']);
    await tmux(['send-keys', '-t', id, '-l', '--', `claude attach ${plan.jobId}`]);
    await tmux(['send-keys', '-t', id, 'Enter']);
    console.log(`migrate: ${id} attached to background job ${plan.jobId}`);
    return true;
  }
  try { process.kill(plan.pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let i = 0; i < 50 && alive(plan.pid); i++) await sleep(200);
  const rec = elsewhere.get(sid) || {};
  if (alive(plan.pid)) { starting.delete(id); throw new Error(`The other ${rec.agent === 'codex' ? 'Codex' : 'Claude'} (pid ${plan.pid}) did not stop; close it there and try again`); }
  elsewhere.delete(sid);
  await tmux(['send-keys', '-t', id, 'C-l']);
  await startAgent(id, sid, rec.agent);
  console.log(`migrate: ${id} stopped outside pid ${plan.pid} and resumed ${sid.slice(0, 8)} here`);
  return true;
}

let snapshot = { sessions: [], ts: 0 };
const prevState = new Map();

// ---------- hook state (lib/hookstate.js) ----------
// window id -> { state, at, sid } from the last hook event. Saved in the state folder, so a server
// restart keeps the state of running sessions (the next event would also fix it).
const HOOK_FILE = path.join(INST.home, 'hook-state.json');
const hookRecs = new Map(Object.entries((() => { try { return JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8')); } catch { return {}; } })()));
const idleSince = new Map(); // window id -> since when the screen has shown 'idle' (ms)
const paneWindow = new Map(); // tmux pane id (%N) -> window id, from poll()
let hookSave = null;
function saveHookRecs() {
  clearTimeout(hookSave);
  hookSave = setTimeout(() => {
    try { fs.mkdirSync(INST.home, { recursive: true }); fs.writeFileSync(HOOK_FILE, JSON.stringify(Object.fromEntries(hookRecs))); } catch { /* next change saves again */ }
  }, 500);
}
// A session's tool says a macOS permission is missing: check the real state, then ask the app to
// show its guide (PermissionGuide.swift), once per permission in 30 min (lib/permneed.js)
const permAsked = new Map();
async function onPermNeed(event, pane, payload) {
  const ids = PermNeed.wanted(event, payload);
  if (!ids.length) return;
  const st = await Permissions.state({ tmuxArgs: INST.tmuxArgs });
  const missing = Permissions.checks(st).filter((c) => !c.ok && ids.includes(c.id));
  const id = paneWindow.get(pane);
  const session = (snapshot.sessions.find((x) => x.id === id) || {}).name || '';
  for (const c of missing) {
    if (!PermNeed.shouldAsk(permAsked, c.id)) continue;
    const msg = JSON.stringify({ type: 'permAsk', perm: { id: c.id, name: c.name, pane: c.pane }, app: c.app, session });
    for (const ws of stateClients) if (ws.readyState === 1) ws.send(msg);
  }
}

let hookPoll = null;
async function onHook(event, pane, payload) {
  if (!/^%\d+$/.test(pane)) return;
  let id = paneWindow.get(pane);
  if (!id) id = ((await tmux(['display-message', '-p', '-t', pane, '#{window_id}'])) || '').trim();
  if (!/^@\d+$/.test(id)) return;
  if (event === 'UserPromptSubmit') {
    // Claude got the prompt; its prompt hooks run now (the brain's takes seconds)
    const e = (echoes.get(id) || []).find((x) => x.phase === 'sending');
    if (e) e.phase = process.env.CC_PANEL_NO_BRAIN ? 'working' : 'brain';
  }
  const rec = HookState.applyHook(hookRecs.get(id) || null, event, payload);
  if (!rec || rec === hookRecs.get(id)) return;
  hookRecs.set(id, rec);
  saveHookRecs();
  // show the change now, not at the next 1.5 s poll (several events in a row: one poll)
  if (!hookPoll) hookPoll = setTimeout(() => { hookPoll = null; poll(); }, 50);
}

async function poll() {
  const fmt = '#{window_id}\t#{window_index}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}\t#{@folder}\t#{@sid}\t#{window_activity}\t#{@label}\t#{pane_pid}\t#{@created}\t#{@agent}\t#{@started}\t#{pane_id}';
  const out = await tmux(['list-windows', '-t', S, '-F', fmt]);
  if (out === null) { snapshot = { sessions: [], ts: Date.now(), down: true }; return broadcast(); }
  const sessions = [];
  const rows = out.split('\n').filter(Boolean);
  // Codex session ids already known (a new Codex window must not take another window's record)
  const codexClaimed = new Set(rows.map((r) => r.split('\t')).filter((c) => c[11] === 'codex' && isUuid(c[6])).map((c) => c[6]));
  for (const row of rows) {
    let [id, index, winName, cmd, cwd, folderOpt, sid, activity, label, panePid, created, agentOpt, started, paneId] = row.split('\t');
    if (paneId) paneWindow.set(paneId, id);
    const agent = agentOf(agentOpt);
    // tmux 3.5 has no #{window_created}: the panel records it (first sight for older windows)
    if (!created) { created = String(Math.floor(Date.now() / 1000)); tmux(['set-option', '-w', '-t', id, '@created', created]); }
    if (winName === 'home') continue;
    const name = label || winName;
    const folder = folderOpt || cwd;
    const running = paneRunning(cmd, panePid, paneSid, SHELLS);
    const screen = (await tmux(['capture-pane', '-p', '-J', '-t', id, '-S', '-200'])) || '';
    const parsed = running ? (agent === 'codex' ? Codex.parseScreen(screen) : parseScreen(screen)) : { state: 'stopped', last: '', options: [], question: '' };
    if (!running) {
      const m = screen.replace(ANSI, '').match(/⏺\s*(.+)/g);
      if (m) parsed.last = m[m.length - 1].replace(/^⏺\s*/, '');
    }
    // the session id comes from the Claude process in this pane (exact); it also corrects a wrong id
    if (agent === 'codex') {
      // a new Codex window: its SessionStart hook names the session (first message); without
      // hooks, its record appears with the first message (folder + start time)
      const hr = hookRecs.get(id);
      if (running && !isUuid(sid) && hr && isUuid(hr.sid) && !codexClaimed.has(hr.sid)) {
        await tmux(['set-option', '-w', '-t', id, '@sid', hr.sid]); sid = hr.sid; codexClaimed.add(hr.sid);
      }
      if (running && !isUuid(sid) && Number(started)) {
        const found = Codex.discover(folder, Number(started), codexClaimed);
        if (found) { await tmux(['set-option', '-w', '-t', id, '@sid', found]); sid = found; codexClaimed.add(found); }
      }
    } else {
      const exact = running ? paneSid.get(panePid) : '';
      if (exact && exact !== sid) { await tmux(['set-option', '-w', '-t', id, '@sid', exact]); sid = exact; }
    }
    // The state from hooks (Claude Code and Codex), with the screen where hooks are silent (lib/hookstate.js)
    if (parsed.state === 'idle') { if (!idleSince.has(id)) idleSince.set(id, Date.now()); } else idleSince.delete(id);
    let hooked = false;
    {
      let rec = hookRecs.get(id) || null;
      // a process that ended takes its record with it (a Claude started by hand has no hooks)
      if (rec && !running) { hookRecs.delete(id); saveHookRecs(); rec = null; }
      if (rec && rec.sid && isUuid(sid) && rec.sid !== sid) rec = null; // another session in this window
      hooked = !!rec && rec.state !== 'stopped';
      parsed.state = HookState.combine({ running, screen: parsed, rec, idleSince: idleSince.get(id) || 0 });
      if (parsed.state !== 'working') parsed.live = '';
      else if (!parsed.live) parsed.live = 'Working';
    }
    const blocked = isBlocked({ running, sid }, elsewhere);
    const tinfo = agent === 'codex' ? Codex.info(sid) : transcriptInfo(folder, sid);
    // Codex: a turn that its record says is still running is "working", even when the screen
    // shows no spinner for a moment (record written in the last 30 minutes, so a crash cannot pin it)
    // (only without hooks: with hooks, Stop and Interrupt say when the turn ends)
    if (agent === 'codex' && !hooked && running && parsed.state === 'idle' && tinfo && tinfo.busy && Date.now() - tinfo.mtime < 30 * 60000) {
      parsed.state = 'working'; parsed.live = parsed.live || 'Working';
    }
    if (tinfo && (!parsed.last || !running)) parsed.last = tinfo.reply || parsed.last;
    sessions.push({
      id, index: Number(index), name, folder, sid: sid || '', running, agent, started: Number(started) || 0,
      state: blocked ? 'elsewhere' : parsed.state,
      last: parsed.last, options: parsed.options, question: parsed.question, live: parsed.live || '',
      branch: gitBranch(folder), prompt: tinfo ? tinfo.prompt : '', title: tinfo ? tinfo.title : '',
      // like Claude.ai / ChatGPT: the time of the last message in the conversation, not terminal
      // output or transcript bookkeeping. Opening or viewing a session must not move it.
      activity: lastMessageTime(tinfo, created),
    });
    prevState.set(id, parsed.state);
  }
  snapshot = { sessions, ts: Date.now(), routes: routes.slice(0, 30), defaultFolder: defaultFolder() };
  if (!restoring) Restore.save(WINDOWS_FILE, Restore.record(sessions, lastRun));
  broadcast();
  flushPending();
}

// A fresh session gets its transcript id once Claude writes the file.

// ---------- message delivery queue ----------
// Messages wait here until their session is ready (running and idle).
const pending = new Map(); // window id -> [{ text, routeId }]
const starting = new Set();
let flushing = false;
async function flushPending() {
  if (flushing || !pending.size) return;
  flushing = true;
  try {
    for (const [id, queue] of pending) {
      const s = snapshot.sessions.find((x) => x.id === id);
      if (!s) { for (const q of queue) setRoute(q.routeId, { status: 'error', error: 'Session closed' }); pending.delete(id); continue; }
      if (s.state === 'stopped') {
        if (!starting.has(id)) { starting.add(id); await startAgent(id, isUuid(s.sid) ? s.sid : '', s.agent); setTimeout(() => starting.delete(id), 30000); }
        continue;
      }
      if (s.state !== 'idle' || !queue.length) continue;
      const q = queue[0];
      if (s.agent === 'codex') {
        // Codex shows its start-up menus (hook review, MCP) a few seconds after the input box: wait
        // 8 s after start. A message typed before such a menu is kept by Codex and runs after it, so
        // before typing again, look in the record: if it arrived, it was sent (a test run:
        // the first task ran twice).
        if (s.started && Date.now() - s.started < 8000) continue;
        if (q.typedAt && codexReceived(s.sid, q.text, q.typedAt)) {
          queue.shift(); if (!queue.length) pending.delete(id);
          setRoute(q.routeId, { status: 'sent' });
          continue;
        }
        q.typedAt = q.typedAt || Date.now();
      }
      const result = await typeMessage(id, q.text, s.agent);
      if (result === 'menu') {
        // a menu came up: leave the message queued; it is typed again once the session is idle
        // (typeMessage clears any text left in the input box first)
        continue;
      }
      queue.shift();
      if (!queue.length) pending.delete(id);
      setRoute(q.routeId, result === 'sent' ? { status: 'sent' } : { status: 'error', error: `The message was typed but ${s.agent === 'codex' ? 'Codex' : 'Claude'} did not take it; press Enter in the session` });
    }
  } finally { flushing = false; }
}
/** Did a Codex session's record get this user message at or after `since` (ms)? */
function codexReceived(sid, text, since) {
  if (!isUuid(sid)) return false;
  const want = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return Codex.chat(sid).items.some((it) => it.role === 'user' && Date.parse(it.ts) >= since - 2000 &&
    it.text.replace(/\s+/g, ' ').trim().slice(0, 200) === want);
}
// Returns 'sent', 'menu' (a menu appeared: nothing was submitted, Enter was NOT pressed on it)
// or 'stuck'. Never press Enter while a menu shows: on Claude's folder-trust prompt the default
// is "No, exit" (2026-11-09 e2e: Claude quit when an Enter meant for the task hit that prompt).
// Screen parser and input-box reader for a session's agent (Claude Code or Codex).
const screenOf = (agent) => (agentOf(agent) === 'codex' ? { parse: Codex.parseScreen, box: Codex.inputBoxText } : { parse: parseScreen, box: inputBoxText });
async function screenState(id, agent) {
  return screenOf(agent).parse((await tmux(['capture-pane', '-p', '-J', '-t', id])) || '').state;
}
async function typeMessage(id, text, agent = 'claude') {
  const { parse, box: boxText } = screenOf(agent);
  const one = text.replace(/\r?\n/g, ' ');
  if (await screenState(id, agent) !== 'idle') return 'menu';
  // clear anything left in the input box (e.g. a copy typed before a menu appeared)
  if (boxText((await tmux(['capture-pane', '-p', '-J', '-t', id])) || '')) await tmux(['send-keys', '-t', id, 'C-u']);
  await tmux(['send-keys', '-t', id, '-l', '--', one]);
  // A brand-new Claude draws its input box before it reads keys: the typed text shows up
  // 1–3 s later and an Enter sent before that is lost, while the box still looks empty, so it
  // looked "sent" (2026-11-10: 2 of 5 new sessions kept the request in the box until the user
  // pressed Enter). Wait until the box shows the text; an empty box only counts as sent after that.
  const typedAt = Date.now();
  let echoed = false;
  while (Date.now() - typedAt < 10000) {
    const screen = (await tmux(['capture-pane', '-p', '-J', '-t', id])) || '';
    if (parse(screen).state === 'needs') return 'menu';
    if (boxText(screen)) { echoed = true; break; }
    await sleep(100);
  }
  // A long message is handled like a paste; an Enter sent too soon is swallowed and the
  // text stays in the input box (found in the real handoff test, 2026-11-09). Wait by
  // length, press Enter, then check the box is empty and press again if it is not.
  await sleep(Math.max(0, Math.min(3000, 150 + one.length / 2) - (Date.now() - typedAt)));
  // Right after a menu (e.g. folder trust) Claude may still be starting and ignore Enter
  // (found in an end-to-end test, 2026-11-09: 1 run of 6 left the task in the box). Keep
  // trying for about 15 s with growing waits.
  for (const wait of [700, 1000, 1500, 2000, 2500, 3000, 3000]) {
    if (await screenState(id, agent) === 'needs') return 'menu';
    await tmux(['send-keys', '-t', id, 'Enter']);
    await sleep(wait);
    const screen = (await tmux(['capture-pane', '-p', '-J', '-t', id])) || '';
    if (parse(screen).state === 'needs') return 'menu';
    const box = boxText(screen);
    if (!box) { if (echoed) return 'sent'; continue; }
    echoed = true;
    if (!one.startsWith(box.slice(0, 20)) && !box.includes(one.slice(0, 20))) return 'sent';
  }
  return 'stuck';
}
async function deliver(id, text, routeId) {
  const s = snapshot.sessions.find((x) => x.id === id);
  if (!s) throw new Error('No such session');
  if (s.state === 'elsewhere') await migrateHere(id, s.sid);
  if (!pending.has(id)) pending.set(id, []);
  pending.get(id).push({ text, routeId });
  setRoute(routeId, { status: s.state === 'idle' ? 'sending' : 'queued', target: id, targetName: s.name });
  flushPending();
}

// ---------- adoption (thoth adopt / the /panel command) ----------
const adoptions = new Map(); // window id -> { sid, pid, until }
let adoptTimer = null;
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function watchAdoptions() {
  if (adoptTimer) return;
  adoptTimer = setInterval(async () => {
    for (const [id, a] of adoptions) {
      if (alive(a.pid)) {
        if (Date.now() > a.until) adoptions.delete(id); // still running elsewhere: leave the Resume button
        continue;
      }
      adoptions.delete(id);
      if (starting.has(id)) continue; // already started (e.g. by migrateHere)
      await tmux(['send-keys', '-t', id, 'C-l']);
      await startAgent(id, a.sid, a.agent);
      setTimeout(poll, 300);
    }
    if (!adoptions.size) { clearInterval(adoptTimer); adoptTimer = null; }
  }, 300);
}

// ---------- router: one entry point for all requests ----------
// an instance with its own state folder keeps routes.json there; a test server on another port
// without one keeps its own request list next to the user's
const ROUTES_FILE = path.join(INST.home, process.env.CC_PANEL_HOME || PORT === 7878 ? 'routes.json' : `routes-${PORT}.json`);
let routes = [];
try { routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')); } catch { routes = []; }
let routeSeq = Date.now();
function saveRoutes() { try { fs.writeFileSync(ROUTES_FILE, JSON.stringify(routes.slice(0, 50), null, 1)); } catch { /* ignore */ } }
function setRoute(rid, patch) {
  const r = routes.find((x) => x.id === rid);
  if (!r) return;
  Object.assign(r, patch);
  saveRoutes();
  snapshot.routes = routes.slice(0, 30);
  broadcast();
}

// Test scope: while set (by the verify skill), the router only sees these
// sessions, so test requests can never reach a real session. Expires by itself.
let testScope = null; // { ids: Set<string>, until: ms }
function routable() {
  if (testScope && Date.now() < testScope.until) return snapshot.sessions.filter((s) => testScope.ids.has(s.id));
  testScope = null;
  return snapshot.sessions;
}

// Default folder for new work that fits no session or project (the Ask box never forces a
// folder choice). Set "defaultFolder" in <state folder>/settings.json or CC_PANEL_DEFAULT_FOLDER.
// ~/code, not ~/Desktop/...: the Desktop is synced to iCloud (user's decision, 2026-11-09).
function defaultFolder() {
  let f = process.env.CC_PANEL_DEFAULT_FOLDER || '';
  if (!f) { try { f = JSON.parse(fs.readFileSync(path.join(INST.home, 'settings.json'), 'utf8')).defaultFolder || ''; } catch { /* none */ } }
  f = (f || path.join(HOME, 'code')).replace(/^~(?=\/|$)/, HOME);
  if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true });
  return f;
}

/** Short session name for a new task: the router's name, else the first words of the request. */
function taskName(name, text) {
  const n = String(name || '').trim();
  if (n) return n.slice(0, 30);
  const words = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return words || 'task';
}

/** Sort key for Recent: time of the last message in the conversation, else when the window was created. */
function lastMessageTime(tinfo, created) {
  if (tinfo && tinfo.lastMsg) return tinfo.lastMsg;
  return Number(created) * 1000 || 0;
}

function routerInputs() {
  const sessions = routable().map((s) => ({ ...s, queued: queuedCount(s.id), topics: history(s.folder).slice(0, 5).map((h) => h.title || h.first.slice(0, 60)) }));
  return [sessions, recentFolders().map((f) => f.folder)];
}

// ---------- central brain (cross-device sessions) ----------
// Where the brain is: <panel home>/brain.json { url, owner_token } for a cloud brain
// else the local brain/brain.py on 127.0.0.1:7879 (as before).
const https = require('https');
const BRAIN_MCP = path.join(__dirname, 'brain', 'mcp_server.py');
let LOCAL_DEVICE = '';
function brainTarget() {
  const loc = Setup.loadBrainLocation(INST.home);
  if (loc) return { cloud: true, url: new URL(loc.url), token: loc.owner_token };
  return { cloud: false, url: new URL(`http://127.0.0.1:${BRAIN_PORT}`), token: brainToken() };
}
/** Request options for the brain: the cloud brain gets the owner token on every call; the local
 * brain gets its write token on POSTs (reads are open on 127.0.0.1). */
function brainOptions(t, method, apiPath, timeout) {
  const headers = { 'Content-Type': 'application/json' };
  if ((t.cloud || method === 'POST') && t.token) headers.Authorization = 'Bearer ' + t.token;
  return { mod: t.url.protocol === 'https:' ? https : http,
    opts: { host: t.url.hostname, port: t.url.port || (t.url.protocol === 'https:' ? 443 : 80), path: apiPath, method, headers, timeout } };
}
/** One brain call -> { status, json }. Rejects on network/certificate errors (err.code kept). */
function brainRequest(method, apiPath, body, { target = brainTarget(), timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const { mod, opts } = brainOptions(target, method, apiPath, timeout);
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json; try { json = JSON.parse(data || 'null'); } catch { json = undefined; } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Object.assign(new Error('brain timeout'), { code: 'ETIMEDOUT' })));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function brainCall(method, apiPath, body) {
  const r = await brainRequest(method, apiPath, body);
  if (r.json === undefined) throw new Error('bad brain reply');
  return r.json;
}
async function brainUp() {
  try {
    const devs = await brainCall('GET', '/api/devices');
    if (!Array.isArray(devs)) return false;   // e.g. the cloud brain refused the owner token
    const cd = cloudDevice();
    const local = cd ? { name: cd.device } : devs.find((d) => d.transport === 'local');
    if (local) LOCAL_DEVICE = local.name;
    return true;
  } catch { return false; }
}

// This computer as a device of the cloud brain: it joins when the owner connects, and pushes its
// sessions over HTTPS (outbound only) with device/device_agent.py every 5 minutes.
const CLOUD_DEVICE_FILE = path.join(INST.home, 'cloud-device.json');
// the device agent's file (device/join.sh); CC_DEVICE_AGENT_FILE moves it in tests
const AGENT_DEVICE_FILE = process.env.CC_DEVICE_AGENT_FILE || path.join(os.homedir(), '.cc-brain', 'device.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/** This computer's identity on the cloud brain (lib/devices.js pickIdentity), or null. */
function cloudIdentity() {
  const loc = Setup.loadBrainLocation(INST.home);
  let agentLogAge = Infinity;
  try { agentLogAge = Date.now() - fs.statSync(path.join(path.dirname(AGENT_DEVICE_FILE), 'device-agent.log')).mtimeMs; } catch { /* no agent log */ }
  const id = Devices.pickIdentity({ own: readJson(CLOUD_DEVICE_FILE), agent: readJson(AGENT_DEVICE_FILE), hub: loc && loc.url, agentLogAge });
  return id && { ...id, file: id.which === 'agent' ? AGENT_DEVICE_FILE : CLOUD_DEVICE_FILE };
}
function cloudDevice() { const id = cloudIdentity(); return id ? id.conf : null; }
const selfPush = { running: false, last: null };
function pushSelf() {
  const id = cloudIdentity();
  // the device agent pushes this computer's sessions on its own schedule: one pusher per computer
  if (selfPush.running || !id || !id.push || process.env.CC_PANEL_NO_CLOUD_PUSH) return Promise.resolve(selfPush.last);
  selfPush.running = true;
  return new Promise((resolve) => {
    const hub = id.conf.hub;
    execFile('python3', ['-I', path.join(__dirname, 'device', 'device_agent.py'), 'push'],
      { env: { ...process.env, CC_DEVICE_CONF: id.file, CC_DEVICE_NO_REJOIN: '1' }, timeout: 600000, maxBuffer: 4 * 1024 * 1024 }, async (err, out, errOut) => {
        let text = String(out || errOut || (err && err.message) || '').trim().split('\n').pop();
        const m = text.match(/the brain has (\d+)/);
        // exit 7: cloud-device.json was copied from another computer (Migration Assistant). The agent
        // moved it aside; this computer joins with its own name (lib/devices.js hostName).
        if (err && err.code === 7) {
          try {
            const e = await joinCloudSelf(setupState(), hub, Devices.hostName());
            text = e || `This computer's device file came from another computer. It joined the cloud brain again as '${(cloudDevice() || {}).device}'.`;
            console.log('cloud push: ' + text);
          } catch (e) { text = `This computer could not join the cloud brain again: ${e.message}`; }
        }
        selfPush.last = { at: Date.now(), ok: !err, message: text.slice(0, 300), sessions: m ? Number(m[1]) : undefined };
        selfPush.running = false;
        resolve(selfPush.last);
      });
  });
}
setInterval(pushSelf, 5 * 60_000).unref();
setTimeout(pushSelf, 5000).unref();

/** Router decided "handoff": the brain moves the work here and opens a panel session. When this
 * computer has the newest copy of the session itself (lib/copies.js), it is resumed here instead. */
async function handoffRoute(rid, device, sid, text) {
  let here = null;
  try { here = Copies.newestHere(await brainCall('GET', `/api/session?sid=${encodeURIComponent(sid)}&count=1`), LOCAL_DEVICE); } catch { /* no brain answer: hand off */ }
  if (here && isUuid(here.sid) && isDir(here.cwd)) {
    const open = snapshot.sessions.find((x) => x.sid === here.sid);
    const id = open ? open.id : (await actions.new({ folder: here.cwd, sid: here.sid, name: (here.title || path.basename(here.cwd)).slice(0, 30),
      agent: here.agent === 'codex' ? 'codex' : 'claude' })).id;
    await poll();
    setRoute(rid, { decided: 'auto-resume', reason: `The session ${here.sid.slice(0, 8)} on ${device} has its newest copy on this computer too, so it is resumed here (no handoff).` });
    await deliver(id, text, rid);
    return;
  }
  setRoute(rid, { status: 'handing-off', targetName: device });
  const { id: hid, error } = await brainCall('POST', '/api/handoff',
    { device, sid, run: 'panel', panel_url: `http://${HOST}:${PORT}`, notes: `The user asked: ${text}` });
  if (!hid) throw new Error(error || 'brain did not start the handoff');
  setRoute(rid, { handoffId: hid });
  for (let i = 0; i < 300; i++) {
    await sleep(2000);
    const h = ((await brainCall('GET', '/api/handoffs?limit=30')) || []).find((x) => x.id === hid);
    if (!h || h.status === 'running' || h.status === 'prepared') continue;
    let res = {};
    try { res = JSON.parse(h.result || '{}'); } catch { /* keep {} */ }
    if (h.status !== 'ran' || !res.panel_session) throw new Error('handoff failed: ' + String(res.result || h.result || '').slice(0, 300));
    await poll();
    const s = snapshot.sessions.find((x) => x.id === res.panel_session);
    setRoute(rid, { status: 'queued', decided: 'auto-handoff', target: res.panel_session, targetName: s ? s.name : 'handoff',
      reason: `${device} → ${LOCAL_DEVICE || 'this Mac'}: code copied to ${h.target_path}; Claude gets the handoff after you approve the folder.` });
    return;
  }
  throw new Error('handoff took too long');
}


/**
 * Messages waiting for a session: the panel's delivery queue, plus Claude Code's own queue
 * (messages typed into the session page while Claude works; read from the transcript).
 */
function queuedCount(id) {
  const s = snapshot.sessions.find((x) => x.id === id);
  let own = 0;
  if (s && (s.state === 'working' || s.state === 'needs') && isUuid(s.sid)) {
    own = Brief.claudeQueue(Brief.readTail(path.join(PROJECTS, slugOf(s.folder), s.sid + '.jsonl'), 512 * 1024));
  }
  return (pending.get(id) || []).length + own;
}

/**
 * Start a new session for a request and send it the request. When `sources` (sessions) are given,
 * the new session first gets a brief written from their recent conversations (lib/brief.js).
 */
async function newWithBrief(rid, { folder, name, text, sources = [], patch = {}, agent = 'claude' }) {
  const id = await createWindow({ name: taskName(name, text), folder, sid: '', run: true, agent });
  await poll();
  let message = text, briefFrom = [];
  if (sources.length) {
    setRoute(rid, { ...patch, status: 'briefing', folder });
    const withDialogue = sources.map((s) => ({ name: s.name, folder: s.folder,
      dialogue: !isUuid(s.sid) ? [] : s.agent === 'codex' ? codexDialogue(s.sid)
        : Brief.readDialogue(path.join(PROJECTS, slugOf(s.folder), s.sid + '.jsonl')) }));
    const brief = await Brief.runBrief(text, withDialogue);
    if (brief) { briefFrom = withDialogue.filter((s) => s.dialogue.length).map((s) => s.name); message = Brief.withBrief(text, brief, briefFrom); }
  }
  setRoute(rid, { ...patch, status: 'queued', folder, briefFrom });
  await deliver(id, message, rid);
}

/** The recent user/assistant turns of a Codex session, for a brief ({role, text}[], like Brief.readDialogue). */
function codexDialogue(sid) {
  return Codex.chat(sid, 40).items.map((it) => ({ role: it.role,
    text: it.role === 'user' ? it.text : it.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') }))
    .filter((t) => t.text && t.text.trim()).map((t) => ({ ...t, text: t.text.slice(0, 1500) })).slice(-12);
}

/** Carry out one routing decision `d` for the request `text` (route record `rid`). */
async function runDecision(rid, d, text, dry) {
  // the router picks the agent for a new session (Codex only when the request asks for it)
  let newAgent = d.agent === 'codex' && Codex.availability().available ? 'codex' : 'claude';
  // no agent given for the overflow of a busy session: keep that session's agent
  if (!d.agent && d.action === 'new') {
    const busy = (d.context_from || []).map((cid) => routable().find((x) => x.id === cid))
      .find((x) => x && x.folder === d.folder && queuedCount(x.id) >= Brief.BUSY_QUEUE);
    if (busy && busy.agent === 'codex' && Codex.availability().available) newAgent = 'codex';
  }
  // the request without the words that only chose the agent ("用 codex …"): a Codex session
  // took "用 codex" as "start the Codex CLI" (a test run, 2026-11-10)
  if (typeof d.task === 'string' && d.task.trim() && d.task.trim().length >= Math.min(20, text.length * 0.3) && d.task.trim() !== text.trim()) {
    text = d.task.trim();
    setRoute(rid, { task: text });
  }
  // "new" without a usable folder goes to the default folder
  if (d.action === 'new' && (!d.folder || !fs.existsSync(d.folder))) d.folder = defaultFolder();
  const pool = routable();
  const target = pool.find((s) => s.id === d.target);
  const choices = [...new Set([d.target, ...(d.alternatives || [])])]
    .map((id) => pool.find((s) => s.id === id)).filter(Boolean).map((s) => ({ id: s.id, name: s.name }));
  const base = { reason: d.reason, confidence: d.confidence, choices, folder: d.folder || '', newName: d.name || '', defaultFolder: defaultFolder() };
  // sessions the router named as background for a new session (never the new session itself)
  const contextFrom = [...new Set(d.context_from || [])].map((id) => pool.find((s) => s.id === id)).filter(Boolean).slice(0, 3);
  if (dry) { setRoute(rid, { ...base, status: 'dry', agent: newAgent, action: d.action, target: d.target || '', targetName: target ? target.name : '', device: d.device || '', sid: d.sid || '' }); return; }
  if (d.action === 'handoff' && !testScope && d.device && d.sid && d.device !== LOCAL_DEVICE && d.confidence >= 0.75) {
    setRoute(rid, { ...base, decided: 'handoff' });
    await handoffRoute(rid, d.device, d.sid, text);
  } else if (d.action === 'send' && target && d.confidence >= 0.75 && queuedCount(target.id) >= Brief.BUSY_QUEUE && !testScope) {
    // The user's rule: do not add to a session with a long queue. Start a new session in its
    // folder and give it the busy session's background (and any other session the router named).
    const n = queuedCount(target.id);
    const folder = fs.existsSync(target.folder) ? target.folder : defaultFolder();
    await newWithBrief(rid, { folder, name: d.name && d.name !== target.name ? d.name : `${target.name} 2`, text, agent: target.agent, sources: [target, ...contextFrom.filter((s) => s.id !== target.id)],
      patch: { ...base, decided: 'auto-new-busy', busy: target.id, reason: `${target.name} has ${n} messages waiting, so a new session in ${path.basename(folder)} with its background. ${d.reason || ''}`.trim() } });
  } else if (d.action === 'send' && target && d.confidence >= 0.75) {
    setRoute(rid, { ...base, decided: 'auto' });
    await deliver(target.id, text, rid);
  } else if (d.action === 'new' && !testScope && d.folder && fs.existsSync(d.folder) && d.confidence >= 0.75) {
    await newWithBrief(rid, { folder: d.folder, name: d.name, text, agent: newAgent, sources: contextFrom, patch: { ...base, decided: 'auto-new', agent: newAgent } });
  } else if (!testScope) {
    // The router is not sure. The user's rule: do not ask, use the default — a new session in the default folder.
    // The folder is the project the request most likely belongs to (the router's folder, else its
    // best-guess session's folder); the default folder only when nothing fits.
    const { folder, from } = router.unsureFolder(d, pool, defaultFolder(), (f) => isDir(f));
    const why = from ? ` (the project of ${from})` : from === null ? ' (the default folder)' : '';
    await newWithBrief(rid, { folder, name: d.name, text, sources: contextFrom, agent: newAgent,
      patch: { ...base, folder, decided: 'auto-new', agent: newAgent, reason: `Not sure which session, so a new session in ${path.basename(folder)}${why}. ${d.reason || ''}`.trim() } });
  } else {
    setRoute(rid, { ...base, status: 'ask' });   // a test scope cannot start sessions
  }
}

async function route(text, dry = false) {
  const rid = 'r' + (++routeSeq);
  routes.unshift({ id: rid, ts: Date.now(), text, status: 'routing' });
  setRoute(rid, {});
  (async () => {
    try {
      await poll();
      if (!routable().length && !testScope) {
        // nothing to route to yet: start the work in the default folder
        const folder = defaultFolder();
        const id = await createWindow({ name: taskName('', text), folder, sid: '', run: true });
        await poll();
        setRoute(rid, { status: 'queued', decided: 'auto-new', folder, reason: `No sessions yet, so a new session in ${path.basename(folder)}.` });
        await deliver(id, text, rid);
        return;
      }
      const brain = !testScope && await brainUp();
      const d = await router.runRouter(text, ...routerInputs(), { brainMcp: brain ? BRAIN_MCP : null, localDevice: LOCAL_DEVICE, defaultFolder: defaultFolder(), codexOk: Codex.availability().available });
      const plan = router.splitTasks(d, routable());
      if (plan.length === 1) return await runDecision(rid, plan[0], text, dry);
      // Several jobs: one route record per task, listed right under the request, each delivered
      // on its own (its own session, its own background), at the same time.
      const n = plan.length;
      const parts = plan.map((t, i) => ({ id: 'r' + (++routeSeq), ts: Date.now(), text: t.task, status: 'routing', parent: rid, part: `${i + 1}/${n}` }));
      routes.splice(routes.findIndex((x) => x.id === rid) + 1, 0, ...parts);
      setRoute(rid, { status: dry ? 'dry' : 'split', tasks: parts.map((p) => p.id), reason: `Split into ${n} tasks. ${d.reason || ''}`.trim(),
        ...(dry ? { plan: plan.map((t) => ({ action: t.action, target: t.target || '', folder: t.folder || '', name: t.name || '', agent: t.agent || '',
          context_from: t.context_from || [], task: t.task, confidence: t.confidence, reason: t.reason })) } : {}) });
      await Promise.all(parts.map((p, i) => runDecision(p.id, plan[i], plan[i].task, dry).catch((e) => {
        console.error(`route ${p.id} failed:`, e && e.stack || e);
        setRoute(p.id, { status: 'error', error: e.message });
      })));
    } catch (e) {
      console.error(`route ${rid} failed:`, e && e.stack || e);   // the message alone did not say where (2026-11-10)
      setRoute(rid, { status: 'error', error: e.message });
    }
  })();
  return rid;
}

// ---------- transcript tail (last reply / last prompt) ----------
const tailCache = new Map();
function transcriptInfo(folder, sid) {
  if (!isUuid(sid)) return null;
  const file = path.join(PROJECTS, slugOf(folder), sid + '.jsonl');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const c = tailCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.v;
  const size = st.size, len = Math.min(size, 1024 * 1024);
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
  let reply = '', prompt = '', title = '', lastMsg = 0;
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0 && (!reply || !prompt || !title); i--) {
    let j; try { j = JSON.parse(lines[i]); } catch { continue; }
    if (!title && j.type === 'custom-title' && j.customTitle) title = j.customTitle;
    if (!title && j.type === 'ai-title' && j.aiTitle) title = j.aiTitle;
    if (!prompt && j.type === 'last-prompt' && j.lastPrompt) prompt = j.lastPrompt.replace(/\s+/g, ' ').slice(0, 200);
    // time of the newest real message; Claude Code also writes bookkeeping lines (bridge-session,
    // cost-state, file-history-snapshot, …) that change the file time without a new message
    if (!lastMsg && (j.type === 'user' || j.type === 'assistant') && j.timestamp) lastMsg = Date.parse(j.timestamp) || 0;
    const m = j.message; if (!m) continue;
    let text = m.content;
    if (Array.isArray(text)) text = text.map((x) => (x && x.type === 'text' ? x.text : '')).join(' ');
    if (typeof text !== 'string' || !text.trim()) continue;
    text = text.replace(/\s+/g, ' ').trim();
    if (!reply && j.type === 'assistant') reply = text.slice(0, 300);
    if (!prompt && j.type === 'user' && !/^<|^\[Request interrupted/.test(text)) prompt = text.slice(0, 200);
  }
  const v = { reply, prompt, title, mtime: st.mtimeMs, lastMsg };
  tailCache.set(file, { mtime: st.mtimeMs, v });
  return v;
}

function requireCodex() {
  const a = Codex.availability();
  if (!a.available) throw Object.assign(new Error(a.reason), { status: 400 });
}
/** The coding agents this panel can start (GET /api/agents). */
function agentsView() {
  const c = Codex.availability();
  return [{ id: 'claude', name: 'Claude Code', available: true },
    { id: 'codex', name: 'Codex', available: c.available, ...(c.reason ? { reason: c.reason } : {}), ...(c.version ? { version: c.version } : {}) }];
}

// ---------- history (previous sessions per folder) ----------
function readHead(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(bytes);
  const n = fs.readSync(fd, buf, 0, bytes, 0);
  fs.closeSync(fd);
  return buf.slice(0, n).toString('utf8');
}
function summarize(file) {
  let title = '', first = '', cwd = '';
  try {
    const head = readHead(file);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!cwd && j.cwd) cwd = j.cwd;
      if (j.type === 'custom-title' && j.customTitle) title = j.customTitle;
      if (!first && j.type === 'user' && j.message) {
        let c = j.message.content;
        if (Array.isArray(c)) c = c.map((x) => (x && x.type === 'text' ? x.text : '')).join(' ');
        if (typeof c === 'string' && !/^<(local-command|command-|system)/.test(c.trim())) first = c.replace(/\s+/g, ' ').slice(0, 140);
      }
      if (first && cwd) break;
    }
  } catch { /* unreadable */ }
  return { title, first, cwd };
}
/** Claude Code and Codex conversations of a folder, newest first (each item has `agent`). */
function history(folder) {
  let codex = [];
  try { codex = Codex.history(folder); } catch { codex = []; }
  return [...claudeHistory(folder).map((h) => ({ ...h, agent: 'claude' })), ...codex].sort((a, b) => b.mtime - a.mtime).slice(0, 30);
}
function claudeHistory(folder) {
  const dir = path.join(PROJECTS, slugOf(folder));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => { const p = path.join(dir, f); return { sid: f.slice(0, -6), mtime: fs.statSync(p).mtimeMs, file: p }; })
    .sort((a, b) => b.mtime - a.mtime).slice(0, 25)
    .map(({ sid, mtime, file }) => ({ sid, mtime, ...summarize(file) }))
    .filter((x) => x.first || x.title);
}
function recentFolders() {
  if (!fs.existsSync(PROJECTS)) return [];
  const res = new Map();
  for (const d of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, d);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    if (!files.length) continue;
    const newest = files.map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
    const { cwd } = summarize(path.join(dir, newest.f));
    if (!cwd || cwd.startsWith('/private/tmp') || cwd.startsWith('/tmp') || !fs.existsSync(cwd)) continue;
    if (!res.has(cwd) || res.get(cwd) < newest.m) res.set(cwd, newest.m);
  }
  return [...res.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([folder, mtime]) => ({ folder, mtime }));
}

// ---------- actions ----------
async function findSession(id) {
  await poll();
  return snapshot.sessions.find((s) => s.id === id);
}

// ---------- first-run setup wizard (lib/setup.js) ----------
// An install that already has panel data counts as set up (existing users do not see the wizard).
function setupState() {
  const s = Setup.load(INST.home);
  if (!s.done && !fs.existsSync(path.join(INST.home, 'setup.json')) &&
      ['sessions.conf', 'routes.json'].some((f) => fs.existsSync(path.join(INST.home, f)))) {
    s.done = true; s.step = 5; s.migrated = true;
    Setup.save(INST.home, s);
  }
  return s;
}
async function setupView(s = setupState()) {
  const loc = Setup.loadBrainLocation(INST.home);
  const cloud = loc ? await cloudSetupView(s, loc) : null;
  const brainOk = cloud ? cloud.up : process.env.CC_PANEL_NO_BRAIN ? null : await brainUp().catch(() => false);
  return { ...Devices.publicView(s), keepOn: { ack: !!s.keepOn, check: Setup.keepOnCheck() },
    // macOS permissions are not part of setup: Thoth asks for one only when a session needs it (onPermNeed)
    checks: Setup.checks({ brainUp: brainOk, otherDevices: s.devices.some((d) => !d.self), cloudHost: cloud ? cloud.host : '' }),
    local: s.devices.find((d) => d.self).name, cloud };
}
/** The cloud brain for the page: host, up, the devices by status (wants to join, connected,
 * ignored), this computer's own pushes, and the join commands. No tokens. */
async function cloudSetupView(s, loc) {
  const host = new URL(loc.url).host, me = cloudDevice();
  const view = { host, url: loc.url, up: false, error: '', commands: Devices.cloudCommands(loc.url),
    self: { device: me ? me.device : '', joined: !!me, error: s.cloudSelfError || '', push: selfPush.last, pushing: selfPush.running } };
  try {
    const r = await brainRequest('GET', '/api/devices', null, { timeout: 15000 });
    if (r.status === 200 && Array.isArray(r.json)) {
      view.up = true;
      if (me) LOCAL_DEVICE = me.device;
      Object.assign(view, Devices.cloudView(r.json, { later: s.cloudLater || {}, selfName: me ? me.device : '' }));
    } else view.error = r.status === 401 || r.status === 403 ? Devices.connectError('refused').error : `The cloud brain answered with an error (${r.status}).`;
  } catch (e) { view.error = Devices.connectError(Devices.errorKind(e.code), host).error; }
  return view;
}
/** Check a connect link: health (is it a brain?) then an owner call (does it take the key?). */
async function checkCloudLink(link) {
  const p = Setup.parseConnectLink(link);
  if (!p) return { fail: Devices.connectError('link') };
  const target = { cloud: true, url: new URL(p.url), token: p.token };
  try {
    const h = await brainRequest('GET', '/api/health', null, { target, timeout: 15000 });
    if (h.status !== 200 || !h.json || h.json.ok !== true) return { fail: Devices.connectError('notbrain', p.host) };
    const d = await brainRequest('GET', '/api/devices', null, { target, timeout: 15000 });
    if (d.status === 401 || d.status === 403) return { fail: Devices.connectError('refused', p.host) };
    if (d.status !== 200 || !Array.isArray(d.json)) return { fail: Devices.connectError('notbrain', p.host) };
  } catch (e) { return { fail: Devices.connectError(Devices.errorKind(e.code), p.host) }; }
  return { ok: p };
}
/** This computer joins the cloud brain as the owner's own device: a pre-approved code made with
 * the owner token, then the normal join. The device token goes to cloud-device.json (0600). */
async function joinCloudSelf(s, url, name) {
  const me = { ...s.devices.find((d) => d.self), ...(name ? { name } : {}) };
  const old = cloudDevice();
  if (old && old.hub === url) return null;   // already joined (a new link to the same brain)
  // the name can be taken (for example by an earlier connect of this Mac): then name-2, name-3, ...
  let c;
  for (let i = 1; i <= 5; i++) {
    c = await brainRequest('POST', '/api/codes', { device_name: i === 1 ? me.name : `${me.name.slice(0, 28)}-${i}` });
    if (c.status !== 409) break;
  }
  if (c.status !== 200 || !c.json || !c.json.code) return `The cloud brain did not make a code for this computer (${(c.json && c.json.error) || c.status}).`;
  const target = { cloud: true, url: new URL(url), token: '' };
  const j = await brainRequest('POST', '/api/join', { name: me.name, os: me.os, host: os.hostname(), code: c.json.code }, { target });
  if (j.status !== 200 || !j.json || !j.json.token) return `This computer could not join the cloud brain (${(j.json && j.json.error) || j.status}).`;
  fs.rmSync(path.join(INST.home, 'cloud-device-collector-state.json'), { force: true });
  Setup.writeSecret(CLOUD_DEVICE_FILE, { hub: url, device: j.json.device || c.json.device || me.name, token: j.json.token, mode: 'cloud' });
  return null;
}
// Step 5: what the brain has per device and the Claude sessions running outside the panel
// (lib/setup_outside.js). Moving one in reuses actions.new (stops the outside interactive copy and
// resumes it here; a background job is attached, never stopped).
const SetupOutside = require('./lib/setup_outside');
const isDir = (f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } };
async function setupOutsideView() {
  await scanElsewhere();
  const s = setupState();
  let brain = null;
  if (!process.env.CC_PANEL_NO_BRAIN) {
    const t = brainTarget();
    try {
      const list = await brainCall('GET', '/api/devices');
      if (!Array.isArray(list)) throw new Error('refused');
      // a cloud brain also lists devices that only asked to join, or were ignored: not part of the brain
      brain = { up: true, cloud: t.cloud, devices: SetupOutside.brainDevices(s.devices, list.filter((d) => !d.status || d.status === 'approved')) };
    } catch (e) {
      brain = t.cloud ? { up: false, cloud: true, error: `Your cloud brain at ${t.url.host} does not answer.`, fix: 'Check that the server is switched on, then reload this page.' }
        : { up: false, error: 'The brain is not answering on this computer.', fix: 'Start it: python3 brain/brain.py serve' };
    }
  }
  const titleOf = (folder, sid) => { try { const t = transcriptInfo(folder, sid) || Codex.info(sid); return t ? (t.title || t.prompt) : ''; } catch { return ''; } };
  return { brain, outside: SetupOutside.outsideList(elsewhere, { exists: isDir, titleOf, home: HOME }), inPanel: snapshot.sessions.length };
}
/** The computers of the brain for the All Devices page: the brain's list, plus what the page needs
 * to tell the user about a computer that went silent. A joined computer sends every 5 minutes;
 * `silent` = nothing for 20 minutes (it is off or asleep, or it cannot find the brain).
 * `reconnect` = this panel can make a new join command for it. null = the brain does not answer. */
async function deviceList() {
  let list;
  try { list = await brainCall('GET', '/api/devices'); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const s = setupState(), cloud = !!Setup.loadBrainLocation(INST.home), now = Date.now();
  return list.filter((d) => !d.status || d.status === 'approved').map((d) => {
    const sends = d.transport === 'push' || d.transport === 'cloud';
    const last = Number(d.last_sync || 0) * 1000;
    return { ...d, silent: sends && now - last > Devices.SILENT_MS,
      reconnect: !cloud && s.devices.some((x) => x.name === d.name && !x.self) };
  });
}
function setupChange(fn) {
  return async (body) => {
    const s = setupState();
    try { fn(s, body || {}); } catch (e) { const err = new Error(e.message); err.status = 400; throw err; }
    Setup.save(INST.home, s);
    return setupView(s);
  };
}

const actions = {
  setupDevices: setupChange((s, b) => Setup.setDevices(s, b.devices)),
  setupStep: setupChange((s, b) => Setup.setStep(s, b.step)),
  setupBrain: setupChange((s, b) => {
    Setup.setBrain(s, String(b.device || ''));
    Setup.clearBrainLocation(INST.home);   // a computer is the brain again: forget the cloud brain
    syncDeviceListener();
  }),
  // step 3, cloud: paste the connect link; the panel checks it, keeps { url, owner_token } (0600),
  // and this computer joins the cloud brain and starts pushing its sessions
  async setupCloudConnect({ link }) {
    const r = await checkCloudLink(link);
    if (r.fail) { const err = new Error(r.fail.error); err.status = 400; err.extra = r.fail; throw err; }
    Setup.saveBrainLocation(INST.home, { url: r.ok.url, owner_token: r.ok.token });
    const s = setupState();
    Setup.setCloud(s, r.ok.host);
    try { s.cloudSelfError = await joinCloudSelf(s, r.ok.url) || ''; } catch (e) { s.cloudSelfError = `This computer could not join the cloud brain: ${e.message}`; }
    if (!s.cloudSelfError) delete s.cloudSelfError;
    Setup.save(INST.home, s);
    syncDeviceListener();
    pushSelf();
    return setupView(s);
  },
  // a device of the cloud brain: approve / ignore / unignore / revoke (the brain decides), or later (ask again)
  async setupCloudDevice({ id, decision }) {
    id = String(id || ''); decision = String(decision || '');
    if (!id || id.length > 100) throw new Error('No device given');
    if (!Setup.loadBrainLocation(INST.home)) throw new Error('This panel is not connected to a cloud brain');
    const s = setupState();
    if (decision === 'later') {
      s.cloudLater = { ...(s.cloudLater || {}), [id]: Date.now() + Devices.LATER_MS };
    } else if (['approve', 'ignore', 'unignore', 'revoke'].includes(decision)) {
      const r = await brainRequest('POST', `/api/devices/${encodeURIComponent(id)}/${decision}`, {});
      if (r.status !== 200) throw new Error(`The cloud brain did not ${decision} this computer: ${(r.json && r.json.error) || `status ${r.status}`}`);
      if (s.cloudLater) delete s.cloudLater[id];
    } else throw new Error('Choose Approve, Ignore, Later, Unignore or Disconnect');
    Setup.save(INST.home, s);
    return setupView(s);
  },
  // a pre-approved one-time code: the device joins at once, without "wants to join"
  async setupCloudCode({ name }) {
    const loc = Setup.loadBrainLocation(INST.home);
    if (!loc) throw new Error('This panel is not connected to a cloud brain');
    name = String(name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) throw new Error(`Computer name "${name}" is not allowed: use small letters, digits and "-" (up to 31)`);
    const r = await brainRequest('POST', '/api/codes', { device_name: name });
    if (r.status !== 200 || !r.json || !r.json.code) throw new Error(`The cloud brain did not make a code: ${(r.json && r.json.error) || `status ${r.status}`}`);
    const expires = Number(r.json.expires || 0) || Date.now() + Devices.CODE_TTL;
    return { code: r.json.code, device: name, expires: expires < 1e12 ? expires * 1000 : expires, commands: Devices.cloudCommands(loc.url, r.json.code, name) };
  },
  setupKeepOn: setupChange((s, b) => Setup.ackKeepOn(s, b.ack)),
  setupFinish: setupChange((s) => Setup.finish(s)),
  async setupPair({ device }) {
    const s = setupState();
    if (s.brain === Setup.CLOUD) { const err = new Error('Your brain is in the cloud: your other computers join it with the cloud join command'); err.status = 400; throw err; }
    let p;
    try { p = Devices.startPair(s, String(device || '')); } catch (e) { const err = new Error(e.message); err.status = 400; throw err; }
    Setup.save(INST.home, s);
    syncDeviceListener();
    const addresses = deviceListenAddresses().map((a) => `${a}:${DEVICE_PORT}`);
    if (!addresses.length) { const err = new Error('This computer has no local network or Tailscale address, so other devices cannot reach it'); err.status = 400; throw err; }
    return { ...p, addresses, commands: Devices.commands(addresses[0], p.code, p.device) };
  },
  setupRevoke: setupChange((s, b) => Devices.revoke(s, String(b.device || ''))),
  // ---- All Devices page: add or remove a computer at any time (lib/devices.js) ----
  // Add: a one-time code and one command to run on the new computer. Works for a brain on this
  // computer (the computer joins this panel's device listener) and for a cloud brain.
  async deviceAdd({ name, os: dos }) {
    name = String(name || '').trim().toLowerCase(); dos = String(dos || '').trim().toLowerCase();
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    try { Devices.checkNewDevice(name, dos); } catch (e) { throw bad(e.message); }
    const pick = (c) => (dos === 'windows' ? c.windows : c.posix);
    if (Setup.loadBrainLocation(INST.home)) {
      let r; try { r = await actions.setupCloudCode({ name }); } catch (e) { throw bad(e.message); }
      return { mode: 'cloud', device: r.device, os: dos, code: r.code, expires: r.expires, command: pick(r.commands), firewall: null };
    }
    const addresses = deviceListenAddresses().map((a) => `${a}:${DEVICE_PORT}`);
    if (!addresses.length) throw bad('This computer has no local network or Tailscale address, so other computers cannot reach it. Connect it to your network, then try again');
    let taken = [];
    try { const list = await brainCall('GET', '/api/devices'); if (Array.isArray(list)) taken = list.map((d) => d.name); } catch { /* the brain is down: the list in setup.json decides */ }
    const s = setupState();
    let p; try { p = Devices.addDevice(s, name, dos, taken); } catch (e) { throw bad(e.message); }
    Setup.save(INST.home, s);
    syncDeviceListener();
    const fw = Setup.checks({ otherDevices: true }).find((c) => c.id === 'firewall' && !c.ok);
    return { mode: 'local', device: p.device, os: dos, code: p.code, expires: p.expires, command: pick(Devices.commands(addresses[0], p.code, p.device)),
      firewall: fw ? { cause: fw.cause, fix: fw.fix } : null };
  },
  // Has the computer joined, and has the brain got its sessions? (the Add sheet asks every 2 s)
  async deviceStatus({ name }) {
    name = String(name || '');
    if (Setup.loadBrainLocation(INST.home)) {
      const list = await brainCall('GET', '/api/devices').catch(() => []);
      const d = (Array.isArray(list) ? list : []).find((x) => x.name === name && (x.status || 'approved') === 'approved');
      return { joined: !!d, sessions: d ? Number(d.sessions || 0) : 0, pushed: !!(d && (d.last_seen || d.last_sync)) };
    }
    const d = setupState().devices.find((x) => x.name === name && !x.self);
    return { joined: !!(d && d.connected), sessions: d ? Number(d.sessions || 0) : 0, pushed: !!(d && d.lastSeen),
      lastSeen: d ? Number(d.lastSeen || 0) : 0, waiting: !!(d && d.pair && d.pair.expires > Date.now()) };
  },
  // A computer that stopped sending (it cannot find this computer, or it was set up again): a new
  // one-time command for it. Its sessions in the brain stay. Only for a brain on this computer; a
  // cloud brain has a fixed address, so its computers do not lose it.
  async deviceReconnect({ name }) {
    name = String(name || '').trim();
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (Setup.loadBrainLocation(INST.home)) throw bad('Your brain is in the cloud. Its address does not change; check that the other computer is on and online');
    const addresses = hubAddresses();
    if (!addresses.length) throw bad('This computer has no local network or Tailscale address, so other computers cannot reach it. Connect it to your network, then try again');
    const s = setupState();
    let p; try { p = Devices.reconnect(s, name); } catch (e) { throw bad(e.message); }
    const dos = s.devices.find((d) => d.name === name).os;
    Setup.save(INST.home, s);
    syncDeviceListener();
    const c = Devices.commands(addresses[0], p.code, p.device);
    const fw = Setup.checks({ otherDevices: true }).find((x) => x.id === 'firewall' && !x.ok);
    return { mode: 'local', device: p.device, os: dos, code: p.code, expires: p.expires, since: Date.now(), command: dos === 'windows' ? c.windows : c.posix,
      firewall: fw ? { cause: fw.cause, fix: fw.fix } : null };
  },
  // Remove: the computer can no longer send data (token gone), and the brain deletes its sessions
  // and memory files. Nothing on the removed computer itself changes.
  async deviceRemove({ name }) {
    name = String(name || '').trim();
    const bad = (m, status = 400) => Object.assign(new Error(m), { status });
    if (!name || name.length > 100) throw bad('No computer given');
    const s = setupState(), me = cloudDevice();
    if (s.devices.some((d) => d.self && d.name === name) || (me && me.device === name) || name === LOCAL_DEVICE) throw bad('This computer cannot be removed from its own panel');
    const cloud = !!Setup.loadBrainLocation(INST.home);
    // a test instance (verify) that talks to the user's own brain must never delete from it
    if (INST.test && !cloud && !process.env.CC_BRAIN_PORT) throw bad('A test instance cannot remove a computer from your real brain');
    const before = JSON.stringify(s.devices);
    let listed; try { listed = Devices.removeDevice(s, name); } catch (e) { throw bad(e.message); }
    const keep = () => { if (JSON.stringify(s.devices) !== before) { Setup.save(INST.home, s); syncDeviceListener(); } };
    let r;
    try { r = await brainRequest('POST', '/api/devices/remove', { name }); }
    catch { throw bad(cloud ? 'Your cloud brain does not answer, so nothing was removed. Try again when it is up' : 'The brain is not answering on this computer, so nothing was removed. Start it, then try again', 502); }
    const msg = (r.json && r.json.error) || `status ${r.status}`;
    if (r.status === 200) { keep(); return { ok: true, device: name, sessions: Number(r.json.sessions || 0), memories: Number(r.json.memories || 0) }; }
    if (r.status === 404 && /no device called/.test(msg)) {
      if (!listed) throw bad(`There is no computer called "${name}"`, 404);
      keep(); return { ok: true, device: name, sessions: 0, memories: 0 };   // listed, but it never sent anything
    }
    if (r.status === 404) {   // a brain from before this feature: it can disconnect, not delete
      if (cloud) {
        const list = await brainCall('GET', '/api/devices').catch(() => []);
        const d = (Array.isArray(list) ? list : []).find((x) => x.name === name && x.id);
        if (d) await brainRequest('POST', `/api/devices/${encodeURIComponent(d.id)}/revoke`, {});
        keep();
        return { ok: true, device: name, partial: true, note: `"${name}" is disconnected, but your cloud brain is an older version and kept its sessions. Update the brain on the server, then remove "${name}" again.` };
      }
      throw bad('The brain on this computer is an older version and cannot remove a computer. Restart the brain, then try again', 409);
    }
    throw bad(`The brain did not remove "${name}": ${msg}`, r.status === 409 ? 400 : 502);
  },
  // guided fixes (lib/setup_fix.js): open System Settings, a password prompt, or Terminal, on THIS Mac
  async setupFix({ id }) { return SetupFix.runFix(String(id || ''), { app: Permissions.lastApp() }); },
  async setupMoveIn({ sid }) {
    if (!isUuid(sid)) throw new Error('Bad session id');
    await scanElsewhere();
    const args = SetupOutside.moveInArgs(elsewhere.get(sid), isDir);
    const { id } = await actions.new(args);
    return { id, sid, name: args.name };
  },
  async upload({ name, data }) {
    // web UI: base64 image -> file in the attachments folder
    const ext = (String(name || '').match(IMAGE_EXT) || ['.png'])[0].toLowerCase();
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length || buf.length > 20 * 1024 * 1024) throw new Error('Bad image');
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    const file = path.join(ATTACH_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    fs.writeFileSync(file, buf);
    return { path: file };
  },
  async highlight({ code, lang }) {
    if (typeof code !== 'string' || code.length > 200000) throw new Error('Bad code');
    return { html: await highlight(code, lang) };
  },
  // Take over a Claude Code or Codex session that runs in another terminal (VS Code etc.).
  // The panel prepares a window and resumes the conversation as soon as the
  // outside process has exited, so one conversation never runs in two places.
  async adopt({ sid, folder, pid, name, agent }) {
    if (!isUuid(sid)) throw new Error('Bad session id');
    if (agent !== undefined && agent !== null && agent !== '' && !AGENTS.has(agent)) throw new Error('Unknown agent');
    agent = agentOf(agent);
    if (agent === 'codex') {
      requireCodex();
      if (!Codex.rolloutFile(sid)) throw new Error(`No Codex conversation ${sid} in ~/.codex/sessions`);
    }
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Folder not found');
    const outside = Number(pid);
    if (!Number.isInteger(outside) || outside <= 1) throw new Error('Bad pid');
    await poll();
    let s = snapshot.sessions.find((x) => x.sid === sid);
    if (s && s.running) return { id: s.id, already: true };
    let id = s && s.id;
    if (!id) {
      const info = agent === 'codex' ? Codex.info(sid) : transcriptInfo(folder, sid);
      const label = String(name || (info && info.title) || path.basename(folder)).slice(0, 30);
      id = await createWindow({ name: label, folder, sid, run: false, agent });
    }
    adoptions.set(id, { sid, pid: outside, until: Date.now() + 120000, agent });
    watchAdoptions();
    return { id };
  },
  async testScope({ ids, ttlSec }) {
    if (!ids || !ids.length) { testScope = null; return { scope: null }; }
    testScope = { ids: new Set(ids), until: Date.now() + Math.min(Number(ttlSec) || 600, 1800) * 1000 };
    return { scope: [...testScope.ids], until: testScope.until };
  },
  async route({ text, dry, attachments }) {
    text = withAttachments(text, attachments);
    if (!text) throw new Error('Empty request');
    return { routeId: await route(text, !!dry) };
  },
  async routeTo({ routeId, target, folder, name, agent }) {
    const r = routes.find((x) => x.id === routeId);
    if (!r) throw new Error('Request not found');
    let id = target;
    if (!id) {
      if (!folder) folder = defaultFolder();   // "New session" without a folder choice
      if (!fs.existsSync(folder)) throw new Error('Folder not found');
      if (agentOf(agent) === 'codex') requireCodex();
      id = await createWindow({ name: taskName(name || r.newName, r.text), folder, sid: '', run: true, agent });
      await poll();
    }
    const ts = snapshot.sessions.find((x) => x.id === id);
    setRoute(routeId, { decided: 'manual', reason: `You chose ${ts ? ts.name : 'a new session'}.`, choices: [] });
    await deliver(id, r.task || r.text, routeId);
    return { id };
  },
  // Queue a message for a session: sent when Claude there is ready (e.g. after the
  // folder-trust prompt). Used by cross-device handoff (brain/handoff.py --run panel).
  async queue({ id, text }) {
    if (!text || !text.trim()) throw new Error('Empty message');
    await poll();
    await deliver(id, text, null);
    return {};
  },
  async dismissRoute({ routeId }) {
    routes = routes.filter((x) => x.id !== routeId);
    saveRoutes(); snapshot.routes = routes.slice(0, 30); broadcast();
    return {};
  },
  async new({ folder, sid, name, mcp, agent }) {
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Folder not found');
    if (sid && !isUuid(sid)) throw new Error('Bad session id');
    if (agent !== undefined && agent !== null && agent !== '' && !AGENTS.has(agent)) throw new Error('Unknown agent');
    if (agentOf(agent) === 'codex') {
      // a Codex conversation already open in the panel: show that window instead of a second copy
      requireCodex();
      if (sid) {
        await poll();
        const open = snapshot.sessions.find((x) => x.sid === sid && x.agent === 'codex' && x.running);
        if (open) return { id: open.id, already: true };
        // the conversation is open outside the panel: stop it there first, then resume it here
        await scanElsewhere();
        const out = elsewhere.get(sid);
        if (out && out.agent === 'codex') {
          try { process.kill(out.pid, 'SIGTERM'); } catch { /* gone */ }
          for (let i = 0; i < 50 && alive(out.pid); i++) await sleep(200);
          if (alive(out.pid)) throw new Error(`The other Codex (pid ${out.pid}) did not stop; close it there and try again`);
          elsewhere.delete(sid);
        }
        const stopped = snapshot.sessions.find((x) => x.sid === sid && x.agent === 'codex');
        if (stopped) { await tmux(['send-keys', '-t', stopped.id, 'C-l']); await startCodex(stopped.id, sid); return { id: stopped.id }; }
      }
      const id = await createWindow({ name: (name || path.basename(folder)).slice(0, 30), folder, sid, run: true, agent: 'codex' });
      return { id };
    }
    if (sid) await scanElsewhere();
    const plan = sid ? migrationPlan(elsewhere.get(sid)) : { kind: 'none' };
    if (plan.kind === 'stop') {
      // the conversation is open outside the panel: stop it there first, then resume it here
      try { process.kill(plan.pid, 'SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 50 && alive(plan.pid); i++) await sleep(200);
      if (alive(plan.pid)) throw new Error(`The other Claude (pid ${plan.pid}) did not stop; close it there and try again`);
    }
    if (plan.kind === 'attach') {
      const id = await createWindow({ name: (name || path.basename(folder)).slice(0, 30), folder, sid, run: false,
        mcp: mcp === 'brain' ? 'brain' : '' });
      await migrateHere(id, sid);
      return { id };
    }
    const id = await createWindow({ name: (name || path.basename(folder)).slice(0, 30), folder, sid, run: true,
      mcp: mcp === 'brain' ? 'brain' : '' });
    return { id };
  },
  async start({ id }) {
    const s = await findSession(id);
    if (!s) throw new Error('No such session');
    if (s.running) return {};
    if (s.state === 'elsewhere' && await migrateHere(id, s.sid)) return {};
    await tmux(['send-keys', '-t', id, 'C-l']);
    await startAgent(id, isUuid(s.sid) ? s.sid : '', s.agent);
    return {};
  },
  async interrupt({ id }) { await tmux(['send-keys', '-t', id, 'Escape']); return {}; },
  async choose({ id, n }) {
    const s = await findSession(id);
    if (!s || !s.options.length) throw new Error('No choice is waiting');
    const screen = (await tmux(['capture-pane', '-p', '-J', '-t', id])) || '';
    const cur = screenOf(s.agent).parse(screen).selected;
    const target = Number(n);
    if (!s.options.some((o) => o.n === target)) throw new Error('Bad option');
    // positions in the list (Codex numbers its options; Claude's are 1..n already)
    const pos = (n) => s.options.findIndex((o) => o.n === n) + 1;
    const delta = pos(target) - (cur > 0 ? Math.max(1, pos(cur)) : 1);
    const key = delta > 0 ? 'Down' : 'Up';
    for (let i = 0; i < Math.abs(delta); i++) { await tmux(['send-keys', '-t', id, key]); await sleep(40); }
    await tmux(['send-keys', '-t', id, 'Enter']);
    setTimeout(poll, 300);
    return {};
  },
  async send({ id, text, attachments }) {
    const full = withAttachments(text, attachments);
    if (!full) throw new Error('Empty message');
    // the chat shows the message now, not when Claude writes it to the transcript (after its prompt hooks)
    const shown = String(text || '').trim() || (attachments || []).map((p) => path.basename(p)).join(' ');
    const echo = { text: shown, at: Date.now(), phase: 'sending' };
    echoes.set(id, [...(echoes.get(id) || []), echo]);
    const typed = await tmux(['send-keys', '-t', id, '-l', '--', full.replace(/\r?\n/g, ' ')]);
    if (typed === null) { echoes.set(id, (echoes.get(id) || []).filter((x) => x !== echo)); return {}; }
    await sleep(80);
    await tmux(['send-keys', '-t', id, 'Enter']);
    return {};
  },
  async rename({ id, name }) {
    if (!name || !name.trim()) throw new Error('Empty name');
    const n = name.trim().slice(0, 30);
    // @label is the user's name; it survives programs that rename tmux windows
    await tmux(['set-option', '-w', '-t', id, '@label', n]);
    await tmux(['rename-window', '-t', id, n]);
    return {};
  },
  async close({ id }) {
    const s = await findSession(id);
    if (s && s.running) {
      await tmux(['send-keys', '-t', id, 'Escape']);
      await sleep(150);
      await tmux(['send-keys', '-t', id, '-l', '--', s.agent === 'codex' ? '/quit' : '/exit']);
      // Codex opens its command list first; an Enter sent at once is lost (a test run)
      await sleep(600);
      await tmux(['send-keys', '-t', id, 'Enter']);
      for (let i = 0; i < 25; i++) {
        await sleep(200);
        const cmd = ((await tmux(['display-message', '-p', '-t', id, '#{pane_current_command}'])) || '').trim();
        if (SHELLS.has(cmd)) break;
      }
    }
    await tmux(['kill-window', '-t', id]);
    return {};
  },
  async pickFolder() {
    const out = await new Promise((r) => execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a project folder for Claude Code")'], (e, o) => r(e ? '' : o)));
    return { folder: out.trim().replace(/\/$/, '') };
  },
  async reveal({ folder, app }) {
    if (!fs.existsSync(folder)) throw new Error('Folder not found');
    const args = app === 'code' ? ['-a', 'Visual Studio Code', folder] : [folder];
    execFile('open', args);
    return {};
  },
};

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
const STATIC = {
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
const STATIC_DIRS = { '/vendor/fonts/': 'node_modules/katex/dist/fonts/' };

// chat items for one session, read from its transcript
const chatCache = new Map();
function chatFor(win) {
  const s = snapshot.sessions.find((x) => x.id === win);
  if (!s) return null;
  if (!isUuid(s.sid)) return { sid: '', mtime: 0, items: [] };
  if (s.agent === 'codex') return Codex.chat(s.sid);
  const file = path.join(PROJECTS, slugOf(s.folder), s.sid + '.jsonl');
  let st;
  try { st = fs.statSync(file); } catch { return { sid: s.sid, mtime: 0, items: [] }; }
  const c = chatCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.v;
  const v = { sid: s.sid, mtime: st.mtimeMs, items: parseTranscript(fs.readFileSync(file, 'utf8'), { limit: 300 }) };
  chatCache.set(file, { mtime: st.mtimeMs, v });
  return v;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  // Central brain (brain.json's cloud URL, else brain/brain.py on 127.0.0.1:7879): sessions from every device.
  // Read-only proxy so the app talks to one port. GET /api/brain/<x> -> /api/<x>; POST /api/brain/sync.
  if (url.pathname.startsWith('/api/brain/')) {
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && !ORIGINS.has(origin)) return sendJson(res, 403, { error: 'Bad origin' });
    const sub = url.pathname.slice('/api/brain/'.length);
    if (!/^(health|devices|projects|sessions|sync|handoffs|handoff)$/.test(sub)) return sendJson(res, 404, { error: 'Unknown brain path' });
    const isPost = sub === 'sync' || sub === 'handoff';
    if (isPost !== (req.method === 'POST')) return sendJson(res, 405, { error: 'Method not allowed' });
    // the brain's tokens stay on this machine; the server adds them for the app (local brain: the
    // write token on POSTs; cloud brain: the owner token on every call, see brainOptions)
    const target = brainTarget();
    const { mod, opts } = brainOptions(target, req.method, `/api/${sub}${url.search}`, 60000);
    const preq = mod.request(opts, (pres) => {
      res.writeHead(pres.statusCode, { 'Content-Type': 'application/json' });
      pres.pipe(res);
    });
    preq.on('error', () => sendJson(res, 503, { error: target.cloud ? `Your cloud brain at ${target.url.host} does not answer.`
      : 'Central brain is not running. Start it: python3 brain/brain.py serve' }));
    preq.on('timeout', () => preq.destroy());
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        if (sub === 'handoff') {
          // tell the brain which panel to open the session in (this server)
          try { const j = JSON.parse(body || '{}'); j.panel_url = `http://${HOST}:${PORT}`; body = JSON.stringify(j); } catch { body = '{}'; }
        }
        preq.end(body);
      });
      return;
    }
    return preq.end();
  }
  // Claude Code hooks of the panel's sessions (lib/claude_args.js stateHooks): only from this Mac
  if (req.method === 'POST' && url.pathname === '/api/hook') {
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '') || req.headers.origin) return sendJson(res, 403, { error: 'Local hooks only' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}') || {}; } catch { payload = {}; }
      const event = url.searchParams.get('event') || payload.hook_event_name || '';
      onHook(event, String(req.headers['x-pane'] || ''), payload).catch(() => {});
      onPermNeed(event, String(req.headers['x-pane'] || ''), payload).catch(() => {});
      sendJson(res, 200, {});
    });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && !ORIGINS.has(origin)) return sendJson(res, 403, { error: 'Bad origin' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const name = url.pathname.slice(5);
      if (!Object.hasOwn(actions, name)) return sendJson(res, 404, { error: 'Unknown action' });
      // fixes act on this Mac's screen (System Settings, password prompt): only for a request from this Mac
      if (name === 'setupFix' && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '')) return sendJson(res, 403, { error: 'Fixes run only from this computer' });
      try {
        const result = await actions[name](body ? JSON.parse(body) : {});
        setTimeout(poll, 200);
        sendJson(res, 200, result || {});
      } catch (e) { sendJson(res, 400, { error: e.message, ...(e.extra ? { problem: e.extra } : {}) }); }
    });
    return;
  }
  if (url.pathname === '/api/history') return sendJson(res, 200, history(url.searchParams.get('folder') || ''));
  if (url.pathname === '/api/folders') return sendJson(res, 200, recentFolders());
  if (url.pathname === '/api/agents') return sendJson(res, 200, agentsView());
  if (url.pathname === '/api/state') return sendJson(res, 200, snapshot);
  if (url.pathname === '/api/setup') return sendJson(res, 200, await setupView());
  if (url.pathname === '/api/deviceList') return sendJson(res, 200, await deviceList());
  if (url.pathname === '/api/setupOutside') return sendJson(res, 200, await setupOutsideView());
  // the app's permission guide checks the state here (PermissionGuide.swift)
  if (url.pathname === '/api/permissions') return sendJson(res, 200, { checks: Permissions.checks(await Permissions.state({ tmuxArgs: INST.tmuxArgs })) });
  if (url.pathname === '/api/setupDiagnostics') {
    const brainOk = process.env.CC_PANEL_NO_BRAIN ? null : await brainUp().catch(() => false);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(Setup.diagnostics({ home: INST.home, logFile: path.join(INST.home, 'server.log'), brainUp: brainOk }));
  }
  if (url.pathname === '/' && !setupState().done) { res.writeHead(302, { Location: '/setup.html' }); return res.end(); }
  if (url.pathname === '/api/chat') {
    const c = chatFor(url.searchParams.get('win') || '');
    if (!c) return sendJson(res, 404, { error: 'No such session' });
    const pending = echoesFor(url.searchParams.get('win') || '', c.items);
    if (Number(url.searchParams.get('since')) === c.mtime && c.mtime) return sendJson(res, 200, { unchanged: true, mtime: c.mtime, pending });
    return sendJson(res, 200, { ...c, pending });
  }
  if (url.pathname === '/api/thumb') {
    // first-page preview of an attached document (attachments folder only)
    const p = path.resolve(url.searchParams.get('path') || '');
    if (!p.startsWith(ATTACH_DIR + path.sep) || !ATTACH_EXT.test(p)) { res.writeHead(403); return res.end(); }
    thumbnail(p, url.searchParams.get('size')).then((png) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(png).pipe(res);
    }, () => { res.writeHead(404); res.end(); });
    return;
  }
  if (url.pathname === '/api/sent') {
    // an image that the session's Claude sent with SendUserFile; no other path is served
    const c = chatFor(url.searchParams.get('win') || '');
    const p = path.resolve(url.searchParams.get('path') || '');
    if (!c || !IMAGE_EXT.test(p) || !wasSent(c.items, p)) { res.writeHead(403); return res.end(); }
    return fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/' + (path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg')), 'Cache-Control': 'max-age=3600' });
      res.end(data);
    });
  }
  if (url.pathname === '/api/attachment') {
    // only files in the attachments folder are served
    const p = path.resolve(url.searchParams.get('path') || '');
    if (!p.startsWith(ATTACH_DIR + path.sep) || !IMAGE_EXT.test(p)) { res.writeHead(403); return res.end(); }
    return fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/' + (path.extname(p).slice(1).replace('jpg', 'jpeg')), 'Cache-Control': 'max-age=3600' });
      res.end(data);
    });
  }

  const dirKey = Object.keys(STATIC_DIRS).find((k) => url.pathname.startsWith(k));
  let file = dirKey ? path.join(__dirname, STATIC_DIRS[dirKey], path.basename(url.pathname))
    : STATIC[url.pathname] ? path.join(__dirname, STATIC[url.pathname])
    : path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
const server = http.createServer(handleRequest);

// ---------- websockets ----------
const stateClients = new Set();
function broadcast() {
  const msg = JSON.stringify({ type: 'state', ...snapshot });
  for (const ws of stateClients) if (ws.readyState === 1) ws.send(msg);
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (!ORIGINS.has(origin)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

let viewSeq = 0;
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === '/ws/state') {
    stateClients.add(ws);
    ws.send(JSON.stringify({ type: 'state', ...snapshot }));
    ws.on('close', () => stateClients.delete(ws));
    return;
  }
  if (url.pathname === '/ws/term') {
    const win = url.searchParams.get('win') || '';
    if (!/^@\d+$/.test(win)) return ws.close();
    const cols = Math.max(20, Math.min(500, Number(url.searchParams.get('cols')) || 120));
    const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 40));
    // A grouped session gives this view its own current window without moving other viewers.
    const view = `ccview-${process.pid}-${++viewSeq}`;
    const term = pty.spawn('tmux', [...INST.tmuxArgs,
      'new-session', '-t', S, '-s', view, ';',
      'set-option', '-t', view, 'destroy-unattached', 'on', ';',
      'set-option', '-t', view, 'status', 'off', ';',
      'set-option', '-t', view, 'mouse', 'on', ';',
      'set-option', '-t', view, 'history-limit', '50000', ';',
      'select-window', '-t', `${view}:${win}`,
    ], { name: 'xterm-256color', cols, rows, cwd: HOME, env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' } });
    term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
    term.onExit(() => { try { ws.close(); } catch { /* closed */ } });
    ws.on('message', (raw) => {
      const msg = raw.toString();
      if (msg.startsWith('\x00resize:')) {
        const [c, r] = msg.slice(8).split(',').map(Number);
        if (c > 0 && r > 0) term.resize(Math.min(c, 500), Math.min(r, 200));
        return;
      }
      term.write(msg);
    });
    ws.on('close', () => { try { term.kill(); } catch { /* gone */ } tmux(['kill-session', '-t', view]); });
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
(async () => {
  const out = (await tmux(['list-sessions', '-F', '#{session_name}'])) || '';
  // only views of servers that are gone: another server may share this tmux server
  for (const s of out.split('\n')) {
    const m = /^ccview-(?:native-)?(\d+)/.exec(s);
    if (m && !alive(Number(m[1]))) await tmux(['kill-session', '-t', s]);
  }
})();
tmux(['set-option', '-g', '-t', S, 'history-limit', '50000']);
setInterval(poll, 1500);
setInterval(scanElsewhere, 5000);
scanElsewhere().then(poll);
server.listen(PORT, HOST, () => console.log(`thoth on http://${HOST}:${PORT}`));

// ---------- remote access for the iPhone app ----------
// Off by default. When on, a second listener binds ONLY to Tailscale addresses and every
// request / WebSocket needs the pairing token (scripts/pair.js prints it).
const remote = { servers: new Map(), token: '' };
function remoteGate(req) {
  if (!Remote.authorized(req, remote.token)) return false;
  // never pass the token on (e.g. to the brain proxy, which forwards the query string)
  const u = new URL(req.url, 'http://x');
  u.searchParams.delete('token');
  req.url = u.pathname + (u.search || '');
  return true;
}
function syncRemote() {
  if (!Remote.enabled(INST.home)) {
    for (const [ip, srv] of remote.servers) { srv.close(); remote.servers.delete(ip); }
    return;
  }
  remote.token = Remote.loadToken(INST.home);
  const port = Number(process.env.CC_PANEL_REMOTE_PORT || PORT);
  const want = process.env.CC_PANEL_REMOTE_TEST_HOST ? [process.env.CC_PANEL_REMOTE_TEST_HOST]
    : Remote.tailscaleAddresses(os.networkInterfaces());
  for (const [ip, srv] of remote.servers) if (!want.includes(ip)) { srv.close(); remote.servers.delete(ip); }
  for (const ip of want) {
    if (remote.servers.has(ip)) continue;
    const srv = http.createServer((req, res) => {
      if (!remoteGate(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      handleRequest(req, res);
    });
    srv.on('upgrade', (req, socket, head) => {
      if (!remoteGate(req)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    srv.on('error', (e) => { console.log(`remote ${ip}:${port}: ${e.message}`); remote.servers.delete(ip); });
    srv.listen(port, ip, () => console.log(`remote access on http://${ip.includes(':') ? `[${ip}]` : ip}:${port} (token required)`));
    remote.servers.set(ip, srv);
  }
}
syncRemote();
setInterval(syncRemote, 30000);

// ---------- device listener (lib/devices.js) ----------
// Other devices join with a one-time code and push their sessions with their own token. Bound to
// private LAN and Tailscale addresses only, and only while setup lists other devices. It serves
// nothing else: no panel, no state.
const DEVICE_PORT = Number(process.env.CC_PANEL_DEVICE_PORT || 7870);
const devListen = new Map();
const joinFails = [];
const proveHits = [];
/** Every address a device can reach this computer on, now ("ip:port"; Tailscale first). A device
 * keeps the list, so it has more than one way back when one address changes. */
const hubAddresses = () => deviceListenAddresses().map((a) => `${a}:${DEVICE_PORT}`);
function deviceListenAddresses() {
  return process.env.CC_PANEL_DEVICE_TEST_HOST ? [process.env.CC_PANEL_DEVICE_TEST_HOST] : Devices.deviceAddresses(os.networkInterfaces());
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const DEVICE_FILES = { '/join.sh': 'device/join.sh', '/join.ps1': 'device/join.ps1',
  '/device/collector.py': 'brain/collector.py', '/device/device_agent.py': 'device/device_agent.py' };
async function deviceRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && DEVICE_FILES[url.pathname]) {
    let body = fs.readFileSync(path.join(__dirname, DEVICE_FILES[url.pathname]), 'utf8');
    if (url.pathname.startsWith('/join.')) body = body.replace('__HUB__', `http://${req.headers.host}`);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  if (req.method === 'POST' && url.pathname === '/api/join') {
    const now = Date.now();
    while (joinFails.length && joinFails[0] < now - 60_000) joinFails.shift();
    if (joinFails.length >= 10) return sendJson(res, 429, { error: 'Too many wrong codes; wait a minute' });
    let b; try { b = await readBody(req, 10_000); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const s = setupState();
    const r = Devices.redeem(s, b.code, b.host);
    if (!r) { joinFails.push(now); return sendJson(res, 403, { error: 'The code is wrong, used or expired. Make a new one on the setup page' }); }
    Setup.save(INST.home, s);
    console.log(`device joined: ${r.device}`);
    return sendJson(res, 200, { ...r, addresses: hubAddresses() });
  }
  // "Are you the brain I joined?" (lib/devices.js prove). A device asks this before it sends its
  // token, and when it looks for this computer on a new address. Nothing secret is in the answer.
  if (req.method === 'POST' && url.pathname === '/api/hub/prove') {
    const now = Date.now();
    while (proveHits.length && proveHits[0] < now - 60_000) proveHits.shift();
    if (proveHits.length >= 600) return sendJson(res, 429, { error: 'Too many requests; wait a minute' });
    proveHits.push(now);
    let b; try { b = await readBody(req, 2_000); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const proof = Devices.prove(setupState(), String(b.device || ''), b.nonce);
    if (!proof) return sendJson(res, 403, { error: 'refused: this device is unknown here' });
    return sendJson(res, 200, { proof, addresses: hubAddresses() });
  }
  if (req.method === 'POST' && url.pathname === '/api/device/push') {
    const s = setupState();
    const d = Devices.byToken(s, Remote.requestToken(req));
    if (!d) return sendJson(res, 403, { error: 'refused: this device is revoked or unknown; pair again from the setup page' });
    let b; try { b = await readBody(req, 50_000_000); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    let r = await brainCall('POST', '/api/ingest', { device: d.name, doc: b.doc || {} }).catch((e) => ({ error: e.message }));
    if (r && /token/.test(r.error || '')) r = await brainCall('POST', '/api/ingest', { device: d.name, doc: b.doc || {} }).catch((e) => ({ error: e.message }));
    if (!r || r.error) return sendJson(res, 502, { error: `the brain did not accept the data: ${(r && r.error) || 'no answer'}` });
    const s2 = setupState(); const d2 = s2.devices.find((x) => x.name === d.name);
    if (d2) { d2.sessions = r.sessions; d2.lastSeen = Date.now(); Setup.save(INST.home, s2); }
    return sendJson(res, 200, { ok: true, sessions: r.sessions, updated: r.updated, dialogue: !!r.dialogue, addresses: hubAddresses() });
  }
  return sendJson(res, 404, { error: 'not found' });
}
function syncDeviceListener() {
  const st = setupState();   // a cloud brain: other computers connect out to it, never to this one
  const want = st.devices.some((d) => !d.self) && st.brain !== Setup.CLOUD ? deviceListenAddresses() : [];
  for (const [ip, srv] of devListen) if (!want.includes(ip)) { srv.close(); devListen.delete(ip); }
  for (const ip of want) {
    if (devListen.has(ip)) continue;
    const srv = http.createServer((req, res) => { deviceRequest(req, res).catch((e) => sendJson(res, 500, { error: e.message })); });
    srv.on('error', (e) => { console.log(`device listener ${ip}:${DEVICE_PORT}: ${e.message}`); devListen.delete(ip); });
    srv.listen(DEVICE_PORT, ip, () => console.log(`device listener on ${ip}:${DEVICE_PORT} (join + push only)`));
    devListen.set(ip, srv);
  }
}
syncDeviceListener();
setInterval(syncDeviceListener, 30000);
