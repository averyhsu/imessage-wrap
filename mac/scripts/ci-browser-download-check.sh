#!/bin/bash
# CI only. Downloads this run's artifacts the way a browser does (the REST API's
# archive_download_url, following the redirect, saving under the name the server gives),
# marks them quarantined as Safari would, expands them with the real Archive Utility and with
# ditto, and checks that what comes out is the Threadback.app that was built.
#
#   ci-browser-download-check.sh            exits 1 if the owner's download does not give a
#                                           working Threadback.app in one expansion
#
# Needs: GH_TOKEN (the job token, with actions: read), GITHUB_REPOSITORY, GITHUB_RUN_ID,
#        WORK, OUT, SHOTS. Artifacts: "Threadback-for-Mac.zip" (uploaded with archive: false)
#        and "diagnosis-nested-zip" (the same zip inside an artifact zip, the old way).
set -uo pipefail

REL="$WORK/release-dd/Build/Products/Release/Threadback.app"
UPLOADED="$OUT/download/Threadback-for-Mac.zip"
ROOT="$WORK/browser"
API="https://api.github.com/repos/$GITHUB_REPOSITORY"
FAIL=0
rm -rf "$ROOT"
mkdir -p "$ROOT"

say() { echo "$@"; }
info() { echo "$@" >&2; }
sha() { shasum -a 256 "$1" | cut -c1-64; }
tree_hash() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | shasum -a 256 | cut -c1-64; }

LIST="$ROOT/artifacts.json"
curl -sS -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/actions/runs/$GITHUB_RUN_ID/artifacts?per_page=100" > "$LIST"
say "artifacts of this run (name, bytes):"
python3 -c 'import json,sys
for a in json.load(open(sys.argv[1]))["artifacts"]:
    print("  %s  %s" % (a["name"], a["size_in_bytes"]))' "$LIST"

url_for() {
  python3 -c 'import json,sys
for a in json.load(open(sys.argv[1]))["artifacts"]:
    if a["name"] == sys.argv[2]:
        print(a["archive_download_url"])' "$LIST" "$1"
}

# fetch NAME DIR: like a browser, follow the redirect and keep the server's file name.
fetch() {
  local name="$1" dir="$2" url
  url="$(url_for "$name")"
  mkdir -p "$dir"
  if [ -z "$url" ]; then info "artifact $name not found"; return 1; fi
  (cd "$dir" && curl -sSL -OJ -D "$ROOT/headers-$name.txt" -H "Authorization: Bearer $GH_TOKEN" "$url")
  info "downloaded $name: content-type $(grep -i '^content-type' "$ROOT/headers-$name.txt" | tail -1 | tr -d '\r' | cut -d' ' -f2-);" \
      "disposition $(grep -i '^content-disposition' "$ROOT/headers-$name.txt" | tail -1 | tr -d '\r' | cut -d' ' -f2- || true)"
  local file
  file="$(ls -t "$dir" | head -1)"
  info "  saved as: $file ($(stat -f %z "$dir/$file") bytes)"
  # What Safari or Chrome adds to a download.
  xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$dir/$file"
  echo "$dir/$file"
}

# archive_utility FILE: expand with the real Archive Utility, default settings; wait for it.
archive_utility() {
  local file="$1" dir
  dir="$(dirname "$file")"
  open -a "Archive Utility" "$file"
  for _ in $(seq 1 60); do
    sleep 1
    pgrep -x "Archive Utility" > /dev/null || break
  done
  if pgrep -x "Archive Utility" > /dev/null; then
    say "  Archive Utility is still open after 60 s (an error dialog?); screenshot taken, then it was closed"
    screencapture -x "$SHOTS/download-archive-utility-stuck.png" 2>/dev/null || true
    killall "Archive Utility" 2>/dev/null || true
  fi
  say "  after Archive Utility, the folder holds:"
  ls -la "$dir" | sed 's/^/    /'
}

# check_app APP LABEL: the app must be exactly the one that was built, and intact.
check_app() {
  local app="$1" label="$2" ok=1
  if [ ! -d "$app" ]; then say "  $label: NO Threadback.app"; return 1; fi
  if codesign --verify --deep --strict --verbose=2 "$app" > "$ROOT/codesign.txt" 2>&1; then
    say "  $label: codesign --verify --deep --strict: valid"
  else
    say "  $label: codesign FAILED: $(tr '\n' ' ' < "$ROOT/codesign.txt")"; ok=0
  fi
  if [ -x "$app/Contents/MacOS/Threadback" ]; then say "  $label: main executable is executable"; else say "  $label: main executable NOT executable"; ok=0; fi
  local a b
  a="$(tree_hash "$app")"; b="$(tree_hash "$REL")"
  if [ "$a" = "$b" ]; then say "  $label: every file identical to the build (tree sha256 ${a:0:16})"; else say "  $label: files DIFFER from the build ($a vs $b)"; ok=0; fi
  say "  $label: size $(du -sk "$app" | cut -f1) KB (build $(du -sk "$REL" | cut -f1) KB); quarantine: $(xattr -p com.apple.quarantine "$app" 2>/dev/null | cut -d';' -f1,3 || echo none)"
  say "  $label: Gatekeeper (spctl, expected to reject an ad-hoc app): $(spctl -a -vv -t exec "$app" 2>&1 | head -2 | tr '\n' ' ')"
  [ "$ok" -eq 1 ]
}

say "== The owner's download (browser path)"
say "Archive Utility settings: $(defaults read com.apple.archiveutility 2>&1 | tr '\n' ' ' | cut -c1-300)"
say "uploaded file: Threadback-for-Mac.zip, $(stat -f %z "$UPLOADED") bytes, sha256 $(sha "$UPLOADED")"

say "-- artifact Threadback-for-Mac.zip (uploaded with archive: false): one file, the app zip itself"
F="$(fetch "Threadback-for-Mac.zip" "$ROOT/one/Downloads" | tail -1)"
if [ -f "$F" ]; then
  say "  downloaded sha256 $(sha "$F"); same bytes as uploaded: $([ "$(sha "$F")" = "$(sha "$UPLOADED")" ] && echo yes || echo NO)"
  archive_utility "$F"
  APPS="$(find "$ROOT/one/Downloads" -maxdepth 3 -name 'Threadback.app' -type d)"
  say "  Threadback.app found after ONE Archive Utility expansion: $(echo "$APPS" | grep -c . || true)"
  if ! check_app "$(echo "$APPS" | head -1)" "Archive Utility"; then FAIL=1; fi
  mkdir -p "$ROOT/one/ditto"
  ditto -x -k "$F" "$ROOT/one/ditto"
  check_app "$ROOT/one/ditto/Threadback.app" "ditto -x -k" || FAIL=1
else
  say "  DOWNLOAD FAILED"; FAIL=1
fi

say "-- diagnosis: the old artifact (the app zip inside the artifact's own zip)"
N="$(fetch "diagnosis-nested-zip" "$ROOT/nested/Downloads" | tail -1)"
if [ -f "$N" ]; then
  say "  outer zip, the entry for the inner file (zipinfo -v):"
  zipinfo -v "$N" 2>&1 | grep -E "Central directory entry|file system or operating system of origin|version of encoding software|minimum software version|compression method|file security status|extended local header|file last modified|32-bit CRC|compressed size|uncompressed size|length of filename|length of extra field|Zip64|There is no file comment|ZIP64|zip64" | sed 's/^/    /' | head -24
  zipinfo "$N" 2>&1 | sed 's/^/    /' | head -6
  mkdir -p "$ROOT/nested/ditto"
  ditto -x -k "$N" "$ROOT/nested/ditto"
  INNER="$ROOT/nested/ditto/Threadback-for-Mac.zip"
  if [ -f "$INNER" ]; then
    say "  inner file via ditto: $(stat -f %z "$INNER") bytes, sha256 $(sha "$INNER"); same as uploaded: $([ "$(sha "$INNER")" = "$(sha "$UPLOADED")" ] && echo yes || echo NO)"
    say "  inner file type: $(file -b "$INNER")"
  else
    say "  ditto produced: $(ls "$ROOT/nested/ditto" | tr '\n' ' ')"
  fi
  archive_utility "$N"
  for f in "$ROOT"/nested/Downloads/*; do
    [ -f "$f" ] || continue
    say "  file after Archive Utility: $(basename "$f"), $(stat -f %z "$f") bytes, sha256 $(sha "$f" | cut -c1-16), type: $(file -b "$f" | cut -c1-80)"
  done
  APPS="$(find "$ROOT/nested/Downloads" -maxdepth 4 -name 'Threadback.app' -type d)"
  say "  Threadback.app after Archive Utility on the old artifact: $(echo "$APPS" | grep -c . || true)"
  INNER_AU="$(find "$ROOT/nested/Downloads" -mindepth 1 -maxdepth 2 -name '*.zip' ! -path "$N" | head -1)"
  if [ -n "$INNER_AU" ]; then
    say "  Archive Utility left an inner zip: $(basename "$INNER_AU"); expanding that with Archive Utility too"
    archive_utility "$INNER_AU"
    APPS="$(find "$ROOT/nested/Downloads" -maxdepth 4 -name 'Threadback.app' -type d)"
    say "  Threadback.app after the second expansion: $(echo "$APPS" | grep -c . || true)"
  fi
  [ -n "$APPS" ] && check_app "$(echo "$APPS" | head -1)" "old artifact via Archive Utility" || true
else
  say "  (the diagnosis artifact could not be downloaded)"
fi

if [ "$FAIL" -eq 0 ]; then
  say "DOWNLOAD CHECK PASSED: the Threadback-for-Mac.zip artifact expands with one Archive Utility pass into the exact app that was built"
else
  say "DOWNLOAD CHECK FAILED"
fi
exit "$FAIL"
