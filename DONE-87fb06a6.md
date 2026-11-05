# DONE evidence — task 87fb06a6 (one-step podcast reschedule: episode datetime + hold move)

Verified against origin/main `35e7b376` (2026-11-05) in a dedicated worktree.
The one-step command already exists and is fully implemented; this task's ask
is the design intake named in `docs/unified-event-lifecycle.md:3` ("Design for
intakes d8d270d5 and 87fb06a6"), and the implementation landed in verified
slices (commits `853971ad` unified event CLI + reschedule aliases, `417350d5`
+ `c0fe21e5` reschedule checklist Task). This file is the verification record;
the only code change here is the two missing transaction-layer tests for the
episode-projection leg of the reschedule commit.

## Verdict: one step exists — `dataops podcast reschedule`

`dataops podcast reschedule <episode-id|card-id> --date YYYY-MM-DD [--time HH:MM | --window midday|evening]`
moves the calendar hold/invite, Card, Episode datetime, Google calendars, and
linked docs together in one command. It is a first-class alias of the unified
event reschedule, not a two-step composition.

- CLI surface: `cli/src/commands/podcast.mjs:58-61` (help), `:598-600`
  (`reschedule` delegates to `eventCommands.reschedule`), `:609` (command map).
- CLI plumbing: `cli/src/commands/event.mjs:31-43` (`resolveTarget` accepts a
  Card, hold, or episode id), `:128-138` (`reschedule` POSTs
  `/api/events/<target>/reschedule`), `:94-105` (prints event + hold summary
  and the deferred-sync warning), `:104` (prints the reschedule checklist
  Task id).
- Backend route: `backend/src/routes/events.ts:124-149` dispatches
  `reschedule` to `rescheduleEvent`.
- Target resolution: `backend/src/events/service.ts:251-316` —
  `resolveEventTarget` accepts a Card id (`:258-284`), a hold id (`:286-296`),
  or a PodcastEpisode id (`:298-313`, requiring the episode to be linked to a
  Card).
- `rescheduleEvent` (`service.ts:880-890`): an active proposed/approved event
  runs the `reschedule` transition (returns it to `proposed`); no active or a
  released event falls back to `propose`, so the same command also books a
  fresh slot for a cancelled/released episode.

## What the one step moves (episode datetime AND hold/invite together)

1. Planner (`backend/src/events/lifecycle.ts:97-189`): `planEventTransition`
   computes the next EventRecord — new date/time/window, `generation + 1`
   (`:130`), status back to `proposed` for reschedule (`:116`, `:136`), a
   pending operation whose `desired` payload is fully resolved (`:165-179`;
   `:22` "a retry must never reread mutable Card values"), and the rendered
   Google title from `policy.titles.proposed` (`:168`).
2. Atomic commit (`backend/src/events/store.ts:87-129`): one DynamoDB
   transaction writes the event authority (version CAS `:99-100`), the Card
   projection (`anchorDate`, `eventTime`, `:102-108`), the operation journal
   and history (`:109-112`), and — via
   `buildEpisodeTransactionWrite` (`backend/src/events/service.ts:345-376`) —
   the Episode projection: `recordingDate`, `recordingTime`,
   `recordingTimeZone`, `recordingStartIso`, `recordingEndIso`,
   `recordingEventStatus`, `recordingHoldId`, `dateKey`, version-conditional
   (`:356-372`). Conflicts of any leg cancel the whole transaction and surface
   as `EventConflictError` (`store.ts:119-128`); the local transaction
   emulator rolls back applied snapshots (`store.ts:14-47`).
3. External legs reconcile after commit (`service.ts:816-822`,
   `reconcileEventOperation` `:379-456+`): Google organizer + mirror events
   move in place under a worker lease (`store.ts:132-145`), keeping Google
   identities on ordinary reschedules (`lifecycle.ts:42-44`,
   `googleEventKey` at `service.ts:417-418`) and resetting attendee responses
   (`service.ts:444`), emails render per transition policy, and a failed/
   pending leg reports `sync.state: 'deferred'` — never a false complete —
   with `dataops event retry` for recovery (design doc "Expose pending/failed
   sync and a retry command").
4. Reschedule checklist Task: `service.ts:806-814` +
   `ensureEventRescheduleTask` (`backend/src/taskChecklist.ts:249`) creates a
   standalone checklist Task for the SOP steps.
5. Drift guards close the two-step loophole: a direct episode
   recordingDate/time PUT while a hold owns the date is refused with a pointer
   to the one-step command (`backend/src/routes/podcastEpisodes.ts:519-532`,
   code `event_hold_owns_date`); the Card-side equivalent is
   `backend/src/routes/cards.ts:726-736`. The legacy `calendar move-hold`
   route likewise delegates to the unified service when the hold backs an
   event-policy Card (`backend/src/routes/calendarHolds.ts:308-338`).

Title lifecycle is respected: reschedule puts the event back to `proposed`
(`lifecycle.ts:116,136`), the Google title returns to the `(Proposal)` prefix
form from `policy.titles.proposed` (`lifecycle.ts:168`,
`backend/src/events/policy.ts:63,65`), and the same policy drives the podcast
templates (verified end-to-end in `backend/tests/event-service.test.ts:516`).

## Read paths agree

Episode reads derive the recording datetime from the hold authority, so the
episode view can never drift from the hold:
`resolveEpisodeEventAuthority` (`backend/src/routes/podcastEpisodes.ts:311-350`)
+ `presented` (`:353-373`). Read-only prod check on 2026-11-05 confirmed
booked episodes expose `recordingTime`/`recordingEventStatus`/
`recordingHoldId` from their holds (e.g. episode `bcbfb38a…`: confirmed,
hold `hold_d5667b067e8d`); no prod writes were made.

## Tests

Existing coverage (all passing, targeted runs):

- `backend/tests/event-service.test.ts:341-555` (AC3/AC4/AC5/AC7/AC9): full
  podcast lifecycle `propose -> approve -> reschedule -> approve -> release`
  asserts the Card, Episode datetime (`:521-524`), Google events (`:513-518`),
  linked docs, and the checklist Task move together; the AC4 drift guards at
  `:438-452`.
- `backend/tests/event-lifecycle.test.ts:35,58,68,97` (planner-level
  reschedule semantics incl. pending-op and released-event refusals).
- `backend/tests/event-store.ddb.ts:78-96` (concurrent approve vs reschedule:
  one winner, Card/event dates cannot split) and `:68-76` (stale Card version
  rolls back everything).
- `cli/test/event.test.mjs:181-217`: `podcast reschedule` and
  `calendar move-hold` hit the unified endpoints with the expected payloads.

Gap filled in this change — the episode leg of the transaction had no
failure-path test (the stale-Card rollback test committed without
`relatedWrites`): `backend/tests/event-store.ddb.ts` now commits a reschedule
with the real `buildEpisodeTransactionWrite` and asserts (a) event, Card and
Episode move in one transaction, (b) a stale Episode version rolls the
reschedule back for event, Card and journals while the episode stays
untouched. `buildEpisodeTransactionWrite` is exported (`service.ts:345`) and
the loopback harness names the episodes table
(`backend/scripts/test-task-card-transaction.sh`). No production behavior
changed.

Test results (2026-11-05, this worktree):

- `npm --prefix backend run test:task-card-transaction`: 18/18 pass (9
  task/dependency/deletion + 9 event-store incl. the 2 new ones).
- `node --test test/event.test.mjs` (cli): 2/2 pass.
- `tests/event-lifecycle.test.ts` + `tests/event-policy.test.ts`: 11/11 pass.
- `npm run typecheck --workspace dataops-backend`: clean.
