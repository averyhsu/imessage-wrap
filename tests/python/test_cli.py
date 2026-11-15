"""Smoke tests for ``python -m wrapped`` and the small public API."""

import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

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
        self.assertEqual(len(lines), 1 + 2 + 4 + 2)       # summary, heading, four chats, hint
        self.assertEqual(support.text_leaks(out.replace("\n", " ")), [])

    def test_chats_json_and_backup(self):
        status, out, err = run("chats", "--backup", support.path("backup"), "--json")
        self.assertEqual((status, err), (0, ""))
        data = json.loads(out)
        self.assertEqual(data["source"], "sms.db")
        self.assertEqual(len(data["chats"]), 4)
        self.assertEqual(data["diagnostics"]["group_chats"], 4)
        self.assertEqual(data["chats"][3]["name"], "Book Club \U0001F4DA")
        self.assertEqual(data["chats"][0]["members"], 7)   # names came from the backup
        # the listing for other programs: everything, the members' handle ids included
        self.assertEqual(sorted(data), ["chats", "diagnostics", "source"])
        self.assertEqual(sorted(data["chats"][0]),
                         ["chat_identifier", "chat_ids", "display_name", "first_unix", "guid", "id",
                          "last_unix", "members", "messages", "name", "participants"])
        self.assertIn("+15550100001", data["chats"][0]["participants"])
        for chat in data["chats"]:                          # what is meant to be shown is clean
            self.assertEqual(support.text_leaks(chat["name"]), [])

    def test_stats_matches_the_hand_computed_tiny_chat(self):
        # --year 2026 while "today" is later: the whole year is in range, and
        # the fixture has one message after the pinned test clock (Nov 20)
        period = ["--start", "2026-01-01", "--end", "2026-11-11", "--tz", LA]
        status, out, err = run("stats", "Book Club", "--full-names", *period, *source_args())
        self.assertEqual((status, err), (0, ""))
        got = json.loads(out)
        expected = json.loads(json.dumps(TINY))
        expected["period"]["label"] = "2026-01-01 \u2013 2026-11-11"
        got["meta"]["generated"] = expected["meta"]["generated"]
        # tapbacks are bounded by the period end exactly like messages
        self.assertEqual(got, expected)
        # without the flag people are called by their first names, everywhere
        status, out, err = run("stats", "Book Club", *period, *source_args())
        self.assertEqual((status, err), (0, ""))
        short = json.loads(out)
        short["meta"]["generated"] = expected["meta"]["generated"]
        self.assertEqual(short, wrapped.short_names(expected))
        self.assertEqual([s["name"] for s in short["senders"]], ["Nora", "Me", "\u20260012"])
        self.assertNotIn("Quill", out)

    def test_stats_options(self):
        with tempfile.TemporaryDirectory() as folder:
            target = os.path.join(folder, "out.json")
            status, out, err = run("stats", "3", "--all-time", "--me", "Amara", "--tz", "UTC",
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
        self.assertIn("Amara", [s["name"] for s in got["senders"]])
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
            status, out, err = run("link", "--stats", target, "--quotes")
            self.assertEqual((status, err), (0, ""))
            self.assertEqual(wrapped.stats_from_url(out.strip()), TINY)
            # message text goes into a link only when asked for
            for flags in ([], ["--no-quotes"], ["--quotes", "--no-quotes"]):
                status, out, err = run("link", "--stats", target, *flags)
                self.assertEqual((status, err), (0, ""), flags)
                quiet = wrapped.stats_from_url(out.strip())
                self.assertEqual([q["text"] for q in quiet["most_reacted"]], ["", "", ""], flags)
                self.assertEqual(quiet["totals"], TINY["totals"])
            status, out, err = run("link", "--stats", "-", "--quotes", stdin=json.dumps(TINY))
            self.assertEqual(wrapped.stats_from_url(out.strip()), TINY)

    def test_link_over_budget_is_trimmed_and_says_so(self):
        status, out, err = run("link", "Extremely", "--year", "2026", "--tz", LA, "--quotes",
                               "--full-names", *source_args())
        self.assertEqual(status, 0)
        url = out.strip()
        self.assertLessEqual(len(url), 4800)
        self.assertIn("shortened", err)
        stats = wrapped.stats_from_url(url)
        self.assertTrue(all("detail" not in a for a in stats["awards"]))
        # first names and no message text: the same chat fits without trimming
        status, out, err = run("link", "Extremely", "--year", "2026", "--tz", LA, *source_args())
        self.assertEqual((status, err), (0, ""))
        short = wrapped.stats_from_url(out.strip())
        self.assertTrue(all("detail" in a for a in short["awards"]))
        self.assertTrue(all(q["text"] == "" for q in short["most_reacted"]))
        self.assertTrue(all(len(s["name"].split()) == 1 or s["name"].endswith(".")
                            for s in short["senders"]), [s["name"] for s in short["senders"]])

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
        self.assertEqual((args.chat, args.year, args.me, args.backup), ("Book Club", 2026, None, None))
        self.assertTrue(callable(args.func))
        args = parser.parse_args(["chats", "--backup"])
        self.assertEqual(args.backup, "")
        self.assertFalse(parser.parse_args(["link", "x"]).full_names)
        self.assertTrue(parser.parse_args(["stats", "x", "--full-names"]).full_names)
        self.assertFalse(parser.parse_args(["link", "x"]).quotes)

    def test_printed_json_cannot_garble_a_terminal(self):
        value = {"name": "a\u202eb\x7f\x9b\u2028c\u2066d\x1b[0m", "emoji": "\U0001F32E\u200d"}
        text = cli._pretty(value)
        self.assertEqual(json.loads(text), value)
        self.assertEqual([f for f in support.text_leaks(text.replace("\n", " ")) if "control" in f], [])
        self.assertIn("\U0001F32E", text)                   # ordinary characters stay readable
        self.assertIn("\\u202e", text)
        # a quoted message with a direction override, through the real command
        status, out, err = run("stats", "Taco", "--all-time", "--tz", LA, *source_args())
        self.assertEqual((status, err), (0, ""))
        self.assertEqual([f for f in support.text_leaks(out.replace("\n", " ")) if "control" in f], [])
        self.assertGreater(json.loads(out)["totals"]["messages"], 3000)


class OwnerName(unittest.TestCase):
    """Who the recap calls its owner when nobody says: not "Me" if the Mac
    knows a first name. The lookup is always a stand-in here, so the answers
    are the same on every machine."""

    NOTICE = ('Threadback: you are "%s" in this recap (the first name of this Mac\'s account). '
              "Use --me NAME to change it.\n")

    @staticmethod
    def answering(stdout="", error=None, returncode=0):
        calls = []

        def run(command, **options):
            calls.append((command, options))
            if error is not None:
                raise error
            return types.SimpleNamespace(stdout=stdout, returncode=returncode)
        return run, calls

    def test_the_first_name_of_the_mac_account(self):
        run, calls = self.answering("Amara Quinn\n")
        self.assertEqual(wrapped.account_first_name(platform="darwin", run=run), "Amara")
        command, options = calls[0]
        self.assertEqual(command, ["/usr/bin/id", "-F"])
        self.assertEqual(options.get("timeout"), 3)
        self.assertFalse(options.get("shell"))
        cases = {
            "Amara\n": "Amara", "  Amara   Quinn  \n": "Amara", "Zo\xeb M\xfcller\n": "Zo\xeb",
            "\u738b \u5c0f\u660e\n": "\u738b", "Am\u202eara\x1b X\n": "Amara",
            "A" * 100: "A" * 40 + "\u2026",
            # not a name: nothing, a question mark, a number, an address
            "": "Me", "  \n": "Me", "?\n": "Me", "5550100123\n": "Me", "+1 555 010 0123\n": "Me",
            "jane.doe@example.com\n": "Me", "\x00\x1b\n": "Me",
        }
        for stdout, expected in cases.items():
            run, _calls = self.answering(stdout)
            self.assertEqual(wrapped.account_first_name(platform="darwin", run=run), expected,
                             repr(stdout))

    def test_anything_else_is_me(self):
        for error in (OSError("no such command"), subprocess.TimeoutExpired(["id"], 3),
                      UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")):
            run, _calls = self.answering(error=error)
            self.assertEqual(wrapped.account_first_name(platform="darwin", run=run), "Me", error)
        run, _calls = self.answering("Amara Quinn\n", returncode=1)
        self.assertEqual(wrapped.account_first_name(platform="darwin", run=run), "Me")
        for platform in ("linux", "win32"):             # only a Mac is asked
            run, calls = self.answering("Amara Quinn\n")
            self.assertEqual(wrapped.account_first_name(platform=platform, run=run), "Me")
            self.assertEqual(calls, [])
        self.assertIsInstance(wrapped.account_first_name(), str)        # the real thing never raises

    def command(self, *args, account="Amara", env=None):
        """Run the command line in this process with a stand-in for the lookup."""
        environment = {key: value for key, value in os.environ.items() if key != "WRAPPED_ME"}
        environment.update(env or {})
        with mock.patch.dict(os.environ, environment, clear=True), \
                mock.patch.object(wrapped.api, "account_first_name", return_value=account) as lookup:
            status, out, err = support.call_cli(*args)
        return status, out, err, lookup.call_count

    def test_the_command_line_uses_it_and_says_so(self):
        period = ["--year", "2026", "--tz", LA]
        status, out, err, asked = self.command("stats", "Book Club", *period, *source_args())
        self.assertEqual((status, asked), (0, 1))
        self.assertEqual(err, self.NOTICE % "Amara")
        names = [s["name"] for s in json.loads(out)["senders"]]
        self.assertIn("Amara", names)
        self.assertNotIn("Me", names)
        status, out, err, asked = self.command("link", "Book Club", *period, *source_args())
        self.assertEqual((status, asked, err), (0, 1, self.NOTICE % "Amara"))
        shared = wrapped.stats_from_url(out.strip())
        self.assertIn("Amara", [s["name"] for s in shared["senders"]])
        self.assertEqual(shared["late_night"]["top"]["name"], "Amara")
        # the chat list does not show the owner: the same name is used, nothing is said
        status, out, err, asked = self.command("chats", *source_args())
        self.assertEqual((status, err, asked), (0, "", 1))

    def test_a_name_that_was_given_is_used_without_comment(self):
        period = ["--year", "2026", "--tz", LA]
        for args, env, expected in (
                (["--me", "Sam"], None, "Sam"),
                (["--me", ""], None, "Me"),
                (["--me", "Robin Hood"], {"WRAPPED_ME": "Somebody Else"}, "Robin Hood"),
                ([], {"WRAPPED_ME": "Robin Hood"}, "Robin Hood"),
                ([], {"WRAPPED_ME": "+1 555 010 0123"}, "\u20260123"),      # a label like any other
                ([], {"WRAPPED_ME": ""}, "Me")):
            for command in ("stats", "link"):
                status, out, err, asked = self.command(command, "Book Club", *period, *args,
                                                       *source_args(), env=env)
                self.assertEqual((status, err, asked), (0, "", 0), (command, args, env))
                stats = json.loads(out) if command == "stats" else wrapped.stats_from_url(out.strip())
                self.assertIn(expected, [s["name"] for s in stats["senders"]], (command, args, env))

    def test_without_a_name_the_recap_says_how_to_give_one(self):
        status, out, err, asked = self.command("stats", "Book Club", "--year", "2026", "--tz", LA,
                                               *source_args(), account="Me")
        self.assertEqual((status, asked), (0, 1))
        self.assertEqual(err, 'Threadback: you are "Me" in this recap. '
                              "Use --me NAME to put your name there.\n")
        self.assertIn("Me", [s["name"] for s in json.loads(out)["senders"]])
        # a link from a stats file names nobody, so nothing is looked up or said
        with tempfile.TemporaryDirectory() as folder:
            target = os.path.join(folder, "tiny.json")
            with open(target, "w", encoding="utf-8") as handle:
                json.dump(TINY, handle)
            status, out, err, asked = self.command("link", "--stats", target)
        self.assertEqual((status, err, asked), (0, "", 0))
        # an error is still one sentence, with nothing in front of it
        status, out, err, asked = self.command("stats", "no such chat", *source_args())
        self.assertEqual((status, out), (1, ""))
        self.assertEqual(err.count("\n"), 1)
        self.assertIn("No group chat matches", err)

    def test_the_tests_themselves_pin_the_name(self):
        self.assertEqual(os.environ.get("WRAPPED_ME"), "Me")
        status, out, err = run("stats", "Book Club", "--year", "2026", "--tz", LA, *source_args())
        self.assertEqual((status, err), (0, ""))
        self.assertIn("Me", [s["name"] for s in json.loads(out)["senders"]])
        self.assertIn("WRAPPED_ME", run("stats", "--help")[1])


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
        url = wrapped.build_link(TINY, quotes=True)
        self.assertEqual(wrapped.stats_from_url(url), TINY)
        quiet = wrapped.stats_from_url(wrapped.build_link(TINY))      # no message text by default
        self.assertEqual([q["text"] for q in quiet["most_reacted"]], ["", "", ""])
        self.assertEqual(wrapped.build_link(TINY), wrapped.build_link(TINY, quotes=False))
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
