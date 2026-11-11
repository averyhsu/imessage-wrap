import unittest

import mac_support  # noqa: F401  (puts the repo root on sys.path)

from wrapped.mac.triggers import Trigger, normalize, parse_trigger, starts_with_trigger

ZWSP = chr(0x200B)
OBJ = chr(0xFFFC)
NBSP = chr(0xA0)
FULLWIDTH_SLASH = chr(0xFF0F)


class TriggerTable(unittest.TestCase):
    ACCEPT = [
        ("/wrapped", Trigger("wrapped", None)),
        ("/recap", Trigger("recap", None)),
        ("/WRAPPED", Trigger("wrapped", None)),
        ("/Wrapped", Trigger("wrapped", None)),
        ("/ReCaP", Trigger("recap", None)),
        ("  /wrapped  ", Trigger("wrapped", None)),
        ("\n/wrapped\n", Trigger("wrapped", None)),
        ("\t/recap\t", Trigger("recap", None)),
        ("/wrapped 2025", Trigger("wrapped", "2025")),
        ("/wrapped   2024", Trigger("wrapped", "2024")),
        ("/recap 2026", Trigger("recap", "2026")),
        ("/wrapped all", Trigger("wrapped", "all")),
        ("/wrapped ALL", Trigger("wrapped", "all")),
        ("/Recap All ", Trigger("recap", "all")),
        ("/wrapped" + OBJ, Trigger("wrapped", None)),  # attachment placeholder left by Messages
        (ZWSP + "/wrapped", Trigger("wrapped", None)),
        ("/wrapped" + NBSP + "2025", Trigger("wrapped", "2025")),
        (NBSP + "/wrapped" + NBSP, Trigger("wrapped", None)),
        (FULLWIDTH_SLASH + "wrapped", Trigger("wrapped", None)),
        ("/wrapped 2007", Trigger("wrapped", "2007")),
    ]
    REJECT = [
        "",
        None,
        " ",
        "wrapped",
        "recap",
        "/wrap",
        "/wrappedd",
        "/wrapped!",
        "/wrapped please",
        "/wrapped 25",
        "/wrapped 20255",
        "/wrapped 2025 2026",
        "/wrapped all time",
        "/wrapped everything",
        "hey /wrapped",
        "type /wrapped to get a recap",
        "/ wrapped",
        "//wrapped",
        "\\wrapped",
        "/wrapped\n/wrapped",
        "/wrapped\nplease",
        "/recaps",
        "/wrapped2025",
        "/wrapped 1999",  # before any Messages database could exist
        "/wrapped 2031",  # the future (current_year below is 2026)
        "/wrapped -2025",
        "Loved “/wrapped”",  # what a tapback row's text looks like
        "https://example.invalid/#w1=abc",
    ]

    def test_accept(self):
        for text, want in self.ACCEPT:
            with self.subTest(text=text):
                self.assertEqual(parse_trigger(text, current_year=2026), want)

    def test_reject(self):
        for text in self.REJECT:
            with self.subTest(text=text):
                self.assertIsNone(parse_trigger(text, current_year=2026))

    def test_year_upper_bound_follows_the_clock(self):
        self.assertIsNone(parse_trigger("/wrapped 2027", current_year=2026))
        self.assertEqual(parse_trigger("/wrapped 2027", current_year=2027), Trigger("wrapped", "2027"))
        # without a clock there is no upper bound, only the lower one
        self.assertEqual(parse_trigger("/wrapped 2099"), Trigger("wrapped", "2099"))

    def test_normalize_strips_invisible_characters(self):
        self.assertEqual(normalize(ZWSP + " /wrapped" + OBJ + " "), "/wrapped")
        self.assertEqual(normalize(None), "")

    def test_starts_with_trigger(self):
        for line in ["/wrapped", "/recap", "/WRAPPED 2025", " /wrapped up nicely", "/recap: here it is", "/ wrapped"]:
            with self.subTest(line=line):
                self.assertTrue(starts_with_trigger(line))
        for line in ["", None, "🧵 /wrapped", "· /wrapped", "type /wrapped", "https://x.invalid/wrapped", "wrapped"]:
            with self.subTest(line=line):
                self.assertFalse(starts_with_trigger(line))


if __name__ == "__main__":
    unittest.main()
