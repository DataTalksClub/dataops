"""Frontmatter helpers for plain-markdown knowledge documents.

Every document is frontmatter (YAML between ``---`` lines) plus a plain
markdown body. Sections are ``##`` headings, steps are numbered lists,
images are ``![](...)``. There is no body parser.
"""

from __future__ import annotations

from typing import Any


def split_frontmatter(text: str) -> tuple[str, str]:
    # An optional leading UTF-8 BOM is not content: normalize it before
    # frontmatter matching so BOM-prefixed writes keep their stable
    # frontmatter identity instead of deriving a different document ID.
    # Without frontmatter the input is returned untouched.
    normalized = text[1:] if text.startswith("\ufeff") else text
    if not normalized.startswith("---\n"):
        return "", text
    end = normalized.find("\n---\n", 4)
    if end == -1:
        return "", text
    return normalized[4:end], normalized[end + 5 :]


def parse_frontmatter(raw: str) -> dict[str, Any]:
    """Minimal YAML subset: scalars, inline lists, and `key:` + `  - item` lists."""
    data: dict[str, Any] = {}
    lines = raw.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        if line.startswith(" "):
            # continuation handled when we collect lists below
            i += 1
            continue
        if ":" not in line:
            i += 1
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value == "":
            # Look ahead for `  - item` list
            items: list[str] = []
            j = i + 1
            while j < len(lines) and (lines[j].startswith("  -") or lines[j].startswith("  - ")):
                items.append(lines[j].lstrip()[1:].strip().strip('"'))
                j += 1
            data[key] = items
            i = j
        elif value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            if not inner:
                data[key] = []
            else:
                data[key] = [v.strip().strip('"') for v in inner.split(",")]
            i += 1
        else:
            data[key] = value.strip('"')
            i += 1
    return data
