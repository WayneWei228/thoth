#!/usr/bin/env node
// The command line of `thoth setup` and `thoth doctor --json` (bin/thoth calls this file):
//   node scripts/thoth_setup.ts setup --role main|helper [--join <code>] [--hub <url>] [--name <n>] [--wait <s>]
//   node scripts/thoth_setup.ts doctor-json
// The logic and its tests: lib/thoth_setup.ts, a test
// Exit codes: setup 0 done, 1 failed, 2 bad arguments, 6 waiting for the owner's Approve;
// doctor-json 0 all checks ok, 1 otherwise (the JSON is printed in both cases).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { instance } from '../lib/instance.ts';
import * as T from '../lib/thoth_setup.ts';
import { isWsl } from '../lib/wsl.ts';
import { TIMEOUT_MS } from '../lib/wsl_host.ts';

const ROOT = path.join(import.meta.dirname, '..');
const home = instance().home;
const agentFile = process.env['CC_DEVICE_AGENT_FILE'] ?? path.join(os.homedir(), '.cc-brain', 'device.json');

function which(cmd: string): string | null {
  try {
    return execFileSync('sh', ['-c', 'command -v "$1"', 'sh', cmd], { encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch {
    const local = path.join(os.homedir(), '.local', 'bin', cmd);
    return cmd === 'claude' && fs.existsSync(local) ? local : null;
  }
}

/** A command's output, or null when it fails or runs longer than TIMEOUT_MS (the WSL checks). */
function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** The same places scripts/services.sh claude_logged_in looks (that file is bash and cannot import
 * this; change both together). */
function claudeLoggedIn(): boolean {
  const e = process.env;
  if ((e['ANTHROPIC_API_KEY'] ?? '') !== '' || (e['CLAUDE_CODE_OAUTH_TOKEN'] ?? '') !== '') return true;
  const h = os.homedir();
  try {
    if (fs.statSync(path.join(h, '.claude', '.credentials.json')).size > 0) return true;
  } catch {
    /* none */
  }
  try {
    if (fs.readFileSync(path.join(h, '.claude.json'), 'utf8').includes('"oauthAccount"')) return true;
  } catch {
    /* none */
  }
  if (process.platform !== 'darwin') return false;
  return (
    spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { timeout: 5000 }).status === 0
  );
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'setup') {
    let o: T.SetupOptions;
    try {
      o = T.parseArgs(rest);
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
    const r = await T.setup(o, { home, agentFile, health: T.health, agent: T.agentRunner(ROOT, home) });
    console.log(T.formatSetup(r));
    return r.code;
  }
  if (cmd === 'doctor-json') {
    const r = await T.doctor({
      home,
      agentFile,
      health: T.health,
      appDir: ROOT,
      nodeVersion: process.version,
      which,
      claudeLoggedIn,
      wsl: isWsl(),
      run,
    });
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  console.error(T.USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
