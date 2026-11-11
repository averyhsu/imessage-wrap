"""Housekeeping checks on the engine's own source files."""

import glob
import os
import re
import subprocess
import unittest

import support

ROOT = support.ROOT


def tracked(pattern):
    return sorted(glob.glob(os.path.join(ROOT, *pattern.split("/")), recursive=True))


class Sources(unittest.TestCase):
    def test_engine_sources_are_plain_ascii(self):
        """Invisible characters (U+FEFF, U+2028, U+00A0 ...) matter to the
        counting rules, so they are always written as escapes: an editor or
        formatter must not be able to change them unnoticed."""
        files = (tracked("wrapped/*.py") + tracked("web/make/*.js") + tracked("tests/python/*.py")
                 + tracked("tests/conformance/*.py") + tracked("tests/conformance/*.js")
                 + tracked("tests/conformance/*.swift") + tracked("tests/engine-js/*.js")
                 + tracked("tests/engine-js/*.py") + tracked("tests/fixtures/*.py"))
        self.assertGreater(len(files), 25)
        for path in files:
            with open(path, "rb") as handle:
                data = handle.read()
            bad = [i for i, byte in enumerate(data) if byte > 0x7E or (byte < 0x20 and byte not in (9, 10))]
            self.assertEqual(bad[:5], [], "%s has non-ASCII or control bytes" % os.path.relpath(path, ROOT))

    def test_the_engine_uses_only_the_standard_library(self):
        allowed = {
            "__future__", "argparse", "base64", "binascii", "bisect", "copy", "datetime", "fractions",
            "functools", "glob", "hashlib", "json", "math", "os", "pathlib", "plistlib", "re", "shutil",
            "sqlite3",
            "sys", "tempfile", "time", "typing", "zlib", "zoneinfo", "wrapped",
        }
        for path in tracked("wrapped/*.py"):
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if line.startswith("import "):
                        names = [part.strip().split(" ")[0] for part in line[7:].split(",")]
                    elif line.startswith("from ") and " import " in line:
                        names = [line.split()[1]]
                    else:
                        continue
                    for name in names:
                        if name.startswith("."):
                            continue
                        self.assertIn(name.split(".")[0], allowed, "%s imports %s" % (path, name))

    def test_test_data_is_invented(self):
        """Every phone number in the tests is inside +1 555 01xx xxxx and every
        e-mail address is at example.com (or the specification's own
        "jane@localhost"), so nothing here can be somebody's."""
        files = (tracked("tests/python/*.py") + tracked("tests/conformance/*") + tracked("tests/engine-js/*")
                 + tracked("tests/fixtures/*.py"))
        address = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:[.][A-Za-z0-9-]+)*)")
        plus = re.compile(r"[+][0-9][0-9 ().-]{7,}")
        spaced = re.compile(r"(?<![0-9.])[(]?([0-9]{3})[)]?[ .-]([0-9]{3})[ .-][0-9]{4}(?![0-9])")
        checked = 0
        for path in files:
            if not os.path.isfile(path):
                continue
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            name = os.path.relpath(path, ROOT)
            for match in address.finditer(text):
                checked += 1
                self.assertIn(match.group(1).lower(), ("example.com", "localhost"),
                              "%s: %s" % (name, match.group(0)))
            for match in plus.finditer(text):
                checked += 1
                digits = re.sub("[^0-9]", "", match.group(0))
                self.assertTrue(digits.startswith("155501"), "%s: %s" % (name, match.group(0)))
            for match in spaced.finditer(text):
                checked += 1
                self.assertEqual((match.group(1), match.group(2)[:2]), ("555", "01"),
                                 "%s: %s" % (name, match.group(0)))
        self.assertGreater(checked, 150)

    def test_no_database_files_are_tracked(self):
        try:
            listing = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True,
                                     check=True).stdout.splitlines()
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("not a git checkout")
        offenders = [name for name in listing
                     if name.lower().endswith((".db", ".sqlite", ".sqlitedb", ".abcddb", "-wal", "-shm"))]
        self.assertEqual(offenders, [])

    def test_product_name_is_a_single_constant(self):
        from wrapped import product
        self.assertEqual(product.PRODUCT_NAME, "Threadback")
        for path in tracked("wrapped/*.py"):
            if path.endswith("product.py"):
                continue
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            self.assertNotIn("iMessage Wrapped", text, path)
            self.assertNotIn("Wrapped for iMessage", text, path)
            self.assertNotIn('"Threadback', text.replace('"Threadback engine', ""), path)


if __name__ == "__main__":
    unittest.main()
