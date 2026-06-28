from __future__ import annotations

import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LAMBDA_SRC = REPO_ROOT / "lambda-functions" / "src"
if str(LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(LAMBDA_SRC))

from lambda_functions import api_handler, process_quality  # noqa: E402


def _write(repo_root: Path, relative_path: str, text: str = "") -> Path:
    path = repo_root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _seed_repo(repo_root: Path) -> None:
    _write(
        repo_root,
        "content/tasks/templates/podcast.md",
        """---
id: task-template.tasks.podcast
title: "Podcast Task Template"
doc_type: task-template
related_docs:
  - sop.ops.generated
  - missing.related
---

# Podcast Task Template

## References

- [External process](https://docs.google.com/document/d/example/edit)
- ![Missing image](../../images/podcast/missing.png)

## Task Definitions

| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof / closure | Waiting / follow-up |
| - | - | - | -: | - | - | - | - | - |
| 1 | `prepare-guest` | intake | -1 |  | Prepare guest | missing.instruction |  |  |
""",
    )
    _write(
        repo_root,
        "content/ops/sops/generated.md",
        """---
title: "Generated ID SOP"
doc_type: sop
related_docs: []
---

# Generated ID SOP

TODO: fill this before operators use it.
""",
    )
    _write(
        repo_root,
        "work-engine/scripts/seed-templates.ts",
        """
const PODCAST_SOURCE_DOC_IDS = [
  'task-template.tasks.podcast',
  'missing.source',
];

const DEFAULT_TEMPLATES = [
  {
    type: 'podcast',
    sourceDocIds: [
      ...PODCAST_SOURCE_DOC_IDS,
    ],
  },
];
""",
    )


def test_process_quality_report_has_structured_workflow_findings(tmp_path: Path) -> None:
    _seed_repo(tmp_path)

    report = process_quality.build_report(tmp_path, "content")
    findings = report["findings"]
    categories = {finding["category"] for finding in findings}

    assert report["summary"]["total"] == len(findings)
    assert report["summary"]["blocking"] > 0
    assert "broken-doc-reference" in categories
    assert "broken-asset-reference" in categories
    assert "missing-metadata" in categories
    assert "missing-proof-instructions" in categories
    assert "missing-validation" in categories
    assert "template-doc-gap" in categories
    assert "todo-or-placeholder" in categories
    assert "unstable-doc-id" in categories
    assert any(finding["nextAction"] for finding in findings)
    assert any(finding.get("templateId") == "task-template.tasks.podcast" for finding in findings)
    assert any(finding.get("taskRef") == "prepare-guest" for finding in findings)


def test_process_quality_endpoint_uses_content_root(monkeypatch, tmp_path: Path) -> None:
    _seed_repo(tmp_path)
    monkeypatch.setattr(api_handler, "CONTENT_ROOT", tmp_path / "content")

    response = api_handler.handler(
        {
            "rawPath": "/docs/process-quality",
            "path": "/docs/process-quality",
            "requestContext": {"http": {"method": "GET"}},
        },
        None,
    )

    assert response["statusCode"] == 200
    payload = json.loads(response["body"])
    assert payload["summary"]["total"] > 0
    assert payload["sources"]["registry"] == "lambda_functions.doc_registry"
