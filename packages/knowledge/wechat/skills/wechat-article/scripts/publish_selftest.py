"""Offline end-to-end publication tests against an account-aware fake WeChat API."""

from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import requests
from PIL import Image

from article_library import load_json, write_json
from article_card import render_card
from publication_plan import bundle_path, prepare_job, read_plan, registry
from wechat_api import ApiError, TransportError, WeChatAPI
from wechat_publish import Publication, account_lock, run_plan


class FakeAPI:
    def __init__(self, account):
        self.account = account
        self.calls, self.drafts, self.failures = [], {}, {}
        self.publish_status, self.mass_status = 1, "SENDING"
        self.lose_draft_response = False

    def call(self, endpoint, payload=None, image=None, query=None):
        self.calls.append((endpoint, copy.deepcopy(payload)))
        if endpoint in self.failures:
            raise self.failures[endpoint]
        if endpoint == "media/uploadimg":
            return {"url": f"http://mmbiz.qpic.cn/{self.account}/{image.stem}/0"}
        if endpoint == "material/add_material":
            return {"media_id": f"cover-{self.account}-{image.stem}"}
        if endpoint == "draft/add":
            media_id = f"draft-{self.account}-{len(self.drafts) + 1}"
            self.drafts[media_id] = copy.deepcopy(payload["articles"])
            if self.lose_draft_response:
                raise TransportError("simulated lost response after creating the draft")
            return {"media_id": media_id}
        if endpoint == "draft/get":
            if payload["media_id"] not in self.drafts:
                raise ApiError(40007, endpoint)
            return {"news_item": copy.deepcopy(self.drafts[payload["media_id"]])}
        if endpoint == "draft/update":
            self.drafts[payload["media_id"]][payload["index"]] = copy.deepcopy(payload["articles"])
            return {"errcode": 0}
        if endpoint == "draft/delete":
            self.drafts.pop(payload["media_id"])
            return {"errcode": 0}
        if endpoint == "freepublish/submit":
            return {"publish_id": f"publish-{self.account}", "msg_data_id": 10}
        if endpoint == "freepublish/get":
            return {"publish_id": payload["publish_id"], "publish_status": self.publish_status,
                    "article_detail": {"item": [{"article_url": f"https://mp.weixin.qq.com/s/{self.account}"}]}}
        if endpoint == "message/mass/sendall":
            return {"msg_id": 987, "msg_data_id": 10}
        if endpoint == "message/mass/get":
            return {"msg_id": payload["msg_id"], "msg_status": self.mass_status}
        if endpoint == "message/mass/preview":
            return {"msg_id": 123}
        raise AssertionError("Unexpected fake endpoint: " + endpoint)

    def count(self, endpoint):
        return sum(name == endpoint for name, _ in self.calls)


class PublishingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wechat-publish-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.registry_path, self.plan_path = self.root / "accounts.json", self.root / "plan.json"
        accounts, jobs = [], []
        for index, alias in enumerate(("career", "life"), 1):
            account = self.root / alias
            article = account / "articles/a"
            article.mkdir(parents=True)
            (article / "article.md").write_text("# 一个完整标题\n\n这是本账号原创的完整正文。\n\n![图示](image.png)\n\n[资料](https://example.com/source)", encoding="utf-8")
            Image.new("RGB", (128, 96), (22, 128, 80)).save(article / "image.png")
            accounts.append({"id": alias, "name": alias, "root": alias,
                             "app_id": "wx" + str(index) * 16, "secret_env": "WECHAT_" + alias.upper() + "_SECRET",
                             "theme_preset": "professional-clean"})
            jobs.append({"id": alias + "-a", "account": alias, "articles": [{"article": "articles/a/article.md",
                         "cover": "articles/a/image.png", "reviewed": True}], "delivery": "publish"})
        write_json(self.registry_path, {"schema_version": 1, "accounts": accounts})
        self.plan = {"id": "week-01", "jobs": jobs}
        write_json(self.plan_path, self.plan)
        self.accounts = registry(self.registry_path)
        self.clients = {alias: FakeAPI(alias) for alias in self.accounts}
        self.prepare()

    def prepare(self):
        read_plan(self.plan_path, self.accounts)
        for job in self.plan["jobs"]:
            prepare_job(self.accounts[job["account"]], self.plan["id"], job)

    def run_jobs(self, action, run=True, jobs=(), **kwargs):
        return run_plan(self.registry_path, self.plan_path, action, run, jobs,
                        api_factory=lambda account: self.clients[account["id"]], **kwargs)

    def publication(self, job=None):
        job = job or self.plan["jobs"][0]
        return Publication(self.accounts[job["account"]], self.plan["id"], job, self.clients[job["account"]])

    def test_prepare_and_dry_run_are_offline_and_preserve_source(self):
        before = (self.root / "career/articles/a/article.md").read_bytes()
        result = run_plan(self.registry_path, self.plan_path, "draft", api_factory=lambda _: self.fail("dry run created a client"))
        self.assertTrue(result["ok"])
        self.assertFalse(result["executed"])
        self.assertEqual(before, (self.root / "career/articles/a/article.md").read_bytes())
        body = (self.publication().root / "article-1.html").read_text(encoding="utf-8")
        self.assertNotIn("<h1", body)
        self.assertNotIn("data:image", body)
        self.assertIn("#2563eb", body)
        self.assertIn("https://example.com/source", body)

    def test_multi_account_uploads_and_receipts_stay_separate(self):
        result = self.run_jobs("draft")
        self.assertTrue(result["ok"], result)
        for alias, api in self.clients.items():
            self.assertEqual(api.count("draft/add"), 1)
            article = next(iter(api.drafts.values()))[0]
            self.assertIn("cover-" + alias, article["thumb_media_id"])
            self.assertIn("https://mmbiz.qpic.cn/" + alias, article["content"])
            self.assertNotIn("data:image", article["content"])
        self.assertTrue(self.run_jobs("draft")["ok"])
        for api in self.clients.values():
            self.assertEqual(api.count("draft/add"), 1)
            self.assertEqual(api.count("media/uploadimg"), 1)
            self.assertEqual(api.count("material/add_material"), 1)

    def test_submission_and_publication_are_distinct_and_idempotent(self):
        self.run_jobs("draft")
        result = self.run_jobs("publish")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["jobs"][0]["status"], "publish_submitted")
        self.assertEqual(self.run_jobs("status")["jobs"][0]["status"], "publishing")
        self.clients["career"].publish_status = 0
        self.assertEqual(self.run_jobs("publish")["jobs"][0]["status"], "published")
        self.assertEqual(self.clients["career"].count("freepublish/submit"), 1)
        self.clients["career"].publish_status = 4
        self.assertEqual(self.run_jobs("status")["jobs"][0]["status"], "review_rejected")

    def test_partial_batch_failure_keeps_success_and_can_resume(self):
        self.clients["life"].failures["draft/add"] = ApiError(48001, "draft/add")
        result = self.run_jobs("draft")
        self.assertFalse(result["ok"])
        self.assertEqual(result["jobs"][0]["status"], "drafted")
        self.clients["life"].failures.clear()
        self.assertTrue(self.run_jobs("draft")["ok"])
        self.assertEqual(self.clients["career"].count("draft/add"), 1)
        self.assertEqual(self.clients["life"].count("draft/add"), 2)

    def test_changed_source_prevents_any_dispatch(self):
        (self.root / "career/articles/a/article.md").write_text("Changed after review", encoding="utf-8")
        result = self.run_jobs("draft", jobs=("career-a",))
        self.assertFalse(result["ok"])
        self.assertIn("source changed", result["jobs"][0]["error"])
        self.assertEqual(self.clients["career"].calls, [])

    def test_changed_snapshot_and_account_binding_are_rejected(self):
        publication = self.publication()
        (publication.root / "article-1.html").write_text("Changed", encoding="utf-8")
        self.assertFalse(self.run_jobs("draft", jobs=("career-a",))["ok"])
        configured = load_json(self.registry_path)
        configured["accounts"][1]["app_id"] = "wx" + "3" * 16
        write_json(self.registry_path, configured)
        result = self.run_jobs("draft", jobs=("life-a",))
        self.assertIn("different account", result["jobs"][0]["error"])

    def test_unknown_draft_is_not_created_twice_and_can_be_reconciled(self):
        api = self.clients["career"]
        api.lose_draft_response = True
        self.assertFalse(self.run_jobs("draft", jobs=("career-a",))["ok"])
        api.lose_draft_response = False
        self.assertFalse(self.run_jobs("draft", jobs=("career-a",))["ok"])
        self.assertEqual(api.count("draft/add"), 1)
        publication = self.publication()
        with self.assertRaises(ApiError):
            publication.reconcile("draft", "wrong-draft")
        result = publication.reconcile("draft", "draft-career-1")
        self.assertEqual(result["status"], "drafted")
        self.assertTrue(self.run_jobs("draft", jobs=("career-a",))["ok"])
        self.assertEqual(api.count("draft/add"), 1)

    def test_remote_edit_blocks_publishing(self):
        self.run_jobs("draft")
        self.clients["career"].drafts["draft-career-1"][0]["content"] += "Changed in WeChat"
        result = self.run_jobs("publish", jobs=("career-a",))
        self.assertIn("differ", result["jobs"][0]["error"])
        self.assertEqual(self.clients["career"].count("freepublish/submit"), 0)

    def test_scheduled_publication_waits_without_a_network_request(self):
        job = copy.deepcopy(self.plan["jobs"][0])
        job.update(id="scheduled-a", not_before="2099-09-09T08:00:00+08:00")
        self.plan["jobs"] = [job]
        write_json(self.plan_path, self.plan)
        self.prepare()
        result = self.run_jobs("publish")
        self.assertEqual(result["jobs"][0]["status"], "scheduled")
        self.assertEqual(self.clients["career"].calls, [])
        self.run_jobs("draft")
        self.assertEqual(self.publication(job).deliver("publish", datetime(2100, 1, 1, tzinfo=timezone.utc))["status"], "publish_submitted")

    def test_mass_delivery_uses_explicit_audience_and_stable_clientmsgid(self):
        job = copy.deepcopy(self.plan["jobs"][0])
        job.update(id="mass-a", delivery="mass", audience={"tag_id": 42})
        self.plan["jobs"] = [job]
        write_json(self.plan_path, self.plan)
        self.prepare()
        self.run_jobs("draft")
        self.assertFalse(self.run_jobs("publish")["ok"])
        self.assertEqual(self.run_jobs("mass")["jobs"][0]["status"], "mass_submitted")
        api = self.clients["career"]
        payload = next(payload for endpoint, payload in api.calls if endpoint == "message/mass/sendall")
        self.assertEqual(payload["filter"], {"is_to_all": False, "tag_id": 42})
        self.assertEqual(len(payload["clientmsgid"]), 32)
        self.assertEqual(payload["send_ignore_reprint"], 0)
        api.mass_status = "SEND_SUCCESS"
        self.assertEqual(self.run_jobs("mass")["jobs"][0]["status"], "mass_sent")
        self.assertEqual(api.count("message/mass/sendall"), 1)
        api.mass_status = "DELETE"
        self.assertEqual(self.run_jobs("status")["jobs"][0]["status"], "mass_deleted")
        api.failures["message/mass/get"] = ApiError(89504, "message/mass/get")
        self.assertEqual(self.run_jobs("status")["jobs"][0]["status"], "mass_pending_review")

    def test_preview_does_not_publish_and_draft_update_preserves_remote_id(self):
        self.run_jobs("draft")
        result = self.run_jobs("preview", jobs=("career-a",), openid="explicit-test-recipient")
        self.assertEqual(result["jobs"][0]["status"], "preview_submitted")
        self.assertEqual(self.clients["career"].count("freepublish/submit"), 0)
        job = copy.deepcopy(self.plan["jobs"][0])
        job.update(id="revision-a", draft_media_id="draft-career-1")
        job["articles"][0]["title"] = "修改后的标题"
        self.plan["jobs"] = [job]
        write_json(self.plan_path, self.plan)
        self.prepare()
        result = self.run_jobs("draft")
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.clients["career"].count("draft/add"), 1)
        self.assertEqual(self.clients["career"].count("draft/update"), 1)
        self.assertEqual(self.clients["career"].drafts["draft-career-1"][0]["title"], "修改后的标题")

    def test_lock_prevents_a_concurrent_account_writer(self):
        with account_lock(self.accounts["career"]):
            result = self.run_jobs("draft", jobs=("career-a",))
        self.assertIn("interrupted publisher", result["jobs"][0]["error"])
        self.assertEqual(self.clients["career"].calls, [])

    def test_account_roots_and_article_paths_cannot_cross_accounts(self):
        configured = load_json(self.registry_path)
        configured["accounts"][1]["root"] = "career/nested"
        write_json(self.registry_path, configured)
        with self.assertRaisesRegex(ValueError, "non-overlapping"):
            registry(self.registry_path)
        job = copy.deepcopy(self.plan["jobs"][0])
        job["articles"][0]["article"] = "../life/articles/a/article.md"
        with self.assertRaisesRegex(ValueError, "inside their account"):
            prepare_job(self.accounts["career"], "new-plan", job)

    def test_multi_article_draft_and_platform_lengths(self):
        job = copy.deepcopy(self.plan["jobs"][0])
        job["id"] = "multi-a"
        job["articles"] *= 2
        prepare_job(self.accounts["career"], self.plan["id"], job)
        self.assertEqual(len(self.publication(job).draft()["actions"]), 3)
        job["id"] = "long-title"
        job["articles"][0]["title"] = "字" * 33
        with self.assertRaisesRegex(ValueError, "32"):
            prepare_job(self.accounts["career"], self.plan["id"], job)

    def test_card_dimensions_and_existing_version_are_preserved(self):
        spec = self.root / "card.json"
        write_json(spec, {"kind": "card", "title": "Three signals worth checking", "points": ["Tasks", "Information", "Feedback"]})
        result = render_card(spec, self.root / "card.png")
        self.assertEqual((result["width"], result["height"]), (1080, 1440))
        with Image.open(self.root / "card.png") as image:
            self.assertGreater(len(image.getcolors(image.width * image.height)), 2)
        with self.assertRaisesRegex(ValueError, "new PNG"):
            render_card(spec, self.root / "card.png")

    def test_unknown_publication_is_not_resubmitted_or_reported_as_drafted(self):
        self.run_jobs("draft")
        self.clients["career"].failures["freepublish/submit"] = TransportError("lost response")
        self.assertFalse(self.run_jobs("publish", jobs=("career-a",))["ok"])
        self.clients["career"].failures.clear()
        self.assertFalse(self.run_jobs("publish", jobs=("career-a",))["ok"])
        self.assertEqual(self.run_jobs("status", jobs=("career-a",))["jobs"][0]["status"], "needs_reconciliation")
        self.assertEqual(self.clients["career"].count("freepublish/submit"), 1)

    def test_unknown_preview_preserves_delivery_status_and_does_not_resend(self):
        original = copy.deepcopy(self.plan["jobs"][0])
        api = self.clients["career"]
        for delivery, endpoint, final_status in (("publish", "freepublish/get", "published"),
                                                 ("mass", "message/mass/get", "mass_sent")):
            with self.subTest(delivery=delivery):
                job = copy.deepcopy(original)
                job.update(id="preview-then-" + delivery, delivery=delivery)
                if delivery == "mass":
                    job["audience"] = {"all": True}
                self.plan["jobs"] = [job]
                write_json(self.plan_path, self.plan)
                self.prepare()
                self.assertTrue(self.run_jobs("draft")["ok"])
                api.failures["message/mass/preview"] = TransportError("lost preview response")
                self.assertFalse(self.run_jobs("preview", openid="explicit-test-recipient")["ok"])
                api.failures.clear()
                preview_calls = api.count("message/mass/preview")
                self.assertFalse(self.run_jobs("preview", openid="explicit-test-recipient")["ok"])
                self.assertEqual(api.count("message/mass/preview"), preview_calls)

                result = self.run_jobs(delivery)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["jobs"][0]["status"], delivery + "_submitted")
                api.publish_status, api.mass_status = 0, "SEND_SUCCESS"
                result = self.run_jobs("status")
                self.assertEqual(result["jobs"][0]["status"], final_status)
                self.assertEqual(api.count(endpoint), 1)
                local = self.run_jobs("status", run=False)["jobs"][0]
                self.assertEqual(local["status"], final_status)
                previews = {name: state for name, state in local["actions"].items() if name.startswith("preview:")}
                self.assertEqual(list(previews.values()), ["unknown"])

    def test_unknown_preview_does_not_unblock_uncertain_delivery(self):
        original = copy.deepcopy(self.plan["jobs"][0])
        api = self.clients["career"]
        for delivery, endpoint in (("publish", "freepublish/submit"), ("mass", "message/mass/sendall")):
            with self.subTest(delivery=delivery):
                job = copy.deepcopy(original)
                job.update(id="uncertain-" + delivery, delivery=delivery)
                if delivery == "mass":
                    job["audience"] = {"all": True}
                self.plan["jobs"] = [job]
                write_json(self.plan_path, self.plan)
                self.prepare()
                self.assertTrue(self.run_jobs("draft")["ok"])
                api.failures["message/mass/preview"] = TransportError("lost preview response")
                self.assertFalse(self.run_jobs("preview", openid="explicit-test-recipient")["ok"])
                api.failures.clear()
                api.failures[endpoint] = TransportError("lost delivery response")
                self.assertFalse(self.run_jobs(delivery)["ok"])
                api.failures.clear()
                self.assertFalse(self.run_jobs(delivery)["ok"])
                self.assertEqual(api.count(endpoint), 1)
                result = self.run_jobs("status")["jobs"][0]
                self.assertEqual(result["status"], "needs_reconciliation")
                self.assertEqual(result["actions"][delivery], "unknown")

    def test_interrupted_upload_has_a_scoped_retry_without_resetting_delivery_history(self):
        api = self.clients["career"]
        api.failures["media/uploadimg"] = TransportError("lost upload response")
        self.assertFalse(self.run_jobs("draft", jobs=("career-a",))["ok"])
        api.failures.clear()
        self.assertFalse(self.run_jobs("draft", jobs=("career-a",))["ok"])
        self.assertTrue(self.publication().retry_media()["retryable_media"])
        self.assertTrue(self.run_jobs("draft", jobs=("career-a",))["ok"])
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.publication().retry_media()

    def test_deleted_draft_and_local_status_do_not_claim_publication(self):
        self.run_jobs("draft")
        result = self.run_jobs("delete", jobs=("career-a",))
        self.assertEqual(result["jobs"][0]["status"], "draft_deleted")
        result = run_plan(self.registry_path, self.plan_path, "status", jobs=("career-a",),
                          api_factory=lambda _: self.fail("local status created an API client"))
        self.assertEqual(result["jobs"][0]["status"], "draft_deleted")
        self.assertFalse(result["jobs"][0]["network_called"])

    def test_token_transport_failure_before_dispatch_can_resume(self):
        api = self.clients["career"]
        api.failures["media/uploadimg"] = TransportError("token request failed", dispatched=False)
        self.assertFalse(self.run_jobs("draft", jobs=("career-a",))["ok"])
        api.failures.clear()
        self.assertTrue(self.run_jobs("draft", jobs=("career-a",))["ok"])
        self.assertEqual(api.count("draft/add"), 1)


class ApiTests(unittest.TestCase):
    def test_token_network_failure_is_marked_as_not_dispatched(self):
        def request(*_args, **_kwargs):
            raise requests.Timeout("token acquisition timed out")
        api = WeChatAPI("appid", "PRIVATE", request=request)
        with self.assertRaises(TransportError) as caught:
            api.call("draft/add", {"title": "Example"})
        self.assertFalse(caught.exception.dispatched)

    def test_utf8_payload_token_cache_and_explicit_expiry_refresh(self):
        calls = []
        def request(url, **kwargs):
            calls.append((url, kwargs))
            if url.endswith("stable_token"):
                return SimpleNamespace(status_code=200, json=lambda: {"access_token": "token", "expires_in": 7200})
            if len(calls) == 2:
                return SimpleNamespace(status_code=200, json=lambda: {"errcode": 42001})
            return SimpleNamespace(status_code=200, json=lambda: {"media_id": "created"})
        api = WeChatAPI("appid", "not-a-real-secret", request=request)
        api.call("draft/add", {"title": "中文标题"})
        api.call("draft/add", {"title": "下一篇"})
        self.assertEqual(sum(url.endswith("stable_token") for url, _ in calls), 2)
        self.assertIn("中文标题".encode(), calls[1][1]["data"])
        self.assertNotIn(b"\\u", calls[1][1]["data"])
        self.assertFalse(calls[0][1]["allow_redirects"])
        self.assertFalse(json.loads(calls[0][1]["data"])["force_refresh"])

    def test_network_failure_never_retries_a_mutation_or_exposes_credentials(self):
        calls = []
        def request(url, **_kwargs):
            calls.append(url)
            if url.endswith("stable_token"):
                return SimpleNamespace(status_code=200, json=lambda: {"access_token": "SECRET-TOKEN", "expires_in": 7200})
            raise requests.Timeout("access_token=SECRET-TOKEN secret=PRIVATE")
        api = WeChatAPI("appid", "PRIVATE", request=request)
        with self.assertRaises(TransportError) as caught:
            api.call("freepublish/submit", {"media_id": "draft"})
        self.assertNotIn("SECRET-TOKEN", str(caught.exception))
        self.assertNotIn("PRIVATE", str(caught.exception))
        self.assertEqual(len(calls), 2)

    def test_platform_error_does_not_echo_server_credential_text(self):
        api = WeChatAPI("appid", "PRIVATE", request=lambda *_args, **_kwargs:
                        SimpleNamespace(status_code=200, json=lambda: {"errcode": 40125, "errmsg": "secret=PRIVATE"}))
        with self.assertRaises(ApiError) as caught:
            api.access_token()
        self.assertNotIn("PRIVATE", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
