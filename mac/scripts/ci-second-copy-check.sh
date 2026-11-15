#!/bin/bash
# CI only. A second copy of Threadback must not change anything the first copy uses before it
# knows it is the second: it is started from the command line with the flag that would wipe
# every setting (-TBResetOnboarding, Debug builds only) while a first copy runs, and the
# settings must be untouched. The control: the same launch with no first copy running does
# reset them, so the check can tell the difference.
#
#   ci-second-copy-check.sh APP_BINARY
set -uo pipefail

BIN="$1"
DOMAIN="io.github.averyhsu.threadback.mac"
FAIL=0
say() { echo "$@"; }
told() { defaults read "$DOMAIN" toldAboutMenuBar 2>/dev/null || echo "missing"; }
running() { pgrep -f "$BIN" | tr '\n' ' '; }

pkill -f "$BIN" 2>/dev/null; sleep 1
defaults write "$DOMAIN" toldAboutMenuBar -bool YES
say "before: toldAboutMenuBar $(told)"

# The first copy (no flags): it takes the single-instance lock.
"$BIN" > /dev/null 2>&1 &
FIRST=$!
sleep 5
say "first copy pid $FIRST running: $(kill -0 $FIRST 2>/dev/null && echo yes || echo NO)"

# The second copy, with the reset flag. It must quit by itself within a few seconds.
START=$(date +%s)
perl -e 'alarm 25; exec @ARGV' "$BIN" -TBResetOnboarding YES > /dev/null 2>&1
CODE=$?
ELAPSED=$(( $(date +%s) - START ))
say "second copy exited with $CODE after ${ELAPSED}s"
[ "$CODE" -eq 0 ] || { say "FAIL: the second copy did not quit cleanly"; FAIL=1; }
AFTER="$(told)"
say "after the second copy: toldAboutMenuBar $AFTER; first copy still running: $(kill -0 $FIRST 2>/dev/null && echo yes || echo NO)"
[ "$AFTER" = "1" ] || { say "FAIL: the second copy changed the settings"; FAIL=1; }
kill -0 $FIRST 2>/dev/null || { say "FAIL: the first copy is gone"; FAIL=1; }

# Control: alone, the same launch takes the lock and resets.
kill $FIRST 2>/dev/null; wait $FIRST 2>/dev/null; sleep 2
"$BIN" -TBResetOnboarding YES > /dev/null 2>&1 &
ALONE=$!
sleep 5
CONTROL="$(told)"
say "control (no first copy): toldAboutMenuBar $CONTROL (the reset removes it)"
[ "$CONTROL" = "missing" ] || { say "FAIL: the control did not reset, so this check proves nothing"; FAIL=1; }
kill $ALONE 2>/dev/null; wait $ALONE 2>/dev/null
pkill -f "$BIN" 2>/dev/null
say "still running: $(running)"

if [ "$FAIL" -eq 0 ]; then
  say "SECOND COPY CHECK PASSED: a second copy launched with the reset flag quit and changed no setting; alone, the same launch resets"
else
  say "SECOND COPY CHECK FAILED"
fi
exit "$FAIL"
