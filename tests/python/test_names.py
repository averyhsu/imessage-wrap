"""Names in a recap (docs/SCHEMA.md section 2): clean names, masking, short names.

The hand-written expectations are in tests/conformance/names.json, which the
JavaScript tests read as well, so both engines answer to the same table. The
last class checks, end to end, that no phone number, address or control
character reaches the stats JSON, the share link or the ``wrapped chats``
listing, for the ordinary fixture and for the hostile one.
"""

import copy
import json
import sqlite3
import unicodedata
import unittest

import support
from support import NOW, msg, tap

import wrapped
from wrapped import payload, stats as S

VECTORS = support.names_vectors()
FIXTURE = support.build_fixture
utc = FIXTURE.utc
ME = "\x07Avery\u202e\r\nQuinn\x7f"            # cleans to "Avery Quinn"


def run(rows, **options):
    options.setdefault("tz", "UTC")
    options.setdefault("now", NOW)
    options.setdefault("all_time", True)
    return S.compute_stats(rows, options)


class CleanNames(unittest.TestCase):
    def test_table(self):
        self.assertGreater(len(VECTORS["clean"]), 20)
        for raw, expected in VECTORS["clean"]:
            self.assertEqual(S.clean_name(raw), expected, repr(raw))
        self.assertIs(wrapped.clean_name, S.clean_name)

    def test_every_dangerous_character_is_dropped(self):
        removed = (list(range(0x00, 0x20)) + list(range(0x7F, 0xA0)) + list(range(0x202A, 0x202F))
                   + list(range(0x2066, 0x206A)) + [0xFFFC, 0xFFFD])
        for code in removed:
            expected = "a b" if code in (0x09, 0x0A, 0x0D) else "ab"
            self.assertEqual(S.clean_name("a%sb" % chr(code)), expected, hex(code))
        for code in (0x2028, 0x2029):                 # line and paragraph separators as well
            self.assertEqual(S.clean_name("a%sb" % chr(code)), "a b", hex(code))
        for keep in ("\u200d", "\u200b", "\ufe0f", "\xe9", "\U0001F32E", "\u0301", "\xa0"):
            self.assertEqual(S.clean_name("a%sb" % keep), "a%sb" % keep, repr(keep))

    def test_cleaning_is_stable_and_leaves_no_control_characters(self):
        for raw, _expected in VECTORS["clean"] + VECTORS["mask"] + VECTORS["chat_names"]:
            once = S.clean_name(raw)
            self.assertEqual(S.clean_name(once), once, repr(raw))
            self.assertEqual([f for f in support.text_leaks(once) if "control" in f], [], repr(raw))

    def test_every_name_that_reaches_the_stats_is_clean(self):
        t = utc(2026, 5, 5, 10, 0)
        evil = "Mal\x1b[31m\u202eory\r\nX\x00"
        rows = [msg(t, evil, "hello", guid="G1"), msg(t + 60, "me", "hi", guid="G2"),
                msg(t + 120, "+15550100020", "yo"), tap(t + 180, evil, 2000, {"guid": "G2"}),
                tap(t + 200, "me", 2003, {"guid": "G1"})]
        contacts = {"+15550100020": "Tab\tby \x1b[0mCat"}
        st = run(rows, me=ME, chat_name="Chat\x07 \u2066name\u2069\t!", label="La\x1bbel\n2",
                 source="chat\x00.db", contacts=contacts, participants=[evil, "+15550100020"])
        self.assertEqual(st["chat"], {"name": "Chat name !", "members": 3})
        self.assertEqual(st["period"]["label"], "Label 2")
        self.assertEqual(st["meta"]["source"], "chat.db")
        self.assertEqual(sorted(s["name"] for s in st["senders"]),
                         ["Avery Quinn", "Mal[31mory X", "Tab by [0mCat"])
        self.assertIn(st["reactions"]["top_giver"]["name"], ("Avery Quinn", "Mal[31mory X"))
        self.assertEqual(support.leaks(st), [])
        # a chat without a name of its own is called after its (clean) members
        st = run(rows, me=ME, contacts=contacts, participants=[evil, "+15550100020"])
        self.assertEqual(st["chat"]["name"], "Mal[31mory, Tab")
        self.assertEqual(support.leaks(st), [])
        # nothing left of a name: the fallbacks
        st = run([msg(t, "\x1b\x07\u202e")], me="\x00", chat_name="\x1b")
        self.assertEqual(st["senders"][0]["name"], "Unknown")
        self.assertEqual(run([msg(t)], me="\x00\t")["senders"][0]["name"], "Me")
        self.assertEqual(run([msg(t)], chat_name="\x1b\x07")["chat"]["name"], "Unnamed group")


class Masking(unittest.TestCase):
    def test_table(self):
        self.assertGreater(len(VECTORS["mask"]), 40)
        for raw, expected in VECTORS["mask"]:
            self.assertEqual(S.mask_handle(S.clean_name(raw)), expected, repr(raw))
        self.assertIs(wrapped.mask_handle, S.mask_handle)

    def test_what_comes_out_holds_nothing_private(self):
        for raw, _expected in VECTORS["mask"]:
            shown = S.mask_handle(S.clean_name(raw))
            self.assertEqual(support.text_leaks(shown), [], repr(raw))
            self.assertLess(support.count_decimals(shown), 7, repr(raw))
            self.assertEqual(S.mask_handle(S.clean_name(shown)), shown, repr(raw))     # stable

    def test_chat_names(self):
        for display, expected in VECTORS["chat_names"]:
            self.assertEqual(S.chat_display_name(display, [], None, "Me"), expected, repr(display))
        t = utc(2026, 5, 5, 10, 0)
        self.assertEqual(run([msg(t)], chat_name="+1 (555) 010-0142")["chat"]["name"], "\u20260142")
        self.assertEqual(run([msg(t)], chat_name="Party <party.planning@example.com>")["chat"]["name"],
                         "party.planning")

    def test_the_digit_table_covers_every_decimal_digit(self):
        self.assertEqual(len(S._DIGITS), 10 * len(S._DIGIT_BLOCKS))
        known = [chr(c) for c in range(0x110000) if unicodedata.category(chr(c)) == "Nd"]
        self.assertGreaterEqual(len(known), 600)
        # the engine's table is Unicode 17; a newer runtime may know digits that it does not
        if tuple(int(part) for part in unicodedata.unidata_version.split(".")[:2]) <= (17, 0):
            self.assertEqual([hex(ord(ch)) for ch in known if ch not in S._DIGITS], [])
        self.assertEqual(len(S._DIGITS), 770)
        for ch in S._DIGITS:            # and nothing in the table is another kind of character
            self.assertIn(unicodedata.category(ch), ("Nd", "Cn"), hex(ord(ch)))
        for start in S._DIGIT_BLOCKS:
            label = chr(start) * 3 + chr(start + 9) * 4
            self.assertEqual(S.mask_handle(label), "\u2026" + label[-4:], hex(start))
            self.assertEqual(S.mask_handle(label[:6]), label[:6], hex(start))

    def test_every_way_round_the_first_mask_is_closed(self):
        """The handles from the review, as senders, tapback givers and members."""
        t = utc(2026, 5, 5, 10, 0)
        pairs = [(ident, label) for ident, label in FIXTURE.EVIL_HANDLES if isinstance(ident, str)]
        self.assertGreaterEqual(len(pairs), 20)
        for start in range(0, len(pairs), 10):          # a recap lists at most 12 senders
            group = [ident for ident, _label in pairs[start:start + 10]]
            labels = [label for _ident, label in pairs[start:start + 10]]
            rows = [msg(t + i, h, "hello there", guid="G%d" % i) for i, h in enumerate(group)]
            rows += [tap(t + 100 + i, h, 2003, rows[0]) for i, h in enumerate(group)]
            st = run(rows, participants=group, chat_name="")
            self.assertEqual(sorted(s["name"] for s in st["senders"]), sorted(labels))
            self.assertEqual(st["chat"]["members"], len(group) + 1)
            self.assertEqual(support.leaks(st), [], group)
            self.assertEqual(support.leaks(payload.stats_from_url(payload.build_link(st))), [])
        # a contact name still wins over the mask
        named = run([msg(t, "tel:+15550100123")], contacts={"(555) 010-0123": "Ines Calloway"})
        self.assertEqual(named["senders"][0]["name"], "Ines Calloway")


class ShortNames(unittest.TestCase):
    def test_table(self):
        self.assertGreater(len(VECTORS["short"]), 10)
        for case in VECTORS["short"]:
            self.assertEqual(S.short_forms(case["names"], case["me"]), case["expected"], case["names"])

    def recap(self):
        t = utc(2026, 5, 5, 3, 0)
        contacts = {"+15550100003": "Sam Rivera", "+15550100004": "Sam Chen",
                    "+15550100001": "Ines Calloway", "+15550100021": "Dave plumber"}
        people = ["+15550100003", "+15550100004", "+15550100001", "+15550100021", "+15550100022", "me"]
        rows = []
        for i in range(48):
            sender = people[(i * i + i // 5) % 6]
            rows.append(msg(t + i * 600, sender, "word " * (1 + i % 5), guid="G%d" % i))
        for i in range(30):
            rows.append(tap(t + 40000 + i, people[i % 6], 2003 if i % 2 else 2000, rows[(i * 7) % 12]))
        return run(rows, contacts=contacts, me="Avery Quinn", chat_name="Dinner")

    def test_a_whole_recap(self):
        full = self.recap()
        frozen = copy.deepcopy(full)
        short = wrapped.short_names(full, me="Avery Quinn")
        self.assertEqual(full, frozen)                                # the input is not modified
        expected = {"Sam Rivera": "Sam R.", "Sam Chen": "Sam C.", "Ines Calloway": "Ines",
                    "Dave plumber": "Dave", "\u20260022": "\u20260022", "Avery Quinn": "Avery Quinn"}
        self.assertEqual({s["name"] for s in full["senders"]}, set(expected))
        self.assertEqual([s["name"] for s in short["senders"]],
                         [expected[s["name"]] for s in full["senders"]])
        # every other place that names somebody uses the same replacement
        before, after = support.names_in(full), support.names_in(short)
        self.assertEqual([where for where, _name in before], [where for where, _name in after])
        places = {where.split("[")[0] for where, _name in before}
        self.assertEqual(places, {"chat.name", "senders", "late_night.top.name", "most_reacted",
                                  "reactions.top_giver.name", "reactions.top_receiver.name", "awards"})
        for (where, old), (_where, new) in zip(before, after):
            self.assertEqual(new, old if where == "chat.name" else expected[old], where)
        # and nothing else changes
        for key in full:
            if key not in ("senders", "late_night", "most_reacted", "reactions", "awards"):
                self.assertEqual(short[key], full[key], key)
        self.assertEqual([s["messages"] for s in short["senders"]],
                         [s["messages"] for s in full["senders"]])
        self.assertEqual(wrapped.short_names(short, me="Avery Quinn"), short)
        self.assertIs(wrapped.short_names, S.short_names)

    def test_the_owner_is_whoever_the_caller_says(self):
        full = self.recap()
        default = wrapped.short_names(full)             # me="Me": nobody here is called that
        self.assertIn("Avery", [s["name"] for s in default["senders"]])
        self.assertEqual(S.short_names(full, "Avery Quinn"), wrapped.short_names(full, me="Avery Quinn"))

    def test_compute_stats_itself_keeps_full_names(self):
        self.assertIn("Sam Rivera", [s["name"] for s in self.recap()["senders"]])

    def test_odd_input(self):
        self.assertEqual(wrapped.short_names({}), {})
        odd = {"senders": None, "awards": [None, 5, {"winner": 7}, {"winner": "Sam Rivera"}],
               "reactions": [], "late_night": {"top": None}, "most_reacted": "none"}
        expected = copy.deepcopy(odd)
        expected["awards"][3]["winner"] = "Sam"
        self.assertEqual(wrapped.short_names(odd), expected)
        self.assertEqual(wrapped.short_names([1, 2]), [1, 2])


class NothingPrivateIsShown(unittest.TestCase):
    """Stats JSON, share link and `wrapped chats`, through the command line."""

    def check(self, db_path, book, me, expected_names=None):
        source = ["--db", db_path, "--me", me] + (["--contacts", book] if book else ["--no-contacts"])
        chats = wrapped.list_chats(db=db_path, contacts=[book] if book else False, me=me)
        self.assertGreaterEqual(len(chats), 4)

        status, out, err = support.call_cli("chats", *source)
        self.assertEqual((status, err), (0, ""))
        self.assertEqual(support.text_leaks(out.replace("\n", " ")), [])
        lines = out.split("\n")
        rows = lines[3:3 + len(chats)]
        self.assertEqual(lines[3 + len(chats)], "")             # one row per chat, whatever its name
        self.assertEqual([row.split(None, 4)[4] for row in rows], [chat["name"] for chat in chats])
        self.assertEqual([int(row.split()[0]) for row in rows], [chat["id"] for chat in chats])
        if expected_names:
            shown = {chat["id"]: chat["name"] for chat in chats}
            for rowid, name in expected_names.items():
                self.assertEqual(shown[rowid], name)

        # --json is the listing for other programs (it has the raw handle ids): what it
        # prints cannot garble a terminal, and the names in it are the clean ones
        status, out, err = support.call_cli("chats", "--json", *source)
        self.assertEqual((status, err), (0, ""))
        self.assertEqual([f for f in support.text_leaks(out.replace("\n", " ")) if "control" in f], [])
        listing = json.loads(out)
        self.assertEqual(listing["chats"], json.loads(json.dumps(chats)))
        for chat in listing["chats"]:
            self.assertEqual(support.text_leaks(chat["name"] + " " + chat["display_name"]), [])

        seen = set()
        for chat in chats:
            period = ["--all-time", "--tz", "UTC"]
            for flags in ([], ["--full-names"]):
                status, out, err = support.call_cli("stats", str(chat["id"]), *period, *flags, *source)
                self.assertEqual((status, err), (0, ""), chat["id"])
                stats = json.loads(out)
                self.assertEqual(support.leaks(stats), [], (chat["id"], flags))
                if flags:
                    seen.update(sender["name"] for sender in stats["senders"])
            for flags in ([], ["--quotes"], ["--full-names", "--quotes"]):
                status, out, err = support.call_cli("link", str(chat["id"]), *period, *flags, *source)
                self.assertEqual(status, 0, (chat["id"], err))
                self.assertEqual(support.text_leaks(err.replace("\n", " ")), [])
                shared = payload.stats_from_url(out.strip())
                self.assertEqual(support.leaks(shared), [], (chat["id"], flags))
                if "--quotes" not in flags:
                    self.assertEqual({quote["text"] for quote in shared["most_reacted"]} - {""}, set())
        return seen

    def test_the_ordinary_fixture(self):
        book = support.path("address_book_dir")
        self.assertIn("Ines Calloway", self.check(support.path("chat_db"), book, "Me"))
        self.assertIn("\u20260001", self.check(support.path("chat_db"), None, "Avery"))

    def test_the_evil_fixture(self):
        info = support.fixture()[1]["evil"]
        names = {chat["rowid"]: chat["name"] for chat in info["chats"].values() if chat["name"]}
        seen = self.check(support.path("evil_db"), support.path("evil_address_book"), ME, names)
        for entry in info["handles"]:
            self.assertIn(entry["label"], seen)
        for entry in info["contacts"]:
            self.assertIn(entry["name"], seen)
        self.assertLessEqual({"Avery Quinn", "Unknown", info["stranger"]["label"]}, seen)
        seen = self.check(support.path("evil_db"), None, "Me", names)
        for entry in info["handles"]:
            self.assertIn(entry["label"], seen)
        self.assertIn("nick", seen)                     # nick@example.com without the address book

    def test_the_real_command_line_prints_no_escape_sequences(self):
        """Once through a real process: bytes on stdout, not just strings."""
        status, out, err = support.run_cli("chats", "--db", support.path("evil_db"), "--contacts",
                                           support.path("evil_address_book"), "--me", ME)
        self.assertEqual((status, err), (0, ""))
        self.assertEqual(support.text_leaks(out.replace("\n", " ")), [])
        self.assertEqual(len(out.split("\n")), 1 + 2 + 8 + 2 + 1)
        self.assertIn("Evil[31m name line two tab end", out)
        status, out, err = support.run_cli("link", "1", "--all-time", "--tz", "UTC", "--db",
                                           support.path("evil_db"), "--no-contacts")
        self.assertEqual((status, err), (0, ""))
        self.assertEqual(support.leaks(wrapped.stats_from_url(out.strip())), [])

    def test_a_chat_named_after_a_number_stays_masked_for_the_helper(self):
        info = support.fixture()[1]["evil"]["chats"]
        con = sqlite3.connect(support.path("evil_db"))
        try:
            first = {chat: message for chat, message in con.execute(
                "SELECT chat_id, MIN(message_id) FROM chat_message_join GROUP BY chat_id")}
        finally:
            con.close()
        for key in ("phone_name", "address_name", "control_name", "integer_name", "text_style"):
            found = wrapped.chat_for_message(support.path("evil_db"), first[info[key]["rowid"]])
            self.assertEqual(found["display_name"], info[key]["name"], key)
            self.assertEqual((found["style"], found["is_group"]), (43, True), key)
            self.assertEqual(support.text_leaks(found["display_name"]), [])
        blank = wrapped.chat_for_message(support.path("evil_db"), first[info["blank_name"]["rowid"]])
        self.assertEqual(blank["display_name"], "")


if __name__ == "__main__":
    unittest.main()
