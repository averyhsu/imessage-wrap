#!/usr/bin/env bash
# Threadback installer: your group chat's year in review, answered in the thread.
#
#   curl -fsSL https://raw.githubusercontent.com/averyhsu/imessage-wrap/main/install.sh | bash
#
# What it does, and nothing else:
#   - checks for macOS and Python 3.9+
#   - creates a private Python environment in ~/.threadback/venv
#   - installs this project and Pillow into it (from GitHub; no sudo, nothing system-wide)
#   - puts two small launchers, `wrapped` and `threadback`, in ~/.local/bin
#
# It never sends a message, never reads your messages, and never asks for a password.
#
# Remove everything again:
#   curl -fsSL https://raw.githubusercontent.com/averyhsu/imessage-wrap/main/install.sh | bash -s -- --uninstall
#
# Settings (environment variables, mostly for testing):
#   THREADBACK_SOURCE   what pip installs (default: the GitHub tarball of THREADBACK_REF)
#   THREADBACK_REF      branch to install (default: main)
#   THREADBACK_HOME     where the private environment lives (default: ~/.threadback). Must be a
#                       folder of its own: new, empty, or one this installer created
#   THREADBACK_BIN      where the launchers go (default: ~/.local/bin)
#   THREADBACK_PYTHON   the python3 to use (default: the first python3 on PATH)
#   THREADBACK_ALLOW_NON_MACOS=1   install on Linux anyway (reading works, sending does not)

set -euo pipefail

REPO="averyhsu/imessage-wrap"
MARKER="# Installed by the Threadback installer (safe to delete; --uninstall removes it)"
STAMP_NAME=".installed-by-threadback"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() {
  warn ""
  warn "Threadback installer: $*"
  exit 1
}

usage() {
  say "Threadback installer"
  say ""
  say "  install.sh              install or update"
  say "  install.sh --uninstall  remove everything this installer created"
  say "  install.sh --help       show this text"
}

full_disk_access_steps() {
  say "Before the first run, let your terminal app read your Messages database:"
  say "  1. Open System Settings > Privacy & Security > Full Disk Access"
  say "  2. Turn it on for the app you type commands in (Terminal, iTerm, ...)"
  say "  3. Quit that app completely and open it again"
  say "Threadback only reads the database. Nothing is uploaded."
}

find_python() {
  # Prints the python3 to use, or explains what to do and returns 1.
  local candidate="${THREADBACK_PYTHON:-}"
  if [ -z "$candidate" ]; then
    candidate="$(command -v python3 || true)"
  fi
  if [ -z "$candidate" ]; then
    warn "Threadback needs Python 3.9 or newer, and this computer has no python3."
    if [ "$(uname -s)" = "Darwin" ]; then
      warn "The simplest way to get it on a Mac is Apple's Command Line Tools:"
      warn "    xcode-select --install"
      warn "Click Install in the window that opens, wait for it to finish, then run this installer again."
    fi
    return 1
  fi
  if [ "$(uname -s)" = "Darwin" ] && [ "$candidate" = "/usr/bin/python3" ] && ! xcode-select -p >/dev/null 2>&1; then
    # /usr/bin/python3 is only a placeholder until Apple's Command Line Tools are installed.
    warn "Python is part of Apple's Command Line Tools, which are not installed on this Mac yet."
    warn "A window from macOS should open now offering to install them. Click Install, wait for"
    warn "it to finish (a few minutes), then run this installer again."
    xcode-select --install >/dev/null 2>&1 || true
    return 1
  fi
  if ! "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
    local found
    found="$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
    warn "Threadback needs Python 3.9 or newer; $candidate is ${found:-not usable}."
    warn "Install a current Python from https://www.python.org/downloads/ (or: brew install python),"
    warn "then run this installer again."
    return 1
  fi
  printf '%s\n' "$candidate"
}

write_launcher() {
  # write_launcher NAME: a tiny script that runs the CLI from the private environment.
  local name="$1" target="$BIN_DIR/$1"
  if [ -e "$target" ] && ! grep -qF "$MARKER" "$target" 2>/dev/null; then
    warn "Note: $target already exists and is not ours, so it was left alone."
    return 0
  fi
  {
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' "$MARKER"
    # shellcheck disable=SC2016  # the launcher, not this script, expands the variable
    printf 'THREADBACK_HOME="${THREADBACK_HOME:-%s}"\n' "$TB_HOME"
    printf '%s\n' 'export THREADBACK_HOME'
    # -I: isolated mode. Without it Python would put the current folder first on its
    # module path, and a folder named "wrapped" there would be run instead of this install.
    printf 'exec "%s/bin/python" -I -m wrapped "$@"\n' "$VENV"
  } >"$target.tmp.$$"
  chmod 755 "$target.tmp.$$"
  mv -f "$target.tmp.$$" "$target"
}

canon() {
  # canon PATH: the absolute path with symlinks, "//", "." and ".." resolved. PATH does
  # not have to exist: its nearest existing ancestor is resolved and the rest appended.
  # Shell built-ins only, and every turn of the loop shortens the path.
  local path="$1" tail="" base
  [ -n "$path" ] || return 1
  case "$path" in
    /*) ;;
    *) path="$PWD/$path" ;;
  esac
  while [ ! -d "$path" ]; do
    while [ "${path%/}" != "$path" ]; do
      path="${path%/}"
    done
    base="${path##*/}"
    case "$base" in
      "" | . | ..) return 1 ;;
    esac
    tail="/$base$tail"
    path="${path%/*}"
    if [ -z "$path" ]; then
      path="/"
    fi
  done
  path="$(cd "$path" 2>/dev/null && pwd -P)" || return 1
  while [ "${path#//}" != "$path" ]; do
    path="/${path#//}" # the shell keeps a leading "//" as it was typed; it is still the root
  done
  if [ "$path" = "/" ]; then
    path=""
  fi
  if [ -z "$path$tail" ]; then
    printf '/\n'
  else
    printf '%s\n' "$path$tail"
  fi
}

safe_home() {
  # Is THREADBACK_HOME a folder we may treat as ours? Compared in canonical form, so
  # "$HOME//", "$HOME/.", a symlink to the home folder and the like are all caught.
  # Never the root, the home folder, or anything the home folder lives inside.
  # On success TB_HOME and VENV are replaced by their canonical forms.
  local home_c tb_c
  home_c="$(canon "$HOME")" || return 1
  tb_c="$(canon "$TB_HOME")" || return 1
  [ -n "$tb_c" ] || return 1
  [ "$tb_c" != "/" ] || return 1
  [ "$tb_c" != "$home_c" ] || return 1
  case "$home_c/" in
    "$tb_c"/*) return 1 ;;
  esac
  TB_HOME="$tb_c"
  VENV="$TB_HOME/venv"
  return 0
}

only_helper_files() {
  # True if the folder holds nothing but files the helper itself writes there.
  local entry
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "${entry##*/}" in
      state.json | state.json.lock | agent.log) ;;
      *) return 1 ;;
    esac
  done
  return 0
}

uninstall() {
  # Removes exactly what the installer and the helper wrote, by name: the two
  # launchers (only if they carry our marker), the Python environment, the stamp
  # and the helper's own three files. The folder itself goes only if that leaves
  # it empty. Nothing is ever removed recursively except the environment.
  local removed=0 name target
  for name in wrapped threadback; do
    target="$BIN_DIR/$name"
    if [ -f "$target" ] && grep -qF "$MARKER" "$target" 2>/dev/null; then
      rm -f "$target"
      say "Removed $target"
      removed=1
    fi
  done
  if [ -d "$TB_HOME" ] || [ -L "$TB_HOME" ]; then
    if ! safe_home; then
      warn "Left $TB_HOME alone: that is not a folder Threadback may touch."
    elif [ ! -f "$TB_HOME/$STAMP_NAME" ]; then
      warn "Left $TB_HOME alone: it does not look like a folder this installer created."
    else
      if [ -L "$VENV" ]; then
        rm -f "$VENV" # a link: remove the link, never what it points to
      elif [ -d "$VENV" ]; then
        if [ -f "$VENV/pyvenv.cfg" ]; then
          rm -rf "$VENV"
        else
          warn "Left $VENV alone: it is not a Python environment."
        fi
      fi
      for name in state.json state.json.lock agent.log "$STAMP_NAME"; do
        if [ -f "$TB_HOME/$name" ] || [ -L "$TB_HOME/$name" ]; then
          rm -f "$TB_HOME/$name"
        fi
      done
      if rmdir "$TB_HOME" 2>/dev/null; then
        say "Removed $TB_HOME"
      else
        say "Removed Threadback's files from $TB_HOME."
        say "The folder itself stays, because it holds files Threadback did not create:"
        for target in "$TB_HOME"/* "$TB_HOME"/.[!.]* "$TB_HOME"/..?*; do
          if [ -e "$target" ] || [ -L "$target" ]; then
            say "    ${target##*/}"
          fi
        done
      fi
      removed=1
    fi
  fi
  if [ "$removed" = "0" ]; then
    say "Nothing to remove: Threadback is not installed here."
  else
    say ""
    say "Threadback is uninstalled. Two things only you can undo:"
    say "  - recap images it saved are still in ~/Pictures/Threadback (delete the folder if you like)"
    say "  - Full Disk Access for your terminal app: System Settings > Privacy & Security > Full Disk Access"
  fi
}

install() {
  local os python version
  os="$(uname -s)"
  if [ "$os" != "Darwin" ] && [ "${THREADBACK_ALLOW_NON_MACOS:-0}" != "1" ]; then
    die "this is for a Mac that is signed in to Messages (this computer runs $os).
On another computer you can still make a recap from a copy of chat.db or an iPhone
backup: see the README. To install here anyway, set THREADBACK_ALLOW_NON_MACOS=1."
  fi
  safe_home || die "THREADBACK_HOME must be a folder of its own (got '$TB_HOME').
It cannot be your home folder, a folder your home folder is inside, or the top of the disk."
  if [ -e "$TB_HOME" ] && [ ! -d "$TB_HOME" ]; then
    die "$TB_HOME exists and is not a folder."
  fi
  if [ -d "$TB_HOME" ] && [ ! -f "$TB_HOME/$STAMP_NAME" ] && ! only_helper_files "$TB_HOME"; then
    die "$TB_HOME already exists, is not empty and was not created by this installer.
Nothing was changed. Use a new or empty folder (the default is ~/.threadback)."
  fi

  python="$(find_python)" || exit 1
  version="$("$python" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
  say "Threadback installer"
  say "  Python:   $python ($version)"
  say "  Into:     $VENV"
  say "  Commands: $BIN_DIR/wrapped and $BIN_DIR/threadback"
  say "  From:     $SOURCE"
  say ""

  if [ ! -d "$TB_HOME" ]; then
    mkdir -p "$TB_HOME"
    chmod 700 "$TB_HOME" # the helper's state and log live here
  fi
  mkdir -p "$BIN_DIR"
  : >"$TB_HOME/$STAMP_NAME"

  if [ ! -x "$VENV/bin/python" ]; then
    say "Creating a private Python environment ..."
    "$python" -m venv "$VENV" || die "could not create the Python environment in $VENV.
If the message above mentions 'ensurepip', your Python is missing the venv module
(on Debian/Ubuntu: sudo apt install python3-venv)."
  else
    say "Updating the existing environment ..."
  fi

  local pip_flags="--quiet --disable-pip-version-check"
  # shellcheck disable=SC2086  # the flags are meant to be split into words
  "$VENV/bin/python" -m pip install $pip_flags --upgrade pip >/dev/null 2>&1 || true
  say "Installing Pillow (draws the recap image) ..."
  # shellcheck disable=SC2086
  "$VENV/bin/python" -m pip install $pip_flags "pillow>=10" ||
    die "could not install Pillow. Check your internet connection and run the installer again."
  say "Installing Threadback ..."
  # --force-reinstall --no-deps: always take the newest code, even when the version number is unchanged.
  # shellcheck disable=SC2086
  "$VENV/bin/python" -m pip install $pip_flags --force-reinstall --no-deps "$SOURCE" ||
    die "could not install Threadback from $SOURCE.
Check your internet connection and run the installer again."

  "$VENV/bin/python" -I -c 'import wrapped.mac.card as c; c.FontBook()' ||
    die "the install finished but the card renderer is not usable (see the message above)."
  "$VENV/bin/python" -I -m wrapped --help >/dev/null ||
    die "the install finished but the command does not start (see the message above)."

  write_launcher wrapped
  write_launcher threadback

  say ""
  say "Installed."
  say ""
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      say "One more step: $BIN_DIR is not on your PATH yet. Add it with:"
      say "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
      say "(or run the commands below as $BIN_DIR/threadback ...)"
      say ""
      ;;
  esac
  full_disk_access_steps
  say ""
  say "Then try it. None of these send anything:"
  say "    threadback doctor                              # can it read your messages?"
  say "    threadback chats                               # your group chats"
  say "    threadback preview --chat \"Name\" --open        # the recap it would send"
  say "When you are ready (it asks before it ever sends):"
  say "    threadback agent --chat \"Name\" --dry-run       # watch for /wrapped, send nothing"
  say "    threadback agent --chat \"Name\"                 # answer /wrapped in that chat"
  say ""
  say "Guide and 2-minute checklist: https://github.com/$REPO/blob/main/docs/MAC.md"
}

main() {
  if [ -z "${HOME:-}" ]; then
    die "HOME is not set."
  fi
  local ref="${THREADBACK_REF:-main}"
  SOURCE="${THREADBACK_SOURCE:-https://github.com/$REPO/archive/refs/heads/$ref.tar.gz}"
  TB_HOME="${THREADBACK_HOME:-$HOME/.threadback}"
  BIN_DIR="${THREADBACK_BIN:-$HOME/.local/bin}"
  VENV="$TB_HOME/venv"

  case "${1:-}" in
    "") install ;;
    --uninstall) uninstall ;;
    -h | --help) usage ;;
    *)
      usage >&2
      warn ""
      warn "Unknown option: $1"
      exit 2
      ;;
  esac
}

# Everything is inside functions and this is the last line, so a download that is
# cut off part-way runs nothing at all.
main "$@"
