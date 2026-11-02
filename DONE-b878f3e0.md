# DONE evidence — intake b878f3e0 (invite label by event type, DataOps doc link, live verification)

The AC1/AC2 fix landed 2026-10-29 (commit `c6c117ca`). This file records the
2026-11-02 verification-gap closure: a live read of the invite event on all
three calendars, the read-back tooling built for it, and the reply to Orin.

- AC1 label follows the type: `holdDocumentLabel` maps the Card's Template type
  (podcast/webinar/workshop) to `Podcast document` / `Webinar document` /
  `Workshop document`, falls back to the type named in a Card-less hold title,
  and defaults to `Event document`; `syncCardInvite` passes the Template type.
  Commit `c6c117ca`; tests "labels a Card invite by its Template type …" and
  "falls back to a neutral label for untyped events"
  (`backend/tests/calendar-invite-sop.test.ts`, 10/10 pass on the deployed head).
- AC2 Card DataOps doc wins: `cardGuestDocument` prefers the Card's own
  portal-hosted doc (`/webinar-docs/…`, `/workshop-docs/…`, `/podcast-docs/…`,
  `/guest-docs/…`) over any supplied `--document-url` Google Doc. Same commit
  and test; the test asserts the Card doc over a supplied
  `docs.google.com/document/d/old-doc/edit`.
- AC3 live proof (2026-11-02, deployed head `3c823165`, Deploy DataOps V1
  Lambda run 41450774123): `dataops calendar google-event
  10399ad9dc4432a31541e12f42a6f43ee69fcced427986222094a32314aa1b1f` reads the
  event through the deployed API on every hold calendar. All three copies —
  `orin@datatalks.club` (organizer), `alexey.s.grigoriev@gmail.com`, and the
  DTC events calendar `f8qidjnq0jhscp8809k1eghs60@group.calendar.google.com` —
  report `confirmed — Build a Media Agent: CPU Agent, GPU Models as Tools`
  with description `Zoom link: https://zoom.us/j/94755324762` +
  `Workshop document: https://ops.dtcdev.click/workshop-docs/sdoc-1eda0adc879493da`,
  Zoom kept as location, organizer attendees `alexey@datatalks.club` +
  `alexey.s.grigoriev@gmail.com`. No `Podcast document`, no `docs.google.com`.
  The doc path is the Card's current `Workshop document` link; the intake's
  `webinar-docs` path is where that link pointed on 10-29 (both URLs serve 200).
  The read-back route/CLI were added for exactly this check
  (`GET /api/calendar-holds/google-events/:eventId`, commit `084b0c80`;
  `dataops calendar google-event`, `b32fba95`).
- AC3 repair trail: the DTC copy had gone stale in Google (cancelled/missing)
  and was re-imported through the normal `cards time` sync. The first repair
  attempt exposed a real bug — `cards time` silenced guests for any Card with a
  Luma link and patched the organizer with empty attendees, which made Google
  drop Alexey and his calendar copy. Fixed in `3c823165` (a hold-linked Card
  keeps its guests; `cardHasHoldInvite`; regression test re-times a hold-linked
  Luma Card and asserts attendees survive the organizer PATCH), deployed, and
  the invite was restored with `cards time --guests alexey@datatalks.club`
  (Alexey is the only guest; a resend is fine per the AC).
- En route, main was red: `12d56695`'s contra-expense refund branch only ran
  for income-recorded rows, failing the credit-note and finance-summary suites
  (and every deploy since). `bf84f4ea` applies the branch however the row's
  entryType was recorded; the peer's own regression tests then pass
  (22/22 credit-notes+finance-summary, 82/82 wider finance/bookkeeping).
- AC4: backend suites on the pushed heads — calendar-invite-sop 10/10,
  calendar-google-event-read 3/3, card-calendar-invites + card-event-time +
  course-event-slots 38/38, CLI calendar suite 22/22. Deploys: run 41447551448
  succeeded for `bf84f4ea`, run 41450774123 succeeded for `3c823165`.
  Reply to Orin: Task `b696e50e-596e-489b-b8d4-fc93ae43a51e` (assigned to Orin,
  due 2026-11-02) carries the intake id, the commits, and the live check with
  both URLs as materials, and asks Orin to confirm their calendar copy from
  their side (the verifier noted Orin's confirmation covers the orin copy).
  The portal has no outbound email transport, so the assigned follow-up Task
  is the reply channel; it is readable with `dataops tasks show b696e50e`.
