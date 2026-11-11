import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import mac_support
from mac_support import FixtureDb, attributed_body, simple_decode

from wrapped.mac import chatdb, send
from wrapped.mac.engine import ChatRef
from wrapped.mac.send import (
    DELIVERED,
    DRY_RUN,
    FAILED,
    UNVERIFIED,
    DryRunSender,
    MessagesSender,
    OsaResult,
    SEND_SCRIPT,
)

ERR_1728 = 'execution error: Messages got an error: Can’t get chat id "any;+;chat111". (-1728)\n'
ERR_1743 = "execution error: Not authorized to send Apple events to Messages. (-1743)\n"


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = 0
        self.on_sleep = None

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps += 1
        self.now += seconds
        if self.on_sleep:
            self.on_sleep(self.sleeps)


class SenderCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.db = FixtureDb(self.dir / "fixture-chat.db")
        self.chat_id = self.db.add_chat("chat111", "Dinner Club")
        self.other_id = self.db.add_chat("chat222", "Other Group")
        self.chat = ChatRef(guid="any;+;chat111", identifier="chat111", name="Dinner Club", rowid=self.chat_id)
        self.db.add_message("hello", chat=self.chat_id)
        self.clock = FakeClock()
        self.calls = []
        self.card = self.dir / "card.png"
        self.card.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def sender(self, script, **kw):
        """``script(n, guid, text, file)`` plays Messages: it may write rows and returns an OsaResult."""

        def runner(source, args, timeout):
            self.calls.append((source, list(args), timeout))
            return script(len(self.calls), *args)

        kw.setdefault("decode", lambda text, body: text if text else simple_decode(body))
        return MessagesSender(
            self.db.path,
            runner=runner,
            staging=self.dir / "Pictures" / "Threadback",
            sleep=self.clock.sleep,
            monotonic=self.clock.monotonic,
            **kw,
        )

    def deliver(self, text="", file="", chat=None, **kw):
        return self.db.add_message(
            None if file else text,
            body=None if file else None,
            chat=self.chat_id if chat is None else chat,
            is_from_me=True,
            attachment=bool(file),
            **kw,
        )

    # -- argv ---------------------------------------------------------------

    def test_text_guid_and_path_travel_as_argv_never_in_the_script(self):
        nasty = 'he said "hi" \\ & `id`; $(rm -rf ~) \n" & (do shell script "x") & "\n-e evil'
        rowids = []

        def script(n, guid, text, file):
            rowids.append(self.deliver(text))
            return OsaResult(0)

        res = self.sender(script).send_text(self.chat, nasty)
        self.assertEqual(res.status, DELIVERED)
        self.assertEqual(res.rowid, rowids[0])
        source, args, timeout = self.calls[0]
        self.assertIs(source, SEND_SCRIPT)
        self.assertEqual(args, ["any;+;chat111", nasty, ""])
        self.assertEqual(timeout, 30.0)
        self.assertNotIn("hi", SEND_SCRIPT)
        self.assertNotIn("chat111", SEND_SCRIPT)

    def test_run_osascript_builds_a_shell_free_argv(self):
        seen = {}

        def fake_run(cmd, **kw):
            seen["cmd"], seen["kw"] = cmd, kw
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with mock.patch.object(send, "find_osascript", return_value="/usr/bin/osascript"), mock.patch.object(
            send.subprocess, "run", fake_run
        ):
            out = send.run_osascript(SEND_SCRIPT, ["any;+;chat1", 'a "quoted" $HOME', ""], 12.5)
        self.assertEqual(out.returncode, 0)
        self.assertEqual(seen["cmd"], ["/usr/bin/osascript", "-e", SEND_SCRIPT, "any;+;chat1", 'a "quoted" $HOME', ""])
        self.assertEqual(seen["kw"]["timeout"], 12.5)
        self.assertNotIn("shell", seen["kw"])

    def test_run_osascript_timeout_and_missing(self):
        def boom(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, kw["timeout"])

        with mock.patch.object(send, "find_osascript", return_value="/usr/bin/osascript"), mock.patch.object(
            send.subprocess, "run", boom
        ):
            self.assertTrue(send.run_osascript(SEND_SCRIPT, ["g", "t", ""], 1).timed_out)
        with mock.patch.object(send, "find_osascript", return_value=None):
            self.assertTrue(send.run_osascript(SEND_SCRIPT, ["g", "t", ""], 1).missing)

    def test_script_shape(self):
        self.assertIn("on run argv", SEND_SCRIPT)
        self.assertIn("chat id chatGuid", SEND_SCRIPT)
        self.assertIn("send messageText to targetChat", SEND_SCRIPT)
        self.assertIn("POSIX file filePath", SEND_SCRIPT)
        self.assertNotIn("do shell script", SEND_SCRIPT)
        self.assertNotIn("send", send.LIST_CHATS_SCRIPT)  # the diagnostic can never send

    # -- verification outcomes ------------------------------------------------

    def test_join_row_arriving_late_still_verifies(self):
        state = {}

        def script(n, guid, text, file):
            state["rowid"] = self.db.add_message(text, is_from_me=True)  # no join yet
            return OsaResult(0)

        def on_sleep(count):
            if count == 3:
                self.db.join(self.chat_id, state["rowid"])

        self.clock.on_sleep = on_sleep
        res = self.sender(script).send_text(self.chat, "recap text")
        self.assertEqual(res.status, DELIVERED)
        self.assertEqual(res.rowid, state["rowid"])
        self.assertEqual(self.clock.sleeps, 3)

    def test_success_with_no_row_is_unverified_and_never_retried(self):
        res = self.sender(lambda n, g, t, f: OsaResult(0)).send_text(self.chat, "recap text")
        self.assertEqual(res.status, UNVERIFIED)
        self.assertIn("no outgoing message appeared", res.reason)
        self.assertFalse(res.orphan)
        self.assertEqual(len(self.calls), 1)
        self.assertGreaterEqual(self.clock.now, 8.0)  # waited the full window
        self.assertLess(self.clock.now, 9.0)

    def test_orphan_row_is_reported_as_the_macos26_symptom(self):
        def script(n, guid, text, file):
            self.db.add_message(None, is_from_me=True)  # empty row joined to no chat
            return OsaResult(0)

        res = self.sender(script).send_text(self.chat, "recap text")
        self.assertEqual(res.status, UNVERIFIED)
        self.assertTrue(res.orphan)
        self.assertIn("attached to no chat", res.reason)
        self.assertIn("NOT delivered", res.reason)
        self.assertEqual(len(self.calls), 1)

    def test_row_in_another_chat_does_not_count(self):
        def script(n, guid, text, file):
            self.deliver(text, chat=self.other_id)
            return OsaResult(0)

        res = self.sender(script).send_text(self.chat, "recap text")
        self.assertEqual(res.status, UNVERIFIED)

    def test_sms_variant_of_the_same_group_counts(self):
        sms_row = self.db.add_chat("chat111", "Dinner Club", guid="SMS;+;chat111")

        def script(n, guid, text, file):
            self.deliver(text, chat=sms_row)
            return OsaResult(0)

        self.assertEqual(self.sender(script).send_text(self.chat, "recap text").status, DELIVERED)

    def test_row_with_error_code_is_failed(self):
        def script(n, guid, text, file):
            self.deliver(text, error=22)
            return OsaResult(0)

        res = self.sender(script).send_text(self.chat, "recap text")
        self.assertEqual(res.status, FAILED)
        self.assertIn("error code 22", res.reason)

    def test_owner_typing_at_the_same_moment_is_not_mistaken_for_the_send(self):
        def script(n, guid, text, file):
            self.deliver("something the owner typed on their phone")
            return OsaResult(0)

        self.assertEqual(self.sender(script).send_text(self.chat, "recap text").status, UNVERIFIED)

    def test_attributed_body_only_row_is_matched_by_decoding(self):
        def script(n, guid, text, file):
            self.db.add_message(None, body=attributed_body(text), chat=self.chat_id, is_from_me=True)
            return OsaResult(0)

        self.assertEqual(self.sender(script).send_text(self.chat, "🧵 recap\n💬 two lines").status, DELIVERED)

    # -- the -1728 swap -----------------------------------------------------------

    def test_1728_gets_one_swap_retry_and_the_working_form_is_remembered(self):
        def script(n, guid, text, file):
            if ";+;" in guid:
                return OsaResult(1, "", ERR_1728)
            self.deliver(text)
            return OsaResult(0)

        sender = self.sender(script)
        res = sender.send_text(self.chat, "first")
        self.assertEqual(res.status, DELIVERED)
        self.assertTrue(res.swapped)
        self.assertEqual(res.guid, "any;-;chat111")
        self.assertEqual([c[1][0] for c in self.calls], ["any;+;chat111", "any;-;chat111"])
        res2 = sender.send_text(self.chat, "second")
        self.assertEqual(res2.status, DELIVERED)
        self.assertEqual([c[1][0] for c in self.calls][2:], ["any;-;chat111"])  # straight to the working form

    def test_1728_on_both_forms_fails_after_exactly_two_attempts(self):
        res = self.sender(lambda n, g, t, f: OsaResult(1, "", ERR_1728)).send_text(self.chat, "x")
        self.assertEqual(res.status, FAILED)
        self.assertEqual(len(self.calls), 2)
        self.assertIn("-1728", res.reason)
        self.assertIn("both", res.reason)
        self.assertEqual(res.hint, send.CHAT_NOT_FOUND_HINT)

    def test_swap_then_silent_nothing_is_not_retried_again(self):
        def script(n, guid, text, file):
            if ";+;" in guid:
                return OsaResult(1, "", ERR_1728)
            self.db.add_message(None, is_from_me=True)  # "success" that wrote an orphan row
            return OsaResult(0)

        res = self.sender(script).send_text(self.chat, "x")
        self.assertEqual(res.status, UNVERIFIED)
        self.assertTrue(res.orphan and res.swapped)
        self.assertEqual(len(self.calls), 2)

    def test_old_style_guid_swaps_too_and_other_shapes_do_not_retry(self):
        self.assertEqual(send.swap_guid_form("iMessage;+;chat9"), "iMessage;-;chat9")
        self.assertEqual(send.swap_guid_form("any;-;chat9"), "any;+;chat9")
        self.assertEqual(send.swap_guid_form("weird-guid"), "weird-guid")
        odd = ChatRef(guid="weird-guid", identifier="chat111", name="Dinner Club")
        res = self.sender(lambda n, g, t, f: OsaResult(1, "", ERR_1728)).send_text(odd, "x")
        self.assertEqual(res.status, FAILED)
        self.assertEqual(len(self.calls), 1)

    def test_other_errors_are_never_retried(self):
        for stderr in (ERR_1743, "execution error: Messages got an error: something else (-50)\n", ""):
            with self.subTest(stderr=stderr):
                self.calls.clear()
                res = self.sender(lambda n, g, t, f, s=stderr: OsaResult(1, "", s)).send_text(self.chat, "x")
                self.assertEqual(res.status, FAILED)
                self.assertEqual(len(self.calls), 1)

    # -- error mapping ------------------------------------------------------------

    def test_automation_denied_maps_to_instructions(self):
        res = self.sender(lambda n, g, t, f: OsaResult(1, "", ERR_1743)).send_text(self.chat, "x")
        self.assertEqual(res.status, FAILED)
        self.assertIn("Automation", res.reason)
        self.assertIn("Privacy & Security > Automation", res.hint)
        self.assertIn("Messages", res.hint)

    def test_error_explanations(self):
        table = [
            (OsaResult(1, "", "37:60: execution error: Not authorized to send Apple events to Messages. (-1743)"), "Automation"),
            (OsaResult(1, "", "execution error: Messages got an error: Application isn’t running. (-600)"), "not running"),
            (OsaResult(1, "", "execution error: Messages got an error: AppleEvent timed out. (-1712)"), "too long"),
            (OsaResult(1, "", 'execution error: File some/file wasn’t found. (-43)'), "attachment"),
            (OsaResult(1, "", "execution error: Can’t make file into type alias. (-1700)"), "attachment"),
            (OsaResult(124, "", "timed out after 30 s", timed_out=True), "did not answer"),
            (OsaResult(127, "", "", missing=True), "not available"),
            (OsaResult(1, "", "syntax error: something odd (-2741)"), "osascript failed (exit 1)"),
        ]
        for result, needle in table:
            with self.subTest(needle=needle):
                reason, _hint = send.explain_osascript_error(result)
                self.assertIn(needle, reason)
        self.assertEqual(send.osa_error_number(ERR_1728), -1728)
        self.assertIsNone(send.osa_error_number("no number here"))

    def test_timeout_fails_unless_the_message_is_actually_there(self):
        res = self.sender(lambda n, g, t, f: OsaResult(124, "", "timed out after 30 s", timed_out=True)).send_text(
            self.chat, "x"
        )
        self.assertEqual(res.status, FAILED)
        self.assertIn("no outgoing message appeared", res.reason)
        self.assertEqual(len(self.calls), 1)

        def slow_but_sent(n, guid, text, file):
            self.deliver(text)
            return OsaResult(124, "", "timed out after 30 s", timed_out=True)

        self.calls.clear()
        res = self.sender(slow_but_sent).send_text(self.chat, "y")
        self.assertEqual(res.status, DELIVERED)
        self.assertIn("timed out", res.reason)

    def test_not_macos(self):
        res = self.sender(lambda n, g, t, f: OsaResult(127, missing=True)).send_text(self.chat, "x")
        self.assertEqual(res.status, FAILED)
        self.assertEqual(res.hint, send.NOT_MACOS_HINT)

    def test_unreadable_database_means_nothing_is_sent(self):
        sender = MessagesSender(
            self.dir / "Library" / "Messages" / "chat.db",
            runner=lambda *a: self.fail("osascript must not run when chat.db cannot be read"),
            sleep=self.clock.sleep,
            monotonic=self.clock.monotonic,
        )
        res = sender.send_text(self.chat, "x")
        self.assertEqual(res.status, FAILED)
        self.assertIn("nothing was sent", res.reason)
        self.assertIn("Full Disk Access", res.hint)

    def test_full_disk_access_errors_map_to_instructions(self):
        for msg in ("unable to open database file", "authorization denied", "Operation not permitted"):
            with self.subTest(msg=msg):
                err = chatdb.explain_db_error(sqlite3.OperationalError(msg), "/Users/x/Library/Messages/chat.db")
                self.assertIn("Full Disk Access", err.hint)
                self.assertIn("Privacy & Security", err.hint)
        self.assertEqual(chatdb.explain_db_error(sqlite3.DatabaseError("file is not a database"), "x").hint, "")

    def test_empty_text_and_bad_guid_are_refused_before_osascript(self):
        sender = self.sender(lambda n, g, t, f: self.fail("must not run"))
        self.assertEqual(sender.send_text(self.chat, "  ").status, FAILED)
        self.assertEqual(sender.send_text(ChatRef(guid="-e", identifier="", name="x"), "hi").status, FAILED)
        self.assertEqual(sender.send_text(ChatRef(guid="", identifier="", name="x"), "hi").status, FAILED)
        self.assertEqual(sender.send_file(self.chat, self.dir / "missing.png").status, FAILED)
        self.assertEqual(self.calls, [])

    # -- attachments ------------------------------------------------------------

    def test_file_is_staged_under_pictures_and_sent_alone(self):
        def script(n, guid, text, file):
            self.assertEqual(text, "")
            self.assertTrue(Path(file).is_file())
            self.deliver(file=file)
            return OsaResult(0)

        res = self.sender(script).send_file(self.chat, self.card)
        self.assertEqual(res.status, DELIVERED)
        self.assertEqual(res.kind, "file")
        staged = Path(self.calls[0][1][2])
        self.assertEqual(staged.parent, self.dir / "Pictures" / "Threadback")
        self.assertNotEqual(staged, self.card)
        self.assertEqual(staged.read_bytes(), self.card.read_bytes())
        self.assertTrue(staged.name.startswith("threadback-"))

    def test_file_send_needs_an_attachment_row(self):
        def script(n, guid, text, file):
            self.deliver("owner typed text at the same time")
            return OsaResult(0)

        self.assertEqual(self.sender(script).send_file(self.chat, self.card).status, UNVERIFIED)

    def test_attachment_row_without_the_flag_counts_when_it_has_no_typed_text(self):
        def script(n, guid, text, file):
            self.db.add_message(None, chat=self.chat_id, is_from_me=True)  # schema without the flag set
            return OsaResult(0)

        self.assertEqual(self.sender(script).send_file(self.chat, self.card).status, DELIVERED)

    def test_text_match_ignores_whitespace_differences(self):
        def script(n, guid, text, file):
            self.deliver(text.replace("\n", "\r") + "  ")
            return OsaResult(0)

        self.assertEqual(self.sender(script).send_text(self.chat, "line one\nline two").status, DELIVERED)

    def test_default_staging_dir_is_inside_pictures(self):
        self.assertEqual(send.staging_dir(), Path.home() / "Pictures" / "Threadback")

    def test_staging_gives_unique_names_and_prunes_only_its_own_files(self):
        target = self.dir / "Pictures" / "Threadback"
        target.mkdir(parents=True)
        keepsake = target / "family-photo.png"
        keepsake.write_bytes(b"not ours")
        first = send.stage_attachment(self.card, target, keep=3)
        second = send.stage_attachment(self.card, target, keep=3)
        self.assertNotEqual(first.name, second.name)  # never overwrites a staged file
        self.assertTrue(first.exists() and second.exists())
        made = [send.stage_attachment(self.card, target, keep=3) for _ in range(6)]
        left = sorted(p.name for p in target.iterdir())
        self.assertIn("family-photo.png", left)
        self.assertEqual(len([n for n in left if n.startswith("threadback-")]), 3)
        self.assertTrue(made[-1].exists())


class DryRun(unittest.TestCase):
    def test_records_and_never_touches_osascript(self):
        chat = ChatRef(guid="any;+;chat1", identifier="chat1", name="Dinner Club")
        with mock.patch.object(send, "run_osascript", side_effect=AssertionError("osascript in a dry run")), mock.patch.object(
            send.subprocess, "run", side_effect=AssertionError("subprocess in a dry run")
        ):
            sender = DryRunSender()
            a = sender.send_file(chat, "/tmp/card.png")
            b = sender.send_text(chat, "hello")
        self.assertEqual((a.status, b.status), (DRY_RUN, DRY_RUN))
        self.assertTrue(a.sent_something)
        self.assertEqual([s["kind"] for s in sender.sent], ["file", "text"])
        self.assertEqual(sender.sent[1]["text"], "hello")
        self.assertEqual(sender.sent[0]["chat"], "chat1")


if __name__ == "__main__":
    unittest.main()
