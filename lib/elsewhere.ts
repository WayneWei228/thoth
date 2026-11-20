// Conversations open OUTSIDE the panel (VS Code, a terminal, a background job).
//
// Claude Code writes one record per process: ~/.claude/sessions/<pid>.json with sessionId,
// cwd, kind ("interactive" | "bg") and status. A panel window is "elsewhere" only when Claude
// is not running in it and ITS session id is held by a live process outside the panel.
// (Before 2026-11-09 any Claude in the same folder blocked the window; new sessions in busy
// folders were refused.)
//
// User decision (2026-11-09): when the panel needs such a conversation, move it into the
// panel: stop the outside interactive process (SIGTERM; Claude saves the transcript), then
// resume the same session here. A background job is not stopped; the window attaches to it.
import fs from 'node:fs';
import path from 'node:path';

export const SID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** One ~/.claude/sessions/<pid>.json record (fields this code reads). */
export interface ProcessRecord {
  pid: number;
  sessionId: string;
  cwd?: string;
  kind?: string;
  status?: string;
  jobId?: string | number;
  name?: string;
  agent?: string;
  [key: string]: unknown;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live process records from ~/.claude/sessions. */
export function readRecords(dir: string, isAlive: (pid: number) => boolean = alive): ProcessRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out: ProcessRecord[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Partial<ProcessRecord>;
      if (Number.isInteger(r.pid) && SID.test(r.sessionId ?? '') && isAlive(r.pid ?? 0)) out.push(r as ProcessRecord);
    } catch {
      /* partial write: skip */
    }
  }
  return out;
}

/** sessionId -> record, for processes not running inside a panel pane. */
export function outsideHolders(
  records: ProcessRecord[],
  inPanel: (pid: string) => boolean,
): Map<string, ProcessRecord> {
  const m = new Map<string, ProcessRecord>();
  for (const r of records) if (!inPanel(String(r.pid))) m.set(r.sessionId, r);
  return m;
}

/**
 * panePid -> sessionId of the Claude process running inside that pane (exact; from the records).
 * Replaces guessing by transcript birth time, which picked old transcripts (tmux 3.5 has no
 * #{window_created}, so every old transcript passed the time filter; 2026-11-09 a new
 * window got the session id of a two-month-old session of another folder, and a watcher followed the wrong one).
 */
export function paneSessions(
  records: ProcessRecord[],
  parent: Map<string, string>,
  panes: Set<string>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of records) {
    let p: string | undefined = String(r.pid);
    for (let i = 0; i < 30 && p !== undefined && p !== '' && p !== '1'; i++) {
      if (panes.has(p)) {
        m.set(p, r.sessionId);
        break;
      }
      p = parent.get(p);
    }
  }
  return m;
}

/**
 * Is Claude running in this pane? The pane's foreground command is not enough: a pane started as
 * `zsh -lc "claude …; exec zsh"` shows `zsh` while Claude runs inside it (2026-11-09, @166).
 * A live Claude process record under the pane pid also counts.
 */
export function paneRunning(
  cmd: string,
  panePid: string | number,
  paneSid: Map<string, string>,
  shells: Set<string>,
): boolean {
  return !shells.has(cmd) || paneSid.has(String(panePid));
}

export function isBlocked(
  { running, sid }: { running?: boolean; sid?: string | null },
  holders: Map<string, unknown>,
): boolean {
  const s = sid ?? '';
  return running !== true && SID.test(s) && holders.has(s);
}

export type MigrationPlan = { kind: 'none' } | { kind: 'attach'; jobId: string } | { kind: 'stop'; pid: number };

/** How to bring a held conversation into the panel. */
export function migrationPlan(rec: ProcessRecord | null | undefined): MigrationPlan {
  if (!rec) return { kind: 'none' };
  if (rec.kind === 'bg' && rec.jobId !== undefined && rec.jobId !== '' && rec.jobId !== 0)
    return { kind: 'attach', jobId: String(rec.jobId) };
  return { kind: 'stop', pid: rec.pid };
}
