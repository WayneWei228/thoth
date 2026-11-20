import { SETTLE_MS } from './hookstate.ts';

// Does a session wait for the owner's answer? When Claude ends its turn with a question in plain
// text (not a menu), Claude Code sends Stop and the hook state is 'idle' (lib/hookstate.ts). The
// panel then reads the last reply of the turn (finalText) and looks for a question in its last two
// paragraphs (questionOf). Pure functions, tested in a test with real replies.

const MAX = 200;

/** What an idle session waits for from the owner (server.ts Session.waits). */
export interface Waits {
  kind: 'question' | 'draft';
  text: string;
}

/** What the server last saw in a session's input box: the plain text, its draft (draftText in
 * lib/screen.ts, '' = none), since when the box shows that draft, and when it was last captured. */
export interface BoxSeen {
  box: string;
  draft: string;
  at: number;
  checked: number;
}

/**
 * Whether the input box must be captured again with its escape codes (the second, costly capture).
 * Yes when its plain text changed. A box whose text stayed but held no draft is checked again every
 * SETTLE_MS: a prompt suggestion accepted with Tab keeps its text and only loses the dim attribute.
 */
export function needsCapture(seen: BoxSeen | undefined, box: string, now: number): boolean {
  if (!box) return false;
  if (seen?.box !== box) return true;
  return seen.draft === '' && now - seen.checked >= SETTLE_MS;
}

/** The new BoxSeen after a poll: `draft` is draftText() of a new capture, or null without one. */
export function seeBox(seen: BoxSeen | undefined, box: string, draft: string | null, now: number): BoxSeen {
  if (draft === null) return seen?.box === box ? seen : { box, draft: '', at: now, checked: now };
  const same = seen?.box === box && seen.draft === draft;
  return { box, draft, at: same ? seen.at : now, checked: now };
}

/**
 * What an idle session waits for: unsent text in its input box first (a brief whose Enter was lost;
 * text the owner typed), once it has stayed SETTLE_MS (text the panel is typing must not flash); else
 * the question its last reply asks; else null.
 */
export function waitsFrom(seen: BoxSeen | undefined, asks: string, now: number): Waits | null {
  if (seen && seen.draft !== '' && now - seen.at >= SETTLE_MS) return { kind: 'draft', text: seen.draft.slice(0, 300) };
  return asks === '' ? null : { kind: 'question', text: asks };
}

/** The delivery queue types nothing into a session with unsent text: typing clears the input box
 * first (Ctrl-U), and the owner's text would be lost. The message waits until the box is empty. */
export const holdsDraft = (s: { waits?: Waits }): boolean => s.waits?.kind === 'draft';

/**
 * The text of the newest message in a Claude Code transcript (.jsonl lines, oldest first) when that
 * message is an assistant text: the reply that ended the turn, newlines kept. '' when the newest
 * message is the user's (a new prompt, an interrupt) or a tool call.
 */
export function finalText(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    let j: { type?: unknown; message?: { content?: unknown } };
    try {
      j = JSON.parse(lines[i] ?? '') as typeof j;
    } catch {
      continue;
    }
    if (j.type === 'user') return '';
    if (j.type !== 'assistant') continue; // bookkeeping lines (system, last-prompt, ai-title, …)
    const content = j.message?.content;
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    const parts = content as ({ type?: unknown; text?: unknown } | null)[];
    if (parts.some((p) => p?.type === 'tool_use')) return '';
    return parts
      .map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .join('\n')
      .trim();
  }
  return '';
}

// A sentence that asks without a question mark: it opens like a question, or says it waits.
const OPENS = /^(?:should|shall|can|may) i\b|^(?:do|would) you (?:want|like)\b|^want me to\b/i;
const WAITS =
  /waiting for your (?:answers?|decision|reply|confirmation|input|go-ahead)|要我[^吗。！？\n]{0,60}吗|(?:^|[，,])\s*要不要|需要你(?:确认|决定|回答|选择)|等你的?(?:回答|确认|决定|选择|答复|批准)|(?:可以|好|行)吗/i;

/** The sentences of one line: up to and with . ! ? 。 ！ ？ (a run of them), plus the rest. */
const sentences = (line: string): string[] =>
  (line.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);

/**
 * The question a reply asks the owner, or ''. Only the last two paragraphs count: a question higher
 * up was answered by the reply itself. Code (fenced or inline), quotes and links do not count. The
 * last sentence that ends with ? or ？ wins; without one, the first sentence that asks in words
 * ("Should I …", "要我…吗", "需要你确认…", "I'm waiting for your answers …"). At most 200 characters.
 */
export function questionOf(reply: string): string {
  const text = reply
    .replaceAll(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, '')
    .replaceAll(/`[^`\n]*`/g, '')
    .replaceAll(/^\s*>.*$/gm, '')
    .replaceAll(/\b[a-z][\w+.-]*:\/\/\S+/gi, '')
    .replaceAll(/\*\*|__/g, '');
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const tail = paragraphs
    .slice(-2)
    .flatMap((p) => p.split('\n'))
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
    .flatMap(sentences);
  const asked = tail.findLast((s) => /[?？]$/.test(s)) ?? tail.find((s) => OPENS.test(s) || WAITS.test(s)) ?? '';
  return asked.length > MAX ? asked.slice(0, MAX - 1) + '…' : asked;
}
