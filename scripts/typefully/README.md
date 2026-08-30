# Manual Typefully Exporter

`export-posts.mjs` is retained as manual, one-shot raw source-export tooling.
It is not a supported product feature and must not run from application
runtime, deployment, CI, tests, schedules, or other recurring automation.

Running the exporter requires explicit HUMAN authorization for both provider
access and the intended export scope. The operator must supply an authorized
`TYPEFULLY_API_KEY` through the environment or the repository's ignored
`.env` file. The script does not print the token.

Raw exports can contain unpublished text, account context, provider metadata,
and private Typefully links. Always write them below the repository's ignored
`.tmp/` directory; they must never be committed, uploaded as public CI
artifacts, or treated as durable operational knowledge.

After an authorized export, review, analysis, curation, retention, and disposal
belong to the private operational-knowledge process. Do not add raw exports or
derived operational documents to this public repository.

## Authorized manual use

The exporter discovers every social set available to the API key unless the
operator restricts the scope with one or more `--social-set` selectors. Prefer
an explicit scope and status approved for the one-shot operation:

```bash
node scripts/typefully/export-posts.mjs \
  --output .tmp/typefully-export \
  --status published \
  --social-set <approved-name-username-or-id>
```

The ignored output can include:

- `social-sets.json`, containing accessible social sets and platforms;
- `<social-set>-drafts.json`, containing raw draft records and details;
- `all-drafts.json`, containing the combined raw export;
- `posts.jsonl` and `posts.csv`, containing normalized platform-post rows; and
- `x-analytics.json` when the separately authorized
  `--include-x-analytics` option is used.

Use `node scripts/typefully/export-posts.mjs --help` to inspect the available
manual options before an authorized run. A past export does not authorize a
future one; each run requires a new HUMAN/provider authorization and an
explicit private-data disposition.
