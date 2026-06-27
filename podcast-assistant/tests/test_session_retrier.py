from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from session_retrier import SessionRetrier


def test_get_session_id_exists(tmp_path: Path) -> None:
    session_file = tmp_path / ".tmp" / "heru_session_id.txt"
    session_file.parent.mkdir()
    session_file.write_text("session-123", encoding="utf-8")
    retrier = SessionRetrier(tmp_path, tmp_path / "logs", engine_name="codex")

    assert retrier.get_session_id() == "session-123"


def test_get_commit_hash_returns_none_outside_git(tmp_path: Path) -> None:
    retrier = SessionRetrier(tmp_path, tmp_path / "logs", engine_name="codex")

    assert retrier.get_commit_hash() is None


@pytest.mark.asyncio
async def test_success_no_git_no_raw_files(tmp_path: Path) -> None:
    (tmp_path / "inbox" / "raw").mkdir(parents=True)
    retrier = SessionRetrier(tmp_path, tmp_path / "logs", engine_name="codex")
    bot = Mock()
    progress = Mock()

    with patch("session_retrier.HeruRunner") as mock_runner:
        mock_runner.return_value.run_process_command.return_value = (0, "", "")

        success, commit, error = await retrier.run_with_auto_retry(
            chat_id=1,
            bot=bot,
            on_progress=progress,
        )

    assert success is True
    assert commit is None
    assert error is None
