"""Check an image-led article's files and review records, not its visual quality."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from markdown_it import MarkdownIt
from PIL import Image

from article_library import contained, digest, load_json


def image_path(root: Path, name):
    if not isinstance(name, str) or "\\" in name:
        raise ValueError("image output must use a relative images/ path")
    parts = Path(name).parts
    if not parts or parts[0] != "images" or Path(name).is_absolute() or ".." in parts:
        raise ValueError("image output must stay under images/")
    if Path(name).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise ValueError("unsupported image format")
    return contained(root, name)


def check(root: Path):
    root = root.resolve()
    errors = []
    plan = load_json(root / "图文计划.json")
    if isinstance(plan, dict) and plan.get("schema_version") == 2:
        from article_workflow import require_ready
        try:
            accepted = require_ready(root)
            return {**accepted, "status": "files_checked", "cards": len(plan.get("cards", [])),
                    "errors": [], "visual_quality_verified_by_script": False}
        except (ValueError, OSError, KeyError, TypeError) as error:
            return {"status": "incomplete", "cards": len(plan.get("cards", [])), "errors": [str(error)],
                    "visual_quality_verified_by_script": False}
    if not isinstance(plan, dict) or plan.get("schema_version") != 1 or plan.get("content_mode") != "image-led":
        raise ValueError("provide a version-1 image-led article plan")
    cards = plan.get("cards")
    if not isinstance(cards, list) or not cards or any(not isinstance(c, dict) for c in cards):
        raise ValueError("plan must contain image cards")
    ids = [c.get("id") for c in cards]
    if any(not isinstance(i, str) or not i.strip() for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("card ids must be unique nonempty strings")
    if [c.get("order") for c in cards] != list(range(1, len(cards) + 1)):
        errors.append("card order must be sequential starting at 1")

    review = load_json(root / "图文检查.json")
    reviewed = review.get("cards", []) if isinstance(review, dict) else []
    if not isinstance(reviewed, list) or any(not isinstance(c, dict) for c in reviewed):
        raise ValueError("review cards must be an array of objects")
    review_ids = [c.get("id") for c in reviewed]
    if len(review_ids) != len(ids) or any(review_ids.count(i) != 1 for i in ids):
        errors.append("review must contain exactly one record per planned card")

    outputs = []
    for card in cards:
        ident = card["id"]
        text = card.get("text")
        if not isinstance(text, dict) or not isinstance(text.get("title"), str) or not text["title"].strip():
            errors.append(f"{ident}: missing precise title text")
        for field in ["scene", "layout", "text_image_relation"]:
            if not isinstance(card.get(field), str) or not card[field].strip():
                errors.append(f"{ident}: missing {field}")
        rules = card.get("style_rule_ids")
        if not isinstance(rules, list) or not rules or any(not isinstance(r, str) or not r.strip() for r in rules):
            errors.append(f"{ident}: missing applied style rule ids")
        path = image_path(root, card.get("output"))
        outputs.append(card["output"])
        if not path.is_file():
            errors.append(f"{ident}: image pending")
            continue
        try:
            with Image.open(path) as im:
                im.verify()
            with Image.open(path) as im:
                if min(im.size) < 256:
                    errors.append(f"{ident}: image too small for readable body content")
                extrema = im.convert("RGB").getextrema()
                if all(low == high for low, high in extrema):
                    errors.append(f"{ident}: blank image")
        except (OSError, ValueError) as error:
            errors.append(f"{ident}: unreadable image ({type(error).__name__})")
        record = next((c for c in reviewed if c.get("id") == ident), {})
        if record.get("output_sha256") != digest(path.read_bytes()):
            errors.append(f"{ident}: review hash missing or stale")
        for field in ["text_checked", "visual_checked", "style_checked"]:
            if record.get(field) is not True:
                errors.append(f"{ident}: {field} pending")
    if len(set(outputs)) != len(outputs):
        errors.append("each card must have a distinct output")

    body = root / "article-illustrated.md"
    if not body.is_file():
        errors.append("image body pending")
    else:
        tokens = MarkdownIt().parse(body.read_text(encoding="utf-8-sig"))
        sources = []

        def collect(items):
            for token in items:
                if token.type == "image":
                    sources.append(token.attrGet("src"))
                if token.children:
                    collect(token.children)

        collect(tokens)
        if sources != outputs:
            errors.append("body images must match all planned outputs in order")
    return {"status": "files_checked" if not errors else "incomplete", "cards": len(cards),
            "errors": errors, "legacy_files_only": True, "visual_quality_verified_by_script": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("article_directory", type=Path)
    args = parser.parse_args()
    try:
        result = check(args.article_directory)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if not result["errors"] else 1
    except (ValueError, OSError) as error:
        print(json.dumps({"status": "incomplete", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
