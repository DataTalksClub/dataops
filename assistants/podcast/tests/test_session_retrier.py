from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

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


@pytest.mark.asyncio
async def test_failed_run_resumes_saved_session_and_succeeds(tmp_path: Path) -> None:
    session_file = tmp_path / ".tmp" / "heru_session_id.txt"
    session_file.parent.mkdir()
    session_file.write_text("session-123", encoding="utf-8")
    retrier = SessionRetrier(tmp_path, tmp_path / "logs", engine_name="codex", model="gpt-test")
    bot = Mock()
    bot.send_message = AsyncMock()
    progress = Mock()

    first_runner = Mock()
    first_runner.run_process_command.return_value = (1, "", "failed")
    resumed_runner = Mock()
    resumed_runner.run_process_command.return_value = (0, "", "")

    with patch("session_retrier.HeruRunner", side_effect=[first_runner, resumed_runner]) as mock_runner:
        success, commit, error = await retrier.run_with_auto_retry(
            chat_id=7,
            bot=bot,
            on_progress=progress,
        )

    assert success is True
    assert commit is None
    assert error is None
    assert mock_runner.call_count == 2
    resumed_kwargs = mock_runner.call_args_list[1].kwargs
    assert resumed_kwargs["session_id"] == "session-123"
    assert resumed_kwargs["continuation_prompt"] == "Please continue with the podcast document processing task."
    assert resumed_kwargs["model"] == "gpt-test"
    bot.send_message.assert_awaited_once_with(
        chat_id=7,
        text="Session failed. Resuming with codex... (1/3)",
        parse_mode=None,
    )


@pytest.mark.asyncio
async def test_failed_run_without_saved_session_returns_error(tmp_path: Path) -> None:
    retrier = SessionRetrier(tmp_path, tmp_path / "logs", engine_name="codex")
    bot = Mock()
    bot.send_message = AsyncMock()
    progress = Mock()
    first_runner = Mock()
    first_runner.run_process_command.return_value = (2, "", "failed")

    with patch("session_retrier.HeruRunner", return_value=first_runner) as mock_runner:
        success, commit, error = await retrier.run_with_auto_retry(
            chat_id=7,
            bot=bot,
            on_progress=progress,
        )

    assert success is False
    assert commit is None
    assert error == "Session failed with exit code 2 and no Heru session ID was saved"
    assert mock_runner.call_count == 1
    bot.send_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_failed_resumes_stop_after_max_retries(tmp_path: Path) -> None:
    session_file = tmp_path / ".tmp" / "heru_session_id.txt"
    session_file.parent.mkdir()
    session_file.write_text("session-123", encoding="utf-8")
    retrier = SessionRetrier(tmp_path, tmp_path / "logs", engine_name="codex")
    bot = Mock()
    bot.send_message = AsyncMock()
    progress = Mock()
    runners = []
    for returncode in (1, 2, 3):
        runner = Mock()
        runner.run_process_command.return_value = (returncode, "", "failed")
        runners.append(runner)

    with (
        patch.object(SessionRetrier, "MAX_RETRIES", 2),
        patch("session_retrier.HeruRunner", side_effect=runners) as mock_runner,
    ):
        success, commit, error = await retrier.run_with_auto_retry(
            chat_id=7,
            bot=bot,
            on_progress=progress,
        )

    assert success is False
    assert commit is None
    assert error == "Session failed 3 times; last exit code: 3"
    assert mock_runner.call_count == 3
    assert bot.send_message.await_count == 2
    for call in mock_runner.call_args_list[1:]:
        assert call.kwargs["session_id"] == "session-123"
        assert call.kwargs["continuation_prompt"] == "Please continue with the podcast document processing task."
