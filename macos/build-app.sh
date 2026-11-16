#!/bin/bash
# Build the native app (Swift + AppKit). The app uses server.js from this repository.
#   macos/build-app.sh [release|debug]   build "Thoth.app" and install it in ~/Applications
#   macos/build-app.sh --no-install      build "Thoth.app" in macos/build only (verify copies it;
#                                        the installed app is not touched)
# There is one app for the user: ~/Applications/Thoth.app, built from main.
# Branches and worktrees are tried with verify's isolated instances, not with a second app.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PORT=7878; CONFIG=release; INSTALL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-install) INSTALL=0 ;;
    *) CONFIG="$1" ;;
  esac
  shift
done
# A bundle id that an older build of the app had on this Mac (THOTH_LEGACY_BUNDLE_ID; empty: none).
# The app copies that UserDefaults domain once on its first launch under the new id
# (Sources/ClaudePanel/LegacyDefaults.swift). The id is not written here: it held a person's name.
LEGACY_BUNDLE_ID="${THOTH_LEGACY_BUNDLE_ID:-}"
NAME="Thoth"; BUNDLE_ID="com.claudepanel.app"; EXE="ClaudePanel"; SCHEME="claudepanel"

cd "$HERE"
# Swift 6.4 (macOS 26) builds with the "swiftbuild" engine by default. That engine compiles
# SwiftTerm's Shaders.metal with the `metal` compiler, which only Xcode has: on a Mac with only the
# Command Line Tools the build stops ("unable to spawn process 'metal'"; found on a cloud macOS 26).
# The older "native" engine copies the file and needs no `metal`; it is what every earlier Swift used.
BUILD=(swift build -c "$CONFIG")
if ! xcrun -f metal >/dev/null 2>&1 && swift build --help 2>/dev/null | grep -q -E '^ +native '; then
  BUILD+=(--build-system native)
fi
"${BUILD[@]}"
BIN="$("${BUILD[@]}" --show-bin-path)/ClaudePanel"

APP="$HERE/build/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$EXE"
[ -f "$HERE/Resources/AppIcon.icns" ] && cp "$HERE/Resources/AppIcon.icns" "$APP/Contents/Resources/"
# the title font of the Website look (Sources/ClaudePanel/Theme.swift serif). From public/, which every install has
mkdir -p "$APP/Contents/Resources/fonts" && cp "$REPO/public/fonts/instrument-serif-latin-400-normal.woff2" "$APP/Contents/Resources/fonts/"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 0.0.0)"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>$EXE</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>CCPanelRepo</key><string>$REPO</string>
  <key>CCPanelPort</key><string>$PORT</string>
  <key>CCPanelURLScheme</key><string>$SCHEME</string>
$( [ -n "$LEGACY_BUNDLE_ID" ] && printf '  <key>CCPanelLegacyDefaults</key><string>%s</string>' "$LEGACY_BUNDLE_ID" )
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>$BUNDLE_ID</string>
    <key>CFBundleURLSchemes</key><array><string>$SCHEME</string></array>
  </dict></array>
</dict></plist>
PLIST
# Sign with the local identity (scripts/signing-identity.sh) so the designated requirement is the
# same on every build and macOS keeps the Accessibility and Screen Recording grants. Without the
# identity: ad-hoc, which gives a new cdhash per build (the grants are lost after each rebuild).
# Signed by SHA-1 hash, not name, so a second certificate with the same name cannot make it fail.
# perl alarm: a keychain dialog must never hang an unattended build.
SIGN_NAME="${THOTH_SIGN_IDENTITY:-Thoth Local Signing}"
SIGN_HASH="$(security find-identity -p codesigning 2>/dev/null | grep -F "\"$SIGN_NAME\"" | awk 'NR==1{print $2}' || true)"
if [ -n "$SIGN_HASH" ] && perl -e 'alarm 30; exec @ARGV' codesign --force --deep --sign "$SIGN_HASH" "$APP" >/dev/null 2>&1; then
  echo "Signed with \"$SIGN_NAME\""
else
  echo "build-app: warning: signed ad-hoc (no \"$SIGN_NAME\" identity; run scripts/signing-identity.sh); macOS drops the app's permissions after each rebuild"
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
fi
if [ "$INSTALL" = 0 ]; then
  echo "Built $APP (port $PORT, not installed)"
  exit 0
fi
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/$NAME.app"
# the app had the name "Claude Panel" before the rename to Thoth: one app for the user, not two
rm -rf "$HOME/Applications/Claude Panel.app"
cp -R "$APP" "$HOME/Applications/"
echo "Installed $HOME/Applications/$NAME.app"
