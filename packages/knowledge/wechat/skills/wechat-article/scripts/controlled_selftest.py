"""Offline contract tests. All content, model certificates and images are synthetic fixtures."""
from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
import os
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

from PIL import Image, ImageDraw

from article_library import digest, load_json, write_json
import article_workflow as workflow
import style_release


def assessment(signature, keys):
    return {"input_signature": signature, "reviewer": "synthetic-test-reviewer",
            "reviewed_at": "2026-09-17T00:00:00+00:00", "unresolved": [],
            "checks": {key: {"passed": True, "evidence": "TEST ONLY: " + key} for key in keys}}


def fixture(root, alias="alpha", mode="image-led", count=2, style="ink"):
    account = root / alias
    article = account / "创作" / "T001"
    article.mkdir(parents=True)
    write_json(account / "账号.json", {"id": alias, "name": alias, "content_mode": mode})
    model_path = "作者风格系统/04_作者稳定风格/测试模型.json"
    model = {"schema_version": 1, "rules": [
        {"id": "G1", "rule": "explain this topic through concrete evidence", "how_to_apply": "use the task's scene",
         "boundaries": "do not copy examples", "stability": "local", "evidence": [{"article_id": "S1", "summary": "TEST ONLY"}]},
        {"id": "V1", "rule": style, "how_to_apply": "apply to scene, reading order and visual relationships",
         "boundaries": "style, not topic", "stability": "local", "evidence": [{"article_id": "S1", "summary": "TEST ONLY"}]}]}
    write_json(account / model_path, model)
    # This is a deliberately synthetic already-issued certificate for downstream gate tests.
    cert = {"schema_version": 1, "workflow": "style-release-v1", "account_id": alias,
            "status": "ready", "coverage": {"included": 2, "ready": 2},
            "models": [{"key": "g", "kind": "global", "file": model_path,
                        "sha256": digest((account / model_path).read_bytes())},
                       {"key": "v", "kind": "visual", "file": model_path,
                        "sha256": digest((account / model_path).read_bytes())}],
            "review": {"reviewer": "synthetic-test-reviewer", "note": "TEST ONLY; not a real author certificate"}}
    cert["signature"] = workflow.checksum(cert)
    write_json(account / style_release.RELEASE, cert)
    brief = {"schema_version": 1, "account_id": alias, "article_id": "T001",
             "user_request": "TEST: explain checking work messages at dinner", "topic": "checking work messages",
             "audience": "workers", "goal": "distinguish interruption from negotiated response boundaries",
             "primary_category": "career", "expression_task": "mechanism explanation",
             "transfer_reason": "TEST ONLY: global fixture, no topic-specific claims",
             "content_mode": mode, "constraints": ["never change the topic"], "forbidden_terms": ["invented 70%"],
             "originality": ["interrupted dinner", "negotiated call boundary"], "facts": [],
             "selected_models": ["g"] if mode == "text" else ["g", "v"], "image_provider": "manual"}
    cards = []
    if mode != "text":
        for index in range(1, count + 1):
            cards.append({"id": f"c{index}", "order": index, "role": "body",
                          "text": {"title": f"Point {index}", "body": f"Explanation {index}", "dialogue": [f"Line {index}"]},
                          "scene": f"A person acts in scene {index}", "layout": "configured by the selected style",
                          "text_image_relation": "the action reveals what the words omit",
                          "style_rule_ids": ["v/V1"], "output": f"images/c{index}-v1.png",
                          "alt": f"Scene {index}", "anchor": f"Paragraph {index}.",
                          "requirements": {"size": [360, 480], "text_rendering": "model"},
                          "parameters": {"size": "360x480"}, "references": []})
    plan = {"schema_version": 2, "content_mode": mode, "title": "Test article", "opening": "", "closing": "",
            "style_rule_ids": ["g/G1"], "cards": cards}
    article_text = "# Test article\n\n" + "\n\n".join(
        f"Paragraph {i}.\n\nPoint {i}\n\nExplanation {i}\n\nLine {i}" for i in range(1, max(count, 1) + 1))
    (article / "article.md").write_text(article_text + "\n", encoding="utf-8")
    write_json(article / "任务输入.json", brief)
    write_json(article / "图文计划.json", plan)
    return account, article


def lock(account, article, revision=1, **options):
    data = workflow.inspect_inputs(account, article)
    write_json(article / "方案审稿.json", assessment(data["input_signature"], workflow.PLAN_CHECKS))
    return workflow.lock_plan(account, article, revision=revision, **options)


def reviewed_images(article):
    from import_article_image import import_image
    state = workflow.current(article)
    reviews = []
    for card in state["plan"]["cards"]:
        source = article / (card["id"] + "-fixture.png")
        size = tuple(card["requirements"].get("size", (360, 480)))
        image = Image.new("RGB", size, "white")
        ImageDraw.Draw(image).rectangle((10, 10, 80, 80), fill="black")
        image.save(source)
        output = article / card["output"]
        if not output.exists():
            import_image(article, card["id"], source)
        reviews.append({"id": card["id"], "input_signature": state["card_signatures"][card["id"]],
                        "output_sha256": digest(output.read_bytes()), "reviewer": "synthetic-test-reviewer",
                        "reviewed_at": "2026-09-17T00:00:00+00:00", "unresolved": [],
                        "observed_text": workflow.card_text(card),
                        "checks": {key: {"passed": True, "evidence": "TEST ONLY: " + key}
                                   for key in workflow.IMAGE_CHECKS}})
    write_json(article / "图文检查.json", {"schema_version": 2, "cards": reviews})


def complete(account, article):
    lock(account, article)
    reviewed_images(article)
    workflow.assemble(article)
    target = workflow.review_target(article)
    write_json(article / "成稿审稿.json", assessment(target["input_signature"], workflow.FINAL_CHECKS))
    return workflow.require_ready(article)


class ControlledTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="wechat-controlled-test-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.account, self.article = fixture(self.root)

    def test_multiple_content_modes_and_styles_share_one_pipeline(self):
        for index, (mode, style, count) in enumerate([("text", "long-form commentary", 0),
                                                   ("mixed", "documentary photography", 1),
                                                   ("image-led", "monochrome ink", 3)]):
            with self.subTest(mode=mode):
                account, article = fixture(self.root, f"mode{index}", mode, count, style)
                result = complete(account, article)
                self.assertEqual(result["status"], "reviewed")
                self.assertFalse(result["semantic_quality_verified_by_script"])
                self.assertEqual(len(workflow.current(article)["plan"]["cards"]), count)

    def test_model_only_writing_never_reads_reference_root(self):
        (self.account / "参考文章").mkdir()
        shutil.rmtree(self.account / "参考文章")
        self.assertEqual(lock(self.account, self.article)["status"], "plan_locked")

    def test_model_ready_flag_without_release_is_insufficient(self):
        (self.account / style_release.RELEASE).unlink()
        with self.assertRaises(ValueError):
            lock(self.account, self.article)

    def test_account_and_article_binding(self):
        other, target = fixture(self.root, "other")
        with self.assertRaises(ValueError):
            workflow.inspect_inputs(other, self.article)
        lock(self.account, self.article)
        shutil.copyfile(self.article / workflow.RECORD, target / workflow.RECORD)
        with self.assertRaises(ValueError):
            workflow.current(target)

    def test_plan_review_cannot_be_replaced_with_boolean(self):
        data = workflow.inspect_inputs(self.account, self.article)
        write_json(self.article / "方案审稿.json", {"input_signature": data["input_signature"], "reviewed": True})
        with self.assertRaises(ValueError):
            workflow.lock_plan(self.account, self.article)

    def test_topic_or_source_change_invalidates_lock(self):
        lock(self.account, self.article)
        brief = load_json(self.article / "任务输入.json")
        brief["topic"] = "unrelated productivity"
        write_json(self.article / "任务输入.json", brief)
        self.assertEqual(workflow.status(self.article)["status"], "blocked")
        with self.assertRaises(ValueError):
            workflow.compile_job(self.article, "c1")

    def test_prompt_is_deterministic_and_bound_to_card_not_inspiration(self):
        lock(self.account, self.article)
        first = workflow.compile_job(self.article, "c1")
        second = workflow.compile_job(self.article, "c1")
        self.assertEqual(first["job"], second["job"])
        job = load_json(self.article / first["job"])
        prompt = (self.article / job["prompt_file"]).read_text(encoding="utf-8")
        self.assertIn("Point 1", prompt)
        self.assertIn("ink", prompt)
        self.assertNotIn("Point 2", prompt)
        workflow.verify_job(self.article, job)
        (self.article / job["prompt_file"]).write_text("draw a generic poster", encoding="utf-8")
        job["prompt_sha256"] = digest((self.article / job["prompt_file"]).read_bytes())
        with self.assertRaises(ValueError):
            workflow.verify_job(self.article, job)

    def test_only_changed_card_requires_regeneration_after_new_revision(self):
        previous = lock(self.account, self.article)
        first = workflow.compile_job(self.article, "c1")
        plan = load_json(self.article / "图文计划.json")
        plan["cards"][1]["scene"] = "A different action for card two"
        plan["cards"][1]["output"] = "images/c2-v2.png"
        write_json(self.article / "图文计划.json", plan)
        revised = lock(self.account, self.article, revision=2)
        self.assertEqual(revised["changed_cards"], ["c2"])
        self.assertEqual(previous["card_signatures"]["c1"], revised["card_signatures"]["c1"])
        self.assertEqual(first["job"], workflow.compile_job(self.article, "c1")["job"])

    def test_model_change_requires_explicit_new_release(self):
        lock(self.account, self.article)
        path = self.account / "作者风格系统/04_作者稳定风格/测试模型.json"
        path.write_text(path.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            workflow.current(self.article)

    def test_no_images_or_no_review_is_not_complete(self):
        lock(self.account, self.article)
        with self.assertRaises(ValueError):
            workflow.assemble(self.article)
        with self.assertRaises(ValueError):
            workflow.require_ready(self.article)

    def test_invented_or_changed_image_text_is_rejected(self):
        lock(self.account, self.article)
        reviewed_images(self.article)
        review = load_json(self.article / "图文检查.json")
        review["cards"][0]["observed_text"].append("invented 70%")
        write_json(self.article / "图文检查.json", review)
        with self.assertRaises(ValueError):
            workflow.assemble(self.article)

    def test_stale_image_review_and_wrong_dimensions_are_rejected(self):
        lock(self.account, self.article)
        reviewed_images(self.article)
        card = workflow.current(self.article)["plan"]["cards"][0]
        Image.new("RGB", (640, 320), "blue").save(self.article / card["output"])
        with self.assertRaises(ValueError):
            workflow.assemble(self.article)

    def test_unplanned_text_and_image_order_cannot_enter_final(self):
        complete(self.account, self.article)
        body = self.article / "article-illustrated.md"
        body.write_text(body.read_text(encoding="utf-8") + "\nAn unplanned claim\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            workflow.require_ready(self.article)

    def test_arbitrary_rule_and_cross_account_asset_are_rejected(self):
        plan = load_json(self.article / "图文计划.json")
        plan["cards"][0]["style_rule_ids"] = ["unknown/rule"]
        write_json(self.article / "图文计划.json", plan)
        with self.assertRaises(ValueError):
            workflow.inspect_inputs(self.account, self.article)
        plan["cards"][0]["style_rule_ids"] = ["v/V1"]
        plan["cards"][0]["references"] = ["../../../another-account/image.png"]
        write_json(self.article / "图文计划.json", plan)
        with self.assertRaises(ValueError):
            workflow.inspect_inputs(self.account, self.article)

    def test_legacy_record_is_not_silently_overwritten(self):
        write_json(self.article / workflow.RECORD, {"workflow": "style-model-v1", "human_note": "keep me"})
        original = (self.article / workflow.RECORD).read_bytes()
        with self.assertRaises(ValueError):
            lock(self.account, self.article)
        lock(self.account, self.article, migrate=True)
        self.assertTrue(any(p.read_bytes() == original for p in (self.article / ".wechat").rglob("legacy-record.json")))

    def test_render_and_publish_cannot_bypass_missing_review(self):
        from render_article import render
        from publication_plan import prepare_job
        lock(self.account, self.article)
        with self.assertRaises(ValueError):
            render(self.article / "article.md", self.article / "article.html")
        with self.assertRaises(ValueError):
            prepare_job({"id": "alpha", "name": "alpha", "root": self.account, "app_id": "wx" + "1" * 16},
                        "test", {"id": "one", "articles": [{"article": "创作/T001/article.md",
                        "cover": "创作/T001/images/c1-v1.png", "reviewed": True}]})

    def test_full_controlled_export_and_fake_publication_then_stale_review_block(self):
        from render_article import render
        from publication_plan import prepare_job, load_bundle
        from wechat_publish import Publication
        from publish_selftest import FakeAPI
        complete(self.account, self.article)
        render(self.article / "article-illustrated.md", self.article / "article.html")
        exported = load_json(self.article / "article.html.receipt.json")
        write_json(self.article / "排版检查.json", assessment(workflow.checksum(exported), ("mobile", "desktop", "images", "typography")))
        account = {"id": "alpha", "name": "alpha", "root": self.account, "app_id": "wx" + "1" * 16}
        job = {"id": "one", "articles": [{"article": "创作/T001/article-illustrated.md",
                                          "cover": "创作/T001/images/c1-v1.png", "reviewed": True}]}
        prepared = prepare_job(account, "test", job)
        self.assertFalse(prepared["network_called"])
        bundle = load_bundle(account, "test", job)
        self.assertIn("创作/T001/成稿审稿.json", bundle["source_files"])
        self.assertIn("创作/T001/图文检查.json", bundle["source_files"])
        # The existing publication suite covers API delivery. Here verify the new
        # gate composes with its account-aware client without any network.
        client = FakeAPI("alpha")
        publication = Publication(account, "test", job, client)
        self.assertIsNotNone(publication)
        publication.draft()
        self.assertEqual(client.count("draft/add"), 1)
        self.assertGreaterEqual(client.count("draft/get"), 1)
        Publication(account, "test", job, client).draft()
        self.assertEqual(client.count("draft/add"), 1)
        review = load_json(self.article / "成稿审稿.json")
        review["checks"]["topic"]["passed"] = False
        write_json(self.article / "成稿审稿.json", review)
        with self.assertRaises(ValueError):
            load_bundle(account, "test", job)

    def test_draft_preview_does_not_create_final_export_receipt(self):
        from render_article import render
        lock(self.account, self.article)
        result = render(self.article / "article.md", self.article / "draft-preview.html", draft=True)
        self.assertTrue(result["draft"])
        self.assertFalse(result["reviewed_export"])
        self.assertFalse((self.article / "article.html.receipt.json").exists())

    def test_two_selected_providers_and_no_silent_fallback(self):
        from article_images import execute
        adapter = self.root / "fixture_adapter.py"
        adapter.write_text('''
def describe_image_provider(name):
    if name not in {"test-a", "test-b", "no-text"}: raise ValueError("unknown provider")
    return {"name": name, "required_env": [], "reference_images": False, "native_text": name != "no-text", "sizes": ["360x480"]}
def compile_image_payload(name, payload):
    return {"size": payload["parameters"]["size"], "prompt": payload["prompt"]}
''', encoding="utf-8")
        brief = load_json(self.article / "任务输入.json")
        for revision, provider in enumerate(("test-a", "test-b", "no-text"), 1):
            brief["image_provider"] = provider
            write_json(self.article / "任务输入.json", brief)
            lock(self.account, self.article, revision=revision)
            compiled = workflow.compile_job(self.article, "c1")
            job_path = self.article / compiled["job"]
            if provider == "no-text":
                with self.assertRaises(ValueError):
                    execute(job_path, adapter, run=True, runner=lambda *a, **k: self.fail("unsupported provider was called"))
            else:
                result = execute(job_path, adapter)
                self.assertEqual(result["provider"], provider)
                self.assertTrue(result["configured"])
                self.assertFalse(result["dispatched"])

    def test_actual_provider_request_is_saved_and_not_repeated(self):
        from article_images import execute
        adapter = self.root / "fixture_adapter.py"
        adapter.write_text('''
def describe_image_provider(name):
    return {"name": name, "required_env": [], "reference_images": True, "native_text": True}
def compile_image_payload(name, payload):
    return {"size": payload["parameters"]["size"], "prompt": payload["prompt"]}
''', encoding="utf-8")
        brief = load_json(self.article / "任务输入.json")
        brief["image_provider"] = "test-local"
        write_json(self.article / "任务输入.json", brief)
        lock(self.account, self.article)
        compiled = workflow.compile_job(self.article, "c1")
        calls = []
        def runner(command, **kwargs):
            payload = json.loads(kwargs["input"])
            calls.append(payload)
            path = Path(payload["output_root"]) / "result.png"
            image = Image.new("RGB", (360, 480), "white")
            ImageDraw.Draw(image).rectangle((10, 10, 50, 50), fill="black")
            image.save(path)
            return SimpleNamespace(returncode=0, stdout=json.dumps({"outputs": [{"target": payload["outputs"][0], "source": str(path)}]}).encode())
        result = execute(self.article / compiled["job"], adapter, run=True, runner=runner)
        self.assertEqual(result["status"], "succeeded")
        self.assertIn("control", result)
        self.assertIn("request_payload_sha256", result)
        again = execute(self.article / compiled["job"], adapter, run=True, runner=runner)
        self.assertTrue(again["reused"])
        self.assertEqual(len(calls), 1)
        job = load_json(self.article / compiled["job"])
        self.assertEqual(calls[0]["prompt"], (self.article / job["prompt_file"]).read_text(encoding="utf-8"))
        reviewed_images(self.article)
        brief["image_provider"] = "test-replacement"
        write_json(self.article / "任务输入.json", brief)
        changed = lock(self.account, self.article, revision=2)
        self.assertEqual(changed["changed_cards"], [])
        workflow.image_evidence(workflow.current(self.article))
        with self.assertRaises(ValueError):
            execute(self.article / compiled["job"], adapter, run=True, runner=runner)
        self.assertEqual(len(calls), 1)

    def test_limited_model_requires_explicit_scope_acceptance(self):
        path = self.account / style_release.RELEASE
        release = load_json(path)
        release["status"] = "limited"
        release["signature"] = workflow.checksum({k: v for k, v in release.items() if k != "signature"})
        write_json(path, release)
        with self.assertRaises(ValueError):
            lock(self.account, self.article)
        brief = load_json(self.article / "任务输入.json")
        brief["limited_model_acceptance"] = "TEST: user accepts limited-scope exploration, not full author verification"
        write_json(self.article / "任务输入.json", brief)
        self.assertEqual(lock(self.account, self.article)["model_scope"], "limited")

    def test_revision_reuse_preserves_already_reviewed_unaffected_image(self):
        lock(self.account, self.article)
        reviewed_images(self.article)
        before = (self.article / "images/c1-v1.png").read_bytes()
        plan = load_json(self.article / "图文计划.json")
        plan["cards"][1]["scene"] = "Changed second scene"
        plan["cards"][1]["output"] = "images/c2-v2.png"
        write_json(self.article / "图文计划.json", plan)
        revised = lock(self.account, self.article, revision=2)
        self.assertEqual(revised["changed_cards"], ["c2"])
        reviewed_images(self.article)
        workflow.assemble(self.article)
        self.assertEqual((self.article / "images/c1-v1.png").read_bytes(), before)

    def test_mixed_image_order_cannot_contradict_its_text_anchors(self):
        account, article = fixture(self.root, "mixed-order", "mixed", 2)
        plan = load_json(article / "图文计划.json")
        plan["cards"][0]["anchor"], plan["cards"][1]["anchor"] = plan["cards"][1]["anchor"], plan["cards"][0]["anchor"]
        write_json(article / "图文计划.json", plan)
        with self.assertRaises(ValueError):
            workflow.inspect_inputs(account, article)

    def test_reference_style_image_markup_cannot_bypass_planning(self):
        source = self.article / "article.md"
        source.write_text(source.read_text(encoding="utf-8") + "\n![extra][outside]\n\n[outside]: extra.png\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            workflow.inspect_inputs(self.account, self.article)

    def test_explicit_length_budget_is_enforced_without_a_fixed_default(self):
        brief = load_json(self.article / "任务输入.json")
        brief["length_budget"] = {"basis": "image_text", "min": 10000}
        write_json(self.article / "任务输入.json", brief)
        with self.assertRaises(ValueError):
            workflow.inspect_inputs(self.account, self.article)

    def test_inconsistent_provider_size_is_rejected_before_dispatch(self):
        plan = load_json(self.article / "图文计划.json")
        plan["cards"][0]["parameters"]["size"] = "480x360"
        write_json(self.article / "图文计划.json", plan)
        with self.assertRaises(ValueError):
            workflow.inspect_inputs(self.account, self.article)


if __name__ == "__main__":
    unittest.main()
