// Ask for a macOS permission only when a session needs it (user, 2026-11-15: setup must not ask
// for "screen recording" up front; most users never need it). A Claude session's tool output
// (hook PostToolUse / PostToolUseFailure, lib/claude_args.ts) that says a permission is missing
// names the permission here; the server then checks the real state (lib/permissions.ts) and the
// app shows its guide (PermissionGuide.swift). Pure functions, no I/O.

// Only real failures count (user, 2026-11-16: a grep or a Read of code that names "Screen Recording"
// opened the guide). So: only the Bash tool, only when its command runs the tool that failed, and
// only the exact error line that tool prints. No keyword search in other output.
const PERM_ID: Record<string, string> = { accessibility: 'accessibility', 'screen recording': 'screen_recording' };
// screencapture without Screen Recording (exit 1)
const SCREENCAPTURE = /^(screencapture: )?could not create image from (display|window)\.?$/i;
// agent-desktop: older plain text, and the JSON of 2.6 ({"ok":false,"error":{"code":"PERM_DENIED",...}})
const AD_TEXT = /^agent-desktop needs (Accessibility|Screen Recording) permission\b/i;
const AD_MESSAGE = /^(Accessibility|Screen Recording) permission not granted$/i;

const permId = (name: string | undefined): string => PERM_ID[(name ?? '').toLowerCase()] ?? '';

interface AgentDesktopJson {
  ok?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

/** The permission one agent-desktop JSON line says is missing, else ''. */
function agentDesktopJson(line: string): string {
  if (!line.startsWith('{')) return '';
  let j: AgentDesktopJson | null;
  try {
    j = JSON.parse(line) as AgentDesktopJson | null;
  } catch {
    return '';
  }
  const e = j?.ok === false ? j.error : null;
  const m = e && e.code === 'PERM_DENIED' && typeof e.message === 'string' ? AD_MESSAGE.exec(e.message) : null;
  return m ? permId(m[1]) : '';
}

export interface HookPayload {
  error?: unknown;
  tool_response?: unknown;
  tool_name?: unknown;
  tool_input?: { command?: unknown } | null;
  [key: string]: unknown;
}

/** The text a hook payload carries about the tool's result (error, stdout, stderr), short. */
export function resultText(payload: HookPayload = {}): string {
  const parts: string[] = [];
  if (typeof payload.error === 'string') parts.push(payload.error);
  const r = payload.tool_response;
  if (typeof r === 'string') parts.push(r);
  else if (typeof r === 'object' && r !== null) {
    const rec = r as Record<string, unknown>;
    for (const k of ['stderr', 'stdout', 'error', 'content']) {
      const v = rec[k];
      if (typeof v === 'string') parts.push(v);
    }
  }
  return parts.join('\n').slice(0, 20_000);
}

/** The permissions a hook event says are missing: [] or some of ['accessibility', 'screen_recording']. */
export function wanted(event: string, payload: HookPayload = {}): string[] {
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return [];
  if (payload.tool_name !== 'Bash') return []; // Read, Grep, Glob, ... only show files
  const command = payload.tool_input?.command;
  const cmd = typeof command === 'string' ? command : '';
  const capture = /\bscreencapture\b/.test(cmd),
    ad = /\bagent-desktop\b/.test(cmd);
  if (!capture && !ad) return [];
  const out = new Set<string>();
  for (const raw of resultText(payload).split('\n')) {
    const line = raw.trim();
    if (capture && SCREENCAPTURE.test(line)) out.add('screen_recording');
    if (!ad) continue;
    const m = AD_TEXT.exec(line);
    if (m) out.add(permId(m[1]));
    const id = agentDesktopJson(line);
    if (id) out.add(id);
  }
  return [...out];
}

/** Ask once per permission in `cooldownMs` (a session that retries must not open the guide again and again). */
export function shouldAsk(
  asked: Map<string, number>,
  id: string,
  now: number = Date.now(),
  cooldownMs: number = 30 * 60 * 1000,
): boolean {
  const t = asked.get(id);
  if (t !== undefined && t !== 0 && now - t < cooldownMs) return false;
  asked.set(id, now);
  return true;
}
