import json
import tempfile
import time
import unittest
from pathlib import Path

import mac_support
from mac_support import FakeEngine, FixtureDb, attributed_body, sample_stats

from wrapped.mac import agent as agent_mod
from wrapped.mac.agent import Agent, AgentConfig, consent_text, match_chats, scope_signature
from wrapped.mac.engine import ChatRef
from wrapped.mac.send import DELIVERED, DRY_RUN, FAILED, UNVERIFIED, DryRunSender, SendResult
from wrapped.mac.state import State
from wrapped.mac.triggers import parse_trigger

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 16


def fake_render(stats, path):
    Path(path).write_bytes(PNG)


class WritingSender:
    """Plays Messages: every send becomes an outgoing row in the fixture, like the real thing."""

    def __init__(self, db: FixtureDb, statuses=None):
        self.db = db
        self.sent = []
        self.statuses = list(statuses or [])

    def _result(self, kind, rowid):
        status = self.statuses.pop(0) if self.statuses else DELIVERED
        if status == FAILED:
            return SendResult(FAILED, "Messages said no", kind)
        if status == "orphan":
            return SendResult(UNVERIFIED, "attached to no chat", kind, orphan=True)
        return SendResult(status, "", kind, rowid=rowid if status == DELIVERED else None)

    def send_text(self, chat, text):
        rowid = self.db.add_message(text, chat=chat.rowid, is_from_me=True)
        self.sent.append(("text", chat.key, text))
        return self._result("text", rowid)

    def send_file(self, chat, path):
        assert Path(path).is_file()
        rowid = self.db.add_message(None, chat=chat.rowid, is_from_me=True, attachment=True)
        self.sent.append(("file", chat.key, Path(path).name))
        return self._result("file", rowid)


class AgentCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.db = FixtureDb(self.dir / "fixture-chat.db")
        self.maya = self.db.add_handle("+15550100001")
        self.dev = self.db.add_handle("+15550100002")
        self.group = self.db.add_chat("chat111", "Dinner Club 🍝", members=[self.maya, self.dev])
        self.other = self.db.add_chat("chat222", "Book Club", members=[self.maya])
        self.unnamed = self.db.add_chat("chat333", "", members=[self.dev])
        self.direct = self.db.add_chat("+15550100001", "", style=45, members=[self.maya])
        self.now = time.time()
        for i in range(5):  # history from before the helper started, including an old command
            self.db.add_message(f"old message {i}", chat=self.group, handle=self.maya, when=self.now - 5000)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now - 4000)
        self.engine = FakeEngine()
        self.logs = []
        self.slept = []

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def make(self, sender=None, **overrides):
        cfg = dict(
            db_path=self.db.path,
            state_path=self.dir / "home" / "state.json",
            chats=["dinner"],
            dry_run=True,
            out_dir=self.dir / "out",
            join_delay=0.01,
        )
        cfg.update(overrides)
        self.sender = sender if sender is not None else DryRunSender()
        return Agent(
            AgentConfig(**cfg),
            self.engine,
            self.sender,
            clock=lambda: self.now,
            sleep=self._sleep,
            log=self.logs.append,
            render=fake_render,
        )

    def _sleep(self, seconds):
        self.slept.append(seconds)

    def started(self, **kw):
        """An agent that has already done its first (cursor-initialising) pass."""
        agent = self.make(**kw)
        self.assertEqual(agent.run_once(), 0)
        return agent

    def kinds(self):
        return [s["kind"] for s in self.sender.sent]

    # -- first run / cursor --------------------------------------------------

    def test_first_run_starts_from_now_and_never_replays_old_commands(self):
        agent = self.make()
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.engine.compute_calls, [])
        saved = json.loads((self.dir / "home" / "state.json").read_text())
        self.assertEqual(saved["cursor"], self.db.max_rowid())

    def test_trigger_from_someone_else(self):
        agent = self.started()
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now - 3)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(self.kinds(), ["file", "text", "text"])
        self.assertEqual(self.engine.compute_calls, [("chat111", None, "Me")])
        card, text, link = self.sender.sent
        self.assertTrue(card["path"].endswith("threadback-dinner-club-2026.png"))
        self.assertIn("Dinner Club 🍝", text["text"])
        # the URL stands alone, and carries no message text unless --quotes was given
        self.assertEqual(link["text"], "https://example.invalid/story/#w1=FAKEPAYLOAD-noquotes")
        self.assertNotIn("http", text["text"])
        self.assertEqual(card["guid"], "any;+;chat111")

    def test_trigger_from_me(self):
        agent = self.started(me="Amara")
        self.db.add_message("/recap", chat=self.group, is_from_me=True, when=self.now - 1)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(self.engine.compute_calls, [("chat111", None, "Amara")])
        self.assertEqual(self.kinds(), ["file", "text", "text"])

    def test_attributed_body_only_command(self):
        agent = self.started()
        self.db.add_message(None, body=attributed_body("/Wrapped 2025"), chat=self.group, handle=self.dev, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(self.engine.compute_calls, [("chat111", "2025", "Me")])
        self.assertIn("2025 in review", self.sender.sent[1]["text"])

    def test_period_all(self):
        agent = self.started()
        self.db.add_message("  /wrapped ALL ", chat=self.group, handle=self.dev, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(self.engine.compute_calls[0][1], "all")

    def test_non_commands_are_ignored_silently(self):
        agent = self.started()
        for text in ["hey /wrapped", "/wrapped please", "wrapped", "/wrapped 1999", "lol", None]:
            self.db.add_message(text, chat=self.group, handle=self.maya, when=self.now)
        self.db.add_message("Loved “/wrapped”", chat=self.group, handle=self.dev, when=self.now, associated_type=2000)
        self.db.add_message("/wrapped", chat=self.group, handle=self.dev, when=self.now, associated_type=2001)
        self.db.add_message("/wrapped", chat=self.group, handle=self.dev, when=self.now, item_type=2)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.logs[1:], [])  # nothing about ordinary messages is ever logged

    def test_one_to_one_chat_is_ignored(self):
        agent = self.started(all_chats=True)
        self.db.add_message("/wrapped", chat=self.direct, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertTrue(any("outside a group chat" in ln for ln in self.logs))

    def test_stale_command_is_ignored(self):
        agent = self.started()
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now - 601)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertTrue(any("10 min old" in ln for ln in self.logs))
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now - 599)
        self.assertEqual(agent.run_once(), 1)

    def test_command_dated_in_the_future_is_ignored(self):
        agent = self.started(cooldown=0)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now + 3600)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now + 10 * 365 * 86400)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(sum("in the future" in ln for ln in self.logs), 2)
        # a few seconds of clock skew between devices is normal and still answered
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now + 5)
        self.assertEqual(agent.run_once(), 1)

    def test_cooldown_per_chat(self):
        agent = self.started(chats=["dinner", "book"], cooldown=120)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.db.add_message("/wrapped", chat=self.group, handle=self.dev, when=self.now)  # same batch
        self.assertEqual(agent.run_once(), 1)
        self.now += 60
        self.db.add_message("/recap", chat=self.group, handle=self.dev, when=self.now)
        self.db.add_message("/recap", chat=self.other, handle=self.maya, when=self.now)  # another chat: own cooldown
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual([c[0] for c in self.engine.compute_calls], ["chat111", "chat222"])
        self.assertEqual(sum("cooling down" in ln for ln in self.logs), 2)
        self.now += 61  # 121 s after the first reply
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(len(self.engine.compute_calls), 3)

    def test_cooldown_survives_a_restart(self):
        agent = self.started()
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.now += 30
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        fresh = self.make()
        self.assertEqual(fresh.run_once(), 0)
        self.assertEqual(self.sender.sent, [])

    def test_cursor_persists_across_restarts(self):
        agent = self.started()
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        cursor = State.load(self.dir / "home" / "state.json").cursor
        self.assertEqual(cursor, self.db.max_rowid())
        self.now += 300
        restarted = self.make()
        self.assertEqual(restarted.run_once(), 0)  # the answered command is not replayed
        self.assertEqual(self.sender.sent, [])
        # a command typed while the helper was off (but still fresh) is picked up
        self.db.add_message("/wrapped", chat=self.group, handle=self.dev, when=self.now)
        again = self.make()
        self.assertEqual(again.run_once(), 1)

    def test_idle_passes_do_not_rewrite_the_state_file(self):
        agent = self.started()
        path = self.dir / "home" / "state.json"
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        before = path.stat().st_mtime_ns
        inode = path.stat().st_ino
        for _ in range(3):
            self.assertEqual(agent.run_once(), 0)
        self.assertEqual((path.stat().st_mtime_ns, path.stat().st_ino), (before, inode))
        self.db.add_message("hello", chat=self.group, handle=self.maya, when=self.now)
        agent.run_once()
        self.assertEqual(State.load(path).cursor, self.db.max_rowid())  # real changes are still written

    def test_cursor_ahead_of_database_resets_to_now(self):
        path = self.dir / "home" / "state.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"cursor": 10**9}))
        agent = self.make()
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(State.load(path).cursor, self.db.max_rowid())
        self.assertTrue(any("replaced" in ln for ln in self.logs))

    def test_corrupt_state_file_starts_fresh(self):
        path = self.dir / "home" / "state.json"
        path.parent.mkdir(parents=True)
        path.write_text("{not json")
        agent = self.make()
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(State.load(path).cursor, self.db.max_rowid())

    def test_own_replies_are_ignored(self):
        sender = WritingSender(self.db)
        agent = self.started(sender=sender, dry_run=False, cooldown=0)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(len(sender.sent), 3)
        own = set(State.load(self.dir / "home" / "state.json").own_rowids)
        self.assertEqual(len(own), 3)
        # the three replies are now rows in chat.db; with no cooldown at all the
        # next passes must still stay quiet
        for _ in range(3):
            self.assertEqual(agent.run_once(), 0)
        self.assertEqual(len(sender.sent), 3)
        self.assertEqual(len(self.engine.compute_calls), 1)

    def test_own_row_is_skipped_even_if_it_looked_like_a_command(self):
        agent = self.started(cooldown=0)
        rowid = self.db.add_message("/wrapped", chat=self.group, is_from_me=True, when=self.now)
        agent.state.remember_own(rowid)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])

    def test_hostile_chat_name_cannot_make_the_helper_answer_itself(self):
        hostile = self.db.add_chat("chat444", "/wrapped", members=[self.maya])
        sender = WritingSender(self.db, statuses=[UNVERIFIED] * 9)  # unverified = row ids unknown
        agent = self.started(sender=sender, dry_run=False, cooldown=0, all_chats=True)
        self.db.add_message("/wrapped", chat=hostile, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        for kind, _chat, payload in sender.sent:
            if kind == "text":
                for line in payload.splitlines():
                    self.assertIsNone(parse_trigger(line, current_year=2026), line)
        for _ in range(3):
            self.assertEqual(agent.run_once(), 0)
        self.assertEqual(len(sender.sent), 3)

    def test_missing_join_row_is_retried(self):
        agent = self.started()
        rowid = self.db.add_message("/wrapped", handle=self.maya, when=self.now)  # no join row yet
        attempts = []

        def sleep(seconds):
            attempts.append(seconds)
            if len(attempts) == 3:
                self.db.join(self.group, rowid)

        agent._sleep = sleep
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(len(attempts), 3)
        self.assertEqual(self.kinds(), ["file", "text", "text"])

    def test_join_row_that_never_arrives_gives_up_and_moves_on(self):
        agent = self.started(join_attempts=4)
        self.db.add_message("/wrapped", handle=self.maya, when=self.now)
        self.db.add_message("/wrapped", chat=self.group, handle=self.dev, when=self.now)
        self.assertEqual(agent.run_once(), 1)  # the second command is still answered
        self.assertEqual(len(self.slept), 3)
        self.assertTrue(any("never showed up" in ln for ln in self.logs))

    # -- scope: frozen at start, by chat id, never by name ---------------------

    def rename(self, chat_rowid, name):
        self.db.conn.execute("UPDATE chat SET display_name = ? WHERE ROWID = ?", (name, chat_rowid))
        self.db.conn.commit()

    def test_only_approved_chats_are_answered(self):
        agent = self.started(chats=["DINNER"])
        self.db.add_message("/wrapped", chat=self.other, handle=self.maya, when=self.now)
        self.db.add_message("/wrapped", chat=self.unnamed, handle=self.dev, when=self.now)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.engine.compute_calls, [])
        self.assertEqual(sum("not in the approved list" in ln for ln in self.logs), 2)
        self.db.add_message("/wrapped", chat=self.group, handle=self.dev, when=self.now)
        self.assertEqual(agent.run_once(), 1)

    def test_no_chats_and_no_all_chats_means_nothing_is_approved(self):
        agent = self.started(chats=[])
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(agent.approved_chats(), [])

    def test_new_group_with_a_matching_name_is_never_answered(self):
        # the reviewer's repro: started with --chat Dinner, then someone creates this
        agent = self.started(chats=["Dinner"])
        strangers = self.db.add_chat("chat999", "Dinner plans with strangers", members=[self.dev])
        for _ in range(3):  # however often the helper looks again
            self.db.add_message("/wrapped", chat=strangers, handle=self.dev, when=self.now)
            self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.engine.compute_calls, [])
        self.db.add_message("/wrapped", chat=self.group, handle=self.dev, when=self.now)
        self.assertEqual(agent.run_once(), 1)  # the approved chat still works

    def test_renaming_another_chat_to_match_does_not_add_it(self):
        # any member can rename a group; a name must never widen the scope
        agent = self.started(chats=["Dinner"])
        self.rename(self.other, "Work Stuff (Dinner edition)")
        strangers = self.db.add_chat("chat998", "x", members=[self.dev])
        self.db.add_message("/wrapped", chat=strangers, handle=self.dev, when=self.now)  # forces any "refresh"
        agent.run_once()
        for _ in range(3):
            self.db.add_message("/wrapped", chat=self.other, handle=self.maya, when=self.now)
            self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(self.engine.compute_calls, [])

    def test_renaming_an_approved_chat_keeps_it_approved(self):
        agent = self.started(chats=["Dinner"])
        self.rename(self.group, "Supper Society")
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(self.engine.compute_calls, [("chat111", None, "Me")])
        self.assertIn("Supper Society", self.sender.sent[1]["text"])

    def test_all_chats_is_frozen_at_start_too(self):
        agent = self.started(all_chats=True, chats=[])
        self.db.add_message("/wrapped", chat=self.unnamed, handle=self.dev, when=self.now)
        newer = self.db.add_chat("chat555", "Made After Start", members=[self.maya])
        self.db.add_message("/wrapped", chat=newer, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual([c[0] for c in self.engine.compute_calls], ["chat333"])
        self.assertEqual({s["chat"] for s in self.sender.sent}, {"chat333"})

    def test_chat_created_after_start_needs_a_restart(self):
        agent = self.started(chats=["ski trip"])
        self.assertEqual(agent.approved_chats(), [])
        newer = self.db.add_chat("chat666", "Ski Trip 2027", members=[self.maya])
        self.db.add_message("/wrapped", chat=newer, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 0)
        restarted = self.make(chats=["ski trip"])  # a restart resolves (and asks about) the list again
        self.assertEqual([c.key for c in restarted.resolve_scope()], ["chat666"])
        self.db.add_message("/wrapped", chat=newer, handle=self.maya, when=self.now)
        self.assertEqual(restarted.run_once(), 1)

    def test_unapproved_chat_is_logged_once_by_id_and_never_by_name(self):
        agent = self.started(chats=["Dinner"])
        secret = self.db.add_chat("chat424242", "Surprise Dinner for Maya", members=[self.dev])
        for _ in range(3):
            self.db.add_message("/wrapped", chat=secret, handle=self.dev, when=self.now)
            agent.run_once()
        lines = [ln for ln in self.logs if "not in the approved list" in ln]
        self.assertEqual(len(lines), 1, self.logs)
        self.assertIn("restart", lines[0])
        self.assertIn("4242", lines[0])
        self.assertFalse(any("Surprise" in ln for ln in self.logs), self.logs)

    def test_approving_fewer_chats_than_the_names_match(self):
        agent = self.make(chats=["club"])
        scope = agent.resolve_scope()
        self.assertEqual(sorted(c.key for c in scope), ["chat111", "chat222"])
        agent.approve([c for c in scope if c.key == "chat222"])
        self.assertEqual(agent.run_once(), 0)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.db.add_message("/wrapped", chat=self.other, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual([c[0] for c in self.engine.compute_calls], ["chat222"])

    # -- dry run --------------------------------------------------------------

    def test_dry_run_writes_card_text_and_link_to_a_folder(self):
        agent = self.started()
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        folders = list((self.dir / "out").iterdir())
        self.assertEqual(len(folders), 1)
        names = sorted(p.name for p in folders[0].iterdir())
        self.assertEqual(names, ["link.txt", "recap.txt", "threadback-dinner-club-2026.png"])
        self.assertEqual((folders[0] / "threadback-dinner-club-2026.png").read_bytes(), PNG)
        self.assertIn("48,213 messages", (folders[0] / "recap.txt").read_text(encoding="utf-8"))
        self.assertEqual((folders[0] / "link.txt").read_text().strip(),
                         "https://example.invalid/story/#w1=FAKEPAYLOAD-noquotes")
        self.assertTrue(all(r.status == DRY_RUN for r in agent.outcomes[0].results.values()))
        self.assertTrue(any("card=dry-run" in ln and "link=dry-run" in ln for ln in self.logs))

    def test_attachment_file_name_never_contains_a_phone_number(self):
        numbered = self.db.add_chat("chat777", "", members=[self.maya])
        real = self.engine.list_group_chats

        def named(db_path):
            return [
                c if c.identifier != "chat777" else ChatRef(c.guid, c.identifier, "Bram, +15550100007 & 1 more", c.rowid, 3)
                for c in real(db_path)
            ]

        self.engine.list_group_chats = named
        agent = self.started(all_chats=True, chats=[])
        self.db.add_message("/wrapped", chat=numbered, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertNotIn("5550100007", self.sender.sent[0]["path"])
        self.assertNotIn("5550100007", self.sender.sent[1]["text"])
        self.assertIn("…0007", self.sender.sent[1]["text"])

    def test_hostile_chat_name_cannot_reach_the_log_the_files_or_the_reply(self):
        esc, rlo, zwsp = chr(0x1B), chr(0x202E), chr(0x200B)
        hostile = f"Dinner{esc}[2J{rlo}live{zwsp}\nFAKE  /wrapped in \"Bank\": card=delivered"
        self.rename(self.group, hostile)
        agent = self.started(chats=["dinner"])
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        everything = self.logs + [s.get("text", "") for s in self.sender.sent] + [s.get("path", "") for s in self.sender.sent]
        everything.append(str(agent.outcomes[0].out_dir))
        everything.append(agent_mod.consent_text(agent.config, agent.approved_chats(), 4))
        for blob in everything:
            for cp in (0x1B, 0x202E, 0x200B):
                self.assertNotIn(chr(cp), blob, (hex(cp), blob[:80]))
        for line in self.logs:
            self.assertNotIn("\n", line)  # a name can never start a second, forged log line
        card = self.sender.sent[0]["path"]
        self.assertRegex(Path(card).name, r"^[a-z0-9.-]+$")
        long_name = "W" * 300_000
        self.rename(self.other, long_name)
        other = self.started(chats=["www"], cooldown=0)
        self.db.add_message("/wrapped", chat=self.other, handle=self.maya, when=self.now)
        self.assertEqual(other.run_once(), 1)
        self.assertLess(max(len(ln) for ln in self.logs), 400)
        self.assertLess(len(self.sender.sent[-2]["text"]), 800)

    def full_named_stats(self):
        stats = sample_stats(members=4, messages=900)
        for sender, name in zip(stats["senders"], ["Dave Plumber", "Sam Rivera", "Sam Kowalski", "Amara"]):
            sender["name"] = name
        stats["awards"][0]["winner"] = "Dave Plumber"
        return stats

    def test_the_link_carries_short_names_by_default(self):
        self.engine.stats = self.full_named_stats()
        agent = self.started(me="Amara")
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        sent = self.engine.link_stats[0]
        self.assertEqual([s["name"] for s in sent["senders"]], ["Dave", "Sam R.", "Sam K.", "Amara"])
        self.assertEqual(sent["awards"][0]["winner"], "Dave")
        self.assertNotIn("Plumber", json.dumps(sent))
        self.assertNotIn("Plumber", self.sender.sent[1]["text"])
        self.assertIn("🥇 Dave ", self.sender.sent[1]["text"])

    def test_full_names_is_an_explicit_choice_for_the_link_only(self):
        self.engine.stats = self.full_named_stats()
        agent = self.started(me="Amara", full_names=True)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(self.engine.link_stats[0]["senders"][0]["name"], "Dave Plumber")
        self.assertNotIn("Plumber", self.sender.sent[1]["text"])  # the text in the thread keeps first names

    def test_no_link_sends_only_card_and_text(self):
        agent = self.started(link=False)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(self.kinds(), ["file", "text"])
        self.assertEqual(self.engine.link_calls, [])
        self.assertNotIn("link below", self.sender.sent[1]["text"])

    def test_message_text_is_in_the_link_only_when_asked_for(self):
        agent = self.started()                      # the default: no message text
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        agent.run_once()
        self.assertEqual(self.engine.link_calls, [False])
        self.assertTrue(self.sender.sent[2]["text"].endswith("-noquotes"))

    def test_quotes_is_passed_to_the_link_builder(self):
        agent = self.started(quotes=True)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        agent.run_once()
        self.assertEqual(self.engine.link_calls, [True])
        self.assertTrue(self.sender.sent[2]["text"].endswith("FAKEPAYLOAD"))

    # -- robustness -------------------------------------------------------------

    def test_engine_error_is_logged_and_the_loop_continues(self):
        agent = self.started(chats=["dinner", "book"])
        self.engine.fail_compute = RuntimeError("engine exploded")
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertTrue(any("could not compute stats" in ln and "engine exploded" in ln for ln in self.logs))
        self.engine.fail_compute = None
        # a failed attempt does not start the cooldown: the same chat can try again
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)

    def test_decode_error_on_one_row_does_not_stop_the_batch(self):
        agent = self.started()
        bad = self.db.add_message("boom", chat=self.group, handle=self.maya, when=self.now)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        real_decode = self.engine.decode_text

        def decode(text, body):
            if text == "boom":
                raise ValueError("bad blob")
            return real_decode(text, body)

        self.engine.decode_text = decode
        self.assertEqual(agent.run_once(), 1)
        self.assertTrue(any(f"row {bad}" in ln and "ValueError" in ln for ln in self.logs))

    def test_link_failure_still_sends_card_and_text_without_the_pointer(self):
        agent = self.started()
        self.engine.fail_link = RuntimeError("link too long")
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(self.kinds(), ["file", "text"])
        self.assertNotIn("link below", self.sender.sent[1]["text"])

    def test_render_error_sends_nothing(self):
        agent = self.started()
        agent._render = lambda stats, path: (_ for _ in ()).throw(RuntimeError("no fonts"))
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual(self.sender.sent, [])
        self.assertTrue(any("could not render the card" in ln for ln in self.logs))

    def test_failed_card_stops_the_sequence(self):
        sender = WritingSender(self.db, statuses=[FAILED])
        agent = self.started(sender=sender, dry_run=False)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 0)
        self.assertEqual([s[0] for s in sender.sent], ["file"])
        self.assertTrue(any("card=failed (Messages said no)" in ln for ln in self.logs))
        self.assertNotIn("chat111", agent.state.cooldowns)  # nothing went out, so no cooldown

    def test_orphan_symptom_stops_the_sequence_but_unverified_alone_does_not(self):
        sender = WritingSender(self.db, statuses=["orphan"])
        agent = self.started(sender=sender, dry_run=False, cooldown=0)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        agent.run_once()
        self.assertEqual([s[0] for s in sender.sent], ["file"])
        sender.statuses = [UNVERIFIED, DELIVERED, DELIVERED]
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        agent.run_once()
        self.assertEqual([s[0] for s in sender.sent], ["file", "file", "text", "text"])
        self.assertIn("card=unverified", self.logs[-1])
        self.assertIn("text=delivered", self.logs[-1])

    def test_empty_period_gets_one_short_line_and_no_card(self):
        self.engine.stats = sample_stats(messages=0)
        agent = self.started()
        self.db.add_message("/wrapped 2019", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(self.kinds(), ["text"])
        self.assertIn("Nothing to recap in 2019", self.sender.sent[0]["text"])

    def test_awards_hook_replaces_awards_and_its_failure_is_harmless(self):
        seen = {}

        def render(stats, path):
            seen["awards"] = stats["awards"]
            fake_render(stats, path)

        def hook(stats):
            out = dict(stats)
            out["awards"] = [{"emoji": "🎯", "title": "The Closer", "winner": "Maya", "detail": "x", "ai": True}]
            return out

        agent = self.started(cooldown=0)
        agent._render = render
        agent._awards_hook = hook
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        agent.run_once()
        self.assertEqual(seen["awards"][0]["title"], "The Closer")
        self.assertIn("Closer: Maya", self.sender.sent[1]["text"])

        agent._awards_hook = lambda stats: (_ for _ in ()).throw(RuntimeError("api down"))
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        self.assertEqual(agent.run_once(), 1)
        self.assertEqual(seen["awards"][0]["title"], "The Yapper")
        self.assertTrue(any("AI awards skipped" in ln for ln in self.logs))

    def test_logs_never_contain_message_text(self):
        agent = self.started()
        secret = "INVENTED-SECRET-" + "x" * 8
        self.db.add_message(secret, chat=self.group, handle=self.maya, when=self.now)
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        agent.run_once()
        self.assertFalse(any(secret in ln for ln in self.logs))
        state_text = (self.dir / "home" / "state.json").read_text()
        self.assertNotIn(secret, state_text)
        self.assertNotIn("Dinner", state_text)  # no chat names in the state file either

    def test_run_forever_survives_database_errors(self):
        agent = self.started()
        calls = {"n": 0}

        def connect(path):
            calls["n"] += 1
            if calls["n"] <= 2:
                from wrapped.mac.chatdb import ChatDbError, FDA_HINT

                raise ChatDbError("Cannot open chat.db", FDA_HINT)
            from wrapped.mac.chatdb import open_ro

            return open_ro(path)

        agent._connect = connect
        self.db.add_message("/wrapped", chat=self.group, handle=self.maya, when=self.now)
        agent.run_forever(stop=lambda: calls["n"] >= 3)
        self.assertEqual(sum("cannot read the Messages database" in ln for ln in self.logs), 1)  # said once
        self.assertTrue(any("Full Disk Access" in ln for ln in self.logs))
        self.assertEqual(self.kinds(), ["file", "text", "text"])


class Scope(unittest.TestCase):
    CHATS = [
        ChatRef("any;+;chat1", "chat1", "Dinner Club 🍝", 1, 7),
        ChatRef("any;+;chat2", "chat2", "Book Club", 2, 4),
        ChatRef("any;+;chat3", "chat3", "Maya, Dev, Priya & 2 more", 3, 6),
    ]

    def test_match_chats(self):
        self.assertEqual([c.key for c in match_chats(self.CHATS, ["club"])], ["chat1", "chat2"])
        self.assertEqual([c.key for c in match_chats(self.CHATS, ["DINNER", "priya"])], ["chat1", "chat3"])
        self.assertEqual(match_chats(self.CHATS, []), [])
        self.assertEqual(match_chats(self.CHATS, ["", "  "]), [])  # an empty pattern never means "everything"

    def test_consent_text_says_exactly_what_will_happen(self):
        cfg = AgentConfig(db_path=Path("x"), state_path=Path("y"), chats=["club"], cooldown=120)
        text = consent_text(cfg, self.CHATS[:2], total_groups=3)
        self.assertIn("Replies are sent from YOUR Apple ID into these group chats when someone types /wrapped", text)
        self.assertIn("  - Dinner Club 🍝 (7 members)", text)
        self.assertIn("  - Book Club (4 members)", text)
        self.assertNotIn("Maya, Dev", text)
        self.assertIn("every 120 seconds", text)
        self.assertIn("numbers and names only; no message text", text)      # the default
        everything = consent_text(
            AgentConfig(db_path=Path("x"), state_path=Path("y"), all_chats=True, quotes=True), self.CHATS, 3
        )
        self.assertIn("EVERY group chat on this Mac as of now (3)", everything)
        for chat in self.CHATS:  # ... and it still names each one
            self.assertIn(f"  - {chat.name}", everything)
        self.assertIn("created later are NOT included until you restart", everything)
        self.assertIn("Only these exact chats", text)
        named = consent_text(AgentConfig(db_path=Path("x"), state_path=Path("y"), chats=["club"], me="Robin"), self.CHATS[:1], 3)
        self.assertIn('Your own messages appear under the name "Robin"', named)
        self.assertIn("--me", named)
        self.assertIn("first names", named)
        self.assertIn("full contact names", consent_text(
            AgentConfig(db_path=Path("x"), state_path=Path("y"), chats=["club"], full_names=True), self.CHATS[:1], 3))
        self.assertIn("renamed", text)
        self.assertIn("including the text of the most-reacted messages, because you passed --quotes", everything)
        no_link = consent_text(AgentConfig(db_path=Path("x"), state_path=Path("y"), chats=["club"], link=False), self.CHATS[:1], 3)
        self.assertIn("two messages", no_link)
        self.assertNotIn("a link", no_link)

    def test_scope_signature_changes_with_scope(self):
        cfg = AgentConfig(db_path=Path("x"), state_path=Path("y"), chats=["club"])
        a = scope_signature(cfg, self.CHATS[:2])
        b = scope_signature(cfg, self.CHATS[:1])
        c = scope_signature(AgentConfig(db_path=Path("x"), state_path=Path("y"), all_chats=True), self.CHATS)
        self.assertEqual(len({a, b, c}), 3)
        self.assertEqual(a, scope_signature(cfg, list(reversed(self.CHATS[:2]))))
        # the signature is the set of chat ids, in both modes: names are not part of it,
        # and "all chats" means the chats that existed when it was approved
        renamed = [ChatRef(c.guid, c.identifier, "Renamed " + c.name, c.rowid, c.members) for c in self.CHATS[:2]]
        self.assertEqual(a, scope_signature(cfg, renamed))
        everything = AgentConfig(db_path=Path("x"), state_path=Path("y"), all_chats=True)
        self.assertNotEqual(scope_signature(everything, self.CHATS), scope_signature(everything, self.CHATS[:2]))
        for key in ("chat1", "chat2"):
            self.assertIn(key, a)

    def test_asking_for_more_than_was_approved_asks_again(self):
        def sig(**kw):
            return scope_signature(AgentConfig(db_path=Path("x"), state_path=Path("y"), chats=["club"], **kw),
                                   self.CHATS[:2])
        plain = sig()
        self.assertEqual(plain, sig())
        # message text, full contact names, or dropping the link: each is a different agreement
        self.assertEqual(len({plain, sig(quotes=True), sig(full_names=True), sig(link=False),
                              sig(quotes=True, full_names=True)}), 5)
        # with no link there is nothing for --quotes or --full-names to change
        self.assertEqual(sig(link=False), sig(link=False, quotes=True, full_names=True))

    def test_lock_is_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = agent_mod.acquire_lock(Path(tmp) / "agent.lock")
            self.assertIsNotNone(first)
            self.assertIsNone(agent_mod.acquire_lock(Path(tmp) / "agent.lock"))
            first.close()
            again = agent_mod.acquire_lock(Path(tmp) / "agent.lock")
            self.assertIsNotNone(again)
            again.close()


if __name__ == "__main__":
    unittest.main()
