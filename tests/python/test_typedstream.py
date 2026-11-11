"""attributedBody (typedstream) decoder: every length encoding and fallback."""

import json
import os
import struct
import unittest

import support
from support import build_fixture

from wrapped import typedstream
from wrapped.typedstream import decode_attributed_body, decode_with_strategy

IMMUTABLE_PREFIX = typedstream._FAST_PREFIXES[0]
MUTABLE_PREFIX = typedstream._FAST_PREFIXES[1]
TAIL = b"\x86\x84\x02iI\x01\x05\x92\x84\x84\x84\x0cNSDictionary\x00\x94\x84\x01i\x00\x86\x86"


def blob(length_bytes, payload, prefix=IMMUTABLE_PREFIX):
    return prefix + length_bytes + payload + TAIL


class LengthEncodings(unittest.TestCase):
    def check(self, length_bytes, n):
        payload = (b"abcdefghij" * (n // 10 + 1))[:n]
        for prefix in (IMMUTABLE_PREFIX, MUTABLE_PREFIX):
            data = blob(length_bytes, payload, prefix)
            self.assertEqual(decode_attributed_body(data), payload.decode())
            # the three strategies must agree
            self.assertEqual(typedstream._fast(data), payload.decode())
            self.assertEqual(typedstream._structural(data), payload.decode())
            self.assertEqual(typedstream._scan(data), payload.decode())

    def test_single_byte_lengths(self):
        for n in (0, 1, 2, 126, 127):
            self.check(bytes([n]), n)

    def test_16_bit_lengths(self):
        for n in (128, 129, 255, 256, 300, 2359, 32767):
            self.check(b"\x81" + struct.pack("<H", n), n)

    def test_16_bit_length_is_unsigned(self):
        for n in (32768, 40000, 65535):
            self.check(b"\x81" + struct.pack("<H", n), n)

    def test_32_bit_lengths(self):
        for n in (5, 200, 32768, 65536, 70000):
            self.check(b"\x82" + struct.pack("<I", n), n)

    def test_64_bit_length(self):
        self.check(b"\x87" + struct.pack("<Q", 300), 300)

    def test_length_counts_utf8_bytes_not_characters(self):
        text = "\U0001F602" * 40          # 40 characters, 160 bytes, 80 UTF-16 units
        raw = text.encode("utf-8")
        self.assertEqual(len(raw), 160)
        self.assertEqual(decode_attributed_body(blob(b"\x81" + struct.pack("<H", 160), raw)), text)


class FixtureSamples(unittest.TestCase):
    def test_samples_decode_exactly_and_take_the_fast_path(self):
        _folder, info = support.fixture()
        samples = info["typedstream_samples"]
        self.assertGreaterEqual(len(samples), 30)
        for sample in samples:
            data = bytes.fromhex(sample["hex"])
            text, how = decode_with_strategy(data)
            self.assertEqual(text, sample["text"], sample["name"])
            self.assertEqual(how, "fast", sample["name"])
            self.assertEqual(typedstream._structural(data), sample["text"], sample["name"])
            self.assertEqual(typedstream._scan(data), sample["text"], sample["name"])

    def test_writer_length_encodings(self):
        short = build_fixture.archive_attributed_string("a" * 127)
        self.assertIn(b"\x84\x01+\x7f" + b"a" * 127, short)
        medium = build_fixture.archive_attributed_string("b" * 128)
        self.assertIn(b"\x84\x01+\x81\x80\x00" + b"b" * 128, medium)
        large = build_fixture.archive_attributed_string("c" * 256)
        self.assertIn(b"\x84\x01+\x81\x00\x01" + b"c" * 256, large)

    def test_accepts_bytearray_and_memoryview(self):
        data = build_fixture.archive_attributed_string("café \U0001F389")
        self.assertEqual(decode_attributed_body(bytearray(data)), "café \U0001F389")
        self.assertEqual(decode_attributed_body(memoryview(data)), "café \U0001F389")


class Fallbacks(unittest.TestCase):
    def test_unknown_class_chain_is_walked_structurally(self):
        # a subclass and class versions the fast path has never seen
        data = (b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x1aNSConcreteAttributedString"
                b"\x05\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84"
                b"\x12NSBigMutableString\x02\x84\x84\x0fNSMutableString\x01\x84\x84\x08NSString\x01"
                b"\x95\x84\x01+\x0bhello world\x86")
        self.assertEqual(decode_with_strategy(data), ("hello world", "structural"))

    def test_big_endian_stream(self):
        data = (b"\x04\x0btypedstream\x81\x03\xe8\x84\x01@\x84\x84\x84\x12NSAttributedString\x00"
                b"\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+"
                b"\x81\x01\x2c" + b"z" * 300 + b"\x86")
        self.assertEqual(decode_with_strategy(data), ("z" * 300, "structural"))

    def test_c_string_typed_value(self):
        data = (b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x08NSString\x00\x84\x84"
                b"\x08NSObject\x00\x85\x84\x01*\x84\x84\x05plain\x86")
        self.assertEqual(decode_with_strategy(data), ("plain", "structural"))

    def test_scan_when_the_structure_is_broken(self):
        data = b"\x04\x0bstreamtyped\x81\xe8\x03\x00\x00junk" + b"NSString\x01\x94\x84\x01+\x05hello\x86"
        self.assertEqual(decode_with_strategy(data), ("hello", "scan"))

    def test_scan_skips_a_class_name_without_a_string(self):
        data = b"xxNSStringxxxxxxxxxxxxxxxxxxxxxxxxNSString\x01\x95\x84\x01+\x02ok\x86"
        self.assertEqual(decode_attributed_body(data), "ok")

    def test_invalid_utf8_is_replaced(self):
        self.assertEqual(decode_attributed_body(blob(b"\x04", b"a\xff\xfeb")), "a��b")

    def test_not_a_typedstream(self):
        for junk in (None, b"", b"\x00", b"bplist00\xd4\x01\x02", b"streamtyped", "text".encode()):
            self.assertEqual(decode_with_strategy(junk), (None, "none"))

    def test_truncated_blobs_never_raise(self):
        for text in ("see you at 7", "x" * 300):
            for mutable in (False, True):
                data = build_fixture.archive_attributed_string(text, mutable=mutable)
                marker = data.index(b"\x84\x01+") + 3
                for cut in range(len(data)):
                    got = decode_attributed_body(data[:cut])
                    if cut < marker + (1 if len(text) < 128 else 3) + len(text):
                        self.assertIsNone(got, cut)     # the string is not all there yet
                    else:
                        self.assertEqual(got, text, cut)


@unittest.skipUnless(os.environ.get("WRAPPED_REAL_TYPEDSTREAM"),
                     "needs NSArchiver output (WRAPPED_REAL_TYPEDSTREAM, macOS CI job)")
class RealNSArchiver(unittest.TestCase):
    """Blobs produced by the real NSArchiver on macOS
    (tests/conformance/real_typedstream.swift)."""

    @classmethod
    def setUpClass(cls):
        with open(os.environ["WRAPPED_REAL_TYPEDSTREAM"], encoding="utf-8") as handle:
            cls.samples = json.load(handle)

    def test_every_real_blob_decodes_exactly(self):
        self.assertGreaterEqual(len(self.samples), 20)
        for sample in self.samples:
            data = bytes.fromhex(sample["hex"])
            text, how = decode_with_strategy(data)
            self.assertEqual(text, sample["string"], sample["name"])
            self.assertEqual(typedstream._structural(data), sample["string"], sample["name"])
            self.assertEqual(typedstream._scan(data), sample["string"], sample["name"])
            self.assertEqual(how, "fast", sample["name"])

    def test_fixture_writer_is_byte_identical_to_nsarchiver(self):
        checked = 0
        for sample in self.samples:
            if not sample.get("messages_layout"):
                continue
            ours = build_fixture.archive_attributed_string(
                sample["string"], mutable=sample["mutable"])
            self.assertEqual(ours.hex(), sample["hex"], sample["name"])
            checked += 1
        self.assertGreaterEqual(checked, 8)


if __name__ == "__main__":
    unittest.main()
