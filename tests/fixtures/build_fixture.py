#!/usr/bin/env python3
"""Build invented Messages databases for the test suites.

Everything here is made up: names, numbers (+1555...), addresses (@example.com)
and message text. Nothing is read from a real device. The output is generated at
test time and never committed (the repository .gitignore blocks *.db).

    python tests/fixtures/build_fixture.py OUTDIR

Layout written to OUTDIR:

    mac/chat.db (+ chat.db-wal, chat.db-shm)   Messages database in WAL mode with
                                               the newest rows only in the -wal
    mac/AddressBook/...                        two fake AddressBook-v22.abcddb
    backup/<udid>/                             unencrypted iPhone backup:
        Manifest.db, Manifest.plist, Info.plist, Status.plist
        3d/3d0d7e5f...  (sms.db, same data, fully checkpointed)
        31/31bb7ba8...  (AddressBook.sqlitedb)
    backup-wal/<udid>/                         same, but sms.db has a live -wal
        cd/cd47480f...  (sms.db-wal)
    backup-encrypted/<udid>/                   Manifest.plist IsEncrypted + noise
    legacy/chat.db                             old schema: second-precision
                                               dates, no attributedBody /
                                               associated_message_* columns
    noemoji/chat.db                            current schema without the
                                               associated_message_emoji column
    fixture.json                               paths, chat ids, typedstream
                                               samples, the fixed "now"

Standard library only. Deterministic: a fixed seed and no wall-clock input.
"""

from __future__ import annotations

import calendar
import hashlib
import json
import os
import plistlib
import shutil
import sqlite3
import struct
import sys

APPLE_EPOCH = 978307200  # 2001-01-01T00:00:00Z as Unix seconds
M64 = (1 << 64) - 1

# The instant every test treats as "now": 2026-11-11 12:00:00 in Los Angeles.
NOW_UNIX = calendar.timegm((2026, 11, 11, 20, 0, 0))

SMS_DB_ID = "3d0d7e5fb2ce288813306e4d4636395e047a3d28"  # HomeDomain-Library/SMS/sms.db
SMS_WAL_ID = "cd47480f213dba9bc38ee792775d17e3f5a73a59"  # ...sms.db-wal
ADDRESS_BOOK_ID = "31bb7ba8914766d4ba40d6dfb6113c8b614be442"  # ...AddressBook.sqlitedb
FAKE_UDID = "00008030-000FAKE0FAKE0FAKE"

OBJ = "\ufffc"  # object replacement character: one per inline attachment


# --------------------------------------------------------------------------- #
# typedstream (NSArchiver) writer
# --------------------------------------------------------------------------- #

class Archiver:
    """Just enough of NSArchiver's "streamtyped" format to write the
    NSAttributedString / NSMutableAttributedString blobs Messages stores in
    message.attributedBody. The CI job on macOS compares this writer's output
    with real NSArchiver output (tests/conformance/real_typedstream.swift)."""

    def __init__(self):
        self.out = bytearray(b"\x04\x0bstreamtyped\x81\xe8\x03")
        self.strings = {}   # shared strings (type encodings, class names)
        self.classes = {}   # class name -> object-table index
        self.shared = {}    # objects written once and referenced afterwards
        self.n_objects = 0

    def integer(self, n):
        if -110 <= n <= 127:
            self.out.append(n & 0xFF)
        elif -32768 <= n <= 32767:
            self.out += b"\x81" + struct.pack("<h", n)
        else:
            self.out += b"\x82" + struct.pack("<i", n)

    def _ref(self, index):
        assert index < 110, "reference table too large for this tiny writer"
        self.out.append(0x92 + index)

    def shared_string(self, raw):
        index = self.strings.get(raw)
        if index is None:
            self.strings[raw] = len(self.strings)
            self.out.append(0x84)
            self.integer(len(raw))
            self.out += raw
        else:
            self._ref(index)

    def type(self, encoding):
        self.shared_string(encoding)

    def begin_object(self, chain):
        """chain: [(class name, version), ...] most-derived first."""
        self.out.append(0x84)
        self.n_objects += 1
        for name, version in chain:
            if name in self.classes:
                self._ref(self.classes[name])
                return
            self.out.append(0x84)
            self.classes[name] = self.n_objects
            self.n_objects += 1
            self.shared_string(name)
            self.integer(version)
        self.out.append(0x85)  # nil superclass

    def end_object(self):
        self.out.append(0x86)

    # -- Foundation objects ------------------------------------------------- #

    def ns_string(self, text, mutable=False, shared=False):
        """shared: the same string object is archived more than once (the
        attribute-name constants), so later uses are references to the first."""
        if shared:
            if ("string", text) in self.shared:
                self._ref(self.shared[("string", text)])
                return
            self.shared[("string", text)] = self.n_objects
        chain = [(b"NSString", 1), (b"NSObject", 0)]
        if mutable:
            chain.insert(0, (b"NSMutableString", 1))
        self.begin_object(chain)
        raw = text.encode("utf-8")
        self.type(b"+")
        self.integer(len(raw))
        self.out += raw
        self.end_object()

    def ns_number(self, value):
        self.begin_object([(b"NSNumber", 0), (b"NSValue", 0), (b"NSObject", 0)])
        self.type(b"*")
        if "i" in self.shared:     # the same C string again: a reference
            self._ref(self.shared["i"])
        else:
            self.out.append(0x84)      # a C string value takes an object slot...
            self.shared["i"] = self.n_objects
            self.n_objects += 1
            self.shared_string(b"i")   # ...and its bytes are a shared string
        self.type(b"i")
        self.integer(value)
        self.end_object()

    def ns_dictionary(self, items):
        self.begin_object([(b"NSDictionary", 0), (b"NSObject", 0)])
        self.type(b"i")
        self.integer(len(items))
        for key, value in items:
            self.type(b"@")
            self.ns_string(key, shared=True)
            self.type(b"@")
            if isinstance(value, int):
                self.ns_number(value)
            else:
                self.ns_string(value)
        self.end_object()


def utf16_len(text):
    return len(text.encode("utf-16-le")) // 2


def archive_attributed_string(text, mutable=False, runs=None):
    """Return typedstream bytes for an attributed string holding `text`.

    runs: optional [(utf16 length, [(key, value), ...]), ...]. By default the
    whole string is one run carrying __kIMMessagePartAttributeName = 0, with
    each U+FFFC split out as its own attachment run the way Messages does."""
    if runs is None:
        runs = default_runs(text)
    a = Archiver()
    a.type(b"@")
    chain = [(b"NSAttributedString", 0), (b"NSObject", 0)]
    if mutable:
        chain.insert(0, (b"NSMutableAttributedString", 0))
    a.begin_object(chain)
    a.type(b"@")
    a.ns_string(text, mutable=mutable)
    for index, (length, items) in enumerate(runs, start=1):
        a.type(b"iI")
        a.integer(index)
        a.integer(length)
        a.type(b"@")
        a.ns_dictionary(items)
    a.end_object()
    return bytes(a.out)


def default_runs(text):
    runs = []
    part = 0
    buf = ""
    for ch in text:
        if ch == OBJ:
            if buf:
                runs.append((utf16_len(buf), [("__kIMMessagePartAttributeName", part)]))
                part += 1
                buf = ""
            runs.append((1, [
                ("__kIMFileTransferGUIDAttributeName", "at_%d_FAKE-TRANSFER-GUID" % part),
                ("__kIMMessagePartAttributeName", part),
            ]))
            part += 1
        else:
            buf += ch
    if buf or not runs:
        runs.append((utf16_len(buf), [("__kIMMessagePartAttributeName", part)]))
    return runs


def typedstream_samples():
    """(name, text, mutable) triples covering every length encoding."""
    out = []
    cases = [
        ("empty", ""),
        ("one", "k"),
        ("short", "see you at 7"),
        ("len127", "a" * 127),
        ("len128", "b" * 128),
        ("len255", "c" * 255),
        ("len256", "d" * 256),
        ("len300", ("lorem ipsum " * 25)),
        ("len5000", ("the quick brown fox jumps over the lazy dog " * 114)[:5000]),
        ("len32767", "e" * 32767),
        ("emoji", "ok \U0001f44d\U0001f3fd see you \U0001f389\U0001f389 at the caf\xe9"),
        ("emoji_long", "\U0001f602" * 70),  # 280 UTF-8 bytes, 140 UTF-16 units
        ("cjk", "\u660e\u65e5\u306e\u591c\u3054\u98ef\u306f\u3069\u3053\u306b\u3059\u308b\uff1f" * 12),
        ("attachment", OBJ),
        ("attachment_text", OBJ + "Look at this cover"),
        ("two_attachments", OBJ + OBJ + " both of these"),
        ("multiline", "line one\nline two\r\n\tindented"),
        ("looks_like_tags", "\u0084\u0085\u0086 + NSString +"),
    ]
    for name, text in cases:
        out.append((name, text, False))
        out.append((name + "_mutable", text, True))
    return out


# --------------------------------------------------------------------------- #
# deterministic pseudo-random numbers (identical on every Python version)
# --------------------------------------------------------------------------- #

class Rng:
    def __init__(self, seed):
        self.state = seed & M64

    def next(self):
        self.state = (self.state * 6364136223846793005 + 1442695040888963407) & M64
        return self.state >> 33

    def below(self, n):
        return self.next() % n

    def chance(self, percent):
        return self.below(100) < percent

    def pick(self, seq):
        return seq[self.below(len(seq))]

    def weighted(self, weights):
        total = sum(weights)
        r = self.below(total)
        for index, w in enumerate(weights):
            if r < w:
                return index
            r -= w
        return len(weights) - 1

    def guid(self):
        h = "%08X%08X%08X%08X" % (self.next(), self.next(), self.next(), self.next())
        return "%s-%s-%s-%s-%s" % (h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])


# --------------------------------------------------------------------------- #
# invented people
# --------------------------------------------------------------------------- #

# key -> (first, last, [handles as Messages stores them], [contact card values])
PEOPLE = {
    "ines":  ("Ines", "Calloway", ["+15550100001", "ines.calloway@example.com"],
              [("phone", "(555) 010-0001"), ("email", "Ines.Calloway@Example.com")]),
    "bram":  ("Bram", "Okoye", ["+15550100002"], [("phone", "+1 555-010-0002")]),
    "samr":  ("Sam", "Rivera", ["+15550100003"], [("phone", "555.010.0003")]),
    "samc":  ("Sam", "Chen", ["+15550100004"], [("phone", "15550100004")]),
    "zoe":   ("Zo\xeb", "M\xfcller", ["+15550100005"], [("phone", "+1 (555) 010-0005")]),
    "anon6": (None, None, ["+15550100006"], []),            # not in contacts
    "anon7": (None, None, ["+15550100007"], []),            # not in contacts
    "pat":   (None, None, ["pat@example.com"], []),         # not in contacts
    "nora":  ("Nora", "Quill", ["+15550100011", "nora.quill@example.com"],
              [("phone", "+1 (555) 010-0011"), ("email", "nora.quill@example.com")]),
    "ezra":  (None, None, ["+15550100012"], []),            # not in contacts
}

SYLLABLES = ("ba be bi bo bu da de di do du fa fe fi fo fu ga ge gi go gu ka ke ki ko ku "
             "la le li lo lu ma me mi mo mu na ne ni no nu pa pe pi po pu ra re ri ro ru "
             "sa se si so su ta te ti to tu va ve vi vo vu za ze zi zo zu "
             "\u00e1 \u00e9 \u00ed \u00f3 \u00fa \u00f1o \u00fc \u00f8 \u0142a \u017ee").split()


def gibberish_word(rng, capital=False):
    """An invented, hard-to-compress word; sometimes Hangul, CJK or emoji."""
    r = rng.below(100)
    if r < 12:
        word = "".join(chr(0xAC00 + rng.below(11172)) for _ in range(2 + rng.below(4)))
    elif r < 22:
        word = "".join(chr(0x4E00 + rng.below(20000)) for _ in range(2 + rng.below(3)))
    elif r < 26:
        word = chr(0x1F600 + rng.below(80)) * (1 + rng.below(2))
    else:
        word = "".join(rng.pick(SYLLABLES) for _ in range(2 + rng.below(4)))
        if capital:
            word = word[:1].upper() + word[1:]
    return word


def stress_people(rng):
    """14 invented people with enormous names, for the link-length ladder."""
    people = {}
    for i in range(14):
        first = " ".join(gibberish_word(rng, True) for _ in range(9 + rng.below(4)))
        last = " ".join(gibberish_word(rng, True) for _ in range(12 + rng.below(5)))
        key = "long%02d" % i
        phone = "+155502%05d" % (200 + i)
        people[key] = (first, last + " \u2116%d" % (i + 1), [phone], [("phone", phone)])
    return people


def contact_cards(people):
    """[(first, last, nickname, organization, [(kind, value)])] in card order."""
    cards = []
    for key in sorted(people):
        first, last, _handles, values = people[key]
        if values:
            cards.append((first, last, None, None, values))
    # cards that exercise the name fallbacks; none of them is in a chat
    cards.append((None, None, None, "Pizza Planet", [("phone", "555-010-0099")]))
    cards.append((None, None, "Coach", None, [("phone", "555-010-0098")]))
    cards.append((None, None, None, None, [("phone", "555-010-0097")]))  # nameless: skipped
    cards.append(("Solo", None, None, None, [("email", "SOLO@EXAMPLE.COM")]))
    return cards


# --------------------------------------------------------------------------- #
# message specs
# --------------------------------------------------------------------------- #

def utc(y, mo, d, h, mi, s=0):
    return calendar.timegm((y, mo, d, h, mi, s))


def local(y, mo, d, h, mi, s=0, off=-8):
    """Unix seconds for a wall-clock time at a fixed UTC offset (hours).
    Los Angeles: off=-8 is PST, off=-7 is PDT."""
    return calendar.timegm((y, mo, d, h, mi, s)) - off * 3600


TAPBACK_TEXT = {
    2000: "Loved", 2001: "Liked", 2002: "Disliked", 2003: "Laughed at",
    2004: "Emphasized", 2005: "Questioned", 2006: "Reacted to", 2007: "Reacted with a sticker to",
}


class Specs:
    """Collects rows for one database before they are written."""

    def __init__(self, rng):
        self.rng = rng
        self.rows = []
        self.seq = 0

    def add(self, chat, when, sender, text=None, **kw):
        """sender: 'me' or a handle string. Returns the spec (with .guid)."""
        self.seq += 1
        spec = {
            "chat": chat, "t": when, "ns": kw.pop("ns", 0), "sender": sender,
            "text": text, "seq": self.seq, "guid": self.rng.guid(),
            "body": kw.pop("body", "both"),     # both | only | none
            "mutable": kw.pop("mutable", False),
            "att": kw.pop("att", None),          # None = count the U+FFFC in text
            "has_att": kw.pop("has_att", None),  # override cache_has_attachments
            "precision": kw.pop("precision", "ns"),
            "item_type": kw.pop("item_type", 0),
            "group_action_type": kw.pop("group_action_type", 0),
            "group_title": kw.pop("group_title", None),
            "assoc_type": kw.pop("assoc_type", 0),
            "assoc_guid": kw.pop("assoc_guid", None),
            "emoji": kw.pop("emoji", None),
            "service": kw.pop("service", "iMessage"),
            "raw_text": kw.pop("raw_text", None),   # bytes stored as TEXT verbatim
            "retracted": kw.pop("retracted", False),
            "deleted": kw.pop("deleted", False),    # insert, then DELETE the row
            "insert_ns": kw.pop("insert_ns", None),  # insertion (ROWID) order override
            "label": kw.pop("label", None),
        }
        assert not kw, kw
        self.rows.append(spec)
        return spec

    def tapback(self, chat, when, sender, kind, target, prefix="p:0/", **kw):
        quoted = (target.get("text") or "an attachment").replace(OBJ, "").strip()[:40]
        verb = TAPBACK_TEXT.get(kind if kind < 3000 else kind - 1000, "Reacted to")
        if kind >= 3000:
            verb = "Removed a reaction from"
        text = "%s \u201c%s\u201d" % (verb, quoted)
        return self.add(chat, when, sender, text, assoc_type=kind,
                        assoc_guid=prefix + target["guid"], **kw)


# Handles used by the tiny chat.
NORA_P = "+15550100011"
NORA_E = "nora.quill@example.com"
EZRA = "+15550100012"

M10_TEXT = ("I have read exactly one chapter and I already have opinions about every "
            "single character in this book so please prepare yourselves for a rant")
M11_TEXT = ("Zo\xeb says the caf\xe9 scene is the best part \U0001F602 and honestly I agree "
            "\u2014 the whole chapter felt like a fever dream, na\xefve narrator and all. "
            "Also who brings a pi\xf1ata to a funeral?? \U0001FA85\U0001FA85 Anyway next month "
            "we are reading something shorter because I cannot do another 600 pages of this, "
            "d\xe9j\xe0 vu or not.")


def tiny_chat(s):
    """The 3-person "Book Club" chat. Every row is spelled out because
    tests/conformance/expected_tiny.py holds numbers worked out by hand from
    this table. Times are Los Angeles wall-clock; off=-8 is PST, -7 is PDT."""
    c = "tiny"
    m = {}
    # --- 2025 (before the default period) ---------------------------------
    m["B1"] = s.add(c, local(2025, 12, 20, 18, 0), NORA_P, "Book club is back on for January")
    m["B2"] = s.add(c, local(2025, 12, 31, 23, 59, 30), NORA_P, "Last message of the year")
    # --- New Year: 00:00:05 PST is 2026 in Los Angeles ---------------------
    m["M1"] = s.add(c, local(2026, 1, 1, 0, 0, 5), "me", "Happy new year!!")
    s.tapback(c, local(2026, 1, 1, 0, 1, 0), EZRA, 2000, m["B2"], label="TB1")
    m["M2"] = s.add(c, local(2026, 1, 1, 0, 2, 0), EZRA, "Happy new year \U0001F389", body="only")
    s.tapback(c, local(2026, 1, 1, 9, 0, 0), NORA_P, 2001, m["M1"], label="TB5")
    s.tapback(c, local(2026, 1, 1, 9, 1, 0), NORA_E, 3001, m["M1"], label="TB6")
    # --- midnight: the last nanosecond of Feb 14 and the first of Feb 15 ---
    m["M3"] = s.add(c, local(2026, 2, 14, 23, 59, 59), NORA_P, "Just under the wire", ns=999999999)
    m["M4"] = s.add(c, local(2026, 2, 15, 0, 0, 0), EZRA, "Midnight exactly")
    s.tapback(c, local(2026, 2, 15, 8, 0, 0), "me", 2003, m["M3"], label="TB2")
    s.tapback(c, local(2026, 2, 15, 8, 5, 0), EZRA, 2003, m["M3"], label="TB3")
    s.tapback(c, local(2026, 2, 15, 9, 0, 0), "me", 3000, m["M4"], label="TB14")  # stray removal
    # --- spring forward: 01:59 PST, then 03:00 PDT one and a half minutes later
    m["M5"] = s.add(c, local(2026, 3, 8, 1, 59, 0), "me", "Clocks change tonight")
    m["M6"] = s.add(c, local(2026, 3, 8, 3, 0, 30, off=-7), NORA_E, "Where did 2 AM go")
    s.tapback(c, local(2026, 3, 8, 9, 0, 0, off=-7), "me", 2003, m["M6"], label="TB4")
    s.tapback(c, local(2026, 3, 8, 9, 10, 0, off=-7), EZRA, 2003, m["M5"], label="TB7")
    s.tapback(c, local(2026, 3, 8, 9, 11, 0, off=-7), EZRA, 2000, m["M5"], label="TB8")  # changed
    # --- April 10 (PDT): one of everything ---------------------------------
    d = lambda h, mi, sec=0: local(2026, 4, 10, h, mi, sec, off=-7)
    m["M7"] = s.add(c, d(12, 0), EZRA, "Lunch?", precision="s", body="none")
    s.tapback(c, d(12, 0, 30), NORA_P, 2004, m["M7"], prefix="bp:", label="TB9")
    m["M8"] = s.add(c, d(12, 1), "me", OBJ)
    m["M9"] = s.add(c, d(12, 2), NORA_P, OBJ + "Look at this cover", body="only")
    m["M10"] = s.add(c, d(12, 3), EZRA, M10_TEXT, body="only")
    m["M11"] = s.add(c, d(12, 4), NORA_P, M11_TEXT, body="only", mutable=True)
    s.add(c, d(12, 5), NORA_P, None, body="none", item_type=2, group_title="Book Club \U0001F4DA", label="E1")
    s.add(c, d(12, 5, 30), "me", None, body="none", item_type=1, group_action_type=0, label="E2")
    s.add(c, d(12, 5, 40), EZRA, None, body="none", item_type=3, group_action_type=1, has_att=1, label="E3")
    s.add(c, d(12, 6, 0), "me", None, body="none", retracted=True, label="U1")
    s.add(c, d(12, 6, 10), EZRA, "", body="none", label="U2")
    s.add(c, d(12, 6, 20), NORA_P, "  \n ", body="none", label="U3")
    s.add(c, d(12, 6, 30), "me", OBJ, body="none", has_att=0, att=0, label="U4")
    s.add(c, d(12, 6, 40), EZRA, "", body="only", label="U5")  # NULL text, empty attributed string
    s.add(c, d(12, 7, 0), EZRA, OBJ, assoc_type=1000, assoc_guid="p:0/" + m["M9"]["guid"], label="S1")
    s.add(c, d(12, 7, 10), NORA_P, None, body="none", assoc_type=4000,
          assoc_guid="p:0/" + m["M9"]["guid"], label="P1")
    s.tapback(c, d(12, 10), "me", 2006, m["M11"], emoji="\U0001F525", label="TB10")
    s.tapback(c, d(12, 11), EZRA, 2007, m["M11"], label="TB11")
    s.tapback(c, d(12, 12), "me", 2005, m["M10"], label="TB12")
    s.tapback(c, d(12, 13), NORA_P, 2002, m["M10"], label="TB13")
    s.add(c, d(12, 14), EZRA, "Liked \u201csomething else\u201d", assoc_type=2001,
          assoc_guid="p:0/00000000-0000-0000-0000-00000000DEAD", label="TB15")
    # a tapback whose add row Messages deleted when it was removed
    s.tapback(c, d(12, 15), "me", 2000, m["M7"], deleted=True, label="TB19")
    # --- July 4 (PDT): the busiest day -------------------------------------
    j = lambda h, mi, sec=0: local(2026, 7, 4, h, mi, sec, off=-7)
    m["J1"] = s.add(c, j(20, 15), "me", "Fireworks at nine")
    m["J2"] = s.add(c, j(20, 16), NORA_P, "Bringing the dog")
    m["J3"] = s.add(c, j(20, 17), EZRA, "He will hate it")
    m["J4"] = s.add(c, j(20, 18), "me", OBJ + OBJ)
    m["J5"] = s.add(c, j(21, 5), EZRA, "Best one yet")
    m["J6"] = s.add(c, j(21, 6), "me", "Agreed")
    m["J7"] = s.add(c, j(21, 30), NORA_E, "Home safe")
    # add and remove one nanosecond apart, stored with the removal FIRST
    # (lower ROWID): only full-precision chronological order gets this right
    s.tapback(c, j(20, 20), "me", 3001, m["J3"], ns=100000001, label="TB17b")
    s.tapback(c, j(20, 20), "me", 2001, m["J3"], ns=100000000, insert_ns=100000002, label="TB17a")
    # identical timestamps: ROWID order decides, so the laugh (second) stands
    s.tapback(c, j(21, 10), NORA_P, 2000, m["J5"], label="TB18a")
    s.tapback(c, j(21, 10), NORA_P, 2003, m["J5"], label="TB18b")
    # --- later ---------------------------------------------------------------
    m["M12"] = s.add(c, local(2026, 9, 15, 8, 30, off=-7), NORA_P, "Chapter nine was wild")
    # fall back: 01:30 happens twice on November 1
    m["Ma"] = s.add(c, local(2026, 11, 1, 1, 30, off=-7), NORA_P, "First 1:30")
    m["Mb"] = s.add(c, local(2026, 11, 1, 1, 30, off=-8), "me", "Second 1:30")
    # --- after the fixed "now" (2026-11-11 12:00 PST) ------------------------
    s.tapback(c, local(2026, 11, 15, 10, 0), EZRA, 2000, m["M3"], label="TB16")
    m["F1"] = s.add(c, local(2026, 11, 20, 10, 0), EZRA, "From the future")
    return m


WORDS = (
    "ok yes no maybe lol omg wait what who when where tonight tomorrow dinner tacos "
    "salsa queso margaritas table reservation seven eight late early running traffic "
    "parking bring chips guac anyone else coming there here soon almost done leaving "
    "now seriously literally honestly never again best worst idea plan vote decide "
    "pick place same usual new spot downtown uptown patio inside outside rain sunny "
    "birthday surprise cake candles forgot remember photo video send link menu spicy "
    "mild extra hungry starving full sleepy awake weekend monday friday game movie show"
).split()
SPICE = ["\U0001F32E", "\U0001F602", "\U0001F525", "\U0001F62D", "\u2764\ufe0f", "caf\xe9",
         "jalape\xf1o", "\U0001F469\u200d\U0001F373", "\U0001F1F2\U0001F1FD", "na\xefve",
         "\xa1vamos!", "\u3059\u3054\u3044", "\U0001F44D\U0001F3FD"]

# Text that probes the whitespace and clean-up rules of SCHEMA.md section 2.
EDGE_TEXTS = [
    "tabs\tand\nnewlines\r\nmixed   spaces",
    "nbsp\xa0separated\xa0words",
    "ideographic\u3000space",
    "zero\u200bwidth\u200bspace is not a separator",
    "bom\ufeffinside",
    "\ufeffleading bom",
    "unit\x1fseparator and\x1cfile separator",
    "next\x85line",
    "line\u2028separator\u2029paragraph",
    "narrow\u202fnbsp and\u205fmath space and\u1680ogham",
    "\u180emongolian vowel separator",
    "replacement \ufffd char and " + OBJ + " object inside text",
    "\ufffd",
    "emoji only \U0001F468\u200d\U0001F469\u200d\U0001F467\u200d\U0001F466 \U0001F1E8\U0001F1E6 \U0001F44D\U0001F3FD",
    "nul\x00inside the text",
    "  padded with spaces  ",
    "\u2003\u2003em spaces around\u2003",
    "x",
]


def sentence(rng, n):
    out = []
    for _ in range(n):
        out.append(rng.pick(SPICE) if rng.chance(7) else rng.pick(WORDS))
    sep = "  " if rng.chance(3) else " "
    return sep.join(out)


HOUR_WEIGHTS = [5, 3, 2, 1, 1, 1, 2, 4, 6, 7, 7, 8, 10, 9, 7, 7, 8, 10, 13, 15, 17, 19, 16, 10]


def generated_chat(s, rng, chat, senders, weights, first_day, last_day, density,
                   sms_chat=None, long_text=False):
    """Random but deterministic traffic. senders: 'me' or lists of handles."""
    messages = []
    for day in range(first_day, last_day + 1):
        r = rng.below(100)
        if r < density[0]:
            n = 0
        elif r < density[1]:
            n = 1 + rng.below(8)
        elif r < density[2]:
            n = 8 + rng.below(18)
        else:
            n = 25 + rng.below(40)
        for _ in range(n):
            hour = rng.weighted(HOUR_WEIGHTS)
            # hour is "Los Angeles-ish": shift by eight hours, ignore DST
            t = day * 86400 + (hour + 8) * 3600 + rng.below(3600)
            who = senders[rng.weighted(weights)]
            sender = who if who == "me" else rng.pick(who) if rng.chance(15) else who[0]
            r = rng.below(100)
            if long_text:
                n_words = 30 + rng.below(60)
            elif r < 60:
                n_words = 1 + rng.below(6)
            elif r < 93:
                n_words = 7 + rng.below(14)
            else:
                n_words = 30 + rng.below(70)
            if long_text:
                text = " ".join(gibberish_word(rng) for _ in range(n_words))
            else:
                text = sentence(rng, n_words)
            kw = {}
            r = rng.below(100)
            if r < 4:
                text = OBJ * (1 + rng.below(3))
            elif r < 9:
                text = OBJ + text
            r = rng.below(100)
            kw["body"] = "only" if r < 40 else "both" if r < 90 else "none"
            kw["mutable"] = rng.chance(30)
            if rng.chance(5):
                kw["precision"] = "s"
            else:
                kw["ns"] = rng.below(1000) * 1000000 + rng.below(1000)
            if sms_chat and rng.chance(8):
                kw["service"] = "SMS"
                chat_key = sms_chat
            else:
                chat_key = chat
            messages.append(s.add(chat_key, t, sender, text, **kw))
    # tapbacks
    handles = [who if who == "me" else who[0] for who in senders]
    kinds = [2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007]
    kind_weights = [30, 22, 4, 28, 10, 4, 6, 1]
    for msg in messages:
        if not rng.chance(26):
            continue
        for _ in range(1 + rng.weighted([50, 28, 14, 8])):
            reactor = rng.pick(handles)
            kind = kinds[rng.weighted(kind_weights)]
            r = rng.below(100)
            prefix = "p:0/" if r < 85 else "bp:" if r < 95 else "p:1/"
            delay = 5 + rng.below(4000)
            if rng.chance(3):
                delay += 86400 * (1 + rng.below(120))   # a very late reaction
            kw = {"ns": rng.below(1000000000), "emoji": "\U0001F525" if kind == 2006 else None}
            chat_key = msg["chat"]
            s.tapback(chat_key, msg["t"] + delay, reactor, kind, msg, prefix=prefix, **kw)
            r = rng.below(100)
            if r < 10:      # removed again
                s.tapback(chat_key, msg["t"] + delay + 3 + rng.below(600), reactor, kind + 1000,
                          msg, prefix=prefix, ns=rng.below(1000000000))
            elif r < 18:    # changed to another kind
                s.tapback(chat_key, msg["t"] + delay + 3 + rng.below(600), reactor,
                          kinds[rng.weighted(kind_weights)], msg, prefix=prefix,
                          ns=rng.below(1000000000))
            elif r < 21:    # removed, and Messages deleted the add row
                s.rows[-1]["deleted"] = True
                if rng.chance(50):
                    s.tapback(chat_key, msg["t"] + delay + 3, reactor, kind + 1000, msg,
                              prefix=prefix)
    # group events, unsent rows, stickers, poll votes
    for _ in range(max(3, len(messages) // 250)):
        base = rng.pick(messages)
        who = rng.pick(handles)
        s.add(chat, base["t"] + 1, who, None, body="none", item_type=1 + rng.below(3),
              group_action_type=rng.below(2), group_title="renamed " + sentence(rng, 2))
        s.add(chat, base["t"] + 2, who, None, body="none", retracted=True)
        s.add(chat, base["t"] + 3, who, OBJ, assoc_type=1000, assoc_guid="p:0/" + base["guid"])
        s.add(chat, base["t"] + 4, who, None, body="none", assoc_type=4000,
              assoc_guid="p:0/" + base["guid"])
        s.add(chat, base["t"] + 5, who, "app message " + sentence(rng, 3), assoc_type=3,
              assoc_guid="p:0/" + base["guid"])
    return messages


def day_number(y, mo, d):
    return calendar.timegm((y, mo, d, 0, 0, 0)) // 86400


def build_specs():
    rng = Rng(20261111)
    s = Specs(rng)
    people = dict(PEOPLE)
    people.update(stress_people(rng))

    tiny = tiny_chat(s)

    def h(key):
        return people[key][2]

    # lively 7-person chat, split over an iMessage and an SMS chat row
    lively = generated_chat(
        s, rng, "lively",
        ["me", h("ines"), h("bram"), h("samr"), h("samc"), h("zoe"), h("anon6")],
        [20, 25, 18, 12, 10, 8, 7],
        day_number(2025, 10, 1), day_number(2026, 11, 10), (18, 70, 93),
        sms_chat="lively_sms")
    for i, text in enumerate(EDGE_TEXTS):
        s.add("lively", utc(2026, 5, 2 + i, 18, 30, i), h("bram")[0] if i % 2 else "me", text,
              body="only" if i % 3 == 0 else "both")
    s.add("lively", utc(2026, 5, 30, 18, 0), h("zoe")[0], None, body="none", att=2, has_att=1)

    # unnamed 5-person chat
    generated_chat(
        s, rng, "unnamed",
        ["me", h("bram"), h("samr"), h("anon7"), h("pat")],
        [30, 25, 20, 15, 10],
        day_number(2026, 1, 5), day_number(2026, 6, 30), (60, 97, 100))
    s.add("unnamed", utc(2026, 3, 3, 3, 3, 3), h("pat")[0], None, body="none",
          raw_text=b"bad \xff\xfe bytes in a text column")

    # 14 people with enormous names and long messages: over the link budget
    longs = sorted(k for k in people if k.startswith("long"))
    generated_chat(
        s, rng, "stress",
        ["me"] + [h(k) for k in longs],
        [10] + [12 - (i % 5) for i in range(len(longs))],
        day_number(2026, 2, 1), day_number(2026, 9, 30), (55, 96, 100), long_text=True)

    # two 1:1 chats that must never show up
    generated_chat(s, rng, "dm_ines", ["me", h("ines")], [50, 50],
                   day_number(2026, 3, 1), day_number(2026, 4, 15), (40, 90, 100))
    generated_chat(s, rng, "dm_bram", ["me", h("bram")], [50, 50],
                   day_number(2025, 11, 1), day_number(2025, 12, 15), (40, 90, 100))
    return s, people, tiny, lively


CHATS = {
    # key: (guid, chat_identifier, style, service, display_name, member people keys)
    "lively": ("iMessage;+;chat100000000000000001", "chat100000000000000001", 43, "iMessage",
               "Taco Tuesday Crew \U0001F32E", ["ines", "bram", "samr", "samc", "zoe", "anon6"]),
    "lively_sms": ("SMS;+;chat100000000000000001", "chat100000000000000001", 43, "SMS",
                   "", ["ines", "bram", "samr", "samc", "zoe", "anon6"]),
    "tiny": ("iMessage;+;chat200000000000000002", "chat200000000000000002", 43, "iMessage",
             "Book Club \U0001F4DA", ["nora", "ezra"]),
    "unnamed": ("iMessage;+;chat300000000000000003", "chat300000000000000003", 43, "iMessage",
                "", ["bram", "samr", "anon7", "pat"]),
    "stress": ("iMessage;+;chat400000000000000004", "chat400000000000000004", 43, "iMessage",
               "The Extremely Long-Named Group Chat Of Unreasonable Proportions "
               "\u2728\U0001FAA9\U0001F389 (est. 2019) \u300c\u9577\u3044\u540d\u524d\u300d", None),
    "dm_ines": ("iMessage;-;+15550100001", "+15550100001", 45, "iMessage", "", ["ines"]),
    "dm_bram": ("iMessage;-;+15550100002", "+15550100002", 45, "iMessage", "", ["bram"]),
}
CHAT_ORDER = ["lively", "lively_sms", "tiny", "unnamed", "stress", "dm_ines", "dm_bram"]


# --------------------------------------------------------------------------- #
# writing the Messages database
# --------------------------------------------------------------------------- #

MESSAGE_COLUMNS = [
    ("guid", "TEXT UNIQUE NOT NULL"), ("text", "TEXT"), ("replace", "INTEGER DEFAULT 0"),
    ("service_center", "TEXT"), ("handle_id", "INTEGER DEFAULT 0"), ("subject", "TEXT"),
    ("country", "TEXT"), ("attributedBody", "BLOB"), ("version", "INTEGER DEFAULT 0"),
    ("type", "INTEGER DEFAULT 0"), ("service", "TEXT"), ("account", "TEXT"),
    ("account_guid", "TEXT"), ("error", "INTEGER DEFAULT 0"), ("date", "INTEGER"),
    ("date_read", "INTEGER"), ("date_delivered", "INTEGER"),
    ("is_delivered", "INTEGER DEFAULT 0"), ("is_finished", "INTEGER DEFAULT 0"),
    ("is_emote", "INTEGER DEFAULT 0"), ("is_from_me", "INTEGER DEFAULT 0"),
    ("is_empty", "INTEGER DEFAULT 0"), ("is_read", "INTEGER DEFAULT 0"),
    ("is_sent", "INTEGER DEFAULT 0"), ("cache_has_attachments", "INTEGER DEFAULT 0"),
    ("cache_roomnames", "TEXT"), ("item_type", "INTEGER DEFAULT 0"),
    ("other_handle", "INTEGER DEFAULT 0"), ("group_title", "TEXT"),
    ("group_action_type", "INTEGER DEFAULT 0"), ("associated_message_guid", "TEXT"),
    ("associated_message_type", "INTEGER DEFAULT 0"), ("balloon_bundle_id", "TEXT"),
    ("payload_data", "BLOB"), ("expressive_send_style_id", "TEXT"),
    ("associated_message_range_location", "INTEGER DEFAULT 0"),
    ("associated_message_range_length", "INTEGER DEFAULT 0"),
    ("message_summary_info", "BLOB"), ("thread_originator_guid", "TEXT"),
    ("thread_originator_part", "TEXT"), ("date_retracted", "INTEGER DEFAULT 0"),
    ("date_edited", "INTEGER DEFAULT 0"), ("associated_message_emoji", "TEXT"),
]
LEGACY_DROPPED = {
    "attributedBody", "item_type", "other_handle", "group_title", "group_action_type",
    "associated_message_guid", "associated_message_type", "balloon_bundle_id", "payload_data",
    "expressive_send_style_id", "associated_message_range_location",
    "associated_message_range_length", "message_summary_info", "thread_originator_guid",
    "thread_originator_part", "date_retracted", "date_edited", "associated_message_emoji",
}


def create_messages_schema(con, dropped=()):
    cols = ", ".join('"%s" %s' % (n, t) for n, t in MESSAGE_COLUMNS if n not in dropped)
    con.executescript("""
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL,
            country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT,
            person_centric_id TEXT, UNIQUE (id, service));
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
            style INTEGER, state INTEGER, account_id TEXT, properties BLOB,
            chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT,
            is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT,
            group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, %s);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER,
            message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER,
            UNIQUE (chat_id, handle_id));
        CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
            guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0,
            start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT,
            transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0,
            transfer_name TEXT, total_bytes INTEGER DEFAULT 0, is_sticker INTEGER DEFAULT 0,
            hide_attachment INTEGER DEFAULT 0);
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER,
            UNIQUE (message_id, attachment_id));
        CREATE INDEX chat_message_join_idx_message_id ON chat_message_join (message_id, chat_id);
        CREATE INDEX message_idx_date ON message (date);
    """ % cols)


class MessagesWriter:
    def __init__(self, con, people, dropped=()):
        self.con = con
        self.dropped = set(dropped)
        self.handle_ids = {}     # (id, service) -> ROWID
        self.chat_ids = {}       # chat key -> ROWID
        self.n_attachments = 0
        self.people = people
        self.columns = [n for n, _ in MESSAGE_COLUMNS if n not in self.dropped]

    def handle(self, ident, service="iMessage"):
        key = (ident, service)
        if key not in self.handle_ids:
            cur = self.con.execute(
                "INSERT INTO handle (id, country, service, uncanonicalized_id) VALUES (?,?,?,?)",
                (ident, "us", service, None))
            self.handle_ids[key] = cur.lastrowid
        return self.handle_ids[key]

    def write_chats(self, stress_keys):
        for key in CHAT_ORDER:
            guid, ident, style, service, name, members = CHATS[key]
            if members is None:
                members = stress_keys
            cur = self.con.execute(
                "INSERT INTO chat (guid, style, state, chat_identifier, service_name, "
                "display_name, group_id) VALUES (?,?,?,?,?,?,?)",
                (guid, style, 3, ident, service, name, "GROUP-" + ident))
            self.chat_ids[key] = cur.lastrowid
            for person in members:
                for ident_ in self.people[person][2]:
                    if service == "SMS" and "@" in ident_:
                        continue
                    self.con.execute(
                        "INSERT OR IGNORE INTO chat_handle_join (chat_id, handle_id) VALUES (?,?)",
                        (cur.lastrowid, self.handle(ident_, service)))

    def write_message(self, spec):
        text = spec["text"]
        n_att = spec["att"] if spec["att"] is not None else (text or "").count(OBJ)
        has_att = spec["has_att"] if spec["has_att"] is not None else (1 if n_att else 0)
        body = None
        if spec["body"] in ("both", "only") and text is not None:
            body = archive_attributed_string(text, mutable=spec["mutable"])
        stored_text = None if spec["body"] == "only" else text
        if spec["precision"] == "s":
            date = spec["t"] - APPLE_EPOCH
        else:
            date = (spec["t"] - APPLE_EPOCH) * 1000000000 + spec["ns"]
        from_me = 1 if spec["sender"] == "me" else 0
        handle_id = 0 if from_me else self.handle(spec["sender"], spec["service"])
        assoc = spec["assoc_type"]
        values = {
            "guid": spec["guid"], "text": stored_text, "handle_id": handle_id,
            "attributedBody": body, "service": spec["service"], "date": date,
            "date_read": 0, "date_delivered": 0, "is_from_me": from_me,
            "is_finished": 1, "is_sent": from_me, "cache_has_attachments": has_att,
            "item_type": spec["item_type"], "group_title": spec["group_title"],
            "group_action_type": spec["group_action_type"],
            "associated_message_guid": spec["assoc_guid"],
            "associated_message_type": assoc,
            "associated_message_emoji": spec["emoji"],
            "date_retracted": date if spec["retracted"] else 0,
            "date_edited": date if spec["retracted"] else 0,
        }
        # real databases store 0 for ordinary rows; a few NULLs keep the
        # "NULL or < 1000" and "0 or NULL" branches of the rules honest
        if assoc == 0 and spec["seq"] % 19 == 0:
            values["associated_message_type"] = None
        if spec["item_type"] == 0 and spec["seq"] % 23 == 0:
            values["item_type"] = None
        names = [n for n in self.columns if n in values]
        sql = "INSERT INTO message (%s) VALUES (%s)" % (
            ", ".join('"%s"' % n for n in names), ", ".join("?" for _ in names))
        cur = self.con.execute(sql, [values[n] for n in names])
        rowid = cur.lastrowid
        if spec["raw_text"] is not None:
            self.con.execute("UPDATE message SET text = CAST(? AS TEXT) WHERE ROWID = ?",
                             (spec["raw_text"], rowid))
        self.con.execute(
            "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?,?,?)",
            (self.chat_ids[spec["chat"]], rowid, date))
        for i in range(n_att):
            self.n_attachments += 1
            cur = self.con.execute(
                "INSERT INTO attachment (guid, filename, mime_type, transfer_name, total_bytes) "
                "VALUES (?,?,?,?,?)",
                ("at_%d_%s" % (i, spec["guid"]), "~/Library/Messages/Attachments/fake/IMG_%04d.heic"
                 % self.n_attachments, "image/heic", "IMG_%04d.heic" % self.n_attachments, 1234))
            self.con.execute(
                "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?,?)",
                (rowid, cur.lastrowid))
        if spec["deleted"]:
            self.con.execute("DELETE FROM chat_message_join WHERE message_id = ?", (rowid,))
            self.con.execute("DELETE FROM message WHERE ROWID = ?", (rowid,))
        spec["rowid"] = rowid
        return rowid


def ordered(rows):
    """Insertion order: chronological, so ROWIDs grow with time as they do in
    a real database (insert_ns lets a row be stored out of order on purpose)."""
    return sorted(rows, key=lambda r: (
        r["t"], r["ns"] if r["insert_ns"] is None else r["insert_ns"], r["seq"]))


WAL_CUTOFF = utc(2026, 10, 25, 0, 0, 0)   # rows from here on stay in the -wal


def write_messages_db(work_path, specs, people, wal_cutoff=WAL_CUTOFF):
    """Create a WAL-mode database at work_path and leave the connection open,
    so the caller can copy the main file and its un-checkpointed -wal."""
    con = sqlite3.connect(work_path, isolation_level=None)
    con.execute("PRAGMA page_size = 4096")
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA wal_autocheckpoint = 0")
    con.execute("PRAGMA synchronous = OFF")
    create_messages_schema(con)
    writer = MessagesWriter(con, people)
    stress_keys = sorted(k for k in people if k.startswith("long"))
    con.execute("BEGIN")
    writer.write_chats(stress_keys)
    rows = ordered(specs.rows)
    late = []
    for spec in rows:
        if spec["t"] >= wal_cutoff:
            late.append(spec)
        else:
            writer.write_message(spec)
    con.execute("COMMIT")
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    # everything after the cutoff lands in the -wal, over several transactions
    chunk = max(1, len(late) // 4)
    for start in range(0, len(late), chunk):
        con.execute("BEGIN")
        for spec in late[start:start + chunk]:
            writer.write_message(spec)
        con.execute("COMMIT")
    return con, writer, len(late)


def snapshot(con, work_path, dest_db, dest_wal=None, dest_shm=None):
    """Copy the database (and optionally its sidecars) while `con` is open."""
    os.makedirs(os.path.dirname(dest_db), exist_ok=True)
    shutil.copyfile(work_path, dest_db)
    if dest_wal:
        os.makedirs(os.path.dirname(dest_wal), exist_ok=True)
        shutil.copyfile(work_path + "-wal", dest_wal)
    if dest_shm and os.path.exists(work_path + "-shm"):
        shutil.copyfile(work_path + "-shm", dest_shm)


def checkpointed_copy(con, dest_db):
    """A full copy with everything merged, still flagged as WAL mode."""
    os.makedirs(os.path.dirname(dest_db), exist_ok=True)
    out = sqlite3.connect(dest_db)
    con.backup(out)
    out.execute("PRAGMA journal_mode = WAL")
    out.commit()
    out.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()   # nothing may be left in a log
    out.close()
    for suffix in ("-wal", "-shm"):
        if os.path.exists(dest_db + suffix):
            os.remove(dest_db + suffix)
    with open(dest_db, "rb") as f:
        header = f.read(20)
    assert header[18] == 2 and header[19] == 2, "expected a WAL-flagged header"


# --------------------------------------------------------------------------- #
# address books
# --------------------------------------------------------------------------- #

def write_mac_address_book(path, cards):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
            ZFIRSTNAME VARCHAR, ZLASTNAME VARCHAR, ZMIDDLENAME VARCHAR, ZNICKNAME VARCHAR,
            ZORGANIZATION VARCHAR);
        CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
            ZOWNER INTEGER, ZFULLNUMBER VARCHAR, ZLABEL VARCHAR);
        CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
            ZOWNER INTEGER, ZADDRESS VARCHAR, ZADDRESSNORMALIZED VARCHAR, ZLABEL VARCHAR);
    """)
    for first, last, nick, org, values in cards:
        cur = con.execute(
            "INSERT INTO ZABCDRECORD (Z_ENT, Z_OPT, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, "
            "ZORGANIZATION) VALUES (22, 1, ?, ?, ?, ?)", (first, last, nick, org))
        for kind, value in values:
            if kind == "phone":
                con.execute("INSERT INTO ZABCDPHONENUMBER (Z_ENT, Z_OPT, ZOWNER, ZFULLNUMBER, "
                            "ZLABEL) VALUES (21, 1, ?, ?, '_$!<Mobile>!$_')", (cur.lastrowid, value))
            else:
                con.execute("INSERT INTO ZABCDEMAILADDRESS (Z_ENT, Z_OPT, ZOWNER, ZADDRESS, "
                            "ZADDRESSNORMALIZED, ZLABEL) VALUES (12, 1, ?, ?, ?, '_$!<Home>!$_')",
                            (cur.lastrowid, value, value.lower()))
    con.commit()
    con.close()


def write_ios_address_book(path, cards):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE ABPerson (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, First TEXT, Last TEXT,
            Middle TEXT, FirstPhonetic TEXT, MiddlePhonetic TEXT, LastPhonetic TEXT,
            Organization TEXT, Department TEXT, Note TEXT, Kind INTEGER, Birthday TEXT,
            JobTitle TEXT, Nickname TEXT, Prefix TEXT, Suffix TEXT, PersonLink INTEGER DEFAULT -1);
        CREATE TABLE ABMultiValue (UID INTEGER PRIMARY KEY, record_id INTEGER, property INTEGER,
            identifier INTEGER, label INTEGER, value TEXT, guid TEXT);
        CREATE TABLE ABStore (ROWID INTEGER PRIMARY KEY, Name TEXT, MeIdentifier INTEGER DEFAULT -1);
    """)
    for first, last, nick, org, values in cards:
        cur = con.execute("INSERT INTO ABPerson (First, Last, Nickname, Organization) "
                          "VALUES (?, ?, ?, ?)", (first, last, nick, org))
        for i, (kind, value) in enumerate(values):
            con.execute("INSERT INTO ABMultiValue (record_id, property, identifier, value) "
                        "VALUES (?, ?, ?, ?)", (cur.lastrowid, 3 if kind == "phone" else 4, i, value))
        # a street address (property 5 has no value text) must be ignored
        con.execute("INSERT INTO ABMultiValue (record_id, property, identifier, value) "
                    "VALUES (?, 5, 9, NULL)", (cur.lastrowid,))
    con.commit()
    con.close()


# --------------------------------------------------------------------------- #
# iPhone backup directory
# --------------------------------------------------------------------------- #

def write_backup(root, files, encrypted=False):
    """files: [(domain, relativePath, source path or bytes)]."""
    os.makedirs(root, exist_ok=True)
    manifest = sqlite3.connect(os.path.join(root, "Manifest.db"))
    manifest.executescript("""
        CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT,
            flags INTEGER, file BLOB);
        CREATE TABLE Properties (key TEXT PRIMARY KEY, value BLOB);
    """)
    for domain, rel, source in files:
        file_id = hashlib.sha1(("%s-%s" % (domain, rel)).encode("utf-8")).hexdigest()
        dest = os.path.join(root, file_id[:2], file_id)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if isinstance(source, bytes):
            with open(dest, "wb") as f:
                f.write(source)
        else:
            shutil.copyfile(source, dest)
        info = plistlib.dumps({"RelativePath": rel, "Size": os.path.getsize(dest)},
                              fmt=plistlib.FMT_BINARY)
        manifest.execute("INSERT INTO Files VALUES (?,?,?,1,?)", (file_id, domain, rel, info))
    for domain, rel in (("HomeDomain", "Library/SMS"), ("HomeDomain", "Library/AddressBook")):
        file_id = hashlib.sha1(("%s-%s" % (domain, rel)).encode("utf-8")).hexdigest()
        manifest.execute("INSERT INTO Files VALUES (?,?,?,2,NULL)", (file_id, domain, rel))
    manifest.commit()
    manifest.close()
    with open(os.path.join(root, "Manifest.plist"), "wb") as f:
        plistlib.dump({"IsEncrypted": encrypted, "Version": "10.0", "SystemDomainsVersion": "24.0",
                       "Lockdown": {"DeviceName": "Invented iPhone", "ProductVersion": "26.1"}},
                      f, fmt=plistlib.FMT_BINARY)
    with open(os.path.join(root, "Info.plist"), "wb") as f:
        plistlib.dump({"Device Name": "Invented iPhone", "Product Version": "26.1",
                       "Unique Identifier": FAKE_UDID}, f)
    with open(os.path.join(root, "Status.plist"), "wb") as f:
        plistlib.dump({"IsFullBackup": True, "SnapshotState": "finished", "Version": "3.3"},
                      f, fmt=plistlib.FMT_BINARY)


# --------------------------------------------------------------------------- #
# small variant databases
# --------------------------------------------------------------------------- #

def write_legacy_db(path):
    """An old-schema database: dates in seconds, no attributedBody and no
    associated_message_* / item_type columns."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path)
    create_messages_schema(con, dropped=LEGACY_DROPPED)
    con.execute("INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) "
                "VALUES ('iMessage;+;chat900000000000000009', 43, 'chat900000000000000009', "
                "'iMessage', 'Old Friends')")
    for ident in ("+15550100001", "+15550100002"):
        cur = con.execute("INSERT INTO handle (id, service) VALUES (?, 'iMessage')", (ident,))
        con.execute("INSERT INTO chat_handle_join VALUES (1, ?)", (cur.lastrowid,))
    rows = [
        (utc(2016, 6, 1, 19, 0), 1, 0, "remember flip phones"),
        (utc(2016, 6, 1, 19, 1), 0, 1, "barely"),
        (utc(2016, 6, 1, 19, 2), 2, 0, "I still have mine"),
        (utc(2016, 6, 2, 3, 30), 1, 0, OBJ),
        (utc(2016, 6, 2, 3, 31), 0, 1, ""),
    ]
    for i, (t, handle_id, from_me, text) in enumerate(rows):
        cur = con.execute(
            "INSERT INTO message (guid, text, handle_id, service, date, is_from_me, "
            "cache_has_attachments) VALUES (?,?,?,?,?,?,?)",
            ("LEGACY-%04d" % i, text, handle_id, "iMessage", t - APPLE_EPOCH, from_me,
             1 if text == OBJ else 0))
        con.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)",
                    (cur.lastrowid,))
    con.commit()
    con.close()


def write_noemoji_db(path, specs, people):
    """The tiny chat on a schema without associated_message_emoji."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path, isolation_level=None)
    create_messages_schema(con, dropped={"associated_message_emoji"})
    writer = MessagesWriter(con, people, dropped={"associated_message_emoji"})
    con.execute("BEGIN")
    writer.write_chats(sorted(k for k in people if k.startswith("long")))
    for spec in ordered(specs.rows):
        if spec["chat"] == "tiny":
            writer.write_message(dict(spec))
    con.execute("COMMIT")
    con.close()


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #

def build(out_dir):
    """Build every fixture under out_dir and return the fixture.json dict."""
    out_dir = os.path.abspath(out_dir)
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    work = os.path.join(out_dir, "_work")
    os.makedirs(work)

    specs, people, tiny, lively = build_specs()
    cards = contact_cards(people)

    work_db = os.path.join(work, "chat.db")
    con, writer, n_wal_rows = write_messages_db(work_db, specs, people)

    mac = os.path.join(out_dir, "mac")
    snapshot(con, work_db, os.path.join(mac, "chat.db"), os.path.join(mac, "chat.db-wal"),
             os.path.join(mac, "chat.db-shm"))

    # address books: an almost empty top-level one plus the real "source"
    ab_main = os.path.join(mac, "AddressBook", "AddressBook-v22.abcddb")
    ab_source = os.path.join(mac, "AddressBook", "Sources", "0A1B2C3D-FAKE-FAKE-FAKE-000000000001",
                             "AddressBook-v22.abcddb")
    write_mac_address_book(ab_main, cards[-1:])
    write_mac_address_book(ab_source, cards[:-1])
    ios_ab = os.path.join(work, "AddressBook.sqlitedb")
    write_ios_address_book(ios_ab, cards)

    # iPhone backups
    sms_merged = os.path.join(work, "sms.db")
    checkpointed_copy(con, sms_merged)
    backup = os.path.join(out_dir, "backup", FAKE_UDID)
    write_backup(backup, [
        ("HomeDomain", "Library/SMS/sms.db", sms_merged),
        ("HomeDomain", "Library/AddressBook/AddressBook.sqlitedb", ios_ab),
    ])
    backup_wal = os.path.join(out_dir, "backup-wal", FAKE_UDID)
    write_backup(backup_wal, [
        ("HomeDomain", "Library/SMS/sms.db", os.path.join(mac, "chat.db")),
        ("HomeDomain", "Library/SMS/sms.db-wal", os.path.join(mac, "chat.db-wal")),
        ("HomeDomain", "Library/AddressBook/AddressBook.sqlitedb", ios_ab),
    ])
    noise = hashlib.sha256(b"not a database").digest() * 64
    backup_enc = os.path.join(out_dir, "backup-encrypted", FAKE_UDID)
    write_backup(backup_enc, [
        ("HomeDomain", "Library/SMS/sms.db", noise),
        ("HomeDomain", "Library/AddressBook/AddressBook.sqlitedb", noise),
    ], encrypted=True)
    # an encrypted backup's Manifest.db is not readable either
    with open(os.path.join(backup_enc, "Manifest.db"), "wb") as f:
        f.write(noise)

    con.close()

    write_legacy_db(os.path.join(out_dir, "legacy", "chat.db"))
    write_noemoji_db(os.path.join(out_dir, "noemoji", "chat.db"), specs, people)
    shutil.rmtree(work)

    wal_size = os.path.getsize(os.path.join(mac, "chat.db-wal"))
    assert wal_size > 32, "the Mac fixture must keep an un-checkpointed -wal"

    info = {
        "now": NOW_UNIX,
        "wal_cutoff": WAL_CUTOFF,
        "wal_rows": n_wal_rows,
        "paths": {
            "chat_db": "mac/chat.db",
            "chat_db_wal": "mac/chat.db-wal",
            "address_book_dir": "mac/AddressBook",
            "address_books": ["mac/AddressBook/AddressBook-v22.abcddb",
                              os.path.relpath(ab_source, out_dir).replace(os.sep, "/")],
            "backup": "backup/" + FAKE_UDID,
            "backup_parent": "backup",
            "backup_wal": "backup-wal/" + FAKE_UDID,
            "backup_encrypted": "backup-encrypted/" + FAKE_UDID,
            "backup_sms": "backup/%s/%s/%s" % (FAKE_UDID, SMS_DB_ID[:2], SMS_DB_ID),
            "backup_address_book": "backup/%s/%s/%s" % (FAKE_UDID, ADDRESS_BOOK_ID[:2], ADDRESS_BOOK_ID),
            "legacy_db": "legacy/chat.db",
            "noemoji_db": "noemoji/chat.db",
        },
        "chats": {
            key: {"rowid": writer.chat_ids[key], "guid": CHATS[key][0],
                  "chat_identifier": CHATS[key][1], "style": CHATS[key][2],
                  "display_name": CHATS[key][4]}
            for key in CHAT_ORDER
        },
        "tiny": {label: {"guid": spec["guid"], "rowid": spec.get("rowid")}
                 for label, spec in tiny.items()},
        "lively_messages": len(lively),
        "typedstream_samples": [
            {"name": name, "text": text, "mutable": mutable,
             "hex": archive_attributed_string(text, mutable=mutable).hex()}
            for name, text, mutable in typedstream_samples()
        ],
    }
    with open(os.path.join(out_dir, "fixture.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=1)
    return info


def main(argv):
    if len(argv) != 2:
        sys.stderr.write(__doc__)
        return 2
    info = build(argv[1])
    sys.stdout.write("fixture written to %s (%d rows in the -wal)\n"
                     % (os.path.abspath(argv[1]), info["wal_rows"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
