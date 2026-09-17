"""Read-only corpus audit, Agent annotation merge, and full-article retrieval."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import zipfile
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

SYSTEM = "作者风格系统"
CATALOG = f"{SYSTEM}/00_项目说明/资料清单.json"
ANNOTATIONS = f"{SYSTEM}/01_全量索引/文章标注.json"
INDEX = f"{SYSTEM}/01_全量索引/文章全量索引.json"
GENERATED = {SYSTEM, "创作", "排版", "发布"}
EXCLUDED = {".git", "node_modules", "__pycache__"}
FORMATS = {".md", ".txt", ".html", ".htm", ".docx"}
NEEDS_EXTRACTION = {".pdf", ".rtf"}
MAX_BYTES = 16 * 1024 * 1024
FIELDS = (
    "primary_category", "subtopic", "expression_task", "audience", "title_formula",
    "structure", "tone", "core_question", "core_claim", "keywords", "variant_group",
    "duplicate_status", "time_period", "publish_date", "author", "source_type",
    "platform_template_flag", "author_identity_flag", "identity_terms", "quality_notes", "confidence",
    "analysis_input_sha256", "content_reviewed", "visual_reviewed",
    "joint_analysis_file", "joint_analysis_sha256",
)
REQUIRED = {"primary_category", "subtopic", "expression_task", "core_question", "core_claim", "structure"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(content)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path: Path, value) -> None:
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def contained(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("path escapes its root")
    return path


def account_root(account) -> Path:
    """The canonical root of an account registry entry.

    `registry()` already resolves the root it derives, but an account dictionary assembled by a
    caller can carry a Windows 8.3 short name (the runners hand out `RUNNER~1` where the long
    name is `runneradmin`). Everything this package compares against the root comes back from
    `resolve()`, so an unresolved root makes `relative_to` raise "is not in the subpath of" on
    Windows only — the check that should have passed, fails.
    """
    return Path(account["root"]).resolve()


# Up to Python 3.12 `_markupbase` raised AssertionError for a marked section whose status
# keyword it did not recognise. Python 3.13 stopped reporting it and silently drops the section,
# so a malformed export would be scanned as a readable article instead of being counted
# unreadable. The scan has to reject the same documents on every interpreter, so the rule is
# spelled out here rather than left to the standard library. The keywords are compared exactly
# the way `_markupbase` compares them: case-sensitively.
MARKED_SECTION = re.compile(r"<!\[([A-Za-z][A-Za-z0-9]*)")
MARKED_SECTION_STATUS = frozenset({"temp", "cdata", "ignore", "include", "rcdata", "if", "else", "endif"})


def malformed_markup(body: str) -> str | None:
    match = MARKED_SECTION.search(body)
    if match is None or match.group(1) in MARKED_SECTION_STATUS:
        return None
    return f"unknown status keyword {match.group(1)!r} in marked section"


class ArticleHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.all_text = []
        self.article_text = []
        self.wechat_text = []
        self.title_text = []
        self.has_article = False
        self.has_wechat = False

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        hidden = tag in {"script", "style", "nav", "footer", "header", "noscript"}
        parent = self.stack[-1] if self.stack else ("", False, False, False, False)
        wechat = parent[2] or attr.get("id") == "js_content"
        article = parent[3] or tag == "article"
        title = parent[4] or tag == "title"
        self.has_wechat |= wechat
        self.has_article |= article
        if tag == "img" and not parent[1] and not parent[4]:
            reference = attr.get("data-src") or attr.get("src") or ""
            self.handle_data(f"\n![image](<{reference}>)\n")
        if tag not in {"br", "img", "meta", "link", "input", "hr", "source", "wbr", "area", "base", "embed", "param", "track", "col"}:
            self.stack.append((tag, hidden or parent[1], wechat, article, title))
        if tag in {"p", "div", "section", "h1", "h2", "h3", "li", "br", "tr"}:
            self.handle_data("\n")

    def handle_endtag(self, tag):
        if tag in {"p", "div", "section", "h1", "h2", "h3", "li", "tr"}:
            self.handle_data("\n")
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        state = self.stack[-1] if self.stack else ("", False, False, False, False)
        if state[4]:
            self.title_text.append(data)
        if state[1] or state[4]:
            return
        self.all_text.append(data)
        if state[2]:
            self.wechat_text.append(data)
        if state[3]:
            self.article_text.append(data)


def read_article(path: Path) -> tuple[str, str, str]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError("not a regular readable article, or larger than 16 MiB")
    data = path.read_bytes()
    suffix = path.suffix.lower()
    title = path.stem
    if suffix == ".docx":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > MAX_BYTES:
                raise ValueError("DOCX document XML exceeds 16 MiB")
            tree = ElementTree.fromstring(archive.read(info))
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            body = "\n".join("".join(p.itertext()) for p in tree.findall(".//w:p", ns))
    else:
        for encoding in ("utf-8-sig", "gb18030"):
            try:
                body = data.decode(encoding)
                break
            except UnicodeDecodeError:
                pass
        else:
            raise ValueError("unsupported text encoding")
        if suffix in {".html", ".htm"}:
            parser = ArticleHTML()
            try:
                parser.feed(body)
            except AssertionError as error:
                raise ValueError(f"invalid HTML: {error}") from error
            malformed = malformed_markup(body)
            if malformed is not None:
                raise ValueError(f"invalid HTML: {malformed}")
            parts = parser.wechat_text if parser.has_wechat else parser.article_text if parser.has_article else parser.all_text
            body = "".join(parts)
            title = "".join(parser.title_text).strip() or title
        elif suffix == ".md":
            body = re.sub(r"\A---\s*\r?\n.*?\r?\n---\s*\r?\n", "", body, count=1, flags=re.S)
            heading = re.search(r"^#\s+(.+)$", body, re.M)
            if heading:
                title = heading.group(1).strip()
    body = body.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not body:
        raise ValueError("empty extracted body")
    return title, body, digest(data)


def has_image_references(path: Path, body: str) -> bool:
    # Conservative scan without requiring OCR/Markdown dependencies. The ingest
    # parser later distinguishes real images from code examples and HTML chrome.
    if path.suffix.lower() == ".docx":
        with zipfile.ZipFile(path) as archive:
            return any(name.startswith("word/media/") for name in archive.namelist())
    return bool(re.search(r"!\[|<img\b", body, re.I))


def scan(account: Path, source: Path) -> dict:
    account, source = account.resolve(), source.resolve()
    if not source.is_dir():
        raise ValueError("source directory does not exist")
    catalog_path = contained(account, CATALOG)
    if catalog_path.is_relative_to(source) and SYSTEM not in catalog_path.relative_to(source).parts:
        raise ValueError("generated files must be outside the source corpus")
    old = load_json(catalog_path, {})
    if old and old["source_root"] != str(source):
        raise ValueError("account is bound to another source root; use a separate account")
    previous = {row["source_file"]: row for row in old.get("articles", [])}
    next_id = max((int(row["id"].split("-")[1]) for row in previous.values()), default=0)
    rows, excluded, seen, hashes = [], [], set(), {}
    generated_roots = tuple(account / name for name in GENERATED)
    for path in sorted(source.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(source)
        if path.is_symlink() or not path.resolve().is_relative_to(source):
            excluded.append({"path": relative.as_posix(), "reason": "symlink or outside source"})
            continue
        if not path.is_file():
            continue
        if any(path.is_relative_to(root) for root in generated_roots):
            excluded.append({"path": relative.as_posix(), "reason": "generated account output"})
            continue
        if any(part in EXCLUDED for part in relative.parts):
            excluded.append({"path": relative.as_posix(), "reason": "tool or dependency file"})
            continue
        if path.suffix.lower() not in FORMATS | NEEDS_EXTRACTION:
            excluded.append({"path": relative.as_posix(), "reason": "non-body file"})
            continue
        name = relative.as_posix()
        seen.add(name)
        existing = previous.get(name)
        if existing is None:
            next_id += 1
        row = {"id": existing["id"] if existing else f"ART-{next_id:03d}", "source_file": name,
               "source_path": str(path), "file_format": path.suffix.lower(), "read_status": "unreadable"}
        try:
            if path.suffix.lower() in NEEDS_EXTRACTION:
                raise ValueError("needs a format-specific extraction tool")
            title, body, sha = read_article(path)
            body_hash = digest(re.sub(r"\s+", "", body).encode("utf-8"))
            row.update(title=title, source_sha256=sha, body_sha256=body_hash,
                       body_char_count=len(re.sub(r"\s+", "", body)), read_status="readable",
                       duplicate_of=hashes.get(body_hash), has_image_references=has_image_references(path, body))
            hashes.setdefault(body_hash, row["id"])
        except (ValueError, OSError, KeyError, zipfile.BadZipFile, ElementTree.ParseError) as error:
            row["error"] = str(error)
        rows.append(row)
    rows.extend({**row, "read_status": "missing"} for name, row in previous.items() if name not in seen)
    document = {"schema_version": 1, "source_root": str(source),
                "scanned_at": datetime.now(timezone.utc).isoformat(), "articles": rows, "excluded": excluded}
    write_json(catalog_path, document)
    return {"catalog": str(catalog_path), "counts": dict(Counter(row["read_status"] for row in rows)),
            "exact_duplicates": sum(bool(row.get("duplicate_of")) for row in rows if row["read_status"] == "readable"),
            "excluded": len(excluded), "analysis_completed": False}


def build_index(account: Path) -> dict:
    catalog = load_json(contained(account, CATALOG))
    if catalog is None:
        raise ValueError("run scan first")
    annotations = load_json(contained(account, ANNOTATIONS), [])
    if not isinstance(annotations, list):
        raise ValueError("annotations must be a JSON array")
    known = {row["id"] for row in catalog["articles"]}
    by_id = {}
    for item in annotations:
        if not isinstance(item, dict) or item.get("id") not in known or item["id"] in by_id:
            raise ValueError("annotation has an unknown or duplicate article ID")
        if any(not isinstance(item.get(key), str) or not item[key].strip() for key in REQUIRED):
            raise ValueError(f"{item['id']}: required semantic fields must be non-empty strings")
        for key in ("keywords", "identity_terms"):
            if not isinstance(item.get(key), list) or not all(isinstance(term, str) for term in item[key]):
                raise ValueError(f"{item['id']}: {key} must be a string array")
        for key in ("platform_template_flag", "author_identity_flag"):
            if not isinstance(item.get(key), bool):
                raise ValueError(f"{item['id']}: {key} must be boolean")
        by_id[item["id"]] = item
    rows = []
    for physical in catalog["articles"]:
        physical = dict(physical)
        if physical["read_status"] == "readable" and "has_image_references" not in physical:
            # Catalogs produced before image ingestion did not have this field.
            # Missing metadata must not allow image-only sources to bypass review.
            try:
                source_path = contained(Path(catalog["source_root"]), physical["source_file"])
                _, body, current_sha = read_article(source_path)
                physical["has_image_references"] = has_image_references(source_path, body)
                if current_sha != physical.get("source_sha256"):
                    physical["read_status"] = "changed"
            except (ValueError, OSError, KeyError, zipfile.BadZipFile, ElementTree.ParseError):
                physical["read_status"] = "unreadable"
        item = by_id.get(physical["id"])
        valid = physical["read_status"] == "readable" and item is not None and item.get("source_sha256") == physical.get("source_sha256")
        image_pending = False
        if valid and physical.get("has_image_references"):
            from article_ingest import extraction_for
            extraction = extraction_for(account, physical)
            valid = extraction is not None and item.get("analysis_input_sha256") == extraction.get("analysis_input_sha256")
            if valid and extraction.get("images"):
                valid = item.get("content_reviewed") is True and item.get("visual_reviewed") is True
                if valid:
                    from article_joint import annotation_ready
                    valid = annotation_ready(account, physical, item)
            image_pending = not valid
        row = {**physical, "annotation_status": "ready" if valid else "pending"}
        if valid:
            row.update({key: item.get(key) for key in FIELDS})
        else:
            row["pending_reason"] = ("image body missing/stale or content/visual/joint evidence review pending" if image_pending
                                     else "unreadable/missing source, missing annotation, or changed source hash")
        rows.append(row)
    index = {"schema_version": 1, "source_root": catalog["source_root"], "articles": rows}
    path = contained(account, INDEX)
    write_json(path, index)
    output = io.StringIO(newline="")
    columns = ["id", "source_file", "source_path", "file_format", "title", "body_char_count", "source_sha256", "read_status", "annotation_status", "duplicate_of", *FIELDS]
    writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({key: json.dumps(value, ensure_ascii=False) if isinstance(value, (list, dict)) else value for key, value in row.items()})
    atomic_text(path.with_suffix(".csv"), output.getvalue())
    return {"index": str(path), "counts": dict(Counter(row["annotation_status"] for row in rows))}


def retrieve(account: Path, category="", task="", subtopic="", audience="", keywords=(), limit=5, ids=()) -> dict:
    if not 3 <= limit <= 5:
        raise ValueError("reference limit must be between 3 and 5")
    if ids and (len(ids) > limit or len(set(ids)) != len(ids)):
        raise ValueError("explicit IDs must be unique and fit the limit")
    index = load_json(contained(account, INDEX))
    if index is None:
        raise ValueError("run index first")
    if not category and not ids:
        raise ValueError("provide a routed category or explicit reference IDs")
    eligible = [row for row in index["articles"] if row["annotation_status"] == "ready" and row["read_status"] == "readable"]
    def rank(row):
        return (row.get("primary_category") == category, row.get("expression_task") == task,
                bool(subtopic) and row.get("subtopic") == subtopic,
                bool(audience) and row.get("audience") == audience,
                len(set(keywords) & set(row.get("keywords") or [])), str(row.get("publish_date") or ""))
    if ids:
        by_id = {row["id"]: row for row in eligible}
        if any(article_id not in by_id for article_id in ids):
            raise ValueError("explicit reference is missing or its annotation is pending")
        candidates = [by_id[article_id] for article_id in ids]
    else:
        candidates = sorted([row for row in eligible if row["primary_category"] == category], key=rank, reverse=True)
    selected, rejected, hashes = [], [], set()
    source_root = Path(index["source_root"]).resolve()
    # Prefer two close references and then a different structure in the same topic.
    while candidates and len(selected) < limit:
        pick = 0
        if not ids and len(selected) == 2:
            structures = {row.get("structure") for row in selected}
            pick = next((n for n, row in enumerate(candidates) if row.get("structure") not in structures), 0)
        row = candidates.pop(pick)
        try:
            if row.get("duplicate_status") == "完全重复":
                raise ValueError("reference is marked as an exact duplicate")
            title, body, sha = read_article(contained(source_root, row["source_file"]))
            if sha != row["source_sha256"]:
                raise ValueError("source changed; scan and re-analyze this article")
            if row.get("has_image_references") or has_image_references(contained(source_root, row["source_file"]), body):
                from article_ingest import extraction_for
                extraction = extraction_for(account, row)
                if extraction is None or extraction["analysis_input_sha256"] != row.get("analysis_input_sha256"):
                    raise ValueError("image body changed or extraction missing; ingest and review before retrieval")
                from article_joint import annotation_ready
                if not annotation_ready(account, row, row):
                    raise ValueError("whole-article joint evidence is missing or stale; review before retrieval")
                body = contained(account, extraction["extracted_file"]).read_text(encoding="utf-8")
            if row["body_sha256"] in hashes:
                raise ValueError("same complete body already selected")
            hashes.add(row["body_sha256"])
            selected.append({**row, "title": title, "body": body, "match": list(rank(row))})
        except (ValueError, OSError, KeyError, zipfile.BadZipFile, ElementTree.ParseError) as error:
            rejected.append({"id": row["id"], "reason": str(error)})
    return {"references": selected, "rejected": rejected, "count": len(selected),
            "needs_review": len(selected) < 3,
            "note": "Agent must validate topic fit, template boundaries, model evidence, and diversity; bodies are complete, not summaries."}


def status(account: Path) -> dict:
    catalog = load_json(contained(account, CATALOG), {"articles": []})
    index = load_json(contained(account, INDEX), {"articles": []})
    from article_ingest import MANIFEST
    extraction = load_json(contained(account, MANIFEST), {"articles": []})
    return {"scan_counts": dict(Counter(row["read_status"] for row in catalog["articles"])),
            "index_counts": dict(Counter(row["annotation_status"] for row in index["articles"])),
            "extraction_counts": dict(Counter(row["status"] for row in extraction["articles"])),
            "image_articles": sum(bool(row.get("has_image_references")) for row in catalog["articles"]),
            "global_model_exists": contained(account, f"{SYSTEM}/04_作者稳定风格/作者稳定风格模型.md").is_file(),
            "state_file_exists": contained(account, f"{SYSTEM}/07_处理状态/处理状态.md").is_file(),
            "note": "Counts are from the last scan/index. Model content and evidence still require Agent review."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("scan", "ingest", "index", "retrieve", "status"):
        command = commands.add_parser(name)
        command.add_argument("--account", type=Path, required=True)
        if name in {"scan", "ingest"}:
            command.add_argument("--source", type=Path, required=True)
        if name == "ingest":
            command.add_argument("--visual-only", action="store_true", help="prepare actual images/all bounded animation frames without requiring OCR")
            command.add_argument("--allow-remote-images", action="store_true")
            command.add_argument("--refresh-remote-images", action="store_true")
            command.add_argument("--limit", type=int, default=0, help="maximum articles for this invocation; 0 means all")
        if name == "retrieve":
            for flag in ("category", "task", "subtopic", "audience", "keywords", "ids"):
                command.add_argument("--" + flag, default="")
            command.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()
    try:
        if args.command == "scan":
            result = scan(args.account, args.source)
        elif args.command == "ingest":
            if args.refresh_remote_images and not args.allow_remote_images:
                raise ValueError("refreshing remote images requires --allow-remote-images")
            from article_ingest import ingest
            result = ingest(args.account, args.source, allow_remote=args.allow_remote_images,
                            refresh_remote=args.refresh_remote_images, limit=args.limit, visual_only=args.visual_only)
        elif args.command == "index":
            result = build_index(args.account)
        elif args.command == "status":
            result = status(args.account)
        else:
            result = retrieve(args.account, args.category, args.task, args.subtopic, args.audience,
                              [term.strip() for term in args.keywords.split(",") if term.strip()], args.limit,
                              [item.strip() for item in args.ids.split(",") if item.strip()])
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
