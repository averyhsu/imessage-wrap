"""The loop that answers ``/wrapped`` typed in a group chat.

Every couple of seconds it looks at message rows newer than its cursor, decodes
each row's text (a typed command often lives only in ``attributedBody``), and
when a whole message is a command in an allowed group chat it computes the
recap locally and replies into the thread: card image, short text, then the link
as its own message. Each send is verified in ``chat.db`` and the outcome is
logged in one line.

What it will never do:

- reply in a chat the owner has not approved. ``--chat`` names (or ``--all-chats``)
  are turned into a fixed set of chat ids once, at start, and that list is what
  the owner approves. After that only the ids count: a chat that is created or
  renamed later is never added, whatever it is called, until a restart
- replay commands typed before it started, or more than ten minutes ago
- answer more than once per chat inside the cooldown
- react to its own replies
- log or store message text
"""

from __future__ import annotations

import datetime as _dt
import os
import re
import sqlite3
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence

from . import PRODUCT_NAME, chatdb
from .engine import ChatRef, Engine
from .send import FAILED, SendResult
from .state import State, private_dir
from .fmt import clean, safe_chat_name, shorten
from .text import assert_safe, empty_text, recap_lines
from .triggers import Trigger, parse_trigger


@dataclass
class AgentConfig:
    db_path: Path
    state_path: Path
    chats: Sequence[str] = ()  # names to look for AT START (case-insensitive substrings)
    all_chats: bool = False  # every group chat that exists at start
    me: str = "Me"  # the owner's display name in the recap
    cooldown: float = 120.0  # seconds between replies in one chat
    stale_after: float = 600.0  # ignore commands older than this (sleep/wake catch-up)
    future_skew: float = 30.0  # ... and ones dated further ahead than clocks plausibly differ
    poll_interval: float = 2.0
    dry_run: bool = False
    out_dir: Optional[Path] = None  # where a dry run writes card + text + link
    quotes: bool = False  # True puts the most-reacted messages' text in the link (--quotes)
    link: bool = True  # False sends the card and text only
    full_names: bool = False  # True keeps full contact names in the link (--full-names)
    join_attempts: int = 10  # a message row can appear before its chat join row
    join_delay: float = 0.3
    batch: int = 500


@dataclass
class TriggerOutcome:
    """What happened to one accepted command (also the source of the log line)."""

    chat: ChatRef
    trigger: Trigger
    results: Dict[str, SendResult] = field(default_factory=dict)
    error: str = ""
    out_dir: Optional[Path] = None

    @property
    def sent_something(self) -> bool:
        return any(r.sent_something for r in self.results.values())

    def line(self) -> str:
        period = self.trigger.period or "default period"
        head = f'/{self.trigger.command} in "{self.chat.name}" ({period})'
        if self.error:
            return f"{head}: error: {self.error}"
        parts = [f"{name}={res.summary()}" for name, res in self.results.items()]
        return f"{head}: " + " ".join(parts)


def sanitize_chats(chats: Iterable[ChatRef]) -> List[ChatRef]:
    """Chats with names that are safe to print, log and send (cleaned, masked, capped).

    Chat names are other people's input: this is where they enter the helper."""
    return [
        ChatRef(guid=c.guid, identifier=c.identifier, name=safe_chat_name(c.name) or "Group chat", rowid=c.rowid,
                members=c.members)
        for c in chats
    ]


def match_chats(chats: Iterable[ChatRef], patterns: Sequence[str]) -> List[ChatRef]:
    """Chats whose name contains any of the patterns (case-insensitive)."""
    wanted = [p.casefold().strip() for p in patterns if p and p.strip()]
    return [c for c in chats if any(w in c.name.casefold() for w in wanted)]


def slugify(text: str, fallback: str = "chat") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(text)[:200].lower()).strip("-")
    return slug[:40].strip("-") or fallback


class Agent:
    def __init__(
        self,
        config: AgentConfig,
        engine: Engine,
        sender,
        *,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        log: Optional[Callable[[str], None]] = None,
        render: Optional[Callable[[dict, os.PathLike], object]] = None,
        awards_hook: Optional[Callable[[dict], dict]] = None,
        connect: Callable[[os.PathLike], sqlite3.Connection] = chatdb.open_ro,
    ) -> None:
        self.config = config
        self.engine = engine
        self.sender = sender
        self._clock = clock
        self._sleep = sleep
        self._log = log or (lambda line: None)
        self._render = render
        self._awards_hook = awards_hook
        self._connect = connect
        self.state = State.load(config.state_path)
        self._known: Dict[str, ChatRef] = {}  # the approved chats as they were at start
        self._approved: Optional[frozenset] = None  # chat ids; None until approve()
        self._warned: set = set()  # unapproved chat ids already mentioned in the log
        self.outcomes: List[TriggerOutcome] = []

    # -- scope ---------------------------------------------------------------

    def resolve_scope(self) -> List[ChatRef]:
        """The group chats the configuration selects *right now* (by name, or all).

        Names are used here and nowhere else: this list is shown to the owner,
        and what they approve is frozen by ``approve``."""
        chats = sanitize_chats(self.engine.list_group_chats(self.config.db_path))
        return chats if self.config.all_chats else match_chats(chats, self.config.chats)

    def approve(self, chats: Iterable[ChatRef]) -> None:
        """Freeze the scope to exactly these chats, by id, for the life of this helper.

        Any member can rename a group or start a new one, so a name can never add
        a chat afterwards; a renamed approved chat stays approved (same id)."""
        approved = sanitize_chats(chats)
        self._known = {c.key: c for c in approved}
        self._approved = frozenset(self._known)

    def approved_chats(self) -> List[ChatRef]:
        if self._approved is None:
            self.approve(self.resolve_scope())
        return list(self._known.values())

    # -- loop ----------------------------------------------------------------

    def run_once(self) -> int:
        """Process every pending row, then return. Returns the number of commands answered."""
        answered = 0
        if self._approved is None:
            self.approve(self.resolve_scope())  # programmatic use: start = first pass
        conn = self._connect(self.config.db_path)
        try:
            top = chatdb.max_message_rowid(conn)
            if self.state.cursor is None:
                # First run: start from "now" so nothing old is ever replayed.
                self.state.cursor = top
                self._log(f"first run: starting after message row {top}; older commands are ignored")
            elif self.state.cursor > top:
                self._log("the Messages database looks replaced (cursor is ahead of it); starting from now")
                self.state.cursor = top
            while True:
                rows = chatdb.new_rows(conn, self.state.cursor, self.config.batch)
                if not rows:
                    break
                for row in rows:
                    try:
                        if self._handle_row(conn, row):
                            answered += 1
                    except Exception as exc:  # one bad row must never stop the loop
                        self._log(f"error while handling message row {row.rowid}: {type(exc).__name__}: {clean(exc, 300)}")
                    self.state.cursor = row.rowid
        finally:
            conn.close()
            self.state.prune_cooldowns(self._clock())
            self.state.save()
        return answered

    def run_forever(self, stop: Optional[Callable[[], bool]] = None) -> None:
        """Poll until interrupted. Database errors are logged and retried with backoff."""
        backoff = self.config.poll_interval
        last_error = ""
        while not (stop and stop()):
            try:
                self.run_once()
                backoff = self.config.poll_interval
                last_error = ""
            except (chatdb.ChatDbError, sqlite3.Error) as exc:
                err = exc if isinstance(exc, chatdb.ChatDbError) else chatdb.explain_db_error(exc, self.config.db_path)
                text = str(err)
                if text != last_error:  # say it once, not every two seconds
                    self._log(f"cannot read the Messages database: {text}")
                    if err.hint:
                        self._log(err.hint)
                    last_error = text
                backoff = min(30.0, max(backoff * 2, self.config.poll_interval))
            self._sleep(backoff)

    # -- one row -------------------------------------------------------------

    def _handle_row(self, conn: sqlite3.Connection, row: chatdb.NewRow) -> bool:
        if row.rowid in self.state.own_rowids:
            return False  # one of our own replies
        if row.associated_type >= 1000 or row.item_type != 0:
            return False  # tapbacks, stickers, renames, joins: never commands
        text = self.engine.decode_text(row.text, row.attributed_body)
        now = self._clock()
        trigger = parse_trigger(text, current_year=_dt.datetime.fromtimestamp(now).year)
        if trigger is None:
            return False

        age = now - row.unix_time
        if age < -self.config.future_skew:
            # A message cannot come from the future. A date like that is a broken or
            # doctored row, and it would otherwise stay "fresh" for as long as it likes.
            self._log(f"ignored a /{trigger.command} dated {int(-age)} s in the future (row {row.rowid})")
            return False
        if age > self.config.stale_after:
            self._log(f"ignored a /{trigger.command} that is {int(age // 60)} min old (row {row.rowid})")
            return False

        chat_row = self._find_group_chat(conn, row.rowid)
        if chat_row is None:
            return False
        key = chat_row.identifier or chat_row.guid
        if self._approved is None or key not in self._approved:
            # Scope is the approved id set and nothing else. The chat's name is
            # deliberately not consulted and not logged.
            if key not in self._warned:
                self._warned.add(key)
                self._log(
                    f"ignored /{trigger.command} in a group chat that is not in the approved list "
                    f"(id ending {key[-4:]}); restart the helper to add it"
                )
            return False
        chat = self._chat_ref(chat_row)

        last = self.state.cooldowns.get(chat.key)
        if last is not None and 0 <= now - last < self.config.cooldown:
            wait = int(self.config.cooldown - (now - last)) + 1
            self._log(f'ignored /{trigger.command} in "{chat.name}": cooling down ({wait} s left)')
            return False

        outcome = self._answer(chat, trigger)
        self.outcomes.append(outcome)
        for res in outcome.results.values():
            self.state.remember_own(res.rowid)
        if outcome.sent_something:
            self.state.cooldowns[chat.key] = self._clock()
        self._log(outcome.line())
        for hint in dict.fromkeys(r.hint for r in outcome.results.values() if r.hint):
            self._log(hint)
        self.state.cursor = row.rowid
        self.state.save()  # persist before anything else can go wrong
        return outcome.sent_something

    def _find_group_chat(self, conn: sqlite3.Connection, rowid: int) -> Optional[chatdb.ChatRow]:
        """The group chat a message belongs to, retrying briefly while the join row is missing."""
        attempts = max(1, self.config.join_attempts)
        for attempt in range(attempts):
            rows = chatdb.chats_for_message(conn, rowid)
            if rows:
                groups = [r for r in rows if r.is_group]
                if not groups:
                    self._log(f"ignored a command outside a group chat (row {rowid})")
                    return None
                return groups[0]
            if attempt + 1 < attempts:
                self._sleep(self.config.join_delay)
        self._log(f"ignored a command whose chat never showed up in chat.db (row {rowid})")
        return None

    def _chat_ref(self, row: chatdb.ChatRow) -> ChatRef:
        key = row.identifier or row.guid
        known = self._known.get(key)
        # the current name if the group has one (an approved chat may have been
        # renamed since start), else the name worked out from its members at start
        name = safe_chat_name(row.display_name) or (known.name if known else "") or "Group chat"
        # Reply through the exact chat row the command arrived on.
        return ChatRef(
            guid=row.guid,
            identifier=row.identifier,
            name=name,
            rowid=row.rowid,
            members=known.members if known else 0,
        )

    def preview(self, chat: ChatRef, period: Optional[str] = None) -> TriggerOutcome:
        """Build exactly what a command in ``chat`` would produce, through the
        configured sender (a ``DryRunSender`` for ``wrapped preview``). Ignores
        the cursor, the allowlist and the cooldown, and changes no state."""
        return self._answer(chat, Trigger("wrapped", period))

    # -- answering -----------------------------------------------------------

    def _answer(self, chat: ChatRef, trigger: Trigger) -> TriggerOutcome:
        outcome = TriggerOutcome(chat=chat, trigger=trigger)
        try:
            stats = self.engine.compute_stats(self.config.db_path, chat, trigger.period, self.config.me)
        except Exception as exc:
            outcome.error = f"could not compute stats ({type(exc).__name__}: {clean(exc, 300)})"
            return outcome

        if int(((stats.get("totals") or {}).get("messages")) or 0) <= 0:
            line = empty_text(stats)
            assert_safe(line)
            outcome.results["text"] = self.sender.send_text(chat, line)
            return outcome

        if self._awards_hook is not None:
            try:
                stats = self._awards_hook(stats) or stats
            except Exception as exc:  # AI awards are optional; never let them block a reply
                self._log(f"AI awards skipped ({type(exc).__name__}); using the built-in ones")

        # Contact names are the owner's private labels, so everything that leaves
        # uses short names (docs/SCHEMA.md 2). --full-names keeps them in the link
        # only; the card and the text in the thread always use first names.
        full_stats = stats
        try:
            stats = shorten(stats, self.config.me)
        except Exception as exc:
            outcome.error = f"could not shorten names ({type(exc).__name__}: {clean(exc, 300)})"
            return outcome

        link = ""
        if self.config.link:
            try:
                link = self.engine.build_link(full_stats if self.config.full_names else stats, self.config.quotes)
            except Exception as exc:
                self._log(f"no link this time ({type(exc).__name__}: {clean(exc, 300)}); sending the card and text only")
        text = "\n".join(recap_lines(stats, with_link=bool(link)))
        assert_safe(text)
        if link:
            assert_safe(link)

        label = str((stats.get("period") or {}).get("label") or "")
        # the file name travels with the attachment, so no phone numbers in it either
        filename = f"threadback-{slugify(safe_chat_name(chat.name))}-{slugify(label, 'recap')}.png"
        with tempfile.TemporaryDirectory(prefix="threadback-") as tmp:
            if self.config.dry_run:
                folder = self._dry_run_folder(chat)
                outcome.out_dir = folder
            else:
                folder = Path(tmp)
            card_path = folder / filename
            try:
                self._render_card(stats, card_path)
            except Exception as exc:
                outcome.error = f"could not render the card ({type(exc).__name__}: {clean(exc, 300)})"
                return outcome
            if self.config.dry_run:
                (folder / "recap.txt").write_text(text + "\n", encoding="utf-8")
                (folder / "link.txt").write_text((link or "") + "\n", encoding="utf-8")

            res = self.sender.send_file(chat, card_path)
            outcome.results["card"] = res
            if _stop_after(res):
                return outcome
            res = self.sender.send_text(chat, text)
            outcome.results["text"] = res
            if _stop_after(res) or not link:
                return outcome
            # The link goes alone: Messages only builds a preview for a bare URL.
            outcome.results["link"] = self.sender.send_text(chat, link)
        return outcome

    def _render_card(self, stats: dict, path: Path) -> None:
        if self._render is not None:
            self._render(stats, path)
            return
        from .card import render_card  # imported late: Pillow is only needed here

        render_card(stats, path)

    def _dry_run_folder(self, chat: ChatRef) -> Path:
        base = self.config.out_dir or (Path.home() / "Pictures" / PRODUCT_NAME / "dry-run")
        stamp = _dt.datetime.fromtimestamp(self._clock()).strftime("%Y%m%d-%H%M%S")
        slug = slugify(safe_chat_name(chat.name))
        folder = Path(base) / f"{stamp}-{slug}"
        n = 1
        while folder.exists():
            n += 1
            folder = Path(base) / f"{stamp}-{slug}-{n}"
        folder.mkdir(parents=True)
        return folder


def _stop_after(res: SendResult) -> bool:
    """Stop the card/text/link sequence when carrying on could only make noise."""
    return res.status == FAILED or res.orphan


# -- consent ------------------------------------------------------------------


def scope_signature(config: AgentConfig, allowed: Sequence[ChatRef]) -> str:
    """What exactly the owner agreed to: the set of chat ids and what a reply
    carries. A different set (one more chat, in either mode) asks again, and so
    does asking for more than was approved before (message text or full contact
    names in the link, or a link at all); a renamed chat does not."""
    carries = [name for name, on in (("link", config.link), ("quotes", config.link and config.quotes),
                                     ("full-names", config.link and config.full_names)) if on]
    return "chats:" + "|".join(sorted(c.key for c in allowed)) + ";carries:" + ",".join(carries)


def consent_text(config: AgentConfig, allowed: Sequence[ChatRef], total_groups: int) -> str:
    """The exact statement shown before the helper is allowed to send anything."""
    lines = [
        f"{PRODUCT_NAME} is about to start answering commands in your group chats.",
        "",
        "Replies are sent from YOUR Apple ID into these group chats when someone types /wrapped",
        "(or /recap, optionally followed by a year or 'all'):",
    ]
    if config.all_chats:
        lines.append(f"  EVERY group chat on this Mac as of now ({len(allowed)}):")
    for chat in sorted(allowed, key=lambda c: c.name.casefold()):
        members = f" ({chat.members} members)" if chat.members else ""
        lines.append(f"  - {chat.name}{members}")
    if config.all_chats:
        lines.append("Groups created later are NOT included until you restart the helper and approve them.")
    else:
        lines.append("Only these exact chats. A chat that is created or renamed later is not added,")
        lines.append("whatever it is called; restart the helper to approve a new one.")
    lines.append("")
    if config.link:
        lines += [
            "Each reply is three messages that everyone in the chat will see: a recap image,",
            "a short text recap, and a link that carries the recap"
            + (" (including the text of the most-reacted messages, because you passed --quotes)."
               if config.quotes else " (numbers and names only; no message text)."),
        ]
    else:
        lines.append("Each reply is two messages that everyone in the chat will see: a recap image and a short text recap.")
    lines += [
        f'Your own messages appear under the name "{clean(config.me, 40)}" (change it with --me NAME).',
        "Other people appear under their first names"
        + (", and the link carries their full contact names (--full-names)." if config.full_names else "."),
        f"At most one reply per chat every {int(config.cooldown)} seconds. Anyone in the chat can trigger it.",
        "Your messages are read on this Mac only; nothing is uploaded.",
    ]
    return "\n".join(lines)


def acquire_lock(path: os.PathLike):
    """Hold an exclusive lock so two helpers cannot answer the same command.

    Returns the open file (keep a reference), or ``None`` if another process
    holds the lock."""
    import fcntl

    p = Path(path)
    private_dir(p.parent)
    fh = open(p, "a+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return None
    return fh
