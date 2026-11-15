#!/usr/bin/env python3
"""Generate the app icon and the iMessage app icon set (requires Pillow).

    python3 ios/scripts/make-icons.py

Design: near-black background with a soft glow, a speech bubble filled with the brand
gradient, and three rising bars (the "stats") inside it. No third-party logos.
The same bubble, without the background, is the brand mark the app and the extension show
in their own UI (Shared/Brand.xcassets), so there is one mark everywhere.
The PNGs are committed; rerun this only when the design changes.
"""
import json
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
IOS = os.path.dirname(HERE)

PINK = (255, 61, 127)
VIOLET = (155, 77, 255)
BLUE = (61, 139, 255)
BG_TOP = (22, 14, 40)
BG_BOTTOM = (7, 7, 12)


def gradient(size, start, mid, end, angle=45):
    """Three-stop linear gradient covering `size`, rotated by `angle` degrees."""
    w, h = size
    side = int(max(w, h) * 1.5)
    ramp = Image.linear_gradient("L").resize((side, side))
    ramp = ramp.rotate(angle, resample=Image.BICUBIC)
    left = (side - w) // 2
    top = (side - h) // 2
    ramp = ramp.crop((left, top, left + w, top + h))
    return ImageOps.colorize(ramp, black=start, white=end, mid=mid)


def render(width, height, bubble_scale=0.62, mark_only=False):
    """Render the icon at width x height (supersampled 4x).

    With mark_only, return just the bubble on a transparent background, cropped to its
    bounds and still at the supersampled resolution."""
    ss = 4
    w, h = width * ss, height * ss
    base = min(w, h)

    # Background: vertical dark gradient plus a violet glow behind the bubble.
    bg = gradient((w, h), BG_TOP, (12, 9, 22), BG_BOTTOM, angle=0)
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    r = int(base * 0.46)
    cx, cy = w // 2, int(h * 0.5)
    gd.ellipse((cx - r, cy - r, cx + r, cy + r), fill=120)
    glow = glow.filter(ImageFilter.GaussianBlur(base * 0.12))
    glow_color = Image.new("RGB", (w, h), (120, 50, 220))
    bg = Image.composite(glow_color, bg, glow)

    # Speech bubble mask: rounded rectangle plus a tail at the lower left.
    bw = int(base * bubble_scale * 1.12)
    bh = int(base * bubble_scale * 0.86)
    bx0 = cx - bw // 2
    by0 = cy - bh // 2 - int(base * 0.035)
    bx1, by1 = bx0 + bw, by0 + bh
    radius = int(bh * 0.34)
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((bx0, by0, bx1, by1), radius=radius, fill=255)
    tail = [
        (bx0 + int(bw * 0.16), by1 - int(bh * 0.10)),
        (bx0 + int(bw * 0.06), by1 + int(bh * 0.22)),
        (bx0 + int(bw * 0.40), by1 - int(bh * 0.04)),
    ]
    md.polygon(tail, fill=255)

    # The gradient spans just the bubble (not the whole canvas), so the bubble shows the
    # full pink-to-blue range instead of only its violet middle.
    tail_bottom = by1 + int(bh * 0.22)
    box_w, box_h = bx1 - bx0, tail_bottom - by0
    span = int(max(box_w, box_h))
    ramp = Image.linear_gradient("L").resize((span, span)).rotate(-45, resample=Image.BICUBIC, expand=True)
    inner = int(ramp.size[0] * 0.5)
    off = (ramp.size[0] - inner) // 2
    ramp = ramp.crop((off, off, off + inner, off + inner)).resize((box_w, box_h), Image.BICUBIC)
    local = ImageOps.colorize(ramp, black=PINK, white=BLUE, mid=VIOLET)
    fill = Image.new("RGB", (w, h), VIOLET)
    fill.paste(local, (bx0, by0))
    img = Image.composite(fill, bg, mask)

    # A subtle top highlight inside the bubble for depth.
    hi = Image.new("L", (w, h), 0)
    hd = ImageDraw.Draw(hi)
    hd.rounded_rectangle((bx0, by0, bx1, by0 + int(bh * 0.5)), radius=radius, fill=26)
    hi = hi.filter(ImageFilter.GaussianBlur(base * 0.03))
    hi = ImageChops.multiply(hi, mask)
    img = Image.composite(Image.new("RGB", (w, h), (255, 255, 255)), img, hi)

    # Three rising bars.
    d = ImageDraw.Draw(img)
    bar_w = int(bw * 0.13)
    gap = int(bw * 0.085)
    total = bar_w * 3 + gap * 2
    x = cx - total // 2
    floor = by1 - int(bh * 0.22)
    for frac in (0.26, 0.42, 0.58):
        top = floor - int(bh * frac)
        d.rounded_rectangle((x, top, x + bar_w, floor), radius=bar_w // 2, fill=(255, 255, 255))
        x += bar_w + gap

    if mark_only:
        rgba = img.convert("RGBA")
        rgba.putalpha(mask)
        return rgba.crop((bx0, by0, bx1, tail_bottom))

    return img.resize((width, height), Image.LANCZOS).convert("RGB")


def write_brand_mark():
    """The bubble alone, for use inside the app's and the extension's own UI."""
    catalog = os.path.join(IOS, "Shared", "Brand.xcassets")
    out = os.path.join(catalog, "BrandMark.imageset")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(catalog, "Contents.json"), "w") as f:
        json.dump({"info": {"author": "xcode", "version": 1}}, f, indent=2)
        f.write("\n")
    big = render(512, 512, mark_only=True)
    ratio = big.width / big.height
    images = []
    for scale in (1, 2, 3):
        height = 44 * scale
        name = "brand-mark@%dx.png" % scale
        big.resize((round(height * ratio), height), Image.LANCZOS).save(os.path.join(out, name), optimize=True)
        images.append({"filename": name, "idiom": "universal", "scale": "%dx" % scale})
    with open(os.path.join(out, "Contents.json"), "w") as f:
        json.dump({"images": images, "info": {"author": "xcode", "version": 1}}, f, indent=2)
        f.write("\n")


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
        path = os.path.join(out, name)
        if not os.path.exists(path) or True:
            render(px, py, bubble_scale=0.66 if pw != ph else 0.62).save(path, optimize=True)
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
    write_brand_mark()
    print("icons written")
