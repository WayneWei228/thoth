// lib/wsl.ts
// WSL detection (Windows helper plan). WSL's kernel release names Microsoft ("5.15.153.1-microsoft-standard-WSL2").
import fs from 'node:fs';
import os from 'node:os';

/** This Linux runs inside WSL (Windows Subsystem for Linux). */
export function isWsl(platform: string = process.platform, release: string = os.release(), procVersion?: string): boolean {
  if (platform !== 'linux') return false;
  if (/microsoft/i.test(release)) return true;
  let v = procVersion;
  if (v === undefined) {
    try { v = fs.readFileSync('/proc/version', 'utf8'); } catch { v = ''; }
  }
  return /microsoft/i.test(v);
}
