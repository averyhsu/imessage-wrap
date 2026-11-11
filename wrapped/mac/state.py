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


def default_state_path() -> Path:
    return home_dir() / "state.json"


@dataclass
class State:
    path: Optional[Path] = None
    cursor: Optional[int] = None  # last message.ROWID that has been looked at
    cooldowns: Dict[str, float] = field(default_factory=dict)  # chat key -> unix time of last reply
    own_rowids: List[int] = field(default_factory=list)  # message rows the helper sent
    consent: Dict[str, object] = field(default_factory=dict)  # {"send": scope, "ai": scope}

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

    def save(self) -> None:
        """Atomic write (temp file + rename), private to the user."""
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "v": 1,
            "cursor": self.cursor,
            "cooldowns": self.cooldowns,
            "own_rowids": self.own_rowids[-MAX_OWN_ROWIDS:],
            "consent": self.consent,
        }
        fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".json", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=1, sort_keys=True)
                fh.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def remember_own(self, rowid: Optional[int]) -> None:
        if rowid is None:
            return
        if rowid not in self.own_rowids:
            self.own_rowids.append(int(rowid))
            del self.own_rowids[:-MAX_OWN_ROWIDS]

    def prune_cooldowns(self, now: float, horizon: float = 86400.0) -> None:
        self.cooldowns = {k: t for k, t in self.cooldowns.items() if now - t < horizon}
