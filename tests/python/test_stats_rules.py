"""The counting rules of docs/SCHEMA.md section 2, one at a time, on
hand-made rows (no database involved)."""

import calendar
import datetime
import json
import unittest
from zoneinfo import ZoneInfo

import support
from support import LA, msg, ns, tap

from wrapped import stats as S
from wrapped.stats import compute_stats

A, B, C = "+15550100001", "+15550100002", "+15550100003"
# how a number with no contact name is shown: never in full (docs/SCHEMA.md 2)
NA, NB, NC = "\u20260001", "\u20260002", "\u20260003"
NOW = calendar.timegm((2026, 11, 11, 20, 0, 0))      # 12:00 PST


def utc(*parts):
    return calendar.timegm(tuple(parts) + (0,) * (6 - len(parts)))


def run(rows, **options):
    options.setdefault("tz", "UTC")
    options.setdefault("now", NOW)
    return compute_stats(rows, options)


class Timestamps(unittest.TestCase):
    def test_nanoseconds_and_seconds(self):
        t = utc(2026, 3, 1, 15, 30)
        rows = [msg(t, A), {"date": t - support.APPLE_EPOCH, "handle": B, "text": "seconds"},
                {"date": str(ns(t, 999999999)), "handle": C, "text": "string"}]
        st = run(rows)
        self.assertEqual(st["totals"]["messages"], 3)
        self.assertEqual(st["by_hour"][15], 3)
        self.assertEqual(st["busiest_day"], {"date": "2026-03-01", "messages": 3})

    def test_threshold_between_units(self):
        self.assertEqual(S._split_date(99999), (99999 + support.APPLE_EPOCH, 0))
        self.assertEqual(S._split_date(100000000001), (100 + support.APPLE_EPOCH, 1))
        self.assertIsNone(S._split_date(100000000000))    # as seconds: the year 5138

    def test_rows_without_a_usable_date_are_ignored(self):
        rows = [msg(utc(2026, 3, 1), A)]
        for bad in (None, 0, -5, "", "soon", 9 * 10 ** 18):
            rows.append({"date": bad, "handle": B, "text": "no date"})
        self.assertEqual(run(rows, all_time=True)["totals"]["messages"], 1)

    def test_last_nanosecond_of_the_day_stays_on_that_day(self):
        t = utc(2026, 2, 15, 7, 59, 59)             # 23:59:59 PST on Feb 14
        rows = [{"date": ns(t, 999999999), "handle": A, "text": "late"},
                {"date": ns(t + 1), "handle": A, "text": "midnight"}]
        st = run(rows, tz=LA)
        self.assertEqual(st["by_hour"][23], 1)
        self.assertEqual(st["by_hour"][0], 1)
        self.assertEqual(st["totals"]["days_active"], 2)
        self.assertEqual(st["totals"]["longest_streak"], 2)

    def test_local_time_zone_buckets(self):
        t = utc(2026, 7, 5, 4, 30)                   # Jul 4 21:30 PDT, Jul 5 10:00 IST
        cases = {LA: ("2026-07-04", 21, 5), "UTC": ("2026-07-05", 4, 6),
                 "Asia/Kolkata": ("2026-07-05", 10, 6), "Asia/Kathmandu": ("2026-07-05", 10, 6),
                 "Pacific/Chatham": ("2026-07-05", 17, 6)}
        for zone, (day, hour, weekday) in cases.items():
            st = run([msg(t, A)], tz=zone)
            self.assertEqual(st["busiest_day"]["date"], day, zone)
            self.assertEqual(st["by_hour"][hour], 1, zone)
            self.assertEqual(st["by_weekday"][weekday], 1, zone)
            self.assertEqual(st["by_month"][6], 1, zone)

    def test_daylight_saving_transitions(self):
        rows = [msg(utc(2026, 3, 8, 9, 59), A),      # 01:59 PST
                msg(utc(2026, 3, 8, 10, 0, 30), A),  # 03:00 PDT
                msg(utc(2026, 11, 1, 8, 30), A),     # 01:30 PDT
                msg(utc(2026, 11, 1, 9, 30), A)]     # 01:30 PST
        st = run(rows, tz=LA)
        self.assertEqual(st["by_hour"][1], 3)
        self.assertEqual(st["by_hour"][3], 1)
        self.assertEqual(st["by_hour"][2], 0)

    def test_offset_table_matches_zoneinfo_everywhere(self):
        for zone in (LA, "Asia/Kolkata", "Australia/Lord_Howe", "Europe/London",
                     "America/Sao_Paulo", "Africa/Casablanca", "Pacific/Apia", "UTC"):
            info = ZoneInfo(zone)
            lo, hi = utc(2009, 1, 1), utc(2027, 1, 1)
            table = S._Offsets(S._offset_function(zone), lo, hi)
            step = 5 * 3600 + 1234
            for t in range(lo, hi, step):
                want = datetime.datetime.fromtimestamp(t, info).utcoffset().total_seconds()
                self.assertEqual(table.at(t), want, (zone, t))
            for start in table.starts[1:]:            # exact to the second
                self.assertNotEqual(table.at(start - 1), table.at(start), (zone, start))

    def test_default_zone_is_the_computers(self):
        t = utc(2026, 6, 1, 12, 0)
        import time as _time
        hour = _time.localtime(t).tm_hour
        st = compute_stats([msg(t, A)], now=NOW)
        self.assertEqual(st["by_hour"][hour], 1)

    def test_unknown_zone_is_an_error(self):
        with self.assertRaises(ValueError):
            run([msg(utc(2026, 3, 1), A)], tz="Mars/Olympus_Mons")

    def test_civil_date_helpers_round_trip(self):
        for day in range(-800, 40000, 37):
            date = datetime.date(1970, 1, 1) + datetime.timedelta(days=day)
            self.assertEqual(S._civil_from_days(day), (date.year, date.month, date.day))
            self.assertEqual(S._days_from_civil(date.year, date.month, date.day), day)
            self.assertEqual((day + 3) % 7, date.weekday())


class Period(unittest.TestCase):
    rows = [msg(utc(2024, 6, 1, 12), A, "old"), msg(utc(2025, 12, 31, 23), A, "last year"),
            msg(utc(2026, 1, 1, 0), B, "new year"), msg(utc(2026, 11, 11, 23), B, "today"),
            msg(utc(2026, 11, 12, 0), B, "tomorrow")]

    def test_default_is_the_current_year_up_to_today(self):
        st = run(self.rows)
        self.assertEqual(st["period"], {"label": "2026", "start": "2026-01-01", "end": "2026-11-11"})
        self.assertEqual(st["totals"]["messages"], 2)
        self.assertEqual(st["meta"]["generated"], "2026-11-11")

    def test_default_in_january_is_the_previous_year(self):
        st = run(self.rows, now=utc(2026, 1, 20, 12))
        self.assertEqual(st["period"], {"label": "2025", "start": "2025-01-01", "end": "2025-12-31"})
        self.assertEqual(st["totals"]["messages"], 1)

    def test_today_follows_the_time_zone(self):
        now = utc(2026, 1, 1, 3)                      # still Dec 31 in Los Angeles
        self.assertEqual(run(self.rows, now=now, tz=LA)["period"]["label"], "2025")
        self.assertEqual(run(self.rows, now=now, tz="UTC")["period"]["label"], "2025")  # January
        now = utc(2026, 2, 1, 3)                      # Feb 1 UTC, Jan 31 in Los Angeles
        self.assertEqual(run(self.rows, now=now, tz="UTC")["period"]["label"], "2026")
        self.assertEqual(run(self.rows, now=now, tz=LA)["period"]["label"], "2025")

    def test_explicit_year(self):
        st = run(self.rows, year=2025)
        self.assertEqual(st["period"], {"label": "2025", "start": "2025-01-01", "end": "2025-12-31"})
        self.assertEqual(st["totals"]["messages"], 1)
        self.assertEqual(run(self.rows, year=2023)["totals"]["messages"], 0)

    def test_all_time_starts_at_the_first_message(self):
        st = run(self.rows, all_time=True)
        self.assertEqual(st["period"], {"label": "All time", "start": "2024-06-01", "end": "2026-11-11"})
        self.assertEqual(st["totals"]["messages"], 4)
        empty = run([], all_time=True)
        self.assertEqual(empty["period"], {"label": "All time", "start": "2026-11-11", "end": "2026-11-11"})

    def test_explicit_bounds_are_inclusive(self):
        st = run(self.rows, start="2025-12-31", end="2026-01-01")
        self.assertEqual(st["period"], {"label": "2025-12-31 \u2013 2026-01-01",
                                        "start": "2025-12-31", "end": "2026-01-01"})
        self.assertEqual(st["totals"]["messages"], 2)
        self.assertEqual(run(self.rows, start="2026-11-12", end="2026-12-31")["totals"]["messages"], 1)
        self.assertEqual(run(self.rows, end="2025-01-01", label="Early")["period"],
                         {"label": "Early", "start": "2024-06-01", "end": "2025-01-01"})

    def test_bad_dates_are_errors(self):
        for bad in ({"start": "2026-02-30"}, {"start": "yesterday"},
                    {"start": "2026-05-01", "end": "2026-04-01"}):
            with self.assertRaises(ValueError):
                run(self.rows, **bad)


class Countable(unittest.TestCase):
    t = utc(2026, 5, 5, 10)

    def count(self, row):
        return run([row])["totals"]["messages"]

    def test_text_or_attachment_is_required(self):
        self.assertEqual(self.count(msg(self.t, A, "hi")), 1)
        self.assertEqual(self.count(msg(self.t, A, None)), 0)
        self.assertEqual(self.count(msg(self.t, A, "")), 0)
        self.assertEqual(self.count(msg(self.t, A, " \n\t\u00a0")), 0)
        self.assertEqual(self.count(msg(self.t, A, "\ufffc")), 0)
        self.assertEqual(self.count(msg(self.t, A, "\ufffc", cache_has_attachments=1)), 1)
        self.assertEqual(self.count(msg(self.t, A, None, cache_has_attachments=1)), 1)
        self.assertEqual(self.count(msg(self.t, A, None, keep_empty=1)), 1)

    def test_group_events_are_not_messages(self):
        for item_type in (1, 2, 3, 4, 6):
            self.assertEqual(self.count(msg(self.t, A, "event", item_type=item_type)), 0)
        self.assertEqual(self.count(msg(self.t, A, "ok", item_type=0)), 1)
        self.assertEqual(self.count(msg(self.t, A, "ok", item_type=None)), 1)

    def test_associated_message_types(self):
        for kind in (None, 0, 2, 3, 999):
            self.assertEqual(self.count(msg(self.t, A, "x", associated_message_type=kind)), 1, kind)
        for kind in (1000, 2000, 2007, 3000, 3007, 4000):
            self.assertEqual(self.count(msg(self.t, A, "x", associated_message_type=kind,
                                            associated_message_guid="p:0/G")), 0, kind)

    def test_attributed_body_is_used_when_text_is_empty(self):
        body = support.build_fixture.archive_attributed_string("four words in here")
        for text in (None, ""):
            st = run([msg(self.t, A, text, attributedBody=body)])
            self.assertEqual(st["totals"], dict(st["totals"], messages=1, words=4))
        st = run([msg(self.t, A, "text wins", attributedBody=body)])
        self.assertEqual(st["totals"]["words"], 2)
        st = run([msg(self.t, A, None, attributedBody=b"not a typedstream")])
        self.assertEqual(st["totals"]["messages"], 0)

    def test_attachments_are_counted_per_message(self):
        rows = [msg(self.t, A, "\ufffc\ufffc\ufffc", cache_has_attachments=1),
                msg(self.t, A, "\ufffclook", cache_has_attachments=1),
                msg(self.t, B, "plain")]
        st = run(rows)
        self.assertEqual(st["totals"]["attachments"], 2)
        self.assertEqual(st["totals"]["words"], 2)
        self.assertEqual(st["senders"][0]["attachments"], 2)


class Words(unittest.TestCase):
    def test_cleaning(self):
        self.assertEqual(S.clean_text("  \ufffc hi \ufffd there \ufffc\n"), "hi  there")
        self.assertEqual(S.clean_text(None), "")
        self.assertEqual(S.clean_text("\ufeff\u3000x\u2028"), "x")

    def test_words_are_whitespace_separated_tokens(self):
        cases = {
            "": 0, "one": 1, "two words": 2, "tabs\tand\nnewlines\r\nmixed   spaces": 5,
            "nbsp\u00a0separated\u00a0words": 3, "ideographic\u3000space": 2,
            "zero\u200bwidth\u200bspace is not a separator": 5, "bom\ufeffinside": 2,
            "unit\x1fseparator and\x1cfile separator": 3, "next\x85line": 1,
            "line\u2028separator\u2029paragraph": 3,
            "narrow\u202fnbsp and\u205fmath space and\u1680ogham": 7,
            "\u180emongolian vowel separator": 3, "nul\x00inside the text": 3,
            "emoji \U0001F468\u200d\U0001F469\u200d\U0001F467 \U0001F1E8\U0001F1E6": 3,
        }
        for text, expected in cases.items():
            self.assertEqual(S.count_words(S.clean_text(text)), expected, repr(text))

    def test_every_whitespace_character_separates(self):
        for ch in S.WHITESPACE:
            self.assertEqual(S.count_words("a" + ch + "b"), 2, repr(ch))
            self.assertEqual(S.clean_text(ch + "a" + ch), "a", repr(ch))
        for ch in "\x1c\x1d\x1e\x1f\x85\u200b\u180e\u2060":
            self.assertEqual(S.count_words("a" + ch + "b"), 1, repr(ch))


class Senders(unittest.TestCase):
    t = utc(2026, 5, 5, 10)

    def test_owner_name(self):
        self.assertEqual(run([msg(self.t)])["senders"][0]["name"], "Me")
        self.assertEqual(run([msg(self.t)], me="Amara")["senders"][0]["name"], "Amara")

    def test_contacts_match_phones_on_last_ten_digits_and_emails_without_case(self):
        contacts = {"(555) 010-0001": "Ines Calloway", "Ines.Calloway@Example.com": "Ines Calloway",
                    "001 555 010 0002": "Bram Okoye"}
        rows = [msg(self.t, "+15550100001"), msg(self.t, "ines.calloway@example.com"),
                msg(self.t, "5550100001"), msg(self.t, "+15550100002"), msg(self.t, "+15550100003"),
                msg(self.t, "INES.CALLOWAY@EXAMPLE.COM")]
        st = run(rows, contacts=contacts)
        got = {s["name"]: s["messages"] for s in st["senders"]}
        self.assertEqual(got, {"Ines Calloway": 4, "Bram Okoye": 1, NC: 1})
        self.assertEqual(st["chat"]["members"], 4)     # three people plus the owner

    def test_contact_pairs_and_conflicts(self):
        pairs = [["+1 555 010 0001", "Zed"], ["5550100001", "Alba"], ["", "Nobody"],
                 ["+15550100002", "  "], [None, "x"], ["555-010-0002", "Bram"]]
        st = run([msg(self.t, A), msg(self.t, B)], contacts=pairs)
        self.assertEqual(sorted(s["name"] for s in st["senders"]), ["Alba", "Bram"])
        reverse = run([msg(self.t, A), msg(self.t, B)], contacts=list(reversed(pairs)))
        self.assertEqual(reverse["senders"], st["senders"])

    def test_contact_key(self):
        self.assertEqual(S.contact_key("+1 (555) 010-0001"), "p:5550100001")
        self.assertEqual(S.contact_key("\u202a+1\u00a0555\u2011010\u20110001\u202c"), "p:5550100001")
        self.assertEqual(S.contact_key("22000"), "p:22000")
        self.assertEqual(S.contact_key(" Ines@Example.COM "), "e:ines@example.com")
        self.assertEqual(S.contact_key("\u0130nes@example.com"), "e:\u0130nes@example.com")
        self.assertIsNone(S.contact_key("Pizza Planet"))
        self.assertIsNone(S.contact_key(""))
        self.assertIsNone(S.contact_key(None))

    def test_unknown_sender_without_a_handle(self):
        st = run([{"date": ns(self.t), "is_from_me": 0, "handle": None, "text": "who"}])
        self.assertEqual(st["senders"][0]["name"], "Unknown")

    def test_same_display_name_merges_with_the_owner_too(self):
        st = run([msg(self.t), msg(self.t, A)], me="Sam", contacts={A: "Sam"})
        self.assertEqual(len(st["senders"]), 1)
        self.assertEqual(st["senders"][0]["messages"], 2)
        self.assertEqual(st["chat"]["members"], 1)

    def test_members_include_silent_participants(self):
        st = run([msg(self.t, A)], participants=[A, B, C, "bram@example.com"],
                 contacts={B: "Bram", "bram@example.com": "Bram"})
        self.assertEqual(st["chat"]["members"], 4)      # A, Bram, C, owner
        gone = run([msg(self.t, "+15550109999")], participants=[A])
        self.assertEqual(gone["chat"]["members"], 3)    # someone who left still spoke

    def test_sorted_by_messages_then_name_and_capped_at_twelve(self):
        rows = []
        for i in range(15):
            handle = "+155501001%02d" % i
            rows += [msg(self.t + j, handle) for j in range(1 + (i % 3))]
        st = run(rows)
        self.assertEqual(len(st["senders"]), 12)
        keys = [(-s["messages"], s["name"]) for s in st["senders"]]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(st["totals"]["messages"], len(rows))    # totals keep everyone
        self.assertEqual(st["chat"]["members"], 16)

    def test_name_order_is_utf16_code_unit_order(self):
        names = ["\U0001F525 Jake", "\uff21lice", "Zed", "amy", "\u00c9mile"]
        contacts = {"+155501002%02d" % i: n for i, n in enumerate(names)}
        st = run([msg(self.t, h) for h in contacts], contacts=contacts)
        self.assertEqual([s["name"] for s in st["senders"]],
                         ["Zed", "amy", "\u00c9mile", "\U0001F525 Jake", "\uff21lice"])

    def test_shares_are_rounded_half_up_to_four_decimals(self):
        rows = [msg(self.t + i, A) for i in range(1)] + [msg(self.t + i, B) for i in range(2)]
        st = run(rows)
        self.assertEqual([s["share"] for s in st["senders"]], [0.6667, 0.3333])
        for n, total, want in ((1, 3, 0.3333), (2, 3, 0.6667), (1, 8, 0.125), (1, 16, 0.0625),
                               (1, 32, 0.0313), (3, 32, 0.0938), (1, 20000, 0.0001),
                               (1, 20001, 0), (5, 5, 1), (0, 5, 0), (0, 0, 0)):
            self.assertEqual(S._round4(n, total), want, (n, total))
        self.assertIsInstance(S._round4(5, 5), int)


class ChatName(unittest.TestCase):
    contacts = {A: "Ines Calloway", B: "Bram Okoye", C: "Sam Rivera", "+15550100004": "Sam Chen"}

    def test_display_name_wins(self):
        self.assertEqual(S.chat_display_name("  Dinner Club ", [A, B]), "Dinner Club")

    def test_fallback_uses_first_names(self):
        name = S.chat_display_name
        self.assertEqual(name("", [A], self.contacts), "Ines")
        self.assertEqual(name(None, [A, B], self.contacts), "Ines, Bram")
        self.assertEqual(name("", [A, B, C], self.contacts), "Ines, Bram, Sam")
        self.assertEqual(name("", [A, B, C, "+15550100004"], self.contacts), "Ines, Bram, Sam & 1 more")
        self.assertEqual(name(" ", [A, B, C, "+15550100004", "x@example.com", "+15550100009"],
                              self.contacts), "Ines, Bram, Sam & 3 more")
        self.assertEqual(name("", [B, "+15550100007", A]), "\u20260002, \u20260007, \u20260001")
        self.assertEqual(name("", []), "Unnamed group")
        self.assertEqual(name("", [A, "(555) 010-0001", "ines@example.com"],
                              {A: "Ines Calloway", "ines@example.com": "Ines Calloway"}), "Ines")
        self.assertEqual(name("", [A, B], {A: "Amara"}, me="Amara"), NB)

    def test_stats_use_the_same_name(self):
        st = run([msg(utc(2026, 5, 5), A)], participants=[A, B, C, "+15550100004"],
                 contacts=self.contacts, chat_name="")
        self.assertEqual(st["chat"], {"name": "Ines, Bram, Sam & 1 more", "members": 5})
        st = run([msg(utc(2026, 5, 5), A)], chat_name="Named", participants=[A])
        self.assertEqual(st["chat"], {"name": "Named", "members": 2})


class Tapbacks(unittest.TestCase):
    t = utc(2026, 5, 5, 10)

    def setUp(self):
        self.m = msg(self.t, A, "funny thing", guid="G-1", rowid=1)

    def kinds(self, rows, **options):
        st = run([self.m] + rows, **options)
        return st["reactions"]["by_kind"], st

    def test_each_kind(self):
        names = ["love", "like", "dislike", "laugh", "emphasize", "question", "emoji", "emoji"]
        for offset, name in enumerate(names):
            by_kind, st = self.kinds([tap(self.t + 5, B, 2000 + offset, self.m)])
            self.assertEqual(by_kind[name], 1, offset)
            self.assertEqual(st["totals"]["reactions"], 1)
            self.assertEqual(st["totals"]["messages"], 1)   # a tapback is never a message

    def test_remove_and_change(self):
        by_kind, st = self.kinds([tap(self.t + 5, B, 2001, self.m), tap(self.t + 9, B, 3001, self.m)])
        self.assertEqual(st["totals"]["reactions"], 0)
        self.assertEqual(st["most_reacted"], [])
        self.assertIsNone(st["reactions"]["top_giver"])
        by_kind, st = self.kinds([tap(self.t + 5, B, 2003, self.m), tap(self.t + 9, B, 2000, self.m)])
        self.assertEqual((by_kind["laugh"], by_kind["love"], st["totals"]["reactions"]), (0, 1, 1))
        # removing with a different kind code still clears that person's tapback
        by_kind, st = self.kinds([tap(self.t + 5, B, 2003, self.m), tap(self.t + 9, B, 3000, self.m)])
        self.assertEqual(st["totals"]["reactions"], 0)

    def test_order_is_chronological_then_rowid(self):
        add = tap(self.t + 5, B, 2001, self.m, rowid=9)
        remove = tap(self.t + 5, B, 3001, self.m, rowid=3)
        remove["date"] += 1                           # one nanosecond later, lower ROWID
        self.assertEqual(self.kinds([remove, add])[1]["totals"]["reactions"], 0)
        self.assertEqual(self.kinds([add, remove])[1]["totals"]["reactions"], 0)
        first = tap(self.t + 5, B, 2000, self.m, rowid=3)
        second = tap(self.t + 5, B, 2003, self.m, rowid=4)
        for rows in ([first, second], [second, first]):
            self.assertEqual(self.kinds(rows)[0]["laugh"], 1)

    def test_target_formats(self):
        for prefix in ("p:0/", "p:1/", "bp:", ""):
            by_kind, st = self.kinds([tap(self.t + 5, B, 2000, self.m, prefix=prefix)])
            self.assertEqual(st["totals"]["reactions"], 1, prefix)

    def test_each_message_part_keeps_its_own_tapback(self):
        rows = [tap(self.t + 5, B, 2000, self.m, prefix="p:0/"),
                tap(self.t + 6, B, 2003, self.m, prefix="p:1/"),
                tap(self.t + 7, B, 3003, self.m, prefix="p:1/")]
        by_kind, st = self.kinds(rows[:2])
        self.assertEqual((by_kind["love"], by_kind["laugh"]), (1, 1))
        by_kind, st = self.kinds(rows)
        self.assertEqual((by_kind["love"], by_kind["laugh"]), (1, 0))

    def test_unknown_or_uncountable_targets_do_not_count(self):
        ghost = {"guid": "NOT-IN-CHAT"}
        event = msg(self.t, A, None, guid="EV", item_type=2)
        st = run([self.m, event, tap(self.t + 5, B, 2000, ghost), tap(self.t + 5, B, 2000, event),
                  msg(self.t + 6, B, "x", associated_message_type=2000)])
        self.assertEqual(st["totals"]["reactions"], 0)

    def test_tapbacks_on_messages_outside_the_period(self):
        old = msg(utc(2025, 12, 31, 12), A, "last year", guid="OLD")
        rows = [old, tap(utc(2026, 1, 2), B, 2000, old), tap(utc(2026, 1, 3), C, 2003, self.m)]
        by_kind, st = self.kinds(rows)                  # 2026
        self.assertEqual(st["totals"]["reactions"], 1)
        self.assertEqual(by_kind["laugh"], 1)
        st = run([self.m] + rows, year=2025)            # the tapback came after 2025 ended
        self.assertEqual(st["totals"]["reactions"], 0)
        st = run([self.m] + rows, all_time=True)
        self.assertEqual(st["totals"]["reactions"], 2)

    def test_standing_means_at_the_end_of_the_period(self):
        rows = [tap(self.t + 5, B, 2000, self.m), tap(utc(2026, 11, 12, 5), B, 3000, self.m)]
        self.assertEqual(self.kinds(rows)[1]["totals"]["reactions"], 1)       # removed "tomorrow"
        self.assertEqual(self.kinds(rows, now=utc(2026, 11, 13))[1]["totals"]["reactions"], 0)

    def test_reactors_are_merged_by_display_name(self):
        contacts = {B: "Bram", "bram@example.com": "Bram"}
        rows = [tap(self.t + 5, B, 2001, self.m), tap(self.t + 9, "bram@example.com", 3001, self.m)]
        self.assertEqual(self.kinds(rows, contacts=contacts)[1]["totals"]["reactions"], 0)
        self.assertEqual(self.kinds(rows)[1]["totals"]["reactions"], 1)

    def test_given_and_received(self):
        other = msg(self.t + 1, B, "second", guid="G-2")
        rows = [other, tap(self.t + 5, B, 2003, self.m), tap(self.t + 6, C, 2003, self.m),
                tap(self.t + 7, "me", 2000, self.m), tap(self.t + 8, "me", 2000, other),
                tap(self.t + 9, A, 2001, self.m)]       # reacting to your own message counts
        by_kind, st = self.kinds(rows)
        people = {s["name"]: s for s in st["senders"]}
        self.assertEqual(people[NA]["reactions_received"], 4)
        self.assertEqual(people[NA]["reactions_given"], 1)
        self.assertEqual(people[NB]["reactions_received"], 1)
        self.assertEqual(people[NB]["reactions_given"], 1)
        self.assertEqual(st["totals"]["reactions"], 5)
        self.assertEqual(sum(by_kind.values()), 5)
        # the owner and C never wrote, so they are not in senders, but they can top the list
        self.assertEqual(st["reactions"]["top_giver"], {"name": "Me", "count": 2})
        self.assertEqual(st["reactions"]["top_receiver"], {"name": NA, "count": 4})

    def test_most_reacted_order_truncation_and_kinds(self):
        long_text = "\U0001F602" * 200
        m1 = msg(utc(2026, 3, 1, 10), A, "three", guid="M1")
        m2 = msg(utc(2026, 2, 1, 10), B, long_text, guid="M2")
        m3 = msg(utc(2026, 2, 1, 9), C, "\ufffc", guid="M3", cache_has_attachments=1)
        m4 = msg(utc(2026, 1, 1, 9), C, "one", guid="M4")
        m5 = msg(utc(2026, 2, 1, 9), A, "same instant, higher rowid", guid="M5", rowid=50)
        m3["rowid"] = 30
        rows = [m1, m2, m3, m4, m5]
        t = utc(2026, 4, 1)
        for i, who in enumerate((A, B, C)):
            rows.append(tap(t + i, who, 2003 if i else 2000, m1))
        for target in (m2, m3, m5):
            rows += [tap(t + 10, A, 2004, target), tap(t + 11, B, 2001, target)]
        rows.append(tap(t + 20, A, 2000, m4))
        st = run(rows)
        top = st["most_reacted"]
        self.assertEqual([q["sender"] for q in top], [NA, NC, NA])       # 3, then 2 (earliest first)
        self.assertEqual(top[0], {"sender": NA, "reactions": 3, "date": "2026-03-01", "text": "three",
                                  "kinds": {"laugh": 2, "love": 1}})
        self.assertEqual(list(top[0]["kinds"]), ["laugh", "love"])
        self.assertEqual(top[1], {"sender": NC, "reactions": 2, "date": "2026-02-01", "text": "",
                                  "kinds": {"like": 1, "emphasize": 1}, "attachment": True})
        self.assertEqual(list(top[1]["kinds"]), ["like", "emphasize"])
        self.assertEqual(top[2]["text"], "same instant, higher rowid")
        rows.remove(m3)
        rows.remove(m5)
        top = run(rows)["most_reacted"]
        self.assertEqual(top[1]["text"], "\U0001F602" * 180 + "\u2026")    # characters, not UTF-16 units
        self.assertEqual(len(top), 3)


class Calendar(unittest.TestCase):
    def test_days_streaks_and_busiest_day(self):
        days = [(1, 1), (1, 2), (1, 3), (1, 5), (2, 27), (2, 28), (3, 1), (3, 2), (3, 3), (6, 9)]
        rows = []
        for month, day in days:
            rows += [msg(utc(2026, month, day, 12), A)] * (2 if (month, day) in ((1, 2), (3, 3)) else 1)
        st = run(rows)
        self.assertEqual(st["totals"]["days_active"], 10)
        self.assertEqual(st["totals"]["longest_streak"], 5)          # Feb 27 to Mar 3
        self.assertEqual(st["busiest_day"], {"date": "2026-01-02", "messages": 2})   # earliest tie
        self.assertEqual(st["by_month"], [5, 2, 4, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        self.assertEqual(sum(st["by_weekday"]), 12)

    def test_leap_day_and_year_boundary_streak(self):
        rows = [msg(utc(2024, 2, 28, 12), A), msg(utc(2024, 2, 29, 12), A), msg(utc(2024, 3, 1, 12), A),
                msg(utc(2024, 12, 31, 12), A), msg(utc(2025, 1, 1, 12), A)]
        self.assertEqual(run(rows, year=2024)["totals"]["longest_streak"], 3)
        self.assertEqual(run(rows, all_time=True)["totals"]["longest_streak"], 3)
        self.assertEqual(run(rows, year=2024)["by_weekday"], [0, 1, 1, 1, 1, 0, 0])

    def test_late_night(self):
        rows = [msg(utc(2026, 5, 5, h), who) for h, who in
                ((0, A), (4, A), (4, B), (5, B), (23, B), (3, "me"))]
        rows.append(msg(utc(2026, 5, 5, 4, 59, 59), B))
        st = run(rows)
        self.assertEqual(st["late_night"], {"messages": 5, "share": 0.7143,
                                            "top": {"name": NB, "messages": 2}})   # tie: more messages
        people = {s["name"]: s["late_night"] for s in st["senders"]}
        self.assertEqual(people, {NA: 2, NB: 2, "Me": 1})

    def test_empty_chat(self):
        st = run([])
        self.assertEqual(st["totals"], {"messages": 0, "words": 0, "attachments": 0, "reactions": 0,
                                        "days_active": 0, "longest_streak": 0})
        self.assertIsNone(st["busiest_day"])
        self.assertEqual(st["late_night"], {"messages": 0, "share": 0, "top": None})
        self.assertEqual(st["senders"], [])
        self.assertEqual(st["most_reacted"], [])
        self.assertEqual(st["awards"], [])
        self.assertEqual(st["reactions"]["top_giver"], None)
        self.assertEqual(st["personality"]["id"], "quiet_ones")
        self.assertEqual(st["chat"], {"name": "Unnamed group", "members": 1})
        self.assertEqual(st["by_hour"], [0] * 24)

    def test_output_shape_and_key_order(self):
        st = run([msg(utc(2026, 5, 5, 10), A)], source="sms.db")
        self.assertEqual(list(st), ["v", "chat", "period", "totals", "by_hour", "by_weekday",
                                    "by_month", "busiest_day", "personality", "late_night",
                                    "senders", "most_reacted", "reactions", "awards", "meta"])
        self.assertEqual(st["v"], 1)
        self.assertEqual(st["meta"], {"generator": "wrapped/1", "source": "sms.db",
                                      "generated": "2026-11-11"})
        self.assertEqual(list(st["reactions"]["by_kind"]),
                         ["love", "like", "dislike", "laugh", "emphasize", "question", "emoji"])
        self.assertEqual(list(st["senders"][0]), ["name", "messages", "share", "words",
                                                  "attachments", "late_night", "reactions_given",
                                                  "reactions_received"])

    def test_rows_may_be_any_iterable_and_are_not_modified(self):
        rows = [msg(utc(2026, 5, 5, 10), A, guid="G")]
        frozen = [dict(r) for r in rows]
        a = run(iter(rows))
        b = run(tuple(rows))
        self.assertEqual(a, b)
        self.assertEqual(rows, frozen)


class Masking(unittest.TestCase):
    """A number or address with no contact name never goes into a recap in full."""

    def test_mask_handle(self):
        # tests/python/test_names.py has the full table (tests/conformance/names.json)
        cases = {
            "+15550100001": "\u20260001", "(555) 010-0001": "\u20260001",
            "ines.calloway@example.com": "ines.calloway",
            "Maya": "Maya", "Agent 47": "Agent 47", "22000": "22000", "Maya @ work": "Maya @ work",
        }
        for handle, shown in cases.items():
            self.assertEqual(S.mask_handle(handle), shown, handle)

    def test_no_raw_number_or_address_anywhere_in_the_stats(self):
        t = utc(2026, 5, 5, 3)
        handles = ["+15550100001", "+15550100002", "ines.calloway@example.com"]
        rows = []
        for i, h in enumerate(handles * 4):
            rows.append(msg(t + i, h, "hello there", guid="G%d" % i))
        rows += [tap(t + 100 + i, h, 2003, rows[0]) for i, h in enumerate(handles)]
        st = run(rows, participants=handles + ["+15550100009"], chat_name="")
        text = json.dumps(st, ensure_ascii=False)
        for secret in ("5550100001", "5550100002", "5550100009", "@example.com"):
            self.assertNotIn(secret, text)
        self.assertEqual(sorted(s["name"] for s in st["senders"]),
                         sorted(["\u20260001", "\u20260002", "ines.calloway"]))
        # a contact name always wins over the mask
        named = run(rows, contacts={"+15550100001": "Ines Calloway"})
        self.assertIn("Ines Calloway", [s["name"] for s in named["senders"]])

    def test_names_from_an_import_are_kept(self):
        t = utc(2026, 5, 5, 12)
        st = run([msg(t, "Maya"), msg(t + 1, "Dev"), msg(t + 2, "Maya")])
        self.assertEqual([s["name"] for s in st["senders"]], ["Maya", "Dev"])


if __name__ == "__main__":
    unittest.main()
