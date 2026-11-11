#!/usr/bin/env python3
"""Invented Messages data for trying the helper without touching real messages.

    python tests/mac/ci_fixture.py build OUTDIR      # the engine's fixture; prints the chat.db path
    python tests/mac/ci_fixture.py command DB [TEXT] # append one fresh command row (default "/wrapped 2026")
    python tests/mac/ci_fixture.py applescript DIR   # write the helper's AppleScript sources for osacompile

Used by CI for the dry-run pass and handy by hand:

    python tests/mac/ci_fixture.py build /tmp/fx
    wrapped agent --db /tmp/fx/mac/chat.db --contacts /tmp/fx/mac/AddressBook \\
        --chat taco --dry-run --once --state /tmp/fx/state.json     # first pass: starts from "now"
    python tests/mac/ci_fixture.py command /tmp/fx/mac/chat.db
    wrapped agent ... --dry-run --once                              # answers it into a folder

Everything is made up by tests/fixtures/build_fixture.py; nothing is read from a real device.
"""

import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
for path in (ROOT, HERE, os.path.join(ROOT, "tests", "fixtures")):
    if path not in sys.path:
        sys.path.insert(0, path)

APPLE_EPOCH = 978307200
LIVELY_CHAT = "chat100000000000000001"  # "Taco Tuesday Crew" in the engine fixture


def build(out_dir: str) -> str:
    import build_fixture

    info = build_fixture.build(out_dir)
    return os.path.join(out_dir, *info["paths"]["chat_db"].split("/"))


def add_command(db_path: str, text: str = "/wrapped 2026") -> int:
    """Append a command the way a current Mac stores typed text: ``text`` NULL,
    the string inside ``attributedBody``. Returns the new message ROWID."""
    from mac_support import attributed_body

    conn = sqlite3.connect(db_path)
    try:
        chat = conn.execute(
            "SELECT ROWID FROM chat WHERE chat_identifier = ? ORDER BY ROWID LIMIT 1", (LIVELY_CHAT,)
        ).fetchone()
        if chat is None:
            raise SystemExit(f"{db_path} is not the generated fixture (no chat {LIVELY_CHAT})")
        handle = conn.execute("SELECT MIN(ROWID) FROM handle").fetchone()[0] or 0
        apple_ns = int((time.time() - APPLE_EPOCH) * 1e9)
        cur = conn.execute(
            "INSERT INTO message (guid, text, attributedBody, handle_id, date, is_from_me) VALUES (?, NULL, ?, ?, ?, 0)",
            (f"FIXTURE-COMMAND-{time.time_ns()}", attributed_body(text), handle, apple_ns),
        )
        conn.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)", (chat[0], cur.lastrowid))
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


def write_applescript(out_dir: str) -> None:
    from wrapped.mac.send import LIST_CHATS_SCRIPT, SEND_SCRIPT

    os.makedirs(out_dir, exist_ok=True)
    for name, source in (("send.applescript", SEND_SCRIPT), ("list-chats.applescript", LIST_CHATS_SCRIPT)):
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as handle:
            handle.write(source)
    # Control for the compile check: the same script addressed to an app without
    # a "chat" class must NOT compile, which shows the check really reads the
    # Messages scripting dictionary.
    with open(os.path.join(out_dir, "control-wrong-app.applescript"), "w", encoding="utf-8") as handle:
        handle.write(SEND_SCRIPT.replace('tell application "Messages"', 'tell application "Finder"'))


def main(argv) -> int:
    if len(argv) >= 2 and argv[0] == "build":
        print(build(argv[1]))
        return 0
    if len(argv) >= 2 and argv[0] == "command":
        print(add_command(argv[1], argv[2] if len(argv) > 2 else "/wrapped 2026"))
        return 0
    if len(argv) >= 2 and argv[0] == "applescript":
        write_applescript(argv[1])
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
