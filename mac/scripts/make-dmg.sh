#!/bin/bash
# Builds Threadback-for-Mac.dmg: the app, an Applications shortcut and a background that
# shows the three install steps (drag, open, Open Anyway). Needs macOS, create-dmg
# (Homebrew) and the Debug app to render the background.
#
# usage: make-dmg.sh RELEASE_APP DEBUG_BINARY OUT.dmg
set -euo pipefail
APP="$1"
BIN="$2"
OUT="$3"
WORK="$(mktemp -d)"

"$BIN" --tb-dmg-background "$WORK/bg"
# One TIFF holding both resolutions, so Finder uses the sharp one on Retina screens.
tiffutil -cathidpicheck "$WORK/bg/background.png" "$WORK/bg/background@2x.png" -out "$WORK/background.tiff"

mkdir -p "$WORK/src"
ditto "$APP" "$WORK/src/Threadback.app"
rm -f "$OUT"
# create-dmg scripts Finder to save the window: size, icon view, background, positions.
# Window: 660 x 420 content; the background and the positions come from DMGBackground.swift.
create-dmg \
  --volname "Threadback" \
  --background "$WORK/background.tiff" \
  --window-pos 200 140 \
  --window-size 660 420 \
  --icon-size 112 \
  --text-size 13 \
  --icon "Threadback.app" 170 160 \
  --hide-extension "Threadback.app" \
  --app-drop-link 490 160 \
  "$OUT" "$WORK/src" || {
    # create-dmg exits 2 when it could not sign the image; any other failure is real.
    status=$?
    if [ "$status" -ne 2 ] || [ ! -f "$OUT" ]; then exit "$status"; fi
  }
hdiutil verify "$OUT"
echo "make-dmg: wrote $OUT ($(du -h "$OUT" | cut -f1))"
