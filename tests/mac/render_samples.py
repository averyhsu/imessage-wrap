#!/usr/bin/env python3
"""Render sample recap cards from invented data, for looking at.

    python tests/mac/render_samples.py OUTDIR

Writes ``card-demo.png`` (the story's demo data), one card per edge case, a
contact sheet ``card-edge-cases.png`` and the send-test picture. CI uploads the
folder as an artifact so the macOS rendering can be inspected.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
for path in (ROOT, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from PIL import Image  # noqa: E402

from mac_support import sample_stats  # noqa: E402
from test_mac_card import edge_cases  # noqa: E402
from wrapped.mac.card import FontBook, render_card, render_test_image  # noqa: E402


def demo_stats() -> dict:
    vector = os.path.join(ROOT, "tests", "vectors", "payload-v1.json")
    try:
        with open(vector, encoding="utf-8") as handle:
            return json.load(handle)["stats"]
    except (OSError, ValueError, KeyError):
        return sample_stats()


def main(argv) -> int:
    if len(argv) != 1:
        sys.stderr.write(__doc__)
        return 2
    out = argv[0]
    os.makedirs(out, exist_ok=True)
    book = FontBook()
    print("emoji font:", book.emoji_path or "none", "| text shaping:", "raqm" if book.shaping else "basic")
    render_card(demo_stats(), os.path.join(out, "card-demo.png"))
    render_test_image(os.path.join(out, "send-test-image.png"))
    names = []
    for i, (name, stats) in enumerate(edge_cases().items(), 1):
        slug = "".join(ch if ch.isalnum() else "-" for ch in name).strip("-")
        path = os.path.join(out, f"case-{i:02d}-{slug}.png")
        render_card(stats, path)
        names.append(path)
        print("rendered", os.path.basename(path))
    cols, tw, th, gap = 5, 324, 405, 8
    rows = (len(names) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw + (cols + 1) * gap, rows * th + (rows + 1) * gap), (24, 24, 28))
    for i, path in enumerate(names):
        with Image.open(path) as im:
            thumb = im.resize((tw, th), Image.LANCZOS)
        sheet.paste(thumb, (gap + (i % cols) * (tw + gap), gap + (i // cols) * (th + gap)))
    sheet.save(os.path.join(out, "card-edge-cases.png"), format="PNG", compress_level=6)
    print("wrote", out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
