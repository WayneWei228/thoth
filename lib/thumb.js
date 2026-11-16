// First-page thumbnails for attached documents (PDFs etc.) with macOS Quick Look
// (`qlmanage -t`). Rendered at the requested pixel size (callers ask for 2x the
// display size, so they stay sharp on Retina) and cached by path + mtime + size.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CACHE = path.join(require('./instance').instance().home, 'thumbs');

function thumbnail(file, size = 480) {
  return new Promise((resolve, reject) => {
    let st;
    try { st = fs.statSync(file); } catch { return reject(new Error('File not found')); }
    const px = Math.max(64, Math.min(1600, Math.round(Number(size) || 480)));
    const key = crypto.createHash('sha1').update(`${file}\0${st.mtimeMs}\0${px}`).digest('hex');
    const out = path.join(CACHE, `${key}.png`);
    if (fs.existsSync(out)) return resolve(out);
    fs.mkdirSync(CACHE, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccthumb-'));
    execFile('qlmanage', ['-t', '-s', String(px), '-o', tmp, file], { timeout: 20000 }, () => {
      const made = path.join(tmp, path.basename(file) + '.png');
      try {
        if (!fs.existsSync(made)) throw new Error('No preview');
        fs.renameSync(made, out);
        resolve(out);
      } catch (e) { reject(e); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  });
}

module.exports = { thumbnail, CACHE };
