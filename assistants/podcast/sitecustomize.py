"""Keep no-argument assistant pytest runs scoped to the assistant suite."""

from __future__ import annotations

import sys
from pathlib import Path


def _is_pytest_entrypoint() -> bool:
    return Path(sys.argv[0]).name in {"pytest", "py.test"}


if _is_pytest_entrypoint() and len(sys.argv) == 1:
    project_root = Path(__file__).resolve().parent
    sys.argv.extend(["-c", str(project_root / "pyproject.toml"), str(project_root / "tests")])
