#!/usr/bin/env python3
"""Validate a marked-up SOP markdown file against docs/sop-format.md.

Exits 0 if clean, 1 if violations found, 2 on parse error.

Usage:
    python scripts/sop_lint.py <file.md> [<file.md> ...]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_LAMBDA_SRC = Path(__file__).resolve().parent.parent / "lambda-functions" / "src"
if str(_LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(_LAMBDA_SRC))

from lambda_functions.sop_lint import lint_text  # noqa: E402


def lint_file(path: Path) -> list[str]:
    return lint_text(path.read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("paths", nargs="+", type=Path)
    args = ap.parse_args(argv)
    total = 0
    for p in args.paths:
        violations = lint_file(p)
        if violations:
            total += len(violations)
            for v in violations:
                print(f"{p}: {v}")
    if total:
        print(f"\n{total} violation(s) across {len(args.paths)} file(s)", file=sys.stderr)
        return 1
    print(f"OK: {len(args.paths)} file(s) clean")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
