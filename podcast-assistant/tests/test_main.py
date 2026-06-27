from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest
from telegram import Message, Update

from main import create_collapsible_message, get_timestamp, is_allowed_chat, save_text_message, status_command


def test_get_timestamp() -> None:
    assert get_timestamp(datetime(2026, 6, 27, 12, 3, 40)) == "20260627_120340"


@patch("main.TELEGRAM_CHAT_ID", 123456)
def test_is_allowed_chat() -> None:
    update = Mock(spec=Update)
    update.effective_chat.id = 123456

    assert is_allowed_chat(update) is True


def test_create_collapsible_message() -> None:
    text, entities = create_collapsible_message("Saved: note", "content")

    assert text == "Saved: note\n\ncontent"
    assert len(entities) == 1
    assert entities[0].offset == len("Saved: note") + 2
    assert entities[0].length == len("content")


@pytest.mark.asyncio
async def test_save_text_message_creates_markdown(tmp_path: Path) -> None:
    with patch("main.INBOX_RAW", tmp_path):
        filename = await save_text_message(
            "Guest is working on evals.",
            user_id=42,
            username="alexey",
            message_date=datetime(2026, 6, 27, 12, 3, 40),
            message_id=10,
        )

    assert filename.name == "20260627_120340_alexey_msg10.md"
    content = filename.read_text(encoding="utf-8")
    assert "source: telegram" in content
    assert "Guest is working on evals." in content


@pytest.mark.asyncio
async def test_status_command_counts_inbox_and_documents(tmp_path: Path) -> None:
    inbox = tmp_path / "raw"
    docs = tmp_path / "documents"
    inbox.mkdir()
    docs.mkdir()
    (inbox / "one.md").write_text("one", encoding="utf-8")
    (inbox / ".gitkeep").write_text("", encoding="utf-8")
    (docs / "guest.md").write_text("guest", encoding="utf-8")

    update = Mock(spec=Update)
    update.effective_chat.id = 123456
    update.message = Mock(spec=Message)
    update.message.reply_text = AsyncMock()

    with patch("main.INBOX_RAW", inbox), patch("main.DOCUMENTS_DIR", docs), patch("main.is_allowed_chat", return_value=True):
        await status_command(update, None)

    reply_text = update.message.reply_text.call_args.args[0]
    assert "Raw items: 1" in reply_text
    assert "Podcast documents: 1" in reply_text
