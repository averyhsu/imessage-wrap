#!/bin/bash
# CI only. Photographs what macOS shows the first time someone opens the ad-hoc-signed app
# from a browser download: the "could not verify" dialog, then System Settings > Privacy &
# Security with its Open Anyway button, and what follows a click on it. Reads the exact words
# with UI scripting (System Events). Never types a password. Nothing here is faked: if macOS
# does not block the app on this runner, the output says so.
#
# usage: ci-gatekeeper-photos.sh RELEASE_APP SHOTS_DIR
set -uo pipefail
REL="$1"
SHOTS="$2"
GK="$HOME/Downloads/threadback-gatekeeper"
rm -rf "$GK"
mkdir -p "$GK"

limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }   # run a command for at most N seconds

# Every static text and button of the windows of the given processes, one per line.
read_ui() {
  limit 90 osascript - "$@" <<'APPLESCRIPT' 2>&1
on run argv
  set out to {}
  tell application "System Events"
    repeat with procName in argv
      if exists process (procName as text) then
        tell process (procName as text)
          repeat with w in windows
            set end of out to (procName as text) & " WINDOW: " & (name of w as text)
            try
              set items_ to entire contents of w
              repeat with e in items_
                try
                  set r to role of e
                  if r is "AXStaticText" or r is "AXButton" or r is "AXHeading" then
                    set v to ""
                    try
                      set v to (value of e) as text
                    end try
                    if v is "" or v is "missing value" then
                      try
                        set v to (name of e) as text
                      end try
                    end if
                    if v is not "" and v is not "missing value" then set end of out to (procName as text) & " " & r & ": " & v
                  end if
                end try
              end repeat
            end try
          end repeat
        end tell
      end if
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return out as text
end run
APPLESCRIPT
}

click_button() {  # process, button name
  limit 60 osascript - "$1" "$2" <<'APPLESCRIPT' 2>&1
on run argv
  set procName to item 1 of argv
  set buttonName to item 2 of argv
  tell application "System Events"
    tell process procName
      repeat with w in windows
        try
          repeat with e in (entire contents of w)
            try
              if role of e is "AXButton" and (name of e as text) is buttonName then
                try
                  perform action "AXScrollToVisible" of e
                end try
                click e
                return "clicked " & buttonName & " in " & procName
              end if
            end try
          end repeat
        end try
      end repeat
    end tell
  end tell
  return "no button " & buttonName & " in " & procName
end run
APPLESCRIPT
}

echo "== Gatekeeper on this runner"
echo "spctl --status: $(spctl --status 2>&1)"
echo "SIP: $(csrutil status 2>&1)"
ditto "$REL" "$GK/Threadback.app"
QUARANTINE="0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)"
find "$GK/Threadback.app" -print0 | xargs -0 xattr -w com.apple.quarantine "$QUARANTINE"
echo "quarantine set to: $QUARANTINE (as Safari writes it on a download)"
echo "spctl assessment: $(spctl -a -vv -t exec "$GK/Threadback.app" 2>&1 | tr '\n' ' ')"

echo "-- 1. open it, as a double-click does"
open "$GK/Threadback.app" 2>&1 || true
sleep 8
screencapture -x "$SHOTS/gatekeeper-1-first-open.png" 2>&1 || true
if pgrep -f "$GK/Threadback.app/Contents/MacOS/Threadback" > /dev/null; then
  echo "RESULT: the app RAN; macOS did not block it on this runner"
  BLOCKED=0
else
  echo "the app is not running (blocked, as expected)"
  BLOCKED=1
fi
echo "what is on screen (UI scripting):"
read_ui "CoreServicesUIAgent" "UserNotificationCenter" "Threadback" | sed 's/^/  /' | head -40
echo "click Done: $(click_button "CoreServicesUIAgent" "Done")"
sleep 2
pkill -f "$GK/Threadback.app/Contents/MacOS/Threadback" 2>/dev/null || true

echo "-- 2. System Settings > Privacy & Security"
LINK=""
for candidate in \
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Security" \
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension" \
  "x-apple.systempreferences:com.apple.preference.security?General"; do
  open "$candidate" 2>&1 || true
  sleep 10
  UI="$(read_ui "System Settings")"
  if echo "$UI" | grep -q "Open Anyway"; then
    LINK="$candidate"
    echo "deep link that shows the Open Anyway button: $candidate"
    break
  fi
  echo "deep link $candidate: no Open Anyway button visible in its window"
done
echo "$UI" | grep -i -E "WINDOW|Threadback|Open Anyway|blocked|security|developer|App Store|Allow applications" | sed 's/^/  /' | head -30
screencapture -x "$SHOTS/gatekeeper-2-privacy-security.png" 2>&1 || true

if [ -n "$LINK" ]; then
  echo "-- 3. click Open Anyway (no password is ever typed)"
  echo "  $(click_button "System Settings" "Open Anyway")"
  sleep 4
  screencapture -x "$SHOTS/gatekeeper-3-after-open-anyway.png" 2>&1 || true
  echo "  what is on screen now:"
  read_ui "System Settings" "CoreServicesUIAgent" "SecurityAgent" "UserNotificationCenter" | grep -v -E "AXStaticText: (General|Privacy|Appearance)" | sed 's/^/    /' | tail -30
  sleep 2
  screencapture -x "$SHOTS/gatekeeper-4-confirm.png" 2>&1 || true
  # Close whatever asks for a password or confirmation, then quit Settings.
  click_button "SecurityAgent" "Cancel" > /dev/null 2>&1 || true
  click_button "CoreServicesUIAgent" "Cancel" > /dev/null 2>&1 || true
fi
killall "System Settings" 2>/dev/null || true
for f in "$SHOTS"/gatekeeper-*.png; do [ -s "$f" ] || rm -f "$f"; done
echo "gatekeeper photos: $(ls "$SHOTS" | grep -c '^gatekeeper-' || true)"
echo "blocked on first open: $([ "$BLOCKED" -eq 1 ] && echo yes || echo no)"
exit 0
