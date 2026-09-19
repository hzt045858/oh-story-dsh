"""Synthetic corpus tests; no real author is declared analyzed by this suite."""
from __future__ import annotations

import copy
import shutil
import tempfile
import unittest
from pathlib import Path

from article_library import ANNOTATIONS, CATALOG, digest, load_json, scan, write_json
from article_workflow import checksum
from controlled_selftest import assessment
import style_release


class StyleReleaseTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="wechat-style-release-test-")
        self.addCleanup(tmp.cleanup)
        self.account = Path(tmp.name) / "account"
        self.source = self.account / "参考文章"
        self.source.mkdir(parents=True)
        write_json(self.account / "账号.json", {"id": "test-author", "name": "Synthetic author", "content_mode": "text"})
        for i in (1, 2):
            (self.source / f"source-{i}.md").write_text(f"# Source {i}\n\nThis is distinct test source number {i}.\n", encoding="utf-8")
        scan(self.account, self.source)
        rows = load_json(self.account / CATALOG)["articles"]
        annotations = [{"id": row["id"], "source_sha256": row["source_sha256"], "primary_category": "career",
                        "subtopic": "messages", "expression_task": "explain", "core_question": "a fixture question",
                        "core_claim": "a fixture conclusion", "structure": "fixture structure",
                        "keywords": [], "identity_terms": [], "platform_template_flag": False,
                        "author_identity_flag": False} for row in rows]
        write_json(self.account / ANNOTATIONS, annotations)
        evidence = [{"article_id": row["id"], "source_sha256": row["source_sha256"],
                     "summary": "Synthetic source observation; not a real style judgment"} for row in rows]
        model = {"rules": [{"id": "R1", "rule": "start with a concrete observation", "stability": "local",
                            "how_to_apply": "supply a new topic-specific observation", "boundaries": "TEST ONLY",
                            "evidence": evidence}]}
        self.entries = [{"key": "global", "kind": "global", "file": "作者风格系统/04_作者稳定风格/global.json"},
                        {"key": "career", "kind": "topic", "topic": "career", "file": "作者风格系统/03_主题风格模型/career.json"}]
        for entry in self.entries:
            write_json(self.account / entry["file"], copy.deepcopy(model))

    def review(self):
        result = style_release.audit(self.account, self.entries)
        return assessment(result["input_signature"], style_release.MODEL_CHECKS)

    def test_full_reviewed_corpus_issues_a_model_only_release(self):
        result = style_release.seal(self.account, self.entries, self.review())
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["coverage"]["included"], 2)
        self.assertFalse(result["semantic_quality_verified_by_script"])
        shutil.rmtree(self.source)
        saved = style_release.load_release(self.account, "test-author")
        self.assertEqual(saved["status"], "ready")

    def test_pending_source_prevents_full_ready_and_remains_in_next_batch(self):
        (self.source / "new.md").write_text("# New material\n\nNever analyzed by anyone.\n", encoding="utf-8")
        review = self.review()
        with self.assertRaises(ValueError):
            style_release.seal(self.account, self.entries, review)
        pending = style_release.next_batch(self.account, 1)
        self.assertEqual(pending["remaining"], 1)
        self.assertFalse(pending["analysis_completed"])
        limited = style_release.seal(self.account, self.entries, review, "User explicitly accepts these two synthetic sources only")
        self.assertEqual(limited["status"], "limited")
        self.assertEqual(limited["coverage"]["pending"], 1)

    def test_ready_boolean_or_unbound_review_cannot_issue_a_release(self):
        with self.assertRaises(ValueError):
            style_release.seal(self.account, self.entries, {"reviewed": True})

    def test_missing_topic_coverage_is_not_full_ready(self):
        self.entries = self.entries[:1]
        with self.assertRaises(ValueError):
            style_release.seal(self.account, self.entries, self.review())

    def test_invented_quote_or_stale_source_hash_is_rejected(self):
        path = self.account / self.entries[0]["file"]
        model = load_json(path)
        model["rules"][0]["evidence"][0].update(evidence_type="verbatim", quote="this does not exist")
        write_json(path, model)
        self.assertTrue(style_release.audit(self.account, self.entries)["model_errors"])
        with self.assertRaises(ValueError):
            style_release.seal(self.account, self.entries, self.review(), "limited is not permission to fabricate")

    def test_account_init_reuses_publication_identity_without_touching_user_rules(self):
        write_json(self.account / "账号.json", {"name": "Existing", "human_style": "keep unchanged"})
        write_json(self.account.parent / "accounts.json", {"schema_version": 1, "accounts": [
            {"id": "career", "root": "account", "name": "Existing", "app_id": "wx" + "1" * 16, "secret_env": "SECRET_NAME_ONLY"}]})
        result = style_release.init_account(self.account)
        self.assertEqual(result["id"], "career")
        self.assertTrue(result["publication_identity_reused"])
        self.assertEqual(load_json(self.account / "账号.json")["human_style"], "keep unchanged")

    def test_account_init_never_silently_reassigns_an_existing_id(self):
        original = (self.account / "账号.json").read_bytes()
        write_json(self.account.parent / "accounts.json", {"schema_version": 1, "accounts": [
            {"id": "different", "root": "account", "app_id": "wx" + "1" * 16}]})
        with self.assertRaises(ValueError):
            style_release.init_account(self.account)
        self.assertEqual(original, (self.account / "账号.json").read_bytes())

    def test_changed_source_invalidates_evidence_on_update(self):
        (self.source / "source-1.md").write_text("# Changed\n\nA different argument.\n", encoding="utf-8")
        result = style_release.audit(self.account, self.entries)
        self.assertEqual(len(result["pending_articles"]), 1)
        self.assertTrue(result["model_errors"])

    def test_visual_rule_cannot_be_certified_from_text_only_evidence(self):
        self.entries.append({"key": "visual", "kind": "visual", "file": self.entries[0]["file"]})
        self.assertTrue(style_release.audit(self.account, self.entries)["model_errors"])

    def review_image_references(self, role="identity"):
        from PIL import Image
        from article_ingest import ingest, MANIFEST
        from article_joint import BASE
        from joint_selftest import joint_fixture
        Image.new("RGB", (80, 90), "teal").save(self.source / "logo.png")
        for path in self.source.glob("*.md"):
            path.write_text(path.read_text(encoding="utf-8") + "\n![logo](logo.png)\n", encoding="utf-8")
        ingest(self.account, self.source, visual_only=True)
        annotations = load_json(self.account / ANNOTATIONS)
        records = load_json(self.account / MANIFEST)["articles"]
        for record in records:
            analysis = joint_fixture(record)
            if role != "body":
                for unit in analysis["units"]:
                    unit.update(role=role, excluded_reason="Reviewed logo, not article content")
                analysis["sequence"].update(body_orders=[], transitions=[])
                analysis["transfer_rules"] = []
            name = f"{BASE}/{record['id']}.json"
            write_json(self.account / name, analysis)
            annotation = next(item for item in annotations if item["id"] == record["id"])
            annotation.update(source_sha256=record["source_sha256"], analysis_input_sha256=record["analysis_input_sha256"],
                              content_reviewed=True, visual_reviewed=True, joint_analysis_file=name,
                              joint_analysis_sha256=digest((self.account / name).read_bytes()))
            for entry in self.entries:
                model = load_json(self.account / entry["file"])
                evidence = next(item for item in model["rules"][0]["evidence"] if item["article_id"] == record["id"])
                evidence["source_sha256"] = record["source_sha256"]
                write_json(self.account / entry["file"], model)
        write_json(self.account / ANNOTATIONS, annotations)
        return records

    def test_excluded_decorations_do_not_force_a_visual_model_for_text_articles(self):
        records = self.review_image_references()
        result = style_release.audit(self.account, self.entries)
        self.assertEqual(result["model_errors"], [])
        self.assertEqual(result["pending_articles"], [])
        self.assertEqual(result["candidate"]["coverage"]["image_articles"], 2)
        self.assertEqual(result["candidate"]["coverage"]["body_image_articles"], 0)
        self.assertEqual(style_release.seal(self.account, self.entries, self.review())["status"], "ready")
        visual = {"key": "visual", "kind": "visual", "file": "作者风格系统/04_作者稳定风格/visual.json"}
        model = load_json(self.account / self.entries[0]["file"])
        for evidence in model["rules"][0]["evidence"]:
            record = next(r for r in records if r["id"] == evidence["article_id"])
            evidence.update(order=1, image_sha256=record["images"][0]["image_sha256"],
                            observation="TEST ONLY: observed logo")
        write_json(self.account / visual["file"], model)
        self.assertTrue(style_release.audit(self.account, [*self.entries, visual])["model_errors"])

    def test_reviewed_body_images_still_require_a_joint_visual_model(self):
        self.review_image_references(role="body")
        result = style_release.audit(self.account, self.entries)
        self.assertEqual(result["candidate"]["coverage"]["body_image_articles"], 2)
        self.assertIn("image corpus requires a joint visual style model", result["model_errors"])
        with self.assertRaises(ValueError):
            style_release.seal(self.account, self.entries, self.review())

    def test_release_is_account_bound_and_model_hash_bound(self):
        style_release.seal(self.account, self.entries, self.review())
        with self.assertRaises(ValueError):
            style_release.load_release(self.account, "other-author")
        path = self.account / self.entries[0]["file"]
        path.write_text(path.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            style_release.load_release(self.account, "test-author")

    def test_stable_rule_needs_more_than_one_sample(self):
        path = self.account / self.entries[0]["file"]
        model = load_json(path)
        model["rules"][0]["stability"] = "high"
        model["rules"][0]["evidence"] = model["rules"][0]["evidence"][:1]
        write_json(path, model)
        self.assertTrue(style_release.audit(self.account, self.entries)["model_errors"])


if __name__ == "__main__":
    unittest.main()
