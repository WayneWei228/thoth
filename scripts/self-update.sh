#!/bin/bash
# Replace this Thoth copy with an update bundle from the owner's main Mac, then restart the server.
# Started detached by the server (lib/self_update.ts startInstall) after it checked who sent the
# bundle, its SHA-256 and its file list. Never run by hand.
#
#   self-update.sh <root> <bundle.tgz> <status file> <update id> <commit> <commit time> <service> <node> <server pid>
#
# 1. unpack into <root>.thoth-new (next to the copy), write BUILD;
# 2. move node_modules (and the Mac app's build cache) over, so npm install takes seconds;
# 3. swap: <root> -> <root>.thoth-old, the new copy -> <root>; npm install; on a failure the old copy
#    goes back and the server keeps running unchanged;
# 4. restart: the launchd job that runs the server (and its brain job, when there is one); on Linux
#    (WSL too) the systemd user unit of scripts/services.sh (<service> ends in .service; and its brain
#    unit); or else stop the server and start it again with the same environment.
#    tmux (the Claude sessions) is not stopped: launchd's job and the unit's KillMode=process stop only
#    the server process.
# The status file (<state>/update.json) says how far it got; the new server marks it done when it
# runs the new commit (lib/self_update.ts settleAfterStart). <root>.thoth-old stays until the next update.
set -u
umask 077   # update.json, update.log and the temp files stay private
ROOT="$1" BUNDLE="$2" STATUS="$3" ID="$4" COMMIT="$5" TIME="$6" LABEL="$7" NODE="$8" SPID="$9"
NEW="$ROOT.thoth-new"
OLD="$ROOT.thoth-old"
log() { printf '%s self-update %s: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$ID" "$*"; }
status() {  # state, error
  local e
  e=$(printf '%s' "${2:-}" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-300)
  printf '{"id":"%s","state":"%s","error":"%s","commit":"%s"}\n' "$ID" "$1" "$e" "$COMMIT" >"$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}
fail() { log "failed: $1"; status failed "$1"; rm -rf "$NEW"; rm -f "$BUNDLE"; exit 1; }

log "from $(cat "$ROOT/BUILD" 2>/dev/null | cut -c1-12) to ${COMMIT:0:12} in $ROOT (service: ${LABEL:-none})"
status installing
[ -d "$ROOT/.git" ] && fail "this copy is a git checkout"
# one run at a time (the server also refuses a second request while one runs). The lock holds the
# pid of its run: a lock whose run is gone (power loss, kill -9, reboot) is taken over.
LOCK="$ROOT.thoth-lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    log "another update runs (pid $holder)"; status failed "another update runs"; rm -f "$BUNDLE"; exit 1
  fi
  log "an old lock (pid ${holder:-none} is gone): taken over"
  rm -rf "$LOCK" && mkdir "$LOCK" || { status failed "cannot take the update lock"; rm -f "$BUNDLE"; exit 1; }
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
rm -rf "$NEW" "$OLD" && mkdir "$NEW" || fail "cannot write next to $ROOT"
# the same tar that checked the file list (lib/self_update.ts, server.ts handlePeerUpdate)
/usr/bin/tar -xzf "$BUNDLE" -C "$NEW" --strip-components 1 --no-same-owner || fail "the bundle did not unpack"
rm -f "$BUNDLE"
[ -f "$NEW/server.ts" ] && [ -f "$NEW/scripts/self-update.sh" ] || fail "the bundle is not a Thoth copy"
printf '%s %s\n' "$COMMIT" "$TIME" >"$NEW/BUILD" || fail "cannot write BUILD"

# the packages and the build cache are copied over (APFS clones: fast, no extra space); the old copy
# keeps its own, so npm in the new copy never changes the packages of the copy that runs
# (Linux: --reflink=auto, a clone where the file system has them; GNU cp -c means something else)
if [ "$(uname -s)" = Darwin ]; then CLONE=(-Rc); else CLONE=(-R --reflink=auto); fi
copy() { cp "${CLONE[@]}" "$1" "$2" 2>/dev/null || { rm -rf "$2"; cp -R "$1" "$2"; }; }
[ -d "$ROOT/node_modules" ] && { copy "$ROOT/node_modules" "$NEW/node_modules" || fail "cannot copy node_modules"; }
[ -d "$ROOT/macos/.build" ] && mkdir -p "$NEW/macos" && copy "$ROOT/macos/.build" "$NEW/macos/.build"
back() {  # the old copy back in place, unchanged; the running server never noticed
  rm -rf "$ROOT" && mv "$OLD" "$ROOT"
}
mv "$ROOT" "$OLD" || fail "cannot move $ROOT"
mv "$NEW" "$ROOT" || { mv "$OLD" "$ROOT"; fail "cannot put the new copy in place"; }
log "new copy in place; npm install"

NODE_DIR="$(dirname "$NODE")"
export PATH="$NODE_DIR:$PATH"
NPM="$NODE_DIR/npm"
[ -x "$NPM" ] || NPM="npm"
if ! (cd "$ROOT" && "$NPM" install --no-audit --no-fund --loglevel=error </dev/null); then
  back
  fail "npm install failed: the old copy is back"
fi

status restarting
if [[ "$LABEL" == *.service ]]; then
  # systemd user units (Linux, WSL): systemctl needs the user manager's runtime folder and bus
  [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ] && export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/bus" ] && export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  BRAIN="${LABEL/claude-panel-server/claude-panel-brain}"
  if systemctl --user is-active --quiet "$BRAIN"; then
    log "restarting $BRAIN"
    systemctl --user restart "$BRAIN" || log "the brain unit did not restart"
  fi
  log "restarting $LABEL"
  systemctl --user restart "$LABEL" || fail "systemctl could not restart $LABEL: the new copy is installed and starts at the next restart of the unit"
elif [ -n "$LABEL" ]; then
  DOM="gui/$(id -u)"
  BRAIN="${LABEL/com.claudepanel.server/com.claudepanel.brain}"
  if launchctl print "$DOM/$BRAIN" >/dev/null 2>&1; then
    log "restarting $BRAIN"
    launchctl kickstart -k "$DOM/$BRAIN" || log "the brain job did not restart"
  fi
  log "restarting $LABEL"
  launchctl kickstart -k "$DOM/$LABEL" || fail "launchctl could not restart $LABEL"
else
  # no launchd job: stop this server (poll for its exit, at most 5 s), start the new one the same
  # way bin/thoth does, with the environment the old one had
  log "restarting the server (pid $SPID)"
  # only that pid while it is still a Thoth server (a pid can be reused after a long npm install)
  ps -p "$SPID" -o command= 2>/dev/null | grep -q 'server\.ts' || SPID=""
  [ -n "$SPID" ] && kill "$SPID" 2>/dev/null
  if [ -n "$SPID" ]; then
    for _ in $(seq 1 50); do kill -0 "$SPID" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$SPID" 2>/dev/null && kill -9 "$SPID" 2>/dev/null
  fi
  (cd "$ROOT" && trap '' HUP && exec "$NODE" "$ROOT/server.ts" >>"$(dirname "$STATUS")/server.log" 2>&1 </dev/null &) >/dev/null 2>&1 </dev/null
fi
log "done; the new server confirms the commit"
