// First-run setup wizard.
// Steps: 1 devices, 2 connect them, 3 your brain (cloud or a computer), 4 keep the brain on (skipped
// for a cloud brain), 5 index and move in.
// State lives in <panel home>/setup.json so closing and reopening resumes at the same step.
// The brain location lives in <panel home>/brain.json (0600):
// { url, owner_token }. No brain.json = the local brain on 127.0.0.1 (as before).
// Every check returns { id, title, ok, cause, fix } in plain words: the page shows them as they are.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Device } from './devices.ts';
import * as Firewall from './firewall.ts';
import { ne, truthy } from './truthy.ts';
import { isWsl } from './wsl.ts';
import * as WslHost from './wsl_host.ts';

const NAME = /^[a-z\d][a-z\d-]{0,30}$/;
export const CLOUD = ':cloud'; // s.brain for a cloud brain (never a device name: NAME has no ':')
const OSES = new Set(['macos', 'linux', 'windows']);

export interface SetupState {
  version: number;
  done: boolean;
  step: number;
  brain: string;
  keepOn: boolean;
  devices: Device[];
  cloud?: { host: string; connectedAt: number };
  [key: string]: unknown;
}

/** The OS family for packages and the setup page's device list. WSL is 'linux' here (apt, tmux);
 * thisSystem() says that it is WSL. */
export function thisOs(): 'macos' | 'windows' | 'linux' {
  if (process.platform === 'darwin') return 'macos';
  return process.platform === 'win32' ? 'windows' : 'linux';
}
/** macos, windows, linux, or windows-wsl (Linux inside WSL on a Windows PC). */
export function thisSystem(wsl: boolean = isWsl()): string {
  return WslHost.systemOs(process.platform, wsl);
}
export function hostName(): string {
  return (
    ((os.hostname().split('.')[0] ?? '') || 'this-computer')
      .toLowerCase()
      .replaceAll(/[^a-z\d-]/g, '-')
      .slice(0, 31) || 'this-computer'
  );
}

export function defaultState(): SetupState {
  return {
    version: 1,
    done: false,
    step: 1,
    brain: '',
    keepOn: false,
    devices: [{ name: hostName(), os: thisOs(), self: true }],
  };
}

function file(home: string): string {
  return path.join(home, 'setup.json');
}

export function load(home: string): SetupState {
  try {
    const s = JSON.parse(fs.readFileSync(file(home), 'utf8')) as Partial<SetupState> | null;
    if (s?.version === 1 && Array.isArray(s.devices)) return s as SetupState;
  } catch {
    /* first run */
  }
  return defaultState();
}

export function save<S>(home: string, s: S): S {
  fs.mkdirSync(home, { recursive: true });
  const tmp = file(home) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, file(home));
  return s;
}

interface DeviceInput {
  name?: unknown;
  os?: unknown;
}

const textOf = (v: unknown): string => (truthy(v) ? String(v) : '');

/** Step 1: the user's devices (this one is always there). Throws with a plain reason. */
export function setDevices(s: SetupState, list: unknown): SetupState {
  if (!Array.isArray(list)) throw new Error('Send a list of devices');
  const self = s.devices.find((d) => d.self === true);
  const out = [self] as Device[];
  for (const d of list as (DeviceInput | null)[]) {
    const name = textOf(d?.name).trim().toLowerCase();
    const dos = textOf(d?.os).toLowerCase();
    if (!NAME.test(name))
      throw new Error(
        `Device name "${d ? String(d.name) : String(d)}" is not allowed: use letters, digits and "-" (up to 31)`,
      );
    if (!OSES.has(dos)) throw new Error(`Choose macOS, Linux or Windows for "${name}"`);
    if (out.some((x) => x.name === name)) throw new Error(`Two devices are called "${name}"`);
    const old = s.devices.find((x) => x.name === name && x.self !== true) ?? {};
    out.push({ ...old, name, os: dos });
  }
  s.devices = out;
  if (s.brain && s.brain !== CLOUD && !out.some((d) => d.name === s.brain)) s.brain = '';
  s.step = Math.max(s.step, 2);
  return s;
}

export function setStep(s: SetupState, step: unknown): SetupState {
  const n = Number(step);
  if (!(n >= 1 && n <= 5)) throw new Error('Steps are 1 to 5');
  if (n === 4 && s.brain === CLOUD) throw new Error('A cloud brain is always on: there is no step 4');
  if (n >= 4 && !s.brain) throw new Error('Choose the brain device first (step 3)');
  if (n >= 5 && !s.keepOn) throw new Error('Confirm that the brain device stays on (step 4)');
  s.step = n;
  return s;
}

export function setBrain(s: SetupState, device: string): SetupState {
  const d = s.devices.find((x) => x.name === device);
  if (!d) throw new Error(`"${device}" is not one of your devices`);
  if (d.self !== true && d.connected !== true)
    throw new Error(`"${device}" is not connected yet. Connect it in step 2, or choose this device`);
  s.brain = d.name;
  s.keepOn = false;
  delete s.cloud;
  s.step = 4;
  return s;
}

/** Step 3, cloud: the panel is connected to a cloud brain. A server is always on, so step 4 is
 * not needed. With other computers listed, go back to step 2 so they join the cloud brain. */
export function setCloud(s: SetupState, host: string): SetupState {
  s.brain = CLOUD;
  s.keepOn = true;
  s.cloud = { host, connectedAt: Date.now() };
  if (!s.done) s.step = s.devices.some((d) => d.self !== true) ? 2 : 5;
  return s;
}

// ------------------------------------------------------- brain location ----
const LINK = /^ccbrain:\/\/([A-Za-z\d.-]+(?::\d{1,5})?)\/?#([\w.~-]{16,200})$/;
/** Parse a connect link `ccbrain://<host>/#<owner-token>`. Returns { host, url, token } or null. */
export function parseConnectLink(link: unknown): { host: string; url: string; token: string } | null {
  const m = LINK.exec(textOf(link).trim());
  if (!m) return null;
  const host = (m[1] ?? '').toLowerCase();
  return { host, url: `https://${host}`, token: m[2] ?? '' };
}
function brainFile(home: string): string {
  return path.join(home, 'brain.json');
}

export interface BrainLocation {
  url: string;
  owner_token: string;
}

/** The brain location: { url, owner_token } for a cloud brain, or null (the local brain). */
export function loadBrainLocation(home: string): BrainLocation | null {
  try {
    const j = JSON.parse(fs.readFileSync(brainFile(home), 'utf8')) as { url?: unknown; owner_token?: unknown } | null;
    const url = typeof j?.url === 'string' ? j.url : '';
    if (j && /^https?:\/\//.test(url) && truthy(j.owner_token))
      return { url: url.replace(/\/+$/, ''), owner_token: String(j.owner_token) };
  } catch {
    /* none */
  }
  return null;
}
export function writeSecret(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
export function saveBrainLocation(home: string, loc: BrainLocation): void {
  writeSecret(brainFile(home), { url: loc.url, owner_token: loc.owner_token });
}
export function clearBrainLocation(home: string): void {
  for (const f of ['brain.json', 'cloud-device.json', 'cloud-device-collector-state.json'])
    fs.rmSync(path.join(home, f), { force: true });
}

export function ackKeepOn(s: SetupState, ack: unknown): SetupState {
  if (!s.brain) throw new Error('Choose the brain device first (step 3)');
  s.keepOn = truthy(ack);
  if (s.keepOn) s.step = 5;
  return s;
}

export function finish(s: SetupState): SetupState {
  if (!s.brain) throw new Error('Choose the brain device first (step 3)');
  if (!s.keepOn) throw new Error('Confirm that the brain device stays on (step 4)');
  s.done = true;
  s.step = 5;
  return s;
}

// ---------------------------------------------------------------- checks ----
function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      ...(env ? { env } : {}),
    }).trim();
  } catch {
    return null;
  }
}
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fake = (env['CC_SETUP_FAKE_MISSING'] ?? '').split(',');
  if (fake.includes(cmd)) return null;
  const pathVar = env['PATH'] ?? '';
  const found = run('sh', ['-c', `command -v ${cmd}`], pathVar ? { ...process.env, PATH: pathVar } : undefined);
  if (ne(found)) return found;
  const local = path.join(os.homedir(), '.local/bin/claude');
  return cmd === 'claude' && fs.existsSync(local) ? local : null;
}

/** macOS: does the application firewall block incoming connections to this node? (other devices
 * then get an empty reply; found in a real Docker pairing test, 2026-11-09). null = cannot tell.
 * The check itself is in lib/firewall.ts (pairing uses it too). */
export function firewallBlocksNode(env: NodeJS.ProcessEnv = process.env): boolean | null {
  return Firewall.blocksNodeSync(env);
}

export interface Action {
  id: string;
  label: string;
  note?: string;
}

export interface Check {
  id: string;
  title: string;
  ok: boolean;
  cause: string;
  fix: string;
  optional?: boolean;
  actions?: Action[];
  steps?: string[];
}

export interface CheckOptions {
  env?: NodeJS.ProcessEnv;
  brainUp?: unknown;
  otherDevices?: boolean;
  cloudHost?: string;
}

function codexCheck(o: string, env: NodeJS.ProcessEnv): Check {
  // Codex is optional: the panel works without it (Claude Code sessions); it is needed only to
  // start Codex sessions. A missing Codex is shown, with the fix, but never counts as a problem.
  const codex = which('codex', env);
  const codexHome = (env['CODEX_HOME'] ?? '') || path.join(os.homedir(), '.codex');
  const codexAuth = ne(env['OPENAI_API_KEY']) || fs.existsSync(path.join(codexHome, 'auth.json'));
  let cause = '';
  let fix = '';
  if (!ne(codex)) {
    cause = 'Codex is not installed. The panel works without it; you need it only to start Codex sessions.';
    fix = 'Install it, then sign in once:   npm install -g @openai/codex   then run: codex login';
  } else if (!codexAuth) {
    cause = 'Codex is installed but not signed in, so Codex sessions cannot start.';
    fix = 'Sign in once by running:   codex login';
  }
  let actions: { actions?: Action[] } = {};
  if (o === 'macos' && !ne(codex))
    actions = { actions: [{ id: 'install-codex', label: 'Install Codex', note: 'opens Terminal with the command' }] };
  else if (o === 'macos' && !codexAuth)
    actions = {
      actions: [{ id: 'codex-login', label: 'Sign in to Codex', note: 'opens Terminal with the command' }],
    };
  return {
    id: 'codex',
    title: 'Codex (optional)',
    optional: true,
    ok: ne(codex) && codexAuth,
    cause,
    fix,
    ...actions,
  };
}

function firewallCheck(blocked: boolean): Check {
  return {
    id: 'firewall',
    title: 'Other computers can reach this one',
    ok: !blocked,
    cause: blocked ? "Your Mac's firewall stops your other computers from connecting to Thoth." : '',
    fix: blocked
      ? `System Settings → Network → Firewall → Options: set "node" to Allow incoming connections. Or run: sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp ${process.execPath}`
      : '',
    ...(blocked
      ? {
          actions: [
            {
              id: 'firewall-allow',
              label: 'Allow other computers to connect',
              note: 'macOS asks for your Mac password once. That is all.',
            },
            { id: 'open-firewall', label: 'Open System Settings' },
          ],
          steps: [
            'In System Settings → Network, click Firewall, then Options…',
            'Find "node" in the list. If it is not there, click + and choose it: ' + process.execPath,
            'Set it to "Allow incoming connections", then click OK. This page checks again by itself.',
          ],
        }
      : {}),
  };
}

/** Checks for this machine. `brainUp` is the result of the brain health call. */
export function checks({
  env = process.env,
  brainUp = null,
  otherDevices = false,
  cloudHost = '',
}: CheckOptions = {}): Check[] {
  const o = thisOs();
  const pkg = (name: string): string =>
    o === 'macos' ? `brew install ${name}` : `sudo apt-get install -y ${name}   (Fedora: sudo dnf install -y ${name})`;
  const out: Check[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  out.push({
    id: 'node',
    title: `Node.js ${process.versions.node}`,
    ok: nodeMajor >= 22,
    cause: nodeMajor >= 22 ? '' : `The panel needs Node.js 22; this is ${process.versions.node}.`,
    fix: nodeMajor >= 22 ? '' : 'Run scripts/install.sh again: it downloads Node.js 22 for you.',
  });
  const tmux = ne(which('tmux', env));
  out.push({
    id: 'tmux',
    title: 'tmux (keeps sessions running)',
    ok: tmux,
    cause: tmux ? '' : 'tmux is missing, so the panel cannot run Claude sessions.',
    fix: tmux ? '' : pkg('tmux'),
    ...(!tmux && o === 'macos'
      ? { actions: [{ id: 'install-tmux', label: 'Install tmux', note: 'opens Terminal with the command' }] }
      : {}),
  });
  const claude = ne(which('claude', env));
  out.push({
    id: 'claude',
    title: 'Claude Code',
    ok: claude,
    cause: claude ? '' : 'Claude Code is not installed on this computer.',
    fix: claude
      ? ''
      : 'Install it, then log in once by running "claude":   curl -fsSL https://claude.ai/install.sh | bash',
    ...(!claude && o === 'macos'
      ? {
          actions: [{ id: 'install-claude', label: 'Install Claude Code', note: 'opens Terminal with the command' }],
        }
      : {}),
  });
  out.push(codexCheck(o, env));
  const py = ne(which('python3', env));
  out.push({
    id: 'python3',
    title: 'Python 3 (runs the brain)',
    ok: py,
    cause: py ? '' : 'python3 is missing, so the brain cannot run.',
    fix: py ? '' : pkg('python3'),
  });
  if (otherDevices && !cloudHost) {
    // a cloud brain: other computers connect out to it, not to this one
    const blocked = firewallBlocksNode(env);
    if (blocked !== null) out.push(firewallCheck(blocked));
  }
  const up = truthy(brainUp);
  if (brainUp !== null && cloudHost) {
    out.push({
      id: 'brain',
      title: 'Your cloud brain',
      ok: up,
      cause: up ? '' : `Your cloud brain at ${cloudHost} does not answer, or it refused this panel's key.`,
      fix: up
        ? ''
        : 'Check that the server is switched on. If it still fails, connect again with a new link in step 3 (manage page: Change the brain).',
    });
  } else if (brainUp !== null) {
    out.push({
      id: 'brain',
      title: 'Brain service',
      ok: up,
      cause: up ? '' : 'The brain service is not answering on this computer.',
      fix: up ? '' : 'Start it: python3 brain/brain.py serve   (step 4 can keep it running)',
    });
  }
  return out;
}

export interface KeepOn {
  ok: boolean;
  detail: string;
  fix: string;
  actions?: Action[];
  steps?: string[];
}

/** Can this machine stay on? macOS: pmset sleep; Linux: systemd sleep targets; WSL and Windows:
 * the Windows power settings. Plain words. */
export function keepOnCheck(env: NodeJS.ProcessEnv = process.env, wsl: boolean = isWsl()): KeepOn {
  const o = wsl ? 'windows' : thisOs();
  if (ne(env['CC_SETUP_FAKE_SLEEP']))
    return { ok: false, detail: 'This computer goes to sleep after 10 minutes.', fix: 'test fault' };
  if (o === 'macos') {
    const pm = run('pmset', ['-g']) ?? '';
    const m = /^\s*sleep\s+(\d+)/m.exec(pm);
    const mins = m ? Number(m[1]) : null;
    if (mins === 0)
      return { ok: true, detail: 'This Mac never sleeps on its own (System Settings → Energy).', fix: '' };
    return {
      ok: false,
      detail:
        mins !== null && !Number.isNaN(mins)
          ? `This Mac sleeps after ${String(mins)} minutes without use.`
          : 'Could not read the sleep setting.',
      fix: 'System Settings → Energy (or Battery → Options): turn on "Prevent automatic sleeping when the display is off", and keep it plugged in.',
      actions: [
        {
          id: 'keep-awake',
          label: 'Keep this Mac awake while plugged in',
          note: 'macOS asks for your Mac password once. That is all.',
        },
        { id: 'open-energy', label: 'Open System Settings' },
      ],
      steps: [
        'In System Settings → Battery, click Options…',
        'Turn on "Prevent automatic sleeping on power adapter when the display is off", then click Done.',
        'Keep this Mac plugged in. This page checks again by itself.',
      ],
    };
  }
  if (o === 'linux') {
    const masked = (run('systemctl', ['is-enabled', 'sleep.target']) ?? '').includes('masked');
    const server = !ne(env['DISPLAY']) && !ne(env['WAYLAND_DISPLAY']);
    if (masked || server)
      return {
        ok: true,
        detail: masked
          ? 'Sleep is turned off on this machine.'
          : 'This looks like a server without a desktop; servers normally do not sleep.',
        fix: '',
      };
    return {
      ok: false,
      detail: 'This Linux desktop may go to sleep.',
      fix: 'Turn off automatic suspend in Settings → Power, or run: sudo systemctl mask sleep.target suspend.target',
    };
  }
  return {
    ok: false,
    detail: 'Windows may go to sleep.',
    fix: 'Settings → System → Power: set "When plugged in, put my device to sleep after" to Never.',
  };
}

export interface DiagnosticsOptions {
  home: string;
  logFile: string;
  env?: NodeJS.ProcessEnv;
  brainUp?: unknown;
}

/** Plain-text report for "copy diagnostics": versions, checks, setup state, log tail. No tokens. */
export function diagnostics({ home, logFile, env = process.env, brainUp = null }: DiagnosticsOptions): string {
  const loc = loadBrainLocation(home);
  const claude = ne(which('claude', env)) ? (run('claude', ['--version']) ?? '') || 'found' : 'missing';
  const lines = [
    `Thoth diagnostics  ${new Date().toISOString()}`,
    `os: ${os.type()} ${os.release()} ${os.arch()}${isWsl() ? ' (WSL on Windows)' : ''}   node: ${process.versions.node}`,
    `tmux: ${(run('tmux', ['-V']) ?? '') || 'missing'}   python3: ${(run('python3', ['--version']) ?? '') || 'missing'}   claude: ${claude}`,
    '',
  ];
  if (loc) lines.push(`brain: cloud ${loc.url} (owner key kept in brain.json, not shown)`, '');
  for (const c of checks({ env, brainUp, cloudHost: loc ? loc.url : '' }))
    lines.push(`${c.ok ? 'ok  ' : 'FAIL'} ${c.title}${c.ok ? '' : `: ${c.cause} Fix: ${c.fix}`}`);
  const s = load(home);
  const brain = s.brain === CLOUD ? 'cloud' : s.brain || '-';
  const devices = s.devices
    .map(
      (d) => `${d.name}(${String(d.os)}${d.self === true ? ',this' : ''}${d.connected === true ? ',connected' : ''})`,
    )
    .join(' ');
  lines.push('', `setup: step ${String(s.step)}, done ${String(s.done)}, brain ${brain}, devices ${devices}`);
  try {
    const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n');
    lines.push('', 'server log (last 40 lines):', tail);
  } catch {
    /* no log */
  }
  return lines
    .join('\n')
    .replaceAll(/(Bearer\s+|token=)[\w.~+/=-]+/g, '[hidden]')
    .replaceAll(/(ccbrain:\/\/[^#\s]*#)[\w.~-]+/g, '$1[hidden]');
}
