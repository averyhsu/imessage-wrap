"""Sending into a group chat through Messages, and proving that it happened.

Rules this module enforces (from docs/research/03-mac-chatdb-applescript.md):

- The chat GUID, the text and the file path are passed to ``osascript`` as ARGV.
  They are never interpolated into AppleScript source.
- AppleScript can report success while delivering nothing (macOS 26 stores
  ``any;+;chat…`` in chat.db while Messages may expose ``any;-;chat…``). So every
  send is checked in ``chat.db``: only a new outgoing row *joined to that chat*
  counts as delivered.
- Error ``-1728`` ("can't get chat id") means nothing was sent, so it gets exactly
  one retry with the other GUID spelling. Nothing else is ever retried.
- Messages can only attach files from ``~/Pictures``, ``~/Downloads`` and
  ``~/Documents``, so attachments are staged in ``~/Pictures/Threadback/``.

Every send ends in exactly one of: ``delivered``, ``unverified``, ``failed``
(or ``dry-run`` for the recorder), always with a reason.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

from . import PRODUCT_NAME, chatdb
from .engine import ChatRef

DELIVERED = "delivered"
UNVERIFIED = "unverified"
FAILED = "failed"
DRY_RUN = "dry-run"

# One action per run: text OR file (the caller passes "" for the other).
# The alias is resolved outside the ``tell`` block so that ``POSIX file`` is
# evaluated by AppleScript itself rather than in the context of Messages.
SEND_SCRIPT = """\
on run argv
	set chatGuid to item 1 of argv
	set messageText to item 2 of argv
	set filePath to item 3 of argv
	if filePath is not "" then set attachmentFile to (POSIX file filePath) as alias
	tell application "Messages"
		set targetChat to chat id chatGuid
		if messageText is not "" then send messageText to targetChat
		if filePath is not "" then send attachmentFile to targetChat
	end tell
end run
"""

# Read-only diagnostic used by ``wrapped doctor --automation``: lists the chat ids
# Messages exposes to AppleScript. It sends nothing.
LIST_CHATS_SCRIPT = """\
tell application "Messages"
	set chatIds to id of every chat
end tell
set AppleScript's text item delimiters to linefeed
return chatIds as text
"""

AUTOMATION_HINT = (
    "macOS has not allowed this app to control Messages.\n"
    "  1. Open System Settings > Privacy & Security > Automation\n"
    "  2. Find the app you run this from (Terminal, iTerm, VS Code, ...) and turn on 'Messages'\n"
    "  3. Run the command again\n"
    "If the app is not listed, run:  tccutil reset AppleEvents   and try again; "
    "macOS will ask \"... wants to control Messages\" - choose Allow."
)
CHAT_NOT_FOUND_HINT = (
    "Messages could not find this chat by either spelling of its id.\n"
    "  - Open Messages and click the group chat once so it is loaded, then try again.\n"
    "  - If it keeps failing, this version of macOS cannot script sends to this group "
    "(a known macOS 26/27 problem; see docs/MAC.md, 'Limits')."
)
MESSAGES_NOT_RUNNING_HINT = "Open the Messages app, make sure you are signed in to iMessage, and try again."
NOT_MACOS_HINT = "Sending needs macOS with the Messages app. Use --dry-run to see what would be sent."
ATTACHMENT_HINT = (
    "Messages could not read the image. It can only attach files from ~/Pictures, "
    "~/Downloads or ~/Documents; the helper stages cards in ~/Pictures/Threadback/."
)


@dataclass
class OsaResult:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    missing: bool = False  # no osascript on this machine (not macOS)


Runner = Callable[[str, Sequence[str], float], OsaResult]


def find_osascript() -> Optional[str]:
    if os.path.exists("/usr/bin/osascript"):
        return "/usr/bin/osascript"
    return shutil.which("osascript")


def run_osascript(script: str, args: Sequence[str], timeout: float) -> OsaResult:
    """Run an AppleScript with ARGV. The script source is a constant; every
    variable part travels as a separate argument."""
    exe = find_osascript()
    if not exe:
        return OsaResult(returncode=127, missing=True, stderr="osascript not found")
    cmd = [exe, "-e", script, *[str(a) for a in args]]
    try:
        proc = subprocess.run(  # noqa: S603 - fixed executable, no shell
            cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL
        )
    except subprocess.TimeoutExpired:
        return OsaResult(returncode=124, timed_out=True, stderr=f"timed out after {timeout:g} s")
    except OSError as exc:
        return OsaResult(returncode=126, missing=True, stderr=str(exc))
    return OsaResult(proc.returncode, proc.stdout or "", proc.stderr or "")


_ERRNUM = re.compile(r"\((-\d+)\)\s*$", re.MULTILINE)


def osa_error_number(stderr: str) -> Optional[int]:
    """The AppleScript error number at the end of an osascript error line."""
    found = _ERRNUM.findall(stderr or "")
    return int(found[-1]) if found else None


def swap_guid_form(guid: str) -> str:
    """``any;+;chat123`` <-> ``any;-;chat123``. Returns the input if it has neither."""
    if ";+;" in guid:
        return guid.replace(";+;", ";-;", 1)
    if ";-;" in guid:
        return guid.replace(";-;", ";+;", 1)
    return guid


def explain_osascript_error(result: OsaResult) -> "tuple[str, str]":
    """(reason, hint) for a failed osascript run, in plain language."""
    if result.missing:
        return "osascript is not available on this machine", NOT_MACOS_HINT
    if result.timed_out:
        return (
            f"Messages did not answer ({result.stderr.strip() or 'timed out'})",
            "Messages may be showing a dialog or still starting. Open it, dismiss anything "
            "on screen, and try again.",
        )
    err = result.stderr or ""
    low = err.lower()
    num = osa_error_number(err)
    if num == -1743 or "not authorized to send apple events" in low or "not authorised" in low:
        return "not allowed to control Messages (Automation permission is off)", AUTOMATION_HINT
    if num == -1728:
        return "Messages could not find this chat (AppleScript error -1728)", CHAT_NOT_FOUND_HINT
    if num in (-600, -609, -10810) or "application isn" in low and "running" in low:
        return f"Messages is not running or could not be reached (error {num})", MESSAGES_NOT_RUNNING_HINT
    if num == -1712:
        return "Messages took too long to answer (AppleEvent timed out, -1712)", MESSAGES_NOT_RUNNING_HINT
    if num in (-43, -1700, -10000, -10006) and ("file" in low or "alias" in low):
        return f"Messages could not use the attachment (error {num})", ATTACHMENT_HINT
    first = next((ln.strip() for ln in err.splitlines() if ln.strip()), "")
    if len(first) > 200:
        first = first[:199] + "…"
    return f"osascript failed (exit {result.returncode}): {first or 'no error text'}", ""


@dataclass
class SendResult:
    status: str
    reason: str = ""
    kind: str = "text"  # "text" or "file"
    guid: str = ""  # the GUID spelling used for the last attempt
    rowid: Optional[int] = None  # the outgoing message row, when verified
    swapped: bool = False  # the ;+;/;-; swap retry was used
    orphan: bool = False  # an outgoing row appeared that is attached to no chat
    hint: str = ""

    @property
    def sent_something(self) -> bool:
        return self.status in (DELIVERED, UNVERIFIED, DRY_RUN)

    def summary(self) -> str:
        return f"{self.status}" + (f" ({self.reason})" if self.reason else "")


def staging_dir() -> Path:
    """Where attachments are staged. Must be under ~/Pictures for Messages to read them."""
    return Path.home() / "Pictures" / PRODUCT_NAME


def stage_attachment(src: os.PathLike, directory: Optional[os.PathLike] = None, keep: int = 30) -> Path:
    """Copy ``src`` into the staging folder under a unique name and return the copy.

    Old staged cards (our own ``threadback-*`` files only) are pruned so the
    folder does not grow without bound.
    """
    src_path = Path(src)
    target_dir = Path(directory) if directory is not None else staging_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", src_path.stem).strip("-") or "card"
    if not stem.lower().startswith("threadback"):
        stem = "threadback-" + stem
    suffix = src_path.suffix or ".png"
    dest = target_dir / f"{stem}{suffix}"
    n = 1
    while dest.exists():
        n += 1
        dest = target_dir / f"{stem}-{n}{suffix}"
    shutil.copyfile(src_path, dest)
    _prune(target_dir, keep, protect=dest)
    return dest


def _prune(directory: Path, keep: int, protect: Path) -> None:
    try:
        ours = sorted(
            (p for p in directory.glob("threadback-*") if p.is_file() and p != protect),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for old in ours[max(0, keep - 1):]:
            old.unlink()
    except OSError:
        pass  # pruning is best-effort; never fail a send over it


class MessagesSender:
    """Sends through ``osascript`` and verifies each send in ``chat.db``."""

    def __init__(
        self,
        db_path: os.PathLike,
        *,
        runner: Optional[Runner] = None,
        decode: Optional[Callable[[Optional[str], Optional[bytes]], str]] = None,
        verify_timeout: float = 8.0,
        verify_interval: float = 0.4,
        osascript_timeout: float = 30.0,
        staging: Optional[os.PathLike] = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        connect: Callable[[os.PathLike], "chatdb.sqlite3.Connection"] = chatdb.open_ro,
    ) -> None:
        self.db_path = Path(db_path)
        self._runner_override = runner
        self._decode = decode
        self.verify_timeout = verify_timeout
        self.verify_interval = verify_interval
        self.osascript_timeout = osascript_timeout
        self._staging = Path(staging) if staging is not None else None
        self._sleep = sleep
        self._monotonic = monotonic
        self._connect = connect
        self._working_guid: Dict[str, str] = {}

    def _runner(self, script: str, args: Sequence[str], timeout: float) -> OsaResult:
        return (self._runner_override or run_osascript)(script, args, timeout)

    # -- public API ---------------------------------------------------------

    def send_text(self, chat: ChatRef, text: str) -> SendResult:
        if not text or not text.strip():
            return SendResult(FAILED, "nothing to send (empty text)", "text", chat.guid)
        return self._send(chat, text=text, file_path="", kind="text")

    def send_file(self, chat: ChatRef, path: os.PathLike) -> SendResult:
        src = Path(path)
        if not src.is_file():
            return SendResult(FAILED, f"attachment does not exist: {src}", "file", chat.guid)
        try:
            staged = stage_attachment(src, self._staging)
        except OSError as exc:
            return SendResult(
                FAILED, f"could not stage the attachment in ~/Pictures: {exc}", "file", chat.guid,
                hint=ATTACHMENT_HINT,
            )
        return self._send(chat, text="", file_path=str(staged), kind="file")

    # -- internals ----------------------------------------------------------

    def _send(self, chat: ChatRef, *, text: str, file_path: str, kind: str) -> SendResult:
        guid = self._working_guid.get(chat.key, chat.guid)
        if not guid or guid.startswith("-"):
            return SendResult(FAILED, "this chat has no usable id", kind, guid)

        # Never send what cannot be verified: take the "before" mark first.
        try:
            conn = self._connect(self.db_path)
            try:
                before = chatdb.max_message_rowid(conn)
            finally:
                conn.close()
        except chatdb.ChatDbError as exc:
            return SendResult(FAILED, f"cannot read chat.db, so nothing was sent: {exc}", kind, guid, hint=exc.hint)
        except chatdb.sqlite3.Error as exc:
            err = chatdb.explain_db_error(exc, self.db_path)
            return SendResult(FAILED, f"cannot read chat.db, so nothing was sent: {err}", kind, guid, hint=err.hint)

        swapped = False
        result = self._runner(SEND_SCRIPT, [guid, text, file_path], self.osascript_timeout)
        if (
            not result.timed_out
            and not result.missing
            and result.returncode != 0
            and osa_error_number(result.stderr) == -1728
        ):
            other = swap_guid_form(guid)
            if other != guid:
                # -1728 = Messages could not resolve the chat id, so nothing was
                # sent. One retry with the other spelling; never more.
                swapped = True
                guid = other
                result = self._runner(SEND_SCRIPT, [guid, text, file_path], self.osascript_timeout)

        if result.missing:
            reason, hint = explain_osascript_error(result)
            return SendResult(FAILED, reason, kind, guid, swapped=swapped, hint=hint)

        if result.returncode != 0 and not result.timed_out:
            reason, hint = explain_osascript_error(result)
            if swapped:
                reason += " (tried both the ;+; and ;-; forms of the chat id)"
            return SendResult(FAILED, reason, kind, guid, swapped=swapped, hint=hint)

        verdict = self._verify(chat, before, text=text, kind=kind)
        verdict.guid = guid
        verdict.swapped = swapped
        if result.timed_out:
            if verdict.status == DELIVERED:
                verdict.reason = "osascript timed out, but the message is in the chat"
            else:
                reason, hint = explain_osascript_error(result)
                verdict.status = FAILED
                verdict.reason = f"{reason}; no outgoing message appeared in this chat"
                verdict.hint = hint
        if verdict.status == DELIVERED:
            self._working_guid[chat.key] = guid
        return verdict

    def _verify(self, chat: ChatRef, before: int, *, text: str, kind: str) -> SendResult:
        """Poll chat.db for a new outgoing row joined to this chat."""
        deadline = self._monotonic() + self.verify_timeout
        orphan_seen = False
        last_error: Optional[chatdb.ChatDbError] = None
        while True:
            try:
                conn = self._connect(self.db_path)
                try:
                    chat_ids = chatdb.chat_rowids(
                        conn, [chat.guid, swap_guid_form(chat.guid)], chat.identifier
                    )
                    rows = chatdb.outgoing_rows_after(conn, before)
                finally:
                    conn.close()
                last_error = None
            except chatdb.ChatDbError as exc:
                rows, chat_ids, last_error = [], set(), exc
            except chatdb.sqlite3.Error as exc:
                rows, chat_ids, last_error = [], set(), chatdb.explain_db_error(exc, self.db_path)

            orphan_seen = False
            for row in rows:
                if not row.chat_ids:
                    orphan_seen = orphan_seen or self._looks_like_ours(row, text, kind, strict=False)
                    continue
                if not any(cid in chat_ids for cid in row.chat_ids):
                    continue
                if not self._looks_like_ours(row, text, kind, strict=True):
                    continue
                if row.error:
                    return SendResult(
                        FAILED,
                        f"Messages recorded the message with error code {row.error}; it was not delivered",
                        kind,
                        rowid=row.rowid,
                        hint=MESSAGES_NOT_RUNNING_HINT,
                    )
                return SendResult(DELIVERED, "", kind, rowid=row.rowid)

            if self._monotonic() >= deadline:
                break
            self._sleep(self.verify_interval)

        waited = f"{self.verify_timeout:g} s"
        if last_error is not None:
            return SendResult(
                UNVERIFIED,
                f"osascript reported success but chat.db could not be read to confirm: {last_error}",
                kind,
                hint=last_error.hint,
            )
        if orphan_seen:
            return SendResult(
                UNVERIFIED,
                "Messages accepted the send but the new outgoing row is attached to no chat "
                f"after {waited} (the known macOS 26 group-send problem); treat it as NOT delivered",
                kind,
                orphan=True,
                hint=CHAT_NOT_FOUND_HINT,
            )
        return SendResult(
            UNVERIFIED,
            f"osascript reported success but no outgoing message appeared in this chat within {waited}",
            kind,
            hint="Look at the chat on another device. If nothing arrived, see docs/MAC.md, 'Limits'.",
        )

    def _looks_like_ours(self, row: chatdb.OutgoingRow, text: str, kind: str, strict: bool) -> bool:
        """Tell our send apart from something the owner typed at the same moment."""
        decoded: Optional[str] = None
        if self._decode is not None:
            try:
                decoded = _squash(self._decode(row.text, row.attributed_body) or "")
            except Exception:  # a decoder problem must never turn a real send into a failure
                decoded = None
        if kind == "file":
            # an attachment row; or (schemas vary) a row with no typed text at all
            return row.has_attachment or not strict or decoded == ""
        if row.has_attachment:
            return False
        if decoded is None:
            return True
        return decoded == "" or decoded == _squash(text)


def _squash(text: str) -> str:
    """Whitespace-insensitive form for comparing what was sent with what was stored."""
    return " ".join(text.replace(chr(0xFFFC), " ").split())


@dataclass
class DryRunSender:
    """Records what would be sent. Never runs osascript, never touches Messages."""

    sent: List[dict] = field(default_factory=list)

    def send_text(self, chat: ChatRef, text: str) -> SendResult:
        self.sent.append({"kind": "text", "chat": chat.key, "chat_name": chat.name, "guid": chat.guid, "text": text})
        return SendResult(DRY_RUN, "", "text", chat.guid)

    def send_file(self, chat: ChatRef, path: os.PathLike) -> SendResult:
        self.sent.append(
            {"kind": "file", "chat": chat.key, "chat_name": chat.name, "guid": chat.guid, "path": str(path)}
        )
        return SendResult(DRY_RUN, "", "file", chat.guid)
