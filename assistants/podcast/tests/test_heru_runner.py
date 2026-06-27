from heru_runner import HeruEvent, HeruProgressFormatter


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
