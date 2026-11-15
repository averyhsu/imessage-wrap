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
    story-1-playing) echo "Play the story: the bundled web story for the chosen chat, in its own window, on this Mac only." ;;
    story-2-next) echo "The story after pressing the right arrow key: the next slide." ;;
    onboarding-1-welcome) echo "First run, screen 1 of 3: what Threadback does. One button: Continue." ;;
    onboarding-2-connect) echo "Screen 2 of 3: connect your messages. The button opens the Open panel already inside ~/Library/Messages." ;;
    onboarding-2b-connected) echo "Screen 2 after the folder grant (fixture data in this run): connected, with the optional Contacts step for first names." ;;
    onboarding-3-choose-chat) echo "Screen 3 of 3: choose the chat. \"Turn on\" next to one chat; the consent text says replies come from your Apple ID." ;;
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
    echo "1. Open the run above while signed in to GitHub, scroll to **Artifacts** and click"
    echo "   **Threadback-for-Mac.dmg** (it downloads as that one file)."
    echo "2. Double-click **Threadback-for-Mac.dmg** in Downloads. Its window opens by itself and shows"
    echo "   the three steps: drag **Threadback** onto **Applications**; open it from Applications"
    echo "   (macOS says “Threadback” Not Opened: click **Done**); then System Settings > Privacy &"
    echo "   Security, scroll down, **Open Anyway**. See \`download-dmg-window.jpg\` and the"
    echo "   \`gatekeeper-*.jpg\` photos below for what each step looks like."
    echo ""
    echo "\`Threadback-for-Mac.zip\` is the same app as a plain zip (one double-click gives"
    echo "Threadback.app). Every run downloads both the way a browser does and checks them: the disk"
    echo "image opens its window by itself and holds the exact app that was built (signature valid,"
    echo "every file identical) next to an Applications shortcut; the zip expands with one pass of the"
    echo "real Archive Utility. See sections 13 and 14 of [MAC-APP-RESULTS.txt](MAC-APP-RESULTS.txt)."
    echo "The app is the universal Release build, ad-hoc signed (no Apple developer account), with no"
    echo "link in its replies until the story site is live. \`Threadback-debug-with-probes\` is the"
    echo "Debug build CI drives; you do not need it."
    echo ""
    echo "| File | What it shows |"
    echo "|------|---------------|"
    for file in "$stage"/*.jpg; do
      name="$(basename "$file" .jpg)"
      echo "| [\`$name\`]($name.jpg) | $(describe "$name") |"
    done
    echo ""
    for file in "$stage"/download-*.jpg "$stage"/gatekeeper-*.jpg "$stage"/card-*.jpg "$stage"/onboarding-*.jpg "$stage"/story-*.jpg "$stage"/lifecycle-*.jpg "$stage"/access-*.jpg "$stage"/automation-*.jpg "$stage"/contacts-*.jpg "$stage"/login-*.jpg "$stage"/system-*.jpg; do
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
