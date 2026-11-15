"""Personality (section 3) and awards (section 4).

Most cases live in tests/vectors/personality-awards-v1.json, which the
JavaScript engine's tests run too (tests/engine-js/personality-awards.test.js),
so both engines are held to the same hand-worked answers."""

import calendar
import json
import os
import time
import unittest

import support
from support import msg, ns, tap

from wrapped import stats as S
from wrapped.stats import compute_stats

NOW = calendar.timegm((2026, 11, 11, 20, 0, 0))
MONDAY = calendar.timegm((2026, 6, 1, 0, 0, 0))       # 2026-06-01 is a Monday

with open(os.path.join(support.ROOT, "tests", "vectors", "personality-awards-v1.json"),
          encoding="utf-8") as handle:
    VECTORS = json.load(handle)


def figures(changes):
    f = dict(VECTORS["figures"]["base"])
    f["H"] = list(f["H"])
    for key, value in changes.items():
        if key == "peak":
            f["H"] = [0] * 24
            if value is not None:
                f["H"][value] = 1000
        else:
            f[key] = value
    return f


def people(spec):
    """{name: counters}, padded with zeros to the engine's thirteen."""
    return {name: list(values) + [0] * (S._COUNTERS - len(values)) for name, values in spec.items()}


def triples(awards):
    return [[a["id"], a["winner"], a["detail"]] for a in awards]


def expand(entries):
    """Rows from the vector file's compact form (see its rows.about)."""
    rows = []
    for e in entries:
        start = calendar.timegm(time.strptime(e["at"], "%Y-%m-%dT%H:%M:%S"))
        every = e.get("every", 60)
        made = 0
        for day in e.get("days", [0]):
            base = start + day * 86400
            if "tap" in e:
                for k, target in enumerate(e["on"]):
                    rows.append(msg(base + k * every, e["from"], "Reacted",
                                    associated_message_type=e["tap"],
                                    associated_message_guid="p:0/" + target))
                continue
            for k in range(e.get("count", 1)):
                text = e["text"][k % len(e["text"])] if isinstance(e["text"], list) else e["text"]
                row = msg(base + k * every, e["from"], text)
                row["date"] = ns(base + k * every, e.get("ns", 0))
                if "rowid" in e:
                    row["rowid"] = e["rowid"]
                if e.get("att"):
                    row["cache_has_attachments"] = 1
                if "guid" in e:
                    row["guid"] = "%s%d" % (e["guid"], made)
                made += 1
                rows.append(row)
    return rows


def run_case(case):
    options = dict(tz="UTC", now=NOW, contacts=VECTORS["rows"]["contacts"])
    options.update(case.get("options", {}))
    return compute_stats(expand(case["rows"]), **options)


class Personality(unittest.TestCase):
    def test_figure_vectors(self):
        cases = VECTORS["figures"]["cases"]
        self.assertGreaterEqual(len(cases), 55)
        for case in cases:
            with self.subTest(case["name"]):
                p = S.personality(figures(case["set"]))
                self.assertEqual(p["id"], case["id"])
                emoji, title, line = S.PERSONALITIES[case["id"]]
                self.assertEqual((p["emoji"], p["title"]), (emoji, title))
                if "reason" in case:
                    self.assertEqual(p["reason"], case["reason"])
                self.assertEqual(p["blurb"], p["reason"] + ". " + line)
                self.assertEqual(p["peak_hour"], case.get("peak_hour", case["set"].get("peak", 19)))
                self.assertEqual(list(p), ["id", "emoji", "title", "reason", "blurb", "peak_hour"])

    def test_every_trait_has_a_hit_and_a_miss(self):
        names = [c["name"] for c in VECTORS["figures"]["cases"]]
        for row, trait in enumerate(S._TRAITS, 1):
            hits = [n for n in names if n.startswith("%d %s at the floor" % (row, trait[0]))]
            misses = [n for n in names if n.startswith("%d %s just" % (row, trait[0]))]
            self.assertEqual((len(hits), len(misses)), (1, 1), trait[0])

    def test_by_peak_hour_when_no_trait_stands_out(self):
        labels = VECTORS["figures"]["peak_labels"]
        for hour, pid in VECTORS["figures"]["peak_hours"].items():
            p = S.personality(figures({"peak": int(hour)}))
            self.assertEqual((p["id"], p["peak_hour"]), (pid, int(hour)))
            self.assertTrue(p["reason"].startswith("Peak hour: "), p)
            if hour in labels:
                self.assertEqual(p["reason"], "Peak hour: " + labels[hour])
        for hour, label in labels.items():
            self.assertEqual(S._hour12(int(hour)), label)

    def test_tables(self):
        self.assertEqual([t[0] for t in S._TRAITS], [
            "one_person_show", "dynamic_duo", "round_table", "night_owls", "weekend_warriors",
            "weekday_regulars", "always_on", "daily_ritual", "flash_mob", "seasonal_special",
            "firehose", "slow_burn", "photo_dump", "hype_squad", "comedy_club", "love_fest",
            "essayists", "rapid_fire"])
        self.assertEqual(len(S.PERSONALITIES), 25)
        for pid, (emoji, title, line) in S.PERSONALITIES.items():
            self.assertTrue(emoji and title.startswith("The ") and line.endswith("."), pid)
        self.assertEqual(S.PERSONALITIES["always_on"][1:],
                         ("The Always-On Group Chat", "There is no off switch."))
        self.assertEqual(S.PERSONALITIES["morning_meeting"], ("\u2615", "The Morning Meeting",
                                                              "This could not have been an email."))

    def test_rounding_helpers(self):
        self.assertEqual([S._pct(a, b) for a, b in ((1, 200), (1, 199), (2, 3), (1, 3), (0, 9), (9, 9))],
                         ["1%", "1%", "67%", "33%", "0%", "100%"])
        self.assertEqual([S._tenths(a, b) for a, b in ((57, 4), (1, 20), (1, 21), (855, 60))],
                         ["14.3", "0.1", "0.0", "14.3"])
        self.assertEqual([S._nearest(a, b) for a, b in ((5, 2), (7, 2), (1, 3), (2, 3))], [3, 4, 0, 1])

    def test_figures_from_rows(self):
        def at(day, hour, n, sender, **extra):
            return [msg(MONDAY + day * 86400 + hour * 3600 + i, sender, "one two", **extra)
                    for i in range(n)]
        rows = at(0, 23, 5, "+15550100001") + at(1, 0, 4, "+15550100002") + at(1, 1, 3, "+15550100003")
        rows += at(5, 12, 2, "+15550100004", cache_has_attachments=1)      # a Saturday
        rows += [msg(MONDAY + 38 * 86400 + 3600 + i, "+15550101%03d" % i, "x") for i in range(13)]
        st = compute_stats(rows, tz="UTC", now=NOW, start="2026-06-01", end="2026-07-31")
        f = S.personality_figures(st["totals"], st["by_hour"], st["by_weekday"], st["by_month"], 61,
                                  st["busiest_day"]["messages"], st["reactions"]["by_kind"],
                                  [5, 4, 3, 2] + [1] * 13)
        self.assertEqual(len(st["senders"]), 12)
        self.assertEqual((f["n"], f["top1"], f["top2"], f["low"]), (17, 5, 4, 1))
        self.assertEqual((f["T"], f["night"], f["weekend"], f["best3"]), (27, 20, 2, 25))   # 11 PM to 1 AM
        self.assertEqual((f["month1"], f["month1_index"], f["day1"], f["A"], f["Wd"]), (14, 5, 13, 2, 41))

    def test_the_owners_chat_was_called_night_owls_before(self):
        # the old rule: 12% or more between midnight and 5 AM made any chat the Night Owls
        case = VECTORS["rows"]["cases"][0]
        st = run_case(case)
        self.assertGreaterEqual(st["late_night"]["share"], 0.12)
        self.assertEqual(st["personality"]["peak_hour"], 11)
        self.assertNotEqual(st["personality"]["id"], "night_owls")

    def test_no_name_in_the_reason(self):
        for case in VECTORS["rows"]["cases"]:
            st = run_case(case)
            for person in st["senders"]:
                for word in person["name"].split():
                    self.assertNotIn(word, st["personality"]["reason"], case["name"])


class Awards(unittest.TestCase):
    def test_award_vectors(self):
        for case in VECTORS["awards"]["cases"]:
            with self.subTest(case["name"]):
                self.assertEqual(triples(S._awards(people(case["people"]))), case["expect"])

    def test_needs_three_qualifying_senders(self):
        self.assertEqual(S._awards(people({"a": [50], "b": [5], "c": [4]})), [])
        got = S._awards(people({"a": [50], "b": [5], "c": [5], "d": [1, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]}))
        # d does not qualify; the spec sets no minimum for words per message
        self.assertEqual([a["id"] for a in got], ["yapper", "lurker", "novelist"])

    def test_table(self):
        self.assertEqual([(a[0], a[1], a[2]) for a in S.AWARDS], [
            ("yapper", "\U0001F5E3\ufe0f", "The Yapper"),
            ("comedian", "\U0001F602", "The Comedian"),
            ("night_owl", "\U0001F989", "The Night Owl"),
            ("starter", "\U0001F680", "The Conversation Starter"),
            ("paparazzi", "\U0001F4F8", "The Paparazzi"),
            ("interrogator", "\u2753", "The Interrogator"),
            ("hype", "\U0001F4E3", "The Hype Machine"),
            ("early_bird", "\U0001F426", "The Early Bird"),
            ("closer", "\U0001F3AC", "The Last Word"),
            ("link_dropper", "\U0001F517", "The Link Dropper"),
            ("favorite", "\u2b50", "The Crowd Favorite"),
            ("double_texter", "\U0001F4F2", "The Double Texter"),
            ("novelist", "\U0001F4DA", "The Novelist"),
            ("minimalist", "\u2702\ufe0f", "The Minimalist"),
            ("lurker", "\U0001F47B", "The Lurker"),
        ])

    def test_details_use_thousands(self):
        got = {a["id"]: a for a in S._awards(people({
            "a": [12004, 61200, 3120, 1201, 2100, 1850, 1400, 1500, 1600, 1700, 1800, 1900, 2000],
            "b": [2000, 1], "c": [1000, 1]}))}
        self.assertEqual(got["yapper"]["detail"], "12,004 messages. Nobody asked.")
        self.assertEqual(got["comedian"]["detail"], "Made the chat laugh 1,400 times.")
        self.assertEqual(got["night_owl"]["detail"], "1,201 messages after midnight.")
        self.assertEqual(got["starter"]["detail"], "Sent the first message of the day 1,800 times.")
        self.assertEqual((got["minimalist"]["winner"], got["minimalist"]["detail"]),
                         ("b", "0.0 words per message. Straight to the point."))
        self.assertNotIn("paparazzi", got)                  # the list is full at six
        self.assertEqual(got["lurker"]["detail"], "1,000 messages. Reads everything, says little.")

    def test_novelist_ratio_is_exact_and_rounds_half_up(self):
        for words, messages, shown in ((45, 20, "2.3"), (49, 20, "2.5"), (41, 20, "2.1"),
                                       (239, 20, "12.0"), (25001, 20, "1250.1")):
            got = {a["id"]: a for a in S._awards(people({"a": [messages, words], "b": [50, 50],
                                                         "c": [10, 10]}))}
            self.assertEqual(got["novelist"]["winner"], "a")
            self.assertEqual(got["novelist"]["detail"], shown + " words per message. A paragraph person.")
        got = {a["id"]: a["winner"] for a in S._awards(people({
            "a": [3000000, 1000000], "b": [1000000, 333333], "c": [30, 1]}))}
        self.assertEqual(got["novelist"], "a")              # 1/3 against 333333/1000000
        self.assertEqual(got["minimalist"], "c")


class FromRows(unittest.TestCase):
    def test_row_vectors(self):
        for case in VECTORS["rows"]["cases"]:
            with self.subTest(case["name"]):
                st = run_case(case)
                expect = case["expect"]
                for key, value in expect.get("personality", {}).items():
                    self.assertEqual(st["personality"][key], value, key)
                if "late_share" in expect:
                    self.assertEqual(st["late_night"]["share"], expect["late_share"])
                if "senders" in expect:
                    self.assertEqual(len(st["senders"]), expect["senders"])
                awards = expect.get("awards")
                got = triples(st["awards"])
                if isinstance(awards, list):
                    self.assertEqual(got, awards)
                elif isinstance(awards, dict):
                    ids = [a[0] for a in got]
                    for aid in awards.get("has", []):
                        self.assertIn(aid, ids)
                    for aid in awards.get("lacks", []):
                        self.assertNotIn(aid, ids)
                for aid in ("double_texter",):
                    if aid in expect:
                        self.assertEqual([a[1:] for a in got if a[0] == aid], [expect[aid]])

    def test_tapback_rows_feed_the_comedian(self):
        t = calendar.timegm((2026, 6, 1, 12, 0, 0))
        a, b, c = "+15550100001", "+15550100002", "+15550100003"
        na, nb, nc = "\u20260001", "\u20260002", "\u20260003"      # no contacts: masked
        rows = [msg(t + i, a, "word " * 3, guid="A%d" % i) for i in range(30)]
        rows += [msg(t + 100 + i, b, "\ufffc", cache_has_attachments=1) for i in range(6)]
        rows += [msg(t - 12 * 3600 + i, c, "night") for i in range(5)]          # midnight UTC
        rows += [tap(t + 500 + i, b, 2003, rows[i]) for i in range(4)]
        st = compute_stats(rows, tz="UTC", now=NOW)
        # fresh winners first, then the deferred ones in table order
        self.assertEqual(triples(st["awards"]), [
            ["yapper", na, "30 messages. Nobody asked."],
            ["night_owl", nc, "5 messages after midnight."],
            ["paparazzi", nb, "6 photos, videos and memes."],
            ["comedian", na, "Made the chat laugh 4 times."],
            ["hype", nb, "Handed out 4 tapbacks."],
            ["favorite", na, "4 tapbacks received."]])


if __name__ == "__main__":
    unittest.main()
