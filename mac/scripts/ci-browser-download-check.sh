#!/bin/bash
# CI only. Checks the owner's download the way a person gets it: the file arrives in a
# Downloads folder with Safari's quarantine mark, the disk image is opened as a double-click
# opens it (its window must open by itself, with the app and an Applications shortcut) and the
# zip is expanded by the real Archive Utility. Each Threadback.app must be exactly the app
# that was built (signature valid, every file identical). Exits 1 otherwise.
#
#   ci-browser-download-check.sh --file DMG ZIP        the built files, before publishing
#   ci-browser-download-check.sh --url DMG_URL ZIP_URL  the published release assets, as a
#                                                       browser downloads them (no sign-in)
#
# Needs: WORK, SHOTS, and the Release build in $WORK/release-dd. GH_TOKEN is used only to
# tell a private repository apart from a broken link.
set -uo pipefail

MODE="$1"; DMG_SRC="$2"; ZIP_SRC="$3"
REL="$WORK/release-dd/Build/Products/Release/Threadback.app"
ROOT="$WORK/browser-$(date +%s)"
FAIL=0
mkdir -p "$ROOT/Downloads"

say() { echo "$@"; }
sha() { shasum -a 256 "$1" | cut -c1-64; }
tree_hash() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | shasum -a 256 | cut -c1-64; }
quarantine() { xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$1"; }
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }

# get SOURCE NAME: into Downloads, as a browser would, and quarantined. Prints the path.
get() {
  local src="$1" name="$2" dest="$ROOT/Downloads/$2"
  if [ "$MODE" = "--url" ]; then
    local code
    code="$(curl -sSL -o "$dest" -w '%{http_code}' "$src")"
    say "  GET $src -> HTTP $code, $(stat -f %z "$dest" 2>/dev/null || echo 0) bytes (no sign-in)" >&2
    if [ "$code" != "200" ]; then
      say "  the public link did not work (HTTP $code)" >&2
      rm -f "$dest"
      return 1
    fi
  else
    cp "$src" "$dest"
  fi
  quarantine "$dest"
  echo "$dest"
}

check_app() {
  local app="$1" label="$2" ok=1
  if [ ! -d "$app" ]; then say "  $label: NO Threadback.app"; return 1; fi
  if codesign --verify --deep --strict "$app" > "$ROOT/codesign.txt" 2>&1; then
    say "  $label: codesign --verify --deep --strict: valid"
  else
    say "  $label: codesign FAILED: $(tr '\n' ' ' < "$ROOT/codesign.txt")"; ok=0
  fi
  if [ -x "$app/Contents/MacOS/Threadback" ]; then say "  $label: main executable is executable"; else say "  $label: main executable NOT executable"; ok=0; fi
  local a b
  a="$(tree_hash "$app")"; b="$(tree_hash "$REL")"
  if [ "$a" = "$b" ]; then say "  $label: every file identical to the build (tree sha256 ${a:0:16})"; else say "  $label: files DIFFER from the build"; ok=0; fi
  [ "$ok" -eq 1 ]
}

say "== The owner's download ($([ "$MODE" = "--url" ] && echo "from the release page, as a browser gets it" || echo "the built files, before publishing"))"

say "-- Threadback-for-Mac.dmg"
D="$(get "$DMG_SRC" "Threadback-for-Mac.dmg")"
# A freshly replaced release asset can take a moment to reach the download servers.
for attempt in 1 2 3 4 5; do
  [ "$MODE" = "--url" ] && [ -f "$D" ] || break
  [ "$(sha "$D")" = "$(sha "$WORK/out/download/Threadback-for-Mac.dmg")" ] && break
  say "  the download is not this build's disk image yet (attempt $attempt); waiting"
  sleep 20
  rm -f "$D"
  D="$(get "$DMG_SRC" "Threadback-for-Mac.dmg")"
done
if [ -n "$D" ] && [ -f "$D" ]; then
  say "  sha256 $(sha "$D"); same bytes as built: $([ "$(sha "$D")" = "$(sha "$WORK/out/download/Threadback-for-Mac.dmg")" ] && echo yes || echo NO)"
  hdiutil detach "/Volumes/Threadback" > /dev/null 2>&1 || true
  open "$D"   # what a double-click does
  for _ in $(seq 1 60); do [ -d "/Volumes/Threadback/Threadback.app" ] && break; sleep 1; done
  sleep 5
  [ "$MODE" = "--url" ] && screencapture -x "$SHOTS/download-dmg-window.png" 2>/dev/null
  WINDOWS="$(limit 30 osascript -e 'tell application "Finder" to get name of every window' 2>&1)"
  say "  Finder windows after the double-click: $WINDOWS"
  if echo "$WINDOWS" | grep -q "Threadback"; then say "  the disk image window OPENED BY ITSELF"; else say "  the disk image window did NOT open by itself"; FAIL=1; fi
  if [ "$(readlink /Volumes/Threadback/Applications)" = "/Applications" ]; then say "  Applications shortcut: -> /Applications"; else say "  Applications shortcut MISSING"; FAIL=1; fi
  check_app "/Volumes/Threadback/Threadback.app" "disk image" || FAIL=1
  limit 30 osascript -e 'tell application "Finder" to close every window' > /dev/null 2>&1 || true
  hdiutil detach "/Volumes/Threadback" > /dev/null 2>&1 || hdiutil detach -force "/Volumes/Threadback" > /dev/null 2>&1 || true
else
  FAIL=1
fi

say "-- Threadback-for-Mac.zip"
Z="$(get "$ZIP_SRC" "Threadback-for-Mac.zip")"
if [ -n "$Z" ] && [ -f "$Z" ]; then
  mkdir -p "$ROOT/zip"
  mv "$Z" "$ROOT/zip/"
  Z="$ROOT/zip/Threadback-for-Mac.zip"
  open -a "Archive Utility" "$Z"
  for _ in $(seq 1 60); do sleep 1; pgrep -x "Archive Utility" > /dev/null || break; done
  killall "Archive Utility" 2>/dev/null || true
  say "  after one pass of Archive Utility: $(ls "$ROOT/zip" | tr '\n' ' ')"
  check_app "$ROOT/zip/Threadback.app" "zip via Archive Utility" || FAIL=1
else
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  say "DOWNLOAD CHECK PASSED: the disk image opens its window by itself with the exact app and an Applications shortcut; the zip expands with one pass of Archive Utility into the exact app"
else
  say "DOWNLOAD CHECK FAILED"
fi
exit "$FAIL"
