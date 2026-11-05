# DONE evidence — task d8d270d5 (unified event lifecycle coverage: every event type via card templates)

Verified against origin/main `e8eef735` (2026-11-05) in a dedicated worktree
(`fix/event-lifecycle-verify`). Design intake named in
`docs/unified-event-lifecycle.md:3`; sibling verification record for 87fb06a6
covers the one-step podcast reschedule slice. This task's ask: the lifecycle
must cover ALL event-producing template types through the Card Template's
`eventPolicy`, with no type bypassing the unified path except documented
deliberate exemptions.

## Verdict

The unified lifecycle is a **type-agnostic interpreter**: one service
(`backend/src/events/`), one route family (`/api/events/:target/:action`),
one CLI family (`dataops event *` + aliases), one set of lifecycle primitives
(`propose → approve → reschedule → release`, plus title lifecycle, guest
invites, calendar targets, Zoom, transition emails and calendar-accept
approval — all `EventPolicy` fields). No backend code branches on template
type anywhere in the lifecycle. Coverage of a template type is therefore
gated by exactly one thing: the Card Template (its snapshot, its live
definition, or its Git base) declaring an `eventPolicy`
(`backend/src/events/service.ts:100-135`, strict shared validation in
`backend/src/events/policy.ts:29-98`, authored-YAML field `event_policy` in
`backend/src/templates/yamlTemplates.ts` TEMPLATE_FIELDS, API-editable field
in `backend/src/templates/cardTemplateUpdates.ts:32,182`).

Tests prove the type-generality: the planner suite runs the identical full
lifecycle for `podcast`, `webinar` and `workshop` fixtures with distinct
policies (different windows, Zoom on/off)
(`backend/tests/event-lifecycle.test.ts:22-48`), and the service suite runs
podcast through the full atomic lifecycle including Episode/Google/docs
projections (`backend/tests/event-service.test.ts:341-555`) and webinar +
workshop per-type behaviour with calendar-accept auto-approval
(`:557-684`).

**No event-producing template type hand-rolls its own lifecycle outside the
unified service.** The only deliberate, documented bypass is AISHL
(site-scheduled). Everything else still on legacy writers is the documented
pre-cutover state of migration slices 3-5 (`docs/unified-event-lifecycle.md:195-217`),
not a per-type gap. **No code change was needed; this PR is the verification
record only.**

## Event-producing template universe

- `backend/src/cards/cardTitleTokens.json` `templateTypes`: `podcast`,
  `lightning-lesson-podcast` (podcast-episode record); `newsletter`,
  `newsletter-standalone` (newsletter-issue record — publication, not an
  event).
- In-repo canonical dated-event set `EVENT_CARD_TYPES`
  (`backend/src/calendar/entities.ts:29-37`): `webinar`, `workshop`,
  `course`, `book-of-the-week`, `maven-ll`, `office-hours`, `oss` (+ podcast
  Cards shown via their episode; newsletter via its issue).
- Live template types (read-only prod check 2026-11-05, `dataops templates
  list`): the above plus `lightning-lesson-podcast`, `maven-cohort`,
  `aishl-workshop`, `course-module-start`, `course-project-start`,
  `course-deadline`, `course-retrospective`, `social-media`, `tax-report`,
  `operating-model-w01..w13`, `dev-sync-smoke`. Course-cohort Q&A/launch
  sessions are themselves event Cards linked by the course Template
  (`linkCard` slots — `backend/tests/course-event-slots.test.ts`), so the
  course family needs no lifecycle of its own.

## Coverage matrix

All unified primitives live in shared code; per-type behaviour is the
Template's `eventPolicy` content. Primitive → implementation:

| Primitive | Implementation (file:line) | Test |
| --- | --- | --- |
| propose (hold) | `events/lifecycle.ts:119-147` (planner), `events/store.ts:87-129` (atomic commit: authority + Card `eventTime` + op/history journals), `events/service.ts:857-870` | `event-lifecycle.test.ts:22-27`, `event-service.test.ts:341` |
| approve (confirm) | `events/lifecycle.ts:148-151,160-164` (approved title, Zoom location, attendee set, lead minutes), `events/service.ts:872-878` | `event-lifecycle.test.ts:29-33`, `event-service.test.ts:341` |
| reschedule | `events/lifecycle.ts:116,130,135` (back to proposed, generation+1, Google identity retained), `events/service.ts:880-890`, episode projection `events/service.ts:345-376` joined to the same transaction (`store.ts:113`) | `event-lifecycle.test.ts:35-39`, `event-store.ddb.ts` (transaction + rollback), `cli/test/event.test.mjs:181-217` |
| release (delete) | `events/lifecycle.ts:150`, Google delete `events/service.ts:421-425`, reproposal fresh identity `lifecycle.ts:131,144-145` | `event-lifecycle.test.ts:42-46`, `event-service.test.ts:341` |
| TTL expiry (proposal only) | legacy `db/calendarHolds.ts:185-260` + `calendar/holds.ts:389-391` (tentative only — approved events never auto-release, per design doc :22-24) | `calendar-holds.test.ts:180-210` |
| title lifecycle | `policy.titles.proposed/approved` rendered at `events/lifecycle.ts:167-168`; `(Proposal)` required `events/policy.ts:63-65` | `event-lifecycle.test.ts:27,33,38` |
| guest invites | `policy.guests.proposal/approved/requiredEmails/leadMinutes` at `events/lifecycle.ts:162-171`; guest resolution `events/service.ts:318-343` | `event-service.test.ts` (email/attendee assertions), `calendar-holds.test.ts:396-414` (legacy invite rules) |
| calendar targets (organizer + 2 mirrors) | `events/service.ts:427-456` via `calendar/holdGoogleSync.ts`; extendedProperties markers `:436-442` | `hold-google-copies.test.ts:63+`, `hold-google-errors.test.ts`, `calendar-google-event-read.test.ts` |
| calendar-accept approval | `events/lifecycle.ts:152-158`, poll `events/service.ts:975-1195`, quorum any/all `policy.calendarAcceptance` | `event-lifecycle.test.ts:72-82,114-122`, `event-service.test.ts:557-684` |
| drift guards | Card date `routes/cards.ts:726-736`, episode date `routes/podcastEpisodes.ts:519-532` — both redirect to `dataops event reschedule` / `dataops podcast reschedule` | `calendar.test.ts:312-313`, `api-podcast-slice.test.ts` |
| retry / poll / read surfaces | `events/service.ts:900-959`, routes `routes/events.ts:89-165`, CLI `cli/src/commands/event.mjs` | `cli/test/event.test.mjs:71-179`, `event-store.ddb.ts` (lease/no-op retries) |
| UI controls | `frontend/src/surfaces/work-detail/card-invites.js:366-370` | `frontend/test/card-invites.test.mjs` |

Per template type (the gate is the Template's `eventPolicy`; "unified path"
means the service resolves the policy and runs every primitive above
identically):

| Template type | Unified primitives apply | Policy variance proven by | Prod status (2026-11-05, read-only) |
| --- | --- | --- | --- |
| podcast | Yes — full matrix, plus Episode datetime projection and `podcast reschedule` alias | `event-service.test.ts:341-555`; policy fixture `tests/helpers/eventPolicy.ts` | 9 Cards; 3 hold-backed. Template pinned WITHOUT `eventPolicy`/`base` → unified writes unreachable until the knowledge repo declares `event_policy`; legacy hold paths still serve |
| lightning-lesson-podcast | Yes — same record/aliases as podcast (`cardTitleTokens.json` podcast-episode record; `resolvePodcastCardInviteTitle` `calendar/cardInvite.ts:212-240`) | same planner suite (type-agnostic) | pinned, no `eventPolicy` yet |
| webinar | Yes — full matrix; distinct windows/Zoom-off variants covered | `event-lifecycle.test.ts:22-48`, `event-service.test.ts:557-684` | 3 Cards on `card:` invitations (Luma-family silent entries — documented migration inventory); no `eventPolicy` yet |
| workshop | Yes — full matrix (90-min evening window shape in legacy propose; policy-driven under unified) | same two suites | pinned, no `eventPolicy` yet |
| course family (course Cohort Launch, module/project start, deadline, retrospective; Q&A via linked event Cards) | Yes — Q&A/launch sessions are event Cards of event template types linked by `linkCard` slots; the lifecycle applies to those Cards, not to the course Template | `course-event-slots.test.ts` | `course` git template, no `eventPolicy`; its future Q&A Cards inherit their own template's policy |
| maven-ll / maven-cohort (Maven lightning lessons) | Yes — `maven-ll` is in `EVENT_CARD_TYPES`; `lightning-lesson-podcast` rides the podcast record | planner suite (type-agnostic); `calendar/entities.ts:29-37` | both live, no `eventPolicy` yet |
| office-hours, oss, book-of-the-week | Yes — in `EVENT_CARD_TYPES`, so any dated Card rides the same service | planner suite (type-agnostic) | no `eventPolicy` yet |
| aishl-workshop | **Deliberate bypass** — never creates Google invites/Zoom; `cards time` records date/time only | `card-calendar-invites.test.ts:226-239` | 10 Cards, all `card:` keys, zero Google calls — working as designed |

## Bypass inventory

1. **AISHL site-time routing — deliberate and documented.** Code:
   `backend/src/calendar/cardInvite.ts:24-25` ("AISHL workshops are
   scheduled by the AISHL site event, which sends its own invite and
   Zoom."), branch `:251`, implementation `setSiteScheduledTime` `:390-406`
   with the operator-facing reason string `:399`; AISHL is deliberately
   absent from `EVENT_CARD_TYPES` (`calendar/entities.ts:29-37`) so its
   Cards do not project onto the DataOps calendar. SOP: knowledge base
   `sop.aishl.workshops.run-an-aishl-workshop` ("the site event as the only
   calendar invite"; "Workshops are NOT created through the events API").
2. **Legacy hold writers (calendar propose / confirm-hold / release-hold /
   TTL expiry; `cards time` → `syncCardInvite`) — transitional, documented.**
   `docs/unified-event-lifecycle.md:108-113` retains aliases; slices 3-5
   (`:195-217`) replace the direct writers at cutover ("production awaits
   Alexey"). Today `POST /api/calendar-holds/:id/move` already delegates to
   the unified service whenever the hold's Card resolves an eventPolicy, and
   falls back to the legacy move otherwise
   (`routes/calendarHolds.ts:308-338`, fallback comment `:332-337`); the
   drift guards (`cards.ts:726-736`, `podcastEpisodes.ts:519-532`) refuse
   manual writes on hold-owned dates.
3. **Luma silent entries (`syncLumaCalendarEvents`, `cardInvite.ts:281-322`)
   — transitional.** Card-only `card:<id>` invitations are explicitly in the
   migration inventory (design doc `:199-202`).
4. **Noted, not fixed (would be churn against the documented plan):** the
   legacy TTL expiry and hold listing filter on the legacy status vocabulary
   (`db/calendarHolds.ts:150`, statuses at `routes/calendarHolds.ts:62`), so
   fully migrated (`proposed`/`approved`) holds fall outside them; and
   `moveRoute`'s delegation/fallback has no direct route-level test (the
   service semantics and the CLI contract are covered by
   `event-store.ddb.ts` and `cli/test/event.test.mjs:181-217`). Both are
   cutover-slice work, listed under remaining gaps.

## Read-only prod evidence (2026-11-05; no writes performed)

- `dataops templates list`: 33 templates; **none** declares `eventPolicy`,
  and the pinned Git templates (podcast, webinar, workshop, …) carry no
  `base` either — they were pinned before the base/eventPolicy mechanism and
  `templates sync` refreshes `base` only for pinned rows that already have
  one (`backend/src/templates/authoredTemplates.ts:333-345,389-412`).
  Consequently `resolveCardEventPolicy` cannot yet resolve a policy for any
  prod Card: the unified lifecycle is implemented and tested but not yet
  *armed* by template content. Arming it is authored-YAML work in the
  private `dataops-knowledge/workflow-templates` (out of this repo), after
  which the pinned-base fallback (commit `49554273`,
  `backend/tests/event-policy-pinned-base.test.ts:18-33`) reaches pinned
  templates through `base.eventPolicy`.
- `dataops cards list`: 33 Cards; 16 with `eventTime` — 3 podcast hold-backed,
  10 AISHL `card:` (no Google), 3 webinar `card:`.
- `dataops calendar holds`: 19 holds; 2 already carry unified fields
  (`hold_c3d15b7c…` `lifecycleStatus=released` gen 1; `hold_5b63ec9d3281`
  gen 3), 17 remain legacy rows — consistent with the not-yet-run offline
  migration (design doc slice 5).

## Tests run in this worktree (all green)

- `node --test tests/event-lifecycle.test.ts` — 8/8 pass.
- `node --test tests/event-policy.test.ts tests/event-policy-pinned-base.test.ts` — 5/5 pass.
- `node --test tests/event-service.test.ts` — 2/2 pass (podcast full
  lifecycle; webinar+workshop per-type + calendar accept).
- `node --test tests/calendar-holds.test.ts tests/card-calendar-invites.test.ts tests/card-event-time.test.ts tests/course-event-slots.test.ts` — 51/51 pass.
- `npm run test:task-card-transaction` — 16/16 pass (9 task/dependency +
  7 event-store transaction/lease/rollback).
- `node --test test/event.test.mjs` (cli) — 2/2 pass (unified endpoints;
  `podcast reschedule` / `calendar move-hold` delegation payloads).

## Remaining gaps (rollout, not code gaps in this repo)

1. Author `event_policy` for the event-producing templates in the private
   `dataops-knowledge/workflow-templates` (podcast first, then webinar,
   workshop, course Q&A Cards, lightning lessons, office-hours, oss,
   book-of-the-week) and let `templates sync` publish it. Pinned rows
   without a stored `base` (all pinned prod templates today) take the
   seed-replace path on sync (`authoredTemplates.ts:389-397`) — review pins
   before relying on that.
2. Cutover slices 3-5: replace the legacy confirm/release/create writers and
   the legacy TTL expiry with the service (expiry currently only sees legacy
   `tentative` holds), run the offline status migration, then delete the
   legacy writers.
3. Add a route-level test for `moveRoute`'s unified delegation + fallback
   (`routes/calendarHolds.ts:308-338`).
4. Hub intake d8d270d5 could not be updated from this environment (intake
   API returned HTTP 503 twice); this record is the durable evidence.
