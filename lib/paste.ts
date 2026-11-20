// How the panel puts a message into an agent's input box: typed keys or one bracketed paste.
// Claude Code reads a burst of typed keys in pieces of about 1 KB; when a gap falls between two
// pieces, the later piece replaces the first, and Claude gets only the end of the message (probe
// with Claude Code 2.1.328, 2026-11-19: 1.6 KB typed lost the head in 3–5 of 10 runs, 1.05 KB in
// 4 of 10, 700 B in 0 of 10; pasted, 0 of 30). Codex took 1.6 KB and 5 KB typed whole (15 of 15).
import * as Commands from './commands.ts';

/** A Claude message longer than this (UTF-8 bytes) is pasted. */
export const PASTE_OVER = 512;

/**
 * 'paste' or 'type' for a message. A slash command is always typed: a long pasted command shows
 * as "[Pasted text #1]" and Claude gets it as text, not as a command (probe, 2026-11-19). Known
 * limit: a command with about 1 KB or more of arguments can still lose its head when typed.
 */
export function inputMethod(text: string, agent: 'claude' | 'codex'): 'paste' | 'type' {
  if (agent === 'codex' || Commands.parse(text) !== null) return 'type';
  return Buffer.byteLength(text, 'utf8') > PASTE_OVER ? 'paste' : 'type';
}

// a long paste shows as a placeholder: Claude "[Pasted text #1 +3 lines]", Codex "[Pasted Content 1669 chars]"
const PLACEHOLDER = /^\[Pasted (?:text #\d+|Content \d+ chars)/;

/** Is `text` (what the panel typed) still in the input box, which shows `box`? */
export function stillInBox(box: string, text: string): boolean {
  if (PLACEHOLDER.test(box) && Buffer.byteLength(text, 'utf8') > PASTE_OVER) return true;
  return text.startsWith(box.slice(0, 20)) || box.includes(text.slice(0, 20));
}

/** The text for a paste: no control characters except tab (an ESC[201~ would end the paste early). */
export function forPaste(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/[\u0000-\u0008\u000A-\u001F\u007F]/g, '');
}
