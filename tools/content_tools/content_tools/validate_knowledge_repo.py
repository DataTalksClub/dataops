from __future__ import annotations

import argparse
import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from content_tools import sop_parse


REQUIRED_SCAFFOLD_DIRS = [
    "content",
    "workflow-templates",
    "assistant-prompts",
    "assistant-process",
    "examples",
    "images",
    "indexes",
    "schemas",
    "scripts",
    "tests",
]
EXPECTED_TEMPLATE_SLUGS = [
    "book-of-the-week",
    "course",
    "maven-ll",
    "newsletter",
    "office-hours",
    "oss",
    "podcast",
    "social-media",
    "tax-report",
    "webinar",
    "workshop",
]
WORKFLOW_SCHEMA_REQUIRED_FIELDS = {
    "id",
    "type",
    "name",
    "schema_version",
    "trigger",
    "bundle_links",
    "phases",
    "tasks",
    "default_assignee",
    "source_document_ids",
}
TASK_REQUIRED_FIELDS = {
    "id",
    "name",
    "phase_id",
    "stage",
    "schedule",
    "default_assignee",
    "required_proofs",
    "required_links",
    "instruction_doc_id",
}
TARGET_PATH_RE = re.compile(r"^workflow-templates/[a-z0-9][a-z0-9-]*\.yaml$")
STABLE_ID_RE = re.compile(r"^task-template\.tasks\.[a-z0-9][a-z0-9-]*$")
RUNTIME_TYPE_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the dataops-knowledge migration scaffold.")
    parser.add_argument("--repo-root", default=Path.cwd(), type=Path)
    parser.add_argument("--scaffold-root", default=Path("templates/dataops-knowledge"), type=Path)
    args = parser.parse_args()

    violations = validate(args.repo_root, args.scaffold_root)
    if violations:
        print("Knowledge repository scaffold validation failed:")
        for violation in violations:
            print(f"- {violation}")
        return 1

    print("Knowledge repository scaffold validation passed.")
    return 0


def validate(repo_root: Path, scaffold_root: Path | str = "templates/dataops-knowledge") -> list[str]:
    repo_root = repo_root.resolve()
    scaffold_path = _resolve_repo_path(repo_root, scaffold_root)
    violations: list[str] = []

    violations.extend(validate_scaffold_dirs(repo_root, scaffold_path))

    schema_path = scaffold_path / "schemas" / "workflow-template.schema.json"
    schema = _load_json(schema_path, repo_root, violations, "workflow-template schema")
    if isinstance(schema, dict):
        violations.extend(validate_workflow_schema_shape(schema, repo_root, schema_path))

    manifest_path = scaffold_path / "indexes" / "workflow-template-migration-manifest.json"
    manifest = _load_json(manifest_path, repo_root, violations, "workflow-template migration manifest")
    if isinstance(manifest, dict):
        violations.extend(validate_manifest(repo_root, manifest_path, manifest))

    return violations


def validate_scaffold_dirs(repo_root: Path, scaffold_root: Path) -> list[str]:
    violations: list[str] = []
    if not scaffold_root.exists():
        return [f"{_repo_path(repo_root, scaffold_root)}: scaffold directory is required"]
    for relative_dir in REQUIRED_SCAFFOLD_DIRS:
        path = scaffold_root / relative_dir
        if not path.is_dir():
            violations.append(f"{_repo_path(repo_root, path)}: required scaffold directory is missing")
    return violations


def validate_workflow_schema_shape(schema: Mapping[str, Any], repo_root: Path, schema_path: Path) -> list[str]:
    source = _repo_path(repo_root, schema_path)
    violations: list[str] = []
    if schema.get("type") != "object":
        violations.append(f"{source}: schema root type must be object")
    if schema.get("additionalProperties") is not False:
        violations.append(f"{source}: schema root must set additionalProperties to false")

    required = set(_strings(schema.get("required")))
    missing_required = sorted(WORKFLOW_SCHEMA_REQUIRED_FIELDS - required)
    for field in missing_required:
        violations.append(f"{source}: schema required fields missing {field!r}")

    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return violations + [f"{source}: schema properties must be an object"]
    for field in sorted(WORKFLOW_SCHEMA_REQUIRED_FIELDS):
        if field not in properties:
            violations.append(f"{source}: schema properties missing {field!r}")

    defs = schema.get("$defs")
    if not isinstance(defs, dict):
        return violations + [f"{source}: schema $defs must be an object"]
    task_schema = defs.get("task")
    if not isinstance(task_schema, dict):
        return violations + [f"{source}: schema $defs.task is required"]
    task_required = set(_strings(task_schema.get("required")))
    for field in sorted(TASK_REQUIRED_FIELDS - task_required):
        violations.append(f"{source}: task schema required fields missing {field!r}")

    return violations


def validate_manifest(repo_root: Path, manifest_path: Path, manifest: Mapping[str, Any]) -> list[str]:
    source = _repo_path(repo_root, manifest_path)
    violations: list[str] = []
    if manifest.get("schema_version") != 1:
        violations.append(f"{source}: schema_version must be 1")
    if manifest.get("source_root") != "content/tasks/templates":
        violations.append(f"{source}: source_root must be 'content/tasks/templates'")
    if manifest.get("target_root") != "workflow-templates":
        violations.append(f"{source}: target_root must be 'workflow-templates'")

    entries = manifest.get("templates")
    if not isinstance(entries, list):
        return violations + [f"{source}: templates must be a list"]

    current_template_paths = sorted((repo_root / "content" / "tasks" / "templates").glob("*.md"))
    current_sources = {_repo_path(repo_root, path) for path in current_template_paths}
    expected_sources = {f"content/tasks/templates/{slug}.md" for slug in EXPECTED_TEMPLATE_SLUGS}
    if current_sources != expected_sources:
        missing_current = sorted(expected_sources - current_sources)
        extra_current = sorted(current_sources - expected_sources)
        for path in missing_current:
            violations.append(f"{path}: expected current Markdown template file is missing")
        for path in extra_current:
            violations.append(f"{path}: unexpected current Markdown template file is present")

    seen_ids: dict[str, int] = {}
    seen_sources: dict[str, int] = {}
    seen_targets: dict[str, int] = {}
    mapped_sources: set[str] = set()

    for index, entry in enumerate(entries):
        entry_label = f"{source}: templates[{index}]"
        if not isinstance(entry, dict):
            violations.append(f"{entry_label}: entry must be an object")
            continue

        stable_id = _required_string(entry, "stable_id", entry_label, violations)
        runtime_type = _required_string(entry, "runtime_type", entry_label, violations)
        source_path = _required_string(entry, "source_path", entry_label, violations)
        target_path = _required_string(entry, "target_path", entry_label, violations)
        if not all([stable_id, runtime_type, source_path, target_path]):
            continue

        if not STABLE_ID_RE.fullmatch(stable_id):
            violations.append(f"{entry_label}: stable_id must match task-template.tasks.<slug>, got {stable_id!r}")
        if not RUNTIME_TYPE_RE.fullmatch(runtime_type):
            violations.append(f"{entry_label}: runtime_type must be a slug, got {runtime_type!r}")
        if source_path not in expected_sources:
            violations.append(f"{entry_label}: source_path must be one of the current task templates, got {source_path!r}")
        if not TARGET_PATH_RE.fullmatch(target_path):
            violations.append(f"{entry_label}: target_path must match workflow-templates/*.yaml, got {target_path!r}")

        _record_duplicate(seen_ids, stable_id, index, entry_label, "stable_id", violations)
        _record_duplicate(seen_sources, source_path, index, entry_label, "source_path", violations)
        _record_duplicate(seen_targets, target_path, index, entry_label, "target_path", violations)
        mapped_sources.add(source_path)

        template_path = repo_root / source_path
        if not template_path.is_file():
            violations.append(f"{entry_label}: source Markdown template is missing: {source_path}")
            continue
        violations.extend(validate_current_template_frontmatter(repo_root, template_path, stable_id, entry_label))

    missing_mappings = sorted(expected_sources - mapped_sources)
    extra_mappings = sorted(mapped_sources - expected_sources)
    for source_path in missing_mappings:
        violations.append(f"{source}: missing migration mapping for {source_path}")
    for source_path in extra_mappings:
        violations.append(f"{source}: unexpected migration mapping for {source_path}")
    if len(entries) != len(EXPECTED_TEMPLATE_SLUGS):
        violations.append(f"{source}: expected {len(EXPECTED_TEMPLATE_SLUGS)} template mappings, found {len(entries)}")

    return violations


def validate_current_template_frontmatter(repo_root: Path, template_path: Path, expected_id: str, label: str) -> list[str]:
    violations: list[str] = []
    text = template_path.read_text(encoding="utf-8", errors="replace")
    raw, _body = sop_parse.split_frontmatter(text)
    metadata = sop_parse.parse_frontmatter(raw) if raw else {}
    actual_id = str(metadata.get("id", "")).strip()
    if not actual_id:
        violations.append(f"{label}: {_repo_path(repo_root, template_path)} frontmatter id is required")
    elif actual_id != expected_id:
        violations.append(
            f"{label}: {_repo_path(repo_root, template_path)} frontmatter id {actual_id!r} does not match stable_id {expected_id!r}"
        )
    if metadata.get("doc_type") != "task-template":
        violations.append(
            f"{label}: {_repo_path(repo_root, template_path)} frontmatter doc_type must be task-template, got {metadata.get('doc_type')!r}"
        )
    return violations


def validate_workflow_template_document(document: Mapping[str, Any], schema: Mapping[str, Any]) -> list[str]:
    """Validate a workflow-template document against the supported JSON Schema subset."""
    return _validate_schema_node(document, schema, schema, "$")


def _validate_schema_node(value: Any, schema: Mapping[str, Any], root_schema: Mapping[str, Any], path: str) -> list[str]:
    if "$ref" in schema:
        target = _resolve_schema_ref(root_schema, str(schema["$ref"]))
        if target is None:
            return [f"{path}: unresolved schema reference {schema['$ref']!r}"]
        return _validate_schema_node(value, target, root_schema, path)

    violations: list[str] = []
    expected_type = schema.get("type")
    if expected_type and not _matches_json_type(value, str(expected_type)):
        return [f"{path}: expected {expected_type}, got {_json_type_name(value)}"]

    if "const" in schema and value != schema["const"]:
        violations.append(f"{path}: expected const {schema['const']!r}, got {value!r}")
    if "enum" in schema and value not in schema["enum"]:
        violations.append(f"{path}: expected one of {schema['enum']!r}, got {value!r}")
    if isinstance(value, str):
        min_length = schema.get("minLength")
        if isinstance(min_length, int) and len(value) < min_length:
            violations.append(f"{path}: string is shorter than minLength {min_length}")
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and not re.fullmatch(pattern, value):
            violations.append(f"{path}: value {value!r} does not match pattern {pattern!r}")

    if isinstance(value, dict):
        required = _strings(schema.get("required"))
        for field in required:
            if field not in value:
                violations.append(f"{path}: required field {field!r} is missing")
        properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        if schema.get("additionalProperties") is False:
            for field in value:
                if field not in properties:
                    violations.append(f"{path}.{field}: additional property is not allowed")
        for field, field_schema in properties.items():
            if field in value and isinstance(field_schema, dict):
                violations.extend(_validate_schema_node(value[field], field_schema, root_schema, f"{path}.{field}"))
        any_of = schema.get("anyOf")
        if isinstance(any_of, list) and any_of:
            if not any(
                isinstance(candidate, dict) and not _validate_schema_node(value, candidate, root_schema, path)
                for candidate in any_of
            ):
                violations.append(f"{path}: value does not match any required schema option")

    if isinstance(value, list):
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(value) < min_items:
            violations.append(f"{path}: array has fewer than {min_items} items")
        if schema.get("uniqueItems") is True and len({_json_key(item) for item in value}) != len(value):
            violations.append(f"{path}: array items must be unique")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                violations.extend(_validate_schema_node(item, item_schema, root_schema, f"{path}[{index}]"))

    return violations


def _load_json(path: Path, repo_root: Path, violations: list[str], label: str) -> Any:
    if not path.is_file():
        violations.append(f"{_repo_path(repo_root, path)}: {label} file is required")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        violations.append(f"{_repo_path(repo_root, path)}: invalid JSON: {exc.msg} at line {exc.lineno}, column {exc.colno}")
        return None


def _record_duplicate(
    seen: dict[str, int],
    value: str,
    index: int,
    entry_label: str,
    field: str,
    violations: list[str],
) -> None:
    if value in seen:
        violations.append(f"{entry_label}: duplicate {field} {value!r}; first seen at templates[{seen[value]}]")
    else:
        seen[value] = index


def _required_string(entry: Mapping[str, Any], key: str, label: str, violations: list[str]) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        violations.append(f"{label}: {key} is required")
        return ""
    return value.strip()


def _resolve_schema_ref(root_schema: Mapping[str, Any], ref: str) -> Mapping[str, Any] | None:
    if not ref.startswith("#/"):
        return None
    node: Any = root_schema
    for part in ref[2:].split("/"):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node if isinstance(node, dict) else None


def _matches_json_type(value: Any, expected_type: str) -> bool:
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "boolean":
        return isinstance(value, bool)
    return True


def _json_type_name(value: Any) -> str:
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if isinstance(value, str):
        return "string"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if value is None:
        return "null"
    return type(value).__name__


def _json_key(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [item for item in value if isinstance(item, str)]
    return []


def _resolve_repo_path(repo_root: Path, path: Path | str) -> Path:
    path = Path(path)
    if path.is_absolute():
        return path.resolve()
    return (repo_root / path).resolve()


def _repo_path(repo_root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(repo_root).as_posix()
    except ValueError:
        return path.as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
