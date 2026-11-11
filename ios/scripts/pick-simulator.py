#!/usr/bin/env python3
"""Pick an available iPhone simulator instead of hard-coding a device name.

Prints `udid=`, `name=` and `os=` lines (GitHub Actions output format).

Choice: the newest iOS runtime that is not newer than the selected Xcode's simulator SDK,
then a mainstream iPhone model. Override with WRAPPED_SIM_NAME / WRAPPED_SIM_OS
(for example WRAPPED_SIM_OS=18 or WRAPPED_SIM_OS=26.1).
"""
import json
import os
import re
import subprocess
import sys

PREFERRED = [
    "iPhone 17 Pro",
    "iPhone 17",
    "iPhone 16 Pro",
    "iPhone 16",
    "iPhone 15 Pro",
    "iPhone 15",
]


def sdk_version():
    try:
        out = subprocess.check_output(
            ["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"], text=True
        ).strip()
        parts = [int(p) for p in out.split(".") if p.isdigit()]
        return tuple((parts + [0, 0])[:2])
    except Exception:
        return (999, 0)


def main():
    raw = subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"])
    devices = json.loads(raw).get("devices", {})
    want_name = os.environ.get("WRAPPED_SIM_NAME", "").strip()
    want_os = os.environ.get("WRAPPED_SIM_OS", "").strip()
    sdk = sdk_version()

    candidates = []
    for runtime, entries in devices.items():
        match = re.search(r"iOS-(\d+)(?:-(\d+))?(?:-(\d+))?$", runtime)
        if not match:
            continue
        version = tuple(int(g) if g else 0 for g in match.groups())
        label = "%d.%d" % (version[0], version[1])
        if want_os and not (label == want_os or label.startswith(want_os + ".")):
            continue
        for device in entries:
            name = device.get("name", "")
            if not name.startswith("iPhone"):
                continue
            if device.get("isAvailable") is False:
                continue
            if want_name and name != want_name:
                continue
            if name in PREFERRED:
                rank = PREFERRED.index(name)
            elif "SE" in name or "mini" in name:
                rank = len(PREFERRED) + 2
            else:
                rank = len(PREFERRED) + 1
            not_newer_than_sdk = 1 if version[:2] <= sdk else 0
            candidates.append((not_newer_than_sdk, version, -rank, name, device["udid"], label))

    if not candidates:
        sys.stderr.write("No available iPhone simulator matched.\n")
        sys.exit(1)

    candidates.sort(reverse=True)
    _, _, _, name, udid, label = candidates[0]
    print("udid=%s" % udid)
    print("name=%s" % name)
    print("os=%s" % label)


if __name__ == "__main__":
    main()
