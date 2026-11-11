"""Small formatting helpers shared by the card and the text recap.

Both surfaces show aggregate numbers and first names only, so the name handling
lives in one place.
"""

from __future__ import annotations

import copy
import re
import subprocess
import sys
from typing import Dict, Iterable, List, Optional

_WS = re.compile(r"\s+")

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

# No name, label or title is ever looked at beyond this many characters. Chat and
# contact names are other people's input (any member can rename a group), so every
# later step must be bounded however long the input is.
MAX_INPUT = 2000
MAX_CHAT_NAME = 60

# Characters that are invisible, move the cursor or reorder the text around them.
# They are removed from every name before it is drawn, printed, logged or sent
# (docs/SCHEMA.md 2 "Clean names", plus zero-width and filler characters). The
# zero-width joiner and the variation selectors stay: emoji sequences need them.
_REMOVED = (
    list(range(0x00, 0x20)) + list(range(0x7F, 0xA0))  # C0 and C1 controls, ESC included
    + [0x00AD, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x17B5]  # soft hyphen, fillers, Arabic letter mark
    + list(range(0x180B, 0x1810))  # Mongolian free variation selectors and vowel separator
    + [0x200B, 0x200E, 0x200F]  # zero-width space, left-to-right and right-to-left marks
    + list(range(0x202A, 0x202F))  # bidi embeddings and overrides
    + list(range(0x2060, 0x2070))  # word joiner, invisible operators, bidi isolates
    + [0x3164, 0xFEFF, 0xFFA0]  # Hangul fillers, byte-order mark
    + list(range(0xFFF9, 0xFFFE))  # interlinear marks, object replacement, replacement character
    + list(range(0x1D173, 0x1D17B))  # musical formatting
    + list(range(0xE0000, 0xE0080))  # tag characters
)
_SPACES = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000] + list(
    range(0x2000, 0x200B)
)
_UNSAFE = {cp: None for cp in _REMOVED}
_UNSAFE.update({cp: " " for cp in _SPACES})
_JOINERS = chr(0x200D) + chr(0xFE0F) + " "


def scrub(text: object) -> str:
    """Remove unsafe characters but keep the spacing (for whole log lines)."""
    return str(text if text is not None else "")[: MAX_INPUT * 4].translate(_UNSAFE)


def clean(text: object, limit: Optional[int] = None) -> str:
    """A string that is safe to draw, print, log or send: unsafe characters
    removed, all whitespace (newlines too) collapsed to single spaces, trimmed,
    and optionally capped at ``limit`` code points with an ellipsis."""
    s = str(text if text is not None else "")
    if len(s) > MAX_INPUT:
        s = s[:MAX_INPUT]
    s = _WS.sub(" ", s.translate(_UNSAFE)).strip()
    if limit is not None and len(s) > limit:
        s = s[: max(1, limit - 1)].rstrip(_JOINERS) + "…"
    return s


def is_emoji_base(cp: int) -> bool:
    """Code points that start (or continue) an emoji."""
    return (
        0x1F000 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
        or 0x231A <= cp <= 0x23FF
        or cp in (0x2B50, 0x2B55, 0x2B1B, 0x2B1C, 0x2B05, 0x2B06, 0x2B07, 0x2934, 0x2935, 0x3030, 0x303D)
    )


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


_RUN = re.compile(r"[^\s<>()\[\]\"',;:]+")
_NAME_PARTS = re.compile(r"(, | & )")


def mask_label(label: object) -> str:
    """docs/SCHEMA.md 2, "Masking": a label never shows a raw e-mail address or
    phone number. The engine masks at the source; this is the same rule applied
    again wherever a name is about to be shown.

    1. an e-mail address anywhere in it -> the part before the ``@`` (16 characters at most)
    2. seven or more digits in total -> an ellipsis and the last four digits
    3. anything else is kept."""
    s = clean(label)
    for match in _RUN.finditer(s):
        run = match.group(0)
        at = run.find("@")
        if 0 < at < len(run) - 1:
            local = run[:at]
            return local if len(local) <= 16 else local[:16] + "…"
    digits = [ch for ch in s if ch.isdecimal()]
    if len(digits) >= 7:
        return "…" + "".join(digits[-4:])
    return s


def first_name(name: object) -> str:
    """What a person is called on a shared image: their first word (16 characters
    at most). A label the engine already masked (it starts with an ellipsis) is
    left alone; a raw number or address that somehow got this far is masked."""
    s = clean(name)
    if not s:
        return "?"
    if s.startswith("…"):
        return s[:17]
    masked = mask_label(s)
    if masked != s:
        return masked
    first = s.split(" ", 1)[0]
    return first if len(first) <= 16 else first[:15] + "…"


def safe_chat_name(name: object, limit: int = MAX_CHAT_NAME) -> str:
    """A chat name fit to be drawn, logged or sent: cleaned, masked and capped.

    A group without a name is called after its members ("Bram, Sam, …0007 & 1
    more"), so the masking rule is applied to each of those parts separately."""
    parts = _NAME_PARTS.split(clean(name))
    for i, part in enumerate(parts):
        if part in (", ", " & ") or part.startswith("…"):
            continue
        parts[i] = mask_label(part)
    return clean("".join(parts), limit)


def display_names(names: Iterable[object]) -> Dict[str, str]:
    """Map sender names to short display names that stay distinguishable.

    Two people who share a first name get a last initial ("Sam K.", "Sam R.");
    anything still identical gets a number."""
    full: List[str] = list(dict.fromkeys(clean(n) for n in names))
    shown = {name: first_name(name) for name in full}

    def clashes() -> List[str]:
        values = list(shown.values())
        return [name for name in full if values.count(shown[name]) > 1]

    for name in clashes():
        if shown[name].startswith("…") or shown[name] != name.split(" ", 1)[0]:
            continue  # a masked label has no initial to add
        rest = name.split(" ")[1:]
        initial = next((part[0] for part in rest if part[:1].isalpha()), "")
        if initial:
            shown[name] = f"{shown[name]} {initial.upper()}."
    seen: Dict[str, int] = {}
    for name in clashes():
        seen[shown[name]] = seen.get(shown[name], 0) + 1
        if seen[shown[name]] > 1:
            shown[name] = f"{shown[name]} {seen[shown[name]]}"
    return shown


def _apply_names(stats: dict, rename) -> dict:
    """A deep copy of ``stats`` with every person's name passed through ``rename``."""
    out = copy.deepcopy(stats)
    for sender in out.get("senders") or []:
        if isinstance(sender, dict) and isinstance(sender.get("name"), str):
            sender["name"] = rename(sender["name"])
    top = (out.get("late_night") or {}).get("top")
    if isinstance(top, dict) and isinstance(top.get("name"), str):
        top["name"] = rename(top["name"])
    for item in out.get("most_reacted") or []:
        if isinstance(item, dict) and isinstance(item.get("sender"), str):
            item["sender"] = rename(item["sender"])
    for key in ("top_giver", "top_receiver"):
        who = (out.get("reactions") or {}).get(key)
        if isinstance(who, dict) and isinstance(who.get("name"), str):
            who["name"] = rename(who["name"])
    for award in out.get("awards") or []:
        if isinstance(award, dict) and isinstance(award.get("winner"), str):
            award["winner"] = rename(award["winner"])
    return out


def short_names(stats: dict, me: str = "Me") -> dict:
    """docs/SCHEMA.md 2, "Short names", for use until the engine's own
    ``wrapped.short_names`` is available (``shorten`` prefers that one).

    Contact names are the owner's private labels ("Dave plumber"), so a recap
    shows the first word. The owner's own name and masked labels are unchanged;
    two people with the same first word become "Sam R." / "Sam K."; if that
    still collides they keep their full names."""
    names: List[str] = []
    seen = set()

    def collect(name: str) -> str:
        if name not in seen:
            seen.add(name)
            names.append(name)
        return name

    _apply_names(stats, collect)

    def kept(name: str) -> bool:
        return name == me or name.startswith("…")

    short = {name: (name if kept(name) else (name.split() or [name])[0]) for name in names}
    for _round in range(2):
        counts: Dict[str, int] = {}
        for value in short.values():
            counts[value] = counts.get(value, 0) + 1
        clashing = [name for name in names if counts[short[name]] > 1 and not kept(name)]
        if not clashing:
            break
        for name in clashing:
            words = name.split() or [name]
            short[name] = f"{words[0]} {words[-1][0]}." if _round == 0 else name
    return _apply_names(stats, lambda name: short.get(name, name))


def shorten(stats: dict, me: str = "Me") -> dict:
    """Short names through the engine when it provides them, else the same rule here."""
    try:
        from .. import short_names as engine_short_names  # wrapped.short_names(stats, me=...)
    except ImportError:
        return short_names(stats, me)
    try:
        return engine_short_names(stats, me=me)
    except TypeError:
        return engine_short_names(stats)


def account_first_name(platform: Optional[str] = None, run=None) -> str:
    """The first name of this Mac's user account (``id -F``), or "Me".

    Used as the default for ``--me``: a recap the whole chat reads should not call
    its owner "Me"."""
    if (platform or sys.platform) != "darwin":
        return "Me"
    try:
        proc = (run or subprocess.run)(  # noqa: S603 - fixed command, no shell
            ["/usr/bin/id", "-F"], capture_output=True, text=True, timeout=3, stdin=subprocess.DEVNULL
        )
        full = clean(proc.stdout, 80)
    except (OSError, subprocess.SubprocessError, ValueError):
        return "Me"
    name = first_name(full) if full else ""
    if not name or name == "?" or name.startswith("…"):
        return "Me"
    return name


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
