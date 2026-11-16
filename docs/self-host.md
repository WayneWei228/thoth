# Run your brain on your own server

The brain keeps the index of your Claude Code and Codex sessions from all your computers.
You can run it on your own server in the cloud. Then each computer connects to it over HTTPS,
from any network. No VPN, no open ports on your computers, no SSH between them.

This guide is for version A of the cloud brain.

## What you need

- A server with **Ubuntu 24.04** and a **public IPv4 address**. The smallest size is enough
  (1 vCPU, 1 GB RAM, 10 GB disk). For example: AWS EC2 t3.micro/t3.small, Hetzner CX22,
  DigitalOcean Basic.
- SSH access with a key, as a user that can run `sudo`.
- Ports **80 and 443 open** in your cloud provider's firewall (AWS: security group; Hetzner and
  DigitalOcean: cloud firewall, if you use one). Let's Encrypt uses port 80 to give you the
  HTTPS certificate.
- A domain name is **not** needed. The server gets a free name: `<your-ip-with-dashes>.sslip.io`
  (for 203.0.113.7: `203-0-113-7.sslip.io`). You can use your own domain if you want.

## Install (one command)

Copy the Thoth bundle to the server, unpack it, and run the installer:

```sh
scp claude-panel.tgz you@203.0.113.7:
ssh you@203.0.113.7
tar xzf claude-panel.tgz
sudo bash claude-panel/brain/deploy/install-server.sh
```

With your own domain (first add a DNS A record `brain.example.com -> 203.0.113.7`):

```sh
sudo bash claude-panel/brain/deploy/install-server.sh --domain brain.example.com --email you@example.com
```

`--email` is optional. Let's Encrypt uses it to warn you before a certificate expires (Caddy renews
certificates by itself, so you normally get no mail).

The installer takes 1 to 3 minutes. At the end it prints a **connect link**:

```
ccbrain://203-0-113-7.sslip.io/#Xq3...43 characters...
```

**Keep this link secret.** It holds the owner token: whoever has it controls your brain.
Show it again at any time with `sudo brain-server connect-link`.

## Connect your Mac

In Thoth on your Mac: **Setup > Connect to my cloud brain**, paste the link.
Your Mac becomes the owner. Other computers then ask to join, and you approve them in the panel.

## What the installer sets up

```
 your computers ──HTTPS 443──▶ Caddy ──▶ 127.0.0.1:7879 brain.py ──▶ /var/lib/claude-brain/brain.db
                               (certificate,                 (systemd service,
                                HTTP→HTTPS,                   user ccbrain)
                                security headers)
 ufw: only 22, 80, 443 in.  Port 7879 is never reachable from outside.
```

| Part | Where | Notes |
| --- | --- | --- |
| Brain code | `/opt/claude-brain` | owned by root; the service can only read it |
| Data | `/var/lib/claude-brain` | `brain.db`, `owner-token` (0600), `backups/`; only the user `ccbrain` can read it |
| Service | `claude-brain.service` | `python3 brain.py serve` on 127.0.0.1:7879; restarts by itself; starts at boot; locked down (no new privileges, read-only system, private /tmp, no devices, system call filter) |
| HTTPS | Caddy (`/etc/caddy/Caddyfile`) | free Let's Encrypt certificate, renewed by itself; plain HTTP redirects to HTTPS |
| Logs | `journalctl -u claude-brain -u caddy`, `/var/log/caddy/claude-brain-access.log` | tokens are removed: no `Authorization` header and no query string is written |
| Firewall | ufw | allows only SSH (22), 80 and 443 in |
| Backup | `claude-brain-backup.timer` | every night about 03:15 UTC; keeps the newest 7 in `/var/lib/claude-brain/backups` |
| Settings | `/etc/claude-brain/server.conf` | host name, domain, email; used again by updates |
| Join files | `/opt/claude-brain/public` | `https://<host>/join.sh`, `/join.ps1`, `/device/collector.py`, `/device/device_agent.py`: public (no secrets), served by Caddy for the join command on other computers; nothing else under `/device/` |

### SSH check

The installer checks that SSH accepts keys only. If your server still accepts passwords, it
prints a warning and the exact commands to fix it. It does **not** change SSH itself, because a
wrong SSH change can lock you out. Before you run the fix, open a second terminal and make sure
your key login works.

## Daily use: `brain-server`

| Command | What it does |
| --- | --- |
| `sudo brain-server status` | services, health, certificate, firewall, SSH, last backup, free disk |
| `sudo brain-server logs` | last 200 log lines of the brain and Caddy (`logs -f` to follow) |
| `sudo brain-server backup` | back up the database now |
| `sudo brain-server update claude-panel.tgz` | install a new version (see below) |
| `sudo brain-server connect-link` | print the connect link again (and a QR code) |
| `sudo brain-server uninstall` | remove the brain, Caddy and the command; keeps your data |
| `sudo brain-server uninstall --purge` | the same, and deletes all data and certificates |

## Update

Copy the new bundle to the server, then:

```sh
sudo brain-server update claude-panel.tgz
```

It backs up the database, checks the new code, swaps it in, and restarts the brain. If the new
brain does not start, it goes back to the old code by itself and tells you. Your data, owner
token, connect link and certificate stay the same.

## Backups

Backups are on the same disk as the brain. To keep a copy somewhere else, copy them now and then:

```sh
scp you@203.0.113.7:/var/lib/claude-brain/backups/brain-*.db ./brain-backups/
```

(The files belong to `ccbrain`. Copy them first with
`sudo install -o $USER /var/lib/claude-brain/backups/<file> ~/` if you cannot read them.)

Restore a backup:

```sh
sudo systemctl stop claude-brain
sudo install -o ccbrain -g ccbrain -m 600 /var/lib/claude-brain/backups/brain-<time>.db /var/lib/claude-brain/brain.db
sudo rm -f /var/lib/claude-brain/brain.db-wal /var/lib/claude-brain/brain.db-shm
sudo systemctl start claude-brain
```

## Problems

| You see | Cause and fix |
| --- | --- |
| "no certificate yet" at the end of the install | Ports 80/443 are closed in your cloud provider's firewall. Open them. Caddy keeps trying; check with `sudo brain-server status`. |
| "port 80 is used by 'nginx'" (or apache2) | Another web server runs on this machine. Stop it (`sudo systemctl disable --now nginx`) or use a clean server. |
| "… does not point to …" with `--domain` | The DNS A record is missing or not updated yet. Add it; Caddy gets the certificate when DNS is right. |
| "this is a private address" | The server has no public IP (or the IP check failed). Give the public IP with `--ip 203.0.113.7`. |
| The link does not work in the panel | Run `sudo brain-server status` on the server. Every line must say `ok`. |
| You lost the link | `sudo brain-server connect-link`. |

## Known limits

- The prompt helper (`/api/enrich`, used by the prompt hook) runs Claude Code on the brain's machine.
  A server without Claude Code cannot answer it; this request fails on a self-hosted brain for now.
  Search, sessions, memories and devices work.
- The installer runs from an unpacked bundle. A `curl … | sudo bash` download is not set up yet.

## Security notes

- Only Caddy faces the internet. The brain listens on 127.0.0.1 only.
- Every request except `/api/health` needs a token (the owner token, or a device's own token).
  These checks are in `brain.py`, not in Caddy. The service runs
  with `CC_BRAIN_LOCAL_TRUST=0`, so even a request from the server itself needs a token.
- Rotate the owner token (for example after you shared the link by mistake):
  `sudo -u ccbrain env CC_BRAIN_DIR=/var/lib/claude-brain python3 -I /opt/claude-brain/brain/brain.py owner-token --rotate`,
  then `sudo systemctl restart claude-brain` and `sudo brain-server connect-link` for the new link.
- The connect link puts the token after `#`. Browsers and apps never send that part to a server,
  so it does not appear in any log.
- Caddy forwards the client address in `X-Forwarded-For` and ignores the value a client sends,
  so the brain can trust it for rate limits.
- Ubuntu installs security updates by itself (unattended-upgrades is on by default). Reboot now and
  then; the brain starts again by itself.
