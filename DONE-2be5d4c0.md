# DONE evidence — task 2be5d4c0 (wire Google calendar broker so propose/invite creates real Google Proposal blockers)

Verified against origin/main `ebf0fb18` (2026-11-05) in a dedicated worktree
(`fix/calendar-broker-verify`). This task's ask: `calendar propose` (the
propose command, Proposals in the CLI) should create a real Google Calendar
event marked as a Proposal blocker — the `(Proposal)`-titled tentative event —
via the calendar broker (`backend/src/calendar/dapierBroker.ts`, Dapier
connections).

## Verdict

**Already implemented on origin/main — no code change needed.** All three
"propose" paths write real Google events through the Dapier broker
(`holdGoogleSync.syncEvents`), and the `(Proposal)` blocker lands on the
Orin organizer calendar plus Alexey's personal calendar
(`alexey.s.grigoriev@gmail.com`, `DEFAULT_HOLD_GOOGLE_CALENDARS`,
`backend/src/calendar/dapierBroker.ts:29-31`). The broker credential is the
machine agent token (`personal-scheduler.dapier-api-token`, Dapier
`POST /api/agent/token`), and the calendar connection is the one Orin picks in
calendar settings (`calendarInviteDeps`, `backend/src/db/calendarHolds.ts:32-53`).
This PR is the verification record only.

There is no deprecated or orphaned CLI path: `dataops calendar propose` **is**
the hold propose endpoint — the same route the rest of the holds feature uses.
Help text documents this explicitly (Holds section,
`cli/src/commands/calendar.mjs:57-58`): "A hold is a tentative event
reservation: DataOps plus a Google `(Proposal)` event on the DTC and personal
calendars."

## Trace, path by path

### (a) `dataops calendar propose` (the calendar CLI)

1. CLI registration `propose: calendar.propose` — `cli/src/cli.mjs:115`
   (command block `cli/src/cli.mjs:107-126`); usage line
   `cli/src/commands/calendar.mjs:19`; arg parsing `proposeArgs`
   `cli/src/commands/calendar.mjs:727-755` (window/duration/topic/expires
   validation, `--card`, `--guest-ref`, `--document-url`).
2. `propose` posts to `/api/calendar-holds` —
   `cli/src/commands/calendar.mjs:768-778`, and prints
   `Google sync deferred: <reason>` when the broker leg defers
   (`:774-776`).
3. Backend route `POST /api/calendar-holds` → `createRoute` —
   `backend/src/routes/calendarHolds.ts:479-482`; `createRoute` body
   `:74-117`. Card-backed proposals are rejected if the Card already owns an
   invitation (`:77-82`).
4. `buildHold` constructs the record with the Proposal mirror title —
   `backend/src/calendar/holds.ts:310-349`:
   `googleTitle: proposalTitle(title)` (`:332`), where
   `HOLD_PROPOSAL_PREFIX = '(Proposal) '` (`:22`) and `proposalTitle`
   (`:222-224`). The Google leg starts `deferred` (`:334`,
   `reason: 'not-synced-yet'`).
5. **The Google write happens synchronously inside the propose request**:
   `createHoldGoogleEvents(googlePayload(hold, proposalTitle(hold.title),
   hold.startIso, hold.endIso), await calendarInviteDeps(body, client))` —
   `backend/src/routes/calendarHolds.ts:105-108`. The hold is then stored with
   the resulting `googleEventIds` and `googleSync` state (`:109-115`).
6. `createHoldGoogleEvents` → `syncEvents` —
   `backend/src/calendar/holdGoogleSync.ts:290-292` → `:171-288`:
   - mints a Google token via the broker: `POST
     {DAPIER_BASE_URL}/api/agent/token` with
     `{ connection_id, agent: 'personal-scheduler' }` (`:92-97`; constants in
     `backend/src/calendar/dapierBroker.ts:18-20`);
   - verifies the token's calendar is the Orin organizer before any write
     (`:202-205`, `HOLD_ORGANIZER = 'orin@datatalks.club'`, `:115`);
   - writes the `(Proposal)` event to `[HOLD_ORGANIZER, ...personal
     calendars]` (`:214-252`) — UID-import for silent personal copies,
     organizer PATCH last; `eventBody` (`:156-169`) sets
     `summary: event.summary` (the `(Proposal) …` title).
   - On any broker/Google failure the hold stays stored locally and the
     Google leg is recorded `deferred` with an operator-actionable reason
     (`:177-183`, `:283-287`) — propose never fails because Google is down.
7. Connection resolution: `calendarInviteDeps` reads `connectionId` from
   DataOps calendar settings (Orin's pick) —
   `backend/src/db/calendarHolds.ts:32-53`; machine credential from the team
   store via `readDapierCredential` —
   `backend/src/calendar/dapierBroker.ts:103-113`.

### (b) Hold propose on Cards (`calendar propose --card ID`)

Same `createRoute` with a Card guard against double-invites
(`backend/src/routes/calendarHolds.ts:77-82`). Confirming such a hold
delegates to the Card invite path `syncCardInvite`
(`backend/src/routes/calendarHolds.ts:231-249`; implementation
`backend/src/calendar/cardInvite.ts:244`, which uses the same
`createHoldGoogleEvents`/`updateHoldGoogleEvents` primitives imported at
`backend/src/calendar/cardInvite.ts:12`). Prod holds show this exact shape:
Card-backed holds carry `googleEventIds` on
`orin@datatalks.club` + personal + public calendars with
`googleSync.state = 'synced'`.

### (c) Unified event lifecycle propose (`dataops event propose`)

1. CLI `propose` → `POST /api/events/{target}/propose` —
   `cli/src/commands/event.mjs:107-116`; help `:7-27`.
2. Route dispatch → `proposeEvent` —
   `backend/src/routes/events.ts:123-155` (`:144-145`).
3. `proposeEvent` → `runTransition('propose')` —
   `backend/src/events/service.ts:857-870` → `:654-825`; the planned
   operation's `desired.summary` is rendered from the Card Template's
   `eventPolicy.titles.proposed` (`backend/src/events/lifecycle.ts:165-179`,
   `:168`), and policy validation **requires** the proposed title to contain
   `(Proposal)` (`backend/src/events/policy.ts:62-65`).
4. The Google write: `reconcileEventOperation` →
   `createHoldGoogleEvents` / `updateHoldGoogleEvents` with
   `extendedProperties.private` hold/card/generation metadata —
   `backend/src/events/service.ts:379-457` (`:448-456`). Same broker, same
   `syncEvents` as (a).

## Tests cited and run (all green in this worktree)

- `backend/tests/calendar-holds.test.ts` (14 pass) — POST
  `/api/calendar-holds` creates the tentative hold with
  `googleTitle === "(Proposal) GraphRAG workshop"` (`:86-105`, `:96`); the
  broker-deferral contract: no connection selected / Dapier `use` grant
  missing → hold stored, Google leg deferred with reason (`:61-84`);
  `proposalTitle`/`confirmedTitle` prefix lifecycle (`:387-389`); personal
  calendars only (`:364`).
- `backend/tests/calendar-invite-sop.test.ts` (10 pass) — the end-to-end
  SOP contract with a fake Google provider: **"propose → confirm → release:
  Orin organizer, personal block, one normal invitation"** (`:50-102`)
  asserts `googleSync.state === 'synced'` right after propose (`:58`), event
  ids on `HOLD_ORGANIZER` + personal calendars (`:59`), `(Proposal)` summary
  on every written Google event (`:60-73`), token calls carry
  `connection_id: 'orin-selected'` + `agent: 'personal-scheduler'`
  (`:100-101`); wrong Google identity rejected before any write (`:104-112`);
  partial-copy recovery (`:114-134`).
- `backend/tests/hold-google-copies.test.ts` (17 pass) — broker write
  semantics: imports for personal copies, silent PATCHes, organizer-only
  invitation, public-calendar refusal.
- `backend/tests/event-lifecycle.test.ts` (8 pass) and
  `backend/tests/event-service.test.ts` (2 pass) — unified lifecycle,
  including the podcast full lifecycle "syncs Card, Episode, Google
  calendars, emails, tasks" (AC3/AC4/AC5/AC7/AC9 test).
- `cli/test/calendar.test.mjs` (32 pass) — CLI `calendar propose` posts the
  hold payload with evening/60/+7d defaults (`:677-703`), workshop flags with
  `--card` (`:704-725`), client-side validation (`:726-739`).

Test commands (repo root `backend/`):

```
NODE_ENV=test FRONTEND_ROOT=../frontend SKIP_AUTH=true \
  node --import tsx --test --test-force-exit tests/calendar-holds.test.ts \
       tests/calendar-invite-sop.test.ts tests/hold-google-copies.test.ts \
       tests/event-lifecycle.test.ts tests/event-service.test.ts
node --test cli/test/calendar.test.mjs   # from the repo root
```

## Read-only prod corroboration (2026-11-05)

`dataops calendar holds --json` (GET only, no writes): 19 holds total,
16 with `googleSync.state = 'synced'`, 3 deferred. Six holds carry a
`(Proposal)` googleTitle together with real `googleEventIds` — e.g.
`hold_109132fd3e13` (Card `b4a90396-…`, workshop, later confirmed) holds
Google event ids on `orin@datatalks.club`,
`alexey.s.grigoriev@gmail.com` and the public DTC events calendar.
Propose-created Proposal blockers exist in prod exactly as designed.

## Remaining gaps

None for this ask. Two observations, both already by-design:

1. When the broker credential/connection is unavailable, propose still
   succeeds and stores the hold with `googleSync.state = 'deferred'`
   (`holdGoogleSync.ts:177-187`, CLI prints the reason) — recovery is retry
   confirm/move, which PATCHes or re-creates the mirrors
   (`routes/calendarHolds.ts:216-254`). DataOps stays the source of truth on
   purpose.
2. The deferred-then-confirmed hold `hold_c3d15b7c-…` in prod shows the
   deferred path leaves `googleEventIds` present but not synced until a
   retry — matching the documented behaviour above.
