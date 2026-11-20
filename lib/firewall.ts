// The macOS application firewall: does it block incoming connections to this server's node binary?
// Then a device on the network (another computer, a remote client) gets no answer from this Mac,
// and nothing on that device says why (found in a real Docker pairing test, 2026-11-09, and in the
// first test with a real device, 2026-11-16).
// One check for the setup page and the Add Device sheet (lib/setup.ts, sync) and for pairing
// (server.ts and the pairing command, async and kept for a few seconds). It only reads. The fix is
// `firewall-allow` in lib/setup_fix.ts.
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';

export const TOOL = '/usr/libexec/ApplicationFirewall/socketfilterfw';

/** The questions for socketfilterfw, one at a time: each `yield` gives the arguments and gets the
 * tool's answer (text), or null when it could not be read. Returns true (blocked), false (not
 * blocked) or null (cannot tell). An app that is not in the firewall's list is not blocked: macOS
 * allows signed software, or asks the user. */
function* questions(node: string): Generator<string[], boolean | null, string | null> {
  const state = yield ['--getglobalstate']; // "Firewall is enabled. (State = 1)"
  if (state === null) return null;
  if (!/enabled/i.test(state)) return false;
  const all = yield ['--getblockall']; // "Firewall has block all state set to disabled."
  if (all === null) return null;
  if (/enabled/i.test(all)) return true;
  const app = yield ['--getappblocked', node]; // "Incoming connection to <path> is blocked."
  if (app === null) return null;
  return /is blocked\.?\s*$/i.test(app);
}

type Plan = { answer: boolean | null; tool?: undefined } | { tool: string };

/** What to do: a fixed answer, or the tool to ask. Test switch CC_SETUP_FAKE_FIREWALL: an absolute
 * path is a program that answers in place of socketfilterfw;
 * any other value means "blocked". */
function plan(env: NodeJS.ProcessEnv): Plan {
  const fake = env['CC_SETUP_FAKE_FIREWALL'] ?? '';
  if (fake && !path.isAbsolute(fake)) return { answer: true };
  if (!fake && process.platform !== 'darwin') return { answer: null };
  return { tool: fake || TOOL };
}

/** For the setup checks (they are sync). It blocks while the tool runs: never call it from a route
 * that is asked often. */
export function blocksNodeSync(env: NodeJS.ProcessEnv = process.env, node: string = process.execPath): boolean | null {
  const p = plan(env);
  if (p.tool === undefined) return p.answer;
  const q = questions(node);
  let step = q.next(null);
  while (step.done !== true) {
    let text: string | null = null;
    try {
      text = execFileSync(p.tool, step.value, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
    } catch {
      /* no answer */
    }
    step = q.next(text);
  }
  return step.value;
}

async function ask(env: NodeJS.ProcessEnv, node: string): Promise<boolean | null> {
  const p = plan(env);
  if (p.tool === undefined) return p.answer;
  const tool = p.tool;
  const q = questions(node);
  let step = q.next(null);
  while (step.done !== true) {
    const args = step.value;
    const text = await new Promise<string | null>((resolve) => {
      execFile(tool, args, { encoding: 'utf8', timeout: 3000 }, (err, out) => {
        resolve(err ? null : out);
      });
    });
    step = q.next(text);
  }
  return step.value;
}

interface Kept {
  key: string;
  pending: Promise<boolean | null> | null;
  at?: number;
  value?: boolean | null;
}
let kept: Kept | null = null; // { key, pending } while the tool runs, then { key, at, value }

export interface BlocksNodeOptions {
  env?: NodeJS.ProcessEnv;
  node?: string;
  maxAge?: number;
}

/** The same check without blocking the server. The answer is kept for `maxAge` ms (the open Pair
 * remote client sheet asks every 2 s), and callers that ask while the tool runs share that one run.
 * It never rejects: a tool that fails or takes too long gives null. */
export function blocksNode({
  env = process.env,
  node = process.execPath,
  maxAge = 5000,
}: BlocksNodeOptions = {}): Promise<boolean | null> {
  const key = `${env['CC_SETUP_FAKE_FIREWALL'] ?? ''}\n${node}`;
  if (kept?.key === key) {
    if (kept.pending) return kept.pending;
    if (Date.now() - (kept.at ?? 0) < maxAge) return Promise.resolve(kept.value ?? null);
  }
  const entry: Kept = { key, pending: null };
  entry.pending = ask(env, node).then((value) => {
    Object.assign(entry, { value, at: Date.now(), pending: null });
    return value;
  });
  kept = entry;
  return entry.pending;
}

/** Drop the kept answer: the next call asks the tool again (after a fix ran). */
export function forget(): void {
  kept = null;
}
