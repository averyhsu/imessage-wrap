"""Small formatting helpers shared by the card and the text recap.

Both surfaces show aggregate numbers and first names only, so the name handling
lives in one place.
"""

from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional

_WS = re.compile(r"\s+")

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


def _is_phone(s: str) -> bool:
    digits = re.sub(r"\D", "", s)
    return len(digits) >= 7 and len(digits) >= len(re.sub(r"\s", "", s)) - 4


def first_name(name: object, digits: int = 2) -> str:
    """The part of a sender name that is safe to print on a shared image.

    The same rules as the web story's card (``cardName`` in web/js/card.js):
    - a contact name -> its first word (at most 16 characters)
    - a phone number -> its last two digits behind an ellipsis, never the number
    - an e-mail address -> its first letter and an ellipsis
    """
    s = clean(name)
    if not s:
        return "?"
    if s.find("@") > 0:
        return s[0].upper() + "…"
    if _is_phone(s):
        return "…" + re.sub(r"\D", "", s)[-digits:]
    first = s.split(" ", 1)[0]
    return first if len(first) <= 16 else first[:15] + "…"


_NAME_PARTS = re.compile(r"(, | & )")


def safe_chat_name(name: object) -> str:
    """A chat name fit for a shared image.

    A group without a name is called after its members ("Bram, Sam, +1555... & 1
    more"); a member who is not in the owner's contacts would appear there as a
    full phone number or e-mail address. Those parts are masked like sender
    names; everything else is left alone."""
    parts = _NAME_PARTS.split(clean(name))
    for i, part in enumerate(parts):
        if part in (", ", " & "):
            continue
        if (part.find("@") > 0 and " " not in part) or _is_phone(part):
            parts[i] = first_name(part)
    return "".join(parts)


def display_names(names: Iterable[object]) -> Dict[str, str]:
    """Map full sender names to short display names that stay distinguishable.

    Two people who share a first name get a last initial ("Sam K.", "Sam R."),
    two unknown numbers ending in the same digits show four digits, and
    anything still identical gets a number."""
    full: List[str] = list(dict.fromkeys(clean(n) for n in names))
    shown = {name: first_name(name) for name in full}

    def clashes() -> List[str]:
        values = list(shown.values())
        return [name for name in full if values.count(shown[name]) > 1]

    for name in clashes():
        if _is_phone(name) and name.find("@") <= 0:
            shown[name] = first_name(name, digits=4)
        else:
            rest = name.split(" ")[1:]
            initial = next((part[0] for part in rest if part[:1].isalpha()), "")
            if initial:
                shown[name] = f"{first_name(name)} {initial.upper()}."
    seen: Dict[str, int] = {}
    for name in clashes():
        seen[shown[name]] = seen.get(shown[name], 0) + 1
        if seen[shown[name]] > 1:
            shown[name] = f"{shown[name]} {seen[shown[name]]}"
    return shown


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
