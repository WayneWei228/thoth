#!/bin/bash
# Keep the panel server (7878) and the brain (7879) running after logout and reboot, and
# diagnose common faults. Called by `thoth services ...` and `thoth doctor`.
#
#   services.sh install [--dry-run]   Linux: systemd --user units + linger. macOS: launchd agents.
#   services.sh uninstall [--dry-run]
#   services.sh status
#   services.sh ctl start|stop|restart server|brain   (used by thoth when services are installed)
#   services.sh installed             exit 0 when the service files exist
#   services.sh doctor [--fix]        explain faults with cause + exact fix; exit 0 when all good
#
# Test settings: CC_SERVICES_DIR (write the unit/plist files there, touch nothing else),
# CC_SERVICES_OS=Linux|Darwin (pretend), --dry-run (same as CC_SERVICES_DIR with a temp folder).
#
# Test only (macOS): CC_SERVICES_TEST_SUFFIX=<suffix> runs a second, separate pair of launchd jobs
# next to the real ones. The labels become com.claudepanel.server.<suffix> and
# com.claudepanel.brain.<suffix> (the plist names too), and the plists get this shell's HOME,
# CC_PANEL_PORT, CC_PANEL_HOME, CC_BRAIN_PORT, CC_BRAIN_DIR and, when set, CC_PANEL_TMUX_SOCKET,
# CC_PANEL_NO_CLOUD_PUSH. The ports must not be 7878/7879. What this bypasses: the real labels,
# the HOME that launchd gives a job (so with a temp HOME the plists are not in the real
# ~/Library/LaunchAgents), the default ports and state folders, and the removal of the old
# brain agent of earlier versions (LEGACY_MAC_LABEL). All other code (plist text, bootstrap, ctl, status, doctor) is the same.
set -u
APP_DIR="${CC_PANEL_DIR:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}"
PORT="${CC_PANEL_PORT:-7878}"
BPORT="${CC_BRAIN_PORT:-7879}"
OS="${CC_SERVICES_OS:-$(uname -s)}"
SHARE="$HOME/.local/share/claude-panel"
STATE="${CC_PANEL_HOME:-$HOME/.config/cc-panel}"
BRAIN_HOME="${CC_BRAIN_DIR:-$HOME/.config/cc-brain}"
UID_N="$(id -u)"
MAC_LABELS=(com.claudepanel.server com.claudepanel.brain)
TEST_SUFFIX="${CC_SERVICES_TEST_SUFFIX:-}"
if [ -n "$TEST_SUFFIX" ]; then
  case "$TEST_SUFFIX" in *[!A-Za-z0-9_-]*) echo "bad CC_SERVICES_TEST_SUFFIX" >&2; exit 1 ;; esac
  if [ "$PORT" = 7878 ] || [ "$BPORT" = 7879 ]; then echo "CC_SERVICES_TEST_SUFFIX needs CC_PANEL_PORT and CC_BRAIN_PORT other than 7878/7879" >&2; exit 1; fi
  MAC_LABELS=("com.claudepanel.server.$TEST_SUFFIX" "com.claudepanel.brain.$TEST_SUFFIX")
fi
LEGACY_MAC_LABEL="${THOTH_LEGACY_MAC_LABEL:-}"   # the label of a brain agent of an older install on this Mac (it held a person's name); empty: none
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AGENT_DIR="$HOME/Library/LaunchAgents"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# ---- helpers -------------------------------------------------------------------------------
find_node() {  # the installer's private Node first, then the system one; only Node >= 22
  local c
  for c in "$SHARE/node/bin/node" "$(command -v node 2>/dev/null)"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    [ "$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ] 2>/dev/null && { echo "$c"; return 0; }
  done
  [ -x "$SHARE/node/bin/node" ] && { echo "$SHARE/node/bin/node"; return 0; }
  command -v node 2>/dev/null
}
listener_pid() {  # pid listening on a tcp port (lsof, or ss on machines without lsof)
  local p
  p=$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "$p" ] && { echo "$p"; return 0; }
  command -v ss >/dev/null 2>&1 && ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1
}
port_taken() { [ -n "$(listener_pid "$1")" ] || { command -v ss >/dev/null 2>&1 && [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]; }; }
proc_name() { ps -o args= -p "$1" 2>/dev/null | cut -c1-80; }
server_up() { curl -sf --max-time 2 "http://127.0.0.1:$PORT/api/state" 2>/dev/null | python3 -I -c 'import json,sys;json.load(sys.stdin)' >/dev/null 2>&1; }
brain_up() { curl -sf --max-time 2 "http://127.0.0.1:$BPORT/api/health" 2>/dev/null | grep -q '"ok"'; }
wait_for() { local i; for i in $(seq 1 "${2:-40}"); do "$1" && return 0; sleep 0.5; done; return 1; }
sysd() {
  [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$UID_N" ] && export XDG_RUNTIME_DIR="/run/user/$UID_N"
  [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/bus" ] && export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  systemctl --user "$@"
}
have_systemd_user() { command -v systemctl >/dev/null 2>&1 && sysd show-environment >/dev/null 2>&1; }
dom() { echo "gui/$UID_N"; }
# launchctl bootout returns before launchd has unloaded the job. A bootstrap straight after it can
# fail, and "uninstall" would report done while the job is still there (both seen on a loaded Mac,
# a test run). So: boot out, then wait (at most 15 s) until the job is gone.
mac_bootout() {  # label
  local i
  launchctl bootout "$(dom)/$1" 2>/dev/null
  for i in $(seq 1 75); do launchctl print "$(dom)/$1" >/dev/null 2>&1 || return 0; sleep 0.2; done
  return 0
}

NODE_BIN="$(find_node)"
PY_BIN="$(command -v python3 || true)"

# ---- unit / plist text ---------------------------------------------------------------------
server_path() { echo "$(dirname "${NODE_BIN:-/usr/bin/node}"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"; }
brain_path() { echo "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"; }

write_unit() {  # file, description, path, exec..., log
  local file="$1" desc="$2" path="$3" log="$4"; shift 4
  local exec="" a
  for a in "$@"; do exec="$exec \"$a\""; done
  cat > "$file" <<UNIT
[Unit]
Description=$desc
After=network.target

[Service]
WorkingDirectory=$APP_DIR
Environment="PATH=$path"
ExecStart=${exec# }
Restart=always
RestartSec=3
# Stop only the main process. The server starts tmux, and tmux (your Claude sessions)
# must survive a restart of the server.
KillMode=process
StandardOutput=append:$log
StandardError=append:$log

[Install]
WantedBy=default.target
UNIT
}

write_plist() {  # file, label, path, log, program args...
  local file="$1" label="$2" path="$3" log="$4"; shift 4
  {
    cat <<HEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
HEAD
    local a; for a in "$@"; do printf '    <string>%s</string>\n' "$(printf '%s' "$a" | sed 's/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g')"; done
    cat <<TAIL
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$path</string>
$(test_env)
  </dict>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
TAIL
  } > "$file"
}

test_env() {  # test only (CC_SERVICES_TEST_SUFFIX): the isolated ports, folders and HOME for the job
  [ -n "$TEST_SUFFIX" ] || return 0
  local k v
  for k in HOME CC_PANEL_PORT CC_PANEL_HOME CC_BRAIN_PORT CC_BRAIN_DIR CC_PANEL_TMUX_SOCKET CC_PANEL_NO_CLOUD_PUSH; do
    case "$k" in CC_PANEL_PORT) v="$PORT" ;; CC_PANEL_HOME) v="$STATE" ;; CC_BRAIN_PORT) v="$BPORT" ;; CC_BRAIN_DIR) v="$BRAIN_HOME" ;; *) eval "v=\${$k:-}" ;; esac
    [ -n "$v" ] && printf '    <key>%s</key><string>%s</string>\n' "$k" "$v"
  done
}

ensure_brain_devices() {
  [ -f "$BRAIN_HOME/devices.json" ] && return 0
  mkdir -p "$BRAIN_HOME"
  printf '[ {"name": "%s", "transport": "local"} ]\n' "$(hostname -s | tr '[:upper:]' '[:lower:]')" > "$BRAIN_HOME/devices.json"
}

# only stop a server or brain that WE started by hand; never another program
stop_manual() {  # port, pattern
  local p; p=$(listener_pid "$1")
  [ -n "$p" ] && ps -o args= -p "$p" 2>/dev/null | grep -q "$2" && kill "$p" 2>/dev/null
  return 0
}

# ---- install / uninstall -------------------------------------------------------------------
install_linux() {
  local dry="$1" dir="$UNIT_DIR"
  [ -n "${CC_SERVICES_DIR:-}" ] && dir="$CC_SERVICES_DIR"
  if [ -z "$dry" ] && ! have_systemd_user; then
    say "This machine has no systemd user session, so the panel cannot start by itself at boot."
    say "What you can do:"
    say "  - start it by hand after each boot:   thoth web   and   python3 $APP_DIR/brain/brain.py serve"
    say "  - or add them to cron:   (crontab -l; echo '@reboot $HOME/.local/bin/thoth web') | crontab -"
    say "  - or on Ubuntu/Debian/Fedora: make sure 'systemd' and 'dbus-user-session' are installed, log in again, retry."
    exit 2
  fi
  [ -n "$NODE_BIN" ] && [ -n "$PY_BIN" ] || die "Node.js 22 or python3 is missing. Run: $APP_DIR/scripts/install.sh"
  mkdir -p "$dir"
  [ -z "$dry" ] && { mkdir -p "$STATE" "$BRAIN_HOME"; ensure_brain_devices; }
  write_unit "$dir/claude-panel-server.service" "Thoth server" "$(server_path)" "$STATE/server.log" "$NODE_BIN" "$APP_DIR/server.ts"
  write_unit "$dir/claude-panel-brain.service" "Thoth brain" "$(brain_path)" "$BRAIN_HOME/brain.log" "$PY_BIN" -I "$APP_DIR/brain/brain.py" serve
  say "Wrote claude-panel-server.service and claude-panel-brain.service in $dir"
  [ -n "$dry" ] && { say "(dry run: nothing was started or enabled)"; return 0; }
  # a server or brain started by hand holds the ports; hand them over to the services
  stop_manual "$PORT" "server\.[jt]s"; stop_manual "$BPORT" "brain.py"; sleep 1
  sysd daemon-reload || die "systemctl --user daemon-reload failed."
  sysd enable --now claude-panel-server.service claude-panel-brain.service 2>&1 | sed 's/^/  /'
  # linger: user services start at boot and keep running after logout
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
    loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER" 2>/dev/null || true
  fi
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ]; then
    say "Linger is on: the services start at boot and keep running after you log out."
  else
    say "The services run while you are logged in. To keep them after logout and to start them at boot, run:"
    say "    sudo loginctl enable-linger $USER"
  fi
  if wait_for server_up 60 && wait_for brain_up 60; then
    say "Server answers on http://127.0.0.1:$PORT and brain on http://127.0.0.1:$BPORT."
  else
    say "A service does not answer yet. Run: thoth doctor"; exit 1
  fi
}

uninstall_linux() {
  local dry="$1" dir="$UNIT_DIR"
  [ -n "${CC_SERVICES_DIR:-}" ] && dir="$CC_SERVICES_DIR"
  if [ -z "$dry" ] && have_systemd_user; then
    sysd disable --now claude-panel-server.service claude-panel-brain.service 2>/dev/null
  fi
  rm -f "$dir/claude-panel-server.service" "$dir/claude-panel-brain.service"
  [ -z "$dry" ] && have_systemd_user && sysd daemon-reload 2>/dev/null
  say "Services removed. (Linger is left as it is. Turn it off with: sudo loginctl disable-linger $USER)"
}

install_mac() {
  local dry="$1" dir="$AGENT_DIR"
  [ -n "${CC_SERVICES_DIR:-}" ] && dir="$CC_SERVICES_DIR"
  [ -n "$NODE_BIN" ] && [ -n "$PY_BIN" ] || die "Node.js 22 or python3 is missing. Run: $APP_DIR/scripts/install.sh"
  mkdir -p "$dir"
  [ -z "$dry" ] && { mkdir -p "$STATE" "$BRAIN_HOME"; ensure_brain_devices; }
  write_plist "$dir/${MAC_LABELS[0]}.plist" "${MAC_LABELS[0]}" "$(server_path)" "$STATE/server.log" "$NODE_BIN" "$APP_DIR/server.ts"
  write_plist "$dir/${MAC_LABELS[1]}.plist" "${MAC_LABELS[1]}" "$(brain_path)" "$BRAIN_HOME/brain.log" "$PY_BIN" -I "$APP_DIR/brain/brain.py" serve
  local l
  if command -v plutil >/dev/null 2>&1; then
    for l in "${MAC_LABELS[@]}"; do plutil -lint "$dir/$l.plist" >/dev/null || die "Generated $l.plist is not valid."; done
  fi
  say "Wrote ${MAC_LABELS[0]}.plist and ${MAC_LABELS[1]}.plist in $dir"
  [ -n "$dry" ] && { say "(dry run: nothing was loaded)"; return 0; }
  # the old brain agent of earlier versions (name tied to one person) is replaced
  if [ -z "$TEST_SUFFIX" ] && [ -n "$LEGACY_MAC_LABEL" ] && [ -f "$AGENT_DIR/$LEGACY_MAC_LABEL.plist" ]; then
    launchctl bootout "$(dom)/$LEGACY_MAC_LABEL" 2>/dev/null; rm -f "$AGENT_DIR/$LEGACY_MAC_LABEL.plist"
    say "Replaced the old agent $LEGACY_MAC_LABEL."
  fi
  stop_manual "$PORT" "server\.[jt]s"; stop_manual "$BPORT" "brain.py"; sleep 1
  for l in "${MAC_LABELS[@]}"; do
    mac_bootout "$l"
    launchctl bootstrap "$(dom)" "$dir/$l.plist" || die "launchctl could not load $l. Run: thoth doctor"
  done
  if wait_for server_up 60 && wait_for brain_up 60; then
    say "Server answers on http://127.0.0.1:$PORT and brain on http://127.0.0.1:$BPORT. They start at login."
  else
    say "A service does not answer yet. Run: thoth doctor"; exit 1
  fi
}

uninstall_mac() {
  local dry="$1" dir="$AGENT_DIR" l
  [ -n "${CC_SERVICES_DIR:-}" ] && dir="$CC_SERVICES_DIR"
  for l in "${MAC_LABELS[@]}"; do
    [ -z "$dry" ] && mac_bootout "$l"
    rm -f "$dir/$l.plist"
  done
  say "Services removed."
}

installed() {
  if [ "$OS" = Darwin ]; then [ -f "$AGENT_DIR/${MAC_LABELS[0]}.plist" ]; else [ -f "$UNIT_DIR/claude-panel-server.service" ]; fi
}

# ---- status / ctl --------------------------------------------------------------------------
status() {
  if ! installed; then say "services: not installed (thoth services install)"; fi
  if [ "$OS" = Darwin ]; then
    local l; for l in "${MAC_LABELS[@]}"; do
      if launchctl print "$(dom)/$l" >/dev/null 2>&1; then
        say "$l: loaded ($(launchctl print "$(dom)/$l" 2>/dev/null | awk -F' = ' '/^\tstate =/ {print $2; exit}'))"
      else say "$l: not loaded"; fi
    done
  elif have_systemd_user; then
    local u; for u in claude-panel-server claude-panel-brain; do
      say "$u: $(sysd is-enabled $u.service 2>/dev/null || echo not-installed), $(sysd is-active $u.service 2>/dev/null)"
    done
    say "linger: $(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)"
  fi
  server_up && say "server: answers on port $PORT" || say "server: no answer on port $PORT"
  brain_up && say "brain: answers on port $BPORT" || say "brain: no answer on port $BPORT"
}

unit_of() { case "$1" in server) echo claude-panel-server ;; brain) echo claude-panel-brain ;; *) die "unknown service: $1" ;; esac; }
label_of() { case "$1" in server) echo "${MAC_LABELS[0]}" ;; brain) echo "${MAC_LABELS[1]}" ;; *) die "unknown service: $1" ;; esac; }
ctl() {
  local act="$1" who="$2"
  installed || die "services are not installed"
  if [ "$OS" = Darwin ]; then
    local l; l=$(label_of "$who")
    case "$act" in
      stop) mac_bootout "$l" ;;
      start) launchctl print "$(dom)/$l" >/dev/null 2>&1 && launchctl kickstart "$(dom)/$l" || launchctl bootstrap "$(dom)" "$AGENT_DIR/$l.plist" ;;
      restart) if launchctl print "$(dom)/$l" >/dev/null 2>&1; then launchctl kickstart -k "$(dom)/$l"; else launchctl bootstrap "$(dom)" "$AGENT_DIR/$l.plist"; fi ;;
    esac
  else
    sysd reset-failed "$(unit_of "$who").service" 2>/dev/null
    sysd "$act" "$(unit_of "$who").service"
  fi
}

# ---- doctor --------------------------------------------------------------------------------
FIXES=()
BAD=0
ok() { printf '  ok    %s\n' "$*"; }
bad() {  # title, cause, fix [, autofix-function]
  BAD=$((BAD+1))
  printf '  FAIL  %s\n        Cause: %s\n        Fix:   %s\n' "$1" "$2" "$3"
  [ -n "${4:-}" ] && FIXES+=("$4")
  return 0
}
warn() { printf '  warn  %s\n        %s\n' "$1" "$2"; }

fix_server() {
  if installed; then ctl restart server; else
    ( cd "$APP_DIR" && trap '' HUP && exec "$NODE_BIN" "$APP_DIR/server.ts" >>"$STATE/server.log" 2>&1 </dev/null & ) >/dev/null 2>&1   # no nohup: see bin/thoth start_server
  fi
  wait_for server_up 40
}
fix_brain() {
  ensure_brain_devices
  if installed; then ctl restart brain; else
    ( cd "$APP_DIR" && trap '' HUP && exec "$PY_BIN" -I "$APP_DIR/brain/brain.py" serve >>"$BRAIN_HOME/brain.log" 2>&1 </dev/null & ) >/dev/null 2>&1
  fi
  wait_for brain_up 40
}
fix_linger() { loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER" 2>/dev/null; }

check_port() {  # name, port, upfn, fixfn, start-hint
  local name="$1" port="$2" upfn="$3" fixfn="$4" pid
  if "$upfn"; then ok "$name answers on port $port"; return; fi
  if port_taken "$port"; then
    pid=$(listener_pid "$port")
    bad "$name does not answer: port $port is used by another program${pid:+ (pid $pid: $(proc_name "$pid"))}" \
      "Another program holds port $port, so the $name cannot use it." \
      "Stop that program${pid:+ (kill $pid)}, then run: thoth doctor --fix. Or move the $name: set CC_PANEL_PORT / CC_BRAIN_PORT."
  elif installed; then
    bad "$name is not running" "The $name service is installed but nothing listens on port $port." \
      "thoth doctor --fix   (or: thoth services status, and read the log)" "$fixfn"
  else
    bad "$name is not running" "Nothing listens on port $port, and the services are not installed." \
      "thoth doctor --fix   (starts it now). To keep it running after reboot: thoth services install" "$fixfn"
  fi
}

claude_logged_in() {
  [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && return 0
  [ -s "$HOME/.claude/.credentials.json" ] && return 0
  [ -f "$HOME/.claude.json" ] && grep -q '"oauthAccount"' "$HOME/.claude.json" 2>/dev/null && return 0
  [ "$OS" = Darwin ] && security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 && return 0
  return 1
}

doctor_pass() {
  BAD=0; FIXES=()
  local v major minor
  # Node
  if [ -z "$NODE_BIN" ]; then
    bad "Node.js is missing" "The panel server needs Node.js 22.18 or newer." "$APP_DIR/scripts/install.sh   (downloads Node.js 22 for you)"
  else
    v=$("$NODE_BIN" --version 2>/dev/null); major=${v#v}; minor=${major#*.}; major=${major%%.*}; minor=${minor%%.*}
    # 22.18+: Node runs the panel's TypeScript files directly (type stripping)
    if [ "${major:-0}" -gt 22 ] 2>/dev/null || { [ "${major:-0}" -eq 22 ] && [ "${minor:-0}" -ge 18 ]; } 2>/dev/null; then ok "Node.js $v ($NODE_BIN)"
    else bad "Node.js $v is too old" "The panel server needs Node.js 22.18 or newer." "$APP_DIR/scripts/install.sh   (downloads Node.js 22 for you, no sudo)"; fi
  fi
  # tmux
  if command -v tmux >/dev/null 2>&1; then ok "tmux $(tmux -V 2>/dev/null | awk '{print $2}')"
  else
    local hint="brew install tmux"; [ "$OS" != Darwin ] && hint="sudo apt-get install -y tmux   (Debian/Ubuntu)   or   sudo dnf install -y tmux   (Fedora)"
    bad "tmux is missing" "Claude Code sessions run inside tmux; without it the panel cannot start or show sessions." "$hint"
  fi
  # python3
  if [ -n "$PY_BIN" ]; then ok "python3 ($PY_BIN)"; else bad "python3 is missing" "The brain is a Python program." "sudo apt-get install -y python3   (or: brew install python)"; fi
  # Claude Code
  if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
    if claude_logged_in; then ok "Claude Code is installed and logged in"
    else bad "Claude Code is not logged in" "No Claude login was found on this machine." "Run: claude   then type /login and follow the steps."; fi
  else
    bad "Claude Code is not installed" "The panel runs Claude Code sessions." "curl -fsSL https://claude.ai/install.sh | bash   then run: claude   and type /login"
  fi
  # server and brain
  check_port "panel server" "$PORT" server_up fix_server
  check_port "brain" "$BPORT" brain_up fix_brain
  # services
  if installed; then
    if [ "$OS" = Darwin ]; then
      local l st
      for l in "${MAC_LABELS[@]}"; do
        if ! launchctl print "$(dom)/$l" >/dev/null 2>&1; then
          bad "service $l is not loaded" "The plist exists but launchd has not loaded it." "thoth services install"
        else
          st=$(launchctl print "$(dom)/$l" 2>/dev/null | awk -F' = ' '/last exit code/ {print $2; exit}')
          if [ -n "$st" ] && [ "$st" != 0 ] && [ "$st" != "(never exited)" ] && ! { [ "$l" = "${MAC_LABELS[0]}" ] && server_up; } && ! { [ "$l" = "${MAC_LABELS[1]}" ] && brain_up; }; then
            bad "service $l failed (last exit code $st)" "The program stops right after it starts." "Read the log: tail -30 $STATE/server.log or $BRAIN_HOME/brain.log, then: thoth doctor --fix"
          else ok "service $l is loaded"; fi
        fi
      done
    elif have_systemd_user; then
      local u
      for u in claude-panel-server claude-panel-brain; do
        local lg="$STATE/server.log"; [ "$u" = claude-panel-brain ] && lg="$BRAIN_HOME/brain.log"
        local tailmsg; tailmsg=$(tail -n 2 "$lg" 2>/dev/null | tr '\n' '|' | cut -c1-200)
        local act; act=$(sysd is-active "$u.service" 2>/dev/null)
        if sysd is-failed --quiet "$u.service" || [ "$act" = activating ]; then
          bad "service $u keeps failing (state: $act)" "systemd starts it and it stops again. Last log lines ($lg): ${tailmsg:-none}" \
            "Fix what the log says (a busy port is the usual cause), then: thoth doctor --fix   (resets and restarts it)" "fix_$([ "$u" = claude-panel-server ] && echo server || echo brain)"
        elif [ "$(sysd is-enabled "$u.service" 2>/dev/null)" != enabled ]; then
          bad "service $u is not enabled" "It will not start at boot." "thoth services install"
        else ok "service $u is enabled ($(sysd is-active "$u.service" 2>/dev/null))"; fi
      done
      if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ]; then ok "linger is on (services survive logout and start at boot)"
      else bad "linger is off" "Without linger, user services stop at logout and do not start at boot." "sudo loginctl enable-linger $USER   (or: thoth doctor --fix)" fix_linger; fi
    else
      bad "systemd user session is not available" "The unit files exist but this shell cannot reach systemd --user." "Log in again (a full login, not su), or run: export XDG_RUNTIME_DIR=/run/user/$UID_N"
    fi
  fi
  # disk
  local use free
  use=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}'); free=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print int($4/1024)}')
  if [ -n "$use" ]; then
    if [ "$use" -ge 95 ] || [ "${free:-9999}" -lt 500 ]; then
      bad "disk is nearly full (${use}% used, ${free} MB free)" "The brain database, logs and Claude sessions need room to grow." "Free space: delete old files, or run: du -sh ~/.claude ~/.config/cc-brain ~/Downloads | sort -h"
    elif [ "$use" -ge 90 ]; then warn "disk is ${use}% used (${free} MB free)" "Free some space soon."
    else ok "disk has room (${use}% used, ${free} MB free)"; fi
  fi
}

doctor() {
  local fix=""; [ "${1:-}" = "--fix" ] && fix=1
  say "Thoth doctor"
  doctor_pass
  if [ -n "$fix" ] && [ ${#FIXES[@]} -gt 0 ]; then
    say ""; say "Fixing what is safe to fix..."
    local f seen=" "
    for f in "${FIXES[@]}"; do
      case "$seen" in *" $f "*) continue ;; esac; seen="$seen$f "
      if "$f"; then say "  fixed: $f"; else say "  not fixed: $f"; fi
    done
    say ""; say "Checking again..."
    doctor_pass
  fi
  say ""
  if [ "$BAD" = 0 ]; then say "All good."; exit 0; fi
  say "$BAD problem(s) found.${fix:+ The ones above are what --fix cannot repair.}${fix:-  Run: thoth doctor --fix   to repair what is safe.}"
  exit 1
}

# ---- main ----------------------------------------------------------------------------------
cmd="${1:-status}"; shift || true
dry=""
for a in "$@"; do [ "$a" = "--dry-run" ] && dry=1; done
if [ -n "$dry" ] && [ -z "${CC_SERVICES_DIR:-}" ]; then CC_SERVICES_DIR="$(mktemp -d)"; export CC_SERVICES_DIR; say "Dry run: files go to $CC_SERVICES_DIR"; fi
[ -n "${CC_SERVICES_DIR:-}" ] && dry=1
case "$cmd" in
  install) if [ "$OS" = Darwin ]; then install_mac "$dry"; else install_linux "$dry"; fi ;;
  uninstall) if [ "$OS" = Darwin ]; then uninstall_mac "$dry"; else uninstall_linux "$dry"; fi ;;
  status) status ;;
  installed) installed ;;
  ctl) ctl "${1:?start|stop|restart}" "${2:?server|brain}" ;;
  doctor) doctor "${1:-}" ;;
  *) say "usage: thoth services install|uninstall|status   (add --dry-run to only write the files to a temp folder)"; exit 1 ;;
esac
