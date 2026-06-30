# Typefully Export Scripts

Utilities for exporting Typefully social-set drafts and turning them into local
analysis/process-doc drafts.

These scripts read `TYPEFULLY_API_KEY` from `.env` or the environment. They do
not print the token. Keep exports under `.tmp/` because post archives can
contain private Typefully URLs, draft text, and unpublished drafts.

## Export drafts and posts

```bash
node scripts/typefully/export-posts.mjs \
  --output .tmp/typefully-export \
  --status all
```

By default, the exporter discovers all Typefully social sets available to the
API key. To restrict the export, pass one or more social-set names, usernames,
or ids:

```bash
node scripts/typefully/export-posts.mjs \
  --output .tmp/typefully-export \
  --status published \
  --social-set DataTalksClub \
  --social-set Al_Grigor
```

The export includes:

- `social-sets.json`: accessible social sets and connected platforms.
- `<social-set>-drafts.json`: raw draft list and detail responses.
- `all-drafts.json`: combined raw export.
- `posts.jsonl`: one normalized row per platform post.
- `posts.csv`: same normalized rows for spreadsheet analysis.

The normalized rows include both X/Twitter (`platform=x`) and LinkedIn
(`platform=linkedin`) posts when present in Typefully draft details.

## Optional X analytics samples

Typefully analytics currently supports X posts only. LinkedIn analytics is not
available through the Typefully endpoint tested on 2026-06-29.

```bash
node scripts/typefully/export-posts.mjs \
  --output .tmp/typefully-export \
  --status published \
  --include-x-analytics \
  --analytics-start-year 2022
```

## Analyze an export

```bash
node scripts/typefully/analyze-posts.mjs \
  --input .tmp/typefully-export/all-drafts.json \
  --output .tmp/typefully-analysis
```

This creates:

- `analysis.md`
- `process-doc-drafts/*.md`

