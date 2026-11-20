// Who starts the Thoth server when the Mac app finds none. One owner per server:
//   - the launchd service of `thoth services install` / `thoth always-on` is installed: launchd starts
//     it (the app asks it to, `launchctl kickstart`, only while the job is loaded); the app never
//     starts its own;
//   - the helper role (setup.json) without the service: the app starts nothing and says what to run;
//   - the thoth command uses another install folder than the app: the app starts nothing (it would run
//     old code from its own folder) and names both folders;
//   - else the app starts the server from its own folder, as before.
// Found on a helper Mac (2026-11-19): an old app started its server from an old folder the moment the
// service stopped, took the port, and the service then failed: the helper ran old code again.
import fs from 'node:fs';
import path from 'node:path';

export type Role = 'main' | 'helper' | '';

export interface Facts {
  role: Role;
  /** the launchd plist of the server service exists */
  serviceInstalled: boolean;
  /** the WorkingDirectory in that plist (the install folder launchd runs), or null */
  serviceDir: string | null;
  /** the install folder of the thoth command (~/.local/bin/thoth -> <dir>/bin/thoth), or null */
  commandDir: string | null;
  /** the folder of the app's server.ts (Info.plist CCPanelRepo) */
  appDir: string;
}

export type Decision =
  { action: 'spawn'; dir: string } | { action: 'launchd'; message: string } | { action: 'none'; message: string };

export function decide(f: Facts): Decision {
  if (f.serviceInstalled) {
    return {
      action: 'launchd',
      message: `The Thoth service (launchd) runs the server from ${f.serviceDir ?? 'its install folder'}. Asking it to start.`,
    };
  }
  if (f.role === 'helper') {
    return {
      action: 'none',
      message:
        'This Mac is a helper: the Thoth service runs its server, not the app. The service is not installed. In the Terminal app run: thoth always-on',
    };
  }
  if (f.commandDir !== null && f.commandDir !== f.appDir) {
    return {
      action: 'none',
      message: `This app is from ${f.appDir}, but Thoth is installed in ${f.commandDir}. The app does not start old code. Quit it and open the app that the installer built, or run: thoth start`,
    };
  }
  return { action: 'spawn', dir: f.appDir };
}

const SUFFIX = /^[A-Za-z0-9_-]+$/;

/** The launchd label of the server service. A test instance (CC_PANEL_INSTANCE) uses only the test
 * label of scripts/services.sh (CC_SERVICES_TEST_SUFFIX), never the user's real service: null without
 * a suffix. */
export function serviceLabel(env: NodeJS.ProcessEnv): string | null {
  const test = (env['CC_PANEL_INSTANCE'] ?? '') !== '';
  if (!test) return 'com.claudepanel.server';
  const s = env['CC_SERVICES_TEST_SUFFIX'] ?? '';
  return SUFFIX.test(s) ? `com.claudepanel.server.${s}` : null;
}

function plistPath(env: NodeJS.ProcessEnv, label: string): string {
  return path.join(env['HOME'] ?? '', 'Library', 'LaunchAgents', `${label}.plist`);
}

function readRole(home: string): Role {
  try {
    const r = (JSON.parse(fs.readFileSync(path.join(home, 'setup.json'), 'utf8')) as { role?: unknown }).role;
    return r === 'main' || r === 'helper' ? r : '';
  } catch {
    return '';
  }
}

function plistDir(file: string): string | null {
  try {
    const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(fs.readFileSync(file, 'utf8'));
    return m?.[1] !== undefined && m[1] !== ''
      ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      : null;
  } catch {
    return null;
  }
}

/** <dir>/bin/thoth -> <dir>. A test instance looks only at CC_THOTH_COMMAND (the user's own command
 * points at the user's install, not at the worktree under test). */
function commandDir(env: NodeJS.ProcessEnv): string | null {
  const test = (env['CC_PANEL_INSTANCE'] ?? '') !== '';
  const cmd = env['CC_THOTH_COMMAND'] ?? (test ? '' : path.join(env['HOME'] ?? '', '.local', 'bin', 'thoth'));
  if (cmd === '') return null;
  try {
    return path.dirname(path.dirname(fs.realpathSync(cmd)));
  } catch {
    return null;
  }
}

/** The command folder is realpath'd; the app folder (Info.plist CCPanelRepo, a plain `pwd`) may hold
 * a symlink. The same install in both spellings counts as the app's folder. */
function sameAs(cmdDir: string | null, appDir: string): string | null {
  if (cmdDir === null) return null;
  try {
    return fs.realpathSync(appDir) === cmdDir ? appDir : cmdDir;
  } catch {
    return cmdDir;
  }
}

export function readFacts(env: NodeJS.ProcessEnv, appDir: string): Facts {
  const home = env['CC_PANEL_HOME'] ?? path.join(env['HOME'] ?? '', '.config', 'cc-panel');
  const label = serviceLabel(env);
  const plist = label === null ? null : plistPath(env, label);
  const installed = plist !== null && fs.existsSync(plist);
  return {
    role: readRole(home),
    serviceInstalled: installed,
    serviceDir: installed && plist ? plistDir(plist) : null,
    commandDir: sameAs(commandDir(env), appDir),
    appDir,
  };
}

/** Runs a program and gives its exit code. */
export type Run = (cmd: string, args: readonly string[]) => number;

/** Asks launchd to start the server service now, only when launchd has the job loaded (kickstart).
 * A job that is not loaded was stopped on purpose (thoth stop, services uninstall, launchctl bootout):
 * the app never loads it again ('stopped'), so it cannot undo a stop or race an uninstall. Returns at
 * once (launchd starts the program); 'failed' when kickstart was refused. */
export function askLaunchd(run: Run, uid: number, label: string): 'started' | 'stopped' | 'failed' {
  const job = `gui/${String(uid)}/${label}`;
  if (run('/bin/launchctl', ['print', job]) !== 0) return 'stopped';
  return run('/bin/launchctl', ['kickstart', job]) === 0 ? 'started' : 'failed';
}
