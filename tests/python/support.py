"""Shared helpers for the Python tests.

The fixture (invented databases) is generated once per test process into a
temporary folder, or reused from ``WRAPPED_FIXTURE_DIR`` when that is set and
already holds one (the conformance job builds it once for both engines).

Nothing is written into the repository: everything the tests create goes to
temporary folders, and Python is told not to leave ``__pycache__`` behind (set
``PYTHONDONTWRITEBYTECODE=1`` yourself to cover the test modules as well, as
the CI job does; whatever this run wrote for them regardless is removed again
when it ends).
"""

import atexit
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_CACHE_WAS_ON = not sys.dont_write_bytecode
sys.dont_write_bytecode = True                          # the engine, the fixture builder
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"             # every program the tests start
# The command line calls the owner by the Mac account's first name unless told
# otherwise. The tests tell it: the same name on every machine.
os.environ["WRAPPED_ME"] = "Me"


def _forget_bytecode():
    """Remove the bytecode this run wrote for the test modules themselves
    (they are imported before this file can switch the cache off)."""
    for part in ("python", "conformance"):
        folder = os.path.join(ROOT, "tests", part, "__pycache__")
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in names:
            if name.startswith(("test_", "support.")):
                try:
                    os.remove(os.path.join(folder, name))
                except OSError:
                    pass
        try:
            os.rmdir(folder)                            # only when nothing else is in it
        except OSError:
            pass


if _CACHE_WAS_ON:
    atexit.register(_forget_bytecode)

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


def run_cli(*args, stdin=None, env=None):
    """Run ``python -m wrapped`` in a subprocess, in a temporary folder.
    Returns ``(status, stdout, stderr)``; the two texts are decoded without
    newline translation, so a stray carriage return stays visible."""
    environment = dict(os.environ, PYTHONPATH=ROOT, PYTHONIOENCODING="utf-8", TZ=LA)
    environment.pop("WRAPPED_DEBUG", None)
    environment.update(env or {})
    if isinstance(stdin, str):
        stdin = stdin.encode("utf-8")
    proc = subprocess.run([sys.executable, "-m", "wrapped"] + list(args), input=stdin,
                          capture_output=True, env=environment, cwd=tempfile.gettempdir())
    return (proc.returncode, proc.stdout.decode("utf-8", "replace"),
            proc.stderr.decode("utf-8", "replace"))


def call_cli(*args):
    """Run the command line inside this process (fast: no interpreter start).
    Returns ``(status, stdout, stderr)``."""
    from wrapped import cli
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            status = cli.main(list(args))
        except SystemExit as exc:           # argparse: usage errors
            status = exc.code
    return status, out.getvalue(), err.getvalue()


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


# ---- nothing private in what is shown or shared -------------------------------

_NOT_IN_AN_ADDRESS = re.compile(r"""[\s<>()\[\]"',;:@]""")
_CONTROL = re.compile("[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]")


def count_decimals(text):
    """How many decimal digits (of any script) a string holds."""
    return sum(1 for ch in text if ch.isdecimal())


def text_leaks(text, where="text"):
    """What a piece of output must never contain: a run of seven or more
    digits (in any script), an e-mail address, a control character or a
    direction override. Returns a list of findings (empty = clean)."""
    found = []
    run = 0
    for ch in text + " ":
        if ch.isdecimal():
            run += 1
            continue
        if run >= 7:
            found.append("%s: a run of %d digits" % (where, run))
        run = 0
    at = text.find("@")
    while at != -1:                 # a character on each side of the sign; linear, whatever the length
        if (0 < at < len(text) - 1 and not _NOT_IN_AN_ADDRESS.match(text[at - 1])
                and not _NOT_IN_AN_ADDRESS.match(text[at + 1])):
            found.append("%s: an address (%r)" % (where, text[max(0, at - 30):at + 30]))
        at = text.find("@", at + 1)
    for match in _CONTROL.finditer(text):
        found.append("%s: control character U+%04X" % (where, ord(match.group(0))))
    return found


def names_in(stats):
    """(where, name) for the chat name and every place that names a person."""
    out = []
    chat = stats.get("chat")
    if isinstance(chat, dict) and isinstance(chat.get("name"), str):
        out.append(("chat.name", chat["name"]))
    for index, sender in enumerate(stats.get("senders") or []):
        out.append(("senders[%d].name" % index, sender["name"]))
    late = (stats.get("late_night") or {}).get("top")
    if late:
        out.append(("late_night.top.name", late["name"]))
    for index, quote in enumerate(stats.get("most_reacted") or []):
        out.append(("most_reacted[%d].sender" % index, quote["sender"]))
    reactions = stats.get("reactions") or {}
    for key in ("top_giver", "top_receiver"):
        if reactions.get(key):
            out.append(("reactions.%s.name" % key, reactions[key]["name"]))
    for index, award in enumerate(stats.get("awards") or []):
        out.append(("awards[%d].winner" % index, award["winner"]))
    return out


def _strings(value, where):
    if isinstance(value, str):
        yield where, value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield where + " (key)", key
            for found in _strings(item, "%s.%s" % (where, key)):
                yield found
    elif isinstance(value, list):
        for index, item in enumerate(value):
            for found in _strings(item, "%s[%d]" % (where, index)):
                yield found


def leaks(stats):
    """Findings for a whole stats object: text_leaks() for every string in
    it (the quoted message text aside: that is the user's own content and
    only goes into a link when asked for), and no name in it may hold seven
    digits in total, however they are separated ("+1 555-010-0123" has no
    long run but is a phone number)."""
    found = []
    for where, text in _strings(stats, "stats"):
        if not (where.startswith("stats.most_reacted[") and where.endswith(".text")):
            found += text_leaks(text, where)
    for where, name in names_in(stats):
        # a chat without a name of its own is called after its members: "Ines, Bram & 2 more"
        parts = re.split(", | & ", name) if where == "chat.name" else [name]
        for part in parts:
            if count_decimals(part) >= 7:
                found.append("%s: %d digits in %r" % (where, count_decimals(part), part))
    return found


def too_long(stats):
    """Names in a stats object that are over the caps of docs/SCHEMA.md 2: a
    person 40 characters plus an ellipsis, a chat 80 plus an ellipsis."""
    found = []
    for where, name in names_in(stats):
        limit = 81 if where == "chat.name" else 41
        if len(name) > limit:
            found.append("%s: %d characters" % (where, len(name)))
    label = (stats.get("period") or {}).get("label")
    if isinstance(label, str) and len(label) > 81:
        found.append("period.label: %d characters" % len(label))
    return found


def names_vectors():
    """tests/conformance/names.json: hand-written clean/mask/short-name cases."""
    with open(os.path.join(ROOT, "tests", "conformance", "names.json"), encoding="utf-8") as handle:
        return json.load(handle)


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
