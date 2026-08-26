from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import validate_planning_docs  # noqa: E402


WORKFLOW_TEXT = (
    REPO_ROOT / ".github" / "workflows" / "validate-planning-docs.yml"
).read_text(encoding="utf-8")


def _modify_event_path(workflow_text: str, event: str, path: str, *, add: bool) -> str:
    event_marker = f"  {event}:\n"
    start = workflow_text.index(event_marker)
    following_event = re.search(
        r"(?m)^  \w[\w-]*:", workflow_text[start + len(event_marker) :]
    )
    end = (
        len(workflow_text)
        if following_event is None
        else start + len(event_marker) + following_event.start()
    )
    path_line = f'      - "{path}"\n'
    block = workflow_text[start:end]
    if add:
        docs_line = '      - "_docs/**"\n'
        assert docs_line in block
        modified_block = block.replace(docs_line, docs_line + path_line, 1)
    else:
        assert path_line in block
        modified_block = block.replace(path_line, "", 1)
    return workflow_text[:start] + modified_block + workflow_text[end:]


def _remove_event_path(workflow_text: str, event: str, path: str) -> str:
    return _modify_event_path(workflow_text, event, path, add=False)


def test_current_workflow_trigger_paths_are_canonical_and_consistent():
    paths = validate_planning_docs._workflow_trigger_paths(WORKFLOW_TEXT)

    assert paths["push"] == paths["pull_request"]
    assert validate_planning_docs.CANONICAL_PLANNING_DOCS_TEST_PATH in paths["push"]
    assert validate_planning_docs.validate_workflow_trigger_paths(WORKFLOW_TEXT) == []


def test_current_workflow_execution_command_is_canonical():
    assert validate_planning_docs.validate_workflow_execution_command(WORKFLOW_TEXT) == []


@pytest.mark.parametrize(
    ("replacement", "expected_violation"),
    [
        (
            "uv run --with pytest python -m pytest tests/planningdocs",
            "planning docs test command must not use the retired path tests/planningdocs",
        ),
        (
            "uv run --with pytest python -m pytest tests/planning_docs_extra",
            "planning docs test command must be exactly uv run --with pytest python -m pytest tests/planning_docs",
        ),
    ],
)
def test_execution_command_drift_fails_closed(replacement, expected_violation):
    modified = WORKFLOW_TEXT.replace(
        validate_planning_docs.CANONICAL_PLANNING_DOCS_TEST_COMMAND,
        replacement,
        1,
    )

    violations = validate_planning_docs.validate_workflow_execution_command(modified)

    assert expected_violation in violations


@pytest.mark.parametrize("event", ["push", "pull_request"])
def test_missing_canonical_path_fails_closed_for_each_event(event):
    modified = _remove_event_path(
        WORKFLOW_TEXT,
        event,
        validate_planning_docs.CANONICAL_PLANNING_DOCS_TEST_PATH,
    )

    violations = validate_planning_docs.validate_workflow_trigger_paths(modified)

    assert f"{event} trigger path filter must include tests/planning_docs/**" in violations
    assert any("push and pull_request path filters differ" in violation for violation in violations)


@pytest.mark.parametrize("event", ["push", "pull_request"])
def test_stale_test_path_fails_closed_for_each_event(event):
    canonical = validate_planning_docs.CANONICAL_PLANNING_DOCS_TEST_PATH
    stale = validate_planning_docs.STALE_PLANNING_DOCS_TEST_PATH
    modified = _modify_event_path(WORKFLOW_TEXT, event, stale, add=True)

    violations = validate_planning_docs.validate_workflow_trigger_paths(modified)

    assert canonical in validate_planning_docs._workflow_trigger_paths(modified)[event]
    assert f"{event} trigger path filter must not contain the retired path {stale}" in violations
    assert any("push and pull_request path filters differ" in violation for violation in violations)


def test_missing_docs_path_in_one_event_fails_consistency_check():
    modified = _remove_event_path(
        WORKFLOW_TEXT,
        "pull_request",
        "_docs/**",
    )

    violations = validate_planning_docs.validate_workflow_trigger_paths(modified)

    assert violations == [
        "push and pull_request path filters differ (branches excluded): "
        "push-only=['_docs/**']; pull_request-only=[]"
    ]
