"""The real ``Engine``: a thin adapter over the ``wrapped`` core package.

Kept separate from ``engine.py`` so that importing the interface (and running
the agent with a fake engine) never needs the core package.
"""

from __future__ import annotations

import os
from typing import Any, List, Optional

from .. import api as _api
from .engine import ChatRef, EngineError


class RealEngine:
    """``contacts``: ``None`` = the Mac's address books (automatic), ``False`` =
    no names, or a list of address-book paths. ``me`` is the owner's display
    name, used for the names of unnamed group chats."""

    def __init__(self, me: str = "Me", contacts: Any = None, tz: Optional[str] = None) -> None:
        self.me = me
        self.contacts = contacts
        self.tz = tz

    def decode_text(self, text: Optional[str], attributed_body: Optional[bytes]) -> str:
        return _api.decode_text(text, attributed_body)

    def list_group_chats(self, db_path: os.PathLike) -> List[ChatRef]:
        with _api.open_source(db=os.fspath(db_path), contacts=self.contacts) as source:
            chats = source.chats(self.me)
        return [
            ChatRef(
                guid=str(c.get("guid") or ""),
                identifier=str(c.get("chat_identifier") or ""),
                name=str(c.get("name") or ""),
                rowid=int(c.get("id") or 0),
                members=int(c.get("members") or 0),
            )
            for c in chats
        ]

    def compute_stats(self, db_path: os.PathLike, chat: ChatRef, period: Optional[str], me: str) -> dict:
        year: Optional[int] = None
        all_time = False
        if period == "all":
            all_time = True
        elif period:
            try:
                year = int(period)
            except ValueError as exc:
                raise EngineError(f"unknown period {period!r}") from exc
        # A chat ROWID is the least ambiguous way to name the chat; the engine
        # merges the iMessage/SMS rows of one group by itself.
        query: Any = chat.rowid or chat.identifier or chat.guid
        with _api.open_source(db=os.fspath(db_path), contacts=self.contacts) as source:
            return source.stats(query, year=year, me=me or self.me, tz=self.tz, all_time=all_time)

    def build_link(self, stats: dict, quotes: bool) -> str:
        return _api.build_link(stats, quotes=quotes)
