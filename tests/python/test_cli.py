"""Smoke tests for ``python -m wrapped`` and the small public API."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

import support
from support import LA

import wrapped
from wrapped import cli

with open(os.path.join(support.ROOT, "tests", "conformance", "expected_tiny.json"),
          encoding="utf-8") as handle:
    EXPECTED = json.load(handle)
TINY = EXPECTED["cases"][0]["stats"]


def run(*args, stdin=None):
    """Run the CLI in a subprocess. Returns (status, stdout, stderr)."""
    env = dict(os.environ, PYTHONPATH=support.ROOT, PYTHONIOENCODING="utf-8", TZ=LA)
    proc = subprocess.run([sys.executable, "-m", "wrapped"] + list(args), input=stdin,
                          capture_output=True, text=True, encoding="utf-8", env=env,
                          cwd=tempfile.gettempdir())
    return proc.returncode, proc.stdout, proc.stderr


def source_args():
    return ["--db", support.path("chat_db"), "--contacts", support.path("address_book_dir")]


class CommandLine(unittest.TestCase):
    def test_help_uses_the_product_name(self):
        status, out, _err = run("--help")
        self.assertEqual(status, 0)
        self.assertIn("Threadback", out)
        self.assertNotIn("iMessage Wrapped", out)
        for command in ("chats", "stats", "link"):
            self.assertIn(command, out)
        status, out, _err = run("--version")
        self.assertEqual(status, 0)
        self.assertIn("Threadback", out)
        status, out, _err = run()
        self.assertEqual(status, 0)
        self.assertIn("usage: wrapped", out)

    def test_chats(self):
        status, out, err = run("chats", *source_args())
        self.assertEqual((status, err), (0, ""))
        lines = out.splitlines()
        self.assertRegex(lines[0], r"^chat\.db: 7,\d\d\d messages in 7 chats \(4 group chats\), "
                                   r"2025-\d\d-\d\d to \d{4}-\d\d-\d\d$")
        self.assertIn("Taco Tuesday Crew \U0001F32E", out)
        self.assertIn("Bram, Sam, \u20260007 & 1 more", out)
        self.assertIn("Book Club \U0001F4DA", out)
        self.assertNotIn("+15550100001", out)             # 1:1 chats are not listed

    def test_chats_json_and_backup(self):
        status, out, err = run("chats", "--backup", support.path("backup"), "--json")
        self.assertEqual((status, err), (0, ""))
        data = json.loads(out)
        self.assertEqual(data["source"], "sms.db")
        self.assertEqual(len(data["chats"]), 4)
        self.assertEqual(data["diagnostics"]["group_chats"], 4)
        self.assertEqual(data["chats"][3]["name"], "Book Club \U0001F4DA")
        self.assertEqual(data["chats"][0]["members"], 7)   # names came from the backup

    def test_stats_matches_the_hand_computed_tiny_chat(self):
        # --year 2026 while "today" is later: the whole year is in range, and
        # the fixture has one message after the pinned test clock (Nov 20)
        status, out, err = run("stats", "Book Club", "--start", "2026-01-01", "--end", "2026-11-11",
                               "--tz", LA, *source_args())
        self.assertEqual((status, err), (0, ""))
        got = json.loads(out)
        expected = json.loads(json.dumps(TINY))
        expected["period"]["label"] = "2026-01-01 \u2013 2026-11-11"
        got["meta"]["generated"] = expected["meta"]["generated"]
        # tapbacks are bounded by the period end exactly like messages
        self.assertEqual(got, expected)

    def test_stats_options(self):
        with tempfile.TemporaryDirectory() as folder:
            target = os.path.join(folder, "out.json")
            status, out, err = run("stats", "3", "--all-time", "--me", "Avery", "--tz", "UTC",
                                   "--no-contacts", "--db", support.path("chat_db"),
                                   "-o", target, "--compact")
            self.assertEqual((status, out), (0, ""))
            self.assertIn("Threadback: wrote", err)
            with open(target, encoding="utf-8") as handle:
                text = handle.read()
            self.assertEqual(text.count("\n"), 1)
            got = json.loads(text)
        self.assertEqual(got["period"]["label"], "All time")
        self.assertEqual(got["period"]["start"], "2025-12-21")       # B1 in UTC
        self.assertIn("Avery", [s["name"] for s in got["senders"]])
        self.assertIn("\u20260011", [s["name"] for s in got["senders"]])
        status, out, _err = run("stats", "Book Club", "--year", "2025", "--tz", LA, *source_args())
        self.assertEqual(json.loads(out)["totals"]["messages"], 2)
        status, out, _err = run("stats", "Old Friends", "--year", "2016", "--tz", "UTC",
                                "--no-contacts", "--db", support.path("legacy_db"))
        self.assertEqual(json.loads(out)["totals"]["messages"], 4)

    def test_link(self):
        status, out, err = run("link", "Book Club", "--year", "2025", "--tz", LA, *source_args())
        self.assertEqual((status, err), (0, ""))
        url = out.strip()
        self.assertTrue(url.startswith("https://averyhsu.github.io/imessage-wrap/#w1="))
        stats = wrapped.stats_from_url(url)
        self.assertEqual(stats["totals"]["messages"], 2)
        self.assertEqual(stats["chat"]["name"], "Book Club \U0001F4DA")

    def test_link_from_a_stats_file_with_and_without_quotes(self):
        with tempfile.TemporaryDirectory() as folder:
            target = os.path.join(folder, "tiny.json")
            with open(target, "w", encoding="utf-8") as handle:
                json.dump(TINY, handle)
            status, out, err = run("link", "--stats", target)
            self.assertEqual((status, err), (0, ""))
            self.assertEqual(wrapped.stats_from_url(out.strip()), TINY)
            status, out, err = run("link", "--stats", target, "--no-quotes")
            quiet = wrapped.stats_from_url(out.strip())
            self.assertEqual([q["text"] for q in quiet["most_reacted"]], ["", "", ""])
            self.assertEqual(quiet["totals"], TINY["totals"])
            status, out, err = run("link", "--stats", "-", stdin=json.dumps(TINY))
            self.assertEqual(wrapped.stats_from_url(out.strip()), TINY)

    def test_link_over_budget_is_trimmed_and_says_so(self):
        status, out, err = run("link", "Extremely", "--year", "2026", "--tz", LA, *source_args())
        self.assertEqual(status, 0)
        url = out.strip()
        self.assertLessEqual(len(url), 4800)
        self.assertIn("shortened", err)
        stats = wrapped.stats_from_url(url)
        self.assertTrue(all("detail" not in a for a in stats["awards"]))

    def test_errors_are_friendly(self):
        cases = [
            (["stats", "nothing like this", *source_args()], "No group chat matches"),
            (["stats", "o", *source_args()], "Use the id instead"),
            (["stats", "Book Club", "--tz", "Mars/Olympus", *source_args()], "unknown time zone"),
            (["stats", "Book Club", "--year", "2026", "--all-time", *source_args()], "choose one"),
            (["stats", "Book Club", "--start", "2026-13-01", *source_args()], "not a real calendar date"),
            (["stats", "Book Club", "--start", "1/2/2026", *source_args()], "YYYY-MM-DD"),
            (["chats", "--db", os.path.join(support.fixture()[0], "nope.db")], "no database at"),
            (["chats", "--backup", support.path("backup_encrypted")], "ENCRYPTED iPhone backup"),
            (["chats", "--db", support.path("backup_address_book")], "not a Messages database"),
            (["link"], "which chat?"),
        ]
        for args, phrase in cases:
            status, out, err = run(*args)
            self.assertEqual(status, 1, args)
            self.assertEqual(out, "", args)
            self.assertIn(phrase.lower(), err.lower(), args)
            self.assertTrue(err.startswith("Threadback: "), err)
            self.assertNotIn("Traceback", err)
        status, _out, err = run("stats")
        self.assertEqual(status, 2)

    def test_parser(self):
        parser = cli.build_parser()
        args = parser.parse_args(["stats", "Book Club", "--year", "2026"])
        self.assertEqual((args.chat, args.year, args.me, args.backup), ("Book Club", 2026, "Me", None))
        self.assertTrue(callable(args.func))
        args = parser.parse_args(["chats", "--backup"])
        self.assertEqual(args.backup, "")


class PublicApi(unittest.TestCase):
    def test_exports(self):
        for name in wrapped.__all__:
            self.assertTrue(hasattr(wrapped, name), name)
        self.assertEqual(wrapped.PRODUCT_NAME, "Threadback")
        self.assertEqual(wrapped.GENERATOR, "wrapped/1")

    def test_decode_text(self):
        body = support.build_fixture.archive_attributed_string("\ufffc  /wrapped 2026 ")
        self.assertEqual(wrapped.decode_text(None, body), "/wrapped 2026")
        self.assertEqual(wrapped.decode_text("", body), "/wrapped 2026")
        self.assertEqual(wrapped.decode_text(None, body, clean=False), "\ufffc  /wrapped 2026 ")
        self.assertEqual(wrapped.decode_text("  plain text\n", body), "plain text")
        self.assertEqual(wrapped.decode_text(None, None), "")
        self.assertEqual(wrapped.decode_text(None, b"junk"), "")
        self.assertEqual(wrapped.decode_text(None, memoryview(body)), "/wrapped 2026")

    def test_build_link(self):
        url = wrapped.build_link(TINY)
        self.assertEqual(wrapped.stats_from_url(url), TINY)
        quiet = wrapped.stats_from_url(wrapped.build_link(TINY, quotes=False))
        self.assertEqual([q["text"] for q in quiet["most_reacted"]], ["", "", ""])
        self.assertEqual(TINY["most_reacted"][0]["text"], "Just under the wire")
        with self.assertRaises(wrapped.LinkTooLongError):
            wrapped.build_link(TINY, max_length=200)

    def test_list_chats_and_stats_from_rows(self):
        chats = wrapped.list_chats(db=support.path("chat_db"), contacts=False)
        self.assertEqual(len(chats), 4)
        self.assertEqual(chats[2]["name"], "\u20260002, \u20260003, \u20260007 & 1 more")
        st = wrapped.stats_from_rows([support.msg(support.NOW - 3600, "+15550100001")],
                                     tz="UTC", now=support.NOW)
        self.assertEqual(st["totals"]["messages"], 1)


if __name__ == "__main__":
    unittest.main()
