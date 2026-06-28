from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from lambda_functions import doc_registry, sop_parse, validate_docs_links


CATEGORIES = {
    "broken-doc-reference",
    "broken-asset-reference",
    "unstable-doc-id",
    "missing-metadata",
    "todo-or-placeholder",
    "missing-validation",
    "missing-proof-instructions",
    "legacy-external-only-doc",
    "template-doc-gap",
}
REQUIRED_METADATA = ("id", "summary", "doc_type", "schema_version", "source", "systems", "tags", "related_docs")
TODO_RE = re.compile(r"\b(TODO|TBD|FIXME|placeholder|coming soon)\b|\.{3,}", re.IGNORECASE)
GOOGLE_DOC_RE = re.compile(r"https://docs\.google\.com/document/[^\s)>\"]+", re.IGNORECASE)
MARKDOWN_TABLE_ROW_RE = re.compile(r"^\|(.+)\|\s*$")


@dataclass
class QualityFinding:
    category: str
    severity: str
    title: str
    summary: str
    source: str
    next_action: str
    doc_id: str = ""
    doc_path: str = ""
    template_id: str = ""
    workflow_slug: str = ""
    source_doc_ids: list[str] = field(default_factory=list)
    instruction_doc_id: str = ""
    task_ref: str = ""
    task_id: str = ""
    bundle_id: str = ""
    status: str = "open"

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "id": self.stable_id(),
            "category": self.category,
            "severity": self.severity,
            "title": self.title,
            "summary": self.summary,
            "source": self.source,
            "nextAction": self.next_action,
            "status": self.status,
        }
        optional = {
            "docId": self.doc_id,
            "docPath": self.doc_path,
            "templateId": self.template_id,
            "workflowSlug": self.workflow_slug,
            "sourceDocIds": self.source_doc_ids,
            "instructionDocId": self.instruction_doc_id,
            "taskRef": self.task_ref,
            "taskId": self.task_id,
            "bundleId": self.bundle_id,
        }
        for key, value in optional.items():
            if value:
                payload[key] = value
        return payload

    def stable_id(self) -> str:
        raw = "|".join(
            [
                self.category,
                self.source,
                self.doc_path,
                self.doc_id,
                self.template_id,
                self.workflow_slug,
                self.task_ref,
                self.instruction_doc_id,
                ",".join(self.source_doc_ids),
                self.title,
            ]
        )
        return f"pq-{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:12]}"


def build_report(repo_root: Path, content_root: Path | str = "content") -> dict[str, Any]:
    repo_root = repo_root.resolve()
    content_root_path = Path(content_root)
    if not content_root_path.is_absolute():
        content_root_path = repo_root / content_root_path
    content_root_path = content_root_path.resolve()

    findings: list[QualityFinding] = []
    validation_errors: list[str] = []
    try:
        registry = doc_registry.build_registry(content_root_path)
        registry_ok = True
    except doc_registry.DocumentRegistryError as exc:
        registry_ok = False
        validation_errors.extend(exc.violations)
        registry = doc_registry.build_registry(content_root_path, validate=False)

    template_context = template_context_from_seed(repo_root, registry)
    workflow_doc_ids = workflow_critical_doc_ids(registry, template_context)
    workflow_doc_paths = {registry.by_id[doc_id].path for doc_id in workflow_doc_ids if doc_id in registry.by_id}

    findings.extend(validation_findings(repo_root, content_root_path))
    findings.extend(metadata_findings(repo_root, content_root_path, registry, workflow_doc_paths))
    findings.extend(unstable_doc_id_findings(registry, workflow_doc_paths))
    findings.extend(template_gap_findings(repo_root, template_context, registry))
    findings.extend(doc_content_findings(repo_root, content_root_path, registry, workflow_doc_paths))

    deduped = dedupe_findings(findings)
    return {
        "ok": registry_ok,
        "summary": summarize(deduped),
        "findings": [finding.to_dict() for finding in sorted(deduped, key=finding_sort_key)],
        "validationErrors": validation_errors,
        "sources": {
            "registry": "lambda_functions.doc_registry",
            "linkValidation": "lambda_functions.validate_docs_links",
            "templateSource": "work-engine/scripts/seed-templates.ts",
            "contentRoot": content_root_path.relative_to(repo_root).as_posix()
            if repo_root in content_root_path.parents
            else content_root_path.as_posix(),
        },
    }


def validation_findings(repo_root: Path, content_root: Path) -> list[QualityFinding]:
    findings: list[QualityFinding] = []
    for violation in validate_docs_links.validate(repo_root, content_root):
        source_path, detail = split_validation_violation(violation)
        category = "broken-asset-reference" if "image target not found" in detail else "broken-doc-reference"
        if "sourceDocIds reference not found" in detail or "instructionDocId reference not found" in detail:
            category = "template-doc-gap"
        ref = extract_quoted(detail)
        findings.append(
            QualityFinding(
                category=category,
                severity="warning",
                title=validation_title(category, detail),
                summary=validation_summary(detail, ref),
                source="link validation",
                next_action=validation_next_action(category, detail),
                doc_path=source_path if source_path.startswith("content/") else "",
                source_doc_ids=[ref] if "sourceDocIds" in detail and ref else [],
                instruction_doc_id=ref if "instructionDocId" in detail and ref else "",
                template_id=template_id_from_path(source_path),
                workflow_slug=workflow_slug_from_path(source_path),
            )
        )
    return findings


def metadata_findings(
    repo_root: Path,
    content_root: Path,
    registry: doc_registry.DocumentRegistry,
    workflow_doc_paths: set[str],
) -> list[QualityFinding]:
    findings: list[QualityFinding] = []
    for record in registry.documents:
        if record.path not in workflow_doc_paths and record.doc_type != "task-template":
            continue
        raw, _body = sop_parse.split_frontmatter((repo_root / record.path).read_text(encoding="utf-8", errors="replace"))
        metadata = sop_parse.parse_frontmatter(raw) if raw else {}
        missing = [key for key in REQUIRED_METADATA if key not in metadata or metadata_value_empty(metadata.get(key))]
        for key in missing:
            findings.append(
                QualityFinding(
                    category="missing-metadata",
                    severity="warning",
                    title=f"Missing {key} metadata",
                    summary=f"{record.title} is workflow-critical but has no usable `{key}` frontmatter.",
                    source="registry",
                    next_action="fix metadata",
                    doc_id=record.id,
                    doc_path=record.path,
                    template_id=record.id if record.doc_type == "task-template" else "",
                    workflow_slug=workflow_slug_from_path(record.path),
                )
            )
    return findings


def unstable_doc_id_findings(
    registry: doc_registry.DocumentRegistry,
    workflow_doc_paths: set[str],
) -> list[QualityFinding]:
    findings: list[QualityFinding] = []
    for record in registry.documents:
        if record.path not in workflow_doc_paths and record.doc_type != "task-template":
            continue
        if record.id_source == "generated":
            findings.append(
                QualityFinding(
                    category="unstable-doc-id",
                    severity="warning",
                    title="Workflow document uses a generated ID",
                    summary=f"{record.title} is referenced by runnable workflow context but still relies on a generated document ID.",
                    source="registry",
                    next_action="add stable doc mapping",
                    doc_id=record.id,
                    doc_path=record.path,
                    template_id=record.id if record.doc_type == "task-template" else "",
                    workflow_slug=workflow_slug_from_path(record.path),
                )
            )
    return findings


def template_gap_findings(
    repo_root: Path,
    templates: list[dict[str, Any]],
    registry: doc_registry.DocumentRegistry,
) -> list[QualityFinding]:
    findings: list[QualityFinding] = []
    if not templates and not (repo_root / "work-engine" / "scripts" / "seed-templates.ts").exists():
        return [
            QualityFinding(
                category="template-doc-gap",
                severity="warning",
                title="Seed template source is missing",
                summary="Workflow template quality cannot be checked because work-engine/scripts/seed-templates.ts is absent.",
                source="workflow-template scan",
                next_action="add stable doc mapping",
            )
        ]
    for template in templates:
        workflow_slug = template["workflowSlug"]
        template_id = template.get("templateId", "")
        source_doc_ids = template.get("sourceDocIds", [])
        if not source_doc_ids:
            findings.append(
                QualityFinding(
                    category="template-doc-gap",
                    severity="blocking",
                    title="Workflow template has no source documents",
                    summary=f"{workflow_slug} can create runnable tasks without a sourceDocIds contract.",
                    source="workflow-template scan",
                    next_action="add stable doc mapping",
                    template_id=template_id,
                    workflow_slug=workflow_slug,
                )
            )
        for doc_id in source_doc_ids:
            if not registry_resolves(registry, doc_id):
                findings.append(
                    QualityFinding(
                        category="template-doc-gap",
                        severity="blocking",
                        title="Workflow template source document cannot be resolved",
                        summary=f"{workflow_slug} references sourceDocId `{doc_id}`, but the document registry cannot resolve it.",
                        source="workflow-template scan",
                        next_action="add stable doc mapping",
                        template_id=template_id,
                        workflow_slug=workflow_slug,
                        source_doc_ids=[doc_id],
                    )
                )
        for task in template.get("tasks", []):
            instruction_doc_id = task.get("instructionDocId", "")
            if not instruction_doc_id:
                findings.append(
                    QualityFinding(
                        category="template-doc-gap",
                        severity="blocking",
                        title="Template task has no instruction document",
                        summary=f"{workflow_slug} task `{task.get('refId', 'unknown')}` has no instructionDocId before it becomes runnable work.",
                        source="workflow-template scan",
                        next_action="add stable doc mapping",
                        template_id=template_id,
                        workflow_slug=workflow_slug,
                        task_ref=task.get("refId", ""),
                    )
                )
            elif not registry_resolves(registry, instruction_doc_id):
                findings.append(
                    QualityFinding(
                        category="broken-doc-reference",
                        severity="blocking",
                        title="Template task instruction document cannot be resolved",
                        summary=f"{workflow_slug} task `{task.get('refId', 'unknown')}` points to `{instruction_doc_id}`, but that process doc cannot be opened.",
                        source="workflow-template scan",
                        next_action="fix doc reference",
                        template_id=template_id,
                        workflow_slug=workflow_slug,
                        task_ref=task.get("refId", ""),
                        instruction_doc_id=instruction_doc_id,
                    )
                )
            if proof_instruction_missing(task.get("proof", "")):
                findings.append(
                    QualityFinding(
                        category="missing-proof-instructions",
                        severity="blocking",
                        title="Template task proof requirement is unclear",
                        summary=f"{workflow_slug} task `{task.get('refId', 'unknown')}` does not explain the evidence required before closure.",
                        source="proof/validation scan",
                        next_action="add proof requirement",
                        template_id=template_id,
                        workflow_slug=workflow_slug,
                        task_ref=task.get("refId", ""),
                        instruction_doc_id=instruction_doc_id,
                    )
                )
        if template.get("externalOnly"):
            findings.append(
                QualityFinding(
                    category="legacy-external-only-doc",
                    severity="warning",
                    title="Template instructions only point to Google Docs",
                    summary=f"{workflow_slug} still depends on external Google Docs references without enough in-repo source document mappings.",
                    source="workflow-template scan",
                    next_action="add stable doc mapping",
                    template_id=template_id,
                    workflow_slug=workflow_slug,
                )
            )
    return findings


def doc_content_findings(
    repo_root: Path,
    content_root: Path,
    registry: doc_registry.DocumentRegistry,
    workflow_doc_paths: set[str],
) -> list[QualityFinding]:
    findings: list[QualityFinding] = []
    for record in registry.documents:
        if record.path not in workflow_doc_paths and record.doc_type != "task-template":
            continue
        path = repo_root / record.path
        text = path.read_text(encoding="utf-8", errors="replace")
        raw, body = sop_parse.split_frontmatter(text)
        if TODO_RE.search(body):
            findings.append(
                QualityFinding(
                    category="todo-or-placeholder",
                    severity="warning",
                    title="Workflow process doc contains TODO or placeholder text",
                    summary=f"{record.title} contains placeholder language that can leave an operator without a complete instruction.",
                    source="lint/TODO scan",
                    next_action="open doc",
                    doc_id=record.id,
                    doc_path=record.path,
                    template_id=record.id if record.doc_type == "task-template" else "",
                    workflow_slug=workflow_slug_from_path(record.path),
                )
            )
        if validation_section_missing_or_empty(body):
            findings.append(
                QualityFinding(
                    category="missing-validation",
                    severity="warning",
                    title="Workflow process doc lacks validation guidance",
                    summary=f"{record.title} does not provide enough validation guidance for an operator to know when the work is done.",
                    source="proof/validation scan",
                    next_action="add validation guidance",
                    doc_id=record.id,
                    doc_path=record.path,
                    template_id=record.id if record.doc_type == "task-template" else "",
                    workflow_slug=workflow_slug_from_path(record.path),
                )
            )
        metadata = sop_parse.parse_frontmatter(raw) if raw else {}
        if record.doc_type == "task-template" and GOOGLE_DOC_RE.search(body) and not metadata.get("related_docs"):
            findings.append(
                QualityFinding(
                    category="legacy-external-only-doc",
                    severity="warning",
                    title="Task template has only external process references",
                    summary=f"{record.title} links to Google Docs without in-repo related_docs mappings.",
                    source="workflow-template scan",
                    next_action="add stable doc mapping",
                    doc_id=record.id,
                    doc_path=record.path,
                    template_id=record.id,
                    workflow_slug=workflow_slug_from_path(record.path),
                )
            )
    return findings


def template_context_from_seed(repo_root: Path, registry: doc_registry.DocumentRegistry) -> list[dict[str, Any]]:
    seed_path = repo_root / "work-engine" / "scripts" / "seed-templates.ts"
    if not seed_path.exists():
        return []
    text = seed_path.read_text(encoding="utf-8", errors="replace")
    source_doc_ids = validate_docs_links._source_doc_ids(text)  # type: ignore[attr-defined]
    instruction_map = instruction_doc_ids_by_ref(text)
    templates: list[dict[str, Any]] = []
    for md_path in sorted((repo_root / "content" / "tasks" / "templates").glob("*.md")):
        repo_path = md_path.relative_to(repo_root).as_posix()
        record = registry.by_path.get(repo_path)
        workflow_slug = md_path.stem
        body = md_path.read_text(encoding="utf-8", errors="replace")
        tasks = task_rows_from_template_markdown(body, instruction_map)
        template_source_ids = sorted(doc_id for doc_id in source_doc_ids if doc_id == (record.id if record else "") or workflow_slug in doc_id)
        if record:
            for related in record.related_docs:
                template_source_ids.append(related)
        templates.append(
            {
                "workflowSlug": workflow_slug,
                "templateId": record.id if record else "",
                "sourceDocIds": sorted(set(template_source_ids)),
                "tasks": tasks,
                "externalOnly": bool(GOOGLE_DOC_RE.search(body) and not (record and record.related_docs)),
            }
        )
    return templates


def workflow_critical_doc_ids(registry: doc_registry.DocumentRegistry, templates: list[dict[str, Any]]) -> set[str]:
    ids = {record.id for record in registry.documents if record.doc_type == "task-template"}
    for template in templates:
        ids.update(template.get("sourceDocIds", []))
        for task in template.get("tasks", []):
            if task.get("instructionDocId"):
                ids.add(task["instructionDocId"])
    resolved: set[str] = set()
    for ref in ids:
        try:
            resolved.add(doc_registry.resolve_reference(registry, ref).id)
        except Exception:
            continue
    return resolved


def instruction_doc_ids_by_ref(seed_text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for match in re.finditer(
        r"['\"](?P<ref>[a-z0-9._-]+)['\"]\s*:\s*\{(?P<body>[^{}]*instructionDocId\s*:\s*['\"][^'\"]+['\"][^{}]*)\}",
        seed_text,
        re.DOTALL,
    ):
        doc_match = re.search(r"instructionDocId\s*:\s*['\"](?P<doc>[^'\"]+)['\"]", match.group("body"))
        if doc_match:
            out[match.group("ref")] = doc_match.group("doc")
    return out


def task_rows_from_template_markdown(markdown: str, instruction_map: dict[str, str]) -> list[dict[str, str]]:
    tasks: list[dict[str, str]] = []
    in_task_table = False
    for line in markdown.splitlines():
        if line.strip().lower() == "## task definitions":
            in_task_table = True
            continue
        if in_task_table and line.startswith("## "):
            break
        if not in_task_table:
            continue
        match = MARKDOWN_TABLE_ROW_RE.match(line.strip())
        if not match:
            continue
        cells = [clean_table_cell(cell) for cell in split_table_cells(match.group(1))]
        if len(cells) < 8 or cells[0] in {"#", "-"} or cells[1].lower() == "ref id":
            continue
        ref_id = cells[1].strip("`")
        instruction_doc_id = cells[6].split("<br>", 1)[0].strip().strip("`")
        instruction_doc_id = re.sub(r"\s+step\s+\S+.*$", "", instruction_doc_id, flags=re.IGNORECASE).strip()
        if instruction_doc_id.lower() in {"", "none", "-"}:
            instruction_doc_id = instruction_map.get(ref_id, "")
        tasks.append(
            {
                "refId": ref_id,
                "phase": cells[2].strip("`"),
                "instructionDocId": instruction_doc_id,
                "proof": cells[7],
            }
        )
    return tasks


def split_table_cells(row_body: str) -> list[str]:
    cells: list[str] = []
    current: list[str] = []
    escaped = False
    for char in row_body:
        if char == "\\" and not escaped:
            escaped = True
            current.append(char)
            continue
        if char == "|" and not escaped:
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
        escaped = False
    cells.append("".join(current).strip())
    return cells


def clean_table_cell(value: str) -> str:
    return re.sub(r"<[^>]+>", " ", value).replace("&nbsp;", " ").strip()


def proof_instruction_missing(value: str) -> bool:
    text = re.sub(r"\s+", " ", str(value or "")).strip().lower()
    if not text or text in {"-", "tbd", "todo", "placeholder"}:
        return True
    if text == "none":
        return False
    if TODO_RE.search(text):
        return True
    return not re.search(r"\b(url|link|file|pdf|artifact|comment|note|external-status|status|evidence|proof|receipt|invoice)\b", text)


def validation_section_missing_or_empty(markdown_body: str) -> bool:
    section = section_body(markdown_body, "validation")
    if section is None:
        match = re.search(r"(?im)^##\s+Validation\s*$", markdown_body)
        if not match:
            return True
        rest = markdown_body[match.end() :]
        next_heading = re.search(r"(?m)^##\s+", rest)
        section = rest[: next_heading.start()] if next_heading else rest
    cleaned = re.sub(r"<!--.*?-->", "", section, flags=re.DOTALL)
    cleaned = re.sub(r"#+\s*Validation", "", cleaned, flags=re.IGNORECASE).strip()
    return not cleaned or TODO_RE.search(cleaned) is not None


def section_body(markdown_body: str, name: str) -> str | None:
    start_re = re.compile(rf"<!--\s*sop-section-start:\s*{re.escape(name)}(?:\s+[^>]*)?-->", re.IGNORECASE)
    start = start_re.search(markdown_body)
    if not start:
        return None
    close = re.search(r"<!--\s*sop-section-end\s*-->", markdown_body[start.end() :], re.IGNORECASE)
    return markdown_body[start.end() : start.end() + close.start()] if close else markdown_body[start.end() :]


def split_validation_violation(violation: str) -> tuple[str, str]:
    source, sep, detail = violation.partition(": ")
    if source == "content registry" and sep:
        nested_source, nested_sep, nested_detail = detail.partition(": ")
        if nested_sep:
            return nested_source, nested_detail
    return source if sep else "", detail if sep else violation


def extract_quoted(value: str) -> str:
    match = re.search(r"'([^']+)'", value)
    return match.group(1) if match else ""


def validation_title(category: str, detail: str) -> str:
    if category == "broken-asset-reference":
        return "Process doc references a missing asset"
    if "sourceDocIds" in detail:
        return "Workflow template source document cannot be resolved"
    if "instructionDocId" in detail:
        return "Template task instruction document cannot be resolved"
    return "Process doc reference cannot be resolved"


def validation_summary(detail: str, ref: str) -> str:
    target = f" `{ref}`" if ref else ""
    if "image target not found" in detail:
        return f"A workflow-relevant process doc uses a missing screenshot or image{target}."
    if "link target not found" in detail:
        return f"A workflow-relevant process doc links to a missing local file{target}."
    if "related_docs" in detail:
        return f"A related_docs entry cannot be resolved{target}."
    if "wiki reference" in detail:
        return f"A wiki-style process reference cannot be resolved{target}."
    if "doc reference" in detail:
        return f"A doc: process reference cannot be resolved{target}."
    return detail


def validation_next_action(category: str, detail: str) -> str:
    if category == "broken-asset-reference":
        return "open doc"
    if "sourceDocIds" in detail or "instructionDocId" in detail:
        return "add stable doc mapping"
    return "fix metadata"


def registry_resolves(registry: doc_registry.DocumentRegistry, ref: str) -> bool:
    try:
        doc_registry.resolve_reference(registry, ref)
        return True
    except Exception:
        return False


def metadata_value_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, list):
        return len(value) == 0
    return not str(value).strip()


def template_id_from_path(path: str) -> str:
    if path.startswith("content/tasks/templates/") and path.endswith(".md"):
        return f"task-template.tasks.{Path(path).stem}"
    return ""


def workflow_slug_from_path(path: str) -> str:
    if path.startswith("content/tasks/templates/") and path.endswith(".md"):
        return Path(path).stem
    return ""


def dedupe_findings(findings: list[QualityFinding]) -> list[QualityFinding]:
    seen: set[str] = set()
    out: list[QualityFinding] = []
    for finding in findings:
        if finding.category not in CATEGORIES:
            continue
        key = finding.stable_id()
        if key in seen:
            continue
        seen.add(key)
        out.append(finding)
    return out


def summarize(findings: list[QualityFinding]) -> dict[str, Any]:
    by_severity = {"blocking": 0, "warning": 0, "info": 0}
    by_category = {category: 0 for category in sorted(CATEGORIES)}
    for finding in findings:
        by_severity[finding.severity] = by_severity.get(finding.severity, 0) + 1
        by_category[finding.category] = by_category.get(finding.category, 0) + 1
    return {
        "total": len(findings),
        "blocking": by_severity.get("blocking", 0),
        "warning": by_severity.get("warning", 0),
        "info": by_severity.get("info", 0),
        "byCategory": by_category,
    }


def finding_sort_key(finding: QualityFinding) -> tuple[int, str, str, str]:
    severity_order = {"blocking": 0, "warning": 1, "info": 2}
    return (severity_order.get(finding.severity, 3), finding.workflow_slug, finding.category, finding.title)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the DataOps process-quality report.")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--content-root", default="content")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    report = build_report(args.repo_root, args.content_root)
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
