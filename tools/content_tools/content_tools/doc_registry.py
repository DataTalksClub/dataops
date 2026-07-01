from __future__ import annotations

import re
import posixpath
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from content_tools.sop_parse import parse_frontmatter, split_frontmatter


DOCUMENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
WIKI_REF_RE = re.compile(r"^\[\[(?P<target>[^\]|]+)(?:\|[^\]]+)?\]\]$")
VALID_DOC_TYPES = {
    "sop",
    "checklist",
    "template",
    "reference",
    "playbook",
    "prompt",
    "task-template",
    "archive",
    "doc",
}


class DocumentRegistryError(ValueError):
    def __init__(self, violations: list[str]):
        self.violations = violations
        super().__init__("\n".join(violations))


@dataclass(frozen=True)
class DocumentRecord:
    id: str
    aliases: list[str]
    path: str
    title: str
    doc_type: str
    summary: str
    tags: list[str]
    systems: list[str]
    related_docs: list[str]
    updated_at: int
    domain: str
    id_source: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "stable_id": self.id_source == "frontmatter",
            "aliases": self.aliases,
            "path": self.path,
            "title": self.title,
            "doc_type": self.doc_type,
            "summary": self.summary,
            "tags": self.tags,
            "systems": self.systems,
            "related_docs": self.related_docs,
            "updated_at": self.updated_at,
            "domain": self.domain,
            "id_source": self.id_source,
        }


@dataclass(frozen=True)
class DocumentRegistry:
    documents: list[DocumentRecord]
    by_id: dict[str, DocumentRecord]
    by_alias: dict[str, DocumentRecord]
    by_path: dict[str, DocumentRecord]

    def to_dict(self) -> dict[str, Any]:
        return {"documents": [doc.to_dict() for doc in self.documents]}


def build_registry(content_root: Path, validate: bool = True) -> DocumentRegistry:
    root = content_root.resolve()
    repo_root = root.parent
    records: list[DocumentRecord] = []
    violations: list[str] = []

    for file_path in sorted(root.rglob("*.md")):
        text = file_path.read_text(encoding="utf-8", errors="replace")
        raw_frontmatter, body = split_frontmatter(text)
        metadata = parse_frontmatter(raw_frontmatter) if raw_frontmatter else {}
        repo_path = file_path.relative_to(repo_root).as_posix()
        record = _record_from_metadata(file_path, repo_path, body, metadata)
        records.append(record)

        if not DOCUMENT_ID_RE.match(record.id):
            violations.append(f"{repo_path}: invalid id {record.id!r}")
        for alias in record.aliases:
            if _looks_like_path(alias):
                try:
                    _normalize_path_alias(alias)
                except ValueError:
                    violations.append(f"{repo_path}: invalid path alias {alias!r}")
            elif not DOCUMENT_ID_RE.match(alias):
                violations.append(f"{repo_path}: invalid alias {alias!r}")
        if record.doc_type not in VALID_DOC_TYPES:
            violations.append(f"{repo_path}: unsupported doc_type {record.doc_type!r}")

    by_id: dict[str, DocumentRecord] = {}
    by_alias: dict[str, DocumentRecord] = {}
    by_path: dict[str, DocumentRecord] = {}

    for record in records:
        _add_unique(by_id, record.id, record, "id", violations)
        by_path[record.path] = record
        by_path[record.path.removeprefix("content/")] = record
        by_path["/" + record.path.removeprefix("content/")] = record
        for alias in record.aliases:
            normalized = _normalize_alias(alias)
            _add_unique(by_alias, normalized, record, "alias", violations)

    registry = DocumentRegistry(
        documents=records,
        by_id=by_id,
        by_alias=by_alias,
        by_path=by_path,
    )

    if validate:
        violations.extend(validate_alias_conflicts(by_alias, by_id))
        violations.extend(validate_alias_path_conflicts(by_alias, by_path))
        violations.extend(validate_related_docs(records, registry))
        if violations:
            raise DocumentRegistryError(violations)

    return registry


def resolve_reference(registry: DocumentRegistry, ref: str) -> DocumentRecord:
    normalized = normalize_reference(ref)
    matches: list[DocumentRecord] = []
    for index in (registry.by_id, registry.by_alias, registry.by_path):
        record = index.get(normalized)
        if record and record not in matches:
            matches.append(record)

    if not matches and _looks_like_path(normalized):
        path_ref = _normalize_path_alias(normalized)
        record = registry.by_path.get(path_ref) or registry.by_path.get(path_ref.removeprefix("content/"))
        if record:
            matches.append(record)

    if not matches:
        raise LookupError(f"Document reference not found: {ref}")
    if len(matches) > 1:
        ids = ", ".join(sorted(record.id for record in matches))
        raise LookupError(f"Document reference is ambiguous: {ref} ({ids})")
    return matches[0]


def normalize_reference(ref: str) -> str:
    value = ref.strip()
    wiki = WIKI_REF_RE.match(value)
    if wiki:
        value = wiki.group("target").strip()
    if value.startswith("doc:"):
        value = value.removeprefix("doc:").strip()
    return value.strip()


def validate_related_docs(records: list[DocumentRecord], registry: DocumentRegistry) -> list[str]:
    violations: list[str] = []
    for record in records:
        source_dir = str(Path(record.path).parent)
        for related in record.related_docs:
            ref = normalize_reference(related)
            candidates = _related_candidates(ref, source_dir)
            if any(_can_resolve(registry, candidate) for candidate in candidates):
                continue
            violations.append(f"{record.path}: related_docs reference not found: {related!r}")
    return violations


def validate_alias_conflicts(
    by_alias: dict[str, DocumentRecord],
    by_id: dict[str, DocumentRecord],
) -> list[str]:
    violations: list[str] = []
    for alias, record in by_alias.items():
        id_record = by_id.get(alias)
        if id_record and id_record.path != record.path:
            violations.append(f"alias {alias!r} from {record.path} conflicts with id from {id_record.path}")
    return violations


def validate_alias_path_conflicts(
    by_alias: dict[str, DocumentRecord],
    by_path: dict[str, DocumentRecord],
) -> list[str]:
    violations: list[str] = []
    for alias, record in by_alias.items():
        path_record = by_path.get(alias)
        if path_record and path_record.path != record.path:
            violations.append(f"alias {alias!r} from {record.path} conflicts with path from {path_record.path}")
    return violations


def _record_from_metadata(
    file_path: Path,
    repo_path: str,
    body: str,
    metadata: dict[str, Any],
) -> DocumentRecord:
    explicit_id = _string(metadata.get("id"))
    doc_type = _string(metadata.get("doc_type")) or _infer_doc_type(repo_path)
    doc_id = explicit_id or _generated_id(repo_path, doc_type)
    return DocumentRecord(
        id=doc_id,
        aliases=_strings(metadata.get("aliases")),
        path=repo_path,
        title=_string(metadata.get("title")) or _first_heading(body) or file_path.stem.replace("-", " ").title(),
        doc_type=doc_type,
        summary=_string(metadata.get("summary")),
        tags=_strings(metadata.get("tags")),
        systems=_strings(metadata.get("systems")),
        related_docs=_strings(metadata.get("related_docs")),
        updated_at=int(file_path.stat().st_mtime),
        domain=_infer_domain(repo_path),
        id_source="frontmatter" if explicit_id else "generated",
    )


def _generated_id(repo_path: str, doc_type: str) -> str:
    path = repo_path.removeprefix("content/").removesuffix(".md")
    parts = [part for part in path.split("/") if part not in {"sops", "templates", "reference", "playbooks"}]
    slug = ".".join(parts)
    return f"{doc_type}.{slug}".replace("_", "-")


def _add_unique(
    index: dict[str, DocumentRecord],
    key: str,
    record: DocumentRecord,
    label: str,
    violations: list[str],
) -> None:
    existing = index.get(key)
    if existing and existing.path != record.path:
        violations.append(f"duplicate {label} {key!r}: {existing.path} and {record.path}")
        return
    index[key] = record


def _normalize_alias(alias: str) -> str:
    if _looks_like_path(alias):
        return _normalize_path_alias(alias)
    return alias.strip()


def _normalize_path_alias(alias: str) -> str:
    path = alias.strip().replace("\\", "/").lstrip("/")
    if not path.endswith(".md"):
        raise ValueError(alias)
    if not path.startswith("content/"):
        path = f"content/{path}"
    return path


def _related_candidates(ref: str, source_dir: str) -> list[str]:
    candidates = [ref]
    if _looks_like_path(ref):
        path = ref.strip().replace("\\", "/").lstrip("/")
        if not path.startswith("content/"):
            candidates.append(f"content/{path}")
            candidates.append(posixpath.normpath(f"{source_dir}/{path}"))
    return candidates


def _can_resolve(registry: DocumentRegistry, ref: str) -> bool:
    try:
        resolve_reference(registry, ref)
        return True
    except LookupError:
        return False
    except ValueError:
        return False


def _looks_like_path(value: str) -> bool:
    return "/" in value or value.endswith(".md")


def _string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ""
    return str(value).strip()


def _strings(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip().strip('"').strip("'") for item in value if str(item).strip()]
    if isinstance(value, str):
        return [value.strip().strip('"').strip("'")] if value.strip() else []
    return [str(value).strip()]


def _first_heading(body: str) -> str:
    for line in body.splitlines():
        if line.startswith("# "):
            return line.removeprefix("# ").strip()
    return ""


def _infer_domain(path: str) -> str:
    parts = path.split("/")
    if len(parts) >= 2 and parts[0] == "content":
        return parts[1]
    return "unknown"


def _infer_doc_type(path: str) -> str:
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
    if "archive" in parts:
        return "archive"
    return "doc"
