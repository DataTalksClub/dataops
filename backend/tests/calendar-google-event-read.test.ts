import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { DEFAULT_HOLD_GOOGLE_CALENDARS, PUBLIC_DTC_EVENTS_CALENDAR, setDapierBrokerClientsForTests } from '../src/calendar/dapierBroker';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { HOLD_ZOOM_LOCATION } from '../src/calendar/holds';
import { saveCalendarOverlaySettings } from '../src/db/calendar';
import { holdGoogleProvider } from './helpers/hold-google';
import type { LambdaResponse } from '../src/types';

function invoke(pathName: string, query: Record<string, string> = {}): Promise<LambdaResponse> {
  const event = { httpMethod: 'GET', path: pathName, body: null, queryStringParameters: query };
  return handler(event, {});
}

const parse = (r: LambdaResponse): any => JSON.parse(r.body);

let client: DynamoDBDocumentClient;
const [PERSONAL] = DEFAULT_HOLD_GOOGLE_CALENDARS;
const DTC = PUBLIC_DTC_EVENTS_CALENDAR;

describe('Google event read-back (invite verification)', () => {
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await saveCalendarOverlaySettings(client, { connectionId: 'google-calendar' }, 'test-operator');
    // Keep unit tests offline: the broker secret is unreadable unless a test injects a credential.
    setDapierBrokerClientsForTests({
      readSecret: async () => {
        throw Object.assign(new Error('no aws in unit test'), { name: 'CredentialsProviderError' });
      },
    });
  });

  after(async () => {
    setCalendarHoldGoogleDepsForTests({});
    await stopLocal();
  });

  it('reads the live event on the organizer and every configured hold calendar, trimming internal provenance', async () => {
    const google = holdGoogleProvider();
    const description = `Zoom link: ${HOLD_ZOOM_LOCATION}\n\nWorkshop document: https://ops.dtcdev.click/webinar-docs/sdoc-synthetic`;
    for (const calendar of [HOLD_ORGANIZER, PERSONAL, DTC]) {
      google.events.set(calendar, new Map([['evt-live', {
        id: 'evt-live',
        status: 'confirmed',
        summary: 'Build a Media Agent',
        description,
        location: HOLD_ZOOM_LOCATION,
        start: { dateTime: '2026-11-03T15:25:00.000Z', timeZone: 'Europe/Berlin' },
        end: { dateTime: '2026-11-03T17:00:00.000Z', timeZone: 'Europe/Berlin' },
        extendedProperties: { private: { dataopsHoldId: 'hold_internal' } },
        attendees: [{ email: 'guest@example.com', responseStatus: 'accepted' }],
      }]]));
    }
    setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
    const res = await invoke('/api/calendar-holds/google-events/evt-live');
    assert.strictEqual(res.statusCode, 200, res.body);
    const body = parse(res);
    assert.strictEqual(body.eventId, 'evt-live');
    assert.deepStrictEqual(body.events.map((entry: any) => entry.calendar), [HOLD_ORGANIZER, DTC, PERSONAL]);
    for (const entry of body.events) {
      assert.strictEqual(entry.state, 'ok', JSON.stringify(entry));
      assert.strictEqual(entry.event.description, description);
      assert.strictEqual(entry.event.location, HOLD_ZOOM_LOCATION);
      assert.strictEqual(entry.event.summary, 'Build a Media Agent');
      assert.deepStrictEqual(entry.event.attendees, [{ email: 'guest@example.com', responseStatus: 'accepted' }]);
      assert.ok(!('extendedProperties' in entry.event), 'internal provenance must not leave the backend');
      if (entry.calendar === DTC) {
        assert.deepStrictEqual(entry.warnings, ['public_calendar_contains_zoom_link', 'public_calendar_contains_internal_link', 'public_calendar_contains_attendees']);
      }
    }
  });

  it('reads one calendar via ?calendar= and rejects calendars outside the hold set', async () => {
    const google = holdGoogleProvider();
    google.events.set(DTC, new Map([['evt-dtc', {
      id: 'evt-dtc', status: 'confirmed', description: `Zoom link: ${HOLD_ZOOM_LOCATION}`,
    }]]));
    setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });

    const res = await invoke('/api/calendar-holds/google-events/evt-dtc', { calendar: DTC });
    assert.strictEqual(res.statusCode, 200, res.body);
    const body = parse(res);
    assert.deepStrictEqual(body.events.map((entry: any) => entry.calendar), [DTC]);
    assert.strictEqual(body.events[0].state, 'ok');
    assert.strictEqual(body.events[0].event.description, `Zoom link: ${HOLD_ZOOM_LOCATION}`);

    const reject = await invoke('/api/calendar-holds/google-events/evt-dtc', { calendar: 'someone@example.com' });
    assert.strictEqual(reject.statusCode, 400, reject.body);
    assert.match(parse(reject).error, /not a DataOps hold calendar/);
  });

  it('reports gone for a 404 instead of an error', async () => {
    const google = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
    const res = await invoke('/api/calendar-holds/google-events/missing-event');
    assert.strictEqual(res.statusCode, 200, res.body);
    const body = parse(res);
    assert.ok(body.events.length >= 3);
    for (const entry of body.events) assert.strictEqual(entry.state, 'gone');
  });
});
