"""Read-only access to the Messages database for the helper's own needs.

The stats engine owns everything about *counting*. This module only covers what
the agent loop and the sender need to do their jobs: open ``chat.db`` safely,
see new rows, find the chat a row belongs to, and check that a send really
produced an outgoing row in the right chat.
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Set

APPLE_EPOCH = 978307200  # 2001-01-01T00:00:00Z as Unix seconds
GROUP_STYLE = 43  # chat.style: 43 = group, 45 = one-to-one

FDA_HINT = (
    "macOS is blocking access to your Messages database. Give Full Disk Access to "
    "the app you run this from (Terminal, iTerm, VS Code, ...):\n"
    "  1. Open System Settings > Privacy & Security > Full Disk Access\n"
    "  2. Turn it on for that app (use + to add it if it is not listed)\n"
    "  3. Quit and reopen the app, then run the command again\n"
    "Shortcut: open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'"
)


class ChatDbError(RuntimeError):
    """The Messages database could not be opened or read. ``hint`` says what to do."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


def default_db_path() -> Path:
    return Path.home() / "Library" / "Messages" / "chat.db"


def open_ro(db_path: os.PathLike) -> sqlite3.Connection:
    """Open the database read-only.

    ``mode=ro`` and never ``immutable=1``: an immutable connection ignores the
    write-ahead log and silently misses recent messages.
    """
    path = Path(db_path).expanduser()
    if not path.exists():
        # On a Mac without Full Disk Access the file can look missing as well.
        hint = FDA_HINT if _looks_like_messages_path(path) else ""
        raise ChatDbError(f"No Messages database at {path}", hint)
    uri = path.resolve().as_uri() + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=5.0)
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchall()
    except sqlite3.Error as exc:
        raise explain_db_error(exc, path) from exc
    conn.row_factory = sqlite3.Row
    return conn


def explain_db_error(exc: BaseException, path: os.PathLike) -> ChatDbError:
    """Turn a raw sqlite/OS error into one with instructions a person can follow."""
    text = str(exc).lower()
    denied = (
        "unable to open database file" in text
        or "authorization denied" in text
        or "operation not permitted" in text
        or "permission denied" in text
    )
    if denied:
        return ChatDbError(f"Cannot open {path}: {exc}", FDA_HINT)
    if "not a database" in text or "malformed" in text:
        return ChatDbError(f"{path} is not a readable Messages database: {exc}")
    return ChatDbError(f"Cannot read {path}: {exc}")


def _looks_like_messages_path(path: Path) -> bool:
    return "Library/Messages" in path.as_posix()


def apple_time_to_unix(value: object) -> float:
    """``message.date`` to Unix seconds (nanoseconds since 2001 when large, else seconds)."""
    try:
        v = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    if abs(v) > 1e11:
        v /= 1e9
    return v + APPLE_EPOCH


def message_columns(conn: sqlite3.Connection) -> Set[str]:
    """Column names of ``message``. Schemas vary between Macs, so probe, never assume."""
    return {row[1] for row in conn.execute("PRAGMA table_info(message)")}


def max_message_rowid(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(ROWID) FROM message").fetchone()
    return int(row[0] or 0)


@dataclass(frozen=True)
class NewRow:
    rowid: int
    unix_time: float
    is_from_me: bool
    text: Optional[str]
    attributed_body: Optional[bytes]
    associated_type: int
    item_type: int


def new_rows(conn: sqlite3.Connection, cursor: int, limit: int = 500) -> List[NewRow]:
    """Rows with ``ROWID > cursor`` in order. The text is *not* filtered in SQL:
    a typed command often lives only in ``attributedBody`` and must be decoded."""
    cols = message_columns(conn)
    body = "attributedBody" if "attributedBody" in cols else "NULL"
    assoc = "associated_message_type" if "associated_message_type" in cols else "0"
    item = "item_type" if "item_type" in cols else "0"
    sql = (
        f"SELECT ROWID, date, is_from_me, text, {body}, {assoc}, {item} "
        "FROM message WHERE ROWID > ? ORDER BY ROWID LIMIT ?"
    )
    out: List[NewRow] = []
    for r in conn.execute(sql, (int(cursor), int(limit))):
        blob = r[4]
        out.append(
            NewRow(
                rowid=int(r[0]),
                unix_time=apple_time_to_unix(r[1]),
                is_from_me=bool(r[2]),
                text=r[3] if isinstance(r[3], str) else None,
                attributed_body=bytes(blob) if isinstance(blob, (bytes, bytearray, memoryview)) else None,
                associated_type=int(r[5] or 0),
                item_type=int(r[6] or 0),
            )
        )
    return out


@dataclass(frozen=True)
class ChatRow:
    """One ``chat`` row: the exact thing a message is joined to."""

    rowid: int
    guid: str
    identifier: str
    display_name: str
    style: int

    @property
    def is_group(self) -> bool:
        return self.style == GROUP_STYLE


def chats_for_message(conn: sqlite3.Connection, message_rowid: int) -> List[ChatRow]:
    """The chat rows a message is joined to. Empty when the join row is not there yet."""
    rows = conn.execute(
        "SELECT c.ROWID, c.guid, c.chat_identifier, c.display_name, c.style "
        "FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id "
        "WHERE j.message_id = ? ORDER BY c.ROWID",
        (int(message_rowid),),
    ).fetchall()
    return [_chat_row(r) for r in rows]


def group_chat_rows(conn: sqlite3.Connection) -> List[ChatRow]:
    rows = conn.execute(
        "SELECT ROWID, guid, chat_identifier, display_name, style FROM chat WHERE style = ? ORDER BY ROWID",
        (GROUP_STYLE,),
    ).fetchall()
    return [_chat_row(r) for r in rows]


def _chat_row(r: Sequence) -> ChatRow:
    return ChatRow(
        rowid=int(r[0]),
        guid=str(r[1] or ""),
        identifier=str(r[2] or ""),
        display_name=str(r[3] or ""),
        style=int(r[4] or 0),
    )


def chat_rowids(conn: sqlite3.Connection, guids: Sequence[str], identifier: str = "") -> Set[int]:
    """Every ``chat.ROWID`` that is the same logical chat: any of the given GUID
    spellings, plus rows sharing the non-empty ``chat_identifier`` (the iMessage
    and SMS variants of one group)."""
    ids: Set[int] = set()
    guids = [g for g in guids if g]
    if guids:
        marks = ",".join("?" for _ in guids)
        ids.update(int(r[0]) for r in conn.execute(f"SELECT ROWID FROM chat WHERE guid IN ({marks})", guids))
    if identifier:
        ids.update(
            int(r[0]) for r in conn.execute("SELECT ROWID FROM chat WHERE chat_identifier = ?", (identifier,))
        )
    return ids


@dataclass(frozen=True)
class OutgoingRow:
    rowid: int
    chat_ids: Sequence[int]  # chats it is joined to; empty = orphan
    error: int
    has_attachment: bool
    text: Optional[str]
    attributed_body: Optional[bytes]


def outgoing_rows_after(conn: sqlite3.Connection, after_rowid: int) -> List[OutgoingRow]:
    """Outgoing (``is_from_me = 1``) rows newer than ``after_rowid`` with their joins."""
    cols = message_columns(conn)
    err = "m.error" if "error" in cols else "0"
    att = "m.cache_has_attachments" if "cache_has_attachments" in cols else "0"
    body = "m.attributedBody" if "attributedBody" in cols else "NULL"
    sql = (
        f"SELECT m.ROWID, {err}, {att}, m.text, {body}, j.chat_id "
        "FROM message m LEFT JOIN chat_message_join j ON j.message_id = m.ROWID "
        "WHERE m.ROWID > ? AND m.is_from_me = 1 ORDER BY m.ROWID"
    )
    by_id = {}
    for r in conn.execute(sql, (int(after_rowid),)):
        rowid = int(r[0])
        entry = by_id.setdefault(
            rowid,
            {
                "error": int(r[1] or 0),
                "att": bool(r[2]),
                "text": r[3] if isinstance(r[3], str) else None,
                "body": bytes(r[4]) if isinstance(r[4], (bytes, bytearray, memoryview)) else None,
                "chats": [],
            },
        )
        if r[5] is not None:
            entry["chats"].append(int(r[5]))
    return [
        OutgoingRow(rowid, tuple(e["chats"]), e["error"], e["att"], e["text"], e["body"])
        for rowid, e in sorted(by_id.items())
    ]
