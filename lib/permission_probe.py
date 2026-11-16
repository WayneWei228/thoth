# Prints the macOS permission state of the app that macOS charges this process to (its
# "responsible" app), as one JSON line. lib/permissions.js runs it inside the panel's tmux server,
# so the answer is what Claude sessions in Thoth get. Both calls only read; they never prompt.
import ctypes, json

def main():
    ax = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
    ax.AXIsProcessTrusted.restype = ctypes.c_bool
    cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cg.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
    out = {'accessibility': 'granted' if ax.AXIsProcessTrusted() else 'denied',
           'screen_recording': 'granted' if cg.CGPreflightScreenCaptureAccess() else 'denied', 'responsible': ''}
    try:   # private libsystem call; without it the page falls back to ~/Applications/Thoth.app
        libc = ctypes.CDLL(None)
        resp = libc.responsibility_get_pid_responsible_for_pid
        resp.restype, resp.argtypes = ctypes.c_int, [ctypes.c_int]
        import os
        buf = ctypes.create_string_buffer(4096)
        if ctypes.CDLL('/usr/lib/libproc.dylib').proc_pidpath(resp(os.getpid()), buf, 4096) > 0:
            out['responsible'] = buf.value.decode('utf-8', 'replace')
    except Exception:
        pass
    print(json.dumps(out))

main()
