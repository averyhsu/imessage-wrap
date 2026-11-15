"""Decode the text of a Messages ``attributedBody`` blob.

``message.attributedBody`` holds an ``NSAttributedString`` (or
``NSMutableAttributedString``) serialised by ``NSArchiver`` in Apple's
"typedstream" format. Only the string is needed here, never the attributes.

Layout of the part that matters (little-endian "streamtyped" variant)::

    04 0B "streamtyped" 81 E8 03          version 4, signature, system 1000
    84 01 "@"                             type encoding of the root value
    84                                    new object ...
       84 84 12 "NSAttributedString" 00   ... of a new class (name, version)
       84 84 08 "NSObject" 00 85          ... whose superclass chain ends in nil
    92                                    type "@" again (shared-string reference)
    84 84 84 08 "NSString" 01 94          new object of class NSString : NSObject
    84 01 "+"                             type "+": raw bytes with a length
    <length> <UTF-8 bytes>                the text
    86 ...                                end of the string object, attribute runs

Integers (and therefore lengths) are one byte for 0..127, ``0x81`` plus a
16-bit value, ``0x82`` plus a 32-bit value. Lengths count UTF-8 bytes.

Three strategies run in order and must agree on well-formed input:

1. ``fast``: the blob starts with one of the two byte prefixes Messages
   actually writes, so the length sits at a known offset;
2. ``structural``: a real walk of the typedstream grammar down to the first
   ``+`` value (handles any class chain, version or reference numbering);
3. ``scan``: look for ``NSString`` and the following ``01 2B`` type marker, the
   heuristic most third-party readers use, for blobs the walk cannot follow.

Written from the format description in docs/research/03 and the public
reverse-engineering notes; no third-party code is used.
"""

from __future__ import annotations

from typing import Optional, Tuple

__all__ = ["decode_attributed_body", "decode_with_strategy", "TypedStreamError"]

_TAG_INT16 = 0x81
_TAG_INT32 = 0x82
_TAG_INT64 = 0x87
_TAG_NEW = 0x84
_TAG_NIL = 0x85
_TAG_END = 0x86
_FIRST_REF = 0x92

_HEADER_LE = b"\x04\x0bstreamtyped"
_HEADER_BE = b"\x04\x0btypedstream"

# The two prefixes NSArchiver produces for the classes Messages uses, up to and
# including the "+" type marker. The length of the text follows immediately.
_FAST_PREFIXES = (
    b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00"
    b"\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+",
    b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x19NSMutableAttributedString\x00"
    b"\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84"
    b"\x0fNSMutableString\x01\x84\x84\x08NSString\x01\x95\x84\x01+",
)
_FAST = tuple((p, len(p)) for p in _FAST_PREFIXES)


class TypedStreamError(ValueError):
    """The blob is not a typedstream this decoder can follow."""


def _read_int(data, pos: int, little: bool) -> Tuple[int, int]:
    """Read one unsigned integer. Returns (value, next position)."""
    tag = data[pos]
    if tag < 0x80:
        return tag, pos + 1
    order = "little" if little else "big"
    if tag == _TAG_INT16:
        if pos + 3 > len(data):
            raise TypedStreamError("truncated 16-bit integer")
        return int.from_bytes(data[pos + 1:pos + 3], order), pos + 3
    if tag == _TAG_INT32:
        if pos + 5 > len(data):
            raise TypedStreamError("truncated 32-bit integer")
        return int.from_bytes(data[pos + 1:pos + 5], order), pos + 5
    if tag == _TAG_INT64:
        if pos + 9 > len(data):
            raise TypedStreamError("truncated 64-bit integer")
        return int.from_bytes(data[pos + 1:pos + 9], order), pos + 9
    raise TypedStreamError("expected an integer, found tag 0x%02x" % tag)


def _take_text(data, pos: int, little: bool) -> str:
    length, pos = _read_int(data, pos, little)
    end = pos + length
    if end > len(data):
        raise TypedStreamError("string runs past the end of the blob")
    return bytes(data[pos:end]).decode("utf-8", "replace")


def _fast(data) -> Optional[str]:
    for prefix, size in _FAST:
        if data.startswith(prefix):
            return _take_text(data, size, True)
    return None


class _Walker:
    """Follows the typedstream grammar just far enough to reach the first
    ``+`` (or ``*``) value, which is the backing string of the root object."""

    def __init__(self, data):
        self.data = data
        self.pos = 0
        self.little = True
        self.strings = []       # shared strings, in order of first appearance

    def byte(self) -> int:
        if self.pos >= len(self.data):
            raise TypedStreamError("unexpected end of data")
        value = self.data[self.pos]
        self.pos += 1
        return value

    def integer(self) -> int:
        if self.pos >= len(self.data):
            raise TypedStreamError("unexpected end of data")
        value, self.pos = _read_int(self.data, self.pos, self.little)
        return value

    def header(self) -> None:
        data = self.data
        if data.startswith(_HEADER_LE):
            self.little = True
        elif data.startswith(_HEADER_BE):
            self.little = False
        else:
            raise TypedStreamError("not a typedstream")
        self.pos = len(_HEADER_LE)
        self.integer()          # system version, 1000 in practice

    def shared_string(self) -> bytes:
        """A type encoding or class name: new (0x84 + bytes) or a reference."""
        tag = self.byte()
        if tag == _TAG_NEW:
            length = self.integer()
            end = self.pos + length
            if end > len(self.data):
                raise TypedStreamError("shared string runs past the end")
            raw = bytes(self.data[self.pos:end])
            self.pos = end
            self.strings.append(raw)
            return raw
        if tag >= _FIRST_REF:
            index = tag - _FIRST_REF
            if index >= len(self.strings):
                raise TypedStreamError("dangling shared-string reference")
            return self.strings[index]
        raise TypedStreamError("expected a shared string, found tag 0x%02x" % tag)

    def class_chain(self) -> None:
        """New classes (name + version) until nil or a reference to a known one."""
        for _ in range(64):
            tag = self.byte()
            if tag == _TAG_NEW:
                self.shared_string()
                self.integer()
            elif tag == _TAG_NIL or tag >= _FIRST_REF:
                return
            else:
                raise TypedStreamError("malformed class chain")
        raise TypedStreamError("class chain too deep")

    def first_string(self) -> str:
        self.header()
        for _ in range(8):      # root object, then its backing string object
            encoding = self.shared_string()
            kind = encoding[:1]
            if kind == b"+":
                return _take_text(self.data, self.pos, self.little)
            if kind == b"*":
                tag = self.byte()
                if tag != _TAG_NEW:
                    raise TypedStreamError("C string is nil or a reference")
                return self.shared_string().decode("utf-8", "replace")
            if kind != b"@":
                raise TypedStreamError("unexpected type %r before the string" % encoding)
            tag = self.byte()
            if tag != _TAG_NEW:
                raise TypedStreamError("root object is nil or a reference")
            self.class_chain()
        raise TypedStreamError("no string found")


def _structural(data) -> str:
    return _Walker(data).first_string()


def _scan(data) -> Optional[str]:
    """Heuristic: the first "+"-typed value after an NSString class name."""
    little = not data.startswith(_HEADER_BE)
    start = data.find(b"NSString")
    while start != -1:
        marker = data.find(b"\x01+", start + 8, start + 8 + 16)
        if marker != -1:
            try:
                return _take_text(data, marker + 2, little)
            except (TypedStreamError, IndexError):
                pass
        start = data.find(b"NSString", start + 8)
    return None


def decode_with_strategy(blob) -> Tuple[Optional[str], str]:
    """Decode ``blob`` and say how: ``(text, "fast" | "structural" | "scan" | "none")``.

    Mainly for tests and diagnostics; use :func:`decode_attributed_body`.
    """
    if blob is None:
        return None, "none"
    if isinstance(blob, (bytes, bytearray)):
        data = blob
    else:
        try:
            data = bytes(memoryview(blob))
        except TypeError:           # not bytes-like at all (a str, a number ...)
            return None, "none"
    if not data:
        return None, "none"
    try:
        text = _fast(data)
        if text is not None:
            return text, "fast"
    except (TypedStreamError, IndexError):
        pass
    try:
        return _structural(data), "structural"
    except (TypedStreamError, IndexError):
        pass
    try:
        text = _scan(data)
        if text is not None:
            return text, "scan"
    except IndexError:
        pass
    return None, "none"


def decode_attributed_body(blob) -> Optional[str]:
    """Return the plain text inside a ``message.attributedBody`` blob.

    ``blob`` is ``bytes`` (or anything ``bytes()`` accepts, or ``None``).
    Returns ``None`` when the blob is empty or not a decodable typedstream;
    never raises. Invalid UTF-8 is replaced with U+FFFD, and attachments show
    up as U+FFFC exactly as Messages stores them.
    """
    return decode_with_strategy(blob)[0]
