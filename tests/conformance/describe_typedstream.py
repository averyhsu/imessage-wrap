#!/usr/bin/env python3
"""Show what the Python decoder makes of real NSArchiver samples.

    python tests/conformance/describe_typedstream.py SAMPLES.json

SAMPLES.json comes from real_typedstream.swift (macOS). For each sample this
prints its size, which decoding strategy succeeded, whether the text came back
exactly, and whether the fixture writer (tests/fixtures/build_fixture.py)
produces the very same bytes. A few short blobs are dumped in hex so the real
layout is on record in the CI log. Always exits 0: the test suites assert.
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests", "fixtures"))

import build_fixture  # noqa: E402
from wrapped.typedstream import decode_with_strategy  # noqa: E402

DUMP = {"len12", "len12_mutable", "len128", "len300_mutable", "attachment_and_text",
        "link_run_mutable", "no_attributes", "int64_part", "len0", "len0_mutable"}


def spaced(hex_text, width=64):
    return "\n".join("      " + hex_text[i:i + width] for i in range(0, len(hex_text), width))


def main(path):
    with open(path, encoding="utf-8") as handle:
        samples = json.load(handle)
    wrong = different = 0
    print("%-28s %8s  %-10s %-5s %s" % ("sample", "bytes", "strategy", "text", "fixture writer"))
    for sample in samples:
        blob = bytes.fromhex(sample["hex"])
        text, how = decode_with_strategy(blob)
        ok = text == sample["string"]
        wrong += not ok
        ours = build_fixture.archive_attributed_string(sample["string"], mutable=sample["mutable"])
        same = ours == blob
        if sample["messages_layout"]:
            verdict = "identical" if same else "DIFFERENT"
            different += not same
        else:
            verdict = "identical" if same else "-"
        print("%-28s %8d  %-10s %-5s %s" % (sample["name"], len(blob), how, "ok" if ok else "WRONG", verdict))
        if sample["name"] in DUMP or not ok or (sample["messages_layout"] and not same and len(blob) < 400):
            print("    real:")
            print(spaced(sample["hex"][:1600]))
            if not same and len(ours) < 800:
                print("    fixture writer:")
                print(spaced(ours.hex()))
    print("%d samples, %d decoded wrongly, %d Messages-layout samples the fixture writer does not "
          "reproduce byte for byte" % (len(samples), wrong, different))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
