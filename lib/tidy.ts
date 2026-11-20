// AI tidy: suggests which panel sessions to close (user request, 2026-11-15).
// One headless Claude call sorts the sessions into ongoing work (keep) and one-off tasks that
// are done (close). The app shows the suggestion in select mode with the "close" ones ticked;
// the user confirms with "Close N". Nothing is closed here.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { instance } from './instance.ts';
import { truthy } from './truthy.ts';

export const TIDY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          close: { type: 'boolean' },
          reason: { type: 'string', description: "at most 12 words, in the user's language (one language for all)" },
        },
        required: ['id', 'close', 'reason'],
      },
    },
  },
  required: ['sessions'],
});

export interface TidySession {
  id: string;
  name?: string;
  agent?: string;
  folder?: string;
  title?: string | null;
  state?: string;
  activity?: number | null;
  prompt?: string | null;
  last?: string | null;
}

function hoursAgo(ms: number | null | undefined, now: number): number | null {
  return ms !== null && ms !== undefined && ms !== 0 && !Number.isNaN(ms) ? Math.round((now - ms) / 3_600_000) : null;
}

export function buildPrompt(sessions: TidySession[], now: number = Date.now()): string {
  const list = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    agent: s.agent === 'codex' ? 'codex' : 'claude',
    folder: s.folder,
    title: s.title ?? '',
    state: s.state,
    hours_since_last_message: hoursAgo(s.activity, now),
    last_user_request: (s.prompt ?? '').slice(0, 300),
    last_reply: (s.last ?? '').slice(0, 300),
  }));
  return `You help a user tidy their coding-agent sessions. Each session is one conversation in one folder.
Decide for each session: keep it open, or close it. Closing stops the process; the conversation is
saved and can be resumed later, so closing is safe.

Keep:
- ongoing project work: a session that belongs to a project the user keeps working on (an app, a
  website, a course with more assignments), or a task that is not finished (it stopped in the middle,
  ended with an error, or waits for the user's answer).
- a session used in the last few hours, unless its task is clearly done.
Close:
- one-off tasks that are done: a question that got its answer, research whose report was delivered,
  a fix or a check that is finished, a session that only started and was never used.
- sessions not used for several days whose last exchange shows the task finished.

Give every session in the list exactly once. The reason is a short phrase (at most 12 words).
Write ALL reasons in ONE language: the user's language, the one the user writes most in the
last_user_request fields (not the language of each session's replies or files). For a user who
writes Chinese: "调研已交付 PDF"; for a user who writes English: "ongoing website work".

Sessions:
${JSON.stringify(list, null, 1)}`;
}

/** Sessions the AI must not close: working, waiting for the user, or the caller's own window. */
export function protectedIds(sessions: TidySession[], keepIds: string[] = []): Set<string> {
  return new Set([
    ...keepIds,
    ...sessions.filter((s) => s.state === 'working' || s.state === 'needs').map((s) => s.id),
  ]);
}

export interface TidyDecision {
  id: string;
  close: boolean;
  reason: string;
}

interface RawDecision {
  id?: unknown;
  close?: unknown;
  reason?: unknown;
}

/** The model's answer -> one decision per known session (missing ones are kept). */
export function normalize(answer: unknown, sessions: TidySession[], keepIds: string[] = []): TidyDecision[] {
  const known = new Map(sessions.map((s) => [s.id, s]));
  const prot = protectedIds(sessions, keepIds);
  const got = new Map<string, TidyDecision>();
  const list = (answer as { sessions?: unknown } | null | undefined)?.sessions;
  for (const d of Array.isArray(list) ? (list as (RawDecision | null)[]) : []) {
    if (d && typeof d.id === 'string' && known.has(d.id) && !got.has(d.id)) {
      const reason = truthy(d.reason) ? String(d.reason) : '';
      got.set(d.id, { id: d.id, close: Boolean(d.close), reason: reason.slice(0, 80) });
    }
  }
  return sessions.map((s) => {
    const d = got.get(s.id) ?? { id: s.id, close: false, reason: '' };
    if (prot.has(s.id))
      return { ...d, close: false, reason: d.reason || (s.state === 'working' ? 'working' : 'in use') };
    return d;
  });
}

/** The answer in the output of `claude -p --output-format json`: structured_output, else the result
 * text (a ```json fence is stripped). null when there is no usable answer. */
export function parseAnswer(out: string): object | null {
  let j: unknown;
  try {
    j = JSON.parse(out);
  } catch {
    return null;
  }
  if (j === null || typeof j !== 'object') return null;
  const o = j as { structured_output?: unknown; result?: unknown };
  if (o.structured_output !== null && typeof o.structured_output === 'object') return o.structured_output;
  if (typeof o.result !== 'string') return null;
  try {
    const v: unknown = JSON.parse(
      o.result
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, ''),
    );
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export interface TidyOptions {
  model?: string;
  cwd?: string;
}

export function runTidy(sessions: TidySession[], { model, cwd }: TidyOptions = {}): Promise<object> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      buildPrompt(sessions),
      '--model',
      (model ?? '') || (process.env['CC_TIDY_MODEL'] ?? '') || 'sonnet',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--json-schema',
      TIDY_SCHEMA,
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({ mcpServers: {} }),
      '--disallowedTools',
      'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite,Agent',
    ];
    const dir = (cwd ?? '') || path.join(instance().home, 'router');
    fs.mkdirSync(dir, { recursive: true });
    execFile('claude', args, { cwd: dir, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err && !out) {
        reject(new Error('Tidy failed: ' + (err.message.split('\n')[0] ?? '')));
        return;
      }
      const answer = parseAnswer(out);
      if (answer) resolve(answer);
      else reject(new Error('Tidy gave no answer'));
    });
  });
}
