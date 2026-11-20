// Claude Code commands for the Ask box ("/name"): the list comes from Claude Code itself, so it
// holds the built-in commands, the user's skills and commands, and the plugins of THIS user.
// `claude -p` in stream-json mode answers an "initialize" control request with the commands
// (name, description, argument hint) before any prompt is sent: no model call, about 0.4 s.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** A command as Claude Code lists it (the fields this file reads). */
export interface RawCommand {
  name?: unknown;
  description?: unknown;
  argumentHint?: unknown;
}

/** A command as the Ask box shows it. `folders`: a project command, only in these folders. */
export interface Command {
  name: string;
  description: string;
  hint: string;
  folders?: string[];
}

// names Claude Code lists that are not for a person to type
const HIDDEN = /^(__|workflow-launch-exec$|heapdump$)/;
const NAME = /^[A-Za-z0-9][\w:.-]*$/;

const oneLine = (v: unknown): string => (typeof v === 'string' ? v.replaceAll(/\s+/g, ' ').trim() : '');

/** The list as the Ask box shows it: valid names once, short descriptions, sorted by name. */
export function clean(list: unknown): Command[] {
  const seen = new Set<string>();
  const out: Command[] = [];
  for (const c of Array.isArray(list) ? (list as unknown[]) : []) {
    if (c === null || typeof c !== 'object') continue;
    const raw = c as RawCommand;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!NAME.test(name) || HIDDEN.test(name) || seen.has(name)) continue;
    seen.add(name);
    const description = oneLine(raw.description);
    out.push({
      name,
      description: description.length > 200 ? `${description.slice(0, 199)}…` : description,
      hint: oneLine(raw.argumentHint).slice(0, 80),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One list for several folders. `base` is the list of the folder for new sessions; `perFolder`
 * maps a session folder to its list. A command that `base` does not have (a project command)
 * carries `folders`: the folders where it exists.
 */
export function merge(base: Command[], perFolder: Record<string, Command[]>): Command[] {
  const out = new Map<string, Command>(base.map((c) => [c.name, { ...c }]));
  for (const [folder, list] of Object.entries(perFolder)) {
    for (const c of list) {
      const have = out.get(c.name);
      if (!have) out.set(c.name, { ...c, folders: [folder] });
      else if (have.folders && !have.folders.includes(folder)) have.folders.push(folder);
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "/name" or "/name args" → { name, args }; anything else (also a file path) → null. */
export function parse(text: unknown): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(typeof text === 'string' ? text.trim() : '');
  if (!m) return null;
  return { name: m[1] ?? '', args: (m[2] ?? '').trim() };
}

/**
 * The keys to type into Claude Code for a command. A command without arguments gets a space at
 * the end: while only "/name" is in the input box, Claude Code shows its own suggestion list and
 * Enter runs the suggestion that is selected there, which can be another command (seen with
 * "/cost": the list selected "/usage"). The space closes that list.
 */
export function typed(text: unknown): string | null {
  const c = parse(text);
  if (!c) return null;
  return c.args ? `/${c.name} ${c.args.replaceAll(/[\r\n]+/g, ' ')}` : `/${c.name} `;
}

/**
 * A menu (Claude's own dialog) right after the Enter of a command: was the command sent? Only when
 * the Enter was pressed and the box had shown the command before it: then the menu is the command's
 * answer (/model, /resume), and typing it again later would run it twice. When the text never showed
 * in the box (Claude was still starting and did not read the keys), the menu is something else.
 */
export function menuAfterEnter(seen: { command: boolean; pressed: boolean; echoed: boolean }): 'sent' | 'menu' {
  return seen.command && seen.pressed && seen.echoed ? 'sent' : 'menu';
}

/** The command list in one stream-json line of Claude Code, or undefined when the line has none. */
function listIn(line: string): { commands?: unknown[]; other?: true } | undefined {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (j === null || typeof j !== 'object' || (j as { type?: unknown }).type !== 'control_response') return undefined;
  const response = (j as { response?: { response?: unknown } }).response;
  const r = (response?.response ?? response ?? {}) as { commands?: unknown };
  return Array.isArray(r.commands) ? { commands: r.commands as unknown[] } : { other: true };
}

/** Ask Claude Code in `cwd` for its commands. Rejects when it does not answer in `timeout` ms. */
export function ask(cwd: string, { timeout = 8000, bin = 'claude' } = {}): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let p: ChildProcessWithoutNullStreams;
    try {
      p = spawn(
        bin,
        [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--no-session-persistence',
        ],
        { cwd, stdio: 'pipe' },
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let buf = '';
    let over = false;
    const end = (err: Error | null, list?: unknown[]): void => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      p.kill('SIGKILL');
      if (err) reject(err);
      else resolve(list ?? []);
    };
    const timer = setTimeout(() => {
      end(new Error('Claude Code did not list its commands in time'));
    }, timeout);
    p.on('error', (e) => {
      end(e);
    });
    p.on('exit', () => {
      end(new Error('Claude Code ended before it listed its commands'));
    });
    p.stdin.on('error', () => {
      /* the process ended first: 'exit' reports it */
    });
    p.stderr.resume();
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const found = listIn(l);
        if (!found) continue;
        if (found.commands) end(null, found.commands);
        else end(new Error('Claude Code gave no command list'));
        return;
      }
    });
    p.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: 'commands', request: { subtype: 'initialize' } })}\n`,
    );
  });
}

interface Entry {
  at: number;
  list?: Command[];
  pending?: Promise<Command[]> | null;
}

/**
 * A cache of the lists by folder. A list is asked again after `ttl` ms; while Claude Code does not
 * answer, the last list of that folder is used.
 */
export function cache({
  ttl = 60_000,
  askFn = (folder: string): Promise<unknown> => ask(folder),
}: { ttl?: number; askFn?: (folder: string) => Promise<unknown> } = {}): {
  forFolder: (folder: string) => Promise<Command[]>;
  list: (base: string, folders: string[]) => Promise<Command[]>;
} {
  const lists = new Map<string, Entry>();
  function forFolder(folder: string): Promise<Command[]> {
    const e = lists.get(folder) ?? { at: 0 };
    if (e.list && Date.now() - e.at < ttl) return Promise.resolve(e.list);
    if (!e.pending) {
      e.pending = askFn(folder)
        .then((raw) => {
          e.list = clean(raw);
          e.at = Date.now();
          return e.list;
        })
        .catch((error: unknown) => {
          if (e.list) return e.list;
          throw error;
        })
        .finally(() => {
          e.pending = null;
        });
      lists.set(folder, e);
    }
    return e.pending;
  }
  /** The merged list for the new-session folder `base` and the session folders `folders`. */
  async function list(base: string, folders: string[]): Promise<Command[]> {
    const others = [...new Set(folders)].filter((f) => f !== '' && f !== base);
    const [baseList, ...rest] = await Promise.all([
      forFolder(base),
      ...others.map((f) => forFolder(f).catch((): Command[] => [])),
    ]);
    return merge(baseList, Object.fromEntries(others.map((f, i) => [f, rest[i] ?? []])));
  }
  return { forFolder, list };
}
