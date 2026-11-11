"""Damaged, hostile and merely odd input.

Whatever is wrong with a database or a file, the library raises
``wrapped.DatabaseError`` (or ``ValueError`` for an argument) carrying one
explanation for the user, and the command line prints it and exits with
status 1: never a traceback. Cells of the wrong type read the same way in both
engines; the conformance suite compares the engines byte for byte, and the
individual decisions are pinned down here.
"""

import json
import os
import shutil
import sqlite3
import tempfile
import unittest

import support
from support import NOW, msg, tap

import wrapped
from wrapped import db, payload, stats as S

FIXTURE = support.build_fixture
utc = FIXTURE.utc
NONE = type(None)


def run(rows, **options):
    options.setdefault("tz", "UTC")
    options.setdefault("now", NOW)
    options.setdefault("all_time", True)
    return S.compute_stats(rows, options)


class Scratch(unittest.TestCase):
    """A private temporary folder per test."""

    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="wrapped-robust-")
        self.addCleanup(shutil.rmtree, self.folder, True)

    def copy(self, key, name="chat.db"):
        target = os.path.join(self.folder, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(support.path(key), target)
        return target

    def write(self, name, content):
        target = os.path.join(self.folder, name)
        with open(target, "wb") as handle:
            handle.write(content if isinstance(content, bytes) else content.encode("utf-8"))
        return target

    def assert_one_sentence(self, result, *phrases):
        status, out, err = result
        self.assertEqual((status, out), (1, ""), err)
        self.assertTrue(err.startswith("Threadback: "), err)
        self.assertEqual(err.count("\n"), 1, err)
        self.assertTrue(err.endswith("\n"), err)
        self.assertNotIn("Traceback", err)
        for phrase in phrases:
            self.assertIn(phrase.lower(), err.lower())


class DamagedDatabases(Scratch):
    def test_pages_overwritten_with_noise(self):
        path = self.copy("backup_sms")
        size = os.path.getsize(path)
        with open(path, "r+b") as handle:           # everything after the first page
            handle.seek(4096)
            handle.write(b"\xa5" * (size - 4096))
        for call in (lambda: wrapped.list_chats(db=path, contacts=False),
                     lambda: wrapped.compute_stats(path, 1, year=2026, contacts=False),
                     lambda: wrapped.chat_for_message(path, 1)):
            with self.assertRaises(wrapped.DatabaseError) as caught:
                call()
            self.assertEqual(caught.exception.code, "corrupt")
            self.assertNotIn("\n", str(caught.exception))
        for command in (["chats"], ["chats", "--json"], ["stats", "1", "--no-contacts"],
                        ["link", "1", "--no-contacts"]):
            self.assert_one_sentence(support.call_cli(*command, "--db", path),
                                     "cannot be read", "chat.db-wal")
        # once through a real process, and once with the traceback asked for
        self.assert_one_sentence(support.run_cli("stats", "1", "--no-contacts", "--db", path),
                                 "cannot be read")
        status, out, err = support.run_cli("stats", "1", "--no-contacts", "--db", path,
                                           env={"WRAPPED_DEBUG": "1"})
        self.assertEqual((status, out), (1, ""))
        self.assertIn("Traceback", err)

    def test_files_cut_short(self):
        size = os.path.getsize(support.path("backup_sms"))
        for index, keep in enumerate((100, 1000, 4096, 4096 * 3 + 17, size // 4, size // 2 + 100)):
            path = self.copy("backup_sms", "cut%d/chat.db" % index)
            with open(path, "r+b") as handle:
                handle.truncate(keep)
            self.assert_one_sentence(support.call_cli("chats", "--db", path), "cannot be read")
            with self.assertRaises(wrapped.DatabaseError) as caught:
                wrapped.compute_stats(path, "Book Club", year=2026, contacts=False)
            self.assertEqual(caught.exception.code, "corrupt", keep)

    def test_a_wal_from_another_copy(self):
        path = self.copy("foreign_wal_db", "foreign/chat.db")
        shutil.copyfile(support.path("foreign_wal"), path + "-wal")
        for command in (["chats"], ["stats", "Book Club", "--no-contacts", "--year", "2026"]):
            status, out, err = support.run_cli(*command, "--db", path)
            self.assertNotIn("Traceback", err)
            self.assertIn(status, (0, 1))
            if status == 1:                         # what every SQLite seen so far does
                self.assert_one_sentence((status, out, err), "cannot be read", "chat.db-wal")
        try:
            chats = wrapped.list_chats(db=path, contacts=False)
        except wrapped.DatabaseError as exc:
            self.assertEqual(exc.code, "corrupt")
        else:
            self.assertIsInstance(chats, list)

    def test_no_chat_handle_join_table(self):
        path = support.path("nojoin_db")
        chats = wrapped.list_chats(db=path, contacts=False)
        self.assertEqual([(c["name"], c["participants"], c["members"], c["messages"]) for c in chats],
                         [("Old Friends", [], 1, 5)])
        options = dict(year=2016, tz="UTC", contacts=False, now=NOW)
        self.assertEqual(wrapped.compute_stats(path, 1, **options),
                         wrapped.compute_stats(support.path("legacy_db"), 1, **options))
        status, out, err = support.call_cli("chats", "--db", path)
        self.assertEqual((status, err), (0, ""))
        self.assertIn("Old Friends", out)

    def test_a_missing_column(self):
        path = support.path("nocolumn_db")
        self.assertEqual(len(wrapped.list_chats(db=path, contacts=False)), 1)
        with self.assertRaises(wrapped.DatabaseError) as caught:
            wrapped.compute_stats(path, 1, year=2016, contacts=False)
        self.assertEqual(caught.exception.code, "schema")
        self.assertIn("is_from_me", str(caught.exception))
        self.assert_one_sentence(
            support.call_cli("stats", "1", "--year", "2016", "--no-contacts", "--db", path),
            "part of the usual layout is missing", "is_from_me")
        self.assert_one_sentence(
            support.call_cli("link", "1", "--year", "2016", "--no-contacts", "--db", path),
            "part of the usual layout is missing")

    def test_missing_tables_and_columns_of_every_kind(self):
        layouts = [
            "CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text)",
            "CREATE TABLE chat (x); CREATE TABLE message (x); CREATE TABLE handle (x); "
            "CREATE TABLE chat_message_join (x)",
            "CREATE TABLE chat (style, guid, chat_identifier, display_name, service_name); "
            "CREATE TABLE message (date); CREATE TABLE handle (id); "
            "CREATE TABLE chat_message_join (chat_id); INSERT INTO chat (style) VALUES (43)",
        ]
        for index, layout in enumerate(layouts):
            path = os.path.join(self.folder, "layout%d.sqlite" % index)
            con = sqlite3.connect(path)
            con.executescript(layout)
            con.commit()
            con.close()
            with self.assertRaises(wrapped.DatabaseError) as caught:
                wrapped.compute_stats(path, 1, all_time=True, contacts=False)
            self.assertEqual(caught.exception.code, "schema", layout)
            status, out, err = support.call_cli("chats", "--db", path)
            self.assertEqual((status, out), (1, ""), layout)
            self.assertNotIn("Traceback", err)

    def test_a_damaged_address_book_costs_the_names_not_the_recap(self):
        book = self.copy("evil_address_book", "AddressBook-v22.abcddb")
        size = os.path.getsize(book)
        with open(book, "r+b") as handle:
            handle.seek(4096)
            handle.write(b"\x5a" * (size - 4096))
        with self.assertRaises(wrapped.DatabaseError) as caught:
            db.load_contacts(book)
        self.assertEqual(caught.exception.code, "corrupt")
        status, out, err = support.call_cli("stats", "Book Club", "--year", "2026", "--tz", "UTC",
                                            "--db", support.path("chat_db"), "--contacts", self.folder)
        self.assertEqual((status, err), (0, ""))
        self.assertIn("\u20260011", [s["name"] for s in json.loads(out)["senders"]])

    def test_random_damage_is_a_database_error_or_nothing(self):
        """Sixty differently damaged copies of a small database."""
        with open(support.path("noemoji_db"), "rb") as handle:
            original = handle.read()
        rng = FIXTURE.Rng(99)
        outcomes = {"read": 0, "refused": 0}
        for attempt in range(60):
            data = bytearray(original)
            for _ in range(1 + rng.below(6)):
                at = rng.below(len(data))
                for i in range(at, min(len(data), at + 1 + rng.below(900))):
                    data[i] = rng.below(256)
            if attempt % 6 == 5:
                del data[100 + rng.below(len(data) - 100):]          # and sometimes cut short
            path = self.write("damaged%d.sqlite" % attempt, bytes(data))
            try:
                with wrapped.open_source(db=path, contacts=False) as source:
                    for chat in source.chats():
                        stats = source.stats(chat["id"], all_time=True, tz="UTC", now=NOW)
                        self.assertEqual([f for f in support.leaks(stats) if "control" in f], [])
                        try:
                            payload.build_link(wrapped.short_names(stats))
                        except wrapped.LinkTooLongError:
                            pass                    # garbage can make an enormous name
                outcomes["read"] += 1
            except wrapped.DatabaseError as exc:
                self.assertIn(exc.code, ("corrupt", "schema", "not_sqlite", "open"), attempt)
                self.assertTrue(str(exc))
                outcomes["refused"] += 1
        self.assertGreater(outcomes["read"], 5, outcomes)
        self.assertGreater(outcomes["refused"], 5, outcomes)


class OddCells(unittest.TestCase):
    """Cells of the wrong type, as the fixture's "evil" database has them."""

    @classmethod
    def setUpClass(cls):
        cls.chats = support.fixture()[1]["evil"]["chats"]
        cls.con = db.open_database(support.path("evil_db"))
        cls.rows = db.load_rows(cls.con, [cls.chats["control_name"]["rowid"]])
        cls.by_text = {row["text"]: row for row in cls.rows if row["text"]}

    @classmethod
    def tearDownClass(cls):
        cls.con.close()

    def test_every_value_has_the_type_it_should_have(self):
        kinds = {"rowid": (int,), "guid": (str, NONE), "date": (int, NONE), "is_from_me": (int, NONE),
                 "handle": (str, NONE), "text": (str, NONE), "attributedBody": (bytes, NONE),
                 "cache_has_attachments": (int, NONE), "item_type": (int, NONE),
                 "associated_message_type": (int, NONE), "associated_message_guid": (str, NONE)}
        self.assertGreater(len(self.rows), 40)
        for chat in self.chats.values():
            for row in db.load_rows(self.con, [chat["rowid"]]):
                self.assertEqual(sorted(row), sorted(kinds))
                for key, allowed in kinds.items():
                    self.assertIsInstance(row[key], allowed, (key, row))

    def test_a_number_or_a_blob_where_text_belongs_is_read_as_text(self):
        self.assertIn("1099511627776", self.by_text)                # INTEGER: not a buffer size
        self.assertIn("2.5", self.by_text)                          # REAL
        self.assertIn("hello from a blob", self.by_text)            # BLOB
        self.assertIn("caf\ufffd \ufffd ok", self.by_text)          # BLOB that is not UTF-8
        self.assertEqual(self.by_text["my guid is a number"]["guid"], "12345")
        self.assertIsNone(self.by_text["0"]["attributedBody"])      # the zero is text: no fallback
        handles = {row["handle"] for row in db.load_rows(self.con, [self.chats["integer_name"]["rowid"]])}
        self.assertLessEqual({"+15550100134", "15550100135", "555.5"}, handles)   # BLOB, INTEGER, REAL
        names = [chat["display_name"] for chat in db.list_group_chats(self.con)]
        self.assertIn("\u20260177", names)                          # INTEGER display name, masked
        self.assertIn("Group 7", names)                             # BLOB display name
        self.assertIn("Style As Text", names)                       # style stored as the text "43"

    def test_a_date_that_is_not_an_integer(self):
        t = utc(2026, 5, 20, 16, 0) - support.APPLE_EPOCH
        dates = {text: row["date"] for text, row in self.by_text.items()}
        self.assertEqual(dates["a date with a fraction"], t + 240)              # REAL: truncated
        self.assertEqual(dates["a date in floating point"], (t + 300) * 10 ** 9)
        self.assertEqual(dates["a date that is text"], t + 360)
        self.assertEqual(dates["a date that is a word"], 0)
        self.assertIsNone(dates["no date at all"])
        self.assertEqual(dates["a negative date"], -5)
        self.assertEqual(dates["a date beyond the end of time"], 2 ** 63 - 1)
        # the first three are messages of 20 May 2026; the other four have no date and do not count
        wanted = [row for text, row in self.by_text.items() if "date" in text]
        self.assertEqual(len(wanted), 7)
        st = run(wanted)
        self.assertEqual(st["totals"]["messages"], 3)
        self.assertEqual(st["busiest_day"], {"date": "2026-05-20", "messages": 3})
        self.assertEqual(st["by_hour"][16], 3)
        # and none of them becomes the chat's first or last day
        listed = {chat["id"]: chat for chat in db.list_group_chats(self.con)}
        chat = listed[self.chats["control_name"]["rowid"]]
        self.assertEqual(chat["last_unix"], utc(2026, 5, 20, 16, 21))
        self.assertGreater(chat["first_unix"], utc(2026, 5, 1, 0, 0))

    def test_flags_and_kinds_of_the_wrong_type(self):
        rows = self.by_text
        self.assertEqual(rows["mine, says a text cell"]["is_from_me"], 1)       # the text "1"
        self.assertEqual(rows["a flag that is a word"]["is_from_me"], 0)        # "yes" is not a number
        self.assertEqual(rows["a flag that is a fraction"]["is_from_me"], 0)    # 0.9, truncated
        self.assertIsNone(rows["a flag that is missing"]["is_from_me"])
        self.assertEqual(rows["an event, typed as text"]["item_type"], 1)
        self.assertEqual(rows["\ufffc"]["cache_has_attachments"], 2)            # 2.7, truncated
        taps = [row for row in self.rows if row["associated_message_guid"] == "p:0/12345"]
        self.assertEqual(sorted(row["associated_message_type"] for row in taps), [2000, 2001])
        bodies = [row["attributedBody"] for row in self.rows if row["attributedBody"] is not None]
        self.assertIn(b"not a typedstream", bodies)                             # TEXT, read as bytes
        self.assertIn(b"7", bodies)                                             # INTEGER, as bytes
        with wrapped.open_source(db=support.path("evil_db"), contacts=False) as source:
            st = source.stats(self.chats["control_name"]["rowid"], all_time=True, tz="UTC", now=NOW)
        quote = [q for q in st["most_reacted"] if q["text"] == "my guid is a number"]
        self.assertEqual(len(quote), 1)
        self.assertEqual((quote[0]["reactions"], quote[0]["kinds"]), (2, {"love": 1, "like": 1}))
        self.assertIn("Unknown", [s["name"] for s in st["senders"]])            # four kinds of no handle


class OddRows(unittest.TestCase):
    """compute_stats on rows that did not come from a loader."""

    t = utc(2026, 5, 5, 10, 0)

    def test_values_of_the_wrong_type_never_raise(self):
        base = msg(self.t, "+15550100001", "hello", guid="G1")
        values = [None, True, False, 0, 1, -1, 2 ** 40, 2 ** 70, -2 ** 70, 1.5, float("inf"),
                  float("-inf"), float("nan"), 1e300, "", "x", "1", b"bytes", bytearray(b"ba"),
                  memoryview(b"mv"), [], [1], {}, {"a": 1}, (1, 2), object()]
        keys = ("date", "is_from_me", "handle", "text", "attributedBody", "cache_has_attachments",
                "item_type", "associated_message_type", "associated_message_guid", "guid", "rowid",
                "keep_empty")
        for key in keys:
            for value in values:
                odd = dict(base, guid="G2")
                odd[key] = value
                st = run([dict(base), odd, tap(self.t + 5, "+15550100002", 2000, base)])
                self.assertIn(st["totals"]["messages"], (1, 2), (key, value))
                payload.canonical_json(st)
        st = run([None, 5, "row", [], base, object(), ()])           # rows that are not rows
        self.assertEqual(st["totals"]["messages"], 1)
        self.assertEqual(run([])["totals"]["messages"], 0)
        self.assertEqual(run(iter([base]))["totals"]["messages"], 1)

    def test_a_huge_number_as_text_is_not_a_buffer_size(self):
        st = run([msg(self.t, "+15550100001", 2 ** 40), msg(self.t + 1, "+15550100001", "real text")])
        self.assertEqual((st["totals"]["messages"], st["totals"]["words"]), (1, 2))
        body = FIXTURE.archive_attributed_string("from the body")
        st = run([msg(self.t, "+15550100001", 2 ** 40, attributedBody=body)])
        self.assertEqual((st["totals"]["messages"], st["totals"]["words"]), (1, 3))
        # the one-message helper the Mac side uses
        self.assertEqual(wrapped.decode_text(2 ** 40), "")
        self.assertEqual(wrapped.decode_text(2 ** 40, body), "from the body")
        self.assertEqual(wrapped.decode_text(0, body), "from the body")
        for nothing in (5.5, True, [], {}, object()):
            self.assertEqual(wrapped.decode_text(nothing), "")
            self.assertEqual(wrapped.decode_text(nothing, nothing), "")
        self.assertEqual(wrapped.decode_text(b"caf\xc3\xa9 \xff"), "caf\xe9")
        self.assertEqual(wrapped.decode_text(None, 5), "")
        self.assertEqual(wrapped.decode_text(None, "a string"), "")

    def test_options_of_the_wrong_type(self):
        rows = [msg(self.t)]
        for year in (0, -1, 10000, 2026.5, "2026", True, [], float("nan"), float("inf"), 10 ** 30):
            with self.assertRaises(ValueError, msg=repr(year)) as caught:
                run(rows, all_time=False, year=year)
            self.assertIn("between 1 and 9999", str(caught.exception))
        self.assertEqual(run(rows, all_time=False, year=2026.0)["period"]["label"], "2026")
        self.assertEqual(run(rows, all_time=False, year=1)["period"]["start"], "0001-01-01")
        self.assertEqual(run(rows, all_time=False, year=9999)["period"]["end"], "9999-12-31")
        for bad in ({"now": "soon"}, {"now": -1}, {"now": float("nan")}, {"now": 1e30}, {"now": []},
                    {"tz": "Mars/Olympus"}, {"tz": 5}, {"tz": []}, {"start": 5}, {"start": "2026-13-01"},
                    {"end": "soon"}, {"start": "2026-06-01", "end": "2026-05-01"}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                run(rows, all_time=False, **bad)
        for harmless in ({"me": 5}, {"me": []}, {"chat_name": 7}, {"chat_name": ["x"]},
                         {"participants": 5}, {"participants": "+15550100002"},
                         {"participants": [None, 5, "", "+15550100002"]}, {"contacts": 5},
                         {"contacts": "text"}, {"contacts": [None, 5, "ab", ["solo"], [5, "Name"]]},
                         {"label": 5}, {"source": []}):
            self.assertEqual(run(rows, **harmless)["totals"]["messages"], 1, harmless)


class CommandLine(Scratch):
    def source(self):
        return ["--db", support.path("legacy_db"), "--no-contacts", "--year", "2016"]

    def test_output_that_cannot_be_written(self):
        missing = os.path.join(self.folder, "no", "such", "folder", "x.json")
        self.assert_one_sentence(support.call_cli("stats", "1", "-o", missing, *self.source()),
                                 "could not write", "x.json")
        self.assert_one_sentence(support.call_cli("stats", "1", "-o", self.folder, *self.source()),
                                 "could not write")
        self.assertEqual(os.listdir(self.folder), [])

    def test_a_stats_file_that_is_not_a_recap(self):
        cases = [
            (None, "could not read"),
            (b"[1, 2]", "expected a JSON object, found a list"),
            (b"5", "expected a JSON object"),
            (b"\"text\"", "expected a JSON object"),
            (b"null", "expected a JSON object"),
            (b"{not json", "not valid JSON"),
            (b"", "not valid JSON"),
            (b"\xff\xfe\x00", "not a text file"),
        ]
        for index, (content, phrase) in enumerate(cases):
            path = os.path.join(self.folder, "missing.json") if content is None \
                else self.write("stats%d.json" % index, content)
            self.assert_one_sentence(support.call_cli("link", "--stats", path), phrase)
        self.assert_one_sentence(support.call_cli("link", "--stats", self.folder), "could not read")
        self.assert_one_sentence(support.call_cli("link", "Old Friends", "--stats", "x", *self.source()),
                                 "not both")

    def test_a_stats_file_nested_too_deeply(self):
        for content in (b"[" * 100000, b'{"a":' * 100000 + b"1" + b"}" * 100000,
                        b'{"a":' * 600 + b"1" + b"}" * 600):
            path = self.write("deep.json", content)
            self.assert_one_sentence(support.run_cli("link", "--stats", path), "nested too deeply")
        self.assert_one_sentence(support.run_cli("link", "--stats", "-", stdin=b"[" * 100000),
                                 "nested too deeply", "standard input")

    def test_a_stats_file_with_the_wrong_things_inside_still_makes_a_link(self):
        for content in ('{"most_reacted": 5, "senders": "x", "awards": [1], "chat": []}',
                        '{"most_reacted": [{"text": 5}, 7], "senders": [1], "awards": {"a": 1}}',
                        '{}', '{"v": "one", "totals": null}'):
            path = self.write("odd.json", content)
            for flags in ([], ["--quotes"]):
                status, out, err = support.call_cli("link", "--stats", path, *flags)
                self.assertEqual((status, err), (0, ""), content)
                shared = wrapped.stats_from_url(out.strip())
                self.assertIsInstance(shared, dict)

    def test_the_year_has_to_be_a_year(self):
        for year in ("0", "-1", "10000", "99999999999999999999"):
            for command in ("stats", "link"):
                self.assert_one_sentence(
                    support.call_cli(command, "1", "--db", support.path("legacy_db"), "--no-contacts",
                                     "--year", year), "--year must be between 1 and 9999")
        status, out, err = support.call_cli("stats", "1", "--db", support.path("legacy_db"),
                                            "--no-contacts", "--year", "soon")
        self.assertEqual((status, out), (2, ""))            # argparse's own usage message
        self.assertNotIn("Traceback", err)
        status, out, err = support.call_cli("stats", "1", "--db", support.path("legacy_db"),
                                            "--no-contacts", "--year", "2016", "--tz", "UTC")
        self.assertEqual((status, err), (0, ""))
        self.assertEqual(json.loads(out)["totals"]["messages"], 4)


if __name__ == "__main__":
    unittest.main()
