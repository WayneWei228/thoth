#!/usr/bin/env python3
"""Device agent: connects this computer to the user's brain and pushes its sessions.

Installed by the join command the setup page shows (device/join.sh, device/join.ps1). Uses only the
Python standard library and collector.py next to it.

  python3 device_agent.py join <brain-address> [code] [--name NAME] [--no-wait]   join once; keeps a token
  python3 device_agent.py wait                                         wait for Approve (after join --no-wait: exit 6)
  python3 device_agent.py push                                         send new sessions (run on a schedule)

A copied config (Migration Assistant, a restored backup): the device file remembers the machine id
of the computer that joined (collector.machine_id()). When it does not match this computer, or the
brain says another computer already pushes with this token (409), the push stops, the file is moved
to <file>.copied and this computer asks to join with its own name (the owner approves it). With
CC_DEVICE_NO_REJOIN=1 (the panel's own push) it only moves the file and exits 7; the panel joins again.

Two kinds of brain:
- a cloud brain (https://...): without a code the computer asks to
  join and waits until the owner chooses Approve (or Ignore) on their panel; with a pre-approved
  code it joins at once. Pushes go to POST /api/ingest over HTTPS (outgoing connections only).
- a brain computer on the same network (the panel's device listener, http://<lan-ip>:7870): a
  one-time code is needed. Pushes go to POST /api/device/push.
State: ~/.cc-brain/device.json (0600), or the file in CC_DEVICE_CONF: brain address, device name,
token (or, while waiting for approval, the pending id and its poll secret).

A brain computer on a home network gets a new address from time to time. This agent then finds it
again by itself (find_hub): it tries every address the brain computer gave it, then asks the
computers of its own network on the brain's port. It takes a new address only from a machine that
proves it is the brain this computer joined (hub_proof), and it sends its token only after that proof.
"""
import concurrent.futures
import hashlib
import hmac
import json
import os
import platform
import secrets
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
if not os.path.exists(os.path.join(HERE, "collector.py")):   # run from the repo (the panel's own push)
    sys.path.insert(1, os.path.join(os.path.dirname(HERE), "brain"))
CONF = os.environ.get("CC_DEVICE_CONF") or os.path.join(os.path.expanduser("~"), ".cc-brain", "device.json")
POLL_SECS = float(os.environ.get("CC_DEVICE_POLL_SECS") or 3)
WAIT_SECS = float(os.environ.get("CC_DEVICE_WAIT_SECS") or 30 * 60)


def _why(e):
    r = getattr(e, "reason", e)
    if isinstance(r, ssl.SSLError) or isinstance(e, ssl.SSLError) or "CERTIFICATE" in str(r).upper():
        return f"the brain's security certificate is not valid ({r})"
    return f"cannot reach the brain: {r}"


def request(method, url, body=None, token=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})}
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, socket.timeout, OSError, ValueError) as e:
        return 0, {"error": _why(e)}


def post(url, body, token=None, timeout=120):
    return request("POST", url, body, token, timeout)


def this_os():
    s = platform.system()
    if s == "Linux" and is_wsl():
        return "windows-wsl"  # Linux inside WSL on a Windows PC (lib/wsl.ts)
    return "macos" if s == "Darwin" else "windows" if s == "Windows" else "linux"


def is_wsl(release=None, proc_version=None):
    """This Linux runs inside WSL: the kernel release or /proc/version names Microsoft."""
    if "microsoft" in (platform.release() if release is None else release).lower():
        return True
    if proc_version is None:
        try:
            with open("/proc/version", encoding="utf-8") as f:
                proc_version = f.read()
        except OSError:
            proc_version = ""
    return "microsoft" in proc_version.lower()


def save(conf):
    os.makedirs(os.path.dirname(CONF), exist_ok=True)
    tmp = CONF + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(conf, f)
    os.replace(tmp, CONF)
    try:
        os.chmod(CONF, 0o600)
    except OSError:
        pass


def cloud_state_file():
    """Collector state for a cloud brain: next to the device file, so a first push sends everything
    (a LAN pairing or the local brain may already have their own state in ~/.cc-brain)."""
    return os.path.splitext(CONF)[0] + "-collector-state.json"


def is_cloud(hub):
    """A cloud brain answers GET /api/health with {ok: true}; the LAN device listener does not."""
    status, j = request("GET", hub + "/api/health", timeout=20)
    return status == 200 and j.get("ok") is True, status, j


def machine():
    import collector
    return collector.machine_id()


def approved(hub, j):
    save({"hub": hub, "device": j["device"], "token": j["token"], "mode": "cloud", "machine": machine()})
    try:
        os.remove(cloud_state_file())
    except OSError:
        pass
    print(f"Approved. Joined as '{j['device']}' with your cloud brain at {hub}.", flush=True)


def poll_once(conf):
    """While pending: ask the cloud brain once. Returns approved, pending, ignored, gone or error."""
    status, j = request("GET", f"{conf['hub']}/api/join/{conf['pending_id']}", token=conf["poll_secret"], timeout=30)
    st = j.get("status") if status == 200 else None
    if st == "approved" and j.get("token"):
        approved(conf["hub"], {"device": j.get("device") or conf.get("device"), "token": j["token"]})
        return "approved"
    if st in ("pending", "ignored"):
        return st
    if status in (401, 403, 404, 410) or st == "approved":
        return "gone"   # the request is unknown now, or its token was already handed out
    return "error"


def load():
    try:
        return json.load(open(CONF))
    except (OSError, ValueError):
        return None


def wait_approval():
    """Ask the cloud brain until the owner decides, for WAIT_SECS. The schedule asks too (join.sh
    installs it before this wait), and the brain hands the token out once: so read the file each
    time, the scheduled run may have put the token there."""
    end = time.time() + WAIT_SECS
    while time.time() < end:
        conf = load()
        if not conf:
            print("This computer is not paired yet. Run the join command from the setup page.")
            return 2
        st = "approved" if conf.get("token") else poll_once(conf) if conf.get("pending_id") else "gone"
        if st == "gone" and (load() or {}).get("token"):
            st = "approved"
        if st == "approved":
            if conf.get("token"):
                print(f"Approved. Joined as '{conf.get('device')}' with your cloud brain at {conf.get('hub')}.", flush=True)
            return 0
        if st == "ignored":
            print("The owner chose Ignore, so this computer did not join. Ask them to choose Unignore, then run the command again.")
            return 4
        if st == "gone":
            print("The brain no longer knows this request. Run the join command again.")
            return 5
        time.sleep(POLL_SECS)
    print("Still waiting for approval. This computer asks again every 5 minutes and starts sending sessions after you approve it.")
    return 0


# ------------------------------------------------ the brain computer moved ----
SCAN_EVERY = float(os.environ.get("CC_DEVICE_SCAN_EVERY") or 30 * 60)   # look on the network at most this often
PROVE_TIMEOUT = float(os.environ.get("CC_DEVICE_PROVE_TIMEOUT") or 4)


def hostport(hub):
    return hub.split("://", 1)[-1].rstrip("/")


def hub_proof(addr, conf, timeout=None):
    """Ask the machine at addr ("ip:port") to prove it is the brain this computer joined: it must
    answer a random nonce with HMAC-SHA256(key: the hash of this computer's token, nonce). Only the
    brain has that hash. Nothing secret is sent. Returns (state, answer):
    'ok', 'wrong' (a bad proof), 'old' (a brain from before this check), 'refused' (it does not
    know this computer), 'down' (no answer)."""
    nonce = secrets.token_hex(16)
    status, j = request("POST", f"http://{addr}/api/hub/prove", {"device": conf["device"], "nonce": nonce},
                        timeout=timeout or PROVE_TIMEOUT)
    if status == 0:
        return "down", j
    if status == 404:
        return "old", j
    if status != 200:
        return "refused", j
    key = hashlib.sha256(conf["token"].encode()).hexdigest().encode()
    want = hmac.new(key, nonce.encode(), hashlib.sha256).hexdigest()
    return ("ok" if hmac.compare_digest(str(j.get("proof") or ""), want) else "wrong"), j


def my_address(toward):
    """This computer's address on the network that leads to `toward` (no packet is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((toward, 9))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


def net24(ip):
    p = ip.split(".")
    return ".".join(p[:3]) if len(p) == 4 and all(x.isdigit() for x in p) else ""


def listening(net, port, skip=(), timeout=0.5):
    """The addresses net.1 .. net.254 that accept a connection on the port (the brain's device port)."""
    def open_(ip):
        try:
            with socket.create_connection((ip, port), timeout=timeout):
                return ip
        except OSError:
            return None
    ips = ["%s.%d" % (net, i) for i in range(1, 255)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as ex:
        return [ip for ip in ex.map(open_, ips) if ip and ip not in skip]


def find_hub(conf, now=None):
    """The brain computer does not answer on its address. Returns its new "ip:port", or "".
    1. Every address it gave this computer (its other network, Tailscale).
    2. The computers of this computer's own network, on the brain's port: only when this is the
       network the brain was on (not a cafe or an office), and at most every SCAN_EVERY seconds.
    A machine is taken only with a correct proof (hub_proof)."""
    now = time.time() if now is None else now
    old = hostport(conf["hub"])
    known = [a for a in dict.fromkeys([old] + list(conf.get("addresses") or [])) if ":" in a]
    for a in known[1:]:
        if hub_proof(a, conf)[0] == "ok":
            return a
    if now - float(conf.get("last_scan") or 0) < SCAN_EVERY:
        return ""
    conf["last_scan"] = now
    save(conf)
    for a in known:
        ip, port = a.rsplit(":", 1)
        mine = my_address(ip)
        if not net24(ip) or net24(mine) != net24(ip) or not port.isdigit():
            continue     # this computer is on another network now: do not knock on strangers' doors
        for cand in listening(net24(ip), int(port), skip=(ip,)):
            if hub_proof("%s:%s" % (cand, port), conf)[0] == "ok":
                return "%s:%s" % (cand, port)
    return ""


def reach_hub(conf):
    """Before a push to a brain computer on the network: is it there, and is it the right one?
    Returns True to go on with the push. May change conf["hub"] (and saves it)."""
    state, j = hub_proof(hostport(conf["hub"]), conf)
    if state == "wrong":
        print("The machine on the brain's address did not prove that it is the brain this computer joined, so "
              "nothing was sent. If the brain was set up again or this computer was removed, join again: "
              "on the brain's All Devices page choose Reconnect (or Add Computer) and run the command here.")
        return False
    if state == "down":
        new = find_hub(conf)
        if not new:
            print(f"The brain computer does not answer at {conf['hub']}. It may be off or asleep, or it has a new "
                  "address this computer could not find. It will try again on the next run.")
            return False
        print(f"The brain computer moved from {conf['hub']} to http://{new}. Using the new address.")
        conf["hub"] = "http://" + new
        conf.pop("last_scan", None)
        save(conf)
    elif state == "ok" and j.get("addresses") and j["addresses"] != conf.get("addresses"):
        conf["addresses"] = [str(a) for a in j["addresses"]][:8]
        save(conf)
    return True      # ok, old (a brain without the check) or refused (the push then says why)


def join_cloud(hub, code, name, wait=True):
    body = {"name": name or own_name(), "os": this_os(), "host": socket.gethostname(), "machine": machine()}
    if code:
        body["code"] = code.strip().upper()
    status, j = post(hub + "/api/join", body)
    if status == 200 and j.get("token"):
        approved(hub, j)
        return 0
    if status == 200 and j.get("pending_id") and j.get("poll_secret"):
        conf = {"hub": hub, "device": body["name"], "pending_id": j["pending_id"], "poll_secret": j["poll_secret"], "mode": "cloud",
                "machine": body.get("machine", "")}
        save(conf)
        print(f"Asked your cloud brain to let '{body['name']}' join.")
        print("Waiting for approval. In Thoth on your main Mac: the join request at the top of the sidebar, or File > Set Up Devices… Choose Approve there.", flush=True)
        return wait_approval() if wait else 6   # 6: asked, not approved yet (join.sh installs the schedule, then runs "wait")
    if status in (401, 403) and code:
        print(f"Joining failed: {j.get('error') or 'the code is wrong, used or expired'}.")
        print("Make a new code on the setup page, or run the command without a code and approve the computer there.")
        return 1
    print(f"Joining failed: {j.get('error') or f'status {status}'}")
    return 1


def join(hub, code, name="", wait=True):
    hub = (hub if hub.startswith("http") else "http://" + hub).rstrip("/")
    cloud, status, j = is_cloud(hub)
    if cloud:
        return join_cloud(hub, code, name, wait)
    if status == 0 and hub.startswith("https://"):
        print(f"Joining failed: {j.get('error')}.")
        return 1
    if not code:
        print("This brain needs a code. Choose Get join command on the setup page and run that command.")
        return 2
    status, j = post(hub + "/api/join", {"code": code.strip().upper(), "name": name, "os": this_os(),
                                         "host": socket.gethostname()})
    if status != 200 or not j.get("token"):
        print(f"Pairing failed: {j.get('error') or f'status {status}'}")
        print("Make a new code on the setup page and run the command again.")
        return 1
    save({"hub": hub, "device": j["device"], "token": j["token"], "machine": machine(),
          "addresses": [str(a) for a in (j.get("addresses") or [])][:8]})
    print(f"Paired as '{j['device']}' with the brain at {hub}.")
    return 0


def own_name():
    """A device name from this computer's host name (a-z, 0-9, -)."""
    n = "".join(c if c.isascii() and c.isalnum() else "-" for c in socket.gethostname().split(".")[0].lower()).strip("-")
    return n[:31] or "computer"


def copied(conf, why):
    """This device file belongs to another computer. Move it aside, then (cloud brain) ask to join
    with this computer's own name. Returns the exit code."""
    print(f"This computer's device file was copied from another computer ({why}). Its token stays with "
          f"'{conf.get('device')}', so nothing was sent.", flush=True)
    try:
        os.replace(CONF, CONF + ".copied")
    except OSError:
        pass
    for f in (cloud_state_file(),):
        try:
            os.remove(f)
        except OSError:
            pass
    if conf.get("mode") != "cloud" or os.environ.get("CC_DEVICE_NO_REJOIN"):
        print("Join this computer again with its own name (the join command on the setup page).")
        return 7
    name = own_name()
    if name == conf.get("device"):
        name = (name[:28] + "-2")
    print(f"Asking the brain to let this computer join as '{name}'.", flush=True)
    rc = join_cloud(conf["hub"], "", name, wait=False)
    return 7 if rc in (0, 6) else rc


PART_BYTES = int(os.environ.get("CC_DEVICE_PART_BYTES", str(4 * 1024 * 1024)))


def parts(out, limit=None):
    """Split a collector document into documents of about `limit` bytes of sessions. The first part
    carries everything that is not a session (memories, removed files); the others only sessions."""
    limit = limit or PART_BYTES
    groups, cur, size = [], [], 0
    for s in out.get("sessions", []):
        n = len(json.dumps(s, ensure_ascii=False).encode("utf-8"))
        if cur and size + n > limit:
            groups.append(cur)
            cur, size = [], 0
        cur.append(s)
        size += n
    groups.append(cur)
    docs = [dict(out, sessions=groups[0])]
    for g in groups[1:]:
        docs.append({"version": out.get("version"), "device": out.get("device"), "os": out.get("os"),
                     "home": out.get("home"), "sessions": g})
    return docs


def push():
    try:
        conf = json.load(open(CONF))
    except (OSError, ValueError):
        print("This computer is not paired yet. Run the join command from the setup page.")
        return 2
    cloud = conf.get("mode") == "cloud"
    if cloud and not conf.get("token"):
        st = poll_once(conf) if conf.get("pending_id") else "gone"
        if st in ("pending", "error"):
            print("Waiting for approval. In Thoth on your main Mac: the join request at the top of the sidebar, or File > Set Up Devices… Choose Approve there.")
            return 0
        if st == "ignored":
            print("The owner chose Ignore, so this computer does not send sessions.")
            return 4
        conf = load() or conf   # approved just now, or the waiting join command got the token first
        if st == "gone" and not conf.get("token"):
            print("The brain no longer knows this request. Run the join command again.")
            return 5
    here = machine()
    if conf.get("token") and here and conf.get("machine") and conf["machine"] != here:
        return copied(conf, "the machine id is different")
    if conf.get("token") and here and not conf.get("machine"):
        conf["machine"] = here    # a file from before machine ids: this computer adopts it
        save(conf)
    if not cloud and not reach_hub(conf):
        return 1
    import collector
    if cloud:
        collector.STATE_DIR = os.path.dirname(CONF)
        collector.STATE_FILE = cloud_state_file()
    url = conf["hub"] + ("/api/ingest" if cloud else "/api/device/push")

    def send(out):
        """Send one collector document in parts of a few MB (the dialogue of every session is large).
        Stops at the first part that fails. Returns the last (status, answer)."""
        out["device"] = conf["device"]
        status, j = 0, {}
        for part in parts(out):
            status, j = post(url, {"doc": part}, conf["token"], timeout=300)
            if status != 200:
                break
        return status, j

    # The dialogue of every session goes only to a brain that said it keeps dialogues (its last answer).
    out, new_state = collector.collect(dialogue_too=bool(conf.get("dialogue")))
    status, j = send(out)
    if status == 200 and j.get("sessions") == 0 and not out.get("sessions") and new_state:
        # The brain has nothing from this computer, but this computer remembers that it sent its
        # sessions: the brain is new, or the owner removed this computer and added it again.
        # Send everything once.
        out, new_state = collector.collect(all_sessions=True, dialogue_too=bool(conf.get("dialogue")))
        status, j = send(out)
    if status == 200:
        collector.save_state(new_state)
        if bool(j.get("dialogue")) != bool(conf.get("dialogue")):
            # the brain was updated (or replaced by an older one): the next run sends every session again
            conf["dialogue"] = bool(j.get("dialogue"))
            save(conf)
        print(f"Sent {len(out.get('sessions', []))} new or changed sessions; the brain has {j.get('sessions', '?')} from this device.")
        return 0
    if status == 409 and cloud:
        return copied(conf, "the brain says another computer pushes with this token")
    if status in (401, 403):
        print(f"The brain refused this device ({j.get('error') or status}). It may have been revoked: pair again from the setup page.")
        return 3
    print(f"Push failed: {j.get('error') or f'status {status}'}. It will try again on the next run.")
    return 1


def main(argv):
    if len(argv) >= 2 and argv[0] == "join":
        name, rest, i, wait = "", [], 2, True
        while i < len(argv):
            if argv[i] == "--no-wait":
                wait, i = False, i + 1
                continue
            if argv[i] == "--name" and i + 1 < len(argv):
                name, i = argv[i + 1], i + 2
                continue
            rest.append(argv[i])
            i += 1
        return join(argv[1], rest[0] if rest else "", name, wait)
    if argv[:1] == ["wait"]:
        return wait_approval()
    if argv[:1] == ["push"]:
        return push()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
