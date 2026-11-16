'use strict';
// macOS permissions for Claude sessions in Thoth (Accessibility, Screen Recording), shown on the
// setup page like `agent-desktop permissions --guide` (user, 2026-11-15): detect the state, open the
// exact System Settings pane, show which app to drag into the list, check again until it is granted.
//
// macOS grants these per app: a process gets the grant of its "responsible" app (the app that
// started it, for Thoth sessions normally ~/Applications/Thoth.app). So the state is read by
// lib/permission_probe.py run INSIDE the panel's tmux server (`tmux run-shell`): the same app as
// the sessions. No tmux server yet: the probe runs from this server. No Python: `agent-desktop
// permissions` gives the state if it is installed (then the app to add is the default Thoth.app).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PANE = 'x-apple.systempreferences:com.apple.preference.security?';
const PERMS = [
  { id: 'accessibility', name: 'Accessibility', pane: PANE + 'Privacy_Accessibility',
    why: 'Claude sessions in Thoth cannot click or type in other apps (for example with agent-desktop).' },
  { id: 'screen_recording', name: 'Screen Recording', pane: PANE + 'Privacy_ScreenCapture',
    why: 'Claude sessions in Thoth cannot take screenshots of the screen or of other apps.' },
];
const DEFAULT_APP = path.join(os.homedir(), 'Applications', 'Thoth.app');

/** The app bundle that holds `bin` ("/A/Thoth.app/Contents/MacOS/X" -> "/A/Thoth.app"), else bin. */
function appOf(bin) {
  const m = String(bin || '').match(/^(.*?\.app)\//);
  return m ? m[1] : String(bin || '');
}
const appName = (p) => path.basename(p).replace(/\.app$/, '');

/** Parse the probe's (or agent-desktop's) output into { accessibility, screen_recording, app } or null. */
function parse(out) {
  const line = String(out || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  if (!line) return null;
  let j; try { j = JSON.parse(line); } catch { return null; }
  const d = j.data && j.command === 'permissions' ? j.data : j;   // agent-desktop wraps it in { data }
  const st = (v) => { const s = v && typeof v === 'object' ? v.state : v; return s === 'granted' || s === 'denied' ? s : 'unknown'; };
  const r = { accessibility: st(d.accessibility), screen_recording: st(d.screen_recording), app: d.responsible ? appOf(d.responsible) : '' };
  return r.accessibility === 'unknown' && r.screen_recording === 'unknown' ? null : r;
}

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function run(cmd, args, ms = 3000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: ms }, (e, out) => resolve(e ? '' : String(out))));
}
/** A python3 that will not pop up the "install developer tools" window (/usr/bin/python3 does without them). */
function python() {
  for (const p of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3']) if (fs.existsSync(p)) return p;
  const tools = ['/Library/Developer/CommandLineTools/usr/bin/python3', '/Applications/Xcode.app'];
  return tools.some((p) => fs.existsSync(p)) ? '/usr/bin/python3' : '';
}
function agentDesktop() {
  for (const p of ['/opt/homebrew/bin/agent-desktop', '/usr/local/bin/agent-desktop']) if (fs.existsSync(p)) return p;
  return '';
}

/** Read the state now. `tmuxArgs` selects the panel's tmux server. Never prompts, never opens a window. */
async function probe({ tmuxArgs = ['-u'], env = process.env } = {}) {
  if (env.CC_SETUP_FAKE_PERMS) {   // tests: "accessibility=denied,screen_recording=granted", or a file that holds it
    const f = env.CC_SETUP_FAKE_PERMS, text = f.startsWith('/') ? fs.readFileSync(f, 'utf8').trim() : f;
    const kv = Object.fromEntries(text.split(',').map((p) => p.split('=')));
    return { accessibility: kv.accessibility || 'unknown', screen_recording: kv.screen_recording || 'unknown', app: kv.app || DEFAULT_APP };
  }
  if (process.platform !== 'darwin') return null;
  const py = python(), ad = agentDesktop();
  const cmds = [py && [py, '-I', path.join(__dirname, 'permission_probe.py')], ad && [ad, 'permissions']].filter(Boolean);
  for (const c of cmds) {
    const r = parse(await run('tmux', [...tmuxArgs, 'run-shell', c.map(sh).join(' ')])) || parse(await run(c[0], c.slice(1)));
    if (r) return { ...r, app: r.app || DEFAULT_APP };
  }
  return null;
}

let cache = { at: 0, value: null, pending: null };
/** probe() at most once per 1.5 s (the setup page asks every 2 s while the user fixes something). */
function state(opts) {
  if (Date.now() - cache.at < 1500) return Promise.resolve(cache.value);
  if (!cache.pending) cache.pending = probe(opts).then((v) => { cache = { at: Date.now(), value: v, pending: null }; return v; }, () => { cache.pending = null; return null; });
  return cache.pending;
}
const lastApp = () => (cache.value && cache.value.app) || DEFAULT_APP;

/** Setup checks (lib/setup.js shape) for a probe result: one per permission, optional, with the guide. */
function checks(st) {
  if (!st) return [];
  const app = st.app || DEFAULT_APP, name = appName(app);
  const where = app.startsWith(os.homedir() + '/') ? '~' + app.slice(os.homedir().length) : app;
  return PERMS.filter((p) => st[p.id] !== 'unknown').map((p) => {
    const ok = st[p.id] === 'granted';
    return { id: p.id, perm: true, optional: true, title: `${p.name} for ${name}`, ok, name: p.name, pane: p.pane, app,
      cause: ok ? '' : p.why,
      fix: ok ? '' : `System Settings → Privacy & Security → ${p.name}: add ${where} and turn it on. If it is already in the list, turn it off and on again (a new build of ${name} can make macOS forget the old permission).`,
      ...(ok ? {} : {
        actions: [{ id: `perm-${p.id}`, label: `Open ${p.name} settings`, note: `System Settings opens, and Finder shows ${name}. Drag ${name} into the list.` }],
        steps: [
          `System Settings opens at Privacy & Security → ${p.name}. A Finder window shows ${name} (${where}).`,
          `Drag ${name} from Finder into the list. Or click + below the list and choose ${where}.`,
          `Turn the switch next to ${name} on. macOS asks for Touch ID or your password.`,
          `Already in the list and switched on, but this page still says no? Turn it off and on again. A new build of ${name} can make macOS forget the old permission.`,
          ...(p.id === 'screen_recording' ? [`If macOS asks to quit and reopen ${name}, you can: sessions keep running.`] : []),
          'This page checks again every 2 seconds and says when it works.',
        ] }) };
  });
}

module.exports = { PERMS, DEFAULT_APP, appOf, parse, probe, state, lastApp, checks, _reset: () => { cache = { at: 0, value: null, pending: null }; } };
