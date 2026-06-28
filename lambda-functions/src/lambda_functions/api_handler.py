import base64
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from lambda_functions import doc_registry, process_quality, sop_lint, sop_parse
from lambda_functions.http import response


CONTENT_ROOT = Path(os.environ.get("CONTENT_ROOT", os.environ.get("DOCS_ROOT", "../content"))).resolve()
CONTENT_PREFIX = "content/"
DOC_PATH_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9/_-]*\.md$")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("requestContext", {}).get("http", {}).get("method", event.get("httpMethod"))
    if method == "OPTIONS":
        return response(204, {})

    path = event.get("rawPath") or event.get("path") or "/"

    try:
        if path == "/docs/registry" and method == "GET":
            return get_doc_registry()

        if path == "/docs/resolve" and method == "GET":
            return resolve_doc(query_param(event, "ref"))

        if path == "/docs/process-quality" and method == "GET":
            return get_process_quality()

        if path == "/docs" and method == "GET":
            doc_path = query_param(event, "path")
            if doc_path:
                return get_doc(doc_path)
            return list_docs()

        if path == "/docs" and method == "PUT":
            return save_doc(query_param(event, "path"), json_body(event))

        if path == "/docs" and method == "POST":
            return create_doc(json_body(event))

        if path == "/docs" and method == "DELETE":
            return delete_doc(query_param(event, "path"))

        if path == "/docs/rename" and method == "POST":
            return rename_doc(json_body(event))

        if path == "/docs/backlinks" and method == "GET":
            return list_backlinks(query_param(event, "path"))

        if path == "/folders" and method == "DELETE":
            return delete_folder(query_param(event, "path"))

        if path == "/folders/rename" and method == "POST":
            return rename_folder(json_body(event))

        if path == "/lint" and method == "GET":
            return run_corpus_lint()

        if path == "/parse" and method == "POST":
            return parse_content(json_body(event))

        if path == "/images" and method == "POST":
            return upload_image(json_body(event))

        return response(404, {"error": "Not found"})
    except ValueError as exc:
        return response(400, {"error": str(exc)})
    except FileNotFoundError:
        return response(404, {"error": "Document not found"})


def list_docs() -> dict[str, Any]:
    docs = []
    registry = doc_registry.build_registry(CONTENT_ROOT)
    for record in registry.documents:
        item = record.to_dict()
        item["updated"] = item["updated_at"]
        docs.append(item)

    return response(200, {"documents": docs})


def get_doc_registry() -> dict[str, Any]:
    registry = doc_registry.build_registry(CONTENT_ROOT)
    return response(200, registry.to_dict())


def get_process_quality() -> dict[str, Any]:
    report = process_quality.build_report(CONTENT_ROOT.parent, CONTENT_ROOT)
    return response(200, report)


def resolve_doc(ref: str | None) -> dict[str, Any]:
    if not ref:
        raise ValueError("Missing required query parameter: ref")
    registry = doc_registry.build_registry(CONTENT_ROOT)
    try:
        record = doc_registry.resolve_reference(registry, ref)
    except LookupError as exc:
        return response(404, {"error": str(exc)})
    return response(200, {"document": record.to_dict()})


def extract_frontmatter_list(markdown: str, key: str) -> list[str]:
    if not markdown.startswith("---\n"):
        return []
    end = markdown.find("\n---", 4)
    if end == -1:
        return []
    block = markdown[4:end].splitlines()
    items: list[str] = []
    prefix = f"{key}:"
    for i, line in enumerate(block):
        if not line.startswith(prefix):
            continue
        value = line[len(prefix):].strip()
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            if not inner:
                return []
            return [v.strip().strip('"').strip("'") for v in inner.split(",") if v.strip()]
        if value:
            return [value.strip('"').strip("'")]
        # Look ahead for `  - item` lines.
        for j in range(i + 1, len(block)):
            nxt = block[j]
            if nxt.startswith("  -") or nxt.startswith("  - "):
                items.append(nxt.lstrip()[1:].strip().strip('"').strip("'"))
            elif nxt and not nxt.startswith(" "):
                break
        return items
    return []


def get_doc(raw_path: str) -> dict[str, Any]:
    file_path = resolve_doc_path(raw_path)
    content = file_path.read_text(encoding="utf-8", errors="replace")
    body: dict[str, Any] = {
        "path": file_path.relative_to(CONTENT_ROOT.parent).as_posix(),
        "content": content,
        "updated": int(file_path.stat().st_mtime),
    }
    try:
        parsed = sop_parse.parse(content)
        body["parsed"] = parsed
    except sop_parse.ParseError as exc:
        body["parsed"] = None
        body["parse_error"] = str(exc)
    return response(200, body)


def save_doc(raw_path: str | None, body: dict[str, Any]) -> dict[str, Any]:
    if not raw_path:
        raise ValueError("Missing required query parameter: path")

    content = body.get("content")
    if not isinstance(content, str):
        raise ValueError("Request body must include string field: content")

    file_path = resolve_doc_path(raw_path)
    file_path.write_text(content, encoding="utf-8")

    warnings: list[str] = []
    try:
        warnings = sop_lint.lint_text(content)
    except Exception:
        warnings = []

    return response(
        200,
        {
            "path": file_path.relative_to(CONTENT_ROOT.parent).as_posix(),
            "updated": int(file_path.stat().st_mtime),
            "warnings": warnings,
        },
    )


def create_doc(body: dict[str, Any]) -> dict[str, Any]:
    raw_path = body.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("Request body must include string field: path")

    file_path = resolve_doc_path(raw_path, must_exist=False)
    if file_path.exists():
        raise ValueError("Document already exists")

    title = body.get("title")
    if not isinstance(title, str) or not title.strip():
        title = file_path.stem.replace("-", " ").title()

    doc_type = body.get("doc_type")
    if not isinstance(doc_type, str) or not doc_type.strip():
        doc_type = infer_doc_type(file_path.relative_to(CONTENT_ROOT.parent).as_posix())

    summary = body.get("summary")
    if not isinstance(summary, str):
        summary = ""

    scaffold = body.get("scaffold")
    if not isinstance(scaffold, str) or scaffold not in {"full", "minimal"}:
        scaffold = "full"

    content = new_doc_content(title=title.strip(), doc_type=doc_type.strip(), summary=summary.strip(), scaffold=scaffold)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(content, encoding="utf-8")

    return response(
        201,
        {
            "path": file_path.relative_to(CONTENT_ROOT.parent).as_posix(),
            "content": content,
            "updated": int(file_path.stat().st_mtime),
        },
    )


def delete_doc(raw_path: str | None) -> dict[str, Any]:
    if not raw_path:
        raise ValueError("Missing required query parameter: path")
    file_path = resolve_doc_path(raw_path)
    file_path.unlink()
    # Clean up empty parent dirs up to CONTENT_ROOT.
    parent = file_path.parent
    while parent != CONTENT_ROOT and parent.is_dir():
        try:
            next(parent.iterdir())
            break
        except StopIteration:
            parent.rmdir()
            parent = parent.parent
    return response(200, {"deleted": file_path.relative_to(CONTENT_ROOT.parent).as_posix()})


def rename_doc(body: dict[str, Any]) -> dict[str, Any]:
    old_raw = body.get("old_path")
    new_raw = body.get("new_path")
    if not isinstance(old_raw, str) or not old_raw.strip():
        raise ValueError("Request body must include string field: old_path")
    if not isinstance(new_raw, str) or not new_raw.strip():
        raise ValueError("Request body must include string field: new_path")
    old_path = resolve_doc_path(old_raw)
    new_path = resolve_doc_path(new_raw, must_exist=False)
    if new_path.exists():
        raise ValueError("Target path already exists")
    new_path.parent.mkdir(parents=True, exist_ok=True)
    old_path.rename(new_path)
    return response(
        200,
        {
            "old_path": old_path.relative_to(CONTENT_ROOT.parent).as_posix(),
            "new_path": new_path.relative_to(CONTENT_ROOT.parent).as_posix(),
        },
    )


def parse_content(body: dict[str, Any]) -> dict[str, Any]:
    text = body.get("content")
    if not isinstance(text, str):
        raise ValueError("Request body must include string field: content")
    try:
        return response(200, {"parsed": sop_parse.parse(text)})
    except sop_parse.ParseError as exc:
        return response(200, {"parsed": None, "error": str(exc)})


_BACKLINK_LINK_RE = re.compile(r"\]\(([^)]+\.md)(?:#[^)]*)?\)")


def list_backlinks(raw_path: str | None) -> dict[str, Any]:
    if not raw_path:
        raise ValueError("Missing required query parameter: path")
    target = resolve_doc_path(raw_path)
    target_basename = target.name
    target_repo_path = target.relative_to(CONTENT_ROOT.parent).as_posix()
    results: list[dict[str, Any]] = []
    for file_path in sorted(CONTENT_ROOT.rglob("*.md")):
        if file_path == target:
            continue
        text = file_path.read_text(encoding="utf-8", errors="replace")
        # Quick prefilter — if the basename of the target doesn't appear,
        # there's no chance of a link.
        if target_basename not in text:
            continue
        if not _references(file_path, text, target):
            continue
        results.append({
            "path": file_path.relative_to(CONTENT_ROOT.parent).as_posix(),
            "title": extract_frontmatter_value(text, "title") or file_path.stem.replace("-", " ").title(),
        })
    return response(200, {"path": target_repo_path, "backlinks": results})


def _references(source: Path, text: str, target: Path) -> bool:
    for match in _BACKLINK_LINK_RE.finditer(text):
        link = match.group(1)
        if link.startswith(("http://", "https://", "#", "mailto:")):
            continue
        try:
            resolved = (source.parent / link).resolve()
        except Exception:
            continue
        if resolved == target:
            return True
    return False


def run_corpus_lint() -> dict[str, Any]:
    results = []
    for file_path in sorted(CONTENT_ROOT.rglob("*.md")):
        text = file_path.read_text(encoding="utf-8", errors="replace")
        # Only report on schema_version=1 docs (the spec) to avoid noise from
        # legacy templates/references that don't conform.
        if "schema_version: 1" not in text:
            continue
        try:
            violations = sop_lint.lint_text(text)
        except Exception as exc:
            violations = [f"lint failed: {exc}"]
        if violations:
            results.append({
                "path": file_path.relative_to(CONTENT_ROOT.parent).as_posix(),
                "violations": violations,
            })
    return response(200, {"docs": results, "total_violations": sum(len(d["violations"]) for d in results)})


def delete_folder(raw_path: str | None) -> dict[str, Any]:
    folder = _resolve_folder_path(raw_path)
    file_count = sum(1 for _ in folder.rglob("*") if _.is_file())
    shutil.rmtree(folder)
    return response(200, {"deleted": folder.relative_to(CONTENT_ROOT.parent).as_posix(), "files": file_count})


def rename_folder(body: dict[str, Any]) -> dict[str, Any]:
    old = body.get("old_path")
    new = body.get("new_path")
    if not isinstance(old, str) or not old.strip():
        raise ValueError("Request body must include string field: old_path")
    if not isinstance(new, str) or not new.strip():
        raise ValueError("Request body must include string field: new_path")
    src = _resolve_folder_path(old)
    dst = _resolve_folder_path(new, must_exist=False)
    if dst.exists():
        raise ValueError("Target folder already exists")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return response(
        200,
        {
            "old_path": src.relative_to(CONTENT_ROOT.parent).as_posix(),
            "new_path": dst.relative_to(CONTENT_ROOT.parent).as_posix(),
        },
    )


def _resolve_folder_path(raw_path: str | None, must_exist: bool = True) -> Path:
    if not raw_path:
        raise ValueError("Missing required parameter: path")
    norm = unquote(raw_path).strip().replace("\\", "/").lstrip("/")
    if not norm.startswith(CONTENT_PREFIX):
        norm = f"{CONTENT_PREFIX}{norm}"
    relative = norm.removeprefix(CONTENT_PREFIX)
    if not relative or relative.endswith("/"):
        relative = relative.rstrip("/")
    if not relative:
        raise ValueError("Cannot operate on the content/ root itself")
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9/_-]*$", relative):
        raise ValueError("Folder path may only contain letters, numbers, slash, dash, underscore")
    folder = (CONTENT_ROOT / relative).resolve()
    if CONTENT_ROOT not in folder.parents and folder != CONTENT_ROOT:
        raise ValueError("Folder escapes content root")
    if must_exist and (not folder.exists() or not folder.is_dir()):
        raise FileNotFoundError(norm)
    return folder


def upload_image(body: dict[str, Any]) -> dict[str, Any]:
    doc_path_raw = body.get("doc_path")
    if not isinstance(doc_path_raw, str) or not doc_path_raw.strip():
        raise ValueError("Request body must include string field: doc_path")
    doc_file = resolve_doc_path(doc_path_raw)

    filename = body.get("filename")
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError("Request body must include string field: filename")
    safe_name = sanitize_image_filename(filename)
    if not safe_name:
        raise ValueError("filename is empty after sanitization")
    if Path(safe_name).suffix.lower() not in IMAGE_EXTENSIONS:
        raise ValueError(f"Unsupported image extension. Allowed: {sorted(IMAGE_EXTENSIONS)}")

    raw_data = body.get("data")
    if not isinstance(raw_data, str):
        raise ValueError("Request body must include base64 string field: data")
    try:
        image_bytes = base64.b64decode(raw_data, validate=False)
    except Exception as exc:
        raise ValueError("data is not valid base64") from exc
    if len(image_bytes) == 0:
        raise ValueError("image is empty")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise ValueError(f"image exceeds {MAX_IMAGE_BYTES // (1024 * 1024)} MB limit")

    slug = doc_file.stem
    image_dir = CONTENT_ROOT / "images" / slug
    image_dir.mkdir(parents=True, exist_ok=True)
    target = image_dir / safe_name
    target = _unique_image_path(target)
    target.write_bytes(image_bytes)

    repo_relative = target.relative_to(CONTENT_ROOT.parent).as_posix()
    doc_relative = _relative_path(doc_file.parent, target)
    return response(
        201,
        {
            "path": doc_relative,
            "absolute_path": repo_relative,
            "bytes": len(image_bytes),
        },
    )


def sanitize_image_filename(filename: str) -> str:
    name = filename.strip().replace("\\", "/").split("/")[-1]
    name = name.replace(" ", "-").lower()
    name = re.sub(r"[^a-z0-9._-]+", "", name)
    return name


def _unique_image_path(target: Path) -> Path:
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    i = 1
    while True:
        candidate = target.with_name(f"{stem}-{i}{suffix}")
        if not candidate.exists():
            return candidate
        i += 1


def _relative_path(from_dir: Path, to_file: Path) -> str:
    from_parts = from_dir.resolve().parts
    to_parts = to_file.resolve().parts
    i = 0
    while i < len(from_parts) and i < len(to_parts) and from_parts[i] == to_parts[i]:
        i += 1
    up = [".."] * (len(from_parts) - i)
    down = list(to_parts[i:])
    return "/".join(up + down) if (up or down) else "."


def resolve_doc_path(raw_path: str, must_exist: bool = True) -> Path:
    path = normalize_doc_path(raw_path)
    if not DOC_PATH_RE.match(path.removeprefix(CONTENT_PREFIX)):
        raise ValueError("Document path may only contain letters, numbers, slash, dash, underscore, and .md")

    relative = path.removeprefix(CONTENT_PREFIX)
    file_path = (CONTENT_ROOT / relative).resolve()
    if CONTENT_ROOT not in file_path.parents and file_path != CONTENT_ROOT:
        raise ValueError("Document path escapes content root")
    if must_exist and not file_path.exists():
        raise FileNotFoundError(path)
    if file_path.suffix != ".md":
        raise ValueError("Document path must end with .md")

    return file_path


def normalize_doc_path(raw_path: str) -> str:
    path = unquote(raw_path).strip().replace("\\", "/").lstrip("/")
    if not path.startswith(CONTENT_PREFIX):
        path = f"{CONTENT_PREFIX}{path}"
    return path


def query_param(event: dict[str, Any], name: str) -> str | None:
    params = event.get("queryStringParameters") or {}
    value = params.get(name)
    return str(value) if value is not None else None


def json_body(event: dict[str, Any]) -> dict[str, Any]:
    raw_body = event.get("body") or "{}"
    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise ValueError("Request body must be valid JSON") from exc
    if not isinstance(body, dict):
        raise ValueError("Request body must be a JSON object")
    return body


def extract_frontmatter_value(markdown: str, key: str) -> str:
    if not markdown.startswith("---\n"):
        return ""
    end = markdown.find("\n---", 4)
    if end == -1:
        return ""

    prefix = f"{key}:"
    for line in markdown[4:end].splitlines():
        if line.startswith(prefix):
            return line.partition(":")[2].strip().strip('"')
    return ""


def infer_domain(path: str) -> str:
    parts = path.split("/")
    if len(parts) >= 2 and parts[0] == "content":
        return parts[1]
    return "unknown"


def infer_doc_type(path: str) -> str:
    parts = set(path.split("/"))
    if "sops" in parts:
        return "sop"
    if "templates" in parts:
        return "template"
    if "reference" in parts:
        return "reference"
    if "playbooks" in parts:
        return "playbook"
    if "prompts" in parts:
        return "prompt"
    return "doc"


def new_doc_content(title: str, doc_type: str, summary: str, scaffold: str = "full") -> str:
    if doc_type in ("sop", "checklist"):
        return _structured_sop_template(title, doc_type, summary, scaffold)
    return f"""---
title: "{title}"
summary: "{summary}"
doc_type: {doc_type}
tags: []
systems: []
related_docs: []
---

# {title}

## Summary

## Content

"""


def _structured_sop_template(title: str, doc_type: str, summary: str, scaffold: str = "full") -> str:
    if scaffold == "minimal":
        return _minimal_sop_template(title, doc_type, summary)
    return f"""---
title: "{title}"
summary: "{summary}"
doc_type: {doc_type}
schema_version: 1
tags: []
systems: []
related_docs: []
---

# {title}

<!-- sop-section-start: summary -->
## Summary

- Purpose:
- Outcome:
- Trigger:
- Frequency:
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites

- Access:
- Tools:
- Inputs:
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure

<!-- sop-step-start id=1 -->
1.  Describe the first step.
<!-- sop-step-end -->

<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation

- How to confirm the work is done correctly.
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting

- Common issue:
- Fix:
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

-
<!-- sop-section-end -->
"""


def _minimal_sop_template(title: str, doc_type: str, summary: str) -> str:
    return f"""---
title: "{title}"
summary: "{summary}"
doc_type: {doc_type}
schema_version: 1
tags: []
systems: []
related_docs: []
---

# {title}

<!-- sop-section-start: summary -->
## Summary
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure

<!-- sop-step-start id=1 -->
1.
<!-- sop-step-end -->

<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References
<!-- sop-section-end -->
"""
