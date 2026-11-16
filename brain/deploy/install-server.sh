#!/bin/bash
# Self-host install of the Thoth brain on a fresh Ubuntu 24.04 server with a public IP
# (guide: docs/self-host.md).
#
#   sudo bash brain/deploy/install-server.sh [--domain your.domain] [--email you@example.com]
#                                            [--ip 203.0.113.7] [--staging]
#
# Run it from an unpacked bundle (the folder that holds brain/brain.py). Safe to run again:
# data, the owner token and the settings are kept. `brain-server update <bundle>` runs it with --update.
#
# What it sets up:
#   - system user ccbrain; code in /opt/claude-brain (root-owned, read-only for the service);
#     data in /var/lib/claude-brain (CC_BRAIN_DIR, 0700 ccbrain)
#   - systemd service claude-brain: `python3 brain.py serve` on 127.0.0.1:7879, restarts always, hardened
#   - Caddy (official apt repo) with automatic HTTPS for <ip-with-dashes>.sslip.io or --domain;
#     HTTP redirects to HTTPS; security headers; logs without Authorization headers or query strings
#   - ufw: only 22, 80, 443 in (plus the SSH port if sshd listens elsewhere)
#   - nightly backup of brain.db (sqlite backup API) to /var/lib/claude-brain/backups, keep 7
#   - the `brain-server` command; the owner token /var/lib/claude-brain/owner-token (0600)
# It checks that SSH is key-only and prints the exact fix if not. It never changes sshd itself.
set -euo pipefail

CODE=/opt/claude-brain
DATA=/var/lib/claude-brain
CONF_DIR=/etc/claude-brain
CONF=$CONF_DIR/server.conf
SVC_USER=ccbrain
PORT=7879
APT=(apt-get -o DPkg::Lock::Timeout=600 -y -qq)
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok    %s\n' "$*"; }
warn() { printf '    WARN  %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

DOMAIN=""; EMAIL=""; IP=""; STAGING=0; UPDATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)  DOMAIN=${2:-}; shift 2 ;;
    --email)   EMAIL=${2:-}; shift 2 ;;
    --ip)      IP=${2:-}; shift 2 ;;
    --staging) STAGING=1; shift ;;
    --update)  UPDATE=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root: sudo bash $0 $*"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/../.." && pwd)
[ -f "$SRC/brain/brain.py" ] || die "brain/brain.py not found next to this script ($SRC). Run it from an unpacked bundle."

# ---------------------------------------------------------------- settings --
if [ -f "$CONF" ]; then
  # earlier settings win unless given again on the command line
  # shellcheck disable=SC1090
  OLD_DOMAIN=$(. "$CONF"; echo "${DOMAIN:-}"); OLD_EMAIL=$(. "$CONF"; echo "${EMAIL:-}")
  OLD_IP=$(. "$CONF"; echo "${IP:-}"); OLD_STAGING=$(. "$CONF"; echo "${STAGING:-0}")
  [ -n "$DOMAIN" ] || DOMAIN=$OLD_DOMAIN
  [ -n "$EMAIL" ] || EMAIL=$OLD_EMAIL
  [ -n "$IP" ] || IP=$OLD_IP
  [ "$STAGING" = 1 ] || STAGING=$OLD_STAGING
fi

say "Checking this machine"
. /etc/os-release 2>/dev/null || true
if [ "${ID:-}" != ubuntu ]; then die "this installer supports Ubuntu (found ${PRETTY_NAME:-unknown})."; fi
[ "${VERSION_ID:-}" = "24.04" ] && ok "Ubuntu 24.04" || warn "tested on Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}"
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || die "systemd is not running on this machine."

valid_ip() { [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] && for o in "${BASH_REMATCH[@]:1}"; do [ "$o" -le 255 ] || return 1; done; }
if [ -z "$IP" ]; then
  for u in https://checkip.amazonaws.com https://api.ipify.org https://ifconfig.me/ip; do
    IP=$(curl -fsS -m 8 "$u" 2>/dev/null | tr -d '[:space:]') && valid_ip "$IP" && break || IP=""
  done
fi
[ -n "$IP" ] && valid_ip "$IP" || die "could not find this server's public IPv4 address. Give it with --ip 203.0.113.7"
case "$IP" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|127.*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
  die "$IP is a private address. Let's Encrypt must reach this server on a public IP (give it with --ip)." ;;
esac
ok "public IP $IP"

if [ -n "$DOMAIN" ]; then
  DOMAIN=$(echo "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  [[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "'$DOMAIN' is not a valid domain name."
  HOST=$DOMAIN
  if getent ahostsv4 "$DOMAIN" | awk '{print $1}' | grep -qx "$IP"; then ok "$DOMAIN points to $IP"
  else warn "$DOMAIN does not point to $IP yet. Add a DNS A record '$DOMAIN -> $IP'. Caddy keeps trying to get the certificate."; fi
else
  HOST="${IP//./-}.sslip.io"
  ok "host name $HOST (sslip.io: no domain needed)"
fi

for p in 80 443; do
  holder=$(ss -Hltnp "sport = :$p" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true)
  if [ -n "$holder" ] && [ "$holder" != caddy ]; then die "port $p is used by '$holder'. Stop it first (for example: sudo systemctl disable --now $holder)."; fi
done
holder=$(ss -Hltnp "sport = :$PORT" 2>/dev/null | grep -o 'users:(("[^"]*",pid=[0-9]*' | head -1 || true)
if [ -n "$holder" ] && ! systemctl is-active -q claude-brain 2>/dev/null; then die "port $PORT is used by another program ($holder). Stop it first."; fi

# ---------------------------------------------------------------- packages --
say "Installing packages (python3, ufw, Caddy from its official repository)"
installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"; }
need=()
for p in python3 ufw curl gpg qrencode debian-keyring debian-archive-keyring apt-transport-https; do
  installed "$p" || need+=("$p")
done
if [ ${#need[@]} -gt 0 ]; then
  "${APT[@]}" update >/dev/null
  "${APT[@]}" install "${need[@]}" >/dev/null
fi
python3 - <<'EOF' || die "python3 has no SQLite FTS5 trigram support (needs SQLite 3.34+)."
import sqlite3
sqlite3.connect(":memory:").execute("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')")
EOF
ok "python3 $(python3 -c 'import sys,sqlite3;print("%d.%d, SQLite %s" % (sys.version_info[0], sys.version_info[1], sqlite3.sqlite_version))')"

KEYRING=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
if ! installed caddy; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o "$KEYRING"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r "$KEYRING" /etc/apt/sources.list.d/caddy-stable.list
  "${APT[@]}" update >/dev/null
  "${APT[@]}" install caddy >/dev/null
fi
ok "$(caddy version | cut -d' ' -f1 | sed 's/^/Caddy /')"

# ---------------------------------------------------------- user and data --
say "Creating the service user and folders"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin --user-group "$SVC_USER"
fi
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0700 "$DATA" "$DATA/backups"
install -d -o root -g root -m 0755 "$CONF_DIR"
# the server keeps no sessions of its own: devices push to it (no "local" device named after the server)
if [ ! -e "$DATA/devices.json" ]; then
  echo '[]' > "$DATA/devices.json"; chown "$SVC_USER:$SVC_USER" "$DATA/devices.json"; chmod 0600 "$DATA/devices.json"
fi
umask 022
cat > "$CONF" <<EOF
# written by install-server.sh; read by brain-server and by the next install/update
HOST=$HOST
DOMAIN=$DOMAIN
EMAIL=$EMAIL
IP=$IP
STAGING=$STAGING
EOF
chmod 0644 "$CONF"

# ------------------------------------------------------------------- code --
say "Installing the brain code to $CODE"
rm -rf "$CODE.new"
install -d -m 0755 "$CODE.new"
cp -R "$SRC/brain" "$CODE.new/brain"
rm -rf "$CODE.new/brain/tests"
# public files for the join command (no secrets in them): served by Caddy at fixed paths
install -d -m 0755 "$CODE.new/public" "$CODE.new/public/device"
for pair in device/join.sh:join.sh device/join.ps1:join.ps1 brain/collector.py:device/collector.py device/device_agent.py:device/device_agent.py; do
  from=${pair%%:*}; to=${pair#*:}
  if [ -f "$SRC/$from" ]; then cp "$SRC/$from" "$CODE.new/public/$to"; else warn "$from is not in the bundle; https://<host>/$to will be missing"; fi
done
find "$CODE.new" -name __pycache__ -prune -exec rm -rf {} +
ver="$(date -u +%Y-%m-%dT%H:%M:%SZ) brain.py sha256 $(sha256sum "$CODE.new/brain/brain.py" | cut -c1-12)"
echo "$ver" > "$CODE.new/VERSION"
chown -R root:root "$CODE.new"; chmod -R u=rwX,go=rX "$CODE.new"
python3 -I - "$CODE.new/brain" <<'EOF' || { rm -rf "$CODE.new"; die "the new code has a syntax error; nothing was changed."; }
import ast, os, sys
for root, _, files in os.walk(sys.argv[1]):
    for f in files:
        if f.endswith(".py"):
            p = os.path.join(root, f)
            ast.parse(open(p, encoding="utf-8").read(), p)
EOF

# owner token: brain.py owner-token creates it (32 random bytes, base64url, 0600) and keeps an existing one;
# the installer's own generator (same format) is the fallback for code without that command
if [ ! -s "$DATA/owner-token" ]; then
  if runuser -u "$SVC_USER" -- env CC_BRAIN_DIR="$DATA" HOME="$DATA" PYTHONDONTWRITEBYTECODE=1 \
       python3 -I "$CODE.new/brain/brain.py" owner-token >/dev/null 2>&1 && [ -s "$DATA/owner-token" ]; then
    ok "new owner token in $DATA/owner-token (brain.py owner-token)"
  else
    ( umask 077; python3 -c 'import secrets;print(secrets.token_urlsafe(32))' > "$DATA/owner-token.tmp" )
    chown "$SVC_USER:$SVC_USER" "$DATA/owner-token.tmp"; chmod 0600 "$DATA/owner-token.tmp"
    mv "$DATA/owner-token.tmp" "$DATA/owner-token"
    ok "new owner token in $DATA/owner-token"
  fi
else
  chown "$SVC_USER:$SVC_USER" "$DATA/owner-token"; chmod 0600 "$DATA/owner-token"
  ok "owner token kept"
fi

install -m 0755 "$SRC/brain/deploy/brain-server.sh" /usr/local/bin/brain-server

# ---------------------------------------------------------------- systemd --
HARDEN='NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/claude-brain
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RemoveIPC=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077'
ENV="Environment=CC_BRAIN_DIR=$DATA
Environment=CC_BRAIN_PORT=$PORT
Environment=CC_BRAIN_LOCAL_TRUST=0
Environment=HOME=$DATA
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PYTHONUNBUFFERED=1"

cat > /etc/systemd/system/claude-brain.service <<EOF
[Unit]
Description=Thoth brain (127.0.0.1:$PORT, behind Caddy)
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
$ENV
WorkingDirectory=$DATA
ExecStart=/usr/bin/python3 -I $CODE/brain/brain.py serve
Restart=always
RestartSec=3
$HARDEN

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/claude-brain-backup.service <<EOF
[Unit]
Description=Back up the Thoth brain database (keep 7)
# a manual backup (brain-server backup, update) must never be refused by the default start limit
StartLimitIntervalSec=0

[Service]
Type=oneshot
User=$SVC_USER
Group=$SVC_USER
$ENV
Environment=CC_BRAIN_BACKUP_KEEP=7
ExecStart=/usr/bin/python3 -I $CODE/brain/deploy/backup.py
$HARDEN
EOF

cat > /etc/systemd/system/claude-brain-backup.timer <<EOF
[Unit]
Description=Nightly backup of the Thoth brain database

[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload

health() { curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
wait_health() { for _ in $(seq 1 ${1:-30}); do health && return 0; sleep 1; done; return 1; }

# back up before code changes (update), then swap the code in one step; roll back if it does not start
if [ -f "$DATA/brain.db" ]; then
  systemctl start claude-brain-backup.service && ok "backup before the change: $(ls -1t "$DATA"/backups/brain-*.db 2>/dev/null | head -1)" \
    || warn "backup before the change failed (see: journalctl -u claude-brain-backup)"
fi
if [ -d "$CODE" ]; then rm -rf "$CODE.prev"; mv "$CODE" "$CODE.prev"; fi
mv "$CODE.new" "$CODE"
systemctl enable -q claude-brain.service claude-brain-backup.timer
systemctl restart claude-brain.service
systemctl start claude-brain-backup.timer
if wait_health 30; then
  ok "brain answers on 127.0.0.1:$PORT ($ver)"
else
  if [ -d "$CODE.prev" ]; then
    warn "the new brain does not start; going back to the previous code"
    journalctl -u claude-brain -n 15 --no-pager | sed 's/^/      /'
    rm -rf "$CODE.failed"; mv "$CODE" "$CODE.failed"; mv "$CODE.prev" "$CODE"
    systemctl restart claude-brain.service
    wait_health 30 && die "update failed; the previous version is running again (failed code kept in $CODE.failed)."
  fi
  journalctl -u claude-brain -n 30 --no-pager | sed 's/^/      /'
  die "the brain does not start (log above)."
fi

# ------------------------------------------------------------------ Caddy --
say "Configuring Caddy (HTTPS for $HOST)"
[ -f /etc/caddy/Caddyfile.orig ] || cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig 2>/dev/null || true
# log filters: drop credentials from every request that Caddy logs (access log and error log)
FILTER='request>headers>Authorization delete
			request>headers>Cookie delete
			request>headers>Proxy-Authorization delete
			request>uri regexp "\?.*$" "?redacted"
			resp_headers>Set-Cookie delete'
{
  echo "# written by brain/deploy/install-server.sh (Thoth brain). Re-run the installer to change it."
  echo "{"
  [ -n "$EMAIL" ] && echo "	email $EMAIL"
  [ "$STAGING" = 1 ] && echo "	acme_ca https://acme-staging-v02.api.letsencrypt.org/directory"
  cat <<EOF
	servers {
		protocols h1 h2
	}
	log default {
		output stderr
		format filter {
			wrap json
			fields {
			$FILTER
			}
		}
	}
}

$HOST {
	request_body {
		max_size 20MB
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		Content-Security-Policy "default-src 'none'; frame-ancestors 'none'"
		Cache-Control "no-store"
		-Server
	}
	# the join command's files: public, read-only, exactly these four paths
	@public path /join.sh /join.ps1 /device/collector.py /device/device_agent.py
	handle @public {
		root * $CODE/public
		header Content-Type "text/plain; charset=utf-8"
		file_server
	}
	handle /device/* {
		respond 404
	}
	handle {
		reverse_proxy 127.0.0.1:$PORT {
			header_down -Server
		}
	}
	log {
		output file /var/log/caddy/claude-brain-access.log {
			roll_size 10MiB
			roll_keep 5
		}
		format filter {
			wrap json
			fields {
			$FILTER
			}
		}
	}
}
EOF
} > /etc/caddy/Caddyfile.new
install -d -o caddy -g caddy -m 0750 /var/log/caddy
chown -R caddy:caddy /var/log/caddy   # also repairs a log file an earlier root run created
chmod 0644 /etc/caddy/Caddyfile.new
# validate as the caddy user: validation opens the log files, and as root it would create them
# owned by root, so the real Caddy (user caddy) could not write them and the reload fails
cvalidate() { runuser -u caddy -- env HOME=/var/lib/caddy caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile; }
cvalidate >/dev/null 2>&1 || { cvalidate 2>&1 | tail -5; die "the Caddy configuration is not valid (bug in the installer)."; }
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
systemctl enable -q caddy
if systemctl is-active -q caddy; then act=reload; else act=restart; fi
systemctl "$act" caddy 2>/dev/null || { journalctl -u caddy -n 5 --no-pager -o cat | cut -c1-300 | sed 's/^/      /'; die "Caddy did not $act (log above)."; }
ok "Caddy proxies https://$HOST to 127.0.0.1:$PORT"

# -------------------------------------------------------------------- ufw --
say "Firewall (ufw): only SSH, 80 and 443 in"
SSH_PORTS=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' | sort -u)
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in $SSH_PORTS 80 443; do ufw allow "$p/tcp" >/dev/null; done
for p in $SSH_PORTS; do [ "$p" = 22 ] || warn "sshd listens on port $p, so ufw allows $p/tcp too"; done
ufw --force enable >/dev/null
extra=$(ufw status | awk 'NR>4 && $0!="" {print $1}' | grep -vxE "($(echo $SSH_PORTS | tr ' ' '|')|80|443)/tcp( \(v6\))?" | sort -u || true)
if [ -n "$extra" ]; then warn "ufw has other rules that open more ports: $(echo $extra). Remove each with: sudo ufw delete allow <rule>"
else ok "ufw allows only $(echo $SSH_PORTS | tr ' ' ',')/tcp, 80/tcp, 443/tcp"; fi

# -------------------------------------------------------------------- SSH --
say "SSH"
brain-server check-ssh || true

# ------------------------------------------------------------ certificate --
say "Getting the HTTPS certificate (Let's Encrypt)"
got=1
for _ in $(seq 1 60); do
  if curl -fsS -m 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/health" >/dev/null 2>&1; then got=0; break; fi
  [ "$STAGING" = 1 ] && curl -fsSk -m 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/health" >/dev/null 2>&1 && { got=0; break; }
  sleep 3
done
if [ $got = 0 ]; then
  ok "https://$HOST/api/health answers with a valid certificate"
else
  warn "no certificate yet. Most common cause: ports 80 and 443 are closed in your cloud provider's firewall"
  warn "(AWS security group, Hetzner/DigitalOcean firewall). Open them; Caddy keeps trying. Log: journalctl -u caddy -n 50"
fi

echo
echo "=================================================================="
echo " The Thoth brain is running."
echo "   Address:  https://$HOST"
echo "   Health:   https://$HOST/api/health"
echo "=================================================================="
brain-server connect-link
echo
echo " Commands:  brain-server status | logs | backup | update <bundle> | connect-link | uninstall"
[ "$UPDATE" = 1 ] && echo " Update done: $ver"
exit 0
