"""Read-only access to Messages databases.

Covers the Mac's ``~/Library/Messages/chat.db``, the ``sms.db`` inside an
unencrypted iPhone backup (same schema) and the two address-book formats used
to turn phone numbers and e-mail addresses into names.

Nothing in this module ever writes to a user's database:

* databases are opened through ``file:...?mode=ro`` URIs;
* a database with a ``-wal`` file next to it is opened in place so the rows
  that only exist in the write-ahead log are counted (``immutable=1`` would
  silently skip them);
* files inside an iPhone backup are opened with ``immutable=1`` so SQLite does
  not create ``-shm`` files in the backup folder, and when the backup also
  holds ``sms.db-wal`` both are copied to a private temporary folder first.
"""

from __future__ import annotations

import glob
import hashlib
import os
import pathlib
import plistlib
import shutil
import sqlite3
import tempfile
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .product import PRODUCT_NAME
from .stats import (APPLE_EPOCH, WHITESPACE, _NS_THRESHOLD, _Names, _distinct, _fallback_name,
                    build_contact_lookup)

__all__ = [
    "DatabaseError", "open_database", "open_backup", "find_backup", "locate_in_backup",
    "backup_is_encrypted", "list_group_chats", "diagnostics", "find_chat", "load_chat",
    "load_rows", "chat_for_message", "load_contacts", "load_mac_contacts",
    "default_chat_db", "default_address_books", "default_backup_root",
    "SMS_DB_ID", "SMS_WAL_ID", "ADDRESS_BOOK_ID",
]

SQLITE_MAGIC = b"SQLite format 3\x00"
GROUP_STYLE = 43

# fileID = SHA-1("<domain>-<relativePath>") inside an iPhone backup
SMS_DB_ID = "3d0d7e5fb2ce288813306e4d4636395e047a3d28"
SMS_WAL_ID = "cd47480f213dba9bc38ee792775d17e3f5a73a59"
ADDRESS_BOOK_ID = "31bb7ba8914766d4ba40d6dfb6113c8b614be442"
_SMS_PATH = ("HomeDomain", "Library/SMS/sms.db")
_SMS_WAL_PATH = ("HomeDomain", "Library/SMS/sms.db-wal")
_ADDRESS_BOOK_PATH = ("HomeDomain", "Library/AddressBook/AddressBook.sqlitedb")

FULL_DISK_ACCESS_HELP = """\
macOS would not let this program read {path}

Messages data is protected. The app you are running this from needs
"Full Disk Access":

  1. Open System Settings > Privacy & Security > Full Disk Access.
  2. Switch it on for your terminal app (Terminal, iTerm, VS Code ...).
  3. Quit that app completely, open it again and re-run the command.

{product} only ever reads the database, and nothing leaves this computer."""

ENCRYPTED_BACKUP_HELP = """\
This looks like an ENCRYPTED iPhone backup, which {product} cannot read yet.
In Finder (or the Apple Devices app on Windows) select the iPhone, untick
"Encrypt local backup", make a new backup and try again."""


class DatabaseError(Exception):
    """A problem with a database that the user can act on. ``str(exc)`` is a
    complete, friendly explanation; ``exc.code`` is a short machine tag."""

    def __init__(self, message: str, code: str = "database"):
        super().__init__(message)
        self.code = code


class _Connection(sqlite3.Connection):
    """A connection that removes its private snapshot folder when closed."""

    _snapshot_dir: Optional[str] = None
    wal_merged = False          #: rows from a -wal file are visible
    opened_immutable = False    #: opened with immutable=1 (no -wal existed)

    def close(self) -> None:
        try:
            super().close()
        finally:
            if self._snapshot_dir:
                shutil.rmtree(self._snapshot_dir, ignore_errors=True)
                self._snapshot_dir = None


# --------------------------------------------------------------------------- #
# locations
# --------------------------------------------------------------------------- #

def default_chat_db() -> str:
    """``~/Library/Messages/chat.db``."""
    return os.path.join(os.path.expanduser("~"), "Library", "Messages", "chat.db")


def default_address_books() -> List[str]:
    """Every ``AddressBook-v22.abcddb`` of the current macOS user."""
    root = os.path.join(os.path.expanduser("~"), "Library", "Application Support", "AddressBook")
    return _address_books_under(root)


def _address_books_under(root: str) -> List[str]:
    found = glob.glob(os.path.join(root, "AddressBook-v22.abcddb"))
    found += sorted(glob.glob(os.path.join(root, "Sources", "*", "AddressBook-v22.abcddb")))
    return found


def default_backup_root() -> Optional[str]:
    """The folder that holds iPhone backups on this computer, if there is one."""
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, "Library", "Application Support", "MobileSync", "Backup"),
        os.path.join(home, "Apple", "MobileSync", "Backup"),
        os.path.join(os.environ.get("APPDATA", ""), "Apple Computer", "MobileSync", "Backup"),
    ]
    for path in candidates:
        if path and os.path.isdir(path):
            return path
    return None


# --------------------------------------------------------------------------- #
# opening
# --------------------------------------------------------------------------- #

def _protected(path: str) -> bool:
    lowered = os.path.abspath(path).replace("\\", "/").lower()
    return any(part in lowered for part in ("/library/messages", "/mobilesync/", "/addressbook"))


def _access_error(path: str, exc: BaseException) -> DatabaseError:
    if isinstance(exc, PermissionError) or _protected(path):
        return DatabaseError(
            FULL_DISK_ACCESS_HELP.format(path=path, product=PRODUCT_NAME), "permission")
    return DatabaseError("Could not open %s: %s" % (path, exc), "open")


def _sniff(path: str) -> None:
    """Raise a helpful error unless ``path`` is a readable SQLite database."""
    if not os.path.exists(path):
        hint = ""
        if os.path.abspath(path) == os.path.abspath(default_chat_db()):
            hint = ("\nIs this a Mac that is signed in to Messages? Use --db PATH for a copy "
                    "of chat.db, or --backup DIR for an iPhone backup.")
        raise DatabaseError("There is no database at %s%s" % (path, hint), "missing")
    if os.path.isdir(path):
        raise DatabaseError("%s is a folder, not a database file." % path, "missing")
    try:
        with open(path, "rb") as handle:
            head = handle.read(16)
    except OSError as exc:
        raise _access_error(path, exc)
    if head != SQLITE_MAGIC:
        if len(head) == 0:
            raise DatabaseError("%s is empty." % path, "not_sqlite")
        raise DatabaseError(
            "%s is not a SQLite database. If it came out of an iPhone backup, the backup is "
            "probably encrypted.\n%s" % (path, ENCRYPTED_BACKUP_HELP.format(product=PRODUCT_NAME)),
            "not_sqlite")


def _connect(path: str, flags: str) -> _Connection:
    # as_uri() gives file:///C:/... on Windows and escapes "?", "#" and "%"
    uri = pathlib.Path(os.path.abspath(path)).as_uri() + "?" + flags
    con = sqlite3.connect(uri, uri=True, factory=_Connection)
    try:
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except sqlite3.Error:
        con.close()
        raise
    return con


def _snapshot(path: str, wal: Optional[str], name: str = "snapshot.db") -> _Connection:
    """Copy a database and its -wal to a private folder and open the copy."""
    folder = tempfile.mkdtemp(prefix="wrapped-")
    try:
        copy = os.path.join(folder, name)
        shutil.copyfile(path, copy)
        if wal:
            shutil.copyfile(wal, copy + "-wal")
        con = _connect(copy, "mode=ro")
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    con._snapshot_dir = folder
    con.wal_merged = bool(wal)
    return con


def open_database(path: str, wal: Optional[str] = None) -> sqlite3.Connection:
    """Open a Messages or address-book database read-only.

    ``path`` is the database file. If ``path + "-wal"`` exists the database is
    opened in place with ``mode=ro`` so un-checkpointed rows are included; if
    that is impossible (read-only folder) both files are copied to a private
    temporary folder and the copy is opened. Without a ``-wal`` the file is
    opened with ``immutable=1`` and nothing is created next to it.

    ``wal`` names a write-ahead log stored elsewhere (iPhone backups keep it
    under a different hashed name); it forces the copy route.

    Raises :class:`DatabaseError` with a message meant for the user, including
    the Full Disk Access steps when macOS refuses access.
    """
    path = os.fspath(path)
    _sniff(path)
    try:
        if wal:
            return _snapshot(path, wal)
        sidecar = path + "-wal"
        if os.path.exists(sidecar):
            try:
                con = _connect(path, "mode=ro")
                con.wal_merged = os.path.getsize(sidecar) > 0
                return con
            except sqlite3.Error:
                return _snapshot(path, sidecar)
        con = _connect(path, "immutable=1")
        con.opened_immutable = True
        return con
    except (sqlite3.Error, OSError) as exc:
        raise _access_error(path, exc)


# --------------------------------------------------------------------------- #
# iPhone backups
# --------------------------------------------------------------------------- #

def _looks_like_backup(path: str) -> bool:
    return (os.path.isfile(os.path.join(path, "Manifest.db"))
            or os.path.isfile(os.path.join(path, "Manifest.plist"))
            or os.path.isfile(os.path.join(path, SMS_DB_ID[:2], SMS_DB_ID))
            or os.path.isfile(os.path.join(path, SMS_DB_ID)))


def find_backup(path: Optional[str] = None) -> str:
    """Return the backup folder to use.

    ``path`` may be one backup (the folder holding ``Manifest.db``) or the
    folder that contains several, in which case the most recently modified
    one wins. ``None`` means the standard MobileSync location.
    """
    if path is None:
        path = default_backup_root()
        if path is None:
            raise DatabaseError(
                "No iPhone backup folder found on this computer. Pass --backup DIR with the "
                "folder that contains Manifest.db.", "missing")
    path = os.path.abspath(os.path.expanduser(os.fspath(path)))
    try:
        if not os.path.isdir(path):
            raise DatabaseError("%s is not a folder." % path, "missing")
        if _looks_like_backup(path):
            return path
        children = [os.path.join(path, name) for name in os.listdir(path)]
    except OSError as exc:
        raise _access_error(path, exc)
    backups = [c for c in children if os.path.isdir(c) and _looks_like_backup(c)]
    if not backups:
        raise DatabaseError(
            "%s does not look like an iPhone backup (no Manifest.db inside)." % path, "missing")
    return max(backups, key=lambda c: (os.path.getmtime(c), c))


def backup_is_encrypted(backup_dir: str) -> bool:
    """True when ``Manifest.plist`` says the backup is encrypted."""
    try:
        with open(os.path.join(backup_dir, "Manifest.plist"), "rb") as handle:
            return bool(plistlib.load(handle).get("IsEncrypted"))
    except Exception:
        return False


def locate_in_backup(backup_dir: str, domain: str, relative_path: str) -> Optional[str]:
    """Path of one backed-up file, or ``None`` when the backup lacks it.

    The file name is looked up in ``Manifest.db``; when the manifest is
    missing or unreadable the name is computed directly, because it is always
    ``SHA-1("<domain>-<relativePath>")``. Both the ``xx/<fileID>`` layout
    (iOS 10 and later) and the old flat layout are tried.
    """
    file_ids = []
    manifest = os.path.join(backup_dir, "Manifest.db")
    if os.path.isfile(manifest):
        try:
            con = _connect(manifest, "immutable=1")
            try:
                for (file_id,) in con.execute(
                        "SELECT fileID FROM Files WHERE domain = ? AND relativePath = ?",
                        (domain, relative_path)):
                    if isinstance(file_id, str):
                        file_ids.append(file_id)
            finally:
                con.close()
        except (sqlite3.Error, OSError):
            pass
    hashed = hashlib.sha1(("%s-%s" % (domain, relative_path)).encode("utf-8")).hexdigest()
    if hashed not in file_ids:
        file_ids.append(hashed)
    for file_id in file_ids:
        for candidate in (os.path.join(backup_dir, file_id[:2], file_id),
                          os.path.join(backup_dir, file_id)):
            if os.path.isfile(candidate):
                return candidate
    return None


def open_backup(backup_dir: str) -> Tuple[sqlite3.Connection, List[Tuple[str, str]]]:
    """Open the ``sms.db`` of an iPhone backup and read its contacts.

    Returns ``(connection, contacts)`` where ``contacts`` is a list of
    ``(identifier, name)`` pairs (empty when the backup has no address book).
    """
    backup_dir = find_backup(backup_dir)
    try:
        sms = locate_in_backup(backup_dir, *_SMS_PATH)
        if sms is None:
            if backup_is_encrypted(backup_dir):
                raise DatabaseError(ENCRYPTED_BACKUP_HELP.format(product=PRODUCT_NAME), "encrypted")
            raise DatabaseError(
                "This backup has no Messages database (%s/%s is missing). Was the backup "
                "finished?" % (SMS_DB_ID[:2], SMS_DB_ID), "missing")
        try:
            wal = locate_in_backup(backup_dir, *_SMS_WAL_PATH)
            if wal and os.path.getsize(wal) == 0:
                wal = None
            con = open_database(sms, wal=wal)
        except DatabaseError as exc:
            if exc.code == "not_sqlite" or backup_is_encrypted(backup_dir):
                raise DatabaseError(ENCRYPTED_BACKUP_HELP.format(product=PRODUCT_NAME), "encrypted")
            raise
        contacts: List[Tuple[str, str]] = []
        book = locate_in_backup(backup_dir, *_ADDRESS_BOOK_PATH)
        if book:
            try:
                contacts = load_contacts(book)
            except DatabaseError:
                contacts = []
        return con, contacts
    except OSError as exc:
        raise _access_error(backup_dir, exc)


# --------------------------------------------------------------------------- #
# queries
# --------------------------------------------------------------------------- #

def _lenient(raw: bytes) -> str:
    return raw.decode("utf-8", "replace")


def _fetch(con: sqlite3.Connection, sql: str, params: Sequence[Any] = ()) -> List[tuple]:
    """fetchall(), retrying with a forgiving text decoder when a TEXT value is
    not valid UTF-8 (sqlite3 raises OperationalError for those by default)."""
    try:
        return con.execute(sql, params).fetchall()
    except sqlite3.OperationalError as exc:
        if "decode" not in str(exc).lower():
            raise
        con.text_factory = _lenient
        return con.execute(sql, params).fetchall()


def _columns(con: sqlite3.Connection, table: str) -> set:
    return {row[1] for row in con.execute('PRAGMA table_info("%s")' % table)}


def _require_messages_schema(con: sqlite3.Connection) -> None:
    tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    missing = {"message", "chat", "handle", "chat_message_join"} - tables
    if missing:
        raise DatabaseError(
            "This is a SQLite database but not a Messages database (no %s table)."
            % sorted(missing)[0], "schema")


def _unix(raw: Optional[int]) -> Optional[int]:
    if not isinstance(raw, int) or raw <= 0:
        return None
    return (raw // 1000000000 if raw > _NS_THRESHOLD else raw) + APPLE_EPOCH


def _countable_sql(cols: set) -> str:
    """Rows that can be messages: no group events, tapbacks, stickers or votes."""
    parts = []
    if "item_type" in cols:
        parts.append("(m.item_type IS NULL OR m.item_type = 0)")
    if "associated_message_type" in cols:
        parts.append("(m.associated_message_type IS NULL OR m.associated_message_type < 1000)")
    return " AND ".join(parts) or "1"


def diagnostics(con: sqlite3.Connection) -> Dict[str, Any]:
    """Size and date range of the whole database.

    Shown next to the chat list so that a partial database (for example a Mac
    that only holds recent history because of Messages in iCloud) is visible:
    ``{"messages", "chats", "group_chats", "first_unix", "last_unix",
    "wal_merged", "immutable"}``.
    """
    _require_messages_schema(con)
    total, first, last = con.execute(
        "SELECT COUNT(*), MIN(CASE WHEN date > 0 THEN date END), MAX(date) FROM message").fetchone()
    chats = con.execute("SELECT COUNT(*) FROM chat").fetchone()[0]
    groups = len(_group_rows(con))
    return {
        "messages": total,
        "chats": chats,
        "group_chats": groups,
        "first_unix": _unix(first),
        "last_unix": _unix(last),
        "wal_merged": bool(getattr(con, "wal_merged", False)),
        "immutable": bool(getattr(con, "opened_immutable", False)),
    }


def _group_rows(con: sqlite3.Connection) -> List[List[tuple]]:
    """Group-chat rows, merged when they share a non-empty chat_identifier."""
    rows = _fetch(con, "SELECT ROWID, guid, chat_identifier, display_name, service_name "
                       "FROM chat WHERE style = ? ORDER BY ROWID", (GROUP_STYLE,))
    merged: Dict[Any, List[tuple]] = {}
    for row in rows:
        key = row[2] if row[2] else ("rowid", row[0])
        merged.setdefault(key, []).append(row)
    return list(merged.values())


def list_group_chats(con: sqlite3.Connection, contacts: Any = None,
                     me: str = "Me") -> List[Dict[str, Any]]:
    """Every group chat (``chat.style = 43``), busiest first.

    Each entry: ``id`` (lowest chat ROWID of the group), ``chat_ids`` (all
    merged rows), ``chat_identifier``, ``guid``, ``display_name`` (as stored,
    may be empty), ``name`` (what to show), ``participants`` (handle ids of
    the other members), ``members`` (people including the owner),
    ``messages`` (all-time count of message rows; a quick SQL count that does
    not look inside the text), ``first_unix`` / ``last_unix``.
    """
    _require_messages_schema(con)
    lookup = build_contact_lookup(contacts)
    names = _Names(me, lookup)
    cols = _columns(con, "message")
    counts: Dict[int, tuple] = {}
    for chat_id, n, first, last in con.execute(
            "SELECT j.chat_id, COUNT(*), MIN(CASE WHEN m.date > 0 THEN m.date END), MAX(m.date) "
            "FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id "
            "WHERE j.chat_id IN (SELECT ROWID FROM chat WHERE style = ?) AND %s "
            "GROUP BY j.chat_id" % _countable_sql(cols), (GROUP_STYLE,)):
        counts[chat_id] = (n, first, last)
    handles: Dict[int, List[str]] = {}
    for chat_id, handle in _fetch(
            con, "SELECT j.chat_id, h.id FROM chat_handle_join j JOIN handle h "
                 "ON h.ROWID = j.handle_id ORDER BY j.chat_id, j.handle_id"):
        handles.setdefault(chat_id, []).append(handle)

    chats = []
    for group in _group_rows(con):
        ids = [row[0] for row in group]
        display = next((row[3].strip(WHITESPACE) for row in group
                        if row[3] and row[3].strip(WHITESPACE)), "")
        participants = _distinct(h for chat_id in ids for h in handles.get(chat_id, []) if h)
        resolved = _distinct(names.handle(h) for h in participants)
        total = sum(counts.get(i, (0, None, None))[0] for i in ids)
        firsts = [counts[i][1] for i in ids if i in counts and counts[i][1]]
        lasts = [counts[i][2] for i in ids if i in counts and counts[i][2]]
        chats.append({
            "id": ids[0],
            "chat_ids": ids,
            "chat_identifier": group[0][2] or "",
            "guid": group[0][1],
            "display_name": display,
            "name": display or _fallback_name(resolved, me),
            "participants": participants,
            "members": len(set(resolved) | {me}),
            "messages": total,
            "first_unix": _unix(min(firsts)) if firsts else None,
            "last_unix": _unix(max(lasts)) if lasts else None,
        })
    chats.sort(key=lambda c: (-c["messages"], c["id"]))
    return chats


def find_chat(chats: Sequence[Dict[str, Any]], query: Any) -> Dict[str, Any]:
    """Pick one chat from :func:`list_group_chats` output.

    ``query`` may be a chat ROWID (int or digits), a ``chat.guid``, a
    ``chat_identifier``, or part of the name (case-insensitive; an exact name
    beats a partial match). Raises :class:`DatabaseError` when nothing or more
    than one chat matches, listing the candidates.
    """
    if isinstance(query, dict):
        return query
    text = str(query).strip()
    if text.isdigit():
        for chat in chats:
            if int(text) in chat["chat_ids"]:
                return chat
    for chat in chats:
        if text and text in (chat["guid"], chat["chat_identifier"]):
            return chat
    folded = text.casefold()
    exact = [c for c in chats if c["name"].casefold() == folded]
    partial = [c for c in chats if folded and folded in c["name"].casefold()]
    matches = exact or partial
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise DatabaseError(
            "No group chat matches %r. Run `wrapped chats` to see the names and ids." % text,
            "no_chat")
    listing = "\n".join("  %6d  %s" % (c["id"], c["name"]) for c in matches[:15])
    raise DatabaseError(
        "%d group chats match %r. Use the id instead:\n%s" % (len(matches), text, listing),
        "ambiguous_chat")


_ROW_KEYS = ("rowid", "guid", "date", "is_from_me", "handle", "text", "attributedBody",
             "cache_has_attachments", "item_type", "associated_message_type",
             "associated_message_guid")


def load_rows(con: sqlite3.Connection, chat_ids: Iterable[int]) -> List[Dict[str, Any]]:
    """All message rows of the given chat ROWIDs in the shape
    :func:`wrapped.stats.compute_stats` takes, each message once, by ROWID.

    Columns that an older database lacks (``attributedBody``, ``item_type``,
    ``associated_message_*``) come back as ``None``; the schema is probed with
    ``PRAGMA table_info`` rather than guessed from an OS version.
    """
    ids = [int(i) for i in chat_ids]
    cols = _columns(con, "message")

    def col(name: str) -> str:
        return "m." + name if name in cols else "NULL"

    body = ("CASE WHEN m.text IS NULL OR m.text = '' THEN m.attributedBody END"
            if "attributedBody" in cols else "NULL")
    sql = (
        "SELECT m.ROWID, m.guid, m.date, m.is_from_me, h.id, m.text, %s, %s, %s, %s, %s "
        "FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id "
        "WHERE m.ROWID IN (SELECT message_id FROM chat_message_join WHERE chat_id IN (%s)) "
        "ORDER BY m.ROWID"
        % (body, col("cache_has_attachments"), col("item_type"), col("associated_message_type"),
           col("associated_message_guid"), ",".join("?" for _ in ids)))
    return [dict(zip(_ROW_KEYS, row)) for row in _fetch(con, sql, ids)]


def load_chat(con: sqlite3.Connection, chat: Dict[str, Any]) -> Dict[str, Any]:
    """Rows plus the options :func:`compute_stats` needs for one chat entry
    from :func:`list_group_chats`: ``{"rows", "chat_name", "participants"}``."""
    return {
        "rows": load_rows(con, chat["chat_ids"]),
        "chat_name": chat.get("display_name") or "",
        "participants": list(chat.get("participants") or []),
    }


def chat_for_message(con: sqlite3.Connection, message_rowid: int) -> Optional[Dict[str, Any]]:
    """The chat a message belongs to: ``{"rowid", "guid", "display_name",
    "style", "chat_identifier", "is_group"}`` or ``None`` when the message is
    not (yet) joined to a chat."""
    row = con.execute(
        "SELECT c.ROWID, c.guid, c.display_name, c.style, c.chat_identifier "
        "FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id "
        "WHERE j.message_id = ? ORDER BY c.ROWID LIMIT 1", (int(message_rowid),)).fetchone()
    if row is None:
        return None
    return {"rowid": row[0], "guid": row[1], "display_name": row[2] or "", "style": row[3],
            "chat_identifier": row[4] or "", "is_group": row[3] == GROUP_STYLE}


# --------------------------------------------------------------------------- #
# contacts
# --------------------------------------------------------------------------- #

def _display_name(first: Any, last: Any, nickname: Any, organization: Any) -> str:
    parts = [p.strip(WHITESPACE) for p in (first, last) if isinstance(p, str)]
    name = " ".join(p for p in parts if p)
    if name:
        return name
    for fallback in (nickname, organization):
        if isinstance(fallback, str) and fallback.strip(WHITESPACE):
            return fallback.strip(WHITESPACE)
    return ""


def _contacts_from(con: sqlite3.Connection) -> List[Tuple[str, str]]:
    tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    pairs: List[Tuple[str, str]] = []
    if "ZABCDRECORD" in tables:                       # macOS AddressBook-v22.abcddb
        cols = _columns(con, "ZABCDRECORD")
        name_sql = ", ".join("r." + c if c in cols else "NULL" for c in
                             ("ZFIRSTNAME", "ZLASTNAME", "ZNICKNAME", "ZORGANIZATION"))
        queries = []
        if "ZABCDPHONENUMBER" in tables:
            queries.append("SELECT %s, p.ZFULLNUMBER FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r "
                           "ON r.Z_PK = p.ZOWNER ORDER BY r.Z_PK, p.Z_PK" % name_sql)
        if "ZABCDEMAILADDRESS" in tables:
            email_cols = _columns(con, "ZABCDEMAILADDRESS")
            address = "COALESCE(e.ZADDRESS, e.ZADDRESSNORMALIZED)" if "ZADDRESS" in email_cols \
                else "e.ZADDRESSNORMALIZED"
            queries.append("SELECT %s, %s FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r "
                           "ON r.Z_PK = e.ZOWNER ORDER BY r.Z_PK, e.Z_PK" % (name_sql, address))
    elif "ABPerson" in tables and "ABMultiValue" in tables:   # iPhone AddressBook.sqlitedb
        cols = _columns(con, "ABPerson")
        name_sql = ", ".join("p." + c if c in cols else "NULL" for c in
                             ("First", "Last", "Nickname", "Organization"))
        queries = ["SELECT %s, v.value FROM ABMultiValue v JOIN ABPerson p "
                   "ON p.ROWID = v.record_id WHERE v.property IN (3, 4) "
                   "ORDER BY p.ROWID, v.UID" % name_sql]
    else:
        raise DatabaseError("This file is not an address book this program knows how to read.",
                            "schema")
    for sql in queries:
        for first, last, nickname, organization, value in _fetch(con, sql):
            name = _display_name(first, last, nickname, organization)
            if name and isinstance(value, str) and value.strip(WHITESPACE):
                pairs.append((value, name))
    return pairs


def load_contacts(path: str) -> List[Tuple[str, str]]:
    """Read ``(identifier, name)`` pairs from one address-book database: a
    Mac ``AddressBook-v22.abcddb`` or an iPhone ``AddressBook.sqlitedb`` (the
    format is detected from the tables). Identifiers are phone numbers and
    e-mail addresses exactly as stored; :func:`compute_stats` normalises them.
    The name is "First Last", else the nickname, else the organisation."""
    con = open_database(path)
    try:
        return _contacts_from(con)
    except sqlite3.Error as exc:
        raise DatabaseError("Could not read contacts from %s: %s" % (path, exc), "open")
    finally:
        con.close()


def load_mac_contacts(paths: Optional[Iterable[str]] = None) -> List[Tuple[str, str]]:
    """Contacts from several Mac address books (default: all of the current
    user's). ``paths`` may name database files or an ``AddressBook`` folder.
    Books that cannot be read are skipped."""
    if paths is None:
        files = default_address_books()
    else:
        files = []
        for path in paths:
            files += _address_books_under(path) if os.path.isdir(path) else [path]
    pairs: List[Tuple[str, str]] = []
    for path in files:
        try:
            pairs += load_contacts(path)
        except DatabaseError:
            continue
    return pairs
