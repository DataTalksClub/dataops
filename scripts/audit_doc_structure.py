from __future__ import annotations

import csv
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "content"
REPORT = ROOT / "reports" / "structure-audit.csv"

REQUIRED_FRONTMATTER = [
    "title",
    "doc_type",
    "systems",
    "related_docs",
]

REQUIRED_SECTIONS = {
    "sop": ["Summary", "Prerequisites", "Procedure", "Validation", "Troubleshooting", "References"],
    "checklist": ["Summary", "Prerequisites", "Procedure", "Validation", "Troubleshooting", "References"],
    "template": ["Usage", "Template", "Notes"],
    "reference": ["Summary", "Content", "References"],
    "playbook": ["Summary", "Content", "References"],
}


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    raw = text[4:end]
    body = text[end + 5 :]
    data: dict[str, str] = {}
    for line in raw.splitlines():
        if not line.strip() or line.startswith(" ") or line.startswith("-"):
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            data[key.strip()] = value.strip()
    return data, body


def classify(path: Path, frontmatter: dict[str, str], body: str) -> str:
    explicit = frontmatter.get("doc_type", "").strip().strip('"')
    if explicit in REQUIRED_SECTIONS:
        return explicit

    rel = path.relative_to(DOCS_DIR)
    rel_text = rel.as_posix().lower()
    title = frontmatter.get("title", "").lower()
    text_head = body[:2000].lower()

    if rel_text.startswith("templates/") or "/templates/" in rel_text or "template" in title:
        return "template"
    if path.name.startswith("_") or path.name in {"README.md", "STRUCTURE.md"}:
        return "reference"
    if "source:" in text_head and ".xlsx" in text_head:
        return "reference"
    if re.search(r"(?im)^\s*(what|why|when)\s*:", body):
        return "sop"
    if re.search(r"(?im)^#\s*step-by-step instructions?\b", body):
        return "sop"
    if re.search(r"(?m)^\s*1\.\s+", body):
        return "sop"
    return "reference"


def headings(body: str) -> set[str]:
    found: set[str] = set()
    for line in body.splitlines():
        match = re.match(r"^#{1,3}\s+(.+?)\s*$", line)
        if match:
            title = re.sub(r"[*_`]+", "", match.group(1)).strip().lower()
            found.add(title)
    return found


def main() -> None:
    rows: list[dict[str, str]] = []
    for path in sorted(DOCS_DIR.rglob("*.md")):
        if path.name.startswith("_"):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        frontmatter, body = split_frontmatter(text)
        doc_type = classify(path, frontmatter, body)
        found_headings = headings(body)
        missing_frontmatter = [
            field for field in REQUIRED_FRONTMATTER if field not in frontmatter
        ]
        missing_sections = [
            section
            for section in REQUIRED_SECTIONS[doc_type]
            if section.lower() not in found_headings
        ]
        rows.append(
            {
                "path": path.relative_to(ROOT).as_posix(),
                "doc_type": doc_type,
                "missing_frontmatter": ";".join(missing_frontmatter),
                "missing_sections": ";".join(missing_sections),
            }
        )

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    with REPORT.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["path", "doc_type", "missing_frontmatter", "missing_sections"],
        )
        writer.writeheader()
        writer.writerows(rows)

    compliant = [
        row for row in rows if not row["missing_frontmatter"] and not row["missing_sections"]
    ]
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["doc_type"]] = counts.get(row["doc_type"], 0) + 1
    print(
        {
            "docs": len(rows),
            "compliant": len(compliant),
            "doc_types": counts,
            "report": REPORT.relative_to(ROOT).as_posix(),
        }
    )


if __name__ == "__main__":
    main()
