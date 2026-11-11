"""The recap card: the image that lands in the thread.

``render_card(stats, out_path)`` draws a 1080x1350 PNG from aggregate stats and
first names only. No message text ever goes on the card.

Design notes
- Same world as the web story's share card (``web/js/card.js``): a Messages-blue
  background, the chat name as the headline, and one slightly tilted speech
  bubble per fact (white for the count, ink for the personality, green for the
  top senders, yellow for the peak hour), in the same order and colours.
- Bundled type (``assets/``, both SIL OFL 1.1): Archivo, the display face the web
  uses, plus one cut of Inter for scripts Archivo lacks (Cyrillic, Greek). The
  output therefore looks the same on every machine. Emoji come from the
  platform colour-emoji font when one exists (Apple Color Emoji on macOS, Noto
  Color Emoji on Linux) and are dropped cleanly otherwise; other scripts fall
  back to a system font.
- Everything is drawn at 2x and downsampled, so shapes are anti-aliased.
- The motifs (bubbles with tails, a tapback badge) are drawn here from
  primitives: no Apple or Spotify artwork.
"""

from __future__ import annotations

import math
import os
import random
import struct
import sys
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFilter, ImageFont, features

from . import PRODUCT_NAME
from .fmt import clean, display_names, fmt_int, fmt_pct, hour12, peak_hour

DESIGN_W, DESIGN_H = 1080, 1350
EMOJI_SCALE = 0.92  # emoji height relative to the type size
SUPERSAMPLE = 2
FOOTER_TAIL = "· made on this Mac, nothing uploaded"
FOOTER = f"{PRODUCT_NAME} {FOOTER_TAIL}"

FONT_DIR = Path(__file__).resolve().parent / "assets"
FONT_FILES = {
    "wide": "Archivo-Black-Expanded.ttf",  # headline, units
    "black": "Archivo-Black.ttf",  # numbers, names
    "cond": "Archivo-Black-Condensed.ttf",  # the same, when space is tight
    "label": "Archivo-ExtraBold-SemiExpanded.ttf",  # small caps labels
    "text": "Archivo-SemiBold.ttf",  # footer
}
BUNDLED_FALLBACK = "Inter-Display-Bold.ttf"  # Cyrillic, Greek and other Latin-adjacent scripts

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

# Palette: the web story's (web/css/base.css), i.e. the iOS system colours.
BG_TOP, BG_MID, BG_BOTTOM = "#2a9bff", "#0a7aff", "#0042d6"
BG_BUBBLE_LIGHT, BG_BUBBLE_DEEP = "#46a6ff", "#0036c2"
NUMBER_BLUE = "#0a6cff"
GREEN = "#30d158"
GREEN_INK = (3, 32, 12)
WHITE = (255, 255, 255, 255)
INK = (11, 11, 15, 255)
YELLOW = (255, 214, 10, 255)
PINK = (255, 45, 85, 255)


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
        wanted = list(FONT_FILES.values()) + [BUNDLED_FALLBACK]
        missing = [f for f in wanted if not (self.font_dir / f).is_file()]
        if missing:
            raise CardError(
                f"The bundled card font is missing ({', '.join(missing)} in {self.font_dir}). "
                "Reinstall Threadback; the package must include wrapped/mac/assets/*."
            )
        self._primary_ranges = _cmap_ranges(str(self.font_dir / FONT_FILES["black"]))
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
            # The bundled faces always use the basic layout engine, so Latin text is
            # set identically whether or not this machine has the optional shaping
            # library. Emoji and fallback scripts use shaping when it is available.
            engine = ImageFont.Layout.BASIC if path is None else self.engine
            font = ImageFont.truetype(src, max(1, px), layout_engine=engine)
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
            for path in [str(self.font_dir / BUNDLED_FALLBACK)] + list(FALLBACK_FONTS):
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
                    # Without a shaping engine a sequence cannot be fused into one
                    # glyph: show its parts, minus joiners, variation selectors and
                    # skin-tone swatches (which would otherwise appear as squares).
                    seq = "".join(
                        c for c in seq
                        if ord(c) not in (0x200D, 0xFE0F, 0x20E3) and not 0x1F3FB <= ord(c) <= 0x1F3FF
                        and not 0xE0020 <= ord(c) <= 0xE007F
                    )
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
    if not book.shaping:
        cleaned = _visual_order(cleaned)
    return cleaned


def _is_rtl(ch: str) -> bool:
    return unicodedata.bidirectional(ch) in ("R", "AL")


def _visual_order(cl: List[Cluster]) -> List[Cluster]:
    """A minimal stand-in for the bidi algorithm when no shaping engine exists:
    runs of right-to-left letters (with the spaces inside them) are reversed so
    they read correctly when drawn left to right. Arabic letters are still not
    joined in that case."""
    out: List[Cluster] = []
    i, n = 0, len(cl)
    while i < n:
        if cl[i][0] == "text" and _is_rtl(cl[i][1]):
            j = i
            last = i
            while j < n and cl[j][0] == "text" and (_is_rtl(cl[j][1]) or cl[j][1] == " "):
                if cl[j][1] != " ":
                    last = j
                j += 1
            out.extend(reversed(cl[i:last + 1]))
            i = last + 1
        else:
            out.append(cl[i])
            i += 1
    return out


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


class Canvas:
    """A drawing surface in *design units* (1080x1350); pixels are k times larger."""

    def __init__(self, width: int, height: int, k: float, book: FontBook) -> None:
        self.w, self.h, self.k, self.book = width, height, k, book
        self.img = Image.new("RGBA", (width, height), (0, 0, 0, 255))
        self._emoji_cache = {}

    def px(self, v: float) -> int:
        return int(round(v * self.k))

    # background ----------------------------------------------------------------

    def linear(self, stops: Sequence[Tuple[float, str]], x1: float, y1: float) -> None:
        """A linear gradient from the origin to (x1, y1), like a canvas gradient."""
        gw, gh = 54, 68
        colours = [(t, _rgba(col)[:3]) for t, col in stops]
        small = Image.new("RGB", (gw, gh))
        px = small.load()
        vx, vy = x1 * self.k, y1 * self.k
        norm = float(vx * vx + vy * vy) or 1.0
        for y in range(gh):
            for x in range(gw):
                fx, fy = x / (gw - 1) * self.w, y / (gh - 1) * self.h
                t = max(0.0, min(1.0, (fx * vx + fy * vy) / norm))
                for (t0, c0), (t1, c1) in zip(colours, colours[1:]):
                    if t <= t1 or (t1, c1) == colours[-1]:
                        u = 0.0 if t1 == t0 else max(0.0, min(1.0, (t - t0) / (t1 - t0)))
                        px[x, y] = tuple(int(round(c0[i] + (c1[i] - c0[i]) * u)) for i in range(3))
                        break
        self.img.paste(small.resize((self.w, self.h), Image.BICUBIC).convert("RGBA"))

    def sub(self, w: float, h: float) -> "Canvas":
        """A transparent canvas of w x h design units sharing this one's fonts."""
        layer = Canvas(max(1, self.px(w)), max(1, self.px(h)), self.k, self.book)
        layer.img = Image.new("RGBA", layer.img.size, (0, 0, 0, 0))
        layer._emoji_cache = self._emoji_cache
        return layer

    def stamp(self, layer: "Canvas", x: float, y: float, degrees: float = 0.0) -> None:
        """Composite a sub-canvas with its top-left at (x, y), tilted about its centre
        (positive = clockwise, as on an HTML canvas)."""
        img = layer.img
        cx = self.px(x) + img.width / 2.0
        cy = self.px(y) + img.height / 2.0
        if degrees:
            img = img.rotate(-degrees, resample=Image.BICUBIC, expand=True)
        self._safe_composite(img, int(round(cx - img.width / 2.0)), int(round(cy - img.height / 2.0)))

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

    def tapback(self, cx: float, cy: float, r: float, kind: str = "heart", side: str = "right",
                fill=PINK, glyph=WHITE) -> None:
        """A tapback badge: a small bubble with two trailing dots and a glyph."""
        sign = -1 if side == "left" else 1
        blur = self.px(10)
        size = self.px(2 * r) + 6 * blur
        sh = Image.new("L", (size, size), 0)
        ImageDraw.Draw(sh).ellipse((3 * blur, 3 * blur, size - 3 * blur, size - 3 * blur), fill=90)
        layer = Image.new("RGBA", (size, size), (0, 20, 80, 255))
        layer.putalpha(sh.filter(ImageFilter.GaussianBlur(blur)))
        self._safe_composite(layer, self.px(cx) - size // 2, self.px(cy) - size // 2 + self.px(6))
        self.circle(cx + sign * r * 0.80, cy + r * 0.86, r * 0.26, fill)
        self.circle(cx + sign * r * 1.22, cy + r * 1.28, r * 0.12, fill)
        self.circle(cx, cy, r, fill)
        if kind == "heart":
            self.heart(cx, cy, r * 1.12, glyph)
        elif kind == "haha":
            self.text(cx, cy - r * 0.02, "HA", "black", r * 0.56, glyph, anchor="ms")
            self.text(cx, cy + r * 0.48, "HA", "black", r * 0.56, glyph, anchor="ms")
        else:
            self.text(cx, cy + r * 0.42, "!!" if kind == "bang" else "?", "black", r * 1.18, glyph, anchor="ms")

    # text ------------------------------------------------------------------------

    def _emoji_image(self, seq: str, px: int) -> Optional[Image.Image]:
        """The emoji run as an image whose height is ``px`` pixels."""
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
                scale = px / float(max(glyph.height, strike * 0.8))
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
                img = self._emoji_image(text, int(px * EMOJI_SCALE))
                total += (img.width if img else 0) + px * 0.08
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

    def fit_roles(
        self, text: str, roles: Sequence[str], size: float, max_width: float, min_size: float
    ) -> Tuple[List[Cluster], str, float]:
        """Widest cut that fits at full size; otherwise the narrowest cut, shrunk
        (and as a last resort truncated) to fit. Returns (clusters, role, size)."""
        cl = clusters(text, self.book)
        for role in roles:
            if self.measure(cl, role, size) <= max_width:
                return cl, role, size
        role = roles[-1]
        width = self.measure(cl, role, size) or 1.0
        shrunk = float(max(min_size, math.floor(size * max_width / width)))
        cl, shrunk = self.fit(text, role, shrunk, max_width, shrunk)
        return cl, role, shrunk

    def wrap(self, cl: Sequence[Cluster], role: str, size: float, width: float) -> List[List[Cluster]]:
        """Greedy word wrap of clusters; a word wider than the line is broken."""
        words: List[List[Cluster]] = [[]]
        for c in cl:
            if c[0] == "text" and c[1] == " ":
                if words[-1]:
                    words.append([])
            else:
                words[-1].append(c)
        space: Cluster = ("text", " ", None)
        lines: List[List[Cluster]] = []
        line: List[Cluster] = []
        for word in (w for w in words if w):
            candidate = line + [space] + word if line else list(word)
            if self.measure(candidate, role, size) <= width:
                line = candidate
                continue
            if line:
                lines.append(line)
            line = list(word)
            while len(line) > 1 and self.measure(line, role, size) > width:
                cut = len(line) - 1
                while cut > 1 and self.measure(line[:cut], role, size) > width:
                    cut -= 1
                lines.append(line[:cut])
                line = line[cut:]
        if line:
            lines.append(line)
        return lines

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
                img = self._emoji_image(run, int(px * EMOJI_SCALE))
                if img is not None:
                    top = base - int(px * 0.35) - img.height // 2
                    self._safe_composite(img, int(round(cursor + px * 0.04)), top)
                    cursor += img.width + px * 0.08
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
        text = "".join(ch for ch in text if ch == " " or self.book.in_primary(ord(ch)))
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
    c.linear(((0.0, BG_TOP), (0.4, BG_MID), (1.0, BG_BOTTOM)), W * 0.55, H)
    c.grain(3)
    c.bubble(60, H / 2 - 92, 600, 156, 56, WHITE, tail="left", shadow=0.25)
    c.text(360, H / 2 - 12, f"{PRODUCT_NAME} test image", "black", 44, NUMBER_BLUE, anchor="ms", max_width=540)
    c.text(360, H / 2 + 34, "If you can see this, attachments work.", "text", 24, INK, anchor="ms", max_width=540)
    c.tapback(652, H / 2 - 90, 30, "heart", side="right")
    final = c.img.convert("RGB").resize((width, height), Image.LANCZOS)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    final.save(out, format="PNG", compress_level=6)
    return out


@lru_cache(maxsize=4)
def _book(emoji: Optional[bool]) -> FontBook:
    return FontBook(emoji=emoji)


PAD = 72.0
MARGIN = 70.0  # room around a tilted block for its tail, shadow and rotation
PERSONA_EMOJI = {
    "quiet_ones": "🤫", "night_owls": "🦉", "weekend_warriors": "🎉", "always_on": "🔋", "early_birds": "🐦",
    "morning_meeting": "☕", "lunch_break": "🥪", "afternoon_slackers": "😎", "dinner_table": "🍽️",
    "after_hours": "🌙",
}


def _tilted(c: Canvas, x: float, y: float, w: float, h: float, degrees: float, draw) -> None:
    """Draw a block on its own layer (origin at the block's top-left) and stamp it tilted."""
    layer = c.sub(w + 2 * MARGIN, h + 2 * MARGIN)
    draw(layer, MARGIN, MARGIN)
    c.stamp(layer, x - MARGIN, y - MARGIN, degrees)


def _fit_title(c: Canvas, text: str, width: float) -> Tuple[float, str, List[List[Cluster]]]:
    """The chat name: one line if it can stay big, otherwise the biggest two-line setting."""
    cl = clusters(text, c.book)
    if not cl:
        cl = clusters("Group chat", c.book)
    for size in range(116, 87, -4):
        for role in ("wide", "black", "cond"):
            if c.measure(cl, role, size) <= width:
                return float(size), role, [cl]
    for size in range(108, 55, -6):
        for role in ("wide", "black", "cond"):
            lines = c.wrap(cl, role, size, width)
            if len(lines) <= 2:
                return float(size), role, lines
    lines = c.wrap(cl, "cond", 56, width)
    rest: List[Cluster] = []
    for line in lines[1:]:
        rest += ([("text", " ", None)] if rest else []) + line
    ell: List[Cluster] = [("text", "…", None)]
    while rest and c.measure(rest + ell, "cond", 56) > width:
        rest = rest[:-1]
        while rest and rest[-1][1] == " ":
            rest = rest[:-1]
    return 56.0, "cond", [lines[0], rest + ell]


def _paint(c: Canvas, stats: dict, W: float, H: float) -> None:
    chat = stats.get("chat") or {}
    period = stats.get("period") or {}
    totals = stats.get("totals") or {}
    personality = stats.get("personality") or {}

    chat_name = clean(chat.get("name")) or "Group chat"
    label = clean(period.get("label"), 18)
    messages = max(0, _int(totals.get("messages")))
    title = clean(personality.get("title"), 48)
    persona_id = str(personality.get("id") or "")
    peak = peak_hour(stats)
    top = _top_senders(stats)
    inner = W - 2 * PAD

    # background: the story cover's blue world with two oversized bubbles ------------------
    c.linear(((0.0, BG_TOP), (0.4, BG_MID), (1.0, BG_BOTTOM)), W * 0.55, H)
    _tilted(c, W - 520, -210, 760, 520, 14,
            lambda s, x, y: s.bubble(x, y, 760, 520, 170, BG_BUBBLE_LIGHT, tail="right"))
    _tilted(c, -330, H - 340, 820, 600, -10,
            lambda s, x, y: s.bubble(x, y, 820, 600, 180, BG_BUBBLE_DEEP, tail="left"))
    c.grain(3)

    # header: the period in a pill, then the chat name ------------------------------------
    y = 78.0
    pill_text = (f"{label} in review" if label else "In review").upper()
    probe = c.sub(10, 10)
    text_w = probe.tracked(0, 0, pill_text, "label", 26, WHITE, tracking=0.115)
    pill_w = min(inner, text_w + 56)
    c.pill(PAD, y, pill_w, 58, (255, 255, 255, 51))
    c.tracked(PAD + 28, y + 39, pill_text, "label", 26, WHITE, tracking=0.115)
    y += 58 + 34

    size, role, lines = _fit_title(c, chat_name, inner)
    for i, line in enumerate(lines):
        c.text(PAD - 4, y + size * 0.8 + i * size * 0.94, line, role, size, WHITE)
    y += size * 0.94 * len(lines) + 10

    # blocks ---------------------------------------------------------------------------------
    blocks: List[Tuple[float, object]] = []

    count = fmt_int(messages)
    unit = "message" if messages == 1 else "messages"

    def total_block(top_y: float) -> None:
        ncl, nrole, nsize = c.fit_roles(count, ("black", "cond"), 218, 780, 90)
        num_w = c.measure(ncl, nrole, nsize)
        unit_w = c.measure(clusters(unit, c.book), "wide", 50)
        w = max(num_w, unit_w) + 108

        def draw(s: Canvas, x: float, y0: float) -> None:
            s.bubble(x, y0, w, 306, 76, WHITE, tail="left", shadow=0.22)
            s.text(x + 50, y0 + 192, ncl, nrole, nsize, NUMBER_BLUE)
            s.text(x + 54, y0 + 280, unit, "wide", 50, INK)
            s.tapback(x + w - 14, y0 + 8, 40, "heart", side="right")

        _tilted(c, PAD, top_y, w, 306, -2, draw)

    blocks.append((306.0, total_block))

    if title:
        emoji = PERSONA_EMOJI.get(persona_id, "💬")
        emoji_cl = clusters(emoji, c.book)
        has_emoji = bool(emoji_cl) and emoji_cl[0][0] == "emoji"
        text_x = 148.0 if has_emoji else 52.0

        def persona_block(top_y: float) -> None:
            tcl, trole, tsize = c.fit_roles(title, ("black", "cond"), 62, 640, 34)
            text_w = c.measure(tcl, trole, tsize)
            w = max(text_w, 250.0) + text_x + 52
            x0 = W - PAD - w

            def draw(s: Canvas, x: float, y0: float) -> None:
                s.bubble(x, y0, w, 178, 64, INK, tail="right", shadow=0.22)
                if has_emoji:
                    s.text(x + 36, y0 + 92 + 96 * 0.35, emoji_cl, "black", 96, WHITE)
                s.tracked(x + text_x + 2, y0 + 62, "PERSONALITY", "label", 25, YELLOW, tracking=0.12)
                s.text(x + text_x, y0 + 62 + 20 + tsize * 0.74, tcl, trole, tsize, WHITE)

            _tilted(c, x0, top_y, w, 178, 2, draw)

        blocks.append((178.0, persona_block))

    has_peak = peak is not None
    if top or has_peak:
        row_h = 58.0
        senders_h = (104 + len(top) * row_h + 30) if top else 0.0
        block_h = max(senders_h, 214.0)

        def facts_block(top_y: float) -> None:
            bottom = top_y + block_h
            left_w = 574.0 if has_peak else inner
            if top:
                sy = bottom - senders_h

                def draw_senders(s: Canvas, x: float, y0: float) -> None:
                    s.bubble(x, y0, left_w, senders_h, 64, GREEN, tail="left", shadow=0.22)
                    s.tracked(x + 44, y0 + 66, "TOP SENDERS" if len(top) > 1 else "TOP SENDER", "label", 25,
                              GREEN_INK + (158,), tracking=0.12)
                    for i, (name, share, _messages) in enumerate(top):
                        ry = y0 + 104 + i * row_h + 36
                        s.text(x + 44, ry, str(i + 1), "black", 40, GREEN_INK + (128,))
                        pct = fmt_pct(share)
                        pct_w = s.measure(clusters(pct, s.book), "black", 34)
                        s.text(x + left_w - 44, ry, pct, "black", 34, GREEN_INK, anchor="rs")
                        name_w = left_w - 44 - 52 - 44 - pct_w - 24
                        ncl, nrole, nsize = s.fit_roles(name, ("black", "cond"), 44, name_w, 36)
                        s.text(x + 96, ry, ncl, nrole, nsize, GREEN_INK)

                _tilted(c, PAD, sy, left_w, senders_h, -1.5, draw_senders)
            if has_peak:
                pw = (inner - left_w - 30) if top else 380.0
                px0 = W - PAD - pw
                ph = 214.0
                py0 = bottom - ph - (18 if top else 0)

                def draw_peak(s: Canvas, x: float, y0: float) -> None:
                    s.bubble(x, y0, pw, ph, 64, YELLOW, tail="right", shadow=0.22)
                    s.tracked(x + 40, y0 + 66, "PEAK HOUR", "label", 25, (11, 11, 15, 153), tracking=0.12)
                    hcl, hrole, hsize = s.fit_roles(hour12(peak), ("black", "cond"), 112, pw - 80, 60)
                    s.text(x + 38, y0 + 66 + 24 + hsize * 0.74, hcl, hrole, hsize, INK)

                _tilted(c, px0, py0, pw, ph, 3, draw_peak)

        blocks.append((block_h, facts_block))

    # distribute the blocks between the title and the footer (as the web card does) ---------------
    footer_top = H - 104
    used = sum(h for h, _f in blocks)
    space = footer_top - y - used
    n = len(blocks)
    gap = max(18.0, min(64.0, space / (n + 0.5)))
    cursor = y + max(0.0, (space - gap * (n - 1)) / 2)
    cursor = min(cursor, y + 70)
    if space - gap * (n - 1) > 140:
        gap = min(84.0, (footer_top - cursor - used - 20) / max(1, n - 1))
    for h, draw_block in blocks:
        draw_block(cursor)  # type: ignore[operator]
        cursor += h + gap

    # footer ------------------------------------------------------------------------------------
    name_w, _ = c.text(PAD, H - 56, PRODUCT_NAME, "label", 30, WHITE)
    c.text(PAD + name_w + 14, H - 56, FOOTER_TAIL, "text", 26, (255, 255, 255, 199),
           max_width=inner - name_w - 14, min_size=18)


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
