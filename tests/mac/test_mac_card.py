import tempfile
import unittest
from pathlib import Path

import mac_support
from mac_support import sample_stats

try:
    from PIL import Image

    from wrapped.mac import card
    from wrapped.mac.card import CardError, FontBook, clusters, render_card

    HAVE_PILLOW = True
except ImportError:  # the card is the only part that needs Pillow
    HAVE_PILLOW = False

SMALL = (540, 675)  # same layout at half size: keeps the matrix fast


class TrackingDict(dict):
    """A stats dict that remembers which top-level keys were read."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.read = set()

    def get(self, key, default=None):
        self.read.add(key)
        return super().get(key, default)

    def __getitem__(self, key):
        self.read.add(key)
        return super().__getitem__(key)


def edge_cases():
    cases = {}
    cases["demo"] = sample_stats()
    cases["long name"] = sample_stats(
        chat_name="The Extremely Long Group Chat Name That Never Ends 🎉🎉🎉 (official)", messages=9311
    )
    s = sample_stats(members=2, messages=7, chat_name="Maya & Dev")
    s["personality"] = {"id": "quiet_ones", "title": "The Quiet Ones", "blurb": "", "peak_hour": 9}
    cases["two members, tiny count"] = s
    s = sample_stats(members=12, messages=1234567, chat_name="Class of 2019 🎓")
    s["personality"] = {"id": "always_on", "title": "The Always-On Group Chat", "blurb": "", "peak_hour": 14}
    cases["twelve members, seven digits"] = s
    cases["forty members"] = sample_stats(members=40, messages=99999)
    s = sample_stats(members=5, messages=880)
    for key in ("awards", "reactions", "most_reacted", "busiest_day", "late_night"):
        s.pop(key, None)
    cases["optional sections missing"] = s
    s = sample_stats(members=4, messages=412)
    s.pop("personality")
    s.pop("by_hour")
    cases["no personality, no hours"] = s
    s = sample_stats(members=3, messages=2400)
    s["senders"] = []
    cases["no senders"] = s
    s = sample_stats(members=6, messages=15230, chat_name="週末ごはん会 🍣")
    s["senders"][0]["name"] = "Bartholomew-Alexander Montgomery"
    s["senders"][1]["name"] = "+1 (415) 555-0134"
    s["senders"][2]["name"] = "Алексей Иванов"
    s["period"]["label"] = "All time"
    cases["unicode names"] = s
    cases["emoji-only name"] = sample_stats(members=4, messages=3021, chat_name="👨‍👩‍👧‍👦🏳️‍🌈🇯🇵👍🏽")
    cases["one message"] = sample_stats(members=3, messages=1, chat_name="x")
    cases["zero messages"] = sample_stats(members=3, messages=0)
    cases["empty name"] = sample_stats(chat_name="")
    cases["whitespace and newlines in name"] = sample_stats(chat_name="  Dinner\n\tClub  ")
    cases["right-to-left name"] = sample_stats(chat_name="ארוחת ערב مرحبا")
    s = sample_stats()
    s["personality"]["title"] = "The Longest Personality Title Anyone Could Possibly Come Up With Here"
    cases["very long personality"] = s
    s = sample_stats()
    s["senders"][0]["share"] = 0.97
    s["senders"][1]["share"] = 0.02
    s["senders"][2]["share"] = 0.0001
    cases["skewed shares"] = s
    s = sample_stats()
    s["totals"]["messages"] = "not a number"
    s["chat"]["members"] = None
    s["senders"][0]["share"] = "x"
    s["by_hour"] = [1, 2, 3]
    cases["junk values"] = s
    cases["bare minimum"] = {"v": 1}
    legacy = sample_stats()
    legacy["messages_by_hour"] = {str(i): v for i, v in enumerate(legacy.pop("by_hour"))}
    cases["legacy hour keys"] = legacy
    return cases


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
class CardRender(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_size_is_exactly_1080_by_1350(self):
        out = render_card(sample_stats(), self.dir / "card.png")
        self.assertEqual(out, self.dir / "card.png")
        with Image.open(out) as im:
            self.assertEqual(im.size, (1080, 1350))
            self.assertEqual(im.format, "PNG")
            self.assertEqual(im.mode, "RGB")
            # a real picture, not a flat fill
            self.assertGreater(len(im.resize((64, 80)).getcolors(maxcolors=64 * 80)), 500)
        self.assertLess(out.stat().st_size, 3_000_000)

    def test_other_sizes(self):
        for size in [(540, 675), (1080, 1920), (1200, 1200)]:
            with self.subTest(size=size):
                out = render_card(sample_stats(), self.dir / f"c-{size[0]}x{size[1]}.png", size=size)
                with Image.open(out) as im:
                    self.assertEqual(im.size, size)
        with self.assertRaises(CardError):
            render_card(sample_stats(), self.dir / "tiny.png", size=(10, 10))

    def test_edge_case_matrix_renders_without_error(self):
        for name, stats in edge_cases().items():
            with self.subTest(case=name):
                out = render_card(stats, self.dir / "m.png", size=SMALL)
                with Image.open(out) as im:
                    self.assertEqual(im.size, SMALL)

    def test_edge_case_matrix_without_an_emoji_font(self):
        for name in ("demo", "emoji-only name", "unicode names", "long name"):
            with self.subTest(case=name):
                out = render_card(edge_cases()[name], self.dir / "n.png", size=SMALL, emoji=False)
                self.assertTrue(out.is_file())

    def test_same_input_gives_identical_bytes(self):
        a = render_card(sample_stats(), self.dir / "a.png", size=SMALL).read_bytes()
        b = render_card(sample_stats(), self.dir / "b.png", size=SMALL).read_bytes()
        self.assertEqual(a, b)
        c = render_card(sample_stats(messages=48214), self.dir / "c.png", size=SMALL).read_bytes()
        self.assertNotEqual(a, c)

    def test_message_text_is_never_read(self):
        stats = TrackingDict(sample_stats())
        render_card(stats, self.dir / "t.png", size=SMALL)
        self.assertIn("totals", stats.read)
        self.assertIn("senders", stats.read)
        for forbidden in ("most_reacted", "awards", "reactions", "late_night"):
            self.assertNotIn(forbidden, stats.read)

    def test_only_first_names_reach_the_card(self):
        stats = sample_stats(members=3, messages=300)
        stats["senders"][0]["name"] = "Maya Okafor-Lindqvist"
        stats["senders"][1]["name"] = "+1 (415) 555-0134"
        stats["senders"][2]["name"] = "priya.invented@example.invalid"
        self.assertEqual([n for n, _s, _m in card._top_senders(stats)], ["Maya", "…0134", "priya.invented"])

    def test_a_huge_unbroken_chat_name_cannot_stall_the_renderer(self):
        import time

        # anyone in a chat can rename it, so this is attacker-controlled input
        started = time.perf_counter()
        render_card(sample_stats(), self.dir / "base.png", size=SMALL)
        baseline = time.perf_counter() - started
        names = {f"{n} letters": "W" * n for n in (120, 500, 100_000)}
        names["60 identical emoji"] = "😀" * 60
        names["60 different emoji"] = "".join(chr(0x1F600 + i) for i in range(60))
        names["100,000 emoji"] = "🍝" * 100_000
        for label, name in names.items():
            with self.subTest(name=label):
                started = time.perf_counter()
                out = render_card(sample_stats(chat_name=name), self.dir / "long.png", size=SMALL)
                took = time.perf_counter() - started
                self.assertLess(took, baseline + 1.0, f"{label} took {took:.2f}s (plain card {baseline:.2f}s)")
                self.assertTrue(out.is_file())
        hostile = sample_stats(chat_name=("😀" + chr(0x200D)) * 50_000)
        hostile["personality"]["title"] = "T" * 200_000
        hostile["period"]["label"] = "9" * 200_000
        hostile["senders"][0]["name"] = "N" * 200_000
        started = time.perf_counter()
        render_card(hostile, self.dir / "hostile.png", size=SMALL)
        self.assertLess(time.perf_counter() - started, baseline + 1.5)

    def test_palette_matches_the_web_card(self):
        out = render_card(sample_stats(), self.dir / "card.png")
        with Image.open(out) as im:
            def near(point, colour, tolerance=12):
                got = im.getpixel(point)
                self.assertTrue(all(abs(a - b) <= tolerance for a, b in zip(got, colour)), (point, got, colour))

            near((640, 600), (255, 255, 255))  # the count sits in a white bubble
            near((420, 1180), (48, 209, 88))  # top senders: system green
            near((840, 1010), (255, 214, 10))  # peak hour: system yellow
            near((700, 720), (11, 11, 15))  # personality: ink
            r, g, b = im.getpixel((1040, 760))  # the blue world behind them
            self.assertGreater(b, 200)
            self.assertLess(r, 60)

    def test_creates_parent_folders_and_rejects_non_dicts(self):
        out = render_card(sample_stats(), self.dir / "deep" / "er" / "card.png", size=SMALL)
        self.assertTrue(out.is_file())
        with self.assertRaises(CardError):
            render_card([], self.dir / "x.png")


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
class FontsAndText(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.book = FontBook()
        cls.plain = FontBook(emoji=False)

    def test_bundled_fonts_and_licence_ship_with_the_package(self):
        for name in list(card.FONT_FILES.values()) + [card.BUNDLED_FALLBACK]:
            self.assertTrue((card.FONT_DIR / name).is_file(), name)
        for family in ("Archivo", "Inter"):
            licence = (card.FONT_DIR / f"OFL-{family}.txt").read_text(encoding="utf-8")
            self.assertIn("SIL Open Font License", licence)
            self.assertIn(family, licence)
        shipped = {p.name for p in card.FONT_DIR.iterdir()}
        self.assertEqual(shipped, set(card.FONT_FILES.values()) | {card.BUNDLED_FALLBACK, "OFL-Archivo.txt", "OFL-Inter.txt"})

    def test_cmap_reader(self):
        ranges = card._cmap_ranges(str(card.FONT_DIR / card.FONT_FILES["black"]))
        self.assertGreater(len(ranges), 50)
        for ch in "Az09é·…&%,":
            self.assertTrue(card._covers(ranges, ord(ch)), ch)
        for cp in (0x416, 0x9031, 0x1F35D, 0x5D0):
            self.assertFalse(card._covers(ranges, cp), hex(cp))
        # Cyrillic and Greek come from the bundled fallback, so they never depend on the machine
        bundled = str(card.FONT_DIR / card.BUNDLED_FALLBACK)
        self.assertEqual(self.plain.fallback_for(0x416), bundled)
        self.assertEqual(self.plain.fallback_for(0x3BB), bundled)
        self.assertEqual(card._cmap_ranges("/nonexistent/font.ttf"), [])
        self.assertEqual(card._cmap_ranges(__file__), [])  # not a font: no crash

    def test_missing_font_folder_is_a_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(CardError) as ctx:
                FontBook(font_dir=Path(tmp))
            self.assertIn("font", str(ctx.exception).lower())

    def test_emoji_are_dropped_cleanly_without_an_emoji_font(self):
        text = "".join(c[1] for c in clusters("Dinner Club 🍝", self.plain))
        self.assertEqual(text, "Dinner Club")
        text = "".join(c[1] for c in clusters("🎉 Party 🎉 time", self.plain))
        self.assertEqual(text, "Party time")
        self.assertEqual(clusters("🍕🍕🍕", self.plain), [])

    def test_emoji_sequences_stay_together_when_a_font_exists(self):
        if not self.book.emoji_path:
            self.skipTest("no colour emoji font on this machine")
        family = "👨‍👩‍👧‍👦"
        cl = clusters("a" + family + "🇯🇵" + "👍🏽" + "b", self.book)
        kinds = [k for k, _t, _p in cl]
        self.assertEqual(kinds, ["text", "emoji", "emoji", "emoji", "text"])
        if self.book.shaping:
            self.assertEqual(cl[1][1], family)

    def test_bundled_faces_always_use_the_basic_layout_engine(self):
        # so Latin text is set identically with or without the optional shaping library
        from PIL import ImageFont

        for role in card.FONT_FILES:
            self.assertEqual(self.book.face(role, 40).layout_engine, ImageFont.Layout.BASIC, role)

    def test_without_a_shaping_engine_sequences_are_simplified_not_garbled(self):
        book = FontBook()
        if not book.emoji_path:
            self.skipTest("no colour emoji font on this machine")
        book.shaping = False
        thumbs = chr(0x1F44D) + chr(0x1F3FD)  # thumbs up + skin tone
        family = chr(0x1F468) + chr(0x200D) + chr(0x1F469) + chr(0x200D) + chr(0x1F467)
        heart = chr(0x2764) + chr(0xFE0F)
        self.assertEqual(clusters(thumbs, book), [("emoji", chr(0x1F44D), None)])
        self.assertEqual(clusters(family, book), [("emoji", chr(0x1F468) + chr(0x1F469) + chr(0x1F467), None)])
        self.assertEqual(clusters(heart, book), [("emoji", chr(0x2764), None)])

    def test_right_to_left_runs_are_put_in_visual_order_without_a_shaping_engine(self):
        book = FontBook(emoji=False)
        book.shaping = False
        alef, bet, gimel = chr(0x5D0), chr(0x5D1), chr(0x5D2)
        if book.fallback_for(0x5D0) is None:
            self.skipTest("no font with Hebrew on this machine")
        text = "".join(c[1] for c in clusters("ab " + alef + bet + " " + gimel + " cd", book))
        self.assertEqual(text, "ab " + gimel + " " + bet + alef + " cd")
        self.assertEqual("".join(c[1] for c in clusters("plain", book)), "plain")

    def test_control_characters_and_lone_joiners_are_dropped(self):
        cl = clusters("a\x00b" + chr(0x200D) + chr(0xFE0F) + "c", self.plain)
        self.assertEqual("".join(c[1] for c in cl), "abc")

    def test_fit_shrinks_then_truncates_with_an_ellipsis(self):
        canvas = card.Canvas(400, 400, 1.0, self.plain)
        cl, size = canvas.fit("Short", "black", 40, 300)
        self.assertEqual(size, 40)
        self.assertEqual("".join(c[1] for c in cl), "Short")
        cl, size = canvas.fit("A considerably longer piece of text than fits", "black", 40, 300, 30)
        self.assertEqual(size, 30)
        text = "".join(c[1] for c in cl)
        self.assertTrue(text.endswith("…"))
        self.assertLessEqual(canvas.measure(cl, "black", size), 300)
        self.assertTrue(text.startswith("A cons"))

    def test_bubble_tail_sticks_out_at_the_bottom_only(self):
        canvas = card.Canvas(800, 800, 1.0, self.plain)
        mask, pad = canvas.bubble_mask(300, 200, 60, "right")
        self.assertGreater(pad, 4)
        width, height = mask.size
        right_of_body = [(x, y) for x in range(pad + 300, width) for y in range(height) if mask.getpixel((x, y)) > 128]
        self.assertTrue(right_of_body)
        self.assertTrue(all(y > height - 60 for _x, y in right_of_body))
        plain, _ = canvas.bubble_mask(300, 200, 60, None)
        self.assertFalse(any(plain.getpixel((x, y)) for x in range(pad + 300, plain.size[0]) for y in range(height)))
        left, _ = canvas.bubble_mask(300, 200, 60, "left")
        self.assertTrue(any(left.getpixel((x, height - 2)) > 128 for x in range(0, pad)))

    def test_title_fitting(self):
        canvas = card.Canvas(2160, 2700, 2.0, self.plain)
        size, role, lines = card._fit_title(canvas, "Dinner Club", 936)
        self.assertEqual((size, role, len(lines)), (116.0, "wide", 1))
        size, role, lines = card._fit_title(canvas, "The Extremely Long Group Chat Name That Never Ends (official)", 936)
        self.assertEqual(len(lines), 2)
        self.assertGreaterEqual(size, 56)
        for line in lines:
            self.assertLessEqual(canvas.measure(line, role, size), 936)
        size, role, lines = card._fit_title(canvas, "word " * 60, 936)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[1][-1][1], "…")
        self.assertLessEqual(canvas.measure(lines[1], role, size), 936)
        self.assertEqual(len(card._fit_title(canvas, "", 936)[2]), 1)  # an empty name still draws something

    def test_fitting_is_bounded_whatever_it_is_given(self):
        import time

        canvas = card.Canvas(2160, 2700, 2.0, self.plain)
        started = time.perf_counter()
        size, role, lines = card._fit_title(canvas, "W" * 100_000, 936)
        cl, fitted = canvas.fit("W" * 100_000, "black", 60, 500, 40)
        wrapped = canvas.wrap(clusters("W" * 100_000, self.plain), "black", 60, 500)
        took = time.perf_counter() - started
        self.assertLess(took, 0.5, f"fitting took {took:.2f}s")
        self.assertEqual(len(lines), 2)
        for line in lines:
            self.assertLessEqual(canvas.measure(line, role, size), 936)
        self.assertLessEqual(canvas.measure(cl, "black", fitted), 500)
        self.assertLessEqual(len(clusters("W" * 100_000, self.plain)), 200)
        self.assertLessEqual(len(wrapped), 60)

    def test_fit_roles_prefers_the_wider_cut(self):
        canvas = card.Canvas(2160, 2700, 2.0, self.plain)
        _cl, role, size = canvas.fit_roles("880", ("black", "cond"), 218, 780, 90)
        self.assertEqual((role, size), ("black", 218))
        _cl, role, size = canvas.fit_roles("1,234,567", ("black", "cond"), 218, 780, 90)
        self.assertEqual(role, "cond")
        cl, role, size = canvas.fit_roles("123,456,789,012", ("black", "cond"), 218, 780, 90)
        self.assertLess(size, 218)
        self.assertLessEqual(canvas.measure(cl, role, size), 780)

    def test_test_image_renders(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = card.render_test_image(Path(tmp) / "t.png")
            with Image.open(out) as im:
                self.assertEqual(im.size, (720, 480))


if __name__ == "__main__":
    unittest.main()
