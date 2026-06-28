from __future__ import annotations

from pathlib import Path


from lambda_functions import validate_docs_links


def _write(repo_root: Path, relative_path: str, text: str = "") -> Path:
    path = repo_root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _seed_work_engine(repo_root: Path, source_doc_ids: list[str], instruction_doc_ids: list[str] | None = None) -> None:
    instruction_doc_ids = instruction_doc_ids or []
    instruction_lines = "\n".join(
        f"  '{doc_id.replace('.', '-')}': {{ instructionDocId: '{doc_id}' }}," for doc_id in instruction_doc_ids
    )
    source_lines = "\n".join(f"  '{doc_id}'," for doc_id in source_doc_ids)
    _write(
        repo_root,
        "work-engine/scripts/seed-templates.ts",
        f"""
const PODCAST_SOURCE_DOC_IDS = [
{source_lines}
];

const PODCAST_EXTERNAL_SOURCE_DOC_IDS = [
  {{
    id: 'assistant.podcast.process.podcast',
    path: 'assistants/podcast/process/podcast.md',
    reason: 'assistant-local process guide, not indexed by the content registry yet',
  }},
];

const PODCAST_DOC_CONTEXT = {{
{instruction_lines}
}};

const DEFAULT_TEMPLATES = [
  {{
    type: 'podcast',
    sourceDocIds: [
      ...PODCAST_SOURCE_DOC_IDS,
      ...PODCAST_EXTERNAL_SOURCE_DOC_IDS.map((doc) => doc.id),
    ],
  }},
];
""",
    )
    _write(repo_root, "assistants/podcast/process/podcast.md", "# Assistant process\n")


def test_validate_docs_links_accepts_registry_refs_local_links_images_and_seed_ids(tmp_path):
    repo_root = tmp_path
    _write(
        repo_root,
        "content/ops/sops/create-packet.md",
        """---
id: sop.ops.create-packet
title: "Create Packet"
doc_type: sop
related_docs:
  - sop.ops.packet-reference
  - ../reference/packet-reference.md
---

# Create Packet

Use [[sop.ops.packet-reference|Packet reference]] and [open](doc:sop.ops.packet-reference).
See [local reference](../reference/packet-reference.md#deferred-anchor).
Ignore [external](https://example.com), [email](mailto:ops@example.com), and [anchor](#summary).

![Screenshot](../../images/ops/create-packet.png)
""",
    )
    _write(
        repo_root,
        "content/ops/reference/packet-reference.md",
        """---
id: sop.ops.packet-reference
title: "Packet Reference"
doc_type: reference
---

# Packet Reference
""",
    )
    _write(repo_root, "content/images/ops/create-packet.png", "")
    _write(
        repo_root,
        "content/tasks/templates/podcast.md",
        """---
id: task-template.tasks.podcast
title: "Podcast Task Template"
doc_type: task-template
---

# Podcast Task Template
""",
    )
    _write(
        repo_root,
        "docs/local.md",
        """---
related_docs:
  - content/ops/sops/create-packet.md
---

# Local

[Packet](../content/ops/sops/create-packet.md)
""",
    )
    _seed_work_engine(
        repo_root,
        ["task-template.tasks.podcast", "sop.ops.create-packet"],
        ["sop.ops.packet-reference"],
    )

    assert validate_docs_links.validate(repo_root, "content") == []


def test_validate_docs_links_resolves_doc_refs_before_deferring_anchors(tmp_path):
    repo_root = tmp_path
    _write(
        repo_root,
        "content/ops/sops/source.md",
        """---
id: sop.test.anchor-source
title: "Anchor Source"
doc_type: sop
---

# Anchor Source

[Target](doc:sop.test.anchor-target#section-that-is-not-validated-yet)
""",
    )
    _write(
        repo_root,
        "content/ops/sops/target.md",
        """---
id: sop.test.anchor-target
title: "Anchor Target"
doc_type: sop
---

# Anchor Target
""",
    )
    _seed_work_engine(repo_root, [])

    assert validate_docs_links.validate(repo_root, "content") == []


def test_validate_docs_links_reports_broken_refs_with_source_paths(tmp_path):
    repo_root = tmp_path
    _write(
        repo_root,
        "content/ops/sops/create-packet.md",
        """---
id: sop.ops.create-packet
title: "Create Packet"
doc_type: sop
related_docs:
  - missing.related
---

# Create Packet

Use [[missing.wiki]] and [open](doc:missing.doc).
See [missing](../reference/missing.md).

![Screenshot](../../images/ops/missing.png)
""",
    )
    _write(
        repo_root,
        "content/tasks/templates/podcast.md",
        """---
id: task-template.tasks.podcast
title: "Podcast Task Template"
doc_type: task-template
---
""",
    )
    _seed_work_engine(
        repo_root,
        ["task-template.tasks.podcast", "missing.source"],
        ["missing.instruction"],
    )

    violations = validate_docs_links.validate(repo_root, "content")

    assert any(
        "content/ops/sops/create-packet.md: related_docs reference not found: 'missing.related'" in violation
        for violation in violations
    )
    assert any("content/ops/sops/create-packet.md: wiki reference not found: 'missing.wiki'" in violation for violation in violations)
    assert any("content/ops/sops/create-packet.md: doc reference not found: 'doc:missing.doc'" in violation for violation in violations)
    assert any(
        "content/ops/sops/create-packet.md: link target not found: '../reference/missing.md'" in violation
        for violation in violations
    )
    assert any(
        "content/ops/sops/create-packet.md: image target not found: '../../images/ops/missing.png'" in violation
        for violation in violations
    )
    assert any("work-engine/scripts/seed-templates.ts: sourceDocIds reference not found: 'missing.source'" in violation for violation in violations)
    assert any(
        "work-engine/scripts/seed-templates.ts: instructionDocId reference not found: 'missing.instruction'" in violation
        for violation in violations
    )


def test_validate_docs_links_reports_registry_identity_errors(tmp_path):
    repo_root = tmp_path
    _write(
        repo_root,
        "content/ops/reference/one.md",
        """---
id: duplicate.doc
aliases: [shared-alias]
title: "One"
doc_type: reference
---
""",
    )
    _write(
        repo_root,
        "content/ops/reference/two.md",
        """---
id: duplicate.doc
aliases: [shared-alias]
title: "Two"
doc_type: reference
---
""",
    )

    violations = validate_docs_links.validate(repo_root, "content")

    assert any("content registry: duplicate id 'duplicate.doc'" in violation for violation in violations)
    assert any("content registry: duplicate alias 'shared-alias'" in violation for violation in violations)
