# DONE evidence — task 60cff605 (calendar invite SOP alignment: Orin sender, title lifecycle, no hold leak)

Verified against origin/main `e071abf1` (2026-11-05) in a dedicated worktree.
All three asks are already implemented and covered by the existing suites; no
code change was needed. This file is the evidence record.

## (a) Orin sender — DONE

Invites and holds are always organized/sent by `orin@datatalks.club`
(`HOLD_ORGANIZER`); the personal calendars hold silent copies.

- `backend/src/calendar/holdGoogleSync.ts:114-115` —
  `export const HOLD_ORGANIZER = 'orin@datatalks.club'` ("Orin owns the event;
  SOP target calendars contain copies of that same event").
- `backend/src/calendar/holdGoogleSync.ts:201-205` — pre-write identity guard:
  the broker connection must authenticate as `HOLD_ORGANIZER` (checked against
  `calendars/primary`), otherwise the Google leg defers with "Calendar
  invitations require the Orin Google Calendar connection."
- `backend/src/calendar/holdGoogleSync.ts:240-245` — every import posts
  `organizer: { email: HOLD_ORGANIZER }`; `:247-249` re-verifies after write
  that `current.organizer?.email` is Orin and the `iCalUID` matches.
- `backend/src/calendar/holdGoogleSync.ts:277-280` — only the organizer PATCH
  sends updates (`sendUpdates=all` when attendees exist); copies are patched
  with `sendUpdates=none`, so the guest email comes from Orin alone.
- The unified event lifecycle rides the same path:
  `backend/src/events/service.ts:30,427-456` renders `op.desired` into the same
  `createHoldGoogleEvents`/`updateHoldGoogleEvents`, and `:583,:1036-1048` key
  acceptance polling on `googleEventIds[HOLD_ORGANIZER]`.
- Tests: `backend/tests/calendar-invite-sop.test.ts:59,67` (every copy reports
  `organizer.email === HOLD_ORGANIZER`), `:80-82` (exactly one
  `sendUpdates=all` PATCH and it targets the Orin calendar), `:104-112`
  (a personal Gmail connection is rejected before any event write);
  `backend/tests/hold-google-copies.test.ts:22,74` (token identity and import
  `organizer` stay orin).

## (b) Title lifecycle — DONE

Defined lifecycle: proposed → `(Proposal) {title}`; confirmed → prefix
dropped; rescheduled → proposed again (`(Proposal) {title}`, Google identity
kept, attendee responses reset); released/expired → Google blocks cancelled.

- Hold path: `backend/src/calendar/holds.ts:22` (`HOLD_PROPOSAL_PREFIX`),
  `:222-228` (`proposalTitle`/`confirmedTitle`, normalizing both SOP proposal
  spellings), `:332` (create stores `googleTitle = proposalTitle(title)`),
  `:356-367` (`confirmHoldRecord` → `googleTitle = confirmedTitle(hold.title)`).
  A hold move re-proposes: `backend/src/routes/calendarHolds.ts:368,379`
  (`googleTitle = proposalTitle(rebuilt.title)`).
- Unified event path: `backend/src/events/policy.ts:63,65` — `titles.proposed`
  must include `(Proposal)`, `titles.approved` must not; `lifecycle.ts:116,136`
  — reschedule puts the record back to `status: 'proposed'`; `lifecycle.ts:168`
  — `summary: render(approved ? policy.titles.approved : policy.titles.proposed)`;
  `events/service.ts:444` + `holdGoogleSync.ts:41-42,163,260` — reschedule
  resets attendee `responseStatus` to `needsAction` so prior accepts cannot
  carry over.
- KB (read-only) defines the same lifecycle:
  `reference.events.calendar.calendar-hold-lifecycle` — States table
  (`tentative` → Google title `(Proposal) {title}`; `confirmed` → Proposal
  prefix dropped; `released`/`expired`), flow step 2: "A reschedule moves the
  event, its hold and its Google events together and keeps the hold's status: a
  tentative (proposed) slot stays proposed until the guest approves the new
  time." `sop.events.calendar.creating-tentative-event-on-google-calendar` —
  "DataOps stores the plain title; Google titles are `(Proposal) {title}` while
  tentative"; confirm-hold "drops the Proposal prefix".
- Tests: `backend/tests/calendar-invite-sop.test.ts:53-57` (propose with
  `Proposed - ` input → `googleTitle === '(Proposal) Guest at DataTalks.Club
  Podcast'`), `:75-78` (confirm → plain title), `:263-267` (both spellings
  normalize); `backend/tests/calendar-holds.test.ts:96,150`; unified path
  `backend/tests/event-service.test.ts:420` (propose → `(Proposal) Podcast:
  Ian Whitestone - Agentic Data Stack`), `:474` (approve drops the prefix),
  `:511-519` (reschedule → status proposed, same Google event ids, summary
  back to `(Proposal) …`, Zoom location cleared).

## (c) No hold leak — DONE

Tentative hold events carry nothing guest-facing; details exist only on the
confirmed invite, and the public calendar is walled off.

- Tentative payloads are empty of guest details:
  `backend/src/routes/calendarHolds.ts:64-71` — `googlePayload` has
  `description: ''`, no location, no attendees; create syncs exactly that
  (`:104-105`). Zoom, document link and attendees enter only at confirmation
  via `confirmedHoldInvite` (`:229`; `backend/src/calendar/holds.ts:91-115`).
- Never Meet/conference data: `backend/src/calendar/holdGoogleSync.ts:156-169`
  — `eventBody` has no `conferenceData` field at all (header `:8-9`: "never
  Google Meet (no conferenceData is ever sent)"); test
  `calendar-invite-sop.test.ts:72` asserts `!('conferenceData' in event)`.
- Wrong-calendar guards: `holdGoogleSync.ts:179-181` — holds/invites refuse the
  public DTC events calendar as a target; `:207-209` — `primary`/organizer
  calendar refused as a copy target (copies must name personal calendars
  explicitly); `backend/src/calendar/cardInvite.ts:273-274` — a legacy
  public-calendar attendee copy is stripped from invite event ids; public
  adoption refuses attendees/Zoom/internal links
  (`cardInvite.ts:457-465`); `syncLumaCalendarEvents` rejects private meeting
  or document details in subtitle/description and leaves a public event with
  attendees or Zoom untouched (`holdGoogleSync.ts:334,368-370,391-393`).
- Copies never email: copy PATCH omits `attendees`/`guestsCanModify` and uses
  `sendUpdates=none` (`holdGoogleSync.ts:277-280`;
  `hold-google-copies.test.ts:114-117`); each copy's sole attendee is its own
  calendar (import constraint) so no real guest is ever added to a copy
  (`holdGoogleSync.ts:224-245`; `hold-google-copies.test.ts:75-100`).
- Description hygiene and identity: the confirmed description is exactly
  `Zoom link: …` + the single named guest document, and must not match
  `/DataOps|hold_|tentative|confirmed/` (`calendar-invite-sop.test.ts:87-88`);
  the hold id never reaches Google — the event key is a sha256 hash
  (`holdGoogleSync.ts:211`; test `:71`); the hold payload is rejected if it
  would contain the hold id (`:71`).
- Acceptance cannot leak across times: reschedule resets attendee responses to
  `needsAction` (`holdGoogleSync.ts:41-42,163,260`; `events/service.ts:444`).

## Test results (this worktree, origin/main e071abf1, Node v24.14.0)

- `backend/tests/calendar-invite-sop.test.ts` — 10/10 pass
- `backend/tests/hold-google-copies.test.ts` — 5/5 pass
- `backend/tests/card-calendar-invites.test.ts` — 18/18 pass

## Remaining gaps

None for (a)/(b)/(c). Informational only: the KB SOP records auto-confirm on
guest calendar acceptance (proposal → accept → final invite without manual
`confirm-hold`) as a known, separately tracked gap (Hub intake
`dataops-podcast-template-eventpolicy-20261102`, noted in the SOP's "Intended
process" section) — outside this task's three asks.
