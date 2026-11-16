"""Cloud brain access control: the owner token, device join requests,
owner decisions, one-time codes and rate limits.

- Every secret (owner token, device token, poll secret, one-time code) is random. The database
  stores only its SHA-256 hash. Compares are constant-time.
- A device token is made when the device first polls after the owner approved it (or at once with a
  valid one-time code), so a plain-text token is never stored anywhere on the brain.
- Functions that take `db` expect the caller to hold the brain's database lock.
Python standard library only.
"""
import hashlib
import hmac
import os
import re
import secrets
import threading
import time

ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I (same alphabet as lib/devices.js)
CODE_TTL = 15 * 60
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
ID_RE = re.compile(r"^d[0-9a-f]{16}$")
MACHINE_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_PENDING = 50
PENDING_MAX_AGE = 7 * 86400
OWNER_TOKEN_FILE = "owner-token"
MIN_TOKEN_LEN = 32

SCHEMA = """
CREATE TABLE IF NOT EXISTS cloud_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, asked_name TEXT, os TEXT, host TEXT,
  status TEXT NOT NULL,            -- pending, approved, ignored, revoked
  poll_hash TEXT, token_hash TEXT, token_sent INTEGER DEFAULT 0, via TEXT,
  created INTEGER, decided INTEGER, last_seen INTEGER, sessions INTEGER DEFAULT 0, last_error TEXT DEFAULT '',
  machine TEXT DEFAULT ''          -- collector.machine_id() of the computer that holds the token
);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_devices_token ON cloud_devices(token_hash);
CREATE TABLE IF NOT EXISTS join_codes (
  code_hash TEXT PRIMARY KEY, device_name TEXT NOT NULL, created INTEGER, expires INTEGER, used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""


# ---------------------------------------------------------------- secrets ----
def new_token():
    return secrets.token_urlsafe(32)   # 32 random bytes


def hash_secret(s):
    return hashlib.sha256(str(s).encode("utf-8")).hexdigest()


def same(a, b):
    """Constant-time compare of two hashes (or two secrets)."""
    a, b = str(a or ""), str(b or "")
    return bool(a) and bool(b) and hmac.compare_digest(a.encode(), b.encode())


# ------------------------------------------------------------ owner token ----
def owner_token_path(conf_dir):
    return os.path.join(conf_dir, OWNER_TOKEN_FILE)


def read_owner_token(conf_dir):
    """The owner token, or "" when the file is missing or too short to be safe."""
    try:
        with open(owner_token_path(conf_dir), encoding="utf-8") as f:
            t = f.read().strip()
    except OSError:
        return ""
    return t if len(t) >= MIN_TOKEN_LEN else ""


def owner_token_exists(conf_dir):
    return os.path.exists(owner_token_path(conf_dir))


def write_owner_token(conf_dir, rotate=False):
    """Create the owner token (0600) if it is missing, or replace it with --rotate. Returns it."""
    os.makedirs(conf_dir, mode=0o700, exist_ok=True)
    path = owner_token_path(conf_dir)
    if not rotate and read_owner_token(conf_dir):
        return read_owner_token(conf_dir)
    tmp = path + ".new"
    try:
        os.unlink(tmp)
    except OSError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    token = new_token()
    os.write(fd, (token + "\n").encode())
    os.close(fd)
    os.replace(tmp, path)   # atomic: a reader sees the old or the new token, never half
    return token


def file_too_open(path):
    try:
        return bool(os.stat(path).st_mode & 0o077)
    except OSError:
        return False


# ------------------------------------------------------------ one-time codes ----
def _checks(data):
    """Two check characters: Luhn mod 32 (catches every single wrong character and most swaps
    of neighbours) plus one hash character (catches most other typos)."""
    n, factor, total = len(ALPHA), 2, 0
    for ch in reversed(data):
        add = factor * ALPHA.index(ch)
        total += add // n + add % n
        factor = 3 - factor
    return ALPHA[(n - total % n) % n] + ALPHA[hashlib.sha256(data.encode()).digest()[0] % n]


def new_code():
    data = "".join(secrets.choice(ALPHA) for _ in range(8))   # 40 random bits
    s = data + _checks(data)
    return "%s-%s-%s" % (s[:4], s[4:8], s[8:])


def normalize_code(code):
    return re.sub(r"[\s-]", "", str(code or "")).upper()


def code_well_formed(code):
    s = normalize_code(code)
    return len(s) == 10 and all(c in ALPHA for c in s) and s[8:] == _checks(s[:8])


# ------------------------------------------------------------- rate limits ----
class RateLimiter:
    """Sliding-window counters in memory, per key (for example ("join", ip))."""

    def __init__(self):
        self.hits = {}
        self.lock = threading.Lock()

    def _recent(self, key, window, now):
        lst = [t for t in self.hits.get(key, []) if t > now - window]
        if lst:
            self.hits[key] = lst
        else:
            self.hits.pop(key, None)
        return lst

    def over(self, key, limit, window, now=None):
        now = time.time() if now is None else now
        with self.lock:
            return len(self._recent(key, window, now)) >= limit

    def hit(self, key, limit, window, now=None):
        """Count one event. Returns False when the key was already at its limit (event not counted)."""
        now = time.time() if now is None else now
        with self.lock:
            if len(self.hits) > 20000:   # bound memory: drop keys with nothing in the last hour
                for k in [k for k, v in self.hits.items() if not v or v[-1] < now - 3600]:
                    del self.hits[k]
            lst = self._recent(key, window, now)
            if len(lst) >= limit:
                return False
            self.hits.setdefault(key, []).append(now)
            return True

    def reset(self):
        with self.lock:
            self.hits.clear()


# --------------------------------------------------------------- database ----
def init(db):
    db.executescript(SCHEMA)
    if "machine" not in [r[1] for r in db.execute("PRAGMA table_info(cloud_devices)")]:   # a brain from before
        with db:
            db.execute("ALTER TABLE cloud_devices ADD COLUMN machine TEXT DEFAULT ''")


def clean_machine(m):
    m = str(m or "").strip().lower()
    return m if MACHINE_RE.match(m) else ""


def check_machine(db, dev, machine):
    """Is this push from the computer that holds the device's token? True when it is, when the
    pushing agent is too old to send a machine id, or when the device has none yet (it is recorded
    now: the first computer to push with the token keeps it). False when another computer uses the
    token: its config was copied (Migration Assistant, a backup), so it must join with its own name."""
    machine = clean_machine(machine)
    if not machine:
        return True
    have = dev["machine"] if "machine" in dev.keys() else ""
    if not have:
        with db:
            db.execute("UPDATE cloud_devices SET machine=? WHERE id=? AND (machine IS NULL OR machine='')",
                       (machine, dev["id"]))
        row = db.execute("SELECT machine FROM cloud_devices WHERE id=?", (dev["id"],)).fetchone()
        return not row or row[0] == machine
    return same(have, machine)


def _identity_of(db, machine, skip_id=""):
    """The approved device that already belongs to this computer, or None."""
    machine = clean_machine(machine)
    if not machine:
        return None
    return db.execute("SELECT * FROM cloud_devices WHERE machine=? AND status='approved' AND id!=? ORDER BY created LIMIT 1",
                      (machine, skip_id)).fetchone()


def same_machine_as(db, dev):
    """Names of other approved devices on the same computer (one computer joined twice)."""
    m = dev["machine"] if "machine" in dev.keys() else ""
    if not m:
        return []
    return [r[0] for r in db.execute("SELECT name FROM cloud_devices WHERE machine=? AND id!=? AND status='approved' "
                                     "ORDER BY created", (m, dev["id"]))]


def get_meta(db, k):
    r = db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r[0] if r else None


def set_meta(db, k, v):
    with db:
        db.execute("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))


def clean_text(s, n):
    """A short label from a device (os, host): printable characters only."""
    s = "".join(c for c in str(s or "") if c.isprintable())
    return s.strip()[:n]


def valid_name(name):
    return isinstance(name, str) and bool(NAME_RE.match(name))


def name_taken(db, name, reserved=()):
    if name in reserved:
        return True
    return bool(db.execute("SELECT 1 FROM cloud_devices WHERE name=? AND status IN ('pending','approved')",
                           (name,)).fetchone())


def pick_name(db, asked, reserved=()):
    """The asked name, or asked-2, asked-3 ... when another device holds it."""
    if not name_taken(db, asked, reserved):
        return asked
    for i in range(2, 1000):
        cand = "%s-%d" % (asked[:31 - len(str(i)) - 1], i)
        if not name_taken(db, cand, reserved):
            return cand
    raise ValueError("no free device name")


def _new_id():
    return "d" + secrets.token_hex(8)


def _prune(db, now):
    with db:
        db.execute("DELETE FROM cloud_devices WHERE status='pending' AND created < ?", (now - PENDING_MAX_AGE,))
        db.execute("DELETE FROM join_codes WHERE expires < ?", (now - 86400,))


def request_join(db, name, os_="", host="", reserved=(), now=None, machine=""):
    """A device asks to join without a code. Returns {pending_id, poll_secret, status, device}."""
    now = int(time.time() if now is None else now)
    _prune(db, now)
    secret = new_token()
    # a device the owner ignored stays ignored when it asks again (same asked name and host)
    ign = db.execute("SELECT id, name FROM cloud_devices WHERE status='ignored' AND asked_name=? AND host=? "
                     "ORDER BY created DESC LIMIT 1", (name, host)).fetchone()
    if ign:
        with db:
            db.execute("UPDATE cloud_devices SET poll_hash=?, os=? WHERE id=?", (hash_secret(secret), os_, ign["id"]))
        return {"pending_id": ign["id"], "poll_secret": secret, "status": "pending", "device": ign["name"]}
    if db.execute("SELECT COUNT(*) FROM cloud_devices WHERE status='pending'").fetchone()[0] >= MAX_PENDING:
        raise OverflowError("too many devices are waiting; approve or ignore some first")
    final = pick_name(db, name, reserved)
    did = _new_id()
    with db:
        db.execute("INSERT INTO cloud_devices (id, name, asked_name, os, host, status, poll_hash, via, created, machine) "
                   "VALUES (?,?,?,?,?,'pending',?,'request',?,?)",
                   (did, final, name, os_, host, hash_secret(secret), now, clean_machine(machine)))
    return {"pending_id": did, "poll_secret": secret, "status": "pending", "device": final}


def make_code(db, name, reserved=(), now=None):
    """Owner: a one-time pre-approved code for a device name (15 minutes, single use)."""
    now = int(time.time() if now is None else now)
    if name_taken(db, name, reserved):
        raise ValueError('the name "%s" is already used by a device (approve, ignore or revoke it first)' % name)
    code = new_code()
    with db:
        db.execute("INSERT INTO join_codes (code_hash, device_name, created, expires) VALUES (?,?,?,?)",
                   (hash_secret(normalize_code(code)), name, now, now + CODE_TTL))
    return {"code": code, "device": name, "expires": now + CODE_TTL}


def join_with_code(db, code, os_="", host="", reserved=(), now=None, machine=""):
    """Redeem a well-formed code. Returns {device, token, id, status} or None (wrong, used or expired)."""
    now = int(time.time() if now is None else now)
    h = hash_secret(normalize_code(code))
    row = None
    for r in db.execute("SELECT * FROM join_codes WHERE used=0 AND expires > ?", (now,)).fetchall():
        if same(h, r["code_hash"]):
            row = r
    if not row:
        return None
    name = row["device_name"]
    token, did = new_token(), _new_id()
    mine = _identity_of(db, machine)
    if mine:
        # one computer, one identity: this computer joined before (its token file was lost, or a
        # second program on it joins). It keeps its device and name; the old token stops working.
        with db:
            cur = db.execute("UPDATE join_codes SET used=1 WHERE code_hash=? AND used=0", (row["code_hash"],))
            if cur.rowcount != 1:
                return None
            db.execute("UPDATE cloud_devices SET token_hash=?, token_sent=1, decided=?, os=?, host=? WHERE id=?",
                       (hash_secret(token), now, os_ or mine["os"], host or mine["host"], mine["id"]))
        return {"id": mine["id"], "device": mine["name"], "token": token, "status": "approved", "same_computer": True}
    if name_taken(db, name, reserved):
        name = pick_name(db, name, reserved)
    with db:
        cur = db.execute("UPDATE join_codes SET used=1 WHERE code_hash=? AND used=0", (row["code_hash"],))
        if cur.rowcount != 1:   # another request used it at the same moment
            return None
        db.execute("INSERT INTO cloud_devices (id, name, asked_name, os, host, status, token_hash, token_sent, via, "
                   "created, decided, machine) VALUES (?,?,?,?,?,'approved',?,1,'code',?,?,?)",
                   (did, name, row["device_name"], os_, host, hash_secret(token), now, now, clean_machine(machine)))
    return {"id": did, "device": name, "token": token, "status": "approved"}


def poll(db, did, secret, now=None):
    """A waiting device checks its request. None = unknown id or wrong poll secret."""
    if not ID_RE.match(str(did or "")) or not secret:
        return None
    row = db.execute("SELECT * FROM cloud_devices WHERE id=?", (did,)).fetchone()
    if not row or not same(hash_secret(secret), row["poll_hash"]):
        return None
    out = {"status": row["status"], "device": row["name"]}
    if row["status"] == "approved" and not row["token_sent"]:
        token = new_token()
        mine = _identity_of(db, row["machine"], skip_id=did)
        if mine:   # the owner approved a computer that already has a device: it keeps that one (see join_with_code)
            with db:
                cur = db.execute("DELETE FROM cloud_devices WHERE id=? AND token_sent=0", (did,))
                if cur.rowcount == 1:
                    db.execute("UPDATE cloud_devices SET token_hash=?, token_sent=1, decided=? WHERE id=?",
                               (hash_secret(token), int(time.time() if now is None else now), mine["id"]))
            if cur.rowcount == 1:
                return {"status": "approved", "device": mine["name"], "token": token, "same_computer": True}
            return out
        with db:
            cur = db.execute("UPDATE cloud_devices SET token_hash=?, token_sent=1 WHERE id=? AND token_sent=0",
                             (hash_secret(token), did))
        if cur.rowcount == 1:
            out["token"] = token   # given once; only its hash stays
    return out


def decide(db, did, action, reserved=(), now=None):
    """Owner decision: approve, ignore, unignore, revoke. Returns the device without secrets.
    Raises LookupError (unknown id) or ValueError (not possible in this state)."""
    now = int(time.time() if now is None else now)
    row = db.execute("SELECT * FROM cloud_devices WHERE id=?", (str(did),)).fetchone()
    if not row:
        raise LookupError("no device with this id")
    st = row["status"]
    allowed = {"approve": ("pending", "ignored", "approved"), "ignore": ("pending", "ignored"),
               "unignore": ("ignored", "pending"), "revoke": ("pending", "approved", "ignored", "revoked")}
    if action not in allowed:
        raise LookupError("unknown action")
    if st not in allowed[action]:
        raise ValueError("cannot %s a device that is %s" % (action, st))
    with db:
        if action == "approve" and st != "approved":
            if st == "ignored" and name_taken(db, row["name"], reserved):   # another device took the name meanwhile
                db.execute("UPDATE cloud_devices SET name=? WHERE id=?", (pick_name(db, row["name"], reserved), did))
            db.execute("UPDATE cloud_devices SET status='approved', decided=? WHERE id=?", (now, did))
        elif action == "ignore":
            db.execute("UPDATE cloud_devices SET status='ignored', decided=? WHERE id=?", (now, did))
        elif action == "unignore" and st == "ignored":
            if name_taken(db, row["name"], reserved):
                db.execute("UPDATE cloud_devices SET name=? WHERE id=?", (pick_name(db, row["name"], reserved), did))
            db.execute("UPDATE cloud_devices SET status='pending', decided=? WHERE id=?", (now, did))
        elif action == "revoke":
            db.execute("UPDATE cloud_devices SET status='revoked', token_hash=NULL, poll_hash=NULL, decided=? "
                       "WHERE id=?", (now, did))
    return public(db.execute("SELECT * FROM cloud_devices WHERE id=?", (did,)).fetchone())


def remove(db, name):
    """Owner removes a device: every record with this name goes (any status), so its token stops
    working and the name is free again. Returns the number of records deleted."""
    with db:
        return db.execute("DELETE FROM cloud_devices WHERE name=?", (str(name),)).rowcount


def device_by_token(db, token):
    """The approved device that owns this token, or None."""
    if not token:
        return None
    h = hash_secret(token)
    row = db.execute("SELECT * FROM cloud_devices WHERE token_hash=? AND status='approved'", (h,)).fetchone()
    return row if row and same(h, row["token_hash"]) else None


def touch(db, did, **kw):
    cols = [k for k in kw if k in ("last_seen", "sessions", "last_error", "os")]
    if cols:
        with db:
            db.execute("UPDATE cloud_devices SET " + ",".join(c + "=?" for c in cols) + " WHERE id=?",
                       [kw[c] for c in cols] + [did])


PUBLIC_COLS = ("id", "name", "os", "host", "status", "via", "created", "decided", "last_seen", "sessions", "last_error")


def public(row):
    d = {k: row[k] for k in PUBLIC_COLS}
    d["transport"] = "cloud"
    d["waiting_for_token"] = bool(row["status"] == "approved" and not row["token_sent"])
    return d


def list_devices(db):
    return [public(r) for r in db.execute("SELECT * FROM cloud_devices ORDER BY created")]
