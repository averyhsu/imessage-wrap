#!/usr/bin/env python3
"""Generate the app icon and the iMessage app icon set (requires Pillow).

    python3 ios/scripts/make-icons.py

Design: the product's brand mark as on the web (a speech bubble with three dots), drawn
in the story's cover gradient on a near-black background with a soft blue glow.
No third-party logos. The PNGs are committed; rerun this only when the design changes.
"""
import json
import os

from PIL import Image, ImageDraw, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
IOS = os.path.dirname(HERE)

# web/css/story.css, .slide--cover: linear-gradient(165deg, #2a9bff 0%, #0a7aff 38%, #0047e0 100%)
COVER_TOP = (0x2A, 0x9B, 0xFF)
COVER_MID = (0x0A, 0x7A, 0xFF)
COVER_BOTTOM = (0x00, 0x47, 0xE0)
NIGHT = (0x07, 0x07, 0x0C)
GLOW = (0x0A, 0x84, 0xFF)


def quad(p0, p1, p2, steps=24):
    """Points along a quadratic Bezier curve."""
    points = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1]
        points.append((x, y))
    return points


def render(width, height, bubble_scale=0.6):
    """Render the icon at width x height (supersampled 4x)."""
    ss = 4
    w, h = width * ss, height * ss
    base = min(w, h)
    cx, cy = w // 2, h // 2

    # Background: near-black with a blue glow behind the bubble.
    bg = Image.new("RGB", (w, h), NIGHT)
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    r = int(base * 0.44)
    gd.ellipse((cx - r, cy - r, cx + r, cy + r), fill=105)
    glow = glow.filter(ImageFilter.GaussianBlur(base * 0.13))
    bg = Image.composite(Image.new("RGB", (w, h), GLOW), bg, glow)

    # Speech bubble: a pill-like rounded rectangle with a curved tail at the lower left.
    bw = int(base * bubble_scale * 1.22)
    bh = int(base * bubble_scale * 0.88)
    bx0 = cx - bw // 2 + int(base * 0.02)
    by0 = cy - bh // 2 - int(base * 0.03)
    bx1, by1 = bx0 + bw, by0 + bh
    radius = int(bh * 0.46)
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((bx0, by0, bx1, by1), radius=radius, fill=255)
    tip = (bx0 - int(bw * 0.07), by1 + int(bh * 0.07))
    start = (bx0 + int(radius * 0.22), by1 - int(radius * 0.95))
    end = (bx0 + int(radius * 1.15), by1 - int(radius * 0.06))
    tail = quad(start, (bx0 + int(radius * 0.2), by1 - int(bh * 0.02)), tip)
    tail += quad(tip, (bx0 + int(radius * 0.5), by1 + int(bh * 0.06)), end)
    md.polygon(tail, fill=255)

    # The cover gradient, top to bottom, spanning just the bubble.
    top, bottom = by0, tip[1]
    ramp = Image.linear_gradient("L").resize((w, max(1, bottom - top)))
    local = ImageOps.colorize(ramp, black=COVER_TOP, white=COVER_BOTTOM, mid=COVER_MID, midpoint=97)
    fill = Image.new("RGB", (w, h), COVER_MID)
    fill.paste(local, (0, top))
    img = Image.composite(fill, bg, mask)

    # Three dots.
    d = ImageDraw.Draw(img)
    dot = int(bh * 0.19)
    gap = int(bh * 0.13)
    total = dot * 3 + gap * 2
    x = (bx0 + bx1) // 2 - total // 2
    y = (by0 + by1) // 2 - dot // 2
    for _ in range(3):
        d.ellipse((x, y, x + dot, y + dot), fill=(255, 255, 255))
        x += dot + gap

    return img.resize((width, height), Image.LANCZOS).convert("RGB")


def write_app_icon():
    out = os.path.join(IOS, "App", "Assets.xcassets", "AppIcon.appiconset")
    os.makedirs(out, exist_ok=True)
    render(1024, 1024).save(os.path.join(out, "AppIcon-1024.png"), optimize=True)
    contents = {
        "images": [
            {
                "filename": "AppIcon-1024.png",
                "idiom": "universal",
                "platform": "ios",
                "size": "1024x1024",
            }
        ],
        "info": {"author": "xcode", "version": 1},
    }
    with open(os.path.join(out, "Contents.json"), "w") as f:
        json.dump(contents, f, indent=2)
        f.write("\n")


def write_messages_icon():
    out = os.path.join(IOS, "MessagesExtension", "Assets.xcassets", "iMessage App Icon.stickersiconset")
    os.makedirs(out, exist_ok=True)
    # (idiom, size in points, scale, platform or None)
    slots = [
        ("iphone", (29, 29), 2, None),
        ("iphone", (29, 29), 3, None),
        ("iphone", (60, 45), 2, None),
        ("iphone", (60, 45), 3, None),
        ("ipad", (29, 29), 2, None),
        ("ipad", (67, 50), 2, None),
        ("ipad", (74, 55), 2, None),
        ("ios-marketing", (1024, 1024), 1, None),
        ("universal", (27, 20), 2, "ios"),
        ("universal", (27, 20), 3, "ios"),
        ("universal", (32, 24), 2, "ios"),
        ("universal", (32, 24), 3, "ios"),
        ("ios-marketing", (1024, 768), 1, "ios"),
    ]
    images = []
    for idiom, (pw, ph), scale, platform in slots:
        px, py = pw * scale, ph * scale
        name = "messages-%dx%d.png" % (px, py)
        render(px, py, bubble_scale=0.66 if pw != ph else 0.6).save(os.path.join(out, name), optimize=True)
        entry = {
            "filename": name,
            "idiom": idiom,
            "scale": "%dx" % scale,
            "size": "%dx%d" % (pw, ph),
        }
        if platform:
            entry["platform"] = platform
        images.append(entry)
    with open(os.path.join(out, "Contents.json"), "w") as f:
        json.dump({"images": images, "info": {"author": "xcode", "version": 1}}, f, indent=2)
        f.write("\n")


def write_catalog_roots():
    for target in ("App", "MessagesExtension"):
        root = os.path.join(IOS, target, "Assets.xcassets")
        os.makedirs(root, exist_ok=True)
        with open(os.path.join(root, "Contents.json"), "w") as f:
            json.dump({"info": {"author": "xcode", "version": 1}}, f, indent=2)
            f.write("\n")


if __name__ == "__main__":
    write_catalog_roots()
    write_app_icon()
    write_messages_icon()
    print("icons written")
