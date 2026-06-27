"""Validate a marked-up SOP markdown file against docs/sop-format.md.

Reusable lint logic. The CLI shim lives at scripts/sop_lint.py.
"""
from __future__ import annotations

from typing import Any

from lambda_functions.sop_parse import (
    ParseError,
    REQUIRED_SECTIONS,
    parse,
    parse_frontmatter,
    split_frontmatter,
)


ALLOWED_ACTIONS = {
    "navigate", "click", "type", "upload", "download",
    "copy", "paste", "submit", "verify", "wait", "other",
}


def lint_text(text: str) -> list[str]:
    """Return a list of violation strings for the given marked-up SOP text.

    Empty list means clean.
    """
    violations: list[str] = []
    raw_fm, _ = split_frontmatter(text)
    if not raw_fm:
        violations.append("missing frontmatter")
        return violations
    fm = parse_frontmatter(raw_fm)
    if fm.get("doc_type") not in {"sop", "checklist"}:
        violations.append(
            f"doc_type must be 'sop' or 'checklist' (got {fm.get('doc_type')!r})"
        )
    if not fm.get("title"):
        violations.append("frontmatter is missing `title`")
    if fm.get("schema_version") is None:
        return violations
    try:
        sv = int(fm.get("schema_version"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        violations.append(f"schema_version must be an integer (got {fm.get('schema_version')!r})")
        return violations
    if sv != 1:
        violations.append(f"unsupported schema_version: {sv}")
        return violations
    try:
        result = parse(text)
    except ParseError as e:
        violations.append(f"parse error: {e}")
        return violations

    sections = result["sections"]
    for name in REQUIRED_SECTIONS:
        if name not in sections:
            violations.append(f"missing required section: {name}")

    if "procedure" in sections and not sections["procedure"].get("raw", False):
        proc = sections["procedure"]
        groups = proc.get("groups", [])
        flat = proc.get("flat_steps", [])
        if groups and flat:
            violations.append("procedure mixes groups and flat steps — pick one shape")
        all_steps: list[dict[str, Any]] = []
        for g in groups:
            all_steps.extend(g["steps"])
        all_steps.extend(flat)
        ids = [s["id"] for s in all_steps]
        if len(set(ids)) != len(ids):
            dups = sorted({i for i in ids if ids.count(i) > 1})
            violations.append(f"duplicate step ids: {dups}")
        expected = list(range(1, len(ids) + 1))
        if ids != expected:
            violations.append(f"step ids are not sequential 1..N; got {ids}, expected {expected}")
        declared_systems = set(_as_list(fm.get("systems")))
        for s in all_steps:
            attrs = s.get("attrs", {})
            action = attrs.get("action")
            if action and action not in ALLOWED_ACTIONS:
                violations.append(
                    f"step id={s['id']}: action {action!r} not in {sorted(ALLOWED_ACTIONS)}"
                )
            systems = attrs.get("systems") or []
            unknown = set(systems) - declared_systems
            if unknown and declared_systems:
                violations.append(
                    f"step id={s['id']}: systems {sorted(unknown)} not in frontmatter `systems`"
                )
            for shot in s.get("screenshots", []):
                if not shot.get("src"):
                    violations.append(
                        f"step id={s['id']}: <!-- sop-screenshot-start --> block has no image"
                    )
            if s.get("rendered_number") not in (None, s["id"]):
                violations.append(
                    f"step id={s['id']}: rendered number {s.get('rendered_number')} does not match id"
                )

    return violations


def _as_list(v: Any) -> list[Any]:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]
