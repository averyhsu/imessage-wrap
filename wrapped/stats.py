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

Values of the wrong type never raise, and both engines read them the same way:
a number is used as an integer (truncated towards zero) and anything that is
not a number or ``True`` counts as 0; ``text`` is a ``str`` or UTF-8 bytes and
``attributedBody`` is bytes; ``guid``, ``handle`` and
``associated_message_guid`` are strings (anything else is "not there"); a
``date`` is an int, a float (the fraction is dropped) or a decimal string; rows
that are not mappings are skipped. :mod:`wrapped.db` casts every column in
SQL, so cells of an unexpected type already arrive in this shape.

Every name that reaches the stats is cleaned and capped (:func:`clean_name`: a
person's name at 40 characters, a chat's at 80) and masked
(:func:`mask_handle`, :func:`mask_chat_name`): handles, imported senders,
names from the contact table and the owner's own name alike.
:func:`short_names` turns a finished stats object into the first-name form
that is meant to be shared.
"""

from __future__ import annotations

import bisect
import copy
import datetime as _dt
import math
import re
import time
from fractions import Fraction
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .typedstream import decode_attributed_body

__all__ = [
    "compute_stats", "chat_display_name", "contact_key", "build_contact_lookup", "ContactLookup",
    "clean_name", "mask_handle", "mask_chat_name", "short_names", "NAME_LIMIT", "CHAT_NAME_LIMIT",
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
_DATE_DIGITS = re.compile(r"\+?[0-9]+\Z")
_ASCII_LOWER = {c: c + 32 for c in range(65, 91)}
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")

MAX_SENDERS = 12
MAX_QUOTE = 180
LATE_NIGHT_HOURS = 5                # local hours 0..4

# id -> (emoji, title, line) for every personality of section 3. The order of
# this table means nothing; _TRAITS holds the order in which traits are tried.
PERSONALITIES = {
    "quiet_ones": ("\U0001F92B", "The Quiet Ones", "Few words. All of them count."),
    "one_person_show": ("\U0001F3A4", "The One-Person Show", "Everyone else is the audience."),
    "dynamic_duo": ("\U0001F46F", "The Dynamic Duo", "The rest are here for the show."),
    "round_table": ("\u2696\ufe0f", "The Round Table", "Everybody gets a turn."),
    "night_owls": ("\U0001F989", "The Night Owls", "Sleep is a suggestion."),
    "weekend_warriors": ("\U0001F389", "The Weekend Warriors", "Weekdays are for recovering."),
    "weekday_regulars": ("\U0001F4BC", "The Weekday Regulars", "Weekends are for other chats."),
    "always_on": ("\U0001F50B", "The Always-On Group Chat", "There is no off switch."),
    "daily_ritual": ("\U0001F4C6", "The Daily Ritual", "Skipping a day is not an option."),
    "flash_mob": ("\u26a1", "The Flash Mob", "When it rains, it pours."),
    "seasonal_special": ("\U0001F3D6\ufe0f", "The Seasonal Special",
                         "The rest of the year is the off-season."),
    "firehose": ("\U0001F6BF", "The Firehose", "Mute at your own risk."),
    "slow_burn": ("\U0001F56F\ufe0f", "The Slow Burn", "In no hurry at all."),
    "photo_dump": ("\U0001F4F8", "The Photo Dump", "Words optional."),
    "hype_squad": ("\U0001F64C", "The Hype Squad", "Nothing goes unnoticed."),
    "comedy_club": ("\U0001F602", "The Comedy Club",
                    "Everyone here thinks they are funny. They are right."),
    "love_fest": ("\U0001F496", "The Love Fest", "It is very supportive in here."),
    "essayists": ("\U0001F4DD", "The Essayists", "Every text is a paragraph."),
    "rapid_fire": ("\U0001F3D3", "The Rapid-Fire Round", "Why use many words."),
    # by peak hour, when no trait stands out
    "early_birds": ("\U0001F426", "The Early Birds", "Texting before coffee is a choice."),
    "morning_meeting": ("\u2615", "The Morning Meeting", "This could not have been an email."),
    "lunch_break": ("\U0001F96A", "The Lunch Break Legends",
                    "Eating with one hand, typing with the other."),
    "afternoon_slackers": ("\U0001F60E", "The Afternoon Slackers",
                           "Peak productivity, just not at work."),
    "dinner_table": ("\U0001F37D\ufe0f", "The Dinner Table", "Phones out, forks down."),
    "after_hours": ("\U0001F319", "The After-Hours Crew", "The day ends. The chat begins."),
}
QUIET_BELOW = 50                    # fewer messages than this: the Quiet Ones

# id, emoji, title, detail template ({n} or {x}), in table order (section 4)
AWARDS = (
    ("yapper", "\U0001F5E3\ufe0f", "The Yapper", "{n} messages. Nobody asked."),
    ("comedian", "\U0001F602", "The Comedian", "Made the chat laugh {n} times."),
    ("night_owl", "\U0001F989", "The Night Owl", "{n} messages after midnight."),
    ("starter", "\U0001F680", "The Conversation Starter", "Sent the first message of the day {n} times."),
    ("paparazzi", "\U0001F4F8", "The Paparazzi", "{n} photos, videos and memes."),
    ("interrogator", "\u2753", "The Interrogator", "Asked {n} questions."),
    ("hype", "\U0001F4E3", "The Hype Machine", "Handed out {n} tapbacks."),
    ("early_bird", "\U0001F426", "The Early Bird", "{n} messages before 9 AM."),
    ("closer", "\U0001F3AC", "The Last Word", "Had the last word on {n} days."),
    ("link_dropper", "\U0001F517", "The Link Dropper", "Shared {n} links."),
    ("favorite", "\u2b50", "The Crowd Favorite", "{n} tapbacks received."),
    ("double_texter", "\U0001F4F2", "The Double Texter", "{n} messages in a row. No reply needed."),
    ("novelist", "\U0001F4DA", "The Novelist", "{x} words per message. A paragraph person."),
    ("minimalist", "\u2702\ufe0f", "The Minimalist", "{x} words per message. Straight to the point."),
    ("lurker", "\U0001F47B", "The Lurker", "{n} messages. Reads everything, says little."),
)
MAX_AWARDS = 6
AWARD_MIN_MESSAGES = 5
AWARD_MIN_SENDERS = 3
AWARD_MIN_COUNT = 3
NOVELIST_MIN_MESSAGES = 20
NOVELIST_MIN_RATIO = Fraction(10)           # the Novelist writes at least 10 words per message
MINIMALIST_MAX_RATIO = Fraction(7, 2)       # the Minimalist at most 3.5
DOUBLE_TEXT_MIN_RUN = 5
EARLY_HOURS = (5, 9)                # local hours 5..8
_QUESTION_MARKS = ("?", "\uff1f")
_LINK_STARTS = ("http://", "https://")


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

NAME_LIMIT = 40             # a person's name: this many code points, plus an ellipsis when cut
CHAT_NAME_LIMIT = 80        # a chat's name
_NAME_WINDOW = 1024         # no name is looked at beyond this many code points


def contact_key(identifier: Optional[str]) -> Optional[str]:
    """Normalise a phone number or e-mail address for matching.

    E-mail (anything with ``@``): ASCII-lowercased. Phone: its last 10 ASCII
    digits. Returns ``None`` for anything else.
    """
    if identifier.__class__ is str and len(identifier) > _NAME_WINDOW:
        identifier = identifier[:_NAME_WINDOW]
    value = clean_name(identifier)
    if not value:
        return None
    if "@" in value:
        return "e:" + value.translate(_ASCII_LOWER)
    digits = _NOT_DIGIT.sub("", value)
    if digits:
        return "p:" + digits[-10:]
    return None


# First code point of every block of ten Unicode decimal digits (general
# category Nd, Unicode 17). Spelled out so that both engines agree whatever
# Unicode version their runtime ships.
_DIGIT_BLOCKS = (
    0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6, 0xD66,
    0xDE6, 0xE50, 0xED0, 0xF20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90,
    0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0,
    0xFF10, 0x104A0, 0x10D30, 0x10D40, 0x11066, 0x110F0, 0x11136, 0x111D0, 0x112F0, 0x11450,
    0x114D0, 0x11650, 0x116C0, 0x116D0, 0x116DA, 0x11730, 0x118E0, 0x11950, 0x11BF0, 0x11C50,
    0x11D50, 0x11DA0, 0x11DE0, 0x11F50, 0x16130, 0x16A60, 0x16AC0, 0x16B50, 0x16D70, 0x1CCF0,
    0x1D7CE, 0x1D7D8, 0x1D7E2, 0x1D7EC, 0x1D7F6, 0x1E140, 0x1E2F0, 0x1E4F0, 0x1E5F1, 0x1E950,
    0x1FBF0,
)
_DIGITS = frozenset(chr(start + i) for start in _DIGIT_BLOCKS for i in range(10))
_RUN_ENDS = frozenset(WHITESPACE + "<>()[]\"',;:")
# what may stand between the digits of one phone number (spaces, + - ( ) . and dashes)
_PHONE_JOINERS = frozenset(WHITESPACE + "+-()." + "\u2010\u2011\u2012\u2013\u2014\u2015\u2212")

# clean_name(): tab, line breaks and the Unicode line/paragraph separators
# become a space; other control characters, direction marks, overrides and
# isolates, the byte-order mark and the object/replacement characters are
# dropped. (Zero-width joiners and variation selectors stay: emoji need them.)
_NAME_TABLE = {c: None for c in list(range(0x00, 0x20)) + list(range(0x7F, 0xA0))
               + [0x200E, 0x200F] + list(range(0x202A, 0x202F)) + list(range(0x2066, 0x206A))
               + [0xFEFF, 0xFFFC, 0xFFFD]}
_NAME_TABLE.update({c: " " for c in (0x09, 0x0A, 0x0D, 0x2028, 0x2029)})
_SPACES = re.compile(" {2,}")


def clean_name(name: Any, limit: Optional[int] = None) -> str:
    """Make a name safe to print, log and share (docs/SCHEMA.md 2, "Clean
    names"): line breaks and tabs become a space; control characters,
    direction marks and overrides, U+FEFF, U+FFFC and U+FFFD are removed;
    runs of spaces collapse and the result is trimmed. Anything that is not a
    string gives ``""``.

    With ``limit`` (:data:`NAME_LIMIT` for a person, :data:`CHAT_NAME_LIMIT`
    for a chat) the name is also capped: only its first 1,024 code points are
    looked at, and a clean name longer than ``limit`` code points is cut to
    ``limit`` plus an ellipsis. The cost is bounded however long the input
    is. Cap before masking, so that a masked label is never cut."""
    if name.__class__ is not str or not name:
        return ""
    if limit is not None and len(name) > _NAME_WINDOW:
        name = name[:_NAME_WINDOW]
    name = name.translate(_NAME_TABLE)
    if "  " in name:
        name = _SPACES.sub(" ", name)
    name = name.strip(WHITESPACE)
    if limit is not None and len(name) > limit:
        name = name[:limit] + "\u2026"
    return name


def _mask_digits(label: str) -> str:
    digits = [ch for ch in label if ch in _DIGITS]
    if len(digits) >= 7:
        return "\u2026" + "".join(digits[-4:])
    return label


def _address_local(label: str) -> Optional[str]:
    """The part before the ``@`` of the first e-mail address in ``label`` (cut
    to 16 characters plus an ellipsis), or ``None`` when it holds none."""
    at = label.find("@")
    while at != -1:
        start = at
        while start > 0 and label[start - 1] not in _RUN_ENDS:
            start -= 1
        end = at + 1
        while end < len(label) and label[end] not in _RUN_ENDS:
            end += 1
        if start < at and end > at + 1:
            local = label[start:at]
            return local if len(local) <= 16 else local[:16] + "\u2026"
        at = label.find("@", at + 1)
    return None


def _phone_run(label: str) -> Optional[str]:
    """The last four digits of the first stretch of ``label`` that is shaped
    like a phone number, or ``None``. A stretch is digits joined by spaces,
    ``+ - ( ) .`` or dashes; it counts when it holds ten or more digits, or
    seven or more after a ``+``. Years and counts ("Class of 2026-2027",
    "Flat 12") are not phone numbers."""
    digits: List[str] = []
    plus = False
    for ch in label + "\0":
        if ch in _DIGITS:
            digits.append(ch)
        elif ch == "+" or ch not in _PHONE_JOINERS:
            if len(digits) >= 10 or (plus and len(digits) >= 7):
                return "".join(digits[-4:])
            digits = []
            plus = ch == "+"
    return None


def mask_chat_name(label: str) -> str:
    """Hide a phone number or e-mail address in a chat's own name
    (docs/SCHEMA.md 2, "Masking"). People name chats on purpose and often
    with numbers in them, so the test for a phone number is stricter here
    than for a sender label: see :func:`_phone_run`."""
    local = _address_local(label)
    if local is not None:
        return _mask_digits(local)
    tail = _phone_run(label)
    return label if tail is None else "\u2026" + tail


def mask_handle(label: str) -> str:
    """Hide a phone number or e-mail address inside a label.

    A recap is made to be shared, so a raw number or address never goes into
    it (docs/SCHEMA.md 2, "Masking"). The rule is applied to every sender
    label that did not come from the contact table and to chat names:

    The rule is applied to every sender label (handles, imported senders,
    names from the contact table and the owner's own name):

    1. if the label contains an e-mail address (characters around an ``@``,
       at least one on each side, up to whitespace or one of
       ``< > ( ) [ ] " ' , ; :``) it becomes the part before the ``@``, cut
       to 16 characters plus an ellipsis when longer;
    2. if the label (or that local part) holds seven or more decimal digits
       in total, in any script and whatever separates them, it becomes an
       ellipsis plus its last four digits as written;
    3. anything else is returned unchanged.
    """
    local = _address_local(label)
    return _mask_digits(label if local is None else local)


class ContactLookup(dict):
    """A normalised ``{contact_key: display name}`` table."""


def build_contact_lookup(contacts: Any) -> "ContactLookup":
    """Turn ``{identifier: name}`` or ``[(identifier, name), ...]`` into a
    ``{contact_key: name}`` table. When two cards claim the same number or
    address under different names, the name that sorts first wins, so the
    result does not depend on the order of the input.

    People do save contacts under a number or an address, so a contact name
    is a sender label like any other: it is cleaned, capped and masked
    ("Dr. Okafor 555-010-0403" is shown as an ellipsis and 0403)."""
    if isinstance(contacts, ContactLookup):
        return contacts
    lookup = ContactLookup()
    if not contacts or isinstance(contacts, (str, bytes)):
        return lookup
    try:
        pairs = list(contacts.items() if isinstance(contacts, Mapping) else contacts)
    except TypeError:                   # not a table of any kind
        return lookup
    for pair in pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            continue
        identifier, name = pair[0], pair[1]
        if identifier.__class__ is not str or name.__class__ is not str:
            continue
        name = person_label(name)
        key = contact_key(identifier)
        if not name or key is None:
            continue
        previous = lookup.get(key)
        if previous is None or _u16(name) < _u16(previous):
            lookup[key] = name
    return lookup


def person_label(name: Any) -> str:
    """What may be shown for a person: the name cleaned, capped at
    :data:`NAME_LIMIT` and masked ("" when nothing is left)."""
    return mask_handle(clean_name(name, NAME_LIMIT))


class _Names:
    """handle -> display name, with the owner and the contact table applied.
    Every label is cleaned, capped and masked."""

    def __init__(self, me: str, lookup: Dict[str, str]):
        self.me = me
        self.lookup = lookup
        self.cache: Dict[Any, str] = {}

    def handle(self, handle: Any) -> str:
        if handle.__class__ is not str:
            return "Unknown"
        if len(handle) > _NAME_WINDOW:
            handle = handle[:_NAME_WINDOW]
        name = self.cache.get(handle)
        if name is None:
            key = contact_key(handle)
            name = self.lookup.get(key) if key else None
            if not name:
                name = person_label(handle) or "Unknown"
            self.cache[handle] = name
        return name

    def sender(self, row: Mapping[str, Any]) -> str:
        if _flag(row.get("is_from_me")):
            return self.me
        return self.handle(row.get("handle"))


def _chat_label(display_name: Any) -> str:
    """A chat's own name, cleaned, capped and masked ("" when it has none)."""
    return mask_chat_name(clean_name(display_name, CHAT_NAME_LIMIT))


def _owner_name(me: Any) -> str:
    """The owner's name as it goes into the stats: a sender label like any other."""
    return person_label(me) or "Me"


def chat_display_name(display_name: Optional[str], participants: Optional[Sequence[str]],
                      contacts: Any = None, me: str = "Me") -> str:
    """The chat's name: ``display_name`` (cleaned, and masked if somebody
    named the chat after a phone number or an address) when it has one,
    otherwise the first names of up to three members (in the order given, the
    owner left out) joined with ", " plus " & N more".

    ``contacts`` is anything :func:`build_contact_lookup` accepts, or the
    table it returned (pass that when naming many chats)."""
    name = _chat_label(display_name)
    if name:
        return name
    if not isinstance(contacts, ContactLookup):
        contacts = build_contact_lookup(contacts)
    me = _owner_name(me)
    names = _Names(me, contacts)
    members = participants if isinstance(participants, (list, tuple)) else []
    return _fallback_name(_distinct(names.handle(h) for h in members if h.__class__ is str and h), me)


def _int(value: Any) -> int:
    """A database integer, whatever type it arrived as (anything that is not
    a number counts as 0, so both engines read odd input the same way)."""
    if value is True:
        return 1
    if value.__class__ is int:
        return value
    if value.__class__ is float and value == value:
        return int(value) if abs(value) < 1e18 else value      # +-inf compares like JavaScript's
    return 0


def _flag(value: Any) -> bool:
    return (value if value.__class__ is int else _int(value)) != 0


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
    return _truncate(label, CHAT_NAME_LIMIT)


# --------------------------------------------------------------------------- #
# dates and time zones
# --------------------------------------------------------------------------- #

def _split_date(value: Any) -> Optional[Tuple[int, int]]:
    """message.date -> (Unix seconds, nanoseconds within the second).

    Accepts an int, a float (truncated) or a string of ASCII digits; anything
    else, zero and negative values are "no date"."""
    kind = value.__class__
    if kind is str:
        text = value.strip(WHITESPACE)
        if not _DATE_DIGITS.match(text):
            return None
        value = int(text)
    elif kind is float:
        if value != value or value < 1 or value > 1e30:
            return None
        value = int(value)
    elif kind is not int:
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
    if year.__class__ is float and year == year and abs(year) < 1e6 and year == int(year):
        year = int(year)
    if year.__class__ is not int or not 1 <= year <= 9999:
        raise ValueError("the year must be a whole number between 1 and 9999, got %r" % (year,))
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


MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December")


def _thousands(n: int) -> str:
    return "{:,}".format(n)


def _pct(part: int, whole: int) -> str:
    """Whole percent, half up, in integer arithmetic (section 3)."""
    return "%d%%" % ((200 * part + whole) // (2 * whole))


def _tenths(part: int, whole: int) -> str:
    """part / whole with one decimal, half up, in integer arithmetic."""
    tenths = (part * 20 + whole) // (2 * whole)
    return "%d.%d" % (tenths // 10, tenths % 10)


def _nearest(part: int, whole: int) -> int:
    """part / whole rounded to a whole number, half up."""
    return (2 * part + whole) // (2 * whole)


def _best3(by_hour: Sequence[int]) -> int:
    return max(by_hour[a] + by_hour[(a + 1) % 24] + by_hour[(a + 2) % 24] for a in range(24))


# Section 3, step 2, in table order: id, gate, value, high (True) or low
# (False), floor, ceil, reason. ``f`` holds the figures that
# :func:`personality_figures` describes.
_TRAITS = (
    ("one_person_show", lambda f: f["n"] >= 3, lambda f: f["top1"] / f["T"], True, 0.50, 0.85,
     lambda f: "One person sent %s of the messages" % _pct(f["top1"], f["T"])),
    ("dynamic_duo", lambda f: f["n"] >= 4, lambda f: (f["top1"] + f["top2"]) / f["T"], True, 0.80, 0.98,
     lambda f: "Two people sent %s of the messages" % _pct(f["top1"] + f["top2"], f["T"])),
    ("round_table", lambda f: f["n"] >= 4 and f["low"] * f["n"] * 2 >= f["T"],
     lambda f: f["top1"] * f["n"] / f["T"], False, 1.35, 1.0,
     lambda f: "%s people, and nobody sent more than %s" % (_thousands(f["n"]), _pct(f["top1"], f["T"]))),
    ("night_owls", lambda f: True, lambda f: f["night"] / f["T"], True, 0.25, 0.50,
     lambda f: "%s of messages between midnight and 5 AM" % _pct(f["night"], f["T"])),
    ("weekend_warriors", lambda f: True, lambda f: f["weekend"] / f["T"], True, 0.45, 0.75,
     lambda f: "%s of messages on Saturday and Sunday" % _pct(f["weekend"], f["T"])),
    ("weekday_regulars", lambda f: f["P"] >= 14, lambda f: f["weekend"] / f["T"], False, 0.10, 0.0,
     lambda f: "%s of messages Monday to Friday" % _pct(f["T"] - f["weekend"], f["T"])),
    ("always_on", lambda f: f["T"] >= 200, lambda f: f["best3"] / f["T"], False, 0.20, 0.125,
     lambda f: "Only %s of messages in its busiest three hours" % _pct(f["best3"], f["T"])),
    ("daily_ritual", lambda f: f["P"] >= 28, lambda f: f["D"] / f["P"], True, 0.97, 1.0,
     lambda f: "Active on %s of %s days" % (_thousands(f["D"]), _thousands(f["P"]))),
    ("flash_mob", lambda f: f["P"] >= 28 and f["D"] >= 3, lambda f: f["day1"] / f["T"], True, 0.15, 0.50,
     lambda f: "%s of the messages landed on a single day" % _pct(f["day1"], f["T"])),
    ("seasonal_special", lambda f: f["P"] >= 180, lambda f: f["month1"] / f["T"], True, 0.40, 0.80,
     lambda f: "%s of messages came in %s" % (_pct(f["month1"], f["T"]), MONTHS[f["month1_index"]])),
    ("firehose", lambda f: True, lambda f: f["T"] / f["P"], True, 100, 500,
     lambda f: "%s messages a day, on average" % _thousands(_nearest(f["T"], f["P"]))),
    ("slow_burn", lambda f: f["P"] >= 90, lambda f: f["P"] / f["T"], True, 2, 7,
     lambda f: "About one message every %s days" % _thousands(_nearest(f["P"], f["T"]))),
    ("photo_dump", lambda f: True, lambda f: f["A"] / f["T"], True, 0.25, 0.60,
     lambda f: "%s of messages carry a photo, video or file" % _pct(f["A"], f["T"])),
    ("hype_squad", lambda f: f["R"] >= 20, lambda f: f["R"] / f["T"], True, 0.50, 1.0,
     lambda f: "%s tapbacks on %s messages" % (_thousands(f["R"]), _thousands(f["T"]))),
    ("comedy_club", lambda f: f["R"] >= 20 and f["R"] * 20 >= f["T"], lambda f: f["laugh"] / f["R"],
     True, 0.50, 0.85, lambda f: "%s of all tapbacks are Ha Ha" % _pct(f["laugh"], f["R"])),
    ("love_fest", lambda f: f["R"] >= 20 and f["R"] * 20 >= f["T"], lambda f: f["love"] / f["R"],
     True, 0.60, 0.90, lambda f: "%s of all tapbacks are hearts" % _pct(f["love"], f["R"])),
    ("essayists", lambda f: f["Wd"] > 0, lambda f: f["Wd"] / f["T"], True, 14, 30,
     lambda f: "%s words per message, on average" % _tenths(f["Wd"], f["T"])),
    ("rapid_fire", lambda f: f["Wd"] > 0 and f["A"] * 4 < f["T"], lambda f: f["Wd"] / f["T"], False, 3.5, 1.5,
     lambda f: "%s words per message, on average" % _tenths(f["Wd"], f["T"])),
)


def _by_peak_hour(hour: int) -> str:
    if hour <= 4:
        return "night_owls"
    if hour <= 8:
        return "early_birds"
    if hour <= 11:
        return "morning_meeting"
    if hour <= 13:
        return "lunch_break"
    if hour <= 17:
        return "afternoon_slackers"
    if hour <= 20:
        return "dinner_table"
    return "after_hours"


def personality_figures(totals: Mapping[str, int], by_hour: Sequence[int], by_weekday: Sequence[int],
                        by_month: Sequence[int], period_days: int, busiest: int,
                        by_kind: Mapping[str, int], sender_counts: Iterable[int]) -> Dict[str, Any]:
    """The numbers section 3 works from. ``sender_counts`` holds the
    messages of every sender with at least one countable message (all of
    them, not only the twelve that are listed)."""
    counts = sorted((c for c in sender_counts if c > 0), reverse=True)
    month1 = max(by_month) if by_month else 0
    return {
        "T": totals["messages"], "H": list(by_hour), "P": period_days, "D": totals["days_active"],
        "R": totals["reactions"], "A": totals["attachments"], "Wd": totals["words"],
        "n": len(counts), "top1": counts[0] if counts else 0,
        "top2": counts[1] if len(counts) > 1 else 0, "low": counts[-1] if counts else 0,
        "night": sum(by_hour[:LATE_NIGHT_HOURS]), "weekend": by_weekday[5] + by_weekday[6],
        "best3": _best3(by_hour), "month1": month1, "month1_index": list(by_month).index(month1),
        "day1": busiest, "laugh": by_kind.get("laugh", 0), "love": by_kind.get("love", 0),
    }


def personality(f: Mapping[str, Any]) -> Dict[str, Any]:
    """Section 3: the chat's personality from :func:`personality_figures`."""
    by_hour = f["H"]
    peak_hour = by_hour.index(max(by_hour))
    total = f["T"]
    if total < QUIET_BELOW:
        pid = "quiet_ones"
        reason = "1 message in total" if total == 1 else "%s messages in total" % _thousands(total)
    else:
        pid = reason = None
        best = -1.0
        for tid, gate, value, high, floor, ceil, why in _TRAITS:
            if not gate(f):
                continue
            v = value(f)
            if not (v >= floor if high else v <= floor):
                continue
            strength = min(1, abs(v - floor) / abs(ceil - floor))
            if strength > best:
                pid, best, reason = tid, strength, why
        if pid is None:
            pid = _by_peak_hour(peak_hour)
            reason = "Peak hour: %s" % _hour12(peak_hour)
        else:
            reason = reason(f)
    emoji, title, line = PERSONALITIES[pid]
    return {
        "id": pid,
        "emoji": emoji,
        "title": title,
        "reason": reason,
        "blurb": "%s. %s" % (reason, line),
        "peak_hour": peak_hour,
    }


# per-sender counters, by position
(_MSG, _WORDS, _ATT, _LATE, _GIVEN, _RECV, _LAUGHS,
 _EARLY, _QUESTIONS, _LINKS, _STARTS, _ENDS, _RUN) = range(13)
_COUNTERS = 13


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

    def words_per_message(names: List[str], sign: int) -> Optional[Tuple[str, str]]:
        """Highest (sign -1) or lowest (sign 1) words per message, compared
        exactly; ties go to more messages, then to the name."""
        if not names:
            return None
        best = min(names, key=lambda n: (
            sign * Fraction(qualifying[n][_WORDS], qualifying[n][_MSG]), -qualifying[n][_MSG], _u16(n)))
        return (best, _tenths(qualifying[best][_WORDS], qualifying[best][_MSG]))

    winners: Dict[str, Optional[Tuple[str, str]]] = {}
    winners["yapper"] = most(_MSG, 1)
    winners["comedian"] = most(_LAUGHS, AWARD_MIN_COUNT)
    winners["night_owl"] = most(_LATE, AWARD_MIN_COUNT)
    winners["starter"] = most(_STARTS, AWARD_MIN_COUNT)
    winners["paparazzi"] = most(_ATT, AWARD_MIN_COUNT)
    winners["interrogator"] = most(_QUESTIONS, AWARD_MIN_COUNT)
    winners["hype"] = most(_GIVEN, AWARD_MIN_COUNT)
    winners["early_bird"] = most(_EARLY, AWARD_MIN_COUNT)
    winners["closer"] = most(_ENDS, AWARD_MIN_COUNT)
    winners["link_dropper"] = most(_LINKS, AWARD_MIN_COUNT)
    winners["favorite"] = most(_RECV, AWARD_MIN_COUNT)
    winners["double_texter"] = most(_RUN, DOUBLE_TEXT_MIN_RUN)
    def ratio(name: str) -> Fraction:
        return Fraction(qualifying[name][_WORDS], qualifying[name][_MSG])

    novelist = words_per_message(
        [n for n, c in qualifying.items() if c[_MSG] >= NOVELIST_MIN_MESSAGES], -1)
    winners["novelist"] = novelist if novelist and ratio(novelist[0]) >= NOVELIST_MIN_RATIO else None
    terse = [n for n, c in qualifying.items() if c[_MSG] >= NOVELIST_MIN_MESSAGES and c[_WORDS] >= 1]
    minimalist = words_per_message(terse, 1) if len(terse) >= 2 else None
    winners["minimalist"] = (minimalist if minimalist and ratio(minimalist[0]) <= MINIMALIST_MAX_RATIO
                             else None)
    lurker = min(qualifying, key=lambda n: (qualifying[n][_MSG], _u16(n)))
    winners["lurker"] = (lurker, _thousands(qualifying[lurker][_MSG]))

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
    if options is not None and not isinstance(options, Mapping):
        raise ValueError("options must be a mapping, got %s" % type(options).__name__)
    opts: Dict[str, Any] = dict(options or {})
    opts.update(kwargs)
    me = _owner_name(opts.get("me"))
    lookup = build_contact_lookup(opts.get("contacts"))
    names = _Names(me, lookup)
    now = opts.get("now")
    if now is None:
        now = time.time()
    if now.__class__ not in (int, float) or now != now or not 0 <= now <= _MAX_UNIX:
        raise ValueError("now must be Unix seconds, got %r" % (now,))
    now = int(now)
    if not isinstance(rows, (list, tuple)):
        try:
            rows = list(rows) if rows is not None else []
        except TypeError:
            raise ValueError("rows must be a list of message rows, got %s" % type(rows).__name__)

    # ---- pass 0: timestamps, and the range the time-zone table must cover --
    stamps: List[Optional[Tuple[int, int]]] = []
    lo = hi = now
    for row in rows:
        stamp = _split_date(row.get("date")) if isinstance(row, Mapping) else None
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
        clean_name(opts.get("label"), CHAT_NAME_LIMIT) or None)

    # ---- pass 1: tapbacks, in chronological order ---------------------------
    taps = []
    for index, row in enumerate(rows):
        stamp = stamps[index]
        if stamp is None:
            continue
        kind = row.get("associated_message_type")
        if kind.__class__ is not int:
            kind = _int(kind)
        if kind < 2000 or kind > 3007 or 2007 < kind < 3000:
            continue
        sec, frac = stamp
        if (sec + offset_at(sec)) // _DAY > end_day:
            continue                    # added after the period ended
        taps.append((sec, frac, _int(row.get("rowid")), index, kind))
    taps.sort()
    state: Dict[Tuple[str, str], int] = {}
    for sec, frac, _rowid, index, kind in taps:
        row = rows[index]
        target = row.get("associated_message_guid")
        if target.__class__ is not str or not target:
            continue
        # one tapback per person per message part: the key keeps the "p:N/" or
        # "bp:" prefix, the message is whatever follows it
        key = (target, names.sender(row))
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
    timeline = []                       # (sec, frac, rowid, index, sender, day) per message
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
        if kind.__class__ is not int:
            kind = _int(kind)
        if kind >= 1000:
            continue                    # tapbacks, stickers, poll votes
        if _flag(get("item_type")):
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
        if text.__class__ is not str:
            # raw UTF-8 bytes are fine; any other type is not text at all
            text = (bytes(text).decode("utf-8", "replace")
                    if isinstance(text, (bytes, bytearray, memoryview)) else None)
        if not text:
            body = get("attributedBody")
            text = (decode_attributed_body(body)
                    if isinstance(body, (bytes, bytearray, memoryview)) else None)
        text = clean_text(text)
        has_attachment = 1 if _flag(get("cache_has_attachments")) else 0
        if not text and not has_attachment and not _flag(get("keep_empty")):
            continue                    # unsent or empty

        sender = me if _flag(get("is_from_me")) else names.handle(get("handle"))
        counters = people.get(sender)
        if counters is None:
            counters = people[sender] = [0] * _COUNTERS
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
        elif EARLY_HOURS[0] <= hour < EARLY_HOURS[1]:
            counters[_EARLY] += 1
        if text:
            if text.endswith(_QUESTION_MARKS):
                counters[_QUESTIONS] += 1
            if _LINK_STARTS[0] in text or _LINK_STARTS[1] in text:
                counters[_LINKS] += 1
        timeline.append((sec, stamp[1], _int(get("rowid")), index, sender, day))
        by_hour[hour] += 1
        day_counts[day] = day_counts.get(day, 0) + 1
        if first_day is None or day < first_day:
            first_day = day
        if get_standing is not None:
            guid = get("guid")
            marks = get_standing(guid) if guid.__class__ is str else None
            if marks:
                reacted.append((sec, stamp[1], _int(get("rowid")), sender, day, text,
                                has_attachment, marks))

    # ---- the same messages in chronological order -----------------------------
    # (time, then ROWID, then position in the input, as for tapbacks)
    timeline.sort(key=lambda m: m[:4])
    opens: Dict[int, str] = {}          # local day -> who sent its first message
    closes: Dict[int, str] = {}         # local day -> who sent its last message
    previous_sender = None
    streak = 0
    for _sec, _frac, _rowid, _index, sender, day in timeline:
        if day not in opens:
            opens[day] = sender
        closes[day] = sender
        streak = streak + 1 if sender == previous_sender else 1
        previous_sender = sender
        counters = people[sender]
        if streak > counters[_RUN]:
            counters[_RUN] = streak
    for sender in opens.values():
        people[sender][_STARTS] += 1
    for sender in closes.values():
        people[sender][_ENDS] += 1

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
    participants = opts.get("participants")
    participants = ([h for h in participants if h.__class__ is str and h]
                    if isinstance(participants, (list, tuple)) else [])
    resolved = _distinct(names.handle(h) for h in participants)
    members.update(resolved)
    chat_name = _chat_label(opts.get("chat_name"))
    if not chat_name:
        chat_name = _fallback_name(resolved, me)

    totals = {
        "messages": total,
        "words": words_total,
        "attachments": attachments_total,
        "reactions": reactions_total,
        "days_active": len(day_counts),
        "longest_streak": longest,
    }
    figures = personality_figures(
        totals, by_hour, by_weekday, by_month, end_day - start_day + 1, busiest[1] if busiest else 0,
        {"laugh": by_kind[_LAUGH], "love": by_kind[0]}, (c[_MSG] for c in people.values()))

    return {
        "v": 1,
        "chat": {"name": chat_name, "members": len(members)},
        "period": {"label": label, "start": _iso(start_day), "end": _iso(end_day)},
        "totals": totals,
        "by_hour": by_hour,
        "by_weekday": by_weekday,
        "by_month": by_month,
        "busiest_day": {"date": _iso(busiest[0]), "messages": busiest[1]} if busiest else None,
        "personality": personality(figures),
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
            "source": clean_name(opts.get("source"), NAME_LIMIT) or "chat.db",
            "generated": _iso(today),
        },
    }


# --------------------------------------------------------------------------- #
# short names
# --------------------------------------------------------------------------- #

def _name_slots(stats: Any) -> List[Tuple[Dict[str, Any], str]]:
    """Every place a finished stats object names a person: (container, key)."""
    slots: List[Tuple[Dict[str, Any], str]] = []

    def add(container: Any, key: str) -> None:
        if isinstance(container, dict) and container.get(key).__class__ is str:
            slots.append((container, key))

    def each(items: Any, key: str) -> None:
        if isinstance(items, list):
            for item in items:
                add(item, key)

    if not isinstance(stats, dict):
        return slots
    each(stats.get("senders"), "name")
    late = stats.get("late_night")
    add(late.get("top") if isinstance(late, dict) else None, "name")
    each(stats.get("most_reacted"), "sender")
    reactions = stats.get("reactions")
    if isinstance(reactions, dict):
        add(reactions.get("top_giver"), "name")
        add(reactions.get("top_receiver"), "name")
    each(stats.get("awards"), "winner")
    return slots


def _words(name: str) -> List[str]:
    return [word for word in _WS_RUN.split(name) if word]


def short_forms(names: Iterable[str], me: str = "Me") -> Dict[str, str]:
    """``{full name: short name}`` for the people of one recap (see
    :func:`short_names` for the rule).

    The rule is applied to what may be shown at all: every name is first
    cleaned, capped and masked again (which changes nothing for names that
    :func:`compute_stats` produced), so a short form can never bring back a
    number or an address that a stats object from somewhere else still
    holds."""
    given = _distinct(name for name in names if name.__class__ is str)
    shown = {name: person_label(name) or "Unknown" for name in given}
    me = person_label(me) or "Me"
    short = _short_forms(_distinct(shown.values()), me)
    return {name: short[shown[name]] for name in given}


def _short_forms(people: List[str], me: str) -> Dict[str, str]:
    fixed = {name for name in people if name == me or name.startswith("\u2026")}
    result: Dict[str, str] = {}
    groups: Dict[str, List[str]] = {}
    for name in people:
        words = _words(name)
        result[name] = name if name in fixed or not words else words[0]
        groups.setdefault(result[name], []).append(name)
    for members in groups.values():
        if len(members) < 2:
            continue
        for name in members:            # same first word: "Sam R.", "Sam C."
            words = _words(name)
            if name not in fixed and words:
                result[name] = "%s %s." % (words[0], words[-1][0])
    taken: Dict[str, int] = {}
    for label in result.values():
        taken[label] = taken.get(label, 0) + 1
    for name in people:                 # still not unique: the full name
        if name not in fixed and taken[result[name]] > 1:
            result[name] = name
    return result


def short_names(stats: Dict[str, Any], me: str = "Me") -> Dict[str, Any]:
    """A copy of a finished stats object with every person's name shortened
    (docs/SCHEMA.md 2, "Short names").

    Contact names are the owner's private labels ("Dave plumber"), so what
    people see by default is the first word. ``me`` is the owner's name as
    it appears in the stats; it and masked labels (starting with an
    ellipsis) are left alone. Two different people with the same first word
    become "Sam R." and "Sam C."; if that still collides they keep their
    full names. Names are replaced consistently in ``senders``,
    ``late_night.top``, ``most_reacted[].sender``, ``reactions.top_giver``,
    ``reactions.top_receiver`` and ``awards[].winner``. The input is not
    modified; :func:`compute_stats` itself always returns full names.
    """
    out = copy.deepcopy(stats)
    slots = _name_slots(out)
    mapping = short_forms([container[key] for container, key in slots], me)
    for container, key in slots:
        container[key] = mapping[container[key]]
    return out

