"""Account-isolated WeChat drafts, previews, publication, mass sending and recovery."""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from article_library import digest, load_json, write_json
from publication_plan import (account_identity, bundle_path, checksum, due_at, load_bundle,
                              prepare_job, read_plan, registry, relative_path, write_report)
from wechat_api import ApiError, TransportError, WeChatAPI

PUBLISH_STATES = {0: "published", 1: "publishing", 2: "originality_failed", 3: "publish_failed",
                  4: "review_rejected", 5: "deleted", 6: "banned"}


def timestamp():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def account_lock(account):
    directory = account["root"] / "发布"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ".publish.lock"
    try:
        handle = path.open("x", encoding="utf-8")
    except FileExistsError:
        raise ValueError("account has an active or interrupted publisher; inspect .publish.lock before resuming") from None
    try:
        with handle:
            json.dump({"pid": os.getpid(), "started_at": timestamp()}, handle)
        yield
    finally:
        path.unlink(missing_ok=True)


def image_url(value):
    if not isinstance(value, str):
        raise TransportError("image upload did not return a URL")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"mmbiz.qpic.cn", "mmbiz.qlogo.cn"} or parsed.username or parsed.password:
        raise TransportError("image upload returned an unexpected host")
    return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, ""))


class ImageRewrite(HTMLParser):
    def __init__(self, mapping):
        super().__init__(convert_charrefs=False)
        self.mapping, self.parts = mapping, []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "img":
            source = attributes.get("src")
            if source not in self.mapping:
                raise ValueError("body image has no upload result for this account")
            attributes["src"] = image_url(self.mapping[source])
        self.parts.append("<" + tag + "".join(f' {key}="{html.escape(value or "", quote=True)}"' for key, value in attributes.items()) + ">")

    def handle_endtag(self, tag):
        self.parts.append(f"</{tag}>")

    def handle_data(self, data):
        self.parts.append(html.escape(data))

    def handle_entityref(self, name):
        self.parts.append(f"&{name};")

    def handle_charref(self, name):
        self.parts.append(f"&#{name};")


class BodyEvidence(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text, self.images = [], []

    def handle_data(self, data):
        self.text.append(data)

    def handle_starttag(self, tag, attrs):
        if tag == "img":
            source = urlsplit(dict(attrs).get("src", ""))
            self.images.append((source.hostname, source.path, source.query))


def body_evidence(content):
    parser = BodyEvidence()
    parser.feed(content)
    return {"text": re.sub(r"[\s\u200b\ufeff]+", "", "".join(parser.text)), "images": parser.images}


def draft_articles(response):
    items = response.get("news_item")
    if not isinstance(items, list) or not items or not all(isinstance(item, dict) for item in items):
        raise TransportError("draft/get returned no article content")
    return items


def draft_fingerprint(items):
    keys = ("title", "author", "digest", "content", "content_source_url", "thumb_media_id",
            "need_open_comment", "only_fans_can_comment", "cover_info")
    return checksum([{key: item.get(key) for key in keys} for item in items])


def compare_draft(expected, actual):
    if len(expected) != len(actual):
        raise ValueError("remote draft article count does not match the prepared job")
    for left, right in zip(expected, actual):
        for key in ("title", "author", "thumb_media_id", "content_source_url"):
            if left.get(key, "") != right.get(key, ""):
                raise ValueError(f"remote draft {key} does not match the prepared article")
        if left.get("digest") and left["digest"] != right.get("digest"):
            raise ValueError("remote draft digest does not match")
        if body_evidence(left["content"]) != body_evidence(right.get("content", "")):
            raise ValueError("remote draft text or images differ from the prepared article")


class Publication:
    def __init__(self, account, plan_id, job, api, check_sources=True):
        self.account, self.job, self.api = account, job, api
        self.document = load_bundle(account, plan_id, job, check_sources=check_sources)
        self.root = bundle_path(account, plan_id, job["id"])
        self.path = self.root / "receipt.json"
        self.receipt = load_json(self.path, {"signature": self.document["signature"], "account": account_identity(account),
                                           "actions": {}, "status": "prepared"})
        if self.receipt.get("signature") != self.document["signature"]:
            raise ValueError("receipt belongs to a different article version")
        self.cache_path = account["root"] / "发布" / "media-cache.json"
        self.cache = load_json(self.cache_path, {"app_id": account["app_id"], "items": {}})
        if self.cache.get("app_id") != account["app_id"]:
            raise ValueError("media cache belongs to another AppID")

    def save(self):
        self.receipt["updated_at"] = timestamp()
        write_json(self.path, self.receipt)

    def operation(self, name, request, call, required=()):
        actions = self.receipt["actions"]
        previous = actions.get(name)
        request_hash = checksum(request)
        if previous:
            if previous["request_hash"] != request_hash:
                raise ValueError("operation input changed; prepare a new job version")
            if previous["status"] == "succeeded":
                return previous["result"]
            if previous["status"] == "unknown":
                raise ValueError(f"{name}: previous outcome is unknown; reconcile before another request")
        entry = {"status": "unknown", "request_hash": request_hash, "started_at": timestamp()}
        actions[name] = entry
        self.save()
        try:
            result = call()
            if not isinstance(result, dict) or any(result.get(key) is None or result.get(key) == "" for key in required):
                raise TransportError(f"{name}: successful response omitted its result identifier")
            if "url" in result:
                result["url"] = image_url(result["url"])
            entry.update(status="succeeded", result=result, completed_at=timestamp())
            self.save()
            return result
        except ApiError as error:
            entry.update(status="rejected", error_code=error.code, error=str(error))
            self.save()
            raise
        except TransportError as error:
            entry["status"] = "unknown" if error.dispatched else "rejected"
            entry["error"] = "Outcome uncertain; reconcile before retrying." if error.dispatched else "Credentials request failed before operation dispatch; retry is possible."
            self.save()
            raise
        except (OSError, ValueError):
            entry["error"] = "Outcome uncertain. Inspect the remote account before retrying."
            self.save()
            raise

    def upload(self, name, kind):
        path = relative_path(self.root, name)
        sha = digest(path.read_bytes())
        cache_key = kind + ":" + sha
        cached = self.cache["items"].get(cache_key)
        if cached:
            return cached
        endpoint = "media/uploadimg" if kind == "body" else "material/add_material"
        required = "url" if kind == "body" else "media_id"
        def perform():
            result = self.api.call(endpoint, image=path, query={} if kind == "body" else {"type": "image"})
            return {key: result[key] for key in ("url", "media_id") if key in result}
        result = self.operation("upload:" + cache_key, {"endpoint": endpoint, "sha256": sha}, perform, (required,))
        self.cache["items"][cache_key] = result
        write_json(self.cache_path, self.cache)
        return result

    def payload(self):
        result = []
        for article in self.document["articles"]:
            content = relative_path(self.root, article["content_file"]).read_text(encoding="utf-8")
            # Snapshot image paths are generated locally; no remote image is fetched here.
            class Sources(HTMLParser):
                def __init__(self):
                    super().__init__(); self.paths = []
                def handle_starttag(self, tag, attrs):
                    if tag == "img": self.paths.append(dict(attrs).get("src"))
            sources = Sources()
            sources.feed(content)
            mapping = {name: self.upload(name, "body")["url"] for name in dict.fromkeys(sources.paths)}
            rewrite = ImageRewrite(mapping)
            rewrite.feed(content)
            converted = "".join(rewrite.parts)
            if len(converted) >= 20_000 or len(converted.encode("utf-8")) >= 1024 * 1024:
                raise ValueError("uploaded image URLs pushed the article above WeChat's content limit")
            output = {key: value for key, value in article.items() if key not in {"content_file", "cover_file", "theme"}}
            output.update(content=converted, thumb_media_id=self.upload(article["cover_file"], "cover")["media_id"])
            result.append(output)
        write_json(self.root / "draft-payload.json", {"articles": result})
        return result

    def expected(self):
        value = load_json(self.root / "draft-payload.json")
        if not value or checksum(value) != self.receipt.get("payload_hash"):
            raise ValueError("draft payload is missing or changed; inspect the prepared version")
        return value["articles"]

    def verify_draft(self, media_id, adopt=False):
        actual = draft_articles(self.api.call("draft/get", {"media_id": media_id}))
        compare_draft(self.expected(), actual)
        fingerprint = draft_fingerprint(actual)
        prior = self.receipt.get("remote_fingerprint")
        if prior and fingerprint != prior and not adopt:
            raise ValueError("the draft was edited in WeChat after verification; review and prepare an update job")
        self.receipt.update(remote_fingerprint=fingerprint, draft_verified=True)
        self.save()
        return actual

    def drafted(self):
        action = self.receipt["actions"].get("draft")
        if not action or action["status"] != "succeeded":
            raise ValueError("create or reconcile this job's draft first")
        return action["result"]["media_id"]

    def draft(self):
        if any(self.receipt["actions"].get(kind, {}).get("status") in {"succeeded", "unknown"} for kind in ("publish", "mass", "delete")):
            raise ValueError("this draft is consumed or its delivery outcome is uncertain; query status")
        if self.receipt["actions"].get("draft", {}).get("status") == "succeeded":
            self.verify_draft(self.drafted())
            return self.summary(reused=True)
        payload = self.payload()
        payload_body = {"articles": payload}
        self.receipt["payload_hash"] = checksum(payload_body)
        self.save()
        replace_id = self.document.get("draft_media_id")
        if replace_id:
            actual = draft_articles(self.api.call("draft/get", {"media_id": replace_id}))
            if len(actual) != len(payload):
                raise ValueError("updating a draft requires the same article count; otherwise create a new draft")
            backup = self.root / "draft-before-update.json"
            if not backup.exists():
                write_json(backup, {"news_item": actual})
            for index, article in enumerate(payload):
                request = {"media_id": replace_id, "index": index, "articles": article}
                self.operation(f"update:{index}", request, lambda request=request: self.api.call("draft/update", request))
            result = self.operation("draft", payload_body, lambda: {"media_id": replace_id}, ("media_id",))
        else:
            result = self.operation("draft", payload_body,
                                    lambda: {"media_id": self.api.call("draft/add", payload_body).get("media_id")}, ("media_id",))
        self.verify_draft(result["media_id"], adopt=True)
        self.receipt["status"] = "drafted"
        self.save()
        return self.summary()

    def deliver(self, kind, now=None):
        if kind != self.document["delivery"]:
            raise ValueError("requested delivery differs from the prepared plan; publish and mass are separate actions")
        scheduled = due_at(self.document["not_before"])
        if scheduled and (now or datetime.now(timezone.utc)) < scheduled:
            return self.summary(status="scheduled", not_before=self.document["not_before"])
        other = "mass" if kind == "publish" else "publish"
        if self.receipt["actions"].get(other, {}).get("status") in {"succeeded", "unknown"}:
            raise ValueError("the draft has already been used for another delivery")
        previous = self.receipt["actions"].get(kind)
        if previous and previous["status"] == "succeeded":
            return self.status()
        if previous and previous["status"] == "unknown":
            raise ValueError("delivery outcome unknown; use reconcile with the remote task ID")
        media_id = self.drafted()
        self.verify_draft(media_id)
        if kind == "publish":
            request = {"media_id": media_id}
            def perform():
                result = self.api.call("freepublish/submit", request)
                return {key: result[key] for key in ("publish_id", "msg_data_id") if key in result}
            self.operation("publish", request, perform, ("publish_id",))
            self.receipt["status"] = "publish_submitted"
        else:
            audience = self.document["audience"]
            target = {"is_to_all": True} if audience.get("all") else {"is_to_all": False, "tag_id": audience["tag_id"]}
            request = {"filter": target, "mpnews": {"media_id": media_id}, "msgtype": "mpnews",
                       "send_ignore_reprint": 0, "clientmsgid": self.document["signature"][:32]}
            def perform():
                try:
                    result = self.api.call("message/mass/sendall", request)
                except ApiError as error:
                    if error.code != 45065:
                        raise
                    result = error.result
                return {"msg_id": result.get("msg_id", result.get("msgid")), "msg_data_id": result.get("msg_data_id")}
            self.operation("mass", request, perform, ("msg_id",))
            self.receipt["status"] = "mass_submitted"
        self.save()
        return self.summary()

    def preview(self, openid):
        if not isinstance(openid, str) or not openid.strip():
            raise ValueError("preview requires the intended recipient's OpenID")
        media_id = self.drafted()
        self.verify_draft(media_id)
        request = {"touser": openid, "mpnews": {"media_id": media_id}, "msgtype": "mpnews"}
        result = self.operation("preview:" + digest(openid.encode())[:16], request,
                                lambda: {"msg_id": self.api.call("message/mass/preview", request).get("msg_id")}, ("msg_id",))
        return self.summary(status="preview_submitted", preview_msg_id=result["msg_id"])

    def delete(self):
        if any(self.receipt["actions"].get(kind, {}).get("status") in {"succeeded", "unknown"} for kind in ("publish", "mass")):
            raise ValueError("delivery already submitted; this action only deletes unused drafts")
        media_id = self.drafted()
        request = {"media_id": media_id}
        self.operation("delete", request, lambda: self.api.call("draft/delete", request))
        self.receipt["status"] = "draft_deleted"
        self.save()
        return self.summary()

    def status(self):
        actions = self.receipt["actions"]
        if any(item.get("status") == "unknown" and not name.startswith("preview:")
               for name, item in actions.items()):
            return self.summary(status="needs_reconciliation")
        if actions.get("publish", {}).get("status") == "succeeded":
            remote_id = actions["publish"]["result"]["publish_id"]
            result = self.api.call("freepublish/get", {"publish_id": remote_id})
            if result.get("publish_status") not in PUBLISH_STATES:
                raise TransportError("unknown WeChat publish_status; retain the previous receipt")
            self.receipt.update(status=PUBLISH_STATES[result["publish_status"]],
                                publication={key: result[key] for key in ("publish_id", "publish_status", "article_id", "article_detail", "fail_idx") if key in result})
        elif actions.get("mass", {}).get("status") == "succeeded":
            remote_id = actions["mass"]["result"]["msg_id"]
            try:
                result = self.api.call("message/mass/get", {"msg_id": str(remote_id)})
            except ApiError as error:
                if error.code not in {89504, 89505}:
                    raise
                self.receipt.update(status="mass_pending_review", mass_result={"msg_id": remote_id, "error_code": error.code})
                self.save()
                return self.summary()
            state = result.get("msg_status")
            if not isinstance(state, str) or not state:
                raise TransportError("mass/get omitted msg_status")
            status = {"SEND_SUCCESS": "mass_sent", "SENDING": "mass_sending", "DELETE": "mass_deleted"}.get(
                state, "mass_failed" if state.startswith("SEND_FAIL") else "mass_status_unknown")
            self.receipt.update(status=status, mass_result={"msg_id": remote_id, "msg_status": state})
        elif actions.get("delete", {}).get("status") == "succeeded":
            return self.summary()
        elif actions.get("draft", {}).get("status") == "succeeded":
            self.verify_draft(self.drafted())
            self.receipt["status"] = "drafted"
        else:
            return self.summary()
        self.save()
        return self.summary()

    def reconcile(self, kind, remote_id):
        previous = self.receipt["actions"].get(kind)
        updates = {name: item for name, item in self.receipt["actions"].items() if name.startswith("update:")}
        if kind == "draft" and previous is None and remote_id == self.document.get("draft_media_id") and any(item["status"] == "unknown" for item in updates.values()):
            previous = {"status": "unknown", "request_hash": checksum({"articles": self.expected()})}
            self.receipt["actions"]["draft"] = previous
        if not previous or previous["status"] != "unknown":
            raise ValueError("reconciliation applies only to an uncertain recorded operation")
        if kind == "draft":
            self.verify_draft(remote_id, adopt=True)
            for item in updates.values():
                if item["status"] == "unknown":
                    item.update(status="succeeded", result={"errcode": 0}, reconciled_at=timestamp())
            result, state = {"media_id": remote_id}, "drafted"
        elif kind == "publish":
            probe = self.api.call("freepublish/get", {"publish_id": remote_id})
            if probe.get("publish_status") not in PUBLISH_STATES:
                raise ValueError("remote publish task is not queryable by this account")
            result, state = {"publish_id": remote_id}, "publish_submitted"
        elif kind == "mass":
            probe = self.api.call("message/mass/get", {"msg_id": remote_id})
            if not probe.get("msg_status"):
                raise ValueError("remote mass task is not queryable by this account")
            result, state = {"msg_id": remote_id}, "mass_submitted"
        else:
            raise ValueError("reconcile supports draft, publish and mass")
        previous.update(status="succeeded", result=result, reconciled_at=timestamp(),
                        reconciliation="operator-selected remote ID; draft content verified when available")
        self.receipt["status"] = state
        self.save()
        return self.summary()

    def retry_media(self):
        if any(self.receipt["actions"].get(kind, {}).get("status") in {"unknown", "succeeded"} for kind in ("draft", "publish", "mass")):
            raise ValueError("a draft or delivery already exists or is uncertain; reconcile it before changing media")
        reset = []
        for name, entry in self.receipt["actions"].items():
            if name.startswith("upload:") and entry["status"] == "unknown":
                self.receipt.setdefault("media_retry_history", []).append({"operation": name, **entry})
                entry["status"] = "retryable"
                reset.append(name)
        self.save()
        return self.summary(retryable_media=reset, note="The next upload may leave an unused duplicate in WeChat; no draft is resent.")

    def summary(self, **extra):
        status = self.receipt["status"]
        actions = self.receipt["actions"]
        if any(item["status"] == "unknown" and not name.startswith("preview:")
               for name, item in actions.items()):
            status = "needs_reconciliation"
        elif actions.get("delete", {}).get("status") == "succeeded":
            status = "draft_deleted"
        elif status in {"prepared", "drafted"}:
            for kind in ("publish", "mass"):
                if actions.get(kind, {}).get("status") == "succeeded":
                    status = kind + "_submitted"
            if status == "prepared" and actions.get("draft", {}).get("status") == "succeeded":
                status = "draft_created_unverified"
        result = {"job": self.job["id"], "account": self.account["id"], "status": status,
                  "receipt": str(self.path), "actions": {key: value["status"] for key, value in self.receipt["actions"].items()}}
        for kind in ("draft", "publish", "mass"):
            item = self.receipt["actions"].get(kind, {})
            if item.get("status") == "succeeded":
                result[kind] = item["result"]
        if "publication" in self.receipt:
            result["publication"] = self.receipt["publication"]
        if "mass_result" in self.receipt:
            result["mass_result"] = self.receipt["mass_result"]
        return {**result, **extra}


def make_api(account):
    secret = os.environ.get(account["secret_env"])
    if not secret:
        raise ValueError(f"account {account['id']}: configure {account['secret_env']} in the execution environment")
    return WeChatAPI(account["app_id"], secret)


def run_plan(registry_path, plan_path, action, run=False, jobs=(), openid=None, api_factory=make_api):
    accounts = registry(registry_path)
    plan = read_plan(plan_path, accounts)
    if set(jobs) - {job["id"] for job in plan["jobs"]}:
        raise ValueError("unknown selected job id")
    selected = [job for job in plan["jobs"] if not jobs or job["id"] in jobs]
    result, clients = [], {}
    for job in selected:
        account = accounts[job["account"]]
        try:
            document = load_bundle(account, plan["id"], job, check_sources=action not in {"status", "delete"})
            if action in {"publish", "mass"} and action != document["delivery"]:
                raise ValueError("action differs from this job's planned delivery")
            scheduled = due_at(document["not_before"])
            if action in {"publish", "mass"} and scheduled and datetime.now(timezone.utc) < scheduled:
                result.append({"job": job["id"], "account": account["id"], "status": "scheduled", "not_before": document["not_before"]})
                continue
            if not run:
                if action == "status":
                    result.append(Publication(account, plan["id"], job, None, check_sources=False).summary(local=True, network_called=False))
                    continue
                result.append({"job": job["id"], "account": account["id"], "status": "checked", "action": action,
                               "title": [item["title"] for item in document["articles"]], "audience": document["audience"],
                               "configured": bool(os.environ.get(account["secret_env"])), "network_called": False})
                continue
            if account["id"] not in clients:
                clients[account["id"]] = api_factory(account)
            with account_lock(account):
                publication = Publication(account, plan["id"], job, clients[account["id"]], check_sources=action not in {"status", "delete"})
                if action == "draft": outcome = publication.draft()
                elif action in {"publish", "mass"}: outcome = publication.deliver(action)
                elif action == "preview": outcome = publication.preview(openid)
                elif action == "delete": outcome = publication.delete()
                else: outcome = publication.status()
                result.append(outcome)
        except (ValueError, OSError) as error:
            result.append({"job": job["id"], "account": account["id"], "status": "error", "error": str(error)})
    summary = {"action": action, "executed": run, "jobs": result, "ok": all(item["status"] != "error" for item in result)}
    if run:
        write_report(plan_path, summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("accounts", "prepare", "run", "drafts", "reconcile", "retry-media"):
        command = commands.add_parser(name)
        command.add_argument("--registry", type=Path, required=True)
        if name in {"prepare", "run", "reconcile", "retry-media"}:
            command.add_argument("--plan", type=Path, required=True)
        if name == "run":
            command.add_argument("--action", choices=("draft", "publish", "mass", "preview", "status", "delete"), required=True)
            command.add_argument("--jobs", default="")
            command.add_argument("--openid")
            command.add_argument("--run", action="store_true")
        if name == "drafts":
            command.add_argument("--account", required=True)
            command.add_argument("--offset", type=int, default=0)
            command.add_argument("--count", type=int, default=20)
        if name in {"reconcile", "retry-media"}:
            command.add_argument("--job", required=True)
        if name == "reconcile":
            command.add_argument("--kind", choices=("draft", "publish", "mass"), required=True)
            command.add_argument("--remote-id", required=True)
    args = parser.parse_args()
    try:
        accounts = registry(args.registry)
        if args.command == "accounts":
            result = {"accounts": [{**account_identity(account), "root": str(account["root"]),
                                   "secret_env": account["secret_env"], "configured": bool(os.environ.get(account["secret_env"]))}
                                  for account in accounts.values()]}
        elif args.command == "drafts":
            if args.account not in accounts or args.offset < 0 or not 1 <= args.count <= 20:
                raise ValueError("select a known account, nonnegative offset and count from 1 to 20")
            result = make_api(accounts[args.account]).call("draft/batchget", {"offset": args.offset, "count": args.count, "no_content": 1})
        elif args.command == "prepare":
            plan = read_plan(args.plan, accounts)
            result = {"jobs": [prepare_job(accounts[job["account"]], plan["id"], job) for job in plan["jobs"]]}
        elif args.command in {"reconcile", "retry-media"}:
            plan = read_plan(args.plan, accounts)
            job = next((job for job in plan["jobs"] if job["id"] == args.job), None)
            if job is None:
                raise ValueError("unknown job")
            account = accounts[job["account"]]
            with account_lock(account):
                if args.command == "retry-media":
                    result = Publication(account, plan["id"], job, None).retry_media()
                else:
                    result = Publication(account, plan["id"], job, make_api(account), check_sources=False).reconcile(args.kind, args.remote_id)
        else:
            result = run_plan(args.registry, args.plan, args.action, args.run,
                              [value.strip() for value in args.jobs.split(",") if value.strip()], args.openid)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0 if result.get("ok", True) else 1
    except ImportError:
        print("Install scripts/requirements.txt in this Python environment.", file=sys.stderr)
        return 1
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
