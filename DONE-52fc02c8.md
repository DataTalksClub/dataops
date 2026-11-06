# DONE evidence — task 52fc02c8 (CLI gap: events archive — past Luma descriptions as DataOps event records)

The gap was already closed on main by `46beb022` ("feat(events): add past events
archive API and dataops events CLI (create/list/show/import)", Developer,
2026-10-31). This file records the 2026-11-05 re-verification on current
origin/main (`e8eef735`) and a read-only prod spot-check. No product code or
test changes were needed; this PR is docs-only.

- Inventory — storage: past events are structured DynamoDB items in the
  Calendar table under the `EVENTARCHIVE#` prefix
  (`backend/src/db/eventArchive.ts:59-60`). The `ArchivedEvent` shape (same
  file, lines 15-47) carries title, slug, date, time, type,
  course/series/module, relatedCourse, `lumaUrl`, `recordingUrl`, `speakers[]`,
  the verbatim Markdown event `description`, `registrations`, numeric
  `version`, createdAt/updatedAt — so the Luma description is a first-class
  stored field, not just the URL. Course/series/module normalization is
  `resolveCourseAndSeries` (lines 106-141); the Luma dedup key is `lumaSlug`
  (lines 169-177).
- Inventory — routes: `/api/event-records` GET/POST/PUT/DELETE plus bulk
  `POST /api/event-records/import` (`backend/src/routes/eventArchive.ts:209-275`,
  wired in `backend/src/router.ts:372`). Re-import dedups: match by Luma slug,
  then slug, then date + lowercased title (`findMatchingExisting`,
  `backend/src/routes/eventArchive.ts:149-169`), returning
  created/updated/unchanged counts; identical content counts as `unchanged`
  (`isSameEventContent`, lines 171-194); batches are capped at 500 items
  (lines 215-217). Reads use `work-read`, every mutation `work-write`
  (`resolveInteractiveActor`, lines 202-206) — the same admin-or-operator gate
  the rest of the interactive surface uses (`backend/src/identity/actor.ts:35`
  defines exactly `team-read | work-read | work-write`; there is no separate
  "work-admin" purpose for import-style routes).
- Inventory — Luma client: none. The repo has no Luma HTTP API client (read or
  write); the only Luma-specific code is URL detection/normalization
  (`backend/src/calendar/lumaEvents.ts:6-35`, `backend/src/artifactLinks.ts`).
  The import source is therefore the provided export: Markdown event files
  (folder walk or single file, README.md skipped, folder name becomes the
  series) plus an optional `_data/events.yaml` `link:` → `youtube:` recording
  map (`cli/src/commands/events.mjs:83-98`, `192-224`, `395-427`).
- Inventory — CLI: `dataops events list|show|create|update|delete|import`
  (`cli/src/commands/events.mjs:429-436`, registered in the Planning group at
  `cli/src/cli.mjs:100`, documented in `cli/README.md:68`). `list` filters by
  course/date/from/to/type/speaker/search; `show` accepts id, slug, or Luma
  short code (`backend/src/db/eventArchive.ts:206-222`). There are no separate
  `events archive`/`events past` aliases — `dataops events` is itself the
  past-events archive.
- History: introduced by `46beb022` (2026-10-31); afterwards only refactors
  touched the route (`bd4b5565` shared json helpers, `2f372fd4` realDate
  routing), no functional change to route, db layer or CLI. The task id
  52fc02c8 appears nowhere in the repo. The sibling's note that "eventArchive
  stores Luma URLs as metadata" undersells it: the URL is a dedup/uniqueness
  field and the Luma description body is stored verbatim per record.
- Prod spot-check (read-only, 2026-11-05): `dataops events list --json`
  returns 58 records; all 58 have a non-empty Markdown description and a
  lumaUrl, seeded 2026-10-31T03:17Z (same seeding run as the offers record).
  No live Luma API calls were made for this task.
- Tests on this tree (2026-11-05, current origin/main `e8eef735`):
  `backend/tests/event-archive.test.ts` 2/2 — synthetic-fixture CRUD (read by
  id/slug/Luma code, course and date filters, version-checked update, 409 on
  duplicate slug/lumaUrl, validation errors) and idempotent bulk import (second
  identical import `unchanged=1`, third import with a new recordingUrl
  `updated=1`); `cli/test/events.test.mjs` 5/5 — Luma archive Markdown parsing
  with events.yaml recording enrichment, list filters, show, create/update
  payloads, folder-walk bulk import. Existing coverage already matches the
  task's "synthetic fixture, dedup on re-import" requirement, so no new tests
  were added.
