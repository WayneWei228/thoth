# Thoth

**One memory for Claude Code and Codex, on every device you use. Even a brand-new one.**

Your agents forget, and they do not share:

- Claude Code does not know what Codex did, and Codex does not know what Claude Code did.
- What an agent learned on your laptop is not there on your other computer.
- So you explain the same context again.

Thoth fixes this:

- **Two tools, one memory.** Claude Code and Codex read the same memory. Each can use what the other did.
- **A new device knows everything from day one.** Connect it, and the agents there can use your work from every other device.
- **You stop repeating yourself.** Type a request once. A router sends it to the session that already has the context.
- **Yours.** The memory lives on your own server ([self-host guide](docs/self-host.md)) or on your Mac. Full transcripts stay on your devices.

Thoth is not made by Anthropic or OpenAI. It is open source (MIT).

## What you get

- **A panel for every session.** A native Mac app (and a web panel on Linux) shows each Claude Code and Codex session with its state: needs you, working, ready, not running. Sessions run in tmux, so closing the panel never stops one.
- **One request box.** Type a request once. A router picks the session that already has the context (or starts a new one in the right folder) and sends the text.
- **The brain.** An index of every session and memory file on every device, with search. Any session can ask it through MCP tools (`brain_search`, `brain_grep`, `brain_get_session`, `brain_remember`).
- **Move work between devices.** Continue a session from another computer on this Mac.

The command is `thoth`.

## Install

macOS or Linux. You need tmux, python3 and curl (the installer names the command if one is missing). On Linux the terminal module is compiled, so you also need make and a C++ compiler (`sudo apt-get install -y build-essential`; the installer checks this before it starts and names the command for apt, dnf and pacman). On a Mac without Homebrew the installer says where to get it.
Node.js 22 is downloaded for you if the computer has none or an older one. Claude Code (`claude`) runs the sessions.

**One line, no copy of the code needed** (from a release of this repository):

```bash
curl -fsSL https://github.com/WayneWei228/thoth/releases/latest/download/install.sh | bash
```

It downloads the release bundle, checks its SHA-256, unpacks it to `~/.local/share/claude-panel/app` and runs `scripts/install.sh` there. Run the same line again to update (your packages and sessions are kept; the server restarts).

**Windows:** the panel does not run on Windows (it needs tmux), and the line above fails in PowerShell (`bash` is not found). A Windows PC joins as a device: install the panel on a Mac or a Linux machine first, then run the PowerShell command that the panel's setup page shows for that PC. Its Claude Code and Codex sessions are then indexed and searchable.

**From a copy of the code:**

```bash
scripts/install.sh      # checks, Node.js 22 if needed, npm install, ~/.local/bin/thoth, the Mac app on macOS
thoth                   # macOS: the app (or double-click the app in ~/Applications)
thoth web               # web panel; on a machine without a desktop it prints how to open it from your laptop
```

Commands: `thoth web | stop | restart | status | tui | adopt | services | doctor`.

**Keep it running after logout and reboot (your choice):** `thoth services install` starts the server (7878) and the brain (7879) as background services: systemd user units plus linger on Linux, launchd agents (`com.claudepanel.server`, `com.claudepanel.brain`) on macOS. `thoth services status | uninstall` show or remove them. Something wrong? `thoth doctor` names each fault with its cause and the exact fix (server or brain down, port busy, tmux missing, Node older than 22, Claude Code missing or not logged in, a failing service, a full disk); `thoth doctor --fix` repairs what is safe.

**Move a session into the panel:** in any terminal (VS Code, iTerm, Terminal) where Claude Code is running, type `/panel`. That Claude exits, the panel resumes the same conversation, and the app opens it. For Codex, type `!thoth adopt` in Codex (after its first message): that Codex exits and the panel resumes it with `codex resume`. Rebuild the app: `macos/build-app.sh`. Run `scripts/signing-identity.sh` once before: it makes a local signing certificate, so macOS keeps the app's Accessibility and Screen Recording permissions after a rebuild.

## Native app

| Page | What it shows |
| --- | --- |
| Home (New Request) | Large Ask box; sessions that need you, with their choice buttons; recent requests and where they went |
| All Sessions | Sections per project folder with session cards (state, title, your last request, Claude's last reply) |
| Session | Header with actions, choice bar, Chat/Terminal switch: a rendered chat (markdown, shiki code with Copy, tables, KaTeX math, mermaid diagrams, image previews with Download, file cards, collapsible tool calls, thinking shown like the Claude app ("Thought process", "Thought for Ns", live Thinking… labels; needs Claude Code's `showThinkingSummaries` setting), Copy message, live activity line) or the native terminal (SwiftTerm on a grouped tmux session), composer |

Composer (Home and session page): paste (Cmd+V), drop or attach images, PDFs, text, data and code files; chips with thumbnail and remove; drafts kept per session.

Sidebar: New Request, All Sessions, then Needs You and Recent. Shortcuts: Cmd+N, Cmd+Shift+N, Cmd+0, Cmd+L, Cmd+1…9. Notifications and a Dock badge when a session needs you.

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
brain/install-mac.sh                  # optional: run serve as a launchd agent
```

- `brain/collector.py` runs on each device (Python stdlib, macOS/Windows/Linux), read-only, redacts secrets.
- The brain pulls over SSH and deploys the collector itself; no device opens a port.
- Same project across devices = same git remote (else same folder name).
- Phase 2: memories (Claude memory files, Codex AGENTS.md/memories) are shared too. `brain/mcp_server.py` gives any session the tools `brain_search`, `brain_project_context`, `brain_list_devices`, `brain_grep`, `brain_get_session`, `brain_remember`. The brain keeps the whole dialogue of every session: `brain_grep` searches it like grep on files, and `brain_get_session` reads the messages around a hit. Register it yourself: `claude mcp add brain -- python3 -I <repo>/brain/mcp_server.py`.
- Phase 3, handoff: `python3 brain/handoff.py --from <device> --sid <id> --to <device> --run panel|headless|none` moves the work (code as a git bundle through the brain, nothing pushed; the source is never touched) and starts an agent there with a handoff packet. In the app: All Devices → **Continue on This Mac**.

## How it works

```
 ┌────────────────── Thoth UI ─────────────────┐
 │ Ask box · session cards · terminal · buttons │
 └───────────────┬─────────────────────────────┘
        HTTP + WebSocket (127.0.0.1:7878)
 ┌───────────────┴─────────────────────────────┐
 │ server.js                                    │
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

## Router

The Ask box sends text to `POST /api/route`. A headless `claude -p --model haiku` call with a JSON schema reads each session's name, folder, title, last request, last reply and recent topics, and returns `send`, `new` or `ask`:

| Decision | Condition | Result |
| --- | --- | --- |
| send | confidence ≥ 0.75 | Text goes to that session; the UI opens it |
| new | confidence ≥ 0.75 | New session in that folder, then the text |
| ask | otherwise | Buttons to pick a session or a folder |

Messages wait until the target session is idle. A stopped session starts first. A session at a choice prompt is not interrupted. `CC_ROUTER_MODEL` sets the model.

## Files

| Path | Purpose |
| --- | --- |
| `server.js` | Backend: tmux bridge, state, actions, router, terminal streaming |
| `macos/` | Native app (Swift + AppKit, SwiftTerm) and its build script |
| `brain/` | Central brain: collector (each device), index + API (always-on Mac) |
| `public/` | Web UI (fallback) |
| `bin/thoth` | Launcher command |
| `scripts/` | Install script, services, pairing |
| `lib/` | Screen parser and router (pure) |

Runtime files: `~/.config/cc-panel/` (`server.log`, `routes.json`, `router/`, `sessions.conf`).

Instances: `CC_PANEL_PORT`, `CC_PANEL_TMUX_SOCKET` (`tmux -L`) and `CC_PANEL_HOME` give a server its own port, tmux server and state folder (`lib/instance.js`). The app reads the same settings from its Info.plist (`CCPanelPort`, `CCPanelTmuxSocket`, `CCPanelHome`, `CCPanelURLScheme`).
