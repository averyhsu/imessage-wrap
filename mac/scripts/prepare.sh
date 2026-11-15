#!/bin/bash
# Makes mac/Generated/AppIcon.xcassets from the iOS app icon (one mark everywhere).
# Run before `xcodegen generate`. Needs macOS (sips). The output is not committed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/../ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
SET="$HERE/Generated/AppIcon.xcassets/AppIcon.appiconset"
rm -rf "$HERE/Generated"
mkdir -p "$SET"
printf '{\n  "info" : { "author" : "xcode", "version" : 1 }\n}\n' > "$HERE/Generated/AppIcon.xcassets/Contents.json"
images=""
for size in 16 32 128 256 512; do
  for scale in 1 2; do
    px=$((size * scale))
    name="icon_${size}x${size}@${scale}x.png"
    sips -z "$px" "$px" "$SRC" --out "$SET/$name" > /dev/null
    images="$images{ \"filename\" : \"$name\", \"idiom\" : \"mac\", \"scale\" : \"${scale}x\", \"size\" : \"${size}x${size}\" },"
  done
done
printf '{\n  "images" : [ %s ],\n  "info" : { "author" : "xcode", "version" : 1 }\n}\n' "${images%,}" > "$SET/Contents.json"
echo "prepare: wrote $SET"

# The bundled web story (the same files as the site and the iOS app, minus the browser-only
# maker, the Mac page and the link-preview art), plus the Mac's card page next to it.
WEB="$HERE/../web"
DEST="$HERE/Generated/web"
mkdir -p "$DEST"
cp -R "$WEB/." "$DEST/"
rm -rf "$DEST/make" "$DEST/mac" "$DEST/node_modules"
rm -f "$DEST/assets/og.png" "$DEST/assets/og-video.mp4"
find "$DEST" -name ".DS_Store" -delete
cp "$HERE/Threadback/Card/mac-card.html" "$DEST/mac-card.html"
echo "prepare: bundled the web story ($(find "$DEST" -type f | wc -l | tr -d ' ') files, $(du -sh "$DEST" | cut -f1)) into $DEST"
