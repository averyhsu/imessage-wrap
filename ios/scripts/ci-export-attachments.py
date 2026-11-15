#!/usr/bin/env python3
"""CI fallback: copy the named screenshots out of an .xcresult bundle.

The tests normally write their screenshots straight to WRAPPED_ARTIFACTS_DIR. If that did
not happen (the variable did not reach the test runner), this recovers the same images
from the result bundle's attachments.

usage: ci-export-attachments.py <bundle.xcresult> <destination directory>
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

PREFIXES = ("app-", "gallery-", "render-", "messages-", "experimental-")


def main():
    xcresult, destination = sys.argv[1], sys.argv[2]
    staging = tempfile.mkdtemp()
    subprocess.run(
        ["xcrun", "xcresulttool", "export", "attachments", "--path", xcresult, "--output-path", staging],
        check=True,
    )
    with open(os.path.join(staging, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)

    os.makedirs(destination, exist_ok=True)
    copied = 0
    for test in manifest:
        for attachment in test.get("attachments", []):
            exported = attachment.get("exportedFileName") or ""
            human = attachment.get("suggestedHumanReadableName") or exported
            if not exported.lower().endswith(".png"):
                continue
            name = re.sub(r"_\d+_[0-9A-Fa-f-]{36}(?=\.png$)", "", human)
            if not name.startswith(PREFIXES):
                continue
            target = os.path.join(destination, name)
            if os.path.exists(target):
                continue
            shutil.copyfile(os.path.join(staging, exported), target)
            copied += 1
    print("recovered %d screenshot(s) from %s" % (copied, os.path.basename(xcresult)))


if __name__ == "__main__":
    main()
