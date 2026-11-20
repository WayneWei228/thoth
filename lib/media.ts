// Images and files of a chat for a remote client (GET /api/chat?media=1, /api/media, /api/file,
// /api/toolResult). Pure except `checkFile` (it reads the file system).
//
// 1. Base64 images in the transcript (pasted images, screenshots in tool results) are replaced by
//    a content id (`mediaId`): the chat answer stays small, the phone loads a thumbnail and, on tap,
//    the full image by id. The server resolves an id only to an image block of the same session's
//    transcript (`phoneView(...).media`).
// 2. Files: the server serves a file only when (a) this session's transcript names it in one of the
//    ways listed at `namedPaths` (never in a tool RESULT), (b) its extension is in ALLOWED_EXT and no
//    part of the path is in the deny rules (`denied`), (c) it is a regular file whose real path
//    (symlinks resolved) passes the same rules, under MAX_FILE bytes. (d) is the server's token check.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ne, text as textOfValue, truthy } from './truthy.ts';

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif']);
// documents the phone can show with QuickLook, images, and source/text files Claude writes
const DOC_EXT = new Set([
  'pdf',
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'rtf',
  'ipynb',
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  'svg',
]);
const CODE_EXT = new Set([
  'py',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'swift',
  'java',
  'kt',
  'go',
  'rs',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'm',
  'rb',
  'sql',
  'css',
  'scss',
  'toml',
  'diff',
  'patch',
  'tex',
]);
export const ALLOWED_EXT = new Set([...IMAGE_EXT, ...DOC_EXT, ...CODE_EXT]);
export const MAX_FILE = 50 * 1024 * 1024;
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'text/xml',
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
  rtf: 'application/rtf',
  svg: 'image/svg+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

export const extOf = (p: unknown): string => path.extname(textOfValue(p)).slice(1).toLowerCase();
export const mimeOf = (p: unknown): string => MIME[extOf(p)] ?? 'text/plain; charset=utf-8';

// a file name that often holds a secret, whatever its extension
const SECRET_NAME =
  /(secret|credential|passw|token|private[-_.]?key|id_rsa|id_ed25519|id_ecdsa|keychain|cookies?\.|\.env)/i;
// folders that hold secrets or system files (also covered by the dot rule for ~/.ssh, ~/.aws, ~/.config …)
const DENY_DIRS = [
  'Library/Keychains',
  'Library/Cookies',
  'Library/Mail',
  'Library/Messages',
  'Library/Accounts',
  'Library/Application Support/com.apple.TCC',
  'Library/Safari',
  'Library/Group Containers',
];
const DENY_ROOTS = [
  '/etc',
  '/private/etc',
  '/private/var/root',
  '/var/root',
  '/System',
  '/dev',
  '/Library/Keychains',
  '/usr',
  '/bin',
  '/sbin',
];

export interface RuleOptions {
  home?: string;
  allowDirs?: string[];
}

/**
 * Why `p` (absolute, normalized) must not be served, or '' when the rules allow it.
 * `allowDirs`: folders whose files are served although a part of their path starts with a dot
 * (the panel's attachments folder in ~/.config/cc-panel).
 */
export function denied(p: unknown, { home = os.homedir(), allowDirs = [] }: RuleOptions = {}): string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return 'not an absolute path';
  const ext = extOf(p);
  if (!ALLOWED_EXT.has(ext)) return `type .${ext || '(none)'} is not served`;
  const base = path.basename(p);
  if (SECRET_NAME.test(base)) return 'the name looks like a secret';
  if (DENY_ROOTS.some((r) => p === r || p.startsWith(r + '/'))) return 'system folder';
  if (home && DENY_DIRS.some((d) => p.startsWith(path.join(home, d) + '/'))) return 'private folder';
  const inAllowed = allowDirs.some((d) => d !== '' && p.startsWith(d + path.sep));
  if (!inAllowed && p.split('/').some((seg) => seg.startsWith('.'))) return 'hidden file or folder';
  return '';
}

// ---------- images ----------

export function mediaId(b64: string): string {
  return crypto.createHash('sha256').update(b64).digest('hex').slice(0, 32);
}

export interface Size {
  w: number;
  h: number;
}

/** Width and height from the first bytes of a PNG, JPEG, GIF or WebP; null when unknown. */
export function imageSize(buf: Buffer | null | undefined): Size | null {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG')
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.toString('latin1', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8X' && buf.length >= 30) return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && buf.length >= 30)
      return { w: buf.readUInt16LE(26) & 0x3f_ff, h: buf.readUInt16LE(28) & 0x3f_ff };
    if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3f_ff) + 1, h: ((b >> 14) & 0x3f_ff) + 1 };
    }
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const m = buf[i + 1] ?? 0;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** An image of a chat item: base64 data, a file path, or (after phoneView) a media id. */
export interface ImageIn {
  src?: string | undefined;
  path?: string | undefined;
  id?: string | undefined;
  mime?: string | undefined;
}

export interface Media {
  mime: string;
  b64: string;
}

/** `{src: 'data:…'}` → `{id, mime, w, h, bytes}` and the bytes kept in `media`; other images unchanged. */
function imageRef(im: ImageIn | null | undefined, media: Map<string, Media>): ImageIn | object | null | undefined {
  if (!im || typeof im.src !== 'string' || !im.src.startsWith('data:'))
    return im && ne(im.path) ? { path: im.path, mime: mimeOf(im.path) } : im;
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(im.src);
  if (!m) return null;
  const mime = m[1] ?? '';
  const b64 = m[2] ?? '';
  const id = mediaId(b64);
  if (!media.has(id)) media.set(id, { mime, b64 });
  const head = Buffer.from(b64.slice(0, 64 * 1024), 'base64');
  const size = imageSize(head);
  return {
    id,
    mime,
    ...(size !== null && size.w !== 0 ? { w: size.w, h: size.h } : {}),
    bytes: Math.floor((b64.length * 3) / 4),
  };
}

// ---------- files named in the transcript ----------

const EXT_ALT = [...ALLOWED_EXT].toSorted((a, b) => b.length - a.length).join('|');
// an absolute or ~/ path with an allowed extension, ending at white space or punctuation
const BARE_PATH = new RegExp(
  String.raw`(?:^|[\s(\["'<*_])((?:~|/)[^\s"'<>()\[\]\`*]*?\.(?:${EXT_ALT}))(?=$|[\s)\]"'>.,;:!?*_\`])`,
  'gim',
);
const TICK_PATH = new RegExp(String.raw`\`((?:~|/)[^\`\n]*?\.(?:${EXT_ALT}))\``, 'gi');
const LINK_TARGET = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

function expand(p: string, cwd: string | null | undefined, home: string): string | null {
  let s = p.trim();
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\/(localhost)?/i, ''));
    } catch {
      return null;
    }
  }
  if (s.startsWith('~/')) s = path.join(home, s.slice(2));
  if (!path.isAbsolute(s)) {
    if (!ne(cwd)) return null;
    s = path.join(cwd, s);
  }
  return path.resolve(s);
}

/**
 * Paths of allowed type that a text names: absolute or ~/ paths, `file://` URLs, paths in `back ticks`
 * (may hold spaces) and Markdown link / image targets (relative ones resolved against `cwd`).
 */
export function pathsInText(text: unknown, cwd: string | null | undefined, home: string = os.homedir()): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined, relOk: boolean): void => {
    if (!ne(raw) || (/^[a-z][\d+.a-z-]*:/i.test(raw) && !/^file:/i.test(raw))) return; // http:, mailto: …
    if (!relOk && !/^(~\/|\/|file:)/i.test(raw)) return;
    const p = expand(raw, cwd, home);
    if (ne(p) && ALLOWED_EXT.has(extOf(p))) out.add(p);
  };
  const s = truthy(text) ? textOfValue(text) : '';
  for (const m of s.matchAll(LINK_TARGET)) add(m[1], true);
  for (const m of s.matchAll(TICK_PATH)) add(m[1], false);
  for (const m of s.matchAll(BARE_PATH)) add(m[1], false);
  for (const m of s.matchAll(/file:\/\/[^\s)\]>"'`]+/gi)) add(m[0], false);
  return [...out];
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read']);

/** A block of a chat item (lib/chat.ts or lib/codex.ts), the fields this file reads. */
export interface BlockIn {
  type: string;
  text?: string | undefined;
  name?: string | undefined;
  input?: Record<string, unknown> | undefined;
  cwd?: string | undefined;
  codexPatch?: string | undefined;
  toolUseResult?: unknown;
  images?: (ImageIn | null)[] | undefined;
  sent?: { caption: string; images: { path: string }[] } | undefined;
  fullResult?: string | undefined;
  result?: string | undefined;
}

/** A chat item (lib/chat.ts or lib/codex.ts), the fields this file reads. */
export interface ItemIn {
  role: string;
  cwd?: string | undefined;
  files?: ({ path: string } | null)[] | undefined;
  images?: (ImageIn | null)[] | undefined;
  blocks?: BlockIn[] | undefined;
}

/**
 * Every path this transcript names in a way that lets the phone open it:
 *  - files and images the user attached (user items' `files` / `images[].path`),
 *  - files Claude sent with SendUserFile (any type),
 *  - targets of Write, Edit, MultiEdit, NotebookEdit and Read (the tool's input, not its result),
 *  - paths in Claude's own text blocks (not in tool results, not in thinking, not in user text).
 * Returns a Set of resolved absolute paths.
 */
export function namedPaths(items: readonly ItemIn[] | null | undefined, home: string = os.homedir()): Set<string> {
  const out = new Set<string>();
  for (const it of items ?? []) {
    if (it.role === 'user') {
      for (const f of it.files ?? []) if (f && ne(f.path)) out.add(path.resolve(f.path));
      for (const im of it.images ?? []) if (im && ne(im.path)) out.add(path.resolve(im.path));
      continue;
    }
    for (const b of it.blocks ?? []) {
      if (b.type === 'text') for (const p of pathsInText(b.text, it.cwd, home)) out.add(p);
      if (b.type !== 'tool') continue;
      for (const p of toolPaths(b)) out.add(p);
    }
  }
  return out;
}

export interface PatchFile {
  path: string;
  op: string;
  lines: string[];
}

/**
 * A Codex apply_patch text → [{ path, op: 'update'|'add'|'delete', lines }] (`lines` keep their
 * leading ' ', '-', '+'; '@@' lines start a hunk). Paths are resolved against `cwd`.
 */
export function codexPatch(text: string | null | undefined, cwd: string | null | undefined): PatchFile[] {
  const files: PatchFile[] = [];
  let f: PatchFile | null = null;
  for (const line of (text ?? '').split('\n')) {
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (m) {
      f = { path: path.resolve((cwd ?? '') || '/', (m[2] ?? '').trim()), op: (m[1] ?? '').toLowerCase(), lines: [] };
      files.push(f);
      continue;
    }
    if (/^\*\*\* (Begin|End) Patch|^\*\*\* End of File|^\*\*\* Move to:/.test(line)) continue;
    if (f && (/^[ +-]/.test(line) || line.startsWith('@@'))) f.lines.push(line);
  }
  return files;
}

function toolPaths(b: BlockIn): string[] {
  const input = b.input ?? {};
  const out: string[] = [];
  const base = (b.cwd ?? '') || '/';
  if (ne(b.codexPatch)) for (const f of codexPatch(b.codexPatch, b.cwd)) if (f.op !== 'delete') out.push(f.path);
  if (FILE_TOOLS.has(b.name ?? '')) {
    const p = [input['file_path'], input['notebook_path']].find((x) => truthy(x));
    if (typeof p === 'string' && p) out.push(path.resolve(base, p));
  }
  const files = input['files'];
  if (b.name === 'SendUserFile' && Array.isArray(files)) {
    for (const f of files as unknown[]) if (typeof f === 'string' && f) out.push(path.resolve(base, f));
  }
  return out;
}

export interface CheckFileOptions extends RuleOptions {
  maxBytes?: number;
}

export type CheckFileResult =
  { fd: number; size: number; real: string; mime: string; mtime: number } | { error: string; code: number };

/**
 * Checks `requested` against the rules and opens it. Returns { fd, size, real, mime } or { error, code }.
 * The caller closes `fd`. `named`: namedPaths() of this session's transcript.
 */
export function checkFile(
  requested: unknown,
  named: Set<string>,
  { home = os.homedir(), allowDirs = [], maxBytes = MAX_FILE }: CheckFileOptions = {},
): CheckFileResult {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) return { error: 'bad path', code: 400 };
  const p = path.resolve(requested);
  if (!named.has(p)) return { error: 'this session did not name the file', code: 403 };
  let why = denied(p, { home, allowDirs });
  if (why) return { error: why, code: 403 };
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    return { error: 'not found', code: 404 };
  }
  const realAllow = allowDirs.map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return d;
    }
  });
  why = denied(real, { home, allowDirs: realAllow });
  if (why) return { error: `link target: ${why}`, code: 403 };
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    return { error: 'not found', code: 404 };
  }
  if (!st.isFile()) return { error: 'not a regular file', code: 403 };
  if (st.size > maxBytes) return { error: 'file too large', code: 413 };
  if (CODE_EXT.has(extOf(real)) && st.mode & 0o111) return { error: 'executable', code: 403 };
  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return { error: 'cannot open', code: 404 };
  }
  const fst = fs.fstatSync(fd);
  // the file changed between the checks and the open (a swap to a link or a FIFO): refuse
  if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev || fst.size > maxBytes) {
    fs.closeSync(fd);
    return { error: 'file changed', code: 409 };
  }
  return { fd, size: fst.size, real, mime: mimeOf(real), mtime: fst.mtimeMs };
}

export interface FileCard {
  path: string;
  name: string;
  ext: string;
  size: number;
  kind: string;
  image: boolean;
}

/** { path, name, ext, size } for a named file the rules allow and that exists; null otherwise. */
function fileCard(p: string, opts: RuleOptions, kind: string): FileCard | null {
  if (denied(p, opts)) return null;
  let real: string, st: fs.Stats;
  try {
    real = fs.realpathSync(p);
    st = fs.statSync(real);
  } catch {
    return null;
  }
  const realAllow = (opts.allowDirs ?? []).map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return d;
    }
  });
  if (!st.isFile() || st.size > MAX_FILE || denied(real, { ...opts, allowDirs: realAllow })) return null;
  if (CODE_EXT.has(extOf(real)) && st.mode & 0o111) return null;
  return { path: p, name: path.basename(p), ext: extOf(p), size: st.size, kind, image: IMAGE_EXT.has(extOf(p)) };
}

// ---------- tool details for the phone's cards ----------

const cut = (s: unknown, n: number): { text: string; more: boolean } => {
  const t = s === null || s === undefined ? '' : textOfValue(s);
  return t.length > n ? { text: t.slice(0, n), more: true } : { text: t, more: false };
};
const MAX_PATCH_LINES = 400;

interface Hunk {
  oldStart: unknown;
  newStart: unknown;
  file?: string;
  lines: string[];
}

interface Extras {
  patch?: Hunk[];
  patchMore?: boolean;
  edits?: { old: string; new: string }[];
  editsMore?: boolean;
  write?: { text: string; lines: number; more: boolean; path?: string };
  sent?: { caption: string; images: never[] };
  todos?: { text: string; status: string }[];
  url?: string;
  resultMore?: number;
  files?: FileCard[];
}

interface RawHunk {
  oldStart?: unknown;
  newStart?: unknown;
  lines?: unknown[];
}

function structuredHunks(patch: RawHunk[], x: Extras): void {
  let n = 0;
  const hunks: Hunk[] = [];
  for (const h of patch) {
    if (n >= MAX_PATCH_LINES) break;
    const lines = (h.lines ?? []).slice(0, MAX_PATCH_LINES - n).map((l) => textOfValue(l).slice(0, 2000));
    n += lines.length;
    hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
  }
  x.patch = hunks;
  if (patch.reduce((s, h) => s + (h.lines ?? []).length, 0) > n) x.patchMore = true;
}

function codexHunks(b: BlockIn, x: Extras): void {
  const files = codexPatch(b.codexPatch, b.cwd);
  const hunks: Hunk[] = [];
  let n = 0;
  for (const f of files) {
    if (f.op === 'add') {
      if (!x.write) {
        const c = cut(
          f.lines
            .slice(0, 200)
            .map((l) => l.slice(1))
            .join('\n'),
          16_000,
        );
        x.write = { text: c.text, lines: f.lines.length, more: c.more || f.lines.length > 200, path: f.path };
      }
      continue;
    }
    let h: Hunk | null = null;
    for (const l of f.lines) {
      if (n >= MAX_PATCH_LINES) {
        x.patchMore = true;
        break;
      }
      if (l.startsWith('@@') || !h) {
        h = { oldStart: null, newStart: null, file: path.basename(f.path), lines: [] };
        hunks.push(h);
        if (l.startsWith('@@')) continue;
      }
      h.lines.push(l.slice(0, 2000));
      n++;
    }
  }
  if (hunks.length > 0) x.patch = hunks.filter((hk) => hk.lines.length > 0);
}

interface TodoIn {
  content?: unknown;
  activeForm?: unknown;
  status?: unknown;
}

/** Extra fields of a tool block for the phone: diff, written text, todos, URL, file card. */
function toolExtras(b: BlockIn, cardOpts: RuleOptions, cardCache: Map<string, FileCard | null>): Extras {
  const input = b.input ?? {};
  const r =
    typeof b.toolUseResult === 'object' && b.toolUseResult !== null
      ? (b.toolUseResult as { structuredPatch?: unknown })
      : null;
  const x: Extras = {};
  const oldString = input['old_string'];
  const edits = input['edits'];
  if (
    (b.name === 'Edit' || b.name === 'MultiEdit') &&
    r &&
    Array.isArray(r.structuredPatch) &&
    r.structuredPatch.length > 0
  ) {
    structuredHunks(r.structuredPatch as RawHunk[], x);
  } else if (b.name === 'Edit' && typeof oldString === 'string') {
    const o = cut(oldString, 8000),
      nw = cut(input['new_string'], 8000);
    x.edits = [{ old: o.text, new: nw.text }];
    if (o.more || nw.more) x.editsMore = true;
  } else if (b.name === 'MultiEdit' && Array.isArray(edits)) {
    x.edits = (edits as { old_string?: unknown; new_string?: unknown }[])
      .slice(0, 20)
      .map((e) => ({ old: cut(e.old_string, 4000).text, new: cut(e.new_string, 4000).text }));
  }
  if (ne(b.codexPatch)) codexHunks(b, x);
  const content = input['content'];
  if (b.name === 'Write' && typeof content === 'string') {
    const lines = content.split('\n');
    const head = lines.slice(0, 200).join('\n');
    const c = cut(head, 16_000);
    x.write = { text: c.text, lines: lines.length, more: c.more || lines.length > 200 };
  }
  const caption = input['caption'];
  if (b.name === 'SendUserFile' && !b.sent && typeof caption === 'string' && caption.trim())
    x.sent = { caption: caption.trim(), images: [] };
  const todos = input['todos'];
  if (b.name === 'TodoWrite' && Array.isArray(todos)) {
    x.todos = (todos as TodoIn[]).slice(0, 50).map((t) => ({
      text: textOfValue([t.content, t.activeForm].find((v) => truthy(v)) ?? '').slice(0, 300),
      status: textOfValue(truthy(t.status) ? t.status : 'pending'),
    }));
  }
  const url = input['url'];
  if (b.name === 'WebFetch' && typeof url === 'string' && /^https?:\/\//i.test(url)) x.url = url.slice(0, 2000);
  if (typeof b.fullResult === 'string' && b.fullResult.length > (b.result ?? '').length)
    x.resultMore = b.fullResult.length;
  const files: FileCard[] = [];
  let kind = 'written';
  if (b.name === 'SendUserFile') kind = 'sent';
  else if (b.name === 'Read') kind = 'read';
  for (const p of toolPaths(b)) {
    if (!cardCache.has(p)) cardCache.set(p, fileCard(p, cardOpts, kind));
    const c = cardCache.get(p);
    if (c && !(b.name === 'SendUserFile' && c.image && b.sent)) files.push(c);
  }
  if (files.length > 0) x.files = files;
  return x;
}

export interface PhoneView {
  items: Record<string, unknown>[];
  media: Map<string, Media>;
  named: Set<string>;
}

/**
 * The chat items as the phone gets them: images by id, file cards (only files the rules allow),
 * tool details. Returns { items, media: Map(id → {mime, b64}), named: Set(paths) }.
 */
export function phoneView(
  items: readonly ItemIn[] | null | undefined,
  { home = os.homedir(), allowDirs = [] }: RuleOptions = {},
): PhoneView {
  const media = new Map<string, Media>();
  const cardOpts = { home, allowDirs };
  const cardCache = new Map<string, FileCard | null>();
  const card = (p: string, kind: string): FileCard | null => {
    if (!cardCache.has(p)) cardCache.set(p, fileCard(p, cardOpts, kind));
    return cardCache.get(p) ?? null;
  };
  const named = namedPaths(items, home);
  // a file image (attachment, SendUserFile): its width and height from the file's first bytes, when the
  // rules allow the file; the phone then keeps the right space before the image loads
  const sized = new Map<string, Size | null>();
  const withSize = <I>(im: I): I => {
    const ref = im as ImageIn | null | undefined;
    if (!ref || !ne(ref.path) || ne(ref.id)) return im;
    const p = path.resolve(ref.path);
    if (!sized.has(p)) {
      let dim: Size | null = null;
      if (card(p, 'attached')) {
        try {
          const fd = fs.openSync(p, 'r');
          const buf = Buffer.alloc(64 * 1024);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          dim = imageSize(buf.subarray(0, n));
        } catch {
          dim = null;
        }
      }
      sized.set(p, dim);
    }
    const d = sized.get(p);
    return d ? { ...im, w: d.w, h: d.h } : im;
  };
  const out = (items ?? []).map((it): Record<string, unknown> => {
    if (it.role === 'user') {
      return {
        ...it,
        images: (it.images ?? []).map((im) => withSize(imageRef(im, media))).filter((v) => truthy(v)),
        files: (it.files ?? []).map((f) => card(path.resolve(f?.path ?? ''), 'attached') ?? { ...f, missing: true }),
      };
    }
    const blocks = (it.blocks ?? []).map((b) => {
      if (b.type === 'text') {
        const files = pathsInText(b.text, it.cwd, home)
          .map((p) => card(p, 'named'))
          .filter((v) => v !== null);
        return files.length > 0 ? { ...b, files } : b;
      }
      if (b.type !== 'tool') return b;
      const t: Record<string, unknown> = {
        ...b,
        images: (b.images ?? []).map((im) => imageRef(im, media)).filter((v) => truthy(v)),
        ...toolExtras(b, cardOpts, cardCache),
      };
      if (b.sent)
        t['sent'] = {
          ...b.sent,
          images: b.sent.images.map((im) => withSize({ path: im.path, mime: mimeOf(im.path) })),
        };
      return t;
    });
    return { ...it, blocks };
  });
  return { items: out, media, named };
}
