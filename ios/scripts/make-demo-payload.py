#!/usr/bin/env python3
"""Regenerate ios/Shared/DemoRecap.swift from tests/vectors/payload-v1.json.

Only the `payload` constant is rewritten; the rest of the file is kept.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
VECTOR = os.path.join(REPO, "tests", "vectors", "payload-v1.json")
SWIFT = os.path.join(REPO, "ios", "Shared", "DemoRecap.swift")

with open(VECTOR, encoding="utf-8") as f:
    payload = json.load(f)["payload"]
assert re.fullmatch(r"[A-Za-z0-9_-]+", payload), "payload must be base64url"

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
