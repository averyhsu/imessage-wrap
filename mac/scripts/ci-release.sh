#!/bin/bash
# CI only. Puts the built disk image and zip on the repository's Releases page, where anyone
# can download them without signing in:
#
#   a push to claude/**  -> the rolling pre-release "mac-preview" (tag moved to this commit,
#                           assets replaced). Link: .../releases/download/mac-preview/Threadback-for-Mac.dmg
#   a push to main       -> a new release "mac-v<version>-<run number>", marked latest.
#                           Link: .../releases/latest/download/Threadback-for-Mac.dmg
#
# Prints the two download URLs as GitHub step outputs (dmg_url, zip_url, release_url, tag).
# Needs: GH_TOKEN (contents: write), GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF_NAME,
# GITHUB_RUN_NUMBER, GITHUB_OUTPUT, OUT, and the Release app in $WORK/release-dd.
set -euo pipefail

DMG="$OUT/download/Threadback-for-Mac.dmg"
ZIP="$OUT/download/Threadback-for-Mac.zip"
APP="$WORK/release-dd/Build/Products/Release/Threadback.app"
test -s "$DMG" && test -s "$ZIP" && test -d "$APP"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
SHORT="${GITHUB_SHA:0:7}"
DATE="$(date -u '+%Y-%m-%d %H:%M UTC')"
REPO="https://github.com/$GITHUB_REPOSITORY"
NOTES="$(mktemp)"

if [ "$GITHUB_REF_NAME" = "main" ]; then
  TAG="mac-v${VERSION}-${GITHUB_RUN_NUMBER}"
  cat > "$NOTES" <<EOF
Threadback for Mac: your group chat's year in review, answered right in the chat.

**Download [Threadback-for-Mac.dmg]($REPO/releases/download/$TAG/Threadback-for-Mac.dmg)**, then:

1. Double-click **Threadback-for-Mac.dmg**. In the window that opens, drag **Threadback** onto **Applications**.
2. Open Threadback from Applications. macOS says **"Threadback" Not Opened**, because it is not notarized by Apple: click **Done** (not Move to Trash).
3. Open **System Settings > Privacy & Security**, scroll down to Security and click **Open Anyway**, then confirm with your password or Touch ID. Threadback opens; this happens only once.

Threadback reads your Messages on this Mac only and never uploads them. It needs a Mac with macOS 14 or later, signed in to Messages.

Version $VERSION, built from commit $SHORT on $DATE. Also available as Threadback-for-Mac.zip (the same app).
EOF
  gh release create "$TAG" "$DMG" "$ZIP" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" \
    --title "Threadback for Mac $VERSION" --notes-file "$NOTES" --latest
  DMG_URL="$REPO/releases/latest/download/Threadback-for-Mac.dmg"
  ZIP_URL="$REPO/releases/latest/download/Threadback-for-Mac.zip"
else
  TAG="mac-preview"
  cat > "$NOTES" <<EOF
**Preview build of Threadback for Mac, for testing.** It is replaced by every new build of the work branch.

- Commit: $SHORT ($GITHUB_REF_NAME)
- Built: $DATE
- Not notarized: the first time you open it, macOS says "Threadback" Not Opened. Click **Done**, then System Settings > Privacy & Security > **Open Anyway**.

Download [Threadback-for-Mac.dmg]($REPO/releases/download/mac-preview/Threadback-for-Mac.dmg), double-click it and drag Threadback onto Applications.
EOF
  if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" > /dev/null 2>&1; then
    # Move the tag to this commit, then replace the files and the text.
    gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/tags/$TAG" -f sha="$GITHUB_SHA" -F force=true > /dev/null
    gh release upload "$TAG" "$DMG" "$ZIP" --repo "$GITHUB_REPOSITORY" --clobber
    gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --title "Threadback for Mac (preview build)" \
      --notes-file "$NOTES" --prerelease
  else
    gh release create "$TAG" "$DMG" "$ZIP" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" \
      --title "Threadback for Mac (preview build)" --notes-file "$NOTES" --prerelease
  fi
  DMG_URL="$REPO/releases/download/$TAG/Threadback-for-Mac.dmg"
  ZIP_URL="$REPO/releases/download/$TAG/Threadback-for-Mac.zip"
fi

RELEASE_URL="$REPO/releases/tag/$TAG"
{
  echo "tag=$TAG"
  echo "release_url=$RELEASE_URL"
  echo "dmg_url=$DMG_URL"
  echo "zip_url=$ZIP_URL"
} >> "$GITHUB_OUTPUT"
echo "== Published to the Releases page"
echo "release: $RELEASE_URL"
echo "disk image: $DMG_URL"
echo "zip: $ZIP_URL"
echo "commit: $SHORT; assets: $(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets -q '.assets[] | "\(.name) \(.size) bytes"' | tr '\n' ';')"
