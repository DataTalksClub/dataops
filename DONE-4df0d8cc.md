# DONE evidence — handoff task 4df0d8cc (CLI gap: campaign calendar / social post entity for cohort campaigns)

The gap was already closed on main by `b8091c5a` ("feat(campaigns): add campaign
calendar row entity per cohort Card and CLI import/list/update", 2026-10-31,
merged before the 2026-11-05 verification) and the prod records were seeded the
same day. This file records the 2026-11-05 re-verification on current
origin/main (`41f16668`) and live prod, plus the one in-repo docs gap this PR
fixes. No product code changes were needed.

## Existing-coverage inventory

Entity — one structured record type, keyed per cohort Card:

- `backend/src/db/campaignCalendar.ts:15-38` — `CampaignCalendarRow`: `id`,
  `cardId`, `rowIndex`, `date`, `offset`, `relativeWeek`, `phase`, `weekday`,
  `channel`, `format`, `owner`, `status`, `title`, `audience`, `cta`,
  `phrases`, `assets`, `typefullyExamples`, `purpose`, `version`, `createdAt`,
  `updatedAt`. That is the requested payload: channel, date, copy/link fields
  (title/cta/phrases/assets) and status, queryable per row.
- Storage: one DynamoDB item per row, `PK = SK = CAMPAIGN_ROW#<uuid>` in the
  artifacts table (`campaignCalendar.ts:76`, `TABLE_ARTIFACTS`), next to the
  other CAMPAIGN_ROW siblings; bounded-pagination Scan filtered by the
  `CAMPAIGN_ROW#` prefix and `cardId` (`campaignCalendar.ts:169-213`).
- Reusable process-template rows live under the virtual cardId `template`
  (`CAMPAIGN_TEMPLATE_CARD_ID`, `campaignCalendar.ts:13`); a row's Card must
  exist or the row is hidden/invalid (`campaignTargetExists`,
  `campaignCalendar.ts:83-90`).
- Validation: every row requires `date` or `offset`, `channel`, `format`,
  `status` (default `Planned`) — `normalizeRowInput`/`validateNormalizedRow`
  (`campaignCalendar.ts:96-155`).
- CRUD: create (`:215-244`), import with append vs replace (`:246-314`),
  update and delete under optimistic locking — stale `version` raises
  `CampaignCalendarVersionConflict`, surfaced as HTTP 409
  (`campaignCalendar.ts:69-74,316-403`).
- CSV import: generic parser with header aliases (platform → channel,
  working_title → title, recommended_date → date, …) plus detection of the
  Telegram announcement-calendar layout (`parseCampaignCalendarCsv`,
  `campaignCalendar.ts:405-540`).

Routes and auth:

- `backend/src/routes/campaignCalendar.ts:54-223` — `GET /api/campaign-calendar?cardId=…`
  (also `channel`/`status`/`phase`/`owner`/`format` filters), `GET …/:id`,
  `POST /api/campaign-calendar`, `POST /api/campaign-calendar/import`
  (`csv`, `rows`, or `fromTemplate`; optional `replace` and per-import
  `channel`/`owner`/`status` defaults), `PUT …/:id` and `DELETE …/:id` with
  `version`; 404 for an unknown cardId, 400/409 as above.
- Wired into the single Lambda router: `backend/src/router.ts:67` (import) and
  `backend/src/router.ts:415-418` (dispatch for `/api/campaign-calendar`).
- Scope: `/api/campaign-calendar` rides the `cards:write` scope group, reads
  and writes both (`backend/src/auth/tokenScopes.ts:114`), consistent with it
  being a per-Card record. MCP reaches the same API through the generic
  `/api/` prefix check (`mcp/src/tools.mjs:12`, `validateRoute`).

CLI:

- `cli/src/commands/campaigns.mjs` — `dataops campaigns
  list|show|import|create|update|delete` (`list` takes `--card ID` or
  `--template` plus the same filters; `import` takes `--file PATH` or
  `--from-template` with `--replace`; update/delete read or take `--version`).
  Registered as the `campaigns` family in the Planning group
  (`cli/src/cli.mjs:13,98`).
- Documented in `cli/skill/SKILL.md:269-279`, which is what `dataops
  agent-guide` prints (`cli/src/cli.mjs:43`), so agents discover it without
  reading this repo.

Tests (all on main since `b8091c5a`; helper consolidation `bd4b5565` touched
the route afterwards without behavior change):

- `backend/tests/campaign-calendar.test.ts` — 3 tests: CSV import into
  `template` and cohort Cards with list filters and optimistic locking;
  Telegram-announcement CSV with append vs replace; create/delete/input
  validation, auth enforcement, and rows hidden when the cohort Card is
  removed.
- `cli/test/campaigns.test.mjs` — 1 test: `--file` import for template and
  cohort Card, filtered list, versioned update, delete, and the
  missing-arguments usage errors.

`git log --oneline --all -- backend/src/db/campaignCalendar.ts
backend/src/routes/campaignCalendar.ts cli/src/commands/campaigns.mjs
backend/tests/campaign-calendar.test.ts cli/test/campaigns.test.mjs` shows
exactly those two commits — no other campaign/social-post/post-schedule record
exists (grep over `backend/src`, `cli/`, `frontend/src`, `docs/`, `mcp/` finds
no other campaign entity; the `filterCampaigns` hits are the owner-calendar
overlay's "campaign window" event filter, unrelated).

## How cohort campaigns are tracked today (KB, read-only)

- The KB playbook `playbook.education.course.cohort-lifecycle` ("Prepare and
  Run a Course Cohort Lifecycle", section "Build one campaign and announcement
  schedule") treats `02-course-launch-social-system.md` and
  `02-campaign-calendar.csv` as the 76-row menu and lists the canonical
  calendar columns; the course workflow task-template
  `task-template.tasks.course` carries `select-campaign` (T-84), `plan-calendar`
  (T-56) and `workshop-promote` (T-28) tasks on the cohort Card.
- Those KB pages do not name `dataops campaigns` (0 mentions) — the KB text
  predates the CLI. The KB lives in `DataTalksClub/dataops-knowledge`;
  updating it is a KB follow-up outside this repo (see Remaining gaps).
- In prod the structured layer is already the carrier: the
  `Production AI Agents for Generative Media 2026 (cohort 1, Nebius)` Card
  holds 60 campaign rows (2026-11-05 read).

## Live prod checks (read-only, 2026-11-05)

- Deployed CLI: `dataops campaigns --help` prints the documented usage.
- `dataops campaigns list --template --json` → 76 rows, all
  `channel: "Primary social"`, all `status: "Planned"`, createdAt
  `2026-10-31T03:11:08Z` — the KB menu seeded into the template the day the
  entity landed.
- `dataops campaigns list --card 105c7bad-551b-4c6b-9f05-a3aa52ed3709 --json`
  (cohort 1, Nebius) → 60 rows across `Course landing page`, `DTC newsletter`,
  `Alexey social (LinkedIn, X, Threads, Substack Notes)`, `DTC LinkedIn + X`,
  `DTC Slack`, … with dates from 2026-10-26 and statuses `Planned`/`Ready`.
- `dataops campaigns list --card 7494cd65-23c4-42e6-99cf-8de61d597f41 --json`
  (Product Shipping with AI – Cohort 1, Jan 2027) → 0 rows; that cohort's
  campaign plan has not been built yet. `dataops campaigns import --card …
  --from-template` is the supported seeding path.

## Design decision

Cards + workflow tasks never structurally carried the campaign calendar: Tasks
have deadlines but no channel/copy/status fields, and the CSV files in the
knowledge repo are source menus, not queryable records. The right shape — and
what the intake asked for — is a dedicated row record scoped to the cohort
Card, which is exactly what exists. Nothing to invent, nothing to extend
beyond docs: the minimal gap found in this repo was documentation only.

What this PR adds (docs-only):

- `DONE-4df0d8cc.md` — this evidence record.
- `cli/README.md` — the Commands table listed every family except
  `campaigns` (the family has been in the CLI since `b8091c5a`); added the
  missing row after `calendar`.

## Test results on this tree

- `cd backend && node --import tsx --test tests/campaign-calendar.test.ts`
  → 3/3 pass (dynalite, no external services).
- `cd cli && node --test test/campaigns.test.mjs` → 1/1 pass.

## Remaining gaps (outside this repo's code)

- KB follow-up (dataops-knowledge): name `dataops campaigns` in
  `playbook.education.course.cohort-lifecycle` and the `plan-calendar` step of
  `task-template.tasks.course`, replacing the CSV-only description of where
  the canonical calendar lives.
- No frontend UI surface for campaign rows (CLI/API only, which is what the
  intake asked for); `backend/e2e/frontend-capabilities.json` covers frontend
  surfaces only, so no matrix entry is required.
- CLI tests do not yet pin `show`/`create`/`--from-template`; the backend
  route tests cover create and template-import behavior end-to-end, so this
  is a minor coverage note, not a functional gap.
