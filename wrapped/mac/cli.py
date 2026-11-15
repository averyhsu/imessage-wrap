"""Mac-helper commands for the ``wrapped`` command line.

``register(subparsers)`` is called by the core CLI (``wrapped/cli.py``) and adds:

    wrapped agent      answer /wrapped typed in your group chats (asks first)
    wrapped preview    build the card, text and link for one chat; sends nothing
    wrapped card       render a card from a stats JSON file
    wrapped send-test  send one harmless line to ONE chat, after you confirm
    wrapped doctor     check permissions and setup; sends nothing

Each sub-parser sets ``func`` (a callable taking the parsed arguments and
returning an exit status), the convention the core CLI uses.

Nothing here sends a message unless the person running it has agreed in this
terminal (or passed ``--yes`` after reading what it does).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import functools
import json
import os
import platform
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, List, Optional, Sequence

from . import PRODUCT_NAME, chatdb, send
from .agent import Agent, AgentConfig, acquire_lock, consent_text, match_chats, sanitize_chats, scope_signature
from .engine import ChatRef, EngineError
from .state import append_private, default_state_path, home_dir
from .fmt import account_first_name, clean, scrub
from .text import assert_safe

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2
EXIT_UNVERIFIED = 3

TEST_LINE = f"{PRODUCT_NAME} test ✅ (sent by a setup check; you can ignore this)"


class CliError(Exception):
    """A problem to show the user as-is. ``hint`` adds what to do about it."""

    def __init__(self, message: str, hint: str = "", code: int = EXIT_ERROR) -> None:
        super().__init__(message)
        self.hint = hint
        self.code = code


def _printable(text: object) -> str:
    """Console output never carries control or reordering characters, whatever
    name or error text ended up in it (line breaks are kept)."""
    return "\n".join(scrub(part) for part in str(text).split("\n"))


def _say(text: str = "") -> None:
    print(_printable(text), flush=True)


def _err(text: str) -> None:
    print(_printable(text), file=sys.stderr, flush=True)


def _friendly(func: Callable[[argparse.Namespace], int]) -> Callable[[argparse.Namespace], int]:
    """Turn the helper's own errors into a plain message and an exit status."""

    @functools.wraps(func)
    def wrapper(args: argparse.Namespace) -> int:
        try:
            return int(func(args) or 0)
        except CliError as exc:
            _err(f"{PRODUCT_NAME}: {exc}")
            if exc.hint:
                _err(exc.hint)
            return exc.code
        except chatdb.ChatDbError as exc:
            _err(f"{PRODUCT_NAME}: {exc}")
            if exc.hint:
                _err(exc.hint)
            return EXIT_ERROR
        except EngineError as exc:
            _err(f"{PRODUCT_NAME}: {exc}")
            return EXIT_ERROR
        except KeyboardInterrupt:
            _err("")
            _err("Stopped.")
            return 130

    return wrapper


# -- shared options ---------------------------------------------------------------


def _add_source_options(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group("where the messages come from")
    group.add_argument("--db", metavar="PATH", help="Messages database (default: ~/Library/Messages/chat.db)")
    group.add_argument("--me", metavar="NAME", default=None,
                       help="your own name in the recap (default: the first name of this Mac's account, else Me)")
    group.add_argument("--contacts", metavar="PATH", action="append",
                       help="address-book database or folder to take names from (default: found automatically)")
    group.add_argument("--no-contacts", action="store_true",
                       help="do not look names up in Contacts (numbers show as \u20261234)")


def _add_ai_options(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group("AI awards (optional, off by default)")
    group.add_argument("--ai", action="store_true",
                       help="let a Claude model write the awards. Sends aggregate stats (no message text) "
                            "to Anthropic's API using ANTHROPIC_API_KEY, after asking you")
    group.add_argument("--ai-model", metavar="MODEL", default=None, help="model id (default: claude-sonnet-5-5)")
    group.add_argument("--ai-quotes", action="store_true",
                       help="also send the text of the most-reacted messages to the model")
    group.add_argument("--ai-yes", action="store_true", help="skip the AI consent question (you have read it)")


def _resolve_me(args: argparse.Namespace) -> str:
    """``--me`` if given, else the first name of the macOS account, else "Me"."""
    given = clean(getattr(args, "me", None), 40)
    args.me = given or account_first_name()
    return args.me


def _db_path(args: argparse.Namespace) -> Path:
    return Path(args.db).expanduser() if getattr(args, "db", None) else chatdb.default_db_path()


def _engine(args: argparse.Namespace):
    from .engine import load_engine

    engine = load_engine()
    engine.me = _resolve_me(args)
    if getattr(args, "no_contacts", False):
        engine.contacts = False
    elif getattr(args, "contacts", None):
        engine.contacts = list(args.contacts)
    return engine


def _preflight(db_path: Path) -> None:
    """Fail early, with the Full Disk Access steps, if chat.db cannot be read."""
    conn = chatdb.open_ro(db_path)
    try:
        chatdb.max_message_rowid(conn)
    except chatdb.sqlite3.Error as exc:
        raise chatdb.explain_db_error(exc, db_path) from exc
    finally:
        conn.close()


def _list_chats(engine, db_path: Path) -> List[ChatRef]:
    try:
        return sanitize_chats(engine.list_group_chats(db_path))
    except Exception as exc:
        if type(exc).__name__ == "DatabaseError":  # the core package's user-facing error
            raise CliError(str(exc)) from exc
        raise


def _one_chat(chats: Sequence[ChatRef], pattern: str) -> ChatRef:
    """Exactly one chat for a name; an exact name beats a partial match."""
    wanted = pattern.casefold().strip()
    if not wanted:
        raise CliError("give the chat's name with --chat", code=EXIT_USAGE)
    exact = [c for c in chats if c.name.casefold() == wanted]
    found = exact or match_chats(chats, [pattern])
    if len(found) == 1:
        return found[0]
    if not found:
        raise CliError(f'no group chat matches "{pattern}".', "Run `wrapped chats` to see the names.")
    listing = "\n".join(f"  - {c.name}" for c in found[:15])
    raise CliError(f'{len(found)} group chats match "{pattern}". Use a longer part of the name:\n{listing}')


def _ask(question: str, expect: Sequence[str] = ("y", "yes")) -> bool:
    try:
        answer = input(question)
    except EOFError:
        return False
    return answer.strip().lower() in expect


def _ai_hook(args: argparse.Namespace, state, log: Callable[[str], None], interactive: bool):
    """Consent for ``--ai`` and the function that swaps the awards in."""
    if not getattr(args, "ai", False):
        return None
    from . import ai

    config = ai.AiConfig(model=args.ai_model or ai.DEFAULT_MODEL, quotes=bool(args.ai_quotes))
    signature = ai.consent_signature(config)
    if state is None or state.consent.get("ai") != signature:
        _say(ai.consent_text(config.model, config.quotes))
        if args.ai_yes:
            _say("(--ai-yes given: continuing.)")
        elif interactive:
            if not _ask("Send the stats to the API for AI awards? [y/N] "):
                raise CliError("AI awards were not approved. Run again without --ai to use the built-in awards.")
        else:
            raise CliError(
                "AI awards need your OK and this is not an interactive terminal.",
                "Read the text above, then add --ai-yes.",
                EXIT_USAGE,
            )
        if state is not None:
            state.consent["ai"] = signature
            state.save()
        _say()
    if not (os.environ.get(ai.KEY_ENV) or "").strip():
        _say(f"Note: {ai.KEY_ENV} is not set, so the built-in awards will be used until it is.")
    return lambda stats: ai.apply_ai_awards(stats, config, log=log)


def _open_folder(path: Path) -> None:
    if sys.platform == "darwin":
        try:
            subprocess.run(["/usr/bin/open", str(path)], check=False, timeout=10)  # noqa: S603
        except (OSError, subprocess.SubprocessError):
            pass


# -- agent -------------------------------------------------------------------------


def _make_logger(log_path: Optional[Path]) -> Callable[[str], None]:
    if log_path is not None:
        try:
            append_private(log_path, "")  # create it 0600 now, or tighten an older one
        except OSError:
            pass

    def log(line: str) -> None:
        stamp = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for part in str(line).splitlines() or [""]:
            text = f"{stamp}  {scrub(part)}"  # no control or reordering characters, whatever was logged
            print(text, flush=True)
            if log_path is not None:
                try:
                    append_private(log_path, text + "\n")  # 0600: it names your chats
                except OSError:
                    pass  # logging to a file is a convenience, never a reason to stop

    return log


@_friendly
def cmd_agent(args: argparse.Namespace) -> int:
    patterns = [p for p in (args.chat or []) if p and p.strip()]
    if not patterns and not args.all_chats:
        raise CliError(
            "say where the helper may reply.",
            'Use --chat "Name" (repeat it for more chats; part of the name is enough) or --all-chats.\n'
            "Run `wrapped chats` to see your group chats. Add --dry-run to try it without sending anything.",
            EXIT_USAGE,
        )
    if args.all_chats and patterns:
        raise CliError("use either --chat or --all-chats, not both.", code=EXIT_USAGE)
    if args.cooldown < 0 or args.poll <= 0:
        raise CliError("--cooldown must be 0 or more and --poll must be positive.", code=EXIT_USAGE)

    db_path = _db_path(args)
    state_path = Path(args.state).expanduser() if args.state else default_state_path()
    log_path = None if args.no_log else (Path(args.log).expanduser() if args.log else state_path.parent / "agent.log")
    log = _make_logger(log_path)
    interactive = sys.stdin.isatty()

    _preflight(db_path)
    engine = _engine(args)
    config = AgentConfig(
        db_path=db_path,
        state_path=state_path,
        chats=patterns,
        all_chats=bool(args.all_chats),
        me=args.me,
        cooldown=float(args.cooldown),
        poll_interval=float(args.poll),
        dry_run=bool(args.dry_run),
        out_dir=Path(args.out).expanduser() if args.out else None,
        quotes=bool(args.quotes) and not args.no_quotes,
        link=not args.no_link,
        full_names=bool(args.full_names),
    )
    if config.dry_run:
        sender: Any = send.DryRunSender()
    else:
        if send.find_osascript() is None:
            raise CliError("sending needs macOS with the Messages app.", send.NOT_MACOS_HINT)
        sender = send.MessagesSender(db_path, decode=engine.decode_text)

    lock = acquire_lock(str(state_path) + ".lock")
    if lock is None:
        raise CliError(
            "another copy of the helper is already running with this state file.",
            "Stop it first (Ctrl-C in its window), or two helpers would answer the same command.",
        )
    try:
        agent = Agent(config, engine, sender, log=log)
        all_groups = _list_chats(engine, db_path)
        # Names are resolved to chats exactly once, here. What is listed below is
        # what gets approved, and from then on only those chat ids are in scope.
        allowed = list(all_groups) if config.all_chats else match_chats(all_groups, patterns)
        if not config.all_chats:
            for pattern in patterns:
                if not match_chats(all_groups, [pattern]):
                    raise CliError(f'no group chat matches --chat "{pattern}".', "Run `wrapped chats` to see the names.")
        if not allowed:
            raise CliError("there are no group chats to reply in.")

        if config.dry_run:
            _say(f"{PRODUCT_NAME} DRY RUN: nothing will be sent and Messages is never touched.")
            where = ", ".join(f'"{c.name}"' for c in allowed)
            _say(f"Watching for /wrapped in: {where}")
            _say("(Only these chats. One that is created or renamed later needs a restart.)")
            _say(f"Cards, text and links are written to: {config.out_dir or (send.staging_dir() / 'dry-run')}")
        else:
            signature = scope_signature(config, allowed)
            _say(consent_text(config, allowed, len(all_groups)))
            _say()
            if agent.state.consent.get("send") == signature:
                _say("You approved exactly this before; continuing. (Change the chats and it asks again.)")
            elif args.yes:
                _say("(--yes given: continuing.)")
            elif interactive:
                if not _ask("Start replying in these chats? [y/N] "):
                    raise CliError("not started. Nothing was sent.")
            else:
                raise CliError(
                    "this needs your OK and this is not an interactive terminal.",
                    "Read the text above, then add --yes.",
                    EXIT_USAGE,
                )
            agent.state.consent["send"] = signature
            agent.state.save()
        agent.approve(allowed)
        _say()

        agent._awards_hook = _ai_hook(args, agent.state, log, interactive)

        if args.from_rowid is not None:
            agent.state.cursor = max(0, int(args.from_rowid))

        awake = None
        if args.keep_awake and sys.platform == "darwin" and os.path.exists("/usr/bin/caffeinate"):
            # -i: no idle sleep while we run; -w: quit when this process does
            awake = subprocess.Popen(["/usr/bin/caffeinate", "-i", "-w", str(os.getpid())])  # noqa: S603
            _say("Keeping this Mac awake while the helper runs (caffeinate -i). Closing the lid still sleeps it.")
        try:
            if args.once:
                answered = agent.run_once()
                _say(f"Done: {answered} command(s) answered.")
                for outcome in agent.outcomes:
                    if outcome.out_dir:
                        _say(f"Wrote {outcome.out_dir}")
                return EXIT_OK
            _say("Listening. Type /wrapped in an approved group chat. Press Ctrl-C to stop.")
            agent.run_forever()
        finally:
            if awake is not None:
                awake.terminate()
    finally:
        lock.close()
    return EXIT_OK


# -- preview / card ----------------------------------------------------------------


def _period(args: argparse.Namespace) -> Optional[str]:
    if getattr(args, "all_time", False):
        if getattr(args, "year", None):
            raise CliError("choose --year or --all-time, not both.", code=EXIT_USAGE)
        return "all"
    year = getattr(args, "year", None)
    return str(year) if year else None


@_friendly
def cmd_preview(args: argparse.Namespace) -> int:
    db_path = _db_path(args)
    _preflight(db_path)
    engine = _engine(args)
    chat = _one_chat(_list_chats(engine, db_path), args.chat)
    # Never the current folder: a recap dropped into a project or a synced folder by
    # accident is how private things get committed or shared.
    out_dir = Path(args.out).expanduser() if args.out else send.staging_dir() / "preview"
    config = AgentConfig(
        db_path=db_path, state_path=Path(os.devnull), me=args.me, dry_run=True, out_dir=out_dir,
        quotes=bool(args.quotes) and not args.no_quotes, link=not args.no_link,
        full_names=bool(args.full_names),
    )
    logs: List[str] = []
    agent = Agent(config, engine, send.DryRunSender(), log=logs.append)
    agent.state.path = None  # a preview never writes state
    agent._awards_hook = _ai_hook(args, None, _say, sys.stdin.isatty())
    outcome = agent.preview(chat, _period(args))
    for line in logs:
        _say(line)
    if outcome.error:
        raise CliError(outcome.error)
    _say(f'Preview for "{chat.name}" (nothing was sent):')
    _say()
    for item in agent.sender.sent:
        if item["kind"] == "file":
            _say(f"[image]  {item['path']}")
        else:
            _say(item["text"])
        _say()
    if outcome.out_dir:
        _say(f"Saved in {outcome.out_dir}")
        if args.open:
            _open_folder(outcome.out_dir)
    return EXIT_OK


def _default_card_path(stats: dict) -> Path:
    """``~/Pictures/Threadback/card-<chat>-<period>.png``, never overwriting an earlier one.

    Not the current folder (see ``cmd_preview``), and not a ``threadback-`` name:
    those are staged attachments and get pruned."""
    from .agent import slugify
    from .fmt import safe_chat_name

    chat = slugify(safe_chat_name((stats.get("chat") or {}).get("name")))
    label = slugify(clean((stats.get("period") or {}).get("label"), 24), "recap")
    folder = send.staging_dir()
    candidate = folder / f"card-{chat}-{label}.png"
    n = 1
    while candidate.exists():
        n += 1
        candidate = folder / f"card-{chat}-{label}-{n}.png"
    return candidate


@_friendly
def cmd_card(args: argparse.Namespace) -> int:
    try:
        from .card import CardError, render_card
    except ImportError as exc:
        raise CliError(
            f"the card needs the Pillow imaging library ({exc}).",
            "Install it with:  python3 -m pip install pillow   (the installer does this for you).",
        ) from exc
    try:
        if args.stats == "-":
            stats = json.load(sys.stdin)
        else:
            with open(args.stats, encoding="utf-8") as fh:
                stats = json.load(fh)
    except OSError as exc:
        raise CliError(f"cannot read {args.stats}: {exc}") from exc
    except ValueError as exc:
        raise CliError(f"{args.stats} is not valid JSON: {exc}") from exc
    if not isinstance(stats, dict):
        raise CliError(f"{args.stats} does not hold a stats object.")
    size = (1080, 1350)
    if args.size:
        try:
            w, h = args.size.lower().split("x", 1)
            size = (int(w), int(h))
        except ValueError as exc:
            raise CliError("--size looks like 1080x1350.", code=EXIT_USAGE) from exc
    if args.output:
        out = Path(args.output).expanduser()
    else:
        out = _default_card_path(stats)
    try:
        render_card(stats, out, size=size)
    except CardError as exc:
        raise CliError(str(exc)) from exc
    _say(str(out))
    if args.open:
        _open_folder(out)
    return EXIT_OK


# -- send-test -----------------------------------------------------------------------


def _report(label: str, result: send.SendResult) -> None:
    _say(f"{label}: {result.status.upper()}" + (f" - {result.reason}" if result.reason else ""))
    if result.swapped:
        _say(f"  (Messages only accepted the other spelling of the chat id: {result.guid})")
    if result.hint:
        _say(result.hint)


@_friendly
def cmd_send_test(args: argparse.Namespace) -> int:
    db_path = _db_path(args)
    _preflight(db_path)
    engine = _engine(args)
    chat = _one_chat(_list_chats(engine, db_path), args.chat)
    text = args.text if args.text else TEST_LINE
    if len(text) > 300 or "\n" in text:
        raise CliError("the test line must be one short line.", code=EXIT_USAGE)
    try:
        assert_safe(text)
    except ValueError as exc:
        raise CliError("the test line must not be a command.", code=EXIT_USAGE) from exc

    members = f" ({chat.members} members)" if chat.members else ""
    _say(f"This sends ONE real message from YOUR Apple ID to the group chat \"{chat.name}\"{members}:")
    _say(f"    {text}")
    if args.with_image:
        _say("and then ONE small test picture.")
    _say("Everyone in that chat will see it.")
    if args.dry_run:
        _say("DRY RUN: nothing was sent.")
        return EXIT_OK
    if send.find_osascript() is None:
        raise CliError("sending needs macOS with the Messages app.", send.NOT_MACOS_HINT)
    if not _ask('Type "send" to send it, anything else to cancel: ', expect=("send",)):
        _say("Cancelled. Nothing was sent.")
        return EXIT_ERROR

    sender = send.MessagesSender(db_path, decode=engine.decode_text)
    result = sender.send_text(chat, text)
    _report("Text", result)
    worst = result
    if args.with_image and result.status != send.FAILED and not result.orphan:
        from .card import render_test_image

        with tempfile.TemporaryDirectory(prefix="threadback-") as tmp:
            image = render_test_image(Path(tmp) / "threadback-test.png")
            image_result = sender.send_file(chat, image)
        _report("Image", image_result)
        if image_result.status != send.DELIVERED:
            worst = image_result
    if worst.status == send.DELIVERED:
        _say("Verified: Messages recorded the message in that chat. Check another device to see it arrive.")
        return EXIT_OK
    if worst.status == send.UNVERIFIED:
        _say("Not verified: look at the chat on another device before trusting the helper with it.")
        return EXIT_UNVERIFIED
    return EXIT_ERROR


# -- doctor --------------------------------------------------------------------------


@_friendly
def cmd_doctor(args: argparse.Namespace) -> int:
    ok = True

    def line(good: Optional[bool], text: str) -> None:
        mark = {True: "ok  ", False: "FAIL", None: "note"}[good]
        _say(f"[{mark}] {text}")

    mac = platform.mac_ver()[0]
    line(bool(mac) or None, f"macOS {mac}" if mac else f"not macOS ({platform.system()}): reading works, sending does not")
    py = sys.version_info
    line(py >= (3, 9), f"Python {py.major}.{py.minor}.{py.micro}")
    ok = ok and py >= (3, 9)

    try:
        from .card import FontBook

        book = FontBook()
        emoji = "colour emoji available" if book.emoji_path else "no colour emoji font (emoji are left out of cards)"
        line(True, f"card renderer ready (Pillow, bundled font; {emoji})")
    except Exception as exc:
        line(False, f"card renderer: {exc}")
        ok = False

    db_path = _db_path(args)
    try:
        conn = chatdb.open_ro(db_path)
        try:
            total = conn.execute("SELECT COUNT(*) FROM message").fetchone()[0]
            groups = chatdb.group_chat_rows(conn)
            newest = conn.execute("SELECT MAX(date) FROM message").fetchone()[0]
        finally:
            conn.close()
        when = _dt.datetime.fromtimestamp(chatdb.apple_time_to_unix(newest)).strftime("%Y-%m-%d %H:%M") if newest else "-"
        line(True, f"can read {db_path}: {total:,} messages, {len(groups)} group chat rows, newest {when}")
    except chatdb.ChatDbError as exc:
        line(False, str(exc))
        if exc.hint:
            _say(exc.hint)
        groups = []
        ok = False
    except chatdb.sqlite3.Error as exc:
        err = chatdb.explain_db_error(exc, db_path)
        line(False, str(err))
        if err.hint:
            _say(err.hint)
        groups = []
        ok = False

    osa = send.find_osascript()
    line(bool(osa) or None, f"osascript at {osa}" if osa else "no osascript here: only --dry-run and preview work")

    if args.automation:
        if not osa:
            line(False, "--automation needs macOS")
            ok = False
        else:
            _say("Asking Messages for its list of chats (this sends nothing). macOS may ask whether this app")
            _say("may control Messages: choose Allow.")
            result = send.run_osascript(send.LIST_CHATS_SCRIPT, [], 30.0)
            if result.returncode != 0 or result.timed_out:
                reason, hint = send.explain_osascript_error(result)
                line(False, f"Messages automation: {reason}")
                if hint:
                    _say(hint)
                ok = False
            else:
                known = {ln.strip() for ln in result.stdout.splitlines() if ln.strip()}
                exact = [g for g in groups if g.guid in known]
                swapped = [g for g in groups if g.guid not in known and send.swap_guid_form(g.guid) in known]
                missing = len(groups) - len(exact) - len(swapped)
                line(True, f"Messages automation allowed; it lists {len(known)} chats")
                line(None, f"group chats whose id matches chat.db exactly: {len(exact)}")
                line(None, f"group chats only reachable under the other id spelling (;+; / ;-;): {len(swapped)}")
                line(None, f"group chats Messages does not list right now: {missing}")
                if swapped:
                    _say("       The helper retries with the other spelling and then checks chat.db, so a send")
                    _say("       there ends as delivered or as an honest 'unverified', never a silent success.")
    else:
        line(None, "Messages automation not checked (add --automation; it sends nothing)")

    given = clean(getattr(args, "me", None), 40)
    whose = given or account_first_name()
    source = "from --me" if given else ("from this Mac's account" if whose != "Me" else "no account name found")
    line(None, f'your name in recaps: "{whose}" ({source}; change it with --me NAME)')
    state_path = default_state_path()
    line(None, f"state: {state_path}" + ("" if state_path.exists() else " (not created yet)"))
    _say()
    _say("All good." if ok else "Something needs attention (see FAIL above).")
    return EXIT_OK if ok else EXIT_ERROR


# -- registration ------------------------------------------------------------------


def register(subparsers: Any) -> None:
    """Add the Mac-helper commands to an ``argparse`` sub-parsers object."""
    taken = set(getattr(subparsers, "choices", {}) or {})

    def name(wanted: str) -> str:
        return wanted if wanted not in taken else f"mac-{wanted}"

    agent = subparsers.add_parser(
        name("agent"),
        help="answer /wrapped typed in your group chats (asks before it ever sends)",
        description=(
            f"Watch your Messages database and, when someone types /wrapped (or /recap, optionally with a "
            f"year or 'all') in an approved group chat, reply in that chat with a recap image, a short text "
            f"and a link. Replies come from YOUR Apple ID. You must name the chats, and {PRODUCT_NAME} "
            "asks before it starts. Use --dry-run first: it sends nothing."
        ),
    )
    scope = agent.add_argument_group("where it may reply (required)")
    scope.add_argument("--chat", metavar="NAME", action="append",
                       help="a group chat it may reply in; part of the name is enough; repeat for more. "
                            "The matching chats are listed for your approval at start and fixed from then on")
    scope.add_argument("--all-chats", action="store_true",
                       help="every group chat that exists when the helper starts (think twice)")
    agent.add_argument("--dry-run", action="store_true",
                       help="send nothing; write the card, text and link to a folder instead")
    agent.add_argument("--out", metavar="DIR", help="folder for --dry-run output (default: ~/Pictures/Threadback/dry-run)")
    agent.add_argument("--once", action="store_true", help="handle commands that are waiting, then exit")
    agent.add_argument("--yes", action="store_true", help="skip the start question (you have read what it does)")
    agent.add_argument("--cooldown", type=float, default=120.0, metavar="SECONDS",
                       help="minimum time between replies in one chat (default: 120)")
    agent.add_argument("--poll", type=float, default=2.0, metavar="SECONDS", help="how often to look (default: 2)")
    agent.add_argument("--quotes", action="store_true",
                       help="include the text of the most-reacted messages in the link (off unless you ask)")
    agent.add_argument("--no-quotes", action="store_true", help="keep message text out of the link (the default)")
    agent.add_argument("--no-link", action="store_true", help="send the image and the text only, no link")
    agent.add_argument("--full-names", action="store_true",
                       help="keep people's full contact names in the link (default: first names)")
    agent.add_argument("--keep-awake", action="store_true",
                       help="stop this Mac from idle-sleeping while the helper runs (caffeinate -i)")
    agent.add_argument("--state", metavar="FILE", help="state file (default: ~/.threadback/state.json)")
    agent.add_argument("--log", metavar="FILE", help="log file (default: next to the state file)")
    agent.add_argument("--no-log", action="store_true", help="do not write a log file")
    agent.add_argument("--from-rowid", type=int, metavar="N", help=argparse.SUPPRESS)  # tests: start after row N
    _add_ai_options(agent)
    _add_source_options(agent)
    agent.set_defaults(func=cmd_agent)

    preview = subparsers.add_parser(
        name("preview"),
        help="build the card, text and link for one chat; sends nothing",
        description="Compute the recap for one group chat and write exactly what the helper would send "
                    "(card image, text, link) to a folder. Never sends anything and never touches Messages.",
    )
    preview.add_argument("--chat", metavar="NAME", required=True, help="the group chat (part of its name)")
    preview.add_argument("--year", type=int, metavar="YYYY", help="calendar year (default: this year)")
    preview.add_argument("--all-time", action="store_true", help="everything, not just one year")
    preview.add_argument("--out", metavar="DIR", help="where to write (default: ~/Pictures/Threadback/preview)")
    preview.add_argument("--quotes", action="store_true",
                         help="include the text of the most-reacted messages in the link (off unless you ask)")
    preview.add_argument("--no-quotes", action="store_true", help="keep message text out of the link (the default)")
    preview.add_argument("--no-link", action="store_true", help="leave the link out")
    preview.add_argument("--full-names", action="store_true",
                         help="keep people's full contact names in the link (default: first names)")
    preview.add_argument("--open", action="store_true", help="open the folder afterwards (macOS)")
    _add_ai_options(preview)
    _add_source_options(preview)
    preview.set_defaults(func=cmd_preview)

    card = subparsers.add_parser(
        name("card"),
        help="render the recap card from a stats JSON file",
        description="Render the 1080x1350 recap card (PNG) from a stats JSON file, e.g. one written by "
                    "`wrapped stats CHAT -o stats.json`. Uses aggregate numbers and first names only.",
    )
    card.add_argument("stats", metavar="STATS.json", help="stats file, or - for standard input")
    card.add_argument("-o", "--out", "--output", dest="output", metavar="FILE",
                      help="PNG to write (default: a new file in ~/Pictures/Threadback)")
    card.add_argument("--size", metavar="WxH", help="pixel size (default: 1080x1350)")
    card.add_argument("--open", action="store_true", help="open the image afterwards (macOS)")
    card.set_defaults(func=cmd_card)

    test = subparsers.add_parser(
        name("send-test"),
        help="send one harmless line to ONE chat, after you confirm",
        description="Send one short test line to exactly one group chat and check in chat.db that it "
                    "really went out. It shows what will be sent and where, and waits for you to type "
                    "\"send\". Use it once on a real Mac before trusting the helper.",
    )
    test.add_argument("--chat", metavar="NAME", required=True, help="the group chat (must match exactly one)")
    test.add_argument("--text", metavar="LINE", help="a different test line")
    test.add_argument("--with-image", action="store_true", help="also send a small test picture")
    test.add_argument("--dry-run", action="store_true", help="show what would be sent, then stop")
    _add_source_options(test)
    test.set_defaults(func=cmd_send_test)

    doctor = subparsers.add_parser(
        name("doctor"),
        help="check permissions and setup; sends nothing",
        description="Check that the Messages database can be read (Full Disk Access), that cards can be "
                    "rendered, and optionally that this app may control Messages. Never sends anything.",
    )
    doctor.add_argument("--automation", action="store_true",
                        help="also ask Messages for its chat list (triggers the macOS permission prompt)")
    doctor.add_argument("--db", metavar="PATH", help="Messages database (default: ~/Library/Messages/chat.db)")
    doctor.add_argument("--me", metavar="NAME", default=None, help="your own name in the recap")
    doctor.set_defaults(func=cmd_doctor)


def build_parser() -> argparse.ArgumentParser:
    """A parser with only the Mac-helper commands (``python -m wrapped.mac``)."""
    parser = argparse.ArgumentParser(
        prog="python -m wrapped.mac",
        description=f"{PRODUCT_NAME} Mac helper: answers /wrapped in your group chats.",
    )
    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")
    register(subparsers)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    parser = build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return EXIT_OK
    return int(func(args) or 0)


# keep the state folder helper importable for the installer's self-check
__all__ = ["register", "build_parser", "main", "home_dir"]
