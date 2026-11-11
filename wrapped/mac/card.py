"""The recap card: the image that lands in the thread.

``render_card(stats, out_path)`` draws a 1080x1350 PNG from aggregate stats and
first names only. No message text ever goes on the card.

Design notes
- One bundled typeface (Inter, SIL OFL 1.1, in ``assets/``) so the output looks the
  same on every machine. Emoji come from the platform colour-emoji font when one
  exists (Apple Color Emoji on macOS, Noto Color Emoji on Linux) and are dropped
  cleanly otherwise. Characters Inter lacks fall back to a system font.
- Everything is drawn at 2x and downsampled, so shapes are anti-aliased.
- The motifs are Messages-flavoured (speech bubbles with tails, tapback badges)
  but drawn here from primitives: no Apple or Spotify artwork.
"""

from __future__ import annotations

import math
import os
import random
import struct
import sys
from functools import lru_cache
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFilter, ImageFont, features

from . import PRODUCT_NAME
from .fmt import by_hour as _by_hour
from .fmt import clean, display_names, fmt_int, fmt_pct, hour12, peak_hour

DESIGN_W, DESIGN_H = 1080, 1350
SUPERSAMPLE = 2
FOOTER = f"{PRODUCT_NAME} · made on this Mac, nothing uploaded"

FONT_DIR = Path(__file__).resolve().parent / "assets"
FONT_FILES = {
    "black": "Inter-Display-Black.ttf",
    "bold": "Inter-Display-Bold.ttf",
    "semibold": "Inter-SemiBold.ttf",
    "medium": "Inter-Medium.ttf",
}

EMOJI_FONTS = (
    "/System/Library/Fonts/Apple Color Emoji.ttc",
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf",
    "/usr/share/fonts/noto-emoji/NotoColorEmoji.ttf",
)
EMOJI_STRIKES = (160, 109, 136, 128, 96, 64)

# Tried in order for characters Inter does not cover (CJK, Hebrew, Arabic, Thai...).
FALLBACK_FONTS = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)

# Palette: a saturated dusk gradient, Messages blue for the hero bubble.
MESH = (
    ("#170A52", "#2A1CB0", "#1C55E8"),
    ("#3E13AA", "#6B20DA", "#8E2BE6"),
    ("#A2169A", "#D51F7C", "#FF4F6E"),
)
BLUE_TOP = "#2EA1FF"
BLUE_BOTTOM = "#0A6CFF"
WHITE = (255, 255, 255, 255)
INK = (18, 12, 48, 255)
YELLOW = (255, 214, 10, 255)
PINK = (255, 55, 95, 255)


class CardError(RuntimeError):
    """The card could not be rendered (for example the bundled font is missing)."""


# -- fonts -----------------------------------------------------------------------


def _cmap_ranges(path: str, index: int = 0) -> List[Tuple[int, int]]:
    """Unicode ranges a TrueType/OpenType font (or collection member) covers.

    A tiny reader for cmap formats 4 and 12; it seeks instead of loading the
    file because system CJK and emoji fonts are very large."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(12)
            base = 0
            if head[:4] == b"ttcf":
                count = struct.unpack(">I", head[8:12])[0]
                fh.seek(12 + 4 * min(index, max(0, count - 1)))
                base = struct.unpack(">I", fh.read(4))[0]
                fh.seek(base)
                head = fh.read(12)
            num_tables = struct.unpack(">H", head[4:6])[0]
            cmap_off = None
            for _ in range(num_tables):
                tag, _sum, off, _length = struct.unpack(">4sIII", fh.read(16))
                if tag == b"cmap":
                    cmap_off = off
                    break
            if cmap_off is None:
                return []
            fh.seek(cmap_off)
            _version, n = struct.unpack(">HH", fh.read(4))
            records = [struct.unpack(">HHI", fh.read(8)) for _ in range(n)]
            best = None
            for platform, encoding, off in records:
                fh.seek(cmap_off + off)
                fmt = struct.unpack(">H", fh.read(2))[0]
                if fmt == 12 and (platform, encoding) in ((3, 10), (0, 4), (0, 6)):
                    best = (12, cmap_off + off)
                    break
                if fmt == 4 and best is None and (platform == 0 or (platform, encoding) == (3, 1)):
                    best = (4, cmap_off + off)
            if best is None:
                return []
            fmt, off = best
            fh.seek(off)
            ranges: List[Tuple[int, int]] = []
            if fmt == 12:
                _f, _r, _len, _lang, groups = struct.unpack(">HHIII", fh.read(16))
                data = fh.read(12 * groups)
                for i in range(groups):
                    start, end, _gid = struct.unpack_from(">III", data, 12 * i)
                    ranges.append((start, end))
            else:
                _f, _len, _lang, seg_x2 = struct.unpack(">HHHH", fh.read(8))
                fh.read(6)
                seg = seg_x2 // 2
                ends = struct.unpack(f">{seg}H", fh.read(2 * seg))
                fh.read(2)
                starts = struct.unpack(f">{seg}H", fh.read(2 * seg))
                ranges = [(s, e) for s, e in zip(starts, ends) if e != 0xFFFF or s != 0xFFFF]
            ranges.sort()
            return ranges
    except (OSError, struct.error, ValueError):
        return []


def _covers(ranges: Sequence[Tuple[int, int]], cp: int) -> bool:
    lo, hi = 0, len(ranges) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        start, end = ranges[mid]
        if cp < start:
            hi = mid - 1
        elif cp > end:
            lo = mid + 1
        else:
            return True
    return False


def _layout_engine():
    try:
        if features.check("raqm"):
            return ImageFont.Layout.RAQM
    except Exception:
        pass
    return ImageFont.Layout.BASIC


class FontBook:
    """Loads the bundled faces, the emoji font and fallbacks, and answers
    'which font draws this character?'."""

    def __init__(self, font_dir: Path = FONT_DIR, emoji: Optional[bool] = None) -> None:
        self.font_dir = Path(font_dir)
        self.engine = _layout_engine()
        self.shaping = self.engine == ImageFont.Layout.RAQM
        missing = [f for f in FONT_FILES.values() if not (self.font_dir / f).is_file()]
        if missing:
            raise CardError(
                f"The bundled card font is missing ({', '.join(missing)} in {self.font_dir}). "
                "Reinstall Threadback; the package must include wrapped/mac/assets/*."
            )
        self._primary_ranges = _cmap_ranges(str(self.font_dir / FONT_FILES["bold"]))
        self._faces = {}
        self._fallbacks: Optional[List[Tuple[str, List[Tuple[int, int]]]]] = None
        self.emoji_path: Optional[str] = None
        self.emoji_strike = 0
        self._emoji_ranges: List[Tuple[int, int]] = []
        if emoji is not False:
            self._find_emoji_font()

    def _find_emoji_font(self) -> None:
        override = os.environ.get("THREADBACK_EMOJI_FONT")
        candidates = ([override] if override else []) + list(EMOJI_FONTS)
        for path in candidates:
            if not path or not os.path.isfile(path):
                continue
            for strike in EMOJI_STRIKES:
                try:
                    font = ImageFont.truetype(path, strike, layout_engine=self.engine)
                    probe = Image.new("RGBA", (strike * 2, strike * 2), (0, 0, 0, 0))
                    ImageDraw.Draw(probe).text((0, 0), chr(0x1F600), font=font, embedded_color=True)
                    if probe.getbbox() is None:
                        continue
                    colours = probe.convert("RGB").getcolors(maxcolors=1 << 20)
                    if colours is not None and len(colours) < 8:
                        continue  # monochrome outline only: not worth showing
                except Exception:
                    continue
                self.emoji_path, self.emoji_strike = path, strike
                self._emoji_ranges = _cmap_ranges(path)
                return

    def face(self, role: str, px: int, path: Optional[str] = None) -> ImageFont.FreeTypeFont:
        key = (role, px, path)
        font = self._faces.get(key)
        if font is None:
            src = path or str(self.font_dir / FONT_FILES[role])
            font = ImageFont.truetype(src, max(1, px), layout_engine=self.engine)
            self._faces[key] = font
        return font

    def emoji_face(self) -> Optional[ImageFont.FreeTypeFont]:
        if not self.emoji_path:
            return None
        return self.face("emoji", self.emoji_strike, self.emoji_path)

    def has_emoji(self, cp: int) -> bool:
        if not self.emoji_path:
            return False
        return not self._emoji_ranges or _covers(self._emoji_ranges, cp)

    def in_primary(self, cp: int) -> bool:
        return _covers(self._primary_ranges, cp)

    def fallback_for(self, cp: int) -> Optional[str]:
        if self._fallbacks is None:
            self._fallbacks = []
            for path in FALLBACK_FONTS:
                if os.path.isfile(path):
                    ranges = _cmap_ranges(path)
                    if ranges:
                        self._fallbacks.append((path, ranges))
        for path, ranges in self._fallbacks:
            if _covers(ranges, cp):
                return path
        return None


_JOINERS = (0x200D, 0xFE0F, 0x20E3)


def _emoji_base(cp: int) -> bool:
    return (
        0x1F000 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
        or 0x231A <= cp <= 0x23FF
        or cp in (0x2B50, 0x2B55, 0x2B1B, 0x2B1C, 0x2B05, 0x2B06, 0x2B07, 0x2934, 0x2935, 0x3030, 0x303D)
    )


Cluster = Tuple[str, str, Optional[str]]  # (kind, text, font path): kind is "text" or "emoji"


def clusters(text: str, book: FontBook) -> List[Cluster]:
    """Split text into drawable units: one per character, or one per emoji sequence.

    Anything that cannot be drawn (emoji without an emoji font, characters no
    installed font has) is dropped rather than shown as a box."""
    out: List[Cluster] = []
    chars = list(text)
    i = 0
    n = len(chars)
    while i < n:
        ch = chars[i]
        cp = ord(ch)
        nxt = ord(chars[i + 1]) if i + 1 < n else 0
        is_emoji = False
        if 0x1F000 <= cp <= 0x1FAFF:
            is_emoji = True
        elif _emoji_base(cp):
            # BMP symbols are emoji when asked for (VS16) or when the text font has no glyph
            is_emoji = nxt == 0xFE0F or not book.in_primary(cp)
        if is_emoji:
            j = i + 1
            while j < n:
                c2 = ord(chars[j])
                if c2 in _JOINERS or 0x1F3FB <= c2 <= 0x1F3FF or 0xE0020 <= c2 <= 0xE007F:
                    j += 1
                elif ord(chars[j - 1]) == 0x200D and (_emoji_base(c2) or 0x1F000 <= c2 <= 0x1FAFF):
                    j += 1
                elif 0x1F1E6 <= cp <= 0x1F1FF and 0x1F1E6 <= c2 <= 0x1F1FF and j == i + 1:
                    j += 1  # a flag is a pair of regional indicators
                else:
                    break
            seq = "".join(chars[i:j])
            if book.has_emoji(cp):
                if not book.shaping:
                    seq = "".join(c for c in seq if ord(c) not in (0x200D, 0xFE0F))
                out.append(("emoji", seq, None))
            elif book.in_primary(cp):
                out.append(("text", ch, None))
            i = j
            continue
        if cp in _JOINERS or cp < 0x20 or 0xE0020 <= cp <= 0xE007F:
            i += 1
            continue
        if cp == 0x20 or book.in_primary(cp):
            out.append(("text", ch, None))
        else:
            path = book.fallback_for(cp)
            if path is not None:
                out.append(("text", ch, path))
            elif 0x300 <= cp <= 0x36F:
                pass  # a combining mark with no base font: drop it
        i += 1
    # collapse the spaces that dropping characters can leave behind
    cleaned: List[Cluster] = []
    for c in out:
        if c[0] == "text" and c[1] == " " and (not cleaned or cleaned[-1][1] == " "):
            continue
        cleaned.append(c)
    while cleaned and cleaned[-1][1] == " ":
        cleaned.pop()
    return cleaned


def _runs(cl: Sequence[Cluster]) -> List[Cluster]:
    """Merge neighbouring clusters that share a font so shaping and kerning work."""
    runs: List[Cluster] = []
    for kind, text, path in cl:
        if runs and runs[-1][0] == kind and runs[-1][2] == path:
            runs[-1] = (kind, runs[-1][1] + text, path)
        else:
            runs.append((kind, text, path))
    return runs


# -- canvas ----------------------------------------------------------------------


def _rgba(color) -> Tuple[int, int, int, int]:
    if isinstance(color, str):
        c = color.lstrip("#")
        return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), 255)
    if len(color) == 3:
        return (color[0], color[1], color[2], 255)
    return tuple(color)  # type: ignore[return-value]


def _with_alpha(color, alpha: float) -> Tuple[int, int, int, int]:
    r, g, b, _a = _rgba(color)
    return (r, g, b, int(round(255 * alpha)))


class Canvas:
    """A drawing surface in *design units* (1080x1350); pixels are k times larger."""

    def __init__(self, width: int, height: int, k: float, book: FontBook) -> None:
        self.w, self.h, self.k, self.book = width, height, k, book
        self.img = Image.new("RGBA", (width, height), (0, 0, 0, 255))
        self._emoji_cache = {}

    def px(self, v: float) -> int:
        return int(round(v * self.k))

    # background ----------------------------------------------------------------

    def mesh(self, rows: Sequence[Sequence[str]]) -> None:
        """A smooth mesh gradient: control colours on a grid, eased between, then
        scaled up bicubically from a small image."""
        gw, gh = 36, 45
        cols, rws = len(rows[0]) - 1, len(rows) - 1
        grid = [[_rgba(col)[:3] for col in row] for row in rows]
        small = Image.new("RGB", (gw, gh))
        px = small.load()
        for y in range(gh):
            fy = y / (gh - 1) * rws
            y0 = min(int(fy), rws - 1)
            ty = fy - y0
            ty = ty * ty * (3 - 2 * ty)
            for x in range(gw):
                fx = x / (gw - 1) * cols
                x0 = min(int(fx), cols - 1)
                tx = fx - x0
                tx = tx * tx * (3 - 2 * tx)
                c00, c10 = grid[y0][x0], grid[y0][x0 + 1]
                c01, c11 = grid[y0 + 1][x0], grid[y0 + 1][x0 + 1]
                px[x, y] = tuple(
                    int(round((c00[i] * (1 - tx) + c10[i] * tx) * (1 - ty) + (c01[i] * (1 - tx) + c11[i] * tx) * ty))
                    for i in range(3)
                )
        self.img.paste(small.resize((self.w, self.h), Image.BICUBIC).convert("RGBA"))

    def glow(self, cx: float, cy: float, radius: float, color, alpha: float) -> None:
        """A soft radial light."""
        r = self.px(radius)
        if r <= 0:
            return
        # radial_gradient is 0 at the centre and reaches 128 at the middle of each
        # edge; ease it so the light is fully gone before the layer's square edge
        falloff = [int(255 * alpha * max(0.0, 1.0 - v / 126.0) ** 2) for v in range(256)]
        mask = Image.radial_gradient("L").point(falloff).resize((2 * r, 2 * r), Image.BICUBIC)
        layer = Image.new("RGBA", (2 * r, 2 * r), _rgba(color))
        layer.putalpha(mask)
        self.img.alpha_composite(layer, (self.px(cx) - r, self.px(cy) - r))  # type: ignore[arg-type]

    def grain(self, amount: int = 5, seed: int = 20261111) -> None:
        """Deterministic fine noise: hides gradient banding in an 8-bit PNG."""
        rng = random.Random(seed)
        tile = 256
        noise = Image.frombytes("L", (tile, tile), bytes(rng.getrandbits(8) for _ in range(tile * tile)))
        full = Image.new("L", (self.w, self.h))
        for y in range(0, self.h, tile):
            for x in range(0, self.w, tile):
                full.paste(noise, (x, y))
        light = Image.new("RGBA", (self.w, self.h), (255, 255, 255, 0))
        light.putalpha(full.point(lambda v: max(0, v - 128) * amount // 127))
        dark = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        dark.putalpha(full.point(lambda v: max(0, 127 - v) * amount // 127))
        self.img.alpha_composite(light)
        self.img.alpha_composite(dark)

    # shapes ----------------------------------------------------------------------

    def _safe_composite(self, layer: Image.Image, x: int, y: int) -> None:
        """alpha_composite that tolerates layers hanging off the canvas."""
        left, top = max(0, -x), max(0, -y)
        right = min(layer.width, self.w - x)
        bottom = min(layer.height, self.h - y)
        if right <= left or bottom <= top:
            return
        self.img.alpha_composite(layer.crop((left, top, right, bottom)), (x + left, y + top))

    def bubble_mask(
        self, w: float, h: float, radius: float, tail: Optional[str], tail_size: Optional[float] = None
    ) -> Tuple[Image.Image, int]:
        """Mask for a speech bubble with a Messages-style curved tail.

        The tail squares off the bottom corner so the bubble's flat bottom edge
        runs straight out to the tip, and a rounded bite out of the outer side
        makes the edge sweep out to that tip, as it does in Messages.

        Returns the mask and the horizontal padding (px) added on each side for the tail."""
        pw, ph, r = self.px(w), self.px(h), self.px(radius)
        r = max(1, min(r, pw // 2, ph // 2))
        t = max(2, min(self.px(tail_size) if tail_size else r, ph, pw // 2))
        out = int(t * 0.34)
        bite = int(t * 0.46)
        pad = out + 2
        mask = Image.new("L", (pw + 2 * pad, ph), 0)
        d = ImageDraw.Draw(mask)
        d.rounded_rectangle((pad, 0, pad + pw - 1, ph - 1), radius=r, fill=255)
        if tail == "right":
            edge = pad + pw
            d.rectangle((edge - t, ph - t, edge + out, ph - 1), fill=255)
            d.rounded_rectangle((edge, ph - t - 1, edge + out + 2 * bite, ph - 1), radius=bite, fill=0,
                                corners=(False, False, False, True))
        elif tail == "left":
            edge = pad
            d.rectangle((edge - out, ph - t, edge + t, ph - 1), fill=255)
            d.rounded_rectangle((edge - out - 2 * bite, ph - t - 1, edge - 1, ph - 1), radius=bite, fill=0,
                                corners=(False, False, True, False))
        return mask, pad

    def bubble(
        self,
        x: float,
        y: float,
        w: float,
        h: float,
        radius: float,
        fill,
        *,
        fill_bottom=None,
        tail: Optional[str] = None,
        tail_size: Optional[float] = None,
        shadow: float = 0.0,
        outline=None,
    ) -> None:
        mask, pad = self.bubble_mask(w, h, radius, tail, tail_size)
        ox, oy = self.px(x) - pad, self.px(y)
        if shadow > 0:
            blur = self.px(28)
            sh = Image.new("L", (mask.width + 4 * blur, mask.height + 4 * blur), 0)
            sh.paste(mask, (2 * blur, 2 * blur))
            sh = sh.filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * shadow))
            layer = Image.new("RGBA", sh.size, (10, 4, 40, 255))
            layer.putalpha(sh)
            self._safe_composite(layer, ox - 2 * blur, oy - 2 * blur + self.px(18))
        if fill_bottom is not None:
            top, bottom = _rgba(fill), _rgba(fill_bottom)
            ramp = Image.linear_gradient("L").resize(mask.size, Image.BILINEAR)
            body = Image.composite(
                Image.new("RGBA", mask.size, bottom), Image.new("RGBA", mask.size, top), ramp
            )
        else:
            body = Image.new("RGBA", mask.size, _rgba(fill))
        alpha = _rgba(fill)[3]
        if alpha < 255:
            mask = mask.point(lambda v: v * alpha // 255)
        body.putalpha(mask)
        self._safe_composite(body, ox, oy)
        if outline is not None:
            d = ImageDraw.Draw(self.img, "RGBA")
            d.rounded_rectangle(
                (self.px(x), self.px(y), self.px(x + w) - 1, self.px(y + h) - 1),
                radius=self.px(radius), outline=_rgba(outline), width=max(1, self.px(2)),
            )

    def pill(self, x: float, y: float, w: float, h: float, fill, radius: Optional[float] = None) -> None:
        if w <= 0 or h <= 0:
            return
        r = self.px(h / 2 if radius is None else radius)
        box = (self.px(x), self.px(y), max(self.px(x) + 1, self.px(x + w) - 1), max(self.px(y) + 1, self.px(y + h) - 1))
        colour = _rgba(fill)
        if colour[3] == 255:
            ImageDraw.Draw(self.img).rounded_rectangle(box, radius=r, fill=colour)
            return
        layer = Image.new("RGBA", (box[2] - box[0] + 1, box[3] - box[1] + 1), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle((0, 0, layer.width - 1, layer.height - 1), radius=r, fill=colour)
        self._safe_composite(layer, box[0], box[1])

    def circle(self, cx: float, cy: float, r: float, fill) -> None:
        self.pill(cx - r, cy - r, 2 * r, 2 * r, fill)

    def heart(self, cx: float, cy: float, size: float, fill) -> None:
        """A tapback-style heart from the classic parametric curve."""
        pts = []
        for i in range(120):
            t = 2 * math.pi * i / 120
            hx = 16 * math.sin(t) ** 3
            hy = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
            pts.append((self.px(cx + hx * size / 34.0), self.px(cy - (hy + 2.5) * size / 34.0)))
        ImageDraw.Draw(self.img).polygon(pts, fill=_rgba(fill))

    def tapback(self, cx: float, cy: float, r: float, kind: str, side: str = "left") -> None:
        """A tapback badge: a small bubble with two trailing dots and a glyph."""
        fill = (255, 255, 255, 255)
        sign = -1 if side == "left" else 1
        blur = self.px(10)
        size = self.px(2 * r) + 6 * blur
        sh = Image.new("L", (size, size), 0)
        ImageDraw.Draw(sh).ellipse((3 * blur, 3 * blur, size - 3 * blur, size - 3 * blur), fill=110)
        layer = Image.new("RGBA", (size, size), (10, 4, 40, 255))
        layer.putalpha(sh.filter(ImageFilter.GaussianBlur(blur)))
        self._safe_composite(layer, self.px(cx) - size // 2, self.px(cy) - size // 2 + self.px(6))
        self.circle(cx + sign * r * 0.80, cy + r * 0.86, r * 0.26, fill)
        self.circle(cx + sign * r * 1.20, cy + r * 1.26, r * 0.12, fill)
        self.circle(cx, cy, r, fill)
        if kind == "heart":
            self.heart(cx, cy, r * 1.12, PINK)
        elif kind == "haha":
            self.text(cx, cy - r * 0.02, "HA", "black", r * 0.56, (120, 124, 140, 255), anchor="mb")
            self.text(cx, cy + r * 0.48, "HA", "black", r * 0.56, (120, 124, 140, 255), anchor="mb")
        elif kind == "bang":
            self.text(cx, cy + r * 0.42, "!!", "black", r * 1.18, (120, 124, 140, 255), anchor="mb")
        else:
            self.text(cx, cy + r * 0.42, "?", "black", r * 1.18, (120, 124, 140, 255), anchor="mb")

    # text ------------------------------------------------------------------------

    def _emoji_image(self, seq: str, px: int) -> Optional[Image.Image]:
        key = (seq, px)
        if key in self._emoji_cache:
            return self._emoji_cache[key]
        font = self.book.emoji_face()
        result = None
        if font is not None and px > 0:
            strike = self.book.emoji_strike
            n = max(1, len(seq))
            tmp = Image.new("RGBA", (strike * (n + 1) * 2, strike * 2), (0, 0, 0, 0))
            try:
                ImageDraw.Draw(tmp).text((strike // 4, strike // 4), seq, font=font, embedded_color=True)
                box = tmp.getbbox()
            except Exception:
                box = None
            if box:
                glyph = tmp.crop(box)
                scale = px / float(strike)
                size = (max(1, int(round(glyph.width * scale))), max(1, int(round(glyph.height * scale))))
                result = glyph.resize(size, Image.LANCZOS)
        self._emoji_cache[key] = result
        return result

    def measure(self, cl: Sequence[Cluster], role: str, size: float) -> float:
        """Width of clusters in design units."""
        px = self.px(size)
        total = 0.0
        for kind, text, path in _runs(cl):
            if kind == "emoji":
                img = self._emoji_image(text, int(px * 1.06))
                total += (img.width if img else 0) + px * 0.06
            else:
                total += self.book.face(role, px, path).getlength(text)
        return total / self.k

    def fit(
        self, text: str, role: str, size: float, max_width: float, min_size: Optional[float] = None
    ) -> Tuple[List[Cluster], float]:
        """Shrink, then truncate with an ellipsis, until the text fits ``max_width``."""
        cl = clusters(text, self.book)
        floor = min_size if min_size is not None else size * 0.6
        s = size
        while s > floor and self.measure(cl, role, s) > max_width:
            s = max(floor, s * 0.95)
        if self.measure(cl, role, s) > max_width:
            ell: List[Cluster] = [("text", "…", None)]
            while cl and self.measure(cl + ell, role, s) > max_width:
                cl = cl[:-1]
                while cl and cl[-1][1] == " ":
                    cl = cl[:-1]
            cl = cl + ell
        return cl, s

    def text(
        self,
        x: float,
        y: float,
        text,
        role: str,
        size: float,
        fill,
        *,
        anchor: str = "ls",
        max_width: Optional[float] = None,
        min_size: Optional[float] = None,
    ) -> Tuple[float, float]:
        """Draw text with its baseline at ``y``. ``anchor`` is l/m/r + s (baseline) or
        b (same as s here). Returns (width, size used) in design units."""
        if isinstance(text, str):
            if max_width is not None:
                cl, size = self.fit(text, role, size, max_width, min_size)
            else:
                cl = clusters(text, self.book)
        else:
            cl = list(text)
        width = self.measure(cl, role, size)
        if anchor[0] == "m":
            x0 = x - width / 2
        elif anchor[0] == "r":
            x0 = x - width
        else:
            x0 = x
        px = self.px(size)
        cursor = float(self.px(x0))
        base = self.px(y)
        colour = _rgba(fill)
        draw = ImageDraw.Draw(self.img, "RGBA")
        for kind, run, path in _runs(cl):
            if kind == "emoji":
                img = self._emoji_image(run, int(px * 1.06))
                if img is not None:
                    top = base - int(px * 0.36) - img.height // 2
                    self._safe_composite(img, int(round(cursor + px * 0.03)), top)
                    cursor += img.width + px * 0.06
                continue
            font = self.book.face(role, px, path)
            if colour[3] == 255:
                draw.text((cursor, base), run, font=font, fill=colour, anchor="ls")
            else:
                w = int(font.getlength(run)) + px
                layer = Image.new("RGBA", (w, px * 2), (0, 0, 0, 0))
                ImageDraw.Draw(layer).text((px // 4, int(px * 1.4)), run, font=font, fill=colour, anchor="ls")
                self._safe_composite(layer, int(round(cursor)) - px // 4, base - int(px * 1.4))
            cursor += font.getlength(run)
        return width, size

    def tracked(self, x: float, y: float, text: str, role: str, size: float, fill, tracking: float = 0.12,
                anchor: str = "l") -> float:
        """Small-caps style label with letter spacing (Pillow has no tracking of its own)."""
        px = self.px(size)
        font = self.book.face(role, px)
        gap = px * tracking
        widths = [font.getlength(ch) for ch in text]
        total = sum(widths) + gap * max(0, len(text) - 1)
        cursor = float(self.px(x))
        if anchor == "m":
            cursor -= total / 2
        elif anchor == "r":
            cursor -= total
        colour = _rgba(fill)
        layer = Image.new("RGBA", (int(total) + 2 * px, px * 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        pen = float(px)
        for ch, w in zip(text, widths):
            d.text((pen, int(px * 1.4)), ch, font=font, fill=colour, anchor="ls")
            pen += w + gap
        self._safe_composite(layer, int(round(cursor)) - px, self.px(y) - int(px * 1.4))
        return total / self.k


# -- the card --------------------------------------------------------------------


def _int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _top_senders(stats: dict, limit: int = 3) -> List[Tuple[str, float, int]]:
    senders = [s for s in (stats.get("senders") or []) if isinstance(s, dict) and clean(s.get("name"))]
    names = display_names(s.get("name") for s in senders)
    total = _int((stats.get("totals") or {}).get("messages"))
    out = []
    for s in senders[:limit]:
        messages = _int(s.get("messages"))
        share = s.get("share")
        if not isinstance(share, (int, float)):
            share = (messages / total) if total else 0.0
        out.append((names[clean(s.get("name"))], max(0.0, min(1.0, float(share))), messages))
    return out


def _split_title(title: str) -> List[str]:
    """Break a long title into two balanced lines at a space."""
    words = title.split(" ")
    if len(words) < 2:
        return [title]
    best = None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        score = abs(len(a) - len(b))
        if best is None or score < best[0]:
            best = (score, [a, b])
    return best[1] if best else [title]


def render_card(stats: dict, out_path, size: Tuple[int, int] = (DESIGN_W, DESIGN_H), *, emoji: Optional[bool] = None):
    """Render the recap card for ``stats`` (docs/SCHEMA.md §1) to ``out_path`` (PNG).

    Returns the output path. ``emoji=False`` forces the no-emoji-font path (used
    by tests to exercise the fallback)."""
    if not isinstance(stats, dict):
        raise CardError("stats must be a dict")
    width, height = int(size[0]), int(size[1])
    if width < 200 or height < 250:
        raise CardError("card size is too small")
    book = _book(emoji)
    scale = min(width / DESIGN_W, height / DESIGN_H)
    k = scale * SUPERSAMPLE
    c = Canvas(width * SUPERSAMPLE, height * SUPERSAMPLE, k, book)
    # design-unit extents of the actual canvas (equal to 1080x1350 at the default size)
    W, H = width / scale, height / scale
    _paint(c, stats, W, H)
    final = c.img.convert("RGB").resize((width, height), Image.LANCZOS)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    # level 6: a third of a second; level 9 saves 3% and takes seven times longer
    final.save(out, format="PNG", compress_level=6)
    return out


def render_test_image(out_path, size: Tuple[int, int] = (720, 480)):
    """A small, obviously-a-test picture for ``wrapped send-test --with-image``."""
    width, height = int(size[0]), int(size[1])
    book = _book(None)
    k = (width / 720.0) * SUPERSAMPLE
    c = Canvas(width * SUPERSAMPLE, height * SUPERSAMPLE, k, book)
    W, H = 720.0, height / (width / 720.0)
    c.mesh(MESH)
    c.glow(W * 0.9, H * 0.1, 360, "#2F8CFF", 0.5)
    c.grain(4)
    c.bubble(60, H / 2 - 92, 600, 150, 56, BLUE_TOP, fill_bottom=BLUE_BOTTOM, tail="right", shadow=0.4)
    c.text(360, H / 2 - 10, f"{PRODUCT_NAME} test image", "black", 46, WHITE, anchor="ms", max_width=540)
    c.text(360, H / 2 + 34, "If you can see this, attachments work.", "medium", 24, (255, 255, 255, 235),
           anchor="ms", max_width=540)
    c.tapback(70, H / 2 - 88, 30, "heart", side="left")
    final = c.img.convert("RGB").resize((width, height), Image.LANCZOS)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    final.save(out, format="PNG", compress_level=6)
    return out


@lru_cache(maxsize=4)
def _book(emoji: Optional[bool]) -> FontBook:
    return FontBook(emoji=emoji)


def _paint(c: Canvas, stats: dict, W: float, H: float) -> None:
    chat = stats.get("chat") or {}
    period = stats.get("period") or {}
    totals = stats.get("totals") or {}
    personality = stats.get("personality") or {}

    chat_name = clean(chat.get("name")) or "Group chat"
    label = clean(period.get("label"), 18)
    messages = max(0, _int(totals.get("messages")))
    members = max(0, _int(chat.get("members")))
    title = clean(personality.get("title"), 48)
    peak = peak_hour(stats)
    hours = _by_hour(stats)
    top = _top_senders(stats)

    M = 72.0  # side margin
    inner = W - 2 * M

    # background -----------------------------------------------------------------
    c.mesh(MESH)
    c.glow(W * 0.95, H * 0.10, 560, "#2F8CFF", 0.50)
    c.glow(W * 0.00, H * 0.55, 460, "#8A2BFF", 0.35)
    c.glow(W * 1.00, H * 1.00, 600, "#FF8A4C", 0.50)
    c.grain(4)

    # header: the chat name as an incoming bubble ----------------------------------
    y = 62.0
    cl, used = c.fit(chat_name, "bold", 42, inner - 150, 32)
    name_w = c.measure(cl, "bold", used)
    bub_h = 84.0
    bub_w = max(150.0, name_w + 72)
    c.bubble(M, y, bub_w, bub_h, 42, (255, 255, 255, 255), tail="left", shadow=0.30)
    c.text(M + 36, y + bub_h / 2 + used * 0.36, cl, "bold", used, INK)
    c.tapback(M + bub_w - 4, y, 28, "haha", side="right")

    headline = f"{label} in review" if label else "In review"
    head_base = y + bub_h + 96
    c.text(M, head_base, headline, "black", 68, WHITE, max_width=inner, min_size=44)

    # hero: the message count in an outgoing bubble ---------------------------------
    count = fmt_int(messages)
    unit = "message" if messages == 1 else "messages"
    ncl, num_size = c.fit(count, "black", 204.0, inner - 150, 90)
    num_w = c.measure(ncl, "black", num_size)
    cap = num_size * 0.727
    hero_w = min(inner, max(500.0, num_w + 112))
    hero_h = cap + 158
    hero_y = head_base + 54
    hero_x = W - M - hero_w
    c.bubble(hero_x, hero_y, hero_w, hero_h, 72, BLUE_TOP, fill_bottom=BLUE_BOTTOM, tail="right", shadow=0.45)
    c.text(hero_x + hero_w - 54, hero_y + 44 + cap, ncl, "black", num_size, WHITE, anchor="rs")
    sub = unit if not members else f"{unit} · {fmt_int(members)} {'person' if members == 1 else 'people'}"
    c.text(hero_x + hero_w - 58, hero_y + hero_h - 40, sub, "semibold", 40, (255, 255, 255, 235), anchor="rs",
           max_width=hero_w - 110, min_size=28)
    c.tapback(hero_x + 8, hero_y + 4, 42, "heart", side="left")
    y = hero_y + hero_h

    # the remaining blocks share the space between the hero and the footer -----------
    footer_base = H - 48
    limit = footer_base - 52
    blocks: List[Tuple[str, float]] = []
    two_line = bool(title) and c.measure(clusters(title, c.book), "black", 70) > inner
    if title or peak is not None:
        block_h = (108.0 + (72.0 if two_line else 0.0)) if title else 0.0
        if peak is not None:
            block_h += 130.0
        blocks.append(("personality", block_h))
    if top:
        blocks.append(("senders", 48.0 + 76.0 * len(top) - 12.0))
    if blocks:
        free = limit - y - sum(h for _n, h in blocks)
        gap = max(22.0, min(74.0, free / (len(blocks) + 0.4)))
        cursor = y + gap + max(0.0, (free - gap * (len(blocks) + 0.4)) / 2)
        for name, block_h in blocks:
            if name == "personality":
                _personality(c, M, cursor, inner, title, two_line, peak, hours)
            else:
                _senders(c, M, cursor, inner, top)
            cursor += block_h + gap

    # footer ---------------------------------------------------------------------------
    c.text(W / 2, footer_base, FOOTER, "medium", 24, (255, 255, 255, 205), anchor="ms", max_width=inner, min_size=17)


def _personality(
    c: Canvas, x: float, y: float, w: float, title: str, two_line: bool, peak: Optional[int], hours: List[int]
) -> None:
    label_colour = (255, 255, 255, 205)
    if title:
        c.tracked(x, y + 24, "THIS CHAT IS", "semibold", 24, label_colour)
        lines = _split_title(title) if two_line else [title]
        size = 78.0 if two_line else 90.0
        for i, line in enumerate(lines[:2]):
            c.text(x, y + 108 + i * 72, line, "black", size, WHITE, max_width=w, min_size=40)
        y += 108 + (72 if two_line else 0)
    if peak is None:
        return
    # peak hour: a big value on the left, the shape of the day on the right
    top = y + 30
    row_h = 100.0
    c.tracked(x, top + 24, "PEAK HOUR", "semibold", 24, label_colour)
    c.text(x, top + row_h - 2, hour12(peak), "black", 66, YELLOW)
    if len(hours) == 24 and max(hours) > 0:
        chart_w = min(560.0, w - 300)
        chart_x = x + w - chart_w
        slot = chart_w / 24.0
        bar_w = slot * 0.60
        top_val = float(max(hours))
        for h, v in enumerate(hours):
            bar_h = max(bar_w, row_h * (v / top_val))
            bx = chart_x + h * slot + (slot - bar_w) / 2
            colour = YELLOW if h == peak else (255, 255, 255, 110)
            c.pill(bx, top + row_h - bar_h, bar_w, bar_h, colour)


def _senders(c: Canvas, x: float, y: float, w: float, top: List[Tuple[str, float, int]]) -> None:
    c.tracked(x, y + 24, "WHO TALKED THE MOST", "semibold", 24, (255, 255, 255, 205))
    row_h = 64.0
    pct_col = 148.0
    lead = max(s for _n, s, _m in top) or 1.0
    for i, (name, share, _messages) in enumerate(top):
        ry = y + 48 + i * 76
        c.pill(x, ry, w, row_h, (255, 255, 255, 46))
        bar_w = (w - pct_col) * (0.44 + 0.56 * (share / lead))
        c.pill(x, ry, bar_w, row_h, WHITE)
        c.circle(x + row_h / 2, ry + row_h / 2, 22, INK)
        c.text(x + row_h / 2, ry + row_h / 2 + 10.5, str(i + 1), "black", 29, WHITE, anchor="ms")
        c.text(x + row_h + 8, ry + row_h / 2 + 14.5, name, "bold", 40, INK, max_width=bar_w - row_h - 34, min_size=27)
        c.text(x + w - 26, ry + row_h / 2 + 13.5, fmt_pct(share), "black", 37, WHITE, anchor="rs")


def main(argv: Optional[Iterable[str]] = None) -> int:  # pragma: no cover - tiny manual entry point
    import json

    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2:
        print("usage: python -m wrapped.mac.card STATS.json OUT.png", file=sys.stderr)
        return 2
    with open(args[0], encoding="utf-8") as fh:
        stats = json.load(fh)
    print(render_card(stats, args[1]))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
