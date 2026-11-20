// thoth always-on [--undo] [--status]: keep this Mac on as a helper computer (lib/always_on.ts).
// Test switches: see AlwaysOn.programs (they count only in the services test mode).
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import * as AlwaysOn from '../lib/always_on.ts';
import type { Runner } from '../lib/always_on.ts';
import { instance } from '../lib/instance.ts';

const USAGE = `thoth always-on [--undo] [--status]
  (no option)  run the Thoth server and brain as login services that restart by themselves, and keep
               this Mac on in every case: no sleep on AC power or on battery, also with the lid closed
               (pmset sleep 0, disablesleep 1); start again after a power failure where the Mac can.
               The display may still turn off.
  --undo       put the power settings back as they were; remove the services if this command added them
  --status     show each setting now
  --lid        old option, accepted for old scripts; it changes nothing (the lid is always included)`;

const run: Runner = (cmd, args, interactive = false) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: interactive ? 0 : 15_000,
  });
  // with stdio 'inherit' the output went to this terminal: there is none to return
  if (interactive) return { code: r.status ?? 1, stdout: '', stderr: r.error ? r.error.message : '' };
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.error ? r.error.message : r.stderr };
};

const cmd = AlwaysOn.parseArgs(process.argv.slice(2));
if ('error' in cmd) {
  console.error(`thoth always-on: ${cmd.error}\n${USAGE}`);
  process.exit(1);
}
if (cmd.action === 'help') {
  console.log(USAGE);
  process.exit(0);
}

const deps: AlwaysOn.Deps = {
  run,
  stateDir: instance().home,
  services: path.join(import.meta.dirname, 'services.sh'),
  platform: process.platform,
  tty: AlwaysOn.hasTerminal(process.stdin),
  ...AlwaysOn.programs(process.env),
  log: (line) => {
    console.log(line);
  },
};

try {
  if (cmd.action === 'undo') AlwaysOn.undo(deps);
  else if (cmd.action === 'status') AlwaysOn.status(deps);
  else AlwaysOn.enable(deps);
} catch (e) {
  console.error(`thoth always-on: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
