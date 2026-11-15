#!/bin/bash
# CI only. Publishes the Mac app spike's screenshots (as small JPEGs) and MAC-APP-RESULTS.txt
# to docs/screenshots/mac/ on the branch that triggered the run, as a bot commit that does
# not trigger CI again (the development sandbox cannot download Actions artifacts).
#
# Needs: SHOTS (folder with *.png and MAC-APP-RESULTS.txt), BRANCH, RUN_URL.
set -euo pipefail

describe() {
  case "$1" in
    card-taco-2026) echo "The image friends receive, for the invented \"Taco Tuesday Crew\" chat, 2026: the site's own card (web/js/card.js) drawn by the app, 1080 x 1350." ;;
    card-hostile-name) echo "The same card with a hostile chat name and sender (direction overrides, a phone number, an address, control characters)." ;;
    card-long-name) echo "The same card with a very long chat name and sender name." ;;
    status-1-two-chats) echo "Opening Threadback with two chats on: each with its last reply, Play the story and Turn off; Add a chat, Pause all, Quit, Check for updates." ;;
    status-2-one-off-paused) echo "After turning one chat off and clicking Pause all." ;;
    story-1-playing) echo "Play the story: the bundled web story for the chosen chat, in its own window, on this Mac only." ;;
    story-2-next) echo "The story after pressing the right arrow key: the next slide." ;;
    onboarding-1-welcome) echo "First run, screen 1 of 3: what Threadback does. One button: Continue." ;;
    onboarding-2-connect) echo "Screen 2 of 3: connect your messages. The button opens the Open panel already inside ~/Library/Messages." ;;
    onboarding-2b-connected) echo "Screen 2 after the folder grant (fixture data in this run): connected, with the optional Contacts step for first names." ;;
    onboarding-3-choose-chat) echo "Screen 3 of 3: choose the chat. Every group chat, most recently active first, with a search field; \"Turn on\" next to each." ;;
    onboarding-3a-consent) echo "Turn on, before anything is on: the whole statement of what a reply is (three messages from your Apple ID, who can trigger it, what the link shows and that anyone it is forwarded to can open it). Nothing is on until Turn on in this sheet." ;;
    status-3-replies-changed) echo "A chat turned on when replies carried less: it is not answered until the owner clicks Keep on (or Turn off) in this sheet." ;;
    onboarding-3b-on) echo "Screen 3 after Turn on: the reply everyone in the chat would get (card and text), the login-item switch and Done." ;;
    onboarding-4-menu-bar) echo "The menu-bar item after onboarding (whole screen; best effort)." ;;
    access-1-open-panel-preset) echo "Proof 6b, real ~/Library/Messages on the runner: the Open panel as the app opens it (preset folder, \"Grant Access\")." ;;
    access-2-go-to-folder) echo "Proof 6b: Command-Shift-G (Go to Folder) inside the panel." ;;
    access-3-in-messages-folder) echo "Proof 6b: the panel inside ~/Library/Messages, before Grant Access." ;;
    access-4-after-grant) echo "Proof 6b: the app's window after Grant Access: connected, or the error it got." ;;
    access-5-contacts-prompt) echo "The Contacts prompt (optional names), if it appeared (whole screen)." ;;
    access-6-after-contacts) echo "The app after the Contacts prompt was answered (or not)." ;;
    access-7-relaunch-bookmark) echo "Proof 6b: a new launch reading through the stored bookmark (the report window)." ;;
    automation-*) echo "Proof 7: the screen while the app asks macOS for permission to control Messages." ;;
    contacts-1-screen) echo "The screen while the app asks for Contacts access." ;;
    login-item-1-screen) echo "Proof 8: the screen right after SMAppService.mainApp.register()." ;;
    download-dmg-window) echo "The downloaded disk image, double-clicked: the window Finder opens by itself, with the three install steps." ;;
    gatekeeper-1-first-open) echo "Opening the downloaded (quarantined) app for the first time: what macOS shows." ;;
    gatekeeper-2-privacy-security) echo "System Settings > Privacy & Security, opened with the deep link, where Open Anyway is." ;;
    gatekeeper-3-after-open-anyway) echo "Right after clicking Open Anyway (no password is ever typed in CI)." ;;
    gatekeeper-4-confirm) echo "A moment later: the confirmation or password prompt, if any." ;;
    lifecycle-0-dock-and-menu) echo "While the setup window is open Threadback is a normal app (Dock icon, app menu with Quit)." ;;
    lifecycle-1-window-closed) echo "With a chat on, after closing the window: still running, no window (menu bar only)." ;;
    lifecycle-2-opened-again) echo "Opening Threadback again while it runs: its status window with Turn off and Quit Threadback." ;;
    onboarding-4-keeps-answering) echo "Closing the window the first time with a chat on: it says Threadback keeps answering from the menu bar." ;;
    download-archive-utility-stuck) echo "Archive Utility was still open 60 s after it was asked to expand a download (whole screen)." ;;
    system-1-messages-first-launch) echo "The runner's Messages app on first launch (not signed in), captured with screencapture." ;;
    *) echo "" ;;
  esac
}

main() {
  local src="${SHOTS:?SHOTS is required}"
  local branch="${BRANCH:?BRANCH is required}"
  local dest="docs/screenshots/mac"
  local stage
  stage="$(mktemp -d)"
  shopt -s nullglob
  local count=0 file name
  for file in "$src"/*.png; do
    name="$(basename "$file" .png)"
    if [ -s "$file" ] && sips -s format jpeg -s formatOptions 70 --resampleWidth 900 "$file" --out "$stage/$name.jpg" > /dev/null 2>&1; then
      count=$((count + 1))
    else
      echo "publish: skipped $name (not a readable image)"
      rm -f "$stage/$name.jpg"
    fi
  done
  if [ -f "$src/MAC-APP-RESULTS.txt" ]; then
    cp "$src/MAC-APP-RESULTS.txt" "$stage/"
  fi
  {
    echo "# Threadback for Mac: spike screenshots"
    echo ""
    echo "Generated by the \`Mac app\` workflow (\`.github/workflows/mac-app.yml\`); do not edit by hand."
    echo "Every run replaces this folder. All chats, names and numbers are invented."
    echo ""
    echo "- Run: ${RUN_URL:-unknown}"
    echo "- Everything the run measured, as text: [MAC-APP-RESULTS.txt](MAC-APP-RESULTS.txt)"
    echo ""
    echo "## Download the app"
    echo ""
    echo "No sign-in needed: the builds are on the repository's Releases page."
    echo ""
    echo "- **Preview build** (the work branch, replaced by every build):"
    echo "  https://github.com/averyhsu/imessage-wrap/releases/download/mac-preview/Threadback-for-Mac.dmg"
    echo "- **Latest release** (from main):"
    echo "  https://github.com/averyhsu/imessage-wrap/releases/latest/download/Threadback-for-Mac.dmg"
    echo ""
    echo "Then: double-click **Threadback-for-Mac.dmg**; in the window that opens, drag **Threadback**"
    echo "onto **Applications**; open it from Applications. macOS says “Threadback” Not Opened (it is"
    echo "not notarized): click **Done**, then System Settings > Privacy & Security, scroll down,"
    echo "**Open Anyway**. \`Threadback-for-Mac.zip\` is the same app as a zip."
    echo ""
    echo "Every run checks the download before it publishes anything (quarantined like a browser"
    echo "download, opened with a double-click: the window must open by itself, with the exact app"
    echo "and an Applications shortcut) and again from the Releases page after publishing. See"
    echo "sections 13 and 15 of [MAC-APP-RESULTS.txt](MAC-APP-RESULTS.txt)."
    echo ""
    echo "| File | What it shows |"
    echo "|------|---------------|"
    for file in "$stage"/*.jpg; do
      name="$(basename "$file" .jpg)"
      echo "| [\`$name\`]($name.jpg) | $(describe "$name") |"
    done
    echo ""
    for file in "$stage"/download-*.jpg "$stage"/gatekeeper-*.jpg "$stage"/card-*.jpg "$stage"/onboarding-*.jpg "$stage"/story-*.jpg "$stage"/status-*.jpg "$stage"/lifecycle-*.jpg "$stage"/access-*.jpg "$stage"/automation-*.jpg "$stage"/contacts-*.jpg "$stage"/login-*.jpg "$stage"/system-*.jpg; do
      name="$(basename "$file" .jpg)"
      echo "### $name"
      echo ""
      echo "$(describe "$name")"
      echo ""
      echo "<img src=\"$name.jpg\" width=\"560\" alt=\"$name\">"
      echo ""
    done
  } > "$stage/README.md"

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  # The checkout keeps no credentials (persist-credentials: false): the publish job's token
  # is given to git here, for this push only.
  if [ -n "${GH_TOKEN:-}" ]; then
    git config --local "http.https://github.com/.extraheader" \
      "AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
  fi
  local attempt
  for attempt in 1 2 3 4 5 6; do
    git fetch --quiet --depth 1 origin "$branch"
    git checkout --quiet --force --detach FETCH_HEAD
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -R "$stage"/. "$dest"/
    git add -A "$dest"
    if git diff --cached --quiet; then
      echo "publish: nothing changed"
      return 0
    fi
    git commit --quiet -m "Update Mac app spike screenshots [skip ci]" -m "From ${RUN_URL:-a Mac app workflow run}."
    if git push --quiet origin "HEAD:refs/heads/$branch"; then
      echo "publish: pushed $count images to $dest on $branch ($(git rev-parse --short HEAD))"
      return 0
    fi
    echo "publish: push rejected (attempt $attempt); retrying"
    sleep $((attempt * 4))
  done
  echo "publish: giving up" >&2
  return 1
}

main "$@"
