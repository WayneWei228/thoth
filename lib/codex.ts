// Codex sessions in the panel: the same tmux window model as Claude Code, but the
// window runs the OpenAI Codex CLI (`codex`). This file holds everything that is Codex-specific:
//   - the command the panel types (brain MCP tools + prompt hook passed with -c, never written
//     into the user's ~/.codex/config.toml; the update prompt is switched off),
//   - the screen parser (idle / working / needs + menu options), tested against saved screens,
//   - the session records ("rollouts") in ~/.codex/sessions: find a window's session id, the last
//     reply and prompt, the chat items and the history of a folder.
// Checked with codex-cli 0.163.0 and 0.167.0 (2026-11-10).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AssistantItem, ChatItem, ToolBlock } from './chat.ts';
import type { BrainFiles, Hooks } from './claude_args.ts';
import type { MenuOption, ScreenState } from './screen.ts';
import { ne, text as textOfValue, truthy } from './truthy.ts';

const ANSI = new RegExp(String.raw`${String.fromCodePoint(27)}\[[\d;?]*[A-Za-z]`, 'g');
const SID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const shq = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`;
const codexHome = (): string => (process.env['CODEX_HOME'] ?? '') || path.join(os.homedir(), '.codex');
const at0 = (lines: readonly string[], i: number): string => lines[i] ?? '';

// ---------- command ----------

/** A value as TOML (for `codex -c key=value`): strings, numbers, booleans, arrays, inline tables. */
export function toml(v: unknown): string {
  if (Array.isArray(v)) return `[${(v as unknown[]).map((x) => toml(x)).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.entries(v)
      .map(([k, x]) => `${/^[\w-]+$/.test(k) ? k : JSON.stringify(k)}=${toml(x)}`)
      .join(',')}}`;
  if (typeof v === 'string') return JSON.stringify(v);
  return textOfValue(v);
}

/**
 * The text after `codex` (starts with a space). brain = { mcp, settings } (the brain's session
 * files, the same ones Claude gets with --mcp-config / --settings) or null.
 * Codex reads Claude-format UserPromptSubmit hooks (stdin {prompt, cwd, session_id, …}, output
 * hookSpecificOutput.additionalContext), so the brain's hook works unchanged.
 */
const BRAIN_ENV = ['CC_BRAIN_URL', 'CC_BRAIN_TOKEN', 'CC_BRAIN_DIR', 'CC_BRAIN_PORT', 'CC_PANEL_HOME'];
// The panel's state hooks for Codex (lib/hookstate.ts). Codex 0.167 has no Notification event and
// sends Interrupt on Esc. Codex asks once to trust new hook commands ("Hooks need review"); the
// commands depend only on the port, so the trust stays for later sessions.
export const STATE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt',
  'SessionEnd',
];

interface McpServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

export function codexArgs(brain: BrainFiles | null | undefined, hooks: Hooks | null = null): string {
  const out = ['check_for_update_on_startup=false'];
  const groups: Record<string, unknown[]> = {}; // event -> matcher groups (the brain's prompt hook first, then the state hooks)
  if (brain) {
    try {
      const file = JSON.parse(fs.readFileSync(brain.mcp, 'utf8')) as { mcpServers?: Record<string, McpServer> } | null;
      const servers = file?.mcpServers ?? {};
      for (const [name, s] of Object.entries(servers)) {
        if (!/^[\w-]+$/.test(name) || !truthy(s) || !truthy(s.command)) continue;
        const t: Record<string, unknown> = { command: s.command };
        if (Array.isArray(s.args)) t['args'] = s.args;
        if (truthy(s.env) && typeof s.env === 'object') t['env'] = s.env;
        // Codex starts MCP servers with a clean environment; the brain's settings must pass through
        // (found by a test run: without this the tools asked the default local brain)
        t['env_vars'] = BRAIN_ENV;
        out.push(`mcp_servers.${name}=${toml(t)}`);
      }
    } catch {
      /* no MCP file: no tools */
    }
    try {
      const file = JSON.parse(fs.readFileSync(brain.settings, 'utf8')) as { hooks?: Record<string, unknown> } | null;
      const brainHooks = file?.hooks ?? {};
      const ups = brainHooks['UserPromptSubmit'];
      if (Array.isArray(ups)) groups['UserPromptSubmit'] = [...(ups as unknown[])];
    } catch {
      /* no hook */
    }
  }
  for (const [e, g] of Object.entries(hooks ?? {})) if (Array.isArray(g)) groups[e] = [...(groups[e] ?? []), ...g];
  for (const [e, g] of Object.entries(groups)) out.push(`hooks.${e}=${toml(g)}`);
  return out.map((x) => ` -c ${shq(x)}`).join('');
}

/** The full command line for a window: a new session, or `codex resume <sid>`. */
export function command(
  sid: string | null | undefined,
  brain: BrainFiles | null | undefined,
  hooks: Hooks | null = null,
): string {
  return (ne(sid) && SID.test(sid) ? `codex resume ${sid}` : 'codex') + codexArgs(brain, hooks);
}

export interface Availability {
  available: boolean;
  version?: string;
  reason?: string;
}

/** Is the codex CLI installed? { available, reason, version } (cached for a minute). */
let availCache: { t: number; v: Availability } | null = null;
export function availability(): Availability {
  if (availCache && Date.now() - availCache.t < 60_000) return availCache.v;
  let v: Availability;
  try {
    const out = execFileSync('codex', ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const loggedIn = fs.existsSync(path.join(codexHome(), 'auth.json')) || ne(process.env['OPENAI_API_KEY']);
    v = loggedIn
      ? { available: true, version: out }
      : { available: true, version: out, reason: 'Codex is installed but not signed in. Run: codex login' };
  } catch {
    v = {
      available: false,
      reason: 'Codex is not installed. Install it with: npm install -g @openai/codex, then run: codex login',
    };
  }
  availCache = { t: Date.now(), v };
  return v;
}

// ---------- screen ----------

const MENU_HINT = /enter (to )?(confirm|continue|select)|esc to cancel|esc (back|skip)|press enter/i;
const OPT = /^(\s*)(›|\s)\s(\d+)\.\s+(\S.*)$/; // "› 1. Yes, proceed (y)" or "  2. Skip"

function screenLines(text: string | null | undefined): string[] {
  const lines = (text ?? '')
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  while (lines.length > 0 && !at0(lines, lines.length - 1).trim()) lines.pop();
  return lines;
}

/**
 * Codex's screen -> { state, last, options, selected, question, live } (same shape as
 * lib/screen.ts parseScreen for Claude). States: 'needs' (a numbered menu: approval, folder
 * trust, hook review, …), 'working' ("Working (12s • esc to interrupt)"), else 'idle'.
 */
export function parseScreen(text: string | null | undefined): ScreenState {
  const lines = screenLines(text);
  const tail = lines.slice(-30);

  // a menu: the last "› N." line with numbered siblings at the same indent, and a key hint below
  let at = -1;
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 16); i--) {
    const m = OPT.exec(at0(tail, i));
    if (m?.[2] === '›') {
      at = i;
      break;
    }
  }
  const options: MenuOption[] = [];
  let selected = -1,
    question = '',
    hinted = false;
  if (at >= 0) {
    const indent = (OPT.exec(at0(tail, at))?.[1] ?? '').length;
    let a = at,
      b = at;
    const isOpt = (l: string): boolean => {
      const m = OPT.exec(l);
      return m !== null && (m[1] ?? '').length === indent;
    };
    while (a - 1 >= 0 && isOpt(at0(tail, a - 1))) a--;
    while (b + 1 < tail.length) {
      const next = at0(tail, b + 1);
      if (!(isOpt(next) || (next.trim() && /^\s{4,}\S/.test(next) && !MENU_HINT.test(next)))) break;
      b++;
    }
    for (let i = a; i <= b; i++) {
      const line = at0(tail, i);
      const m = OPT.exec(line);
      const prev = options.at(-1);
      if (m && (m[1] ?? '').length === indent) {
        options.push({
          n: Number(m[3]),
          label: (m[4] ?? '').replaceAll(/\s+/g, ' ').trim(),
        });
        if (i === at) selected = Number(m[3]);
      } else if (prev) prev.label += ' ' + line.trim();
    }
    for (let i = b + 1; i < Math.min(tail.length, b + 5); i++)
      if (MENU_HINT.test(at0(tail, i))) {
        hinted = true;
        break;
      }
    // the heading that asks: "Would you like to run …?", "Trust this folder? …", "Hooks need review"
    const above = tail
      .slice(Math.max(0, a - 12), a)
      .map((l) => l.trim())
      .filter(Boolean);
    const q =
      above.find((l) =>
        /^(Would you like|Do you want|Allow\b|Trust this|Hooks need review|Update available)/i.test(l),
      ) ??
      above.toReversed().find((l) => l.includes('?')) ??
      '';
    question = q.replace(/^(.*?\?)\s.*$/, '$1');
  }
  const validMenu = options.length >= 2 && selected > 0 && hinted;

  let live = '';
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = /•\s+(Working\s*\(([^()]*?)\s*•\s*esc to interrupt\))/i.exec(at0(tail, i));
    if (m) {
      live = `Working (${(m[2] ?? '').trim()})`;
      break;
    }
  }
  let state: ScreenState['state'];
  if (validMenu) state = 'needs';
  else if (live || /esc to interrupt/i.test(tail.join('\n'))) state = 'working';
  else state = 'idle';

  // last reply line on the screen ("• text"), skipping tool lines; the transcript is preferred
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = at0(lines, i).trim();
    if (
      /^•\s/.test(l) &&
      !/^•\s+(Working|Ran|Running|Added|Edited|Deleted|Explored|Read|Searched|Updated|Waited|Called|Viewed)\b/.test(l)
    ) {
      last = l.replace(/^•\s+/, '');
      break;
    }
  }
  return {
    state,
    last,
    options: validMenu ? options.map(({ n, label }) => ({ n, label })) : [],
    selected,
    question,
    live: state === 'working' ? live : '',
  };
}

// Placeholders Codex shows (dim) in an empty input box.
const PLACEHOLDER =
  /^(Ask Codex to do anything|Find and fix a bug in @filename|Improve documentation in @filename|Explain this codebase|Summarize recent commits|Implement \{feature\}|Write tests for @filename|Run \/review on my current changes|Use \/skills to list available skills)$/;

/** The text in Codex's input box: the last "› …" line (plus its wrapped lines) above the footer. */
export function inputBoxText(screen: string | null | undefined): string {
  const lines = screenLines(screen);
  let at = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    if (at0(lines, i).startsWith('› ')) {
      at = i;
      break;
    }
  }
  if (at < 0 || OPT.test(at0(lines, at))) return '';
  const parts = [at0(lines, at).slice(2)];
  for (
    let i = at + 1;
    i < lines.length && /^ {2}\S/.test(at0(lines, i)) && !/ · |for shortcuts|tab to queue|esc to/.test(at0(lines, i));
    i++
  )
    parts.push(at0(lines, i).trim());
  const text = parts.join(' ').trim();
  return PLACEHOLDER.test(text) ? '' : text;
}

// ---------- session records (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl) ----------

export interface RolloutMeta {
  id: string;
  cwd: string;
  originator: string;
  timestamp: string;
  threadSource: string;
  subagent: boolean;
}

const metaCache = new Map<string, RolloutMeta>(); // file -> meta (the first line never changes)
export function readMeta(file: string): RolloutMeta | null {
  const hit = metaCache.get(file);
  if (hit) return hit;
  let meta: RolloutMeta | null = null;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString('utf8');
    if (/"type":\s*"session_meta"/.test(head)) {
      const pick = (k: string): string => {
        const m = new RegExp(String.raw`"${k}":\s*"((?:[^"\\]|\\.)*)"`).exec(head);
        return m ? (JSON.parse(`"${m[1] ?? ''}"`) as string) : '';
      };
      meta = {
        id: pick('id'),
        cwd: pick('cwd'),
        originator: pick('originator'),
        timestamp: pick('timestamp'),
        threadSource: pick('thread_source'),
        subagent: /"source":\{"subagent"/.test(head),
      };
    }
  } catch {
    meta = null;
  }
  if (meta) metaCache.set(file, meta);
  return meta;
}

/** All rollout files, newest first (by name: rollout-YYYY-MM-DDTHH-MM-SS-…). */
function rolloutFiles(): string[] {
  const root = path.join(codexHome(), 'sessions');
  const out: string[] = [];
  const ls = (d: string): string[] => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  const desc = (list: string[]): string[] => list.toSorted().toReversed();
  for (const y of desc(ls(root).filter((x) => /^\d{4}$/.test(x))))
    for (const m of desc(ls(path.join(root, y))))
      for (const d of desc(ls(path.join(root, y, m))))
        for (const f of desc(ls(path.join(root, y, m, d)).filter((x) => /^rollout-.*\.jsonl$/.test(x))))
          out.push(path.join(root, y, m, d, f));
  return out;
}

const fileCache = new Map<string, string>(); // sid -> file
export function rolloutFile(sid: string | null | undefined): string | null {
  if (!ne(sid) || !SID.test(sid)) return null;
  const c = fileCache.get(sid);
  if (c !== undefined && c !== '' && fs.existsSync(c)) return c;
  const f = rolloutFiles().find((x) => x.endsWith(`-${sid}.jsonl`)) ?? null;
  if (ne(f)) fileCache.set(sid, f);
  return f;
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
/** A user's own interactive session (not `codex exec`, not a subagent or guardian review). */
export const isUserThread = (m: RolloutMeta | null | undefined): m is RolloutMeta => {
  if (m === null || m === undefined || !m.id) return false;
  return m.originator !== 'codex_exec' && !m.subagent && (!m.threadSource || m.threadSource === 'user');
};

/**
 * The session a new Codex window started: the oldest user thread in `folder` that began after
 * `sinceMs` (with 5 s slack) and is not already some other window's (`claimed`). Codex writes the
 * file when the first message is sent, so a fresh window has no id until then.
 */
export function discover(folder: string, sinceMs: number, claimed: Set<string> = new Set()): string {
  const want = real(folder);
  let best: { sid: string; t: number; file: string } | null = null;
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
let indexCache: { mtime: number; map: Map<string, string> } = { mtime: 0, map: new Map() };
function threadNames(): Map<string, string> {
  const f = path.join(codexHome(), 'session_index.jsonl');
  let st: fs.Stats;
  try {
    st = fs.statSync(f);
  } catch {
    return indexCache.map;
  }
  if (st.mtimeMs === indexCache.mtime) return indexCache.map;
  const map = new Map<string, string>();
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    try {
      const j = JSON.parse(l) as { id?: string; thread_name?: string } | null;
      if (j && ne(j.id) && ne(j.thread_name)) map.set(j.id, j.thread_name);
    } catch {
      /* skip */
    }
  }
  indexCache = { mtime: st.mtimeMs, map };
  return map;
}

const HIDDEN_USER = /^\s*(<|# AGENTS\.md|<environment_context)/;
interface ContentPart {
  type?: string;
  text?: string;
  image_url?: unknown;
}
const textOf = (content: unknown): string =>
  (Array.isArray(content) ? (content as (ContentPart | null)[]) : [])
    .map((c) => (c && (c.type === 'input_text' || c.type === 'output_text') ? c.text : ''))
    .join(' ');

/** One rollout line (the fields this code reads). */
interface RolloutLine {
  type?: string;
  timestamp?: string;
  payload?: RolloutPayload | null;
}
interface RolloutPayload {
  type?: string;
  role?: string;
  id?: string;
  cwd?: unknown;
  content?: unknown;
  summary?: unknown;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  action?: unknown;
  call_id?: string;
  output?: unknown;
}

const parseLine = (line: string | undefined): RolloutLine | null => {
  try {
    return JSON.parse(line ?? '') as RolloutLine | null;
  } catch {
    return null;
  }
};

export interface CodexInfo {
  reply: string;
  prompt: string;
  title: string;
  mtime: number;
  lastMsg: number;
  busy: boolean;
}

/** Last reply, last prompt, title and time of the newest message: same shape as transcriptInfo. */
const infoCache = new Map<string, { mtime: number; v: CodexInfo }>();
export function info(sid: string): CodexInfo | null {
  const file = rolloutFile(sid);
  if (!ne(file)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const c = infoCache.get(file);
  if (c?.mtime === st.mtimeMs) return c.v;
  const len = Math.min(st.size, 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  let reply = '',
    prompt = '',
    lastMsg = 0,
    busy: boolean | null = null;
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0 && (!reply || !prompt || busy === null); i--) {
    const j = parseLine(lines[i]);
    if (j === null) continue;
    const p = j.payload ?? {};
    // Is a turn running? The newest of task_started / task_complete / turn_aborted decides. The
    // screen alone cannot tell: between a short message and the next tool call Codex shows no
    // "Working" line (found by a test run, 2026-11-10).
    if (busy === null && j.type === 'event_msg') {
      if (p.type === 'task_started') busy = true;
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') busy = false;
    }
    if (j.type !== 'response_item' || p.type !== 'message') continue;
    const text = textOf(p.content).replaceAll(/\s+/g, ' ').trim();
    if (!text) continue;
    if (p.role === 'assistant' && !reply) {
      reply = text.slice(0, 300);
      if (!lastMsg) lastMsg = Date.parse(j.timestamp ?? '') || 0;
    }
    if (p.role === 'user' && !prompt && !HIDDEN_USER.test(text)) {
      prompt = text.slice(0, 200);
      if (!lastMsg) lastMsg = Date.parse(j.timestamp ?? '') || 0;
    }
  }
  const v: CodexInfo = {
    reply,
    prompt,
    title: threadNames().get(sid) ?? '',
    mtime: st.mtimeMs,
    lastMsg,
    busy: busy === true,
  };
  infoCache.set(file, { mtime: st.mtimeMs, v });
  return v;
}

/** A tool call's one-line summary: the shell command when there is one. */
function toolSummary(name: string | undefined, input: unknown): { name: string; summary: string; detail?: string } {
  const s = truthy(input) ? textOfValue(input) : '';
  let m = /"?cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s) ?? /"command"\s*:\s*\[(.*?)\]/.exec(s);
  if (m) {
    try {
      const full = JSON.parse(`"${m[1] ?? ''}"`) as string;
      const summary = full.replaceAll(/\s+/g, ' ').slice(0, 160);
      // the whole command with its lines, for an opened card (as lib/chat.ts toolDetail)
      const detail = full.trim().slice(0, 4000);
      return { name: 'Bash', summary, ...(detail && detail !== summary ? { detail } : {}) };
    } catch {
      /* raw */
    }
  }
  m = /\*\*\* (?:Update|Add|Delete) File: (\S+)/.exec(s);
  if (m) return { name: 'Edit', summary: m[1] ?? '' };
  return { name: (name ?? '') || 'tool', summary: s.replaceAll(/\s+/g, ' ').slice(0, 160) };
}

// a property JSON leaves out: for the phone's view (lib/media.ts), not sent to the web UI
const hide = (o: object, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: false, writable: true });
};

/** The patch text of an apply_patch call (its input, or the JSON around it). */
function patchText(raw: string): string {
  if (/^\*\*\* Begin Patch/.test(raw.trim())) return raw;
  try {
    const j = JSON.parse(raw) as { input?: unknown; patch?: unknown } | null;
    const v = [j?.input, j?.patch].find((x) => truthy(x));
    return textOfValue(v ?? raw);
  } catch {
    return raw; /* raw text */
  }
}

/** Chat items (same shape as lib/chat.ts parseTranscript) from a rollout file's text. */
export function parseRollout(jsonl: string | null | undefined, { limit = 200 }: { limit?: number } = {}): ChatItem[] {
  const items: ChatItem[] = [],
    tools = new Map<string | undefined, ToolBlock>();
  let current: AssistantItem | null = null,
    cwd = '';
  // the assistant item being built (asst() sets it; a getter keeps its declared type)
  const cur = (): AssistantItem | null => current;
  for (const line of (jsonl ?? '').split('\n')) {
    if (!line.trim()) continue;
    const j = parseLine(line);
    if (j === null) continue;
    if ((j.type === 'session_meta' || j.type === 'turn_context') && typeof j.payload?.cwd === 'string')
      cwd = j.payload.cwd;
    if (j.type !== 'response_item') continue;
    const p = j.payload ?? {},
      ts = j.timestamp;
    const asst = (): AssistantItem => {
      if (!current) {
        current = { id: (p.id ?? '') || `a${String(items.length)}`, role: 'assistant', ts, endTs: ts, blocks: [] };
        hide(current, 'cwd', cwd);
        items.push(current);
      }
      current.endTs = ts;
      return current;
    };
    if (p.type === 'message' && p.role === 'user') {
      const text = textOf(p.content).trim();
      if (!text || HIDDEN_USER.test(text)) continue;
      // a pasted image: { type: 'input_image', image_url: 'data:image/png;base64,…' }
      const images = (Array.isArray(p.content) ? (p.content as (ContentPart | null)[]) : [])
        .filter(
          (c): c is ContentPart & { image_url: string } =>
            c?.type === 'input_image' && typeof c.image_url === 'string' && /^data:image\//.test(c.image_url),
        )
        .map((c) => ({ src: c.image_url }));
      items.push({ id: (p.id ?? '') || `u${String(items.length)}`, role: 'user', ts, text, images, files: [] });
      current = null;
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = textOf(p.content).trim();
      if (text) asst().blocks.push({ type: 'text', text });
    } else if (p.type === 'reasoning') {
      const text = (Array.isArray(p.summary) ? (p.summary as ({ text?: string } | null)[]) : [])
        .map((s) => (s?.text ?? '') || '')
        .join('\n')
        .trim();
      if (text)
        asst().blocks.push({
          type: 'thinking',
          text,
          seconds: null,
          key: `${(p.id ?? '') || String(items.length)}:${String(asst().blocks.length)}`,
        });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const input = [p.arguments, p.input].find((x) => truthy(x)) ?? JSON.stringify(truthy(p.action) ? p.action : {});
      const { name, summary, detail } = toolSummary(p.name, input);
      const t: ToolBlock = {
        type: 'tool',
        id: (p.call_id ?? '') || p.id,
        name,
        summary,
        status: 'running',
        result: '',
        images: [],
      };
      if (ne(detail)) t.detail = detail;
      hide(t, 'cwd', cwd);
      // apply_patch: the patch text, for the phone's diff (lib/media.ts codexPatch)
      let raw = '';
      if (typeof p.input === 'string') raw = p.input;
      else if (typeof p.arguments === 'string') raw = p.arguments;
      if (name === 'Edit' && /\*\*\* Begin Patch/.test(raw)) hide(t, 'codexPatch', patchText(raw).slice(0, 256 * 1024));
      tools.set(t.id, t);
      asst().blocks.push(t);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const t = tools.get(p.call_id);
      if (!t) continue;
      let out: string;
      if (Array.isArray(p.output)) out = textOf(p.output);
      else if (typeof p.output === 'string') out = p.output;
      else out = JSON.stringify(truthy(p.output) ? p.output : '');
      t.status = /exit code:? [1-9]|Process exited with code [1-9]|"exit_code":\s*[1-9]/i.test(out) ? 'error' : 'done';
      t.result = out.slice(0, 2000);
      hide(t, 'fullResult', out.slice(0, 256 * 1024));
      const open = cur();
      if (open) open.endTs = ts;
    }
  }
  const out = items.filter((it) => it.role === 'user' || it.blocks.length > 0);
  let turnStart: string | null | undefined = null;
  for (const [i, it] of out.entries()) {
    if (it.role === 'user') {
      turnStart = it.ts;
      continue;
    }
    const next = out[i + 1];
    it.endsTurn = !next || next.role === 'user';
    if (it.endsTurn && ne(turnStart) && ne(it.endTs)) {
      const secs = Math.round((Date.parse(it.endTs) - Date.parse(turnStart)) / 1000);
      if (secs > 0) it.turnSeconds = secs;
    }
  }
  return out.slice(-limit);
}

export interface CodexChat {
  sid: string;
  mtime: number;
  items: ChatItem[];
}

/** Chat for a Codex session id: { sid, mtime, items } (cached by file time). */
const chatCache = new Map<string, { mtime: number; v: CodexChat }>();
export function chat(sid: string | null | undefined, limit = 300): CodexChat {
  const file = rolloutFile(sid);
  if (!ne(file)) return { sid: sid ?? '', mtime: 0, items: [] };
  const id = sid ?? '';
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { sid: id, mtime: 0, items: [] };
  }
  const c = chatCache.get(file);
  if (c?.mtime === st.mtimeMs) return c.v;
  const v = { sid: id, mtime: st.mtimeMs, items: parseRollout(fs.readFileSync(file, 'utf8'), { limit }) };
  chatCache.set(file, { mtime: st.mtimeMs, v });
  return v;
}

export interface HistoryEntry {
  sid: string;
  mtime: number;
  title: string;
  first: string;
  agent: 'codex';
}

/** The first real user message of a rollout file, from its start. */
function firstMessage(f: string): string {
  try {
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const l of buf.subarray(0, n).toString('utf8').split('\n')) {
      const j = parseLine(l);
      if (j === null) continue;
      const p = j.payload ?? {};
      if (j.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const t = textOf(p.content).replaceAll(/\s+/g, ' ').trim();
        if (t && !HIDDEN_USER.test(t)) return t.slice(0, 140);
      }
    }
  } catch {
    /* unreadable */
  }
  return '';
}

/** Previous Codex conversations in a folder (for "resume"), newest first: { sid, mtime, title, first, agent }. */
export function history(folder: string, max = 25): HistoryEntry[] {
  const want = real(folder),
    names = threadNames(),
    out: HistoryEntry[] = [];
  for (const f of rolloutFiles()) {
    const m = readMeta(f);
    if (!isUserThread(m) || real(m.cwd) !== want) continue;
    let mtime: number;
    try {
      mtime = fs.statSync(f).mtimeMs;
    } catch {
      continue;
    }
    const prompt = info(m.id)?.prompt ?? '';
    const first = firstMessage(f);
    if (!first && !prompt) continue;
    out.push({ sid: m.id, mtime, title: names.get(m.id) ?? '', first: first || prompt, agent: 'codex' });
    if (out.length >= max) break;
  }
  return out.toSorted((a, b) => b.mtime - a.mtime);
}

// ---------- Codex running outside the panel (a terminal, VS Code) ----------

export interface CodexProcess {
  pid: number;
  ppid: number;
  start: number;
  args: string;
}

/**
 * Live interactive Codex processes: the codex binary itself (not the node wrapper, not
 * `codex exec`, the app-server daemon, MCP or sandbox helpers). ps -> [{ pid, ppid, args, start }].
 */
export function liveTuis(psText: string | null | undefined): CodexProcess[] {
  const SUB =
    /^(exec|e|app-server|exec-server|mcp|mcp-server|sandbox|login|logout|debug|apply|a|cloud|completion|features|doctor|update|review|agents|queue|archive|delete|unarchive|plugin|remote-control|app|migrate-rollouts|help)$/;
  const VALUE_FLAGS = new Set([
    '-c',
    '--config',
    '-m',
    '--model',
    '-p',
    '--profile',
    '-s',
    '--sandbox',
    '-a',
    '--ask-for-approval',
    '-C',
    '--cd',
    '-i',
    '--image',
    '--enable',
    '--disable',
    '--add-dir',
    '--local-provider',
  ]);
  const out: CodexProcess[] = [];
  for (const line of (psText ?? '').split('\n')) {
    // pid ppid elapsed-seconds tty command
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const tty = m[4] ?? '',
      args = m[5] ?? '';
    const argv0 = args.split(/\s+/)[0] ?? '';
    if (!/(^|\/)codex$/.test(argv0)) continue;
    // apps that bundle Codex (ChatGPT, Codex desktop) and the shared daemon are not the user's terminal sessions
    if (/\.app\/Contents\/|app-server-daemon/.test(argv0)) continue;
    // an interactive Codex has a terminal; servers and helpers have none ("??")
    if (!tty || tty === '??' || tty === '?' || tty === '-') continue;
    const toks = args.slice(argv0.length).trim().split(/\s+/).filter(Boolean);
    let sub = '';
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i] ?? '';
      if (VALUE_FLAGS.has(tok)) {
        i++;
        continue;
      }
      if (tok.startsWith('-')) continue;
      sub = tok;
      break;
    }
    if (SUB.test(sub)) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), start: Date.now() - Number(m[3]) * 1000, args });
  }
  return out;
}

/** Files and working folder a process has open (lsof). */
function openFiles(pid: number): string[] {
  try {
    const out = execFileSync('lsof', ['-p', String(pid), '-Fn'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .filter((l) => l.startsWith('n'))
      .map((l) => l.slice(1));
  } catch {
    return [];
  }
}
function cwdOf(pid: number): string {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const l = out.split('\n').find((x) => x.startsWith('n'));
    return l === undefined ? '' : l.slice(1);
  } catch {
    return '';
  }
}

/** ps etime ([[dd-]hh:]mm:ss) as seconds, as the old code computed it. */
function etimeSeconds(e: string): number {
  const p = e.split(/[-:]/).map(Number);
  const v = (i: number): number => p[i] ?? Number.NaN;
  if (e.includes('-')) return v(0) * 86_400 + v(1) * 3600 + v(2) * 60 + v(3);
  if (p.length === 3) return v(0) * 3600 + v(1) * 60 + v(2);
  return v(0) * 60 + v(1);
}

export interface CodexRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: 'interactive';
  status: string;
  name: string;
  agent: 'codex';
}

/**
 * Codex sessions running outside the panel, as records in the same shape as Claude's
 * (~/.claude/sessions/<pid>.json): { pid, sessionId, cwd, kind: 'interactive', name, agent }.
 * inPanel(pid) says whether a process runs inside a panel pane. The session id is taken from
 * `codex resume <id>`, else from the record file the process has open, else (a Codex that talks
 * to the shared app-server daemon holds no file itself) the newest user thread of its folder that
 * started after it. A Codex that has not got its first message yet has no session to move.
 */
export function outsideRecords(
  inPanel: (pid: string) => boolean,
  { ps = null }: { ps?: string | null } = {},
): CodexRecord[] {
  let text = ps;
  if (text === null) {
    try {
      text = execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,tty=,command='], { encoding: 'utf8', timeout: 5000 });
    } catch {
      return [];
    }
    // etime is [[dd-]hh:]mm:ss: turn it into seconds for liveTuis
    text = text
      .split('\n')
      .map((l) => l.replace(/^(\s*\d+\s+\d+\s+)(\S+)/, (_whole, a: string, e: string) => a + String(etimeSeconds(e))))
      .join('\n');
  }
  const tuis = liveTuis(text).filter((t) => !inPanel(String(t.pid)));
  const taken = new Set<string>(),
    out: CodexRecord[] = [];
  for (const t of tuis) {
    let sid = /\bresume\s+([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\b/.exec(t.args)?.[1] ?? '';
    let cwd = '';
    if (!sid) {
      const mine = path.join(codexHome(), 'sessions') + path.sep;
      const held = openFiles(t.pid)
        .filter((f) => f.startsWith(mine) && /\/rollout-[^/]*\.jsonl$/.test(f))
        .map((f) => readMeta(f))
        .filter((m) => isUserThread(m));
      const first = held[0];
      if (first) {
        sid = first.id;
        cwd = first.cwd;
      }
    }
    if (!cwd) cwd = cwdOf(t.pid) || (sid ? (readMeta(rolloutFile(sid) ?? '')?.cwd ?? '') : '') || '';
    if (!sid && cwd) sid = discover(cwd, t.start, taken);
    // only sessions of this panel's Codex home (CODEX_HOME), like Claude's records under ~/.claude
    if (!sid || taken.has(sid) || !ne(rolloutFile(sid))) continue;
    taken.add(sid);
    out.push({
      pid: t.pid,
      sessionId: sid,
      cwd,
      kind: 'interactive',
      status: '',
      name: path.basename(cwd || '') || 'Codex session',
      agent: 'codex',
    });
  }
  return out;
}
