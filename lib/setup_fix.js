'use strict';
// Guided fixes for the setup page (user, 2026-11-09: "the page pops up, a button tells the user
// what to add, System Settings opens and the page guides them"). A fixed list only; the server
// runs them on this Mac for a request from this Mac (server.js checks the address).
//   settings: open the exact System Settings page (`reveal`: also show the app in Finder, to drag
//             it into a Privacy & Security list, as `agent-desktop permissions --guide` does)
//   admin:    run one command with the normal macOS password prompt
//   terminal: open Terminal with an install command typed in (the user sees what runs)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { PERMS } = require('./permissions');

const FIXES = {
  'open-firewall': { kind: 'settings', url: 'x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall' },
  'firewall-allow': { kind: 'admin', prompt: 'Thoth wants to let your other computers connect to this Mac.',
    cmd: (node) => `/usr/libexec/ApplicationFirewall/socketfilterfw --add '${node}' >/dev/null; /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp '${node}'` },
  'open-energy': { kind: 'settings', url: 'x-apple.systempreferences:com.apple.Battery-Settings.extension' },
  'keep-awake': { kind: 'admin', prompt: 'Thoth wants this Mac to stay awake while it is plugged in.', cmd: () => 'pmset -c sleep 0' },
  ...Object.fromEntries(PERMS.map((p) => [`perm-${p.id}`, { kind: 'settings', reveal: true, url: p.pane }])),   // lib/permissions.js
  'install-tmux': { kind: 'terminal', cmd: 'brew install tmux' },
  'install-claude': { kind: 'terminal', cmd: 'curl -fsSL https://claude.ai/install.sh | bash' },
  'install-codex': { kind: 'terminal', cmd: 'npm install -g @openai/codex && codex login' },
  'codex-login': { kind: 'terminal', cmd: 'codex login' },
};

const asq = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');   // AppleScript string

function osa(script) {
  return new Promise((resolve) => execFile('osascript', ['-e', script], { timeout: 300000 }, (err, out, errOut) =>
    resolve(err ? { ok: false, error: String(errOut || err.message).trim() } : { ok: true, out: String(out).trim() })));
}

/** Run fix `id`. Returns { ok, kind, message } in plain words. `app`: the app a `reveal` fix shows in Finder. */
async function runFix(id, { env = process.env, node = process.execPath, app = '' } = {}) {
  const f = FIXES[id];
  if (!f) throw new Error(`Unknown fix "${id}"`);
  if (process.platform !== 'darwin' && !env.CC_SETUP_FAKE_FIX) throw new Error('This fix is for macOS');
  if (env.CC_SETUP_FAKE_FIX) return { ok: true, kind: f.kind, message: `test: would run ${id}` };
  if (f.kind === 'settings') {
    // Finder first, System Settings last: the last one opened is in front (user, 2026-11-15: Finder
    // covered System Settings). In Thoth.app the page uses the native guide instead (PermissionGuide.swift).
    const shown = f.reveal && app && fs.existsSync(app) && await new Promise((res) => execFile('open', ['-R', app], (e) => res(!e)));
    const r = await new Promise((res) => execFile('open', [f.url], (e) => res(!e)));
    return { ok: r, kind: f.kind, message: !r ? 'Could not open System Settings.'
      : shown ? `System Settings is open, and Finder shows ${path.basename(app, '.app')}. Drag it into the list, then turn it on.` : 'System Settings is open. Follow the steps on this page.' };
  }
  if (f.kind === 'admin') {
    const r = await osa(`do shell script "${asq(f.cmd(node))}" with prompt "${asq(f.prompt)}" with administrator privileges`);
    if (r.ok) return { ok: true, kind: f.kind, message: 'Done.' };
    const canceled = /cancel/i.test(r.error || '');
    return { ok: false, kind: f.kind, canceled, message: canceled ? 'You canceled the password window. Nothing was changed.' : `It did not work: ${r.error}` };
  }
  const r = await osa(`tell application "Terminal"\nactivate\ndo script "${asq(f.cmd)}"\nend tell`);
  return { ok: r.ok, kind: f.kind, message: r.ok ? 'A Terminal window is running the install. Come back when it finishes.' : `Could not open Terminal: ${r.error}` };
}

module.exports = { FIXES, runFix };
