"""Prepare immutable, account-bound WeChat publication bundles without network I/O."""

from __future__ import annotations

import io
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps

from article_library import account_root, contained, digest, load_json, write_json, atomic_text
from render_article import PRESETS, fragment, preview_document, theme_values


def checksum(value) -> str:
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def identifier(value, field="id") -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", value):
        raise ValueError(f"{field} must be a path-safe identifier")
    return value


def relative_path(root: Path, value) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute() or ".." in Path(value).parts:
        raise ValueError("paths must be relative and remain inside their account")
    path = contained(root, value)
    if not path.is_file() or (root / value).is_symlink():
        raise ValueError(f"missing regular input file: {value}")
    return path


def registry(path: Path) -> dict:
    value = load_json(path)
    if not isinstance(value, dict) or value.get("schema_version") != 1 or not isinstance(value.get("accounts"), list):
        raise ValueError("accounts registry requires schema_version=1 and accounts[]")
    result, roots, app_ids = {}, [], set()
    allowed = {"id", "name", "root", "app_id", "secret_env", "author", "theme_preset"}
    for entry in value["accounts"]:
        if not isinstance(entry, dict) or set(entry) - allowed:
            raise ValueError("unsupported account field; credentials belong in environment variables")
        key = identifier(entry.get("id"), "account id")
        if key in result:
            raise ValueError("duplicate account id")
        for field in ("name", "root", "app_id", "secret_env"):
            if not isinstance(entry.get(field), str) or not entry[field].strip():
                raise ValueError(f"account {key}: missing {field}")
        if not re.fullmatch(r"wx[0-9a-fA-F]{16}", entry["app_id"]):
            raise ValueError(f"account {key}: AppID must have wx followed by 16 hexadecimal characters")
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", entry["secret_env"]):
            raise ValueError("secret_env must name an environment variable, not contain a secret")
        if Path(entry["root"]).is_absolute() or ".." in Path(entry["root"]).parts:
            raise ValueError("account root must be relative to the registry directory")
        root = contained(path.resolve().parent, entry["root"])
        if root == path.resolve().parent or any(root.is_relative_to(other) or other.is_relative_to(root) for other in roots):
            raise ValueError("account roots must be distinct, non-overlapping subdirectories")
        if entry["app_id"] in app_ids:
            raise ValueError("each AppID must have one account registry entry")
        if entry.get("theme_preset", "default") not in PRESETS:
            raise ValueError("account theme_preset is not bundled")
        result[key] = {**entry, "root": root}
        roots.append(root)
        app_ids.add(entry["app_id"])
    if not result:
        raise ValueError("configure at least one account")
    return result


def due_at(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("not_before must be an ISO 8601 timestamp with a timezone")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("not_before requires a timezone, for example +08:00")
    return parsed


def read_plan(path: Path, accounts: dict) -> dict:
    plan = load_json(path)
    if not isinstance(plan, dict) or set(plan) != {"id", "jobs"}:
        raise ValueError("plan requires exactly id and jobs")
    identifier(plan["id"], "plan id")
    if not isinstance(plan["jobs"], list) or not 1 <= len(plan["jobs"]) <= 100:
        raise ValueError("plan requires 1 to 100 jobs")
    known = set()
    for job in plan["jobs"]:
        if not isinstance(job, dict) or set(job) - {"id", "account", "articles", "delivery", "audience", "not_before", "draft_media_id"}:
            raise ValueError("unsupported publication job field")
        key = identifier(job.get("id"), "job id")
        if key in known or job.get("account") not in accounts:
            raise ValueError("duplicate job id or unknown account")
        known.add(key)
        if not isinstance(job.get("articles"), list) or not 1 <= len(job["articles"]) <= 8:
            raise ValueError("each job requires 1 to 8 articles")
        if job.get("draft_media_id") is not None and (not isinstance(job["draft_media_id"], str) or not job["draft_media_id"]):
            raise ValueError("draft_media_id must identify an existing draft to update")
        if job.get("delivery", "publish") not in {"publish", "mass"}:
            raise ValueError("delivery must be publish or mass")
        if job.get("delivery") == "mass":
            audience = job.get("audience")
            if not isinstance(audience, dict) or not (
                audience == {"all": True} or
                set(audience) == {"tag_id"} and type(audience["tag_id"]) is int and audience["tag_id"] >= 0
            ):
                raise ValueError("mass delivery requires explicit audience: all=true or tag_id")
        elif "audience" in job:
            raise ValueError("audience applies only to mass delivery")
        due_at(job.get("not_before"))
    return plan


def prepare_image(path: Path) -> tuple[bytes, str]:
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("input image exceeds 32 MiB")
    content = path.read_bytes()
    with Image.open(io.BytesIO(content)) as original:
        if original.width * original.height > 40_000_000 or getattr(original, "is_animated", False):
            raise ValueError("use a static image with at most 40 million pixels")
        original.load()
        if original.format in {"PNG", "JPEG"} and len(content) < 1024 * 1024 and max(original.size) <= 2350:
            return content, ".png" if original.format == "PNG" else ".jpg"
        image = ImageOps.exif_transpose(original).convert("RGBA")
    background = Image.new("RGB", image.size, "white")
    background.paste(image, mask=image.getchannel("A"))
    background.thumbnail((2350, 2350), Image.Resampling.LANCZOS)
    for scale in (1, 0.8, 0.6, 0.4):
        resized = background.resize((max(1, int(background.width * scale)), max(1, int(background.height * scale))))
        for quality in (90, 80, 65):
            output = io.BytesIO()
            resized.save(output, "JPEG", quality=quality, optimize=True)
            if len(output.getvalue()) < 1024 * 1024:
                return output.getvalue(), ".jpg"
    raise ValueError("image could not be compressed below the body upload limit")


def bundle_path(account, plan_id, job_id):
    return contained(account["root"], f"发布/{identifier(plan_id)}/{identifier(job_id)}")


def account_identity(account):
    return {"id": account["id"], "name": account["name"], "app_id": account["app_id"]}


def text_field(value, name, maximum, required=False):
    if not isinstance(value, str) or len(value) > maximum or required and not value.strip():
        raise ValueError(f"{name} must contain {'1' if required else '0'} to {maximum} characters")
    return value


def prepare_job(account, plan_id, job) -> dict:
    # `relative_path` resolves everything it returns, so the root has to be canonical too —
    # see `account_root` for why an unresolved root fails on Windows only.
    root = account_root(account)
    files, media, blobs, articles = {}, {}, {}, []
    def remember(path):
        files[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    def image_mapper(path):
        if not path.is_relative_to(root):
            raise ValueError("article image escaped its account")
        remember(path)
        content, suffix = prepare_image(path)
        sha = digest(content)
        name = "media/" + sha + suffix
        blobs[name] = content
        media[name] = {"path": name, "sha256": sha, "bytes": len(content)}
        return name
    for index, item in enumerate(job["articles"]):
        allowed = {"article", "cover", "title", "author", "digest", "source_url", "theme", "theme_preset",
                   "reviewed", "need_open_comment", "only_fans_can_comment", "cover_crop"}
        if not isinstance(item, dict) or set(item) - allowed or item.get("reviewed") is not True:
            raise ValueError("each article must use supported fields and have reviewed=true after actual review")
        source = relative_path(root, item.get("article"))
        if source.suffix.lower() != ".md" or "发布" in source.relative_to(root).parts:
            raise ValueError("publication input must be original article Markdown outside 发布/")
        cover = relative_path(root, item.get("cover"))
        from article_workflow import publication_gate
        control = publication_gate(source, account, cover, item.get("title"))
        files.update(control.get("files", {}))
        remember(source)
        theme = relative_path(root, item["theme"]) if item.get("theme") else None
        if theme:
            remember(theme)
        preset = item.get("theme_preset", account.get("theme_preset", "default"))
        settings = theme_values(theme, preset)
        if control and settings != control["theme"]:
            raise ValueError("publication theme differs from the reviewed export; export and review the new layout")
        rendered = fragment(source, theme, preset, image_mapper=image_mapper, wechat=True)
        cover_name = image_mapper(cover)
        title = text_field(item.get("title", rendered["title"]), "title", 32, True)
        author = text_field(item.get("author", account.get("author", "")), "author", 16)
        description = text_field(item.get("digest", ""), "digest", 120)
        if control and any(term in title + author + description for term in control["forbidden_terms"]):
            raise ValueError("publication metadata reintroduced a forbidden identity/template term")
        if len(job["articles"]) > 1 and description:
            raise ValueError("digest is supported only for a single-article draft")
        content = rendered["content"]
        if not content.strip() or len(content) >= 20_000 or len(content.encode("utf-8")) >= 1024 * 1024:
            raise ValueError("rendered article must be under 20,000 characters and 1 MiB")
        source_url = item.get("source_url", "")
        from urllib.parse import urlsplit
        if not isinstance(source_url, str) or len(source_url.encode("utf-8")) > 1024 or source_url and urlsplit(source_url).scheme not in {"http", "https"}:
            raise ValueError("source_url must be an HTTP(S) URL within 1 KiB")
        article = {"title": title, "author": author, "digest": description, "content_source_url": source_url,
                   "article_type": "news", "content_file": f"article-{index + 1}.html", "cover_file": cover_name,
                   "theme": settings}
        for key in ("need_open_comment", "only_fans_can_comment"):
            if type(item.get(key, 0)) is not int or item.get(key, 0) not in (0, 1):
                raise ValueError(f"{key} must be 0 or 1")
            article[key] = item.get(key, 0)
        if article["only_fans_can_comment"] and not article["need_open_comment"]:
            raise ValueError("fans-only comments require comments to be open")
        if "cover_crop" in item:
            crops = item["cover_crop"]
            if not isinstance(crops, dict) or set(crops) - {"2.35_1", "1_1"}:
                raise ValueError("cover_crop supports 2.35_1 and 1_1 ratios")
            crop_list = []
            for ratio, values in crops.items():
                if not isinstance(values, list) or len(values) != 4 or any(type(n) not in (float, int) or not 0 <= n <= 1 for n in values):
                    raise ValueError("crop coordinates must be [x1,y1,x2,y2] in [0,1]")
                if values[0] >= values[2] or values[1] >= values[3]:
                    raise ValueError("cover crop must have a positive area")
                crop_list.append({"ratio": ratio, **dict(zip(("x1", "y1", "x2", "y2"), map(str, values)))})
            article["cover_info"] = {"crop_percent_list": crop_list}
        blobs[article["content_file"]] = content.encode("utf-8")
        blobs[f"preview-{index + 1}.html"] = preview_document(title, content).encode("utf-8")
        articles.append(article)
    document = {"schema_version": 1, "plan_id": plan_id, "job_id": job["id"],
                "account": account_identity(account), "job_hash": checksum(job),
                "delivery": job.get("delivery", "publish"), "audience": job.get("audience"),
                "not_before": job.get("not_before"), "draft_media_id": job.get("draft_media_id"),
                "articles": articles, "media": list(media.values()), "source_files": files,
                "snapshot_files": {name: digest(content) for name, content in blobs.items()}}
    document["signature"] = checksum(document)
    target = bundle_path(account, plan_id, job["id"])
    if target.exists():
        existing = load_bundle(account, plan_id, job)
        if existing["signature"] != document["signature"]:
            raise ValueError("prepared job changed; keep the old receipt and use a new job id")
        return {"job": job["id"], "account": account["id"], "bundle": str(target), "reused": True}
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".preparing-", dir=target.parent) as temporary:
        stage = Path(temporary) / "bundle"
        stage.mkdir()
        for name, content in blobs.items():
            file = contained(stage, name)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(content)
        write_json(stage / "publication.json", document)
        os.rename(stage, target)
    return {"job": job["id"], "account": account["id"], "bundle": str(target), "status": "prepared", "network_called": False}


def load_bundle(account, plan_id, job, check_sources=True):
    path = bundle_path(account, plan_id, job["id"])
    document = load_json(path / "publication.json")
    if not isinstance(document, dict):
        raise ValueError("run prepare before publishing")
    if document.get("account", {}).get("id") != account["id"] or document.get("account", {}).get("app_id") != account["app_id"]:
        raise ValueError("prepared bundle belongs to a different account or AppID")
    unsigned = {key: value for key, value in document.items() if key != "signature"}
    if checksum(unsigned) != document.get("signature") or document.get("job_hash") != checksum(job):
        raise ValueError("prepared bundle or plan changed; create a new job version")
    for name, sha in document["snapshot_files"].items():
        if digest(relative_path(path, name).read_bytes()) != sha:
            raise ValueError("prepared media or HTML changed; create a new job version")
    if check_sources:
        from article_workflow import publication_gate
        for item in job["articles"]:
            publication_gate(relative_path(account["root"], item["article"]), account,
                             relative_path(account["root"], item["cover"]), item.get("title"))
        for name, sha in document["source_files"].items():
            if digest(relative_path(account["root"], name).read_bytes()) != sha:
                raise ValueError(f"source changed after review: {name}; prepare a new job version")
    return document


def write_report(path: Path, result: dict):
    write_json(path.with_suffix(".results.json"), result)
    rows = ["# Publication Results", "", "| Account | Job | Result |", "| --- | --- | --- |"]
    for item in result["jobs"]:
        status = str(item.get("status", item.get("error", "unknown"))).replace("|", "/").replace("\n", " ")
        rows.append(f"| {item['account']} | {item['job']} | {status} |")
    atomic_text(path.with_suffix(".results.md"), "\n".join(rows) + "\n")
