# Podcast Assistant

Telegram assistant for collecting podcast prep material and generating podcast guest documents.

This is copied from the Telegram Writing Assistant shape, but the agent execution boundary uses
Heru instead of calling Claude directly. Set `HERU_ENGINE=codex` or `HERU_ENGINE=claude` to choose
which coding agent processes the inbox.

## Setup

```bash
uv sync
cp .env.example .env
uv run python main.py
```

Required `.env` values:

```bash
TELEGRAM_BOT_API_KEY=...
TELEGRAM_CHAT_ID=...
GROQ_API_KEY=...
HERU_ENGINE=codex
```

## Commands

- `/start` - show bot help
- `/status` - show inbox and document counts
- `/process` - process with the default `HERU_ENGINE`
- `/process codex` or `/process claude` - process with a specific Heru engine

## Layout

```text
inbox/raw/        incoming Telegram notes, transcripts, images, and files
inbox/used/       processed source material
documents/        generated podcast guest documents
process/          agent instructions
heru_runs/        raw Heru JSONL logs
knowledge_base/   normalized past podcast prep docs
data/             JSON/JSONL/CSV exports for search and agents
```

The exact podcast document format is intentionally left in `process/podcast.md` as a placeholder
until you provide the final format.

## Podcast Knowledge Base

Build the normalized archive from the unpacked `.docx` files:

```bash
uv run python scripts/build_podcast_knowledge_base.py
```

Search past episodes and extracted questions:

```bash
uv run python scripts/search_podcast_kb.py "AI agents evaluation"
uv run python scripts/search_podcast_kb.py "career transition" --questions-only
```
