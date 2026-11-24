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
DEFAULT_BASE_URL = "https://fabiopsh.github.io/machine-learning-videolesson/"

OG_WIDTH = 1200
OG_HEIGHT = 630

PART_ACCENTS: dict[str, tuple[str, str]] = {
    "frontmatter": ("#38BDF8", "#818CF8"),
    "parte-1": ("#38BDF8", "#34D399"),
    "parte-2": ("#60A5FA", "#38BDF8"),
    "parte-3": ("#FBBF24", "#FB7185"),
    "parte-4": ("#FB7185", "#A78BFA"),
    "parte-5": ("#34D399", "#38BDF8"),
    "parte-6": ("#A78BFA", "#38BDF8"),
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


def draw_decorative_network(img: Any, card_mask: Any, accent_a: str, accent_b: str, seed: int) -> Any:
    """Draw a smooth blurred ambient glow and crisp neural graph clipped inside the card."""
    glow = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow, "RGBA")
    cx, cy = 995, 295
    gd.ellipse([cx - 190, cy - 190, cx + 190, cy + 190], fill=hex_to_rgba(accent_a, 58))
    gd.ellipse([160 - 150, 520 - 150, 160 + 150, 520 + 150], fill=hex_to_rgba(accent_b, 42))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=62))
    clipped_glow = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
    clipped_glow.paste(glow, (0, 0), card_mask)
    img = Image.alpha_composite(img, clipped_glow)

    net = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
    d = ImageDraw.Draw(net, "RGBA")

    cols = [885, 995, 1100]
    layers = [
        [(cols[0], 175), (cols[0], 250), (cols[0], 325), (cols[0], 400)],
        [(cols[1], 205), (cols[1], 290), (cols[1], 375)],
        [(cols[2], 248), (cols[2], 332)],
    ]

    for li in range(len(layers) - 1):
        for i, p1 in enumerate(layers[li]):
            for j, p2 in enumerate(layers[li + 1]):
                is_highlight = ((i + j + seed) % 3) == 0
                color = hex_to_rgba(accent_a, 120) if is_highlight else hex_to_rgba("#94A3B8", 44)
                width = 3 if is_highlight else 2
                d.line([p1, p2], fill=color, width=width)

    for li, pts in enumerate(layers):
        for idx, (nx, ny) in enumerate(pts):
            is_accent = ((li + idx + seed) % 2) == 0
            ring_color = hex_to_rgba(accent_a if is_accent else accent_b, 235)
            fill_color = hex_to_rgba("#090D16", 248)
            r = 14 if li == 1 else 12
            d.ellipse([nx - r, ny - r, nx + r, ny + r], fill=fill_color, outline=ring_color, width=3)
            d.ellipse([nx - 4, ny - 4, nx + 4, ny + 4], fill=ring_color)

    curve_pts = []
    for step in range(42):
        px = 855 + step * 6.5
        t = (step / 41.0) * math.pi * 2.0 + seed * 0.6
        py = 446 + int(16 * math.sin(t))
        curve_pts.append((px, py))
    d.line(curve_pts, fill=hex_to_rgba(accent_b, 120), width=3)

    clipped_net = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
    clipped_net.paste(net, (0, 0), card_mask)
    return Image.alpha_composite(img, clipped_net)


def generate_og_card(
    out_path: Path,
    eyebrow: str,
    part_label: str,
    title: str,
    description: str,
    chips: list[str],
    footer_right: str,
    accent_a: str = "#38BDF8",
    accent_b: str = "#FB7185",
    seed: int = 0,
) -> None:
    if Image is None:
        raise RuntimeError("Pillow non installato: installa `pillow` per generare le immagini Open Graph.")

    img = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), hex_to_rgba("#090D16", 255))

    # Subtle dot grid background
    grid_layer = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid_layer, "RGBA")
    dot_color = hex_to_rgba("#94A3B8", 28)
    for gx in range(28, OG_WIDTH, 32):
        for gy in range(28, OG_HEIGHT, 32):
            gd.ellipse([gx - 1, gy - 1, gx + 1, gy + 1], fill=dot_color)
    img = Image.alpha_composite(img, grid_layer)

    # Card frame & rounded clip mask
    card_layer = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card_layer, "RGBA")
    margin = 36
    card_box = [margin, margin, OG_WIDTH - margin, OG_HEIGHT - margin]
    cd.rounded_rectangle(
        card_box,
        radius=28,
        fill=hex_to_rgba("#111827", 238),
        outline=hex_to_rgba("#94A3B8", 70),
        width=2,
    )
    img = Image.alpha_composite(img, card_layer)

    card_mask = Image.new("L", (OG_WIDTH, OG_HEIGHT), 0)
    ImageDraw.Draw(card_mask).rounded_rectangle(card_box, radius=28, fill=255)
    img = draw_decorative_network(img, card_mask, accent_a, accent_b, seed)

    # Top accent bar & crisp card border on top
    accent_bar = Image.new("RGBA", (OG_WIDTH, OG_HEIGHT), (0, 0, 0, 0))
    abd = ImageDraw.Draw(accent_bar, "RGBA")
    abd.rounded_rectangle(card_box, radius=28, fill=None, outline=hex_to_rgba("#94A3B8", 75), width=2)
    abd.rounded_rectangle(
        [margin + 40, margin, margin + 290, margin + 6],
        radius=3,
        fill=hex_to_rgba(accent_a, 245),
    )
    img = Image.alpha_composite(img, accent_bar)

    draw = ImageDraw.Draw(img, "RGBA")

    f_badge = load_font(20, bold=True)
    f_eyebrow = load_font(24, bold=True)
    f_title = load_font(54, bold=True)
    f_desc = load_font(25, bold=False)
    f_chip = load_font(20, bold=True)
    f_foot = load_font(19, bold=False)

    left = margin + 46
    top = margin + 42

    # Top badges (pre-blended dark tinted pill for high contrast)
    next_x = draw_pill(
        draw,
        left,
        top,
        "UNIPI 654AA · MACHINE LEARNING",
        f_badge,
        fill=blend_hex(accent_a, "#111827", 0.22),
        outline=blend_hex(accent_a, "#111827", 0.72),
        text_color=blend_hex(accent_a, "#FFFFFF", 0.35),
    )
    if part_label:
        draw_pill(
            draw,
            next_x + 14,
            top,
            part_label.upper(),
            f_badge,
            fill=hex_to_rgba("#1E293B", 255),
            outline=hex_to_rgba("#475569", 255),
            text_color=hex_to_rgba("#CBD5E1", 255),
        )

    # Eyebrow
    y = top + 66
    if eyebrow:
        draw.text((left, y), eyebrow.upper(), font=f_eyebrow, fill=hex_to_rgba(accent_a, 255))
        y += 40

    # Title (constrained to left ~735 px to stay clear of motif)
    max_text_w = 735
    title_lines = wrap_text(draw, title, f_title, max_text_w, max_lines=2)
    if len(title_lines) == 2 and len(title) > 46:
        f_title = load_font(46, bold=True)
        title_lines = wrap_text(draw, title, f_title, max_text_w, max_lines=2)
    line_step = 64 if f_title.size >= 50 else 56
    for line in title_lines:
        draw.text((left, y), line, font=f_title, fill=hex_to_rgba("#F8FAFC", 255))
        y += line_step

    # Description
    y += 12
    desc_lines = wrap_text(draw, description, f_desc, max_text_w, max_lines=3)
    for line in desc_lines:
        draw.text((left, y), line, font=f_desc, fill=hex_to_rgba("#CBD5E1", 240))
        y += 35

    # Bottom divider & chips
    div_y = OG_HEIGHT - margin - 102
    draw.line(
        [(left, div_y), (OG_WIDTH - margin - 46, div_y)],
        fill=hex_to_rgba("#94A3B8", 48),
        width=2,
    )

    chip_x = left
    chip_y = div_y + 24
    for chip in chips:
        chip_x = draw_pill(
            draw,
            chip_x,
            chip_y,
            chip,
            f_chip,
            fill=hex_to_rgba("#161F33", 240),
            outline=hex_to_rgba("#94A3B8", 80),
            text_color=hex_to_rgba("#F1F5F9", 255),
            pad_x=16,
            pad_y=8,
        ) + 12

    # Footer right
    fbbox = draw.textbbox((0, 0), footer_right, font=f_foot)
    fw = fbbox[2] - fbbox[0]
    draw.text(
        (OG_WIDTH - margin - 46 - fw, chip_y + 10),
        footer_right,
        font=f_foot,
        fill=hex_to_rgba("#94A3B8", 230),
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
            f'  <link rel="icon" type="image/svg+xml" href="{root_prefix}favicon.svg" />',
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
  <link rel="icon" type="image/svg+xml" href="{base_path}favicon.svg" />
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
    (out_dir / "lessons").mkdir(parents=True, exist_ok=True)
    shutil.copy2(manifest_path, out_dir / "lessons" / "manifest.json")
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
        f"Videolezioni interattive di Machine Learning ({course.get('university', 'UNIPI')}, "
        f"{course.get('professor', 'Prof. Alessio Micheli')}): {len(ready_lessons)} capitoli pronti, "
        f"{total_scenes} scene con formule KaTeX, grafici e voce sincronizzata."
    )
    generate_og_card(
        og_dir / "home.png",
        eyebrow="CORSO INTERATTIVO · LAUREA MAGISTRALE",
        part_label=course.get("academic_year", "2026/27"),
        title="Machine Learning",
        description="Videolezioni dinamiche con formule KaTeX, grafici interattivi e voce sincronizzata dalle note di Fabio Piscitelli.",
        chips=[
            f"{len(ready_lessons)}/{len(lessons)} capitoli",
            f"{total_scenes} scene",
            format_hours(total_mins),
        ],
        footer_right=display_host,
        accent_a="#38BDF8",
        accent_b="#FB7185",
        seed=0,
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
    first_ready = ready_ids[0] if ready_ids else "02-problema"
    index_html = index_html.replace(
        'href="lesson.html?id=02-problema"',
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
        og_desc = f"{summary} ({scenes_count} scene · ~{dur_min} min · Voce e formule sincronizzate)"
        canonical = f"{base_url}{lid}/"
        og_img_url = f"{base_url}og/{lid}.png"

        generate_og_card(
            og_dir / f"{lid}.png",
            eyebrow=f"CAPITOLO {chap_str}",
            part_label=part_badge,
            title=lesson["title"],
            description=summary,
            chips=[
                f"{scenes_count} scene",
                f"~{dur_min} min",
                "Audio + KaTeX",
            ],
            footer_right=display_host,
            accent_a=accent_a,
            accent_b=accent_b,
            seed=chap_num + 1,
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
