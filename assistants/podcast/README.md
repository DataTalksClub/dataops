# Podcast Assistant

Telegram assistant for collecting podcast prep material and generating podcast guest documents.

This directory is the canonical in-repo Podcast Assistant location for DataOps:
`assistants/podcast/`. The old root-level `podcast-assistant/` import has been
folded into this module.

This is copied from the Telegram Writing Assistant shape, but the agent execution boundary uses
Heru instead of calling Claude directly. Set `HERU_ENGINE=codex` or `HERU_ENGINE=claude` to choose
which coding agent processes the inbox.

## Setup

From the DataOps checkout:

```bash
cd assistants/podcast
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

`HERU_ENGINE` can be `codex` or `claude`. The DataOps checkout expects the local
Heru source at `../heru` relative to the repo root; `pyproject.toml` references it
as `../../../heru` from this directory.

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

`inbox/`, `documents/`, `.tmp/`, and `heru_runs/` are local development/runtime
storage. They are ignored except for `.gitkeep` placeholders and are not the
production artifact store for DataOps V1. Future portal integration should
create assistant jobs, logs, and artifact records instead of treating these
folders as durable workflow storage.

Live `/process` runs do not commit or push by default. Generated files stay as
local working-tree changes for review through the normal DataOps pipeline.

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
uv run python scripts/search_podcast_kb.py "Kubernetes AI infrastructure" --actual-only
```

Use [knowledge_base/question_playbook.md](knowledge_base/question_playbook.md) when drafting new
guest questions. It describes how to derive questions from a guest's bio, topic, projects, claims,
metrics, and tensions in the same style as the archive.
