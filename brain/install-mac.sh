#!/bin/bash
# Install the panel server and the brain as launchd agents on this Mac (the always-on device).
# They start at login and restart if they stop. This creates persistent background services:
# run it yourself when you decide to. It only calls scripts/services.sh (labels
# com.claudepanel.server and com.claudepanel.brain); an older agent is replaced when THOTH_LEGACY_MAC_LABEL names it.
#   brain/install-mac.sh            install or update
#   brain/install-mac.sh uninstall  remove
#   brain/install-mac.sh --dry-run  write the plists to a temp folder only
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-install}" in
  uninstall) exec "$HERE/../scripts/services.sh" uninstall ;;
  *) exec "$HERE/../scripts/services.sh" install "$@" ;;
esac
