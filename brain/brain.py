#!/usr/bin/env python3
"""Central Brain, phase 1: a read-only index of every Claude Code and Codex
session on every device, with full-text search.

- Runs on the always-on device (this Mac). Python standard library + SQLite FTS5.
- Pulls from devices: local devices run collector.py directly; remote devices
  run it over SSH (the brain deploys it first). No device needs an open port,
  and the brain itself listens on 127.0.0.1 only.
- Cloud brain: behind Caddy, with an owner token in
  CC_BRAIN_DIR/owner-token. Devices join, the owner approves, devices push with their own
  token (brain/cloud_auth.py). Without an owner token a 127.0.0.1 brain trusts local requests.

Usage:
  python3 brain.py sync              # pull from all devices once
  python3 brain.py search "query"    # search sessions
  python3 brain.py serve             # HTTP API on 127.0.0.1:7879, sync every 2 min
  python3 brain.py owner-token [--rotate]   # print (create) the owner token; tokens then required
Config: ~/.config/cc-brain/devices.json   DB: ~/.config/cc-brain/brain.db
"""
import hashlib
import json
import os
import re
import shlex
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # python3 -I leaves the script folder out of sys.path
import cloud_auth  # noqa: E402
import peers  # noqa: E402
import heartbeat  # noqa: E402
COLLECTOR = os.path.join(HERE, "collector.py")
CONF_DIR = os.path.expanduser(os.environ.get("CC_BRAIN_DIR", "~/.config/cc-brain"))
DB_PATH = os.path.join(CONF_DIR, "brain.db")
DEVICES_PATH = os.path.join(CONF_DIR, "devices.json")
PORT = int(os.environ.get("CC_BRAIN_PORT", "7879"))
SYNC_EVERY = int(os.environ.get("CC_BRAIN_SYNC_SECONDS", "120"))

# without devices.json: just this machine, named after it (not "local")
DEFAULT_DEVICES = [{"name": (socket.gethostname().split(".")[0].lower() or "this-computer"), "transport": "local"}]

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
  name TEXT PRIMARY KEY, os TEXT, home TEXT, transport TEXT,
  last_sync INTEGER, ok INTEGER, error TEXT, sessions INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  device TEXT NOT NULL, agent TEXT NOT NULL, sid TEXT NOT NULL,
  path TEXT, cwd TEXT, project TEXT, title TEXT,
  first_prompt TEXT, last_prompt TEXT, last_reply TEXT,
  started TEXT, updated TEXT, size INTEGER, mtime INTEGER,
  UNIQUE(device, agent, sid)
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS sessions_mtime ON sessions(mtime);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  title, first_prompt, last_prompt, last_reply, cwd, project,
  tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, session INTEGER NOT NULL, idx INTEGER NOT NULL,
  role TEXT, ts TEXT, text TEXT
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session, idx);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content = 'messages', content_rowid = 'id', tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,            -- 'file' (collected) or 'agent' (brain_remember)
  device TEXT, source TEXT, scope TEXT, kind TEXT,
  project TEXT, folder TEXT, name TEXT, description TEXT, body TEXT,
  path TEXT, mtime INTEGER, session TEXT, created INTEGER
);
CREATE INDEX IF NOT EXISTS memories_project ON memories(project);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, created INTEGER, src_device TEXT, src_sid TEXT, src_cwd TEXT,
  dst_device TEXT, target_path TEXT, branch TEXT, packet TEXT, run_mode TEXT, status TEXT, result TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  name, description, body, project, folder, tokenize = 'trigram'
);
"""
TOKEN_PATH = os.path.join(CONF_DIR, "token")
MEM_FIELDS = ["origin", "device", "source", "scope", "kind", "project", "folder", "name", "description",
              "body", "path", "mtime", "session", "created"]
FIELDS = ["path", "cwd", "project", "title", "first_prompt", "last_prompt", "last_reply",
          "started", "updated", "size", "mtime"]


_regex_cache = {}


def _regexp(pattern, text):
    """SQL: text REGEXP pattern. Case is ignored, like the keyword search."""
    r = _regex_cache.get(pattern)
    if r is None:
        if len(_regex_cache) > 50:
            _regex_cache.clear()
        r = _regex_cache[pattern] = re.compile(pattern, re.I)
    return 1 if text and r.search(text) else 0


def connect(path=None):
    os.makedirs(CONF_DIR, mode=0o700, exist_ok=True)
    db = sqlite3.connect(path or DB_PATH, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.create_function("regexp", 2, _regexp, deterministic=True)
    db.executescript(SCHEMA)
    cloud_auth.init(db)
    peers.init(db)
    heartbeat.init(db)
    if not path:
        try:
            os.chmod(DB_PATH, 0o600)   # holds token hashes and everyone's session summaries
        except OSError:
            pass
    return db


def load_devices():
    if not os.path.exists(DEVICES_PATH):
        return DEFAULT_DEVICES
    with open(DEVICES_PATH, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- ingest ----
def ingest(db, doc, device_name=None):
    """Upsert one collector document. Returns the number of sessions written."""
    dev = device_name or doc.get("device") or "unknown"
    n = 0
    with db:
        for s in doc.get("sessions", []):
            row = db.execute("SELECT id, mtime, path FROM sessions WHERE device=? AND agent=? AND sid=?",
                             (dev, s["agent"], s["sid"])).fetchone()
            vals = [s.get(k) for k in FIELDS]
            # Claude copies a transcript into another project folder when it is resumed
            # there, so one id can have several files. Keep the newest copy.
            if row and row["path"] != s.get("path") and (row["mtime"] or 0) > (s.get("mtime") or 0):
                continue
            if row:
                db.execute("UPDATE sessions SET " + ",".join(k + "=?" for k in FIELDS) + " WHERE id=?",
                           vals + [row["id"]])
                rid = row["id"]
                db.execute("DELETE FROM sessions_fts WHERE rowid=?", (rid,))
            else:
                cur = db.execute("INSERT INTO sessions (device, agent, sid, " + ",".join(FIELDS) + ") VALUES (?,?,?," +
                                 ",".join("?" * len(FIELDS)) + ")", [dev, s["agent"], s["sid"]] + vals)
                rid = cur.lastrowid
            db.execute("INSERT INTO sessions_fts (rowid, title, first_prompt, last_prompt, last_reply, cwd, project) "
                       "VALUES (?,?,?,?,?,?,?)", (rid, s.get("title", ""), s.get("first_prompt", ""),
                                                   s.get("last_prompt", ""), s.get("last_reply", ""),
                                                   s.get("cwd", ""), s.get("project", "")))
            if isinstance(s.get("messages"), list):  # the whole dialogue (collector version 2); replace it
                db.execute("DELETE FROM messages WHERE session=?", (rid,))
                db.executemany("INSERT INTO messages (session, idx, role, ts, text) VALUES (?,?,?,?,?)",
                               [(rid, i, str(m.get("r") or ""), str(m.get("ts") or ""), str(m.get("t") or ""))
                                for i, m in enumerate(s["messages"]) if isinstance(m, dict)])
            n += 1
        if "memories" in doc:  # files: replace this device's set (handles deletions)
            for r in db.execute("SELECT id FROM memories WHERE origin='file' AND device=?", (dev,)).fetchall():
                db.execute("DELETE FROM memories_fts WHERE rowid=?", (r["id"],))
            db.execute("DELETE FROM memories WHERE origin='file' AND device=?", (dev,))
            seen = set()
            for m in doc["memories"]:
                # the same memory file is often copied into several project folders; keep one
                key = (m.get("name"), hashlib.sha256((m.get("body") or "").encode()).hexdigest())
                if key in seen:
                    continue
                seen.add(key)
                add_memory_row(db, dict(m, origin="file", device=dev))
        for path in doc.get("removed", []):
            row = db.execute("SELECT id FROM sessions WHERE device=? AND path=?", (dev, path)).fetchone()
            if row:
                db.execute("DELETE FROM sessions_fts WHERE rowid=?", (row["id"],))
                db.execute("DELETE FROM messages WHERE session=?", (row["id"],))
                db.execute("DELETE FROM sessions WHERE id=?", (row["id"],))
    return n


def add_memory_row(db, m):
    vals = [m.get(k) for k in MEM_FIELDS]
    cur = db.execute("INSERT INTO memories (" + ",".join(MEM_FIELDS) + ") VALUES (" + ",".join("?" * len(MEM_FIELDS)) + ")", vals)
    db.execute("INSERT INTO memories_fts (rowid, name, description, body, project, folder) VALUES (?,?,?,?,?,?)",
               (cur.lastrowid, m.get("name", ""), m.get("description", ""), m.get("body", ""),
                m.get("project", ""), m.get("folder", "")))
    return cur.lastrowid


def remember(db, text, project="", folder="", kind="note", device="", agent="", session=""):
    """A memory written by an agent (MCP brain_remember). Shared with every device."""
    text = (text or "").strip()
    if not text:
        raise ValueError("empty memory")
    import collector
    text = collector.redact(text)[:4000]
    if folder and not project:
        project = collector.project_key(folder)
    with db:
        rid = add_memory_row(db, {"origin": "agent", "device": device, "source": agent, "scope": "project" if project else "user",
                                  "kind": kind, "project": project, "folder": folder, "name": text[:80],
                                  "description": "", "body": text, "path": "", "mtime": int(time.time()),
                                  "session": session, "created": int(time.time())})
    return rid


def record_handoff(db, h):
    cols = ["id", "created", "src_device", "src_sid", "src_cwd", "dst_device", "target_path", "branch", "packet",
            "run_mode", "status", "result"]
    with db:
        db.execute("INSERT OR REPLACE INTO handoffs (" + ",".join(cols) + ") VALUES (" + ",".join("?" * len(cols)) + ")",
                   [h.get(c) if not isinstance(h.get(c), (dict, list)) else json.dumps(h.get(c), ensure_ascii=False) for c in cols])


def handoffs(db, limit=20):
    return [dict(r) for r in db.execute("SELECT * FROM handoffs ORDER BY created DESC LIMIT ?", (int(limit),))]


def start_handoff(db, lock, body):
    """Run brain/handoff.py in the background; progress is the handoffs row (status
    running -> ran / run-failed / failed). Target is this device unless 'to' is given."""
    import re
    import secrets
    dev, sid = body.get("device", ""), body.get("sid", "")
    if not re.match(r"^[\w.-]+$", dev) or not re.match(r"^[\w-]{4,80}$", sid):
        raise ValueError("device and sid required")
    to = body.get("to") or next((d["name"] for d in load_devices() if d.get("transport") == "local"), "")
    run = body.get("run", "panel")
    if run not in ("none", "headless", "panel"):
        raise ValueError("bad run mode")
    hid = "h" + time.strftime("%m%d%H%M") + secrets.token_hex(2)
    with lock:
        record_handoff(db, {"id": hid, "created": int(time.time()), "src_device": dev, "src_sid": sid,
                            "dst_device": to, "run_mode": run, "status": "running", "result": ""})
    cmd = [sys.executable, "-I", os.path.join(HERE, "handoff.py"), "--from", dev, "--sid", sid, "--to", to,
           "--run", run, "--id", hid, "--json"]
    if body.get("panel_url"):
        cmd += ["--panel-url", body["panel_url"]]
    if body.get("notes"):
        cmd += ["--notes", str(body["notes"])[:2000]]

    def work():
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if p.returncode != 0:
            with lock:
                db.execute("UPDATE handoffs SET status='failed', result=? WHERE id=?",
                           (json.dumps({"ok": False, "result": (p.stderr or p.stdout)[-1500:]}), hid))
                db.commit()
    threading.Thread(target=work, daemon=True).start()
    return hid


# ---------------------------------------------------------------- enrich ----
# Every prompt goes through the brain first (UserPromptSubmit hook). WHAT to add is decided
# by an AI retrieval step: a model with the brain's
# read-only tools searches sessions, memories and devices and returns only what helps.
RETRIEVER_MODEL = os.environ.get("CC_BRAIN_RETRIEVER_MODEL", "sonnet")
RETRIEVER_TIMEOUT = int(os.environ.get("CC_BRAIN_RETRIEVER_TIMEOUT", "50"))
_enrich_given = {}   # session_id -> list of context blocks already added to that session
_enrich_lock = threading.Lock()

ENRICH_SCHEMA = {
    "type": "object",
    "properties": {
        "useful": {"type": "boolean", "description": "true only if the found information would really help this session"},
        "context": {"type": "string", "description": "the information to add, as short bullets with their source (device + memory/session name); empty if not useful"},
    },
    "required": ["useful", "context"],
}


def retriever_command(prompt_text):
    """The AI retrieval step. CC_BRAIN_RETRIEVER_CMD replaces it in tests."""
    if os.environ.get("CC_BRAIN_RETRIEVER_CMD"):
        return [os.environ["CC_BRAIN_RETRIEVER_CMD"], prompt_text]
    mcp, _ = session_files()
    return ["claude", "-p", prompt_text, "--model", RETRIEVER_MODEL, "--output-format", "json",
            "--no-session-persistence", "--json-schema", json.dumps(ENRICH_SCHEMA), "--strict-mcp-config",
            "--mcp-config", mcp,
            "--allowedTools", "mcp__brain__brain_search,mcp__brain__brain_project_context,"
                              "mcp__brain__brain_list_devices,mcp__brain__brain_get_session",
            "--disallowedTools", "Bash,PowerShell,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,Agent,mcp__brain__brain_remember"]


ENRICH_STOP = set("""the and for with that this what when where which who how why did does done was were are you your
can could should would have has had from into about not but all any some there here then than them they our out get got
make made use used please help want need like just also more most very will its let now new one two see show tell
remind know session sessions work worked working ref""".split())


def enrich_by_search(db, lock, prompt, session_id=""):
    """Enrich without the AI step: the best keyword matches (sessions and memories) for the words of
    the prompt. Used by a token-mode (cloud) brain, and when `claude` is not installed here.
    Fast (one database search), and never more than 3 sessions and 3 memories."""
    terms = []
    for t in re.findall(r"[\w][\w.\-]{2,}", prompt.lower()):
        if t not in ENRICH_STOP and t not in terms:
            terms.append(t)
    if not terms:
        return ""
    q = " ".join(terms[:12])
    with lock:
        sessions = search(db, q, limit=3, any_term=True)
        mems = search_memories(db, q, limit=3)
    cut = lambda v, n: " ".join(str(v or "").split())[:n]  # noqa: E731
    items = []
    for s in sessions:
        day = time.strftime("%Y-%m-%d", time.localtime(s.get("mtime") or 0))
        on = s["device"] + "".join(" and " + c["device"] for c in s.get("also_on") or [] if c["relation"] != "fork")
        items.append("- session on %s (%s, %s, id %s) in %s: %s | last request: %s" % (
            on, s["agent"], day, s["sid"][:8], s.get("cwd") or "?",
            cut(s.get("title") or s.get("first_prompt"), 160), cut(s.get("last_prompt"), 160)))
    for m in mems:
        items.append("- memory on %s (%s): %s: %s" % (" and ".join([m.get("device") or "?"] + (m.get("also_on") or [])),
                                                    m.get("project") or "user level",
                                                    cut(m.get("name"), 80), cut(m.get("body"), 300)))
    listed = {s["sid"] for s in sessions}
    with lock:
        said = [h for h in message_matches(db, terms[:12], limit=4, skip_sid=session_id) if h["sid"] not in listed][:2]
    for h in said:
        day = time.strftime("%Y-%m-%d", time.localtime(h.get("mtime") or 0))
        items.append("- inside the session \"%s\" on %s (%s, id %s, message %d, %s): %s" % (
            cut(h.get("title") or h.get("first_prompt"), 80), h["device"], day, h["sid"][:8], h["idx"], h["role"],
            cut(h["snippet"], 300)))
    with _enrich_lock:
        given = _enrich_given.setdefault(session_id or "-", [])
        items = [i for i in items if i not in given]
        given.extend(items)
        del given[:-200]
    if not items:
        return ""
    return ("[Central brain] Keyword matches for this message in the user's other sessions and memories "
            "(found by a plain search, not chosen by an AI; ignore what does not fit, and use the brain tools "
            "for details):\n" + "\n".join(items))[:3000]


def enrich(db, prompt, cwd="", session_id="", lock=None, search_only=False):
    """Ask the AI retrieval step what the session should know for this prompt. Returns ""
    when nothing helps, or on any error/timeout (the prompt is never blocked).
    search_only (a token-mode brain: a server, where the AI step's brain tools have no token and
    Claude Code is usually not installed): keyword search instead, `claude` is never started."""
    if not (prompt or "").strip():
        return ""
    if search_only and not os.environ.get("CC_BRAIN_RETRIEVER_CMD"):
        try:
            return enrich_by_search(db, lock or threading.Lock(), prompt, session_id)
        except Exception:
            return ""
    local = next((d["name"] for d in load_devices() if d.get("transport") == "local"), "this Mac")
    with _enrich_lock:
        given = "\n\n".join(_enrich_given.get(session_id or "-", []))[-6000:]
    task = f"""You are the retrieval step of the user's central brain. The brain indexes the Claude Code and Codex
sessions and memories of ALL the user's devices and knows how to reach each device.

The user just sent this message to a Claude Code session on the device "{local}", working in the folder
"{cwd or 'unknown'}":
<message>
{prompt[:4000]}
</message>

Use the brain tools to find information that would help that session with this message but that it may not
know: how to reach another device (exact commands, current address, whether it is online), what was done on
another device or in another session, decisions, memories, file locations. Search a few times with short
keywords in the languages the work was likely done in. Use only facts you found with the tools, and name the
source of each (device + memory or session title).

Return useful=false with empty context when nothing would really help: general questions (writing, math,
concepts), or when the message is fully answerable without the user's history. Do not answer the message.
Keep context under 1500 characters.

The session ALREADY HAS this context from earlier messages. Add only facts that are not in it; if the
useful facts are all already there, return useful=false:
<already_given>
{given or 'nothing yet'}
</already_given>"""
    try:
        p = subprocess.run(retriever_command(task), capture_output=True, text=True, timeout=RETRIEVER_TIMEOUT,
                           cwd=CONF_DIR)
        j = json.loads(p.stdout)
        r = j.get("structured_output") or j
    except Exception:
        return ""
    if not r.get("useful") or not (r.get("context") or "").strip():
        return ""
    with _enrich_lock:
        _enrich_given.setdefault(session_id or "-", []).append(r["context"].strip()[:3000])
    return ("[Central brain] Found in the user's other sessions, memories and devices for this message "
            "(added automatically; use it if it helps):\n" + r["context"].strip())[:6000]


def session_files():
    """Files that give a panel-started session the brain: MCP tools + the prompt hook.
    Passed with --mcp-config / --settings; the user's own config is not changed."""
    os.makedirs(CONF_DIR, exist_ok=True)
    mcp = os.path.join(CONF_DIR, "session-mcp.json")
    settings = os.path.join(CONF_DIR, "session-settings.json")
    with open(mcp, "w") as f:
        json.dump({"mcpServers": {"brain": {"command": "python3", "args": ["-I", os.path.join(HERE, "mcp_server.py")]}}}, f)
    with open(settings, "w") as f:
        json.dump({"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "timeout": 60,
                   "command": "python3 -I " + os.path.join(HERE, "hooks", "prompt_context.py")}]}]}}, f)
    return mcp, settings


def forget(db, project):
    """Delete memories that agents wrote for one project (never collected files)."""
    with db:
        ids = [r["id"] for r in db.execute("SELECT id FROM memories WHERE origin='agent' AND project=?", (project,))]
        for i in ids:
            db.execute("DELETE FROM memories_fts WHERE rowid=?", (i,))
        db.execute("DELETE FROM memories WHERE origin='agent' AND project=?", (project,))
    return len(ids)


def remove_device(db, name):
    """Remove one device from the brain: its sessions, its collected memory files, its device record
    (cloud devices: its token too) and, for a device the brain pulls from, its line in devices.json.
    Notes that agents saved with brain_remember stay: they belong to the project, not to the device.
    The brain's own computer cannot be removed. A device known only by its heartbeats (sent with the
    owner token) comes back with its next heartbeat while it runs: stop Thoth there first.
    Returns what was deleted. Raises ValueError/LookupError."""
    name = str(name or "").strip()
    if not name:
        raise ValueError("device name required")
    conf = load_devices()
    if any(d.get("name") == name and d.get("transport") == "local" for d in conf):
        raise ValueError('"%s" is the computer the brain runs on; it cannot be removed' % name)
    known = (db.execute("SELECT 1 FROM devices WHERE name=?", (name,)).fetchone()
             or db.execute("SELECT 1 FROM cloud_devices WHERE name=?", (name,)).fetchone()
             or db.execute("SELECT 1 FROM sessions WHERE device=? LIMIT 1", (name,)).fetchone()
             or db.execute("SELECT 1 FROM heartbeats WHERE device=?", (name,)).fetchone()
             or any(d.get("name") == name for d in conf))
    if not known:
        raise LookupError('the brain has no device called "%s"' % name)
    with db:
        sids = [r[0] for r in db.execute("SELECT id FROM sessions WHERE device=?", (name,))]
        for i in sids:
            db.execute("DELETE FROM sessions_fts WHERE rowid=?", (i,))
            db.execute("DELETE FROM messages WHERE session=?", (i,))
        db.execute("DELETE FROM sessions WHERE device=?", (name,))
        mids = [r[0] for r in db.execute("SELECT id FROM memories WHERE origin='file' AND device=?", (name,))]
        for i in mids:
            db.execute("DELETE FROM memories_fts WHERE rowid=?", (i,))
        db.execute("DELETE FROM memories WHERE origin='file' AND device=?", (name,))
        db.execute("DELETE FROM devices WHERE name=?", (name,))
        heartbeat.forget(db, name)
    for r in db.execute("SELECT id FROM cloud_devices WHERE name=?", (name,)).fetchall():
        peers.forget_device(db, r["id"])
    cloud_auth.remove(db, name)
    pulled = False
    if os.path.exists(DEVICES_PATH) and any(d.get("name") == name for d in conf):
        tmp = DEVICES_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump([d for d in conf if d.get("name") != name], f, indent=1)
        os.replace(tmp, DEVICES_PATH)
        pulled = True
    return {"device": name, "sessions": len(sids), "memories": len(mids), "pulled": pulled}


def ensure_token():
    """Secret for write calls (brain_remember). Readable only by this user."""
    if not os.path.exists(TOKEN_PATH):
        os.makedirs(CONF_DIR, exist_ok=True)
        fd = os.open(TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, hashlib.sha256(os.urandom(32)).hexdigest().encode())
        os.close(fd)
    with open(TOKEN_PATH) as f:
        return f.read().strip()


def set_device(db, name, **kw):
    with db:
        db.execute("INSERT INTO devices (name) VALUES (?) ON CONFLICT(name) DO NOTHING", (name,))
        for k, v in kw.items():
            db.execute("UPDATE devices SET %s=? WHERE name=?" % k, (v, name))
        count = db.execute("SELECT COUNT(*) FROM sessions WHERE device=?", (name,)).fetchone()[0]
        db.execute("UPDATE devices SET sessions=? WHERE name=?", (count, name))


# ------------------------------------------------------------------ pull ----
def run(cmd, timeout=180):
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).decode("utf-8", "replace").strip()[-300:] or "exit %d" % p.returncode)
    return p.stdout


def ssh_base(dev):
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"] + [os.path.expanduser(a) for a in dev["ssh"]]


def deploy_remote(dev):
    """Copy collector.py to the device when its hash differs. Windows and POSIX."""
    local_hash = hashlib.sha256(open(COLLECTOR, "rb").read()).hexdigest()
    py = dev.get("python", "python3")
    remote = dev.get("collector_path", ".cc-brain/collector.py")
    check = "%s -c \"import hashlib,os;p=os.path.expanduser('~/%s');print(hashlib.sha256(open(p,'rb').read()).hexdigest() if os.path.exists(p) else '')\"" % (py, remote)
    try:
        remote_hash = run(ssh_base(dev) + [check], timeout=30).decode().strip()
    except RuntimeError:
        remote_hash = ""
    if remote_hash == local_hash:
        return False
    mk = "%s -c \"import os;os.makedirs(os.path.expanduser('~/.cc-brain'),exist_ok=True)\"" % py
    run(ssh_base(dev) + [mk], timeout=30)
    host = dev["ssh"][-1]
    opts = [os.path.expanduser(a) for a in dev["ssh"][:-1]]
    run(["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"] + opts + [COLLECTOR, host + ":" + remote], timeout=60)
    return True


def pull(dev, full=False):
    flag = ["--all"] if full else []
    if dev.get("transport") == "local":
        out = run([sys.executable, "-I", COLLECTOR] + flag)
    elif dev.get("transport") == "ssh":
        deploy_remote(dev)
        py = dev.get("python", "python3")
        remote = dev.get("collector_path", ".cc-brain/collector.py")
        cmd = "%s -I %s %s" % (py, remote, " ".join(flag))
        out = run(ssh_base(dev) + [cmd])
    else:
        raise RuntimeError("unknown transport %r" % dev.get("transport"))
    return json.loads(out.decode("utf-8", "replace"))


def sync(db, full=False, log=print):
    results = []
    for dev in load_devices():
        name = dev["name"]
        t0 = time.time()
        try:
            # a device the brain has nothing from gets a full collection: its collector may remember
            # sending data to an earlier brain (reinstall, new brain machine)
            empty = not db.execute("SELECT 1 FROM sessions WHERE device=? LIMIT 1", (name,)).fetchone()
            doc = pull(dev, full=full or empty)
            n = ingest(db, doc, name)
            set_device(db, name, os=doc.get("os"), home=doc.get("home"), transport=dev.get("transport"),
                       last_sync=int(time.time()), ok=1, error="")
            results.append({"device": name, "ok": True, "updated": n, "errors": len(doc.get("errors", [])),
                            "seconds": round(time.time() - t0, 1)})
        except Exception as e:
            set_device(db, name, transport=dev.get("transport"), last_sync=int(time.time()), ok=0, error=str(e)[:300])
            results.append({"device": name, "ok": False, "error": str(e)[:300]})
    for r in results:
        log(json.dumps(r, ensure_ascii=False))
    return results


# ----------------------------------------------------------------- query ----
# ------------------------------------------------- copies of one session ----
# The same session (same agent and id) can be on several devices: a config or a home folder copied
# to a new computer (Migration Assistant), one computer joined twice, or a session handed over.
# The brain keeps every copy as it was sent. Reads show each session once: a copy with the same
# dialogue, or an older part of it, is folded into the best copy (`also_on`). When both copies went
# on after a common part, they are a fork: both stay, and the other one says `fork_of`.
def _dialogue_hashes(db, rid):
    return [hashlib.sha1(((r[0] or "") + "\0" + (r[1] or "")).encode("utf-8", "replace")).digest()
            for r in db.execute("SELECT role, text FROM messages WHERE session=? ORDER BY idx", (rid,))]


def copies(db, agent, sid):
    """Every copy of one session, best first (most messages, then newest). Each copy gets
    `messages` (its count), `relation` to the best copy ('main', 'same', 'older' = an older part of
    it, 'fork' = both went on after `common` messages, 'unknown' = no dialogue to compare) and `common`."""
    rows = [dict(r) for r in db.execute("SELECT * FROM sessions WHERE agent=? AND sid=?", (agent, sid))]
    if not rows:
        return []
    hs = {r["id"]: _dialogue_hashes(db, r["id"]) for r in rows}
    rows.sort(key=lambda r: (len(hs[r["id"]]), r.get("mtime") or 0, r.get("device") or ""), reverse=True)
    main, mh = rows[0], hs[rows[0]["id"]]
    out = [dict(main, messages=len(mh), relation="main", common=len(mh))]
    for r in rows[1:]:
        h = hs[r["id"]]
        if not h or not mh:   # an old collector sent no dialogue: only identical summaries count as the same
            same = all((r.get(k) or "") == (main.get(k) or "") for k in ("first_prompt", "last_prompt", "last_reply"))
            out.append(dict(r, messages=len(h), relation="same" if same and len(h) == len(mh) else "unknown", common=0))
            continue
        common = 0
        for a, b in zip(h, mh):
            if a != b:
                break
            common += 1
        rel = ("same" if len(h) == len(mh) else "older") if common == len(h) else "fork"
        out.append(dict(r, messages=len(h), relation=rel, common=common))
    return out


def merge_copies(db, rows):
    """A result list with each session once (see above). rows: dicts with device, agent and sid, in
    result order. Of the copies of one session that are in the list, the best one stays (with
    `also_on`: every other copy, its device, relation and messages); forks and copies that cannot be
    compared stay too (with `fork_of`); copies that are the same or older are dropped."""
    keys = list({(r["agent"], r["sid"]) for r in rows})
    multi = set()
    for i in range(0, len(keys), 200):
        part = keys[i:i + 200]
        q = " OR ".join("(agent=? AND sid=?)" for _ in part)
        multi |= {(r[0], r[1]) for r in db.execute(
            "SELECT agent, sid FROM sessions WHERE " + q + " GROUP BY agent, sid HAVING COUNT(*) > 1",
            [x for k in part for x in k])}
    if not multi:
        return rows
    info, kept_main = {}, set()
    for k in multi:
        cs = copies(db, *k)
        info[k] = {c["device"]: c for c in cs}
        info[k]["_order"] = [c["device"] for c in cs]
    present = {}
    for r in rows:
        k = (r["agent"], r["sid"])
        if k in multi:
            present.setdefault(k, set()).add(r["device"])
    out = []
    for r in rows:
        k = (r["agent"], r["sid"])
        if k not in multi:
            out.append(r)
            continue
        cs, dev = info[k], r["device"]
        c = cs.get(dev)
        if not c:
            out.append(r)
            continue
        main_dev = cs["_order"][0]
        # the best copy that is in the list stands for the main copy and every same or older one
        stand_in = next((d for d in cs["_order"] if d in present[k] and cs[d]["relation"] in ("main", "same", "older")), None)
        if c["relation"] in ("fork", "unknown"):
            out.append(dict(r, fork_of={"device": main_dev, "common": c["common"], "relation": c["relation"]}))
        elif dev == stand_in and k not in kept_main:
            kept_main.add(k)
            out.append(dict(r, also_on=[{"device": d, "relation": cs[d]["relation"], "messages": cs[d]["messages"],
                                         "common": cs[d]["common"]} for d in cs["_order"] if d != dev]))
    return out


def fts_query(q, any_term=False):
    # trigram tokenizer: each term needs >= 3 characters; quote terms to keep punctuation literal
    terms = [t for t in q.replace('"', " ").split() if t]
    return (" OR " if any_term else " AND ").join('"%s"' % t for t in terms)


def search(db, q="", device="", project="", agent="", limit=50, any_term=False, merge=True):
    """Sessions that match. Each session once (merge_copies), unless a device is named or merge=False."""
    merge = merge and not device
    sql = "SELECT s.* FROM sessions s"
    where, args = [], []
    like_terms = []
    if q:
        terms = [t for t in q.split() if t]
        long_terms = [t for t in terms if len(t) >= 3]
        like_terms = [t for t in terms if len(t) < 3]  # trigram cannot match 1-2 chars; use LIKE
        if long_terms:
            sql += " JOIN sessions_fts f ON f.rowid = s.id"
            where.append("sessions_fts MATCH ?")
            args.append(fts_query(" ".join(long_terms), any_term))
    for t in ([] if any_term and q and any(len(x) >= 3 for x in q.split()) else like_terms):
        where.append("(s.title LIKE ? OR s.first_prompt LIKE ? OR s.last_prompt LIKE ? OR s.last_reply LIKE ? OR s.cwd LIKE ?)")
        args += ["%" + t + "%"] * 5
    for col, val in (("device", device), ("project", project), ("agent", agent)):
        if val:
            where.append("s.%s = ?" % col)
            args.append(val)
    if where:
        sql += " WHERE " + " AND ".join(where)
    ranked = any_term and " JOIN sessions_fts f " in sql
    sql += (" ORDER BY bm25(sessions_fts), s.mtime DESC" if ranked else " ORDER BY s.mtime DESC") + " LIMIT ?"
    args.append(int(limit) * (3 if merge else 1))   # room for the copies that merge_copies folds away
    rows = [dict(r) for r in db.execute(sql, args)]
    return (merge_copies(db, rows) if merge else rows)[:int(limit)]


def _snippet(text, pos, width=160):
    """The part of a message around character `pos`, on one line."""
    a, b = max(0, pos - width), min(len(text), pos + width)
    return ("…" if a else "") + " ".join(text[a:b].split()) + ("…" if b < len(text) else "")


def _session_filter(device="", project="", agent="", sid=""):
    where, args = [], []
    for col, val in (("device", device), ("project", project), ("agent", agent)):
        if val:
            where.append("s.%s = ?" % col)
            args.append(val)
    if sid:
        where.append("s.sid LIKE ?")
        args.append(sid.replace("%", "").replace("_", "") + "%")
    return where, args


def grep(db, q, device="", project="", agent="", sid="", role="", regex=False, context=0, limit=30, mode="hits",
         merge=True):
    """Search the text of every message of every session, the way a coding agent greps files.
    q: the words to find, as one phrase (case ignored); with regex=True a regular expression.
    role: "user", "assistant" or "tool" for only those messages. Newest sessions first.
    mode "hits": the matching messages, each with a snippet around the match, its session and its
    position (idx), and `context` messages before and after. mode "sessions": the sessions that
    have a match, with the number of matching messages."""
    q = (q or "").strip()
    if not q:
        raise ValueError("the pattern is empty")
    if regex:
        try:
            pat = re.compile(q, re.I)
        except re.error as e:
            raise ValueError("the regular expression is not valid: %s" % e)
        match, margs, join = "m.text REGEXP ?", [q], ""
    elif len(q) >= 3:  # trigram index: a phrase of 3 or more characters
        pat = re.compile(re.escape(q), re.I)
        match, margs, join = "messages_fts MATCH ?", ['"%s"' % q.replace('"', '""')], " JOIN messages_fts f ON f.rowid = m.id"
    else:
        pat = re.compile(re.escape(q), re.I)
        esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        match, margs, join = "m.text LIKE ? ESCAPE '\\'", ["%" + esc + "%"], ""
    where, args = _session_filter(device, project, agent, sid)
    where = [match] + where
    args = margs + args
    if role:
        where.append("m.role = ?")
        args.append(role)
    base = " FROM messages m" + join + " JOIN sessions s ON s.id = m.session WHERE " + " AND ".join(where)
    cols = "s.device, s.agent, s.sid, s.title, s.first_prompt, s.cwd, s.project, s.mtime"
    limit, context = max(1, min(int(limit), 200)), max(0, min(int(context), 5))
    merge = merge and not device
    room = limit * (3 if merge else 1)   # copies on other devices are folded away (merge_copies)
    if mode == "sessions":
        rows = [dict(r) for r in db.execute("SELECT " + cols + ", COUNT(*) AS hits, MIN(m.idx) AS first_idx, MAX(m.idx) AS last_idx" +
                                            base + " GROUP BY s.id ORDER BY s.mtime DESC LIMIT ?", args + [room])]
        return {"pattern": q, "sessions": (merge_copies(db, rows) if merge else rows)[:limit]}
    total = db.execute("SELECT COUNT(*)" + base, args).fetchone()[0]
    rows = db.execute("SELECT " + cols + ", m.session AS session_row, m.idx, m.role, m.ts, m.text" + base +
                      " ORDER BY s.mtime DESC, m.idx DESC LIMIT ?", args + [room]).fetchall()
    if merge:
        seen, per = [], {}
        for r in rows:
            if (r["device"], r["agent"], r["sid"]) not in per:
                per[(r["device"], r["agent"], r["sid"])] = {"device": r["device"], "agent": r["agent"], "sid": r["sid"]}
                seen.append(per[(r["device"], r["agent"], r["sid"])])
        kept = {(x["device"], x["agent"], x["sid"]): x for x in merge_copies(db, seen)}
        rows = [r for r in rows if (r["device"], r["agent"], r["sid"]) in kept]
    rows = rows[:limit]
    hits = []
    for r in rows:
        h = dict(r)
        text = h.pop("text") or ""
        row = h.pop("session_row")
        mm = pat.search(text)
        h["snippet"] = _snippet(text, mm.start() if mm else 0)
        if merge:
            extra = kept[(h["device"], h["agent"], h["sid"])]
            for f in ("also_on", "fork_of"):
                if f in extra:
                    h[f] = extra[f]
        if context:
            near = db.execute("SELECT idx, role, text FROM messages WHERE session=? AND idx BETWEEN ? AND ? AND idx != ? "
                              "ORDER BY idx", (row, h["idx"] - context, h["idx"] + context, h["idx"])).fetchall()
            h["context"] = [{"idx": n["idx"], "role": n["role"], "text": _snippet(n["text"] or "", 0, 300)} for n in near]
        hits.append(h)
    return {"pattern": q, "total": total, "hits": hits}


def read_session(db, sid, device="", start=None, count=30, around=None, max_chars=1500):
    """Read part of one session's dialogue, the way a coding agent reads part of a file.
    sid: the session id or its first characters. start: the first message position (default: the
    last `count` messages). around: a position from grep; the messages around it are returned."""
    where, args = _session_filter(device=device, sid=sid)
    rows = [dict(r) for r in db.execute("SELECT s.* FROM sessions s WHERE " + " AND ".join(where) +
                                        " ORDER BY s.mtime DESC LIMIT 50", args)] if sid else []
    if not rows:
        return None
    ids = list(dict.fromkeys((r["agent"], r["sid"]) for r in rows))
    cs = []
    if not device and len(ids) == 1 and len(rows) > 1:
        # one session on several devices: read the best copy, and say where the others are
        cs = copies(db, *ids[0])
        rows = [next(r for r in rows if r["device"] == cs[0]["device"])]
    s = dict(rows[0])
    total = db.execute("SELECT COUNT(*) FROM messages WHERE session=?", (s["id"],)).fetchone()[0]
    count = max(1, min(int(count), 100))
    if around is not None:
        start = int(around) - count // 2
    if start is None:
        start = total - count
    start = max(0, min(int(start), max(0, total - 1)))
    msgs = db.execute("SELECT idx, role, ts, text FROM messages WHERE session=? AND idx >= ? ORDER BY idx LIMIT ?",
                      (s["id"], start, count)).fetchall()
    max_chars = max(100, min(int(max_chars), 6000))
    out = []
    for m in msgs:
        t = m["text"] or ""
        out.append({"idx": m["idx"], "role": m["role"], "ts": m["ts"],
                    "text": t if len(t) <= max_chars else t[:max_chars] + " [… %d more characters; ask with a larger max_chars]" % (len(t) - max_chars)})
    r = {"session": s, "total": total, "start": start, "messages": out, "more_than_one": len(ids) > 1}
    if cs:
        r["copies"] = [{"device": c["device"], "relation": c["relation"], "messages": c["messages"], "common": c["common"]}
                       for c in cs]
    return r


def message_matches(db, terms, limit=2, skip_sid=""):
    """The messages that best match any of the terms (for the prompt hook): one per session."""
    terms = [t for t in terms if len(t) >= 3]
    if not terms:
        return []
    try:
        rows = db.execute(
            "SELECT s.device, s.agent, s.sid, s.title, s.first_prompt, s.mtime, m.idx, m.role, m.text "
            "FROM messages_fts f JOIN messages m ON m.id = f.rowid JOIN sessions s ON s.id = m.session "
            "WHERE messages_fts MATCH ? AND m.role != 'tool' ORDER BY bm25(messages_fts) LIMIT 60",
            (" OR ".join('"%s"' % t.replace('"', '""') for t in terms),)).fetchall()
    except sqlite3.Error:
        return []
    out, seen = [], set()
    for r in rows:
        if r["sid"] in seen or (skip_sid and r["sid"] == skip_sid):
            continue
        seen.add(r["sid"])
        low = (r["text"] or "").lower()
        found = [t for t in terms if t.lower() in low]
        # one common word is noise: two of the words, or one exact name (a file, a command, a number)
        if len(found) < 2 and not any(len(t) >= 6 and re.search(r"[0-9_.\-]|[a-z][A-Z]", t) for t in found):
            continue
        pos = min([low.find(t.lower()) for t in found] or [0])
        out.append(dict(r, snippet=_snippet(r["text"] or "", pos, 140)))
        if len(out) >= limit:
            break
    return out


def search_memories(db, q="", project="", scope="", limit=30, any_term=True, merge=True):
    """Memories that match. The same memory file collected on several devices (a copied home
    folder) is listed once, with `also_on` naming the other devices (merge=False: every copy)."""
    sql, where, args = "SELECT m.* FROM memories m", [], []
    terms = [t for t in q.split() if t]
    long_terms = [t for t in terms if len(t) >= 3]
    if long_terms:
        sql += " JOIN memories_fts f ON f.rowid = m.id"
        where.append("memories_fts MATCH ?")
        args.append(fts_query(" ".join(long_terms), any_term))
    elif terms:
        where.append("(" + " OR ".join("(m.name LIKE ? OR m.body LIKE ?)" for _ in terms) + ")")
        for t in terms:
            args += ["%" + t + "%"] * 2
    if project:
        where.append("m.project = ?")
        args.append(project)
    if scope:
        where.append("m.scope = ?")
        args.append(scope)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += (" ORDER BY bm25(memories_fts)" if long_terms else " ORDER BY m.mtime DESC") + " LIMIT ?"
    args.append(int(limit) * (3 if merge else 1))
    rows = [dict(r) for r in db.execute(sql, args)]
    if not merge:
        return rows
    out, by_key = [], {}
    for m in rows:
        key = (m.get("origin"), m.get("name"), hashlib.sha256((m.get("body") or "").encode()).hexdigest())
        if key in by_key:
            first = by_key[key]
            if m.get("device") and m["device"] != first.get("device") and m["device"] not in first["also_on"]:
                first["also_on"].append(m["device"])
            continue
        m["also_on"] = []
        by_key[key] = m
        out.append(m)
    for m in out:
        if not m["also_on"]:
            del m["also_on"]
    return out[:int(limit)]


def context(db, project="", folder="", limit=10):
    """Everything the brain knows about one project, from every device."""
    if not project and folder:
        import collector
        project = collector.project_key(folder)
    mems = search_memories(db, project=project, limit=50) if project else []
    user = search_memories(db, scope="user", limit=20)
    sess = search(db, project=project, limit=limit) if project else []
    return {"project": project, "project_memories": mems, "user_memories": user, "recent_sessions": sess,
            "devices": sorted({s["device"] for s in sess})}


def projects(db):
    rows = db.execute("""SELECT project, COUNT(DISTINCT agent || ':' || sid) n, MAX(mtime) last, GROUP_CONCAT(DISTINCT device) devices,
                         GROUP_CONCAT(DISTINCT agent) agents FROM sessions GROUP BY project ORDER BY last DESC""")
    return [dict(r) for r in rows]


def devices(db):
    return [dict(r) for r in db.execute("SELECT * FROM devices ORDER BY name")]


# ------------------------------------------------------------------ http ----
# Access. Two modes:
# - local trust (the single-Mac setup): the brain listens on 127.0.0.1 and has no owner token, so a
#   request from this machine without a token is trusted, as before. Write calls still need the
#   brain's own token (TOKEN_PATH), as before.
# - tokens required (cloud brain behind Caddy, or any brain with an owner token): every endpoint
#   except GET /api/health needs the owner token or a device token, even from 127.0.0.1, because
#   Caddy connects from 127.0.0.1. Once a brain has had an owner token it never falls back to local
#   trust (a deleted token file must not open it). CC_BRAIN_LOCAL_TRUST=1/0 forces the mode.
VERSION = "1.2"
BIND_HOST = os.environ.get("CC_BRAIN_HOST", "127.0.0.1")
MAX_BODY = 256 * 1024                                                       # every POST but ingest
MAX_INGEST = int(os.environ.get("CC_BRAIN_MAX_INGEST", str(32 * 1024 * 1024)))
JOIN_LIMIT = (10, 600)          # join requests per client address per 10 minutes
JOIN_GLOBAL = (200, 600)        # join requests from everyone per 10 minutes
BAD_CODE_LIMIT = (5, 600)       # wrong or mistyped codes per client address per 10 minutes
POLL_LIMIT = (120, 60)          # polls per client address per minute
BAD_TOKEN_LIMIT = (20, 600)     # wrong tokens per client address per 10 minutes, then 429 for all calls
DEVICE_ROUTE = re.compile(r"^/api/devices/(d[0-9a-f]{16})/(approve|ignore|unignore|revoke)$")
JOIN_ROUTE = re.compile(r"^/api/join/([^/]{1,40})$")
_auth_required = False          # becomes True for good once an owner token was seen


def is_loopback(host):
    return host in ("127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1") or str(host).startswith("127.")


def log_event(msg):
    """One line on stderr (the service log). Never pass a token, code or secret here."""
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, file=sys.stderr, flush=True)


def auth_required(db):
    """True when tokens are required (see the comment above)."""
    global _auth_required
    forced = os.environ.get("CC_BRAIN_LOCAL_TRUST")
    if forced in ("0", "1"):
        return forced == "0" or not is_loopback(BIND_HOST)
    if _auth_required:
        return True
    if not is_loopback(BIND_HOST):
        _auth_required = True
    elif cloud_auth.owner_token_exists(CONF_DIR):
        _auth_required = True
        cloud_auth.set_meta(db, "auth_required", "1")
    elif cloud_auth.get_meta(db, "auth_required") == "1":
        _auth_required = True
    return _auth_required


def reserved_names(db):
    """Names of devices the brain pulls from or that pushed through the panel (not cloud devices)."""
    names = {d.get("name") for d in load_devices()}
    names |= {r[0] for r in db.execute("SELECT name FROM devices")}
    return names


def all_devices(db, now=None):
    """GET /api/devices: pulled devices (local, ssh, push) and cloud devices with their status, and
    each device's newest heartbeat (brain/heartbeat.py). A device known only by its heartbeats (sent
    with the owner token) has transport 'heartbeat'."""
    cloud = cloud_auth.list_devices(db)
    cloud_names = {d["name"] for d in cloud}
    out = []
    for d in devices(db):
        if d["name"] in cloud_names:
            continue
        d.update(status="approved", last_seen=d.get("last_sync"), last_error=d.get("error") or "")
        out.append(d)
    for d in cloud:
        d.update(ok=1 if d["status"] == "approved" and not d["last_error"] else 0, error=d["last_error"],
                 last_sync=d["last_seen"])
        out.append(d)
    known = {d["name"] for d in out}
    for name in sorted(set(heartbeat.latest(db)) - known):
        out.append({"name": name, "os": "", "transport": "heartbeat", "sessions": 0, "status": "approved",
                    "ok": 1, "error": "", "last_sync": None, "last_seen": None, "last_error": ""})
    return heartbeat.attach(out, db, time.time() if now is None else now)


class HttpError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


class Handler(BaseHTTPRequestHandler):
    db = None
    lock = threading.Lock()
    limiter = cloud_auth.RateLimiter()
    timeout = 30                      # a slow or silent client cannot hold a thread for ever
    server_version = "cc-brain"
    sys_version = ""

    def log_message(self, *a):
        pass

    def send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    # --- who is asking ---------------------------------------------------
    def peer(self):
        return self.client_address[0] if self.client_address else ""

    def proxied(self):
        return any(self.headers.get(h) for h in ("X-Forwarded-For", "Forwarded", "X-Real-IP", "Via"))

    def client_ip(self):
        """The client address for rate limits. Behind Caddy (a proxy on this machine) it is the last
        X-Forwarded-For entry, which Caddy sets; a remote peer cannot choose it."""
        if is_loopback(self.peer()):
            xff = (self.headers.get("X-Forwarded-For") or "").split(",")[-1].strip()
            if xff:
                return xff[:64]
        return self.peer()

    def bearer(self):
        h = self.headers.get("Authorization") or ""
        return h[7:].strip() if h[:7].lower() == "bearer " else ""

    def is_owner_token(self, tok):
        h = cloud_auth.hash_secret(tok)
        owner = cloud_auth.read_owner_token(CONF_DIR)
        if owner and cloud_auth.same(h, cloud_auth.hash_secret(owner)):
            return True
        # the brain's own write token (TOKEN_PATH, 0600 next to the owner token) counts as the owner:
        # the panel on the brain's machine already sends it for writes and pushed devices
        try:
            with open(TOKEN_PATH) as f:
                legacy = f.read().strip()
        except OSError:
            legacy = ""
        return bool(legacy) and cloud_auth.same(h, cloud_auth.hash_secret(legacy))

    def auth(self, need):
        """need: 'read' (owner or device), 'owner', 'write' (owner token even in local trust), 'device'
        (ingest: device token, or the owner token with a device name in the body).
        Returns (role, device_row); role is 'owner', 'device' or 'local'. Raises HttpError."""
        ip = self.client_ip()
        if self.limiter.over(("badtoken", ip), *BAD_TOKEN_LIMIT):
            raise HttpError(429, "too many wrong tokens from your address; wait 10 minutes")
        tok = self.bearer()
        if tok:
            if self.is_owner_token(tok):
                return "owner", None
            with self.lock:
                dev = cloud_auth.device_by_token(self.db, tok)
                if dev:
                    cloud_auth.touch(self.db, dev["id"], last_seen=int(time.time()))
            if dev:
                if need in ("owner", "write"):
                    raise HttpError(403, "this needs the owner token; a device token cannot do this")
                return "device", dev
            self.limiter.hit(("badtoken", ip), *BAD_TOKEN_LIMIT)
            log_event("refused a wrong token from %s for %s %s" % (ip, self.command, urlparse(self.path).path))
            raise HttpError(401, "missing or wrong token")
        if need in ("read", "owner") and self.local_trusted():
            return "local", None
        raise HttpError(401, "missing or wrong token")

    def local_trusted(self):
        """Local trust: no owner token on a 127.0.0.1 brain, a request from this machine, and not
        forwarded by a proxy (a request through Caddy carries X-Forwarded-For)."""
        with self.lock:
            required = auth_required(self.db)
        return not required and is_loopback(self.peer()) and not self.proxied()

    def body(self, limit=MAX_BODY):
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self.close_connection = True
            raise HttpError(411, "send the body with a Content-Length")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise HttpError(400, "bad Content-Length")
        if n < 0:
            raise HttpError(400, "bad Content-Length")
        if n > limit:
            self.close_connection = True
            raise HttpError(413, "the request is too large (limit %d bytes)" % limit)
        self.body_read = True
        raw = self.rfile.read(n) if n else b""
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise HttpError(400, "the request body is not valid JSON")
        if not isinstance(data, dict):
            raise HttpError(400, "the request body must be a JSON object")
        return data

    # --- routing -----------------------------------------------------------
    def drain(self):
        """Read a body that the request handler did not need (a refused request). Closing a socket
        with unread data sends a reset, and the client (on Windows always) loses the answer."""
        if self.body_read:
            return
        self.body_read = True
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return
        if 0 < n <= MAX_BODY and "chunked" not in (self.headers.get("Transfer-Encoding") or "").lower():
            self.rfile.read(n)

    def handle_safely(self, fn):
        self.body_read = False
        try:
            fn()
        except HttpError as e:
            try:
                self.drain()
            except (OSError, socket.timeout):
                self.close_connection = True
                return
            self.send(e.code, {"error": e.msg})
        except ValueError:
            self.send(400, {"error": "a parameter has a wrong value"})
        except (BrokenPipeError, ConnectionResetError, TimeoutError, socket.timeout):
            self.close_connection = True
        except Exception as e:   # never echo internals (or request data) to the client or the log
            log_event("error in %s %s: %s" % (self.command, urlparse(self.path).path, type(e).__name__))
            try:
                self.send(500, {"error": "internal error in the brain"})
            except Exception:
                pass

    def do_GET(self):
        self.handle_safely(self.get)

    def do_POST(self):
        self.handle_safely(self.post)

    def get(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        lim = lambda d: max(1, min(int(q.get("limit", d)), 1000))  # noqa: E731

        def num(key, default):
            try:
                return int(q[key]) if q.get(key) not in (None, "") else default
            except ValueError:
                raise HttpError(400, "%s must be a number" % key)
        if u.path == "/api/health":
            with self.lock:
                local = not auth_required(self.db)
            out = {"ok": True, "version": VERSION, "auth": "local" if local else "token"}
            if local:
                out["port"] = PORT
            return self.send(200, out)
        m = JOIN_ROUTE.match(u.path)
        if m:
            return self.poll_join(m.group(1))
        if u.path in ("/api/peer/keys", "/api/peer/links"):
            return self.peer_get(u.path, q)
        read = {"/api/sessions", "/api/memories", "/api/context", "/api/search", "/api/projects", "/api/grep",
                "/api/session"}
        owner = {"/api/devices", "/api/handoffs"}
        if u.path not in read | owner:
            raise HttpError(404, "not found")
        self.auth("read" if u.path in read else "owner")
        with self.lock:
            if u.path == "/api/devices":
                return self.send(200, all_devices(self.db))
            if u.path == "/api/projects":
                return self.send(200, projects(self.db))
            merge = q.get("copies") != "all"   # ?copies=all: every device's copy of a session or memory
            if u.path == "/api/sessions":
                return self.send(200, search(self.db, q.get("q", ""), q.get("device", ""), q.get("project", ""),
                                             q.get("agent", ""), lim(50), q.get("mode") == "any", merge))
            if u.path == "/api/search":
                return self.send(200, {
                    "sessions": search(self.db, q.get("q", ""), q.get("device", ""), q.get("project", ""),
                                       q.get("agent", ""), lim(50), q.get("mode") == "any", merge),
                    "memories": search_memories(self.db, q.get("q", ""), q.get("project", ""), q.get("scope", ""),
                                                lim(30), merge=merge)})
            if u.path == "/api/memories":
                return self.send(200, search_memories(self.db, q.get("q", ""), q.get("project", ""), q.get("scope", ""),
                                                      lim(30), merge=merge))
            if u.path == "/api/handoffs":
                return self.send(200, handoffs(self.db, lim(20)))
            if u.path == "/api/grep":
                try:
                    return self.send(200, grep(self.db, q.get("q", ""), q.get("device", ""), q.get("project", ""),
                                               q.get("agent", ""), q.get("sid", ""), q.get("role", ""),
                                               q.get("regex") in ("1", "true"), num("context", 0), lim(30),
                                               q.get("mode") or "hits", merge))
                except ValueError as e:
                    raise HttpError(400, str(e))
            if u.path == "/api/session":
                r = read_session(self.db, q.get("sid", ""), q.get("device", ""),
                                 num("start", None), num("count", 30), num("around", None), num("max_chars", 1500))
                if r is None:
                    raise HttpError(404, "no session with this id")
                return self.send(200, r)
            if u.path == "/api/context":
                return self.send(200, context(self.db, q.get("project", ""), q.get("folder", ""), lim(10)))

    def poll_join(self, did):
        """GET /api/join/<id> with Authorization: Bearer <poll_secret> (never in the URL)."""
        ip = self.client_ip()
        if self.limiter.over(("badtoken", ip), *BAD_TOKEN_LIMIT):
            raise HttpError(429, "too many wrong tokens from your address; wait 10 minutes")
        if not self.limiter.hit(("poll", ip), *POLL_LIMIT):
            raise HttpError(429, "polling too fast; wait a minute")
        with self.lock:
            r = cloud_auth.poll(self.db, did, self.bearer())
        if r is None:
            self.limiter.hit(("badtoken", ip), *BAD_TOKEN_LIMIT)
            raise HttpError(401, "unknown join request or wrong poll secret")
        if r.get("token"):
            log_event("device %s fetched its token" % r["device"])
        return self.send(200, r)

    def post(self):
        path = urlparse(self.path).path
        if path == "/api/join":
            return self.join()
        m = DEVICE_ROUTE.match(path)
        if m:
            self.auth("owner")
            self.body()
            with self.lock:
                try:
                    d = cloud_auth.decide(self.db, m.group(1), m.group(2), reserved_names(self.db))
                except LookupError as e:
                    raise HttpError(404, str(e))
                except ValueError as e:
                    raise HttpError(409, str(e))
            log_event("owner: %s device %s (%s)" % (m.group(2), d["name"], d["id"]))
            return self.send(200, d)
        if path == "/api/devices/remove":
            self.auth("write")
            name = str(self.body().get("name") or "")
            with self.lock:
                try:
                    r = remove_device(self.db, name)
                except LookupError as e:
                    raise HttpError(404, str(e))
                except ValueError as e:
                    raise HttpError(409, str(e))
            log_event("owner: removed device %s (%d sessions)" % (r["device"], r["sessions"]))
            return self.send(200, r)
        if path == "/api/codes":
            self.auth("owner")
            name = str(self.body().get("device_name") or "").strip().lower()
            if not cloud_auth.valid_name(name):
                raise HttpError(400, "device_name must be 1-31 characters: a-z, 0-9 and -, starting with a letter or digit")
            with self.lock:
                try:
                    c = cloud_auth.make_code(self.db, name, reserved_names(self.db))
                except ValueError as e:
                    raise HttpError(409, str(e))
            log_event("owner: made a one-time code for %s" % name)
            return self.send(200, c)
        if path == "/api/ingest":
            return self.ingest()
        if path in ("/api/peer/key", "/api/peer/link"):
            return self.peer_post(path)
        if path == "/api/heartbeat":
            return self.heartbeat()
        if path == "/api/enrich":
            self.auth("owner")
            body = self.body()
            # no self.lock here: the AI retriever's brain tools call back into this server
            with self.lock:
                token_mode = auth_required(self.db)
            return self.send(200, {"context": enrich(self.db, str(body.get("prompt") or ""), str(body.get("cwd") or ""),
                                                     str(body.get("session_id") or ""), lock=self.lock,
                                                     search_only=token_mode)})
        if path == "/api/sync":
            self.auth("owner")
            with self.lock:
                return self.send(200, sync(self.db, log=lambda *_: None))
        if path == "/api/handoff":
            self.auth("write")
            try:
                hid = start_handoff(self.db, self.lock, self.body())
            except ValueError as e:
                raise HttpError(400, str(e))
            return self.send(200, {"id": hid})
        if path == "/api/forget":
            self.auth("write")
            body = self.body()
            if not body.get("project"):
                raise HttpError(400, "project required")
            with self.lock:
                return self.send(200, {"deleted": forget(self.db, body["project"])})
        if path == "/api/memories":
            self.auth("write")
            body = self.body()
            try:
                with self.lock:
                    rid = remember(self.db, body.get("text", ""), body.get("project", ""), body.get("folder", ""),
                                   body.get("kind", "note"), body.get("device", ""), body.get("agent", ""),
                                   body.get("session", ""))
            except ValueError as e:
                raise HttpError(400, str(e))
            return self.send(200, {"id": rid})
        raise HttpError(404, "not found")

    def join(self):
        """POST /api/join {name, os, host, code?}: a new device asks to join (public, rate-limited)."""
        ip = self.client_ip()
        if not self.limiter.hit(("join", ip), *JOIN_LIMIT) or not self.limiter.hit(("join", "*"), *JOIN_GLOBAL):
            log_event("join rate limit for %s" % ip)
            raise HttpError(429, "too many join requests; wait 10 minutes")
        b = self.body()
        os_, host = cloud_auth.clean_text(b.get("os"), 40), cloud_auth.clean_text(b.get("host"), 80)
        if b.get("code"):
            if self.limiter.over(("badcode", ip), *BAD_CODE_LIMIT):
                raise HttpError(429, "too many wrong codes; wait 10 minutes")
            if not cloud_auth.code_well_formed(b["code"]):
                self.limiter.hit(("badcode", ip), *BAD_CODE_LIMIT)
                raise HttpError(400, "the code has a typo; check it (it looks like ABCD-EFGH-JK) and try again")
            with self.lock:
                r = cloud_auth.join_with_code(self.db, b["code"], os_, host, reserved_names(self.db),
                                              machine=b.get("machine"))
            if not r:
                self.limiter.hit(("badcode", ip), *BAD_CODE_LIMIT)
                raise HttpError(403, "the code is wrong, used or expired; ask the owner for a new one")
            log_event("device %s joined with a one-time code from %s" % (r["device"], ip))
            return self.send(200, r)
        name = b.get("name")
        name = name.strip().lower() if isinstance(name, str) else ""
        if not cloud_auth.valid_name(name):
            raise HttpError(400, "name must be 1-31 characters: a-z, 0-9 and -, starting with a letter or digit")
        with self.lock:
            try:
                r = cloud_auth.request_join(self.db, name, os_, host, reserved_names(self.db), machine=b.get("machine"))
            except OverflowError as e:
                raise HttpError(429, str(e))
        log_event("device %s (%s) asks to join from %s" % (r["device"], r["pending_id"], ip))
        return self.send(200, r)

    def peer_get(self, path, q):
        """GET /api/peer/keys (device or owner) and /api/peer/links?key= (owner): brain/peers.py."""
        if path == "/api/peer/keys":
            self.auth("read")
            with self.lock:
                return self.send(200, {"keys": peers.keys(self.db)})
        self.peer_owner()
        with self.lock:
            try:
                return self.send(200, {"links": peers.links(self.db, q.get("key", ""))})
            except ValueError as e:
                raise HttpError(400, str(e))

    def peer_owner(self):
        """The owner token itself: local trust (a loopback brain with no owner token, any local
        process) cannot add a key or read the sealed links."""
        role, _ = self.auth("owner")
        if role != "owner":
            raise HttpError(401, "this needs the owner token")

    def peer_post(self, path):
        """POST /api/peer/key {key} (owner) and /api/peer/link {sealed} (device token only)."""
        if path == "/api/peer/key":
            self.peer_owner()
            b = self.body()
            with self.lock:
                try:
                    kid = peers.add_key(self.db, b.get("key"), time.time())
                except ValueError as e:
                    raise HttpError(400, str(e))
            return self.send(200, {"id": kid})
        role, dev = self.auth("device")
        if dev is None:
            raise HttpError(403, "this needs a device token")
        b = self.body()
        with self.lock:
            try:
                n = peers.set_links(self.db, dev["id"], b.get("sealed"), time.time())
            except ValueError as e:
                raise HttpError(400, str(e))
        return self.send(200, {"device": dev["name"], "stored": n})
    def heartbeat(self):
        """POST /api/heartbeat {role, on_ac, cpu_load, ...} every 30 s (brain/heartbeat.py). With a device
        token the token decides the device name; with the owner token the body names it (a computer
        that is not a cloud device, for example the brain's own computer)."""
        role, dev = self.auth("device")
        b = self.body(heartbeat.MAX_BODY)
        if dev is not None:
            name = dev["name"]
        else:
            raw = str(b.get("device") or "").strip()
            with self.lock:
                known = reserved_names(self.db)
            # a device the brain already has keeps its exact name (devices.json names it after the host
            # name, which may break the rule for new names); a new name must follow the rule
            name = raw if raw in known and 0 < len(raw) <= 100 else raw.lower()
            if name not in known and not cloud_auth.valid_name(name):
                raise HttpError(400, "bad device name")
        hb = heartbeat.clean(b)
        with self.lock:
            heartbeat.store(self.db, name, hb, time.time())
        return self.send(200, {"device": name, "every": 30, "offline_after": heartbeat.OFFLINE_AFTER})

    def ingest(self):
        """POST /api/ingest {doc}. With a device token the token decides the device name (a name in the
        body is ignored). With the owner token (the panel's device listener) the body names the device."""
        role, dev = self.auth("device")
        b = self.body(MAX_INGEST)
        doc = b.get("doc") or {}
        if not isinstance(doc, dict) or not isinstance(doc.get("sessions", []), list):
            raise HttpError(400, "doc must be a collector document (an object with a sessions list)")
        if dev is not None:
            name = dev["name"]
        else:
            name = str(b.get("device") or "")
            if not cloud_auth.valid_name(name):
                raise HttpError(400, "bad device name")
        now = int(time.time())
        with self.lock:
            if dev is not None and not cloud_auth.check_machine(self.db, dev, doc.get("machine")):
                msg = ("this device's token is used on another computer (a copied config, for example after "
                       "Migration Assistant); that computer must join with its own name")
                cloud_auth.touch(self.db, dev["id"], last_error="another computer pushed with this device's token")
                log_event("device %s: push from another computer refused" % name)
                raise HttpError(409, msg)
            try:
                n = ingest(self.db, doc, name)
            except (KeyError, TypeError, AttributeError, sqlite3.Error):
                if dev is not None:
                    cloud_auth.touch(self.db, dev["id"], last_seen=now, last_error="the brain could not read the data")
                raise HttpError(400, "doc is not in the collector format")
            count = self.db.execute("SELECT COUNT(*) FROM sessions WHERE device=?", (name,)).fetchone()[0]
            if dev is not None:
                errs = doc.get("errors") or []
                err = cloud_auth.clean_text(errs[0] if isinstance(errs, list) and errs else "", 300)
                twins = cloud_auth.same_machine_as(self.db, self.db.execute(
                    "SELECT * FROM cloud_devices WHERE id=?", (dev["id"],)).fetchone())
                if twins and not err:
                    err = "this computer is also joined as %s; remove one of them" % ", ".join(twins)
                cloud_auth.touch(self.db, dev["id"], last_seen=now, sessions=count, last_error=err,
                                 os=cloud_auth.clean_text(doc.get("os"), 40) or dev["os"])
            else:
                set_device(self.db, name, os=doc.get("os"), home=doc.get("home"), transport="push",
                           last_sync=now, ok=1, error="")
        return self.send(200, {"updated": n, "dialogue": True, "sessions": count, "device": name})


def serve():
    db = connect()
    ensure_token()
    session_files()
    Handler.db = db
    forced = os.environ.get("CC_BRAIN_LOCAL_TRUST")
    if not is_loopback(BIND_HOST) and forced == "1":
        sys.exit("refusing to start: CC_BRAIN_LOCAL_TRUST=1 is only allowed on 127.0.0.1")
    if not is_loopback(BIND_HOST) and not cloud_auth.read_owner_token(CONF_DIR):
        sys.exit("refusing to start on %s without an owner token: run  brain.py owner-token" % BIND_HOST)
    required = auth_required(db)
    if forced == "1" and cloud_auth.owner_token_exists(CONF_DIR):
        log_event("warning: CC_BRAIN_LOCAL_TRUST=1 although an owner token exists; requests from this machine need no token")
    if cloud_auth.owner_token_exists(CONF_DIR) and not cloud_auth.read_owner_token(CONF_DIR):
        log_event("warning: the owner-token file is shorter than %d characters; the owner token does not work"
                  % cloud_auth.MIN_TOKEN_LEN)
    if cloud_auth.file_too_open(cloud_auth.owner_token_path(CONF_DIR)):
        log_event("warning: other users can read the owner-token file; run  chmod 600 %s"
                  % cloud_auth.owner_token_path(CONF_DIR))

    def loop():
        while True:
            with Handler.lock:
                try:
                    sync(db, log=lambda *_: None)
                except Exception as e:
                    print("sync failed:", e, file=sys.stderr)
            time.sleep(SYNC_EVERY)

    threading.Thread(target=loop, daemon=True).start()
    httpd = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    httpd.daemon_threads = True
    print("cc-brain on http://%s:%d (%s)" % (BIND_HOST, PORT, "tokens required" if required else "local trust"),
          flush=True)
    httpd.serve_forever()


def main(argv):
    cmd = argv[0] if argv else "help"
    if cmd == "sync":
        sync(connect(), full="--all" in argv)
    elif cmd == "search":
        for r in search(connect(), " ".join(argv[1:]), limit=20):
            print("%-12s %-6s %-40s %s" % (r["device"], r["agent"], (r["title"] or r["first_prompt"])[:40], r["cwd"]))
    elif cmd == "serve":
        serve()
    elif cmd == "session-files":
        print("\n".join(session_files()))
    elif cmd == "enrich":
        print(enrich(connect(), " ".join(argv[1:]), session_id="cli"))
    elif cmd == "owner-token":
        # prints the token on stdout only (for the installer's connect link); never into a log
        existed = bool(cloud_auth.read_owner_token(CONF_DIR))
        token = cloud_auth.write_owner_token(CONF_DIR, rotate="--rotate" in argv)
        cloud_auth.set_meta(connect(), "auth_required", "1")
        print(token)
        print("owner token %s: %s" % ("rotated" if "--rotate" in argv else ("kept" if existed else "created"),
                                       cloud_auth.owner_token_path(CONF_DIR)), file=sys.stderr)
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
