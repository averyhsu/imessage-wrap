"""Command line: ``python -m wrapped`` (or the ``wrapped`` console script).

    wrapped chats                         list group chats
    wrapped stats "Dinner Club"           write the stats JSON for one chat
    wrapped link  "Dinner Club"           print the share link

Sub-commands are registered on one ``argparse`` sub-parser object and each
sets ``func`` (a callable taking the parsed arguments and returning an exit
status). The optional ``wrapped.mac`` package adds its own commands through
``wrapped.mac.cli.register(subparsers)`` using the same convention.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any, List, Optional

from . import api, payload
from .db import DatabaseError
from .payload import LinkTooLongError
from .product import PRODUCT_NAME, TAGLINE

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
    group.add_argument("--me", metavar="NAME", default="Me",
                       help="your own name in the recap (default: Me)")
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


def _open(args: argparse.Namespace) -> api.Source:
    contacts: Any = None
    if getattr(args, "no_contacts", False):
        contacts = False
    elif getattr(args, "contacts", None):
        contacts = args.contacts
    return api.open_source(db=args.db, backup=args.backup, contacts=contacts)


def _day(unix: Optional[int]) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(unix)) if unix else "-"


def _stats_for(args: argparse.Namespace) -> Any:
    if sum(bool(x) for x in (args.year, args.all_time, args.start or args.end)) > 1:
        raise ValueError("choose one of --year, --all-time or --start/--end")
    with _open(args) as source:
        return source.stats(args.chat, year=args.year, me=args.me, tz=args.tz,
                            all_time=args.all_time, start=args.start, end=args.end)


def cmd_chats(args: argparse.Namespace) -> int:
    with _open(args) as source:
        chats = source.chats(args.me)
        info = source.diagnostics()
        kind = source.kind
    if args.json:
        json.dump({"source": kind, "diagnostics": info, "chats": chats}, sys.stdout,
                  ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return EXIT_OK
    out = sys.stdout.write
    out("%s: %s messages in %s chats (%s group chats), %s to %s\n" % (
        kind, format(info["messages"], ","), format(info["chats"], ","),
        format(info["group_chats"], ","), _day(info["first_unix"]), _day(info["last_unix"])))
    if not chats:
        out("No group chats in this database.\n")
        return EXIT_OK
    out("\n%6s  %9s  %7s  %-10s  %s\n" % ("id", "messages", "members", "last", "name"))
    for chat in chats:
        out("%6d  %9s  %7d  %-10s  %s\n" % (
            chat["id"], format(chat["messages"], ","), chat["members"],
            _day(chat["last_unix"]), chat["name"]))
    out("\nNext: wrapped stats ID   or   wrapped link ID\n")
    return EXIT_OK


def cmd_stats(args: argparse.Namespace) -> int:
    stats = _stats_for(args)
    text = (payload.canonical_json(stats) if args.compact
            else json.dumps(stats, ensure_ascii=False, indent=2))
    if args.output and args.output != "-":
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        sys.stderr.write("%s: wrote %s (%s messages, %s)\n" % (
            PRODUCT_NAME, args.output, format(stats["totals"]["messages"], ","),
            stats["period"]["label"]))
    else:
        sys.stdout.write(text + "\n")
    return EXIT_OK


def cmd_link(args: argparse.Namespace) -> int:
    if args.stats:
        if args.chat:
            raise ValueError("give either a chat or --stats FILE, not both")
        with (sys.stdin if args.stats == "-" else open(args.stats, encoding="utf-8")) as handle:
            stats = json.load(handle)
    elif args.chat:
        stats = _stats_for(args)
    else:
        raise ValueError("which chat? Give its name or id, or --stats FILE")
    result = payload.fit_link(stats, quotes=not args.no_quotes,
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
    chats.add_argument("--json", action="store_true", help="machine-readable output")
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
                      help="build the link from a stats JSON file instead of a chat")
    link.add_argument("--no-quotes", action="store_true",
                      help="leave message text out of the link")
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


def main(argv: Optional[List[str]] = None) -> int:
    """Run the CLI. Returns the process exit status."""
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
    try:
        return int(func(args) or 0)
    except (DatabaseError, LinkTooLongError) as exc:
        sys.stderr.write("%s: %s\n" % (PRODUCT_NAME, exc))
        return EXIT_ERROR
    except ValueError as exc:
        sys.stderr.write("%s: %s\n" % (PRODUCT_NAME, exc))
        return EXIT_ERROR
    except BrokenPipeError:
        return EXIT_OK
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
