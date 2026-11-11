"""Small formatting helpers shared by the card and the text recap.

Both surfaces show aggregate numbers and first names only, so the name handling
lives in one place.
"""

from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional

_WS = re.compile(r"\s+")
_PHONE = re.compile(r"^\+?[\d\s().\-]{7,}$")

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def clean(text: object, limit: Optional[int] = None) -> str:
    """Collapse all whitespace (including newlines) and trim; optionally cap length."""
    s = _WS.sub(" ", str(text if text is not None else "")).strip()
    if limit is not None and len(s) > limit:
        s = s[: max(1, limit - 1)].rstrip() + "…"
    return s


def fmt_int(n: object) -> str:
    """48213 -> '48,213'. Anything non-numeric becomes '0'."""
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return "0"


def fmt_compact(n: object) -> str:
    """Compact form for tight spots: 950 -> '950', 48213 -> '48.2K', 1234567 -> '1.2M'."""
    try:
        v = int(n)
    except (TypeError, ValueError):
        return "0"
    if abs(v) < 1000:
        return str(v)
    for div, suffix in ((1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")):
        if abs(v) >= div:
            x = v / div
            s = f"{x:.1f}" if abs(x) < 100 else f"{x:.0f}"
            if s.endswith(".0"):
                s = s[:-2]
            return s + suffix
    return str(v)


def fmt_pct(share: object) -> str:
    """0.2456 -> '25%'. Small non-zero shares read '<1%' rather than '0%'."""
    try:
        x = float(share) * 100.0
    except (TypeError, ValueError):
        return "0%"
    if 0 < x < 1:
        return "<1%"
    return f"{int(x + 0.5)}%"


def hour12(h: object) -> str:
    """23 -> '11 PM', 0 -> '12 AM', 12 -> '12 PM'."""
    try:
        h = int(h) % 24
    except (TypeError, ValueError):
        return ""
    suffix = "AM" if h < 12 else "PM"
    return f"{h % 12 or 12} {suffix}"


def short_date(iso: object) -> str:
    """'2026-07-04' -> 'Jul 4'. Returns '' for anything unparseable."""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(iso or ""))
    if not m:
        return ""
    month, day = int(m.group(2)), int(m.group(3))
    if not 1 <= month <= 12:
        return ""
    return f"{MONTHS[month - 1]} {day}"


def first_name(name: object) -> str:
    """The part of a sender name that is safe to print on a shared image.

    - a contact name -> its first word
    - a phone number -> its last four digits behind dots (never the full number)
    - an e-mail address -> the part before the ``@``
    """
    s = clean(name)
    if not s:
        return "Someone"
    if "@" in s and " " not in s:
        return s.split("@", 1)[0][:20] or "Someone"
    if _PHONE.match(s):
        digits = re.sub(r"\D", "", s)
        return "···" + digits[-4:]
    return s.split(" ", 1)[0]


def display_names(names: Iterable[object]) -> Dict[str, str]:
    """Map full sender names to short display names, keeping them distinguishable.

    Two people who share a first name get a last initial ("Sam K.", "Sam R.").
    """
    full: List[str] = [clean(n) for n in names]
    firsts = [first_name(n) for n in full]
    out: Dict[str, str] = {}
    for name, first in zip(full, firsts):
        shown = first
        if firsts.count(first) > 1:
            rest = name.split(" ")[1:] if not _PHONE.match(name) else []
            initial = next((p[0] for p in rest if p[:1].isalpha()), "")
            if initial:
                shown = f"{first} {initial.upper()}."
        out[name] = shown
    return out


def peak_hour(stats: dict) -> Optional[int]:
    """Peak hour from the personality block, else derived from ``by_hour``."""
    p = (stats.get("personality") or {}).get("peak_hour")
    if isinstance(p, int) and 0 <= p <= 23:
        return p
    hours = by_hour(stats)
    if hours and max(hours) > 0:
        return hours.index(max(hours))
    return None


def by_hour(stats: dict) -> List[int]:
    """24 ints from ``by_hour``, tolerating the legacy ``messages_by_hour`` dict."""
    h = stats.get("by_hour")
    if isinstance(h, list) and len(h) == 24:
        return [_as_int(x) for x in h]
    legacy = stats.get("messages_by_hour")
    if isinstance(legacy, dict):
        return [_as_int(legacy.get(str(i), legacy.get(i, 0))) for i in range(24)]
    return []


def _as_int(x: object) -> int:
    try:
        return max(0, int(x))
    except (TypeError, ValueError):
        return 0
