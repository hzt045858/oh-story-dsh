"""Render a local article into an inline-styled, self-contained HTML preview."""

from __future__ import annotations

import argparse
import base64
import html
import json
import mimetypes
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

from article_library import atomic_text, contained, digest, load_json, write_json

DEFAULT = {"font_size": 16, "line_height": 1.8, "paragraph_gap": 20,
           "text_color": "#333333", "accent_color": "#24755b", "background_color": "#ffffff",
           "quote_background": "#f4f5f5", "quote_border": "#24755b"}
PRESETS = ("default", "professional-clean", "minimal", "newspaper")


def theme_values(path: Path | None, preset="default") -> dict:
    values = dict(DEFAULT)
    if preset not in PRESETS:
        raise ValueError("unknown bundled theme preset")
    if preset != "default":
        import yaml
        source = Path(__file__).resolve().parents[3] / "third_party/wewrite/themes" / (preset + ".yaml")
        colors = yaml.safe_load(source.read_text(encoding="utf-8"))["colors"]
        for key, upstream in {"text_color": "text", "accent_color": "primary", "background_color": "background",
                              "quote_background": "quote_bg", "quote_border": "quote_border"}.items():
            values[key] = colors[upstream]
    if path is not None:
        source = load_json(path)
        if not isinstance(source, dict) or set(source) - set(DEFAULT):
            raise ValueError("theme must contain supported style fields only")
        values.update(source)
    for key, low, high in (("font_size", 12, 24), ("line_height", 1.2, 2.5), ("paragraph_gap", 0, 48)):
        value = values[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
            raise ValueError(f"invalid theme field: {key}")
    for key in ("text_color", "accent_color", "background_color", "quote_background", "quote_border"):
        if not isinstance(values[key], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", values[key]):
            raise ValueError(f"{key} must be a six-digit hex color")
    return values


class InlineHTML(HTMLParser):
    def __init__(self, root: Path, theme: dict, image_mapper=None, wechat=False):
        super().__init__(convert_charrefs=False)
        self.root, self.theme, self.parts, self.images = root, theme, [], []
        self.image_mapper, self.wechat = image_mapper, wechat
        self.links, self.active_link = [], None
        self.styles = {
            "p": f"font-size:{theme['font_size']}px;line-height:{theme['line_height']};margin:0 0 {theme['paragraph_gap']}px;overflow-wrap:anywhere;",
            "h1": "font-size:24px;line-height:1.5;margin:24px 0 18px;",
            "h2": f"font-size:20px;color:{theme['accent_color']};margin:28px 0 16px;",
            "h3": "font-size:18px;margin:22px 0 12px;",
            "h4": "font-size:17px;margin:20px 0 12px;",
            "blockquote": f"margin:20px 0;padding:8px 16px;border-left:3px solid {theme['quote_border']};background:{theme['quote_background']};color:{theme['text_color']};",
            "pre": "white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f5;padding:12px;font-size:13px;",
            "code": "font-family:monospace;font-size:14px;",
            "ul": "padding-left:24px;", "ol": "padding-left:24px;", "li": "margin:8px 0;",
            "table": "border-collapse:collapse;width:100%;table-layout:fixed;font-size:14px;",
            "th": "border:1px solid #dddddd;padding:8px;overflow-wrap:anywhere;text-align:left;",
            "td": "border:1px solid #dddddd;padding:8px;overflow-wrap:anywhere;",
            "a": f"color:{theme['accent_color']};text-decoration:underline;overflow-wrap:anywhere;",
            "img": "display:block;width:auto;max-width:100%;height:auto;margin:20px auto;",
            "hr": "border:0;border-top:1px solid #dddddd;margin:24px 0;",
        }

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "img":
            src = attributes.get("src", "")
            parsed = urlsplit(src)
            if parsed.scheme or parsed.netloc:
                raise ValueError("local preview requires downloaded local images; remote/data image URLs are not embedded")
            path = contained(self.root, unquote(parsed.path))
            if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
                raise ValueError("image is missing or exceeds 16 MiB")
            mime = mimetypes.guess_type(path.name)[0]
            if mime not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                raise ValueError("unsupported article image type")
            content = path.read_bytes()
            valid = (mime == "image/png" and content.startswith(b"\x89PNG\r\n\x1a\n")) or (mime == "image/jpeg" and content.startswith(b"\xff\xd8\xff")) or (mime == "image/webp" and content[:4] == b"RIFF" and content[8:12] == b"WEBP") or (mime == "image/gif" and content[:6] in {b"GIF87a", b"GIF89a"})
            if not valid:
                raise ValueError("image bytes do not match their extension")
            attributes["src"] = self.image_mapper(path) if self.image_mapper else f"data:{mime};base64," + base64.b64encode(content).decode("ascii")
            self.images.append(str(path))
        if tag == "a":
            url = urlsplit(attributes.get("href", ""))
            if url.scheme.lower() not in {"http", "https", "mailto", ""}:
                attributes.pop("href", None)
            if self.wechat and url.hostname != "mp.weixin.qq.com":
                href = attributes.pop("href", "")
                if url.scheme in {"http", "https"} and href:
                    if href not in self.links:
                        self.links.append(href)
                    self.active_link = self.links.index(href) + 1
        if tag in self.styles:
            attributes["style"] = self.styles[tag]
        allowed = {"href", "src", "alt", "title", "style", "start"}
        serialized = "".join(f' {key}="{html.escape(str(value), quote=True)}"' for key, value in attributes.items() if key in allowed and value is not None)
        self.parts.append(f"<{tag}{serialized}>")

    def handle_endtag(self, tag):
        self.parts.append(f"</{tag}>")
        if tag == "a" and self.active_link is not None:
            self.parts.append(f"<sup>[{self.active_link}]</sup>")
            self.active_link = None

    def handle_data(self, data):
        self.parts.append(html.escape(data))

    def handle_entityref(self, name):
        self.parts.append(f"&{name};")

    def handle_charref(self, name):
        self.parts.append(f"&#{name};")


def fragment(source: Path, theme: Path | None = None, preset="default", image_mapper=None, wechat=False) -> dict:
    from markdown_it import MarkdownIt
    text = source.read_text(encoding="utf-8-sig")
    text = re.sub(r"\A---\s*\r?\n.*?\r?\n---\s*\r?\n", "", text, count=1, flags=re.S)
    if not text.strip():
        raise ValueError("article is empty")
    settings = theme_values(theme, preset)
    markdown = MarkdownIt("commonmark", {"html": False}).enable("table").enable("strikethrough")
    tokens = markdown.parse(text)
    title = source.stem
    if len(tokens) >= 3 and tokens[0].type == "heading_open" and tokens[0].tag == "h1":
        title = tokens[1].content
        if wechat:
            tokens = tokens[3:]
    if not tokens:
        raise ValueError("article has no body after its title")
    parser = InlineHTML(source.resolve().parent, settings, image_mapper, wechat)
    parser.feed(markdown.renderer.render(tokens, markdown.options, {}))
    body = "".join(parser.parts)
    if parser.links:
        body += '<section style="font-size:12px;overflow-wrap:anywhere;">' + "".join(
            f"<p>[{index}] {html.escape(url)}</p>" for index, url in enumerate(parser.links, 1)) + "</section>"
    style = f"font-size:{settings['font_size']}px;line-height:{settings['line_height']};color:{settings['text_color']};background:{settings['background_color']};font-family:system-ui,sans-serif;letter-spacing:0;overflow-wrap:anywhere;"
    return {"title": title, "content": f'<section style="{style}">{body}</section>', "images": parser.images}


def preview_document(title: str, body: str) -> str:
    return f'<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: \'self\'; style-src \'unsafe-inline\'"><title>{html.escape(title)}</title></head><body style="margin:0;padding:24px 16px;"><main style="max-width:720px;margin:auto;">{body}</main></body></html>\n'


def render(source: Path, output: Path, theme: Path | None = None, preset="default", draft=False) -> dict:
    if source.resolve() == output.resolve() or output.suffix.lower() != ".html":
        raise ValueError("output must be a separate HTML file")
    from article_workflow import has_contract, require_ready
    controlled = has_contract(source.resolve().parent)
    ready = None
    if controlled and not draft:
        ready = require_ready(source.resolve().parent)
        if source.name != "article-illustrated.md" or output.resolve() != source.resolve().parent / "article.html":
            raise ValueError("controlled export uses the reviewed article-illustrated.md and article.html")
    if controlled and draft and output.name == "article.html":
        raise ValueError("draft preview must use a separate filename; do not overwrite reviewed export")
    result = fragment(source, theme, preset)
    atomic_text(output, preview_document(result["title"], result["content"]))
    if ready is not None:
        write_json(output.with_suffix(".html.receipt.json"),
                   {"schema_version": 1, "status": "reviewed_export", "review_signature": ready["input_signature"],
                    "html_sha256": digest(output.read_bytes()), "theme": theme_values(theme, preset),
                    "source_sha256": digest(source.read_bytes()), "semantic_quality_verified_by_script": False})
    return {"output": str(output.resolve()), "images": result["images"], "status": "local_preview",
            "reviewed_export": ready is not None, "draft": draft,
            "wechat_image_upload_required": bool(result["images"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("article", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--theme", type=Path)
    parser.add_argument("--preset", choices=PRESETS, default="default")
    parser.add_argument("--draft", action="store_true", help="unreviewed local preview only; cannot overwrite article.html")
    args = parser.parse_args()
    try:
        print(json.dumps(render(args.article, args.output, args.theme, args.preset, args.draft), ensure_ascii=True, indent=2))
        return 0
    except ImportError:
        print("Install the selected Python environment's scripts/requirements.txt first.", file=sys.stderr)
        return 1
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
