#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote


REPO_ROOT = Path(__file__).resolve().parents[1]
LAMBDA_SRC = REPO_ROOT / "lambda-functions" / "src"
if str(LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(LAMBDA_SRC))

from lambda_functions import doc_registry, sop_parse  # noqa: E402


PROTECTED_MARKDOWN_GLOBS = [
    "_docs/**/*.md",
    "docs/**/*.md",
    "templates/**/*.md",
    "content/tasks/templates/**/*.md",
]
PROTECTED_MARKDOWN_FILES = [
    ".goal-v1.md",
    "PROJECT_PLAN.md",
    "PORTAL_ANALYSIS.md",
    "README.md",
]
REQUIRED_WORKFLOW_PATHS = [
    ".github/workflows/validate-planning-docs.yml",
    "_docs/**",
    "docs/**",
    "templates/**",
    "content/tasks/templates/**",
    ".goal-v1.md",
    "PROJECT_PLAN.md",
    "PORTAL_ANALYSIS.md",
    "README.md",
    "scripts/validate_planning_docs.py",
    "tests/planning_docs/**",
    "tests/docs_app/**",
    "lambda-functions/src/lambda_functions/doc_registry.py",
    "lambda-functions/src/lambda_functions/build_search_index.py",
]
TASK_TEMPLATE_SECTIONS = [
    "summary",
    "purpose",
    "references",
    "required-bundle-links",
    "task-definitions",
]
TASK_TEMPLATE_SYSTEMS = {"dataops", "datatasks"}
TASK_DEFINITIONS_TABLE_HEADERS = {
    "| # | Ref ID | Offset | Task | Requirements | Instructions |",
    "| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof / closure | Waiting / follow-up |",
}
PROCESS_CONTROLS = {
    "orchestrator intake with needs grooming": [
        "orchestrator files",
        "needs grooming",
        "orchestrator does not groom inline",
    ],
    "pm grooming owns scope and tests": [
        "product manager",
        "groom",
        "acceptance criteria",
        "test scenarios",
    ],
    "software engineer does not commit before review": [
        "software engineer",
        "does not commit",
        "tester",
        "pm acceptance",
    ],
    "tester runs real verification and screenshots": [
        "tester",
        "real tests",
        "screenshots",
        "verifies every acceptance criterion",
    ],
    "pm acceptance from user perspective": [
        "product manager performs final acceptance",
        "user perspective",
    ],
    "local merge to main": [
        "local merge",
        "main",
        "no prs",
    ],
    "push main": [
        "push",
        "origin main",
    ],
    "on-call ci/cd monitoring": [
        "on-call",
        "monitors ci/cd",
    ],
    "no pull request merge workflow": [
        "never use",
        "gh pr create",
        "gh pr merge",
    ],
    "no stylint requirement for internal process docs": [
        "internal process docs",
        "stylint",
        "explicitly asks",
    ],
}

MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*]\((?P<target>[^)]+)\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(?P<title>.+?)\s*#*\s*$", re.MULTILINE)
SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate DataOps planning/process docs contracts.")
    parser.add_argument("--repo-root", default=REPO_ROOT, type=Path)
    args = parser.parse_args()

    violations = validate(args.repo_root)
    if violations:
        print("Planning docs validation failed:", file=sys.stderr)
        for violation in violations:
            print(f"- {violation}", file=sys.stderr)
        return 1

    print("Planning docs validation passed.")
    return 0


def validate(repo_root: Path) -> list[str]:
    repo_root = repo_root.resolve()
    violations: list[str] = []
    violations.extend(validate_markdown_links(repo_root))
    violations.extend(validate_frontmatter_related_docs(repo_root))
    violations.extend(validate_goal_reference_set(repo_root))
    violations.extend(validate_jtbd_reference_set(repo_root))
    violations.extend(validate_process_controls(repo_root))
    violations.extend(validate_doc_registry(repo_root))
    violations.extend(validate_task_templates(repo_root))
    violations.extend(validate_workflow(repo_root))
    return violations


def protected_markdown_files(repo_root: Path) -> list[Path]:
    files: set[Path] = set()
    for pattern in PROTECTED_MARKDOWN_GLOBS:
        files.update(path for path in repo_root.glob(pattern) if path.is_file())
    files.update(repo_root / path for path in PROTECTED_MARKDOWN_FILES)
    return sorted(path for path in files if path.exists())


def validate_markdown_links(repo_root: Path) -> list[str]:
    return validate_markdown_links_for_files(repo_root, protected_markdown_files(repo_root))


def validate_markdown_links_for_files(repo_root: Path, markdown_files: list[Path]) -> list[str]:
    repo_root = repo_root.resolve()
    violations: list[str] = []
    for markdown_path in markdown_files:
        markdown_path = markdown_path.resolve()
        text = markdown_path.read_text(encoding="utf-8", errors="replace")
        for match in MARKDOWN_LINK_RE.finditer(text):
            raw_target = _strip_markdown_title(match.group("target"))
            if _is_external_or_anchor(raw_target):
                continue
            path_part, anchor = _split_link_target(raw_target)
            if not path_part:
                continue
            target_path = _resolve_doc_link(repo_root, markdown_path, path_part)
            display_source = _repo_path(repo_root, markdown_path)
            if not target_path.exists():
                violations.append(f"{display_source}: link target not found: {raw_target}")
                continue
            if anchor and target_path.suffix.lower() == ".md":
                anchors = markdown_anchors(target_path.read_text(encoding="utf-8", errors="replace"))
                if anchor not in anchors:
                    violations.append(f"{display_source}: anchor #{anchor} not found in {_repo_path(repo_root, target_path)}")
    return violations


def validate_frontmatter_related_docs(repo_root: Path) -> list[str]:
    violations: list[str] = []
    registry = _build_registry_or_none(repo_root, violations)
    for markdown_path in protected_markdown_files(repo_root):
        raw, _body = sop_parse.split_frontmatter(markdown_path.read_text(encoding="utf-8", errors="replace"))
        metadata = sop_parse.parse_frontmatter(raw) if raw else {}
        for related in _strings(metadata.get("related_docs")):
            if _is_external_or_anchor(related):
                continue
            candidates = _reference_candidates(repo_root, markdown_path, related)
            if any(candidate.exists() for candidate in candidates):
                continue
            if registry and _registry_resolves(registry, related):
                continue
            violations.append(f"{_repo_path(repo_root, markdown_path)}: related_docs target not found: {related}")
    return violations


def validate_goal_reference_set(repo_root: Path) -> list[str]:
    path = repo_root / ".goal-v1.md"
    text = path.read_text(encoding="utf-8", errors="replace")
    refs = _code_refs_after_heading(text, "## Reference Files")
    violations: list[str] = []
    required = {"docs/operations-manager-platform-jtbd.md", "content/tasks/templates/"}
    missing_refs = sorted(required - set(refs))
    for ref in missing_refs:
        violations.append(f".goal-v1.md: required V1 goal reference is missing from Reference Files: {ref}")
    for ref in refs:
        target = repo_root / ref.rstrip("/")
        if not target.exists():
            violations.append(f".goal-v1.md: reference target not found: {ref}")
        elif target.is_dir() and not any(target.rglob("*.md")):
            violations.append(f".goal-v1.md: reference directory has no Markdown files: {ref}")
    return violations


def validate_jtbd_reference_set(repo_root: Path) -> list[str]:
    path = repo_root / "docs" / "operations-manager-platform-jtbd.md"
    text = path.read_text(encoding="utf-8", errors="replace")
    refs = _code_refs_after_heading(text, "## Source Material Used")
    violations: list[str] = []
    required = {
        "work-engine/docs/specs.md",
        "work-engine/docs/data.md",
        "work-engine/docs/templates.md",
        "work-engine/src/types.ts",
        "work-engine/src/public/app.js",
        "content/tasks/templates/*.md",
        "assistants/podcast/README.md",
        "assistants/podcast/process/podcast.md",
        "assistants/podcast/templates/podcast_guest_intake.md",
    }
    missing_refs = sorted(required - set(refs))
    for ref in missing_refs:
        violations.append(f"docs/operations-manager-platform-jtbd.md: required source reference is missing: {ref}")
    for ref in refs:
        if "*" in ref:
            if not list(repo_root.glob(ref)):
                violations.append(f"docs/operations-manager-platform-jtbd.md: glob reference has no matches: {ref}")
            continue
        if not (repo_root / ref).exists():
            violations.append(f"docs/operations-manager-platform-jtbd.md: source reference target not found: {ref}")
    return violations


def validate_process_controls(repo_root: Path) -> list[str]:
    text = (repo_root / "_docs" / "PROCESS.md").read_text(encoding="utf-8", errors="replace")
    normalized = _normalize_text(text)
    violations: list[str] = []
    for control, phrases in PROCESS_CONTROLS.items():
        missing = [phrase for phrase in phrases if phrase not in normalized]
        if missing:
            violations.append(f"_docs/PROCESS.md: missing lifecycle control '{control}' ({', '.join(missing)})")
    return violations


def validate_doc_registry(repo_root: Path) -> list[str]:
    violations: list[str] = []
    try:
        registry = doc_registry.build_registry(repo_root / "content")
    except doc_registry.DocumentRegistryError as exc:
        violations.extend(f"content registry: {violation}" for violation in exc.violations)
        return violations

    for template_path in sorted((repo_root / "content" / "tasks" / "templates").glob("*.md")):
        repo_path = _repo_path(repo_root, template_path)
        record = registry.by_path.get(repo_path)
        if record is None:
            violations.append(f"{repo_path}: missing from document registry")
        elif record.doc_type != "task-template":
            violations.append(f"{repo_path}: registry doc_type must be task-template, got {record.doc_type!r}")
    return violations


def validate_task_templates(repo_root: Path) -> list[str]:
    violations: list[str] = []
    template_paths = sorted((repo_root / "content" / "tasks" / "templates").glob("*.md"))
    if not template_paths:
        return ["content/tasks/templates/: no task template Markdown files found"]

    seen_titles: dict[str, str] = {}
    for template_path in template_paths:
        repo_path = _repo_path(repo_root, template_path)
        text = template_path.read_text(encoding="utf-8", errors="replace")
        raw, body = sop_parse.split_frontmatter(text)
        metadata = sop_parse.parse_frontmatter(raw) if raw else {}
        title = str(metadata.get("title", "")).strip()
        if not title:
            violations.append(f"{repo_path}: frontmatter title is required")
        elif title in seen_titles:
            violations.append(f"{repo_path}: duplicate task-template title also used by {seen_titles[title]}")
        else:
            seen_titles[title] = repo_path
        if metadata.get("doc_type") != "task-template":
            violations.append(f"{repo_path}: doc_type must be task-template")
        if str(metadata.get("schema_version")) != "1":
            violations.append(f"{repo_path}: schema_version must be 1")
        if metadata.get("source") != "work-engine/scripts/seed-templates.ts":
            violations.append(f"{repo_path}: source must stay linked to work-engine/scripts/seed-templates.ts")
        systems = set(_strings(metadata.get("systems")))
        if not TASK_TEMPLATE_SYSTEMS.issubset(systems):
            violations.append(f"{repo_path}: systems must include dataops and datatasks")
        tags = set(_strings(metadata.get("tags")))
        if "task-template" not in tags or template_path.stem not in tags:
            violations.append(f"{repo_path}: tags must include task-template and {template_path.stem}")
        for section in TASK_TEMPLATE_SECTIONS:
            if f"<!-- sop-section-start: {section} -->" not in body:
                violations.append(f"{repo_path}: missing task-template section {section}")
        if not any(header in body for header in TASK_DEFINITIONS_TABLE_HEADERS):
            violations.append(f"{repo_path}: task definitions table header is missing or changed")
    return violations


def validate_workflow(repo_root: Path) -> list[str]:
    workflow = repo_root / ".github" / "workflows" / "validate-planning-docs.yml"
    if not workflow.exists():
        return [".github/workflows/validate-planning-docs.yml: workflow is required"]

    text = workflow.read_text(encoding="utf-8")
    violations: list[str] = []
    required_snippets = [
        "workflow_dispatch:",
        "permissions:",
        "contents: read",
        "uv run --with pytest python -m pytest tests/planning_docs",
        "uv run --project lambda-functions --extra search --with pytest python -m pytest tests/docs_app",
        "python -m lambda_functions.build_search_index",
    ]
    for snippet in required_snippets:
        if snippet not in text:
            violations.append(f"{_repo_path(repo_root, workflow)}: missing required workflow snippet: {snippet}")
    for protected_path in REQUIRED_WORKFLOW_PATHS:
        if protected_path not in text:
            violations.append(f"{_repo_path(repo_root, workflow)}: path filter missing {protected_path}")
    forbidden_snippets = [
        "id-token:",
        "configure-aws-credentials",
        "AWS_ROLE_ARN",
        "sam deploy",
        "lambda invoke",
        "/admin/refresh",
        "git push",
        "gh pr create",
        "gh pr merge",
        "stylint",
    ]
    for snippet in forbidden_snippets:
        if snippet in text:
            violations.append(f"{_repo_path(repo_root, workflow)}: forbidden read-only planning workflow snippet: {snippet}")
    if re.search(r"^\s+\w[\w-]*:\s+write\s*$", text, re.MULTILINE):
        violations.append(f"{_repo_path(repo_root, workflow)}: workflow permissions must not grant write scopes")
    return violations


def markdown_anchors(markdown: str) -> set[str]:
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    for match in HEADING_RE.finditer(markdown):
        base = github_anchor(match.group("title"))
        count = counts.get(base, 0)
        counts[base] = count + 1
        anchors.add(base if count == 0 else f"{base}-{count}")
    return anchors


def github_anchor(title: str) -> str:
    title = re.sub(r"<[^>]+>", "", title)
    title = re.sub(r"`([^`]+)`", r"\1", title)
    title = title.strip().lower()
    title = re.sub(r"[^\w\s-]", "", title)
    title = re.sub(r"\s+", "-", title)
    return title.strip("-")


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
        or SCHEME_RE.match(target) is not None
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


def _resolve_doc_link(repo_root: Path, markdown_path: Path, target: str) -> Path:
    target = target.replace("\\", "/")
    if target.startswith("/"):
        return (repo_root / target.lstrip("/")).resolve()
    return (markdown_path.parent / target).resolve()


def _reference_candidates(repo_root: Path, markdown_path: Path, target: str) -> list[Path]:
    target = _split_link_target(unquote(target))[0].replace("\\", "/").strip()
    if not target:
        return []
    candidates = [_resolve_doc_link(repo_root, markdown_path, target)]
    candidates.append((repo_root / target.lstrip("/")).resolve())
    return candidates


def _build_registry_or_none(repo_root: Path, violations: list[str]) -> doc_registry.DocumentRegistry | None:
    try:
        return doc_registry.build_registry(repo_root / "content")
    except doc_registry.DocumentRegistryError as exc:
        violations.extend(f"content registry: {violation}" for violation in exc.violations)
        return None


def _registry_resolves(registry: doc_registry.DocumentRegistry, reference: str) -> bool:
    try:
        doc_registry.resolve_reference(registry, reference)
        return True
    except (LookupError, ValueError):
        return False


def _code_refs_after_heading(markdown: str, heading: str) -> list[str]:
    start = markdown.find(heading)
    if start == -1:
        return []
    next_heading = markdown.find("\n## ", start + len(heading))
    section = markdown[start:] if next_heading == -1 else markdown[start:next_heading]
    refs: list[str] = []
    for line in section.splitlines():
        refs.extend(match.strip() for match in re.findall(r"`([^`]+)`", line))
    return refs


def _strings(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip().strip('"').strip("'") for item in value if str(item).strip()]
    if isinstance(value, str):
        return [value.strip().strip('"').strip("'")] if value.strip() else []
    return [str(value).strip()]


def _normalize_text(text: str) -> str:
    text = text.replace("`", "")
    text = re.sub(r"\s+", " ", text)
    return text.lower()


def _repo_path(repo_root: Path, path: Path) -> str:
    return path.resolve().relative_to(repo_root).as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
