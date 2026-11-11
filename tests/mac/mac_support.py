"""Shared helpers for the Mac-helper tests. Everything here is invented data.

Importing this module also puts the repository root on ``sys.path`` so the tests
run the same under ``pytest`` and ``python -m unittest discover -s tests/mac``.
"""

from __future__ import annotations

import copy
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from wrapped.mac.engine import ChatRef  # noqa: E402

APPLE_EPOCH = 978307200

SCHEMA = """
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT DEFAULT 'iMessage');
CREATE TABLE chat (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
    chat_identifier TEXT, service_name TEXT DEFAULT 'iMessage', display_name TEXT, room_name TEXT
);
CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, attributedBody BLOB,
    handle_id INTEGER DEFAULT 0, service TEXT DEFAULT 'iMessage', date INTEGER, is_from_me INTEGER DEFAULT 0,
    item_type INTEGER DEFAULT 0, group_action_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0,
    group_title TEXT, associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT,
    associated_message_emoji TEXT, thread_originator_guid TEXT, date_edited INTEGER DEFAULT 0,
    date_retracted INTEGER DEFAULT 0, message_summary_info BLOB, cache_has_attachments INTEGER DEFAULT 0,
    cache_roomnames TEXT, error INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, is_delivered INTEGER DEFAULT 0
);
CREATE TABLE chat_message_join (
    chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE (chat_id, handle_id));
CREATE TABLE attachment (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, filename TEXT, mime_type TEXT, is_sticker INTEGER DEFAULT 0
);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
"""


def attributed_body(text: str) -> bytes:
    """A typedstream ``NSAttributedString`` blob in the layout documented in
    docs/research/03 (what Messages stores when ``message.text`` is NULL)."""
    data = text.encode("utf-8")
    n = len(data)
    if n < 128:
        length = bytes([n])
    elif n < 65536:
        length = b"\x81" + n.to_bytes(2, "little")
    else:
        length = b"\x82" + n.to_bytes(4, "little")
    chars = len(text.encode("utf-16-le")) // 2
    run = bytes([chars]) if chars < 128 else b"\x81" + chars.to_bytes(2, "little")
    return (
        b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00"
        b"\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+"
        + length
        + data
        + b"\x86\x84\x02iI\x01"
        + run
        + b"\x92\x84\x84\x84\x0cNSDictionary\x00\x94\x84\x01i\x01\x92\x84\x96\x96"
        b"\x1d__kIMMessagePartAttributeName\x86\x92\x84\x84\x84\x08NSNumber\x00"
        b"\x84\x84\x07NSValue\x00\x94\x84\x01*\x84\x99\x99\x00\x86\x86\x86"
    )


def simple_decode(blob: Optional[bytes]) -> str:
    """Test-only decoder following the documented recipe (the real one is the engine's)."""
    if not blob:
        return ""
    i = blob.find(b"NSString")
    if i < 0:
        return ""
    j = blob.find(b"\x01+", i)
    if j < 0:
        return ""
    j += 2
    first = blob[j]
    if first == 0x81:
        n, j = int.from_bytes(blob[j + 1 : j + 3], "little"), j + 3
    elif first == 0x82:
        n, j = int.from_bytes(blob[j + 1 : j + 5], "little"), j + 5
    else:
        n, j = first, j + 1
    return blob[j : j + n].decode("utf-8", "replace")


class FixtureDb:
    """A generated Messages-shaped SQLite database (WAL mode, like the real one)."""

    def __init__(self, path: os.PathLike, wal: bool = True) -> None:
        self.path = Path(path)
        self.conn = sqlite3.connect(str(self.path))
        if wal:
            self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self._n = 0

    def close(self) -> None:
        self.conn.close()

    def add_handle(self, handle_id: str) -> int:
        cur = self.conn.execute("INSERT INTO handle (id) VALUES (?)", (handle_id,))
        self.conn.commit()
        return int(cur.lastrowid)

    def add_chat(
        self,
        identifier: str,
        display_name: str = "",
        style: int = 43,
        guid: Optional[str] = None,
        members: Optional[List[int]] = None,
    ) -> int:
        if guid is None:
            guid = f"any;{'+' if style == 43 else '-'};{identifier}"
        cur = self.conn.execute(
            "INSERT INTO chat (guid, style, chat_identifier, display_name) VALUES (?, ?, ?, ?)",
            (guid, style, identifier, display_name),
        )
        chat_id = int(cur.lastrowid)
        for h in members or []:
            self.conn.execute("INSERT OR IGNORE INTO chat_handle_join VALUES (?, ?)", (chat_id, h))
        self.conn.commit()
        return chat_id

    def add_message(
        self,
        text: Optional[str] = None,
        *,
        body: Optional[bytes] = None,
        chat: Optional[int] = None,
        is_from_me: bool = False,
        handle: int = 0,
        when: Optional[float] = None,
        associated_type: int = 0,
        item_type: int = 0,
        error: int = 0,
        attachment: bool = False,
    ) -> int:
        self._n += 1
        when = time.time() if when is None else when
        apple_ns = int((when - APPLE_EPOCH) * 1e9)
        cur = self.conn.execute(
            "INSERT INTO message (guid, text, attributedBody, handle_id, date, is_from_me, item_type, "
            "associated_message_type, cache_has_attachments, error, is_sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                f"FIXTURE-{self._n:08d}-0000-4000-8000-000000000000",
                text,
                body,
                handle,
                apple_ns,
                1 if is_from_me else 0,
                item_type,
                associated_type,
                1 if attachment else 0,
                error,
                1 if is_from_me else 0,
            ),
        )
        rowid = int(cur.lastrowid)
        if chat is not None:
            self.conn.execute(
                "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
                (chat, rowid, apple_ns),
            )
        self.conn.commit()
        return rowid

    def join(self, chat: int, message: int) -> None:
        self.conn.execute("INSERT OR IGNORE INTO chat_message_join (chat_id, message_id) VALUES (?, ?)", (chat, message))
        self.conn.commit()

    def max_rowid(self) -> int:
        return int(self.conn.execute("SELECT COALESCE(MAX(ROWID), 0) FROM message").fetchone()[0])


# -- invented stats --------------------------------------------------------------

NAMES = ["Maya", "Dev", "Priya", "Jonah", "Tess", "Marcus", "Lena", "Omar", "Ines", "Kofi", "Yuki", "Bea"]


def sample_stats(members: int = 7, messages: int = 48213, chat_name: str = "Dinner Club 🍝", label: str = "2026") -> dict:
    """A stats dict in the docs/SCHEMA.md §1 shape, scaled to any size. Invented."""
    members = max(1, members)
    listed = min(members, 12)
    weights = [1.0 / (i + 1.6) for i in range(listed)]
    total_w = sum(weights)
    counts = [int(messages * w / total_w) for w in weights]
    counts[0] += messages - sum(counts)
    senders = []
    for i in range(listed):
        c = counts[i]
        senders.append(
            {
                "name": NAMES[i % len(NAMES)] + ("" if i < len(NAMES) else str(i)),
                "messages": c,
                "share": int(c / messages * 10000 + 0.5) / 10000 if messages else 0.0,
                "words": c * 5,
                "attachments": c // 15,
                "late_night": c // 9,
                "reactions_given": c // 8,
                "reactions_received": c // 7,
            }
        )
    shape = [52, 36, 23, 13, 7, 4, 8, 19, 30, 36, 39, 43, 50, 46, 40, 39, 43, 50, 56, 60, 66, 74, 83, 89]
    by_hour = [int(messages * s / sum(shape)) for s in shape]
    by_hour[23] += messages - sum(by_hour)
    week = [126, 129, 134, 138, 156, 172, 145]
    by_weekday = [int(messages * s / sum(week)) for s in week]
    by_weekday[5] += messages - sum(by_weekday)
    months = [74, 69, 86, 81, 92, 104, 126, 113, 96, 109, 50, 0]
    by_month = [int(messages * s / sum(months)) for s in months]
    by_month[6] += messages - sum(by_month)
    awards = []
    if listed >= 3 and messages >= 15:
        awards = [
            {"id": "yapper", "emoji": "🗣️", "title": "The Yapper", "winner": senders[0]["name"],
             "detail": f"{senders[0]['messages']:,} messages. Nobody asked."},
            {"id": "lurker", "emoji": "👻", "title": "The Lurker", "winner": senders[-1]["name"],
             "detail": f"{senders[-1]['messages']:,} messages. Reads everything, says little."},
            {"id": "night_owl", "emoji": "🦉", "title": "The Night Owl", "winner": senders[1]["name"],
             "detail": f"{senders[1]['late_night']:,} messages after midnight."},
        ]
    return {
        "v": 1,
        "chat": {"name": chat_name, "members": members},
        "period": {"label": label, "start": "2026-01-01", "end": "2026-11-10"},
        "totals": {
            "messages": messages,
            "words": messages * 5,
            "attachments": messages // 15,
            "reactions": messages // 5,
            "days_active": min(301, max(1, messages // 3)),
            "longest_streak": min(87, max(1, messages // 40)),
        },
        "by_hour": by_hour,
        "by_weekday": by_weekday,
        "by_month": by_month,
        "busiest_day": {"date": "2026-07-04", "messages": max(1, messages // 80)},
        "personality": {
            "id": "night_owls",
            "title": "The Night Owls",
            "blurb": "Peak hour: 11 PM. Sleep is a suggestion.",
            "peak_hour": 23,
        },
        "late_night": {
            "messages": sum(by_hour[:5]),
            "share": 0.1302,
            "top": {"name": senders[min(1, listed - 1)]["name"], "messages": senders[min(1, listed - 1)]["late_night"]},
        },
        "senders": senders,
        "most_reacted": [
            {"sender": senders[0]["name"], "reactions": 6, "date": "2026-03-14",
             "text": "INVENTED QUOTE that must never appear on the card", "kinds": {"laugh": 4, "love": 2}}
        ],
        "reactions": {
            "by_kind": {"love": 21, "like": 15, "dislike": 1, "laugh": 28, "emphasize": 11, "question": 2, "emoji": 9},
            "top_giver": {"name": senders[min(4, listed - 1)]["name"], "count": 22},
            "top_receiver": {"name": senders[min(3, listed - 1)]["name"], "count": 19},
        },
        "awards": awards,
        "meta": {"generator": "wrapped/1", "source": "fixture", "generated": "2026-11-11"},
    }


class FakeEngine:
    """Stands in for the stats engine behind the narrow ``Engine`` interface."""

    def __init__(self, stats: Optional[dict] = None) -> None:
        self.stats = stats
        self.compute_calls: List[tuple] = []
        self.link_calls: List[bool] = []
        self.fail_compute: Optional[Exception] = None
        self.fail_link: Optional[Exception] = None

    def decode_text(self, text, attributed_body):
        return text if text else simple_decode(attributed_body)

    def list_group_chats(self, db_path):
        conn = sqlite3.connect(str(db_path))
        try:
            rows = conn.execute(
                "SELECT ROWID, guid, chat_identifier, display_name FROM chat WHERE style = 43 ORDER BY ROWID"
            ).fetchall()
            out = []
            for rowid, guid, ident, name in rows:
                n = conn.execute("SELECT COUNT(*) FROM chat_handle_join WHERE chat_id = ?", (rowid,)).fetchone()[0]
                out.append(ChatRef(guid=guid, identifier=ident or "", name=name or f"Group {ident}", rowid=rowid, members=n + 1))
            return out
        finally:
            conn.close()

    def compute_stats(self, db_path, chat, period, me):
        self.compute_calls.append((chat.key, period, me))
        if self.fail_compute is not None:
            raise self.fail_compute
        stats = copy.deepcopy(self.stats) if self.stats is not None else sample_stats()
        stats["chat"]["name"] = chat.name
        if period:
            stats["period"]["label"] = "All time" if period == "all" else period
        return stats

    def build_link(self, stats, quotes):
        self.link_calls.append(quotes)
        if self.fail_link is not None:
            raise self.fail_link
        return "https://example.invalid/story/#w1=FAKEPAYLOAD" + ("" if quotes else "-noquotes")
