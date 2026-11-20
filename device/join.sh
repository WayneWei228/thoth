#!/bin/sh
# Join this computer (macOS or Linux) to the user's brain. Served by the brain (a cloud brain, or
# the device listener of a brain computer on the same network):
# The setup page shows the exact one-line command (lib/devices.ts posixJoin: download to a new
# mktemp file, run it, remove it). Arguments:
#   --hub https://<cloud brain> [code] [name]     (a cloud brain)
#   <code> [name]                                 (a brain computer on the same network)
# A cloud brain without a code: this computer asks to join and waits for Approve on the owner's panel.
# Needs python3 and curl. Puts two files in ~/.cc-brain and pushes sessions every 5 minutes.
set -eu
HUB="__HUB__"
CODE=""; NAME=""; NEXT_HUB=""
# --hub: the brain's address when the file is served as it is (a static file on the cloud brain)
for a in "$@"; do
  if [ -n "$NEXT_HUB" ]; then HUB="$a"; NEXT_HUB=""
  elif [ "$a" = --hub ]; then NEXT_HUB=1
  elif [ -z "$CODE" ] && printf '%s' "$a" | grep -Eq '^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}(-[A-Za-z0-9]{2})?$'; then CODE="$a"
  elif [ -z "$NAME" ]; then NAME="$a"; fi
done
case "$HUB" in http://*|https://*) ;; *) echo "The brain's address is missing. Copy the whole command from the setup page again."; exit 2 ;; esac
case "$HUB" in https://*) ;; *) [ -n "$CODE" ] || { echo "Usage: sh join.sh <code> [name]   (the code is on the setup page)"; exit 2; } ;; esac
PY=$(command -v python3) || { echo "python3 is missing. Install it (macOS: xcode-select --install; Ubuntu: sudo apt-get install -y python3) and run the command again."; exit 1; }
# A Mac without the Command Line Tools has /usr/bin/python3, but it is a stub: it only asks to install them.
"$PY" -c 'import json, ssl, urllib.request' >/dev/null 2>&1 || { echo "python3 ($PY) is on this computer but does not run. Install it (macOS: xcode-select --install, wait until it is done; Ubuntu: sudo apt-get install -y python3) and run the command again."; exit 1; }
D="$HOME/.cc-brain"; mkdir -p "$D"
curl -fsSL "$HUB/device/collector.py" -o "$D/collector.py"
curl -fsSL "$HUB/device/device_agent.py" -o "$D/device_agent.py"
# The 5-minute schedule (launchd on a Mac, cron on Linux).
schedule() {
  if [ -z "${CC_DEVICE_NO_SCHEDULE:-}" ]; then
    if [ "$(uname -s)" = Darwin ]; then
      # Test only: CC_DEVICE_TEST_LABEL=<suffix> gives the job its own label and plist, and puts this
      # shell's HOME (and SSL_CERT_FILE, when set) into the job; CC_DEVICE_TEST_INTERVAL=<seconds> then
      # replaces the 5 minutes. So a test can run in a temp HOME next to a real agent. What this
      # bypasses: the real label, the HOME and certificates launchd gives the job, the 5-minute wait.
      L="com.claudepanel.device-agent"; EV=""; IV=300
      if [ -n "${CC_DEVICE_TEST_LABEL:-}" ]; then
        L="$L.$CC_DEVICE_TEST_LABEL"; IV="${CC_DEVICE_TEST_INTERVAL:-300}"
        EV="<key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string>${SSL_CERT_FILE:+<key>SSL_CERT_FILE</key><string>$SSL_CERT_FILE</string>}</dict>"
      fi
      P="$HOME/Library/LaunchAgents/$L.plist"; mkdir -p "$(dirname "$P")"
      cat > "$P" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>$L</string>
    <key>ProgramArguments</key><array><string>$PY</string><string>$D/device_agent.py</string><string>push</string></array>
    <key>StartInterval</key><integer>$IV</integer><key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>$D/device-agent.log</string><key>StandardErrorPath</key><string>$D/device-agent.log</string>
    $EV
</dict></plist>
PL
      launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true
      ERR=$(launchctl bootstrap "gui/$(id -u)" "$P" 2>&1) || { echo "Could not start the schedule (launchctl: $ERR). Paired, but sessions are sent only when you run: $PY $D/device_agent.py push"; exit 1; }
    else
      command -v crontab >/dev/null || { echo "crontab is missing (Ubuntu: sudo apt-get install -y cron). Paired. Sessions are sent once now; after that only when you run: python3 $D/device_agent.py push"; return 1; }
      # '|| true': with no crontab yet, 'crontab -l' and grep fail, and 'set -e' would end the
      # subshell before the echo, so an empty crontab would be installed (seen on a clean Ubuntu).
      { crontab -l 2>/dev/null | grep -v 'device_agent.py push' || true; echo "*/5 * * * * $PY $D/device_agent.py push >> $D/device-agent.log 2>&1"; } | crontab -
      crontab -l 2>/dev/null | grep -q 'device_agent.py push' || { echo "Could not add the schedule to crontab. Paired, but sessions are sent only when you run: python3 $D/device_agent.py push"; exit 1; }
    fi
    echo "Sessions are sent every 5 minutes (log: $D/device-agent.log)."
  fi
}
# A cloud brain without a code answers "wait for Approve" (exit 6). The schedule goes in BEFORE the
# wait: it finishes the join and starts sending even when this window is closed while it waits.
RC=0
"$PY" "$D/device_agent.py" join "$HUB" ${CODE:+"$CODE"} ${NAME:+--name "$NAME"} --no-wait || RC=$?
# SCHED=1: no schedule could be made (no crontab). The first push still runs, so the brain has this
# computer's sessions; then the script ends with exit 1 (found by a test run).
SCHED=0
if [ "$RC" = 6 ]; then schedule || SCHED=1; "$PY" "$D/device_agent.py" wait
elif [ "$RC" != 0 ]; then exit "$RC"
else schedule || SCHED=1; fi
"$PY" "$D/device_agent.py" push
exit "$SCHED"
