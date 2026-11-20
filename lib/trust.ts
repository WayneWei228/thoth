// Folder trust for Claude Code. A session the main Mac (or the router) starts on a helper runs in a
// folder the helper made itself (<Thoth home>/remote-work/<id>/<name>, lib/remote_new.ts). Claude Code
// asks "Quick safety check: Is this a project you created or one you trust?" in every new folder, and
// nobody sits at the helper (owner's real test, 2026-11-19). So the helper writes Claude Code's own
// answer, `projects[<folder>].hasTrustDialogAccepted = true` in ~/.claude.json, before it starts the
// session: only for a folder inside the work root (after links are followed), never a caller's path.
// Codex 0.170 asks no such question in a new folder (checked 2026-11-19), so it needs nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isInside } from './remote_new.ts';

/** Claude Code's config file: $CLAUDE_CONFIG_DIR/.claude.json when set, else ~/.claude.json. */
export function claudeConfigFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const dir = env['CLAUDE_CONFIG_DIR'] ?? '';
  return path.join(dir || home, '.claude.json');
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The real path of `folder` when it is a folder strictly inside `workRoot` (links followed); throws otherwise. */
function allowedFolder(folder: string, workRoot: string): string {
  try {
    if (!path.isAbsolute(folder)) throw new Error('relative');
    const real = fs.realpathSync(folder);
    const root = fs.realpathSync(workRoot);
    if (real === root || !isInside(real, root) || !fs.statSync(real).isDirectory()) throw new Error('outside');
    return real;
  } catch {
    throw new Error(`${folder} is not a folder this computer made for a remote session`);
  }
}

/** Marks `folder` trusted for Claude Code in `configFile`. `folder` must be a folder strictly inside
 * `workRoot` (links followed). Every other field stays; the file is replaced atomically (a temporary
 * file in the same folder, then rename) with its mode kept. Throws when the folder is not allowed or
 * the config is not a JSON object (then it is not touched). A config that is a link stays a link. */
export function trustFolder(o: { folder: string; workRoot: string; configFile?: string }): 'trusted' | 'already' {
  const given = o.configFile ?? claudeConfigFile();
  // a link (a dotfiles repo) stays a link: the file it points to is the one replaced
  let configFile = given;
  try {
    configFile = fs.realpathSync(given);
  } catch {
    /* not there yet */
  }
  const real = allowedFolder(o.folder, o.workRoot);
  let text: string;
  let mode = 0o600;
  try {
    text = fs.readFileSync(configFile, 'utf8');
    mode = fs.statSync(configFile).mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    text = '{}';
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    config = null;
  }
  if (!isObject(config)) throw new Error(`${configFile} is not a JSON object: not changed`);
  const projects = config['projects'] ?? {};
  if (!isObject(projects)) throw new Error(`${configFile}: "projects" is not an object: not changed`);
  const entry = projects[real] ?? {};
  if (!isObject(entry)) throw new Error(`${configFile}: the entry of ${real} is not an object: not changed`);
  if (entry['hasTrustDialogAccepted'] === true) return 'already';
  const next = { ...config, projects: { ...projects, [real]: { ...entry, hasTrustDialogAccepted: true } } };
  const tmp = `${configFile}.thoth-${String(process.pid)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, configFile);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return 'trusted';
}
