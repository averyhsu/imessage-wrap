"""The small, stable Python API other components build on.

Everything here is re-exported from the ``wrapped`` package::

    import wrapped

    stats = wrapped.compute_stats("~/Library/Messages/chat.db", "Dinner Club", year=2026)
    url = wrapped.build_link(wrapped.short_names(stats))     # no message text by default

    with wrapped.open_source(backup="/path/to/MobileSync/Backup") as source:
        for chat in source.chats():
            print(chat["id"], chat["messages"], chat["name"])
        stats = source.stats("Dinner Club", all_time=True, tz="America/Chicago")

    wrapped.decode_text(row_text, row_attributed_body)     # one message's text
    wrapped.chat_for_message(db_path, message_rowid)       # which chat is it in?
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple, Union

from . import db as _db
from . import payload as _payload
from . import stats as _stats
from .typedstream import decode_attributed_body

__all__ = ["Source", "open_source", "list_chats", "compute_stats", "decode_text",
           "chat_for_message", "build_link", "short_names", "account_first_name"]

short_names = _stats.short_names


def account_first_name(platform: Optional[str] = None, run: Any = None) -> str:
    """The first name of this Mac's user account (``id -F``), or ``"Me"``.

    The default for the owner's name: a recap the whole chat reads should not
    call its owner "Me". The answer is the first word of the account's full
    name, cleaned like every name. Not a Mac, no such command, no answer in
    three seconds, an empty answer, or a "name" that is really a number or an
    address: all of these give ``"Me"``. Never raises.

    ``platform`` (default ``sys.platform``) and ``run`` (default
    ``subprocess.run``) are there for tests."""
    if (platform or sys.platform) != "darwin":
        return "Me"
    try:
        proc = (run or subprocess.run)(             # a fixed command, no shell
            ["/usr/bin/id", "-F"], capture_output=True, text=True, timeout=3,
            stdin=subprocess.DEVNULL)
        if getattr(proc, "returncode", 0):
            return "Me"
        full = _stats.clean_name(proc.stdout, _stats.NAME_LIMIT)
    except (OSError, subprocess.SubprocessError, ValueError):
        return "Me"
    if _stats.mask_handle(full) != full:            # a number or an address is not a name
        return "Me"
    words = _stats._words(full)
    name = words[0] if words else ""
    return name if name and name != "?" else "Me"

Contacts = Union[None, bool, str, Iterable[Any], Mapping[str, str]]


class Source:
    """An opened Messages database together with its contact names.

    Attributes: ``conn`` (read-only ``sqlite3.Connection``), ``kind``
    (``"chat.db"`` or ``"sms.db"``), ``path`` and ``contacts`` (a list of
    ``(identifier, name)`` pairs, possibly empty). Use it as a context
    manager or call :meth:`close`.
    """

    def __init__(self, conn: sqlite3.Connection, kind: str, path: str,
                 contacts: Any):
        self.conn = conn
        self.kind = kind
        self.path = path
        self.contacts = contacts
        self._lookup = _stats.build_contact_lookup(contacts)

    def __enter__(self) -> "Source":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def close(self) -> None:
        self.conn.close()

    def diagnostics(self) -> Dict[str, Any]:
        """See :func:`wrapped.db.diagnostics`."""
        return _db.diagnostics(self.conn)

    def chats(self, me: str = "Me") -> List[Dict[str, Any]]:
        """Group chats, busiest first (see :func:`wrapped.db.list_group_chats`)."""
        return _db.list_group_chats(self.conn, self._lookup, me)

    def chat(self, query: Any, me: str = "Me") -> Dict[str, Any]:
        """One chat by ROWID, guid, chat_identifier or (part of) its name."""
        return _db.find_chat(self.chats(me), query)

    def stats(self, chat: Any, year: Optional[int] = None, me: str = "Me",
              tz: Optional[str] = None, all_time: bool = False, start: Optional[str] = None,
              end: Optional[str] = None, now: Optional[float] = None,
              label: Optional[str] = None) -> Dict[str, Any]:
        """Stats JSON (docs/SCHEMA.md) for one group chat of this source."""
        entry = self.chat(chat, me)
        loaded = _db.load_chat(self.conn, entry)
        return _stats.compute_stats(
            loaded["rows"], tz=tz, year=year, all_time=all_time, start=start, end=end, now=now,
            label=label, me=me, contacts=self._lookup, chat_name=loaded["chat_name"],
            participants=loaded["participants"], source=self.kind)


def _resolve_contacts(contacts: Contacts, automatic: Any) -> Any:
    if contacts is False:
        return []
    if contacts is None or contacts is True:
        return automatic() if callable(automatic) else automatic
    if isinstance(contacts, str):
        contacts = [contacts]
    if isinstance(contacts, Mapping):
        return contacts
    items = list(contacts)
    if items and all(isinstance(item, str) for item in items):
        pairs: List[Tuple[str, str]] = []
        for path in items:               # address-book files or folders
            path = os.path.expanduser(path)
            if os.path.isdir(path):
                pairs += _db.load_mac_contacts([path])
            else:
                pairs += _db.load_contacts(path)
        return pairs
    return items


def open_source(db: Optional[str] = None, backup: Optional[str] = None,
                contacts: Contacts = None) -> Source:
    """Open a Messages database read-only.

    ``db``       path to a Mac ``chat.db`` (default ``~/Library/Messages/chat.db``).
    ``backup``   an iPhone backup folder (or the folder holding several; the
                 newest is used). Reads its ``sms.db`` instead of ``db``.
                 Pass ``""`` for the standard MobileSync location.
    ``contacts`` ``None``: automatic (the Mac's address books for ``db``, the
                 backup's own address book for ``backup``); ``False``: no
                 names; a path or list of paths to address-book databases; or
                 a ready ``{identifier: name}`` mapping / list of pairs.

    Raises :class:`wrapped.DatabaseError` with a message for the user (for
    example the Full Disk Access steps) when the database cannot be read.
    """
    if backup is not None:
        folder = _db.find_backup(backup or None)
        conn, backup_contacts = _db.open_backup(folder)
        try:
            return Source(conn, "sms.db", folder, _resolve_contacts(contacts, backup_contacts))
        except BaseException:
            conn.close()
            raise
    path = os.path.expanduser(db) if db else _db.default_chat_db()
    conn = _db.open_database(path)
    try:
        kind = "sms.db" if os.path.basename(path).lower().startswith("sms") else "chat.db"
        return Source(conn, kind, path, _resolve_contacts(contacts, _db.load_mac_contacts))
    except BaseException:
        conn.close()
        raise


def list_chats(db: Optional[str] = None, backup: Optional[str] = None,
               contacts: Contacts = None, me: str = "Me") -> List[Dict[str, Any]]:
    """Group chats of a database, busiest first. See :meth:`Source.chats`."""
    with open_source(db, backup, contacts) as source:
        return source.chats(me)


def compute_stats(db_path: Optional[str], chat: Any, year: Optional[int] = None,
                  me: str = "Me", tz: Optional[str] = None, *, all_time: bool = False,
                  start: Optional[str] = None, end: Optional[str] = None,
                  backup: Optional[str] = None, contacts: Contacts = None,
                  now: Optional[float] = None) -> Dict[str, Any]:
    """Stats JSON (docs/SCHEMA.md section 1) for one group chat.

    ``db_path``  the Messages database; ``None`` means the default
                 ``~/Library/Messages/chat.db`` (ignored when ``backup`` is given).
    ``chat``     chat ROWID, ``chat.guid``, ``chat_identifier`` or part of the
                 chat's name.
    ``year``     calendar year; default: this year (last year during January).
                 ``all_time=True`` or ``start``/``end`` (``YYYY-MM-DD``,
                 inclusive) select another period.
    ``me``       display name for the owner's own messages.
    ``tz``       IANA zone for all local dates and hours; default: the
                 computer's zone.
    """
    with open_source(db_path, backup, contacts) as source:
        return source.stats(chat, year=year, me=me, tz=tz, all_time=all_time, start=start,
                            end=end, now=now)


def decode_text(text: Optional[str], attributed_body: Optional[bytes] = None,
                clean: bool = True) -> str:
    """The text of one message row.

    ``message.text`` when it is non-empty, otherwise the string inside
    ``message.attributedBody``. With ``clean`` (the default) attachment
    placeholders (U+FFFC) and replacement characters are removed and the
    result is trimmed, exactly as the statistics see it. Returns ``""`` when
    the row has no text.

    Cells of an unexpected type are safe to pass straight from a query: raw
    UTF-8 bytes are decoded, and anything that is neither text nor bytes (a
    number in a damaged or crafted database) counts as "no text", exactly as
    in :func:`wrapped.stats.compute_stats`. Never raises.
    """
    if text.__class__ is not str:
        text = (bytes(text).decode("utf-8", "replace")
                if isinstance(text, (bytes, bytearray, memoryview)) else "")
    if not text:
        text = decode_attributed_body(attributed_body) or ""
    return _stats.clean_text(text) if clean else text


def chat_for_message(db: Union[str, sqlite3.Connection, Source, None],
                     message_rowid: int) -> Optional[Dict[str, Any]]:
    """Which chat a ``message.ROWID`` belongs to.

    Returns ``{"rowid", "guid", "display_name", "style", "chat_identifier",
    "is_group"}`` (``style`` 43 is a group, 45 a one-to-one chat) or ``None``
    when the message is not joined to a chat yet. ``db`` is a path, an open
    connection or a :class:`Source`.
    """
    if isinstance(db, Source):
        return _db.chat_for_message(db.conn, message_rowid)
    if isinstance(db, sqlite3.Connection):
        return _db.chat_for_message(db, message_rowid)
    conn = _db.open_database(os.path.expanduser(db) if db else _db.default_chat_db())
    try:
        return _db.chat_for_message(conn, message_rowid)
    finally:
        conn.close()


def build_link(stats: Dict[str, Any], quotes: bool = False, base_url: Optional[str] = None,
               max_length: Optional[int] = None) -> str:
    """The share URL for a stats object (docs/SCHEMA.md section 5).

    The stats travel in the URL fragment. Message text is opt-in: the text of
    the most-reacted messages is only kept with ``quotes=True``. If the URL
    would exceed 4,800 characters a trimmed copy is encoded instead (the
    six-step ladder of the contract). Raises :class:`wrapped.LinkTooLongError`
    if nothing fits.
    """
    return _payload.build_link(
        stats, quotes=quotes,
        base_url=_payload.BASE_URL if base_url is None else base_url,
        max_length=_payload.MAX_URL_LENGTH if max_length is None else max_length)
