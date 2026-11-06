import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { addPrivateInviteGuests, HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { PUBLIC_DTC_EVENTS_CALENDAR } from '../src/calendar/dapierBroker';

const eventKey = 'card:synthetic';
function provider(overrides: Record<string, unknown> = {}) {
  let event: any = {
    id: 'private-event', etag: '"version-1"', status: 'confirmed',
    iCalUID: `${createHash('sha256').update(eventKey).digest('hex')}@google.com`,
    organizer: { email: HOLD_ORGANIZER }, location: 'https://zoom.us/j/123456789',
    attendees: [{ email: 'existing@example.test', responseStatus: 'accepted' }],
    start: { dateTime: '2026-11-10T15:55:00Z' }, end: { dateTime: '2026-11-10T17:00:00Z' },
    ...overrides,
  };
  const patches: any[] = [];
  const deps = { credential: 'synthetic', connectionId: 'test', fetchImpl: (async (input: any, init: any = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/agent/token') return Response.json({ access_token: 'synthetic' });
    if (url.pathname.endsWith('/calendars/primary')) return Response.json({ id: HOLD_ORGANIZER });
    assert.equal(decodeURIComponent(url.pathname), `/calendar/v3/calendars/${HOLD_ORGANIZER}/events/private-event`);
    if (init.method === 'PATCH') {
      assert.equal(url.searchParams.get('sendUpdates'), 'all');
      assert.equal(init.headers['If-Match'], '"version-1"');
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body), ['attendees']);
      patches.push(body);
      event = { ...event, ...body };
    }
    return Response.json(event);
  }) as typeof fetch };
  return { deps, patches, current: () => event };
}

test('adds private invite speakers once, preserving accepted guests, time and Zoom', async () => {
  const google = provider();
  const before = google.current();
  const result = await addPrivateInviteGuests(eventKey, 'private-event', ['new@example.test'], google.deps);
  assert.deepEqual(result.added, ['new@example.test']);
  assert.deepEqual(google.current().attendees, [...before.attendees, { email: 'new@example.test' }]);
  assert.deepEqual(google.current().start, before.start);
  assert.equal(google.current().location, before.location);
  assert.deepEqual((await addPrivateInviteGuests(eventKey, 'private-event', ['new@example.test'], google.deps)).added, []);
  assert.equal(google.patches.length, 1);
});

for (const [name, overrides] of Object.entries({
  silent: { attendees: [] },
  publicCopy: { organizer: { email: PUBLIC_DTC_EVENTS_CALENDAR } },
  publicAttendee: { attendees: [{ email: PUBLIC_DTC_EVENTS_CALENDAR }] },
  wrongIdentity: { iCalUID: 'unrelated@google.com' },
  nonPrivate: { location: 'https://www.youtube.com/' },
})) {
  test(`refuses ${name} before any calendar mutation`, async () => {
    const google = provider(overrides);
    await assert.rejects(addPrivateInviteGuests(eventKey, 'private-event', ['new@example.test'], google.deps), /existing private Zoom invitation/);
    assert.equal(google.patches.length, 0);
  });
}
