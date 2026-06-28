from __future__ import annotations

import copy
import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LAMBDA_SRC = REPO_ROOT / "lambda-functions" / "src"
if str(LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(LAMBDA_SRC))

from lambda_functions import validate_knowledge_repo  # noqa: E402


def _write(repo_root: Path, relative_path: str, text: str = "") -> Path:
    path = repo_root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _schema() -> dict:
    return json.loads(
        (REPO_ROOT / "templates/dataops-knowledge/schemas/workflow-template.schema.json").read_text(encoding="utf-8")
    )


def _seed_valid_repo(repo_root: Path) -> None:
    scaffold_root = repo_root / "templates" / "dataops-knowledge"
    for directory in validate_knowledge_repo.REQUIRED_SCAFFOLD_DIRS:
        (scaffold_root / directory).mkdir(parents=True, exist_ok=True)
    _write(scaffold_root, "schemas/workflow-template.schema.json", json.dumps(_schema(), indent=2))

    manifest_entries = []
    for slug in validate_knowledge_repo.EXPECTED_TEMPLATE_SLUGS:
        stable_id = f"task-template.tasks.{slug}"
        source_path = f"content/tasks/templates/{slug}.md"
        _write(
            repo_root,
            source_path,
            f"""---
id: {stable_id}
title: "{slug} Task Template"
doc_type: task-template
---

# {slug}
""",
        )
        manifest_entries.append(
            {
                "stable_id": stable_id,
                "runtime_type": slug,
                "source_path": source_path,
                "target_path": f"workflow-templates/{slug}.yaml",
            }
        )

    _write(
        scaffold_root,
        "indexes/workflow-template-migration-manifest.json",
        json.dumps(
            {
                "schema_version": 1,
                "source_root": "content/tasks/templates",
                "target_root": "workflow-templates",
                "templates": manifest_entries,
            },
            indent=2,
        ),
    )


def _manifest(repo_root: Path) -> dict:
    return json.loads(
        (repo_root / "templates/dataops-knowledge/indexes/workflow-template-migration-manifest.json").read_text(
            encoding="utf-8"
        )
    )


def _write_manifest(repo_root: Path, manifest: dict) -> None:
    _write(
        repo_root,
        "templates/dataops-knowledge/indexes/workflow-template-migration-manifest.json",
        json.dumps(manifest, indent=2),
    )


def test_validate_knowledge_repo_accepts_passing_fixture(tmp_path):
    _seed_valid_repo(tmp_path)

    assert validate_knowledge_repo.validate(tmp_path) == []


def test_validate_knowledge_repo_reports_missing_template_mapping(tmp_path):
    _seed_valid_repo(tmp_path)
    manifest = _manifest(tmp_path)
    manifest["templates"] = [entry for entry in manifest["templates"] if entry["source_path"] != "content/tasks/templates/podcast.md"]
    _write_manifest(tmp_path, manifest)

    violations = validate_knowledge_repo.validate(tmp_path)

    assert any("missing migration mapping for content/tasks/templates/podcast.md" in violation for violation in violations)
    assert any("expected 11 template mappings, found 10" in violation for violation in violations)


def test_validate_knowledge_repo_reports_duplicate_target_ids_and_paths(tmp_path):
    _seed_valid_repo(tmp_path)
    manifest = _manifest(tmp_path)
    manifest["templates"][1]["stable_id"] = manifest["templates"][0]["stable_id"]
    manifest["templates"][1]["target_path"] = manifest["templates"][0]["target_path"]
    _write_manifest(tmp_path, manifest)

    violations = validate_knowledge_repo.validate(tmp_path)

    assert any("duplicate stable_id 'task-template.tasks.book-of-the-week'" in violation for violation in violations)
    assert any("duplicate target_path 'workflow-templates/book-of-the-week.yaml'" in violation for violation in violations)


def test_validate_knowledge_repo_reports_invalid_target_path_and_missing_source(tmp_path):
    _seed_valid_repo(tmp_path)
    manifest = _manifest(tmp_path)
    manifest["templates"][0]["target_path"] = "../workflow-templates/book-of-the-week.yml"
    (tmp_path / "content/tasks/templates/book-of-the-week.md").unlink()
    _write_manifest(tmp_path, manifest)

    violations = validate_knowledge_repo.validate(tmp_path)

    assert any("target_path must match workflow-templates/*.yaml" in violation for violation in violations)
    assert any("source Markdown template is missing: content/tasks/templates/book-of-the-week.md" in violation for violation in violations)
    assert any("expected current Markdown template file is missing" in violation for violation in violations)


def test_validate_knowledge_repo_reports_invalid_schema_shape(tmp_path):
    _seed_valid_repo(tmp_path)
    schema = _schema()
    schema["required"].remove("tasks")
    schema["properties"].pop("source_document_ids")
    schema["$defs"]["task"]["required"].remove("instruction_doc_id")
    _write(tmp_path, "templates/dataops-knowledge/schemas/workflow-template.schema.json", json.dumps(schema))

    violations = validate_knowledge_repo.validate(tmp_path)

    assert any("schema required fields missing 'tasks'" in violation for violation in violations)
    assert any("schema properties missing 'source_document_ids'" in violation for violation in violations)
    assert any("task schema required fields missing 'instruction_doc_id'" in violation for violation in violations)


def test_workflow_template_schema_accepts_minimal_valid_fixture():
    document = {
        "id": "task-template.tasks.synthetic",
        "type": "synthetic",
        "name": "Synthetic Fixture",
        "schema_version": 1,
        "trigger": {
            "mode": "manual",
            "anchor": {"field": "event_date", "kind": "date"},
        },
        "bundle_links": [{"id": "event-page", "name": "Event page", "required": True}],
        "phases": [{"id": "prepare", "name": "Prepare", "stage": "preparation"}],
        "tasks": [
            {
                "id": "create-page",
                "name": "Create event page",
                "phase_id": "prepare",
                "stage": "preparation",
                "schedule": {"offset_days": -14},
                "default_assignee": {"kind": "role", "id": "operations"},
                "required_proofs": [{"id": "page-created", "type": "link", "description": "Event page URL"}],
                "required_links": ["event-page"],
                "instruction_doc_id": "sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma",
            }
        ],
        "default_assignee": {"kind": "role", "id": "operations"},
        "source_document_ids": ["task-template.tasks.synthetic"],
        "migration_source": {
            "source_path": "content/tasks/templates/podcast.md",
            "source_doc_id": "task-template.tasks.synthetic",
        },
    }

    assert validate_knowledge_repo.validate_workflow_template_document(document, _schema()) == []


def test_workflow_template_schema_rejects_missing_required_fields_and_bad_schedule():
    document = {
        "id": "task-template.tasks.synthetic",
        "type": "synthetic",
        "name": "Synthetic Fixture",
        "schema_version": 1,
        "trigger": {
            "mode": "manual",
            "anchor": {"field": "event_date", "kind": "date"},
        },
        "bundle_links": [],
        "phases": [{"id": "prepare", "name": "Prepare", "stage": "preparation"}],
        "tasks": [
            {
                "id": "create-page",
                "name": "Create event page",
                "phase_id": "prepare",
                "stage": "preparation",
                "schedule": {},
                "default_assignee": {"kind": "person", "id": "Alexey"},
                "required_proofs": [],
                "required_links": [],
            }
        ],
        "default_assignee": {"kind": "role", "id": "operations"},
    }

    violations = validate_knowledge_repo.validate_workflow_template_document(document, _schema())

    assert "$: required field 'source_document_ids' is missing" in violations
    assert "$.tasks[0]: required field 'instruction_doc_id' is missing" in violations
    assert "$.tasks[0].schedule: value does not match any required schema option" in violations
    assert "$.tasks[0].default_assignee.kind: expected one of ['role', 'user'], got 'person'" in violations


def test_workflow_template_schema_rejects_additional_properties():
    document = {
        "id": "task-template.tasks.synthetic",
        "type": "synthetic",
        "name": "Synthetic Fixture",
        "schema_version": 1,
        "trigger": {
            "mode": "manual",
            "anchor": {"field": "event_date", "kind": "date"},
        },
        "bundle_links": [],
        "phases": [{"id": "prepare", "name": "Prepare", "stage": "preparation"}],
        "tasks": [
            {
                "id": "create-page",
                "name": "Create event page",
                "phase_id": "prepare",
                "stage": "preparation",
                "schedule": {"rule": "on-anchor"},
                "default_assignee": {"kind": "role", "id": "operations"},
                "required_proofs": [],
                "required_links": [],
                "instruction_doc_id": "sop.events.example",
                "unexpected": True,
            }
        ],
        "default_assignee": {"kind": "role", "id": "operations"},
        "source_document_ids": ["task-template.tasks.synthetic"],
    }

    violations = validate_knowledge_repo.validate_workflow_template_document(copy.deepcopy(document), _schema())

    assert "$.tasks[0].unexpected: additional property is not allowed" in violations

