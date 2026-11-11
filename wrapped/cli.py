"""Command line: ``python -m wrapped`` (or the ``wrapped`` console script).

    wrapped chats                         list group chats
    wrapped stats "Dinner Club"           write the stats JSON for one chat
    wrapped link  "Dinner Club"           print the share link

Sub-commands are registered on one ``argparse`` sub-parser object and each
sets ``func`` (a callable taking the parsed arguments and returning an exit
status). The optional ``wrapped.mac`` package adds its own commands through
``wrapped.mac.cli.register(subparsers)`` using the same convention.

The recap calls its owner by ``--me NAME``, else ``$WRAPPED_ME``, else the
first name of this Mac's user account, else "Me"; when nobody chose the name,
``stats`` and ``link`` say on standard error which one was used.

Whatever goes wrong with the input (a damaged database, a file that cannot be
written, a stats file that is not a recap) ends in one sentence on standard
error and exit status 1, never in a traceback. Set ``WRAPPED_DEBUG=1`` to see
the traceback of an unexpected error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from typing import Any, List, Optional

from . import api, payload
from .db import DatabaseError, _damaged
from .payload import LinkTooLongError
from .product import PRODUCT_NAME, TAGLINE
from .stats import _owner_name, short_names

EXIT_OK = 0
EXIT_ERROR = 1


def _add_source_options(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group("where the messages come from")
    group.add_argument("--db", metavar="PATH",
                       help="Messages database (default: ~/Library/Messages/chat.db)")
    group.add_argument("--backup", metavar="DIR", nargs="?", const="",
                       help="read the sms.db of an unencrypted iPhone backup instead; DIR is "
                            "the backup folder or the folder that holds several (default: "
                            "the standard MobileSync folder)")
    group.add_argument("--contacts", metavar="PATH", action="append",
                       help="address-book database (or AddressBook folder) to take names "
                            "from; may be repeated (default: found automatically)")
    group.add_argument("--no-contacts", action="store_true",
                       help="do not look names up in Contacts (numbers show as \u20261234)")
    group.add_argument("--me", metavar="NAME",
                       help="your own name in the recap (default: $WRAPPED_ME if set, else the "
                            "first name of this Mac's user account, else Me)")
    group.add_argument("--tz", metavar="ZONE",
                       help="IANA time zone for dates and hours, e.g. America/Chicago "
                            "(default: this computer's)")


def _add_period_options(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group("period")
    group.add_argument("--year", type=int, metavar="YYYY",
                       help="calendar year (default: this year, or last year in January)")
    group.add_argument("--all-time", action="store_true", help="everything, not just one year")
    group.add_argument("--start", metavar="YYYY-MM-DD", help="first day (inclusive)")
    group.add_argument("--end", metavar="YYYY-MM-DD", help="last day (inclusive)")
    parser.add_argument("--full-names", action="store_true",
                        help="keep people's names exactly as they are in Contacts (by default "
                             "the recap uses first names: \"Sam\", or \"Sam R.\" when two "
                             "people share one)")


def _open(args: argparse.Namespace) -> api.Source:
    contacts: Any = None
    if getattr(args, "no_contacts", False):
        contacts = False
    elif getattr(args, "contacts", None):
        contacts = args.contacts
    return api.open_source(db=args.db, backup=args.backup, contacts=contacts)


_GARBLING = re.compile("[\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]")


def _pretty(value: Any) -> str:
    """Indented JSON that is safe to print. ``json.dumps`` already escapes
    the C0 control characters; the others that can garble a terminal (DEL,
    C1, line separators, direction overrides) are escaped the same way."""
    text = json.dumps(value, ensure_ascii=False, indent=2)
    return _GARBLING.sub(lambda match: "\\u%04x" % ord(match.group(0)), text)


def _day(unix: Optional[int]) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(unix)) if unix else "-"


def _owner(args: argparse.Namespace) -> str:
    """The owner's name for this run: ``--me``, else ``$WRAPPED_ME``, else the
    first name of the Mac account, else "Me". Worked out once and kept on
    ``args``; ``args.me_looked_up`` says that nobody chose it."""
    if getattr(args, "owner", None) is None:
        given = args.me if args.me is not None else os.environ.get("WRAPPED_ME")
        args.me_looked_up = given is None
        args.owner = _owner_name(api.account_first_name() if given is None else given)
    return args.owner


def _say_who(args: argparse.Namespace) -> None:
    """One line on standard error when the recap's owner was not named by the
    user: which name is used, and how to change it."""
    name = _owner(args)
    if not args.me_looked_up:
        return
    if name == "Me":
        sys.stderr.write('%s: you are "Me" in this recap. Use --me NAME to put your name there.\n'
                         % PRODUCT_NAME)
    else:
        sys.stderr.write('%s: you are "%s" in this recap (the first name of this Mac\'s account). '
                         "Use --me NAME to change it.\n" % (PRODUCT_NAME, name))


def _stats_for(args: argparse.Namespace) -> Any:
    if args.year is not None and not 1 <= args.year <= 9999:
        raise ValueError("--year must be between 1 and 9999, for example --year 2026")
    if sum(bool(x) for x in (args.year is not None, args.all_time, args.start or args.end)) > 1:
        raise ValueError("choose one of --year, --all-time or --start/--end")
    with _open(args) as source:
        stats = source.stats(args.chat, year=args.year, me=_owner(args), tz=args.tz,
                             all_time=args.all_time, start=args.start, end=args.end)
    if not args.full_names:
        stats = short_names(stats, me=_owner(args))
    _say_who(args)
    return stats


def cmd_chats(args: argparse.Namespace) -> int:
    with _open(args) as source:
        chats = source.chats(_owner(args))
        info = source.diagnostics()
        kind = source.kind
    if args.json:
        # The listing for other programs: everything list_group_chats() knows,
        # which includes the members' raw handle ids ("participants").
        sys.stdout.write(_pretty({"source": kind, "diagnostics": info, "chats": chats}) + "\n")
        return EXIT_OK
    out = sys.stdout.write
    out("%s: %s messages in %s chats (%s group chats), %s to %s\n" % (
        kind, format(info["messages"], ","), format(info["chats"], ","),
        format(info["group_chats"], ","), _day(info["first_unix"]), _day(info["last_unix"])))
    if not chats:
        out("No group chats in this database.\n")
        return EXIT_OK
    out("\n%6s  %9s  %7s  %-10s  %s\n" % ("id", "messages", "members", "last", "name"))
    for chat in chats:          # names are cleaned by the engine: always one line each
        out("%6d  %9s  %7d  %-10s  %s\n" % (
            chat["id"], format(chat["messages"], ","), chat["members"],
            _day(chat["last_unix"]), chat["name"]))
    out("\nNext: wrapped stats ID   or   wrapped link ID\n")
    return EXIT_OK


def cmd_stats(args: argparse.Namespace) -> int:
    stats = _stats_for(args)
    text = payload.canonical_json(stats) if args.compact else _pretty(stats)
    if args.output and args.output != "-":
        try:
            with open(args.output, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
        except OSError as exc:
            raise ValueError("could not write %s (%s)" % (args.output, exc.strerror or exc))
        sys.stderr.write("%s: wrote %s (%s messages, %s)\n" % (
            PRODUCT_NAME, args.output, format(stats["totals"]["messages"], ","),
            stats["period"]["label"]))
    else:
        sys.stdout.write(text + "\n")
    return EXIT_OK


def _read_stats_file(path: str) -> Any:
    """A stats JSON file written earlier (``-`` is standard input)."""
    shown = "standard input" if path == "-" else path
    try:
        if path == "-":
            text = sys.stdin.read()
        else:
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
    except OSError as exc:
        raise ValueError("could not read %s (%s)" % (shown, exc.strerror or exc))
    except UnicodeDecodeError:
        raise ValueError("%s is not a text file, so it cannot be a recap" % shown)
    try:
        stats = json.loads(text)
    except RecursionError:
        raise ValueError("%s is nested too deeply to be a recap" % shown)
    except ValueError as exc:
        raise ValueError("%s is not valid JSON (%s)" % (shown, exc))
    if not isinstance(stats, dict):
        raise ValueError("%s does not hold a recap: expected a JSON object, found %s"
                         % (shown, "a list" if isinstance(stats, list) else "a single value"))
    return stats


def cmd_link(args: argparse.Namespace) -> int:
    if args.stats:
        if args.chat:
            raise ValueError("give either a chat or --stats FILE, not both")
        stats = _read_stats_file(args.stats)        # used as it is: names are not changed
    elif args.chat:
        stats = _stats_for(args)
    else:
        raise ValueError("which chat? Give its name or id, or --stats FILE")
    result = payload.fit_link(stats, quotes=bool(args.quotes) and not args.no_quotes,
                              base_url=args.base_url or payload.BASE_URL)
    sys.stdout.write(result["url"] + "\n")
    if result["steps"]:
        sys.stderr.write(
            "%s: the full recap was too long for a link, so it was shortened "
            "(trim level %d of %d).\n" % (PRODUCT_NAME, result["steps"], payload.TRIM_STEPS))
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="wrapped",
        description="%s: %s. Reads your Messages database on this computer (read-only) and "
                    "turns one group chat into a recap. Works with iMessage; nothing is "
                    "uploaded." % (PRODUCT_NAME, TAGLINE))
    parser.add_argument("--version", action="version",
                        version="%s (wrapped %s)" % (PRODUCT_NAME, _version()))
    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")

    chats = subparsers.add_parser("chats", help="list group chats with message counts")
    _add_source_options(chats)
    chats.add_argument("--json", action="store_true",
                       help="the full listing for other programs; it includes the members' "
                            "phone numbers and addresses, so do not share it")
    chats.set_defaults(func=cmd_chats)

    stats = subparsers.add_parser("stats", help="write the stats JSON for one chat")
    stats.add_argument("chat", metavar="CHAT", help="chat id, or part of its name")
    _add_period_options(stats)
    _add_source_options(stats)
    stats.add_argument("-o", "--output", metavar="FILE", help="write here instead of printing")
    stats.add_argument("--compact", action="store_true", help="one line, no indentation")
    stats.set_defaults(func=cmd_stats)

    link = subparsers.add_parser("link", help="print the share link for one chat")
    link.add_argument("chat", metavar="CHAT", nargs="?", help="chat id, or part of its name")
    link.add_argument("--stats", metavar="FILE",
                      help="build the link from a stats JSON file instead of a chat (the "
                           "file is used as it is)")
    link.add_argument("--quotes", action="store_true",
                      help="include the text of the most-reacted messages in the link "
                           "(off unless you ask for it)")
    link.add_argument("--no-quotes", action="store_true",
                      help="leave message text out of the link (the default)")
    link.add_argument("--base-url", metavar="URL", help=argparse.SUPPRESS)
    _add_period_options(link)
    _add_source_options(link)
    link.set_defaults(func=cmd_link)

    try:  # the Mac helper (agent, card, sender) registers its own commands
        from wrapped.mac import cli as _mac_cli
        _mac_cli.register(subparsers)
    except ImportError:
        pass
    return parser


def _version() -> str:
    from . import __version__
    return __version__


def _sentence(exc: BaseException) -> str:
    """One line for the person at the keyboard."""
    if isinstance(exc, (sqlite3.Error, sqlite3.Warning, UnicodeError)):
        return str(_damaged(exc))
    if isinstance(exc, RecursionError):
        return "that file is nested too deeply to be a recap"
    if isinstance(exc, MemoryError):
        return "this needs more memory than the computer has free"
    if isinstance(exc, OSError):
        target = getattr(exc, "filename", None)
        reason = exc.strerror or exc.__class__.__name__
        return "could not use %s (%s)" % (target, reason) if target else reason
    if isinstance(exc, (DatabaseError, LinkTooLongError, ValueError)):
        return str(exc)
    return "something unexpected went wrong (%s: %s). Set WRAPPED_DEBUG=1 to see the details." % (
        exc.__class__.__name__, exc)


def main(argv: Optional[List[str]] = None) -> int:
    """Run the CLI. Returns the process exit status."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return EXIT_OK
    try:
        return int(func(args) or 0)
    except BrokenPipeError:
        return EXIT_OK
    except KeyboardInterrupt:
        return 130
    except Exception as exc:        # never a traceback for the person at the keyboard
        if os.environ.get("WRAPPED_DEBUG"):
            raise
        sys.stderr.write("%s: %s\n" % (PRODUCT_NAME, " ".join(_sentence(exc).splitlines())
                                       if not isinstance(exc, DatabaseError) else _sentence(exc)))
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
