"""Dynamic Open Graph image generator.

Loads one of four pre-rendered base WebPs (chosen by ending + sentence
severity) and overlays the player's name and score into the two white
panels in the top-right of the artwork. The composited PNG is what
Facebook, X, Reddit and other unfurlers fetch via the share URL's
``og:image`` meta tag.
"""
from __future__ import annotations

import io
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parent / "assets"
FONT_PATH = ASSETS / "fonts" / "PressStart2P.ttf"

# Text bounding boxes inside the two white panels baked into every base image
# (see frontend/og-base-*.webp). Tighter than the visible white area on
# purpose — these are the regions the text is actually drawn into.
NAME_BOX = (1046, 300, 269, 60)   # x, y, w, h
SCORE_BOX = (1046, 520, 269, 63)
TEXT_FILL = (20, 28, 60)          # deep navy — matches the panel border
PADDING = 4                       # tiny safety margin so glyphs don't kiss the edge

# 1376×768 — native dimensions of the base artwork.
OG_WIDTH = 1376
OG_HEIGHT = 768


def pick_base(ending: str, years: int) -> Path:
    """Choose a base image by ending and sentence severity."""
    if ending == "win":
        name = "og-base-win.webp"
    elif years > 500:
        name = "og-base-crime-max.webp"
    elif years > 50:
        name = "og-base-crime-heavy.webp"
    else:
        name = "og-base-crime-light.webp"
    return Path(__file__).resolve().parent.parent.parent / "frontend" / name


@lru_cache(maxsize=8)
def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_PATH), size)


def _bbox(font: ImageFont.FreeTypeFont, text: str) -> tuple[int, int, int, int]:
    """Return (l, t, r, b) for ``text``, working on Pillow 8.4+ and 9.2+.

    Pillow 9.2 added ``font.getbbox``; 8.x only has the deprecated ``getsize``.
    cPanel still ships 8.4.0, so we feature-detect rather than require an
    upgrade in the host environment.
    """
    if hasattr(font, "getbbox"):
        return font.getbbox(text)
    w, h = font.getsize(text)  # type: ignore[attr-defined]
    return (0, 0, w, h)


def _fit_font(text: str, max_w: int, max_h: int, start: int = 56) -> ImageFont.FreeTypeFont:
    """Largest Press Start 2P size that fits ``text`` in ``max_w × max_h``."""
    for size in range(start, 7, -2):
        f = _font(size)
        l, t, r, b = _bbox(f, text)
        if (r - l) <= max_w and (b - t) <= max_h:
            return f
    return _font(8)


def _draw_centered(draw: ImageDraw.ImageDraw, text: str, box: tuple[int, int, int, int]) -> None:
    x, y, w, h = box
    inner_w = w - 2 * PADDING
    inner_h = h - 2 * PADDING
    font = _fit_font(text, inner_w, inner_h)
    l, t, r, b = _bbox(font, text)
    tw, th = r - l, b - t
    cx = x + (w - tw) // 2 - l
    cy = y + (h - th) // 2 - t
    draw.text((cx, cy), text, font=font, fill=TEXT_FILL)


def render(name: str, score: str, ending: str, years: int) -> bytes:
    """Composite name + score onto the appropriate base, return PNG bytes."""
    base_path = pick_base(ending, years)
    if not base_path.exists():
        # Dev fallback: solid placeholder so /og still returns something useful.
        im = Image.new("RGB", (OG_WIDTH, OG_HEIGHT), (40, 40, 60))
        d = ImageDraw.Draw(im)
        d.text((40, 40), f"missing: {base_path.name}", font=_font(24), fill=(255, 200, 200))
    else:
        im = Image.open(base_path).convert("RGB")
    draw = ImageDraw.Draw(im)
    _draw_centered(draw, name.upper(), NAME_BOX)
    _draw_centered(draw, score, SCORE_BOX)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
