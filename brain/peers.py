"""Remote panel (multi-device plan, PR 4): the brain passes a helper computer's pairing link to the
owner's main panel, so the main panel can reach the helper's Thoth server through the relay with no
manual pairing. The brain never sees the link: the main panel posts a public key (X25519), the helper
seals its link to each key (lib/peer.ts seal), and the brain keeps only the sealed blobs.

- POST /api/peer/key {key}          owner: a main panel's public key (base64url, 32 bytes)
- GET  /api/peer/keys               device or owner: the public keys
- POST /api/peer/link {sealed}      device: {key_id: blob} for this device (replaces the old ones)
- GET  /api/peer/links?key=<id>     owner: the blobs sealed to this key, of approved devices only

A revoked or removed device's blobs are not served (the query joins approved cloud devices) and are
deleted with the device. Functions that take `db` expect the caller to hold the brain's lock.
Python standard library only.
"""
import base64
import hashlib
import re

MAX_KEYS = 8
KEY_TTL = 7 * 86400      # a main panel posts its key every minute; a key not posted for a week goes
MAX_BLOB = 4096
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")       # 32 bytes, base64url without padding
KEY_ID_RE = re.compile(r"^[0-9a-f]{16}$")
BLOB_RE = re.compile(r"^[A-Za-z0-9_-]{1,%d}$" % MAX_BLOB)

SCHEMA = """
CREATE TABLE IF NOT EXISTS peer_keys (id TEXT PRIMARY KEY, key TEXT NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS peer_links (
  device_id TEXT NOT NULL, key_id TEXT NOT NULL, blob TEXT NOT NULL, updated INTEGER,
  PRIMARY KEY (device_id, key_id)
);
"""


def init(db):
    db.executescript(SCHEMA)


def key_id(key):
    """The id of a public key: the first 16 hex characters of SHA-256 of its 32 bytes (lib/peer.ts keyId)."""
    raw = base64.urlsafe_b64decode(key + "=")
    return hashlib.sha256(raw).hexdigest()[:16]


def add_key(db, key, now):
    """Keep a main panel's public key. Returns its id. At most MAX_KEYS: the oldest goes."""
    key = str(key or "")
    if not KEY_RE.match(key):
        raise ValueError("key must be 32 bytes, base64url")
    kid = key_id(key)
    with db:
        db.execute("INSERT INTO peer_keys(id, key, created) VALUES(?,?,?) "
                   "ON CONFLICT(id) DO UPDATE SET created=excluded.created", (kid, key, int(now)))
        old = [r["id"] for r in db.execute("SELECT id FROM peer_keys ORDER BY created DESC, id LIMIT -1 OFFSET ?",
                                           (MAX_KEYS,))]
        old += [r["id"] for r in db.execute("SELECT id FROM peer_keys WHERE created < ?", (int(now) - KEY_TTL,))]
        for o in old:
            db.execute("DELETE FROM peer_keys WHERE id=?", (o,))
            db.execute("DELETE FROM peer_links WHERE key_id=?", (o,))
    return kid


def keys(db):
    return [{"id": r["id"], "key": r["key"]} for r in db.execute("SELECT id, key FROM peer_keys ORDER BY created DESC, id")]


def set_links(db, device_id, sealed, now):
    """Replace this device's sealed links. `sealed`: {key_id: blob}; only known key ids. Returns the count."""
    if not isinstance(sealed, dict) or len(sealed) > MAX_KEYS:
        raise ValueError("sealed must be an object with at most %d entries" % MAX_KEYS)
    known = {r["id"] for r in db.execute("SELECT id FROM peer_keys")}
    rows = []
    for kid, blob in sealed.items():
        if not KEY_ID_RE.match(str(kid)) or not isinstance(blob, str) or not BLOB_RE.match(blob):
            raise ValueError("bad sealed entry")
        if kid in known:
            rows.append((device_id, kid, blob, int(now)))
    with db:
        db.execute("DELETE FROM peer_links WHERE device_id=?", (device_id,))
        db.executemany("INSERT INTO peer_links(device_id, key_id, blob, updated) VALUES(?,?,?,?)", rows)
    return len(rows)


def links(db, kid):
    """The blobs sealed to key `kid`, of approved cloud devices: [{device, blob, updated}]."""
    if not KEY_ID_RE.match(str(kid or "")):
        raise ValueError("key must be a key id")
    q = ("SELECT d.name AS device, l.blob AS blob, l.updated AS updated FROM peer_links l "
         "JOIN cloud_devices d ON d.id = l.device_id WHERE l.key_id=? AND d.status='approved' ORDER BY d.name")
    return [dict(r) for r in db.execute(q, (kid,))]


def forget_device(db, device_id):
    with db:
        db.execute("DELETE FROM peer_links WHERE device_id=?", (device_id,))
