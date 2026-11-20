// Prints the macOS permission state of the app that macOS charges this process to (its
// "responsible" app), as one JSON line. Run with `osascript -l JavaScript -e PROBE_JXA` (JXA).
// lib/permissions.ts runs it inside the panel's tmux server, so the answer is what Claude sessions
// in Thoth get.
// osascript is a plain binary, so it gets the app of the process that started it. A python3 does
// not: Homebrew's and Apple's python3 run inside their own Python.app, and macOS then charges
// Python, not the session's app. Both calls only read; they never prompt.
//
// The probe is JXA source for osascript (not code that Node runs), so it is kept as text here.
// osascript prints the value of the last expression.
export const PROBE_JXA = String.raw`ObjC.import('AppKit');
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('getpid', ['int', []]);
function responsible() {
  try {   // private libsystem call; no app above this process: it is its own responsible process
    ObjC.bindFunction('responsibility_get_pid_responsible_for_pid', ['int', ['int']]);
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier($.responsibility_get_pid_responsible_for_pid($.getpid()));
    return app.isNil() || app.bundleURL.isNil() ? '' : ObjC.unwrap(app.bundleURL.path);
  } catch (e) { return ''; }
}
JSON.stringify({ accessibility: $.AXIsProcessTrusted() ? 'granted' : 'denied',
  screen_recording: $.CGPreflightScreenCaptureAccess() ? 'granted' : 'denied', responsible: responsible() });
`;

/** The command (program and arguments) that runs the probe. */
export function probeCommand(): string[] {
  return ['/usr/bin/osascript', '-l', 'JavaScript', '-e', PROBE_JXA];
}
