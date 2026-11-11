"""Threadback engine: turn a Messages database into the stats JSON.

The public API (stable; everything else is an implementation detail):

``compute_stats(db_path, chat, year=None, me="Me", tz=None, ...)``
    Stats JSON (docs/SCHEMA.md) for one group chat of a ``chat.db`` or, with
    ``backup=DIR``, of the ``sms.db`` in an iPhone backup.
``build_link(stats, quotes=True)``
    The share URL, trimmed to the 4,800-character budget when necessary.
``open_source(db=None, backup=None, contacts=None)`` -> :class:`Source`
    An opened database with ``.chats()``, ``.stats(chat, ...)``,
    ``.diagnostics()``; ``list_chats(...)`` is the one-shot form.
``decode_text(text, attributed_body)``
    The text of a message row (``attributedBody`` is decoded when needed).
``chat_for_message(db, message_rowid)``
    The chat (rowid, guid, display name, style) a message belongs to.
``stats_from_rows(rows, **options)``
    The pure function underneath: rows in, stats out, no database.
``encode_payload`` / ``decode_payload`` / ``fit_link`` / ``stats_from_url``
    The link codec of docs/SCHEMA.md section 5.

Errors meant for the user are :class:`DatabaseError` (its text explains what
to do, e.g. how to grant Full Disk Access) and :class:`LinkTooLongError`.

Only the Python standard library is used. Databases are opened read-only.
"""

from .product import PRODUCT_NAME, TAGLINE

__version__ = "0.1.0"

from .typedstream import decode_attributed_body
from .stats import (GENERATOR, chat_display_name, clean_text, count_words)
from .stats import compute_stats as stats_from_rows
from .payload import (BASE_URL, MAX_URL_LENGTH, LinkTooLongError, decode_payload,
                      encode_payload, fit_link, stats_from_url)
from .db import DatabaseError
from .api import (Source, build_link, chat_for_message, compute_stats, decode_text,
                  list_chats, open_source)

__all__ = [
    "PRODUCT_NAME", "TAGLINE", "__version__", "GENERATOR", "BASE_URL", "MAX_URL_LENGTH",
    "compute_stats", "build_link", "open_source", "list_chats", "Source", "decode_text",
    "chat_for_message", "stats_from_rows", "decode_attributed_body", "clean_text",
    "count_words", "chat_display_name", "encode_payload", "decode_payload", "fit_link",
    "stats_from_url", "DatabaseError", "LinkTooLongError",
]
