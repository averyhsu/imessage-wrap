#!/bin/bash
# Prepares ios/WebBundle (gitignored) before `xcodegen generate`:
#
#   WebBundle/web/                 the story both targets bundle as a folder reference.
#                                  The real one (../web, minus web/make/) when it has an
#                                  index.html, otherwise ios/PlaceholderWeb.
#   WebBundle/fixtures/            the cross-language payload vector for the unit tests.
#   WebBundle/source.txt           "real" or "placeholder" (read by CI for its summary).
#
# Set WRAPPED_WEB=placeholder to force the placeholder story.
set -euo pipefail

IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/.." && pwd)"
BUNDLE_DIR="$IOS_DIR/WebBundle"
DEST="$BUNDLE_DIR/web"
REAL="$REPO_DIR/web"
PLACEHOLDER="$IOS_DIR/PlaceholderWeb"

rm -rf "$BUNDLE_DIR"
mkdir -p "$DEST" "$BUNDLE_DIR/fixtures"

if [ -f "$REAL/index.html" ] && [ "${WRAPPED_WEB:-auto}" != "placeholder" ]; then
  cp -R "$REAL/." "$DEST/"
  # web/make/ is the in-browser analyzer's build area; the app only needs the story.
  rm -rf "$DEST/make" "$DEST/node_modules"
  SOURCE="real"
else
  cp -R "$PLACEHOLDER/." "$DEST/"
  SOURCE="placeholder"
fi
find "$DEST" -name ".DS_Store" -delete
echo "$SOURCE" > "$BUNDLE_DIR/source.txt"

VECTOR="$REPO_DIR/tests/vectors/payload-v1.json"
if [ -f "$VECTOR" ]; then
  cp "$VECTOR" "$BUNDLE_DIR/fixtures/payload-v1.json"
else
  echo "warning: $VECTOR is missing; the payload vector tests will fail" >&2
fi

FILES=$(find "$DEST" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "$DEST" | cut -f1)
echo "sync-web: bundled the $SOURCE story ($FILES files, $SIZE) into $DEST"
