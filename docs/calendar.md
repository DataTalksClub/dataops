# Operations calendar

The operations calendar stores no activities of its own. It is a read-only projection over entities, and every entry links to the entity it comes from: an event Card (Templates of type webinar, workshop, course, book-of-the-week, maven-ll, office-hours and oss) on its anchor date, and a podcast episode on its recording date and its release date (cancelled episodes are left out). Podcast and newsletter Cards are not listed themselves: the episode and the newsletter issue stand for them, and newsletter issues come in through the newsletter overlay. An entry's title comes from the entity, for example the Card title and its people (`GraphRAG in Real-Life Use Cases · Daan Di Scala`). To move or rename an event, change its Card or episode; there is no calendar create, edit or delete. `GET /api/calendar-items?from=YYYY-MM-DD&to=YYYY-MM-DD` returns these entries, Berlin holiday layers, source freshness, and alerts for upcoming events that fall on a Berlin public or school holiday, for a bounded range of at most 366 days. Entries are date-only; "today" and every date are Europe/Berlin dates, whatever the viewer's own timezone.

Holiday source facts are shipped with the application and refreshed through authenticated `POST /api/calendar-items/holidays/sync`; requests never scrape upstream services. A complete generation is written under an immutable generation key before the current pointer is published, so malformed or interrupted refreshes retain the prior last-known-good generation. The sources are the [Berlin Public Holiday Act](https://gesetze.berlin.de/bsbe/document/jlr-FeiertGBErahmen) and the [official Berlin school-holiday order](https://www.berlin.de/sen/bjf/service/kalender/ferien/termine/). Range responses expose generation, freshness, stale, and out-of-horizon metadata.

The calendar grid shows Monday to Friday only, in both the month and week views and on mobile. Weekends are excluded on purpose, not by accident. Weekend events and newsletter dates are not dropped: they collapse into a small "+ weekend" note on the preceding Friday, which opens that weekend day's schedule. A month that starts on a Saturday or Sunday begins at its first workday; that leading weekend has no Friday in the grid, so its entries show as a "+ weekend" note on the first Monday instead, and the month's data range starts on the 1st so they are loaded.

The read-only `CalendarOverlayProvider` in `backend/src/calendar/overlays.ts` lets another feature project display-only records, such as newsletter issues and open event slots. The calendar table holds only holiday generations, dismissed alerts and the overlay settings.

Alexey's Google Calendar overlay (`backend/src/calendar/ownerCalendarOverlay.ts`) is a free/busy source, not a layer of events. On the calendar grid it projects only open event slots ("12:30 Available", "17:00 Available") on weekdays. Personal events such as vacations, flights and meetings never appear as calendar items: a timed event that overlaps a slot window closes that slot, and an all-day event (vacation, conference, flight) closes every slot on its days, so the day simply shows no open slot. Only the day schedule dialog (`includeAll`, or a single-day range) lists the individual events, so a planner can see why a slot is taken. When the source is not connected, the Available slots chip says so instead of implying the days are fully booked. Open slots are for planning ahead, so the overlay is read only from today (Berlin time) onward: past days never show an open slot, a range wholly in the past does not read the owner's calendar at all and shows no slot spinner, and a past day's schedule lists only what happened. Newsletters, webinars, podcasts and other real items still show on past days.

The private schedule workbook is no longer imported into the calendar. `backend/scripts/podcast-schedule.ts` still reads its podcast rows for `import-podcast-episodes.ts`, which writes podcast episodes.

## Holds (tentative reservations with Google Proposal mirrors)

`dataops calendar propose --date D --window evening|midday --duration N --title T --topic TOPIC [--card ID] [--expires-days 7]` creates a tentative hold, not a DataOps-only row. The backend stores the hold (`backend/src/calendar/holds.ts`: tentative/confirmed/released/expired, 7-day TTL by default) and mirrors it to Google Calendar through the Dapier broker (`backend/src/calendar/holdGoogleSync.ts`): one `(Proposal) <title>` event on each configured calendar (DTC events + personal Alexey). Confirming the hold (`dataops calendar confirm-hold <id>`) renames the Google events to drop the prefix; releasing or expiry (`dataops calendar release-hold <id>`, `POST /api/calendar-holds/expire`) deletes them.

DataOps is the source of truth: when the Dapier calendar broker is not ready, the hold is still stored and the response reports `googleSync: { state: "deferred", reason }` instead of failing — the CLI prints `Google sync deferred: <reason>` with the Dapier operator path. Expiry frees the slot and leaves Orin follow-up; it never emails the guest.

### Google calendar broker (through Dapier — required for Proposal mirrors)

Propose / podcast invite call Dapier like other headless agents: `POST https://dapier.dtcdev.click/api/agent/token` with agent `personal-scheduler` and connection `google-calendar`, then create `(Proposal)` events on **both** calendars required by SOP `sop.events.calendar.creating-tentative-event-on-google-calendar`:

- Alexey's personal calendar (`primary`)
- DataTalks.Club events (`f8qidjnq0jhscp8809k1eghs60@group.calendar.google.com`)

Defaults are those two ids. Override only with `DATAOPS_HOLD_GOOGLE_CALENDARS` (comma-separated calendar ids) when the calendar list itself is wrong — never put Dapier API tokens in Coolify or DataOps env.

**Where credentials live:** Google OAuth refresh tokens and connection grants live in **Dapier**. DataOps Lambda reads only the Dapier machine API token from AWS Secrets Manager secret `personal-scheduler/dapier-api-token` (same pattern as the owner-calendar overlay; IAM is already on the backend). Do **not** configure `PERSONAL_SCHEDULER_TOKEN` / `DATAOPS_HOLD_BROKER_TOKEN` on Coolify.

**Operator path (full operator; Orin runs propose after this works):**

```bash
dapier auth login
dapier connections list                    # need google-calendar connected
# If missing / expired:
dapier connections connect google-calendar --agent personal-scheduler
# Machine token for DataOps (once; value shown once):
dapier tokens create --name personal-scheduler --agent personal-scheduler
# Grant use (subject from create output is token:personal-scheduler):
printf '%s\n' '{"connection_id":"google-calendar","subject":"token:personal-scheduler","agent":"personal-scheduler","operations":["use"]}' > /tmp/grant-calendar-hold.json
dapier grants save /tmp/grant-calendar-hold.json
# Store the dap_… value in AWS SM personal-scheduler/dapier-api-token (JSON {api_token} or raw) in the account that hosts dataops-v1.
```

Then `dataops calendar propose …` / `dataops podcast invite …` should return `googleSync.state=synced` with `googleEventIds` for both calendars. Missing broker readiness must never be silent: the deferred reason points at this Dapier path.

Active holds project hard occupancy onto the overlays (`backend/src/calendar/holdOverlay.ts`, `calendar-holds` layer): covered owner-calendar available slots are suppressed, so a proposed podcast evening (17:00 Berlin, 60 min) cannot be double-booked. A 90-min evening hold is the workshop shape and starts 16:30. `--topic` is required on every new hold: the intended episode topic is recorded in DataOps at invite/propose time. `dataops podcast invite` uses the same endpoint for its one proposed slot (midday by default).
