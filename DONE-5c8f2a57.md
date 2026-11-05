# DONE evidence — task 5c8f2a57 (doc workspace for transcripts, timecodes, summaries: txt/docx export, guest review)

Verified against origin/main `fdfc6929` (2026-11-05) in a dedicated worktree,
plus read-only prod checks through the `dataops` CLI. All three asks are
already implemented; the only real gaps found were two export `Content-Type`
misalignments, fixed in this PR (two one-line route changes + assertions in
the existing tests).

## (a) Transcript/timecodes/summary doc workspace — DONE

The same four kinds exist in both doc families, and both are reachable per
card and per task:

- Kinds are `transcript`, `timecodes`, `summary`, `note` in both families:
  `DOCUMENT_KINDS` (`backend/src/db/documents.ts:8`) and
  `CARD_DOCUMENT_KINDS` (`backend/src/db/cardDocuments.ts:8`); enforced by the
  create routes (`backend/src/routes/documents.ts:59`,
  `backend/src/routes/cardDocuments.ts:69`).
- Task documents (guest-reviewable): `dataops doc
  list|show|create|update|delete|export` (`cli/src/commands/documents.mjs:7-17`)
  over `/api/documents` (`backend/src/routes/documents.ts`); portal UI creates
  them from a kind picker and edits/exports them
  (`frontend/src/surfaces/work-detail/task-documents.js:25-28, 33-46`).
- Card documents (staff-only, the per-card workspace):
  `dataops card-doc list --card ID` / `create --card ID --kind transcript …`
  (`cli/src/commands/cardDocuments.mjs:6-15`); the API lists by `cardId` and
  creates attached to the card (`backend/src/routes/cardDocuments.ts:39-42,
  67-72`).
- Podcast episode link: `dataops podcast create-card <episode-id>` creates the
  episode Card and stores its id on the episode (`cli/src/commands/podcast.mjs:54-56`;
  `PodcastEpisode.cardId`, `backend/src/db/podcastEpisodes.ts:77`). Prod has 10
  episodes with linked Cards; `card-doc list` on those cards works (empty
  today — the feature exists, nobody has attached transcripts yet). The
  episode record itself also carries the website page transcript data
  (`EpisodeTranscriptEntry[]` with `sec`/`time`/`who`,
  `backend/src/db/podcastEpisodes.ts:31-39, 90`) and the readiness
  `transcript` observation (`backend/src/podcast/publication.ts`).
- Guest-facing materials for an episode live in the third family:
  `dataops podcast doc create <card-id> --template
  podcast|podcast-guest-research|podcast-run-sheet|podcast-episode-brief`
  (`cli/src/commands/sponsorDocs.mjs:47-68`), linked on the Card and served at
  `/podcast-docs/:id`.
- Copy within a family: `--from ID` on both `doc create` and `card-doc create`
  (`backend/src/routes/documents.ts:49-53`,
  `backend/src/routes/cardDocuments.ts:59-63`; verified by 0101cb2b).

The smallest slice the task asked for ("create doc of kind transcript linked
to an episode card, list docs per card") is exactly `card-doc create --card
<episode-card> --kind transcript …` + `card-doc list --card <episode-card>`,
both present. No new flow was needed.

## (b) txt export — DONE (Content-Types aligned in this PR)

Every doc-family export endpoint accepts `txt`:

- Task documents: `GET /api/documents/:id/export?format=txt` → `text/plain;
  charset=utf-8` (`backend/src/routes/documentExports.ts:14, 21`).
- Card documents: `GET /api/card-documents/:id/export?format=txt` →
  `text/plain; charset=utf-8` (`backend/src/routes/cardDocuments.ts:25, 29`).
- Sponsor/podcast docs: `GET /api/sponsor-docs/:id/export?format=txt`
  (`backend/src/routes/sponsorDocs.ts:827-840`).
- Knowledge/registry docs: `GET /docs/export?format=txt` → `text/plain`
  (`backend/src/docs/contentApi.ts:561, 571`).
- CLI: `dataops doc export <id> --format txt`, `dataops card-doc export <id>
  --format txt`, `dataops podcast doc export <id> --format txt`
  (`cli/src/commands/documents-transfer.mjs:9-10`); DOCX verified by 0101cb2b.

Fixed here: sponsor-docs served `txt` with `Content-Type: text/markdown`
(the format was appended to the markdown branch in `f2780c8e` without
adjusting the header) — now `txt`/`text` export as `text/plain;
charset=utf-8` (`backend/src/routes/sponsorDocs.ts:834`). Card-documents
served `md` as `text/plain` — now `text/markdown; charset=utf-8`, matching
the task-document and docs endpoints (`backend/src/routes/cardDocuments.ts:29`).

## (c) Guest review — DONE (view + comment without an account)

Two existing mechanisms cover it; no new auth was added:

- Document review links (task documents of every kind, so transcripts and
  summaries included): staff mints a reviewer token via
  `POST /api/documents/:id/reviewers` and receives
  `/document-review/:docId?review=<token>`
  (`backend/src/documents/reviews.ts:57-59`); the guest page sends the token
  from the URL as `x-document-review-token`
  (`frontend/src/document-review-page.js:7-20`). Anonymous guest requests are
  allowed exactly for `GET /api/documents/:id/review` (document read) and
  `GET|POST /api/documents/:id/comments(/…/reply|resolve)` (threaded
  comments) — `isAnonymousDocumentReviewRequest`
  (`backend/src/documents/reviews.ts:13-15`). Guests cannot manage reviewers
  (`reviews.ts:43`) or delete threads (`reviews.ts:68-69`); the review read
  strips `taskId` so the link leaks nothing else (asserted in
  `backend/tests/document-reviews.test.ts:40-66`). Tokens are scoped,
  hashed, expiring and revocable
  (`backend/tests/document-reviews.test.ts:13-23`). Staff UI: "Guest review
  and comments" panel on every task document
  (`frontend/src/surfaces/work-detail/task-documents.js:77-86`). Agents can
  mint links without the portal via the generic API passthrough
  (`dataops api POST /api/documents/<id>/reviewers`; MCP `dataops_write`
  reaches the same routes, `mcp/src/tools.mjs:12-39`).
- Sponsor-docs guest-code flow (webinar/workshop/podcast guest materials):
  anonymous `GET|PUT /api/sponsor-docs/:id` and the export are gated by the
  per-doc access code and rate limiter
  (`backend/src/routes/sponsorDocs.ts:175-190`), and guests see the
  speaker view of the content (`speakerContentView`,
  `backend/src/routes/sponsorDocs.ts:352, 800-806`). Card documents are
  deliberately outside both: card docs are staff-only and the review loader
  cannot see them (`getDocument` returns null for card docs; asserted in
  `backend/tests/card-documents.test.ts:36`).

## Changes in this PR

- `backend/src/routes/sponsorDocs.ts` — txt/text export Content-Type is
  `text/plain; charset=utf-8` (was `text/markdown`).
- `backend/src/routes/cardDocuments.ts` — md export Content-Type is
  `text/markdown; charset=utf-8` (was `text/plain`); txt unchanged.
- `backend/tests/sponsor-docs.test.ts` — the all-template export test now
  asserts md → `text/markdown`, txt → `text/plain`, and that both bodies are
  identical.
- `backend/tests/card-documents.test.ts` — the export loop asserts the
  per-format Content-Type.

## Tests

- `backend/tests/card-documents.test.ts` — 6 pass, 0 fail.
- `backend/tests/sponsor-docs.test.ts` — 21 pass, 0 fail.
- `backend/tests/documents.test.ts` +
  `backend/tests/document-reviews.test.ts` — 15 pass, 0 fail.
- `npx tsc --noEmit` (backend) — clean.

## Remaining gaps

- No bridge converts an episode's website transcript data
  (`episode.transcript`) into a card transcript document; staff paste or
  upload it (`card-doc create --file`). The task scoped (a) to
  create-plus-list per episode card, which exists, so this is a candidate
  follow-up, not a gap against the ask.
- There is no dedicated CLI command for reviewer management (review links are
  minted via the portal panel or the generic `dataops api` passthrough).
