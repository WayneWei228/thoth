#!/usr/bin/env python3
"""Claude Code UserPromptSubmit hook: every prompt goes through the central brain first.

Claude Code sends {"prompt", "cwd", "session_id", ...} on stdin. We ask the brain
(POST /api/enrich; the cloud brain in the panel's brain.json with its owner token, else local); an AI retrieval step there searches the brain (sessions, memories,
devices) and decides what helps. We return it as additionalContext.
A cloud brain (token mode) does not run the AI step: it answers with keyword-search context, fast.
It never blocks the prompt: on any error or timeout it prints nothing and exits 0. It waits at most
58 s for a local brain (the AI step takes up to 50 s) and 15 s for a cloud brain.
"""
import json
import os
import sys
import urllib.request



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


def main():
    brain, token = brain_location()
    try:
        data = json.loads(sys.stdin.read() or "{}")
        body = json.dumps({"prompt": data.get("prompt", ""), "cwd": data.get("cwd", ""),
                           "session_id": data.get("session_id", "")}).encode()
        req = urllib.request.Request(brain + "/api/enrich", data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              **({"Authorization": "Bearer " + token} if token else {})})
        ctx = json.loads(urllib.request.urlopen(req, timeout=15 if token else 58).read()).get("context", "")
    except Exception:
        return
    if ctx.strip():
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                                 "additionalContext": ctx[:9000]}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
