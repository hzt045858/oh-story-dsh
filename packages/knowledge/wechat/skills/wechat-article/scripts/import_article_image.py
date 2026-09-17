"""Import one supplied image into an existing card plan, without claiming generation or review."""
from __future__ import annotations

import argparse
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image
from article_library import contained, digest, load_json, write_json


def import_image(article: Path, card_id: str, source: Path, origin: str = "manual") -> dict:
    article = article.resolve()
    if origin not in {"manual", "chatgpt-image", "external-model"}:
        raise ValueError("origin must describe the supplied image, not an invented API receipt")
    plan_path = contained(article, "图文计划.json")
    plan = load_json(plan_path)
    if (not isinstance(plan, dict) or plan.get("schema_version") not in {1, 2}
            or plan.get("content_mode") not in {"text", "mixed", "image-led"}):
        raise ValueError("a card/illustration/cover plan is required before importing")
    control = None
    if plan.get("schema_version") == 2 or (article / "任务输入.json").exists() or (article / "创作记录.json").exists():
        from article_workflow import current
        state = current(article)
        if card_id not in state["card_signatures"]:
            raise ValueError("image is not part of the locked task")
        control = {"workflow": "controlled-wechat-v1", "account_id": state["account_id"],
                   "card_id": card_id, "input_signature": state["card_signatures"][card_id]}
    cards = plan.get("cards")
    if not isinstance(cards, list) or not all(isinstance(c, dict) for c in cards):
        raise ValueError("plan cards must be objects")
    matches = [c for c in cards if c.get("id") == card_id]
    if len(matches) != 1:
        raise ValueError("select one unique card ID from the plan")
    name = matches[0].get("output")
    if (not isinstance(name, str) or not name.startswith("images/") or "\\" in name or ":" in name
            or any(p in {"", ".", ".."} for p in name.split("/"))):
        raise ValueError("planned output must be a safe versioned path under images/")
    output = contained(article, name)
    receipt_path = contained(article, name + ".import.json")
    if output.exists() or receipt_path.exists():
        raise ValueError("output or import receipt already exists; preserve it and choose a new plan version")
    if source.is_symlink() or not source.is_file() or not 0 < source.stat().st_size <= 32 * 1024 * 1024:
        raise ValueError("supply an existing regular image of at most 32 MiB")
    data = source.read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        fmt = image.format
        if fmt != {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP"}.get(output.suffix.lower()):
            raise ValueError("image bytes and planned output extension do not match")
        width, height = image.size
        if min(width, height) < 256 or width * height > 32_000_000 or getattr(image, "n_frames", 1) != 1:
            raise ValueError("body image must be static, at least 256px on each axis and at most 32MP")
        image.load()
        extrema = image.convert("RGB").getextrema()
        if all(low == high for low, high in extrema):
            raise ValueError("blank image is not a completed body card")
    if control:
        from article_workflow import image_requirements
        image_requirements(source, matches[0]["requirements"])
    receipt = {"schema_version": 1, "card_id": card_id, "output": name,
               "output_sha256": digest(data), "plan_sha256": digest(plan_path.read_bytes()),
               "origin_declared_by_importer": origin, "provider_dispatched": False,
               "width": width, "height": height, "status": "import_pending",
               "text_checked": False, "visual_checked": False, "style_checked": False,
               "imported_at": datetime.now(timezone.utc).isoformat()}
    if control:
        receipt["control"] = control
    output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive receipts and output writes never replace adopted files or API receipts.
    with receipt_path.open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, ensure_ascii=False, indent=2)
    try:
        with output.open("xb") as handle:
            handle.write(data)
    except OSError as error:
        receipt["status"] = "import_interrupted"
        write_json(receipt_path, receipt)
        raise ValueError("import interrupted; inspect output and receipt before retrying") from error
    receipt["status"] = "review_pending"
    write_json(receipt_path, receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--article", type=Path, required=True)
    parser.add_argument("--card", required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--origin", choices=("manual", "chatgpt-image", "external-model"), default="manual")
    args = parser.parse_args()
    try:
        print(json.dumps(import_image(args.article, args.card, args.source, args.origin), ensure_ascii=True, indent=2))
        return 0
    except (ValueError, OSError, TypeError, KeyError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
