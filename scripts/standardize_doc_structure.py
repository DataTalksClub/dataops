from __future__ import annotations

import re
from pathlib import Path

from audit_doc_structure import DOCS_DIR, REQUIRED_SECTIONS, classify, split_frontmatter


ROOT = Path(__file__).resolve().parents[1]

SYSTEM_KEYWORDS = {
    "airtable": "airtable",
    "calendar": "google-calendar",
    "finom": "finom",
    "github": "github",
    "linkedin": "linkedin",
    "loom": "loom",
    "luma": "luma",
    "mailchimp": "mailchimp",
    "maven": "maven",
    "meetup": "meetup",
    "revolut": "revolut",
    "slack": "slack",
    "spotify": "spotify",
    "trello": "trello",
    "twitter": "twitter",
    "youtube": "youtube",
    "zoom": "zoom",
}


def title_from_path(path: Path) -> str:
    words = path.stem.replace("-", " ").replace("_", " ").strip()
    return re.sub(r"\s+", " ", words).title()


def yaml_scalar(value: str) -> str:
    escaped = value.replace('"', "'")
    return f'"{escaped}"'


def parse_list_field(raw: str) -> list[str]:
    raw = raw.strip()
    if raw in {"", "[]"}:
        return []
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        return [item.strip().strip('"').strip("'") for item in inner.split(",")]
    return []


def existing_tags(frontmatter_raw: str) -> list[str]:
    tags: list[str] = []
    in_tags = False
    for line in frontmatter_raw.splitlines():
        if line.startswith("tags:"):
            in_tags = True
            inline = line.split(":", 1)[1].strip()
            tags.extend(parse_list_field(inline))
            continue
        if in_tags:
            if line.startswith("  - "):
                tags.append(line[4:].strip().strip('"').strip("'"))
                continue
            if line and not line.startswith(" "):
                break
    return [tag for tag in tags if tag]


def raw_frontmatter(text: str) -> str:
    if not text.startswith("---\n"):
        return ""
    end = text.find("\n---\n", 4)
    if end == -1:
        return ""
    return text[4:end]


def infer_systems(path: Path, title: str, body: str) -> list[str]:
    haystack = f"{path.as_posix()} {title} {body[:4000]}".lower()
    systems = sorted({value for key, value in SYSTEM_KEYWORDS.items() if key in haystack})
    return systems


def infer_status(body: str, source: str) -> str:
    lowered = body.lower()
    if "could not be converted automatically" in lowered:
        return "needs-review"
    if "<insert image>" in lowered or "todo" in lowered or "for update" in source.lower():
        return "needs-review"
    if source:
        return "migrated"
    return "active"


def render_list(name: str, values: list[str]) -> list[str]:
    if not values:
        return [f"{name}: []"]
    return [f"{name}:"] + [f"  - {value}" for value in values]


def build_frontmatter(
    path: Path,
    doc_type: str,
    frontmatter: dict[str, str],
    body: str,
    raw: str,
) -> str:
    title = frontmatter.get("title", "").strip().strip('"') or title_from_path(path)
    source = frontmatter.get("source", "").strip().strip('"')
    converted = frontmatter.get("converted", "").strip()
    tags = existing_tags(raw)
    if "migrated" not in tags and source:
        tags.append("migrated")
    rel_parts = path.relative_to(DOCS_DIR).parts
    category = rel_parts[0] if len(rel_parts) > 1 else ""
    if category and category not in tags:
        tags.append(category)
    systems = infer_systems(path, title, body)
    status = infer_status(body, source)

    lines = [
        "---",
        f"title: {yaml_scalar(title)}",
        f"doc_type: {doc_type}",
        f"status: {status}",
        'owner: ""',
        f"source: {yaml_scalar(source)}",
    ]
    if converted:
        lines.append(f"converted: {converted}")
    else:
        lines.append("converted:")
    lines.extend(render_list("tags", tags))
    lines.extend(render_list("systems", systems))
    lines.append("related_docs: []")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def extract_summary_lines(body: str) -> tuple[dict[str, str], str]:
    summary = {"what": "", "why": "", "when": ""}
    kept: list[str] = []
    for line in body.splitlines():
        match = re.match(r"^\s*(What|Why|When)\s*:\s*(.*)$", line, re.I)
        if match:
            summary[match.group(1).lower()] = match.group(2).strip()
        else:
            kept.append(line)
    return summary, "\n".join(kept).strip()


def remove_duplicate_title(body: str, title: str) -> str:
    lines = body.splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines:
        first = re.sub(r"^#\s+", "", lines[0]).strip()
        if lines[0].startswith("# ") and first.lower() == title.lower():
            lines.pop(0)
    return "\n".join(lines).strip()


def normalize_step_heading(body: str) -> str:
    body = re.sub(r"(?im)^#\s*step-by-step instructions?\s*$", "## Procedure", body)
    body = re.sub(r"(?im)^##\s*step-by-step instructions?\s*$", "## Procedure", body)
    return body.strip()


def demote_headings(markdown: str, by: int = 2) -> str:
    lines: list[str] = []
    for line in markdown.splitlines():
        match = re.match(r"^(#{1,6})(\s+.+)$", line)
        if not match:
            lines.append(line)
            continue
        level = min(6, len(match.group(1)) + by)
        lines.append("#" * level + match.group(2))
    return "\n".join(lines)


def has_section(body: str, section: str) -> bool:
    return re.search(rf"(?im)^##\s+{re.escape(section)}\s*$", body) is not None


def process_body(title: str, body: str) -> str:
    summary, remainder = extract_summary_lines(remove_duplicate_title(body, title))
    remainder = normalize_step_heading(remainder)
    if not has_section(remainder, "Procedure"):
        remainder = f"## Procedure\n\n{demote_headings(remainder)}".strip()
    else:
        head, _, tail = remainder.partition("## Procedure")
        remainder = f"{head}## Procedure{demote_headings(tail)}".strip()

    sections = [
        f"# {title}",
        "## Summary",
        f"- Purpose: {summary['what']}",
        f"- Outcome: {summary['why']}",
        f"- Trigger: {summary['when']}",
        "- Frequency:",
        "",
        "## Prerequisites",
        "",
        "- Access:",
        "- Tools:",
        "- Inputs:",
        "",
        remainder,
    ]
    for section in ["Validation", "Troubleshooting", "References"]:
        if not has_section("\n".join(sections), section):
            sections.extend(["", f"## {section}", "", "-"])
    return "\n".join(sections).strip() + "\n"


def template_body(title: str, body: str) -> str:
    content = demote_headings(remove_duplicate_title(body, title))
    return (
        f"# {title}\n\n"
        "## Usage\n\n"
        "- Use when:\n"
        "- Audience:\n"
        "- Required inputs:\n\n"
        "## Template\n\n"
        f"{content}\n\n"
        "## Notes\n\n"
        "-\n"
    )


def reference_body(title: str, body: str) -> str:
    content = demote_headings(remove_duplicate_title(body, title))
    return (
        f"# {title}\n\n"
        "## Summary\n\n"
        "\n"
        "## Content\n\n"
        f"{content}\n\n"
        "## References\n\n"
        "-\n"
    )


def main() -> None:
    changed = 0
    for path in sorted(DOCS_DIR.rglob("*.md")):
        if path.name.startswith("_"):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        frontmatter, body = split_frontmatter(text)
        raw = raw_frontmatter(text)
        doc_type = classify(path, frontmatter, body)
        title = frontmatter.get("title", "").strip().strip('"') or title_from_path(path)
        header = build_frontmatter(path, doc_type, frontmatter, body, raw)

        if doc_type == "process":
            new_body = process_body(title, body)
        elif doc_type == "template":
            new_body = template_body(title, body)
        else:
            new_body = reference_body(title, body)

        new_text = header + new_body
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")
            changed += 1

    print({"standardized": changed})


if __name__ == "__main__":
    main()
