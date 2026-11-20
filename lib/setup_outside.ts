// Setup step 5, "Index and move in".
// Pure helpers: the server passes in the `elsewhere` Map (sessionId -> process record from
// ~/.claude/sessions/<pid>.json, see lib/elsewhere.ts) and the brain's device rows; these
// functions turn them into plain-English rows for the setup page. No I/O here.
import path from 'node:path';

const SID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function statusText(status: unknown): string {
  const s = (typeof status === 'string' ? status : '').toLowerCase();
  if (s === 'busy' || s === 'working' || s === 'running') return 'Working';
  if (s === 'idle' || s === 'waiting') return 'Waiting for you';
  return s ? (s[0] ?? '').toUpperCase() + s.slice(1) : 'Open';
}

export interface OutsideRecord {
  pid?: number;
  sessionId?: string;
  cwd?: string | null;
  kind?: string;
  jobId?: unknown;
  name?: string | null;
  agent?: string;
  status?: unknown;
}

export interface OutsideRow {
  sid: string;
  pid: number | undefined;
  folder: string;
  place: string;
  shown: string;
  name: string;
  agent: 'codex' | 'claude';
  title: string;
  kind: 'background' | 'interactive';
  status: string;
  move: 'attach' | 'stop';
  moveText: string;
  ok: boolean;
  problem: string;
}

export interface OutsideOptions {
  exists?: (folder: string) => boolean;
  titleOf?: (folder: string, sid: string) => string | null | undefined;
  home?: string;
}

/**
 * Claude Code and Codex sessions that run outside the panel, as rows for the page.
 * exists(folder) -> bool; titleOf(folder, sid) -> conversation title or ''; home shortens folders to ~/…
 */
export function outsideList(
  map: Iterable<[string, OutsideRecord | null | undefined]> | null | undefined,
  { exists = () => true, titleOf = () => '', home = '' }: OutsideOptions = {},
): OutsideRow[] {
  const out: OutsideRow[] = [];
  for (const [sid, r] of map ?? []) {
    if (!SID.test(sid) || !r) continue;
    const folder = r.cwd ?? '';
    const bg = r.kind === 'bg';
    const attach = bg && Boolean(r.jobId);
    const ok = folder !== '' && exists(folder);
    let fallbackName = 'Claude session';
    if (folder) fallbackName = path.basename(folder);
    else if (r.agent === 'codex') fallbackName = 'Codex session';
    out.push({
      sid,
      pid: r.pid,
      folder,
      place: folder ? path.basename(folder) : '',
      shown: home && folder.startsWith(home + path.sep) ? '~' + folder.slice(home.length) : folder,
      name: ((r.name ?? '') || fallbackName).slice(0, 60),
      agent: r.agent === 'codex' ? 'codex' : 'claude',
      title: (titleOf(folder, sid) ?? '').slice(0, 120),
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
  return out.toSorted((a, b) => a.name.localeCompare(b.name) || a.sid.localeCompare(b.sid));
}

export interface MoveInArgs {
  folder: string;
  sid: string | undefined;
  name: string;
  agent?: 'codex';
}

/** Arguments for actions.new() that move one outside session into the panel. Throws in plain words. */
export function moveInArgs(
  rec: OutsideRecord | null | undefined,
  exists: (folder: string) => boolean = () => true,
): MoveInArgs {
  if (!rec) throw new Error('This session is no longer running outside the panel. Refresh the list.');
  const folder = rec.cwd ?? '';
  if (!folder || !exists(folder)) throw new Error('Its folder no longer exists, so it cannot move into the panel.');
  return {
    folder,
    sid: rec.sessionId,
    name: ((rec.name ?? '') || path.basename(folder)).slice(0, 30),
    ...(rec.agent === 'codex' ? { agent: 'codex' as const } : {}),
  };
}

export interface SetupDevice {
  name: string;
  os?: string;
  self?: boolean;
  connected?: boolean;
}

export interface BrainDeviceRow {
  name: string;
  os?: string;
  transport?: string;
  sessions?: unknown;
  last_sync?: unknown;
  ok?: unknown;
  error?: unknown;
}

export interface DeviceSummary {
  name: string;
  os: string;
  self: boolean;
  connected: boolean;
  known: boolean;
  sessions: number;
  lastSync: number;
  ok: boolean | null;
  error: string;
}

const errorText = (e: unknown): string => (typeof e === 'string' && e ? e : 'The last collection failed.');

/**
 * What the brain has per device. setupDevices: the wizard's devices; brainRows: brain
 * GET /api/devices (null = brain not reachable). The brain's "local" row is this computer.
 */
export function brainDevices(
  setupDevices: SetupDevice[] | null | undefined,
  brainRows: BrainDeviceRow[] | null | undefined,
): DeviceSummary[] {
  const rows = Array.isArray(brainRows) ? brainRows : [];
  const devices = setupDevices ?? [];
  const self = devices.find((d) => d.self === true);
  const used = new Set<BrainDeviceRow>();
  const pick = (d: SetupDevice): BrainDeviceRow | undefined => {
    let r = rows.find((x) => x.name === d.name);
    if (!r && d.self === true) r = rows.find((x) => x.transport === 'local');
    if (r) used.add(r);
    return r;
  };
  const out: DeviceSummary[] = devices.map((d) => {
    const r = pick(d);
    return {
      name: d.name,
      os: d.os ?? '',
      self: d.self === true,
      connected: d.self === true || d.connected === true,
      known: Boolean(r),
      sessions: r ? Number(r.sessions) || 0 : 0,
      lastSync:
        r?.last_sync !== undefined && r.last_sync !== null && r.last_sync !== 0 && r.last_sync !== ''
          ? Number(r.last_sync) * 1000
          : 0,
      ok: r ? r.ok !== 0 : null,
      error: r?.ok === 0 ? errorText(r.error) : '',
    };
  });
  for (const r of rows) {
    if (used.has(r) || (self && r.name === self.name)) continue;
    out.push({
      name: r.name,
      os: r.os ?? '',
      self: false,
      connected: true,
      known: true,
      sessions: Number(r.sessions) || 0,
      lastSync:
        r.last_sync !== undefined && r.last_sync !== null && r.last_sync !== 0 && r.last_sync !== ''
          ? Number(r.last_sync) * 1000
          : 0,
      ok: r.ok !== 0,
      error: r.ok === 0 ? errorText(r.error) : '',
    });
  }
  return out;
}
