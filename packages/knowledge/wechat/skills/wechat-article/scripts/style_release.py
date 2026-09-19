"""Issue source-backed, account-bound style releases after the current Agent reviews them.

Only audit/seal/next access the corpus. Loading a saved release for daily writing
never scans the source directory, reads source articles, or repeats OCR.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from pathlib import Path

from article_library import SYSTEM, CATALOG, INDEX, build_index, digest, load_json, read_article, scan, write_json

RELEASE = f"{SYSTEM}/07_处理状态/模型验收.json"
MODEL_CHECKS = ("full_content", "topic_coverage", "joint_style", "identity", "transferability")


def load_release(account, account_id):
    from article_workflow import checksum, obj, safe
    release = obj(safe(account, RELEASE, True))
    unsigned = {k: v for k, v in release.items() if k != "signature"}
    if (release.get("schema_version") != 1 or release.get("workflow") != "style-release-v1"
            or release.get("signature") != checksum(unsigned) or release.get("account_id") != account_id
            or release.get("status") not in {"ready", "limited"}):
        raise ValueError("model release is missing, modified or belongs to another account")
    models = release.get("models")
    if not isinstance(models, list) or not models or not all(isinstance(m, dict) for m in models):
        raise ValueError("verified model catalog is missing")
    keys = [m.get("key") for m in models]
    if any(not isinstance(key, str) or not key for key in keys) or len(set(keys)) != len(keys):
        raise ValueError("model keys must be unique")
    for model in models:
        name = model.get("file")
        if not isinstance(name, str) or not name.startswith(SYSTEM + "/") or model.get("kind") not in {"global", "topic", "visual"}:
            raise ValueError("model files must be account-owned analysis artifacts")
        if digest(safe(account, name, True).read_bytes()) != model.get("sha256"):
            raise ValueError("saved model changed since release; review an updated release before using it")
    return release


def corpus_audit(account):
    from article_workflow import obj, safe
    account = account.resolve()
    catalog = obj(safe(account, CATALOG, True))
    # Source updates happen here, never inside load_release/current/compile.
    source = Path(catalog["source_root"]).resolve()
    if not source.is_dir():
        raise ValueError("source unavailable for model update; existing releases still support daily writing")
    scan(account, source)
    build_index(account)
    index = obj(safe(account, INDEX, True))
    rows, bodies, issues = {}, {}, []
    body_image_articles = 0
    excluded = []
    for row in index["articles"]:
        if row.get("read_status") == "missing":
            excluded.append({"id": row["id"], "reason": "source no longer present"})
            continue
        if row.get("duplicate_of") or row.get("duplicate_status") == "完全重复":
            excluded.append({"id": row["id"], "reason": "exact duplicate", "duplicate_of": row.get("duplicate_of")})
            continue
        rows[row["id"]] = row
        if row.get("annotation_status") != "ready":
            issues.append({"id": row["id"], "reason": row.get("pending_reason", "annotation pending")})
            continue
        try:
            _title, body, sha = read_article(safe(source, row["source_file"], True))
            if sha != row["source_sha256"]:
                raise ValueError("source hash changed")
            if row.get("has_image_references"):
                joint = obj(safe(account, row["joint_analysis_file"], True))
                body_image_articles += any(u.get("role") == "body" for u in joint["units"])
            bodies[row["id"]] = body
        except (ValueError, OSError, KeyError) as error:
            issues.append({"id": row["id"], "reason": str(error)})
    ready = {key: row for key, row in rows.items() if key in bodies}
    categories = sorted({r["primary_category"] for r in ready.values() if r.get("primary_category")})
    coverage = {"included": len(rows), "ready": len(ready), "pending": len(issues),
                "image_articles": sum(bool(r.get("has_image_references")) for r in rows.values()),
                "body_image_articles": body_image_articles,
                "joint_reviewed": sum(bool(r.get("joint_analysis_sha256")) for r in ready.values()),
                "topics": categories, "excluded": excluded}
    return {"rows": rows, "ready": ready, "bodies": bodies, "issues": issues, "coverage": coverage}


def audit(account, model_entries):
    from article_workflow import checksum, identifier, obj, safe, text
    account = account.resolve()
    config = obj(safe(account, "账号.json", True))
    account_id = identifier(config.get("id"), "account id")
    corpus = corpus_audit(account)
    if not isinstance(model_entries, list) or not model_entries or not all(isinstance(m, dict) for m in model_entries):
        raise ValueError("supply a model catalog with global, topic and applicable visual entries")
    models, errors, keys, topics = [], [], set(), set()
    for entry in model_entries:
        key = text(entry.get("key"), "model key")
        if key in keys or "/" in key:
            raise ValueError("model keys must be unique and cannot contain a slash")
        keys.add(key)
        kind = entry.get("kind")
        if kind not in {"global", "topic", "visual"}:
            raise ValueError("model kind must be global, topic or visual")
        name = entry.get("file")
        if not isinstance(name, str) or not name.startswith(SYSTEM + "/"):
            raise ValueError("models must be saved independently under 作者风格系统/")
        path = safe(account, name, True)
        model = obj(path)
        rules = model.get("rules")
        if not isinstance(rules, list) or not rules or not all(isinstance(r, dict) for r in rules):
            errors.append(f"{key}: executable rules missing")
            continue
        ids = set()
        model_evidence = set()
        for rule in rules:
            ident = text(rule.get("id"), "rule id")
            if ident in ids:
                errors.append(f"{key}: duplicate rule id")
            ids.add(ident)
            for field in ("rule", "how_to_apply", "boundaries", "stability"):
                text(rule.get(field), key + " " + field)
            evidence = rule.get("evidence")
            if not isinstance(evidence, list) or not evidence or not all(isinstance(e, dict) for e in evidence):
                errors.append(f"{key}/{ident}: concrete source evidence missing")
                continue
            rule_sources = set()
            for evidence_item in evidence:
                source_id = evidence_item.get("article_id", evidence_item.get("id"))
                physical = corpus["ready"].get(source_id)
                if physical is None:
                    errors.append(f"{key}/{ident}: evidence is not a currently reviewed article: {source_id}")
                    continue
                rule_sources.add(source_id)
                model_evidence.add(source_id)
                if kind == "visual":
                    from article_joint import check
                    record_name = physical.get("joint_analysis_file")
                    result = check(account, record_name, physical.get("joint_analysis_sha256"), source_id)
                    if not result["ok"]:
                        errors.append(f"{key}/{ident}: whole-article joint evidence is incomplete")
                        continue
                    joint = obj(safe(account, record_name, True))
                    unit = next((u for u in joint["units"] if u["order"] == evidence_item.get("order")), None)
                    if (unit is None or unit.get("role") != "body"
                            or unit.get("image_sha256") != evidence_item.get("image_sha256")):
                        errors.append(f"{key}/{ident}: visual evidence must bind a reviewed body image, not a banner")
                    text(evidence_item.get("observation"), "joint visual observation")
                else:
                    if evidence_item.get("source_sha256") != physical["source_sha256"]:
                        errors.append(f"{key}/{ident}: missing/stale source hash")
                    if evidence_item.get("evidence_type") == "verbatim":
                        quote = text(evidence_item.get("quote"), "verbatim evidence")
                        body = corpus["bodies"][source_id]
                        if physical.get("has_image_references"):
                            from article_ingest import extraction_for
                            extracted = extraction_for(account, physical)
                            body = safe(account, extracted["extracted_file"], True).read_text(encoding="utf-8")
                            joint = obj(safe(account, physical["joint_analysis_file"], True))
                            body += "\n" + "\n".join(u.get("text_evidence", "") for u in joint["units"] if u.get("role") == "body")
                        if quote not in body:
                            errors.append(f"{key}/{ident}: claimed quotation not found in its source")
                    else:
                        text(evidence_item.get("summary", evidence_item.get("observation")), "source summary")
            if rule.get("stability") in {"global", "stable", "高", "high"} and len(rule_sources) < 2:
                errors.append(f"{key}/{ident}: a stable rule needs cross-article evidence; otherwise retain local scope")
        if kind == "topic":
            topic = text(entry.get("topic"), "topic model scope")
            topics.add(topic)
            if any(corpus["ready"][source_id]["primary_category"] != topic for source_id in model_evidence):
                errors.append(f"{key}: topic model evidence belongs to another category")
        models.append({**entry, "sha256": digest(path.read_bytes())})
    if not any(m["kind"] == "global" for m in models):
        errors.append("global style model missing")
    if corpus["coverage"]["body_image_articles"] and not any(m["kind"] == "visual" for m in models):
        errors.append("image corpus requires a joint visual style model")
    uncovered = sorted(set(corpus["coverage"]["topics"]) - topics)
    candidate = {"schema_version": 1, "workflow": "style-release-v1", "account_id": account_id,
                 "coverage": corpus["coverage"], "models": models,
                 "source_snapshot": [{"id": r["id"], "source_sha256": r.get("source_sha256"),
                                      "joint_analysis_sha256": r.get("joint_analysis_sha256")}
                                     for r in corpus["rows"].values()]}
    return {"candidate": candidate, "input_signature": checksum(candidate), "model_errors": errors,
            "pending_articles": corpus["issues"], "uncovered_topics": uncovered,
            "semantic_quality_verified_by_script": False}


def seal(account, model_entries, review, limited_reason=""):
    from article_workflow import checked_review, checksum, exclusive, safe
    with exclusive(account):
        result = audit(account, model_entries)
        if result["model_errors"]:
            raise ValueError("; ".join(result["model_errors"][:20]))
        if not result["candidate"]["coverage"]["ready"]:
            raise ValueError("no reviewed source articles; cannot issue a style release")
        incomplete = bool(result["pending_articles"] or result["uncovered_topics"])
        if incomplete and not limited_reason.strip():
            raise ValueError("full coverage is incomplete; never promote a partial model to ready")
        checked_review(review, result["input_signature"], MODEL_CHECKS, "model release")
        release = {**result["candidate"], "status": "limited" if incomplete or limited_reason else "ready",
                   "limited_reason": limited_reason, "pending_articles": result["pending_articles"],
                   "uncovered_topics": result["uncovered_topics"], "review": review}
        release["signature"] = checksum(release)
        archive = safe(account, f"{SYSTEM}/07_处理状态/model-releases/{release['signature']}.json")
        archive.parent.mkdir(parents=True, exist_ok=True)
        if not archive.exists():
            with archive.open("x", encoding="utf-8") as handle:
                json.dump(release, handle, ensure_ascii=False, indent=2)
        write_json(safe(account, RELEASE), release)
        return {"status": release["status"], "release": RELEASE, "signature": release["signature"],
                "coverage": release["coverage"], "semantic_quality_verified_by_script": False}


def next_batch(account, limit=5):
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError("batch limit must be between 1 and 20")
    corpus = corpus_audit(account)
    work = []
    for issue in corpus["issues"][:limit]:
        row = corpus["rows"][issue["id"]]
        item = {**issue, "source_file": row["source_file"]}
        if row.get("has_image_references"):
            from article_joint import prepare
            try:
                packet = prepare(account, row["id"])
                name = f"{SYSTEM}/02_文章卡片/图文联合分析/{row['id']}-{packet['analysis_input_sha256'][:16]}.packet.json"
                write_json(account / name, packet)
                item.update(packet=name, next_action="view ordered images and write joint evidence")
            except (ValueError, OSError, KeyError) as error:
                item.update(next_action="ingest/resolve extraction first", reason=str(error))
        else:
            item["next_action"] = "read the complete source and write source-bound annotation/card"
        work.append(item)
    return {"coverage": corpus["coverage"], "work": work, "remaining": len(corpus["issues"]), "analysis_completed": False}


def init_account(account):
    from article_workflow import identifier, safe
    account = account.resolve()
    config = load_json(account / "账号.json", {})
    if not isinstance(config, dict):
        raise ValueError("account config must be an object")
    adjacent = load_json(account.parent / "accounts.json")
    matched = []
    if adjacent is not None:
        if not isinstance(adjacent, dict) or not isinstance(adjacent.get("accounts"), list):
            raise ValueError("adjacent publication registry is malformed; do not create a second identity")
        for entry in adjacent["accounts"]:
            if isinstance(entry, dict) and isinstance(entry.get("root"), str):
                if safe(account.parent, entry["root"]).resolve() == account:
                    matched.append(entry)
    if len(matched) > 1:
        raise ValueError("more than one publication identity targets this account")
    if matched:
        entry = matched[0]
        expected = identifier(entry.get("id"), "publication account id")
        if config.get("id") is not None and config["id"] != expected:
            raise ValueError("creative/publication account IDs differ; reconcile explicitly, do not overwrite history")
        if config.get("app_id") is not None and config["app_id"] != entry.get("app_id"):
            raise ValueError("creative/publication AppIDs differ; reconcile before initializing")
        config["id"] = expected
        if entry.get("app_id"):
            config["app_id"] = entry["app_id"]
    config.setdefault("id", "wechat-" + uuid.uuid4().hex)
    config.setdefault("name", account.name)
    identifier(config["id"], "account id")
    write_json(safe(account, "账号.json"), config)
    return {"id": config["id"], "name": config["name"], "publication_identity_reused": bool(matched)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init-account", "audit", "seal", "next", "check"))
    parser.add_argument("--account", type=Path, required=True)
    parser.add_argument("--models", help="account-relative catalog JSON containing models[]")
    parser.add_argument("--review", help="account-relative source-bound model review JSON")
    parser.add_argument("--limited-reason", default="")
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()
    try:
        from article_workflow import obj, safe
        account = args.account.resolve()
        if args.command == "init-account":
            result = init_account(account)
        elif args.command == "next":
            result = next_batch(account, args.limit)
        elif args.command == "check":
            config = obj(safe(account, "账号.json", True))
            saved = load_release(account, config["id"])
            result = {"status": saved["status"], "coverage": saved["coverage"], "source_articles_read": []}
        else:
            entries = obj(safe(account, args.models, True)).get("models")
            result = audit(account, entries) if args.command == "audit" else seal(account, entries, obj(safe(account, args.review, True)), args.limited_reason)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 1 if result.get("model_errors") else 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"status": "blocked", "error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
