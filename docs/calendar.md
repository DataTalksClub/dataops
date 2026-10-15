# Operations calendar

The authenticated operations calendar stores non-newsletter activities in the dedicated calendar table. `GET /api/calendar-items?from=YYYY-MM-DD&to=YYYY-MM-DD` returns activities, Berlin holiday layers, source freshness, and stable planning alerts for a bounded range of at most 366 days. Timed values are UTC instants with `timeZone: Europe/Berlin`; all-day values stay date-only. The frontend always shows times in Europe/Berlin, whatever the viewer's own timezone, through the helpers in `frontend/src/surfaces/calendar-time.js` (grid chips, the day schedule dialog, the activity form); never slice the hour out of the UTC string.

Holiday source facts are shipped with the application and refreshed through authenticated `POST /api/calendar-items/holidays/sync`; requests never scrape upstream services. A complete generation is written under an immutable generation key before the current pointer is published, so malformed or interrupted refreshes retain the prior last-known-good generation. The sources are the [Berlin Public Holiday Act](https://gesetze.berlin.de/bsbe/document/jlr-FeiertGBErahmen) and the [official Berlin school-holiday order](https://www.berlin.de/sen/bjf/service/kalender/ferien/termine/). Range responses expose generation, freshness, stale, and out-of-horizon metadata.

The calendar grid shows Monday to Friday only, in both the month and week views and on mobile. Weekends are excluded on purpose, not by accident. Weekend activities and newsletter dates are not dropped: they collapse into a small "+ weekend" note on the preceding Friday, which opens that weekend day's schedule. A month that starts on a Saturday or Sunday begins at its first workday; that leading weekend has no Friday in the grid, so its entries show as a "+ weekend" note on the first Monday instead, and the month's data range starts on the 1st so they are loaded.

The read-only `CalendarOverlayProvider` in `backend/src/calendar/overlays.ts` lets another feature project display-only records. Providers do not gain calendar CRUD access and their records are never persisted in the calendar table.

Alexey's Google Calendar overlay (`backend/src/calendar/alexeyCalendarOverlay.ts`) is a free/busy source, not a layer of events. On the calendar grid it projects only open event slots ("12:30 Available", "17:00 Available") on weekdays. Personal events such as vacations, flights and meetings never appear as calendar items: a timed event that overlaps a slot window closes that slot, and an all-day event (vacation, conference, flight) closes every slot on its days, so the day simply shows no open slot. Only the day schedule dialog (`includeAll`, or a single-day range) lists the individual events, so a planner can see why a slot is taken. When the source is not connected, the Available slots chip says so instead of implying the days are fully booked.

The workbook importer skips holiday reminders typed into activity columns (for example "School Autumn holidays (…)") with the reason `holiday-notice`. Holidays come from the holiday layers, never from activities.

## Private workbook import

Dry-run is the default and makes no network calls:

```sh
npm --prefix backend run calendar:import -- "$HOME/tmp/schedule.xlsx"
```

Writing requires an exact target confirmation and an existing non-browser bearer session token. The token is validated independently from browser OAuth and is used for both writes and bounded verification reads. The script uses only `Time table` and `Extra podcast slots`, deterministic source keys, bounded retries, and API verification:

```sh
CALENDAR_IMPORT_API=https://example.invalid \
CALENDAR_IMPORT_CONFIRM=https://example.invalid \
CALENDAR_IMPORT_TOKEN=... \
npm --prefix backend run calendar:import -- "$HOME/tmp/schedule.xlsx" --write
```

The importer calls `/api/calendar-items`; a browser OAuth cookie is neither accepted nor required by this machine client.

Keep the workbook and import reports in Git-ignored local storage. Output contains coordinates and reason-code counts, never cell contents.
