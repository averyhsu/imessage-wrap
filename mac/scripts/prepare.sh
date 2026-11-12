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
