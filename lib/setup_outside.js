'use strict';
// Setup step 5, "Index and move in".
// Pure helpers: the server passes in the `elsewhere` Map (sessionId -> process record from
// ~/.claude/sessions/<pid>.json, see lib/elsewhere.js) and the brain's device rows; these
// functions turn them into plain-English rows for the setup page. No I/O here.
const path = require('path');

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusText(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'busy' || s === 'working' || s === 'running') return 'Working';
  if (s === 'idle' || s === 'waiting') return 'Waiting for you';
  return s ? s[0].toUpperCase() + s.slice(1) : 'Open';
}

/**
 * Claude Code and Codex sessions that run outside the panel, as rows for the page.
 * exists(folder) -> bool; titleOf(folder, sid) -> conversation title or ''; home shortens folders to ~/…
 */
function outsideList(map, { exists = () => true, titleOf = () => '', home = '' } = {}) {
  const out = [];
  for (const [sid, r] of map || []) {
    if (!SID.test(sid) || !r) continue;
    const folder = String(r.cwd || '');
    const bg = r.kind === 'bg';
    const attach = bg && !!r.jobId;
    const ok = !!folder && exists(folder);
    out.push({
      sid, pid: r.pid, folder, place: folder ? path.basename(folder) : '',
      shown: home && folder.startsWith(home + path.sep) ? '~' + folder.slice(home.length) : folder,
      name: String(r.name || (folder ? path.basename(folder) : r.agent === 'codex' ? 'Codex session' : 'Claude session')).slice(0, 60),
      agent: r.agent === 'codex' ? 'codex' : 'claude',
      title: String(titleOf(folder, sid) || '').slice(0, 120),
      kind: bg ? 'background' : 'interactive',
      status: statusText(r.status),
      move: attach ? 'attach' : 'stop',
      moveText: attach
        ? 'It keeps running. The panel attaches to it.'
        : 'The panel closes it where it runs now and opens the same conversation here. Nothing is lost.',
      ok,
      problem: ok ? '' : 'Its folder no longer exists, so it cannot move into the panel.',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.sid.localeCompare(b.sid));
}

/** Arguments for actions.new() that move one outside session into the panel. Throws in plain words. */
function moveInArgs(rec, exists = () => true) {
  if (!rec) throw new Error('This session is no longer running outside the panel. Refresh the list.');
  const folder = String(rec.cwd || '');
  if (!folder || !exists(folder)) throw new Error('Its folder no longer exists, so it cannot move into the panel.');
  return { folder, sid: rec.sessionId, name: String(rec.name || path.basename(folder)).slice(0, 30), ...(rec.agent === 'codex' ? { agent: 'codex' } : {}) };
}

/**
 * What the brain has per device. setupDevices: the wizard's devices; brainRows: brain
 * GET /api/devices (null = brain not reachable). The brain's "local" row is this computer.
 */
function brainDevices(setupDevices, brainRows) {
  const rows = Array.isArray(brainRows) ? brainRows : [];
  const self = (setupDevices || []).find((d) => d.self);
  const used = new Set();
  const pick = (d) => {
    let r = rows.find((x) => x.name === d.name);
    if (!r && d.self) r = rows.find((x) => x.transport === 'local');
    if (r) used.add(r);
    return r;
  };
  const out = (setupDevices || []).map((d) => {
    const r = pick(d);
    return { name: d.name, os: d.os || '', self: !!d.self, connected: !!(d.self || d.connected), known: !!r,
      sessions: r ? Number(r.sessions) || 0 : 0, lastSync: r && r.last_sync ? Number(r.last_sync) * 1000 : 0,
      ok: r ? r.ok !== 0 : null, error: r && r.ok === 0 ? String(r.error || 'The last collection failed.') : '' };
  });
  for (const r of rows) {
    if (used.has(r) || (self && r.name === self.name)) continue;
    out.push({ name: r.name, os: r.os || '', self: false, connected: true, known: true, sessions: Number(r.sessions) || 0,
      lastSync: r.last_sync ? Number(r.last_sync) * 1000 : 0, ok: r.ok !== 0,
      error: r.ok === 0 ? String(r.error || 'The last collection failed.') : '' });
  }
  return out;
}

module.exports = { outsideList, moveInArgs, brainDevices, statusText };
