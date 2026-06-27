"""Project-local pytest entrypoint for the imported assistant module."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest


def main() -> int:
    project_root = Path(__file__).resolve().parent
    original_args = sys.argv[1:]
    args = original_args[:]

    if not any(arg == "-c" or arg.startswith("--rootdir") for arg in args):
        args = ["-c", str(project_root / "pyproject.toml"), *args]

    if not original_args:
        args.append(str(project_root / "tests"))

    return pytest.main(args)
