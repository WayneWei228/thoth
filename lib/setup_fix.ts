// Guided fixes for the setup page (user, 2026-11-09: "the page pops up, a button tells the user
// what to add, System Settings opens and the page guides them"). A fixed list only; the server
// runs them on this Mac for a request from this Mac (server.ts checks the address).
//   settings: open the exact System Settings page (`reveal`: also show the app in Finder, to drag
//             it into a Privacy & Security list, as `agent-desktop permissions --guide` does)
//   admin:    run one command with the normal macOS password prompt
//   terminal: open Terminal with an install command typed in (the user sees what runs)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PERMS } from './permissions.ts';

export type Fix =
  | { kind: 'settings'; url: string; reveal?: boolean }
  | { kind: 'admin'; prompt: string; cmd: (node: string) => string }
  | { kind: 'terminal'; cmd: string };

export const FIXES: Record<string, Fix> = {
  'open-firewall': {
    kind: 'settings',
    url: 'x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall',
  },
  'firewall-allow': {
    kind: 'admin',
    prompt: 'Thoth wants to let your other computers connect to this Mac.',
    cmd: (node) =>
      `/usr/libexec/ApplicationFirewall/socketfilterfw --add '${node}' >/dev/null; /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp '${node}'`,
  },
  'open-energy': { kind: 'settings', url: 'x-apple.systempreferences:com.apple.Battery-Settings.extension' },
  'keep-awake': {
    kind: 'admin',
    prompt: 'Thoth wants this Mac to stay awake while it is plugged in.',
    cmd: () => 'pmset -c sleep 0',
  },
  ...Object.fromEntries(
    PERMS.map((p): [string, Fix] => [`perm-${p.id}`, { kind: 'settings', reveal: true, url: p.pane }]),
  ), // lib/permissions.ts
  'install-tmux': { kind: 'terminal', cmd: 'brew install tmux' },
  'install-claude': { kind: 'terminal', cmd: 'curl -fsSL https://claude.ai/install.sh | bash' },
  'install-codex': { kind: 'terminal', cmd: 'npm install -g @openai/codex && codex login' },
  'codex-login': { kind: 'terminal', cmd: 'codex login' },
};

const asq = (s: string): string => s.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`); // AppleScript string

type OsaResult = { ok: true; out: string } | { ok: false; error: string };

function osa(script: string): Promise<OsaResult> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 300_000 }, (err, out, errOut) => {
      resolve(err ? { ok: false, error: (errOut || err.message).trim() } : { ok: true, out: out.trim() });
    });
  });
}

const runs = (cmd: string, args: string[]): Promise<boolean> =>
  new Promise((res) => {
    execFile(cmd, args, (e) => {
      res(!e);
    });
  });

export interface FixResult {
  ok: boolean;
  kind: Fix['kind'];
  message: string;
  canceled?: boolean;
}

export interface FixOptions {
  env?: NodeJS.ProcessEnv;
  node?: string;
  app?: string;
}

/** Run fix `id`. Returns { ok, kind, message } in plain words. `app`: the app a `reveal` fix shows in Finder. */
export async function runFix(
  id: string,
  { env = process.env, node = process.execPath, app = '' }: FixOptions = {},
): Promise<FixResult> {
  const f = FIXES[id];
  if (!f) throw new Error(`Unknown fix "${id}"`);
  const fake = env['CC_SETUP_FAKE_FIX'] ?? '';
  if (process.platform !== 'darwin' && !fake) throw new Error('This fix is for macOS');
  if (fake) {
    // an absolute path: a file that gets the id of each fix, so a test can read which fixes ran
    if (path.isAbsolute(fake)) fs.appendFileSync(fake, `${id}\n`);
    return { ok: true, kind: f.kind, message: `test: would run ${id}` };
  }
  if (f.kind === 'settings') {
    // Finder first, System Settings last: the last one opened is in front (user, 2026-11-15: Finder
    // covered System Settings). In Thoth.app the page uses the native guide instead (PermissionGuide.swift).
    const shown = f.reveal === true && app !== '' && fs.existsSync(app) && (await runs('open', ['-R', app]));
    const r = await runs('open', [f.url]);
    let message = 'System Settings is open. Follow the steps on this page.';
    if (!r) message = 'Could not open System Settings.';
    else if (shown)
      message = `System Settings is open, and Finder shows ${path.basename(app, '.app')}. Drag it into the list, then turn it on.`;
    return { ok: r, kind: f.kind, message };
  }
  if (f.kind === 'admin') {
    const r = await osa(
      `do shell script "${asq(f.cmd(node))}" with prompt "${asq(f.prompt)}" with administrator privileges`,
    );
    if (r.ok) return { ok: true, kind: f.kind, message: 'Done.' };
    const canceled = /cancel/i.test(r.error);
    return {
      ok: false,
      kind: f.kind,
      canceled,
      message: canceled ? 'You canceled the password window. Nothing was changed.' : `It did not work: ${r.error}`,
    };
  }
  const r = await osa(`tell application "Terminal"\nactivate\ndo script "${asq(f.cmd)}"\nend tell`);
  return {
    ok: r.ok,
    kind: f.kind,
    message: r.ok
      ? 'A Terminal window is running the install. Come back when it finishes.'
      : `Could not open Terminal: ${r.error}`,
  };
}
