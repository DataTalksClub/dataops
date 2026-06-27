"""Telegram bot for collecting podcast prep material and running Heru processing."""

from __future__ import annotations

import asyncio
import base64
import os
import textwrap
import time
import traceback
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv
from groq import Groq
from telegram import MessageEntity, Update
from telegram.constants import MessageEntityType
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from heru_runner import DEFAULT_ENGINE
from progress_tracker import ProgressTracker
from session_retrier import SessionRetrier

load_dotenv()

TELEGRAM_BOT_API_KEY = os.getenv("TELEGRAM_BOT_API_KEY")
TELEGRAM_CHAT_ID = int(os.getenv("TELEGRAM_CHAT_ID", "0") or 0)
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
HERU_ENGINE = os.getenv("HERU_ENGINE", DEFAULT_ENGINE)
HERU_MODEL = os.getenv("HERU_MODEL")

REPO_PATH = Path.cwd()
INBOX_RAW = REPO_PATH / "inbox" / "raw"
INBOX_USED = REPO_PATH / "inbox" / "used"
DOCUMENTS_DIR = REPO_PATH / "documents"
LOGS_DIR = REPO_PATH / "heru_runs"

groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


def ensure_directories() -> None:
    for path in (INBOX_RAW, INBOX_USED, DOCUMENTS_DIR, LOGS_DIR, REPO_PATH / ".tmp"):
        path.mkdir(parents=True, exist_ok=True)


async def safe_reply(message, text: str, entities=None, parse_mode=None, max_retries: int = 3):
    if message is None:
        print("[safe_reply] Cannot reply: message is None")
        return None
    for attempt in range(max_retries):
        try:
            return await message.reply_text(text, entities=entities, parse_mode=parse_mode)
        except Exception as exc:
            error_text = str(exc)
            if "Forbidden" in error_text or "BadRequest" in error_text:
                print(f"[safe_reply] Non-retryable error: {type(exc).__name__}: {exc}")
                try:
                    return await message.reply_text(f"Error: {type(exc).__name__}", parse_mode=None)
                except Exception:
                    return None
            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)
            else:
                print(f"[safe_reply] All retries failed: {type(exc).__name__}: {exc}")
    return None


def create_collapsible_message(prefix: str, content: str, max_length: int = 1000) -> tuple[str, list[MessageEntity]]:
    if len(content) > max_length:
        content = content[:max_length] + "... (truncated)"
    full_text = f"{prefix}\n\n{content}"
    offset = len(prefix) + 2
    entities = [
        MessageEntity(
            type=MessageEntityType.EXPANDABLE_BLOCKQUOTE,
            offset=offset,
            length=len(content),
        )
    ]
    return full_text, entities


def describe_image(image_path: Path) -> str:
    if groq_client is None:
        raise RuntimeError("GROQ_API_KEY is required to describe images")

    image_data = base64.b64encode(image_path.read_bytes()).decode("utf-8")
    prompt = textwrap.dedent(
        """\
        Analyze this image as source material for a podcast guest preparation document.

        Include:
        1. Type: screenshot, photo, profile, document, diagram, etc.
        2. Main content: what is shown
        3. Visible text: place readable text in code blocks
        4. Podcast relevance: guest facts, topic ideas, claims to verify, or possible questions
        """
    )

    response = groq_client.chat.completions.create(
        model="meta-llama/llama-4-scout-17b-16e-instruct",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_data}"}},
                ],
            }
        ],
    )
    content = response.choices[0].message.content
    lines = [line.rstrip() for line in content.strip().split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def get_timestamp(message_date: datetime) -> str:
    return message_date.strftime("%Y%m%d_%H%M%S")


def get_filename(message_date: datetime, message_id: int, username: str | None = None) -> str:
    timestamp = message_date.strftime("%Y%m%d_%H%M%S")
    user_tag = username or "unknown"
    return f"{timestamp}_{user_tag}_msg{message_id}"


def is_allowed_chat(update: Update) -> bool:
    return bool(update.effective_chat and update.effective_chat.id == TELEGRAM_CHAT_ID)


def telegram_message_link(chat_id: int, message_id: int) -> str:
    chat_id_str = str(chat_id).removeprefix("-100").lstrip("-")
    return f"https://t.me/c/{chat_id_str}/{message_id}"


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed_chat(update):
        return
    await safe_reply(
        update.message,
        "Podcast assistant ready.\n\n"
        "Send guest notes, links, voice notes, screenshots, or files.\n"
        "Use /process to create podcast documents from the inbox.\n"
        "Use /process codex or /process claude to choose a Heru engine.",
        parse_mode=None,
    )


async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed_chat(update):
        return
    raw_files = [f for f in INBOX_RAW.glob("*") if not f.name.startswith(".")]
    documents = [f for f in DOCUMENTS_DIR.glob("*") if not f.name.startswith(".")]
    await safe_reply(
        update.message,
        f"Inbox status:\nRaw items: {len(raw_files)}\nPodcast documents: {len(documents)}",
        parse_mode=None,
    )


async def save_text_message(
    content: str,
    user_id: int,
    username: str | None = None,
    message_date: datetime | None = None,
    message_id: int | None = None,
) -> Path:
    msg_date = message_date or datetime.now()
    base_name = get_filename(msg_date, message_id, username) if message_id else f"{get_timestamp(msg_date)}_{username or user_id}"
    filename = INBOX_RAW / f"{base_name}.md"
    metadata = "\n".join(
        [
            "---",
            "source: telegram",
            f"date: {msg_date.isoformat()}",
            f"user_id: {user_id}",
            f"username: {username or 'unknown'}",
            "---",
            "",
            "",
        ]
    )
    filename.write_text(metadata + content, encoding="utf-8")
    return filename


async def save_voice_message(
    file_path: str,
    user_id: int,
    username: str | None = None,
    message_date: datetime | None = None,
    message_id: int | None = None,
) -> tuple[Path, Path, str]:
    if groq_client is None:
        raise RuntimeError("GROQ_API_KEY is required to transcribe audio")

    msg_date = message_date or datetime.now()
    base_name = get_filename(msg_date, message_id, username) if message_id else f"{get_timestamp(msg_date)}_{username or user_id}"
    audio_filename = INBOX_RAW / f"{base_name}.ogg"
    transcript_filename = INBOX_RAW / f"{base_name}_transcript.txt"

    async with httpx.AsyncClient() as client:
        response = await client.get(file_path)
        audio_filename.write_bytes(response.content)

    with audio_filename.open("rb") as audio_file:
        transcription = groq_client.audio.transcriptions.create(
            file=audio_file,
            model="whisper-large-v3",
            response_format="text",
        )
        transcript_text = transcription.strip()

    metadata = "\n".join(
        [
            "---",
            "source: telegram_voice",
            f"date: {msg_date.isoformat()}",
            f"user_id: {user_id}",
            f"username: {username or 'unknown'}",
            f"audio_file: {audio_filename.name}",
            "---",
            "",
            "",
        ]
    )
    transcript_filename.write_text(metadata + textwrap.fill(transcript_text, width=100), encoding="utf-8")
    audio_filename.unlink()
    return audio_filename, transcript_filename, transcript_text


async def save_photo(
    file_path: str,
    user_id: int,
    username: str | None = None,
    caption: str | None = None,
    message_date: datetime | None = None,
    message_id: int | None = None,
) -> tuple[Path, str]:
    msg_date = message_date or datetime.now()
    base_name = get_filename(msg_date, message_id, username) if message_id else f"{get_timestamp(msg_date)}_{username or user_id}"
    filename = INBOX_RAW / f"{base_name}.jpg"

    async with httpx.AsyncClient() as client:
        response = await client.get(file_path)
        filename.write_bytes(response.content)

    description = describe_image(filename)
    md_filename = INBOX_RAW / f"{base_name}_photo.md"
    content_lines = [
        "---",
        "source: telegram_photo",
        f"date: {msg_date.isoformat()}",
        f"user_id: {user_id}",
        f"username: {username or 'unknown'}",
        f"image_file: {filename.name}",
        "---",
        "",
        description,
    ]
    if caption:
        content_lines.extend(["", f"Caption: {caption}"])
    md_filename.write_text("\n".join(content_lines), encoding="utf-8")
    return filename, description


async def handle_text_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed_chat(update) or update.message is None:
        return
    try:
        user = update.effective_user
        filename = await save_text_message(
            update.message.text,
            user.id,
            user.username,
            update.message.date,
            update.message.message_id,
        )
        await safe_reply(update.message, f"Saved as {filename.name}", parse_mode=None)
    except Exception as exc:
        await safe_reply(update.message, f"Error: {type(exc).__name__}: {exc}", parse_mode=None)


async def handle_voice_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed_chat(update) or update.message is None:
        return
    try:
        user = update.effective_user
        voice = update.message.voice
        file = await voice.get_file()
        audio_file, transcript_file, transcript_text = await save_voice_message(
            file.file_path,
            user.id,
            user.username,
            update.message.date,
            update.message.message_id,
        )
        text, entities = create_collapsible_message(f"Saved: {audio_file.name}", transcript_text, max_length=2000)
        await safe_reply(update.message, text, entities=entities)
    except Exception as exc:
        await safe_reply(update.message, f"Error: {type(exc).__name__}: {exc}", parse_mode=None)


async def handle_audio_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed_chat(update) or update.message is None:
        return
    try:
        user = update.effective_user
        audio = update.message.audio
        file = await audio.get_file()
        audio_file, transcript_file, transcript_text = await save_voice_message(
            file.file_path,
            user.id,
            user.username,
            update.message.date,
            update.message.message_id,
        )
        text, entities = create_collapsible_message(f"Saved: {audio.file_name or audio_file.name}", transcript_text, max_length=2000)
        await safe_reply(update.message, text, entities=entities)
    except Exception as exc:
        await safe_reply(update.message, f"Error: {type(exc).__name__}: {exc}", parse_mode=None)


async def handle_photo_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed_chat(update) or update.message is None:
        return
    try:
        user = update.effective_user
        photo = update.message.photo[-1]
        file = await photo.get_file()
        filename, description = await save_photo(
            file.file_path,
            user.id,
            user.username,
            update.message.caption,
            update.message.date,
            update.message.message_id,
        )
        text, entities = create_collapsible_message(f"Saved: {filename.name}", description, max_length=500)
        await safe_reply(update.message, text, entities=entities)
    except Exception as exc:
        await safe_reply(update.message, f"Error: {type(exc).__name__}: {exc}", parse_mode=None)


async def handle_video_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed_chat(update) or update.message is None:
        return
    try:
        user = update.effective_user
        video = update.message.video or update.message.animation
        caption = update.message.caption
        msg_date = update.message.date
        msg_id = update.message.message_id
        base_name = get_filename(msg_date, msg_id, user.username)
        md_filename = INBOX_RAW / f"{base_name}_video.md"
        content_parts = [
            "---",
            "source: telegram_video",
            f"date: {msg_date.isoformat()}",
            f"user_id: {user.id}",
            f"username: {user.username or 'unknown'}",
            f"message_id: {msg_id}",
            f"chat_id: {update.effective_chat.id}",
            "---",
            "",
            f"[View video on Telegram]({telegram_message_link(update.effective_chat.id, msg_id)})",
            "",
        ]
        if video and getattr(video, "duration", None):
            content_parts.append(f"Duration seconds: {video.duration}")
        if caption:
            content_parts.extend(["", f"Caption: {caption}"])
        md_filename.write_text("\n".join(content_parts), encoding="utf-8")
        await safe_reply(update.message, f"Saved video metadata: {md_filename.name}", parse_mode=None)
    except Exception as exc:
        await safe_reply(update.message, f"Error: {type(exc).__name__}: {exc}", parse_mode=None)


async def handle_document_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed_chat(update) or update.message is None:
        return
    try:
        user = update.effective_user
        document = update.message.document
        file_name = document.file_name or "file"
        extension = Path(file_name).suffix or ".txt"

        if extension.lower() in {".mp4", ".mov", ".avi", ".mkv", ".webm"}:
            await handle_video_message(update, context)
            return

        file = await document.get_file()
        base_name = get_filename(update.message.date, update.message.message_id, user.username)
        saved_filename = INBOX_RAW / f"{base_name}{extension}"

        async with httpx.AsyncClient() as client:
            response = await client.get(file.file_path)
            saved_filename.write_bytes(response.content)

        if extension.lower() in {".m4a", ".mp3", ".wav", ".ogg", ".flac", ".webm"}:
            audio_file, transcript_file, transcript_text = await save_voice_message(
                file.file_path,
                user.id,
                user.username,
                update.message.date,
                update.message.message_id,
            )
            if saved_filename.exists():
                saved_filename.unlink()
            text, entities = create_collapsible_message(f"Saved: {file_name}", transcript_text, max_length=2000)
            await safe_reply(update.message, text, entities=entities)
            return

        text_content = None
        if extension.lower() in {".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".csv", ".log", ".sh"}:
            try:
                text_content = saved_filename.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                text_content = None

        md_filename = INBOX_RAW / f"{base_name}.md"
        frontmatter = [
            "---",
            "source: telegram_file",
            f"date: {update.message.date.isoformat()}",
            f"user_id: {user.id}",
            f"username: {user.username or 'unknown'}",
            f"original_filename: {file_name}",
            f"saved_file: {saved_filename.name}",
            "---",
            "",
        ]
        content_parts = []
        if update.message.caption:
            content_parts.extend([update.message.caption, ""])
        if text_content is not None:
            content_parts.append(text_content)
        md_filename.write_text("\n".join(frontmatter + content_parts), encoding="utf-8")

        reply = f"Saved: {file_name}"
        if text_content:
            text, entities = create_collapsible_message(reply, text_content[:500], max_length=500)
            await safe_reply(update.message, text, entities=entities)
        else:
            await safe_reply(update.message, reply, parse_mode=None)
    except Exception as exc:
        await safe_reply(update.message, f"Error: {type(exc).__name__}: {exc}", parse_mode=None)


def resolve_process_engine(context: ContextTypes.DEFAULT_TYPE) -> str:
    if context.args:
        return context.args[0].strip()
    return HERU_ENGINE


async def process_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed_chat(update):
        return

    bot = context.bot
    chat_id = update.effective_chat.id
    engine_name = resolve_process_engine(context)

    await safe_reply(update.message, f"Processing inbox with Heru engine: {engine_name}", parse_mode=None)
    start_time = time.time()

    progress = ProgressTracker(bot, chat_id)
    await progress.start()

    session_retrier = SessionRetrier(REPO_PATH, LOGS_DIR, engine_name=engine_name, model=HERU_MODEL)

    try:
        success, commit_hash, error_msg = await session_retrier.run_with_auto_retry(
            chat_id=chat_id,
            bot=bot,
            on_progress=progress.add_message,
        )
        await progress.finish()

        if not success:
            await bot.send_message(chat_id=chat_id, text=error_msg, parse_mode=None)
            return

        duration = time.time() - start_time
        duration_str = f"{int(duration // 60)}m {int(duration % 60)}s"
        message = f"Processing complete. Duration: {duration_str}\n"
        if commit_hash:
            message += f"Local commit detected: {commit_hash[:8]}. No push was performed."
        else:
            message += "No commit detected."
        await bot.send_message(chat_id=chat_id, text=message, parse_mode=None)
    except Exception as exc:
        await progress.finish()
        await bot.send_message(chat_id=chat_id, text=f"Error during processing: {type(exc).__name__}: {exc}", parse_mode=None)
        traceback.print_exc()


async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    error = context.error
    if update and update.effective_message:
        await update.effective_message.reply_text(f"Error: {type(error).__name__}: {error}")
    print(f"Error: {error}")
    traceback.print_exc()


def main() -> None:
    ensure_directories()
    if not TELEGRAM_BOT_API_KEY:
        raise RuntimeError("TELEGRAM_BOT_API_KEY is required")
    if not TELEGRAM_CHAT_ID:
        raise RuntimeError("TELEGRAM_CHAT_ID is required")

    application = Application.builder().token(TELEGRAM_BOT_API_KEY).build()
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("status", status_command))
    application.add_handler(CommandHandler("process", process_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text_message))
    application.add_handler(MessageHandler(filters.VOICE, handle_voice_message))
    application.add_handler(MessageHandler(filters.AUDIO, handle_audio_message))
    application.add_handler(MessageHandler(filters.PHOTO, handle_photo_message))
    application.add_handler(MessageHandler(filters.VIDEO | filters.ANIMATION, handle_video_message))
    application.add_handler(MessageHandler(filters.Document.ALL, handle_document_message))
    application.add_error_handler(error_handler)
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
