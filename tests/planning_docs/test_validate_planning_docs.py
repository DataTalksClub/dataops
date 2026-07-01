from __future__ import annotations

import shutil
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import validate_planning_docs  # noqa: E402


def test_current_repo_planning_docs_contract_passes():
    assert validate_planning_docs.validate(REPO_ROOT) == []


def test_external_markdown_links_are_ignored(tmp_path):
    markdown = tmp_path / "doc.md"
    markdown.write_text("[Google](https://docs.google.com/document/d/example/edit#heading=h.x)\n", encoding="utf-8")

    assert validate_planning_docs.validate_markdown_links_for_files(tmp_path, [markdown]) == []


def test_internal_markdown_links_fail_when_target_is_missing(tmp_path):
    markdown = tmp_path / "doc.md"
    markdown.write_text("[Missing](missing.md)\n", encoding="utf-8")

    violations = validate_planning_docs.validate_markdown_links_for_files(tmp_path, [markdown])

    assert violations == ["doc.md: link target not found: missing.md"]


def test_process_controls_fail_when_required_gate_is_missing(tmp_path):
    process_dir = tmp_path / "_docs"
    process_dir.mkdir()
    (process_dir / "PROCESS.md").write_text("# Process\nNo lifecycle here.\n", encoding="utf-8")

    violations = validate_planning_docs.validate_process_controls(tmp_path)

    assert any("software engineer does not commit before review" in violation for violation in violations)
    assert any("no stylint requirement for internal process docs" in violation for violation in violations)


def test_goal_reference_set_fails_when_repo_path_is_missing(tmp_path):
    shutil.copy(REPO_ROOT / ".goal-v1.md", tmp_path / ".goal-v1.md")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "operations-manager-platform-jtbd.md").write_text("# JTBD\n", encoding="utf-8")

    violations = validate_planning_docs.validate_goal_reference_set(tmp_path)

    assert any("reference target not found" in violation for violation in violations)


def test_task_template_metadata_requires_unified_platform_fields(tmp_path):
    templates_dir = tmp_path / "content" / "tasks" / "templates"
    templates_dir.mkdir(parents=True)
    (templates_dir / "newsletter.md").write_text(
        """---
title: "Newsletter"
doc_type: template
schema_version: 1
source: "backend/scripts/seed-templates.ts"
systems:
  - dataops
tags:
  - task-template
---

# Newsletter
""",
        encoding="utf-8",
    )

    violations = validate_planning_docs.validate_task_templates(tmp_path)

    assert any("doc_type must be task-template" in violation for violation in violations)
    assert any("systems must include dataops and datatasks" in violation for violation in violations)
    assert any("tags must include task-template and newsletter" in violation for violation in violations)


def test_task_template_accepts_richer_operator_workflow_table(tmp_path):
    templates_dir = tmp_path / "content" / "tasks" / "templates"
    templates_dir.mkdir(parents=True)
    (templates_dir / "newsletter.md").write_text(
        """---
title: "Newsletter"
doc_type: task-template
schema_version: 1
source: "backend/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - task-template
  - newsletter
---

# Newsletter

<!-- sop-section-start: summary -->
## Summary
<!-- sop-section-start: purpose -->
## Purpose
<!-- sop-section-start: references -->
## References
<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links
<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof / closure | Waiting / follow-up |
| - | - | - | -: | - | - | - | - | - |
| 1 | `create-sponsorship-document` | sponsor-intake | -14 | owner | Create sponsorship document | doc.id | url: Sponsorship document |  |
""",
        encoding="utf-8",
    )

    violations = validate_planning_docs.validate_task_templates(tmp_path)

    assert violations == []
