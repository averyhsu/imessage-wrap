"""Database layer on the generated fixture: chat discovery, WAL handling,
iPhone backups, contacts, old schemas, and the hand-computed tiny chat."""

import json
import os
import shutil
import sqlite3
import stat
import tempfile
import unittest

import support
from support import LA, NOW

import wrapped
from wrapped import db
from wrapped.stats import compute_stats

with open(os.path.join(support.ROOT, "tests", "conformance", "expected_tiny.json"),
          encoding="utf-8") as handle:
    EXPECTED = json.load(handle)


def read_bytes(path):
    with open(path, "rb") as handle:
        return handle.read()


def mac_source(**kwargs):
    kwargs.setdefault("contacts", support.path("address_book_dir"))
    return wrapped.open_source(db=support.path("chat_db"), **kwargs)


class ChatList(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with mac_source() as source:
            cls.chats = source.chats()
            cls.info = source.diagnostics()
        cls.fx = support.fixture()[1]

    def test_only_group_chats_and_same_identifier_rows_are_merged(self):
        self.assertEqual(len(self.chats), 4)
        self.assertEqual(self.info["chats"], 7)            # 5 group rows + two 1:1 chats
        self.assertEqual(self.info["group_chats"], 4)
        lively = self.chats[0]
        self.assertEqual(lively["name"], "Taco Tuesday Crew \U0001F32E")
        self.assertEqual(lively["chat_ids"], [self.fx["chats"]["lively"]["rowid"],
                                              self.fx["chats"]["lively_sms"]["rowid"]])
        self.assertEqual(lively["id"], self.fx["chats"]["lively"]["rowid"])
        self.assertEqual(lively["chat_identifier"], "chat100000000000000001")
        self.assertEqual(lively["members"], 7)
        for chat in self.chats:
            self.assertNotIn(chat["id"], (self.fx["chats"]["dm_ines"]["rowid"],
                                          self.fx["chats"]["dm_bram"]["rowid"]))

    def test_names_counts_and_order(self):
        names = [c["name"] for c in self.chats]
        stress = self.fx["chats"]["stress"]["display_name"]        # 87 characters: cut at 80
        self.assertEqual(names[1], stress[:80] + "\u2026")
        self.assertEqual(names[2], "Bram, Sam, \u20260007 & 1 more")
        self.assertEqual(names[3], "Book Club \U0001F4DA")
        counts = [c["messages"] for c in self.chats]
        self.assertEqual(counts, sorted(counts, reverse=True))
        self.assertGreater(counts[0], 3000)
        tiny = self.chats[3]
        self.assertEqual(tiny["members"], 3)
        self.assertEqual(tiny["participants"], ["+15550100011", "nora.quill@example.com",
                                                "+15550100012"])
        self.assertEqual(tiny["display_name"], "Book Club \U0001F4DA")
        self.assertEqual(self.chats[2]["display_name"], "")

    def test_diagnostics(self):
        self.assertGreater(self.info["messages"], 7000)
        self.assertTrue(self.info["wal_merged"])
        self.assertFalse(self.info["immutable"])
        self.assertLess(self.info["first_unix"], self.info["last_unix"])
        first_day = self.info["first_unix"] // 86400
        self.assertTrue(20362 <= first_day < 20372, first_day)          # early October 2025

    def test_find_chat(self):
        find = db.find_chat
        tiny = self.chats[3]
        self.assertIs(find(self.chats, tiny["id"]), tiny)
        self.assertIs(find(self.chats, str(tiny["id"])), tiny)
        self.assertIs(find(self.chats, "book club"), tiny)
        self.assertIs(find(self.chats, "Book Club \U0001F4DA"), tiny)
        self.assertIs(find(self.chats, tiny["chat_identifier"]), tiny)
        self.assertIs(find(self.chats, tiny["guid"]), tiny)
        self.assertIs(find(self.chats, self.fx["chats"]["lively_sms"]["rowid"]), self.chats[0])
        self.assertIs(find(self.chats, tiny), tiny)
        with self.assertRaises(db.DatabaseError) as caught:
            find(self.chats, "no such chat")
        self.assertEqual(caught.exception.code, "no_chat")
        with self.assertRaises(db.DatabaseError) as caught:
            find(self.chats, "o")                           # several names contain an "o"
        self.assertEqual(caught.exception.code, "ambiguous_chat")
        self.assertIn("Use the id", str(caught.exception))

    def test_chat_for_message(self):
        rowid = self.fx["tiny"]["M3"]["rowid"]
        chat = wrapped.chat_for_message(support.path("chat_db"), rowid)
        self.assertEqual(chat, {"rowid": self.fx["chats"]["tiny"]["rowid"],
                                "guid": "iMessage;+;chat200000000000000002",
                                "display_name": "Book Club \U0001F4DA", "style": 43,
                                "chat_identifier": "chat200000000000000002", "is_group": True})
        with mac_source() as source:
            self.assertEqual(wrapped.chat_for_message(source, rowid), chat)
            self.assertEqual(wrapped.chat_for_message(source.conn, rowid), chat)
            self.assertIsNone(wrapped.chat_for_message(source, 10 ** 9))
            dm = source.conn.execute(
                "SELECT message_id FROM chat_message_join WHERE chat_id = ? LIMIT 1",
                (self.fx["chats"]["dm_ines"]["rowid"],)).fetchone()[0]
            self.assertEqual(wrapped.chat_for_message(source, dm)["style"], 45)
            self.assertFalse(wrapped.chat_for_message(source, dm)["is_group"])


class TinyChat(unittest.TestCase):
    """Both the row loader and the engine against numbers worked out by hand."""

    def stats(self, case, source):
        return source.stats(EXPECTED["chat"], now=EXPECTED["now"], **case["options"])

    def test_hand_computed_cases(self):
        for case in EXPECTED["cases"]:
            contacts = support.path("address_book_dir") if case["contacts"] else False
            with mac_source(contacts=contacts) as source:
                got = self.stats(case, source)
            if "stats" in case:
                self.assertEqual(got, case["stats"], case["name"])
                self.assertEqual(json.dumps(got, ensure_ascii=False),
                                 json.dumps(case["stats"], ensure_ascii=False), case["name"])
            else:
                self.assertEqual(support.subset_mismatches(case["partial"], got), [], case["name"])

    def test_backup_gives_the_same_answer(self):
        case = EXPECTED["cases"][0]
        expected = json.loads(json.dumps(case["stats"]))
        expected["meta"]["source"] = "sms.db"
        for key in ("backup", "backup_parent", "backup_wal"):
            with wrapped.open_source(backup=support.path(key)) as source:
                self.assertEqual(source.kind, "sms.db")
                self.assertEqual(self.stats(case, source), expected, key)

    def test_database_without_the_emoji_column(self):
        case = EXPECTED["cases"][0]
        with wrapped.open_source(db=support.path("noemoji_db"),
                                 contacts=support.path("address_book_dir")) as source:
            columns = {r[1] for r in source.conn.execute("PRAGMA table_info(message)")}
            self.assertNotIn("associated_message_emoji", columns)
            self.assertEqual(self.stats(case, source), case["stats"])

    def test_public_compute_stats(self):
        case = EXPECTED["cases"][0]
        got = wrapped.compute_stats(support.path("chat_db"), "Book Club", 2026, "Me", LA,
                                    contacts=support.path("address_book_dir"), now=NOW)
        self.assertEqual(got, case["stats"])
        renamed = wrapped.compute_stats(support.path("chat_db"), "Book Club", year=2026, me="Amara",
                                        tz=LA, contacts=False, now=NOW)
        self.assertEqual(renamed["senders"][0]["name"], "Amara")

    def test_invariants_on_every_chat(self):
        with mac_source() as source:
            for chat in source.chats():
                for options in ({"year": 2026}, {"all_time": True}, {"year": 2025}):
                    st = source.stats(chat["id"], tz=LA, now=NOW, **options)
                    total = st["totals"]["messages"]
                    self.assertEqual(sum(st["by_hour"]), total)
                    self.assertEqual(sum(st["by_weekday"]), total)
                    self.assertEqual(sum(st["by_month"]), total)
                    self.assertEqual(sum(st["reactions"]["by_kind"].values()),
                                     st["totals"]["reactions"])
                    self.assertLessEqual(len(st["senders"]), 12)
                    self.assertLessEqual(len(st["most_reacted"]), 3)
                    self.assertLessEqual(len(st["awards"]), 6)
                    if len(st["senders"]) < 12:
                        self.assertEqual(sum(s["messages"] for s in st["senders"]), total)
                        self.assertEqual(sum(s["reactions_received"] for s in st["senders"]),
                                         st["totals"]["reactions"])
                    self.assertEqual(st["chat"]["name"], chat["name"])
                    self.assertGreaterEqual(st["chat"]["members"], len(st["senders"]))


class WriteAheadLog(unittest.TestCase):
    def test_rows_that_only_exist_in_the_wal_are_counted(self):
        fx = support.fixture()[1]
        self.assertGreater(os.path.getsize(support.path("chat_db_wal")), 100000)
        with open(support.path("chat_db"), "rb") as handle:
            header = handle.read(20)
        self.assertEqual((header[18], header[19]), (2, 2))          # WAL mode
        immutable = sqlite3.connect("file:%s?immutable=1" % support.path("chat_db"), uri=True)
        stale = immutable.execute("SELECT COUNT(*) FROM message").fetchone()[0]
        immutable.close()
        with mac_source() as source:
            self.assertTrue(source.conn.wal_merged)
            live = source.conn.execute("SELECT COUNT(*) FROM message").fetchone()[0]
            cutoff = (fx["wal_cutoff"] - 978307200) * 10 ** 9
            late = source.conn.execute("SELECT COUNT(*) FROM message WHERE date >= ?",
                                       (cutoff,)).fetchone()[0]
            st = source.stats("Taco", start="2026-10-26", end="2026-11-11", tz="UTC", now=NOW)
            tiny = source.stats("Book Club", year=2026, tz=LA, now=NOW)
        self.assertGreater(late, 100)
        self.assertGreater(live, stale)
        self.assertGreater(st["totals"]["messages"], 50)            # all of these are WAL-only
        self.assertEqual(tiny["by_month"][10], 2)                   # the two Nov 1 messages

    def test_opening_never_changes_the_files(self):
        folder = tempfile.mkdtemp(prefix="wrapped-wal-")
        try:
            for name in ("chat.db", "chat.db-wal", "chat.db-shm"):
                shutil.copyfile(os.path.join(os.path.dirname(support.path("chat_db")), name),
                                os.path.join(folder, name))
            before = {name: read_bytes(os.path.join(folder, name))
                      for name in ("chat.db", "chat.db-wal")}
            with wrapped.open_source(db=os.path.join(folder, "chat.db"), contacts=False) as source:
                source.chats()
                source.stats("Taco", all_time=True, tz="UTC", now=NOW)
                with self.assertRaises(sqlite3.OperationalError):
                    source.conn.execute("DELETE FROM message")
            after = {name: read_bytes(os.path.join(folder, name)) for name in before}
            self.assertEqual(before, after)
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def test_read_only_folder_falls_back_to_a_private_copy(self):
        if os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0):
            self.skipTest("needs a user that directory permissions apply to")
        folder = tempfile.mkdtemp(prefix="wrapped-ro-")
        try:
            for name in ("chat.db", "chat.db-wal"):
                shutil.copyfile(os.path.join(os.path.dirname(support.path("chat_db")), name),
                                os.path.join(folder, name))
            os.chmod(folder, stat.S_IRUSR | stat.S_IXUSR)
            with wrapped.open_source(db=os.path.join(folder, "chat.db"), contacts=False) as source:
                self.assertTrue(source.conn.wal_merged)
                self.assertEqual(sorted(os.listdir(folder)), ["chat.db", "chat.db-wal"])
                total = source.conn.execute("SELECT COUNT(*) FROM message").fetchone()[0]
            with mac_source() as source:
                self.assertEqual(total, source.conn.execute(
                    "SELECT COUNT(*) FROM message").fetchone()[0])
        finally:
            os.chmod(folder, stat.S_IRWXU)
            shutil.rmtree(folder, ignore_errors=True)

    def test_snapshot_copy_is_removed_on_close(self):
        con = db._snapshot(support.path("chat_db"), support.path("chat_db_wal"))
        folder = con._snapshot_dir
        self.assertTrue(os.path.isdir(folder))
        self.assertGreater(con.execute("SELECT COUNT(*) FROM message").fetchone()[0], 7000)
        con.close()
        self.assertFalse(os.path.exists(folder))

    def test_database_without_a_wal_is_opened_immutable(self):
        before = sorted(os.listdir(os.path.dirname(support.path("legacy_db"))))
        con = db.open_database(support.path("legacy_db"))
        self.assertTrue(con.opened_immutable)
        self.assertFalse(con.wal_merged)
        con.close()
        self.assertEqual(sorted(os.listdir(os.path.dirname(support.path("legacy_db")))), before)


class Backups(unittest.TestCase):
    def test_file_ids_are_the_documented_hashes(self):
        import hashlib
        for constant, name in ((db.SMS_DB_ID, "HomeDomain-Library/SMS/sms.db"),
                               (db.SMS_WAL_ID, "HomeDomain-Library/SMS/sms.db-wal"),
                               (db.ADDRESS_BOOK_ID,
                                "HomeDomain-Library/AddressBook/AddressBook.sqlitedb")):
            self.assertEqual(hashlib.sha1(name.encode()).hexdigest(), constant)
        self.assertTrue(support.path("backup_sms").endswith(
            os.path.join("3d", "3d0d7e5fb2ce288813306e4d4636395e047a3d28")))

    def test_locate_through_manifest_and_by_hash(self):
        backup = support.path("backup")
        self.assertEqual(db.locate_in_backup(backup, "HomeDomain", "Library/SMS/sms.db"),
                         support.path("backup_sms"))
        self.assertEqual(
            db.locate_in_backup(backup, "HomeDomain", "Library/AddressBook/AddressBook.sqlitedb"),
            support.path("backup_address_book"))
        self.assertIsNone(db.locate_in_backup(backup, "HomeDomain", "Library/SMS/sms.db-wal"))
        self.assertIsNone(db.locate_in_backup(backup, "HomeDomain", "Library/Nothing/here.db"))
        self.assertEqual(db.find_backup(backup), backup)
        self.assertEqual(db.find_backup(support.path("backup_parent")), backup)

    def test_hashed_path_fallback_without_a_manifest_and_flat_layout(self):
        folder = tempfile.mkdtemp(prefix="wrapped-backup-")
        try:
            flat = os.path.join(folder, "flat")
            os.makedirs(flat)
            shutil.copyfile(support.path("backup_sms"), os.path.join(flat, db.SMS_DB_ID))
            shutil.copyfile(support.path("backup_address_book"),
                            os.path.join(flat, db.ADDRESS_BOOK_ID))
            nested = os.path.join(folder, "nested")
            shutil.copytree(support.path("backup"), nested)
            os.remove(os.path.join(nested, "Manifest.db"))
            broken = os.path.join(folder, "broken")
            shutil.copytree(support.path("backup"), broken)
            with open(os.path.join(broken, "Manifest.db"), "wb") as handle:
                handle.write(b"SQLite format 3\x00" + b"\x00" * 100)
            case = EXPECTED["cases"][0]
            for backup in (flat, nested, broken):
                with wrapped.open_source(backup=backup) as source:
                    self.assertEqual(len(source.chats()), 4)
                    got = source.stats("Book Club", now=NOW, **case["options"])
                    self.assertEqual(got["totals"], case["stats"]["totals"])
                    self.assertEqual(got["senders"][0]["name"], "Nora Quill")
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def test_backup_files_are_not_touched_and_nothing_is_created(self):
        backup = support.path("backup")
        listing = sorted(os.listdir(os.path.dirname(support.path("backup_sms"))))
        with wrapped.open_source(backup=backup) as source:
            self.assertTrue(source.conn.opened_immutable)
            source.stats("Taco", all_time=True, tz="UTC", now=NOW)
        self.assertEqual(sorted(os.listdir(os.path.dirname(support.path("backup_sms")))), listing)
        self.assertEqual(listing, [db.SMS_DB_ID])

    def test_backup_with_a_wal_merges_it(self):
        with wrapped.open_source(backup=support.path("backup_wal")) as with_wal, \
                wrapped.open_source(backup=support.path("backup")) as merged, \
                mac_source() as mac:
            self.assertTrue(with_wal.conn.wal_merged)
            counts = [s.conn.execute("SELECT COUNT(*) FROM message").fetchone()[0]
                      for s in (with_wal, merged, mac)]
            self.assertEqual(counts[0], counts[1])
            self.assertEqual(counts[0], counts[2])
            a = with_wal.stats("Taco", year=2026, tz=LA, now=NOW)
            b = merged.stats("Taco", year=2026, tz=LA, now=NOW)
            c = mac.stats("Taco", year=2026, tz=LA, now=NOW)
            self.assertEqual(a, b)
            c["meta"]["source"] = "sms.db"
            self.assertEqual(a, c)

    def test_encrypted_backup_is_explained(self):
        self.assertTrue(db.backup_is_encrypted(support.path("backup_encrypted")))
        self.assertFalse(db.backup_is_encrypted(support.path("backup")))
        with self.assertRaises(db.DatabaseError) as caught:
            wrapped.open_source(backup=support.path("backup_encrypted"))
        self.assertEqual(caught.exception.code, "encrypted")
        text = str(caught.exception)
        self.assertIn("ENCRYPTED iPhone backup", text)
        self.assertIn("Encrypt local backup", text)
        self.assertIn("Threadback", text)

    def test_folder_that_is_not_a_backup(self):
        folder = tempfile.mkdtemp(prefix="wrapped-empty-")
        try:
            with self.assertRaises(db.DatabaseError) as caught:
                wrapped.open_source(backup=folder)
            self.assertIn("does not look like an iPhone backup", str(caught.exception))
            with self.assertRaises(db.DatabaseError):
                wrapped.open_source(backup=os.path.join(folder, "missing"))
        finally:
            shutil.rmtree(folder, ignore_errors=True)


class Contacts(unittest.TestCase):
    def test_mac_address_books_are_merged(self):
        pairs = db.load_mac_contacts([support.path("address_book_dir")])
        names = dict(pairs)
        self.assertEqual(names["(555) 010-0001"], "Ines Calloway")
        self.assertEqual(names["Ines.Calloway@Example.com"], "Ines Calloway")
        self.assertEqual(names["+1 (555) 010-0005"], "Zo\xeb M\xfcller")
        self.assertEqual(names["555-010-0099"], "Pizza Planet")       # organisation fallback
        self.assertEqual(names["555-010-0098"], "Coach")              # nickname fallback
        self.assertEqual(names["SOLO@EXAMPLE.COM"], "Solo")           # from the second book
        self.assertNotIn("555-010-0097", names)                       # nameless card
        folder, info = support.fixture()
        single = db.load_contacts(os.path.join(folder, info["paths"]["address_books"][0]))
        self.assertEqual(single, [("SOLO@EXAMPLE.COM", "Solo")])

    def test_iphone_address_book(self):
        ios = dict(db.load_contacts(support.path("backup_address_book")))
        mac = dict(db.load_mac_contacts([support.path("address_book_dir")]))
        self.assertEqual(ios, mac)

    def test_contacts_argument_forms(self):
        book = support.path("address_book_dir")
        pairs = db.load_mac_contacts([book])
        results = []
        for contacts in (book, [book], pairs, dict(pairs), support.fixture()[1]["paths"]["address_books"]):
            if isinstance(contacts, list) and contacts and isinstance(contacts[0], str) \
                    and not os.path.isabs(contacts[0]):
                contacts = [os.path.join(support.fixture()[0], c) for c in contacts]
            with wrapped.open_source(db=support.path("chat_db"), contacts=contacts) as source:
                results.append(source.stats("Book Club", year=2026, tz=LA, now=NOW))
        for other in results[1:]:
            self.assertEqual(other, results[0])
        self.assertEqual(results[0]["senders"][0]["name"], "Nora Quill")

    def test_not_an_address_book(self):
        with self.assertRaises(db.DatabaseError) as caught:
            db.load_contacts(support.path("legacy_db"))
        self.assertEqual(caught.exception.code, "schema")
        self.assertEqual(db.load_mac_contacts([support.path("legacy_db")]), [])


class OldAndOddDatabases(unittest.TestCase):
    def test_legacy_schema(self):
        with wrapped.open_source(db=support.path("legacy_db"), contacts=False) as source:
            chats = source.chats()
            self.assertEqual([c["name"] for c in chats], ["Old Friends"])
            self.assertEqual(chats[0]["messages"], 5)
            st = source.stats("Old Friends", year=2016, tz="UTC", now=NOW)
        self.assertEqual(st["totals"], {"messages": 4, "words": 8, "attachments": 1, "reactions": 0,
                                        "days_active": 2, "longest_streak": 2})
        self.assertEqual(st["period"], {"label": "2016", "start": "2016-01-01", "end": "2016-12-31"})
        self.assertEqual(st["by_hour"][19], 3)
        self.assertEqual(st["by_hour"][3], 1)
        self.assertEqual([s["name"] for s in st["senders"]], ["\u20260001", "Me", "\u20260002"])

    def test_invalid_utf8_in_a_text_column(self):
        with mac_source() as source:
            chat = source.chat("Bram, Sam")
            rows = db.load_rows(source.conn, chat["chat_ids"])
        bad = [r for r in rows if isinstance(r["text"], str) and r["text"].startswith("bad ")]
        self.assertEqual([r["text"] for r in bad], ["bad \ufffd\ufffd bytes in a text column"])
        st = compute_stats(bad, tz="UTC", all_time=True, now=NOW)
        self.assertEqual(st["totals"]["words"], 6)

    def test_rows_have_the_documented_shape(self):
        with mac_source() as source:
            rows = db.load_rows(source.conn, source.chat("Book Club")["chat_ids"])
        self.assertEqual(set(rows[0]), {
            "rowid", "guid", "date", "is_from_me", "handle", "text", "attributedBody",
            "cache_has_attachments", "item_type", "associated_message_type",
            "associated_message_guid"})
        self.assertEqual(len({r["rowid"] for r in rows}), len(rows))
        self.assertEqual([r["rowid"] for r in rows], sorted(r["rowid"] for r in rows))
        body_only = [r for r in rows if r["text"] is None and r["attributedBody"]]
        self.assertGreaterEqual(len(body_only), 5)
        both = [r for r in rows if r["text"] and r["attributedBody"]]
        self.assertEqual(both, [])        # the blob is only fetched when it is needed

    def test_not_a_messages_database(self):
        with self.assertRaises(db.DatabaseError) as caught:
            wrapped.list_chats(db=support.path("backup_address_book"), contacts=False)
        self.assertEqual(caught.exception.code, "schema")
        self.assertIn("not a Messages database", str(caught.exception))

    def test_missing_empty_and_non_sqlite_files(self):
        folder = tempfile.mkdtemp(prefix="wrapped-bad-")
        try:
            cases = {"missing.db": None, "empty.db": b"", "noise.db": b"\x8a" * 4096}
            codes = {}
            for name, content in cases.items():
                target = os.path.join(folder, name)
                if content is not None:
                    with open(target, "wb") as handle:
                        handle.write(content)
                with self.assertRaises(db.DatabaseError) as caught:
                    wrapped.open_source(db=target, contacts=False)
                codes[name] = caught.exception.code
            self.assertEqual(codes, {"missing.db": "missing", "empty.db": "not_sqlite",
                                     "noise.db": "not_sqlite"})
            with self.assertRaises(db.DatabaseError) as caught:
                wrapped.open_source(db=folder, contacts=False)
            self.assertIn("folder", str(caught.exception))
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def test_full_disk_access_explanation(self):
        error = db._access_error("/Users/someone/Library/Messages/chat.db",
                                 sqlite3.OperationalError("unable to open database file"))
        self.assertEqual(error.code, "permission")
        text = str(error)
        for phrase in ("Full Disk Access", "System Settings", "Privacy & Security", "terminal",
                       "Threadback", "/Users/someone/Library/Messages/chat.db"):
            self.assertIn(phrase, text)
        self.assertNotIn("iMessage Wrapped", text)
        denied = db._access_error("/tmp/x.db", PermissionError(1, "Operation not permitted"))
        self.assertEqual(denied.code, "permission")
        other = db._access_error("/tmp/x.db", sqlite3.OperationalError("disk I/O error"))
        self.assertEqual(other.code, "open")
        damaged = db._access_error("/tmp/x.db", sqlite3.DatabaseError("file is not a database"))
        self.assertEqual(damaged.code, "corrupt")
        self.assertNotIn("\n", str(damaged))

    def test_paths_with_awkward_characters(self):
        folder = tempfile.mkdtemp(prefix="wrapped odd #1 50% ?x=")
        try:
            target = os.path.join(folder, "copy of chat (2) #final?.db")
            shutil.copyfile(support.path("legacy_db"), target)
            with wrapped.open_source(db=target, contacts=False) as source:
                self.assertEqual([c["name"] for c in source.chats()], ["Old Friends"])
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def test_default_locations(self):
        self.assertTrue(db.default_chat_db().endswith(os.path.join("Library", "Messages", "chat.db")))
        self.assertIsInstance(db.default_address_books(), list)


if __name__ == "__main__":
    unittest.main()
