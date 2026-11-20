// Router: picks the session for a request (send / new / ask / handoff).
// Pure prompt building + one headless Claude call, so the eval set
// can run it against a fixed, fake panel.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { BUSY_QUEUE } from './brief.ts';
import { instance } from './instance.ts';
import { ne } from './truthy.ts';

// The fields of one routing decision. A request with several separate jobs gets one decision
// per job in "tasks" (lib/router.ts splitTasks); a request with one job uses the top level, as before.
const DECISION_PROPS = {
  action: { enum: ['send', 'new', 'ask', 'handoff'] },
  target: { type: 'string', description: 'session id for send, e.g. @3' },
  device: { type: 'string', description: 'for handoff: the device the session is on (from the brain)' },
  sid: { type: 'string', description: 'for handoff: the session id from the brain (full or first 8 characters)' },
  folder: {
    type: 'string',
    description:
      'absolute folder path: for new, where the session starts; for ask, the project folder the request most likely belongs to',
  },
  name: { type: 'string', description: 'short name (1-2 words) for a new session' },
  confidence: { type: 'number' },
  reason: {
    type: 'string',
    description: 'one short sentence in the same language as the request; name the session by name',
  },
  alternatives: { type: 'array', items: { type: 'string' }, description: 'other plausible session ids' },
  context_from: {
    type: 'array',
    items: { type: 'string' },
    description:
      'for new: ids of sessions whose conversation holds background the new session needs (up to 3, may be empty)',
  },
  agent: {
    enum: ['claude', 'codex'],
    description: 'for new: which coding agent runs the new session (claude = Claude Code, codex = OpenAI Codex)',
  },
  task: {
    type: 'string',
    description:
      'for send/new: the request as the session should get it, when the request has words that only choose the agent or session (e.g. "用 codex", "ask Claude to"); same language and meaning, those words removed. Empty when there is nothing to remove.',
  },
};
export const MAX_TASKS = 5;
export const ROUTER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    ...DECISION_PROPS,
    tasks: {
      type: 'array',
      maxItems: MAX_TASKS,
      description:
        'only when the request holds 2 or more separate jobs: one routing decision per job, each with its own "task" text. Empty for one job.',
      items: { type: 'object', properties: DECISION_PROPS, required: ['action', 'confidence', 'reason', 'task'] },
    },
  },
  required: ['action', 'confidence', 'reason'],
});

export interface RouterSession {
  id: string;
  name?: string;
  agent?: string;
  folder?: string;
  title?: string | null;
  state?: string;
  prompt?: string | null;
  last?: string | null;
  topics?: string[] | null;
  queued?: number | null;
}

export interface PromptOptions {
  /** the router has the read-only brain tools */
  brain?: boolean;
  localDevice?: string;
  /** where new work goes when no session or project folder fits */
  defaultFolder?: string;
  codexOk?: boolean;
}

/**
 * text: the request; sessions: [{id,name,folder,title,state,prompt,last,topics:[]}];
 * folders: known project folders.
 */
export function buildPrompt(
  text: string,
  sessions: RouterSession[],
  folders: string[],
  { brain = false, localDevice = '', defaultFolder = '', codexOk = true }: PromptOptions = {},
): string {
  const handoffRule = brain
    ? `
- "handoff": the request is about work in a session on ANOTHER device (or a session not listed above) and the
  user wants it continued here. Find that session with the brain tools (brain_search with a few short keyword tries,
  in Chinese and English; brain_list_devices; brain_get_session), then give its device and sid. The panel runs on
  the device "${localDevice || 'this Mac'}"; never hand off a session that is already on this device.`
    : '';
  const sess = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    agent: s.agent === 'codex' ? 'codex' : 'claude',
    folder: s.folder,
    title: s.title,
    state: s.state,
    last_user_request: (s.prompt ?? '').slice(0, 200),
    last_reply: (s.last ?? '').slice(0, 200),
    recent_topics_in_folder: (s.topics ?? []).slice(0, 5),
    queued_messages: s.queued ?? 0,
  }));
  return `You route a user's request to one of their coding-agent sessions. A session runs Claude Code (agent "claude") or OpenAI Codex (agent "codex"). Each session works in one project folder and has its own conversation.

Sessions:
${JSON.stringify(sess, null, 1)}

Known project folders (for a new session):
${JSON.stringify(folders.slice(0, 20))}

<request>
${text}
</request>

Rules:
- "send": the request continues or clearly belongs to one session's project or topic. Prefer the session whose title or last request matches the topic, not just the folder. A request that names something in a session's recent_topics_in_folder (for example a page, tool or feature) is a clear match for that session, like a title match.
- "new": no session fits, but one known folder clearly does (or the request starts a new, unrelated task in a folder). Give folder and a short name.${
    defaultFolder
      ? `
- A new, self-contained task that fits no session and no project folder (for example a computer-wide setup or config job, or a new topic) is "new" in the default folder ${defaultFolder} with a short name, confidence >= 0.8; its reason names the task and says it starts in the default folder (in Chinese: "默认文件夹"). Do not "ask" just because no folder fits.`
      : ''
  }
- "ask": unclear. Put the best guesses in alternatives. Also give "folder": the project folder the request most likely belongs to (the folder of your best-guess session, or a known project folder${brain ? '; use the brain tools to find the project when the sessions here do not show it' : ''}). The panel starts a new session there. Leave "folder" empty only when no project fits at all.${defaultFolder ? ' Use "ask" only when the request seems to continue existing work but it is unclear which session, or when it is not a task at all (for example a greeting).' : ''}
- If the request names a project, app or folder explicitly (for example "pixelshop", "Claude Panel", "study-notes"), that is a clear match (confidence >= 0.8): "send" to that project's session when the topic is related to it, otherwise "new" in that folder.
- A session with state "elsewhere" cannot receive messages; pick it only if nothing else fits, and then use "ask".
- A session that is "stopped" can still receive the request (it starts first).
- A session is busy when its state is "working" (it is still doing another job) or it has queued_messages >= ${String(BUSY_QUEUE)}. Never "send" to a busy session, even when it matches; the request must not wait for it. Use "new" in that session's folder with a short name, put that session's id FIRST in context_from (plus up to 2 other sessions whose conversation holds background this request needs), and use that session's agent (a busy Codex session gets a new Codex session) unless the request asks for the other agent. Keep confidence as high as the match is clear. The reason says the session is busy (still working, in Chinese "还在工作") and a new session gets its background, in the language of the request.
- For every "new": put in context_from the ids of up to 3 sessions whose conversation holds background the new session needs for this request (the project, decisions, files). Leave it empty when no session is related.${handoffRule}
- confidence: 0.0-1.0. Use >= 0.75 only when the match is clear. If your confidence is below 0.75, the action MUST be "ask" (put your best guess first in alternatives).
- agent: the user can ask for Codex ("用 codex", "让 codex 做", "ask Codex", "with codex") or for Claude. When the request asks for one agent, "send" only to a session of that agent; if none fits, "new" with that agent. For "new", set agent to "codex" only when the request asks for Codex${codexOk ? '' : ' (Codex is not installed on this computer: never choose it)'}; otherwise "claude".
- task: when the request says which agent or session should do it ("用 codex 在 X 里新建 a.txt"), give the request without those words ("在 X 里新建 a.txt"), so the session does not read them as part of the task. Otherwise leave task empty.
- tasks (several jobs): when the request holds 2 or more SEPARATE jobs (different goals that can be done on their own, for example "fix the login bug in pixelshop, also write a CSV export for yanba, and look up flights to Tokyo"), split it: one item in "tasks" per job, at most ${String(MAX_TASKS)}. Each item is a full routing decision for that job alone, with these same rules (action, target, folder, name, agent, context_from, confidence, reason) and "task" = the text of that job only, taken from the request's own words: the SAME language as the request (an English request gives English task text; never translate), plus what the job needs from the rest of the request (shared words like the project name or "do not use tools"). Find the relevant sessions${brain ? ' and brain results' : ''} for EACH job on its own${brain ? ' (brain_search per job when the sessions here do not show its project)' : ''}. Prefer "new" for a job that fits no session; never "send" two tasks to the same session (give the second one a "new" session in that folder with the first in context_from). Fill the top-level fields too: action and target of the first task, and a reason that says in one sentence into how many tasks the request was split.
- One job stays one job: steps of the same job ("build X and test it", "fix the bug and then deploy", "do A, then B with A's result"), or one job with details, is NOT split; leave "tasks" empty and use the top-level fields as usual.
- Do not answer the request. Only route it.

The "reason" field: ONE short sentence, written in the same language as the request (Chinese request → Chinese reason), naming the session by its name (not its id) or the folder, and the topic that decided it.
Example for a Chinese request: "这是 pixelshop 内测方案的后续问题，交给 pixelshop。"
For "ask", the reason says in one sentence what is unclear, for example: "3B 最相关，但它还开在别的窗口，需要你确认。"`;
}

export interface RouterOptions {
  model?: string;
  /** path of brain/mcp_server.py; when set the router gets the read-only brain tools
   * (to find sessions on other devices) and may answer "handoff". */
  brainMcp?: string | null;
  localDevice?: string;
  defaultFolder?: string;
  codexOk?: boolean;
}

export function runRouter(
  text: string,
  sessions: RouterSession[],
  folders: string[],
  { model, brainMcp = null, localDevice = '', defaultFolder = '', codexOk = true }: RouterOptions = {},
): Promise<Decision> {
  return new Promise((resolve, reject) => {
    // sonnet by default (the user's choice when the brain tools were added); CC_ROUTER_MODEL overrides
    const args = [
      '-p',
      buildPrompt(text, sessions, folders, { brain: Boolean(brainMcp), localDevice, defaultFolder, codexOk }),
      '--model',
      (model ?? '') || (process.env['CC_ROUTER_MODEL'] ?? '') || 'sonnet',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--json-schema',
      ROUTER_SCHEMA,
      '--strict-mcp-config',
      '--disallowedTools',
      'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite,Agent',
    ];
    if (ne(brainMcp)) {
      args.push(
        '--mcp-config',
        JSON.stringify({ mcpServers: { brain: { command: 'python3', args: ['-I', brainMcp] } } }),
        '--allowedTools',
        'mcp__brain__brain_search,mcp__brain__brain_list_devices,mcp__brain__brain_get_session',
      );
    } else {
      args.push('--mcp-config', JSON.stringify({ mcpServers: {} }));
    }
    const cwd = path.join(instance().home, 'router');
    fs.mkdirSync(cwd, { recursive: true });
    execFile('claude', args, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err && !out) {
        reject(new Error('Router failed: ' + (err.message.split('\n')[0] ?? '')));
        return;
      }
      try {
        const j = JSON.parse(out) as { structured_output?: Decision | null; result?: unknown };
        resolve(j.structured_output || (JSON.parse(String(j.result).replaceAll(/^```json|```$/g, '')) as Decision));
      } catch {
        reject(new Error('Router gave no decision'));
      }
    });
  });
}

/** One routing decision (the router's answer, or one item of its "tasks"). */
export interface Decision {
  action?: string;
  target?: string;
  device?: string;
  sid?: string;
  folder?: string;
  name?: string;
  confidence?: number;
  reason?: string;
  alternatives?: string[];
  context_from?: string[];
  agent?: string;
  task?: string;
  tasks?: unknown;
  [key: string]: unknown;
}

/**
 * The router's answer as a list of decisions, one per task. One job (no "tasks", or fewer than 2
 * usable items): [the top-level decision], unchanged. Several jobs: one decision per item, each with
 * its own non-empty "task" text; at most MAX_TASKS. Two tasks never "send" to the same session:
 * the later one becomes a new session in that session's folder with it as background.
 * d: the router's answer; sessions: [{id, name, folder, agent}].
 */
export function splitTasks(d: Decision | null | undefined, sessions: RouterSession[] = []): Decision[] {
  const tasks = d?.tasks;
  const items = (Array.isArray(tasks) ? (tasks as unknown[]) : []).filter(
    (t): t is Decision & { action: string; task: string } =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as Decision).action === 'string' &&
      typeof (t as Decision).task === 'string' &&
      ((t as Decision).task ?? '').trim() !== '',
  );
  if (items.length < 2) {
    const one: Decision = { ...d };
    delete one.tasks;
    return [one];
  }
  const sent = new Set<string>();
  return items.slice(0, MAX_TASKS).map((t) => {
    const x: Decision = {
      ...t,
      task: t.task.trim(),
      context_from: Array.isArray(t.context_from) ? [...t.context_from] : [],
    };
    delete x.tasks;
    if (typeof x.confidence !== 'number') x.confidence = typeof d?.confidence === 'number' ? d.confidence : 0;
    if (typeof x.reason !== 'string' || !x.reason) x.reason = '';
    if (x.action === 'send' && ne(x.target)) {
      if (sent.has(x.target)) {
        const target = x.target;
        const s = sessions.find((y) => y.id === target);
        x.action = 'new';
        x.folder = (s?.folder ?? '') || (x.folder ?? '') || '';
        let name = '';
        if (ne(x.name) && (!s || x.name !== s.name)) name = x.name;
        else if (s) name = `${s.name ?? 'undefined'} 2`;
        x.name = name;
        x.context_from = [...new Set([target, ...(x.context_from ?? [])])];
        if (!ne(x.agent) && s) x.agent = s.agent === 'codex' ? 'codex' : 'claude';
        x.target = '';
      } else sent.add(x.target);
    }
    return x;
  });
}

/** A session the router must not send to (the user's rule, 2026-11-17: a request never waits
 * for a session that is still working; it gets a new session with that session's background).
 * Busy: state "working", or `queued` messages waiting (>= BUSY_QUEUE). */
export function isBusy(s: { state?: string } | undefined, queued = 0): boolean {
  return s !== undefined && (s.state === 'working' || queued >= BUSY_QUEUE);
}

/** The router is not sure: the folder for the new session. The user's rule (2026-11-10): do not
 * ask, and do not fall back to the default folder when the request belongs to a known project.
 * Order: the folder the router named, the folder of its best-guess session, the folders of its
 * other guesses, then the default folder. Returns { folder, from } ; `from` is the session whose
 * folder was taken, '' for the router's own folder, null for the default. */
export function unsureFolder(
  d: Decision,
  sessions: RouterSession[],
  defaultFolder: string,
  exists: (folder: string) => boolean,
): { folder: string; from: string | null } {
  if (ne(d.folder) && d.folder !== defaultFolder && exists(d.folder)) return { folder: d.folder, from: '' };
  for (const id of [d.target, ...(d.alternatives ?? [])]) {
    const s = ne(id) ? sessions.find((x) => x.id === id) : undefined;
    if (s && ne(s.folder) && s.folder !== defaultFolder && exists(s.folder))
      return { folder: s.folder, from: s.name ?? null };
  }
  return { folder: defaultFolder, from: null };
}

/** A request can carry the folder and the agent the user chose for a NEW session (the phone's
 * "New task" sheet). They count only where the server starts a new session for the request: a
 * chosen folder replaces the folder the server would use, a chosen agent its agent. Returns
 * { folder, agent, chosen }; `chosen`: the folder is the user's, not the server's.
 * prefs: checked by the caller (the folder exists, the agent is known); folder: the folder the
 * server would use; agent: the agent the server would use. */
export function newSessionChoice(
  prefs: { folder?: string; agent?: string } | null | undefined,
  folder: string,
  agent: string,
): { folder: string; agent: string; chosen: boolean } {
  const p = prefs ?? {};
  return { folder: (p.folder ?? '') || folder, agent: (p.agent ?? '') || agent, chosen: Boolean(p.folder) };
}
