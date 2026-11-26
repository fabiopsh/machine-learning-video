#!/usr/bin/env python3
"""Build static GitHub Pages bundle from videolezioni/.

Generates:
- Clean per-chapter URLs (<lesson-id>/index.html) with dedicated Open Graph & Twitter meta tags
- High-contrast 1200x630 PNG preview covers (og/home.png and og/<lesson-id>.png)
- Optional parallel WAV -> MP3 audio transcoding via ffmpeg (updates built lesson.json paths)
- Styled 404.html with smart path recovery, favicon.svg, sitemap.xml, robots.txt, and .nojekyll
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import html
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any
from urllib.parse import urlparse

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:  # pragma: no cover
    Image = None
    ImageDraw = None
    ImageFilter = None
    ImageFont = None


SCRIPT_DIR = Path(__file__).resolve().parent
VIDEOLEZIONI_DIR = SCRIPT_DIR.parent
DEFAULT_BASE_URL = "https://fabiopsh.github.io/machine-learning-video/"

OG_WIDTH = 1200
OG_HEIGHT = 630

PART_ACCENTS: dict[str, tuple[str, str]] = {
    "frontmatter": ("#1D4ED8", "#15803D"),
    "parte-1": ("#1D4ED8", "#0F766E"),
    "parte-2": ("#1D4ED8", "#C82829"),
    "parte-3": ("#B45309", "#C82829"),
    "parte-4": ("#C82829", "#1D4ED8"),
    "parte-5": ("#15803D", "#1D4ED8"),
    "parte-6": ("#6D28D9", "#1D4ED8"),
}


def normalize_base_url(raw: str) -> str:
    url = raw.strip()
    if not url.endswith("/"):
        url += "/"
    return url


def format_hours(total_min: int) -> str:
    if not total_min:
        return "0 min"
    h = total_min // 60
    m = total_min % 60
    return f"{h}h {m:02d}m" if h > 0 else f"{m} min"


def hex_to_rgba(color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    c = color.lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), alpha)


def find_font(bold: bool = False) -> str | None:
    if bold:
        candidates = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
            "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
            "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf",
            "C:/Windows/Fonts/segoeuib.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
            "C:/Windows/Fonts/calibrib.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        ]
    else:
        candidates = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
            "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf",
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arial.ttf",
            "C:/Windows/Fonts/calibri.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
        ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def load_font(size: int, bold: bool = False) -> Any:
    path = find_font(bold=bold)
    if path:
        return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def wrap_text(draw: Any, text: str, font: Any, max_width: int, max_lines: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if bbox[2] - bbox[0] <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
            if len(lines) == max_lines:
                break
    if len(lines) < max_lines:
        lines.append(current)
    elif len(lines) == max_lines and current:
        # Check if we dropped remaining words
        reconstructed = " ".join(lines)
        if reconstructed != text:
            last = lines[-1]
            while last and draw.textbbox((0, 0), last + "…", font=font)[2] > max_width:
                last = last.rsplit(" ", 1)[0] if " " in last else last[:-1]
            lines[-1] = (last.rstrip(".,;: ") + "…") if last else "…"
    return lines


def draw_pill(
    draw: Any,
    x: int,
    y: int,
    text: str,
    font: Any,
    fill: tuple[int, int, int, int],
    outline: tuple[int, int, int, int],
    text_color: tuple[int, int, int, int],
    pad_x: int = 18,
    pad_y: int = 9,
) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    w = tw + pad_x * 2
    h = th + pad_y * 2
    draw.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=fill, outline=outline, width=2)
    draw.text((x + pad_x, y + pad_y - bbox[1]), text, font=font, fill=text_color)
    return x + w


def blend_hex(fg: str, bg: str, ratio: float) -> tuple[int, int, int, int]:
    fr, fg_c, fb, _ = hex_to_rgba(fg)
    br, bg_c, bb, _ = hex_to_rgba(bg)
    return (
        int(fr * ratio + br * (1.0 - ratio)),
        int(fg_c * ratio + bg_c * (1.0 - ratio)),
        int(fb * ratio + bb * (1.0 - ratio)),
        255,
    )


def load_lia_frame(frame_idx: int = 5, size: int = 240) -> Any | None:
    """Load a crisp pixel-art frame of Lia from assets/lia-spritesheet.png."""
    sheet_path = VIDEOLEZIONI_DIR / "assets" / "lia-spritesheet.png"
    if not sheet_path.is_file():
        return None
    sheet = Image.open(sheet_path).convert("RGBA")
    fw = sheet.width // 6
    idx = max(0, min(5, frame_idx))
    frame = sheet.crop((idx * fw, 0, (idx + 1) * fw, sheet.height))
    return frame.resize((size, size), Image.NEAREST)


def load_circle_photo(filename: str, size: int = 48, border_color: str = "#CECEC7") -> Any | None:
    """Load a circular portrait from videolezioni/assets/ with crisp border."""
    p = VIDEOLEZIONI_DIR / "assets" / filename
    if not p.is_file():
        return None
    im = Image.open(p).convert("RGBA").resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([1, 1, size - 2, size - 2], fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    ImageDraw.Draw(out, "RGBA").ellipse([1, 1, size - 2, size - 2], outline=hex_to_rgba(border_color, 255), width=2)
    return out


def _draw_dashed_line(d: Any, p1: tuple[float, float], p2: tuple[float, float], fill: Any, width: int = 4, dash: int = 16, gap: int = 12) -> None:
    x1, y1 = p1
    x2, y2 = p2
    dist = math.hypot(x2 - x1, y2 - y1)
    if dist < 1:
        return
    ux, uy = (x2 - x1) / dist, (y2 - y1) / dist
    cur = 0.0
    while cur < dist:
        nxt = min(dist, cur + dash)
        d.line([(x1 + ux * cur, y1 + uy * cur), (x1 + ux * nxt, y1 + uy * nxt)], fill=fill, width=width)
        cur = nxt + gap


def _draw_arrow(d: Any, p1: tuple[float, float], p2: tuple[float, float], fill: Any, width: int = 5, head: int = 18) -> None:
    x1, y1 = p1
    x2, y2 = p2
    d.line([(x1, y1), (x2, y2)], fill=fill, width=width)
    ang = math.atan2(y2 - y1, x2 - x1)
    a1 = ang + math.pi * 0.82
    a2 = ang - math.pi * 0.82
    pts = [
        (x2, y2),
        (x2 + head * math.cos(a1), y2 + head * math.sin(a1)),
        (x2 + head * math.cos(a2), y2 + head * math.sin(a2)),
    ]
    d.polygon(pts, fill=fill)


def _draw_axes(d: Any, ox: int, oy: int, w: int, h: int, ink: Any) -> None:
    _draw_arrow(d, (ox, oy), (ox + w, oy), ink, width=4, head=14)
    _draw_arrow(d, (ox, oy), (ox, oy - h), ink, width=4, head=14)


def draw_chapter_visual(chapter: int, width: int = 380, height: int = 350) -> Any:
    """Render a crisp 2x-supersampled topic-specific ML visual diagram for chapter 0..19."""
    S = 2
    W, H = width * S, height * S
    canvas = Image.new("RGBA", (W, H), hex_to_rgba("#FAFAF7", 255))
    d = ImageDraw.Draw(canvas, "RGBA")

    # Subtle architectural graph-paper grid
    grid_c = hex_to_rgba("#E8E8E1", 170)
    for gx in range(44, W, 44):
        d.line([(gx, 16), (gx, H - 16)], fill=grid_c, width=2)
    for gy in range(44, H, 44):
        d.line([(16, gy), (W - 16, gy)], fill=grid_c, width=2)

    INK = hex_to_rgba("#141413", 255)
    SOFT = hex_to_rgba("#57564F", 220)
    MUTED = hex_to_rgba("#9A9990", 210)
    BLUE = hex_to_rgba("#1D4ED8", 255)
    BLUE_S = blend_hex("#1D4ED8", "#FAFAF7", 0.13)
    RED = hex_to_rgba("#C82829", 255)
    RED_S = blend_hex("#C82829", "#FAFAF7", 0.13)
    GREEN = hex_to_rgba("#15803D", 255)
    GREEN_S = blend_hex("#15803D", "#FAFAF7", 0.14)
    AMBER = hex_to_rgba("#D97706", 255)
    AMBER_S = blend_hex("#D97706", "#FAFAF7", 0.15)
    PURPLE = hex_to_rgba("#6D28D9", 255)
    PURPLE_S = blend_hex("#6D28D9", "#FAFAF7", 0.15)
    WHITE = hex_to_rgba("#FFFFFF", 255)

    f_lbl = load_font(28, bold=True)
    f_sm = load_font(22, bold=False)

    if chapter == 0:
        # 6-Part Course Roadmap
        pts = [(110, 520), (210, 390), (340, 440), (455, 290), (575, 330), (660, 175)]
        d.line(pts, fill=BLUE, width=7)
        cols = [BLUE, GREEN, AMBER, RED, PURPLE, BLUE]
        for i, (px, py) in enumerate(pts):
            d.ellipse([px - 34, py - 34, px + 34, py + 34], fill=WHITE, outline=cols[i], width=6)
            lbl = f"P{i + 1}"
            bb = d.textbbox((0, 0), lbl, font=f_lbl)
            d.text((px - (bb[2] - bb[0]) // 2, py - (bb[3] - bb[1]) // 2 - bb[1]), lbl, font=f_lbl, fill=cols[i])
        d.text((76, 84), "Mappa del percorso", font=f_lbl, fill=INK)

    elif chapter == 1:
        # Gradient & elliptical contour lines
        cx, cy = 410, 355
        for rx, ry in [(260, 175), (195, 130), (130, 86), (65, 43)]:
            d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], outline=BLUE, width=4)
        d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=GREEN)
        # Gradient arrow pointing outward orthogonal to contour
        p1 = (cx - 155, cy - 102)
        p2 = (cx - 255, cy - 200)
        _draw_arrow(d, p1, p2, RED, width=7, head=22)
        d.ellipse([p1[0] - 10, p1[1] - 10, p1[0] + 10, p1[1] + 10], fill=INK)
        d.text((p2[0] - 20, p2[1] - 48), "∇f(x)", font=f_lbl, fill=RED)
        d.text((cx + 22, cy - 14), "min", font=f_sm, fill=GREEN)

    elif chapter == 2:
        # ML Pipeline: X -> h(x) -> y with loss feedback
        boxes = [(70, 260, 225, 410, "X", MUTED, WHITE), (295, 240, 465, 430, "h(x)", BLUE, BLUE_S), (535, 260, 690, 410, "y", GREEN, GREEN_S)]
        for x0, y0, x1, y1, txt, col, bg in boxes:
            d.rounded_rectangle([x0, y0, x1, y1], radius=24, fill=bg, outline=col, width=6)
            bb = d.textbbox((0, 0), txt, font=load_font(42, bold=True))
            d.text(((x0 + x1 - (bb[2] - bb[0])) // 2, (y0 + y1 - (bb[3] - bb[1])) // 2 - bb[1]), txt, font=load_font(42, bold=True), fill=INK)
        _draw_arrow(d, (232, 335), (288, 335), INK, width=6, head=18)
        _draw_arrow(d, (472, 335), (528, 335), INK, width=6, head=18)
        # Loss feedback arc
        d.line([(612, 420), (612, 520), (380, 520)], fill=AMBER, width=6)
        _draw_arrow(d, (380, 520), (380, 438), AMBER, width=6, head=18)
        d.text((435, 536), "Loss L(y, d)", font=f_sm, fill=AMBER)

    elif chapter == 3:
        # Hypothesis Space H, Version Space VS, target h*
        d.ellipse([75, 110, 685, 575], fill=BLUE_S, outline=BLUE, width=5)
        d.ellipse([240, 215, 610, 485], fill=AMBER_S, outline=AMBER, width=5)
        d.ellipse([435, 315, 463, 343], fill=RED, outline=WHITE, width=3)
        d.text((135, 160), "Spazio ipotesi H", font=f_lbl, fill=BLUE)
        d.text((285, 245), "Version Space", font=f_sm, fill=AMBER)
        d.text((476, 312), "h*", font=f_lbl, fill=RED)

    elif chapter == 4:
        # Linear Regression with vertical residuals
        _draw_axes(d, 90, 585, 590, 490, SOFT)
        pts = [(145, 485), (225, 415), (305, 435), (390, 325), (470, 345), (555, 225), (625, 250)]
        # Line y = 525 - 0.56*(x - 110)
        p_a = (115, 522)
        p_b = (660, 216)
        for px, py in pts:
            ly = 522 - (522 - 216) * (px - 115) / (660 - 115)
            d.line([(px, py), (px, ly)], fill=GREEN, width=5)
        d.line([p_a, p_b], fill=RED, width=7)
        for px, py in pts:
            d.ellipse([px - 11, py - 11, px + 11, py + 11], fill=BLUE, outline=WHITE, width=3)
        d.text((465, 145), "y = wᵀx + b", font=f_lbl, fill=RED)

    elif chapter == 5:
        # Under/Optimal vs Overfitting polynomial
        _draw_axes(d, 90, 585, 590, 490, SOFT)
        # Smooth true curve (green)
        g_pts = [(120 + i * 18, 370 - int(110 * math.sin(i * 0.14))) for i in range(31)]
        d.line(g_pts, fill=GREEN, width=7)
        # Wiggly overfit curve (red)
        r_pts = [(120 + i * 18, 370 - int(110 * math.sin(i * 0.14) + 58 * math.sin(i * 1.15))) for i in range(31)]
        d.line(r_pts, fill=RED, width=5)
        for i in range(2, 30, 4):
            px, py = r_pts[i]
            d.ellipse([px - 10, py - 10, px + 10, py + 10], fill=BLUE, outline=WHITE, width=3)
        d.text((455, 110), "Overfitting", font=f_sm, fill=RED)
        d.text((130, 120), "Modello ottimo", font=f_sm, fill=GREEN)

    elif chapter == 6:
        # k-NN query point & neighborhood circle
        qx, qy = 380, 345
        d.ellipse([qx - 155, qy - 155, qx + 155, qy + 155], fill=BLUE_S, outline=BLUE, width=5)
        reds = [(315, 290), (425, 265), (345, 425), (210, 210), (175, 420)]
        blues = [(455, 375), (335, 345), (565, 225), (585, 460), (480, 535)]
        for px, py in reds:
            d.ellipse([px - 14, py - 14, px + 14, py + 14], fill=RED, outline=WHITE, width=3)
        for px, py in blues:
            d.ellipse([px - 14, py - 14, px + 14, py + 14], fill=BLUE, outline=WHITE, width=3)
        # Query star/dot
        d.ellipse([qx - 15, qy - 15, qx + 15, qy + 15], fill=INK, outline=AMBER, width=5)
        d.text((qx + 18, qy - 46), "x_q (k=5)", font=f_lbl, fill=INK)

    elif chapter == 7:
        # Structural Risk Minimization (VC complexity U-curve)
        _draw_axes(d, 90, 585, 590, 490, SOFT)
        emp = [(120 + i * 18, int(200 + 330 * (1 - math.exp(-i * 0.14)))) for i in range(31)]
        pen = [(120 + i * 18, int(555 - 320 * (i / 30.0) ** 2.2)) for i in range(31)]
        tot = [(120 + i * 18, int(195 + 220 * (1 - math.exp(-i * 0.18)) - 220 * (i / 30.0) ** 2.4 + 45)) for i in range(31)]
        # Recompute clean U-shape for total risk
        tot = [(120 + i * 18, int(230 + 230 * (1 - ((i - 14) / 14.5) ** 2) * (-0.55) + 125)) for i in range(31)]
        d.line(emp, fill=BLUE, width=6)
        d.line(pen, fill=RED, width=6)
        d.line(tot, fill=AMBER, width=8)
        mx, my = tot[14]
        d.ellipse([mx - 14, my - 14, mx + 14, my + 14], fill=GREEN, outline=WHITE, width=4)
        d.text((485, 480), "R_emp", font=f_sm, fill=BLUE)
        d.text((495, 185), "VC bound", font=f_sm, fill=RED)
        d.text((mx - 42, my - 56), "h* ottimo", font=f_sm, fill=GREEN)

    elif chapter == 8:
        # Bias-Variance 2 targets
        for idx, (cx, label, pts) in enumerate([
            (215, "Basso Bias · Bassa Var", [(206, 330), (222, 342), (212, 352), (226, 326), (204, 346)]),
            (545, "Alto Bias · Alta Var", [(595, 255), (625, 290), (575, 305), (635, 240), (605, 275)]),
        ]):
            cy = 340
            for r, col in [(138, BLUE_S), (92, WHITE), (46, RED_S)]:
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col, outline=SOFT, width=3)
            d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=RED)
            for px, py in pts:
                d.ellipse([px - 9, py - 9, px + 9, py + 9], fill=BLUE, outline=WHITE, width=2)
            bb = d.textbbox((0, 0), label, font=f_sm)
            d.text((cx - (bb[2] - bb[0]) // 2, 512), label, font=f_sm, fill=INK)

    elif chapter == 9:
        # ROC curve + AUC fill
        _draw_axes(d, 100, 575, 560, 470, SOFT)
        _draw_dashed_line(d, (100, 575), (620, 135), MUTED, width=4)
        roc = [(100, 575)]
        for i in range(1, 31):
            t = i / 30.0
            px = int(100 + t * 520)
            py = int(575 - (1 - (1 - t) ** 4.2) * 440)
            roc.append((px, py))
        poly = roc + [(620, 575)]
        d.polygon(poly, fill=RED_S)
        d.line(roc, fill=RED, width=8)
        d.text((310, 385), "AUC", font=load_font(44, bold=True), fill=RED)
        d.text((130, 100), "TPR", font=f_sm, fill=SOFT)
        d.text((575, 592), "FPR", font=f_sm, fill=SOFT)

    elif chapter == 10:
        # Single Perceptron / Artificial Neuron
        inputs = [(115, 200), (115, 345), (115, 490)]
        cx, cy = 395, 345
        for idx, (ix, iy) in enumerate(inputs):
            d.line([(ix + 26, iy), (cx - 64, cy)], fill=BLUE, width=5)
            d.ellipse([ix - 26, iy - 26, ix + 26, iy + 26], fill=WHITE, outline=INK, width=5)
            d.text((ix - 12, iy - 14), f"x{idx + 1}", font=f_sm, fill=INK)
        d.ellipse([cx - 64, cy - 64, cx + 64, cy + 64], fill=BLUE_S, outline=BLUE, width=6)
        d.text((cx - 18, cy - 22), "Σ", font=load_font(44, bold=True), fill=BLUE)
        _draw_arrow(d, (cx + 68, cy), (645, cy), AMBER, width=7, head=20)
        d.text((535, cy - 52), "f(net)", font=f_lbl, fill=AMBER)

    elif chapter == 11:
        # MLP + Backprop feedback arrow
        layers = [
            [(145, 210), (145, 340), (145, 470)],
            [(380, 155), (380, 275), (380, 395), (380, 515)],
            [(615, 265), (615, 415)],
        ]
        for l_idx in range(len(layers) - 1):
            for p1 in layers[l_idx]:
                for p2 in layers[l_idx + 1]:
                    d.line([p1, p2], fill=hex_to_rgba("#1D4ED8", 110), width=4)
        for l_idx, pts in enumerate(layers):
            col = SOFT if l_idx == 0 else (BLUE if l_idx == 1 else AMBER)
            bg = WHITE if l_idx == 0 else (BLUE_S if l_idx == 1 else AMBER_S)
            for px, py in pts:
                d.ellipse([px - 24, py - 24, px + 24, py + 24], fill=bg, outline=col, width=5)
        _draw_arrow(d, (595, 585), (175, 585), RED, width=7, head=20)
        d.text((285, 600), "Backpropagation δ", font=f_sm, fill=RED)

    elif chapter == 12:
        # Gradient descent trajectory into loss valley
        curve = [(90 + i * 20, int(190 + 310 * math.exp(-((i - 16) / 8.5) ** 2) + 45 * math.sin(i * 0.38))) for i in range(30)]
        d.line(curve, fill=INK, width=6)
        hops = [curve[4], curve[7], curve[10], curve[13], curve[16]]
        d.line(hops, fill=RED, width=6)
        for i, (px, py) in enumerate(hops):
            col = GREEN if i == len(hops) - 1 else RED
            d.ellipse([px - 12, py - 12, px + 12, py + 12], fill=col, outline=WHITE, width=3)
        d.text((hops[-1][0] - 42, hops[-1][1] + 24), "w* min", font=f_lbl, fill=GREEN)

    elif chapter == 13:
        # SVM Maximum-Margin Hyperplane + Support Vectors
        d.line([(135, 560), (625, 145)], fill=BLUE, width=8)
        _draw_dashed_line(d, (80, 480), (545, 85), MUTED, width=4)
        _draw_dashed_line(d, (190, 640), (680, 225), MUTED, width=4)
        blues = [(175, 225), (265, 195), (225, 315), (345, 255)]
        reds = [(515, 425), (465, 515), (595, 465), (415, 445)]
        svs = [(225, 315), (345, 255), (415, 445)]
        for px, py in blues:
            d.ellipse([px - 14, py - 14, px + 14, py + 14], fill=BLUE, outline=WHITE, width=3)
        for px, py in reds:
            d.ellipse([px - 14, py - 14, px + 14, py + 14], fill=RED, outline=WHITE, width=3)
        for sx, sy in svs:
            d.ellipse([sx - 26, sy - 26, sx + 26, sy + 26], outline=AMBER, width=5)
        d.text((310, 92), "Margine max", font=f_sm, fill=BLUE)

    elif chapter == 14:
        # CNN 2D grid + 3x3 kernel -> feature map
        cell = 52
        ox, oy = 85, 175
        for r in range(6):
            for c in range(6):
                fill = BLUE_S if (1 <= r <= 3 and 1 <= c <= 3) else WHITE
                col = BLUE if (1 <= r <= 3 and 1 <= c <= 3) else MUTED
                d.rectangle([ox + c * cell, oy + r * cell, ox + (c + 1) * cell, oy + (r + 1) * cell], fill=fill, outline=col, width=3)
        d.rectangle([ox + cell, oy + cell, ox + 4 * cell, oy + 4 * cell], outline=BLUE, width=7)
        # Projection lines
        fx, fy = 515, 250
        d.line([(ox + 4 * cell, oy + cell), (fx, fy)], fill=AMBER, width=4)
        d.line([(ox + 4 * cell, oy + 4 * cell), (fx, fy + 64)], fill=AMBER, width=4)
        for r in range(3):
            for c in range(3):
                fill = AMBER_S if (r == 0 and c == 0) else WHITE
                col = AMBER if (r == 0 and c == 0) else SOFT
                d.rectangle([fx + c * 58, fy + r * 58, fx + (c + 1) * 58, fy + (r + 1) * 58], fill=fill, outline=col, width=4)
        d.text((135, 515), "Kernel 3×3", font=f_sm, fill=BLUE)
        d.text((510, 455), "Feature map", font=f_sm, fill=AMBER)

    elif chapter == 15:
        # Deep Residual Block with Skip Connection
        bx0, bx1 = 235, 515
        for y0, lbl, bg, col in [(155, "Layer Conv / Linear", BLUE_S, BLUE), (315, "ReLU + Norm", GREEN_S, GREEN), (475, "Layer Conv / Linear", BLUE_S, BLUE)]:
            d.rounded_rectangle([bx0, y0, bx1, y0 + 95], radius=18, fill=bg, outline=col, width=5)
            bb = d.textbbox((0, 0), lbl, font=f_sm)
            d.text(((bx0 + bx1 - (bb[2] - bb[0])) // 2, y0 + 30), lbl, font=f_sm, fill=INK)
        _draw_arrow(d, (375, 250), (375, 312), INK, width=5, head=14)
        _draw_arrow(d, (375, 410), (375, 472), INK, width=5, head=14)
        # Skip connection arc on the right
        d.line([(375, 110), (375, 152)], fill=INK, width=5)
        d.line([(375, 118), (615, 118), (615, 610)], fill=AMBER, width=7)
        _draw_arrow(d, (615, 610), (415, 610), AMBER, width=7, head=18)
        d.ellipse([348, 583, 402, 637], fill=AMBER_S, outline=AMBER, width=5)
        d.text((366, 592), "+", font=f_lbl, fill=AMBER)
        d.text((530, 82), "Skip + x", font=f_sm, fill=AMBER)

    elif chapter == 16:
        # Reservoir Computing (sparse recurrent cloud -> linear readout)
        d.ellipse([95, 165, 465, 520], fill=BLUE_S, outline=BLUE, width=5)
        nodes = [(190, 270), (295, 230), (380, 315), (210, 410), (330, 435), (275, 330)]
        edges = [(0, 1), (1, 2), (2, 4), (4, 3), (3, 0), (0, 5), (5, 2), (5, 4), (1, 5)]
        for a, b in edges:
            d.line([nodes[a], nodes[b]], fill=hex_to_rgba("#1D4ED8", 130), width=4)
        for nx, ny in nodes:
            d.ellipse([nx - 16, ny - 16, nx + 16, ny + 16], fill=WHITE, outline=BLUE, width=5)
        # Readout node
        rx, ry = 625, 345
        for nx, ny in [nodes[1], nodes[2], nodes[4]]:
            d.line([(nx + 16, ny), (rx - 36, ry)], fill=AMBER, width=5)
        d.ellipse([rx - 36, ry - 36, rx + 36, ry + 36], fill=AMBER_S, outline=AMBER, width=6)
        d.text((175, 545), "Reservoir fisso", font=f_sm, fill=BLUE)
        d.text((535, 402), "Readout", font=f_sm, fill=AMBER)

    elif chapter == 17:
        # K-means 3 clusters + centroids
        clusters = [
            (210, 235, BLUE, BLUE_S, [(155, 200), (245, 185), (175, 285), (265, 265), (200, 235)]),
            (535, 235, RED, RED_S, [(485, 195), (575, 190), (505, 290), (595, 265), (545, 235)]),
            (375, 475, GREEN, GREEN_S, [(315, 445), (425, 435), (345, 535), (435, 515), (380, 480)]),
        ]
        for cx, cy, col, soft, pts in clusters:
            d.ellipse([cx - 108, cy - 95, cx + 108, cy + 95], fill=soft, outline=col, width=4)
            for px, py in pts:
                d.ellipse([px - 10, py - 10, px + 10, py + 10], fill=col, outline=WHITE, width=2)
            # Centroid
            d.ellipse([cx - 17, cy - 17, cx + 17, cy + 17], fill=WHITE, outline=INK, width=5)
            d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=col)

    elif chapter == 18:
        # Unrolled RNN cells h_{t-1} -> h_t -> h_{t+1}
        xs = [155, 380, 605]
        cy = 345
        for i, cx in enumerate(xs):
            d.rounded_rectangle([cx - 64, cy - 58, cx + 64, cy + 58], radius=20, fill=BLUE_S, outline=BLUE, width=6)
            lbl = ["h(t-1)", "h(t)", "h(t+1)"][i]
            bb = d.textbbox((0, 0), lbl, font=f_sm)
            d.text((cx - (bb[2] - bb[0]) // 2, cy - 14), lbl, font=f_sm, fill=INK)
            _draw_arrow(d, (cx, 530), (cx, cy + 64), SOFT, width=5, head=14)
            _draw_arrow(d, (cx, cy - 64), (cx, 170), GREEN, width=5, head=14)
            d.text((cx - 16, 545), f"x{i + 1}", font=f_sm, fill=SOFT)
            d.text((cx - 16, 130), f"y{i + 1}", font=f_sm, fill=GREEN)
            if i < 2:
                _draw_arrow(d, (cx + 68, cy), (xs[i + 1] - 68, cy), AMBER, width=7, head=18)

    else:
        # Chapter 19: Graph Neural Networks & Message Passing
        nodes = [(380, 340), (205, 195), (565, 200), (165, 445), (595, 455), (375, 555)]
        edges = [(0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (1, 3), (2, 4), (3, 5), (4, 5)]
        for a, b in edges:
            col = AMBER if a == 0 else MUTED
            w = 6 if a == 0 else 4
            d.line([nodes[a], nodes[b]], fill=col, width=w)
            if a == 0:
                # Message arrow toward target node 0
                x1, y1 = nodes[b]
                x2, y2 = nodes[0]
                mx, my = x1 + (x2 - x1) * 0.68, y1 + (y2 - y1) * 0.68
                _draw_arrow(d, (x1 + (x2 - x1) * 0.25, y1 + (y2 - y1) * 0.25), (mx, my), AMBER, width=6, head=16)
        for i, (nx, ny) in enumerate(nodes):
            if i == 0:
                d.ellipse([nx - 38, ny - 38, nx + 38, ny + 38], fill=PURPLE_S, outline=PURPLE, width=7)
                d.text((nx - 10, ny - 16), "v", font=f_lbl, fill=PURPLE)
            else:
                d.ellipse([nx - 24, ny - 24, nx + 24, ny + 24], fill=WHITE, outline=BLUE, width=5)
        d.text((175, 84), "Message Passing", font=f_lbl, fill=PURPLE)

    return canvas.resize((width, height), Image.LANCZOS)


def generate_og_card(
    out_path: Path,
    eyebrow: str,
    part_label: str,
    title: str,
    description: str,
    chips: list[str],
    footer_right: str,
    accent_a: str = "#1D4ED8",
    accent_b: str = "#15803D",
    seed: int = 0,
    chapter: int | None = None,
    is_home: bool = False,
) -> None:
    if Image is None:
        raise RuntimeError("Pillow non installato: installa `pillow` per generare le immagini Open Graph.")

    # Clean Studio Light canvas (matches website default theme, zero AI slop)
    img = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), hex_to_rgba("#F6F6F3", 255))

    margin = 34
    card_box = [margin, margin, OG_WIDTH - margin, OG_HEIGHT - margin]

    # Soft realistic card elevation shadow
    shadow = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(shadow, "RGBA").rounded_rectangle(
        [margin, margin + 8, OG_WIDTH - margin, OG_HEIGHT - margin + 10],
        radius=26,
        fill=(20, 20, 19, 18),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=16))
    img = Image.alpha_composite(img, shadow)

    # Pure white editorial card surface
    card_layer = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(card_layer, "RGBA").rounded_rectangle(
        card_box,
        radius=26,
        fill=hex_to_rgba("#FFFFFF", 255),
        outline=hex_to_rgba("#E5E5E0", 255),
        width=2,
    )
    img = Image.alpha_composite(img, card_layer)
    draw = ImageDraw.Draw(img, "RGBA")

    f_eyebrow = load_font(21, bold=False)
    f_kicker = load_font(22, bold=True)
    f_title = load_font(54 if is_home else 50, bold=True)
    f_desc = load_font(24, bold=False)
    f_chip = load_font(19, bold=True)
    f_foot = load_font(18, bold=False)
    f_name = load_font(21, bold=True)
    f_sub = load_font(17, bold=False)

    left = margin + 46
    top = margin + 38
    right_edge = OG_WIDTH - margin - 46

    # Clean editorial eyebrow (no neon SaaS pills!)
    eyebrow_line = "Università di Pisa  /  654AA  /  Laurea Magistrale 2026–27" if is_home else (
        f"Università di Pisa  /  654AA  /  {part_label}" if part_label else "Università di Pisa  /  654AA"
    )
    draw.text((left, top), eyebrow_line, font=f_eyebrow, fill=hex_to_rgba("#73736D", 255))

    # Right-hand visual panel (Lia hero showcase on Home, topic-specific ML visual on chapters!)
    panel_w, panel_h = 376, 344
    panel_x = right_edge - panel_w
    panel_y = top + 46
    panel_box = [panel_x, panel_y, panel_x + panel_w, panel_y + panel_h]

    if is_home:
        # Warm Studio stage featuring Lia front-and-center
        draw.rounded_rectangle(
            panel_box,
            radius=22,
            fill=hex_to_rgba("#F6F6F3", 255),
            outline=hex_to_rgba("#E5E5E0", 255),
            width=2,
        )
        lia_big = load_lia_frame(frame_idx=5, size=310)
        if lia_big is not None:
            lx = panel_x + (panel_w - 310) // 2
            ly = panel_y + panel_h - 306
            # Clip Lia cleanly inside rounded panel
            pmask = Image.new("L", (OG_WIDTH, OG_HEIGHT), 0)
            ImageDraw.Draw(pmask).rounded_rectangle(panel_box, radius=22, fill=255)
            lia_layer = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
            lia_layer.paste(lia_big, (lx, ly), lia_big)
            clipped_lia = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
            clipped_lia.paste(lia_layer, (0, 0), pmask)
            img = Image.alpha_composite(img, clipped_lia)
            draw = ImageDraw.Draw(img, "RGBA")
    else:
        visual = draw_chapter_visual(chapter if chapter is not None else 0, width=panel_w, height=panel_h)
        pmask = Image.new("L", (panel_w, panel_h), 0)
        ImageDraw.Draw(pmask).rounded_rectangle([0, 0, panel_w - 1, panel_h - 1], radius=20, fill=255)
        img.paste(visual, (panel_x, panel_y), pmask)
        draw = ImageDraw.Draw(img, "RGBA")
        draw.rounded_rectangle(panel_box, radius=20, fill=None, outline=hex_to_rgba("#E5E5E0", 255), width=2)

    # Left column typography
    max_text_w = panel_x - left - 36
    y = top + 52

    if eyebrow and not is_home:
        draw.text((left, y), eyebrow.upper(), font=f_kicker, fill=hex_to_rgba(accent_a, 255))
        y += 38

    title_lines = wrap_text(draw, title, f_title, max_text_w, max_lines=2)
    if len(title_lines) == 2 and len(title) > 36:
        f_title = load_font(44, bold=True)
        title_lines = wrap_text(draw, title, f_title, max_text_w, max_lines=2)
    line_step = 62 if f_title.size >= 50 else 54
    for line in title_lines:
        draw.text((left, y), line, font=f_title, fill=hex_to_rgba("#141413", 255))
        y += line_step

    if is_home:
        # Credits row with Fabio + Prof. Alessio Micheli photos (matching live Homepage!)
        y += 18
        fabio = load_circle_photo("author-fabio.jpg", size=52)
        if fabio is not None:
            img.alpha_composite(fabio, (left, y))
        tx = left + (66 if fabio else 0)
        draw.text((tx, y + 3), "Appunti di Fabio Piscitelli", font=f_name, fill=hex_to_rgba("#141413", 255))
        draw.text((tx, y + 29), "github.com/fabiopsh", font=f_sub, fill=hex_to_rgba("#73736D", 255))

        y += 68
        prof = load_circle_photo("prof-micheli.jpg", size=52)
        if prof is not None:
            img.alpha_composite(prof, (left, y))
        tx = left + (66 if prof else 0)
        draw.text((tx, y + 3), "Prof. Alessio Micheli", font=f_name, fill=hex_to_rgba("#141413", 255))
        draw.text((tx, y + 29), "Docente del corso · Dip. Informatica UNIPI", font=f_sub, fill=hex_to_rgba("#73736D", 255))

        # Clean summary pills below credits
        y += 74
        cx_chip = left
        for chip in chips:
            cx_chip = draw_pill(
                draw,
                cx_chip,
                y,
                chip,
                f_chip,
                fill=hex_to_rgba("#EFEFEC", 255),
                outline=hex_to_rgba("#E5E5E0", 255),
                text_color=hex_to_rgba("#141413", 255),
                pad_x=16,
                pad_y=8,
            ) + 12
    else:
        y += 12
        desc_lines = wrap_text(draw, description, f_desc, max_text_w, max_lines=3)
        for line in desc_lines:
            draw.text((left, y), line, font=f_desc, fill=hex_to_rgba("#464642", 255))
            y += 35

        # Subtle duration/topic chips
        y += 18
        cx_chip = left
        for chip in chips:
            cx_chip = draw_pill(
                draw,
                cx_chip,
                y,
                chip,
                f_chip,
                fill=hex_to_rgba("#EFEFEC", 255),
                outline=hex_to_rgba("#E5E5E0", 255),
                text_color=hex_to_rgba("#141413", 255),
                pad_x=15,
                pad_y=7,
            ) + 10

    # Bottom hairline divider + Natural Lia Tutor signature & domain
    div_y = OG_HEIGHT - margin - 94
    draw.line([(left, div_y), (right_edge, div_y)], fill=hex_to_rgba("#E5E5E0", 255), width=2)

    foot_y = div_y + 18
    if not is_home:
        lia_mini = load_lia_frame(frame_idx=5, size=56)
        if lia_mini is not None:
            badge_box = [left, foot_y, left + 56, foot_y + 56]
            draw.rounded_rectangle(badge_box, radius=14, fill=hex_to_rgba("#F6F6F3", 255), outline=hex_to_rgba("#E5E5E0", 255), width=2)
            bmask = Image.new("L", (56, 56), 0)
            ImageDraw.Draw(bmask).rounded_rectangle([1, 1, 54, 54], radius=13, fill=255)
            img.paste(lia_mini, (left, foot_y), bmask)
            draw = ImageDraw.Draw(img, "RGBA")
            draw.text((left + 70, foot_y + 6), "Lia · Videolezione guidata", font=load_font(19, bold=True), fill=hex_to_rgba("#141413", 255))
            draw.text((left + 70, foot_y + 31), "Appunti di Fabio Piscitelli · Prof. Alessio Micheli", font=f_sub, fill=hex_to_rgba("#73736D", 255))
    else:
        draw.text((left, foot_y + 16), "Videolezioni sincronizzate con formule KaTeX e grafici reali", font=f_foot, fill=hex_to_rgba("#73736D", 255))

    fbbox = draw.textbbox((0, 0), footer_right, font=f_foot)
    fw = fbbox[2] - fbbox[0]
    draw.text(
        (right_edge - fw, foot_y + 16),
        footer_right,
        font=f_foot,
        fill=hex_to_rgba("#73736D", 255),
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_path, format="PNG", optimize=True)


def write_favicon(out_dir: Path) -> None:
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#090D16"/>
  <rect x="2" y="2" width="60" height="60" rx="14" fill="none" stroke="#38BDF8" stroke-opacity="0.45" stroke-width="2.5"/>
  <g stroke="#38BDF8" stroke-width="2.4" stroke-linecap="round" opacity="0.75">
    <line x1="17" y1="22" x2="32" y2="32"/>
    <line x1="17" y1="42" x2="32" y2="32"/>
    <line x1="32" y1="32" x2="47" y2="20"/>
    <line x1="32" y1="32" x2="47" y2="44"/>
  </g>
  <circle cx="17" cy="22" r="5" fill="#090D16" stroke="#38BDF8" stroke-width="3"/>
  <circle cx="17" cy="42" r="5" fill="#090D16" stroke="#38BDF8" stroke-width="3"/>
  <circle cx="32" cy="32" r="6" fill="#38BDF8"/>
  <circle cx="47" cy="20" r="5" fill="#090D16" stroke="#FB7185" stroke-width="3"/>
  <circle cx="47" cy="44" r="5" fill="#090D16" stroke="#34D399" stroke-width="3"/>
</svg>
"""
    (out_dir / "favicon.svg").write_text(svg, encoding="utf-8")


def build_meta_tags(
    *,
    title: str,
    description: str,
    canonical_url: str,
    og_image_url: str,
    og_image_alt: str,
    og_type: str,
    root_prefix: str,
) -> str:
    e = lambda s: html.escape(s, quote=True)
    return "\n".join(
        [
            f'  <meta name="description" content="{e(description)}" />',
            f'  <link rel="canonical" href="{e(canonical_url)}" />',
            f'  <meta property="og:type" content="{e(og_type)}" />',
            '  <meta property="og:locale" content="it_IT" />',
            '  <meta property="og:site_name" content="Machine Learning · UNIPI 654AA" />',
            f'  <meta property="og:title" content="{e(title)}" />',
            f'  <meta property="og:description" content="{e(description)}" />',
            f'  <meta property="og:url" content="{e(canonical_url)}" />',
            f'  <meta property="og:image" content="{e(og_image_url)}" />',
            '  <meta property="og:image:type" content="image/png" />',
            f'  <meta property="og:image:width" content="{OG_WIDTH}" />',
            f'  <meta property="og:image:height" content="{OG_HEIGHT}" />',
            f'  <meta property="og:image:alt" content="{e(og_image_alt)}" />',
            '  <meta name="twitter:card" content="summary_large_image" />',
            f'  <meta name="twitter:title" content="{e(title)}" />',
            f'  <meta name="twitter:description" content="{e(description)}" />',
            f'  <meta name="twitter:image" content="{e(og_image_url)}" />',
            f'  <meta name="twitter:image:alt" content="{e(og_image_alt)}" />',
        ]
    )


def transcode_wav_to_mp3(src_wav: Path, dst_mp3: Path, bitrate: str) -> None:
    dst_mp3.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src_wav),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        bitrate,
        str(dst_mp3),
    ]
    subprocess.run(cmd, check=True)


def write_404_page(out_dir: Path, base_url: str, ready_ids: list[str]) -> None:
    parsed = urlparse(base_url)
    base_path = parsed.path if parsed.path.endswith("/") else parsed.path + "/"
    ready_json = json.dumps(ready_ids)
    page = f"""<!DOCTYPE html>
<html lang="it" data-theme="studio">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pagina non trovata — Machine Learning (654AA)</title>
  <meta name="theme-color" content="#F6F6F3" />
  <link rel="icon" type="image/png" sizes="64x64" href="{base_path}assets/favicon-lia.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="{base_path}assets/apple-touch-icon.png" />
  <script>
    (function () {{
      var BASE = {json.dumps(base_path)};
      var READY = {ready_json};
      var path = window.location.pathname || "";
      var rel = path.indexOf(BASE) === 0 ? path.slice(BASE.length) : path.replace(/^\\/+/, "");
      rel = rel.replace(/^videolezioni\\/+/, "").replace(/\\/+$/, "").replace(/\\.html$/i, "");
      if (READY.indexOf(rel) !== -1) {{
        window.location.replace(BASE + rel + "/" + window.location.search + window.location.hash);
      }}
    }})();
  </script>
  <style>
    :root {{ color-scheme: light; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #F6F6F3;
      color: #141413;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 24px;
    }}
    .card {{
      max-width: 520px;
      width: 100%;
      background: #FFFFFF;
      border: 1px solid #E5E5E0;
      border-radius: 20px;
      padding: 36px;
      box-shadow: 0 1px 2px rgba(20, 20, 19, 0.04), 0 16px 40px rgba(20, 20, 19, 0.06);
    }}
    .badge {{
      display: inline-block;
      padding: 5px 12px;
      border-radius: 999px;
      background: rgba(29, 78, 216, 0.08);
      color: #1D4ED8;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
    }}
    h1 {{ margin: 18px 0 10px; font-size: 28px; letter-spacing: -0.025em; }}
    p {{ margin: 0 0 26px; color: #464642; line-height: 1.55; }}
    a.btn {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 11px 20px;
      border-radius: 999px;
      background: #141413;
      color: #FFFFFF;
      font-weight: 600;
      text-decoration: none;
    }}
    a.btn:hover {{ background: #1D4ED8; }}
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">ERRORE 404 · UNIPI 654AA</span>
    <h1>Lezione o pagina non trovata</h1>
    <p>Il link potrebbe appartenere a un capitolo ancora in preparazione oppure contenere un indirizzo non valido.</p>
    <a class="btn" href="{base_path}">Torna al catalogo del corso</a>
  </main>
</body>
</html>
"""
    (out_dir / "404.html").write_text(page, encoding="utf-8")


def write_seo_files(out_dir: Path, base_url: str, ready_ids: list[str]) -> None:
    urls = [base_url] + [f"{base_url}{lid}/" for lid in ready_ids]
    entries = "\n".join(f"  <url><loc>{html.escape(u)}</loc></url>" for u in urls)
    sitemap = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{entries}\n"
        "</urlset>\n"
    )
    (out_dir / "sitemap.xml").write_text(sitemap, encoding="utf-8")
    robots = f"User-agent: *\nAllow: /\n\nSitemap: {base_url}sitemap.xml\n"
    (out_dir / "robots.txt").write_text(robots, encoding="utf-8")
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")


def _clean_searchable_text(slide_html: str, tts_text: str) -> str:
    """Extract clean plain text from slide HTML (minus SVGs/tags) + spoken narration for Ctrl+K search."""
    no_svg = re.sub(r"<svg\b[\s\S]*?</svg>", " ", slide_html or "", flags=re.IGNORECASE)
    no_tags = re.sub(r"<[^>]+>", " ", no_svg)
    no_tags = html.unescape(no_tags)
    # Strip \htmlId{id}{content} / \htmlClass{cls}{content} keeping content
    s = re.sub(r"\\html(?:Id|Class)\{[^}]*\}", " ", no_tags)
    # Map common LaTeX symbols & custom math.js macros to readable Unicode
    symbol_map = (
        (r"\\implies\b|\\Longrightarrow\b", "⇒"),
        (r"\\iff\b|\\Longleftrightarrow\b", "⇔"),
        (r"\\longrightarrow\b|\\rightarrow\b|\\to\b", "→"),
        (r"\\leftarrow\b", "←"),
        (r"\\leftrightarrow\b", "↔"),
        (r"\\mapsto\b", "↦"),
        (r"\\le\b|\\leq\b", "≤"),
        (r"\\ge\b|\\geq\b", "≥"),
        (r"\\neq\b|\\ne\b", "≠"),
        (r"\\approx\b", "≈"),
        (r"\\equiv\b", "≡"),
        (r"\\sim\b", "~"),
        (r"\\in\b", "∈"),
        (r"\\notin\b", "∉"),
        (r"\\subset\b|\\subseteq\b", "⊆"),
        (r"\\forall\b", "∀"),
        (r"\\exists\b", "∃"),
        (r"\\times\b", "×"),
        (r"\\cdot\b", "·"),
        (r"\\pm\b", "±"),
        (r"\\infty\b", "∞"),
        (r"\\nabla\b", "∇"),
        (r"\\partial\b", "∂"),
        (r"\\sum\b", "∑"),
        (r"\\prod\b", "∏"),
        (r"\\int\b", "∫"),
        (r"\\sqrt\b", "√"),
        (r"\\alpha\b", "α"),
        (r"\\beta\b", "β"),
        (r"\\gamma\b", "γ"),
        (r"\\delta\b", "δ"),
        (r"\\Delta\b", "Δ"),
        (r"\\eps\b|\\varepsilon\b|\\epsilon\b", "ε"),
        (r"\\eta\b", "η"),
        (r"\\theta\b", "θ"),
        (r"\\lambda\b", "λ"),
        (r"\\mu\b", "μ"),
        (r"\\xi\b", "ξ"),
        (r"\\pi\b", "π"),
        (r"\\rho\b", "ρ"),
        (r"\\sigma\b", "σ"),
        (r"\\Sigma\b", "Σ"),
        (r"\\tau\b", "τ"),
        (r"\\phi\b|\\varphi\b", "φ"),
        (r"\\Phi\b", "Φ"),
        (r"\\psi\b", "ψ"),
        (r"\\Psi\b", "Ψ"),
        (r"\\omega\b", "ω"),
        (r"\\Omega\b", "Ω"),
        (r"\\R\b", "ℝ"),
        (r"\\E\b", "𝔼"),
        (r"\\Remp\b", "R_emp"),
        (r"\\VC\b", "VC"),
        (r"\\Var\b", "Var"),
        (r"\\Cov\b", "Cov"),
        (r"\\Bias\b", "Bias"),
        (r"\\sign\b", "sign"),
        (r"\\net\b", "net"),
        (r"\\out\b", "out"),
        (r"\\T\b", "ᵀ"),
        (r"\\x\b", "x"),
        (r"\\w\b", "w"),
        (r"\\y\b", "y"),
        (r"\\dd\b", "d"),
        (r"\\h\b", "h"),
    )
    for pat, rep in symbol_map:
        s = re.sub(pat, f" {rep} ", s)
    # Remove remaining TeX formatting/spacing commands & environments
    s = re.sub(r"\\(?:begin|end)\{[^}]*\}", " ", s)
    s = re.sub(r"\\[,;:!\s]", " ", s)
    s = re.sub(r"\\[A-Za-z]+", " ", s)
    s = re.sub(r"[\\{}\[\]$^_~]+", " ", s)
    clean_tts = re.sub(r"\[[^\]]+\]", " ", tts_text or "")
    combined = f"{s} {clean_tts}"
    return re.sub(r"\s+", " ", combined).strip()


def build_search_index(ready_lessons: list[dict[str, Any]], lessons_root: Path) -> dict[str, Any]:
    """Build compact static global search index across all ready chapters and scenes."""
    index_lessons: list[dict[str, Any]] = []
    index_scenes: list[dict[str, Any]] = []
    for l_idx, lesson in enumerate(ready_lessons):
        lid = lesson["id"]
        index_lessons.append({
            "id": lid,
            "ch": int(lesson.get("chapter", 0)),
            "t": lesson.get("title", ""),
        })
        src_json = lessons_root / lid / "lesson.json"
        if not src_json.is_file():
            continue
        ldata = json.loads(src_json.read_text(encoding="utf-8"))
        for s_idx, scene in enumerate(ldata.get("scenes", [])):
            index_scenes.append({
                "l": l_idx,
                "i": s_idx,
                "sec": scene.get("section", ""),
                "t": scene.get("title", ""),
                "txt": _clean_searchable_text(scene.get("slide_html", ""), scene.get("tts_text", "")),
            })
    return {"lessons": index_lessons, "scenes": index_scenes}


def build_site(
    out_dir: Path,
    base_url: str,
    transcode_mp3: bool,
    require_ffmpeg: bool,
    bitrate: str,
) -> None:
    manifest_path = VIDEOLEZIONI_DIR / "lessons" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    parts_by_id = {p["id"]: p for p in manifest.get("parts", [])}
    lessons = manifest.get("lessons", [])
    ready_lessons = [l for l in lessons if l.get("status") == "ready"]
    ready_ids = [l["id"] for l in ready_lessons]

    ffmpeg_bin = shutil.which("ffmpeg")
    use_mp3 = transcode_mp3 and bool(ffmpeg_bin)
    if transcode_mp3 and not ffmpeg_bin:
        if require_ffmpeg:
            raise RuntimeError("ffmpeg richiesto (--require-ffmpeg) ma non trovato nel PATH.")
        print("[warn] ffmpeg non trovato nel PATH: mantengo i file .wav originali.")

    # Clean output directory
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Copy core static assets
    shutil.copytree(VIDEOLEZIONI_DIR / "css", out_dir / "css")
    shutil.copytree(VIDEOLEZIONI_DIR / "js", out_dir / "js")
    if (VIDEOLEZIONI_DIR / "assets").is_dir():
        shutil.copytree(VIDEOLEZIONI_DIR / "assets", out_dir / "assets")
    (out_dir / "lessons").mkdir(parents=True, exist_ok=True)
    shutil.copy2(manifest_path, out_dir / "lessons" / "manifest.json")
    search_index = build_search_index(ready_lessons, VIDEOLEZIONI_DIR / "lessons")
    search_index_str = json.dumps(search_index, ensure_ascii=False, separators=(",", ":"))
    (VIDEOLEZIONI_DIR / "lessons" / "search-index.json").write_text(search_index_str, encoding="utf-8")
    (out_dir / "lessons" / "search-index.json").write_text(search_index_str, encoding="utf-8")
    write_favicon(out_dir)

    # Copy lesson JSONs, subtitles, and collect audio tasks
    transcode_jobs: list[tuple[Path, Path]] = []
    copied_audio = 0

    for lesson in ready_lessons:
        lid = lesson["id"]
        src_lesson_dir = VIDEOLEZIONI_DIR / "lessons" / lid
        dst_lesson_dir = out_dir / "lessons" / lid
        dst_lesson_dir.mkdir(parents=True, exist_ok=True)

        # Subtitles
        src_subs = src_lesson_dir / "subtitles"
        if src_subs.is_dir():
            dst_subs = dst_lesson_dir / "subtitles"
            dst_subs.mkdir(parents=True, exist_ok=True)
            for sub_file in src_subs.glob("*.json"):
                shutil.copy2(sub_file, dst_subs / sub_file.name)

        # Audio (top-level files only; skips .batches/, .chunks/, .gitkeep)
        src_audio_dir = src_lesson_dir / "audio"
        dst_audio_dir = dst_lesson_dir / "audio"
        converted_rel: set[str] = set()
        if src_audio_dir.is_dir():
            dst_audio_dir.mkdir(parents=True, exist_ok=True)
            for af in sorted(src_audio_dir.iterdir()):
                if not af.is_file() or af.name.startswith("."):
                    continue
                ext = af.suffix.lower()
                if ext == ".wav" and use_mp3:
                    dst_mp3 = dst_audio_dir / f"{af.stem}.mp3"
                    transcode_jobs.append((af, dst_mp3))
                    converted_rel.add(f"audio/{af.name}")
                elif ext in {".wav", ".mp3", ".ogg", ".m4a"}:
                    shutil.copy2(af, dst_audio_dir / af.name)
                    copied_audio += 1

        # Lesson JSON (rewrite audio_file to .mp3 when transcoded)
        src_json = src_lesson_dir / "lesson.json"
        lesson_data = json.loads(src_json.read_text(encoding="utf-8"))
        if use_mp3:
            for scene in lesson_data.get("scenes", []):
                af_rel = scene.get("audio_file", "")
                if af_rel in converted_rel and af_rel.lower().endswith(".wav"):
                    scene["audio_file"] = af_rel[:-4] + ".mp3"
        (dst_lesson_dir / "lesson.json").write_text(
            json.dumps(lesson_data, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

    if transcode_jobs:
        workers = min(8, max(2, os.cpu_count() or 4))
        print(f"Transcodifica {len(transcode_jobs)} file WAV -> MP3 ({bitrate}) con {workers} worker...")
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = [pool.submit(transcode_wav_to_mp3, src, dst, bitrate) for src, dst in transcode_jobs]
            for fut in as_completed(futs):
                fut.result()

    # Generate Open Graph cover images
    parsed_base = urlparse(base_url)
    display_host = (parsed_base.netloc + parsed_base.path).rstrip("/")
    og_dir = out_dir / "og"
    og_dir.mkdir(parents=True, exist_ok=True)

    total_scenes = sum(l.get("scenes_count", 0) for l in ready_lessons)
    total_mins = sum(l.get("duration_min") or l.get("estimated_minutes") or 0 for l in ready_lessons)
    course = manifest.get("course", {})

    home_title = f"{course.get('title', 'Machine Learning')} ({course.get('code', '654AA')}) — Videolezioni Interattive"
    home_desc = (
        f"Videolezioni di Machine Learning ({course.get('university', 'UNIPI')}, "
        f"{course.get('professor', 'Prof. Alessio Micheli')}): {format_hours(total_mins)} di lezioni "
        f"con formule KaTeX, grafici e voce sincronizzata dagli appunti di Fabio Piscitelli."
    )
    generate_og_card(
        og_dir / "home.png",
        eyebrow="",
        part_label=course.get("academic_year", "2026/27"),
        title="Machine Learning",
        description="",
        chips=[
            f"{format_hours(total_mins)} di lezioni",
            f"{len(ready_lessons)} capitoli",
        ],
        footer_right=display_host,
        accent_a="#1D4ED8",
        accent_b="#15803D",
        seed=0,
        is_home=True,
    )

    # Render Home index.html
    index_tpl = (VIDEOLEZIONI_DIR / "index.html").read_text(encoding="utf-8")
    index_html = index_tpl.replace(
        '<html lang="it" data-theme="studio">',
        '<html lang="it" data-theme="studio" data-clean-urls="true">',
        1,
    )
    index_html = index_html.replace(
        "<title>Machine Learning (654AA) — Videolezioni Dinamiche</title>",
        f"<title>{html.escape(home_title)}</title>\n"
        + build_meta_tags(
            title=home_title,
            description=home_desc,
            canonical_url=base_url,
            og_image_url=f"{base_url}og/home.png",
            og_image_alt="Machine Learning (654AA) — Catalogo Videolezioni Interattive",
            og_type="website",
            root_prefix="",
        ),
        1,
    )
    first_ready = ready_ids[0] if ready_ids else "00-guida"
    index_html = index_html.replace(
        'href="lesson.html?id=00-guida"',
        f'href="{first_ready}/"',
    )
    (out_dir / "index.html").write_text(index_html, encoding="utf-8")

    # Render legacy fallback lesson.html
    lesson_tpl = (VIDEOLEZIONI_DIR / "lesson.html").read_text(encoding="utf-8")
    fallback_lesson_html = lesson_tpl.replace(
        "<title>Videolezione — Machine Learning (654AA)</title>",
        "<title>Videolezione — Machine Learning (654AA)</title>\n"
        + build_meta_tags(
            title=home_title,
            description=home_desc,
            canonical_url=base_url,
            og_image_url=f"{base_url}og/home.png",
            og_image_alt="Videolezione — Machine Learning (654AA)",
            og_type="website",
            root_prefix="",
        ),
        1,
    )
    (out_dir / "lesson.html").write_text(fallback_lesson_html, encoding="utf-8")

    # Render per-chapter clean pages + per-chapter OG cards
    for lesson in ready_lessons:
        lid = lesson["id"]
        chap_num = int(lesson.get("chapter", 0))
        chap_str = f"{chap_num:02d}"
        part_info = parts_by_id.get(lesson.get("part", ""), {})
        part_badge = f"{part_info.get('label', '')} · {part_info.get('title', '')}".strip(" ·")
        accent_a, accent_b = PART_ACCENTS.get(lesson.get("part", ""), ("#38BDF8", "#FB7185"))
        scenes_count = int(lesson.get("scenes_count", 0))
        dur_min = int(lesson.get("duration_min") or lesson.get("estimated_minutes") or 10)
        summary = lesson.get("summary", "").strip()

        page_title = f"Cap. {chap_str} · {lesson['title']} — Machine Learning (654AA)"
        og_title = f"Cap. {chap_str} · {lesson['title']}"
        og_desc = f"{summary} (~{dur_min} min · Videolezione sincronizzata UNIPI 654AA)"
        canonical = f"{base_url}{lid}/"
        og_img_url = f"{base_url}og/{lid}.png"

        generate_og_card(
            og_dir / f"{lid}.png",
            eyebrow=f"CAPITOLO {chap_str}",
            part_label=part_badge,
            title=lesson["title"],
            description=summary,
            chips=[
                f"~{dur_min} min",
                "Voce + KaTeX",
            ],
            footer_right=display_host,
            accent_a=accent_a,
            accent_b=accent_b,
            seed=chap_num + 1,
            chapter=chap_num,
            is_home=False,
        )

        chap_html = lesson_tpl.replace(
            '<html lang="it" data-theme="studio">',
            f'<html lang="it" data-theme="studio" data-lesson-id="{html.escape(lid, quote=True)}" data-root="..">',
            1,
        )
        chap_html = chap_html.replace(
            "<title>Videolezione — Machine Learning (654AA)</title>",
            f"<title>{html.escape(page_title)}</title>\n"
            + build_meta_tags(
                title=og_title,
                description=og_desc,
                canonical_url=canonical,
                og_image_url=og_img_url,
                og_image_alt=f"{og_title} — Machine Learning (654AA)",
                og_type="article",
                root_prefix="../",
            ),
            1,
        )
        chap_html = (
            chap_html.replace('href="css/styles.css"', 'href="../css/styles.css"')
            .replace('href="css/themes.css"', 'href="../css/themes.css"')
            .replace('href="assets/favicon-lia.png"', 'href="../assets/favicon-lia.png"')
            .replace('href="assets/apple-touch-icon.png"', 'href="../assets/apple-touch-icon.png"')
            .replace('href="index.html"', 'href="../"')
            .replace('src="js/player.js"', 'src="../js/player.js"')
            .replace(
                '<span id="lesson-chap-tag" class="lesson-chap-tag">Cap. --</span>',
                f'<span id="lesson-chap-tag" class="lesson-chap-tag">Cap. {chap_str}</span>',
            )
            .replace(
                '<span id="lesson-title-bar" class="lesson-title-bar">Caricamento...</span>',
                f'<span id="lesson-title-bar" class="lesson-title-bar">{html.escape(lesson["title"])}</span>',
            )
        )

        chap_dir = out_dir / lid
        chap_dir.mkdir(parents=True, exist_ok=True)
        (chap_dir / "index.html").write_text(chap_html, encoding="utf-8")

    write_404_page(out_dir, base_url, ready_ids)
    write_seo_files(out_dir, base_url, ready_ids)

    # Size summary
    total_bytes = sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file())
    print(
        f"Build completata in {out_dir}: "
        f"{len(ready_lessons)} pagine capitolo + home + {len(ready_lessons) + 1} cover OG PNG "
        f"({total_bytes / (1024 * 1024):.1f} MB, audio: "
        f"{'MP3 ' + bitrate if use_mp3 else f'WAV ({copied_audio} file)'})."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepara il pacchetto statico GitHub Pages da videolezioni/.")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"URL pubblico finale del sito (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--out",
        default=str(VIDEOLEZIONI_DIR / "dist"),
        help="Cartella di output (default: videolezioni/dist)",
    )
    parser.add_argument(
        "--transcode-mp3",
        action="store_true",
        help="Converte gli audio .wav in .mp3 via ffmpeg e aggiorna i lesson.json di output.",
    )
    parser.add_argument(
        "--require-ffmpeg",
        action="store_true",
        help="Fallisce se --transcode-mp3 è attivo ma ffmpeg non è presente.",
    )
    parser.add_argument(
        "--bitrate",
        default="80k",
        help="Bitrate MP3 mono 24 kHz per la voce (default: 80k).",
    )
    args = parser.parse_args()

    build_site(
        out_dir=Path(args.out).resolve(),
        base_url=normalize_base_url(args.base_url),
        transcode_mp3=args.transcode_mp3,
        require_ffmpeg=args.require_ffmpeg,
        bitrate=args.bitrate,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
