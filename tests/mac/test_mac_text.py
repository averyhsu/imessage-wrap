import unittest

import mac_support
from mac_support import sample_stats

from wrapped.mac import fmt
from wrapped.mac.text import assert_safe, empty_text, recap_lines, recap_text
from wrapped.mac.triggers import parse_trigger, starts_with_trigger


class RecapText(unittest.TestCase):
    def test_demo_recap_shape(self):
        stats = sample_stats()
        lines = recap_lines(stats)
        self.assertGreaterEqual(len(lines), 5)
        self.assertLessEqual(len(lines), 8)
        self.assertIn("Dinner Club 🍝", lines[0])
        self.assertIn("2026 in review", lines[0])
        self.assertIn("48,213 messages", lines[1])
        self.assertTrue(any("The Night Owls" in ln and "11 PM" in ln for ln in lines))
        self.assertTrue(any(ln.startswith("🥇 Maya") for ln in lines))
        # every line is emoji-led, never plain ASCII at the start
        for ln in lines:
            self.assertFalse(ln[0].isascii(), ln)

    def test_no_message_text_and_no_link_in_the_recap(self):
        text = recap_text(sample_stats())
        self.assertNotIn("INVENTED QUOTE", text)
        self.assertNotIn("http", text)

    def test_line_count_bounds_across_shapes(self):
        shapes = [
            sample_stats(members=2, messages=3),
            sample_stats(members=2, messages=40),
            sample_stats(members=12, messages=1234567),
            sample_stats(members=40, messages=900),
        ]
        bare = sample_stats(members=3, messages=10)
        for key in ("awards", "reactions", "most_reacted", "busiest_day", "late_night"):
            bare.pop(key, None)
        bare["totals"]["reactions"] = 0
        shapes.append(bare)
        for stats in shapes:
            with self.subTest(members=stats["chat"]["members"], messages=stats["totals"]["messages"]):
                lines = recap_lines(stats)
                self.assertGreaterEqual(len(lines), 5)
                self.assertLessEqual(len(lines), 8)
                self.assertEqual(len(recap_lines(stats, with_link=False)), len(lines) - 1)

    def test_singular_plural(self):
        stats = sample_stats(members=2, messages=1)
        stats["totals"]["days_active"] = 1
        self.assertIn("1 message · 1 active day", recap_lines(stats)[1])

    def test_no_line_can_be_a_command(self):
        hostile = ["/wrapped", "/recap 2025", " /WRAPPED", "/wrapped\n/wrapped", "/recap\r\n/wrapped all"]
        for name in hostile:
            with self.subTest(name=name):
                stats = sample_stats(chat_name=name)
                stats["senders"][0]["name"] = "/wrapped"
                stats["awards"][0]["winner"] = "/wrapped"
                stats["awards"][0]["title"] = "/wrapped"
                stats["personality"]["title"] = "/wrapped"
                stats["period"]["label"] = "/wrapped"
                for text in (recap_text(stats), empty_text(stats)):
                    assert_safe(text)
                    for line in text.splitlines():
                        self.assertFalse(starts_with_trigger(line), line)
                        self.assertIsNone(parse_trigger(line, current_year=2026), line)
                    self.assertIsNone(parse_trigger(text, current_year=2026))

    def test_assert_safe_rejects_commands(self):
        for bad in ["/wrapped", "hello\n/recap 2025", " /Wrapped"]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    assert_safe(bad)
        assert_safe("https://example.invalid/#w1=abc")
        assert_safe("🧵 fine\n💬 also fine")

    def test_empty_text(self):
        stats = sample_stats(messages=0, label="2019")
        line = empty_text(stats)
        self.assertIn("2019", line)
        self.assertEqual(len(line.splitlines()), 1)

    def test_full_names_and_numbers_become_first_names(self):
        stats = sample_stats(members=3, messages=300)
        stats["senders"][0]["name"] = "Maya Okafor-Lindqvist"
        stats["senders"][1]["name"] = "+1 (415) 555-0134"
        stats["senders"][2]["name"] = "priya.invented@example.invalid"
        text = recap_text(stats)
        self.assertIn("🥇 Maya ", text)
        self.assertNotIn("Okafor", text)
        self.assertNotIn("555", text)
        self.assertIn("…0134", text)  # docs/SCHEMA.md 2, Masking: last four digits
        self.assertNotIn("example.invalid", text)
        self.assertIn("🥉 priya.invented ", text)  # the part before the @


class Formatting(unittest.TestCase):
    def test_numbers(self):
        self.assertEqual(fmt.fmt_int(48213), "48,213")
        self.assertEqual(fmt.fmt_int(None), "0")
        self.assertEqual(fmt.fmt_compact(950), "950")
        self.assertEqual(fmt.fmt_compact(48213), "48.2K")
        self.assertEqual(fmt.fmt_compact(1234567), "1.2M")
        self.assertEqual(fmt.fmt_compact(2000000), "2M")
        self.assertEqual(fmt.fmt_pct(0.2456), "25%")
        self.assertEqual(fmt.fmt_pct(0.004), "<1%")
        self.assertEqual(fmt.fmt_pct(0), "0%")
        self.assertEqual(fmt.fmt_pct(1), "100%")

    def test_hours_and_dates(self):
        self.assertEqual([fmt.hour12(h) for h in (0, 1, 11, 12, 13, 23)], ["12 AM", "1 AM", "11 AM", "12 PM", "1 PM", "11 PM"])
        self.assertEqual(fmt.short_date("2026-07-04"), "Jul 4")
        self.assertEqual(fmt.short_date("nope"), "")

    def test_display_names_disambiguate(self):
        names = fmt.display_names(["Sam Kowalski", "Sam Rivera", "Lena Park"])
        self.assertEqual(names["Sam Kowalski"], "Sam K.")
        self.assertEqual(names["Sam Rivera"], "Sam R.")
        self.assertEqual(names["Lena Park"], "Lena")
        phones = fmt.display_names(["+1 555 010 0134", "+1 555 010 0199", "…0134", "Sam"])
        self.assertEqual(phones["+1 555 010 0134"], "…0134")
        self.assertEqual(phones["+1 555 010 0199"], "…0199")
        self.assertEqual(len(set(phones.values())), 4)  # same last four digits are still told apart
        self.assertEqual(len(set(fmt.display_names(["a@x.invalid", "a@y.invalid", "Al"]).values())), 3)
        self.assertEqual(fmt.first_name("Bartholomew-Alexander Montgomery"), "Bartholomew-Ale…")
        self.assertEqual(fmt.first_name(""), "?")
        self.assertEqual(fmt.first_name("…0134"), "…0134")  # already masked by the engine: left alone

    def test_masking_follows_the_schema(self):
        cases = {
            "Jane Doe <jane.doe@example.invalid>": "jane.doe",
            "mailto:jane@localhost": "jane",
            "a.very.long.local.part.indeed@example.invalid": "a.very.long.loca…",
            "Maya @ work": "Maya @ work",
            "tel:+1 555-010-0123 (mobile)": "…0123",
            "Maya +15550100123": "…0123",
            "+15550100123": "…0123",
            "".join(chr(0xFF10 + int(d)) for d in "5550100123"): "".join(["…"] + [chr(0xFF10 + int(d)) for d in "0123"]),
            "Flat 12, door 3456": "Flat 12, door 3456",  # six digits: not a number
            "Dinner Club": "Dinner Club",
        }
        for label, want in cases.items():
            with self.subTest(label=label):
                self.assertEqual(fmt.mask_label(label), want)

    def test_clean_removes_invisible_and_reordering_characters(self):
        esc, rlo, pdf, zwsp, lrm, bom = chr(0x1B), chr(0x202E), chr(0x202C), chr(0x200B), chr(0x200E), chr(0xFEFF)
        isolate, filler, nul, zwj = chr(0x2066), chr(0x3164), chr(0), chr(0x200D)
        dirty = f"  Din{zwsp}ner{esc}[2J {rlo}Club{pdf}{lrm}{bom}{isolate}{filler}{nul}\r\n\tx  "
        self.assertEqual(fmt.clean(dirty), "Dinner[2J Club x")
        family = chr(0x1F468) + zwj + chr(0x1F469) + zwj + chr(0x1F467)
        self.assertEqual(fmt.clean(family), family)  # joiners inside emoji stay
        self.assertEqual(fmt.clean(None), "")
        self.assertEqual(fmt.clean("abcdef", 4), "abc…")
        self.assertEqual(len(fmt.clean("W" * 5_000_000, 60)), 60)  # and a huge input costs nothing
        for cp in list(range(0x20)) + [0x7F, 0x85, 0x9B, 0x200B, 0x200E, 0x200F, 0x202A, 0x202E, 0x2066, 0x2069,
                                        0x2028, 0x2029, 0xFEFF, 0xFFFC, 0xFFFD, 0x3164, 0x115F, 0xE0041]:
            with self.subTest(cp=hex(cp)):
                self.assertNotIn(chr(cp), fmt.clean("a" + chr(cp) + "b"))

    def test_unnamed_group_names_never_show_a_number_or_address(self):
        name = "Bram, Sam, +15550100007 & 1 more"
        self.assertEqual(fmt.safe_chat_name(name), "Bram, Sam, …0007 & 1 more")
        self.assertEqual(fmt.safe_chat_name("Bram, x.invented@example.invalid"), "Bram, x.invented")
        self.assertEqual(fmt.safe_chat_name("Bram, …0007, …0012 & 2 more"), "Bram, …0007, …0012 & 2 more")
        self.assertEqual(len(fmt.safe_chat_name("W" * 100_000)), 60)
        for untouched in ("Dinner Club 🍝", "Class of 2019", "Flat 12 & friends", "24/7", ""):
            self.assertEqual(fmt.safe_chat_name(untouched), untouched)
        text = recap_text(sample_stats(chat_name=name))
        self.assertNotIn("5550100007", text)
        self.assertIn("Bram, Sam, …0007 & 1 more", text)

    def test_recap_text_never_carries_control_or_reordering_characters(self):
        hostile = "Dinner" + chr(0x1B) + "[31m" + chr(0x202E) + "evil" + chr(0x200B) + "\nFAKE: card=delivered"
        stats = sample_stats(chat_name=hostile)
        stats["senders"][0]["name"] = "Ma" + chr(0x202E) + "ya" + chr(0x200B) + "\n/wrapped"
        stats["awards"][0]["winner"] = stats["senders"][0]["name"]
        stats["personality"]["title"] = "The " + chr(0x2066) + "Night" + chr(0x2069) + " Owls" + chr(0x7F)
        text = recap_text(stats)
        for cp in (0x1B, 0x202E, 0x200B, 0x2066, 0x2069, 0x7F, 0x0D):
            self.assertNotIn(chr(cp), text, hex(cp))
        self.assertLessEqual(len(text.splitlines()), 8)  # the newline did not make an extra line
        self.assertIn("Dinner[31mevil FAKE", text.splitlines()[0])

    def test_peak_hour_fallbacks(self):
        self.assertEqual(fmt.peak_hour({"personality": {"peak_hour": 7}}), 7)
        self.assertEqual(fmt.peak_hour({"by_hour": [0] * 9 + [5] + [0] * 14}), 9)
        legacy = {"messages_by_hour": {str(i): (3 if i == 21 else 1) for i in range(24)}}
        self.assertEqual(fmt.peak_hour(legacy), 21)
        self.assertIsNone(fmt.peak_hour({}))


if __name__ == "__main__":
    unittest.main()
