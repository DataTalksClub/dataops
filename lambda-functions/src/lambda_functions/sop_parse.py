#!/usr/bin/env python3
"""Parse a marked-up SOP markdown file into a structured dict.

See docs/sop-format.md for the marker convention. Stdlib only.

Usage:
    python scripts/sop_parse.py <path-to-sop.md>
    python scripts/sop_parse.py <path-to-sop.md> --pretty
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


SECTION_OPEN_RE = re.compile(
    r"<!--\s*sop-section-start:\s*(?P<name>[a-z_]+)(?P<flags>(?:\s+\w+(?:=\S+)?)*)\s*-->"
)
SECTION_CLOSE_RE = re.compile(r"<!--\s*sop-section-end\s*-->")
GROUP_OPEN_RE = re.compile(r'<!--\s*sop-group-start:\s*"(?P<title>[^"]*)"\s*-->')
GROUP_CLOSE_RE = re.compile(r"<!--\s*sop-group-end\s*-->")
STEP_OPEN_RE = re.compile(r"<!--\s*sop-step-start(?P<attrs>\s+[^-][^>]*?)\s*-->")
STEP_CLOSE_RE = re.compile(r"<!--\s*sop-step-end\s*-->")
SCREENSHOT_OPEN_RE = re.compile(r"<!--\s*sop-screenshot-start\s*-->")
SCREENSHOT_CLOSE_RE = re.compile(r"<!--\s*sop-screenshot-end\s*-->")
CAPTION_OPEN_RE = re.compile(r"<!--\s*sop-caption-start\s*-->")
CAPTION_CLOSE_RE = re.compile(r"<!--\s*sop-caption-end\s*-->")
PROSE_OPEN_RE = re.compile(r"<!--\s*sop-prose-start\s*-->")
PROSE_CLOSE_RE = re.compile(r"<!--\s*sop-prose-end\s*-->")
TODO_RE = re.compile(r'<!--\s*sop-todo:\s*"(?P<text>[^"]*)"\s*-->')

ATTR_RE = re.compile(r'(\w+)\s*=\s*(?:"([^"]*)"|(\S+))')
IMAGE_RE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<src>[^)]+)\)")
RENDERED_NUM_RE = re.compile(r"^\s*(\d+)\.\s")


REQUIRED_SECTIONS = [
    "summary",
    "prerequisites",
    "procedure",
    "validation",
    "troubleshooting",
    "references",
]


@dataclass
class ParseError(Exception):
    message: str
    line: int

    def __str__(self) -> str:
        return f"line {self.line}: {self.message}"


# ---------- frontmatter ----------

def split_frontmatter(text: str) -> tuple[str, str]:
    if not text.startswith("---\n"):
        return "", text
    end = text.find("\n---\n", 4)
    if end == -1:
        return "", text
    return text[4:end], text[end + 5 :]


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


# ---------- body parser ----------

@dataclass
class _Step:
    id: int
    rendered_number: int | None
    attrs: dict[str, Any]
    body_lines: list[str] = field(default_factory=list)
    screenshots: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class _Group:
    title: str
    steps: list[_Step] = field(default_factory=list)


@dataclass
class _Procedure:
    raw: bool = False
    raw_body: str = ""
    groups: list[_Group] = field(default_factory=list)
    flat_steps: list[_Step] = field(default_factory=list)
    prose: list[dict[str, Any]] = field(default_factory=list)
    todos: list[str] = field(default_factory=list)


def _parse_step_attrs(s: str) -> dict[str, Any]:
    attrs: dict[str, Any] = {}
    for m in ATTR_RE.finditer(s):
        key = m.group(1)
        val = m.group(2) if m.group(2) is not None else m.group(3)
        if key == "id":
            attrs[key] = int(val)
        elif key == "systems":
            attrs[key] = [v.strip() for v in val.split(",") if v.strip()]
        else:
            attrs[key] = val
    return attrs


def _strip_rendered_number(body_lines: list[str]) -> tuple[int | None, list[str]]:
    """If the first non-blank line is `N. text`, return (N, lines with that prefix stripped)."""
    out = list(body_lines)
    for i, line in enumerate(out):
        if not line.strip():
            continue
        m = RENDERED_NUM_RE.match(line)
        if m:
            n = int(m.group(1))
            out[i] = line[m.end():]
            return n, out
        return None, out
    return None, out


def _parse_screenshots(body_lines: list[str]) -> tuple[list[str], list[dict[str, Any]]]:
    """Pull out <!-- sop-screenshot-start --> blocks. Returns (cleaned_body_lines, screenshots)."""
    screenshots: list[dict[str, Any]] = []
    out: list[str] = []
    i = 0
    while i < len(body_lines):
        line = body_lines[i]
        if SCREENSHOT_OPEN_RE.search(line):
            # collect until close
            j = i + 1
            inner: list[str] = []
            while j < len(body_lines) and not SCREENSHOT_CLOSE_RE.search(body_lines[j]):
                inner.append(body_lines[j])
                j += 1
            if j >= len(body_lines):
                raise ParseError("unclosed <!-- sop-screenshot-start -->", i)
            shot = _parse_screenshot_block(inner)
            screenshots.append(shot)
            i = j + 1
        else:
            out.append(line)
            i += 1
    return out, screenshots


def _parse_screenshot_block(lines: list[str]) -> dict[str, Any]:
    src = ""
    alt = ""
    caption = ""
    in_caption = False
    caption_lines: list[str] = []
    for line in lines:
        if CAPTION_OPEN_RE.search(line):
            in_caption = True
            continue
        if CAPTION_CLOSE_RE.search(line):
            in_caption = False
            caption = "\n".join(caption_lines).strip()
            continue
        if in_caption:
            caption_lines.append(line)
            continue
        m = IMAGE_RE.search(line)
        if m and not src:
            alt = m.group("alt")
            src = m.group("src")
    if in_caption:
        caption = "\n".join(caption_lines).strip()
    return {"alt": alt, "src": src, "caption": caption}


def _finalize_step(step: _Step) -> dict[str, Any]:
    body_lines, screenshots = _parse_screenshots(step.body_lines)
    rendered, body_lines = _strip_rendered_number(body_lines)
    if step.rendered_number is None:
        step.rendered_number = rendered
    step.screenshots = screenshots
    body = "\n".join(body_lines).strip("\n")
    return {
        "id": step.id,
        "rendered_number": step.rendered_number,
        "attrs": step.attrs,
        "body_md": body,
        "screenshots": step.screenshots,
    }


def _parse_procedure_body(body: str) -> _Procedure:
    proc = _Procedure()
    lines = body.splitlines()
    i = 0
    n = len(lines)
    current_group: _Group | None = None
    current_step: _Step | None = None
    in_prose = False
    prose_lines: list[str] = []
    last_step_id: int | None = None

    while i < n:
        line = lines[i]

        # TODO marker (self-closing)
        m = TODO_RE.search(line)
        if m and not current_step:
            proc.todos.append(m.group("text"))
            i += 1
            continue

        # group open
        m = GROUP_OPEN_RE.search(line)
        if m:
            if current_group is not None:
                raise ParseError("nested <!-- group --> not allowed", i)
            current_group = _Group(title=m.group("title"))
            i += 1
            continue

        # group close
        if GROUP_CLOSE_RE.search(line):
            if current_group is None:
                raise ParseError("<!-- sop-group-end --> with no open group", i)
            proc.groups.append(current_group)
            current_group = None
            i += 1
            continue

        # step open
        m = STEP_OPEN_RE.search(line)
        if m:
            if current_step is not None:
                raise ParseError("nested <!-- sop-step-start --> not allowed", i)
            attrs = _parse_step_attrs(m.group("attrs"))
            if "id" not in attrs:
                raise ParseError("step missing required `id` attribute", i)
            sid = attrs.pop("id")
            current_step = _Step(id=sid, rendered_number=None, attrs=attrs)
            i += 1
            continue

        # step close
        if STEP_CLOSE_RE.search(line):
            if current_step is None:
                raise ParseError("<!-- sop-step-end --> with no open step", i)
            finalized = _finalize_step(current_step)
            last_step_id = finalized["id"]
            if current_group is not None:
                current_group.steps.append(finalized)  # type: ignore[arg-type]
            else:
                proc.flat_steps.append(finalized)  # type: ignore[arg-type]
            current_step = None
            i += 1
            continue

        # prose open
        if PROSE_OPEN_RE.search(line) and current_step is None:
            in_prose = True
            prose_lines = []
            i += 1
            continue

        # prose close
        if PROSE_CLOSE_RE.search(line) and in_prose:
            in_prose = False
            proc.prose.append(
                {"after_step_id": last_step_id, "body_md": "\n".join(prose_lines).strip("\n")}
            )
            i += 1
            continue

        # body accumulation
        if current_step is not None:
            current_step.body_lines.append(line)
        elif in_prose:
            prose_lines.append(line)
        # else: ignore lines between procedure markers (heading line itself, blank lines)
        i += 1

    if current_step is not None:
        raise ParseError("unclosed <!-- sop-step-start -->", n)
    if current_group is not None:
        raise ParseError("unclosed <!-- group -->", n)
    if in_prose:
        raise ParseError("unclosed <!-- sop-prose-start -->", n)
    return proc


def _extract_sections(body: str) -> dict[str, dict[str, Any]]:
    sections: dict[str, dict[str, Any]] = {}
    lines = body.splitlines()
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        m = SECTION_OPEN_RE.search(line)
        if not m:
            i += 1
            continue
        name = m.group("name")
        flags = m.group("flags") or ""
        is_raw = "raw" in flags.split()
        # collect until matching /section
        j = i + 1
        depth = 1
        inner: list[str] = []
        while j < n:
            if SECTION_OPEN_RE.search(lines[j]):
                depth += 1
            elif SECTION_CLOSE_RE.search(lines[j]):
                depth -= 1
                if depth == 0:
                    break
            inner.append(lines[j])
            j += 1
        if depth != 0:
            raise ParseError(f"unclosed <!-- sop-section-start: {name} -->", i)
        sections[name] = {"raw": is_raw, "body_md": "\n".join(inner).strip("\n")}
        i = j + 1
    return sections


def parse(text: str) -> dict[str, Any]:
    raw_fm, body = split_frontmatter(text)
    frontmatter = parse_frontmatter(raw_fm) if raw_fm else {}
    sections_raw = _extract_sections(body)
    sections: dict[str, Any] = {}
    for name, sec in sections_raw.items():
        if name == "procedure" and not sec["raw"]:
            proc = _parse_procedure_body(sec["body_md"])
            sections["procedure"] = {
                "raw": False,
                "groups": [
                    {"title": g.title, "steps": g.steps} for g in proc.groups
                ],
                "flat_steps": proc.flat_steps,
                "prose": proc.prose,
                "todos": proc.todos,
            }
        else:
            sections[name] = sec
    return {
        "schema_version": frontmatter.get("schema_version"),
        "frontmatter": frontmatter,
        "sections": sections,
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path", type=Path)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args(argv)
    text = args.path.read_text(encoding="utf-8")
    try:
        result = parse(text)
    except ParseError as e:
        print(f"{args.path}: parse error: {e}", file=sys.stderr)
        return 2
    indent = 2 if args.pretty else None
    print(json.dumps(result, indent=indent, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
