#!/bin/bash
# One-line install of Thoth (macOS or Linux), for a person who has no copy of the code:
#   curl -fsSL <release address>/install.sh | bash
# It downloads the release bundle, checks its SHA-256, unpacks it to
# ~/.local/share/claude-panel/app and runs the bundle's own scripts/install.sh.
# Run the same line again to update.
#
# This file is the source. The release build writes the bundle address into the copy that
# is published as install.sh; the source has none, so the code holds no account name.
#   CC_PANEL_BUNDLE_URL   another address of claude-panel.tgz (claude-panel.tgz.sha256 next to it)
set -u
BUNDLE_URL="${CC_PANEL_BUNDLE_URL:-@BUNDLE_URL@}"
SHARE="$HOME/.local/share/claude-panel"
APP="$SHARE/app"
die() { printf '\nInstall stopped: %s\n' "$*"; exit 1; }

# Everything is in main(), called on the last line: bash runs nothing from a download that
# stopped half way.
main() {
  case "$BUNDLE_URL" in
    @*@) die "this copy of the installer has no download address. Get install.sh from the project's Releases page, or set CC_PANEL_BUNDLE_URL to the address of claude-panel.tgz." ;;
  esac
  command -v curl >/dev/null 2>&1 || die "'curl' is missing. Install it, then run this again."
  command -v tar >/dev/null 2>&1 || die "'tar' is missing. Install it, then run this again."

  # tmp is not local: the EXIT trap runs after main() has returned (a local was unset by then:
  # "tmp: unbound variable" at the end of every run, and the folder stayed; found on a cloud Ubuntu)
  local want got
  tmp="$(mktemp -d)" || die "cannot make a temporary folder."
  trap 'rm -rf "$tmp"' EXIT

  printf '== Downloading Thoth\n'
  curl -fsSL "$BUNDLE_URL" -o "$tmp/bundle.tgz" || die "the download failed: $BUNDLE_URL
  Check the internet connection and try again."
  want="$(curl -fsSL "$BUNDLE_URL.sha256" 2>/dev/null | awk 'NR==1 {print $1}')"
  [ -n "$want" ] || die "the checksum file is missing: $BUNDLE_URL.sha256"
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/bundle.tgz" | awk '{print $1}')"
  else got="$(shasum -a 256 "$tmp/bundle.tgz" | awk '{print $1}')"; fi
  [ "$got" = "$want" ] || die "the download does not match its checksum. Nothing was installed. Try again."

  mkdir -p "$SHARE" || die "cannot write to $SHARE"
  rm -rf "$SHARE/app.new" && mkdir "$SHARE/app.new" || die "cannot write to $SHARE"
  tar xzf "$tmp/bundle.tgz" -C "$SHARE/app.new" --strip-components 1 || die "the bundle did not unpack."
  [ -f "$SHARE/app.new/scripts/install.sh" ] || die "the download is not a Thoth bundle."

  if [ -d "$APP" ]; then
    printf '== Updating the copy in %s\n' "$APP"
    # keep the packages and the Mac app's build cache: the update then takes seconds, not minutes
    [ -d "$APP/node_modules" ] && mv "$APP/node_modules" "$SHARE/app.new/node_modules"
    [ -d "$APP/macos/.build" ] && mv "$APP/macos/.build" "$SHARE/app.new/macos/.build"
    # a running server holds the old files: stop it, the installer's last step starts the new one
    # (Claude sessions keep running in tmux)
    # (a copy from before the rename has bin/cc-panel, a newer one bin/thoth)
    for old in "$APP/bin/thoth" "$APP/bin/cc-panel"; do
      [ -x "$old" ] && { "$old" stop >/dev/null 2>&1 </dev/null || true; break; }
    done
    rm -rf "$SHARE/app.old" && mv "$APP" "$SHARE/app.old" || die "cannot replace $APP"
  fi
  mv "$SHARE/app.new" "$APP" || die "cannot write $APP"
  rm -rf "$SHARE/app.old"

  # stdin is this script when it comes through a pipe: the installer must not read it
  bash "$APP/scripts/install.sh" </dev/null
}
main "$@"
