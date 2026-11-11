"""Share-link payload (docs/SCHEMA.md section 5).

    https://averyhsu.github.io/imessage-wrap/#w1=<payload>
    payload = base64url( raw-DEFLATE( UTF-8( JSON(stats) ) ) )      no padding

The stats ride in the URL *fragment*, which browsers never send to a server.

The whole URL may be at most :data:`MAX_URL_LENGTH` characters. When it would
be longer, :func:`fit_link` re-encodes a trimmed copy of the stats, applying
the six steps of the contract in order and stopping as soon as the link fits.
``web/make/engine.js`` implements the same ladder.
"""

from __future__ import annotations

import base64
import binascii
import copy
import json
import re
import zlib
from typing import Any, Dict, Optional

__all__ = [
    "BASE_URL", "MAX_URL_LENGTH", "TRIM_STEPS", "LinkTooLongError", "canonical_json",
    "encode_payload", "decode_payload", "payload_from_url", "stats_from_url",
    "apply_trim_step", "strip_quotes", "fit_link", "build_link",
]

#: The one place the public address of the story is written down.
BASE_URL = "https://averyhsu.github.io/imessage-wrap/"
#: Longest URL a link builder may produce (MSMessage.url rejects > 5,000).
MAX_URL_LENGTH = 4800
#: Number of trimming steps in the ladder.
TRIM_STEPS = 6
SHORT_QUOTE = 60
_MAX_DECODED_BYTES = 8 * 1024 * 1024


class LinkTooLongError(ValueError):
    """Even the most trimmed stats do not fit in a link."""


_SURROGATE = re.compile("[" + chr(0xD800) + "-" + chr(0xDFFF) + "]")


def _js_number(value: float) -> str:
    """Format a float the way JavaScript's Number::toString does."""
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("NaN and Infinity cannot be put in JSON")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    mantissa, _, exponent = repr(abs(value)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = (whole + fraction).lstrip("0")
    # value = 0.<digits> * 10 ** point
    point = len(whole.lstrip("0")) if whole.strip("0") else -(len(fraction) - len(fraction.lstrip("0")))
    point += int(exponent or 0)
    digits = digits.rstrip("0")
    k = len(digits)
    if k <= point <= 21:
        return sign + digits + "0" * (point - k)
    if 0 < point <= 21:
        return sign + digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return sign + "0." + "0" * (-point) + digits
    e = point - 1
    head = digits[0] + ("." + digits[1:] if k > 1 else "")
    return "%s%se%s%d" % (sign, head, "+" if e >= 0 else "-", abs(e))


def _js_string(text: str) -> str:
    out = json.dumps(text, ensure_ascii=False)
    if _SURROGATE.search(out):          # JSON.stringify escapes lone surrogates
        out = _SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group()), out)
    return out


def _is_index(key: str) -> bool:
    """True for keys JavaScript treats as array indices (they sort first)."""
    return key.isdigit() and key.isascii() and (key == "0" or key[0] != "0") \
        and int(key) < 4294967295


def _write(value: Any, out: list) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, str):
        out.append(_js_string(value))
    elif isinstance(value, int):
        out.append(str(value))
    elif isinstance(value, float):
        out.append(_js_number(value))
    elif isinstance(value, dict):
        keys = [k if isinstance(k, str) else json.dumps(k) for k in value]
        pairs = list(zip(keys, value.values()))
        indices = sorted((p for p in pairs if _is_index(p[0])), key=lambda p: int(p[0]))
        pairs = indices + [p for p in pairs if not _is_index(p[0])]
        out.append("{")
        for n, (key, item) in enumerate(pairs):
            if n:
                out.append(",")
            out.append(_js_string(key))
            out.append(":")
            _write(item, out)
        out.append("}")
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for n, item in enumerate(value):
            if n:
                out.append(",")
            _write(item, out)
        out.append("]")
    else:
        raise TypeError("%s cannot be put in JSON" % type(value).__name__)


def canonical_json(stats: Any) -> str:
    """Compact JSON, character for character what ``JSON.stringify`` prints in
    JavaScript: no spaces, non-ASCII kept as is, ``1.0`` written ``1``,
    JavaScript's exponent rules for very small or large numbers, and integer-like
    keys first (the order a JavaScript object enumerates them in)."""
    out: list = []
    _write(stats, out)
    return "".join(out)


def encode_payload(stats: Any) -> str:
    """Stats object -> base64url(raw DEFLATE(UTF-8 JSON)) without padding."""
    raw = canonical_json(stats).encode("utf-8")
    deflater = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = deflater.compress(raw) + deflater.flush()
    return base64.urlsafe_b64encode(packed).rstrip(b"=").decode("ascii")


def decode_payload(payload: str) -> Any:
    """Inverse of :func:`encode_payload`. Raises ``ValueError`` on bad input."""
    if not isinstance(payload, str) or not payload:
        raise ValueError("empty payload")
    text = payload.strip().replace("+", "-").replace("/", "_").rstrip("=")
    try:
        packed = base64.b64decode(text + "=" * (-len(text) % 4), altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("payload is not base64url: %s" % exc)
    try:
        inflater = zlib.decompressobj(-15)
        raw = inflater.decompress(packed, _MAX_DECODED_BYTES)
        if inflater.unconsumed_tail:
            raise ValueError("payload expands to more than %d bytes" % _MAX_DECODED_BYTES)
    except zlib.error as exc:
        raise ValueError("payload is not raw DEFLATE data: %s" % exc)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError("payload does not contain JSON: %s" % exc)


def payload_from_url(url: str) -> Optional[str]:
    """Pull the ``w1`` payload out of a share URL (``#w1=`` or ``?w1=``)."""
    if not isinstance(url, str):
        return None
    for part in (url.partition("#")[2], url.partition("#")[0].partition("?")[2]):
        for piece in part.split("&"):
            if piece.startswith("w1="):
                return piece[3:]
    return None


def stats_from_url(url: str) -> Any:
    """Decode the stats carried by a share URL."""
    payload = payload_from_url(url)
    if payload is None:
        raise ValueError("no w1= payload in this URL")
    return decode_payload(payload)


def strip_quotes(stats: Dict[str, Any]) -> Dict[str, Any]:
    """"No quotes" mode: blank every ``most_reacted[].text`` (in place)."""
    for entry in stats.get("most_reacted") or []:
        if isinstance(entry, dict):
            entry["text"] = ""
    return stats


def apply_trim_step(stats: Dict[str, Any], step: int) -> Dict[str, Any]:
    """Apply ladder step ``step`` (1..6) to ``stats`` in place and return it.

    1. delete ``awards[].detail``
    2. truncate every ``most_reacted[].text`` to 60 characters plus an ellipsis
    3. keep only the first 8 ``senders``
    4. keep only the first ``most_reacted`` entry
    5. delete ``awards``
    6. keep only the first 5 ``senders``
    """
    if step == 1:
        for award in stats.get("awards") or []:
            if isinstance(award, dict):
                award.pop("detail", None)
    elif step == 2:
        for entry in stats.get("most_reacted") or []:
            text = entry.get("text") if isinstance(entry, dict) else None
            if isinstance(text, str) and len(text) > SHORT_QUOTE:
                entry["text"] = text[:SHORT_QUOTE] + "\u2026"
    elif step == 3:
        if isinstance(stats.get("senders"), list):
            stats["senders"] = stats["senders"][:8]
    elif step == 4:
        if isinstance(stats.get("most_reacted"), list):
            stats["most_reacted"] = stats["most_reacted"][:1]
    elif step == 5:
        stats.pop("awards", None)
    elif step == 6:
        if isinstance(stats.get("senders"), list):
            stats["senders"] = stats["senders"][:5]
    else:
        raise ValueError("there is no trim step %r" % (step,))
    return stats


def fit_link(stats: Dict[str, Any], quotes: bool = True, base_url: str = BASE_URL,
             max_length: int = MAX_URL_LENGTH) -> Dict[str, Any]:
    """Build the share link, trimming the stats only as far as needed.

    Returns ``{"url", "length", "steps", "stats"}`` where ``steps`` is how many
    ladder steps were applied (0 = nothing trimmed) and ``stats`` is the copy
    that was actually encoded. The input is never modified. Raises
    :class:`LinkTooLongError` when even step 6 is not enough.
    """
    trimmed = copy.deepcopy(stats)
    if not quotes:
        strip_quotes(trimmed)
    step = 0
    while True:
        url = base_url + "#w1=" + encode_payload(trimmed)
        if len(url) <= max_length:
            return {"url": url, "length": len(url), "steps": step, "stats": trimmed}
        if step == TRIM_STEPS:
            raise LinkTooLongError(
                "This recap does not fit in a link: %d characters after every trimming step, "
                "and the limit is %d. Try a shorter chat name or the no-quotes option."
                % (len(url), max_length))
        step += 1
        apply_trim_step(trimmed, step)


def build_link(stats: Dict[str, Any], quotes: bool = True, base_url: str = BASE_URL,
               max_length: int = MAX_URL_LENGTH) -> str:
    """The share URL for ``stats`` (see :func:`fit_link` for the details).

    ``quotes=False`` blanks the text of the most-reacted messages first, for
    people who do not want message text inside the link.
    """
    return fit_link(stats, quotes=quotes, base_url=base_url, max_length=max_length)["url"]
