"""What counts as a command typed into a chat.

A trigger is a whole message that is exactly ``/wrapped`` or ``/recap`` (any case,
surrounding whitespace ignored), optionally followed by a four-digit year or
``all``. Anything else, including a sentence that merely mentions the command,
is not a trigger.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Optional

COMMANDS = ("wrapped", "recap")

# The earliest year a Messages database can plausibly hold (the format dates
# from 2001-01-01; nothing real is older than the first iPhone).
MIN_YEAR = 2007

_TRIGGER_RE = re.compile(r"^/(wrapped|recap)(?:\s+(\d{4}|all))?$", re.IGNORECASE)
_STARTS_RE = re.compile(r"^/\s*(wrapped|recap)", re.IGNORECASE)

# Characters Messages can leave around typed text that are invisible to the
# person typing: the attachment placeholder, the replacement character,
# zero-width spaces/joiners, the BOM and the bidi marks.
_INVISIBLE = dict.fromkeys(
    (0xFFFC, 0xFFFD, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2060, 0xFEFF), None
)


@dataclass(frozen=True)
class Trigger:
    command: str  # "wrapped" or "recap"
    period: Optional[str]  # None = default period, "2025" = that year, "all" = everything


def normalize(text: Optional[str]) -> str:
    """Canonical form used for trigger matching (never shown to anyone)."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text).translate(_INVISIBLE)
    return text.strip()


def parse_trigger(text: Optional[str], *, current_year: Optional[int] = None) -> Optional[Trigger]:
    """Return the trigger a message text represents, or ``None``.

    ``current_year`` bounds the accepted year (``MIN_YEAR``..``current_year``); a
    year outside that range is not a trigger at all, so a typo cannot make the
    helper answer with an empty recap.
    """
    m = _TRIGGER_RE.match(normalize(text))
    if not m:
        return None
    command = m.group(1).lower()
    arg = m.group(2)
    if arg is None:
        return Trigger(command, None)
    if arg.lower() == "all":
        return Trigger(command, "all")
    year = int(arg)
    if year < MIN_YEAR or (current_year is not None and year > current_year):
        return None
    return Trigger(command, str(year))


def starts_with_trigger(line: Optional[str]) -> bool:
    """True if a line equals or starts with a command.

    Used to guarantee that nothing the helper sends could ever be read back as a
    command (see ``text.py``).
    """
    return bool(_STARTS_RE.match(normalize(line)))
