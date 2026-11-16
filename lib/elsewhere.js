'use strict';
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
const fs = require('fs');
const path = require('path');

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Live process records from ~/.claude/sessions. */
function readRecords(dir, isAlive = alive) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Number.isInteger(r.pid) && SID.test(r.sessionId || '') && isAlive(r.pid)) out.push(r);
    } catch { /* partial write: skip */ }
  }
  return out;
}

/** sessionId -> record, for processes not running inside a panel pane. */
function outsideHolders(records, inPanel) {
  const m = new Map();
  for (const r of records) if (!inPanel(String(r.pid))) m.set(r.sessionId, r);
  return m;
}

/**
 * panePid -> sessionId of the Claude process running inside that pane (exact; from the records).
 * Replaces guessing by transcript birth time, which picked old transcripts (tmux 3.5 has no
 * #{window_created}, so every old transcript passed the time filter; 2026-11-09 a new
 * window got the session id of a two-month-old session of another folder, and a watcher followed the wrong one).
 */
function paneSessions(records, parent, panes) {
  const m = new Map();
  for (const r of records) {
    let p = String(r.pid);
    for (let i = 0; i < 30 && p && p !== '1'; i++) {
      if (panes.has(p)) { m.set(p, r.sessionId); break; }
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
function paneRunning(cmd, panePid, paneSid, shells) {
  return !shells.has(cmd) || paneSid.has(String(panePid));
}

function isBlocked({ running, sid }, holders) {
  return !running && SID.test(sid || '') && holders.has(sid);
}

/** How to bring a held conversation into the panel. */
function migrationPlan(rec) {
  if (!rec) return { kind: 'none' };
  if (rec.kind === 'bg' && rec.jobId) return { kind: 'attach', jobId: String(rec.jobId) };
  return { kind: 'stop', pid: rec.pid };
}

module.exports = { readRecords, outsideHolders, paneSessions, paneRunning, isBlocked, migrationPlan, alive, SID };
