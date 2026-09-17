"""Offline ingestion regression tests. No live OCR, credentials or network calls."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import article_library as library
import article_ingest as ingestion


class FakeOCR:
    signature = "fixture-v1"

    def __init__(self):
        self.calls = 0

    def __call__(self, path):
        self.calls += 1
        return [{"text": "图片正文，不是分析完成", "score": 0.72, "box": [[0, 0], [20, 0], [20, 10], [0, 10]]}]


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.account = self.root / "account"
        self.ocr = FakeOCR()
        Image.new("RGB", (80, 90), (30, 70, 120)).save(self.source / "图片.png")

    def put(self, name, content):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def ingest(self, **kwargs):
        return ingestion.ingest(self.account, self.source, recognizer=self.ocr, **kwargs)

    def records(self):
        return library.load_json(self.account / ingestion.MANIFEST)["articles"]

    def test_order_reference_markdown_html_and_original_unchanged(self):
        src = self.put("a.md", '# 标题\n前文\n![first][p]\n中间\n<img src="图片.png">\n后文\n\n[p]: 图片.png "caption"\n')
        before = src.read_bytes()
        result = self.ingest()
        row = self.records()[0]
        self.assertEqual(len(row["images"]), 2)
        self.assertEqual([x["order"] for x in row["images"]], [1, 2])
        body = (self.account / row["extracted_file"]).read_text(encoding="utf-8")
        self.assertLess(body.index("前文"), body.index("图片正文"))
        self.assertLess(body.index("中间"), body.rindex("图片正文"))
        self.assertLess(body.rindex("图片正文"), body.index("后文"))
        self.assertEqual(self.ocr.calls, 1)
        self.assertFalse(result["analysis_completed"])
        self.assertFalse(row["visual_reviewed"])
        self.assertEqual(row["status"], "review_pending")
        self.assertEqual(src.read_bytes(), before)
        self.assertEqual(row["source_sha256"], library.digest(before))

    def test_html_only_includes_wechat_body_and_lazy_images(self):
        self.put("a.html", '<title>Title</title><img src="outside.png"><div id="js_content"><p>Before</p><img src="pixel.png" data-src="图片.png"><script><img src="evil.png"></script><p>After</p></div><img src="footer.png">')
        self.ingest()
        row = self.records()[0]
        self.assertEqual([i["reference"] for i in row["images"]], ["图片.png"])
        self.assertEqual(row["status"], "review_pending")

    def test_resume_reuses_ocr_but_image_change_invalidates(self):
        self.put("a.md", "![body](图片.png)")
        self.ingest()
        old = self.records()[0]["analysis_input_sha256"]
        self.ingest()
        self.assertEqual(self.ocr.calls, 1)
        self.assertEqual(old, self.records()[0]["analysis_input_sha256"])
        Image.new("RGB", (80, 90), (70, 10, 120)).save(self.source / "图片.png")
        self.ingest()
        self.assertEqual(self.ocr.calls, 2)
        self.assertNotEqual(old, self.records()[0]["analysis_input_sha256"])

    def test_missing_image_does_not_block_other_articles(self):
        self.put("a.md", "before ![missing](missing.png) after")
        self.put("b.md", "Complete text article")
        self.ingest()
        rows = self.records()
        self.assertEqual(rows[0]["status"], "extraction_pending")
        self.assertEqual(rows[1]["status"], "text_ready")
        self.assertIn("missing", rows[0]["images"][0]["error"])

    def test_remote_is_opt_in_and_local_escape_blocked(self):
        for n, ref in enumerate(["https://mmbiz.qpic.cn/a.png", "../secret.png", "file:///secret.png", "//localhost/a.png", "C:/secret.png"]):
            self.put(f"{n}.md", f"![image](<{ref}>)")
        with patch.object(ingestion, "download_image", side_effect=AssertionError("must not access network")):
            self.ingest()
        self.assertTrue(all(r["status"] == "extraction_pending" for r in self.records()))

    def test_url_allowlist_and_public_address_validation(self):
        for url in ["http://mmbiz.qpic.cn/x", "https://localhost/x", "https://mmbiz.qpic.cn.evil.test/x", "https://user:secret@mmbiz.qpic.cn/x", "https://mmbiz.qpic.cn:444/x"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                ingestion.validate_remote_url(url)
        self.assertEqual(ingestion.validate_remote_url("https://mmbiz.qpic.cn/a?x=1").hostname, "mmbiz.qpic.cn")
        with patch.object(ingestion.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaisesRegex(ValueError, "public"):
                ingestion.download_image("https://mmbiz.qpic.cn/x")

    def test_scan_and_index_cannot_mark_missing_image_body_ready(self):
        self.put("a.md", "![body](missing.png)")
        library.scan(self.account, self.source)
        row = library.load_json(self.account / library.CATALOG)["articles"][0]
        self.assertTrue(row["has_image_references"])
        self.annotate(row)
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1})

    def annotate(self, row, **extra):
        library.write_json(self.account / library.ANNOTATIONS, [{
            "id": row["id"], "source_sha256": row["source_sha256"],
            "primary_category": "职场", "subtopic": "边界", "expression_task": "判断",
            "core_question": "如何回应", "core_claim": "明确边界", "structure": "场景与行动",
            "keywords": [], "identity_terms": [], "platform_template_flag": False,
            "author_identity_flag": False, **extra}])

    def test_index_requires_current_analysis_hash_and_review(self):
        self.put("a.md", "![body](图片.png)")
        self.ingest()
        row = self.records()[0]
        self.annotate(row, analysis_input_sha256=row["analysis_input_sha256"])
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1})
        self.annotate(row, analysis_input_sha256=row["analysis_input_sha256"], content_reviewed=True, visual_reviewed=True)
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1})
        from joint_selftest import joint_fixture
        import article_joint as joint
        relative = f"{joint.BASE}/{row['id']}.json"
        library.write_json(self.account / relative, joint_fixture(row))
        self.annotate(row, analysis_input_sha256=row["analysis_input_sha256"], content_reviewed=True, visual_reviewed=True,
                      joint_analysis_file=relative, joint_analysis_sha256=library.digest((self.account / relative).read_bytes()))
        self.assertEqual(library.build_index(self.account)["counts"], {"ready": 1})
        found = library.retrieve(self.account, ids=[row["id"]])
        self.assertIn("图片正文", found["references"][0]["body"])
        Image.new("RGB", (80, 90), "red").save(self.source / "图片.png")
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1})

    def test_extracted_view_tampering_is_not_accepted(self):
        self.put("a.md", "![body](图片.png)")
        self.ingest()
        row = self.records()[0]
        self.annotate(row, analysis_input_sha256=row["analysis_input_sha256"], content_reviewed=True, visual_reviewed=True)
        (self.account / row["extracted_file"]).write_text("tampered", encoding="utf-8")
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1})

    def test_missing_dependency_is_pending_not_empty_success(self):
        self.put("a.md", "![body](图片.png)")
        class Missing:
            signature = "missing"
            def __call__(self, path):
                raise ValueError("OCR dependency missing")
        ingestion.ingest(self.account, self.source, recognizer=Missing())
        self.assertEqual(self.records()[0]["status"], "extraction_pending")

    def test_limit_resume_and_original_ids_survive(self):
        for n in range(3):
            self.put(f"{n}.md", f"Text {n} ![body](图片.png)")
        result = self.ingest(limit=1)
        self.assertEqual(result["remaining"], 2)
        result = self.ingest(limit=1)
        self.assertEqual(result["remaining"], 1)
        result = self.ingest(limit=1)
        self.assertEqual(result["remaining"], 0)
        self.assertEqual(self.ocr.calls, 1)

    def test_generated_outputs_do_not_reenter_source(self):
        self.account = self.source
        self.put("a.md", "![body](图片.png)")
        self.ingest()
        self.ingest()
        rows = library.load_json(self.account / library.CATALOG)["articles"]
        self.assertEqual(len(rows), 1)

    def test_engine_version_invalidates_cached_text(self):
        self.put("a.md", "![body](图片.png)")
        self.ingest()
        self.ocr.signature = "fixture-v2"
        self.ingest()
        self.assertEqual(self.ocr.calls, 2)

    def test_image_decompression_and_empty_files_are_rejected(self):
        (self.source / "empty.png").write_bytes(b"")
        (self.source / "fake.png").write_text("not a picture")
        self.put("a.md", "![empty](empty.png) ![fake](fake.png)")
        self.ingest()
        self.assertEqual(self.records()[0]["status"], "extraction_pending")
        self.assertEqual(self.ocr.calls, 0)

    def test_corrupted_ocr_cache_is_recomputed(self):
        self.put("a.md", "![body](图片.png)")
        self.ingest()
        cache = next((self.account / ingestion.BASE / "ocr").glob("*.json"))
        cache.write_text("{broken", encoding="utf-8")
        (self.account / self.records()[0]["extracted_file"]).unlink()
        self.ingest()
        self.assertEqual(self.ocr.calls, 2)
        self.assertEqual(self.records()[0]["status"], "review_pending")

    def test_html_image_only_body_is_not_lost_as_empty_text(self):
        self.put("a.html", '<div id="js_content"><img data-src="图片.png"></div>')
        self.ingest()
        self.assertEqual(len(self.records()[0]["images"]), 1)
        self.assertEqual(self.records()[0]["status"], "review_pending")

    def test_animated_images_require_explicit_processing(self):
        frames = [Image.new("RGB", (80, 90), c) for c in ["red", "blue"]]
        frames[0].save(self.source / "animated.gif", save_all=True, append_images=frames[1:], duration=100, loop=0)
        self.put("a.md", "![body](animated.gif)")
        self.ingest()
        self.assertEqual(self.records()[0]["status"], "extraction_pending")

    def test_lock_does_not_get_removed_by_a_second_process(self):
        target = self.account / ingestion.BASE
        target.mkdir(parents=True)
        lock = target / ".ingest.lock"
        lock.write_text("99999")
        with self.assertRaisesRegex(ValueError, "lock"):
            self.ingest()
        self.assertTrue(lock.exists())

    def test_legacy_catalog_without_image_flag_cannot_bypass_review(self):
        self.put("a.md", "![body](图片.png)")
        library.scan(self.account, self.source)
        catalog = library.load_json(self.account / library.CATALOG)
        row = catalog["articles"][0]
        row.pop("has_image_references")
        library.write_json(self.account / library.CATALOG, catalog)
        self.annotate(row)
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1})


if __name__ == "__main__":
    unittest.main()
