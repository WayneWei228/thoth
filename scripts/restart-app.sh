#!/bin/bash
# Restart the Thoth app when it is running, so it uses the build that was just installed.
#   scripts/restart-app.sh [app path] [bundle id]   (defaults: ~/Applications/Thoth.app, com.claudepanel.app)
# Called by scripts/install.sh after macos/build-app.sh. A running app is old code; left running, it
# could start its old server again (found on a helper Mac, 2026-11-19).
#   - the running app is the one at [app path] (now replaced on disk): quit it and open it again;
#   - a Thoth app from another place is running (an old copy, or the user's own app while an install
#     eval uses a temp HOME): it is not touched, only named, so the person can quit it.
# The quit is asked of the app (it saves its state); the wait for it to end polls every 0.2 s, at most 5 s.
set -u
APP="${1:-$HOME/Applications/Thoth.app}"
ID="${2:-com.claudepanel.app}"
case "$ID" in *[!A-Za-z0-9.-]*|'') echo "restart-app: bad bundle id" >&2; exit 2 ;; esac
# the bundle path of the running app with this id, or nothing (lsappinfo needs no permission)
running_path() { lsappinfo info -only bundlepath "$ID" 2>/dev/null | sed -n 's/.*bundle path="\(.*\)".*/\1/p' | head -1; }
real() { (cd -P "$1" 2>/dev/null && pwd) || echo "$1"; }
now="$(running_path)"
[ -n "$now" ] || exit 0
if [ "$(real "$now")" != "$(real "$APP")" ]; then
  echo "Note: a Thoth app from $now is running. It is old code: quit it, then open $APP"
  exit 0
fi
osascript -e 'on run a' -e 'tell application id (item 1 of a) to quit' -e 'end run' "$ID" >/dev/null 2>&1
for _ in $(seq 1 25); do [ -n "$(running_path)" ] || break; sleep 0.2; done
if [ -n "$(running_path)" ]; then
  echo "Note: the Thoth app did not quit in 5 s and still runs old code: quit it, then open $APP"
  exit 0
fi
open "$APP" && echo "Restarted the Thoth app, so it runs the new build."
