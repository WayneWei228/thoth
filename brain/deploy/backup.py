#!/usr/bin/env python3
"""Back up the brain database with SQLite's online backup API (safe while the brain runs).

Writes CC_BRAIN_DIR/backups/brain-<UTC time>.db (0600), checks it with PRAGMA integrity_check,
then keeps only the newest CC_BRAIN_BACKUP_KEEP (default 7). Run by claude-brain-backup.service
(nightly timer) and by `brain-server backup`.
"""
import glob
import os
import sqlite3
import sys
import time

data = os.path.expanduser(os.environ.get("CC_BRAIN_DIR", "~/.config/cc-brain"))
keep = max(1, int(os.environ.get("CC_BRAIN_BACKUP_KEEP", "7")))
src = os.path.join(data, "brain.db")
out_dir = os.path.join(data, "backups")

if not os.path.exists(src):
    print("backup skipped: no database yet at %s" % src)
    sys.exit(0)
os.makedirs(out_dir, mode=0o700, exist_ok=True)
base = time.strftime("brain-%Y%m%d-%H%M%S", time.gmtime())
dst, n = os.path.join(out_dir, base + ".db"), 1
while os.path.exists(dst):
    n += 1
    dst = os.path.join(out_dir, "%s-%d.db" % (base, n))
tmp = dst + ".part"
s = sqlite3.connect(src, timeout=30)
t = sqlite3.connect(tmp)
with t:
    s.backup(t)
s.close()
res = t.execute("PRAGMA integrity_check").fetchone()[0]
t.close()
if res != "ok":
    os.remove(tmp)
    print("backup FAILED: integrity check says %s" % res, file=sys.stderr)
    sys.exit(1)
os.chmod(tmp, 0o600)
os.replace(tmp, dst)
old = sorted(glob.glob(os.path.join(out_dir, "brain-*.db")), key=lambda p: os.stat(p).st_mtime_ns)[:-keep]
for p in old:
    os.remove(p)
print("backup %s (%d bytes; %d older removed)" % (dst, os.path.getsize(dst), len(old)))
