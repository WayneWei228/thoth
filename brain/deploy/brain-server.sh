#!/bin/bash
# brain-server: manage a self-hosted Thoth brain (installed by brain/deploy/install-server.sh).
#
#   brain-server status              services, health, certificate, firewall, SSH, last backup
#   brain-server update <bundle>     back up, install the new code, keep data and settings, roll back if it fails
#   brain-server backup              back up brain.db now (nightly backups run by themselves; 7 kept)
#   brain-server logs [-f]           brain and Caddy logs
#   brain-server connect-link        print the owner's connect link (ccbrain://<host>/#<token>) and a QR code
#   brain-server uninstall [--purge] remove services, code, Caddy; --purge also deletes the data
set -uo pipefail

CODE=/opt/claude-brain
DATA=/var/lib/claude-brain
CONF=/etc/claude-brain/server.conf
PORT=7879

if [ "$(id -u)" != 0 ]; then exec sudo "$0" "$@"; fi
HOST=""; [ -f "$CONF" ] && HOST=$(. "$CONF"; echo "${HOST:-}")

line() { printf '  %-6s %s\n' "$1" "$2"; }

check_ssh() {
  # Key-only SSH: password and keyboard-interactive logins off, root without password.
  # Only reports. It never changes sshd: a wrong change locks the owner out.
  local t pa kb pr bad=0
  t=$(sshd -T 2>/dev/null) || { line WARN "could not read the SSH settings (sshd -T failed)"; return 1; }
  pa=$(awk '$1=="passwordauthentication"{print $2}' <<<"$t")
  kb=$(awk '$1=="kbdinteractiveauthentication"{print $2}' <<<"$t")
  pr=$(awk '$1=="permitrootlogin"{print $2}' <<<"$t")
  [ "$pa" = no ] || { line WARN "SSH accepts passwords (PasswordAuthentication $pa)"; bad=1; }
  [ "$kb" = no ] || { line WARN "SSH accepts keyboard-interactive logins (KbdInteractiveAuthentication $kb)"; bad=1; }
  [ "$pr" = yes ] && { line WARN "SSH lets root log in with a password (PermitRootLogin yes)"; bad=1; }
  if [ $bad = 0 ]; then line ok "SSH is key-only (no password logins)"; return 0; fi
  cat <<'EOF'
         Fix (nothing was changed). First make sure you can log in with your SSH key in a
         second terminal, then run:
           sudo tee /etc/ssh/sshd_config.d/00-key-only.conf >/dev/null <<'END'
           PasswordAuthentication no
           KbdInteractiveAuthentication no
           PermitRootLogin prohibit-password
           END
           sudo sshd -t && sudo systemctl reload ssh
EOF
  return 1
}

connect_link() {
  [ -n "$HOST" ] && [ -s "$DATA/owner-token" ] || { echo "not installed (no $CONF or owner token)"; return 1; }
  local link="ccbrain://$HOST/#$(tr -d '[:space:]' < "$DATA/owner-token")"
  echo
  echo " Connect link (keep it secret: it gives full access to your brain)."
  echo " In Thoth on your Mac: Setup > Connect to my cloud brain > paste it."
  echo
  echo "   $link"
  echo
  if command -v qrencode >/dev/null && [ -t 1 ]; then qrencode -t ANSIUTF8 -m 2 "$link"; fi
}

status() {
  local rc=0 v
  echo "Thoth brain on ${HOST:-?}"
  v=$(cat "$CODE/VERSION" 2>/dev/null || echo unknown); line info "code: $v"
  for u in claude-brain caddy; do
    if systemctl is-active -q "$u"; then line ok "service $u is running"; else line FAIL "service $u is $(systemctl is-active "$u")"; rc=1; fi
  done
  systemctl is-enabled -q claude-brain-backup.timer && line ok "nightly backup timer is on ($(systemctl show -p NextElapseUSecRealtime --value claude-brain-backup.timer | sed 's/^$/next run unknown/'))" \
    || { line FAIL "nightly backup timer is off"; rc=1; }
  if curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null; then line ok "brain answers on 127.0.0.1:$PORT"
  else line FAIL "brain does not answer on 127.0.0.1:$PORT (brain-server logs)"; rc=1; fi
  if ss -Hltn "sport = :$PORT" | awk '{print $4}' | grep -qvE '^(127\.0\.0\.1|\[::1\]):'; then
    line FAIL "port $PORT listens on more than 127.0.0.1"; rc=1; fi
  if [ -n "$HOST" ] && curl -fsS -m 8 --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/health" >/dev/null 2>&1; then
    line ok "https://$HOST answers with a valid certificate"
    v=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOST" 2>/dev/null | openssl x509 -noout -enddate -issuer 2>/dev/null | tr '\n' ' ')
    [ -n "$v" ] && line info "certificate: $v"
  else line FAIL "https://$HOST does not answer with a valid certificate (journalctl -u caddy -n 50)"; rc=1; fi
  v=$(ufw status 2>/dev/null | head -1)
  [ "$v" = "Status: active" ] && line ok "ufw is active: $(ufw status | awk 'NR>4 && $2=="ALLOW" && $0 !~ /v6/ {printf "%s ", $1}')" \
    || { line FAIL "ufw is not active"; rc=1; }
  check_ssh || true
  v=$(ls -1t "$DATA"/backups/brain-*.db 2>/dev/null | head -1)
  [ -n "$v" ] && line info "last backup: $v ($(ls "$DATA"/backups/brain-*.db | wc -l) kept)" || line info "no backup yet"
  line info "data: $(du -sh "$DATA" 2>/dev/null | cut -f1) in $DATA; disk free: $(df -h --output=avail "$DATA" | tail -1 | tr -d ' ')"
  return $rc
}

update() {
  local bundle=${1:-} tmp inst
  [ -n "$bundle" ] && [ -e "$bundle" ] || { echo "usage: brain-server update <bundle.tgz | bundle folder>"; return 2; }
  if [ -d "$bundle" ]; then tmp=""; inst=$(find "$bundle" -path '*/brain/deploy/install-server.sh' | head -1)
  else
    tmp=$(mktemp -d); tar xzf "$bundle" -C "$tmp" || { rm -rf "$tmp"; echo "could not unpack $bundle"; return 1; }
    inst=$(find "$tmp" -path '*/brain/deploy/install-server.sh' | head -1)
  fi
  [ -n "$inst" ] || { echo "no brain/deploy/install-server.sh in $bundle"; [ -n "$tmp" ] && rm -rf "$tmp"; return 1; }
  bash "$inst" --update; local rc=$?
  [ -n "$tmp" ] && rm -rf "$tmp"
  return $rc
}

backup() {
  systemctl start claude-brain-backup.service || { journalctl -u claude-brain-backup -n 20 --no-pager; return 1; }
  journalctl -u claude-brain-backup -n 3 --no-pager -o cat | grep -E '^backup' | tail -1
}

uninstall() {
  local purge=0; [ "${1:-}" = --purge ] && purge=1
  systemctl disable --now claude-brain.service claude-brain-backup.timer 2>/dev/null
  rm -f /etc/systemd/system/claude-brain.service /etc/systemd/system/claude-brain-backup.service /etc/systemd/system/claude-brain-backup.timer
  systemctl daemon-reload
  systemctl disable --now caddy 2>/dev/null
  # remove keeps Caddy's certificates (/var/lib/caddy), so a reinstall does not ask Let's Encrypt again
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -y -qq "$([ $purge = 1 ] && echo purge || echo remove)" caddy >/dev/null 2>&1
  [ $purge = 1 ] && rm -rf /var/lib/caddy /etc/caddy /var/log/caddy
  rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  rm -rf "$CODE" "$CODE.prev" "$CODE.new" "$CODE.failed" /etc/claude-brain
  echo "Removed the brain service, its code, Caddy and the brain-server command."
  echo "ufw stays on (22/80/443). To close 80 and 443: sudo ufw delete allow 80/tcp; sudo ufw delete allow 443/tcp"
  if [ $purge = 1 ]; then
    rm -rf "$DATA"; userdel ccbrain 2>/dev/null; echo "Deleted the data in $DATA and the user ccbrain."
  else
    echo "Data kept in $DATA (database, backups, owner token). Delete it with: sudo rm -rf $DATA"
  fi
  rm -f /usr/local/bin/brain-server
}

case "${1:-}" in
  status) status ;;
  update) update "${2:-}" ;;
  backup) backup ;;
  logs) shift; journalctl -u claude-brain -u caddy -u claude-brain-backup -n 200 --no-pager "$@" ;;
  connect-link) connect_link ;;
  uninstall) uninstall "${2:-}" ;;
  check-ssh) check_ssh ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; [ -z "${1:-}" ] || exit 2 ;;
esac
