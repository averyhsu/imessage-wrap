#!/bin/bash
# Runs xcodebuild quietly. The full output goes to a log file (uploaded as an artifact);
# only the lines that matter (errors, test results, the verdict, WRAPPED_NOTE lines printed
# by tests) reach the job log, so a failure can be read from the tail of the log.
#
# usage: ci-xcodebuild.sh <log file> <xcodebuild arguments...>
set -uo pipefail

LOG="$1"
shift
mkdir -p "$(dirname "$LOG")"

echo "+ xcodebuild $*"
START=$(date +%s)
xcodebuild "$@" > "$LOG" 2>&1
STATUS=$?
END=$(date +%s)
LINES=$(wc -l < "$LOG" | tr -d ' ')
echo "xcodebuild exited with status $STATUS after $((END - START))s ($LINES log lines in $LOG)"

PATTERN="(error:|[Ff]atal error|\*\* [A-Z ]+ \*\*|Test Case .* (passed|failed|skipped)|Test Suite '.*' (passed|failed)|Executed [0-9]+ tests?|Testing failed|Failing tests|: failed:|Undefined symbol|^ld: |Command [A-Za-z]+ failed|The following build commands failed|xcodebuild: error|Restarting after unexpected exit|crashed|nearly matches|WRAPPED_NOTE)"

echo "---- highlights ----"
grep -E "$PATTERN" "$LOG" | awk '!seen[$0]++' | cut -c1-700 | head -n 260 || true

if [ "$STATUS" -ne 0 ]; then
  echo "---- last 60 lines of $LOG ----"
  tail -n 60 "$LOG" | cut -c1-700
fi
exit "$STATUS"
