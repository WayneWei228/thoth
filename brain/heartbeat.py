"""Device heartbeats (multi-device plan, PR 3).

Every computer's Thoth server sends POST /api/heartbeat every 30 s (outgoing HTTPS only). The brain
keeps the newest heartbeat of each device and calls a device offline when its newest heartbeat is
older than OFFLINE_AFTER seconds. GET /api/devices and brain_list_devices show the fields.

A heartbeat comes from a device, so the brain trusts nothing in it: clean() keeps only the known
fields, with fixed types and lengths, and drops a user name or password from a git remote.
"""
import json
import re

OFFLINE_AFTER = 90           # seconds without a heartbeat: offline
MAX_PROJECTS = 200
MAX_BODY = 64 * 1024
ROLES = ("main", "helper")

SCHEMA = """
CREATE TABLE IF NOT EXISTS heartbeats (
  device TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL
);
"""
_CTRL = re.compile(r"[\x00-\x1f\x7f]")
_USERINFO = re.compile(r"^([a-z][a-z0-9+.-]*://)[^/]*@", re.I)   # up to the last '@' before the path
_SCP_PASSWORD = re.compile(r"^[^/:@]*:[^/]*@")                     # user:pw@host:path
_VERSION = re.compile(r"^[0-9A-Za-z.+-]{1,40}$")


def init(db):
    db.executescript(SCHEMA)


def _text(v, n):
    return _CTRL.sub("", v)[:n] if isinstance(v, str) else ""


def _bool(v):
    return v if isinstance(v, bool) else None


def _num(v, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:   # v != v: NaN
        return None
    return max(lo, min(hi, v))


def safe_remote(url):
    """A git remote without secrets: no user name or password (https://user:token@host/x -> https://host/x,
    user:pw@host:path -> host:path; up to the last '@' before the path, so an unencoded '@' in a
    password goes too), then no query or fragment (?access_token=...). Surrounding quotes go first.
    'git@github.com:a/b.git' keeps its form: 'git' there is not a secret."""
    url = _text(url, 300).strip()
    if len(url) >= 2 and url[0] == url[-1] == '"':
        url = url[1:-1]
    url = _SCP_PASSWORD.sub("", _USERINFO.sub(r"\1", url))
    return url.split("?")[0].split("#")[0]


def clean(body):
    """The heartbeat fields this brain stores, from an untrusted request body."""
    b = body if isinstance(body, dict) else {}
    projects = []
    raw = b.get("projects")
    for p in raw[:MAX_PROJECTS] if isinstance(raw, list) else []:
        if not isinstance(p, dict):
            continue
        path = _text(p.get("path"), 500)
        if path:
            projects.append({"path": path, "remote": safe_remote(p.get("remote"))})
    sessions = _num(b.get("running_sessions"), 0, 10000)
    working = _num(b.get("working_sessions"), 0, 10000)
    cpus = _num(b.get("cpus"), 0, 4096)
    return {
        "role": b.get("role") if b.get("role") in ROLES else "main",
        "on_ac": _bool(b.get("on_ac")),
        "cpu_load": _num(b.get("cpu_load"), 0, 100000),
        "cpus": int(cpus) if cpus is not None else None,
        "running_sessions": int(sessions) if sessions is not None else None,
        "working_sessions": int(working) if working is not None else None,
        "projects": projects,
        "claude": _bool(b.get("claude")),
        "codex": _bool(b.get("codex")),
        "thoth_version": v if isinstance(v := b.get("thoth_version"), str) and _VERSION.match(v) else "",
    }


def store(db, device, hb, now):
    """Keep only the newest heartbeat of a device."""
    db.execute("INSERT INTO heartbeats (device, at, data) VALUES (?, ?, ?) "
               "ON CONFLICT(device) DO UPDATE SET at=excluded.at, data=excluded.data",
               (device, int(now), json.dumps(hb, ensure_ascii=False)))
    db.commit()


def latest(db):
    """device name -> (at, fields) for every device that sent a heartbeat."""
    out = {}
    for r in db.execute("SELECT device, at, data FROM heartbeats"):
        try:
            out[r[0]] = (r[1], json.loads(r[2]))
        except ValueError:
            continue
    return out


def attach(devices, db, now):
    """Add the heartbeat fields to each device of GET /api/devices. A device that never sent one
    gets online=None (the brain does not know); the others online=True or False."""
    beats = latest(db)
    for d in devices:
        b = beats.get(d.get("name"))
        if b is None:
            d.update(online=None, last_heartbeat=None)
            continue
        at, fields = b
        d.update(fields)
        d.update(online=now - at <= OFFLINE_AFTER, last_heartbeat=at)
    return devices


def forget(db, device):
    db.execute("DELETE FROM heartbeats WHERE device=?", (device,))
