import sys

import pytest

from heru_runner import HeruEvent, HeruProgressFormatter, _get_engine


def test_heru_event_continuation_id() -> None:
    event = HeruEvent(
        {
            "kind": "continuation",
            "engine": "codex",
            "continuation_id": "session-123",
        }
    )

    assert event.continuation_id == "session-123"


def test_format_tool_call_write() -> None:
    progress = HeruProgressFormatter.format_tool_call(
        "Write",
        '{"file_path": "/tmp/documents/guest.md"}',
    )

    assert progress == "Writing: `guest.md`"


def test_format_tool_call_bash() -> None:
    progress = HeruProgressFormatter.format_tool_call(
        "Bash",
        {"command": "git status --short"},
    )

    assert progress == "Running: `git status --short`"


def test_format_tool_result_file() -> None:
    progress = HeruProgressFormatter.format_tool_result(
        {"filePath": "/tmp/process/podcast.md", "numLines": 20}
    )

    assert progress == "Read: `podcast.md` (20 lines)"


def test_get_engine_explains_missing_heru(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "heru", None)

    with pytest.raises(RuntimeError, match="Heru is required for live podcast assistant processing"):
        _get_engine("codex")
