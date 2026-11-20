import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SETTLE_MS } from './hookstate.ts';
import { parseAnswer } from './tidy.ts';

// Does a session wait for the owner's answer? When Claude ends its turn with a question in plain
// text (not a menu), Claude Code sends Stop and the hook state is 'idle' (lib/hookstate.ts). The
// panel then reads the last reply of the turn (finalText) and takes its last two paragraphs (tailOf).
// A sentence there that ends with ? or ？ is the question at once (markedQuestion); without one, a
// small model decides in the background, once per reply (AsksJudge). Tested in a test

const MAX = 200;
/** at most this much of a reply goes to the model (cost; the command line has a size limit) */
const TAIL_MAX = 4000;

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

/** The sentences of one line: up to and with . ! ? 。 ！ ？ (a run of them), plus the rest. */
const sentences = (line: string): string[] =>
  (line.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);

const cut = (s: string): string => (s.length > MAX ? s.slice(0, MAX - 1) + '…' : s);

/**
 * The part of a reply that can ask the owner something: its last two paragraphs (a question higher
 * up was answered by the reply itself), without code (fenced or inline), quotes, links and bold
 * marks; list markers removed. One line per line of the reply. '' when nothing is left.
 */
export function tailOf(reply: string): string {
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
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .join('\n');
  return tail.length > TAIL_MAX ? tail.slice(-TAIL_MAX) : tail;
}

/** The last sentence of a tail that ends with ? or ？ (at most 200 characters), or ''. This is the
 * instant answer: a reply with a question mark needs no model call. */
function markedQuestion(tail: string): string {
  return cut(
    tail
      .split('\n')
      .flatMap(sentences)
      .findLast((s) => /[?？]$/.test(s)) ?? '',
  );
}

/** The question a reply asks the owner by its question mark, or '' (no model; see AsksJudge). */
export const questionOf = (reply: string): string => markedQuestion(tailOf(reply));

// ---------- the model decides when there is no question mark ----------

const ASKS_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    waits: { type: 'boolean', description: "true when the text waits for the owner's answer before the work goes on" },
    question: {
      type: 'string',
      description: 'when waits is true: the sentence that asks, copied word for word from the text; else ""',
    },
  },
  required: ['waits', 'question'],
});

/** The prompt for one tail: does it wait for the owner's answer? */
export function asksPrompt(tail: string): string {
  return `A coding agent ended its turn with the text below (the last part of its reply to its owner).
Decide: does the text wait for the owner's answer or decision before the agent goes on? It waits when it
asks the owner something (a question, an offer to do more, a request to confirm, choose or approve), or
says the next step happens only after the owner confirms or approves. Any language, also without a
question mark. It does not wait when it only reports, or tells the owner
what to do later without asking now ("tell me when you have tested it").
When it waits, give the sentence that asks, copied word for word from the text.

Text:
${tail}`;
}

/** The model's answer -> the question ('' = it does not wait), or null when the answer is not usable.
 * The question shown must be text of the tail (spaces ignored): a "waits" answer whose question is
 * empty or not in the tail shows the tail's last line, so the session still waits with its own words. */
export function parseAsks(answer: unknown, tail = ''): string | null {
  if (answer === null || typeof answer !== 'object') return null;
  const a = answer as { waits?: unknown; question?: unknown };
  if (typeof a.waits !== 'boolean') return null;
  if (!a.waits) return '';
  const flat = (t: string): string => t.replaceAll(/\s+/g, ' ').trim();
  const q = typeof a.question === 'string' ? flat(a.question) : '';
  const own = q !== '' && flat(tail).includes(q);
  return cut((own ? q : (tail.split('\n').at(-1) ?? '')) || '…');
}

/** One model call: the prompt -> the parsed JSON answer (rejects on failure). */
export type AsksModel = (prompt: string) => Promise<unknown>;

export interface AsksJudgeOptions {
  /** where answers are kept between server runs (JSON: tail hash -> question); none = memory only */
  file?: string;
  /** model calls at the same time (more wait in a queue) */
  parallel?: number;
  /** called when an answer arrives (the server polls again so the session shows it) */
  onAnswer?: () => void;
  /** answers kept (the oldest go first) */
  keep?: number;
  /** after a failed call, the same reply can be asked again after this long */
  retryMs?: number;
}

const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * Decides, once per reply, whether a reply waits for the owner. A question mark in the tail answers at
 * once. Otherwise the model decides in the background: of() returns '' (no question known) at once and
 * starts the call; when the answer arrives it is kept (memory and file) and onAnswer runs, so the next
 * of() for the same reply returns it. After a failed call the reply shows '' and can be asked once more
 * after retryMs.
 */
export class AsksJudge {
  private readonly answers = new Map<string, string>();
  private readonly started = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly queue: { key: string; tail: string }[] = [];
  private running = 0;
  private readonly model: AsksModel;
  private readonly opts: AsksJudgeOptions;

  constructor(model: AsksModel, opts: AsksJudgeOptions = {}) {
    this.model = model;
    this.opts = opts;
    if ((opts.file ?? '') === '') return;
    try {
      const saved = JSON.parse(fs.readFileSync(opts.file ?? '', 'utf8')) as unknown;
      if (saved !== null && typeof saved === 'object')
        for (const [k, v] of Object.entries(saved)) if (typeof v === 'string') this.answers.set(k, v);
    } catch {
      // no file yet, or a broken one: start empty
    }
  }

  /** The question `reply` (the text that ended the turn, finalText) asks, or '' (none, or not known yet). */
  of(reply: string): string {
    const tail = tailOf(reply);
    if (!tail) return '';
    const marked = markedQuestion(tail);
    if (marked) return marked;
    const key = hash(tail);
    const known = this.answers.get(key);
    if (known !== undefined) return known;
    if (!this.started.has(key)) {
      this.started.add(key);
      this.queue.push({ key, tail });
      this.next();
    }
    return '';
  }

  /** Model calls not finished yet (running or queued). */
  get pending(): number {
    return this.running + this.queue.length;
  }

  private next(): void {
    while (this.running < (this.opts.parallel ?? 2)) {
      const job = this.queue.shift();
      if (!job) return;
      this.running++;
      this.model(asksPrompt(job.tail))
        .then(
          (a) => parseAsks(a, job.tail),
          () => null,
        )
        .then((q) => {
          this.running--;
          if (q === null) this.retryLater(job.key);
          else this.keep(job.key, q);
          this.next();
          this.opts.onAnswer?.();
        })
        .catch(() => undefined);
    }
  }

  /** A failed call (a timeout, a rate limit): no answer is kept, the reply can be asked once more later. */
  private retryLater(key: string): void {
    if (this.failed.has(key)) {
      this.answers.set(key, ''); // failed twice: no question for this reply in this server run
      return;
    }
    this.failed.add(key);
    setTimeout(() => {
      this.started.delete(key);
    }, this.opts.retryMs ?? 60_000).unref();
  }

  private keep(key: string, q: string): void {
    this.answers.set(key, q);
    const file = this.opts.file ?? '';
    if (file === '') return;
    const max = this.opts.keep ?? 1000;
    for (const k of this.answers.keys()) {
      if (this.answers.size <= max) break;
      this.answers.delete(k);
      this.started.delete(k); // asked again if a session still shows that reply
    }
    try {
      // replies can be private: owner-only, written whole (a temp file, then rename)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${String(process.pid)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.answers)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // the answer stays in memory
    }
  }
}

/** The real model: the smallest, fastest Claude (haiku) through `claude -p`, no tools, no MCP servers,
 * a JSON schema answer. CC_ASKS_MODEL overrides the model. */
export function claudeAsks(cwd: string): AsksModel {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const args = [
        '-p',
        prompt,
        '--model',
        (process.env['CC_ASKS_MODEL'] ?? '') || 'haiku',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--json-schema',
        ASKS_SCHEMA,
        '--strict-mcp-config',
        '--mcp-config',
        JSON.stringify({ mcpServers: {} }),
        '--tools',
        '',
      ];
      fs.mkdirSync(cwd, { recursive: true });
      execFile('claude', args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, out) => {
        const answer = parseAnswer(out);
        if (answer) resolve(answer);
        else reject(new Error('asks: no answer' + (err ? ': ' + (err.message.split('\n')[0] ?? '') : '')));
      });
    });
}
