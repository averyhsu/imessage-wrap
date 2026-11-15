"""The plain-text recap that goes into the thread next to the card.

Five to eight short, emoji-led lines built only from aggregate stats and first
names. The link is *not* part of this text: it is sent as its own message so
Messages can turn it into a preview card.

Safety property (tested): no line of anything built here equals or starts with
a trigger command, so the helper can never answer itself.
"""

from __future__ import annotations

from typing import List

from . import PRODUCT_NAME
from .fmt import clean, display_names, first_name, fmt_int, fmt_pct, hour12, peak_hour, safe_chat_name, short_date
from .triggers import starts_with_trigger

PERSONALITY_EMOJI = {
    "quiet_ones": "🤫",
    "night_owls": "🦉",
    "weekend_warriors": "🎉",
    "always_on": "🔋",
    "early_birds": "🐦",
    "morning_meeting": "☕",
    "lunch_break": "🥪",
    "afternoon_slackers": "😎",
    "dinner_table": "🍽️",
    "after_hours": "🌙",
}
MEDALS = ("🥇", "🥈", "🥉")


def _plural(n: int, one: str, many: str) -> str:
    return f"{fmt_int(n)} {one if n == 1 else many}"


def recap_lines(stats: dict, with_link: bool = True) -> List[str]:
    """The recap as a list of lines (5..8 with the pointer to the link)."""
    chat = stats.get("chat") or {}
    period = stats.get("period") or {}
    totals = stats.get("totals") or {}
    senders = [s for s in (stats.get("senders") or []) if isinstance(s, dict)]
    names = display_names(s.get("name") for s in senders)

    chat_name = clean(safe_chat_name(chat.get("name")), 60) or "This chat"
    label = clean(period.get("label"), 24)
    lines: List[str] = []

    lines.append(f"🧵 {chat_name} — {label} in review" if label else f"🧵 {chat_name} in review")

    messages = int(totals.get("messages") or 0)
    parts = [_plural(messages, "message", "messages")]
    days = int(totals.get("days_active") or 0)
    if days:
        parts.append(_plural(days, "active day", "active days"))
    streak = int(totals.get("longest_streak") or 0)
    if streak >= 3:
        parts.append(f"{fmt_int(streak)}-day streak")
    lines.append("💬 " + " · ".join(parts))

    personality = stats.get("personality") or {}
    title = clean(personality.get("title"), 40)
    peak = peak_hour(stats)
    if title:
        emoji = PERSONALITY_EMOJI.get(str(personality.get("id")), "✨")
        tail = f" — peak hour {hour12(peak)}" if peak is not None else ""
        lines.append(f"{emoji} You are {title}{tail}")
    elif peak is not None:
        lines.append(f"⏰ Peak hour: {hour12(peak)}")

    podium = []
    for medal, s in zip(MEDALS, senders[:3]):
        shown = names.get(clean(s.get("name")), "Someone")
        podium.append(f"{medal} {shown} {fmt_pct(s.get('share'))}")
    if podium:
        lines.append(" · ".join(podium))

    awards = []
    for a in (stats.get("awards") or [])[:3]:
        if not isinstance(a, dict):
            continue
        a_title = clean(a.get("title"), 28)
        winner = clean(a.get("winner"))
        if not a_title or not winner:
            continue
        if a_title.lower().startswith("the "):
            a_title = a_title[4:]
        awards.append(f"{a_title}: {names.get(winner) or first_name(winner)}")
    if awards:
        lines.append("🏆 " + " · ".join(awards))

    reactions = int(totals.get("reactions") or 0)
    if reactions > 0:
        line = f"❤️ {_plural(reactions, 'tapback', 'tapbacks')}"
        giver = ((stats.get("reactions") or {}).get("top_giver") or {}).get("name")
        if giver:
            g = clean(giver)
            line += f" · most generous: {names.get(g) or first_name(g)}"
        lines.append(line)

    busiest = stats.get("busiest_day") or {}
    day = short_date(busiest.get("date"))
    if day and int(busiest.get("messages") or 0) > 0 and len(lines) < 7:
        lines.append(f"📅 Busiest day: {day} ({_plural(int(busiest['messages']), 'message', 'messages')})")

    lines = lines[:7]
    if with_link:
        lines.append(f"👇 The full story is in the link below ({PRODUCT_NAME})")
    return [_safe(line) for line in lines]


def recap_text(stats: dict, with_link: bool = True) -> str:
    """The recap as one message body."""
    return "\n".join(recap_lines(stats, with_link=with_link))


def empty_text(stats: dict) -> str:
    """One line for a period with nothing in it (no card, no link)."""
    label = clean((stats.get("period") or {}).get("label"), 24)
    where = f" in {label}" if label else ""
    return _safe(f"🧵 Nothing to recap{where}: no messages in this chat for that period.")


def _safe(line: str) -> str:
    """Guarantee a line can never be read back as a command."""
    line = clean(line)
    while starts_with_trigger(line):
        line = "· " + line
    return line


def assert_safe(message: str) -> None:
    """Raise if any line of an outgoing message equals or starts with a command."""
    for line in str(message).splitlines() or [""]:
        if starts_with_trigger(line):
            raise ValueError("refusing to send a line that looks like a command")
