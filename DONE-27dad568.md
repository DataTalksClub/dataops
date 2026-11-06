# DONE evidence — intake 27dad568 (AISHL cards: no cards-time invites/Zoom; invite remove --delete-event; future cards time -> asl events)

All three parts were verified against current origin/main (81e183bf). Parts A and B
were already implemented and landed on main by earlier work (8f7fe89b, 2026-10-31,
plus the follow-up routing fix cf1b429a, 2026-11-01). This session re-verified every
acceptance criterion and re-ran the targeted tests. No product code changes were
needed. Part C needs cross-repo work (see below).

- **Part A — AISHL cards: no cards-time invites/Zoom: landed.**
  AISHL cards are identified by their Template `type`:
  `AISHL_TEMPLATE_TYPE = 'aishl-workshop'` (`backend/src/calendar/cardInvite.ts:25`).
  `syncCardInvite` resolves the Card's template and routes any `cards time` /
  confirm-hold on an AISHL card to `setSiteScheduledTime` before any Google or Zoom
  write (`backend/src/calendar/cardInvite.ts:250-251`); `setSiteScheduledTime`
  records the date-only time on the Card with `googleEventIds: {}` and never calls
  Google (`backend/src/calendar/cardInvite.ts:390-406`). Zoom is not a separate API:
  the guest invite's Zoom link is `HOLD_ZOOM_LOCATION`
  (`backend/src/calendar/holds.ts:37`) written into the Google event by
  `confirmedHoldInvite`, so no Google event means no Zoom invite. The confirm-hold
  path is covered too: `backend/src/routes/calendarHolds.ts:232` routes a
  card-linked hold through the same `syncCardInvite` gate. The opt-out follows the
  same "special-case the invite sync in syncCardInvite" mechanism the podcast and
  silent-Luma card types use. Tests:
  `backend/tests/card-calendar-invites.test.ts:226` ("cards time on an AISHL card
  sets the time but never calls Google", asserts `google.calls.length === 0`) and
  the template-type routing tests added by cf1b429a.

- **Part B — `dataops cards invite remove --delete-event`: landed.**
  CLI parses `--delete-event` and sends `deleteEvent: true` on the DELETE request
  (`cli/src/commands/cards.mjs:35`, `398-402`); the backend route reads
  `deleteEvent === true` and passes deps to `unlinkCardInvite`
  (`backend/src/routes/cards.ts:937`, `945-946`); `unlinkCardInvite` deletes the
  Google event(s) first with `sendUpdates: 'none'` (no guest notification) and
  unlinks only once Google confirms, clearing owned ids from `eventTime`
  (`backend/src/calendar/cardInvite.ts:527-556`). Default behaviour without the
  flag is unchanged: the Google event is untouched, and a live cards-time-owned
  invite is refused with a pointer to `--delete-event`
  (`backend/src/calendar/cardInvite.ts:535-537`). Tests:
  `cli/test/cards-invite.test.mjs:10` ("invite remove --delete-event explicitly
  deletes only the selected calendar copy") and
  `backend/tests/card-calendar-invites.test.ts:165` ("--delete-event deletes the
  Google event silently, then unlinks it"), `:187` (public standalone events are
  refused through this path), `:139`/`:155` (owned-invite guard, stale removal).

- **Part C — future cards time surfaces as ASL events: needs cross-repo work.**
  "ASL events" are the AI Shipping Labs site's event catalog
  (`ai-shipping-labs` Django app `events`, managed with the `asl` CLI from
  `ai-shipping-labs/asl_cli`: `asl events list/get/create/update` with
  `--start-datetime`, `--end-datetime`, `--timezone`, `--platform zoom`,
  `--create-zoom/--no-create-zoom`, `--publish/--no-publish`; AISHL workshops
  exist there as events, e.g. slug `aishl-workshop-tracing`). The dataops repo has
  no ASL wiring at all: no ASL API client, base URL, credential or env var
  (the only mention of ai-shipping-labs in dataops source is a comment about
  booking-parity defaults in `backend/src/calendar/ownerCalendarOverlay.ts:71`),
  and no Card↔ASL-event linkage. Making future AISHL cards-time surface as ASL
  events needs, in the `ai-shipping-labs`/dataops pairing:
  1. a Card→ASL-event mapping (e.g. the ASL event slug saved as a Card link,
     mirroring `lumaUrlForCard` in `backend/src/calendar/lumaEvents.ts`);
  2. an ASL API credential + base URL configured for the DataOps backend;
  3. a write in `setSiteScheduledTime` (`backend/src/calendar/cardInvite.ts:390`)
     that creates/updates the ASL event with start/end/timezone, with deferral
     semantics consistent with the Google sync path (`sync.state: 'deferred'`).
  The zero-code alternative is an operational SOP (run
  `asl events update <slug> --start-datetime …` after `dataops cards time` on an
  AISHL card); product decision needed on which option and whether cards time
  should update an existing ASL event or create one.

- **Verification:** targeted tests on this branch (identical to origin/main for
  these files): `backend/tests/card-calendar-invites.test.ts` 18/18 pass;
  `cli/test/cards-invite.test.mjs` 8/8 pass (node v24.14.0). Worktree:
  `.tmp/worktrees/aishl-no-zoom/dataops`.
