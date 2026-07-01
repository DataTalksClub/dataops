from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

from content_tools import doc_registry, sop_parse


PROCESS_MARKDOWN_GLOBS = [
    "_docs/**/*.md",
    "docs/**/*.md",
    "templates/**/*.md",
]
PROCESS_MARKDOWN_FILES = [
    ".goal-v1.md",
    "PROJECT_PLAN.md",
    "PORTAL_ANALYSIS.md",
    "README.md",
]
MARKDOWN_LINK_RE = re.compile(r"(?P<image>!)?\[[^\]]*]\((?P<target>[^)]+)\)")
WIKI_REF_RE = re.compile(r"\[\[(?P<target>[^\]|]+)(?:\|[^\]]+)?\]\]")
CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`]+`")
SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)
SOURCE_DOC_IDS_RE = re.compile(r"sourceDocIds\s*:\s*\[(?P<body>.*?)\]", re.DOTALL)
INSTRUCTION_DOC_ID_RE = re.compile(r"instructionDocId\s*:\s*['\"](?P<id>[^'\"]+)['\"]")
STRING_LITERAL_RE = re.compile(r"['\"](?P<value>[^'\"]+)['\"]")
EXTERNAL_DOC_OBJECT_RE = re.compile(
    r"\{\s*"
    r"id:\s*['\"](?P<id>[^'\"]+)['\"]\s*,\s*"
    r"path:\s*['\"](?P<path>[^'\"]+)['\"]\s*,\s*"
    r"reason:\s*['\"](?P<reason>[^'\"]+)['\"]\s*,?\s*"
    r"\}",
    re.DOTALL,
)


@dataclass(frozen=True)
class MarkdownReference:
    source_path: Path
    target: str
    is_image: bool


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate internal DataOps document references.")
    parser.add_argument("--repo-root", default=Path.cwd(), type=Path)
    parser.add_argument("--content-root", default=Path("content"), type=Path)
    args = parser.parse_args()

    violations = validate(args.repo_root, args.content_root)
    if violations:
        print("Docs link validation failed:")
        for violation in violations:
            print(f"- {violation}")
        return 1

    print("Docs link validation passed.")
    print("Anchor validation: deferred; local targets are validated without checking heading anchors.")
    return 0


def validate(repo_root: Path, content_root: Path | str = "content") -> list[str]:
    repo_root = repo_root.resolve()
    content_root_path = Path(content_root)
    if not content_root_path.is_absolute():
        content_root_path = repo_root / content_root_path
    content_root_path = content_root_path.resolve()

    violations: list[str] = []
    registry: doc_registry.DocumentRegistry | None = None
    try:
        registry = doc_registry.build_registry(content_root_path)
    except doc_registry.DocumentRegistryError as exc:
        violations.extend(f"content registry: {violation}" for violation in exc.violations)
        registry = doc_registry.build_registry(content_root_path, validate=False)

    markdown_files = docs_markdown_files(repo_root, content_root_path)
    if registry is not None:
        violations.extend(validate_related_docs(repo_root, markdown_files, registry))
        violations.extend(validate_wiki_refs(repo_root, markdown_files, registry))
        violations.extend(validate_markdown_refs(repo_root, markdown_files, registry))
        violations.extend(validate_task_template_docs(repo_root, registry))
        violations.extend(validate_backend_seed_doc_ids(repo_root, registry))
    else:
        violations.extend(validate_markdown_refs(repo_root, markdown_files, None))

    return violations


def docs_markdown_files(repo_root: Path, content_root: Path) -> list[Path]:
    files: set[Path] = set(path for path in content_root.rglob("*.md") if path.is_file())
    for pattern in PROCESS_MARKDOWN_GLOBS:
        files.update(path for path in repo_root.glob(pattern) if path.is_file())
    for repo_path in PROCESS_MARKDOWN_FILES:
        path = repo_root / repo_path
        if path.exists():
            files.add(path)
    return sorted(path.resolve() for path in files)


def validate_related_docs(
    repo_root: Path,
    markdown_files: list[Path],
    registry: doc_registry.DocumentRegistry,
) -> list[str]:
    violations: list[str] = []
    for markdown_path in markdown_files:
        raw, _body = sop_parse.split_frontmatter(markdown_path.read_text(encoding="utf-8", errors="replace"))
        metadata = sop_parse.parse_frontmatter(raw) if raw else {}
        for related in _strings(metadata.get("related_docs")):
            if _is_external_or_anchor(related):
                continue
            if _registry_resolves(registry, related):
                continue
            if any(candidate.exists() for candidate in _reference_candidates(repo_root, markdown_path, related)):
                continue
            violations.append(f"{_repo_path(repo_root, markdown_path)}: related_docs reference not found: {related!r}")
    return violations


def validate_wiki_refs(
    repo_root: Path,
    markdown_files: list[Path],
    registry: doc_registry.DocumentRegistry,
) -> list[str]:
    violations: list[str] = []
    for markdown_path in markdown_files:
        text = _strip_code_blocks(markdown_path.read_text(encoding="utf-8", errors="replace"))
        for match in WIKI_REF_RE.finditer(text):
            target = match.group("target").strip()
            if not _registry_resolves(registry, target):
                violations.append(f"{_repo_path(repo_root, markdown_path)}: wiki reference not found: {target!r}")
    return violations


def validate_markdown_refs(
    repo_root: Path,
    markdown_files: list[Path],
    registry: doc_registry.DocumentRegistry | None,
) -> list[str]:
    violations: list[str] = []
    for ref in iter_markdown_refs(markdown_files):
        source = _repo_path(repo_root, ref.source_path)
        target = _strip_markdown_title(ref.target)
        if _is_external_or_anchor(target):
            continue
        if target.startswith("doc:"):
            doc_ref, _anchor = _split_link_target(target)
            if registry is not None and not _registry_resolves(registry, doc_ref):
                violations.append(f"{source}: doc reference not found: {target!r}")
            continue
        path_part, _anchor = _split_link_target(target)
        if not path_part:
            continue
        target_path = _resolve_local_link(repo_root, ref.source_path, path_part)
        if not target_path.exists():
            label = "image target" if ref.is_image else "link target"
            violations.append(f"{source}: {label} not found: {target!r}")
    return violations


def iter_markdown_refs(markdown_files: list[Path]) -> list[MarkdownReference]:
    refs: list[MarkdownReference] = []
    for markdown_path in markdown_files:
        text = _strip_code_blocks(markdown_path.read_text(encoding="utf-8", errors="replace"))
        for match in MARKDOWN_LINK_RE.finditer(text):
            refs.append(
                MarkdownReference(
                    source_path=markdown_path,
                    target=match.group("target"),
                    is_image=bool(match.group("image")),
                )
            )
    return refs


def validate_task_template_docs(repo_root: Path, registry: doc_registry.DocumentRegistry) -> list[str]:
    violations: list[str] = []
    templates_dir = repo_root / "content" / "tasks" / "templates"
    for template_path in sorted(templates_dir.glob("*.md")):
        repo_path = _repo_path(repo_root, template_path)
        record = registry.by_path.get(repo_path)
        if record is None:
            violations.append(f"{repo_path}: task template is missing from document registry")
        elif record.doc_type != "task-template":
            violations.append(f"{repo_path}: task template doc_type must be task-template, got {record.doc_type!r}")
    return violations


def validate_backend_seed_doc_ids(repo_root: Path, registry: doc_registry.DocumentRegistry) -> list[str]:
    seed_path = repo_root / "backend" / "scripts" / "seed-templates.ts"
    if not seed_path.exists():
        return ["backend/scripts/seed-templates.ts: seed template source is required"]

    text = seed_path.read_text(encoding="utf-8", errors="replace")
    external_docs = _external_seed_docs(text)
    violations: list[str] = []

    for doc_id, info in external_docs.items():
        if _registry_resolves(registry, doc_id):
            continue
        path = info["path"]
        reason = info["reason"]
        if path.startswith("content/"):
            violations.append(f"{_repo_path(repo_root, seed_path)}: external sourceDocId {doc_id!r} points into content/: {path}")
        if not (repo_root / path).exists():
            violations.append(f"{_repo_path(repo_root, seed_path)}: external sourceDocId {doc_id!r} path not found: {path}")
        if not reason.strip():
            violations.append(f"{_repo_path(repo_root, seed_path)}: external sourceDocId {doc_id!r} needs a reason")

    for doc_id in sorted(_source_doc_ids(text)):
        if doc_id in external_docs:
            continue
        if not _registry_resolves(registry, doc_id):
            violations.append(f"{_repo_path(repo_root, seed_path)}: sourceDocIds reference not found: {doc_id!r}")

    for doc_id in sorted(set(INSTRUCTION_DOC_ID_RE.findall(text))):
        if not _registry_resolves(registry, doc_id):
            violations.append(f"{_repo_path(repo_root, seed_path)}: instructionDocId reference not found: {doc_id!r}")

    return violations


def _source_doc_ids(seed_text: str) -> set[str]:
    doc_ids: set[str] = set()
    for match in SOURCE_DOC_IDS_RE.finditer(seed_text):
        body = match.group("body")
        doc_ids.update(item.group("value") for item in STRING_LITERAL_RE.finditer(body))
    for const_match in re.finditer(r"const\s+(?P<name>[A-Z0-9_]*SOURCE_DOC_IDS)\s*=\s*\[(?P<body>.*?)\];", seed_text, re.DOTALL):
        if "EXTERNAL_SOURCE_DOC_IDS" in const_match.group("name"):
            continue
        doc_ids.update(item.group("value") for item in STRING_LITERAL_RE.finditer(const_match.group("body")))
    return doc_ids


def _external_seed_docs(seed_text: str) -> dict[str, dict[str, str]]:
    return {
        match.group("id"): {"path": match.group("path"), "reason": match.group("reason")}
        for match in EXTERNAL_DOC_OBJECT_RE.finditer(seed_text)
    }


def _strip_code_blocks(markdown: str) -> str:
    return INLINE_CODE_RE.sub("", CODE_BLOCK_RE.sub("", markdown))


def _strip_markdown_title(target: str) -> str:
    target = target.strip()
    if target.startswith("<") and ">" in target:
        return target[1 : target.index(">")].strip()
    if " " in target:
        return target.split()[0].strip()
    return target


def _is_external_or_anchor(target: str) -> bool:
    return (
        not target
        or target.startswith("#")
        or target.startswith("//")
        or target == "..."
        or "..." in target
        or target.startswith("path/to/")
        or (SCHEME_RE.match(target) is not None and not target.startswith("doc:"))
    )


def _split_link_target(target: str) -> tuple[str, str]:
    target = unquote(target.strip())
    path_part = target
    anchor = ""
    if "#" in path_part:
        path_part, anchor = path_part.split("#", 1)
    if "?" in path_part:
        path_part = path_part.split("?", 1)[0]
    return path_part, anchor


def _resolve_local_link(repo_root: Path, markdown_path: Path, target: str) -> Path:
    target = target.replace("\\", "/")
    if target.startswith("/"):
        return (repo_root / target.lstrip("/")).resolve()
    return (markdown_path.parent / target).resolve()


def _reference_candidates(repo_root: Path, markdown_path: Path, target: str) -> list[Path]:
    target = doc_registry.normalize_reference(target)
    path_part, _anchor = _split_link_target(target)
    path_part = path_part.replace("\\", "/").strip()
    if not path_part:
        return []
    return [
        _resolve_local_link(repo_root, markdown_path, path_part),
        (repo_root / path_part.lstrip("/")).resolve(),
    ]


def _registry_resolves(registry: doc_registry.DocumentRegistry, reference: str) -> bool:
    try:
        doc_registry.resolve_reference(registry, reference)
        return True
    except (LookupError, ValueError):
        return False


def _strings(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip().strip('"').strip("'") for item in value if str(item).strip()]
    if isinstance(value, str):
        return [value.strip().strip('"').strip("'")] if value.strip() else []
    return [str(value).strip()]


def _repo_path(repo_root: Path, path: Path) -> str:
    return path.resolve().relative_to(repo_root).as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
