#!/usr/bin/env python3
"""Central Brain collector: reads Claude Code and Codex session files on THIS device
and prints one JSON document with a summary of each changed session.

Runs on macOS, Linux and Windows with the Python standard library only (3.8+).
The brain runs it locally or over SSH and ingests stdout.

Read-only: it never writes to the agents' folders. Its own state file lives in
~/.cc-brain/collector-state.json (which sessions were already sent).

Usage:
  python3 collector.py            # changed sessions since the last run
  python3 collector.py --all      # every session
  python3 collector.py --file X   # parse one file (tests)
"""
import json
import os
import platform
import re
import socket
import subprocess
import sys

VERSION = 2
HOME = os.path.expanduser("~")
CLAUDE_DIR = os.path.join(HOME, ".claude", "projects")
CODEX_DIR = os.path.join(HOME, ".codex", "sessions")
CODEX_INDEX = os.path.join(HOME, ".codex", "session_index.jsonl")
CLAUDE_USER_MD = os.path.join(HOME, ".claude", "CLAUDE.md")
CODEX_AGENTS_MD = os.path.join(HOME, ".codex", "AGENTS.md")
CODEX_MEMORIES = os.path.join(HOME, ".codex", "memories")
MEMORY_MAX = 6000
STATE_DIR = os.path.join(HOME, ".cc-brain")
STATE_FILE = os.path.join(STATE_DIR, "collector-state.json")
HEAD_BYTES = 256 * 1024
TAIL_BYTES = 1024 * 1024
TEXT_MAX = 300
DIALOGUE_MSG_MAX = 4000       # characters kept of one message of a session's dialogue
DIALOGUE_MAX = 400 * 1000     # characters kept of one session's dialogue (the newest part)

# --- redaction -------------------------------------------------------------
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),            # OpenAI / Anthropic style keys
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),        # GitHub tokens
    re.compile(r"AKIA[0-9A-Z]{16}"),                  # AWS access key id
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),      # Slack tokens
    re.compile(r"(?i)(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+"),
]


def redact(text):
    for p in SECRET_PATTERNS:
        text = p.sub("[redacted]", text)
    return text


def clip(text, n=TEXT_MAX):
    text = re.sub(r"\s+", " ", text or "").strip()
    return redact(text[:n])


# --- file reading ----------------------------------------------------------
def read_lines(path):
    """Head and tail lines of a JSONL file, without loading a large file whole."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size <= HEAD_BYTES + TAIL_BYTES:
            data = f.read().decode("utf-8", "replace").split("\n")
            return data, data
        head = f.read(HEAD_BYTES).decode("utf-8", "replace").split("\n")[:-1]
        f.seek(size - TAIL_BYTES)
        tail = f.read().decode("utf-8", "replace").split("\n")[1:]
        return head, tail


def parse_json_lines(lines):
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict) and c.get("type") in ("text", "input_text", "output_text"):
                parts.append(c.get("text", ""))
        return " ".join(parts)
    return ""


# --- Claude Code -----------------------------------------------------------
CLAUDE_SKIP = re.compile(r"^\s*(<|\[Request interrupted|Caveat:)")


def parse_claude(path):
    head, tail = read_lines(path)
    hj, tj = parse_json_lines(head), parse_json_lines(tail)
    s = {"agent": "claude", "sid": os.path.basename(path)[:-6], "path": path,
         "cwd": "", "title": "", "first_prompt": "", "last_prompt": "", "last_reply": "",
         "started": "", "updated": ""}
    for j in hj:
        if not s["cwd"] and j.get("cwd"):
            s["cwd"] = j["cwd"]
        if not s["started"] and j.get("timestamp"):
            s["started"] = j["timestamp"]
        if not s["first_prompt"] and j.get("type") == "user" and isinstance(j.get("message"), dict):
            t = content_text(j["message"].get("content"))
            if t.strip() and not CLAUDE_SKIP.match(t):
                s["first_prompt"] = clip(t)
    for j in reversed(tj):
        t = j.get("type")
        if not s["updated"] and j.get("timestamp"):
            s["updated"] = j["timestamp"]
        if not s["title"] and t == "custom-title" and j.get("customTitle"):
            s["title"] = clip(j["customTitle"], 120)
        if not s["title"] and t == "ai-title" and j.get("aiTitle"):
            s["title"] = clip(j["aiTitle"], 120)
        if not s["last_prompt"] and t == "last-prompt" and j.get("lastPrompt"):
            s["last_prompt"] = clip(j["lastPrompt"])
        if isinstance(j.get("message"), dict):
            txt = content_text(j["message"].get("content"))
            if not s["last_reply"] and t == "assistant" and txt.strip():
                s["last_reply"] = clip(txt)
            if not s["last_prompt"] and t == "user" and txt.strip() and not CLAUDE_SKIP.match(txt):
                s["last_prompt"] = clip(txt)
    if not s["cwd"]:
        for j in tj:
            if j.get("cwd"):
                s["cwd"] = j["cwd"]
                break
    if not s["title"]:
        for j in hj:  # custom titles set early live in the head
            if j.get("type") in ("custom-title", "ai-title"):
                s["title"] = clip(j.get("customTitle") or j.get("aiTitle") or "", 120)
    return s


# --- Codex -----------------------------------------------------------------
CODEX_REQUEST = re.compile(r"##\s*My request for Codex:\s*", re.I)


def codex_user_text(t):
    """The user's own words, without the context blocks Codex adds."""
    m = CODEX_REQUEST.search(t)
    if m:
        return t[m.end():]
    s = t.strip()
    if (not s or s.startswith("<") or s.startswith("# Files mentioned") or s.startswith("# AGENTS.md")
            or s.startswith("The following is the Codex agent history")):
        return ""
    return t


def load_codex_index():
    names = {}
    if os.path.exists(CODEX_INDEX):
        with open(CODEX_INDEX, encoding="utf-8", errors="replace") as f:
            for j in parse_json_lines(f):
                if j.get("id") and j.get("thread_name"):
                    names[j["id"]] = j["thread_name"]
    return names


def parse_codex(path, names=None):
    head, tail = read_lines(path)
    hj, tj = parse_json_lines(head), parse_json_lines(tail)
    s = {"agent": "codex", "sid": "", "path": path, "cwd": "", "title": "", "first_prompt": "",
         "last_prompt": "", "last_reply": "", "started": "", "updated": ""}
    for j in hj:
        p = j.get("payload") or {}
        if j.get("type") == "session_meta":
            s["sid"] = p.get("id") or p.get("session_id") or ""
            s["cwd"] = p.get("cwd", "")
            s["started"] = p.get("timestamp") or j.get("timestamp", "")
        if not s["first_prompt"] and j.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
            t = codex_user_text(content_text(p.get("content")))
            if t.strip():
                s["first_prompt"] = clip(t)
    for j in reversed(tj):
        p = j.get("payload") or {}
        if not s["updated"] and j.get("timestamp"):
            s["updated"] = j["timestamp"]
        if j.get("type") == "response_item" and p.get("type") == "message":
            t = content_text(p.get("content"))
            if not s["last_reply"] and p.get("role") == "assistant" and t.strip():
                s["last_reply"] = clip(t)
            if not s["last_prompt"] and p.get("role") == "user":
                u = codex_user_text(t)
                if u.strip():
                    s["last_prompt"] = clip(u)
    if not s["sid"]:
        m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", os.path.basename(path))
        s["sid"] = m.group(1) if m else os.path.basename(path)
    if names and names.get(s["sid"]):
        s["title"] = clip(names[s["sid"]], 120)
    return s


# --- project identity --------------------------------------------------------
_git_cache = {}


def normalize_remote(url):
    url = url.strip()
    url = re.sub(r"\.git$", "", url)
    m = re.match(r"^[\w.-]+@([\w.-]+):(.+)$", url)          # git@github.com:owner/repo
    if m:
        return (m.group(1) + "/" + m.group(2)).lower()
    m = re.match(r"^\w+://(?:[^@/]+@)?([^/]+)/(.+)$", url)   # https://github.com/owner/repo
    if m:
        return (m.group(1) + "/" + m.group(2)).lower()
    return url.lower()


def project_key(cwd):
    """Same project on every device: the git remote. Fallback: folder name."""
    if not cwd:
        return ""
    if cwd in _git_cache:
        return _git_cache[cwd]
    key = ""
    if os.path.isdir(cwd):
        try:
            out = subprocess.run(["git", "-C", cwd, "config", "--get", "remote.origin.url"],
                                 capture_output=True, text=True, timeout=5, env=clean_git_env())
            if out.returncode == 0 and out.stdout.strip():
                key = "git:" + normalize_remote(out.stdout)
        except (OSError, subprocess.SubprocessError):
            pass
    if not key:
        base = re.split(r"[\\/]", cwd.rstrip("\\/"))[-1]
        key = "folder:" + base.lower()
    _git_cache[cwd] = key
    return key


# --- memories ----------------------------------------------------------------
def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def parse_frontmatter(text):
    """Claude memory files: '---' block with name, description, metadata.type."""
    meta, body = {}, text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end > 0:
            for line in text[3:end].splitlines():
                m = re.match(r"^\s*(name|description|type)\s*:\s*(.*)$", line)
                if m:
                    meta[m.group(1)] = m.group(2).strip().strip('"')
            body = text[end + 4:].lstrip("\n")
    return meta, body


def memory(source, scope, path, name, body, description="", kind="", project="", folder=""):
    try:
        mtime = int(os.path.getmtime(path))
    except OSError:
        mtime = 0
    return {"source": source, "scope": scope, "path": path, "name": clip(name, 120),
            "description": clip(description, 300), "kind": kind, "project": project, "folder": folder,
            "body": redact(body.strip()[:MEMORY_MAX]), "mtime": mtime}


def claude_folder_of(slug_dir):
    """The real folder of a Claude project directory, read from one of its sessions."""
    for f in sorted(os.listdir(slug_dir)):
        if f.endswith(".jsonl"):
            try:
                head, _ = read_lines(os.path.join(slug_dir, f))
            except OSError:
                continue
            for j in parse_json_lines(head[:50]):
                if j.get("cwd"):
                    return j["cwd"]
    return ""


def split_codex_task_groups(text):
    """Codex MEMORY.md: one memory per '# Task Group:' section; applies_to cwd = its folder."""
    parts = re.split(r"(?m)^# Task Group:\s*", text)
    out = []
    for part in parts[1:]:
        title, _, rest = part.partition("\n")
        m = re.search(r"applies_to:\s*cwd=([^;\n]+)", rest)
        scope_m = re.search(r"(?m)^scope:\s*(.+)$", rest)
        out.append({"title": title.strip(), "folder": m.group(1).strip() if m else "",
                    "scope": scope_m.group(1).strip() if scope_m else "", "body": "# " + title.strip() + "\n" + rest})
    return out


def collect_memories():
    mems = []
    if os.path.isfile(CLAUDE_USER_MD):
        mems.append(memory("claude", "user", CLAUDE_USER_MD, "Global CLAUDE.md", read_text(CLAUDE_USER_MD),
                           "User-level instructions for every Claude Code session", "instructions"))
    if os.path.isdir(CLAUDE_DIR):
        for d in sorted(os.listdir(CLAUDE_DIR)):
            mdir = os.path.join(CLAUDE_DIR, d, "memory")
            if not os.path.isdir(mdir):
                continue
            folder = claude_folder_of(os.path.join(CLAUDE_DIR, d))
            proj = project_key(folder) if folder else "folder:" + d.rstrip("-").split("-")[-1].lower()
            for f in sorted(os.listdir(mdir)):
                if not f.endswith(".md") or f == "MEMORY.md":
                    continue  # MEMORY.md is only an index of the other files
                path = os.path.join(mdir, f)
                meta, body = parse_frontmatter(read_text(path))
                mems.append(memory("claude", "project", path, meta.get("name") or f[:-3], body,
                                   meta.get("description", ""), meta.get("type", ""), proj, folder))
    if os.path.isfile(CODEX_AGENTS_MD):
        mems.append(memory("codex", "user", CODEX_AGENTS_MD, "Global AGENTS.md", read_text(CODEX_AGENTS_MD),
                           "User-level instructions for every Codex session", "instructions"))
    summary = os.path.join(CODEX_MEMORIES, "memory_summary.md")
    if os.path.isfile(summary):
        mems.append(memory("codex", "user", summary, "Codex user profile and preferences", read_text(summary),
                           "Summary Codex keeps of the user", "user"))
    index = os.path.join(CODEX_MEMORIES, "MEMORY.md")
    if os.path.isfile(index):
        groups = split_codex_task_groups(read_text(index))
        # a MEMORY.md without '# Task Group:' sections (other Codex versions) is kept whole
        if not groups and read_text(index).strip():
            groups = [{"title": "Codex MEMORY.md", "folder": "", "scope": "", "body": read_text(index)}]
        for g in groups:
            mems.append(memory("codex", "project" if g["folder"] else "user", index, g["title"], g["body"],
                               g["scope"], "task-group", project_key(g["folder"]) if g["folder"] else "", g["folder"]))
    return mems


# --- handoff: code snapshot, apply, transcript digest --------------------------
HANDOFF_DIR = os.path.join(STATE_DIR, "handoffs")


# Variables git sets for hooks and that redirect commands to ANOTHER repository
# (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, ...). Inherited by accident, they make
# `git -C <dir>` act on the wrong repo. Every git call here drops them first.
GIT_LOCAL_VARS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                  "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_IMPLICIT_WORK_TREE",
                  "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
                  "GIT_CONFIG_COUNT", "GIT_EXEC_PATH_UNUSED")


def clean_git_env(extra=None):
    env = {k: v for k, v in os.environ.items() if k not in GIT_LOCAL_VARS and not k.startswith("GIT_CONFIG_KEY_")
           and not k.startswith("GIT_CONFIG_VALUE_")}
    env.update(extra or {})
    return env


def _git(cwd, *args, env=None, check=True, binary=False):
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, env=env or clean_git_env(), timeout=600)
    if check and p.returncode != 0:
        raise RuntimeError("git %s: %s" % (args[0], p.stderr.decode("utf-8", "replace").strip()[-400:]))
    return p.stdout if binary else p.stdout.decode("utf-8", "replace").strip()


def git_info(cwd):
    """Read-only git state of a folder."""
    if not os.path.isdir(cwd):
        return {"git": False, "error": "folder not found"}
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd, capture_output=True, text=True,
                         env=clean_git_env())
    if top.returncode != 0:
        return {"git": False, "root": os.path.abspath(cwd), "branch": "(no git)", "head": "", "status": "",
                "remote": "", "log": "", "files": plain_info(cwd), "task_files": task_files(cwd)}
    root = top.stdout.strip()
    has_head = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=root, capture_output=True,
                              env=clean_git_env()).returncode == 0
    return {"git": True, "root": root,
            "branch": _git(root, "rev-parse", "--abbrev-ref", "HEAD", check=False),
            "head": _git(root, "rev-parse", "HEAD") if has_head else "",
            "status": _git(root, "status", "--porcelain", "--untracked-files=all", check=False),
            "remote": _git(root, "config", "--get", "remote.origin.url", check=False),
            "log": _git(root, "log", "--oneline", "-8", check=False) if has_head else "",
            "task_files": task_files(root)}


TASK_FILE_NAMES = ("TASK.md", "TODO.md", "NOTES.md", "README.md", "PLAN.md", "AGENTS.md", "CLAUDE.md")


def task_files(root, limit=3000):
    """Short text of the files that usually state the task, for the packet writer."""
    out = {}
    for name in TASK_FILE_NAMES:
        p = os.path.join(root, name)
        if os.path.isfile(p):
            with open(p, encoding="utf-8", errors="replace") as f:
                out[name] = redact(f.read(limit))
    return out


def snapshot(cwd, hid):
    """Bundle the current work (committed + staged + unstaged + new files) WITHOUT touching
    the user's branch, index or working tree: a temporary index builds a commit on the
    private ref refs/handoff/<hid>; the ref is deleted after the bundle is written."""
    if not re.match(r"^[A-Za-z0-9_-]{4,40}$", hid):
        raise ValueError("bad handoff id")
    info = git_info(cwd)
    if not info.get("git"):
        if info.get("error"):
            raise RuntimeError("%s: %s" % (info["error"], cwd))
        return snapshot_plain(cwd, hid)
    root = info["root"]
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp_index = os.path.join(STATE_DIR, "index-" + hid)
    env = clean_git_env({"GIT_INDEX_FILE": tmp_index, "GIT_AUTHOR_NAME": "handoff", "GIT_AUTHOR_EMAIL": "handoff@cc-brain",
                         "GIT_COMMITTER_NAME": "handoff", "GIT_COMMITTER_EMAIL": "handoff@cc-brain"})
    ref = "refs/handoff/" + hid
    bundle_path = os.path.join(STATE_DIR, "bundle-" + hid)
    try:
        if info["head"]:
            _git(root, "read-tree", "HEAD", env=env)
        _git(root, "add", "-A", env=env)                  # respects .gitignore
        tree = _git(root, "write-tree", env=env)
        parents = ["-p", info["head"]] if info["head"] else []
        commit = _git(root, "commit-tree", tree, *parents, "-m", "handoff %s: work in progress from %s"
                      % (hid, socket.gethostname()), env=env)
        _git(root, "update-ref", ref, commit)
        _git(root, "bundle", "create", bundle_path, ref)
        with open(bundle_path, "rb") as f:
            return f.read()
    finally:
        subprocess.run(["git", "update-ref", "-d", ref], cwd=root, capture_output=True, env=clean_git_env())
        for p in (tmp_index, bundle_path):
            if os.path.exists(p):
                os.remove(p)


# Folders without git: these are never copied (rebuildable or machine-specific).
PLAIN_EXCLUDES = ["node_modules/", ".venv/", "venv/", "env/", "__pycache__/", "*.pyc", ".DS_Store", "Thumbs.db",
                  "dist/", "build/", ".next/", ".cache/", "target/", "bin/Debug/", "bin/Release/", "obj/",
                  ".idea/", ".vs/", "*.log", ".git/"]
PLAIN_MAX_FILE = 20 * 1024 * 1024     # bigger files are skipped and listed
PLAIN_MAX_TOTAL = 300 * 1024 * 1024   # refuse beyond this


def _rmtree(path):
    """Delete a folder completely. On Windows git makes its object files read-only, and
    shutil.rmtree(ignore_errors=True) then leaves them behind without a word."""
    import shutil
    import stat

    def again(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=again)
    else:
        shutil.rmtree(path, onerror=again)


def snapshot_plain(folder, hid):
    """Snapshot a folder that is not a git repository, WITHOUT writing into it: a separate,
    temporary git directory under ~/.cc-brain is pointed at the folder (GIT_WORK_TREE).
    Skips PLAIN_EXCLUDES and files over PLAIN_MAX_FILE (recorded in .handoff-skipped.txt
    inside the snapshot). The temporary git directory is deleted afterwards."""
    folder = os.path.abspath(folder)
    gitdir = os.path.join(STATE_DIR, "plain-" + hid + ".git")
    bundle_path = os.path.join(STATE_DIR, "bundle-" + hid)
    os.makedirs(STATE_DIR, exist_ok=True)
    skipped, total = [], 0
    for root, dirs, files in os.walk(folder):
        rel_root = os.path.relpath(root, folder).replace("\\", "/")
        dirs[:] = [d for d in dirs if (d + "/") not in PLAIN_EXCLUDES and d != ".git"]
        for f in files:
            p = os.path.join(root, f)
            try:
                size = os.path.getsize(p)
            except OSError:
                continue
            rel = f if rel_root == "." else rel_root + "/" + f
            if size > PLAIN_MAX_FILE:
                skipped.append("%s (%d MB)" % (rel, size // (1024 * 1024)))
            else:
                total += size
    if total > PLAIN_MAX_TOTAL:
        raise RuntimeError("folder too large to hand off without git: %d MB" % (total // (1024 * 1024)))
    env = clean_git_env({"GIT_DIR": gitdir, "GIT_WORK_TREE": folder, "GIT_AUTHOR_NAME": "handoff",
                         "GIT_AUTHOR_EMAIL": "handoff@cc-brain", "GIT_COMMITTER_NAME": "handoff",
                         "GIT_COMMITTER_EMAIL": "handoff@cc-brain"})
    try:
        _git(STATE_DIR, "init", "-q", env=env)
        with open(os.path.join(gitdir, "info", "exclude"), "w") as f:
            f.write("\n".join(PLAIN_EXCLUDES + [s.split(" (")[0] for s in skipped]) + "\n")
        _git(STATE_DIR, "add", "-A", env=env)
        if skipped:  # a note inside the snapshot only (blob written to the temp git dir, not the folder)
            note = "Files not copied by the handoff (too large):\n" + "\n".join(skipped) + "\n"
            blob = subprocess.run(["git", "hash-object", "-w", "--stdin"], input=note.encode(), capture_output=True,
                                  env=env, cwd=STATE_DIR, check=True).stdout.decode().strip()
            _git(STATE_DIR, "update-index", "--add", "--cacheinfo", "100644,%s,.handoff-skipped.txt" % blob, env=env)
        tree = _git(STATE_DIR, "write-tree", env=env)
        commit = _git(STATE_DIR, "commit-tree", tree, "-m", "handoff %s: folder snapshot from %s (no git)"
                      % (hid, socket.gethostname()), env=env)
        _git(STATE_DIR, "update-ref", "refs/handoff/" + hid, commit, env=env)
        _git(STATE_DIR, "bundle", "create", bundle_path, "refs/handoff/" + hid, env=env)
        with open(bundle_path, "rb") as f:
            return f.read()
    finally:
        _rmtree(gitdir)
        if os.path.exists(bundle_path):
            os.remove(bundle_path)


def plain_info(folder, limit=60):
    """Read-only facts about a non-git folder for the packet writer."""
    names = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if (d + "/") not in PLAIN_EXCLUDES and d != ".git"]
        for f in files:
            names.append(os.path.relpath(os.path.join(root, f), folder).replace("\\", "/"))
            if len(names) >= limit:
                return names
    return names


def apply_bundle(data, hid, name):
    """Open handed-off code in a NEW repository under ~/.cc-brain/handoffs/<hid>/<name>,
    on branch handoff/<hid>. Never touches an existing checkout."""
    if not re.match(r"^[A-Za-z0-9_-]{4,40}$", hid):
        raise ValueError("bad handoff id")
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name or "project")[:60] or "project"
    target = os.path.join(HANDOFF_DIR, hid, name)
    if os.path.exists(target):
        raise RuntimeError("target exists: %s" % target)
    os.makedirs(target)
    bundle_path = os.path.join(HANDOFF_DIR, hid, "code.bundle")
    with open(bundle_path, "wb") as f:
        f.write(data)
    _git(target, "init", "-q")
    _git(target, "fetch", "-q", bundle_path, "refs/handoff/%s:refs/heads/handoff/%s" % (hid, hid))
    _git(target, "checkout", "-q", "handoff/" + hid)
    os.remove(bundle_path)
    return {"target_path": target, "branch": "handoff/" + hid, "head": _git(target, "rev-parse", "HEAD")}


def dialogue_items(path):
    """What happened in a session, oldest first: (role, text, timestamp) with role user, assistant
    or tool. The user's requests, the agent's replies, and one short line for each tool it used."""
    is_codex = "rollout-" in os.path.basename(path)
    items = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for j in parse_json_lines(f):
            ts = j.get("timestamp") or ""
            if is_codex:
                p = j.get("payload") or {}
                if j.get("type") == "response_item" and p.get("type") == "message" and p.get("role") in ("user", "assistant"):
                    t = content_text(p.get("content"))
                    t = codex_user_text(t) if p["role"] == "user" else t
                    if t.strip():
                        items.append((p["role"], t.strip(), ts))
                elif j.get("type") == "response_item" and p.get("type") in ("function_call", "custom_tool_call"):
                    items.append(("tool", "%s %s" % (p.get("name"), str(p.get("arguments") or p.get("input") or "")[:300]), ts))
                continue
            m = j.get("message")
            if not isinstance(m, dict):
                continue
            c = m.get("content")
            if j.get("type") == "user":
                t = content_text(c)
                if t.strip() and not CLAUDE_SKIP.match(t):
                    items.append(("user", t.strip(), ts))
            elif j.get("type") == "assistant" and isinstance(c, list):
                for part in c:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "text" and part.get("text", "").strip():
                        items.append(("assistant", part["text"].strip(), ts))
                    elif part.get("type") == "tool_use":
                        inp = part.get("input") or {}
                        brief = inp.get("file_path") or inp.get("command") or inp.get("pattern") or json.dumps(inp)[:200]
                        items.append(("tool", "%s %s" % (part.get("name"), str(brief)[:300]), ts))
    return items


def transcript_digest(path, max_chars=40000):
    """What happened in a session, as plain text for the packet writer: the user's
    requests, the agent's replies, and the tools it used. Newest part kept when long."""
    lines = ["%s: %s" % (r, redact(t)) for r, t, _ in dialogue_items(path)]
    first = lines[:3]
    text = "\n".join(lines)
    if len(text) > max_chars:
        tail = text[-(max_chars - 3000):]
        text = "\n".join(first)[:3000] + "\n[... earlier part omitted ...]\n" + tail
    return text


def dialogue(path, msg_max=None, total_max=None):
    """The whole dialogue of a session for the brain's full-text search: a list of
    {"r": role, "t": text, "ts": timestamp}, oldest first, secrets redacted. A long message is cut;
    of a very long session the first messages and the newest part are kept (the cut is marked)."""
    msg_max = msg_max or DIALOGUE_MSG_MAX
    total_max = total_max or DIALOGUE_MAX
    out = []
    for r, t, ts in dialogue_items(path):
        t = redact(t)
        if len(t) > msg_max:
            t = t[:msg_max] + " [... cut ...]"
        out.append({"r": r, "t": t, "ts": ts})
    if sum(len(m["t"]) for m in out) > total_max:
        head, used, tail = out[:3], sum(len(m["t"]) for m in out[:3]), []
        for m in reversed(out[3:]):
            if used + len(m["t"]) > total_max:
                break
            used += len(m["t"])
            tail.append(m)
        out = head + [{"r": "tool", "t": "[... %d earlier messages left out ...]" % (len(out) - 3 - len(tail)), "ts": ""}] + tail[::-1]
    return out


# --- main --------------------------------------------------------------------
def session_files():
    if os.path.isdir(CLAUDE_DIR):
        for d in os.listdir(CLAUDE_DIR):
            full = os.path.join(CLAUDE_DIR, d)
            if not os.path.isdir(full):
                continue
            for f in os.listdir(full):
                if f.endswith(".jsonl"):
                    yield "claude", os.path.join(full, f)
    if os.path.isdir(CODEX_DIR):
        for root, _, files in os.walk(CODEX_DIR):
            for f in files:
                if f.endswith(".jsonl"):
                    yield "codex", os.path.join(root, f)


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def machine_id():
    """A stable id of this computer's hardware or OS install, hashed (the raw id never leaves the
    computer). A copied config (Migration Assistant, a restored backup) keeps its device token, but
    this id changes, so the brain can tell two computers apart. "" when it cannot be read.
    CC_MACHINE_ID replaces it in tests."""
    raw = os.environ.get("CC_MACHINE_ID", "")
    try:
        if raw:
            pass
        elif sys.platform == "darwin":
            out = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], capture_output=True,
                                 text=True, timeout=5).stdout
            m = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', out)
            raw = m.group(1) if m else ""
        elif sys.platform == "win32":
            out = subprocess.run(["reg", "query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"],
                                 capture_output=True, text=True, timeout=5).stdout
            m = re.search(r"MachineGuid\s+REG_SZ\s+(\S+)", out)
            raw = m.group(1) if m else ""
        else:
            for f in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                if os.path.exists(f):
                    raw = open(f).read().strip()
                    break
    except (OSError, subprocess.SubprocessError):
        raw = ""
    if not raw:
        return ""
    import hashlib
    return hashlib.sha256(("cc-brain-machine:" + raw).encode()).hexdigest()[:32]


def collect(all_sessions=False, dialogue_too=True):
    """New and changed sessions (all of them with all_sessions) and the memory files.
    dialogue_too=False: for a brain that does not keep dialogues (an older version): the sessions
    carry no dialogue and the state stamps have the old form, so nothing is sent twice now and
    everything is sent once, with its dialogue, when the brain is updated."""
    state = {} if all_sessions else load_state()
    new_state = {}
    names = load_codex_index()
    sessions, errors = [], []
    for agent, path in session_files():
        try:
            st = os.stat(path)
        except OSError:
            continue
        # the collector version is part of the stamp: a new version sends every session again once
        stamp = "%d:%d" % (int(st.st_mtime), st.st_size) + (":v%d" % VERSION if dialogue_too else "")
        new_state[path] = stamp
        if state.get(path) == stamp:
            continue
        try:
            s = parse_claude(path) if agent == "claude" else parse_codex(path, names)
            if not (s["first_prompt"] or s["last_prompt"] or s["title"]):
                continue  # empty or tool-only file
            s["project"] = project_key(s["cwd"])
            s["size"] = st.st_size
            s["mtime"] = int(st.st_mtime)
            if dialogue_too:
                s["messages"] = dialogue(path)
            sessions.append(s)
        except Exception as e:  # one bad file must not stop the rest
            errors.append({"path": path, "error": str(e)[:200]})
    known = set(new_state)
    removed = [p for p in state if p not in known]
    return {
        "version": VERSION,
        "device": socket.gethostname().split(".")[0].lower(),
        "os": platform.system(),
        "home": HOME,
        "machine": machine_id(),
        "sessions": sessions,
        "memories": collect_memories(),  # always the full set: small, and handles deletions
        "removed": removed,
        "errors": errors,
    }, new_state


def main(argv):
    if "--git-info" in argv:
        out = git_info(argv[argv.index("--git-info") + 1])
    elif "--snapshot" in argv:
        i = argv.index("--snapshot")
        data = snapshot(argv[i + 1], argv[i + 2])
        sys.stdout.buffer.write(data)
        sys.stdout.flush()
        return
    elif "--apply" in argv:
        i = argv.index("--apply")
        out = apply_bundle(sys.stdin.buffer.read(), argv[i + 1], argv[i + 2])
    elif "--transcript" in argv:
        out = {"text": transcript_digest(argv[argv.index("--transcript") + 1])}
    elif "--file" in argv:
        path = argv[argv.index("--file") + 1]
        s = parse_codex(path) if "rollout-" in os.path.basename(path) else parse_claude(path)
        s["project"] = project_key(s["cwd"])
        out = s
    else:
        out, new_state = collect(all_sessions="--all" in argv)
        if "--dry-run" not in argv:
            save_state(new_state)
    data = json.dumps(out, ensure_ascii=False)
    try:
        sys.stdout.buffer.write(data.encode("utf-8"))
    except AttributeError:
        sys.stdout.write(data)
    sys.stdout.flush()


if __name__ == "__main__":
    main(sys.argv[1:])
