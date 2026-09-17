"""Offline tests for user-supplied image import. No API or actual generated samples."""
import tempfile
import unittest
from pathlib import Path
from PIL import Image, ImageDraw
from article_library import load_json, write_json, digest
from import_article_image import import_image


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.article = self.root / "article"
        self.article.mkdir()
        self.source = self.root / "supplied.png"
        im = Image.new("RGB", (400, 600), "white")
        ImageDraw.Draw(im).rectangle((60, 60, 300, 500), fill="teal")
        im.save(self.source)
        self.plan = {"schema_version": 1, "content_mode": "image-led", "cards": [
            {"id": "card-01", "order": 1, "output": "images/card-01-v1.png"}]}
        write_json(self.article / "图文计划.json", self.plan)

    def test_import_preserves_original_and_does_not_invent_review_or_provider(self):
        before = digest(self.source.read_bytes())
        result = import_image(self.article, "card-01", self.source, "chatgpt-image")
        self.assertEqual(result["status"], "review_pending")
        self.assertFalse(result["provider_dispatched"])
        self.assertFalse(result["visual_checked"])
        self.assertEqual(digest(self.source.read_bytes()), before)
        self.assertEqual(digest((self.article / "images/card-01-v1.png").read_bytes()), before)
        self.assertFalse((self.article / "图文检查.json").exists())

    def test_repeat_import_does_not_overwrite(self):
        import_image(self.article, "card-01", self.source, "manual")
        with self.assertRaises(ValueError):
            import_image(self.article, "card-01", self.source, "manual")

    def test_existing_api_receipt_is_not_overwritten_or_deleted(self):
        receipt = self.article / "images/card-01-v1.png.import.json"
        receipt.parent.mkdir()
        receipt.write_text("prior receipt", encoding="utf-8")
        with self.assertRaises(ValueError):
            import_image(self.article, "card-01", self.source, "manual")
        self.assertEqual(receipt.read_text(), "prior receipt")

    def test_missing_or_duplicate_card_is_rejected(self):
        with self.assertRaises(ValueError):
            import_image(self.article, "card-02", self.source, "manual")
        self.plan["cards"].append(dict(self.plan["cards"][0]))
        write_json(self.article / "图文计划.json", self.plan)
        with self.assertRaises(ValueError):
            import_image(self.article, "card-01", self.source, "manual")

    def test_escape_and_format_mismatch_are_rejected(self):
        for output in ["../secret.png", "images/../../secret.png", "C:/x.png", "images/x.jpg", "other/x.png"]:
            self.plan["cards"][0]["output"] = output
            write_json(self.article / "图文计划.json", self.plan)
            with self.assertRaises(ValueError):
                import_image(self.article, "card-01", self.source, "manual")

    def test_blank_and_thumbnail_do_not_pass_as_body_images(self):
        for size in [(1, 1), (400, 600)]:
            Image.new("RGB", size, "white").save(self.source)
            with self.assertRaises(ValueError):
                import_image(self.article, "card-01", self.source, "manual")


if __name__ == "__main__":
    unittest.main()
