"""Preserve original articles while preparing ordered, auditable image-body views.

OCR prepares text for review; it never certifies reading, visual analysis or style.
Network image acquisition is opt-in and limited to the WeChat image CDN.
"""
from __future__ import annotations

import http.client
import importlib.metadata
import io
import ipaddress
import json
import math
import os
import re
import socket
import ssl
import tempfile
import warnings
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlsplit

from article_library import ArticleHTML, CATALOG, SYSTEM, atomic_text, contained, digest, load_json, read_article, scan, write_json

BASE = f"{SYSTEM}/00_项目说明/图文提取"
MANIFEST = f"{BASE}/manifest.json"
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 40_000_000
MAX_IMAGES_PER_ARTICLE = 128
PIPELINE_VERSION = "image-body-v1"
ALLOWED_HOSTS = frozenset({"mmbiz.qpic.cn"})


def json_hash(value) -> str:
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())


def atomic_bytes(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(data)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_utf8_or_gb(data: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("unsupported source encoding")


class ImageDocument(ArticleHTML):
    def __init__(self, marker):
        super().__init__()
        self.marker = marker
        self.images = []

    def handle_starttag(self, tag, attrs):
        if tag == "img":
            parent = self.stack[-1] if self.stack else ("", False, False, False, False)
            if parent[1] or parent[4]:
                return
            attr = dict(attrs)
            self.images.append({"reference": attr.get("data-src") or attr.get("src") or "", "alt": attr.get("alt") or ""})
            self.handle_data(f"\n{self.marker}{len(self.images) - 1}@@\n")
            return
        super().handle_starttag(tag, attrs)


def article_view(path: Path):
    """Return a plain-text template and image occurrences, never execute HTML."""
    title, original_body, source_sha = read_article(path)
    if path.suffix.lower() not in {".md", ".html", ".htm"}:
        if path.suffix.lower() == ".docx":
            import zipfile
            with zipfile.ZipFile(path) as archive:
                if any(name.startswith("word/media/") for name in archive.namelist()):
                    raise ValueError("DOCX embedded images need a format-specific extraction tool")
        return title, original_body, [], source_sha
    raw = read_utf8_or_gb(path.read_bytes())
    if path.suffix.lower() == ".md":
        try:
            from markdown_it import MarkdownIt
        except ImportError as error:
            raise ValueError("Markdown parser missing; install scripts/requirements.txt in this Python environment") from error
        markdown = MarkdownIt("commonmark", {"html": True})
        # This renderer is ONLY parsed as inert data below. Every resulting URL is
        # validated before file/network access, including normally rejected schemes.
        markdown.validateLink = lambda value: True
        raw = markdown.render(original_body)
    marker = "@@WX_IMAGE_" + source_sha + "_"
    while marker in raw:
        marker += "x"
    parser = ImageDocument(marker)
    try:
        parser.feed(raw)
        parser.close()
    except AssertionError as error:
        raise ValueError("invalid article HTML") from error
    selected = parser.wechat_text if parser.has_wechat else parser.article_text if parser.has_article else parser.all_text
    template = "".join(selected).strip()
    images = []
    for match in re.finditer(re.escape(marker) + r"(\d+)@@", template):
        images.append({**parser.images[int(match.group(1))], "marker": match.group(0), "order": len(images) + 1})
    if len(images) > MAX_IMAGES_PER_ARTICLE:
        raise ValueError("too many image occurrences in one article; review input before extraction")
    return title, template, images, source_sha


def validate_remote_url(value):
    if any(ord(c) < 32 for c in value):
        raise ValueError("invalid image URL")
    url = urlsplit(value)
    if (url.scheme != "https" or url.hostname not in ALLOWED_HOSTS or url.port not in (None, 443)
            or url.username is not None or url.password is not None or url.fragment):
        raise ValueError("remote images require HTTPS on the allowed WeChat image CDN")
    return url


def download_image(value: str) -> bytes:
    url = validate_remote_url(value)
    addresses = socket.getaddrinfo(url.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError("image CDN must resolve only to public addresses")
    # Pin the validated address for this connection; no proxy, redirect or second
    # DNS resolution that could turn a public URL into access to a private service.
    connection = http.client.HTTPSConnection(url.hostname, timeout=15)
    sock = socket.create_connection((addresses[0][4][0], 443), timeout=15)
    try:
        connection.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=url.hostname)
        connection.request("GET", (url.path or "/") + ("?" + url.query if url.query else ""), headers={"User-Agent": "OhStory-ImageIngest/1", "Accept": "image/*"})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError(f"image CDN returned HTTP {response.status}; redirects are not followed")
        if int(response.getheader("Content-Length", "0")) > MAX_IMAGE_BYTES:
            raise ValueError("remote image exceeds 16 MiB")
        data = response.read(MAX_IMAGE_BYTES + 1)
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValueError("empty or oversized remote image")
        return data
    finally:
        connection.close()
        sock.close()


def image_info(data: bytes) -> dict:
    from PIL import Image
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("empty image or image exceeds 16 MiB")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP", "GIF"}:
                    raise ValueError("unsupported image format")
                if image.width * image.height > MAX_PIXELS:
                    raise ValueError("image pixel budget exceeded")
                info = {"width": image.width, "height": image.height, "format": image.format,
                        "frames": getattr(image, "n_frames", 1)}
                image.verify()
                return info
        except (OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
            raise ValueError("invalid or unsafe image data") from error


def local_image(source_root: Path, article: Path, reference: str) -> Path:
    value = unquote(reference)
    url = urlsplit(value)
    if not value or url.scheme or url.netloc or value.startswith(("/", "\\")) or "\\" in value or any(ord(c) < 32 for c in value):
        raise ValueError("image path must be relative to the source article")
    # A query on an exported local file is not part of its filesystem name.
    original = article.parent / url.path
    resolved = original.resolve()
    if not resolved.is_relative_to(source_root):
        raise ValueError("image path escapes source root")
    current = original
    while current != source_root and current != current.parent:
        if current.is_symlink():
            raise ValueError("symlink image inputs are not allowed")
        current = current.parent
    if not resolved.is_file():
        raise ValueError("image file missing")
    if resolved.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("image exceeds 16 MiB")
    return resolved


def acquire_image(account, source_root, article, reference, allow_remote=False, refresh_remote=False):
    if reference.startswith(("https:", "http:", "//")):
        url = validate_remote_url(reference)
        if not allow_remote:
            raise ValueError("remote image acquisition is disabled; explicitly allow CDN downloads")
        pointer = contained(account, f"{BASE}/remote/{digest(reference.encode())}.json")
        try:
            cached = load_json(pointer, {})
        except (ValueError, OSError):
            cached = {}
        data = None
        if (not refresh_remote and re.fullmatch(r"[a-f0-9]{64}", str(cached.get("image_sha256", "")))
                and cached.get("extension") in {"png", "jpg", "webp", "gif"}):
            stored = contained(account, f"{BASE}/images/{cached['image_sha256']}.{cached['extension']}")
            if stored.is_file() and stored.stat().st_size <= MAX_IMAGE_BYTES:
                content = stored.read_bytes()
                if digest(content) == cached["image_sha256"]:
                    data = content
        if data is None:
            data = download_image(reference)
        source = {"source_kind": "remote", "remote_host": url.hostname}
    else:
        path = local_image(source_root, article, reference)
        data = path.read_bytes()
        source = {"source_kind": "local", "source_image": path.relative_to(source_root).as_posix()}
    metadata = image_info(data)
    sha = digest(data)
    extension = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp", "GIF": "gif"}[metadata["format"]]
    asset = f"{BASE}/images/{sha}.{extension}"
    destination = contained(account, asset)
    if not destination.is_file() or digest(destination.read_bytes()) != sha:
        atomic_bytes(destination, data)
    if source["source_kind"] == "remote":
        write_json(pointer, {"image_sha256": sha, "extension": extension})
    return {**source, **metadata, "image_sha256": sha, "asset_file": asset}, destination


def checked_lines(lines):
    if not isinstance(lines, list) or len(lines) > 10000:
        raise ValueError("invalid OCR result lines")
    clean = []
    for line in lines:
        if not isinstance(line, dict) or not isinstance(line.get("text"), str) or len(line["text"]) > 20000:
            raise ValueError("invalid OCR text")
        score = line.get("score")
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("invalid OCR confidence")
        clean.append({"text": line["text"], "score": float(score), "box": line.get("box")})
    json_hash(clean)  # Reject non-JSON / non-finite geometry as well.
    return clean


class RapidRecognizer:
    """Lazy optional offline OCR. Never auto-install dependencies or upload images."""
    def __init__(self):
        try:
            version = importlib.metadata.version("rapidocr-onnxruntime")
        except importlib.metadata.PackageNotFoundError:
            version = "missing"
        self.signature = f"rapidocr-onnxruntime:{version}:default:{PIPELINE_VERSION}"
        self.engine = None

    def __call__(self, path):
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as error:
            raise ValueError("OCR dependency missing; install requirements-ocr.txt in the selected Python environment") from error
        if self.engine is None:
            self.engine = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
        result, _elapsed = self.engine(str(path))
        return [{"text": row[1], "score": float(row[2]), "box": row[0].tolist() if hasattr(row[0], "tolist") else row[0]} for row in (result or [])]


def recognize(account, image, recognizer):
    sha = image["image_sha256"]
    cache_path = contained(account, f"{BASE}/ocr/{sha}-{digest(recognizer.signature.encode())[:16]}.json")
    try:
        cached = load_json(cache_path, {})
    except (ValueError, OSError):
        cached = {}
    if (cached.get("image_sha256") == sha and cached.get("engine") == recognizer.signature
            and cached.get("lines_sha256") == json_hash(cached.get("lines"))):
        return checked_lines(cached["lines"]), True
    lines = checked_lines(recognizer(contained(account, image["asset_file"])))
    write_json(cache_path, {"schema_version": 1, "image_sha256": sha, "engine": recognizer.signature,
                           "lines": lines, "lines_sha256": json_hash(lines), "reviewed": False})
    return lines, False


def signature_of(record):
    images = []
    for image in record["images"]:
        item = {key: image.get(key) for key in ("order", "reference", "image_sha256", "ocr_sha256", "status")}
        if "frame_views" in image:
            item["frame_views"] = image["frame_views"]
        images.append(item)
    return json_hash({"version": PIPELINE_VERSION, "source_sha256": record["source_sha256"],
                      "engine": record["engine"], "extracted_sha256": record["extracted_sha256"],
                      "images": images})


def visual_frames(account, image):
    """Save every composited animation frame within a bounded decoding budget.

    These are source-derived observations, not generated artwork or OCR results.
    Repeated pixels reuse files while every timed occurrence remains in order.
    """
    from PIL import Image
    import io
    if image["frames"] > 200 or image["width"] * image["height"] * image["frames"] > 80_000_000:
        raise ValueError("animation exceeds 200 frames or 80MP total; use an explicitly bounded media review")
    views, elapsed = [], 0
    source = contained(account, image["asset_file"])
    with Image.open(source) as animation:
        for index in range(image["frames"]):
            animation.seek(index)
            frame = animation.convert("RGBA")
            frame.load()
            buffer = io.BytesIO()
            frame.save(buffer, "PNG")
            data = buffer.getvalue()
            sha = digest(data)
            relative = f"{BASE}/frames/{image['image_sha256']}/{sha}.png"
            path = contained(account, relative)
            if not path.is_file() or digest(path.read_bytes()) != sha:
                atomic_bytes(path, data)
            duration = animation.info.get("duration", 0)
            if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
                duration = 0
            duration = int(duration)
            views.append({"index": index + 1, "asset_file": relative, "frame_sha256": sha,
                          "start_ms": elapsed, "duration_ms": duration})
            elapsed += duration
    return views


def valid_record(account, source_root, physical, record, engine=None):
    try:
        if (not record or record.get("source_sha256") != physical.get("source_sha256")
                or record.get("status") not in {"text_ready", "review_pending"}
                or (engine is not None and record.get("engine") != engine)):
            return False
        original = contained(source_root, physical["source_file"])
        if digest(original.read_bytes()) != record["source_sha256"]:
            return False
        view = contained(account, record["extracted_file"])
        if not view.is_file() or digest(view.read_bytes()) != record["extracted_sha256"]:
            return False
        if signature_of(record) != record["analysis_input_sha256"]:
            return False
        for image in record["images"]:
            asset = contained(account, image["asset_file"])
            if not asset.is_file() or digest(asset.read_bytes()) != image["image_sha256"]:
                return False
            if image.get("frames", 1) > 1:
                views = image.get("frame_views", [])
                if len(views) != image["frames"] or [v.get("index") for v in views] != list(range(1, image["frames"] + 1)):
                    return False
                for frame in views:
                    path = contained(account, frame["asset_file"])
                    if not path.is_file() or digest(path.read_bytes()) != frame["frame_sha256"]:
                        return False
            if image["source_kind"] == "local":
                current = local_image(source_root, original, image["reference"])
                if digest(current.read_bytes()) != image["image_sha256"]:
                    return False
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def extraction_for(account, physical):
    manifest = load_json(contained(account, MANIFEST), {})
    root = Path(manifest.get("source_root", ".")).resolve()
    record = next((r for r in manifest.get("articles", []) if r.get("id") == physical["id"]), None)
    return record if valid_record(account, root, physical, record) else None


def ingest(account: Path, source: Path, *, recognizer=None, allow_remote=False, refresh_remote=False, limit=0, visual_only=False):
    if not isinstance(limit, int) or limit < 0:
        raise ValueError("limit must be a nonnegative article count")
    account, source = account.resolve(), source.resolve()
    target = contained(account, BASE)
    target.mkdir(parents=True, exist_ok=True)
    lock = contained(account, f"{BASE}/.ingest.lock")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise ValueError("ingestion lock exists; verify its PID has exited before removing this lock") from error
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
        scan(account, source)
        catalog = load_json(contained(account, CATALOG))
        if visual_only:
            # Do not initialize OCR or pretend empty OCR means an image has no text.
            from types import SimpleNamespace
            recognizer = SimpleNamespace(signature="visual-only:v1")
        else:
            recognizer = recognizer or RapidRecognizer()
        manifest = load_json(contained(account, MANIFEST), {})
        if manifest and manifest.get("source_root") != str(source):
            raise ValueError("extraction is bound to another source root")
        records = {r["id"]: r for r in manifest.get("articles", [])}
        physical = catalog["articles"]
        pending = []
        reused = 0
        for row in physical:
            if row["read_status"] != "readable":
                records[row["id"]] = {"id": row["id"], "source_sha256": row.get("source_sha256"),
                                      "status": "source_pending", "error": row.get("error", row["read_status"])}
            elif not refresh_remote and valid_record(account, source, row, records.get(row["id"]), recognizer.signature):
                reused += 1
            else:
                pending.append(row)
        # New/changed records first; a persistently missing asset must not starve
        # untouched articles when a user resumes with a small --limit.
        pending.sort(key=lambda row: row["id"] in records)
        processed = 0
        ocr_reused = 0

        def persist():
            write_json(contained(account, MANIFEST), {"schema_version": 1, "source_root": str(source),
                       "articles": [records[r["id"]] for r in physical if r["id"] in records],
                       "analysis_completed": False, "visual_analysis_completed": False})

        for row in pending[:limit or None]:
            result = {"id": row["id"], "source_sha256": row.get("source_sha256"), "source_file": row["source_file"],
                      "engine": recognizer.signature, "images": [], "visual_reviewed": False, "content_reviewed": False}
            try:
                path = contained(source, row["source_file"])
                title, template, images, sha = article_view(path)
                if sha != row["source_sha256"]:
                    raise ValueError("source changed during extraction; rerun ingest")
                result["title"] = title
                for ref in images:
                    image = {k: v for k, v in ref.items() if k != "marker"}
                    try:
                        acquired, _asset = acquire_image(account, source, path, ref["reference"], allow_remote, refresh_remote)
                        image.update(acquired)
                        if visual_only:
                            if image["frames"] > 1:
                                image["frame_views"] = visual_frames(account, image)
                            image.update(ocr_performed=False, ocr_lines=0, status="visual_ready",
                                         visual_reviewed=False, text_reviewed=False, low_confidence_lines=[])
                            replacement = f"\n【图片{ref['order']}：必须阅读实际原图及所有帧；未执行OCR，不代表没有文字】\n"
                        elif image["frames"] > 1:
                            raise ValueError("animated image requires frame-aware review; a first-frame OCR is not full content")
                        else:
                            lines, cached = recognize(account, image, recognizer)
                            ocr_reused += int(cached)
                            image.update(ocr_sha256=json_hash(lines), ocr_lines=len(lines),
                                         low_confidence_lines=[n + 1 for n, line in enumerate(lines) if line["score"] < 0.85],
                                         status="ocr_extracted", visual_reviewed=False, text_reviewed=False)
                            text = "\n".join(line["text"] for line in lines)
                            replacement = f"\n【图片{ref['order']} OCR，待核对】\n{text or '【未识别到文字，需看图确认】'}\n【图片{ref['order']}结束】\n"
                    except Exception as error:
                        # No credentials are read and no raw provider response is retained.
                        image.update(status="pending", error=str(error)[:300])
                        replacement = f"\n【图片{ref['order']}未完成提取；不能计为全文已读】\n"
                    result["images"].append(image)
                    template = template.replace(ref["marker"], replacement, 1)
                if digest(path.read_bytes()) != sha:
                    raise ValueError("source changed during extraction; rerun ingest")
                content = template.strip() + "\n"
                extracted_sha = digest(content.encode("utf-8"))
                output = f"{BASE}/text/{row['id']}-{extracted_sha[:16]}.md"
                atomic_text(contained(account, output), content)
                result.update(extracted_file=output, extracted_sha256=extracted_sha,
                              status="extraction_pending" if any(i["status"] == "pending" for i in result["images"])
                              else "review_pending" if images else "text_ready")
                result["analysis_input_sha256"] = signature_of(result)
            except (ValueError, OSError, ImportError, KeyError) as error:
                result.update(status="extraction_pending", error=str(error)[:300])
            records[row["id"]] = result
            processed += 1
            persist()  # A completed article survives interruption of the next one.
        persist()
        return {"manifest": str(contained(account, MANIFEST)), "processed": processed, "reused_articles": reused,
                "ocr_cache_hits": ocr_reused, "remaining": len(pending) - processed,
                "counts": dict(Counter(records[row["id"]]["status"] if row["id"] in records else "pending" for row in physical)),
                "analysis_completed": False, "visual_analysis_completed": False,
                "visual_only": visual_only,
                "note": "Original images/frames and optional OCR are unreviewed inputs, not completed semantic/visual analysis."}
    finally:
        lock.unlink(missing_ok=True)
