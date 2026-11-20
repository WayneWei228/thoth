// `thoth setup` and `thoth doctor --json` (multi-device plan, PR 1: docs in bin/thoth).
// A new Mac runs ONE non-interactive command and becomes the owner's main or helper computer:
//   thoth setup --role main|helper [--connect <ccbrain://link>] [--join <code>] [--hub <cloud brain url>]
//               [--name <name>] [--wait <s>]
// 1. role: setup.json gets `role` and `done` (the app and the server skip the Setup page).
// 2. connect (main only): the owner connection, brain.json {url, owner_token} (0600), from --connect
//    (the link the cloud brain's install printed) or already there. Without it the main computer could
//    not see or approve other computers, so setup stops and setup.json stays not done.
// 3. join: this computer joins the CLOUD brain only (owner decision 2026-11-18: no LAN, no 7870
//    device listener, no SSH). It reuses device/device_agent.py's cloud path: a pre-approved code
//    joins at once; without a code it asks to join and the owner chooses Approve in Thoth. The device
//    token goes to <panel home>/cloud-device.json (0600), the file the server pushes sessions with.
// Every step is safe to run twice: a done step says "unchanged"; a pending request is polled again,
// never asked twice. Nothing here touches pmset or launchd (PR 2) and there is no heartbeat (PR 3).
// The logic takes its outside world as `Deps`, so a test runs it without a network.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { hostName, readJson } from './devices.ts';
import { WHERE as APPROVE_WHERE } from './join_requests.ts';
import * as Setup from './setup.ts';
import * as WslHost from './wsl_host.ts';

export type Role = 'main' | 'helper';
const ROLES: readonly Role[] = ['main', 'helper'];
const NAME = /^[a-z\d][a-z\d-]{0,30}$/;
const CODE = /^[A-Za-z\d]{4}-[A-Za-z\d]{4}(-[A-Za-z\d]{2})?$/;
/** The longest --wait: a script must not block for long (the prompt runs the command again). */
const MAX_WAIT_SECS = 600;

export interface SetupOptions {
  role: Role;
  join: string;
  hub: string;
  name: string;
  wait: number;
  /** main only: ccbrain://<host>/#<owner token> */
  connect: string;
}

export const USAGE =
  'usage: thoth setup --role main|helper [--connect <ccbrain://link>] [--join <code>] [--hub <https://cloud-brain>] [--name <name>] [--wait <seconds>]';

/** Parse `thoth setup` arguments. Throws a plain reason (with the usage line) on a bad one. */
export function parseArgs(argv: readonly string[]): SetupOptions {
  const o: SetupOptions = { role: 'main', join: '', hub: '', name: '', wait: 0, connect: '' };
  let role = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const eq = a.indexOf('=');
    const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const value = (): string => {
      if (key !== a) return a.slice(eq + 1);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n${USAGE}`);
      i++;
      return v;
    };
    if (key === '--role') role = value();
    else if (key === '--join') o.join = value().trim();
    else if (key === '--hub') o.hub = value().trim();
    else if (key === '--name') o.name = value().trim().toLowerCase();
    else if (key === '--wait') o.wait = Number(value());
    else if (key === '--connect') o.connect = value().trim();
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (!ROLES.includes(role as Role)) throw new Error(`--role must be main or helper\n${USAGE}`);
  o.role = role as Role;
  if (o.join && !CODE.test(o.join)) throw new Error(`--join: "${o.join}" is not a join code (like ABCD-EFGH-12)`);
  if (o.name && !NAME.test(o.name)) throw new Error(`--name: use letters, digits and "-" (up to 31)`);
  if (o.hub) o.hub = cloudHub(o.hub);
  if (o.connect) {
    if (o.role !== 'main') throw new Error('--connect is only for --role main (the owner connection)');
    if (!Setup.parseConnectLink(o.connect)) throw new Error('--connect: not a connect link (ccbrain://<host>/#<key>)');
  }
  if (!(Number.isFinite(o.wait) && o.wait >= 0 && o.wait <= MAX_WAIT_SECS))
    throw new Error(`--wait: seconds from 0 to ${String(MAX_WAIT_SECS)}`);
  return o;
}

/** The cloud brain's address as an origin. HTTPS only; plain HTTP only on this computer (a local
 * test brain). A LAN address over HTTP (the old 7870 device listener) is refused. */
export function cloudHub(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`--hub: "${raw}" is not an address (like https://brain.example.com)`);
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
    throw new Error(`--hub: the cloud brain needs https:// ("${raw}")`);
  return u.origin;
}

// ------------------------------------------------------------ the world ----
interface AgentRun {
  code: number;
  out: string;
}
export interface Deps {
  /** the panel home (CC_PANEL_HOME or ~/.config/cc-panel) */
  home: string;
  /** the device agent's file from device/join.sh (~/.cc-brain/device.json) */
  agentFile: string;
  /** GET <hub>/api/health: ok when it answers {ok: true} (a cloud brain) */
  health: (hub: string) => Promise<{ ok: boolean; error?: string }>;
  /** python3 device/device_agent.py <args> with CC_DEVICE_CONF=<home>/cloud-device.json and `env` */
  agent: (args: string[], env: Record<string, string>) => Promise<AgentRun>;
  /** an owner request to the brain (main only); defaults to brainRequest */
  owner?: typeof brainRequest;
}

export interface BrainReply {
  status: number;
  json: unknown;
}
/** A request to the brain with a bearer token. No redirects: an https brain must not send the
 * request (and the token) to another address. status 0: no answer. */
export async function brainRequest(url: string, method: string, token: string, body?: unknown): Promise<BrainReply> {
  try {
    const r = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as unknown };
  } catch {
    return { status: 0, json: null };
  }
}

/** GET <hub>/api/health: a cloud brain answers {ok: true}. */
export async function health(hub: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${hub}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => null)) as { ok?: unknown } | null;
    return r.ok && j?.ok === true
      ? { ok: true }
      : { ok: false, error: `status ${String(r.status)}, not a cloud brain` };
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    return { ok: false, error: cause?.code ?? cause?.message ?? (e as Error).message };
  }
}

/** The real device agent (python3 device/device_agent.py) of the app in `root`, with this panel's device file. */
export function agentRunner(root: string, home: string): Deps['agent'] {
  return (args, env) =>
    new Promise((resolve) => {
      const waitSecs = Number(env['CC_DEVICE_WAIT_SECS'] ?? 0);
      execFile(
        'python3',
        ['-I', path.join(root, 'device', 'device_agent.py'), ...args],
        // the agent's own requests time out after 120 s; a wait adds its seconds
        { env: { ...process.env, ...env, CC_DEVICE_CONF: deviceFile(home) }, timeout: (waitSecs + 150) * 1000 },
        (err, out, errOut) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, out: `${out}${errOut}${err && typeof err.code !== 'number' ? err.message : ''}` });
        },
      );
    });
}

interface DeviceConf {
  hub?: string;
  device?: string;
  token?: string;
  mode?: string;
  pending_id?: string;
}
const readConf = (file: string): DeviceConf | null => readJson(file) as DeviceConf | null;
export const deviceFile = (home: string): string => path.join(home, 'cloud-device.json');
const joinedConf = (c: DeviceConf | null): boolean => Boolean(c?.token) && c?.mode === 'cloud';

/** How this computer stands with the cloud brain: joined (panel file or device agent file),
 * waiting for Approve, or not joined. */
export function joinState(
  home: string,
  agentFile: string,
): { state: 'joined' | 'pending' | 'none'; hub: string; device: string; via?: 'panel' | 'agent' } {
  const own = readConf(deviceFile(home));
  if (own && joinedConf(own)) return { state: 'joined', hub: own.hub ?? '', device: own.device ?? '', via: 'panel' };
  const agent = readConf(agentFile);
  if (agent && joinedConf(agent))
    return { state: 'joined', hub: agent.hub ?? '', device: agent.device ?? '', via: 'agent' };
  if (own && typeof own.pending_id === 'string' && own.pending_id !== '' && own.mode === 'cloud')
    return { state: 'pending', hub: own.hub ?? '', device: own.device ?? '' };
  return { state: 'none', hub: '', device: '' };
}

/** The role in setup.json, or '' */
export function roleOf(home: string): Role | '' {
  const r = Setup.load(home)['role'];
  return ROLES.includes(r as Role) ? (r as Role) : '';
}

// ---------------------------------------------------------------- setup ----
export interface Step {
  step: 'role' | 'connect' | 'join';
  status: 'done' | 'unchanged' | 'pending' | 'failed';
  message: string;
}
export interface SetupResult {
  /** 0 done, 1 failed, 6 waiting for the owner's Approve (run the same command again) */
  code: number;
  steps: Step[];
}

/** Step 1: the role in setup.json; with `done`, setup counts as done, so the Setup page is skipped. */
export function writeRole(home: string, role: Role, done = true): Step {
  const s = Setup.load(home);
  if (s['role'] === role && (s.done || !done) && fs.existsSync(path.join(home, 'setup.json')))
    return { step: 'role', status: 'unchanged', message: `This computer is already the ${role} computer.` };
  const old = typeof s['role'] === 'string' ? s['role'] : '';
  s['role'] = role;
  if (done) {
    s.done = true;
    s.step = 5;
  }
  Setup.save(home, s);
  return {
    step: 'role',
    status: 'done',
    message: `Role set to ${role}${old && old !== role ? ` (was ${old})` : ''} in ${path.join(home, 'setup.json')}.`,
  };
}

/** After a join: the brain is the cloud brain (setup.json), so the LAN pairing stays off. */
function markCloud(home: string): void {
  const s = Setup.load(home);
  if (s.brain === Setup.CLOUD && s.keepOn) return;
  s.brain = Setup.CLOUD;
  s.keepOn = true;
  Setup.save(home, s);
}

/** Text without control characters (Unicode category Cc: ESC, BEL, DEL, ...). */
const printable = (t: string): string => t.replaceAll(/\p{Cc}/gu, '');
/** The last lines of the agent's output, without control characters (the text can hold the
 * brain's error message: a hostile brain must not move the cursor or retitle the terminal). */
const lastLines = (t: string, n = 3): string => printable(t.trim().split('\n').slice(-n).join(' ')).slice(0, 400);

/** Step 2: join the cloud brain (or see that this computer already did). */
async function joinCloud(o: SetupOptions, d: Deps): Promise<Step> {
  const step = (status: Step['status'], message: string): Step => ({ step: 'join', status, message });
  const now = joinState(d.home, d.agentFile);
  if (now.state === 'joined') {
    if (o.hub && now.hub !== o.hub)
      return step(
        'failed',
        `This computer already joined another brain (${now.hub}) as '${now.device}'. To move it, remove ${now.via === 'agent' ? d.agentFile : deviceFile(d.home)} and run this command again.`,
      );
    markCloud(d.home);
    return step('unchanged', `Already joined the cloud brain at ${now.hub} as '${now.device}'.`);
  }
  let hub = o.hub;
  if (!hub && now.state === 'pending') {
    try {
      hub = cloudHub(now.hub); // read from a file: the same rule as --hub
    } catch (e) {
      return step('failed', `${(e as Error).message} in ${deviceFile(d.home)}. Run again with --hub.`);
    }
  }
  if (!hub)
    return step('failed', 'Not joined to a brain yet. Add --hub <https address of your cloud brain> (shown in Thoth).');
  const h = await d.health(hub);
  if (!h.ok)
    return step(
      'failed',
      `The cloud brain at ${hub} does not answer${h.error === undefined ? '' : ` (${h.error})`}. Check the address.`,
    );

  // --wait 0: ask once (the agent sleeps a poll interval after a "pending" answer: keep it short too)
  const waitEnv = (secs: number): Record<string, string> => ({
    CC_DEVICE_WAIT_SECS: String(Math.max(secs, 0.1)),
    CC_DEVICE_POLL_SECS: String(Math.min(3, Math.max(secs, 0.1))),
  });
  const join = (): Promise<AgentRun> =>
    d.agent(['join', hub, ...(o.join ? [o.join] : []), ...(o.name ? ['--name', o.name] : []), '--no-wait'], {});
  let run: AgentRun;
  const asked = now.state === 'pending' && now.hub === hub && !o.join;
  if (asked && (!o.name || o.name === now.device)) {
    // asked before: ask the brain again, never a second request
    run = await d.agent(['wait'], waitEnv(o.wait));
    if (run.code === 5) {
      fs.rmSync(deviceFile(d.home), { force: true }); // the brain forgot the request: ask again
      run = await join();
    }
  } else {
    if (asked) fs.rmSync(deviceFile(d.home), { force: true }); // a new --name: ask again under it
    run = await join();
  }
  if (run.code === 6 && o.wait > 0) run = await d.agent(['wait'], waitEnv(o.wait));
  if (run.code === 4)
    return step('failed', 'The owner chose Ignore in Thoth. Ask them to choose Unignore, then run this command again.');
  // 0: joined or still waiting; 6: asked, waiting. Anything else failed (a wrong code leaves an
  // older pending request in place: report the failure, not "waiting")
  if (run.code !== 0 && run.code !== 6)
    return step('failed', `Joining failed: ${lastLines(run.out) || `device agent exit ${String(run.code)}`}`);
  const after = joinState(d.home, d.agentFile);
  if (after.state === 'joined' && after.hub === hub) {
    markCloud(d.home);
    return step('done', `Joined the cloud brain at ${hub} as '${after.device}'.`);
  }
  if (after.state === 'pending')
    return step('pending', `Asked the cloud brain at ${hub} to let '${after.device}' join.`);
  return step('failed', `Joining failed: ${lastLines(run.out) || `device agent exit ${String(run.code)}`}`);
}

/** Step 2, main only: the owner connection (brain.json). Returns the step and the brain location. */
async function connectOwner(o: SetupOptions, d: Deps): Promise<{ step: Step; loc: Setup.BrainLocation | null }> {
  const step = (status: Step['status'], message: string): Step => ({ step: 'connect', status, message });
  const old = Setup.loadBrainLocation(d.home);
  const p = o.connect ? Setup.parseConnectLink(o.connect) : null;
  if (!p) {
    if (old) return { step: step('unchanged', `Already connected as the owner of ${old.url}.`), loc: old };
    return {
      step: step(
        'failed',
        'A main computer needs the owner connection to see and approve your other computers. Add --connect <ccbrain://... link> (printed when your cloud brain was installed), or connect on the Setup page.',
      ),
      loc: null,
    };
  }
  // --hub may name the same host over plain http on this computer (a local test brain)
  let url = p.url;
  if (o.hub && o.hub !== url) {
    if (new URL(o.hub).host !== p.host)
      return { step: step('failed', `--hub ${o.hub} is not the brain of the --connect link (${p.host}).`), loc: null };
    url = o.hub;
  }
  if (old?.url === url && old.owner_token === p.token)
    return { step: step('unchanged', `Already connected as the owner of ${url}.`), loc: old };
  const r = await (d.owner ?? brainRequest)(`${url}/api/devices`, 'GET', p.token);
  if (r.status !== 200)
    return {
      step: step(
        'failed',
        r.status === 0
          ? `The cloud brain at ${url} does not answer. Check the link.`
          : `The cloud brain at ${url} refused the link (status ${String(r.status)}). Copy the whole link again.`,
      ),
      loc: null,
    };
  const loc = { url, owner_token: p.token };
  Setup.saveBrainLocation(d.home, loc);
  const s = Setup.load(d.home);
  s.brain = Setup.CLOUD;
  s.keepOn = true;
  s.cloud = { host: p.host, connectedAt: Date.now() };
  Setup.save(d.home, s);
  return { step: step('done', `Connected as the owner of ${url}${old ? ` (was ${old.url})` : ''}.`), loc };
}

/** A pre-approved code for this computer, made with the owner token (like the server's joinCloudSelf):
 * a taken name gets -2, -3, ... Returns the code or a reason. */
async function ownerCode(
  loc: Setup.BrainLocation,
  name: string,
  d: Deps,
): Promise<{ code: string; error?: undefined } | { code?: undefined; error: string }> {
  let r: BrainReply = { status: 0, json: null };
  for (let i = 1; i <= 5; i++) {
    const n = i === 1 ? name : `${name.slice(0, 28)}-${String(i)}`;
    r = await (d.owner ?? brainRequest)(`${loc.url}/api/codes`, 'POST', loc.owner_token, { device_name: n });
    if (r.status !== 409) break;
  }
  const code = (r.json as { code?: unknown } | null)?.code;
  if (r.status === 200 && typeof code === 'string') return { code };
  return { error: `The cloud brain did not make a code for this computer (status ${String(r.status)}).` };
}

export async function setup(o: SetupOptions, d: Deps): Promise<SetupResult> {
  let steps: Step[];
  if (o.role === 'main') {
    const c = await connectOwner(o, d);
    if (!c.loc) steps = [writeRole(d.home, o.role, false), c.step];
    else {
      const role = writeRole(d.home, o.role);
      let join = o.join;
      const now = joinState(d.home, d.agentFile);
      let codeError = '';
      if (!join && now.state !== 'joined') {
        const made = await ownerCode(c.loc, o.name || hostName(), d);
        join = made.code ?? '';
        codeError = made.error ?? '';
      }
      const j: Step = codeError
        ? { step: 'join', status: 'failed', message: codeError }
        : await joinCloud({ ...o, hub: c.loc.url, join, name: o.name || (join ? hostName() : '') }, d);
      steps = [role, c.step, j];
    }
  } else steps = [writeRole(d.home, o.role), await joinCloud(o, d)];
  const code = steps.some((s) => s.status === 'failed') ? 1 : steps.some((s) => s.status === 'pending') ? 6 : 0;
  return { code, steps };
}

export function formatSetup(r: SetupResult): string {
  const mark = { done: 'done     ', unchanged: 'unchanged', pending: 'waiting  ', failed: 'FAILED   ' };
  const lines = r.steps.map((s) => `  ${mark[s.status]}  ${s.step}: ${printable(s.message)}`);
  let tail = 'Setup is complete.';
  if (r.code === 6)
    tail = `Waiting for Approve.\n${APPROVE_WHERE}\nAfter the owner chooses Approve there, run the same command again.`;
  else if (r.code !== 0) tail = 'Setup is not complete. Fix the step above and run the same command again.';
  return ['Thoth setup', ...lines, tail].join('\n');
}

// --------------------------------------------------------- doctor --json ----
export interface DoctorDeps extends Pick<Deps, 'home' | 'agentFile' | 'health'> {
  appDir: string;
  nodeVersion: string;
  /** the path of a command, or null */
  which: (cmd: string) => string | null;
  claudeLoggedIn: () => boolean;
  /** this Linux runs inside WSL on a Windows PC (lib/wsl.ts isWsl) */
  wsl?: boolean;
  /** run a command with a short timeout: its output, or null when it fails (only for the WSL checks) */
  run?: (cmd: string, args: string[]) => string | null;
}
interface DoctorCheck {
  id:
    | 'installed'
    | 'role'
    | 'owner'
    | 'joined'
    | 'claude'
    | 'claude_login'
    | 'brain'
    | 'wsl_systemd'
    | 'wsl_interop'
    | 'windows_build';
  ok: boolean;
  detail: string;
  fix: string;
}
export interface DoctorReport {
  ok: boolean;
  role: Role | '';
  device: string;
  hub: string;
  /** macos, linux, windows, or windows-wsl */
  os: string;
  checks: DoctorCheck[];
}

const WSL_SYSTEMD_FIX =
  'turn on systemd: sudo sh -c \'printf "[boot]\\nsystemd=true\\n" >> /etc/wsl.conf\', then in Windows (PowerShell) run: wsl.exe --shutdown, and open Ubuntu again';
const WSL_INTEROP_FIX =
  'turn on Windows interop: in /etc/wsl.conf remove "enabled=false" under [interop] and "appendWindowsPath=false", then in Windows (PowerShell) run: wsl.exe --shutdown, and open Ubuntu again';

/** The WSL checks: systemd (the Thoth services are systemd user units), interop (Thoth reads the
 * Windows power state through powershell.exe), and a Windows build that runs WSL 2. */
function wslChecks(run: NonNullable<DoctorDeps['run']>, add: (c: DoctorCheck) => void): void {
  const systemd = run('systemctl', ['--user', 'show-environment']) !== null;
  add({
    id: 'wsl_systemd',
    ok: systemd,
    detail: systemd ? 'systemd is on in WSL' : 'systemd is off in WSL (systemctl --user does not answer)',
    fix: WSL_SYSTEMD_FIX,
  });
  const [cmd, args] = WslHost.BUILD_CMD;
  const out = run(cmd, args);
  const build = WslHost.buildFrom(out);
  add({
    id: 'wsl_interop',
    ok: out !== null,
    detail: out === null ? 'powershell.exe does not run from WSL' : 'Windows programs run from WSL',
    fix: WSL_INTEROP_FIX,
  });
  if (out === null) return;
  // a build that cannot be read (an extra line, a warning) is not a reason to update Windows
  add({
    id: 'windows_build',
    ok: build === null || build >= WslHost.MIN_BUILD,
    detail: build === null ? 'Windows build could not be read' : `Windows build ${String(build)}`,
    fix: `WSL 2 needs Windows 10 version 2004 (build ${String(WslHost.MIN_BUILD)}) or newer: run Windows Update`,
  });
}

/** Machine-readable checks for `thoth doctor --json` (the setup prompt reads them). */
export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: DoctorCheck['id'], ok: boolean, detail: string, fix: string): void => {
    checks.push({ id, ok, detail, fix: ok ? '' : fix });
  };
  const missing: string[] = [];
  const [major = 0, minor = 0] = d.nodeVersion.replace(/^v/, '').split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 18))) missing.push(`Node.js 22.18+ (found ${d.nodeVersion})`);
  if (!fs.existsSync(path.join(d.appDir, 'server.ts'))) missing.push(`Thoth (${d.appDir}/server.ts)`);
  for (const c of ['tmux', 'python3']) if (d.which(c) === null) missing.push(c);
  add(
    'installed',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `Thoth in ${d.appDir}`,
    'run the one-line install command from the Thoth website again (curl ... install.sh | bash)',
  );
  const role = roleOf(d.home);
  add(
    'role',
    role !== '',
    role ? `${role} computer` : 'no role set',
    'thoth setup --role main|helper --hub <cloud brain>',
  );
  if (role === 'main') {
    const loc = Setup.loadBrainLocation(d.home);
    add(
      'owner',
      loc !== null,
      loc ? `owner of ${loc.url}` : 'no owner connection (brain.json)',
      'thoth setup --role main --connect <ccbrain://... link>',
    );
  }
  const j = joinState(d.home, d.agentFile);
  const joinDetail = {
    joined: `joined ${j.hub} as '${j.device}'`,
    pending: `asked ${j.hub} to join as '${j.device}'; waiting for Approve`,
    none: 'not joined to a cloud brain',
  }[j.state];
  add(
    'joined',
    j.state === 'joined',
    joinDetail,
    j.state === 'pending'
      ? 'Approve this computer in Thoth on the main computer, then run thoth setup again'
      : 'thoth setup --role main|helper --hub <cloud brain> [--join <code>]',
  );
  const claude = d.which('claude');
  add('claude', claude !== null, claude ?? 'claude not found', 'curl -fsSL https://claude.ai/install.sh | bash');
  const login = claude !== null && d.claudeLoggedIn();
  add('claude_login', login, login ? 'logged in' : 'no Claude login found', 'run: claude   then type /login');
  let hubOk = true;
  try {
    if (j.hub) cloudHub(j.hub);
  } catch {
    hubOk = false;
  }
  if (j.hub && !hubOk)
    add(
      'brain',
      false,
      `${j.hub} is not a cloud brain address`,
      'thoth setup --role main|helper --hub <https address>',
    );
  else if (j.hub) {
    const h = await d.health(j.hub);
    add(
      'brain',
      h.ok,
      h.ok ? `${j.hub} answers` : `${j.hub} does not answer${h.error === undefined ? '' : ` (${h.error})`}`,
      'check the network; the cloud brain must be switched on',
    );
  } else add('brain', false, 'no cloud brain yet', 'thoth setup --role main|helper --hub <cloud brain>');
  const wsl = d.wsl === true && d.run !== undefined;
  if (wsl && d.run)
    wslChecks(d.run, (c) => {
      add(c.id, c.ok, c.detail, c.fix);
    });
  const os = wsl ? WslHost.WSL_OS : Setup.thisSystem(false);
  return { ok: checks.every((c) => c.ok), role, device: j.device, hub: j.hub, os, checks };
}
