"""The helper's small persistent state: ``~/.threadback/state.json``.

It holds the message cursor (so old commands are never replayed), per-chat
cooldown timestamps, the row ids of the helper's own replies (so it can never
answer itself) and what the owner has consented to. It never holds message
text, names or numbers.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

MAX_OWN_ROWIDS = 400


def home_dir() -> Path:
    """``~/.threadback`` (override with THREADBACK_HOME, used by tests and CI)."""
    override = os.environ.get("THREADBACK_HOME")
    return Path(override).expanduser() if override else Path.home() / ".threadback"


def private_dir(path: os.PathLike) -> Path:
    """Create the helper's folder for the owner only (0700). A folder that already
    exists is left exactly as it is."""
    p = Path(path)
    if not p.exists():
        p.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass
    return p


def append_private(path: os.PathLike, text: str) -> None:
    """Append to a file that only the owner can read (created 0600; an older,
    more open file is tightened)."""
    p = Path(path)
    private_dir(p.parent)
    fd = os.open(str(p), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        if os.fstat(fd).st_mode & 0o077:
            os.fchmod(fd, 0o600)
        os.write(fd, text.encode("utf-8", "replace"))
    finally:
        os.close(fd)


def default_state_path() -> Path:
    return home_dir() / "state.json"


@dataclass
class State:
    path: Optional[Path] = None
    cursor: Optional[int] = None  # last message.ROWID that has been looked at
    cooldowns: Dict[str, float] = field(default_factory=dict)  # chat key -> unix time of last reply
    own_rowids: List[int] = field(default_factory=list)  # message rows the helper sent
    consent: Dict[str, object] = field(default_factory=dict)  # {"send": scope, "ai": scope}
    _saved: Optional[str] = field(default=None, repr=False, compare=False)  # what is on disk

    @classmethod
    def load(cls, path: os.PathLike) -> "State":
        p = Path(path)
        state = cls(path=p)
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return state  # missing or corrupt: start fresh (cursor is re-initialised to "now")
        if not isinstance(data, dict):
            return state
        cursor = data.get("cursor")
        if isinstance(cursor, int) and cursor >= 0:
            state.cursor = cursor
        cooldowns = data.get("cooldowns")
        if isinstance(cooldowns, dict):
            state.cooldowns = {
                str(k): float(v) for k, v in cooldowns.items() if isinstance(v, (int, float))
            }
        own = data.get("own_rowids")
        if isinstance(own, list):
            state.own_rowids = [int(x) for x in own if isinstance(x, int)][-MAX_OWN_ROWIDS:]
        consent = data.get("consent")
        if isinstance(consent, dict):
            state.consent = dict(consent)
        return state

    def _payload(self) -> str:
        return json.dumps(
            {
                "v": 1,
                "cursor": self.cursor,
                "cooldowns": self.cooldowns,
                "own_rowids": self.own_rowids[-MAX_OWN_ROWIDS:],
                "consent": self.consent,
            },
            indent=1,
            sort_keys=True,
        )

    def save(self) -> None:
        """Atomic write (temp file + rename), private to the user. Does nothing when
        the file already holds exactly this state (the loop calls it every pass)."""
        if self.path is None:
            return
        text = self._payload()
        if text == self._saved and self.path.exists():
            return
        private_dir(self.path.parent)
        fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".json", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text + "\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self._saved = text

    def remember_own(self, rowid: Optional[int]) -> None:
        if rowid is None:
            return
        if rowid not in self.own_rowids:
            self.own_rowids.append(int(rowid))
            del self.own_rowids[:-MAX_OWN_ROWIDS]

    def prune_cooldowns(self, now: float, horizon: float = 86400.0) -> None:
        self.cooldowns = {k: t for k, t in self.cooldowns.items() if now - t < horizon}
