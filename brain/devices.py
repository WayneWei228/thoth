"""Run things on a device known to the brain: this Mac (local) or a remote one over SSH.

Python code is sent on stdin (`python -`), so nothing has to survive Windows cmd quoting.
Used by handoff.py and the handoff eval.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import brain  # noqa: E402


def device(name):
    for d in brain.load_devices():
        if d["name"] == name:
            return d
    raise KeyError(f"unknown device {name!r}; see ~/.config/cc-brain/devices.json")


def is_local(dev):
    return dev.get("transport") == "local"


def _python_cmd(dev):
    if is_local(dev):
        return [sys.executable]
    return brain.ssh_base(dev) + [dev.get("python", "python3")]


def run_py(dev, code, stdin_bytes=None, timeout=600):
    """Run Python source on the device; returns stdout bytes. Raises RuntimeError on failure.
    stdin_bytes, if given, is appended after the code as data the code reads from sys.stdin.buffer
    (the code must read exactly that). The code is passed with -c on local, via stdin on remote."""
    if stdin_bytes is None:
        cmd = _python_cmd(dev) + ["-"]
        p = subprocess.run(cmd, input=code.encode(), capture_output=True, timeout=timeout)
    else:
        # code first as a length-prefixed header, then the payload
        boot = ("import sys;n=int(sys.stdin.buffer.readline());src=sys.stdin.buffer.read(n).decode();"
                "exec(compile(src,'<brain>','exec'))")
        if is_local(dev):
            cmd = _python_cmd(dev) + ["-c", boot]
        else:
            cmd = _python_cmd(dev) + ["-c", '"' + boot + '"']
        payload = str(len(code.encode())).encode() + b"\n" + code.encode() + stdin_bytes
        p = subprocess.run(cmd, input=payload, capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"{dev['name']}: {(p.stderr or p.stdout).decode('utf-8', 'replace')[-800:]}")
    return p.stdout


def run_py_json(dev, code, **kw):
    out = run_py(dev, code, **kw).decode("utf-8", "replace").strip().splitlines()
    return json.loads(out[-1]) if out else None


def collector_cmd(dev):
    """Command prefix that runs the (deployed) collector on the device."""
    if is_local(dev):
        return [sys.executable, "-I", brain.COLLECTOR]
    brain.deploy_remote(dev)
    return brain.ssh_base(dev) + ["%s -I %s" % (dev.get("python", "python3"), dev.get("collector_path", ".cc-brain/collector.py"))]


def run_collector(dev, args, stdin_bytes=None, timeout=600):
    cmd = collector_cmd(dev)
    if is_local(dev):
        cmd = cmd + args
    else:
        cmd = cmd[:-1] + [cmd[-1] + " " + " ".join(_q(a) for a in args)]
    p = subprocess.run(cmd, input=stdin_bytes, capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"{dev['name']} collector {args[:1]}: {(p.stderr or p.stdout).decode('utf-8', 'replace')[-800:]}")
    return p.stdout


def _q(a):
    # arguments for a remote shell (cmd.exe or sh): quote when needed
    if a and all(c.isalnum() or c in "-_./:\\=@" for c in a):
        return a
    return '"' + a.replace('"', '\\"') + '"'
