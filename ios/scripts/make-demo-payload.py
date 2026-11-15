#!/usr/bin/env python3
"""Regenerate ios/Shared/DemoRecap.swift from the site's demo (web/js/demo-data.js).

The app's sample recap is the same invented chat the web story plays for `?demo=1`, so
the two can never tell different stories. Only the `payload` constant is rewritten; the
rest of the file is kept. tests/python/test_ios_demo.py fails when the two drift apart.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DEMO = os.path.join(REPO, "web", "js", "demo-data.js")
SWIFT = os.path.join(REPO, "ios", "Shared", "DemoRecap.swift")

sys.path.insert(0, REPO)
from wrapped.payload import decode_payload, encode_payload  # noqa: E402


def demo_stats():
    """The object literal assigned in demo-data.js (it is written as strict JSON)."""
    with open(DEMO, encoding="utf-8") as f:
        source = f.read()
    return json.loads(source[source.index("{"):source.rindex("}") + 1])


def swift_payload():
    with open(SWIFT, encoding="utf-8") as f:
        source = f.read()
    block = source[source.index("static let payload"):source.index("].joined()")]
    return "".join(re.findall(r'"([A-Za-z0-9_-]+)"', block))


def main():
    stats = demo_stats()
    payload = encode_payload(stats)
    assert re.fullmatch(r"[A-Za-z0-9_-]+", payload), "payload must be base64url"
    assert decode_payload(payload) == stats, "the payload must decode back to the demo"

    chunks = [payload[i:i + 96] for i in range(0, len(payload), 96)]
    literal = ",\n".join('        "%s"' % chunk for chunk in chunks)

    with open(SWIFT, encoding="utf-8") as f:
        source = f.read()
    pattern = re.compile(r"(static let payload: String = \[\n).*?(\n    \]\.joined\(\))", re.S)
    assert pattern.search(source), "payload constant not found in DemoRecap.swift"
    source = pattern.sub(lambda m: m.group(1) + literal + m.group(2), source)
    with open(SWIFT, "w", encoding="utf-8") as f:
        f.write(source)
    print("DemoRecap.swift updated (%d characters)" % len(payload))


if __name__ == "__main__":
    main()
