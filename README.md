<h1 align="center">Thoth</h1>
<p align="center">One memory for Claude Code and Codex, on every device you use. Even a brand-new one.</p>

<p align="center">
  <a href="#install"><b>Install</b></a> · <a href="https://thoth.build">Website</a> · <a href="docs/self-host.md">Self-host guide</a> · <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-555" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Linux-555?logo=apple" alt="macOS and Linux" />
</p>

<p align="center">
  <img src="https://thoth.build/media/mac-home.jpg" alt="Thoth: the request box and a session that needs you" width="900" />
</p>

## Features

<table>
<tr>
<td width="40%" valign="middle">
<h3>One request box</h3>
Type a request once. A router picks the session that already has the context, or starts a new one in the right folder, and sends the text. A session that needs you shows its choice buttons here.
</td>
<td width="60%">
<img src="https://thoth.build/media/mac-home.jpg" alt="Request box" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Every session in one place</h3>
Each Claude Code and Codex session, grouped by project folder, with its state: needs you, working, ready, not running. Sessions run in tmux, so closing the panel never stops one.
</td>
<td width="60%">
<img src="https://thoth.build/media/mac-sessions.jpg" alt="All sessions" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Chat or terminal</h3>
A rendered chat (markdown, code with Copy, tables, math, diagrams, image previews, collapsible tool calls, thinking) or the real terminal of the session. Switch with one click.
</td>
<td width="60%">
<img src="https://thoth.build/media/mac-terminal.jpg" alt="Session terminal" width="100%" />
</td>
</tr>
</table>

- **The brain** — An index of every session and memory file on every device, with search. Any session can ask it through MCP tools (`brain_search`, `brain_grep`, `brain_get_session`, `brain_remember`).
- **Two tools, one memory** — Claude Code and Codex read the same memory. Each can use what the other did.
- **A new device knows everything from day one** — Connect it, and the agents there can use your work from every other device.
- **Move work between devices** — Continue a session from another computer on this Mac.
- **Yours** — The memory lives on your own server ([self-host guide](docs/self-host.md)) or on your Mac. Full transcripts stay on your devices.
- **Helper computers** — A spare Mac, a Linux machine or a Windows PC (through WSL 2) joins as a helper. The request box can start a session on it, its sessions show in your panel, and **Fetch result** brings the work to your main computer. You approve each new helper on your main computer (File > Set Up Devices…); the panel shows whether each helper is online and updates an older one with one click. Helpers connect through a cloud brain ([self-host guide](docs/self-host.md)) and the Thoth relay: no open port, no SSH.
- **Add a computer with one prompt** — File > Set Up Devices… gives a ready-made prompt. Paste it into Claude Code on the new computer (macOS, Linux, or Windows 10/11): it installs Thoth, joins it to your brain, keeps the computer on if you want (`thoth always-on`) and checks the result (`thoth doctor`).
- **Native Mac app** — Swift and AppKit, with a native terminal (SwiftTerm).
- **Web panel** — The same panel in a browser, for Linux or any other computer: sessions, chat, terminal, the request box and your devices.
- **Slash commands, tidy and restore** — Type `/` in the request box for the session's commands. Select several sessions to close them at once, or let the model tidy the list. After a crash or a restart the panel brings back its sessions, the open page and your drafts.
- **Composer** — Paste, drop or attach images, PDFs, text, data and code files. Drafts are kept per session.
- **Notifications** — A notification and a Dock badge when a session needs you.
- **Open source** — Free and MIT-licensed.

## Install

macOS or Linux. You need tmux, python3 and curl (the installer names the command if one is missing). On Linux the terminal module is compiled, so you also need make and a C++ compiler (`sudo apt-get install -y build-essential`; the installer checks this before it starts and names the command for apt, dnf and pacman). On a Mac without Homebrew the installer says where to get it.
Node.js 22 (22.18 or newer) is downloaded for you if the computer has none or an older one. Claude Code (`claude`) runs the sessions.

### One line (recommended)

No copy of the code is needed (from a release of this repository):

```bash
curl -fsSL https://github.com/WayneWei228/thoth/releases/latest/download/install.sh | bash
```

It downloads the release bundle, checks its SHA-256, unpacks it to `~/.local/share/claude-panel/app` and runs `scripts/install.sh` there. Run the same line again to update (your packages and sessions are kept; the server restarts).

### From a copy of the code

```bash
scripts/install.sh      # checks, Node.js 22 if needed, npm install, ~/.local/bin/thoth, the Mac app on macOS
thoth                   # macOS: the app (or double-click the app in ~/Applications)
thoth web               # web panel; on a machine without a desktop it prints how to open it from your laptop
```

### Windows

The panel does not run in Windows itself (it needs tmux), and the line above fails in PowerShell (`bash` is not found). A Windows 10 (version 2004 or newer) or 11 PC can join in two ways:

- **As a helper, in WSL 2**: paste the prompt of File > Set Up Devices… into Claude Code on the PC. It sets up WSL 2, installs Thoth there and joins it. `thoth always-on` keeps the PC and WSL running.
- **As a device of the brain**: run the PowerShell command that the panel's setup page shows for that PC. Its Claude Code and Codex sessions are then indexed and searchable.

### Keep it running after logout and reboot

`thoth services install` starts the server (7878) and the brain (7879) as background services: systemd user units plus linger on Linux, launchd agents (`com.claudepanel.server`, `com.claudepanel.brain`) on macOS. `thoth services status | uninstall` show or remove them.

Something wrong? `thoth doctor` names each fault with its cause and the exact fix (server or brain down, port busy, tmux missing, Node older than 22, Claude Code missing or not logged in, a failing service, a full disk). `thoth doctor --fix` repairs what is safe.

## Why Thoth?

Your agents forget, and they do not share:

- Claude Code does not know what Codex did, and Codex does not know what Claude Code did.
- What an agent learned on your laptop is not there on your other computer.
- So you explain the same context again.

Thoth keeps one memory for all of them. The brain indexes every session and memory file on every device. Any session can search it, so an agent on a new device can use the work you did on the others. The request box sends each request to the session that already has the context, so you stop repeating yourself.

## Commands

| Command | What it does |
| --- | --- |
| `thoth` | Opens the Mac app |
| `thoth web` | Starts the web panel |
| `thoth stop` / `restart` / `status` | Stops or restarts the server (sessions keep running), or shows it and its sessions |
| `thoth tui` | Attaches to the sessions in tmux |
| `thoth adopt` | Moves the Codex session you type it in into the panel |
| `thoth services install \| status \| uninstall` | Background services for the server and the brain |
| `thoth setup --role helper \| main` | Joins this computer to your cloud brain, as a helper or as your main computer |
| `thoth always-on [--status \| --undo]` | Keeps a helper Mac or Windows PC on (no sleep; on Windows, WSL keeps running) |
| `thoth doctor [--fix \| --json]` | Finds faults and names the fix |

**Move a session into the panel:** in any terminal (VS Code, iTerm, Terminal) where Claude Code is running, type `/panel`. That Claude exits, the panel resumes the same conversation, and the app opens it. For Codex, type `!thoth adopt` in Codex (after its first message): that Codex exits and the panel resumes it with `codex resume`.

**Rebuild the app:** `macos/build-app.sh`. Run `scripts/signing-identity.sh` once before: it makes a local signing certificate, so macOS keeps the app's Accessibility and Screen Recording grants after a rebuild.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘ N | New request |
| ⌘ ⇧ N | New session |
| ⌘ 0 | Home |
| ⌘ L | All sessions |
| ⌘ E | All devices |
| ⌘ 1–9 | Jump to session 1–9 |
| ⌃ ⌘ S | Toggle sidebar |
| ⌘ W | Close window |
| ⌘ Q | Quit |

## Central brain

A read-only index of every Claude Code and Codex session on every device, with search. Shown in the app under **All Devices**.

```bash
# devices: ~/.config/cc-brain/devices.json, e.g.
# [ {"name": "my-mac", "transport": "local"},
#   {"name": "my-pc", "transport": "ssh", "python": "py -3",
#    "ssh": ["-i", "~/.ssh/key", "-o", "IdentitiesOnly=yes", "user@192.168.x.x"]} ]
python3 brain/brain.py sync --all     # pull from every device
python3 brain/brain.py search "login bug"   # search from the terminal
python3 brain/brain.py serve          # API on 127.0.0.1:7879, sync every 2 min
```

- `brain/collector.py` runs on each device (Python stdlib, macOS/Windows/Linux), read-only, redacts secrets.
- The brain pulls over SSH and deploys the collector itself; no device opens a port.
- Same project across devices = same git remote (else same folder name).
- Memories (Claude memory files, Codex AGENTS.md/memories) are shared too. `brain/mcp_server.py` gives any session the tools `brain_search`, `brain_project_context`, `brain_list_devices`, `brain_grep`, `brain_get_session`, `brain_remember`. The brain keeps the whole dialogue of every session: `brain_grep` searches it like grep on files, and `brain_get_session` reads the messages around a hit. Register it yourself: `claude mcp add brain -- python3 -I <repo>/brain/mcp_server.py`.
- Handoff: `python3 brain/handoff.py --from <device> --sid <id> --to <device> --run panel|headless|none` moves the work (code as a git bundle through the brain, nothing pushed; the source is never touched) and starts an agent there with a handoff packet. In the app: All Devices → **Continue on This Mac**.

## How it works

```
 ┌────────────────── Thoth UI ─────────────────┐
 │ Ask box · session cards · terminal · buttons │
 └───────────────┬─────────────────────────────┘
        HTTP + WebSocket (127.0.0.1:7878)
 ┌───────────────┴─────────────────────────────┐
 │ server.ts                                    │
 │  poll tmux every 1.5 s → state per session   │
 │  actions → tmux send-keys / new-window       │
 │  router → claude -p (haiku) → send/new/ask   │
 └───────────────┬─────────────────────────────┘
          tmux session "cc"
   ┌──────────┬──────────┬──────────┐
   │ claude   │ claude   │ claude   │  one window per session
   │ ~/proj-a │ ~/proj-b │ ~/notes  │
   └──────────┴──────────┴──────────┘
```

- State comes from the pane text: a "❯" menu with sibling lines = needs you; the spinner line "✳ Word… (5s · …)" = working; a shell in the pane = not running.
- "Open elsewhere": a `claude` process outside the panel uses the same folder (for example in VS Code). Type `/exit` there before you resume here.
- Session names you set are stored as the tmux window option `@label`, so programs that rename windows cannot overwrite them.

### Router

The Ask box sends text to `POST /api/route`. A headless `claude -p --model haiku` call with a JSON schema reads each session's name, folder, title, last request, last reply and recent topics, and returns `send`, `new` or `ask`:

| Decision | Condition | Result |
| --- | --- | --- |
| send | confidence ≥ 0.75 | Text goes to that session; the UI opens it |
| new | confidence ≥ 0.75 | New session in that folder, then the text |
| ask | otherwise | Buttons to pick a session or a folder |

Messages wait until the target session is idle. A stopped session starts first. A session at a choice prompt is not interrupted. `CC_ROUTER_MODEL` sets the model.

`POST /api/route` also takes `folder` and `agent` (`claude` or `codex`): what the user chose for a new session. They are used only when the request starts a new session; a request that goes to an existing session ignores them. A folder that does not exist or an unknown agent gives HTTP 400.

## FAQ

### Which agents does Thoth work with?

Claude Code and Codex. Both run as sessions in the panel, and both can read the brain.

### What platforms does it support?

The panel runs on macOS (native app) and Linux (web panel). A Windows PC runs Thoth in WSL 2 as a helper, or joins as a device whose sessions are indexed and searchable.

### Where does my data go?

The memory lives on your own server or on your Mac. Full transcripts stay on your devices. The collector redacts secrets before it sends anything to the brain. See the [self-host guide](docs/self-host.md) and [SECURITY.md](SECURITY.md).

### Does closing the panel stop my sessions?

No. Sessions run in tmux. The panel only shows them and sends them text.

### Can I keep using Claude Code in my own terminal?

Yes. Type `/panel` in that terminal to move the session into Thoth, or leave it where it is. The panel marks a folder as "open elsewhere" when a `claude` process outside the panel uses it.

### Is Thoth made by Anthropic or OpenAI?

No. It is an independent open-source project.

### Is Thoth free?

Yes. It is open source under the MIT license.

### I found a bug or have an idea?

Open an [issue](https://github.com/WayneWei228/thoth/issues) on GitHub.

## Files

| Path | Purpose |
| --- | --- |
| `server.ts` | Backend: tmux bridge, state, actions, router, terminal streaming |
| `macos/` | Native app (Swift + AppKit, SwiftTerm) and its build script |
| `brain/` | Central brain: collector (each device), index + API (always-on Mac) |
| `public/` | Web UI (fallback) |
| `bin/thoth` | Launcher command |
| `scripts/` | Install script, services, setup of a computer |
| `lib/` | Screen parser and router (pure) |

Runtime files: `~/.config/cc-panel/` (`server.log`, `routes.json`, `router/`, `sessions.conf`).

Instances: `CC_PANEL_PORT`, `CC_PANEL_TMUX_SOCKET` (`tmux -L`) and `CC_PANEL_HOME` give a server its own port, tmux server and state folder (`lib/instance.ts`). The app reads the same settings from its Info.plist (`CCPanelPort`, `CCPanelTmuxSocket`, `CCPanelHome`, `CCPanelURLScheme`).

## License

Thoth is open source under the [MIT license](LICENSE).
