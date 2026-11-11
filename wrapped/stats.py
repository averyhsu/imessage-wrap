"""Rows in, stats JSON out: the counting rules of docs/SCHEMA.md sections 1-4.

:func:`compute_stats` is a pure function. It never touches a database, the
network or the clock (pass ``now`` to pin the clock in tests). The JavaScript
engine in ``web/make/engine.js`` implements the same function line for line and
``tests/conformance`` asserts that both produce byte-identical JSON.

Row shape (a mapping; every key except ``date`` is optional). The keys are the
Messages column names, so a row is literally a ``SELECT`` result::

    rowid                    message.ROWID, breaks ties between equal dates
    guid                     message.guid, the target of tapbacks
    date                     message.date, raw (ns or s since 2001-01-01 UTC);
                             an int or a decimal string
    is_from_me               1 when the owner of the database sent it
    handle                   handle.id of the sender (phone number or e-mail)
    text                     message.text
    attributedBody           message.attributedBody (bytes), used when text is
                             empty
    cache_has_attachments    1 when the message carries an attachment
    item_type                0 for messages; anything else is a group event
    associated_message_type  2000-2007 / 3000-3007 for tapbacks
    associated_message_guid  "p:0/<guid>", "bp:<guid>" or "<guid>"
    keep_empty               1 to count a row that has neither text nor an
                             attachment (imported rows are always messages)
"""

from __future__ import annotations

import bisect
import datetime as _dt
import math
import re
import time
from fractions import Fraction
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .typedstream import decode_attributed_body

__all__ = [
    "compute_stats", "chat_display_name", "contact_key", "build_contact_lookup", "ContactLookup",
    "clean_text", "count_words", "resolve_period", "GENERATOR", "KINDS",
]

GENERATOR = "wrapped/1"
APPLE_EPOCH = 978307200             # 2001-01-01T00:00:00Z in Unix seconds
_NS_THRESHOLD = 100000000000        # message.date above 10^11 is nanoseconds
_MAX_UNIX = 4102444800              # 2100-01-01; anything later is not a date
_DAY = 86400

KINDS = ("love", "like", "dislike", "laugh", "emphasize", "question", "emoji")
_KIND_OF = {2000: 0, 2001: 1, 2002: 2, 2003: 3, 2004: 4, 2005: 5, 2006: 6, 2007: 6}
_LAUGH = 3

# Whitespace is the ECMAScript set (what /\s/ and String.prototype.trim use),
# so "trim" and "whitespace-separated" mean the same thing in both engines.
WHITESPACE = (
    "\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008"
    "\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_WS_RUN = re.compile("[" + re.escape(WHITESPACE) + "]+")
# characters on which str.split() and the ECMAScript set disagree
_SPLIT_DIFFERS = re.compile("[\x1c-\x1f\x85\ufeff]")
_NOT_DIGIT = re.compile("[^0-9]")
_PHONE_LIKE = re.compile(r"[0-9+\-(). /]+")
_ASCII_LOWER = {c: c + 32 for c in range(65, 91)}
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")

MAX_SENDERS = 12
MAX_QUOTE = 180
LATE_NIGHT_HOURS = 5                # local hours 0..4

PERSONALITIES = {
    "quiet_ones": ("The Quiet Ones", "Few words. All of them count."),
    "night_owls": ("The Night Owls", "Sleep is a suggestion."),
    "weekend_warriors": ("The Weekend Warriors", "Weekdays are for recovering."),
    "always_on": ("The Always-On Group Chat", "There is no off switch."),
    "early_birds": ("The Early Birds", "Texting before coffee is a choice."),
    "morning_meeting": ("The Morning Meeting", "This could not have been an email."),
    "lunch_break": ("The Lunch Break Legends", "Eating with one hand, typing with the other."),
    "afternoon_slackers": ("The Afternoon Slackers", "Peak productivity, just not at work."),
    "dinner_table": ("The Dinner Table", "Phones out, forks down."),
    "after_hours": ("The After-Hours Crew", "The day ends. The chat begins."),
}

# id, emoji, title, detail template ({n} or {x})
AWARDS = (
    ("yapper", "\U0001F5E3\ufe0f", "The Yapper", "{n} messages. Nobody asked."),
    ("lurker", "\U0001F47B", "The Lurker", "{n} messages. Reads everything, says little."),
    ("night_owl", "\U0001F989", "The Night Owl", "{n} messages after midnight."),
    ("comedian", "\U0001F602", "The Comedian", "Made the chat laugh {n} times."),
    ("hype", "\U0001F4E3", "The Hype Machine", "Handed out {n} tapbacks."),
    ("novelist", "\U0001F4DA", "The Novelist", "{x} words per message. A paragraph person."),
    ("paparazzi", "\U0001F4F8", "The Paparazzi", "{n} photos, videos and memes."),
    ("favorite", "\u2b50", "The Crowd Favorite", "{n} tapbacks received."),
)
MAX_AWARDS = 6
AWARD_MIN_MESSAGES = 5
AWARD_MIN_SENDERS = 3
AWARD_MIN_COUNT = 3
NOVELIST_MIN_MESSAGES = 20


# --------------------------------------------------------------------------- #
# text
# --------------------------------------------------------------------------- #

def clean_text(text: Optional[str]) -> str:
    """Remove U+FFFC and U+FFFD, then trim (section 2, "Text")."""
    if not text:
        return ""
    if "\ufffc" in text:
        text = text.replace("\ufffc", "")
    if "\ufffd" in text:
        text = text.replace("\ufffd", "")
    return text.strip(WHITESPACE)


def count_words(text: str) -> int:
    """Number of whitespace-separated tokens in already cleaned text."""
    if not text:
        return 0
    if _SPLIT_DIFFERS.search(text) is None:
        return len(text.split())
    return sum(1 for token in _WS_RUN.split(text) if token)


def _truncate(text: str, limit: int) -> str:
    """First ``limit`` characters (Unicode code points) plus an ellipsis."""
    return text if len(text) <= limit else text[:limit] + "\u2026"


def _u16(name: str) -> bytes:
    """Sort key giving UTF-16 code unit order, i.e. JavaScript's string order."""
    return name.encode("utf-16-be", "surrogatepass")


# --------------------------------------------------------------------------- #
# contacts
# --------------------------------------------------------------------------- #

def contact_key(identifier: Optional[str]) -> Optional[str]:
    """Normalise a phone number or e-mail address for matching.

    E-mail (anything with ``@``): ASCII-lowercased. Phone: its last 10 ASCII
    digits. Returns ``None`` for anything else.
    """
    if not identifier:
        return None
    value = identifier.strip(WHITESPACE)
    if "@" in value:
        return "e:" + value.translate(_ASCII_LOWER)
    digits = _NOT_DIGIT.sub("", value)
    if digits:
        return "p:" + digits[-10:]
    return None


def mask_handle(handle: str) -> str:
    """The label for a sender who has no contact name.

    A recap is made to be shared, so a raw phone number or e-mail address
    never goes into it (docs/SCHEMA.md 2):

    - a phone number (only digits and ``+ - ( ) . /`` and spaces, with at
      least 7 digits) becomes an ellipsis and its last four digits;
    - an e-mail address (no whitespace, something before the ``@`` and a dot
      after it) becomes the part before the ``@``, cut to 16 characters;
    - anything else (a name from an imported export, a short code) is left
      as it is.
    """
    value = handle.strip(WHITESPACE)
    at = value.find("@")
    if at != -1:
        local, domain = value[:at], value[at + 1:]
        if local and "." in domain and not _WS_RUN.search(value):
            return local if len(local) <= 16 else local[:16] + "\u2026"
        return handle
    if _PHONE_LIKE.fullmatch(value):
        digits = _NOT_DIGIT.sub("", value)
        if len(digits) >= 7:
            return "\u2026" + digits[-4:]
    return handle


class ContactLookup(dict):
    """A normalised ``{contact_key: display name}`` table."""


def build_contact_lookup(contacts: Any) -> "ContactLookup":
    """Turn ``{identifier: name}`` or ``[(identifier, name), ...]`` into a
    ``{contact_key: name}`` table. When two cards claim the same number or
    address under different names, the name that sorts first wins, so the
    result does not depend on the order of the input."""
    if isinstance(contacts, ContactLookup):
        return contacts
    lookup = ContactLookup()
    if not contacts:
        return lookup
    pairs = contacts.items() if isinstance(contacts, Mapping) else contacts
    for pair in pairs:
        identifier, name = pair[0], pair[1]
        if not isinstance(identifier, str) or not isinstance(name, str):
            continue
        name = name.strip(WHITESPACE)
        key = contact_key(identifier)
        if not name or key is None:
            continue
        previous = lookup.get(key)
        if previous is None or _u16(name) < _u16(previous):
            lookup[key] = name
    return lookup


class _Names:
    """handle -> display name, with the owner and the contact table applied."""

    def __init__(self, me: str, lookup: Dict[str, str]):
        self.me = me
        self.lookup = lookup
        self.cache: Dict[Any, str] = {}

    def handle(self, handle: Optional[str]) -> str:
        name = self.cache.get(handle)
        if name is None:
            if not handle:
                name = "Unknown"
            else:
                key = contact_key(handle)
                name = (self.lookup.get(key) if key else None) or mask_handle(handle)
            self.cache[handle] = name
        return name

    def sender(self, row: Mapping[str, Any]) -> str:
        if row.get("is_from_me"):
            return self.me
        return self.handle(row.get("handle"))


def chat_display_name(display_name: Optional[str], participants: Optional[Sequence[str]],
                      contacts: Any = None, me: str = "Me") -> str:
    """The chat's name: ``display_name`` when it has one, otherwise the first
    names of up to three members (in the order given, the owner left out)
    joined with ", " plus " & N more".

    ``contacts`` is anything :func:`build_contact_lookup` accepts, or the
    table it returned (pass that when naming many chats)."""
    name = (display_name or "").strip(WHITESPACE)
    if name:
        return name
    if not isinstance(contacts, ContactLookup):
        contacts = build_contact_lookup(contacts)
    names = _Names(me, contacts)
    return _fallback_name(_distinct(names.handle(h) for h in (participants or []) if h), me)


def _distinct(names: Iterable[str]) -> List[str]:
    seen = set()
    out = []
    for name in names:
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _fallback_name(members: List[str], me: str) -> str:
    others = [m for m in members if m != me]
    if not others:
        return "Unnamed group"
    firsts = []
    for member in others[:3]:
        tokens = [t for t in _WS_RUN.split(member) if t]
        firsts.append(tokens[0] if tokens else member)
    label = ", ".join(firsts)
    if len(others) > 3:
        label += " & %d more" % (len(others) - 3)
    return label


# --------------------------------------------------------------------------- #
# dates and time zones
# --------------------------------------------------------------------------- #

def _split_date(value: Any) -> Optional[Tuple[int, int]]:
    """message.date -> (Unix seconds, nanoseconds within the second)."""
    if value is None:
        return None
    if not isinstance(value, int):
        try:
            value = int(value)
        except (TypeError, ValueError):
            return None
    if value <= 0:
        return None
    if value > _NS_THRESHOLD:
        sec = value // 1000000000 + APPLE_EPOCH
        frac = value % 1000000000
    else:
        sec = value + APPLE_EPOCH
        frac = 0
    if sec > _MAX_UNIX:
        return None
    return sec, frac


def _days_from_civil(y: int, m: int, d: int) -> int:
    """Days since 1970-01-01 for a proleptic Gregorian date."""
    y -= m <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _civil_from_days(z: int) -> Tuple[int, int, int]:
    z += 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    return (y + (m <= 2), m, d)


def _iso(day: int) -> str:
    return "%04d-%02d-%02d" % _civil_from_days(day)


def _parse_iso(value: str, what: str) -> int:
    match = _ISO_DATE.match(value) if isinstance(value, str) else None
    if not match:
        raise ValueError("%s must be a YYYY-MM-DD date, got %r" % (what, value))
    y, m, d = (int(g) for g in match.groups())
    day = _days_from_civil(y, m, d)
    if _civil_from_days(day) != (y, m, d):
        raise ValueError("%s is not a real calendar date: %r" % (what, value))
    return day


def _offset_function(tz: Optional[str]) -> Callable[[int], int]:
    """Unix seconds -> UTC offset in seconds, for an IANA zone or the local one."""
    if tz is None or tz == "" or tz == "local":
        return lambda t: time.localtime(t).tm_gmtoff
    try:
        from zoneinfo import ZoneInfo
        zone = ZoneInfo(tz)
    except Exception as exc:  # unknown key, or no tz database on this machine
        raise ValueError("unknown time zone %r (%s)" % (tz, exc.__class__.__name__))
    fromtimestamp = _dt.datetime.fromtimestamp

    def offset(t: int) -> int:
        delta = fromtimestamp(t, zone).utcoffset()
        return delta.days * _DAY + delta.seconds
    return offset


class _Offsets:
    """UTC offsets over [lo, hi], found by asking the zone once per day and
    bisecting to the exact second whenever two samples differ. Looking a
    timestamp up is then a binary search over a handful of transitions."""

    def __init__(self, offset_at: Callable[[int], int], lo: int, hi: int):
        self.starts = [lo]
        self.offsets = [offset_at(lo)]
        t = lo
        current = self.offsets[0]
        while t < hi:
            nxt = min(t + _DAY, hi)
            if offset_at(nxt) == current:
                t = nxt
                continue
            a, b = t, nxt
            while b - a > 1:
                mid = (a + b) // 2
                if offset_at(mid) == current:
                    a = mid
                else:
                    b = mid
            current = offset_at(b)
            self.starts.append(b)
            self.offsets.append(current)
            t = b
        self.single = len(self.starts) == 1

    def at(self, t: int) -> int:
        if self.single:
            return self.offsets[0]
        return self.offsets[bisect.bisect_right(self.starts, t) - 1]


def resolve_period(today: int, year: Optional[int] = None, all_time: bool = False,
                   start: Optional[str] = None, end: Optional[str] = None,
                   label: Optional[str] = None) -> Tuple[Optional[int], int, Optional[str]]:
    """Work out the period as day numbers (days since 1970-01-01, local).

    Returns ``(start_day or None, end_day, label or None)``. ``None`` for the
    start means "from the first message"; a ``None`` label is filled in once
    the real start is known.
    """
    if all_time:
        return None, today, label or "All time"
    if start is not None or end is not None:
        start_day = _parse_iso(start, "start") if start is not None else None
        end_day = _parse_iso(end, "end") if end is not None else today
        if start_day is not None and start_day > end_day:
            raise ValueError("the period starts after it ends: %s > %s" % (start, _iso(end_day)))
        return start_day, end_day, label
    this_year, month, _day = _civil_from_days(today)
    if year is None:
        year = this_year - 1 if month == 1 else this_year
    year = int(year)
    start_day = _days_from_civil(year, 1, 1)
    end_day = _days_from_civil(year, 12, 31)
    if year == this_year:
        end_day = today
    return start_day, end_day, label or str(year)


# --------------------------------------------------------------------------- #
# small helpers for the output
# --------------------------------------------------------------------------- #

def _round4(numerator: int, denominator: int):
    """Share rounded to 4 decimals, half up (section 2, "Rounding"). Whole
    numbers come back as ints so that JSON output matches JavaScript's."""
    if not denominator:
        return 0
    value = math.floor(numerator / denominator * 10000 + 0.5) / 10000
    return int(value) if value == int(value) else value


def _hour12(hour: int) -> str:
    return "%d %s" % (hour % 12 or 12, "AM" if hour < 12 else "PM")


def _personality(by_hour: List[int], by_weekday: List[int], total: int) -> Dict[str, Any]:
    peak = max(by_hour) if by_hour else 0
    peak_hour = by_hour.index(peak)
    if total < 50:
        pid = "quiet_ones"
    elif sum(by_hour[:LATE_NIGHT_HOURS]) / total >= 0.12 or peak_hour <= 4:
        pid = "night_owls"
    elif (by_weekday[5] + by_weekday[6]) / total >= 0.42:
        pid = "weekend_warriors"
    elif peak / total < 0.065:
        pid = "always_on"
    elif peak_hour <= 8:
        pid = "early_birds"
    elif peak_hour <= 11:
        pid = "morning_meeting"
    elif peak_hour <= 13:
        pid = "lunch_break"
    elif peak_hour <= 17:
        pid = "afternoon_slackers"
    elif peak_hour <= 20:
        pid = "dinner_table"
    else:
        pid = "after_hours"
    title, line = PERSONALITIES[pid]
    return {
        "id": pid,
        "title": title,
        "blurb": "Peak hour: %s. %s" % (_hour12(peak_hour), line),
        "peak_hour": peak_hour,
    }


# per-sender counters, by position
_MSG, _WORDS, _ATT, _LATE, _GIVEN, _RECV, _LAUGHS = range(7)


def _top(people: Dict[str, List[int]], field: int) -> Optional[Tuple[str, int]]:
    """Highest ``field``; ties go to more messages, then to the name."""
    best = None
    best_key = None
    for name, c in people.items():
        if c[field] <= 0:
            continue
        key = (-c[field], -c[_MSG], _u16(name))
        if best_key is None or key < best_key:
            best, best_key = name, key
    return (best, people[best][field]) if best is not None else None


def _awards(people: Dict[str, List[int]]) -> List[Dict[str, Any]]:
    qualifying = {n: c for n, c in people.items() if c[_MSG] >= AWARD_MIN_MESSAGES}
    if len(qualifying) < AWARD_MIN_SENDERS:
        return []

    def most(field: int, minimum: int) -> Optional[Tuple[str, str]]:
        top = _top({n: c for n, c in qualifying.items() if c[field] >= minimum}, field)
        return (top[0], "{:,}".format(top[1])) if top else None

    winners: Dict[str, Optional[Tuple[str, str]]] = {}
    winners["yapper"] = most(_MSG, 1)
    lurker = min(qualifying, key=lambda n: (qualifying[n][_MSG], _u16(n)))
    winners["lurker"] = (lurker, "{:,}".format(qualifying[lurker][_MSG]))
    winners["night_owl"] = most(_LATE, AWARD_MIN_COUNT)
    winners["comedian"] = most(_LAUGHS, AWARD_MIN_COUNT)
    winners["hype"] = most(_GIVEN, AWARD_MIN_COUNT)
    novelists = [n for n, c in qualifying.items() if c[_MSG] >= NOVELIST_MIN_MESSAGES]
    if novelists:
        best = min(novelists, key=lambda n: (
            -Fraction(qualifying[n][_WORDS], qualifying[n][_MSG]), -qualifying[n][_MSG], _u16(n)))
        words, messages = qualifying[best][_WORDS], qualifying[best][_MSG]
        tenths = (words * 20 + messages) // (2 * messages)      # one decimal, half up
        winners["novelist"] = (best, "%d.%d" % (tenths // 10, tenths % 10))
    else:
        winners["novelist"] = None
    winners["paparazzi"] = most(_ATT, AWARD_MIN_COUNT)
    winners["favorite"] = most(_RECV, AWARD_MIN_COUNT)

    chosen, deferred, holders = [], [], set()
    for award_id, emoji, title, template in AWARDS:
        won = winners[award_id]
        if won is None:
            continue
        name, figure = won
        entry = {
            "id": award_id, "emoji": emoji, "title": title, "winner": name,
            "detail": template.replace("{n}", figure).replace("{x}", figure),
        }
        if name in holders:
            deferred.append(entry)
        elif len(chosen) < MAX_AWARDS:
            chosen.append(entry)
            holders.add(name)
    return (chosen + deferred)[:MAX_AWARDS]


# --------------------------------------------------------------------------- #
# the engine
# --------------------------------------------------------------------------- #

def compute_stats(rows: Iterable[Mapping[str, Any]], options: Optional[Mapping[str, Any]] = None,
                  **kwargs: Any) -> Dict[str, Any]:
    """Compute the stats JSON (schema ``v: 1``) for one chat.

    ``rows`` are the chat's message rows in the shape described in the module
    docstring, in any order, each message once. Options (a mapping, keyword
    arguments, or both):

    ``tz``            IANA zone name used for every local date and hour.
                      Default: the zone of the computer running the code.
    ``year``          Calendar year to cover. Default: the current year, or
                      the previous one when it is January.
    ``all_time``      Cover everything up to today instead of one year.
    ``start``/``end`` Explicit inclusive ``YYYY-MM-DD`` bounds (local dates).
    ``label``         Override ``period.label``.
    ``now``           Unix seconds treated as the current time (default: the
                      clock). "Today" bounds the period and dates the output.
    ``me``            Display name of the database owner (default ``"Me"``).
    ``contacts``      ``{identifier: name}`` or ``[(identifier, name), ...]``
                      where identifiers are phone numbers or e-mail addresses.
    ``chat_name``     chat.display_name; empty means "build one from members".
    ``participants``  handle.id values from chat_handle_join (members other
                      than the owner), used for the member count and the
                      fallback name.
    ``source``        Recorded in ``meta.source`` (default ``"chat.db"``).

    Returns a new ``dict`` with exactly the keys of docs/SCHEMA.md section 1.
    Raises ``ValueError`` for an unknown time zone or impossible dates.
    """
    opts: Dict[str, Any] = dict(options or {})
    opts.update(kwargs)
    me = opts.get("me") or "Me"
    lookup = build_contact_lookup(opts.get("contacts"))
    names = _Names(me, lookup)
    now = opts.get("now")
    now = int(time.time() if now is None else now)
    if not isinstance(rows, (list, tuple)):
        rows = list(rows)

    # ---- pass 0: timestamps, and the range the time-zone table must cover --
    stamps: List[Optional[Tuple[int, int]]] = []
    lo = hi = now
    for row in rows:
        stamp = _split_date(row.get("date"))
        stamps.append(stamp)
        if stamp is not None:
            sec = stamp[0]
            if sec < lo:
                lo = sec
            elif sec > hi:
                hi = sec
    table = _Offsets(_offset_function(opts.get("tz")), lo, hi)
    offset_at = table.at

    today = (now + offset_at(now)) // _DAY
    start_day, end_day, label = resolve_period(
        today, opts.get("year"), bool(opts.get("all_time")), opts.get("start"), opts.get("end"),
        opts.get("label"))

    # ---- pass 1: tapbacks, in chronological order ---------------------------
    taps = []
    for index, row in enumerate(rows):
        kind = row.get("associated_message_type")
        if not kind or kind < 2000 or kind > 3007 or 2007 < kind < 3000:
            continue
        stamp = stamps[index]
        if stamp is None:
            continue
        sec, frac = stamp
        if (sec + offset_at(sec)) // _DAY > end_day:
            continue                    # added after the period ended
        taps.append((sec, frac, row.get("rowid") or 0, index))
    taps.sort()
    state: Dict[Tuple[str, str], int] = {}
    for sec, frac, _rowid, index in taps:
        row = rows[index]
        target = row.get("associated_message_guid")
        if not target:
            continue
        # one tapback per person per message part: the key keeps the "p:N/" or
        # "bp:" prefix, the message is whatever follows it
        key = (target, names.sender(row))
        kind = row["associated_message_type"]
        if kind >= 3000:
            state.pop(key, None)
        else:
            state[key] = _KIND_OF[kind]
    standing: Dict[str, List[Tuple[str, int]]] = {}
    for (target, reactor), kind in state.items():
        slash = target.rfind("/")
        if slash >= 0:
            guid = target[slash + 1:]
        else:
            colon = target.find(":")
            guid = target[colon + 1:] if colon >= 0 else target
        standing.setdefault(guid, []).append((reactor, kind))

    # ---- pass 2: countable messages inside the period -----------------------
    people: Dict[str, List[int]] = {}
    by_hour = [0] * 24
    day_counts: Dict[int, int] = {}
    reacted = []                        # messages with standing tapbacks
    total = words_total = attachments_total = 0
    first_day = None
    seg_lo = seg_hi = 0                 # cached [seg_lo, seg_hi) with one offset
    seg_off = 0
    starts, offsets = table.starts, table.offsets
    get_standing = standing.get if standing else None

    for index, row in enumerate(rows):
        stamp = stamps[index]
        if stamp is None:
            continue
        get = row.get
        kind = get("associated_message_type")
        if kind and kind >= 1000:
            continue                    # tapbacks, stickers, poll votes
        if get("item_type"):
            continue                    # group events
        sec = stamp[0]
        if not seg_lo <= sec < seg_hi:
            i = bisect.bisect_right(starts, sec) - 1
            seg_off = offsets[i]
            seg_lo = starts[i]
            seg_hi = starts[i + 1] if i + 1 < len(starts) else _MAX_UNIX + _DAY
        local = sec + seg_off
        day = local // _DAY
        if day > end_day or (start_day is not None and day < start_day):
            continue
        text = get("text")
        if not text:
            body = get("attributedBody")
            text = decode_attributed_body(body) if body else None
        elif not isinstance(text, str):
            text = bytes(text).decode("utf-8", "replace")
        text = clean_text(text)
        has_attachment = 1 if get("cache_has_attachments") else 0
        if not text and not has_attachment and not get("keep_empty"):
            continue                    # unsent or empty

        sender = me if get("is_from_me") else names.handle(get("handle"))
        counters = people.get(sender)
        if counters is None:
            counters = people[sender] = [0, 0, 0, 0, 0, 0, 0]
        n_words = count_words(text)
        hour = (local - day * _DAY) // 3600
        total += 1
        words_total += n_words
        counters[_MSG] += 1
        counters[_WORDS] += n_words
        if has_attachment:
            attachments_total += 1
            counters[_ATT] += 1
        if hour < LATE_NIGHT_HOURS:
            counters[_LATE] += 1
        by_hour[hour] += 1
        day_counts[day] = day_counts.get(day, 0) + 1
        if first_day is None or day < first_day:
            first_day = day
        if get_standing is not None:
            guid = get("guid")
            marks = get_standing(guid) if guid else None
            if marks:
                reacted.append((sec, stamp[1], get("rowid") or 0, sender, day, text,
                                has_attachment, marks))

    # ---- standing tapbacks on those messages ---------------------------------
    by_kind = [0] * len(KINDS)
    givers: Dict[str, int] = {}
    quotes = []
    for sec, frac, rowid, sender, day, text, has_attachment, marks in reacted:
        kinds = [0] * len(KINDS)
        for reactor, kind in marks:
            kinds[kind] += 1
            by_kind[kind] += 1
            givers[reactor] = givers.get(reactor, 0) + 1
        counters = people[sender]
        counters[_RECV] += len(marks)
        counters[_LAUGHS] += kinds[_LAUGH]
        quotes.append((-len(marks), sec, frac, rowid, sender, day, text, has_attachment, kinds))
    for reactor, count in givers.items():
        counters = people.get(reactor)
        if counters is not None:
            counters[_GIVEN] = count
    reactions_total = sum(by_kind)

    # ---- calendar aggregates --------------------------------------------------
    by_weekday = [0] * 7
    by_month = [0] * 12
    busiest = None
    longest = run = 0
    previous = None
    for day in sorted(day_counts):
        count = day_counts[day]
        by_weekday[(day + 3) % 7] += count          # 1970-01-01 was a Thursday
        by_month[_civil_from_days(day)[1] - 1] += count
        if busiest is None or count > busiest[1]:
            busiest = (day, count)
        run = run + 1 if previous is not None and day == previous + 1 else 1
        if run > longest:
            longest = run
        previous = day

    if start_day is None:
        start_day = first_day if first_day is not None else end_day
    if label is None:
        label = "%s \u2013 %s" % (_iso(start_day), _iso(end_day))

    # ---- people -----------------------------------------------------------------
    ranked = sorted(people.items(), key=lambda item: (-item[1][_MSG], _u16(item[0])))
    senders = [
        {
            "name": name,
            "messages": c[_MSG],
            "share": _round4(c[_MSG], total),
            "words": c[_WORDS],
            "attachments": c[_ATT],
            "late_night": c[_LATE],
            "reactions_given": c[_GIVEN],
            "reactions_received": c[_RECV],
        }
        for name, c in ranked[:MAX_SENDERS]
    ]
    late_total = sum(by_hour[:LATE_NIGHT_HOURS])
    late_top = _top(people, _LATE)

    # the top giver may be someone who reacted without ever writing
    top_giver = None
    giver_key = None
    for reactor, count in givers.items():
        key = (-count, -(people[reactor][_MSG] if reactor in people else 0), _u16(reactor))
        if giver_key is None or key < giver_key:
            top_giver, giver_key = {"name": reactor, "count": count}, key
    top_receiver = _top(people, _RECV)

    quotes.sort(key=lambda q: q[:4])
    most_reacted = []
    for neg_count, _sec, _frac, _rowid, sender, day, text, has_attachment, kinds in quotes[:3]:
        order = sorted(range(len(KINDS)), key=lambda k: (-kinds[k], k))
        entry = {
            "sender": sender,
            "reactions": -neg_count,
            "date": _iso(day),
            "text": _truncate(text, MAX_QUOTE),
            "kinds": {KINDS[k]: kinds[k] for k in order if kinds[k]},
        }
        if has_attachment:
            entry["attachment"] = True
        most_reacted.append(entry)

    members = set(people)
    members.add(me)
    participants = [h for h in (opts.get("participants") or []) if h]
    resolved = _distinct(names.handle(h) for h in participants)
    members.update(resolved)
    chat_name = (opts.get("chat_name") or "").strip(WHITESPACE)
    if not chat_name:
        chat_name = _fallback_name(resolved, me)

    return {
        "v": 1,
        "chat": {"name": chat_name, "members": len(members)},
        "period": {"label": label, "start": _iso(start_day), "end": _iso(end_day)},
        "totals": {
            "messages": total,
            "words": words_total,
            "attachments": attachments_total,
            "reactions": reactions_total,
            "days_active": len(day_counts),
            "longest_streak": longest,
        },
        "by_hour": by_hour,
        "by_weekday": by_weekday,
        "by_month": by_month,
        "busiest_day": {"date": _iso(busiest[0]), "messages": busiest[1]} if busiest else None,
        "personality": _personality(by_hour, by_weekday, total),
        "late_night": {
            "messages": late_total,
            "share": _round4(late_total, total),
            "top": {"name": late_top[0], "messages": late_top[1]} if late_top else None,
        },
        "senders": senders,
        "most_reacted": most_reacted,
        "reactions": {
            "by_kind": {KINDS[k]: by_kind[k] for k in range(len(KINDS))},
            "top_giver": top_giver,
            "top_receiver": ({"name": top_receiver[0], "count": top_receiver[1]}
                             if top_receiver else None),
        },
        "awards": _awards(people),
        "meta": {
            "generator": opts.get("generator") or GENERATOR,
            "source": opts.get("source") or "chat.db",
            "generated": _iso(today),
        },
    }
