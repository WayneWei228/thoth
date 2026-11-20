// Brief: background for a NEW session, taken from other sessions' conversations.
// Used when the router starts a new session (for example because the matching session is busy
// with a long queue): the new session has no history, so the panel reads the recent dialogue of
// the related sessions and has one headless Claude call write what the new session must know.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { instance } from './instance.ts';
import { ne, truthy } from './truthy.ts';

// A session with this many messages waiting in the panel's delivery queue is busy:
// the router does not add more to it and starts a new session instead.
export const BUSY_QUEUE = Number(process.env['CC_BUSY_QUEUE']) || 2;

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

/** Text of one transcript message, or '' for tool calls, tool results and panel/system noise. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as (ContentBlock | null)[])
    .filter(
      (c): c is ContentBlock & { text: string } => c?.type === 'text' && typeof c.text === 'string' && c.text !== '',
    )
    .map((c) => c.text)
    .join('\n');
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface DialogueOptions {
  maxTurns?: number;
  maxChars?: number;
  totalChars?: number;
}

interface TranscriptLine {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown } | null;
  operation?: unknown;
}

/**
 * The user/assistant dialogue in a transcript (JSONL text), newest last.
 * Returns at most maxTurns entries, each cut to maxChars, the whole set cut to totalChars
 * (oldest dropped first).
 */
export function parseDialogue(
  jsonl: string | null | undefined,
  { maxTurns = 30, maxChars = 800, totalChars = 12_000 }: DialogueOptions = {},
): Turn[] {
  const out: Turn[] = [];
  for (const line of (jsonl ?? '').split('\n')) {
    let j: TranscriptLine | null;
    try {
      j = JSON.parse(line) as TranscriptLine | null;
    } catch {
      continue;
    }
    if (
      !j ||
      (j.type !== 'user' && j.type !== 'assistant') ||
      j.isMeta === true ||
      j.isSidechain === true ||
      !j.message
    )
      continue;
    let text = messageText(j.message.content).trim();
    // command wrappers, reminders and hook output start with a tag; they are not the dialogue
    if (!text || /^<[a-z-]+[ >]/i.test(text)) continue;
    text = text.replaceAll(/\s+/g, ' ');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
    out.push({ role: j.type, text });
  }
  let turns = out.slice(-maxTurns);
  while (turns.length > 1 && turns.reduce((a, t) => a + t.text.length, 0) > totalChars) turns = turns.slice(1);
  return turns;
}

/** The last `bytes` of a file as text ('' when it cannot be read). */
export function readTail(file: string, bytes: number = 2 * 1024 * 1024): string {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size,
      len = Math.min(size, bytes);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The recent dialogue of a session from its transcript file (reads the last 2 MB). */
export function readDialogue(file: string, opts?: DialogueOptions): Turn[] {
  return parseDialogue(readTail(file), opts);
}

/**
 * Messages waiting in Claude Code's OWN queue (typed into the session while Claude works).
 * Claude Code writes {"type":"queue-operation","operation":"enqueue"|"dequeue"|"remove"} lines.
 * Only meaningful while the session works: an idle Claude has taken every queued message.
 */
export function claudeQueue(jsonl: string | null | undefined): number {
  let n = 0;
  for (const line of (jsonl ?? '').split('\n')) {
    if (!line.includes('"queue-operation"')) continue;
    let j: TranscriptLine | null;
    try {
      j = JSON.parse(line) as TranscriptLine | null;
    } catch {
      continue;
    }
    if (j?.type !== 'queue-operation') continue;
    if (j.operation === 'enqueue') n++;
    else if (j.operation === 'dequeue' || j.operation === 'remove') n = Math.max(0, n - 1);
  }
  return n;
}

/** The language to write the brief in: the request's, not the conversations' (eval: english-request). */
export function requestLanguage(text: string): 'Chinese' | 'English' {
  return /[\u4E00-\u9FFF]/.test(text) ? 'Chinese' : 'English';
}

export interface BriefSource {
  name: string;
  folder: string;
  queued?: number;
  dialogue: Turn[];
}

/** text: the user's request; sources: the related sessions and their recent dialogue. */
export function buildBriefPrompt(text: string, sources: BriefSource[]): string {
  const blocks = sources
    .map(
      (s) =>
        `<session name=${JSON.stringify(s.name)} folder=${JSON.stringify(s.folder)}>\n` +
        s.dialogue.map((t) => `${t.role === 'user' ? 'USER' : 'CLAUDE'}: ${t.text}`).join('\n') +
        '\n</session>',
    )
    .join('\n\n');
  return `A user's request goes to a NEW Claude Code session. It has no history. Below are the recent conversations of the user's other sessions.

${blocks}

<request>
${text}
</request>

Write the background the new session needs to do this request well: the goal, facts, decisions the user made, file paths, commands, the current state, and open problems. Take only what is relevant to the request, from the conversations above. Do not invent anything. Do not answer or plan the request.
State only what the conversations show. Do not claim that something was NOT done or does not exist; you only see part of each conversation (write "the conversation does not say" instead).
Use short sentences, at most about 200 words. Write in ${requestLanguage(text)}, the language of the request, even when the conversations use another language.
If nothing in the conversations is relevant to the request, reply exactly: NONE`;
}

export interface RunOptions {
  model?: string;
  cwd?: string;
}

/** One headless Claude call -> the brief text, or '' when nothing is relevant or the call fails. */
export function runBrief(text: string, sources: BriefSource[], { model, cwd }: RunOptions = {}): Promise<string> {
  const usable = sources.filter((s) => s.dialogue.length > 0);
  if (usable.length === 0) return Promise.resolve('');
  return new Promise((resolve) => {
    const args = [
      '-p',
      buildBriefPrompt(text, usable),
      '--model',
      (model ?? '') || (process.env['CC_BRIEF_MODEL'] ?? '') || 'sonnet',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({ mcpServers: {} }),
      '--disallowedTools',
      'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite,Agent',
    ];
    const dir = (cwd ?? '') || path.join(instance().home, 'router');
    fs.mkdirSync(dir, { recursive: true });
    execFile('claude', args, { cwd: dir, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (_err, out) => {
      let r: string;
      try {
        const result = (JSON.parse(out) as { result?: unknown } | null)?.result;
        r = (truthy(result) ? String(result) : '').trim();
      } catch {
        r = '';
      }
      resolve(!r || /^NONE\.?$/i.test(r) ? '' : r);
    });
  });
}

/** The message the new session gets: the background first, then the request. */
export function withBrief(text: string, brief: string | null | undefined, names: string[]): string {
  if (!ne(brief)) return text;
  return `[Background from the session${names.length > 1 ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')}, prepared by Thoth] ${brief}\n\n[Request] ${text}`;
}
