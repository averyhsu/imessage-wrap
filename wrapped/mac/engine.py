"""The narrow interface between the Mac helper and the stats engine.

The agent loop only ever talks to an ``Engine``. Tests inject a fake; the real
adapter (``load_engine``) wraps the ``wrapped`` core package (``wrapped.db``,
``wrapped.stats``, ``wrapped.payload``, ``wrapped.typedstream``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List, Optional

try:  # Python 3.8+: typing.Protocol
    from typing import Protocol
except ImportError:  # pragma: no cover - ancient Pythons are rejected by the installer
    Protocol = object  # type: ignore[assignment]


@dataclass(frozen=True)
class ChatRef:
    """A group chat as the helper needs to see it.

    ``guid`` is ``chat.guid`` exactly as stored in ``chat.db``; it is handed to
    AppleScript verbatim. ``identifier`` is ``chat.chat_identifier``, the key that
    merges the iMessage and SMS variants of one group.
    """

    guid: str
    identifier: str
    name: str
    rowid: int = 0
    members: int = 0

    @property
    def key(self) -> str:
        """Stable key for cooldowns and allowlists."""
        return self.identifier or self.guid


class EngineError(RuntimeError):
    """The engine could not do what was asked (no such chat, link too long, ...)."""


class Engine(Protocol):
    def decode_text(self, text: Optional[str], attributed_body: Optional[bytes]) -> str:
        """Plain text of a message row (``text``, else decoded ``attributedBody``)."""

    def list_group_chats(self, db_path: os.PathLike) -> List[ChatRef]:
        """Every group chat with the name a person would recognise it by."""

    def compute_stats(self, db_path: os.PathLike, chat: ChatRef, period: Optional[str], me: str) -> dict:
        """Stats dict (docs/SCHEMA.md §1). ``period``: None = default, "2025", or "all"."""

    def build_link(self, stats: dict, quotes: bool) -> str:
        """Share URL within the length budget; ``quotes=False`` strips message text."""


def load_engine() -> Engine:
    """Import the real engine adapter, or explain what is missing."""
    try:
        from ._real_engine import RealEngine
    except ImportError as exc:  # the core package is not installed / too old
        raise EngineError(
            "The stats engine (the 'wrapped' core package) is not available: "
            f"{exc}. Reinstall with the installer, or run from a full checkout."
        ) from exc
    return RealEngine()
