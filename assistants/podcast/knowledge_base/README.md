# Podcast Knowledge Base

This folder is generated from past podcast `.docx` preparation documents.

Regenerate it with:

```bash
uv run python scripts/build_podcast_knowledge_base.py
```

Or rebuild from a new uploaded zip:

```bash
uv run python scripts/build_podcast_knowledge_base.py --zip path/to/Podcast.zip
```

Generated outputs:

- `knowledge_base/episodes/*.md` - one normalized Markdown record per episode
- `knowledge_base/clusters/themes.md` - cluster index by episode theme and question category
- `data/podcast_episodes.json` - structured records for tools and agents
- `data/podcast_episodes.jsonl` - one JSON record per episode
- `data/podcast_questions.csv` - extracted question bank
- `data/podcast_clusters.json` - cluster index

Use `templates/podcast_guest_intake.md` for future guest prep so new episodes enter the same structure.
