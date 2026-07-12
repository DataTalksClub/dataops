# Operations calendar

The authenticated operations calendar stores non-newsletter activities in the dedicated calendar table. `GET /api/calendar-items?from=YYYY-MM-DD&to=YYYY-MM-DD` returns activities, Berlin holiday layers, source freshness, and stable planning alerts for a bounded range of at most 366 days. Timed values are UTC instants with `timeZone: Europe/Berlin`; all-day values stay date-only.

Holiday source facts are shipped with the application and refreshed through authenticated `POST /api/calendar-items/holidays/sync`; requests never scrape upstream services. A complete generation is written under an immutable generation key before the current pointer is published, so malformed or interrupted refreshes retain the prior last-known-good generation. The sources are the [Berlin Public Holiday Act](https://gesetze.berlin.de/bsbe/document/jlr-FeiertGBErahmen) and the [official Berlin school-holiday order](https://www.berlin.de/sen/bjf/service/kalender/ferien/termine/). Range responses expose generation, freshness, stale, and out-of-horizon metadata.

The read-only `CalendarOverlayProvider` in `backend/src/calendar/overlays.ts` lets another feature project display-only records. Providers do not gain calendar CRUD access and their records are never persisted in the calendar table.

## Private workbook migration

Dry-run is the default and makes no network calls:

```sh
npm --prefix backend run calendar:import -- "$HOME/tmp/schedule.xlsx"
```

Writing requires an exact target confirmation and either a complete deployed-portal credential pair or a session token. Portal credentials use Basic auth through the single-origin `/work/api` route for both writes and bounded verification reads. A half-configured pair fails before any network request. The script uses only `Time table` and `Extra podcast slots`, deterministic source keys, bounded retries, and API verification:

```sh
CALENDAR_IMPORT_API=https://example.invalid \
CALENDAR_IMPORT_CONFIRM=https://example.invalid \
CALENDAR_IMPORT_PORTAL_USERNAME=... \
CALENDAR_IMPORT_PORTAL_PASSWORD=... \
npm --prefix backend run calendar:import -- "$HOME/tmp/schedule.xlsx" --write
```

For a direct API target, set `CALENDAR_IMPORT_TOKEN` instead of the portal username/password pair; this retains Bearer session authentication on `/api/calendar-items`.

Keep the workbook and import reports in Git-ignored local storage. Output contains coordinates and reason-code counts, never cell contents.
