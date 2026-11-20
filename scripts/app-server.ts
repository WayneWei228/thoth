// The Mac app runs this when its server does not answer (macos/Sources/ClaudePanel/Backend.swift):
//   node scripts/app-server.ts <the app's server folder>
// It decides who starts the server (lib/server_owner.ts), asks launchd when the service owns it, and
// prints one JSON line: {"action":"spawn","dir":...} (the app starts server.ts from dir, as before),
// {"action":"launchd","message":...} or {"action":"none","message":...} (the app starts nothing and
// shows the message). It returns at once: launchctl only hands the start to launchd. A service that is not loaded
// (stopped on purpose) is never loaded again here: the app shows "stopped, run: thoth start".
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { askLaunchd, decide, readFacts, serviceLabel } from '../lib/server_owner.ts';

const appDir = process.argv[2] ?? '';
if (appDir === '') {
  process.stderr.write('usage: node scripts/app-server.ts <app server folder>\n');
  process.exit(2);
}
const env = { ...process.env, HOME: process.env['HOME'] ?? os.homedir() };
const d = decide(readFacts(env, appDir));
let out: object = d;
if (d.action === 'launchd') {
  const label = serviceLabel(env) ?? '';
  const run = (cmd: string, args: readonly string[]): number => spawnSync(cmd, args, { stdio: 'ignore' }).status ?? 1;
  const r = askLaunchd(run, os.userInfo().uid, label);
  if (r === 'stopped') {
    out = { action: 'none', message: 'The Thoth service is stopped. In the Terminal app run: thoth start' };
  } else if (r === 'failed') {
    out = {
      action: 'none',
      message: `The Thoth service (${label}) is installed, but launchd did not start it. In the Terminal app run: thoth doctor`,
    };
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
