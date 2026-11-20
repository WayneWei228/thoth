// Turns a Claude Code transcript (.jsonl) into chat items for the chat view.
// Pure: input is the transcript text, output is plain objects. Tested in
// a test against a real transcript excerpt.
//
// Item shapes:
//   { id, role: 'user', ts, text, images: [{src}|{path}], files: [{path, name, ext}] }
//   { id, role: 'assistant', ts, blocks: [ {type:'text', text} | {type:'thinking', text, seconds, key}
//                                          | {type:'tool', id, name, summary, detail?, status, result, images, sent?} ] }
//   sent (only on a SendUserFile tool): { caption, images: [{path}] } — the images Claude sent to the user,
//   absolute paths. The chat view shows them in the message; the server serves only these paths.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// attachment paths in a user message: images and the documents Claude Code can read
import { PATH_RE as ATTACH_RE } from './attachments.ts'; // the one list of attachment types
import { ne, truthy } from './truthy.ts';

const HIDDEN_USER =
  /^\s*(<command-|<local-command|<system-reminder|<bash-|<agent-message|<task-notification|<user-prompt-submit-hook|Caveat: The messages below)/;
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|heic)$/i;

export interface ImageRef {
  src?: string;
  path?: string;
}
export interface FileRef {
  path: string;
  name: string;
  ext: string;
}
export interface UserItem {
  id: string;
  role: 'user';
  ts: string | undefined;
  text: string;
  images: ImageRef[];
  files: FileRef[];
  queued?: boolean;
  endsTurn?: boolean;
  turnSeconds?: number;
}
export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  seconds: number | null;
  key: string;
}
export interface SentFiles {
  caption: string;
  images: { path: string }[];
}
export interface ToolBlock {
  type: 'tool';
  id: string | undefined;
  name: string | undefined;
  summary: string;
  detail?: string;
  status: string;
  result: string;
  images: ImageRef[];
  sent?: SentFiles;
  // not enumerable (JSON.stringify leaves them out): kept in memory for lib/media.ts
  owner?: AssistantItem;
  fullResult?: string;
  toolUseResult?: { structuredPatch: unknown[] };
  input?: Record<string, unknown>;
  cwd?: string;
  codexPatch?: string; // lib/codex.ts: the apply_patch text
}
export type Block = TextBlock | ThinkingBlock | ToolBlock;
export interface AssistantItem {
  id: string;
  role: 'assistant';
  ts: string | undefined;
  endTs: string | undefined;
  blocks: Block[];
  // not enumerable
  msgId?: string;
  cwd?: string;
  endsTurn?: boolean;
  turnSeconds?: number;
}
export type ChatItem = UserItem | AssistantItem;

/** One content block of a transcript message (the fields this code reads). */
interface RawBlock {
  type?: string;
  text?: string;
  thinking?: unknown;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  source?: { type?: string; data?: string; media_type?: string; url?: string } | null;
}

/** One transcript line (the fields this code reads). */
interface RawLine {
  isMeta?: boolean;
  isSidechain?: boolean;
  type?: string;
  uuid: string;
  timestamp?: string;
  cwd?: string;
  attachment?: { type?: string; prompt?: unknown } | null;
  message?: { id?: string; content?: unknown } | null;
  toolUseResult?: unknown;
}

// a property that JSON.stringify leaves out: kept in memory for lib/media.ts, not sent to the web UI
function hide(o: object, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: false, writable: true });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as (RawBlock | null)[])
    .filter((b) => b?.type === 'text')
    .map((b) => b?.text)
    .join('\n');
}

function imageSrc(block: RawBlock | null | undefined): ImageRef | null {
  const s = block?.source;
  if (s?.type === 'base64' && ne(s.data))
    return { src: `data:${(s.media_type ?? '') || 'image/png'};base64,${s.data}` };
  if (s?.type === 'url' && ne(s.url)) return { src: s.url };
  return null;
}

const isImage = (x: ImageRef | null): x is ImageRef => x !== null;

// Images that Claude sent with the SendUserFile tool. Relative paths are relative to the session's folder.
function sentFiles(block: RawBlock, cwd: string | undefined): SentFiles | null {
  const input = block.input ?? {};
  const files = input['files'];
  if (block.name !== 'SendUserFile' || !Array.isArray(files)) return null;
  const images = (files as unknown[])
    .filter((f): f is string => typeof f === 'string' && IMAGE_RE.test(f))
    .map((f) => ({ path: path.resolve((cwd ?? '') || '/', f) }));
  if (images.length === 0) return null;
  const caption = input['caption'];
  return { caption: typeof caption === 'string' ? caption.trim() : '', images };
}

export function summarizeTool(name: string | undefined, input: Record<string, unknown> = {}): string {
  const pick = (...keys: string[]): string | undefined =>
    keys.map((k) => input[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  let s: string | undefined;
  switch (name) {
    case 'Bash': {
      s = pick('command');
      break;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      s = pick('file_path', 'notebook_path');
      break;
    }
    case 'Glob':
    case 'Grep': {
      s = pick('pattern');
      break;
    }
    case 'WebFetch': {
      s = pick('url');
      break;
    }
    case 'WebSearch': {
      s = pick('query');
      break;
    }
    case 'Task':
    case 'Agent': {
      s = pick('description', 'prompt');
      break;
    }
    case 'TodoWrite': {
      const todos = input['todos'];
      s = Array.isArray(todos) ? `${String(todos.length)} todos` : '';
      break;
    }
    case undefined:
    default: {
      s = pick('description', 'command', 'file_path', 'url', 'query', 'path', 'name');
    }
  }
  if (!ne(s)) {
    try {
      s = JSON.stringify(input);
    } catch {
      s = '';
    }
  }
  return s.replaceAll(/\s+/g, ' ').slice(0, 160);
}

/** The full Bash command, newlines kept, for an opened tool card; null when the summary already shows all of it. */
function toolDetail(name: string | undefined, input: Record<string, unknown> = {}, summary = ''): string | null {
  const command = input['command'];
  if (name !== 'Bash' || typeof command !== 'string') return null;
  const full = command.trim().slice(0, 4000);
  return full && full !== summary ? full : null;
}

function filesOf(text: string, images: ImageRef[]): FileRef[] {
  const files: FileRef[] = [];
  for (const p of text.match(ATTACH_RE) ?? []) {
    if (IMAGE_RE.test(p)) images.push({ path: p });
    else files.push({ path: p, name: p.split('/').pop() ?? '', ext: (p.split('.').pop() ?? '').toLowerCase() });
  }
  return files;
}

function visible(it: ChatItem): boolean {
  return it.role === 'user' || it.blocks.some((b) => b.type !== 'thinking' || b.text !== '');
}

/**
 * Builds chat items from transcript lines, a part at a time: feed() takes the next complete lines
 * (a transcript only grows, so a reader gives it the bytes appended since the last read and does
 * not parse the whole file again; TranscriptFile below). items() returns the last `limit` items.
 * It keeps at most keep + max(50, keep / 2) raw items, so a long transcript does not stay in memory.
 */
export class TranscriptParser {
  keep: number;
  raw: ChatItem[];
  tools: Map<string | undefined, ToolBlock>; // tool_use id -> tool block
  current: AssistantItem | null; // assistant item being built (same message id)
  lastTs: string | null; // time of the previous record: a thinking block runs from there to its own time
  turnStart: string | null | undefined; // time of the last user item that was dropped from `raw`

  constructor({ keep = 300 }: { keep?: number } = {}) {
    this.keep = keep;
    this.raw = [];
    this.tools = new Map();
    this.current = null;
    this.lastTs = null;
    this.turnStart = null;
  }

  /** text: complete transcript lines */
  feed(text: string): this {
    for (const line of text.split('\n')) this.line(line);
    if (this.raw.length > this.keep + Math.max(50, this.keep >> 1)) this.trim();
    return this;
  }

  line(line: string): void {
    if (!line.trim()) return;
    let j: RawLine;
    try {
      j = JSON.parse(line) as RawLine;
    } catch {
      return;
    }
    if (j.isMeta === true || j.isSidechain === true) return;
    const items = this.raw;
    // a message typed while Claude was busy is stored as a queued_command attachment
    const att = j.type === 'attachment' && j.attachment?.type === 'queued_command' ? j.attachment : null;
    if (att) {
      const text = textOf(att.prompt).trim();
      if (text && !HIDDEN_USER.test(text)) {
        const images: ImageRef[] = [];
        const files = filesOf(text, images);
        items.push({ id: j.uuid, role: 'user', ts: j.timestamp, text, images, files, queued: true });
        this.current = null;
      }
      if (ne(j.timestamp)) this.lastTs = j.timestamp;
      return;
    }
    const m = j.message;
    if (!m) return;
    const prevTs = this.lastTs;
    if (ne(j.timestamp)) this.lastTs = j.timestamp;

    if (j.type === 'user') {
      this.userLine(j, m.content);
      return;
    }

    if (j.type === 'assistant' && Array.isArray(m.content)) {
      this.assistantLine(j, m.id, m.content as RawBlock[], prevTs);
    }
  }

  private userLine(j: RawLine, content: unknown): void {
    const blocks = Array.isArray(content) ? (content as (RawBlock | null)[]) : null;
    // tool results come back as user messages
    if (blocks?.some((b) => b?.type === 'tool_result') === true) {
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue;
        const t = this.tools.get(b.tool_use_id);
        if (!t) continue;
        t.status = b.is_error === true ? 'error' : 'done';
        if (t.owner && ne(j.timestamp)) t.owner.endTs = j.timestamp;
        const parts: RawBlock[] = Array.isArray(b.content)
          ? (b.content as RawBlock[])
          : [{ type: 'text', text: truthy(b.content) ? String(b.content) : '' }];
        const full = parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n');
        t.result = full.slice(0, 2000);
        // for the phone (lib/media.ts): the whole result (capped) and the diff Claude Code saved, not sent by default
        hide(t, 'fullResult', full.slice(0, 256 * 1024));
        const r = j.toolUseResult as { structuredPatch?: unknown } | null | undefined;
        if (r && typeof r === 'object' && Array.isArray(r.structuredPatch))
          hide(t, 'toolUseResult', { structuredPatch: r.structuredPatch });
        t.images = parts
          .filter((p) => p.type === 'image')
          .map((p) => imageSrc(p))
          .filter((x) => isImage(x));
      }
      return;
    }
    const text = textOf(content).trim();
    if (!text && blocks?.some((b) => b?.type === 'image') !== true) return;
    if (HIDDEN_USER.test(text)) return;
    const images: ImageRef[] = blocks
      ? blocks
          .filter((b) => b?.type === 'image')
          .map((b) => imageSrc(b))
          .filter((x) => isImage(x))
      : [];
    const files = filesOf(text, images);
    this.raw.push({ id: j.uuid, role: 'user', ts: j.timestamp, text, images, files });
    this.current = null;
  }

  private assistantLine(j: RawLine, msgId: string | undefined, content: RawBlock[], prevTs: string | null): void {
    let current = this.current;
    if (!current || current.msgId !== msgId) {
      current = this.current = {
        id: j.uuid,
        role: 'assistant',
        ts: j.timestamp,
        endTs: j.timestamp,
        blocks: [],
      };
      hide(current, 'msgId', msgId);
      hide(current, 'cwd', j.cwd ?? '');
      this.raw.push(current);
    }
    if (ne(j.timestamp)) current.endTs = j.timestamp;
    for (const b of content) {
      if (b.type === 'text' && ne(b.text) && b.text.trim() !== '') current.blocks.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        // empty text = Claude Code did not ask for summaries (showThinkingSummaries off)
        const text = b.type === 'thinking' && truthy(b.thinking) ? String(b.thinking).trim() : '';
        const ms = ne(prevTs) && ne(j.timestamp) ? Date.parse(j.timestamp) - Date.parse(prevTs) : null;
        current.blocks.push({
          type: 'thinking',
          text,
          seconds: ms !== null && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : null,
          key: `${j.uuid}:${String(current.blocks.length)}`,
        });
      } else if (b.type === 'tool_use') {
        const t: ToolBlock = {
          type: 'tool',
          id: b.id,
          name: b.name,
          summary: summarizeTool(b.name, b.input),
          status: 'running',
          result: '',
          images: [],
        };
        const detail = toolDetail(b.name, b.input, t.summary);
        if (ne(detail)) t.detail = detail;
        const sent = sentFiles(b, j.cwd);
        if (sent) t.sent = sent;
        this.tools.set(b.id, t);
        Object.defineProperty(t, 'owner', { value: current, enumerable: false });
        hide(t, 'input', b.input ?? {});
        hide(t, 'cwd', j.cwd ?? '');
        current.blocks.push(t);
      }
    }
  }

  // Drops the raw items before the last `keep` items that items() can show, and their tool calls.
  trim(): void {
    let shown = 0,
      cut = this.raw.length;
    while (cut > 0 && shown < this.keep) {
      cut--;
      const it = this.raw[cut];
      if (it && visible(it)) shown++;
    }
    if (cut <= 0) return;
    const gone = new Set<ChatItem>(this.raw.slice(0, cut));
    for (const it of gone) if (it.role === 'user') this.turnStart = it.ts;
    for (const [id, t] of this.tools) if (t.owner && gone.has(t.owner)) this.tools.delete(id);
    this.raw = this.raw.slice(cut);
  }

  /** The last `limit` items. New objects for the items (blocks are shared): the raw items change as lines come. */
  items(limit: number = this.keep): ChatItem[] {
    const out: ChatItem[] = [];
    for (const it of this.raw) {
      if (it.role === 'user') {
        out.push(it);
        continue;
      }
      // Empty thinking (no summary saved) is not shown, as in the Claude app.
      const blocks = it.blocks.filter((b) => b.type !== 'thinking' || b.text !== '');
      if (blocks.length === 0) continue;
      const copy: AssistantItem = { ...it, blocks };
      hide(copy, 'cwd', it.cwd);
      out.push(copy);
    }
    // One rough time per turn (user message -> last assistant item before the next
    // user message), shown once at the end instead of a time on every step.
    let turnStart = this.turnStart;
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
}

/** jsonl: transcript text; keep only the last `limit` items. */
export function parseTranscript(jsonl: string, { limit = 200 }: { limit?: number } = {}): ChatItem[] {
  return new TranscriptParser({ keep: limit }).feed(jsonl).items(limit);
}

/** The parts of node:fs that TranscriptFile uses (a test can pass its own). */
export type FsLike = Pick<typeof fs, 'statSync' | 'openSync' | 'readSync' | 'closeSync'>;

export interface TranscriptView {
  mtime: number;
  items: ChatItem[];
}

/**
 * One transcript file, read as it grows. read() parses only the bytes added since the last read
 * (up to the last complete line), so a long session that changes every second costs the new lines,
 * not the whole file (a 352 MB transcript took 0.8-0.9 s per change, 2026-11-17). A file that got
 * shorter or is another file (inode) is read again from the start.
 * read() returns { mtime, items }; the same object while the file did not change.
 */
export class TranscriptFile {
  file: string;
  limit: number;
  chunk: number;
  parser!: TranscriptParser;
  offset!: number;
  ino!: number | null;
  mtime!: number;
  size!: number;
  v!: TranscriptView | null;

  constructor(file: string, { limit = 300, chunk = 8 << 20 }: { limit?: number; chunk?: number } = {}) {
    this.file = file;
    this.limit = limit;
    this.chunk = chunk;
    this.reset();
  }

  reset(): void {
    this.parser = new TranscriptParser({ keep: this.limit });
    this.offset = 0;
    this.ino = null;
    this.mtime = 0;
    this.size = -1;
    this.v = null;
  }

  read(fsMod: FsLike = fs): TranscriptView {
    const st = fsMod.statSync(this.file);
    if (this.v && st.size === this.size && st.mtimeMs === this.mtime && st.ino === this.ino) return this.v;
    if (st.size < this.offset || (this.ino !== null && st.ino !== this.ino)) this.reset();
    this.ino = st.ino;
    const fd = fsMod.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(this.chunk, Math.max(1, st.size - this.offset)));
      let rest = Buffer.alloc(0);
      while (this.offset + rest.length < st.size) {
        const n = fsMod.readSync(fd, buf, 0, buf.length, this.offset + rest.length);
        if (n <= 0) break;
        const data = rest.length > 0 ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
        const nl = data.lastIndexOf(10);
        if (nl < 0) {
          rest = Buffer.from(data);
          continue;
        }
        // up to the last newline: complete lines only (a line being written is read next time)
        this.parser.feed(data.toString('utf8', 0, nl + 1));
        this.offset += nl + 1;
        rest = Buffer.from(data.subarray(nl + 1));
      }
    } finally {
      fsMod.closeSync(fd);
    }
    this.size = st.size;
    this.mtime = st.mtimeMs;
    this.v = { mtime: st.mtimeMs, items: this.parser.items(this.limit) };
    return this.v;
  }
}

function newEpoch(): string {
  return crypto.randomBytes(6).toString('hex');
}

// true when `ids` is `old` without some items at the front and with new items at the end
function onlyGrew(old: string[], ids: string[]): boolean {
  if (old.length === 0 || ids.length === 0) return true;
  let k = old.indexOf(ids[0] ?? '');
  if (k < 0) return !ids.some((id) => old.includes(id));
  for (let i = 0; k < old.length; i++, k++) if (ids[i] !== old[k]) return false;
  return true;
}

/**
 * Which chat items changed, so the phone does not download the whole window every second while a
 * session works (300 items, 0.5-0.9 MB, for one new line; 2026-11-17). update(items) gives every
 * item the revision in which its JSON last changed; since(token) returns only the items changed
 * after the revision named by `token`, or null when the client must take the whole window (no
 * token, a token of another epoch, or a list that did not only grow at the end).
 * The token is "<epoch>.<revision>"; the epoch changes when the server starts or the list is replaced.
 */
export class ChatRevisions<T extends { id: string } = ChatItem> {
  epoch: string;
  seq: number;
  items: T[] | null;
  revs: Map<string, { sig: string; rev: number }>;
  ids: string[];

  constructor() {
    this.epoch = newEpoch();
    this.seq = 0;
    this.items = null;
    this.revs = new Map();
    this.ids = [];
  }

  update(items: T[]): this {
    if (items === this.items) return this;
    const ids = items.map((it) => it.id);
    if (!onlyGrew(this.ids, ids)) {
      this.epoch = newEpoch();
      this.seq = 0;
      this.revs = new Map();
    }
    this.seq++;
    const revs = new Map<string, { sig: string; rev: number }>();
    for (const it of items) {
      const sig = crypto.createHash('sha1').update(JSON.stringify(it)).digest('base64');
      const old = this.revs.get(it.id);
      revs.set(it.id, old?.sig === sig ? old : { sig, rev: this.seq });
    }
    this.items = items;
    this.revs = revs;
    this.ids = ids;
    return this;
  }

  get token(): string {
    return `${this.epoch}.${String(this.seq)}`;
  }

  since(token: string | null | undefined): T[] | null {
    const [epoch, n] = (token ?? '').split('.');
    const seq = Number(n);
    if (!this.items || epoch !== this.epoch || !Number.isInteger(seq) || seq < 0 || seq > this.seq) return null;
    return this.items.filter((it) => (this.revs.get(it.id)?.rev ?? 0) > seq);
  }
}

// true when `file` is an image that this transcript's SendUserFile calls sent without an error
export function wasSent(items: ChatItem[], file: string): boolean {
  return items.some(
    (it) =>
      it.role === 'assistant' &&
      it.blocks.some(
        (b) =>
          b.type === 'tool' &&
          b.sent !== undefined &&
          b.status === 'done' &&
          b.sent.images.some((im) => im.path === file),
      ),
  );
}

export interface Echo {
  text: string;
  at: number;
  phase?: string;
  [key: string]: unknown;
}

/**
 * Messages sent from the chat composer that the transcript does not show yet.
 * Claude Code writes a prompt to the transcript only after its UserPromptSubmit hooks end; the
 * brain hook takes about 13 s (median, 2026-11-10), so the chat shows the message itself until then.
 *   echoes: [{ text, at, phase }] (at: ms when sent), items: parseTranscript() result
 * A message has arrived when a user item from `at` - 2 s on contains its text (the transcript text
 * also has the attachment paths). One user item matches one message. After maxAge it is dropped.
 * Returns the messages still pending; the input is not changed.
 */
export function pendingEchoes<E extends Echo>(
  echoes: E[] | null | undefined,
  items: ChatItem[] | null | undefined,
  now: number = Date.now(),
  maxAge = 120_000,
): E[] {
  const norm = (t: string | null | undefined): string => (t ?? '').replaceAll(/\s+/g, ' ').trim();
  const users = (items ?? []).filter((it): it is UserItem => it.role === 'user');
  const used = new Set<UserItem>();
  return (echoes ?? []).filter((e) => {
    if (now - e.at > maxAge) return false;
    const want = norm(e.text).slice(0, 80);
    const hit = users.find(
      (u) => !used.has(u) && !(Date.parse(u.ts ?? '') < e.at - 2000) && norm(u.text).includes(want),
    );
    if (hit) {
      used.add(hit);
      return false;
    }
    return true;
  });
}
