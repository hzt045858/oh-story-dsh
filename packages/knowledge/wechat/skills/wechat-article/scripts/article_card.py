"""Render a deterministic cover or information card to PNG using local fonts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from article_library import digest, load_json, write_json

FONTS = (
    "C:/Windows/Fonts/msyh.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def default_font(text: str) -> Path | None:
    """The first listed path that can render `text`, or None when this host ships no such font.

    Callers that only need to know whether card rendering is possible on this host can ask
    here instead of catching the error from `render_card`. The last entry is Latin-only, so it
    is dropped for any non-ASCII text.
    """
    candidates = FONTS if text.isascii() else FONTS[:-1]
    return next((Path(name) for name in candidates if Path(name).is_file()), None)


def wrap(text, font, width):
    lines = []
    for paragraph in text.splitlines() or [""]:
        line = ""
        for char in paragraph:
            if font.getlength(line + char) > width and line:
                lines.append(line)
                line = ""
            line += char
        lines.append(line)
    return lines


def fit(text, font_path, maximum, minimum, width, height):
    for size in range(maximum, minimum - 1, -2):
        font = ImageFont.truetype(str(font_path), size)
        lines = wrap(text, font, width)
        line_height = int(size * 1.45)
        if len(lines) * line_height <= height and all(font.getlength(line) <= width for line in lines):
            return font, lines, line_height
    raise ValueError("card text does not fit; shorten it or split it into multiple cards")


def spec_fields(spec):
    if not isinstance(spec, dict) or set(spec) - {"kind", "title", "points", "footer", "accent", "background", "text"}:
        raise ValueError("unsupported card specification")
    kind = spec.get("kind", "card")
    if kind not in {"cover", "card"}:
        raise ValueError("kind must be cover or card")
    title, points, footer = spec.get("title"), spec.get("points", []), spec.get("footer", "")
    if not isinstance(title, str) or not title.strip() or not isinstance(footer, str):
        raise ValueError("provide a title and an optional text footer")
    if not isinstance(points, list) or len(points) > 4 or any(not isinstance(point, str) or not point.strip() for point in points):
        raise ValueError("points must contain at most four nonempty text items")
    return kind, title, points, footer


def planned_card(state, spec, output):
    from article_workflow import card_text
    kind, title, points, footer = spec_fields(spec)
    name = output.relative_to(state["article"]).as_posix()
    matches = [c for c in state["plan"]["cards"] if c["output"] == name]
    if len(matches) != 1:
        raise ValueError("program output must match one image in the locked plan")
    card = matches[0]
    if card["role"] != ("cover" if kind == "cover" else "body"):
        raise ValueError("program card kind differs from the planned image role")
    visible = [title, *points, *([footer] if footer else [])]
    if visible != card_text(card) or card["requirements"]["text_rendering"] != "overlay":
        raise ValueError("program card requires the planned exact copy and overlay text strategy")
    width, height = (1200, 510) if kind == "cover" else (1080, 1440)
    requirements = card["requirements"]
    if "size" in requirements and requirements["size"] != [width, height]:
        raise ValueError("program card dimensions differ from the locked plan")
    if "aspect_ratio" in requirements:
        rw, rh = requirements["aspect_ratio"]
        if abs(width / height / (rw / rh) - 1) > 0.01:
            raise ValueError("program card aspect ratio differs from the locked plan")
    return card


def render_card(spec_path: Path, output: Path, font_path: Path | None = None):
    from article_workflow import current, exclusive, has_contract, safe
    # Resolve both sides before comparing. `relative_to` is a plain string comparison, and the
    # two sides arrive in different forms: macOS `tempfile` hands out `/var/...` while the
    # contract speaks `/private/var/...`, and Windows delivers 8.3 short names (`RUNNER~1`)
    # while `safe()` resolves them to the long form. `safe()` resolves its own root anyway, so
    # resolving here keeps every path below in one form.
    output, spec_path = output.resolve(), spec_path.resolve()
    owner = next((p for p in output.parents if has_contract(p)), None)
    if owner is None:
        return _render_card(spec_path, output, font_path)
    with exclusive(owner):
        state = current(owner)
        output = safe(owner, output.relative_to(owner).as_posix())
        spec_path = safe(owner, spec_path.relative_to(owner).as_posix(), True)
        safe(owner, output.with_suffix(".receipt.json").relative_to(owner).as_posix())
        return _render_card(spec_path, output, font_path, state)


def _render_card(spec_path, output, font_path, state=None):
    spec = load_json(spec_path)
    kind, title, points, footer = spec_fields(spec)
    card = planned_card(state, spec, output) if state is not None else None
    all_text = title + footer + "".join(points)
    if font_path is None:
        font_path = default_font(all_text)
    if font_path is None or not font_path.is_file():
        raise ValueError("provide --font with a local font supporting the card language")
    colors = {"accent": "#24755b", "background": "#ffffff", "text": "#232629"}
    for key in colors:
        colors[key] = spec.get(key, colors[key])
        if not isinstance(colors[key], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", colors[key]):
            raise ValueError("card colors must be six-digit hex values")
    if output.suffix.lower() != ".png" or output.exists():
        raise ValueError("choose a new PNG output version")
    receipt_path = output.with_suffix(".receipt.json")
    if state is not None and receipt_path.exists():
        raise ValueError("program receipt already exists; choose a new planned output version")
    width, height = (1200, 510) if kind == "cover" else (1080, 1440)
    margin = 64
    canvas = Image.new("RGB", (width, height), colors["background"])
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((margin, margin, margin + 72, margin + 8), fill=colors["accent"])
    title_height = 175 if kind == "cover" else 280
    font, lines, step = fit(title, font_path, 62, 30, width - margin * 2, title_height)
    y = margin + 36
    for line in lines:
        draw.text((margin, y), line, font=font, fill=colors["text"], anchor="lt")
        y += step
    y = max(y + 24, 265 if kind == "cover" else 410)
    footer_y = height - margin - 30
    if points:
        available = footer_y - y - 30
        item_height = available // len(points)
        for index, point in enumerate(points, 1):
            point_font, point_lines, point_step = fit(point, font_path, 30 if kind == "cover" else 38, 18 if kind == "cover" else 24,
                                                       width - margin * 2 - 64, item_height - 24)
            number_font = ImageFont.truetype(str(font_path), 22 if kind == "cover" else 28)
            draw.text((margin, y + 2), f"{index:02}", font=number_font, fill=colors["accent"], anchor="lt")
            for line in point_lines:
                draw.text((margin + 64, y), line, font=point_font, fill=colors["text"], anchor="lt")
                y += point_step
            y += item_height - len(point_lines) * point_step
    if footer:
        footer_font, footer_lines, _ = fit(footer, font_path, 24, 16, width - margin * 2, 35)
        draw.text((margin, footer_y), footer_lines[0], font=footer_font, fill=colors["text"], anchor="lt")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as handle:
        canvas.save(handle, "PNG")
    receipt = {"output": str(output.resolve()), "width": width, "height": height,
               "source_sha256": digest(spec_path.read_bytes()), "output_sha256": digest(output.read_bytes()),
               "font": str(font_path.resolve()), "status": "rendered"}
    if state is not None:
        receipt.update(schema_version=1, provenance="program-card-v1", provider_dispatched=False,
                       output=card["output"],
                       source_file=spec_path.relative_to(state["article"]).as_posix(), status="review_pending",
                       control={"workflow": state["record"]["workflow"], "account_id": state["account_id"],
                                "card_id": card["id"], "input_signature": state["card_signatures"][card["id"]]})
    write_json(receipt_path, receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--font", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(render_card(args.spec, args.output, args.font), ensure_ascii=True, indent=2))
        return 0
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
