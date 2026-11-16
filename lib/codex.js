// Codex sessions in the panel: the same tmux window model as Claude Code, but the
// window runs the OpenAI Codex CLI (`codex`). This file holds everything that is Codex-specific:
//   - the command the panel types (brain MCP tools + prompt hook passed with -c, never written
//     into the user's ~/.codex/config.toml; the update prompt is switched off),
//   - the screen parser (idle / working / needs + menu options), tested against saved screens,
//   - the session records ("rollouts") in ~/.codex/sessions: find a window's session id, the last
//     reply and prompt, the chat items and the history of a folder.
// Checked with codex-cli 0.163.0 and 0.167.0 (2026-11-10).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// ---------- command ----------

/** A value as TOML (for `codex -c key=value`): strings, numbers, booleans, arrays, inline tables. */
function toml(v) {
  if (Array.isArray(v)) return `[${v.map(toml).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toml(x)}`).join(',')}}`;
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

/**
 * The text after `codex` (starts with a space). brain = { mcp, settings } (the brain's session
 * files, the same ones Claude gets with --mcp-config / --settings) or null.
 * Codex reads Claude-format UserPromptSubmit hooks (stdin {prompt, cwd, session_id, …}, output
 * hookSpecificOutput.additionalContext), so the brain's hook works unchanged.
 */
const BRAIN_ENV = ['CC_BRAIN_URL', 'CC_BRAIN_TOKEN', 'CC_BRAIN_DIR', 'CC_BRAIN_PORT', 'CC_PANEL_HOME'];
// The panel's state hooks for Codex (lib/hookstate.js). Codex 0.167 has no Notification event and
// sends Interrupt on Esc. Codex asks once to trust new hook commands ("Hooks need review"); the
// commands depend only on the port, so the trust stays for later sessions.
const STATE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
  'Stop', 'Interrupt', 'SessionEnd'];
function codexArgs(brain, hooks = null) {
  const out = ['check_for_update_on_startup=false'];
  const groups = {}; // event -> matcher groups (the brain's prompt hook first, then the state hooks)
  if (brain) {
    try {
      const servers = (JSON.parse(fs.readFileSync(brain.mcp, 'utf8')) || {}).mcpServers || {};
      for (const [name, s] of Object.entries(servers)) {
        if (!/^[A-Za-z0-9_-]+$/.test(name) || !s || !s.command) continue;
        const t = { command: s.command };
        if (Array.isArray(s.args)) t.args = s.args;
        if (s.env && typeof s.env === 'object') t.env = s.env;
        // Codex starts MCP servers with a clean environment; the brain's settings must pass through
        // (found by a test run: without this the tools asked the default local brain)
        t.env_vars = BRAIN_ENV;
        out.push(`mcp_servers.${name}=${toml(t)}`);
      }
    } catch { /* no MCP file: no tools */ }
    try {
      const hooks = (JSON.parse(fs.readFileSync(brain.settings, 'utf8')) || {}).hooks || {};
      if (Array.isArray(hooks.UserPromptSubmit)) groups.UserPromptSubmit = [...hooks.UserPromptSubmit];
    } catch { /* no hook */ }
  }
  for (const [e, g] of Object.entries(hooks || {})) if (Array.isArray(g)) groups[e] = [...(groups[e] || []), ...g];
  for (const [e, g] of Object.entries(groups)) out.push(`hooks.${e}=${toml(g)}`);
  return out.map((x) => ` -c ${shq(x)}`).join('');
}

/** The full command line for a window: a new session, or `codex resume <sid>`. */
function command(sid, brain, hooks = null) {
  return (sid && SID.test(sid) ? `codex resume ${sid}` : 'codex') + codexArgs(brain, hooks);
}

/** Is the codex CLI installed? { available, reason, version } (cached for a minute). */
let availCache = null;
function availability() {
  if (availCache && Date.now() - availCache.t < 60000) return availCache.v;
  let v;
  try {
    const out = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const loggedIn = fs.existsSync(path.join(codexHome(), 'auth.json')) || !!process.env.OPENAI_API_KEY;
    v = loggedIn ? { available: true, version: out } : { available: true, version: out, reason: 'Codex is installed but not signed in. Run: codex login' };
  } catch {
    v = { available: false, reason: 'Codex is not installed. Install it with: npm install -g @openai/codex, then run: codex login' };
  }
  availCache = { t: Date.now(), v };
  return v;
}

// ---------- screen ----------

const MENU_HINT = /enter (to )?(confirm|continue|select)|esc to cancel|esc (back|skip)|press enter/i;
const OPT = /^(\s*)(›|\s)\s(\d+)\.\s+(\S.*)$/;   // "› 1. Yes, proceed (y)" or "  2. Skip"

/**
 * Codex's screen -> { state, last, options, selected, question, live } (same shape as
 * lib/screen.js parseScreen for Claude). States: 'needs' (a numbered menu: approval, folder
 * trust, hook review, …), 'working' ("Working (12s • esc to interrupt)"), else 'idle'.
 */
function parseScreen(text) {
  const lines = String(text || '').replace(ANSI, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-30);

  // a menu: the last "› N." line with numbered siblings at the same indent, and a key hint below
  let at = -1;
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 16); i--) {
    const m = tail[i].match(OPT);
    if (m && m[2] === '›') { at = i; break; }
  }
  const options = [];
  let selected = -1, question = '', hinted = false;
  if (at >= 0) {
    const indent = tail[at].match(OPT)[1].length;
    let a = at, b = at;
    const isOpt = (l) => { const m = l.match(OPT); return m && m[1].length === indent; };
    while (a - 1 >= 0 && isOpt(tail[a - 1])) a--;
    while (b + 1 < tail.length && (isOpt(tail[b + 1]) || (tail[b + 1].trim() && /^\s{4,}\S/.test(tail[b + 1]) && !MENU_HINT.test(tail[b + 1])))) b++;
    for (let i = a; i <= b; i++) {
      const m = tail[i].match(OPT);
      if (m && m[1].length === indent) {
        options.push({ n: Number(m[3]), label: m[4].replace(/\s+/g, ' ').trim() });
        if (i === at) selected = Number(m[3]);
      } else if (options.length) options[options.length - 1].label += ' ' + tail[i].trim();
    }
    for (let i = b + 1; i < Math.min(tail.length, b + 5); i++) if (MENU_HINT.test(tail[i])) { hinted = true; break; }
    // the heading that asks: "Would you like to run …?", "Trust this folder? …", "Hooks need review"
    const above = tail.slice(Math.max(0, a - 12), a).map((l) => l.trim()).filter(Boolean);
    const q = above.find((l) => /^(Would you like|Do you want|Allow\b|Trust this|Hooks need review|Update available)/i.test(l))
      || above.reverse().find((l) => /\?/.test(l)) || '';
    question = q.replace(/^(.*?\?)\s.*$/, '$1');
  }
  const validMenu = options.length >= 2 && selected > 0 && hinted;

  let live = '';
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(/•\s+(Working\s*\(([^()]*?)\s*•\s*esc to interrupt\))/i);
    if (m) { live = `Working (${m[2].trim()})`; break; }
  }
  let state;
  if (validMenu) state = 'needs';
  else if (live || /esc to interrupt/i.test(tail.join('\n'))) state = 'working';
  else state = 'idle';

  // last reply line on the screen ("• text"), skipping tool lines; the transcript is preferred
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (/^•\s/.test(l) && !/^•\s+(Working|Ran|Running|Added|Edited|Deleted|Explored|Read|Searched|Updated|Waited|Called|Viewed)\b/.test(l)) { last = l.replace(/^•\s+/, ''); break; }
  }
  return { state, last, options: validMenu ? options.map(({ n, label }) => ({ n, label })) : [], selected, question,
    live: state === 'working' ? live : '' };
}

// Placeholders Codex shows (dim) in an empty input box.
const PLACEHOLDER = /^(Ask Codex to do anything|Find and fix a bug in @filename|Improve documentation in @filename|Explain this codebase|Summarize recent commits|Implement \{feature\}|Write tests for @filename|Run \/review on my current changes|Use \/skills to list available skills)$/;

/** The text in Codex's input box: the last "› …" line (plus its wrapped lines) above the footer. */
function inputBoxText(screen) {
  const lines = String(screen || '').replace(ANSI, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let at = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    if (/^› /.test(lines[i])) { at = i; break; }
  }
  if (at < 0 || OPT.test(lines[at])) return '';
  const parts = [lines[at].slice(2)];
  for (let i = at + 1; i < lines.length && /^ {2}\S/.test(lines[i]) && !/ · |for shortcuts|tab to queue|esc to/.test(lines[i]); i++) parts.push(lines[i].trim());
  const text = parts.join(' ').trim();
  return PLACEHOLDER.test(text) ? '' : text;
}

// ---------- session records (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl) ----------

const metaCache = new Map();   // file -> meta (the first line never changes)
function readMeta(file) {
  if (metaCache.has(file)) return metaCache.get(file);
  let meta = null;
  try {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const head = buf.slice(0, n).toString('utf8');
    if (/"type":\s*"session_meta"/.test(head)) {
      const pick = (k) => { const m = head.match(new RegExp(`"${k}":\\s*"((?:[^"\\\\]|\\\\.)*)"`)); return m ? JSON.parse(`"${m[1]}"`) : ''; };
      meta = { id: pick('id'), cwd: pick('cwd'), originator: pick('originator'), timestamp: pick('timestamp'),
        threadSource: pick('thread_source'), subagent: /"source":\{"subagent"/.test(head) };
    }
  } catch { meta = null; }
  if (meta) metaCache.set(file, meta);
  return meta;
}

/** All rollout files, newest first (by name: rollout-YYYY-MM-DDTHH-MM-SS-…). */
function rolloutFiles() {
  const root = path.join(codexHome(), 'sessions');
  const out = [];
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const y of ls(root).filter((x) => /^\d{4}$/.test(x)).sort().reverse())
    for (const m of ls(path.join(root, y)).sort().reverse())
      for (const d of ls(path.join(root, y, m)).sort().reverse())
        for (const f of ls(path.join(root, y, m, d)).filter((x) => /^rollout-.*\.jsonl$/.test(x)).sort().reverse())
          out.push(path.join(root, y, m, d, f));
  return out;
}

const fileCache = new Map();   // sid -> file
function rolloutFile(sid) {
  if (!SID.test(sid || '')) return null;
  const c = fileCache.get(sid);
  if (c && fs.existsSync(c)) return c;
  const f = rolloutFiles().find((x) => x.endsWith(`-${sid}.jsonl`)) || null;
  if (f) fileCache.set(sid, f);
  return f;
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
/** A user's own interactive session (not `codex exec`, not a subagent or guardian review). */
const isUserThread = (m) => m && m.id && m.originator !== 'codex_exec' && !m.subagent && (!m.threadSource || m.threadSource === 'user');

/**
 * The session a new Codex window started: the oldest user thread in `folder` that began after
 * `sinceMs` (with 5 s slack) and is not already some other window's (`claimed`). Codex writes the
 * file when the first message is sent, so a fresh window has no id until then.
 */
function discover(folder, sinceMs, claimed = new Set()) {
  const want = real(folder);
  let best = null;
  for (const f of rolloutFiles().slice(0, 400)) {
    const m = readMeta(f);
    if (!isUserThread(m) || claimed.has(m.id)) continue;
    const t = Date.parse(m.timestamp) || 0;
    if (t < sinceMs - 5000) continue;
    if (real(m.cwd) !== want) continue;
    if (!best || t < best.t) best = { sid: m.id, t, file: f };
  }
  if (best) fileCache.set(best.sid, best.file);
  return best ? best.sid : '';
}

/** Thread names Codex keeps in session_index.jsonl (the last entry per id wins). */
let indexCache = { mtime: 0, map: new Map() };
function threadNames() {
  const f = path.join(codexHome(), 'session_index.jsonl');
  let st; try { st = fs.statSync(f); } catch { return indexCache.map; }
  if (st.mtimeMs === indexCache.mtime) return indexCache.map;
  const map = new Map();
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    try { const j = JSON.parse(l); if (j.id && j.thread_name) map.set(j.id, j.thread_name); } catch { /* skip */ }
  }
  indexCache = { mtime: st.mtimeMs, map };
  return map;
}

const HIDDEN_USER = /^\s*(<|# AGENTS\.md|<environment_context)/;
const textOf = (content) => (Array.isArray(content) ? content : [])
  .map((c) => (c && (c.type === 'input_text' || c.type === 'output_text') ? c.text : '')).join(' ');

/** Last reply, last prompt, title and time of the newest message: same shape as transcriptInfo. */
const infoCache = new Map();
function info(sid) {
  const file = rolloutFile(sid);
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = infoCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.v;
  const len = Math.min(st.size, 1024 * 1024);
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
  let reply = '', prompt = '', lastMsg = 0, busy = null;
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0 && (!reply || !prompt || busy === null); i--) {
    let j; try { j = JSON.parse(lines[i]); } catch { continue; }
    const p = j.payload || {};
    // Is a turn running? The newest of task_started / task_complete / turn_aborted decides. The
    // screen alone cannot tell: between a short message and the next tool call Codex shows no
    // "Working" line (found by a test run, 2026-11-10).
    if (busy === null && j.type === 'event_msg') {
      if (p.type === 'task_started') busy = true;
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') busy = false;
    }
    if (j.type !== 'response_item' || p.type !== 'message') continue;
    const text = textOf(p.content).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (p.role === 'assistant' && !reply) { reply = text.slice(0, 300); if (!lastMsg) lastMsg = Date.parse(j.timestamp) || 0; }
    if (p.role === 'user' && !prompt && !HIDDEN_USER.test(text)) { prompt = text.slice(0, 200); if (!lastMsg) lastMsg = Date.parse(j.timestamp) || 0; }
  }
  const v = { reply, prompt, title: threadNames().get(sid) || '', mtime: st.mtimeMs, lastMsg, busy: !!busy };
  infoCache.set(file, { mtime: st.mtimeMs, v });
  return v;
}

/** A tool call's one-line summary: the shell command when there is one. */
function toolSummary(name, input) {
  const s = String(input || '');
  let m = s.match(/"?cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/) || s.match(/"command"\s*:\s*\[(.*?)\]/);
  if (m) { try { return { name: 'Bash', summary: JSON.parse(`"${m[1]}"`).replace(/\s+/g, ' ').slice(0, 160) }; } catch { /* raw */ } }
  m = s.match(/\*\*\* (?:Update|Add|Delete) File: (\S+)/);
  if (m) return { name: 'Edit', summary: m[1] };
  return { name: name || 'tool', summary: s.replace(/\s+/g, ' ').slice(0, 160) };
}

/** Chat items (same shape as lib/chat.js parseTranscript) from a rollout file's text. */
function parseRollout(jsonl, { limit = 200 } = {}) {
  const items = [], tools = new Map();
  let current = null;
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'response_item') continue;
    const p = j.payload || {}, ts = j.timestamp;
    const asst = () => {
      if (!current) { current = { id: p.id || `a${items.length}`, role: 'assistant', ts, endTs: ts, blocks: [] }; items.push(current); }
      current.endTs = ts;
      return current;
    };
    if (p.type === 'message' && p.role === 'user') {
      const text = textOf(p.content).trim();
      if (!text || HIDDEN_USER.test(text)) continue;
      items.push({ id: p.id || `u${items.length}`, role: 'user', ts, text, images: [], files: [] });
      current = null;
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = textOf(p.content).trim();
      if (text) asst().blocks.push({ type: 'text', text });
    } else if (p.type === 'reasoning') {
      const text = (Array.isArray(p.summary) ? p.summary : []).map((s) => (s && s.text) || '').join('\n').trim();
      if (text) asst().blocks.push({ type: 'thinking', text, seconds: null, key: `${p.id || items.length}:${asst().blocks.length}` });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const { name, summary } = toolSummary(p.name, p.arguments || p.input || JSON.stringify(p.action || {}));
      const t = { type: 'tool', id: p.call_id || p.id, name, summary, status: 'running', result: '', images: [] };
      tools.set(t.id, t);
      asst().blocks.push(t);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const t = tools.get(p.call_id);
      if (!t) continue;
      const out = Array.isArray(p.output) ? textOf(p.output) : typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
      t.status = /exit code:? [1-9]|Process exited with code [1-9]|"exit_code":\s*[1-9]/i.test(out) ? 'error' : 'done';
      t.result = String(out).slice(0, 2000);
      if (current) current.endTs = ts;
    }
  }
  const out = items.filter((it) => it.role === 'user' || it.blocks.length);
  let turnStart = null;
  out.forEach((it, i) => {
    if (it.role === 'user') { turnStart = it.ts; return; }
    const next = out[i + 1];
    it.endsTurn = !next || next.role === 'user';
    if (it.endsTurn && turnStart && it.endTs) {
      const secs = Math.round((Date.parse(it.endTs) - Date.parse(turnStart)) / 1000);
      if (secs > 0) it.turnSeconds = secs;
    }
  });
  return out.slice(-limit);
}

/** Chat for a Codex session id: { sid, mtime, items } (cached by file time). */
const chatCache = new Map();
function chat(sid, limit = 300) {
  const file = rolloutFile(sid);
  if (!file) return { sid: sid || '', mtime: 0, items: [] };
  let st; try { st = fs.statSync(file); } catch { return { sid, mtime: 0, items: [] }; }
  const c = chatCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.v;
  const v = { sid, mtime: st.mtimeMs, items: parseRollout(fs.readFileSync(file, 'utf8'), { limit }) };
  chatCache.set(file, { mtime: st.mtimeMs, v });
  return v;
}

/** Previous Codex conversations in a folder (for "resume"), newest first: { sid, mtime, title, first, agent }. */
function history(folder, max = 25) {
  const want = real(folder), names = threadNames(), out = [];
  for (const f of rolloutFiles()) {
    const m = readMeta(f);
    if (!isUserThread(m) || real(m.cwd) !== want) continue;
    let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    const i = info(m.id) || {};
    let first = '';
    try {
      // the first real user message, from the start of the file
      const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      for (const l of buf.slice(0, n).toString('utf8').split('\n')) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        const p = j.payload || {};
        if (j.type === 'response_item' && p.type === 'message' && p.role === 'user') {
          const t = textOf(p.content).replace(/\s+/g, ' ').trim();
          if (t && !HIDDEN_USER.test(t)) { first = t.slice(0, 140); break; }
        }
      }
    } catch { /* unreadable */ }
    if (!first && !i.prompt) continue;
    out.push({ sid: m.id, mtime, title: names.get(m.id) || '', first: first || i.prompt, agent: 'codex' });
    if (out.length >= max) break;
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------- Codex running outside the panel (a terminal, VS Code) ----------

/**
 * Live interactive Codex processes: the codex binary itself (not the node wrapper, not
 * `codex exec`, the app-server daemon, MCP or sandbox helpers). ps -> [{ pid, ppid, args, start }].
 */
function liveTuis(psText) {
  const SUB = /^(exec|e|app-server|exec-server|mcp|mcp-server|sandbox|login|logout|debug|apply|a|cloud|completion|features|doctor|update|review|agents|queue|archive|delete|unarchive|plugin|remote-control|app|migrate-rollouts|help)$/;
  const VALUE_FLAGS = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '-i', '--image', '--enable', '--disable', '--add-dir', '--local-provider']);
  const out = [];
  for (const line of String(psText || '').split('\n')) {
    // pid ppid elapsed-seconds tty command
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const tty = m[4], args = m[5];
    const argv0 = args.split(/\s+/)[0];
    if (!/(^|\/)codex$/.test(argv0)) continue;
    // apps that bundle Codex (ChatGPT, Codex desktop) and the shared daemon are not the user's terminal sessions
    if (/\.app\/Contents\/|app-server-daemon/.test(argv0)) continue;
    // an interactive Codex has a terminal; servers and helpers have none ("??")
    if (!tty || tty === '??' || tty === '?' || tty === '-') continue;
    const toks = args.slice(argv0.length).trim().split(/\s+/).filter(Boolean);
    let sub = '';
    for (let i = 0; i < toks.length; i++) {
      if (VALUE_FLAGS.has(toks[i])) { i++; continue; }
      if (toks[i].startsWith('-')) continue;
      sub = toks[i]; break;
    }
    if (SUB.test(sub)) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), start: Date.now() - Number(m[3]) * 1000, args });
  }
  return out;
}

/** Files and working folder a process has open (lsof). */
function openFiles(pid) {
  try {
    const out = execFileSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
  } catch { return []; }
}
function cwdOf(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const l = out.split('\n').find((x) => x.startsWith('n'));
    return l ? l.slice(1) : '';
  } catch { return ''; }
}

/**
 * Codex sessions running outside the panel, as records in the same shape as Claude's
 * (~/.claude/sessions/<pid>.json): { pid, sessionId, cwd, kind: 'interactive', name, agent }.
 * inPanel(pid) says whether a process runs inside a panel pane. The session id is taken from
 * `codex resume <id>`, else from the record file the process has open, else (a Codex that talks
 * to the shared app-server daemon holds no file itself) the newest user thread of its folder that
 * started after it. A Codex that has not got its first message yet has no session to move.
 */
function outsideRecords(inPanel, { ps = null } = {}) {
  let text = ps;
  if (text === null) {
    try { text = execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,tty=,command='], { encoding: 'utf8', timeout: 5000 }); } catch { return []; }
    // etime is [[dd-]hh:]mm:ss: turn it into seconds for liveTuis
    text = text.split('\n').map((l) => l.replace(/^(\s*\d+\s+\d+\s+)(\S+)/, (_, a, e) => {
      const p = e.split(/[-:]/).map(Number); let secs = 0;
      if (e.includes('-')) secs = p[0] * 86400 + p[1] * 3600 + p[2] * 60 + p[3];
      else if (p.length === 3) secs = p[0] * 3600 + p[1] * 60 + p[2]; else secs = p[0] * 60 + p[1];
      return a + secs;
    })).join('\n');
  }
  const tuis = liveTuis(text).filter((t) => !inPanel(String(t.pid)));
  const taken = new Set(), out = [];
  for (const t of tuis) {
    let sid = (t.args.match(/\bresume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/) || [])[1] || '';
    let cwd = '';
    if (!sid) {
      const mine = path.join(codexHome(), 'sessions') + path.sep;
      const held = openFiles(t.pid).filter((f) => f.startsWith(mine) && /\/rollout-[^/]*\.jsonl$/.test(f)).map((f) => readMeta(f)).filter(isUserThread);
      if (held.length) { sid = held[0].id; cwd = held[0].cwd; }
    }
    if (!cwd) cwd = cwdOf(t.pid) || (sid && (readMeta(rolloutFile(sid) || '') || {}).cwd) || '';
    if (!sid && cwd) sid = discover(cwd, t.start, taken);
    // only sessions of this panel's Codex home (CODEX_HOME), like Claude's records under ~/.claude
    if (!sid || taken.has(sid) || !rolloutFile(sid)) continue;
    taken.add(sid);
    out.push({ pid: t.pid, sessionId: sid, cwd, kind: 'interactive', status: '', name: path.basename(cwd || '') || 'Codex session', agent: 'codex' });
  }
  return out;
}

module.exports = { liveTuis, outsideRecords, command, codexArgs, STATE_EVENTS, toml, availability, parseScreen, inputBoxText, discover, rolloutFile, readMeta,
  info, parseRollout, chat, history, isUserThread };
