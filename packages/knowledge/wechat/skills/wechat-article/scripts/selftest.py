"""Offline behavioral checks using isolated articles and mocked image dispatch."""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import article_images as images
import article_library as library
import render_article as renderer
import check_image_article as image_article
from PIL import Image, ImageDraw

ADAPTER = Path(__file__).resolve().parents[4] / "drama/skills/short-drama-produce/scripts/provider_adapters.py"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=")


class ImageArticleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wechat-image-body-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "images/card-01.png"
        self.output.parent.mkdir()
        self.plan = {"schema_version": 1, "content_mode": "image-led", "cards": [{
            "id": "card-01", "order": 1, "text": {"title": "A new idea"},
            "scene": "An employee leaves the desk", "layout": "Title above scene",
            "text_image_relation": "The action illustrates a boundary", "style_rule_ids": ["V-01"],
            "output": "images/card-01.png"}]}
        library.write_json(self.root / "图文计划.json", self.plan)
        (self.root / "article-illustrated.md").write_text("# Article\n\n![Card](images/card-01.png)\n", encoding="utf-8")

    def make_reviewed_fixture(self):
        canvas = Image.new("RGB", (300, 400), "white")
        ImageDraw.Draw(canvas).rectangle((30, 80, 250, 330), fill="teal")
        canvas.save(self.output)
        library.write_json(self.root / "图文检查.json", {"cards": [{
            "id": "card-01", "output_sha256": library.digest(self.output.read_bytes()),
            "text_checked": True, "visual_checked": True, "style_checked": True}]})

    def test_text_and_plan_without_images_stay_incomplete(self):
        result = image_article.check(self.root)
        self.assertEqual(result["status"], "incomplete")
        self.assertIn("card-01: image pending", result["errors"])

    def test_reviewed_file_passes_only_file_checks(self):
        self.make_reviewed_fixture()
        result = image_article.check(self.root)
        self.assertEqual(result["errors"], [])
        self.assertFalse(result["visual_quality_verified_by_script"])

    def test_modified_image_invalidates_review_and_blank_is_rejected(self):
        self.make_reviewed_fixture()
        Image.new("RGB", (300, 400), "white").save(self.output)
        result = image_article.check(self.root)
        self.assertIn("card-01: review hash missing or stale", result["errors"])
        self.assertIn("card-01: blank image", result["errors"])

    def test_missing_body_reference_and_pending_review_fail(self):
        self.make_reviewed_fixture()
        (self.root / "article-illustrated.md").write_text("Only text", encoding="utf-8")
        review = library.load_json(self.root / "图文检查.json")
        review["cards"][0]["visual_checked"] = False
        library.write_json(self.root / "图文检查.json", review)
        result = image_article.check(self.root)
        self.assertIn("body images must match all planned outputs in order", result["errors"])
        self.assertIn("card-01: visual_checked pending", result["errors"])

    def test_output_cannot_escape_article(self):
        self.plan["cards"][0]["output"] = "images/../../outside.png"
        library.write_json(self.root / "图文计划.json", self.plan)
        with self.assertRaises(ValueError):
            image_article.check(self.root)


class ArticleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wechat-article-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "reference"
        self.account = self.root / "account"
        self.source.mkdir()

    def put(self, name, text):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def catalog(self):
        return library.load_json(self.account / library.CATALOG)["articles"]

    def annotated(self, count=5):
        for index in range(count):
            self.put(f"{index}.md", f"# Article {index}\n\nA complete example about work {index}.\n\nEnd of article {index}.")
        library.scan(self.account, self.source)
        annotations = []
        for index, row in enumerate(self.catalog()):
            annotations.append({"id": row["id"], "source_sha256": row["source_sha256"],
                                "primary_category": "work", "subtopic": "leadership", "expression_task": "judgment",
                                "audience": "employees", "structure": "scene" if index < 3 else "comparison",
                                "core_question": "What happened?", "core_claim": "Observe repeated changes.",
                                "keywords": ["leadership"], "identity_terms": ["OriginalAccount"],
                                "platform_template_flag": True, "author_identity_flag": True,
                                "publish_date": f"2026-08-{20-index:02d}", "confidence": "high"})
        library.write_json(self.account / library.ANNOTATIONS, annotations)
        library.build_index(self.account)
        return annotations

    def test_scan_keeps_source_and_manual_models_and_stable_ids(self):
        first = self.put("a.md", "Original article")
        original = first.read_bytes()
        library.scan(self.account, self.source)
        first_id = self.catalog()[0]["id"]
        model = self.account / library.SYSTEM / "manual-model.md"
        model.write_text("Human edit", encoding="utf-8")
        first.unlink()
        self.put("b.md", "Another article")
        library.scan(self.account, self.source)
        rows = {row["source_file"]: row for row in self.catalog()}
        self.assertEqual(rows["a.md"]["read_status"], "missing")
        self.assertNotEqual(rows["b.md"]["id"], first_id)
        first.write_bytes(original)
        library.scan(self.account, self.source)
        self.assertEqual(next(row for row in self.catalog() if row["source_file"] == "a.md")["id"], first_id)
        self.assertEqual(first.read_bytes(), original)
        self.assertEqual(model.read_text(), "Human edit")

    def test_excludes_generated_material_and_reports_unreadable(self):
        self.account = self.source
        self.put("a.md", "Reference article")
        self.put("创作/draft.md", "Generated article")
        self.put("作者风格系统/report.md", "Generated analysis")
        self.put("a.pdf", "Needs PDF extractor")
        self.put("cover.png", "Not a body")
        result = library.scan(self.account, self.source)
        self.assertEqual(result["counts"], {"readable": 1, "unreadable": 1})
        self.assertFalse(result["analysis_completed"])
        excluded = library.load_json(self.account / library.CATALOG)["excluded"]
        self.assertEqual({row["path"] for row in excluded}, {"创作/draft.md", "作者风格系统/report.md", "cover.png"})
        library.build_index(self.account)
        self.assertEqual(library.retrieve(self.account, "work")["references"], [])

    def test_external_reference_directories_are_not_treated_as_account_outputs(self):
        names = ["ordinary.md", "创作/original.md", "archive/排版/original.md", "发布/original.md", "作者风格系统/original.md"]
        for name in names:
            self.put(name, f"Original reference: {name}")
        self.put("node_modules/ignored.md", "Dependency documentation")
        result = library.scan(self.account, self.source)
        self.assertEqual(result["counts"], {"readable": len(names)})
        self.assertEqual({row["source_file"] for row in self.catalog()}, set(names))
        excluded = library.load_json(self.account / library.CATALOG)["excluded"]
        self.assertEqual([row["path"] for row in excluded], ["node_modules/ignored.md"])

    def test_only_current_account_outputs_are_excluded_from_parent_source(self):
        self.account = self.source / "account"
        self.put("account/创作/generated.md", "Generated article")
        self.put("archive/创作/original.md", "Original reference")
        result = library.scan(self.account, self.source)
        self.assertEqual(result["counts"], {"readable": 1})
        self.assertEqual(self.catalog()[0]["source_file"], "archive/创作/original.md")
        self.assertEqual(result["excluded"], 1)

    def test_malformed_html_is_reported_without_aborting_scan(self):
        self.put("a.md", "Readable original")
        bad = self.put("bad.html", "<![bad]><article>Broken export</article>")
        result = library.scan(self.account, self.source)
        self.assertEqual(result["counts"], {"readable": 1, "unreadable": 1})
        rows = {row["source_file"]: row for row in self.catalog()}
        self.assertIn("HTML", rows["bad.html"]["error"])
        with self.assertRaisesRegex(ValueError, "HTML"):
            library.read_article(bad)
        self.put("bad.html", "<article>Repaired export</article>")
        self.assertEqual(library.scan(self.account, self.source)["counts"], {"readable": 2})
        self.assertEqual(next(row["id"] for row in self.catalog() if row["source_file"] == "bad.html"), rows["bad.html"]["id"])

    def test_html_uses_wechat_body_and_excludes_scripts(self):
        file = self.put("a.html", '<html><head><title>Title</title></head><body>Menu<div id="js_content"><p>First paragraph</p><script>bad()</script><p>Second paragraph</p></div>Advertisement</body></html>')
        title, body, _ = library.read_article(file)
        self.assertEqual(title, "Title")
        self.assertIn("First paragraph", body)
        self.assertIn("Second paragraph", body)
        self.assertNotIn("Advertisement", body)
        self.assertNotIn("bad()", body)

    def test_full_text_retrieval_keeps_two_matches_and_diverse_structure(self):
        self.annotated()
        found = library.retrieve(self.account, "work", "judgment", limit=3)
        self.assertEqual([row["structure"] for row in found["references"]], ["scene", "scene", "comparison"])
        self.assertEqual(found["count"], 3)
        for row in found["references"]:
            self.assertEqual(row["body"], Path(row["source_path"]).read_text().strip())
        self.assertEqual(library.retrieve(self.account, "unrelated")["count"], 0)

    def test_changed_source_is_rejected_without_a_rescan(self):
        self.annotated(3)
        self.put("0.md", "Changed reference")
        found = library.retrieve(self.account, "work", "judgment")
        self.assertEqual(found["count"], 2)
        self.assertTrue(found["needs_review"])
        self.assertIn("source changed", found["rejected"][0]["reason"])
        annotation_bytes = (self.account / library.ANNOTATIONS).read_bytes()
        library.scan(self.account, self.source)
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1, "ready": 2})
        self.assertEqual((self.account / library.ANNOTATIONS).read_bytes(), annotation_bytes)

    def test_duplicate_bodies_are_not_returned_twice(self):
        annotations = self.annotated(3)
        self.put("copy.md", (self.source / "0.md").read_text())
        library.scan(self.account, self.source)
        copied = next(row for row in self.catalog() if row["source_file"] == "copy.md")
        annotations.append({**annotations[0], "id": copied["id"], "source_sha256": copied["source_sha256"]})
        library.write_json(self.account / library.ANNOTATIONS, annotations)
        library.build_index(self.account)
        self.assertEqual(library.retrieve(self.account, "work")["count"], 3)

    def test_marked_cross_format_duplicate_is_not_a_reference(self):
        annotations = self.annotated(3)
        self.put("copy.html", '<title>Article 0</title><div id="js_content"><p>A complete example about work 0.</p><p>End of article 0.</p></div>')
        library.scan(self.account, self.source)
        copied = next(row for row in self.catalog() if row["source_file"] == "copy.html")
        annotations.append({**annotations[0], "id": copied["id"], "source_sha256": copied["source_sha256"],
                            "duplicate_status": "完全重复", "publish_date": "2026-09-09"})
        library.write_json(self.account / library.ANNOTATIONS, annotations)
        library.build_index(self.account)
        automatic = library.retrieve(self.account, "work")
        self.assertEqual(automatic["count"], 3)
        self.assertNotIn(copied["id"], [row["id"] for row in automatic["references"]])
        explicit = library.retrieve(self.account, ids=[annotations[0]["id"], annotations[1]["id"], copied["id"]])
        self.assertEqual(explicit["count"], 2)
        self.assertTrue(explicit["needs_review"])
        self.assertIn("exact duplicate", explicit["rejected"][0]["reason"])
        annotations[-1]["duplicate_status"] = "近似重复"
        library.write_json(self.account / library.ANNOTATIONS, annotations)
        library.build_index(self.account)
        self.assertEqual(library.retrieve(self.account, "work")["count"], 4)

    def test_unknown_duplicate_annotations_and_path_escape_fail(self):
        annotations = self.annotated(3)
        library.write_json(self.account / library.ANNOTATIONS, annotations + [annotations[0]])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            library.build_index(self.account)
        with self.assertRaises(ValueError):
            library.contained(self.account, "../outside.md")
        with self.assertRaises(ValueError):
            library.retrieve(self.account, "work", limit=20)

    def make_image_job(self):
        (self.root / "article.md").write_text("A workplace article", encoding="utf-8")
        (self.root / "prompt.md").write_text("A quiet office scene, no text", encoding="utf-8")
        job = {"id": "cover-v1", "article_file": "article.md", "prompt_file": "prompt.md",
               "article_sha256": library.digest((self.root / "article.md").read_bytes()),
               "prompt_sha256": library.digest((self.root / "prompt.md").read_bytes()),
               "output": "images/cover-v1.png", "references": [], "parameters": {"size": "1536x1024"}}
        path = self.root / "cover-v1.json"
        library.write_json(path, job)
        return path

    def test_image_preflight_does_not_dispatch_and_detects_stale_prompt(self):
        job = self.make_image_job()
        result = images.execute(job, ADAPTER, runner=lambda *_args, **_kwargs: self.fail("network dispatch during preflight"))
        self.assertFalse(result["dispatched"])
        self.assertFalse(job.with_suffix(".receipt.json").exists())
        original = library.load_json(job)
        library.write_json(job, {**original, "output": ""})
        with self.assertRaisesRegex(ValueError, "relative image path"):
            images.execute(job, ADAPTER)
        library.write_json(job, original)
        (self.root / "prompt.md").write_text("Changed", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "prompt_sha256"):
            images.execute(job, ADAPTER)

    def test_image_success_is_reused_without_a_second_request(self):
        job = self.make_image_job()
        calls = []
        def runner(*_args, **kwargs):
            payload = json.loads(kwargs["input"])
            calls.append(payload)
            output = Path(payload["output_root"]) / "result.png"
            output.write_bytes(PNG)
            return SimpleNamespace(returncode=0, stdout=json.dumps({"outputs": [{"target": payload["outputs"][0], "source": str(output)}], "provider_job_id": "test-request-1"}).encode())
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-only-not-a-credential"}):
            receipt = images.execute(job, ADAPTER, run=True, runner=runner)
            self.assertEqual(receipt["status"], "succeeded")
            self.assertEqual(receipt["provider_job_id"], "test-request-1")
            self.assertIn("completed_at", receipt)
            self.assertTrue(images.execute(job, ADAPTER, run=True, runner=runner)["reused"])
        self.assertEqual(len(calls), 1)
        self.assertEqual((self.root / "images/cover-v1.png").read_bytes(), PNG)

    def test_image_failure_preserves_safe_diagnostics_without_raw_provider_output(self):
        job = self.make_image_job()
        safe = {"request_id": "req_reconcile_123", "category": "provider_response",
                "code": "invalid_image_data", "http_status": 502, "retryable": True}
        private = "private-provider-response-and-credential"
        response = {"error": {**safe, "provider": "gpt-image-2", "message": private,
                              "body": {"authorization": private}}, "debug": private}
        calls = []
        def runner(*_args, **_kwargs):
            calls.append(True)
            return SimpleNamespace(returncode=1, stdout=json.dumps(response).encode(), stderr=private.encode())
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-only-not-a-credential"}):
            with self.assertRaisesRegex(ValueError, "uncertain") as failure:
                images.execute(job, ADAPTER, run=True, runner=runner)
            receipt = library.load_json(job.with_suffix(".receipt.json"))
            self.assertEqual(receipt.get("provider_error"), safe)
            self.assertEqual(receipt["status"], "dispatched_unknown")
            self.assertTrue(receipt["dispatched"])
            self.assertNotIn(private, json.dumps(receipt) + str(failure.exception))
            with self.assertRaisesRegex(ValueError, "reconciliation"):
                images.execute(job, ADAPTER, run=True, runner=runner)
        self.assertEqual(len(calls), 1)

    def test_image_failure_without_safe_diagnostics_stays_unknown_and_cannot_retry(self):
        private = "private-provider-response-and-credential"
        responses = [private.encode(), b"\xff", b"{}", b"[]", b'{"error":null}',
                     json.dumps({"error": {"message": private, "request_id": {"value": private},
                                           "category": [private], "code": "Bearer " + private,
                                           "http_status": True, "retryable": private}}).encode()]
        for index, response in enumerate(responses):
            with self.subTest(response=index):
                job = self.make_image_job().rename(self.root / f"failure-{index}.json")
                calls = []
                def runner(*_args, **_kwargs):
                    calls.append(True)
                    return SimpleNamespace(returncode=1, stdout=response, stderr=private.encode())
                with patch.dict(os.environ, {"OPENAI_API_KEY": "test-only-not-a-credential"}):
                    with self.assertRaisesRegex(ValueError, "uncertain") as failure:
                        images.execute(job, ADAPTER, run=True, runner=runner)
                    receipt = library.load_json(job.with_suffix(".receipt.json"))
                    self.assertEqual(receipt["status"], "dispatched_unknown")
                    self.assertTrue(receipt["dispatched"])
                    self.assertNotIn("provider_error", receipt)
                    self.assertNotIn(private, json.dumps(receipt) + str(failure.exception))
                    with self.assertRaisesRegex(ValueError, "reconciliation"):
                        images.execute(job, ADAPTER, run=True, runner=runner)
                self.assertEqual(len(calls), 1)

    def test_unknown_image_dispatch_cannot_be_retried_automatically(self):
        job = self.make_image_job()
        def timed_out(*_args, **_kwargs):
            raise subprocess.TimeoutExpired("test", 360)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-only-not-a-credential"}):
            with self.assertRaisesRegex(ValueError, "uncertain"):
                images.execute(job, ADAPTER, run=True, runner=timed_out)
            with self.assertRaisesRegex(ValueError, "reconciliation"):
                images.execute(job, ADAPTER, run=True, runner=timed_out)

    @unittest.skipUnless(importlib.util.find_spec("markdown_it"), "install scripts/requirements.txt for HTML rendering checks")
    def test_render_uses_parser_embeds_images_and_escapes_source_html(self):
        image = self.source / "figure.png"
        image.write_bytes(PNG)
        source = self.put("article.md", '# Title\n\n<script>alert(1)</script>\n\n**Text**\n\n![A figure](figure.png)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
        result = renderer.render(source, self.root / "preview.html")
        html = (self.root / "preview.html").read_text()
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("<strong>Text</strong>", html)
        self.assertIn("data:image/png;base64,", html)
        self.assertIn("<table style=", html)
        self.assertTrue(result["wechat_image_upload_required"])
        self.put("escape.md", "![secret](../outside.png)")
        with self.assertRaises(ValueError):
            renderer.render(self.source / "escape.md", self.root / "bad.html")

    def test_theme_cannot_inject_css(self):
        theme = self.root / "theme.json"
        library.write_json(theme, {"text_color": "red;position:fixed"})
        with self.assertRaises(ValueError):
            renderer.theme_values(theme)


if __name__ == "__main__":
    unittest.main()
