"""Personality table (section 3) and award selection (section 4)."""

import calendar
import unittest

from support import msg, tap

from wrapped import stats as S
from wrapped.stats import compute_stats

NOW = calendar.timegm((2026, 11, 11, 20, 0, 0))
MONDAY = calendar.timegm((2026, 6, 1, 0, 0, 0))       # 2026-06-01 is a Monday


def at(day, hour, n, sender="+15550100001"):
    """n messages on MONDAY + day at the given UTC hour."""
    return [msg(MONDAY + day * 86400 + hour * 3600 + i, sender, "x") for i in range(n)]


def personality(rows):
    return compute_stats(rows, tz="UTC", now=NOW)["personality"]


def spread(per_hour, hours=range(24), day=0):
    rows = []
    for hour in hours:
        rows += at(day, hour, per_hour)
    return rows


class Personality(unittest.TestCase):
    def test_rule_1_quiet(self):
        p = personality(at(0, 23, 49))
        self.assertEqual(p, {"id": "quiet_ones", "title": "The Quiet Ones",
                             "blurb": "Peak hour: 11 PM. Few words. All of them count.",
                             "peak_hour": 23})
        self.assertNotEqual(personality(at(0, 23, 50))["id"], "quiet_ones")

    def test_rule_2_night_share_or_night_peak(self):
        # exactly 12% between midnight and 4:59, peak at noon
        rows = at(0, 3, 12) + at(0, 12, 88)
        self.assertEqual(personality(rows)["id"], "night_owls")
        rows = at(0, 3, 11) + at(0, 12, 89)
        self.assertNotEqual(personality(rows)["id"], "night_owls")
        # peak hour inside 0..4 even though the share is small
        rows = at(0, 4, 6) + spread(5, range(5, 24))
        p = personality(rows)
        self.assertEqual((p["id"], p["peak_hour"]), ("night_owls", 4))
        self.assertEqual(p["blurb"], "Peak hour: 4 AM. Sleep is a suggestion.")

    def test_rule_3_weekend(self):
        weekday = at(0, 12, 58)
        self.assertEqual(personality(weekday + at(5, 12, 21) + at(6, 12, 21))["id"],
                         "weekend_warriors")                     # 42 of 100
        self.assertNotEqual(personality(weekday + at(5, 12, 21) + at(6, 12, 20) + at(1, 12, 1))["id"],
                            "weekend_warriors")                 # 41 of 100

    def test_rule_4_always_on(self):
        rows = spread(10, range(5, 24))                 # 19 hours x 10: peak share 5.3%
        self.assertEqual(personality(rows)["id"], "always_on")
        rows = at(0, 9, 13) + at(0, 12, 187)            # 6.5% is not below 6.5%
        self.assertEqual(personality(at(0, 10, 13) + spread(11, range(5, 22)))["id"],
                         "morning_meeting")

    def test_rules_5_to_10_by_peak_hour(self):
        expected = {
            5: "early_birds", 8: "early_birds", 9: "morning_meeting", 11: "morning_meeting",
            12: "lunch_break", 13: "lunch_break", 14: "afternoon_slackers",
            17: "afternoon_slackers", 18: "dinner_table", 20: "dinner_table",
            21: "after_hours", 23: "after_hours",
        }
        for hour, pid in expected.items():
            p = personality(at(0, hour, 60))
            self.assertEqual((p["id"], p["peak_hour"]), (pid, hour))
            title, line = S.PERSONALITIES[pid]
            self.assertEqual(p["title"], title)
            self.assertTrue(p["blurb"].endswith(". " + line), p["blurb"])

    def test_lowest_hour_wins_a_tie(self):
        p = personality(at(0, 18, 30) + at(0, 9, 30))
        self.assertEqual((p["id"], p["peak_hour"]), ("morning_meeting", 9))

    def test_hour_labels(self):
        labels = {0: "12 AM", 1: "1 AM", 11: "11 AM", 12: "12 PM", 13: "1 PM", 23: "11 PM"}
        for hour, label in labels.items():
            self.assertEqual(S._hour12(hour), label)

    def test_every_personality_is_reachable_and_titled(self):
        self.assertEqual(len(S.PERSONALITIES), 10)
        self.assertEqual(S.PERSONALITIES["always_on"],
                         ("The Always-On Group Chat", "There is no off switch."))
        self.assertEqual(S.PERSONALITIES["lunch_break"][1],
                         "Eating with one hand, typing with the other.")


def people(**counts):
    """counters keyed by name: (messages, words, attachments, late, given, received, laughs)."""
    return {name: list(values) for name, values in counts.items()}


def ids(awards):
    return [(a["id"], a["winner"]) for a in awards]


class Awards(unittest.TestCase):
    def test_needs_three_qualifying_senders(self):
        self.assertEqual(S._awards(people(a=(50, 0, 0, 0, 0, 0, 0), b=(5, 0, 0, 0, 0, 0, 0),
                                          c=(4, 0, 0, 0, 0, 0, 0))), [])
        got = S._awards(people(a=(50, 0, 0, 0, 0, 0, 0), b=(5, 0, 0, 0, 0, 0, 0),
                               c=(5, 0, 0, 0, 0, 0, 0), d=(1, 0, 0, 9, 9, 9, 9)))
        # d does not qualify; the spec sets no minimum for words per message
        self.assertEqual(ids(got), [("yapper", "a"), ("lurker", "b"), ("novelist", "a")])

    def test_all_eight_candidates_and_the_cap_of_six(self):
        got = S._awards(people(
            yap=(900, 900, 0, 0, 0, 0, 0), lurk=(5, 5, 0, 0, 0, 0, 0),
            owl=(100, 100, 0, 40, 0, 0, 0), funny=(100, 100, 0, 0, 0, 30, 30),
            hype=(100, 100, 0, 0, 77, 0, 0), novel=(20, 2000, 0, 0, 0, 0, 0),
            pap=(100, 100, 12, 0, 0, 0, 0), fav=(100, 100, 0, 0, 0, 55, 0)))
        self.assertEqual(ids(got), [("yapper", "yap"), ("lurker", "lurk"), ("night_owl", "owl"),
                                    ("comedian", "funny"), ("hype", "hype"), ("novelist", "novel")])
        self.assertEqual(got[0], {"id": "yapper", "emoji": "\U0001F5E3\ufe0f", "title": "The Yapper",
                                  "winner": "yap", "detail": "900 messages. Nobody asked."})

    def test_details(self):
        got = {a["id"]: a for a in S._awards(people(
            a=(12004, 61200, 3120, 1201, 2100, 1850, 1400), b=(2000, 1, 0, 0, 0, 0, 0),
            c=(1000, 1, 0, 0, 0, 0, 0)))}
        # one person wins everything: only the first award is not deferred
        self.assertEqual(got["yapper"]["detail"], "12,004 messages. Nobody asked.")
        self.assertEqual(got["lurker"]["detail"], "1,000 messages. Reads everything, says little.")
        self.assertEqual(got["night_owl"]["detail"], "1,201 messages after midnight.")
        self.assertEqual(got["comedian"]["detail"], "Made the chat laugh 1,400 times.")
        self.assertEqual(got["hype"]["detail"], "Handed out 2,100 tapbacks.")
        self.assertEqual(got["novelist"]["detail"], "5.1 words per message. A paragraph person.")
        self.assertNotIn("paparazzi", got)                  # the list is full at six
        self.assertEqual([got[k]["emoji"] for k in ("lurker", "night_owl", "comedian", "hype",
                                                    "novelist")],
                         ["\U0001F47B", "\U0001F989", "\U0001F602", "\U0001F4E3", "\U0001F4DA"])

    def test_deferred_awards_fill_the_remaining_slots_in_table_order(self):
        got = S._awards(people(star=(100, 100, 9, 9, 9, 9, 9), b=(50, 50, 0, 0, 0, 0, 0),
                               c=(10, 10, 0, 0, 0, 0, 0)))
        self.assertEqual(ids(got), [("yapper", "star"), ("lurker", "c"), ("night_owl", "star"),
                                    ("comedian", "star"), ("hype", "star"), ("novelist", "star")])
        # a novelist who holds nothing yet is taken before the deferred awards
        got = S._awards(people(star=(100, 100, 9, 9, 9, 9, 9), b=(50, 400, 0, 0, 0, 0, 0),
                               c=(10, 10, 0, 0, 0, 0, 0)))
        self.assertEqual(ids(got), [("yapper", "star"), ("lurker", "c"), ("novelist", "b"),
                                    ("night_owl", "star"), ("comedian", "star"), ("hype", "star")])

    def test_thresholds(self):
        base = dict(b=(50, 50, 0, 0, 0, 0, 0), c=(10, 10, 0, 0, 0, 0, 0))
        got = dict(ids(S._awards(people(a=(19, 500, 2, 2, 2, 2, 2), **base))))
        self.assertEqual(set(got), {"yapper", "lurker", "novelist"})   # b has 20+, a has 2 of each
        self.assertEqual(got["novelist"], "b")
        got = dict(ids(S._awards(people(a=(20, 500, 3, 3, 3, 3, 3), **base))))
        self.assertEqual(set(got), {"yapper", "lurker", "night_owl", "comedian", "hype", "novelist",
                                    "paparazzi", "favorite"} - {"paparazzi", "favorite"})
        self.assertEqual(got["novelist"], "a")

    def test_ties_go_to_more_messages_then_name(self):
        got = dict(ids(S._awards(people(
            zed=(30, 30, 0, 5, 0, 0, 0), amy=(30, 30, 0, 5, 0, 0, 0), bob=(40, 40, 0, 5, 0, 0, 0),
            cat=(8, 8, 0, 0, 0, 0, 0), dan=(8, 8, 0, 0, 0, 0, 0)))))
        self.assertEqual(got["yapper"], "bob")
        self.assertEqual(got["lurker"], "cat")              # fewest, then name
        self.assertEqual(got["night_owl"], "bob")           # 5 each: most messages wins
        got = dict(ids(S._awards(people(
            zed=(30, 30, 0, 5, 0, 0, 0), amy=(30, 30, 0, 5, 0, 0, 0), cat=(8, 8, 0, 0, 0, 0, 0)))))
        self.assertEqual((got["yapper"], got["night_owl"]), ("amy", "amy"))

    def test_novelist_ratio_is_exact_and_rounds_half_up(self):
        base = dict(b=(50, 50, 0, 0, 0, 0, 0), c=(10, 10, 0, 0, 0, 0, 0))
        for words, messages, shown in ((45, 20, "2.3"), (49, 20, "2.5"), (41, 20, "2.1"),
                                       (1, 20, "0.1"), (0, 20, "0.0"), (239, 20, "12.0"),
                                       (25001, 20, "1250.1")):
            got = {a["id"]: a for a in S._awards(people(a=(messages, words, 0, 0, 0, 0, 0), **base))}
            if words >= 20:
                self.assertEqual(got["novelist"]["winner"], "a")
                self.assertEqual(got["novelist"]["detail"],
                                 shown + " words per message. A paragraph person.")
        # 1/3 against 333333/1000000: only exact arithmetic separates them
        got = dict(ids(S._awards(people(a=(3000000, 1000000, 0, 0, 0, 0, 0),
                                        b=(1000000, 333333, 0, 0, 0, 0, 0),
                                        c=(30, 1, 0, 0, 0, 0, 0)))))
        self.assertEqual(got["novelist"], "a")

    def test_awards_from_real_rows(self):
        t = calendar.timegm((2026, 6, 1, 12, 0, 0))
        a, b, c = "+15550100001", "+15550100002", "+15550100003"
        rows = [msg(t + i, a, "word " * 3, guid="A%d" % i) for i in range(30)]
        rows += [msg(t + 100 + i, b, "\ufffc", cache_has_attachments=1) for i in range(6)]
        rows += [msg(t - 12 * 3600 + i, c, "night") for i in range(5)]          # midnight UTC
        rows += [tap(t + 500 + i, b, 2003, rows[i]) for i in range(4)]
        st = compute_stats(rows, tz="UTC", now=NOW)
        self.assertEqual(ids(st["awards"]), [
            ("yapper", a), ("lurker", c), ("hype", b),              # fresh winners first
            ("night_owl", c), ("comedian", a), ("novelist", a)])    # then deferred, in order
        details = {x["id"]: x["detail"] for x in st["awards"]}
        self.assertEqual(details["novelist"], "3.0 words per message. A paragraph person.")
        self.assertEqual(details["hype"], "Handed out 4 tapbacks.")
        self.assertEqual(details["comedian"], "Made the chat laugh 4 times.")
        self.assertEqual(details["night_owl"], "5 messages after midnight.")


if __name__ == "__main__":
    unittest.main()
