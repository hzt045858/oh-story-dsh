"""Offline structural tests. Fixture descriptions are not real visual observations."""
from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

from PIL import Image
import article_ingest as ingestion
import article_library as library
import article_joint as joint


def joint_fixture(record):
    """Synthetic, deliberately explicit evidence for isolated tests only."""
    orders = [i["order"] for i in record["images"]]
    return {
        "schema_version": 1, "workflow": "joint-article-v1", "status": "reviewed",
        "article_id": record["id"], "source_sha256": record["source_sha256"],
        "analysis_input_sha256": record["analysis_input_sha256"],
        "observation_method": "Synthetic fixture; no actual author-style judgment",
        "units": [{"order": i["order"], "image_sha256": i["image_sha256"], "role": "body",
                   "text_evidence": "The fixture caption names a contrast.",
                   "visual_evidence": "The fixture image contains differently placed shapes.",
                   "text_image_relation": "contrast", "joint_meaning": "The caption interprets the spatial contrast.",
                   "without_image_loss": "The spatial relationship would be absent.",
                   "reading_path": ["caption", "shape", "other shape"],
                   "article_function": "One parallel example", "uncertainties": []}
                  for i in record["images"]],
        "sequence": {"body_orders": orders, "organization": "parallel examples, not a timeline",
                     "transitions": [{"from_order": a, "to_order": b, "relation": "another parallel example"}
                                     for a, b in zip(orders, orders[1:])],
                     "opening": "The first example establishes the format.",
                     "development": "Each example adds a different comparison.",
                     "ending": "The final example closes the list without a separate conclusion.",
                     "outside_text_role": "Title names the shared subject; other text is a caption."},
        "transfer_rules": [{"id": "J-01", "rule": "Caption interprets a visible contrast.",
                            "evidence_orders": orders, "how_to_apply": "Invent a new contrast and corresponding caption.",
                            "boundaries": "Synthetic fixture only; do not reuse as author evidence."}],
        "unresolved": []}


class JointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.account = self.root / "account"
        Image.new("RGB", (80, 90), "teal").save(self.source / "a.png")
        (self.source / "a.md").write_text("# Topic\nBefore\n![one](a.png)\nBetween\n![two](a.png)\nAfter", encoding="utf-8")
        class OCR:
            signature = "joint-test"
            def __call__(self, path):
                return [{"text": "Fixture caption", "score": 1, "box": []}]
        ingestion.ingest(self.account, self.source, recognizer=OCR())
        self.record = library.load_json(self.account / ingestion.MANIFEST)["articles"][0]
        self.analysis = joint_fixture(self.record)
        self.path = self.account / joint.BASE / "test.json"
        self.annotation = {"id": self.record["id"], "source_sha256": self.record["source_sha256"],
                           "analysis_input_sha256": self.record["analysis_input_sha256"],
                           "primary_category": "test", "subtopic": "test", "expression_task": "contrast",
                           "core_question": "What differs?", "core_claim": "The caption interprets the scene.",
                           "structure": "parallel", "keywords": [], "identity_terms": [],
                           "platform_template_flag": False, "author_identity_flag": False,
                           "content_reviewed": True, "visual_reviewed": True}

    def save(self):
        library.write_json(self.path, self.analysis)
        self.annotation.update(joint_analysis_file=self.path.relative_to(self.account).as_posix(),
                               joint_analysis_sha256=library.digest(self.path.read_bytes()))
        library.write_json(self.account / library.ANNOTATIONS, [self.annotation])

    def test_packet_preserves_whole_article_and_duplicate_occurrences(self):
        packet = joint.prepare(self.account, self.record["id"])
        self.assertEqual([i["order"] for i in packet["images"]], [1, 2])
        for word in ["Before", "Between", "After"]:
            self.assertIn(word, packet["text_with_image_slots"])
        self.assertFalse(packet["analysis_completed"])
        self.assertNotIn("units", packet)

    def test_flags_alone_cannot_unlock_image_index(self):
        library.write_json(self.account / library.ANNOTATIONS, [self.annotation])
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1})

    def test_complete_joint_record_unlocks_only_structural_gate(self):
        self.save()
        result = joint.check(self.account, self.path.relative_to(self.account).as_posix())
        self.assertTrue(result["ok"])
        self.assertFalse(result["semantic_quality_verified_by_script"])
        self.assertEqual(library.build_index(self.account)["counts"], {"ready": 1})

    def test_missing_relation_is_not_replaced_by_two_review_flags(self):
        self.analysis["units"][0].pop("joint_meaning")
        self.save()
        self.assertFalse(joint.check(self.account, self.path.relative_to(self.account).as_posix())["ok"])
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1})

    def test_omitted_or_reordered_images_are_rejected(self):
        for units in [self.analysis["units"][:1], list(reversed(self.analysis["units"]))]:
            changed = copy.deepcopy(self.analysis)
            changed["units"] = units
            self.assertTrue(joint.validate(changed, self.record))

    def test_whole_article_and_transition_evidence_are_required(self):
        for change in [lambda a: a.pop("sequence"), lambda a: a["sequence"].update(body_orders=[2, 1]),
                       lambda a: a["sequence"].update(transitions=[])]:
            changed = copy.deepcopy(self.analysis)
            change(changed)
            self.assertTrue(joint.validate(changed, self.record))

    def test_excluded_banner_needs_reason_and_is_not_rule_evidence(self):
        self.analysis["units"][0]["role"] = "identity"
        self.analysis["sequence"]["body_orders"] = [2]
        self.analysis["sequence"]["transitions"] = []
        self.assertTrue(joint.validate(self.analysis, self.record))
        self.analysis["units"][0]["excluded_reason"] = "Original account banner, not transferable"
        self.analysis["transfer_rules"][0]["evidence_orders"] = [2]
        self.assertEqual(joint.validate(self.analysis, self.record), [])

    def test_draft_unknown_image_hash_and_unresolved_are_blocked(self):
        for change in [lambda a: a.update(status="draft"), lambda a: a["units"][0].update(image_sha256="0" * 64),
                       lambda a: a.update(unresolved=["Image unreadable"])]:
            changed = copy.deepcopy(self.analysis)
            change(changed)
            self.assertTrue(joint.validate(changed, self.record))

    def test_changed_record_invalidates_old_index_and_retrieval(self):
        self.save()
        library.build_index(self.account)
        self.path.write_text("{}", encoding="utf-8")
        self.assertEqual(library.retrieve(self.account, ids=[self.record["id"]])["count"], 0)
        self.assertEqual(library.build_index(self.account)["counts"], {"pending": 1})

    def test_changed_source_picture_invalidates_joint_record(self):
        self.save()
        Image.new("RGB", (80, 90), "red").save(self.source / "a.png")
        self.assertFalse(joint.check(self.account, self.path.relative_to(self.account).as_posix())["ok"])

    def test_bad_paths_malformed_json_and_cross_account_are_blocked(self):
        self.save()
        for path in ["../outside.json", str(self.path), "C:/outside.json"]:
            self.assertFalse(joint.check(self.account, path)["ok"])
        self.path.write_text("{broken", encoding="utf-8")
        self.assertFalse(joint.check(self.account, self.path.relative_to(self.account).as_posix())["ok"])
        self.assertFalse(joint.check(self.root / "other-account", "not-there.json")["ok"])

    def visual_ingest(self, animation=False):
        if animation:
            frames = [Image.new("RGB", (80, 90), color) for color in ("red", "green", "blue")]
            frames[0].save(self.source / "animation.gif", save_all=True, append_images=frames[1:], duration=[80, 120, 160], loop=0)
            (self.source / "a.md").write_text("# Topic\nBefore\n![one](animation.gif)\nBetween\n![two](animation.gif)\nAfter", encoding="utf-8")
        class NeverOCR:
            signature = "must-not-be-called"
            def __call__(self, path):
                raise AssertionError("visual-only mode must not invoke OCR")
        result = ingestion.ingest(self.account, self.source, visual_only=True, recognizer=NeverOCR())
        self.record = library.load_json(self.account / ingestion.MANIFEST)["articles"][0]
        self.analysis = joint_fixture(self.record)
        self.annotation.update(source_sha256=self.record["source_sha256"], analysis_input_sha256=self.record["analysis_input_sha256"])
        return result

    def test_direct_visual_reading_does_not_require_ocr_or_claim_analysis(self):
        result = self.visual_ingest()
        self.assertEqual(result["counts"], {"review_pending": 1})
        self.assertFalse(result["analysis_completed"])
        packet = joint.prepare(self.account, self.record["id"])
        self.assertFalse(packet["images"][0]["ocr_performed"])
        self.assertIn("Before", packet["text_with_image_slots"])
        self.save()
        self.assertTrue(joint.check(self.account, self.path.relative_to(self.account).as_posix())["ok"])

    def test_animation_packets_preserve_every_frame_and_occurrence(self):
        self.visual_ingest(animation=True)
        packet = joint.prepare(self.account, self.record["id"])
        self.assertEqual(len(packet["images"]), 2)
        for image in packet["images"]:
            self.assertEqual([f["index"] for f in image["frame_views"]], [1, 2, 3])
            self.assertEqual([f["start_ms"] for f in image["frame_views"]], [0, 80, 200])
            self.assertEqual([f["duration_ms"] for f in image["frame_views"]], [80, 120, 160])
        self.assertEqual(packet["images"][0]["frame_views"], packet["images"][1]["frame_views"])

    def test_animation_review_cannot_use_only_first_frame_or_a_boolean(self):
        self.visual_ingest(animation=True)
        self.assertTrue(joint.validate(self.analysis, self.record))
        for unit, image in zip(self.analysis["units"], self.record["images"]):
            unit["frame_reviews"] = [{"index": f["index"], "frame_sha256": f["frame_sha256"],
                                      "observation": "Synthetic frame observation; not real author analysis"}
                                     for f in image["frame_views"]]
        self.assertEqual(joint.validate(self.analysis, self.record), [])
        self.save()
        self.assertEqual(library.build_index(self.account)["counts"], {"ready": 1})
        self.analysis["units"][0]["frame_reviews"].pop()
        self.assertTrue(joint.validate(self.analysis, self.record))

    def test_changed_animation_frame_invalidates_entire_source_evidence(self):
        self.visual_ingest(animation=True)
        frame = self.account / self.record["images"][0]["frame_views"][1]["asset_file"]
        frame.write_bytes(b"changed frame bytes")
        with self.assertRaises(ValueError):
            joint.prepare(self.account, self.record["id"])

    def test_visual_inputs_resume_without_reprocessing_or_repeated_ocr(self):
        self.visual_ingest(animation=True)
        result = ingestion.ingest(self.account, self.source, visual_only=True)
        self.assertEqual(result["processed"], 0)
        self.assertEqual(result["reused_articles"], 1)


if __name__ == "__main__":
    unittest.main()
