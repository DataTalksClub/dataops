#!/usr/bin/env python3
"""Strip trailing all-empty columns from markdown tables.

XLSX-imported docs often have tables with 26 phantom columns. This
script walks each .md file, parses tables, and rewrites them keeping
only the columns that have any non-empty content (header included).

Usage:
    python3 scripts/strip_empty_table_columns.py <file>...
    python3 scripts/strip_empty_table_columns.py --apply <file>...

Default is dry-run (print diff summary). With --apply the files are
rewritten in place.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def split_table_row(line: str) -> list[str] | None:
    """Return list of cells if the line is a markdown table row, else None."""
    stripped = line.rstrip("\n")
    if not stripped.lstrip().startswith("|"):
        return None
    # Drop the leading and trailing pipe characters before splitting so
    # an empty leading/trailing column isn't synthesized.
    trimmed = stripped.strip()
    if not trimmed.startswith("|") or not trimmed.endswith("|"):
        return None
    inner = trimmed[1:-1]
    return [c.strip() for c in inner.split("|")]


def is_separator_row(cells: list[str]) -> bool:
    if not cells:
        return False
    return all(set(cell.replace(":", "").replace("-", "")) <= {""} and "-" in cell for cell in cells)


def clean_text(value: str) -> str:
    return value.strip()


def process_file(text: str) -> tuple[str, int]:
    """Return (new_text, columns_removed_total)."""
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    i = 0
    n = len(lines)
    cols_removed = 0
    while i < n:
        header_cells = split_table_row(lines[i])
        if header_cells is None:
            out.append(lines[i])
            i += 1
            continue
        # Look ahead for a separator row to confirm this is a table.
        if i + 1 >= n:
            out.append(lines[i])
            i += 1
            continue
        sep_cells = split_table_row(lines[i + 1])
        if sep_cells is None or not is_separator_row(sep_cells):
            out.append(lines[i])
            i += 1
            continue

        # Collect table rows.
        table_rows: list[list[str]] = [header_cells, sep_cells]
        j = i + 2
        while j < n:
            row = split_table_row(lines[j])
            if row is None:
                break
            table_rows.append(row)
            j += 1

        col_count = max(len(r) for r in table_rows)
        # Normalize all rows to col_count cells.
        norm: list[list[str]] = []
        for row in table_rows:
            row = row + [""] * (col_count - len(row))
            norm.append(row)

        # Find non-empty columns (any content across header/body, ignoring the
        # separator row which is dashes).
        non_separator_rows = [norm[0]] + norm[2:]
        keep_mask = [False] * col_count
        for r in non_separator_rows:
            for k, cell in enumerate(r):
                if clean_text(cell):
                    keep_mask[k] = True

        # Trim trailing empty columns (keep contiguous all-empty trailing
        # columns out). Internal empty columns are kept to preserve the
        # author's layout intent.
        last_kept = -1
        for k, keep in enumerate(keep_mask):
            if keep:
                last_kept = k
        if last_kept < 0:
            # Table is fully empty; drop it entirely.
            cols_removed += col_count
            i = j
            continue

        new_col_count = last_kept + 1
        if new_col_count >= col_count:
            # Nothing to strip — preserve the original formatting verbatim.
            out.extend(lines[i:j])
            i = j
            continue

        cols_removed += col_count - new_col_count
        for k, row in enumerate(norm):
            norm[k] = row[:new_col_count]
            if k == 1:
                norm[k] = ["---"] * new_col_count

        for row in norm:
            out.append("| " + " | ".join(row) + " |\n")
        i = j
    return ("".join(out), cols_removed)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)

    total_cols = 0
    files_changed = 0
    for path in args.paths:
        text = path.read_text(encoding="utf-8")
        new_text, removed = process_file(text)
        if new_text == text:
            continue
        files_changed += 1
        total_cols += removed
        print(f"{path}: stripped {removed} phantom column-cells")
        if args.apply:
            path.write_text(new_text, encoding="utf-8")
    print(f"--- changed {files_changed} file(s), removed {total_cols} phantom column-cells total")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
