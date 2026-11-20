"""Device events for the owner's main panel over a WebSocket (GET /api/events, owner token).

The main Mac is behind a router, so the brain cannot connect to it: the panel keeps one outbound
WebSocket here, and the brain pushes {"type": "devices", "devices": [...]} (the GET /api/devices list)
at once on connect and whenever a computer asks to join or a request is decided. A ping every PING_S
keeps proxies from closing an idle connection; a connection with no frame from the panel for
IDLE_S is closed. Only what RFC 6455 needs for this: text, ping, pong, close; no extensions.
"""
import base64
import hashlib
import json
import queue
import socket
import struct
import threading
import time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TEXT, CLOSE, PING, PONG = 0x1, 0x8, 0x9, 0xA
MAX_CLIENT_FRAME = 4096        # the panel sends only pongs and close frames
PING_S = 25
CHECK_S = 25                  # the token is checked again this often (a rotated token loses the stream)
IDLE_S = 75


def accept_key(key):
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


def frame(op, data=b""):
    """A server frame (never masked)."""
    n = len(data)
    if n < 126:
        head = struct.pack("!BB", 0x80 | op, n)
    elif n < 1 << 16:
        head = struct.pack("!BBH", 0x80 | op, 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | op, 127, n)
    return head + data


def _exact(r, n):
    out = b""
    while len(out) < n:
        chunk = r.read(n - len(out))
        if not chunk:
            raise EOFError("connection closed")
        out += chunk
    return out


def read_frame(r, client=False):
    """(opcode, payload) of the next frame; a masked frame is unmasked. client=True (the server reading
    the panel): a frame must be masked (RFC 6455) and at most MAX_CLIENT_FRAME bytes.
    Raises EOFError or ValueError."""
    b0, b1 = _exact(r, 2)
    op, n = b0 & 0x0F, b1 & 0x7F
    if client and not b1 & 0x80:
        raise ValueError("unmasked client frame")
    if n == 126:
        n = struct.unpack("!H", _exact(r, 2))[0]
    elif n == 127:
        n = struct.unpack("!Q", _exact(r, 8))[0]
    if n > (MAX_CLIENT_FRAME if client else 1 << 24):
        raise ValueError("frame too large")
    mask = _exact(r, 4) if b1 & 0x80 else None
    data = _exact(r, n)
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return op, data


class Pinger:
    """A ping every `every` seconds by the clock, also while messages keep coming (the panel answers
    pings only; without them the read deadline would close a busy, healthy connection)."""

    def __init__(self, every=PING_S, now=time.monotonic):
        self.every, self.now = every, now
        self.last = now()

    def due(self):
        return self.now() - self.last >= self.every

    def sent(self):
        self.last = self.now()


class Hub:
    """The open event connections; publish() gives each one the message."""

    def __init__(self, limit=16):
        self.limit = limit
        self.lock = threading.Lock()
        self.queues = set()

    def join(self):
        with self.lock:
            if len(self.queues) >= self.limit:
                return None
            q = queue.Queue(maxsize=64)
            self.queues.add(q)
            return q

    def leave(self, q):
        with self.lock:
            self.queues.discard(q)

    def publish(self, msg):
        with self.lock:
            qs = list(self.queues)
        for q in qs:
            try:
                q.put_nowait(msg)
            except queue.Full:   # a stuck connection: it gets the next message after it drains
                pass


def serve(handler, hub, first, still_ok=None):
    """Run one event connection on a BaseHTTPRequestHandler after the auth check. `first` is the message
    sent at once (the current list). `still_ok()` is asked every CHECK_S: False (the owner token was
    rotated) closes the connection. Returns when the panel goes away."""
    key = handler.headers.get("Sec-WebSocket-Key") or ""
    q = hub.join()
    if q is None:
        handler.send(503, {"error": "too many event connections"})
        return
    try:
        handler.protocol_version = "HTTP/1.1"   # clients expect "HTTP/1.1 101"
        handler.send_response(101)
        handler.send_header("Upgrade", "websocket")
        handler.send_header("Connection", "Upgrade")
        handler.send_header("Sec-WebSocket-Accept", accept_key(key))
        handler.end_headers()
        handler.wfile.flush()
        handler.close_connection = True
        sock = handler.connection
        sock.settimeout(IDLE_S)
        gone = threading.Event()
        send_lock = threading.Lock()

        def send(op, data=b""):
            with send_lock:
                sock.sendall(frame(op, data))

        def reader():
            try:
                while not gone.is_set():
                    op, data = read_frame(handler.rfile, client=True)
                    if op == CLOSE:
                        break
                    if op == PING:
                        send(PONG, data)
            except (EOFError, ValueError, OSError, socket.timeout):
                pass
            gone.set()
            try:
                q.put_nowait(None)
            except queue.Full:
                pass   # the writer sees `gone` at its next ping

        threading.Thread(target=reader, daemon=True).start()
        send(TEXT, json.dumps(first).encode())
        pinger = Pinger()
        checker = Pinger(every=CHECK_S)
        while not gone.is_set():
            if still_ok is not None and checker.due():
                if not still_ok():
                    break
                checker.sent()
            if pinger.due():
                send(PING)
                pinger.sent()
            left = min(PING_S - (pinger.now() - pinger.last), CHECK_S - (checker.now() - checker.last))
            try:
                msg = q.get(timeout=max(0.05, left))
            except queue.Empty:
                continue
            if msg is None:
                break
            send(TEXT, json.dumps(msg).encode())
        try:
            send(CLOSE)
        except OSError:
            pass
    except OSError:
        pass
    finally:
        hub.leave(q)
