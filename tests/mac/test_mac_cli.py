"""The helper end to end with the REAL stats engine, on the engine's own invented fixture.

Nothing here can send: every test either runs a dry run or replaces the sender
with a recorder, and ``osascript`` is patched to fail the test if it is reached.
"""

import contextlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import mac_support
from mac_support import APPLE_EPOCH, REPO_ROOT, attributed_body

_REAL_RUN = subprocess.run


class FakeStdin:
    def __init__(self, tty):
        self._tty = tty

    def isatty(self):
        return self._tty

    def read(self, *a):
        return ""

    def readline(self, *a):
        return ""


try:
    import wrapped
    import wrapped.cli
    from wrapped.mac import cli as mac_cli
    from wrapped.mac import send
    from wrapped.mac._real_engine import RealEngine
    from wrapped.mac.agent import Agent, AgentConfig
    from wrapped.mac.engine import ChatRef
    from wrapped.mac.send import DELIVERED, DryRunSender, SendResult

    sys.path.insert(0, str(REPO_ROOT / "tests" / "fixtures"))
    import build_fixture

    HAVE_ENGINE = True
except ImportError as exc:  # the core engine or its fixture builder is not there
    HAVE_ENGINE = False
    WHY = str(exc)

try:
    from PIL import Image

    HAVE_PILLOW = True
except ImportError:
    HAVE_PILLOW = False

_FIXTURE = {}


def setUpModule():
    if not HAVE_ENGINE:
        return
    root = tempfile.mkdtemp(prefix="threadback-clitest-")
    _FIXTURE["root"] = root
    _FIXTURE["info"] = build_fixture.build(os.path.join(root, "fx"))


def tearDownModule():
    if _FIXTURE.get("root"):
        shutil.rmtree(_FIXTURE["root"], ignore_errors=True)


def add_message(db_path, chat_rowid, text=None, body=None, when=None, is_from_me=0, handle_id=1):
    """Append one message row the way Messages would (a second writer on a WAL database)."""
    when = time.time() if when is None else when
    conn = sqlite3.connect(str(db_path))
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(message)")}
        values = {
            "guid": f"CLITEST-{time.time_ns()}",
            "text": text,
            "attributedBody": body,
            "handle_id": handle_id,
            "date": int((when - APPLE_EPOCH) * 1e9),
            "is_from_me": is_from_me,
            "service": "iMessage",
        }
        values = {k: v for k, v in values.items() if k in cols}
        names = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        cur = conn.execute(f"INSERT INTO message ({names}) VALUES ({marks})", list(values.values()))
        rowid = cur.lastrowid
        if chat_rowid is not None:
            conn.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)", (chat_rowid, rowid))
        conn.commit()
        return rowid
    finally:
        conn.close()


class FakeMessagesSender:
    """Stands in for MessagesSender in CLI tests: records, reports delivered."""

    instances = []

    def __init__(self, db_path, **kw):
        self.db_path = db_path
        self.sent = []
        FakeMessagesSender.instances.append(self)

    def send_text(self, chat, text):
        self.sent.append(("text", chat.guid, text))
        return SendResult(DELIVERED, "", "text", chat.guid, rowid=None)

    def send_file(self, chat, path):
        self.sent.append(("file", chat.guid, Path(path).name))
        return SendResult(DELIVERED, "", "file", chat.guid, rowid=None)


@unittest.skipUnless(HAVE_ENGINE, "the stats engine is not importable")
class EngineCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        shutil.copytree(os.path.join(_FIXTURE["root"], "fx", "mac"), self.dir / "mac")
        self.db = self.dir / "mac" / "chat.db"
        self.contacts = str(self.dir / "mac" / "AddressBook")
        self.chats = _FIXTURE["info"]["chats"]
        self.home = self.dir / "home"
        self.home.mkdir()
        self.state = self.dir / "tb" / "state.json"
        self.out = self.dir / "out"
        patches = [
            mock.patch.dict(os.environ, {"HOME": str(self.home), "THREADBACK_HOME": str(self.dir / "tb")}),
            mock.patch.object(send, "run_osascript", side_effect=AssertionError("osascript reached in a test")),
            mock.patch.object(mac_cli, "account_first_name", lambda: "Robin"),
            mock.patch.object(send.subprocess, "run", side_effect=AssertionError("subprocess reached in a test")),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        os.environ.pop("ANTHROPIC_API_KEY", None)
        FakeMessagesSender.instances = []

    def tearDown(self):
        self.tmp.cleanup()

    def max_rowid(self):
        conn = sqlite3.connect(str(self.db))
        try:
            return conn.execute("SELECT MAX(ROWID) FROM message").fetchone()[0]
        finally:
            conn.close()

    def run_cli(self, *argv, stdin_tty=False, answers=()):
        """Run the real ``wrapped`` CLI in-process. Returns (exit status, stdout, stderr)."""
        out, err = io.StringIO(), io.StringIO()
        replies = list(answers)

        def fake_input(prompt=""):
            out.write(prompt)
            if not replies:
                raise EOFError
            return replies.pop(0)

        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), mock.patch(
            "builtins.input", fake_input
        ), mock.patch.object(sys, "stdin", FakeStdin(stdin_tty)):
            try:
                code = wrapped.cli.main(list(argv))
            except SystemExit as exc:  # argparse usage errors
                code = exc.code
        return code, out.getvalue(), err.getvalue()

    def agent_args(self, *extra):
        return [
            "agent", "--db", str(self.db), "--contacts", self.contacts, "--state", str(self.state),
            "--no-log", *extra,
        ]


class RealEngineAdapter(EngineCase):
    def test_lists_group_chats_with_readable_names(self):
        chats = RealEngine(contacts=[self.contacts]).list_group_chats(self.db)
        by_key = {c.key: c for c in chats}
        lively = by_key[self.chats["lively"]["chat_identifier"]]
        self.assertEqual(lively.name, self.chats["lively"]["display_name"])
        self.assertGreaterEqual(lively.members, 3)
        self.assertEqual(len(by_key), len(chats))  # the iMessage and SMS rows of one group are one chat
        unnamed = by_key[self.chats["unnamed"]["chat_identifier"]]
        self.assertTrue(unnamed.name)  # derived from members, never empty

    def test_decodes_attributed_body_from_this_suites_blob_builder(self):
        engine = RealEngine()
        for text in ("/wrapped", "/Wrapped 2025", "héllo 🍝", "x" * 300):
            with self.subTest(text=text[:12]):
                self.assertEqual(engine.decode_text(None, attributed_body(text)), text)
        self.assertEqual(engine.decode_text("plain", None), "plain")
        self.assertEqual(engine.decode_text(None, None), "")

    def test_stats_for_year_all_and_default(self):
        engine = RealEngine(contacts=[self.contacts])
        ref = ChatRef(guid=self.chats["lively"]["guid"], identifier=self.chats["lively"]["chat_identifier"],
                      name="x", rowid=self.chats["lively"]["rowid"])
        year = engine.compute_stats(self.db, ref, "2026", "Amara")
        everything = engine.compute_stats(self.db, ref, "all", "Amara")
        self.assertEqual(year["v"], 1)
        self.assertEqual(year["period"]["label"], "2026")
        self.assertGreater(year["totals"]["messages"], 0)
        self.assertGreaterEqual(everything["totals"]["messages"], year["totals"]["messages"])
        self.assertIn("Amara", [s["name"] for s in everything["senders"]])
        link = engine.build_link(year, True)
        self.assertLessEqual(len(link), 4800)
        self.assertEqual(wrapped.stats_from_url(link)["totals"], year["totals"])
        bare = wrapped.stats_from_url(engine.build_link(year, False))
        self.assertTrue(all(m.get("text", "") == "" for m in bare.get("most_reacted", [])))


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
class AgentWithRealEngine(EngineCase):
    def make_agent(self, **kw):
        cfg = dict(db_path=self.db, state_path=self.state, chats=["taco"], dry_run=True, out_dir=self.out)
        cfg.update(kw)
        self.logs = []
        return Agent(AgentConfig(**cfg), RealEngine(contacts=[self.contacts]), DryRunSender(), log=self.logs.append)

    def test_typed_command_produces_a_real_card_text_and_link(self):
        agent = self.make_agent()
        self.assertEqual(agent.run_once(), 0)  # first pass: start from now
        add_message(self.db, self.chats["lively"]["rowid"], body=attributed_body("/wrapped 2026"))
        self.assertEqual(agent.run_once(), 1, self.logs)
        card, text, link = agent.sender.sent
        with Image.open(card["path"]) as im:
            self.assertEqual(im.size, (1080, 1350))
        self.assertIn(self.chats["lively"]["display_name"], text["text"])
        self.assertIn("2026 in review", text["text"])
        stats = wrapped.stats_from_url(link["text"])
        self.assertEqual(stats["chat"]["name"], self.chats["lively"]["display_name"])
        self.assertEqual(stats["period"]["label"], "2026")
        self.assertLessEqual(len(link["text"]), 4800)
        # the command row itself is counted like any other message
        self.assertGreater(stats["totals"]["messages"], 10)
        folder = next(self.out.iterdir())
        self.assertEqual(sorted(p.suffix for p in folder.iterdir()), [".png", ".txt", ".txt"])
        self.assertTrue(any("card=dry-run" in ln for ln in self.logs))

    def test_command_arriving_on_the_sms_row_replies_through_that_row(self):
        agent = self.make_agent()
        agent.run_once()
        add_message(self.db, self.chats["lively_sms"]["rowid"], text="/recap all")
        self.assertEqual(agent.run_once(), 1, self.logs)
        self.assertEqual(agent.sender.sent[0]["guid"], self.chats["lively_sms"]["guid"])
        self.assertIn(self.chats["lively"]["display_name"], agent.sender.sent[1]["text"])

    def test_other_chats_and_empty_periods(self):
        agent = self.make_agent()
        agent.run_once()
        add_message(self.db, self.chats["tiny"]["rowid"], text="/wrapped")  # not in the allowlist
        self.assertEqual(agent.run_once(), 0)
        add_message(self.db, self.chats["lively"]["rowid"], text="/wrapped 2009")  # nothing that year
        self.assertEqual(agent.run_once(), 1, self.logs)
        self.assertEqual([s["kind"] for s in agent.sender.sent], ["text"])
        self.assertIn("Nothing to recap in 2009", agent.sender.sent[0]["text"])


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
class AgentCommand(EngineCase):
    def test_help_lists_the_helper_commands(self):
        code, out, _ = self.run_cli("--help")
        self.assertEqual(code, 0)
        for name in ("agent", "preview", "card", "send-test", "doctor", "chats", "stats", "link"):
            self.assertIn(name, out)

    def test_scope_is_required(self):
        code, out, err = self.run_cli(*self.agent_args("--dry-run", "--once"))
        self.assertEqual(code, 2)
        self.assertIn("--chat", err)
        self.assertIn("--all-chats", err)
        code, _, err = self.run_cli(*self.agent_args("--dry-run", "--once", "--chat", "taco", "--all-chats"))
        self.assertEqual(code, 2)
        code, _, err = self.run_cli(*self.agent_args("--dry-run", "--once", "--chat", "no such chat"))
        self.assertEqual(code, 1)
        self.assertIn('no group chat matches --chat "no such chat"', err)

    def test_dry_run_once_end_to_end(self):
        before = self.max_rowid()
        add_message(self.db, self.chats["lively"]["rowid"], body=attributed_body("/wrapped 2026"))
        code, out, err = self.run_cli(
            *self.agent_args("--dry-run", "--once", "--chat", "taco", "--out", str(self.out), "--from-rowid", str(before))
        )
        self.assertEqual(code, 0, err + out)
        self.assertIn("DRY RUN: nothing will be sent", out)
        self.assertIn("Done: 1 command(s) answered.", out)
        folder = next(self.out.iterdir())
        png = next(folder.glob("*.png"))
        with Image.open(png) as im:
            self.assertEqual(im.size, (1080, 1350))
        self.assertIn("in review", (folder / "recap.txt").read_text(encoding="utf-8"))
        self.assertTrue((folder / "link.txt").read_text().startswith("https://"))
        # a dry run needs no consent and records none
        self.assertNotIn("send", json.loads(self.state.read_text()).get("consent", {}))

    def test_missing_database_explains_full_disk_access(self):
        missing = self.home / "Library" / "Messages" / "chat.db"
        code, _, err = self.run_cli("agent", "--db", str(missing), "--dry-run", "--once", "--chat", "x", "--no-log",
                                    "--state", str(self.state))
        self.assertEqual(code, 1)
        self.assertIn("Full Disk Access", err)

    def test_live_mode_refuses_off_macos(self):
        with mock.patch.object(send, "find_osascript", return_value=None):
            code, _, err = self.run_cli(*self.agent_args("--once", "--chat", "taco", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("needs macOS", err)

    def live(self, *extra, **kw):
        with mock.patch.object(send, "find_osascript", return_value="/usr/bin/osascript"), mock.patch.object(
            send, "MessagesSender", FakeMessagesSender
        ):
            return self.run_cli(*self.agent_args("--once", *extra), **kw)

    def test_live_mode_never_starts_without_consent(self):
        add_message(self.db, self.chats["lively"]["rowid"], text="/wrapped 2026")
        # not a terminal and no --yes: refuse, having said exactly what it would do
        code, out, err = self.live("--chat", "taco", "--from-rowid", "0")
        self.assertEqual(code, 2)
        self.assertIn("Replies are sent from YOUR Apple ID into these group chats when someone types /wrapped", out)
        self.assertIn('Your own messages appear under the name "Robin"', out)  # from the Mac account
        self.assertIn(self.chats["lively"]["display_name"], out)
        self.assertIn("--yes", err)
        # a terminal, and the owner says no
        code, out, err = self.live("--chat", "taco", "--from-rowid", "0", stdin_tty=True, answers=["n"])
        self.assertEqual(code, 1)
        self.assertIn("[y/N]", out)
        self.assertIn("Nothing was sent", err)
        # ... or just presses return
        code, _, _ = self.live("--chat", "taco", "--from-rowid", "0", stdin_tty=True, answers=[""])
        self.assertEqual(code, 1)
        self.assertEqual([s.sent for s in FakeMessagesSender.instances], [[], [], []])
        self.assertFalse(self.state.exists() and "send" in json.loads(self.state.read_text()).get("consent", {}))

    def test_live_mode_with_consent_replies_and_remembers_the_scope(self):
        before = self.max_rowid()
        add_message(self.db, self.chats["lively"]["rowid"], text="/wrapped 2026")
        code, out, err = self.live("--chat", "taco", "--from-rowid", str(before), stdin_tty=True, answers=["y"])
        self.assertEqual(code, 0, err + out)
        sent = FakeMessagesSender.instances[-1].sent
        self.assertEqual([s[0] for s in sent], ["file", "text", "text"])
        self.assertTrue(all(s[1] == self.chats["lively"]["guid"] for s in sent))
        self.assertTrue(sent[2][2].startswith("https://"))
        self.assertIn("card=delivered text=delivered link=delivered", out)
        # same scope again: no question, even without --yes and without a terminal
        code, out, err = self.live("--chat", "taco")
        self.assertEqual(code, 0, err)
        self.assertIn("You approved exactly this before", out)
        # a wider scope asks again
        code, out, err = self.live("--chat", "taco", "--chat", "book")
        self.assertEqual(code, 2)
        code, out, err = self.live("--all-chats")
        self.assertEqual(code, 2)
        self.assertIn("EVERY group chat on this Mac", out)
        code, out, err = self.live("--all-chats", "--yes")
        self.assertEqual(code, 0, err)

    def add_group(self, identifier, name):
        conn = sqlite3.connect(str(self.db))
        try:
            cur = conn.execute(
                "INSERT INTO chat (guid, style, chat_identifier, display_name) VALUES (?, 43, ?, ?)",
                (f"iMessage;+;{identifier}", identifier, name),
            )
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()

    def test_a_new_chat_with_a_matching_name_needs_fresh_approval(self):
        code, out, err = self.live("--chat", "taco", stdin_tty=True, answers=["y"])
        self.assertEqual(code, 0, err + out)
        self.assertIn("Only these exact chats", out)
        strangers = self.add_group("chat900000000000000009", "Taco night with strangers")
        add_message(self.db, strangers, text="/wrapped 2026")
        # the same command again, unattended: the list is no longer what was approved
        code, out, err = self.live("--chat", "taco")
        self.assertEqual(code, 2, err + out)
        self.assertIn("Taco night with strangers", out)
        self.assertIn("--yes", err)
        self.assertEqual(FakeMessagesSender.instances[-1].sent, [])
        # ... and a dry run names exactly what it watches
        code, out, err = self.run_cli(*self.agent_args("--dry-run", "--once", "--chat", "taco", "--out", str(self.out)))
        self.assertEqual(code, 0, err + out)
        self.assertIn("Taco night with strangers", out)
        self.assertIn("created or renamed later needs a restart", out)

    def test_second_helper_on_the_same_state_is_refused(self):
        from wrapped.mac.agent import acquire_lock

        self.state.parent.mkdir(parents=True, exist_ok=True)
        lock = acquire_lock(str(self.state) + ".lock")
        try:
            code, _, err = self.run_cli(*self.agent_args("--dry-run", "--once", "--chat", "taco"))
        finally:
            lock.close()
        self.assertEqual(code, 1)
        self.assertIn("already running", err)

    def test_ai_needs_its_own_consent_and_falls_back_without_a_key(self):
        before = self.max_rowid()
        add_message(self.db, self.chats["lively"]["rowid"], text="/wrapped 2026")
        args = self.agent_args("--dry-run", "--once", "--chat", "taco", "--out", str(self.out), "--from-rowid", str(before), "--ai")
        with mock.patch("wrapped.mac.ai.urllib_transport", side_effect=AssertionError("network reached")):
            code, out, err = self.run_cli(*args)
            self.assertEqual(code, 2)
            self.assertIn("api.anthropic.com", out)
            self.assertIn("--ai-yes", err)
            code, out, err = self.run_cli(*args, stdin_tty=True, answers=["n"])
            self.assertEqual(code, 1)
            code, out, err = self.run_cli(*args, "--ai-yes")
            self.assertEqual(code, 0, err + out)
            self.assertIn("ANTHROPIC_API_KEY is not set", out)
            self.assertIn("keeping the built-in awards", out)
            self.assertIn("Done: 1 command(s) answered.", out)


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
class OtherCommands(EngineCase):
    def test_preview_writes_what_would_be_sent_and_sends_nothing(self):
        code, out, err = self.run_cli(
            "preview", "--db", str(self.db), "--contacts", self.contacts, "--chat", "taco", "--year", "2026",
            "--out", str(self.out), "--me", "Amara",
        )
        self.assertEqual(code, 0, err + out)
        self.assertIn("nothing was sent", out)
        self.assertIn("2026 in review", out)
        self.assertIn("https://", out)
        folder = next(self.out.iterdir())
        self.assertEqual(len(list(folder.glob("*.png"))), 1)
        self.assertFalse((self.dir / "tb" / "state.json").exists())  # a preview keeps no state

    def test_owner_is_named_after_the_mac_account_unless_me_is_given(self):
        base = ["preview", "--db", str(self.db), "--contacts", self.contacts, "--chat", "taco", "--year", "2026",
                "--out", str(self.out)]
        code, out, err = self.run_cli(*base)
        self.assertEqual(code, 0, err + out)
        self.assertIn("Robin 20%", out)  # the account's first name, not "Me"
        self.assertNotIn(" Me ", out)
        link = [ln for ln in out.splitlines() if ln.startswith("https://")][0]
        self.assertIn("Robin", [s["name"] for s in wrapped.stats_from_url(link)["senders"]])
        code, out, err = self.run_cli(*base, "--me", "Amara")
        self.assertIn("Amara 20%", out)
        code, out, err = self.run_cli("doctor", "--db", str(self.db))
        self.assertIn('"Robin"', out)
        self.assertIn("--me", out)

    def test_full_names_flag_reaches_the_link(self):
        base = ["preview", "--db", str(self.db), "--contacts", self.contacts, "--chat", "taco", "--year", "2026",
                "--out", str(self.out)]

        def names(*extra):
            code, out, err = self.run_cli(*base, *extra)
            self.assertEqual(code, 0, err + out)
            link = [ln for ln in out.splitlines() if ln.startswith("https://")][0]
            return [s["name"] for s in wrapped.stats_from_url(link)["senders"]]

        short, full = names(), names("--full-names")
        self.assertTrue(any(" " in n and not n.endswith(".") for n in full), full)  # the fixture has full contact names
        self.assertTrue(all(" " not in n or n.endswith(".") or n == "Robin" for n in short), short)
        self.assertEqual(len(short), len(full))

    def in_empty_cwd(self):
        """Run from an empty folder so anything written 'here' is caught."""
        cwd = self.dir / "cwd"
        cwd.mkdir()
        previous = os.getcwd()
        os.chdir(cwd)
        self.addCleanup(os.chdir, previous)
        return cwd

    def test_preview_and_card_write_to_pictures_by_default_never_to_the_current_folder(self):
        cwd = self.in_empty_cwd()
        code, out, err = self.run_cli(
            "preview", "--db", str(self.db), "--contacts", self.contacts, "--chat", "taco", "--year", "2026"
        )
        self.assertEqual(code, 0, err + out)
        previews = self.home / "Pictures" / "Threadback" / "preview"
        folder = next(previews.iterdir())
        self.assertEqual(sorted(p.suffix for p in folder.iterdir()), [".png", ".txt", ".txt"])
        self.assertIn(str(previews), out)

        stats_file = self.dir / "s.json"
        stats_file.write_text(json.dumps(mac_support.sample_stats()), encoding="utf-8")
        code, out, err = self.run_cli("card", str(stats_file))
        self.assertEqual(code, 0, err + out)
        written = Path(out.strip().splitlines()[-1])
        self.assertEqual(written.parent, self.home / "Pictures" / "Threadback")
        self.assertTrue(written.is_file())
        self.assertFalse(written.name.startswith("threadback-"))  # staged attachments are pruned; this is not one
        code, out2, err = self.run_cli("card", str(stats_file))
        self.assertNotEqual(Path(out2.strip().splitlines()[-1]), written)  # never overwrites an earlier card
        code, out3, err = self.run_cli("card", str(stats_file), "--out", str(self.dir / "chosen.png"))
        self.assertTrue((self.dir / "chosen.png").is_file())

        self.assertEqual(list(cwd.iterdir()), [], "something was written into the current folder")

    def test_log_file_is_private(self):
        log = self.dir / "tb" / "agent.log"
        args = ["agent", "--db", str(self.db), "--contacts", self.contacts, "--state", str(self.state),
                "--dry-run", "--once", "--chat", "taco", "--out", str(self.out)]
        code, out, err = self.run_cli(*args)
        self.assertEqual(code, 0, err + out)
        self.assertTrue(log.is_file())
        self.assertEqual(oct(log.stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(self.state.stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(log.parent.stat().st_mode & 0o077), "0o0")  # the folder is the owner's alone
        os.chmod(log, 0o644)  # an older, world-readable log is tightened on the next run
        code, out, err = self.run_cli(*args)
        self.assertEqual(oct(log.stat().st_mode & 0o777), "0o600")

    def test_preview_needs_exactly_one_chat(self):
        code, _, err = self.run_cli("preview", "--db", str(self.db), "--contacts", self.contacts, "--chat", "zzz")
        self.assertEqual(code, 1)
        self.assertIn("no group chat matches", err)
        code, _, err = self.run_cli("preview", "--db", str(self.db), "--no-contacts", "--chat", "c")
        self.assertEqual(code, 1)
        self.assertIn("group chats match", err)

    def test_card_from_a_stats_file(self):
        stats_file = self.dir / "s.json"
        stats_file.write_text(json.dumps(mac_support.sample_stats()), encoding="utf-8")
        out_png = self.dir / "card.png"
        code, out, err = self.run_cli("card", str(stats_file), "-o", str(out_png), "--size", "540x675")
        self.assertEqual(code, 0, err)
        with Image.open(out_png) as im:
            self.assertEqual(im.size, (540, 675))
        code, _, err = self.run_cli("card", str(self.dir / "missing.json"))
        self.assertEqual(code, 1)
        bad = self.dir / "bad.json"
        bad.write_text("[1, 2]")
        code, _, err = self.run_cli("card", str(bad))
        self.assertEqual(code, 1)
        self.assertIn("stats object", err)

    def send_test(self, *extra, **kw):
        runs = []

        def fake_runner(script, args, timeout):
            runs.append(list(args))
            # play Messages: write the outgoing row into the chat
            add_message(self.db, self.chats["lively"]["rowid"], text=args[1] or None, is_from_me=1)
            return send.OsaResult(0)

        with mock.patch.object(send, "find_osascript", return_value="/usr/bin/osascript"), mock.patch.object(
            send, "run_osascript", fake_runner
        ):
            result = self.run_cli("send-test", "--db", str(self.db), "--contacts", self.contacts, *extra, **kw)
        return result, runs

    def test_send_test_dry_run_and_cancel_send_nothing(self):
        (code, out, err), runs = self.send_test("--chat", "taco", "--dry-run")
        self.assertEqual(code, 0, err)
        self.assertIn("ONE real message from YOUR Apple ID", out)
        self.assertIn(self.chats["lively"]["display_name"], out)
        self.assertIn("DRY RUN: nothing was sent", out)
        self.assertEqual(runs, [])
        for answers in ([], ["y"], ["yes"], ["no"], [""]):
            (code, out, err), runs = self.send_test("--chat", "taco", stdin_tty=True, answers=answers)
            self.assertEqual(code, 1)
            self.assertIn("Cancelled. Nothing was sent.", out)
            self.assertEqual(runs, [])

    def test_send_test_sends_one_verified_line_after_typing_send(self):
        (code, out, err), runs = self.send_test("--chat", "taco", stdin_tty=True, answers=["send"])
        self.assertEqual(code, 0, err + out)
        self.assertEqual(len(runs), 1)
        guid, text, file_path = runs[0]
        self.assertEqual(guid, self.chats["lively"]["guid"])
        self.assertIn("Threadback test", text)
        self.assertEqual(file_path, "")
        self.assertIn("Text: DELIVERED", out)
        self.assertIn("Verified", out)

    def test_send_test_with_image_sends_the_text_then_one_staged_picture(self):
        (code, out, err), runs = self.send_test("--chat", "taco", "--with-image", stdin_tty=True, answers=["send"])
        self.assertEqual(code, 0, err + out)
        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0][2], "")
        self.assertEqual(runs[1][1], "")
        staged = Path(runs[1][2])
        self.assertEqual(staged.parent, self.home / "Pictures" / "Threadback")  # where Messages may read from
        self.assertTrue(staged.is_file())
        self.assertIn("Text: DELIVERED", out)
        self.assertIn("Image: DELIVERED", out)

    def test_send_test_refuses_commands_and_ambiguous_chats(self):
        (code, _, err), runs = self.send_test("--chat", "taco", "--text", "/wrapped", stdin_tty=True, answers=["send"])
        self.assertEqual(code, 2)
        self.assertIn("must not be a command", err)
        (code, _, err), runs2 = self.send_test("--chat", "c", "--no-contacts", stdin_tty=True, answers=["send"])
        self.assertEqual(code, 1)
        self.assertIn("group chats match", err)
        self.assertEqual(runs + runs2, [])

    def test_doctor_reads_the_database_and_sends_nothing(self):
        code, out, err = self.run_cli("doctor", "--db", str(self.db))
        self.assertEqual(code, 0, err + out)
        self.assertIn("can read", out)
        self.assertIn("card renderer ready", out)
        self.assertIn("automation not checked", out)
        code, out, err = self.run_cli("doctor", "--db", str(self.home / "Library" / "Messages" / "chat.db"))
        self.assertEqual(code, 1)
        self.assertIn("Full Disk Access", out)

    def test_doctor_automation_compares_chat_ids_without_sending(self):
        lively, tiny = self.chats["lively"]["guid"], self.chats["tiny"]["guid"]
        listed = "\n".join([send.swap_guid_form(lively), tiny, "any;-;+15550100001"]) + "\n"
        seen = []

        def fake(script, args, timeout):
            seen.append((script, list(args)))
            return send.OsaResult(0, listed, "")

        with mock.patch.object(send, "find_osascript", return_value="/usr/bin/osascript"), mock.patch.object(
            send, "run_osascript", fake
        ):
            code, out, err = self.run_cli("doctor", "--db", str(self.db), "--automation")
        self.assertEqual(code, 0, err + out)
        self.assertEqual(len(seen), 1)
        self.assertIs(seen[0][0], send.LIST_CHATS_SCRIPT)  # the read-only script, never the send script
        self.assertEqual(seen[0][1], [])
        self.assertIn("Messages automation allowed; it lists 3 chats", out)
        self.assertIn("matches chat.db exactly: 1", out)
        self.assertIn("other id spelling (;+; / ;-;): 1", out)

        denied = send.OsaResult(1, "", "execution error: Not authorized to send Apple events to Messages. (-1743)")
        with mock.patch.object(send, "find_osascript", return_value="/usr/bin/osascript"), mock.patch.object(
            send, "run_osascript", lambda *a: denied
        ):
            code, out, err = self.run_cli("doctor", "--db", str(self.db), "--automation")
        self.assertEqual(code, 1)
        self.assertIn("Privacy & Security > Automation", out)

    def test_console_output_is_scrubbed(self):
        esc, rlo = chr(0x1B), chr(0x202E)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            mac_cli._say(f"line one{esc}[2J\n  line {rlo}two")
            mac_cli._err(f"oops{esc}]0;title{chr(7)}")
        self.assertEqual(out.getvalue(), "line one[2J\n  line two\n")
        self.assertEqual(err.getvalue(), "oops]0;title\n")

    def test_register_avoids_name_clashes(self):
        import argparse

        parser = argparse.ArgumentParser()
        sub = parser.add_subparsers()
        sub.add_parser("card")
        mac_cli.register(sub)
        self.assertIn("mac-card", sub.choices)
        self.assertIn("agent", sub.choices)

    def test_python_dash_m_entry_points(self):
        env = dict(os.environ, PYTHONPATH=str(REPO_ROOT))
        with mock.patch.object(send.subprocess, "run", _REAL_RUN):  # undo the guard for this real call
            for module in ("wrapped", "wrapped.mac"):
                proc = _REAL_RUN(
                    [sys.executable, "-m", module, "--help"], capture_output=True, text=True, env=env, timeout=60
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn("send-test", proc.stdout)


if __name__ == "__main__":
    unittest.main()
