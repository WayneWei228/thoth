'use strict';
// First-run setup wizard.
// Steps: 1 devices, 2 connect them, 3 your brain (cloud or a computer), 4 keep the brain on (skipped
// for a cloud brain), 5 index and move in.
// State lives in <panel home>/setup.json so closing and reopening resumes at the same step.
// The brain location lives in <panel home>/brain.json (0600):
// { url, owner_token }. No brain.json = the local brain on 127.0.0.1 (as before).
// Every check returns { id, title, ok, cause, fix } in plain words: the page shows them as they are.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const CLOUD = ':cloud';   // s.brain for a cloud brain (never a device name: NAME has no ':')
const OSES = ['macos', 'linux', 'windows'];

function thisOs() {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
}
function hostName() {
  return (os.hostname().split('.')[0] || 'this-computer').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 31) || 'this-computer';
}

function defaultState() {
  return { version: 1, done: false, step: 1, brain: '', keepOn: false,
    devices: [{ name: hostName(), os: thisOs(), self: true }] };
}

function file(home) { return path.join(home, 'setup.json'); }

function load(home) {
  try {
    const s = JSON.parse(fs.readFileSync(file(home), 'utf8'));
    if (s && s.version === 1 && Array.isArray(s.devices)) return s;
  } catch { /* first run */ }
  return defaultState();
}

function save(home, s) {
  fs.mkdirSync(home, { recursive: true });
  const tmp = file(home) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, file(home));
  return s;
}

/** Step 1: the user's devices (this one is always there). Throws with a plain reason. */
function setDevices(s, list) {
  if (!Array.isArray(list)) throw new Error('Send a list of devices');
  const self = s.devices.find((d) => d.self);
  const out = [self];
  for (const d of list) {
    const name = String((d && d.name) || '').trim().toLowerCase();
    const dos = String((d && d.os) || '').toLowerCase();
    if (!NAME.test(name)) throw new Error(`Device name "${d && d.name}" is not allowed: use letters, digits and "-" (up to 31)`);
    if (!OSES.includes(dos)) throw new Error(`Choose macOS, Linux or Windows for "${name}"`);
    if (out.some((x) => x.name === name)) throw new Error(`Two devices are called "${name}"`);
    const old = s.devices.find((x) => x.name === name && !x.self) || {};
    out.push({ ...old, name, os: dos });
  }
  s.devices = out;
  if (s.brain && s.brain !== CLOUD && !out.some((d) => d.name === s.brain)) s.brain = '';
  s.step = Math.max(s.step, 2);
  return s;
}

function setStep(s, step) {
  const n = Number(step);
  if (!(n >= 1 && n <= 5)) throw new Error('Steps are 1 to 5');
  if (n === 4 && s.brain === CLOUD) throw new Error('A cloud brain is always on: there is no step 4');
  if (n >= 4 && !s.brain) throw new Error('Choose the brain device first (step 3)');
  if (n >= 5 && !s.keepOn) throw new Error('Confirm that the brain device stays on (step 4)');
  s.step = n;
  return s;
}

function setBrain(s, device) {
  const d = s.devices.find((x) => x.name === device);
  if (!d) throw new Error(`"${device}" is not one of your devices`);
  if (!d.self && !d.connected) throw new Error(`"${device}" is not connected yet. Connect it in step 2, or choose this device`);
  s.brain = d.name;
  s.keepOn = false;
  delete s.cloud;
  s.step = 4;
  return s;
}

/** Step 3, cloud: the panel is connected to a cloud brain. A server is always on, so step 4 is
 * not needed. With other computers listed, go back to step 2 so they join the cloud brain. */
function setCloud(s, host) {
  s.brain = CLOUD;
  s.keepOn = true;
  s.cloud = { host, connectedAt: Date.now() };
  if (!s.done) s.step = s.devices.some((d) => !d.self) ? 2 : 5;
  return s;
}

// ------------------------------------------------------- brain location ----
const LINK = /^ccbrain:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)\/?#([A-Za-z0-9._~-]{16,200})$/;
/** Parse a connect link `ccbrain://<host>/#<owner-token>`. Returns { host, url, token } or null. */
function parseConnectLink(link) {
  const m = String(link || '').trim().match(LINK);
  if (!m) return null;
  return { host: m[1].toLowerCase(), url: `https://${m[1].toLowerCase()}`, token: m[2] };
}
function brainFile(home) { return path.join(home, 'brain.json'); }
/** The brain location: { url, owner_token } for a cloud brain, or null (the local brain). */
function loadBrainLocation(home) {
  try {
    const j = JSON.parse(fs.readFileSync(brainFile(home), 'utf8'));
    if (j && /^https?:\/\//.test(j.url || '') && j.owner_token) return { url: String(j.url).replace(/\/+$/, ''), owner_token: String(j.owner_token) };
  } catch { /* none */ }
  return null;
}
function writeSecret(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
function saveBrainLocation(home, loc) { writeSecret(brainFile(home), { url: loc.url, owner_token: loc.owner_token }); }
function clearBrainLocation(home) {
  for (const f of ['brain.json', 'cloud-device.json', 'cloud-device-collector-state.json']) fs.rmSync(path.join(home, f), { force: true });
}

function ackKeepOn(s, ack) {
  if (!s.brain) throw new Error('Choose the brain device first (step 3)');
  s.keepOn = !!ack;
  if (s.keepOn) s.step = 5;
  return s;
}

function finish(s) {
  if (!s.brain) throw new Error('Choose the brain device first (step 3)');
  if (!s.keepOn) throw new Error('Confirm that the brain device stays on (step 4)');
  s.done = true;
  s.step = 5;
  return s;
}

// ---------------------------------------------------------------- checks ----
function run(cmd, args, env) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, ...(env ? { env } : {}) }).trim(); } catch { return null; }
}
function which(cmd, env) {
  const fake = (env.CC_SETUP_FAKE_MISSING || '').split(',');
  if (fake.includes(cmd)) return null;
  return run('sh', ['-c', `command -v ${cmd}`], env.PATH ? { ...process.env, PATH: env.PATH } : undefined) || (cmd === 'claude' && fs.existsSync(path.join(os.homedir(), '.local/bin/claude')) ? path.join(os.homedir(), '.local/bin/claude') : null);
}

/** Checks for this machine. `brainUp` is the result of the brain health call. */
/** macOS: does the application firewall block incoming connections to this node? (other devices
 * then get an empty reply; found in a real Docker pairing test, 2026-11-09). null = cannot tell. */
function firewallBlocksNode(env = process.env) {
  if (env.CC_SETUP_FAKE_FIREWALL) return true;
  if (process.platform !== 'darwin') return null;
  const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw';
  const state = run(fw, ['--getglobalstate']) || '';
  if (!/enabled/i.test(state)) return false;
  if (/enabled/i.test(run(fw, ['--getblockall']) || '')) return true;
  const app = run(fw, ['--getappblocked', process.execPath]) || '';
  return /is blocked/i.test(app);
}

function checks({ env = process.env, brainUp = null, otherDevices = false, cloudHost = '' } = {}) {
  const o = thisOs();
  const pkg = (name) => (o === 'macos' ? `brew install ${name}` : `sudo apt-get install -y ${name}   (Fedora: sudo dnf install -y ${name})`);
  const out = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  out.push({ id: 'node', title: `Node.js ${process.versions.node}`, ok: nodeMajor >= 22,
    cause: nodeMajor >= 22 ? '' : `The panel needs Node.js 22; this is ${process.versions.node}.`,
    fix: nodeMajor >= 22 ? '' : 'Run scripts/install.sh again: it downloads Node.js 22 for you.' });
  const tmux = which('tmux', env);
  out.push({ id: 'tmux', title: 'tmux (keeps sessions running)', ok: !!tmux,
    cause: tmux ? '' : 'tmux is missing, so the panel cannot run Claude sessions.', fix: tmux ? '' : pkg('tmux'),
    ...(!tmux && o === 'macos' ? { actions: [{ id: 'install-tmux', label: 'Install tmux', note: 'opens Terminal with the command' }] } : {}) });
  const claude = which('claude', env);
  out.push({ id: 'claude', title: 'Claude Code', ok: !!claude,
    cause: claude ? '' : 'Claude Code is not installed on this computer.',
    fix: claude ? '' : 'Install it, then log in once by running "claude":   curl -fsSL https://claude.ai/install.sh | bash',
    ...(!claude && o === 'macos' ? { actions: [{ id: 'install-claude', label: 'Install Claude Code', note: 'opens Terminal with the command' }] } : {}) });
  // Codex is optional: the panel works without it (Claude Code sessions); it is needed only to
  // start Codex sessions. A missing Codex is shown, with the fix, but never counts as a problem.
  const codex = which('codex', env);
  const codexAuth = !!env.OPENAI_API_KEY || fs.existsSync(path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'));
  out.push({ id: 'codex', title: 'Codex (optional)', optional: true, ok: !!codex && codexAuth,
    cause: !codex ? 'Codex is not installed. The panel works without it; you need it only to start Codex sessions.'
      : !codexAuth ? 'Codex is installed but not signed in, so Codex sessions cannot start.' : '',
    fix: !codex ? 'Install it, then sign in once:   npm install -g @openai/codex   then run: codex login'
      : !codexAuth ? 'Sign in once by running:   codex login' : '',
    ...(o === 'macos' && !codex ? { actions: [{ id: 'install-codex', label: 'Install Codex', note: 'opens Terminal with the command' }] }
      : o === 'macos' && !codexAuth ? { actions: [{ id: 'codex-login', label: 'Sign in to Codex', note: 'opens Terminal with the command' }] } : {}) });
  const py = which('python3', env);
  out.push({ id: 'python3', title: 'Python 3 (runs the brain)', ok: !!py,
    cause: py ? '' : 'python3 is missing, so the brain cannot run.', fix: py ? '' : pkg('python3') });
  if (otherDevices && !cloudHost) {   // a cloud brain: other computers connect out to it, not to this one
    const blocked = firewallBlocksNode(env);
    if (blocked !== null) out.push({ id: 'firewall', title: 'Other computers can reach this one', ok: !blocked,
      cause: blocked ? 'Your Mac\'s firewall stops your other computers from connecting to Thoth.' : '',
      fix: blocked ? `System Settings → Network → Firewall → Options: set "node" to Allow incoming connections. Or run: sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp ${process.execPath}` : '',
      ...(blocked ? { actions: [{ id: 'firewall-allow', label: 'Allow other computers to connect', note: 'macOS asks for your Mac password once. That is all.' },
                                { id: 'open-firewall', label: 'Open System Settings' }],
        steps: ['In System Settings → Network, click Firewall, then Options…',
                'Find "node" in the list. If it is not there, click + and choose it: ' + process.execPath,
                'Set it to "Allow incoming connections", then click OK. This page checks again by itself.'] } : {}) });
  }
  if (brainUp !== null && cloudHost) {
    out.push({ id: 'brain', title: 'Your cloud brain', ok: !!brainUp,
      cause: brainUp ? '' : `Your cloud brain at ${cloudHost} does not answer, or it refused this panel's key.`,
      fix: brainUp ? '' : 'Check that the server is switched on. If it still fails, connect again with a new link in step 3 (manage page: Change the brain).' });
  } else if (brainUp !== null) {
    out.push({ id: 'brain', title: 'Brain service', ok: !!brainUp,
      cause: brainUp ? '' : 'The brain service is not answering on this computer.',
      fix: brainUp ? '' : 'Start it: python3 brain/brain.py serve   (step 4 can keep it running)' });
  }
  return out;
}

/** Can this machine stay on? macOS: pmset sleep; Linux: systemd sleep targets. Plain words. */
function keepOnCheck(env = process.env) {
  const o = thisOs();
  if (env.CC_SETUP_FAKE_SLEEP) return { ok: false, detail: 'This computer goes to sleep after 10 minutes.', fix: 'test fault' };
  if (o === 'macos') {
    const pm = run('pmset', ['-g']) || '';
    const m = pm.match(/^\s*sleep\s+(\d+)/m);
    const mins = m ? Number(m[1]) : null;
    if (mins === 0) return { ok: true, detail: 'This Mac never sleeps on its own (System Settings → Energy).', fix: '' };
    return { ok: false, detail: mins ? `This Mac sleeps after ${mins} minutes without use.` : 'Could not read the sleep setting.',
      fix: 'System Settings → Energy (or Battery → Options): turn on "Prevent automatic sleeping when the display is off", and keep it plugged in.',
      actions: [{ id: 'keep-awake', label: 'Keep this Mac awake while plugged in', note: 'macOS asks for your Mac password once. That is all.' },
                { id: 'open-energy', label: 'Open System Settings' }],
      steps: ['In System Settings → Battery, click Options…', 'Turn on "Prevent automatic sleeping on power adapter when the display is off", then click Done.', 'Keep this Mac plugged in. This page checks again by itself.'] };
  }
  if (o === 'linux') {
    const masked = (run('systemctl', ['is-enabled', 'sleep.target']) || '').includes('masked');
    const server = !env.DISPLAY && !env.WAYLAND_DISPLAY;
    if (masked || server) return { ok: true, detail: masked ? 'Sleep is turned off on this machine.' : 'This looks like a server without a desktop; servers normally do not sleep.', fix: '' };
    return { ok: false, detail: 'This Linux desktop may go to sleep.', fix: 'Turn off automatic suspend in Settings → Power, or run: sudo systemctl mask sleep.target suspend.target' };
  }
  return { ok: false, detail: 'Windows may go to sleep.', fix: 'Settings → System → Power: set "When plugged in, put my device to sleep after" to Never.' };
}

/** Plain-text report for "copy diagnostics": versions, checks, setup state, log tail. No tokens. */
function diagnostics({ home, logFile, env = process.env, brainUp = null }) {
  const loc = loadBrainLocation(home);
  const lines = [`Thoth diagnostics  ${new Date().toISOString()}`,
    `os: ${os.type()} ${os.release()} ${os.arch()}   node: ${process.versions.node}`,
    `tmux: ${run('tmux', ['-V']) || 'missing'}   python3: ${run('python3', ['--version']) || 'missing'}   claude: ${which('claude', env) ? (run('claude', ['--version']) || 'found') : 'missing'}`, ''];
  if (loc) lines.push(`brain: cloud ${loc.url} (owner key kept in brain.json, not shown)`, '');
  for (const c of checks({ env, brainUp, cloudHost: loc ? loc.url : '' })) lines.push(`${c.ok ? 'ok  ' : 'FAIL'} ${c.title}${c.ok ? '' : `: ${c.cause} Fix: ${c.fix}`}`);
  const s = load(home);
  lines.push('', `setup: step ${s.step}, done ${s.done}, brain ${s.brain === CLOUD ? 'cloud' : s.brain || '-'}, devices ${s.devices.map((d) => `${d.name}(${d.os}${d.self ? ',this' : ''}${d.connected ? ',connected' : ''})`).join(' ')}`);
  try {
    const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n');
    lines.push('', 'server log (last 40 lines):', tail);
  } catch { /* no log */ }
  return lines.join('\n').replace(/(Bearer\s+|token=)[A-Za-z0-9._~+\/=-]+/g, '[hidden]')
    .replace(/(ccbrain:\/\/[^#\s]*#)[A-Za-z0-9._~-]+/g, '$1[hidden]');
}

module.exports = { firewallBlocksNode, load, save, defaultState, setDevices, setStep, setBrain, setCloud, ackKeepOn, finish, checks, keepOnCheck, diagnostics, thisOs, hostName,
  CLOUD, parseConnectLink, loadBrainLocation, saveBrainLocation, clearBrainLocation, writeSecret };
