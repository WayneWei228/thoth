#!/usr/bin/env python3
"""Brain MCP server: lets any Claude Code or Codex session ask the central brain
about work and memory from all of the user's devices, and add shared memory.

Transport: MCP over stdio (newline-delimited JSON-RPC 2.0). Python stdlib only.
Talks to the brain HTTP API: CC_BRAIN_URL if set; else the cloud brain in the panel's brain.json
(<CC_PANEL_HOME or ~/.config/cc-panel>/brain.json: {url, owner_token}; the owner token goes with
every call); else the local brain on http://127.0.0.1:7879.
Local writes (brain_remember) use the token in ~/.config/cc-brain/token (or CC_BRAIN_TOKEN).

Register for Claude Code (user's choice, a settings change):
  claude mcp add brain -- python3 -I /path/to/brain/mcp_server.py
"""
import datetime
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import collector  # noqa: E402  (project_key: same project identity as the collector)



def brain_location(env=os.environ):
    """(url, owner_token or None): CC_BRAIN_URL, else the panel's brain.json (cloud brain), else local."""
    if env.get("CC_BRAIN_URL"):
        return env["CC_BRAIN_URL"].rstrip("/"), None
    home = env.get("CC_PANEL_HOME") or os.path.join(os.path.expanduser("~"), ".config", "cc-panel")
    try:
        with open(os.path.join(home, "brain.json")) as f:
            j = json.load(f)
        if str(j.get("url", "")).startswith(("https://", "http://")) and j.get("owner_token"):
            return j["url"].rstrip("/"), j["owner_token"]
    except (OSError, ValueError, AttributeError):
        pass
    return "http://127.0.0.1:7879", None


BRAIN, CLOUD_TOKEN = brain_location()
TOKEN_FILE = os.path.expanduser(os.environ.get("CC_BRAIN_DIR", "~/.config/cc-brain")) + "/token"
PROTOCOL = "2025-06-18"

ABOUT = ("The central brain indexes every Claude Code and Codex session and memory file on ALL of the user's "
         "devices (for example a Mac and Windows PCs). ")

TOOLS = [
    {"name": "brain_search",
     "description": ABOUT + "Search past sessions and memories on every device by keywords. Use it when the user "
                    "asks about past work, another device, or something you have no local record of. Use several short "
                    "keywords (names, folders, tools), in the language the work was likely done in; try again with other words if empty.",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "keywords, e.g. 'deskflow' or 'group37 push'"},
         "device": {"type": "string", "description": "only this device (see brain_list_devices)"},
         "limit": {"type": "integer", "default": 8}},
         "required": ["query"]}},
    {"name": "brain_project_context",
     "description": ABOUT + "Everything known about one project from every device: its memories, user-level "
                    "preferences, and recent sessions. With no arguments it uses the current folder.",
     "inputSchema": {"type": "object", "properties": {
         "folder": {"type": "string", "description": "project folder (default: current folder)"},
         "project": {"type": "string", "description": "project key from brain_search results, e.g. 'git:github.com/a/b' or 'folder:name'"}}}},
    {"name": "brain_list_devices",
     "description": ABOUT + "List the user's devices the brain knows (name, OS, sessions, last sync). Use it to "
                    "check whether a device exists before answering about it.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "brain_grep",
     "description": ABOUT + "Search the full text of every session on every device: everything the user asked, "
                    "everything the agent answered, and the commands and files it used. It works like grep on files. "
                    "Use it when brain_search finds nothing or you need something said in the middle of a long "
                    "session. Work the way you search a codebase: grep one exact word or short phrase (a name, a "
                    "file, an error, a number), look at the hits, then read around a hit with "
                    "brain_get_session(sid, around=position). Try other words, or the other language, when empty.",
     "inputSchema": {"type": "object", "properties": {
         "pattern": {"type": "string", "description": "one exact word or phrase (case ignored); a regular expression with regex=true"},
         "regex": {"type": "boolean", "default": False},
         "device": {"type": "string", "description": "only this device"},
         "project": {"type": "string", "description": "only this project key"},
         "sid": {"type": "string", "description": "only this session (id or its first 8 characters)"},
         "role": {"type": "string", "enum": ["user", "assistant", "tool"], "description": "only what the user said, the agent said, or the tools used"},
         "context": {"type": "integer", "default": 0, "description": "messages shown before and after each hit (0-5)"},
         "mode": {"type": "string", "enum": ["hits", "sessions"], "default": "hits",
                  "description": "hits: the matching messages; sessions: which sessions match, with counts"},
         "limit": {"type": "integer", "default": 15}},
         "required": ["pattern"]}},
    {"name": "brain_get_session",
     "description": ABOUT + "Read one session found by brain_search or brain_grep: its details and part of its "
                    "dialogue, like reading part of a file. Without a position it shows the last messages. "
                    "around = a position from brain_grep shows the messages around that hit; start + count read a range.",
     "inputSchema": {"type": "object", "properties": {
         "device": {"type": "string"}, "sid": {"type": "string", "description": "session id (or its first 8 characters)"},
         "around": {"type": "integer", "description": "a message position from brain_grep"},
         "start": {"type": "integer", "description": "first message position to read"},
         "count": {"type": "integer", "default": 20, "description": "number of messages (up to 100)"},
         "max_chars": {"type": "integer", "default": 1500, "description": "characters shown of each message"}},
         "required": ["sid"]}},
    {"name": "brain_remember",
     "description": ABOUT + "Save a fact, decision or note so sessions on every device can recall it later. Use when "
                    "the user asks you to remember something, or records a decision others will need. Keep it short and "
                    "self-contained (include names, paths, values).",
     "inputSchema": {"type": "object", "properties": {
         "text": {"type": "string"},
         "project": {"type": "string", "description": "project name or key it belongs to (default: current folder's project)"},
         "kind": {"type": "string", "enum": ["fact", "decision", "preference", "note"], "default": "note"}},
         "required": ["text"]}},
]


# ------------------------------------------------------------------ brain HTTP
def get(path, **params):
    q = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    req = urllib.request.Request(f"{BRAIN}{path}{'?' + q if q else ''}",
                                 headers={"Authorization": f"Bearer {CLOUD_TOKEN}"} if CLOUD_TOKEN else {})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def post(path, body):
    token = CLOUD_TOKEN or os.environ.get("CC_BRAIN_TOKEN")
    if not token and os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            token = f.read().strip()
    req = urllib.request.Request(f"{BRAIN}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token or ''}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


# ------------------------------------------------------------------ formatting
def day(ts):
    try:
        return datetime.datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return "?"


def short_title(s, n=80):
    t = s.get("title") or s.get("first_prompt") or s.get("sid") or ""
    return t if len(t) <= n else t[:n] + "…"


def fmt_copies(s):
    """Where else this session is (the brain lists each session once; brain.merge_copies)."""
    words = {"same": "same dialogue", "older": "an older part of it", "main": "the newest copy",
             "fork": "went on separately", "unknown": "cannot compare"}
    out = []
    if s.get("also_on"):
        out.append("  also on: " + ", ".join(
            f"{c['device']} ({words.get(c['relation'], c['relation'])}"
            + (f" after {c['common']} messages" if c["relation"] == "fork" else "") + ")" for c in s["also_on"]))
    if s.get("fork_of"):
        f = s["fork_of"]
        out.append(f"  a separate copy of the session on {f['device']}"
                   + (f": the same first {f['common']} messages, then different" if f.get("relation") == "fork" else ""))
    return out


def fmt_session(s, full=False):
    lines = [f"- [{s['device']} · {s['agent']} · {day(s.get('mtime'))}] {short_title(s, 200 if full else 80)}",
             f"  folder: {s.get('cwd')}  project: {s.get('project')}  id: {s['sid'][:8]}"] + fmt_copies(s)
    if s.get("last_prompt"):
        lines.append(f"  last request: {s['last_prompt']}")
    if full and s.get("first_prompt"):
        lines.append(f"  first request: {s['first_prompt']}")
    if s.get("last_reply"):
        lines.append(f"  last reply: {s['last_reply']}")
    return "\n".join(lines)


def fmt_memory(m, body_chars=1200):
    where = f"{m.get('device')} · {m.get('source')} {m.get('origin') == 'agent' and 'remembered' or m.get('kind') or ''}".strip()
    head = f"- [{where} · {day(m.get('mtime'))}] {m.get('name')}"
    if m.get("project"):
        head += f"  (project: {m['project']})"
    if m.get("also_on"):
        head += f"  (also on {', '.join(m['also_on'])})"
    body = (m.get("body") or "").strip()
    if len(body) > body_chars:
        body = body[:body_chars] + " …"
    return head + ("\n  " + body.replace("\n", "\n  ") if body else "")


def resolve_project(project="", folder=""):
    if project and (project.startswith("git:") or project.startswith("folder:")):
        return project
    if project:  # a plain name, e.g. "cc-panel eval"
        return "folder:" + project.strip().lower()
    return collector.project_key(folder or os.getcwd())


# ------------------------------------------------------------------ tools
def tool_brain_search(a):
    q, dev, limit = a.get("query", ""), a.get("device", ""), int(a.get("limit") or 8)
    sessions = get("/api/sessions", q=q, device=dev, limit=limit, mode="any")
    mems = get("/api/memories", q=q, limit=limit)
    out = [f"Sessions matching '{q}' ({len(sessions)}):"] + [fmt_session(s) for s in sessions]
    out += ["", f"Memories matching '{q}' ({len(mems)}):"] + [fmt_memory(m, 1500) for m in mems]
    if not sessions and not mems:
        out.append("Nothing found in titles and first/last requests. Try brain_grep (it searches the full text "
                   "of every session), other or fewer keywords, or brain_list_devices.")
        return "\n".join(out)
    # Whole-project overview: a match is often one of several sessions on the same topic.
    projects = []  # only from the best matches, so the overview stays short
    for p in [s.get("project") for s in sessions[:3]] + [m.get("project") for m in mems[:2]]:
        if p and p not in projects:
            projects.append(p)
    if projects:
        out += ["", "All sessions and memories in the matching projects (so you see the whole picture):"]
    for p in projects[:2]:
        ps = get("/api/sessions", project=p, limit=12)
        pm = get("/api/memories", project=p, limit=12)
        out.append(f"* {p}: {len(ps)} sessions on {', '.join(sorted({x['device'] for x in ps})) or '-'}")
        out += [f"    - session [{x['device']} · {day(x.get('mtime'))}] {short_title(x)}" for x in ps]
        out += [f"    - memory {x.get('name')}: {x.get('description') or ''}" for x in pm]
    out += ["", "Answer with every relevant item above, not only the newest. For full memory text, call "
                "brain_project_context(project=...). For something said inside a session, call brain_grep."]
    return "\n".join(out)


def tool_brain_project_context(a):
    key = resolve_project(a.get("project", ""), a.get("folder", ""))
    c = get("/api/context", project=key)
    out = [f"Project: {key}  (devices with sessions: {', '.join(c['devices']) or 'none'})", "", "Project memories:"]
    out += [fmt_memory(m) for m in c["project_memories"]] or ["- none"]
    out += ["", "Recent sessions:"] + ([fmt_session(s) for s in c["recent_sessions"]] or ["- none"])
    out += ["", "User-level memories (apply everywhere):"] + [fmt_memory(m, 400) for m in c["user_memories"][:8]]
    return "\n".join(out)


def tool_brain_list_devices(a):
    ds = get("/api/devices")
    if not ds:
        return "The brain knows no devices yet."
    return "Devices known to the brain:\n" + "\n".join(
        f"- {d['name']} ({d.get('os') or '?'}, {d.get('transport')}): {d.get('sessions', 0)} sessions, "
        f"last sync {day(d.get('last_sync'))}, {'online' if d.get('ok') else 'offline: ' + (d.get('error') or '')}"
        for d in ds) + "\nNo other devices are known."


def tool_brain_grep(a):
    pat, mode = a.get("pattern", ""), a.get("mode") or "hits"
    r = get("/api/grep", q=pat, device=a.get("device", ""), project=a.get("project", ""), sid=a.get("sid", ""),
            role=a.get("role", ""), regex="1" if a.get("regex") else "", context=a.get("context") or "",
            mode=mode, limit=int(a.get("limit") or 15))
    if mode == "sessions":
        ss = r.get("sessions", [])
        if not ss:
            return f"No session has '{pat}'. Try another word, the other language, or fewer filters."
        return "\n".join([f"Sessions with '{pat}' ({len(ss)}):"] + [
            f"- [{s['device']} · {s['agent']} · {day(s.get('mtime'))}] {short_title(s)}  id: {s['sid'][:8]}  "
            f"{s['hits']} matching messages (positions {s['first_idx']}-{s['last_idx']})" for s in ss])
    hits = r.get("hits", [])
    if not hits:
        return f"Nothing matches '{pat}'. Try another word, the other language, or fewer filters."
    out = [f"{r.get('total', len(hits))} messages match '{pat}' (showing {len(hits)}, newest sessions first):"]
    last = None
    for h in hits:
        key = (h["device"], h["sid"])
        if key != last:
            out.append(f"* [{h['device']} · {h['agent']} · {day(h.get('mtime'))}] {short_title(h)}  id: {h['sid'][:8]}  folder: {h.get('cwd')}")
            last = key
        before = [c for c in h.get("context", []) if c["idx"] < h["idx"]]
        after = [c for c in h.get("context", []) if c["idx"] > h["idx"]]
        out += [f"      {c['idx']} {c['role']}: {c['text']}" for c in before]
        out.append(f"    > {h['idx']} {h['role']}: {h['snippet']}")
        out += [f"      {c['idx']} {c['role']}: {c['text']}" for c in after]
    out += ["", "To read around a hit: brain_get_session(sid=<id>, around=<position>)."]
    return "\n".join(out)


def tool_brain_get_session(a):
    dev, sid = a.get("device", ""), a.get("sid", "")
    try:
        r = get("/api/session", sid=sid, device=dev, around=a.get("around"), start=a.get("start"),
                count=int(a.get("count") or 20), max_chars=a.get("max_chars") or "")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        e.close()
        return f"No session {sid}" + (f" on {dev}." if dev else ".")
    s = r["session"]
    out = [fmt_session(s, full=True) + f"\n  started: {s.get('started')}  updated: {s.get('updated')}"]
    if len(r.get("copies") or []) > 1:
        out.append("  copies: " + "; ".join(f"{c['device']}: {c['messages']} messages ({c['relation']})" for c in r["copies"])
                   + ". This is the copy with the most messages; give the device to read another.")
    if r.get("more_than_one"):
        out.append("  (more than one session starts with this id; this is the newest. Give more characters or the device.)")
    msgs = r.get("messages", [])
    if not r.get("total"):
        out.append("  The brain has no dialogue of this session yet (its device has not sent it with the new collector).")
    elif msgs:
        out.append(f"  dialogue: messages {msgs[0]['idx']}-{msgs[-1]['idx']} of {r['total']} (positions 0-{r['total'] - 1})")
        out += [f"  {m['idx']} {m['role']}{' ' + m['ts'][:16] if m.get('ts') else ''}: {m['text']}" for m in msgs]
    return "\n".join(out)


def tool_brain_remember(a):
    key = resolve_project(a.get("project", ""), "")
    r = post("/api/memories", {"text": a.get("text", ""), "project": key, "folder": os.getcwd() if not a.get("project") else "",
                               "kind": a.get("kind") or "note", "device": socket.gethostname().split(".")[0].lower(),
                               "agent": os.environ.get("CC_BRAIN_AGENT", "agent")})
    return f"Saved to the brain (id {r['id']}, project {key}). Every device can now recall it."


def http_problem(e):
    """Plain text for an HTTP error answer of the brain (never the token, never a traceback)."""
    if e.code in (401, 403):
        if CLOUD_TOKEN:
            return (f"The cloud brain at {BRAIN} refused the key (HTTP {e.code}). The owner key may have been changed. "
                    "Open the panel's setup page and connect to the cloud brain again with a new connect link.")
        return (f"The brain at {BRAIN} refused the request (HTTP {e.code}): it needs a token. For a cloud brain, "
                "connect the panel to it first (setup page, \"Connect to my cloud brain\").")
    try:
        msg = str(json.loads(e.read()).get("error") or "")[:200]
    except Exception:
        msg = ""
    return f"The brain at {BRAIN} answered with an error (HTTP {e.code}{': ' + msg if msg else ''})."


HANDLERS = {t["name"]: globals()["tool_" + t["name"]] for t in TOOLS}


# ------------------------------------------------------------------ JSON-RPC
def handle(msg):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None  # notification (e.g. notifications/initialized)
    if method == "initialize":
        ver = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": ver, "capabilities": {"tools": {}},
            "serverInfo": {"name": "brain", "version": "0.2.0"},
            "instructions": ABOUT + "Ask it before saying you have no record of past work or another device. "
                            "brain_search finds sessions by topic; brain_grep searches their full text; brain_get_session reads one."}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        p = msg.get("params") or {}
        fn = HANDLERS.get(p.get("name"))
        if not fn:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"unknown tool {p.get('name')}"}}
        try:
            text, err = fn(p.get("arguments") or {}), False
        except urllib.error.HTTPError as e:  # the brain answered with an error: say what it means, in plain words
            text, err = http_problem(e), True
            e.close()
        except (urllib.error.URLError, OSError) as e:
            where = "It is your cloud brain server: check that it is switched on." if CLOUD_TOKEN else "It runs on the always-on Mac."
            reason = getattr(e, "reason", e)
            reason = getattr(reason, "strerror", None) or str(reason)
            text, err = f"The central brain is not reachable at {BRAIN} ({reason}). {where}", True
        except Exception as e:  # report, do not crash the server
            text, err = f"brain error: {e}", True
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "isError": err}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        reply = handle(msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
