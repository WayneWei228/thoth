// macOS permissions for Claude sessions in Thoth (Accessibility, Screen Recording), shown on the
// setup page like `agent-desktop permissions --guide` (user, 2026-11-15): detect the state, open the
// exact System Settings pane, show which app to drag into the list, check again until it is granted.
//
// macOS grants these per app: a process gets the grant of its "responsible" app (the app that
// started it, for Thoth sessions normally ~/Applications/Thoth.app). So the state is read by
// lib/permission_probe.ts (osascript, a plain binary that gets the same app) run INSIDE the panel's
// tmux server (`tmux run-shell`). No tmux server yet: the probe runs from this server. The state
// counts only when the responsible app is Thoth or a terminal app: a tmux server that no app
// started charges each binary to itself, and a grant for some other app would not help the
// sessions (user, 2026-11-16: never ask to grant Python).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { probeCommand } from './permission_probe.ts';

export type PermId = 'accessibility' | 'screen_recording';
export interface Perm {
  id: PermId;
  name: string;
  pane: string;
  why: string;
}

const PANE = 'x-apple.systempreferences:com.apple.preference.security?';
export const PERMS: Perm[] = [
  {
    id: 'accessibility',
    name: 'Accessibility',
    pane: PANE + 'Privacy_Accessibility',
    why: 'Claude sessions in Thoth cannot click or type in other apps (for example with agent-desktop).',
  },
  {
    id: 'screen_recording',
    name: 'Screen Recording',
    pane: PANE + 'Privacy_ScreenCapture',
    why: 'Claude sessions in Thoth cannot take screenshots of the screen or of other apps.',
  },
];
export const DEFAULT_APP = path.join(os.homedir(), 'Applications', 'Thoth.app');

/** The app bundle that holds `bin` ("/A/Thoth.app/Contents/MacOS/X" -> "/A/Thoth.app"), else bin. */
export function appOf(bin: string | null | undefined): string {
  const m = /^(.*?\.app)\//.exec(bin ?? '');
  return m ? (m[1] ?? '') : (bin ?? '');
}
const appName = (p: string): string => path.basename(p).replace(/\.app$/, '');

export type PermState = 'granted' | 'denied' | 'unknown';
export interface PermResult {
  accessibility: PermState;
  screen_recording: PermState;
  app: string;
}

interface ProbeJson {
  data?: ProbeJson;
  command?: string;
  accessibility?: unknown;
  screen_recording?: unknown;
  responsible?: string;
}

/** Parse the probe's (or agent-desktop's) output into { accessibility, screen_recording, app } or null. */
export function parse(out: string | null | undefined): PermResult | null {
  const line = (out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (line === undefined) return null;
  let j: ProbeJson;
  try {
    j = JSON.parse(line) as ProbeJson;
  } catch {
    return null;
  }
  const d = j.data && j.command === 'permissions' ? j.data : j; // agent-desktop wraps it in { data }
  const st = (v: unknown): PermState => {
    const s = typeof v === 'object' && v !== null ? (v as { state?: unknown }).state : v;
    return s === 'granted' || s === 'denied' ? s : 'unknown';
  };
  const r: PermResult = {
    accessibility: st(d.accessibility),
    screen_recording: st(d.screen_recording),
    app: d.responsible !== undefined && d.responsible !== '' ? appOf(d.responsible) : '',
  };
  return r.accessibility === 'unknown' && r.screen_recording === 'unknown' ? null : r;
}

const sh = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`;
function run(cmd: string, args: string[], ms = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms }, (e, out) => {
      resolve(e ? '' : out);
    });
  });
}
/** The apps whose grant a session can use: Thoth, or the terminal app that runs the tmux server. */
const SESSION_APPS = /^(Thoth|Terminal|iTerm2?|Ghostty|WezTerm|kitty|Alacritty|Warp|Hyper|Tabby)$/i;
export const sessionApp = (app: string | null | undefined): boolean =>
  /\.app$/.test(app ?? '') && SESSION_APPS.test(appName(app ?? ''));

export interface ProbeOptions {
  tmuxArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

/** Read the state now. `tmuxArgs` selects the panel's tmux server. Never prompts, never opens a window. */
export async function probe({ tmuxArgs = ['-u'], env = process.env }: ProbeOptions = {}): Promise<PermResult | null> {
  const fake = env['CC_SETUP_FAKE_PERMS'] ?? '';
  if (fake) {
    // tests: "accessibility=denied,screen_recording=granted", or a file that holds it
    const text = fake.startsWith('/') ? fs.readFileSync(fake, 'utf8').trim() : fake;
    const kv = new Map(text.split(',').map((p): [string, string] => [p.split('=')[0] ?? '', p.split('=')[1] ?? '']));
    return {
      accessibility: ((kv.get('accessibility') ?? '') || 'unknown') as PermState,
      screen_recording: ((kv.get('screen_recording') ?? '') || 'unknown') as PermState,
      app: (kv.get('app') ?? '') || DEFAULT_APP,
    };
  }
  if (process.platform !== 'darwin') return null;
  const [bin = '', ...args] = probeCommand();
  const r =
    parse(await run('tmux', [...tmuxArgs, 'run-shell', [bin, ...args].map((s) => sh(s)).join(' ')])) ??
    parse(await run(bin, args));
  return r && sessionApp(r.app) ? r : null;
}

interface Cache {
  at: number;
  value: PermResult | null;
  pending: Promise<PermResult | null> | null;
}
let cache: Cache = { at: 0, value: null, pending: null };
/** probe() at most once per 1.5 s (the setup page asks every 2 s while the user fixes something). */
export function state(opts?: ProbeOptions): Promise<PermResult | null> {
  if (Date.now() - cache.at < 1500) return Promise.resolve(cache.value);
  cache.pending ??= probe(opts).then(
    (v) => {
      cache = { at: Date.now(), value: v, pending: null };
      return v;
    },
    () => {
      cache.pending = null;
      return null;
    },
  );
  return cache.pending;
}
export const lastApp = (): string => (cache.value?.app ?? '') || DEFAULT_APP;

export interface PermCheck {
  id: PermId;
  perm: true;
  optional: true;
  title: string;
  ok: boolean;
  name: string;
  pane: string;
  app: string;
  cause: string;
  fix: string;
  actions?: { id: string; label: string; note: string }[];
  steps?: string[];
}

/** Setup checks (lib/setup.ts shape) for a probe result: one per permission, optional, with the guide. */
export function checks(st: PermResult | null | undefined): PermCheck[] {
  if (!st || (st.app && !sessionApp(st.app))) return []; // never tell the user to grant some other app
  const app = st.app || DEFAULT_APP,
    name = appName(app);
  const where = app.startsWith(os.homedir() + '/') ? '~' + app.slice(os.homedir().length) : app;
  return PERMS.filter((p) => st[p.id] !== 'unknown').map((p) => {
    const ok = st[p.id] === 'granted';
    return {
      id: p.id,
      perm: true,
      optional: true,
      title: `${p.name} for ${name}`,
      ok,
      name: p.name,
      pane: p.pane,
      app,
      cause: ok ? '' : p.why,
      fix: ok
        ? ''
        : `System Settings → Privacy & Security → ${p.name}: add ${where} and turn it on. If it is already in the list, turn it off and on again (a new build of ${name} can make macOS forget the old permission).`,
      ...(ok
        ? {}
        : {
            actions: [
              {
                id: `perm-${p.id}`,
                label: `Open ${p.name} settings`,
                note: `System Settings opens, and Finder shows ${name}. Drag ${name} into the list.`,
              },
            ],
            steps: [
              `System Settings opens at Privacy & Security → ${p.name}. A Finder window shows ${name} (${where}).`,
              `Drag ${name} from Finder into the list. Or click + below the list and choose ${where}.`,
              `Turn the switch next to ${name} on. macOS asks for Touch ID or your password.`,
              `Already in the list and switched on, but this page still says no? Turn it off and on again. A new build of ${name} can make macOS forget the old permission.`,
              ...(p.id === 'screen_recording'
                ? [`If macOS asks to quit and reopen ${name}, you can: sessions keep running.`]
                : []),
              'This page checks again every 2 seconds and says when it works.',
            ],
          }),
    };
  });
}

export const _reset = (): void => {
  cache = { at: 0, value: null, pending: null };
};
