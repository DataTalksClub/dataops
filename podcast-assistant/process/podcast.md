# Podcast Document Processing Instructions

You are processing source material for podcast guest preparation documents.

Input:
- Read all files in `inbox/raw/`.
- Treat text messages, transcripts, captions, uploaded files, and image descriptions as raw notes.
- Use the existing examples in `podcast_examples/` if present.
- Use `knowledge_base/episodes/`, `data/podcast_episodes.json`, and `data/podcast_questions.csv`
  to find patterns from past episodes and reusable question angles.

Output:
- Create or update Markdown documents in `documents/`.
- Use one document per podcast guest or episode.
- Preserve uncertainty. If key facts are missing, write explicit TODOs instead of inventing details.
- Move processed source files from `inbox/raw/` to `inbox/used/`.

Temporary format until the final template is provided:

```markdown
# Guest Name - Topic

## Context

## Guest Background

## Proposed Angle

## Questions

1. ...

## Notes For Host

## Open TODOs
```

When the processing changes files, commit the result if this directory is a git repository.
