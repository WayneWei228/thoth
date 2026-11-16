#!/usr/bin/env python3
"""Cross-device handoff (phase 3).

  python3 brain/handoff.py --from my-pc --sid <session id or prefix> --to my-mac \
      [--run none|headless|panel] [--notes "extra context"] [--json]

1. Find the source session in the brain; read its git state and transcript on the source device.
2. Write the handoff packet (goal, done, remaining, finish condition, ...) with a model.
3. Snapshot the code on the source WITHOUT touching it (temporary index, private ref, git bundle).
4. Open it on the target in a NEW repo under ~/.cc-brain/handoffs/<id>/<name>, branch handoff/<id>,
   with HANDOFF.md. Never an existing checkout. Nothing is pushed to a remote.
5. Start the target agent with the packet:
   panel    -> a Thoth session on the target Mac, with the same agent as the source session
               (Claude or Codex); the packet is queued until the agent is ready
   headless -> `claude -p` on the target, allowed to edit files and run python/git status only
   none     -> only prepare (default)
"""
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import brain  # noqa: E402
import devices as D  # noqa: E402

PACKET_MODEL = os.environ.get("CC_HANDOFF_MODEL", "sonnet")
AGENT_MODEL = os.environ.get("CC_HANDOFF_AGENT_MODEL", "sonnet")
PANEL = os.environ.get("CC_PANEL_URL", "http://127.0.0.1:7878")
if "--panel-url" in sys.argv:
    PANEL = sys.argv[sys.argv.index("--panel-url") + 1]

PACKET_SCHEMA = {
    "type": "object",
    "properties": {
        "goal": {"type": "string", "description": "the overall task, one or two sentences"},
        "done": {"type": "array", "items": {"type": "string"}, "description": "what is finished, concrete"},
        "remaining": {"type": "array", "items": {"type": "string"}, "description": "what is left, concrete next steps"},
        "finish_condition": {"type": "string", "description": "a check that can pass or fail, e.g. a command and its expected result"},
        "decisions": {"type": "array", "items": {"type": "string"}, "description": "choices made and why, that the next agent must keep"},
        "files_outside_git": {"type": "array", "items": {"type": "string"}, "description": "files the work needs that git does not carry (ignored or outside the repo)"},
        "needs_on_target": {"type": "array", "items": {"type": "string"}, "description": "tools, versions, accounts the next device needs"},
        "open_questions": {"type": "array", "items": {"type": "string"}, "description": "questions for the user"},
    },
    "required": ["goal", "done", "remaining", "finish_condition", "decisions", "files_outside_git", "needs_on_target", "open_questions"],
}

ALLOWED_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(python:*)", "Bash(python3:*)", "Bash(py:*)",
                 "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
                 # Windows: Claude Code runs commands through PowerShell
                 "PowerShell(py:*)", "PowerShell(python:*)", "PowerShell(git status:*)", "PowerShell(git diff:*)"]


def arg(name, default=None):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else default


def session_mcp_config():
    """MCP config that gives a session the brain tools (only for sessions the panel or a handoff
    starts; the user's own Claude/Codex config is not changed)."""
    return json.dumps({"mcpServers": {"brain": {"command": "python3", "args": ["-I", os.path.join(HERE, "mcp_server.py")]}}})


def brain_knowledge(db, session, src, dst):
    """What the brain knows that the next agent needs: how to reach the source device, whether it
    is online, and the memories about that device and this project from every device."""
    access = []
    if src.get("transport") == "ssh":
        ssh = " ".join(["ssh"] + list(src["ssh"]))
        access.append(f"From the brain's computer ({dst['name'] if D.is_local(dst) else 'the always-on Mac'}): `{ssh}` "
                      f"(the brain uses exactly this to sync {src['name']}; it works without a password). "
                      f"Run Python there as `{src.get('python', 'python3')}`.")
    row = db.execute("SELECT * FROM devices WHERE name=?", (src["name"],)).fetchone()
    if row:
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(row["last_sync"] or 0))
        access.append(f"{src['name']} ({row['os']}): {'reachable' if row['ok'] else 'NOT reachable: ' + (row['error'] or '')} "
                      f"at the brain's last sync, {when}.")
    host = (src.get("ssh") or [""])[-1]
    if "@" in host:
        access.append(f"Current address used by the brain: {host.split('@', 1)[1]} (older notes or files may show other IPs).")
    seen, mems = set(), []
    queries = [(f"{src['name']} ssh powershell", ""), ("", session.get("project") or "")]
    for q, proj in queries:
        for m in (brain.search_memories(db, q, project=proj, limit=8) if (q or proj) else []):
            if m["id"] not in seen:
                seen.add(m["id"])
                mems.append(m)
    mems += [dict(m) for m in db.execute("SELECT * FROM memories WHERE device=? AND scope='project' ORDER BY mtime DESC LIMIT 4",
                                          (src["name"],)) if m["id"] not in seen]
    memory_lines = []
    for m in mems[:10]:
        body = (m.get("body") or "").strip().replace("\n", " ")
        memory_lines.append(f"[{m.get('device')} · {m.get('name')}] {body[:500]}")
    return access, memory_lines


def find_session(db, device, sid, known=None):
    """The session to hand over. When another device has a newer copy of it (this device's copy is an
    older part of it: brain.copies), that copy, if the brain can reach its device (`known` names)."""
    rows = [dict(r) for r in db.execute("SELECT * FROM sessions WHERE device=? AND sid LIKE ? ORDER BY mtime DESC",
                                        (device, sid + "%"))]
    if not rows:
        raise SystemExit(f"no session {sid} on {device} in the brain (run: brain.py sync)")
    cs = brain.copies(db, rows[0]["agent"], rows[0]["sid"])
    mine = next((c for c in cs if c["device"] == device), None)
    if mine and mine["relation"] == "older" and (known is None or cs[0]["device"] in known):
        print(f"{device} has an older copy of {rows[0]['sid'][:8]} ({mine['messages']} messages); using the newer "
              f"copy on {cs[0]['device']} ({cs[0]['messages']} messages)", file=sys.stderr)
        return {k: v for k, v in cs[0].items() if k not in ("messages", "relation", "common")}
    return rows[0]


def newest_on(db, session, device):
    """True when `device` has the newest copy of the session (or one with the same dialogue)."""
    return any(c["device"] == device and c["relation"] in ("main", "same")
               for c in brain.copies(db, session["agent"], session["sid"]))


def write_packet(session, git, digest, src_dev, notes="", knowledge=None):
    tasks = "\n\n".join(f"--- {n} ---\n{t}" for n, t in (git.get("task_files") or {}).items()) or "(none)"
    prompt = f"""You write a HANDOFF PACKET so another agent on another computer can continue this work exactly
where it stopped. Use only facts from the material below. Be concrete: file names, function names, commands.

Rules:
- goal = the OVERALL task (from the task files and the user's requests), not the part the first session did.
- The handoff happens because the user wants the rest done on the other device. Limits that only applied to the
  first session ("only do X today", "leave Y for later / for another computer", "stop after Z") explain why it
  stopped. They are NOT decisions to keep: the remaining work is now in scope. Do not repeat them as decisions.
- decisions = technical or product choices the next agent must keep (approach, libraries, names, formats).
- finish_condition = a check that can pass or fail (a command and its expected result), taken from the task when
  it states one.

Task files in the repository:
{tasks}

Source device: {src_dev['name']}
Session title: {session.get('title') or ''}
Folder: {session.get('cwd')}

Git state of the folder (status lists uncommitted work, which travels with the handoff;
"(no git)" means the folder is not a git repository and is copied as it is, minus caches and huge files):
files: {', '.join(git.get('files') or [])[:1500]}
branch: {git.get('branch')}
recent commits:
{git.get('log')}
status:
{git.get('status') or '(clean)'}

{('Notes from the user: ' + notes) if notes else ''}

What the central brain knows (devices, access and memory from ALL the user's devices; use it, for example
put the real way to reach the source device into needs_on_target or decisions, and prefer it over stale files):
{chr(10).join((knowledge or ([], []))[0] + (knowledge or ([], []))[1]) or '(nothing)'}

Transcript of the session (user requests, agent replies, tools used):
<<<
{digest}
>>>"""
    cmd = ["claude", "-p", prompt, "--model", PACKET_MODEL, "--output-format", "json", "--no-session-persistence",
           "--json-schema", json.dumps(PACKET_SCHEMA), "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
           "--disallowedTools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,Agent"]
    os.makedirs(os.path.expanduser("~/.cc-brain"), exist_ok=True)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=600, cwd=os.path.expanduser("~/.cc-brain"))
    j = json.loads(p.stdout)
    packet = j.get("structured_output")
    if not packet:
        raise RuntimeError("packet writer returned no packet: " + str(j.get("result"))[:300])
    return packet


def packet_markdown(packet, hid, src_dev, src_cwd, branch, knowledge=None, brain_tools=False):
    def bullets(xs):
        return "\n".join(f"- {x}" for x in xs) if xs else "- (none)"
    return f"""# Handoff {hid}

Continued from **{src_dev}**, folder `{src_cwd}`. This folder is a copy of that work on branch `{branch}`;
the original on {src_dev} was not changed.

## Goal
{packet['goal']}

## Done
{bullets(packet['done'])}

## Remaining
{bullets(packet['remaining'])}

## Finish condition
{packet['finish_condition']}

## Decisions to keep
{bullets(packet['decisions'])}

## Files outside git
{bullets(packet['files_outside_git'])}

## Needs on this device
{bullets(packet['needs_on_target'])}

## Open questions
{bullets(packet['open_questions'])}

## Devices and access (from the central brain)
{bullets((knowledge or ([], []))[0])}

## Relevant memory from the brain
{bullets((knowledge or ([], []))[1])}
""" + ("""
## Brain tools in this session
You can ask the central brain directly: `brain_search`, `brain_project_context`, `brain_list_devices`,
`brain_get_session`, `brain_remember`. Ask it before you conclude that a device, file or fact is unknown.
""" if brain_tools else "")


def first_message(packet, src_dev, dst):
    rem = "; ".join(packet["remaining"]) or "see HANDOFF.md"
    py = dst.get("python", "python3")
    py_note = (f" On this device run Python as `{py}` (for example `{py} -m unittest`); the plain `python` command "
               f"may not work here." if py != "python3" else "")
    return (f"You are continuing work another agent started on the device {src_dev}.{py_note} The code is in this folder "
            f"(a copy on a handoff branch). Read HANDOFF.md first. Goal: {packet['goal']} Remaining: {rem} "
            f"Finish condition: {packet['finish_condition']} Do the remaining work, then run the finish condition "
            f"and show its result. Keep the decisions listed in HANDOFF.md. HANDOFF.md also says how to reach {src_dev} "
            f"(section 'Devices and access') and what the central brain remembers; use that before asking the user.")


def put_file(dev, path, text):
    code = f"""
import os, sys
data = sys.stdin.buffer.read()
with open({path!r}, "wb") as f:
    f.write(data)
print("ok")
"""
    D.run_py(dev, code, stdin_bytes=text.encode("utf-8"))


def run_headless(dev, target, message):
    # the brain runs on the always-on device; a local target gets the brain tools
    extra = ["--mcp-config", session_mcp_config(), "--allowedTools", "mcp__brain__*"] if D.is_local(dev) else []
    code = f"""
import json, subprocess, sys
cmd = ["claude", "-p", {message!r}, "--model", {AGENT_MODEL!r}, "--output-format", "json",
       "--allowedTools", *{ALLOWED_TOOLS!r}] + {extra!r}
p = subprocess.run(cmd, cwd={target!r}, capture_output=True, text=True, shell=False)
try:
    j = json.loads(p.stdout)
    print(json.dumps({{"ok": not j.get("is_error"), "result": (j.get("result") or "")[-1500:],
                      "session_id": j.get("session_id"), "cost": j.get("total_cost_usd")}}))
except Exception:
    print(json.dumps({{"ok": False, "result": (p.stderr or p.stdout)[-800:]}}))
"""
    return D.run_py_json(dev, code, timeout=1800)


def panel_post(action, body):
    req = urllib.request.Request(f"{PANEL}/api/{action}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Origin": PANEL})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def run_panel(target, name, message, agent="claude"):
    """Open the panel session with the source session's agent. A Codex session in the panel always
    gets the brain tools (server.js startCodex); a Claude session gets them with mcp=brain."""
    body = {"folder": target, "name": name[:30]}
    if agent == "codex":
        body["agent"] = "codex"
    else:
        body["mcp"] = "brain"
    s = panel_post("new", body)
    panel_post("queue", {"id": s["id"], "text": message})
    who = "Codex" if agent == "codex" else "Claude"
    return {"ok": True, "panel_session": s["id"], "agent": agent,
            "result": f"Thoth {who} session started; the packet is sent when {who} is ready"}


def main():
    src_name, sid, dst_name = arg("--from"), arg("--sid"), arg("--to")
    mode = arg("--run", "none")
    if not (src_name and sid and dst_name) or mode not in ("none", "headless", "panel"):
        raise SystemExit(__doc__)
    dst = D.device(dst_name)
    if mode == "panel" and not D.is_local(dst):
        raise SystemExit("--run panel needs the target to be this Mac (the panel runs here)")
    db = brain.connect()
    session = find_session(db, src_name, sid, known={d["name"] for d in brain.load_devices()})
    if newest_on(db, session, dst_name):
        raise SystemExit(f"{dst_name} already has the newest copy of session {session['sid'][:8]}: resume it there, "
                         "no handoff is needed")
    src_name = session["device"]
    src = D.device(src_name)
    hid = arg("--id") or ("h" + time.strftime("%m%d%H%M") + secrets.token_hex(2))
    log = (lambda *a: print(*a, file=sys.stderr))

    log(f"[{hid}] reading git state and transcript on {src_name}")
    git = json.loads(D.run_collector(src, ["--git-info", session["cwd"]]))
    if not git.get("root"):
        raise SystemExit(f"{session['cwd']} on {src_name}: {git.get('error', 'folder not found')}")
    if not git.get("git"):
        log(f"[{hid}] {session['cwd']} has no git: copying the folder (temporary git dir outside it)")
    digest = json.loads(D.run_collector(src, ["--transcript", session["path"]]))["text"]

    knowledge = brain_knowledge(db, session, src, dst)
    log(f"[{hid}] writing the packet ({PACKET_MODEL}) with {len(knowledge[0])} access facts and {len(knowledge[1])} memories")
    packet = write_packet(session, git, digest, src, arg("--notes", ""), knowledge)

    log(f"[{hid}] snapshot on {src_name} (source not touched)")
    bundle = D.run_collector(src, ["--snapshot", git["root"], hid])
    name = os.path.basename(git["root"].replace("\\", "/").rstrip("/")) or "project"

    log(f"[{hid}] opening on {dst_name} ({len(bundle)} bytes)")
    applied = json.loads(D.run_collector(dst, ["--apply", hid, name], stdin_bytes=bundle))
    target = applied["target_path"]
    sep = "\\" if "\\" in target else "/"
    brain_tools = D.is_local(dst) and mode in ("panel", "headless", "none")
    put_file(dst, target + sep + "HANDOFF.md", packet_markdown(packet, hid, src_name, session["cwd"], applied["branch"],
                                                               knowledge, brain_tools))

    record = {"id": hid, "created": int(time.time()), "src_device": src_name, "src_sid": session["sid"],
              "src_cwd": session["cwd"], "dst_device": dst_name, "target_path": target, "branch": applied["branch"],
              "packet": packet, "run_mode": mode, "status": "prepared", "result": ""}
    brain.record_handoff(db, record)

    run = {"ok": True, "result": "prepared only"}
    message = first_message(packet, src_name, dst)
    if mode == "headless":
        log(f"[{hid}] running the agent on {dst_name} (headless, {AGENT_MODEL})")
        run = run_headless(dst, target, message)
    elif mode == "panel":
        run = run_panel(target, f"handoff-{name}", message, session.get("agent") or "claude")
    record.update(status="ran" if run.get("ok") else "run-failed", result=json.dumps(run, ensure_ascii=False))
    brain.record_handoff(db, record)

    out = {"id": hid, "source": {"device": src_name, "sid": session["sid"], "cwd": session["cwd"]},
           "target_path": target, "branch": applied["branch"], "packet": packet, "run": run}
    if "--json" in sys.argv:
        print(json.dumps(out, ensure_ascii=False))
    else:
        print(packet_markdown(packet, hid, src_name, session["cwd"], applied["branch"], knowledge, brain_tools))
        print(f"Target: {dst_name}:{target}  ({applied['branch']})\nRun: {run.get('result', '')[:500]}")


if __name__ == "__main__":
    main()
