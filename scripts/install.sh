#!/bin/bash
# Install Thoth for this user (macOS or Linux). No sudo: what it cannot install itself, it
# names with the exact command. After this, the panel's setup page guides the rest
# Safe to run again.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"; ARCH="$(uname -m)"
SHARE="$HOME/.local/share/claude-panel"
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nInstall stopped: %s\n' "$*"; exit 1; }
need_cmd() {  # name, package
  command -v "$1" >/dev/null 2>&1 && return 0
  case "$OS" in
    Darwin) hint="brew install $2"
      # a new Mac has no Homebrew (found by a test run)
      command -v brew >/dev/null 2>&1 || hint="$hint
  'brew' is Homebrew, the usual way to install such tools on a Mac. This Mac does not have it yet.
  Get it from https://brew.sh (one command, shown there), open a new terminal, then run the line above." ;;
    *) hint="sudo apt-get install -y $2   (Debian/Ubuntu)
    sudo dnf install -y $2       (Fedora/RHEL)
    sudo pacman -S --needed $2   (Arch)" ;;
  esac
  die "'$1' is missing. Install it, then run this script again:
    $hint"
}

step "1/5 Checking what this computer has"
need_cmd tmux tmux
need_cmd python3 python3
need_cmd curl curl
need_cmd tar tar
if [ "$OS" != Darwin ]; then
  # node-pty (the panel's terminal) has no Linux prebuild: npm compiles it with node-gyp, which
  # needs make, a C++ compiler and python3 (checked above). Found on a clean Ubuntu 24.04:
  # npm install failed with "not found: make". Checked here, before npm runs.
  missing=""
  for t in make g++; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
  [ -z "$missing" ] || die "the C/C++ build tools are missing (not found:$missing). The panel's terminal module is compiled during install. Install them, then run this script again:
    sudo apt-get install -y build-essential            (Debian/Ubuntu)
    sudo dnf install -y make gcc-c++                   (Fedora/RHEL)
    sudo pacman -S --needed base-devel                 (Arch)"
fi
say "The tools the panel needs are here."

step "2/5 Node.js 22.18+ (the panel's runtime; it runs the TypeScript files directly)"
NODE=""
for cand in "$SHARE/node/bin/node" "$(command -v node 2>/dev/null)"; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  # 22.18 is the first Node 22 that strips TypeScript types by default (server.ts runs without a build)
  ok=$("$cand" -p 'const [a,b]=process.versions.node.split(".").map(Number); a>22||(a===22&&b>=18)?1:0' 2>/dev/null || echo 0)
  if [ "$ok" = 1 ]; then NODE="$cand"; break; fi
done
if [ -z "$NODE" ]; then
  case "$OS-$ARCH" in
    Darwin-arm64) plat=darwin-arm64 ;; Darwin-x86_64) plat=darwin-x64 ;;
    Linux-x86_64) plat=linux-x64 ;; Linux-aarch64|Linux-arm64) plat=linux-arm64 ;;
    *) die "no Node.js 22 build for $OS $ARCH. Install Node.js 22 yourself (https://nodejs.org), then run this again." ;;
  esac
  say "No Node.js 22.18 or newer found (system: $(node --version 2>/dev/null || echo none)). Downloading the official Node.js 22 for this user only..."
  base="https://nodejs.org/dist/latest-v22.x"
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || die "cannot reach nodejs.org. Check the internet connection, or install Node.js 22 yourself."
  file=$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v22\.[0-9.]+-$plat\.tar\.gz$" | head -1)
  [ -n "$file" ] || die "nodejs.org lists no $plat build."
  want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2==f {print $1}')
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file" || die "the download of $file failed."
  if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp/$file" | awk '{print $1}'); else got=$(shasum -a 256 "$tmp/$file" | awk '{print $1}'); fi
  [ "$got" = "$want" ] || die "the Node.js download does not match its checksum. Try again."
  mkdir -p "$SHARE" && rm -rf "$SHARE/node" && tar xzf "$tmp/$file" -C "$SHARE" && mv "$SHARE/${file%.tar.gz}" "$SHARE/node"
  rm -rf "$tmp"
  NODE="$SHARE/node/bin/node"
fi
say "Using Node.js $("$NODE" --version) at $NODE"
export PATH="$(dirname "$NODE"):$PATH"

step "3/5 Panel files"
cd "$ROOT" && npm install --no-audit --no-fund --loglevel=error || die "npm install failed (see the lines above)."
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/thoth" "$HOME/.local/bin/thoth"
# The command had the name cc-panel before. Remove that name only when it is a link to this
# product's launcher (.../bin/cc-panel or .../bin/thoth). A real file, or a link to something
# else, is not ours and stays.
OLD_CMD="$HOME/.local/bin/cc-panel"
if [ -L "$OLD_CMD" ]; then
  case "$(readlink "$OLD_CMD")" in */bin/cc-panel|*/bin/thoth) rm -f "$OLD_CMD" && say "The command is now 'thoth'. Removed the old link ~/.local/bin/cc-panel." ;; esac
fi
# only in a git checkout (a downloaded bundle has no .git)
[ -d "$ROOT/.git" ] && [ -d "$ROOT/scripts/hooks" ] && git -C "$ROOT" config core.hooksPath scripts/hooks   # a development checkout only
# the /panel command for Claude Code (moves a terminal session into the panel)
mkdir -p "$HOME/.claude/commands"
ln -sf "$ROOT/claude-commands/panel.md" "$HOME/.claude/commands/panel.md"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Note: add ~/.local/bin to your PATH to run 'thoth' from any terminal:
    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile" ;; esac

step "4/5 Desktop app"
if [ "$OS" = Darwin ]; then
  # /usr/bin/swift exists on every Mac: without the Command Line Tools it is only a stub that fails.
  # So ask xcode-select (found on a cloud Mac with the tools removed: the build failed and the
  # message did not say why).
  if xcode-select -p >/dev/null 2>&1 && command -v swift >/dev/null; then "$ROOT/macos/build-app.sh" || say "The Mac app did not build; the web panel still works ('thoth web')."
  else say "The Xcode Command Line Tools are missing, so the Mac app is skipped. Install them, then run this again:
    xcode-select --install
  (the web panel works without them: 'thoth web')"; fi
else
  say "No desktop app on $OS: the panel runs as a web page (on this machine or from your laptop)."
fi

step "5/5 Claude Code"
if command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ]; then
  say "Claude Code found: $(command -v claude || echo "$HOME/.local/bin/claude")"
else
  say "Claude Code is not installed. The panel runs Claude Code sessions, so install it (and log in):
    curl -fsSL https://claude.ai/install.sh | bash"
fi

say ""
"$ROOT/bin/thoth" web
# The brain. On Linux nothing
# else starts it before 'thoth services install' (found by a test run:
# doctor said "brain is not running" right after the install). doctor --fix starts what is safe.
if [ "$OS" != Darwin ] && ! curl -sf --max-time 2 "http://127.0.0.1:${CC_BRAIN_PORT:-7879}/api/health" 2>/dev/null | grep -q '"ok"'; then
  if "$ROOT/scripts/services.sh" doctor --fix >/dev/null 2>&1 || curl -sf --max-time 2 "http://127.0.0.1:${CC_BRAIN_PORT:-7879}/api/health" 2>/dev/null | grep -q '"ok"'; then
    say "The brain is running. To keep the panel and the brain running after a reboot: thoth services install"
  else
    say "The brain did not start. Run: thoth doctor"
  fi
fi
say "Installed. Next: open the panel; its setup page connects your devices and the brain."
