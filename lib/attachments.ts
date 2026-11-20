// Attachments: files the user sends with a message (web panel, Mac app, remote client).
// The file goes into the panel's attachments folder; its absolute path goes into the message text,
// which Claude Code reads (tested: a path to a PNG or PDF is read).
//
// Upload rules (POST /api/upload, also from a remote client through the remote listener or the relay):
//  - only the types Claude Code can read by path (ATTACH_EXT); a name without an extension is a
//    pasted image from the web panel and becomes .png
//  - at most MAX_BYTES; the file name is made here (time, random part, a cleaned short form of the
//    given name), so a name can never leave the folder or hold a space
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic)$/i;
// files Claude Code can read by path: images, PDFs, text, data and code (ONE list: ATTACH_EXT and PATH_RE)
const EXTS =
  'png|jpe?g|gif|webp|heic|pdf|txt|md|csv|tsv|json|ya?ml|xml|html?|log|ipynb|py|js|ts|swift|java|go|rs|c|cpp|h|rb|sh|sql';
export const ATTACH_EXT = new RegExp(String.raw`\.(${EXTS})$`, 'i');
/** The type an attached file is served with (GET /api/attachment), or null when it is not an attachment
 * type. Images and PDFs as they are; every other type (HTML, XML, code, text) as plain text, so a
 * browser never runs it. */
export function attachmentType(file: string): { mime: string } | null {
  if (!ATTACH_EXT.test(file)) return null;
  const ext = path.extname(file).slice(1).toLowerCase();
  if (IMAGE_EXT.test(file)) return { mime: 'image/' + ext.replace('jpg', 'jpeg') };
  if (ext === 'pdf') return { mime: 'application/pdf' };
  return { mime: 'text/plain; charset=utf-8' };
}

/** GET /api/attachment?path=: the file to send and its headers, or the error code. Only a file in
 * `dir` (also after links) of an attachment type. Every type but PDF gets a sandbox policy (Chrome
 * shows no PDF under one; a PDF runs no page script). */
export async function attachmentFile(
  requested: string,
  dir: string,
): Promise<{ code: 403 | 404 } | { real: string; headers: Record<string, string> }> {
  const p = path.resolve(requested);
  const type = attachmentType(p);
  if (!p.startsWith(dir + path.sep) || !type) return { code: 403 };
  let real: string, realDir: string;
  try {
    [real, realDir] = await Promise.all([fs.promises.realpath(p), fs.promises.realpath(dir)]);
  } catch {
    return { code: 404 };
  }
  if (!real.startsWith(realDir + path.sep)) return { code: 403 };
  const safe = type.mime === 'application/pdf' ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'" };
  return {
    real,
    headers: {
      'Content-Type': type.mime,
      'Cache-Control': 'max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      ...safe,
    },
  };
}
export const MAX_BYTES = 20 * 1024 * 1024;
// the JSON body of an upload: base64 of MAX_BYTES (4/3) plus the name and a margin. An encoder that
// writes "/" as "\/" (Apple's JSONSerialization without .withoutEscapingSlashes, as older remote client
// builds send) makes the base64 up to 1/64 longer, so that is allowed too.
export const MAX_UPLOAD_BODY = Math.ceil((((MAX_BYTES * 4) / 3) * 65) / 64) + 64 * 1024;

/** The file name for an upload called `name`, or an Error for a type that is not allowed. */
export function uploadFileName(
  name: string | null | undefined,
  now: number = Date.now(),
  rand: string = crypto.randomBytes(3).toString('hex'),
): string {
  const base = path.basename(name ?? '');
  const m = /\.([A-Za-z\d]{1,8})$/.exec(base);
  if (m && !ATTACH_EXT.test(base)) throw new Error(`Files of type .${(m[1] ?? '').toLowerCase()} cannot be attached`);
  const ext = m ? '.' + (m[1] ?? '').toLowerCase().replace('jpeg', 'jpg') : '.png';
  const stem = (m ? base.slice(0, -m[0].length) : base)
    .replaceAll(/[^\w.-]+/g, '-')
    .replaceAll(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  return `${String(now)}-${rand}${stem ? '-' + stem : ''}${ext}`;
}

export interface Upload {
  name?: string | null;
  data?: string | null;
}

export interface SavedUpload {
  path: string;
  name: string;
  bytes: number;
}

/** Writes an upload ({name, data: base64}) into `dir`. Returns { path, name, bytes }. */
export function saveUpload(dir: string, { name, data }: Upload = {}): SavedUpload {
  const file = uploadFileName(name);
  const b64 = data ?? '';
  if (b64.length > MAX_UPLOAD_BODY) throw new Error('The file is larger than 20 MB');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new Error('The file is empty');
  if (buf.length > MAX_BYTES) throw new Error('The file is larger than 20 MB');
  // only this account can read what the user attaches (photos, documents)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700); // a folder made before this rule
  const p = path.join(dir, file);
  fs.writeFileSync(p, buf, { flag: 'wx', mode: 0o600 });
  return { path: p, name: file, bytes: buf.length };
}

function isFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

export interface AttachmentOptions {
  onlyIn?: string;
}

/**
 * The attachment paths of a message, checked: absolute, an allowed type, no white space, the file
 * exists. With `onlyIn`, every path must be a file in that folder (a remote client sends only files it
 * uploaded). Throws when one path fails, so a message never goes out without a file the user chose.
 */
export function attachmentPaths(attachments: unknown, { onlyIn = '' }: AttachmentOptions = {}): string[] {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) return [];
  const list = attachments as unknown[];
  if (list.length > 20) throw new Error('At most 20 attachments');
  const root = onlyIn ? path.resolve(onlyIn) : '';
  return list.map((p) => {
    const ok =
      typeof p === 'string' &&
      path.isAbsolute(p) &&
      ATTACH_EXT.test(p) &&
      !/\s/.test(p) &&
      (!root || (path.resolve(p) === p && path.dirname(p) === root && isFile(p))) &&
      fs.existsSync(p);
    if (!ok) throw new Error('Attachment not found');
    return p;
  });
}

/** The message text with the attachment paths after it. */
export function withAttachments(
  text: string | null | undefined,
  attachments: unknown,
  opts?: AttachmentOptions,
): string {
  return [(text ?? '').trim(), ...attachmentPaths(attachments, opts)].filter(Boolean).join(' ');
}

export const PATH_RE = new RegExp(String.raw`(\/[^\s'"]+\.(?:${EXTS}))(?=\s|$)`, 'gi');
/** The router may write the task in its own words: the files of `original` stay on it. */
export function keepAttachments(original: unknown, task: string, dir?: string | null): string {
  const lost = (String(original).match(PATH_RE) ?? []).filter(
    (p) => ((dir ?? '') === '' || (path.resolve(p) === p && path.dirname(p) === dir)) && !task.includes(p),
  );
  return [task, ...new Set(lost)].join(' ');
}
