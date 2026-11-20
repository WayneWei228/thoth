// A Claude Code conversation that goes on in a new transcript file.
//
// When a session moves to the background (the /background command or the left arrow), Claude Code
// forks it into a new session id and ends the old transcript with
//   {"type":"continued-in","sessionId":"<old>","continuedInSessionId":"<new>"}
// The process in the panel's pane keeps the old id in its ~/.claude/sessions record, so the panel
// read the old file: its last reply, title, chat and the restore record (owner report, 2026-11-19:
// "pr72-web-ui" showed "Needs you" for a question from the old file). The panel follows the record.
import fs from 'node:fs';
import path from 'node:path';

const SID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const TAIL = 64 * 1024;
const LIMIT = 10;

/** The new session id when the transcript text (its tail) ends with a "continued-in" record, else ''.
 * Bookkeeping lines after the record do not count; a message after it means the file goes on. */
export function continuedIn(tail: string): string {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let j: { type?: unknown; continuedInSessionId?: unknown };
    try {
      j = JSON.parse(lines[i] ?? '') as typeof j;
    } catch {
      continue;
    }
    if (j.type === 'user' || j.type === 'assistant') return '';
    if (j.type === 'continued-in')
      return typeof j.continuedInSessionId === 'string' && SID.test(j.continuedInSessionId)
        ? j.continuedInSessionId
        : '';
  }
  return '';
}

const cache = new Map<string, { mtime: number; size: number; next: string }>();

function nextOf(file: string): string {
  let next = '';
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return '';
    const c = cache.get(file);
    if (c?.mtime === st.mtimeMs && c.size === st.size) return c.next;
    const len = Math.min(st.size, TAIL);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, st.size - len);
    } finally {
      fs.closeSync(fd);
    }
    next = continuedIn(buf.toString('utf8'));
    cache.set(file, { mtime: st.mtimeMs, size: st.size, next });
  } catch {
    cache.delete(file); // removed or unreadable: nothing to follow
  }
  return next;
}

/** The id of the newest transcript of a conversation: follows "continued-in" records from `sid` in
 * `dir` (its ~/.claude/projects folder) while the next file exists, at most `limit` steps. */
export function newestSid(dir: string, sid: string, limit: number = LIMIT): string {
  let cur = sid;
  for (let i = 0; i < limit && SID.test(cur); i++) {
    const next = nextOf(path.join(dir, cur + '.jsonl'));
    if (!next || next === cur || !fs.existsSync(path.join(dir, next + '.jsonl'))) break;
    cur = next;
  }
  return cur;
}

/** A hook record of `recSid` belongs to the window's conversation `sid`: the same id, or an id that
 * conversation was continued from (the pane's process still reports the old id). */
export function sameConversation(dir: string, recSid: string, sid: string): boolean {
  return recSid === sid || newestSid(dir, recSid) === sid;
}
