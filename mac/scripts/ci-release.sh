#!/bin/bash
# CI only. Puts the built disk image and zip on the repository's Releases page, where anyone
# can download them without signing in:
#
#   a push to claude/**  -> the rolling pre-release "mac-preview" (assets replaced first, then
#                           the tag moved to this commit). Link: .../releases/download/mac-preview/Threadback-for-Mac.dmg
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

**What it sends.** Threadback reads your Messages on this Mac. When anyone in a chat you turned on types /wrapped, your Mac replies from your Apple ID with three messages: a picture, a short text and a link. The picture and the link show the chat's name, first names and counts (never message text), and anyone the link is forwarded to can open it. Messages also loads a preview of the link from the site. Nothing else leaves your Mac.

**After each update**, macOS asks again for the Messages folder and whether Threadback may control Messages. Open Threadback once after updating, so the question does not first appear when a friend types /wrapped.

It needs a Mac with macOS 14 or later, signed in to Messages.

Version $VERSION, built from commit $SHORT on $DATE. Also available as Threadback-for-Mac.zip (the same app).
EOF
  gh release create "$TAG" "$DMG" "$ZIP" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" \
    --title "Threadback for Mac $VERSION" --notes-file "$NOTES" --latest
  DMG_URL="$REPO/releases/latest/download/Threadback-for-Mac.dmg"
  ZIP_URL="$REPO/releases/latest/download/Threadback-for-Mac.zip"
else
  TAG="mac-preview"
  cat > "$NOTES" <<EOF
**Rolling test build of Threadback for Mac.** Not a release: every push to a work branch replaces these files and moves this tag, so the download below can change at any time. For a stable version, use the latest release.

- Commit: $SHORT ($GITHUB_REF_NAME)
- Built: $DATE
- Not notarized: the first time you open it, macOS says "Threadback" Not Opened. Click **Done**, then System Settings > Privacy & Security > **Open Anyway**.

Download [Threadback-for-Mac.dmg]($REPO/releases/download/mac-preview/Threadback-for-Mac.dmg), double-click it and drag Threadback onto Applications.

A reply is three messages from your Apple ID: a picture, a short text and a link. The link shows the chat's name, first names and counts (never message text), and anyone it is forwarded to can open it. Each new build makes macOS ask again for the Messages folder and whether Threadback may control Messages.
EOF
  if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" > /dev/null 2>&1; then
    # Replace the files and the text first; move the tag to this commit only after that,
    # so the tag never names a commit whose files are not there yet.
    gh release upload "$TAG" "$DMG" "$ZIP" --repo "$GITHUB_REPOSITORY" --clobber
    gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --title "Threadback for Mac (rolling test build)" \
      --notes-file "$NOTES" --prerelease
    gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/tags/$TAG" -f sha="$GITHUB_SHA" -F force=true > /dev/null
  else
    gh release create "$TAG" "$DMG" "$ZIP" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" \
      --title "Threadback for Mac (rolling test build)" --notes-file "$NOTES" --prerelease
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
