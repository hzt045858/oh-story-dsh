"""Run an article image job through the bundled provider adapter, with receipts."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from article_library import contained, digest, load_json, write_json


def provider_contract(adapter, provider, payload):
    """Keep the bundled adapter compatible while allowing explicitly selected providers."""
    if hasattr(adapter, "describe_image_provider") and hasattr(adapter, "compile_image_payload"):
        info = adapter.describe_image_provider(provider)
        if not isinstance(info, dict) or info.get("name") != provider:
            raise ValueError("adapter must describe the explicitly selected provider")
        compiled = adapter.compile_image_payload(provider, payload)
    elif provider == "gpt-image-2":
        info = {"name": provider, "required_env": ["OPENAI_API_KEY"],
                "reference_images": True, "native_text": True}
        compiled = adapter.compile_gpt_image_2_payload(payload)
    else:
        raise ValueError("selected provider is unavailable; do not silently switch models")
    variables = info.get("required_env")
    if not isinstance(variables, list) or any(not isinstance(v, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", v) for v in variables):
        raise ValueError("adapter required_env must contain environment-variable names, never secret values")
    if not isinstance(compiled, dict):
        raise ValueError("adapter compiler must return an object")
    requirements = payload.get("requirements", {})
    if payload.get("references") and info.get("reference_images") is not True:
        raise ValueError("selected provider does not support required reference images")
    if requirements.get("text_rendering") == "model" and info.get("native_text") is not True:
        raise ValueError("provider lacks required image-text capability; explicitly revise the rendering strategy")
    supported = info.get("sizes")
    if supported is not None and (not isinstance(supported, list) or compiled.get("size") not in supported):
        raise ValueError("requested size is unsupported; revise the plan rather than silently changing it")
    return info, compiled


def local_file(root: Path, value: str) -> Path:
    if not isinstance(value, str) or Path(value).is_absolute() or ".." in Path(value).parts:
        raise ValueError("input paths must be relative to the article directory")
    original = root / value
    path = contained(root, value)
    if original.is_symlink() or not path.is_file():
        raise ValueError("image input must be a regular existing file")
    return path


def prepare(job_path: Path, adapter_script: Path):
    root = job_path.resolve().parent
    raw = load_json(job_path)
    if not isinstance(raw, dict) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", str(raw.get("id", ""))):
        raise ValueError("job requires a stable, path-safe id")
    from article_workflow import has_contract, verify_job
    controlled = has_contract(root) or "control" in raw
    if controlled:
        verify_job(root, raw)
    article = local_file(root, raw.get("article_file"))
    prompt = local_file(root, raw.get("prompt_file"))
    for key, path in (("article_sha256", article), ("prompt_sha256", prompt)):
        if controlled and key == "article_sha256":
            # verify_job binds only this card's actual content/style dependencies.
            continue
        if raw.get(key) != digest(path.read_bytes()):
            raise ValueError(f"{key} does not match the current file; review the image plan")
    output_name = raw.get("output")
    if not isinstance(output_name, str) or not Path(output_name).parts or Path(output_name).is_absolute() or ".." in Path(output_name).parts:
        raise ValueError("output must be a relative image path")
    if Path(output_name).parts[0] != "images" or Path(output_name).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise ValueError("output must be an image under images/")
    output = contained(root, output_name)
    references = raw.get("references", [])
    if not isinstance(references, list):
        raise ValueError("references must be an array of local image paths")
    reference_hashes = {name: digest(local_file(root, name).read_bytes()) for name in references}
    payload = {"modality": "image", "project_root": str(root), "prompt": prompt.read_text(encoding="utf-8-sig"),
               "parameters": raw.get("parameters", {}), "references": references, "outputs": [output_name]}
    if controlled:
        payload["requirements"] = raw["requirements"]
    spec = importlib.util.spec_from_file_location("wechat_image_provider", adapter_script.resolve())
    if spec is None or spec.loader is None:
        raise ValueError("image adapter is not available")
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    provider = raw.get("provider", "gpt-image-2")
    if not isinstance(provider, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", provider):
        raise ValueError("invalid selected provider")
    info, compiled = provider_contract(adapter, provider, payload)
    signed_job = {k: v for k, v in raw.items() if not (controlled and k == "article_sha256")}
    signature = digest(json.dumps({"job": signed_job, "reference_hashes": reference_hashes,
                                   "compiled": compiled, "provider_contract": info,
                                   "adapter_sha256": digest(adapter_script.read_bytes())}, sort_keys=True).encode())
    compiled = {**compiled, "_wechat_provider": info}
    return raw, payload, output, signature, compiled


def failure_diagnostics(stdout) -> dict:
    try:
        response = json.loads(stdout)
    except (ValueError, UnicodeError, TypeError):
        return {}
    error = response.get("error") if isinstance(response, dict) else None
    if not isinstance(error, dict):
        return {}
    # The adapter sanitizes these fields; never retain its raw message or output.
    result = {}
    for key in ("request_id", "category", "code"):
        value = error.get(key)
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}", value):
            result[key] = value
    status = error.get("http_status")
    if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
        result["http_status"] = status
    if isinstance(error.get("retryable"), bool):
        result["retryable"] = error["retryable"]
    return result


def execute(job_path: Path, adapter_script: Path, run=False, runner=subprocess.run):
    raw, payload, output, signature, compiled = prepare(job_path, adapter_script)
    receipt_path = job_path.with_suffix(".receipt.json")
    old = load_json(receipt_path)
    if old:
        if old.get("signature") != signature:
            raise ValueError("job changed after dispatch; preserve its receipt and use a new job version")
        if old.get("status") == "succeeded" and output.is_file() and digest(output.read_bytes()) == old.get("output_sha256"):
            return {**old, "reused": True}
        raise ValueError("previous dispatch needs reconciliation; refusing an automatic paid retry")
    if output.exists():
        raise ValueError("output already exists; choose a new version")
    info = compiled["_wechat_provider"]
    missing_env = [name for name in info["required_env"] if not os.environ.get(name)]
    check = {"id": raw["id"], "provider": info["name"], "output": str(output),
             "size": compiled.get("size", "auto"), "configured": not missing_env, "missing_env": missing_env,
             "status": "validated", "dispatched": False}
    if "control" in raw:
        check.update(control=raw["control"], prompt_sha256=raw["prompt_sha256"],
                     request_payload_sha256=digest(json.dumps(payload, sort_keys=True).encode("utf-8")))
    if not run:
        return check
    if not check["configured"]:
        raise ValueError("required provider environment variables are missing: " + ", ".join(missing_env))
    receipt = {**check, "signature": signature, "status": "dispatched_unknown", "dispatched": True,
               "dispatched_at": datetime.now(timezone.utc).isoformat()}
    # Exclusive receipt creation prevents a concurrent invocation from dispatching the same job twice.
    with receipt_path.open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, ensure_ascii=True)
    try:
        with tempfile.TemporaryDirectory(prefix="wechat-image-") as temporary:
            payload["output_root"] = temporary
            result = runner([sys.executable, str(adapter_script.resolve()), info["name"]],
                            input=json.dumps(payload).encode("utf-8"), capture_output=True, timeout=360)
            if result.returncode != 0:
                diagnostics = failure_diagnostics(result.stdout)
                if diagnostics:
                    receipt["provider_error"] = diagnostics
                raise ValueError("provider did not complete; inspect its job status before retrying")
            response = json.loads(result.stdout)
            if not isinstance(response, dict):
                raise ValueError("provider response must be an object")
            if isinstance(response.get("provider_job_id"), str):
                receipt["provider_job_id"] = response["provider_job_id"]
            results = response.get("outputs", [])
            if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict) or results[0].get("target") != raw["output"]:
                raise ValueError("provider output does not match the image job")
            source = Path(results[0]["source"])
            if source.is_symlink() or not source.resolve().is_relative_to(Path(temporary).resolve()) or not source.is_file():
                raise ValueError("provider output escaped its temporary directory")
            if not 0 < source.stat().st_size <= 32 * 1024 * 1024:
                raise ValueError("provider output is empty or larger than 32 MiB")
            content = source.read_bytes()
            signatures = {".png": content.startswith(b"\x89PNG\r\n\x1a\n"),
                          ".jpg": content.startswith(b"\xff\xd8\xff"), ".jpeg": content.startswith(b"\xff\xd8\xff"),
                          ".webp": content.startswith(b"RIFF") and content[8:12] == b"WEBP"}
            if not signatures[output.suffix.lower()]:
                raise ValueError("image bytes do not match the output format")
            if "control" in raw:
                from article_workflow import image_requirements, verify_job
                verify_job(job_path.resolve().parent, raw)
                image_requirements(source, raw["requirements"])
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("xb") as handle:
                handle.write(content)
            receipt.update(status="succeeded", output_sha256=digest(content),
                           completed_at=datetime.now(timezone.utc).isoformat())
            write_json(receipt_path, receipt)
            return receipt
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        receipt["error"] = "Generation outcome is uncertain; reconcile before another paid request."
        write_json(receipt_path, receipt)
        raise ValueError(receipt["error"]) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", type=Path)
    parser.add_argument("--adapter-script", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--run", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(execute(args.job, args.adapter_script, args.run), ensure_ascii=True, indent=2))
        return 0
    except (ValueError, OSError, TypeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
