"""Shared helpers for the Python tests.

The fixture (invented databases) is generated once per test process into a
temporary folder, or reused from ``WRAPPED_FIXTURE_DIR`` when that is set and
already holds one (the conformance job builds it once for both engines).
"""

import atexit
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
for path in (ROOT, FIXTURES):
    if path not in sys.path:
        sys.path.insert(0, path)

import build_fixture  # noqa: E402

LA = "America/Los_Angeles"
NOW = build_fixture.NOW_UNIX
APPLE_EPOCH = 978307200

_cache = {}


def fixture():
    """Return ``(directory, info)`` for the generated fixture."""
    if "dir" not in _cache:
        shared = os.environ.get("WRAPPED_FIXTURE_DIR")
        if shared and os.path.isfile(os.path.join(shared, "fixture.json")):
            with open(os.path.join(shared, "fixture.json"), encoding="utf-8") as handle:
                _cache["dir"], _cache["info"] = shared, json.load(handle)
        else:
            folder = tempfile.mkdtemp(prefix="wrapped-fixture-")
            atexit.register(shutil.rmtree, folder, True)
            out = os.path.join(folder, "fx")
            _cache["dir"], _cache["info"] = out, build_fixture.build(out)
    return _cache["dir"], _cache["info"]


def path(key):
    """Absolute path of one of the fixture's named files."""
    folder, info = fixture()
    return os.path.join(folder, *info["paths"][key].split("/"))


def ns(unix, nanos=0):
    """Unix seconds -> raw message.date in nanoseconds since 2001."""
    return (unix - APPLE_EPOCH) * 1000000000 + nanos


def msg(unix, sender="me", text="hello", **extra):
    """A minimal message row for compute_stats. sender: 'me' or a handle."""
    row = {"date": ns(unix), "is_from_me": 1 if sender == "me" else 0,
           "handle": None if sender == "me" else sender, "text": text}
    row.update(extra)
    return row


def tap(unix, sender, kind, target, **extra):
    """A tapback row aimed at the message row ``target`` (needs a guid)."""
    return msg(unix, sender, "Reacted", associated_message_type=kind,
               associated_message_guid=extra.pop("prefix", "p:0/") + target["guid"], **extra)


def subset_mismatches(expected, actual, where=""):
    """Paths at which ``expected`` (a partial tree) is not matched by ``actual``."""
    problems = []
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key, value in expected.items():
            if key not in actual:
                problems.append("%s.%s missing" % (where, key))
            else:
                problems += subset_mismatches(value, actual[key], "%s.%s" % (where, key))
    elif expected != actual:
        problems.append("%s: expected %r, got %r" % (where, expected, actual))
    return problems
