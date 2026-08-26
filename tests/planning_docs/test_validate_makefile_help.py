from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import validate_planning_docs  # noqa: E402


VALID_MAKEFILE = """\
.PHONY: help clean
help:
\t@printf '%s\\n' 'DataOps development targets:'
\t@printf '%-28s %s\\n' 'make clean' 'Remove root generated search index and backend dist.'
clean:
\trm -f generated.index
"""


def test_current_repo_help_contract_passes():
    assert validate_planning_docs.validate_makefile_help(REPO_ROOT) == []


def test_duplicate_advertised_target_fails_closed(tmp_path):
    duplicated = VALID_MAKEFILE.replace(
        "\t@printf '%-28s %s\\n' 'make clean' "
        "'Remove root generated search index and backend dist.'\n",
        "\t@printf '%-28s %s\\n' 'make clean' "
        "'Remove root generated search index and work-engine dist.'\n"
        "\t@printf '%-28s %s\\n' 'make clean' "
        "'Remove root generated search index and backend dist.'\n",
    )
    (tmp_path / "Makefile").write_text(duplicated, encoding="utf-8")

    violations = validate_planning_docs.validate_makefile_help(tmp_path)

    assert "Makefile help advertises clean 2 times" in violations
    assert any("retired work-engine wording" in violation for violation in violations)
    assert any("root generated search index and backend dist" in violation for violation in violations)


def test_stale_clean_description_fails_closed(tmp_path):
    stale = VALID_MAKEFILE.replace(
        validate_planning_docs.CLEAN_HELP_DESCRIPTION,
        "Remove root generated search index and work-engine dist.",
    )
    (tmp_path / "Makefile").write_text(stale, encoding="utf-8")

    violations = validate_planning_docs.validate_makefile_help(tmp_path)

    assert any("retired work-engine wording" in violation for violation in violations)
    assert any(
        "Makefile clean help must state that it removes the root generated "
        "search index and backend dist" in violation
        for violation in violations
    )


def test_nonexistent_advertised_target_fails_closed(tmp_path):
    missing_target = VALID_MAKEFILE.replace(
        "'make clean'",
        "'make missing-target'",
    )
    (tmp_path / "Makefile").write_text(missing_target, encoding="utf-8")

    violations = validate_planning_docs.validate_makefile_help(tmp_path)

    assert "Makefile help does not advertise clean" in violations
    assert "Makefile help advertises nonexistent target: missing-target" in violations
