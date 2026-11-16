'use strict';
// Bring the panel's windows back after the Mac restarts.
//
// A restart ends the tmux server and every Claude/Codex in it. The panel keeps a list of its
// windows in windows.json (in its state folder, not in git). When the server starts and finds
// no tmux session, it builds the windows again from that list and resumes the sessions that
// were running before the restart (user request, 2026-11-14). Without the list, it falls back
// to sessions.conf and starts nothing (the old behaviour).
//
// Shutdown can stop Claude a moment before tmux and the server stop. A window that stopped in
// the last GRACE_MS still counts as running, so the last list written before the shutdown
// still says "running".
const fs = require('fs');

const GRACE_MS = 60000;
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The list to save from a poll. `sessions` are the panel's windows (snapshot.sessions);
 * `lastRun` (window id -> ms) is updated here: the last time each window had a running agent.
 */
function record(sessions, lastRun, now = Date.now()) {
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of lastRun.keys()) if (!ids.has(id)) lastRun.delete(id);
  return sessions.map((s) => {
    if (s.running) lastRun.set(s.id, now);
    const running = s.running || now - (lastRun.get(s.id) || 0) < GRACE_MS;
    return { name: s.name, folder: s.folder, sid: SID.test(s.sid || '') ? s.sid : '', agent: s.agent || 'claude', running };
  });
}

/** sessions.conf lines -> windows (none of them run). */
function fromConf(text) {
  return text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => {
    const [name, folder, sid, agent] = l.split('|').map((x) => (x || '').trim());
    return { name, folder, sid: sid || '', agent: agent || 'claude', running: false };
  }).filter((w) => w.name);
}

/**
 * The windows to build after a restart and which of them to resume.
 * saved: the windows.json list, or null. held(sid): true when a live process outside the
 * panel holds that session (VS Code, a terminal): such a window is built but not started.
 */
function plan(saved, confText, held = () => false, exists = fs.existsSync) {
  const list = Array.isArray(saved) && saved.length ? saved : fromConf(confText || '');
  return list.filter((w) => w && w.name && w.folder && exists(w.folder)).map((w) => ({
    name: w.name, folder: w.folder, sid: SID.test(w.sid || '') ? w.sid : '', agent: w.agent || 'claude',
    run: !!w.running && SID.test(w.sid || '') && !held(w.sid),
  }));
}

function load(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : null; } catch { return null; }
}

/** Write only when the content changed; write a temporary file first so a crash leaves the old list. */
let lastText = '';
function save(file, list) {
  const text = JSON.stringify(list, null, 1);
  if (text === lastText) return false;
  try { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); lastText = text; return true; } catch { return false; }
}

module.exports = { record, fromConf, plan, load, save, GRACE_MS };
