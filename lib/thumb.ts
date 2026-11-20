// First-page thumbnails for attached documents (PDFs etc.) with macOS Quick Look
// (`qlmanage -t`). Rendered at the requested pixel size (callers ask for 2x the
// display size, so they stay sharp on Retina) and cached by path + mtime + size.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { instance } from './instance.ts';

export const CACHE = path.join(instance().home, 'thumbs');

// `id`: what the cache key is made of instead of path + mtime (a caller that renders a private copy
// of a file passes the original's path, mtime and size, so the cache still hits)
export function thumbnail(file: string, size: number | string = 480, id = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      reject(new Error('File not found'));
      return;
    }
    const px = Math.max(64, Math.min(1600, Math.round(Number(size) || 480)));
    const key = crypto
      .createHash('sha1')
      .update(id ? `ql\0${id}\0${String(px)}` : `${file}\0${String(st.mtimeMs)}\0${String(px)}`)
      .digest('hex');
    const out = path.join(CACHE, `${key}.png`);
    if (fs.existsSync(out)) {
      resolve(out);
      return;
    }
    fs.mkdirSync(CACHE, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccthumb-'));
    execFile('qlmanage', ['-t', '-s', String(px), '-o', tmp, file], { timeout: 20_000 }, () => {
      const made = path.join(tmp, path.basename(file) + '.png');
      try {
        if (!fs.existsSync(made)) throw new Error('No preview');
        fs.renameSync(made, out);
        resolve(out);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
}

/**
 * A small JPEG of an image (`sips`, macOS): longest side `size` px (64…1024), quality 70, cached by
 * path + mtime + size. For the phone's chat thumbnails, which may cross the relay.
 */
export function imageThumb(file: string, size: number | string = 480, id = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      reject(new Error('File not found'));
      return;
    }
    const px = Math.max(64, Math.min(1024, Math.round(Number(size) || 480)));
    const key = crypto
      .createHash('sha1')
      .update(`img\0${id || `${file}\0${String(st.mtimeMs)}\0${String(st.size)}`}\0${String(px)}`)
      .digest('hex');
    const out = path.join(CACHE, `${key}.jpg`);
    if (fs.existsSync(out)) {
      resolve(out);
      return;
    }
    fs.mkdirSync(CACHE, { recursive: true });
    const tmp = `${out}.${String(process.pid)}.tmp.jpg`;
    execFile(
      'sips',
      ['-Z', String(px), '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', file, '--out', tmp],
      { timeout: 20_000 },
      (err) => {
        try {
          if (err || !fs.existsSync(tmp)) throw new Error('No preview');
          fs.renameSync(tmp, out);
          resolve(out);
        } catch (error) {
          fs.rmSync(tmp, { force: true });
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  });
}

/** The cached thumbnail for `id` at `size`, or '' (no render). */
export function cachedThumb(id: string, size: number | string, image: boolean): string {
  const px = Math.max(64, Math.min(image ? 1024 : 1600, Math.round(Number(size) || 480)));
  const key = crypto
    .createHash('sha1')
    .update(image ? `img\0${id}\0${String(px)}` : `ql\0${id}\0${String(px)}`)
    .digest('hex');
  const out = path.join(CACHE, `${key}.${image ? 'jpg' : 'png'}`);
  return fs.existsSync(out) ? out : '';
}
