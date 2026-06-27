#!/usr/bin/env python3
"""Convert a legacy SOP markdown file into the marked-up format.

Heuristics (see docs/sop-format.md):
  - Wrap each top-level section (## Summary, ## Procedure, ...) with
    <!-- sop-section-start: name --> / <!-- sop-section-end --> markers.
  - Inside Procedure: wrap ### subheadings with <!-- sop-group-start -->
    markers and numbered items (1. 2. ...) with <!-- sop-step-start -->.
  - For each image inside a step, group it with the following
    'Image note:' paragraph into a <!-- sop-screenshot-start --> block.
  - Free text between steps becomes <!-- sop-prose-start -->.
  - Adds `schema_version: 1` to the frontmatter.

Usage:
    python scripts/sop_normalize.py <input.md> -o <output.md>
    python scripts/sop_normalize.py <input.md>          # writes to stdout
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


KNOWN_SECTIONS = [
    ("summary", "## Summary"),
    ("prerequisites", "## Prerequisites"),
    ("procedure", "## Procedure"),
    ("validation", "## Validation"),
    ("troubleshooting", "## Troubleshooting"),
    ("references", "## References"),
]

NUMBERED_ITEM_RE = re.compile(r"^(\d+)\.(\s+)(.*)$")
IMAGE_LINE_RE = re.compile(r"^!\[[^\]]*\]\([^)]+\)\s*$")
IMAGE_NOTE_RE = re.compile(r"^\s*Image note:\s*(.*)$", re.IGNORECASE)
SUBHEADING_RE = re.compile(r"^###\s+(.+?)\s*$")


def split_frontmatter(text: str) -> tuple[str, str]:
    if not text.startswith("---\n"):
        return "", text
    end = text.find("\n---\n", 4)
    if end == -1:
        return "", text
    return text[4:end], text[end + 5 :]


def add_schema_version(frontmatter: str) -> str:
    if "schema_version" in frontmatter:
        return frontmatter
    # Insert after `doc_type:` line if present, else at end
    lines = frontmatter.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("doc_type:"):
            lines.insert(i + 1, "schema_version: 1")
            return "\n".join(lines)
    lines.append("schema_version: 1")
    return "\n".join(lines)


def find_section_spans(body: str) -> list[tuple[str, int, int]]:
    """Find (name, start_line, end_line_exclusive) for each known section."""
    lines = body.splitlines()
    starts: list[tuple[str, int]] = []
    for i, line in enumerate(lines):
        for name, heading in KNOWN_SECTIONS:
            if line.strip() == heading:
                starts.append((name, i))
                break
    spans: list[tuple[str, int, int]] = []
    for idx, (name, start) in enumerate(starts):
        end = starts[idx + 1][1] if idx + 1 < len(starts) else len(lines)
        spans.append((name, start, end))
    return spans


# ---------- procedure body processor ----------

def _split_paragraphs(lines: list[str]) -> list[tuple[int, list[str]]]:
    """Group consecutive non-blank lines into paragraphs.
    Returns list of (start_index, lines)."""
    paras: list[tuple[int, list[str]]] = []
    buf: list[str] = []
    buf_start = -1
    for i, line in enumerate(lines):
        if line.strip() == "":
            if buf:
                paras.append((buf_start, buf))
                buf = []
                buf_start = -1
        else:
            if not buf:
                buf_start = i
            buf.append(line)
    if buf:
        paras.append((buf_start, buf))
    return paras


def _is_subheading(para: list[str]) -> str | None:
    if len(para) == 1:
        m = SUBHEADING_RE.match(para[0].strip())
        if m:
            return m.group(1).strip()
    return None


def _is_numbered_start(para: list[str]) -> tuple[int, str] | None:
    """If paragraph starts with `N.  text`, return (N, indent_after_dot)."""
    if not para:
        return None
    m = NUMBERED_ITEM_RE.match(para[0])
    if m:
        return int(m.group(1)), m.group(2)
    return None


def _is_image_para(para: list[str]) -> bool:
    return len(para) == 1 and bool(IMAGE_LINE_RE.match(para[0].strip()))


def _is_image_note_para(para: list[str]) -> bool:
    return bool(para) and bool(IMAGE_NOTE_RE.match(para[0]))


def _strip_image_note_prefix(para: list[str]) -> list[str]:
    if not para:
        return para
    m = IMAGE_NOTE_RE.match(para[0])
    if m:
        out = [m.group(1)]
        out.extend(para[1:])
        return out
    return para


def _reindent_body_line(line: str, indent: str) -> str:
    """Promote any non-blank line below `indent` width up to `indent`.

    Legacy docs commonly contain step-body paragraphs at column 0, which
    break GitHub's list-item rendering. Force at least `indent` for any
    content line; preserve deeper indentation as-is.
    """
    if line.strip() == "":
        return line
    leading = len(line) - len(line.lstrip())
    if leading >= len(indent):
        return line
    return f"{indent}{line.lstrip()}"


def _wrap_step_body(body_lines: list[str], indent: str) -> list[str]:
    """Inside a step body, wrap image+caption pairs in screenshot markers.

    Always uses `indent` (the step's content indent, typically 4 spaces) for
    every marker and the image line itself, regardless of legacy indentation.
    Also promotes any column-0 prose inside the step to `indent` so the
    rendered list-item stays unbroken on GitHub.
    """
    out: list[str] = []
    i = 0
    n = len(body_lines)
    while i < n:
        line = body_lines[i]
        stripped = line.lstrip()
        if IMAGE_LINE_RE.match(stripped):
            out.append(f"{indent}<!-- sop-screenshot-start -->")
            out.append(f"{indent}{stripped.rstrip()}")
            # Look ahead, skipping blank lines, for an "Image note:" line.
            j = i + 1
            while j < n and body_lines[j].strip() == "":
                j += 1
            if j < n and IMAGE_NOTE_RE.match(body_lines[j]):
                caption_first = re.sub(r"^\s*Image note:\s*", "", body_lines[j])
                caption_lines = [caption_first.rstrip()]
                k = j + 1
                while (
                    k < n
                    and body_lines[k].strip() != ""
                    and not IMAGE_LINE_RE.match(body_lines[k].lstrip())
                ):
                    caption_lines.append(body_lines[k].lstrip().rstrip())
                    k += 1
                out.append(f"{indent}<!-- sop-caption-start -->")
                for cl in caption_lines:
                    out.append(f"{indent}{cl}")
                out.append(f"{indent}<!-- sop-caption-end -->")
                i = k
            else:
                i = j
            out.append(f"{indent}<!-- sop-screenshot-end -->")
            continue
        out.append(_reindent_body_line(line, indent))
        i += 1
    return out


def _normalize_procedure(body: str) -> str:
    """Line-based: numbered items and ### headings are boundaries.

    Everything between two boundaries belongs to the prior boundary's owner.
    """
    lines = body.splitlines()
    out: list[str] = []
    in_group = False
    in_prose = False
    in_step = False
    step_id: int | None = None
    step_indent = ""
    buf: list[str] = []
    id_counter = 0

    def flush_buf_into_step():
        nonlocal buf
        if not buf:
            return
        # Trim trailing blanks
        while buf and buf[-1].strip() == "":
            buf.pop()
        out.extend(_wrap_step_body(buf, step_indent))
        buf = []

    def flush_buf_into_prose():
        nonlocal buf, in_prose
        # Trim leading & trailing blanks
        while buf and buf[0].strip() == "":
            buf.pop(0)
        while buf and buf[-1].strip() == "":
            buf.pop()
        if not buf:
            return
        out.append("")
        out.append("<!-- sop-prose-start -->")
        out.extend(buf)
        out.append("<!-- sop-prose-end -->")
        buf = []

    def close_step():
        nonlocal in_step, step_id
        if not in_step:
            return
        flush_buf_into_step()
        out.append("<!-- sop-step-end -->")
        in_step = False
        step_id = None

    def close_prose():
        nonlocal in_prose
        if not in_prose:
            return
        flush_buf_into_prose()
        in_prose = False

    def close_group():
        nonlocal in_group
        if not in_group:
            return
        out.append("")
        out.append("<!-- sop-group-end -->")
        in_group = False

    for raw_line in lines:
        sub_match = SUBHEADING_RE.match(raw_line.strip())
        num_match = NUMBERED_ITEM_RE.match(raw_line)

        if sub_match:
            close_step()
            close_prose()
            close_group()
            out.append("")
            out.append(f'<!-- sop-group-start: "{sub_match.group(1).strip()}" -->')
            out.append(f"### {sub_match.group(1).strip()}")
            in_group = True
            continue

        if num_match:
            close_step()
            close_prose()
            id_counter += 1
            step_id = id_counter
            # Rewrite the rendered number to match the running id so the
            # rendered list stays sequential 1..N even if the legacy doc
            # had duplicates across sub-procedures.
            rest_of_line = num_match.group(3)
            spacer = num_match.group(2)
            new_prefix = f"{step_id}.{spacer}"
            step_indent = " " * len(new_prefix)
            in_step = True
            out.append("")
            out.append(f"<!-- sop-step-start id={step_id} -->")
            out.append(f"{new_prefix}{rest_of_line}")
            buf = []
            continue

        if in_step:
            buf.append(raw_line)
            continue

        # Outside any step/group: prose
        if not in_prose:
            in_prose = True
            buf = []
        buf.append(raw_line)

    close_step()
    close_prose()
    close_group()

    while out and out[0] == "":
        out.pop(0)
    return "\n".join(out)


# ---------- main normalize ----------

def normalize(text: str) -> str:
    raw_fm, body = split_frontmatter(text)
    new_fm = add_schema_version(raw_fm) if raw_fm else "schema_version: 1\ndoc_type: sop"

    lines = body.splitlines()
    spans = find_section_spans(body)
    if not spans:
        # No recognizable sections — return as-is with updated frontmatter
        return f"---\n{new_fm}\n---\n{body}"

    # Build output: keep pre-section preamble, then wrap each section
    pre = "\n".join(lines[: spans[0][1]]).rstrip("\n")
    parts: list[str] = [pre] if pre else []

    for name, start, end in spans:
        heading_line = lines[start]
        inner_lines = lines[start + 1 : end]
        # Strip trailing blanks from inner
        while inner_lines and inner_lines[-1].strip() == "":
            inner_lines.pop()
        inner_body = "\n".join(inner_lines)

        if name == "procedure" and inner_body.strip():
            normalized_inner = _normalize_procedure(inner_body)
            section_body = f"{heading_line}\n\n{normalized_inner}"
        else:
            section_body = heading_line
            if inner_body.strip():
                section_body += f"\n\n{inner_body}"

        parts.append("")
        parts.append(f"<!-- sop-section-start: {name} -->")
        parts.append(section_body)
        parts.append("<!-- sop-section-end -->")

    body_out = "\n".join(parts).strip("\n") + "\n"
    return f"---\n{new_fm}\n---\n\n{body_out}"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args(argv)
    text = args.input.read_text(encoding="utf-8")
    result = normalize(text)
    if args.output:
        args.output.write_text(result, encoding="utf-8")
        print(f"wrote {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(result)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
