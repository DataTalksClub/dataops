import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardEventInterval } from '../src/calendar/cardEventTime';
import { confirmedHoldInvite } from '../src/calendar/holds';

test('Card event time supports arbitrary minutes and Berlin winter/summer; invite is T-5..end', () => {
  for (const [at, start] of [['2026-11-09 14:30', '2026-11-09T13:30:00.000Z'], ['2026-07-09 14:37', '2026-07-09T12:37:00.000Z']]) {
    const interval = cardEventInterval(at);
    assert.equal(interval.startIso, start);
    const invite = confirmedHoldInvite({ id: 'test', title: 'Podcast', guestRef: 'guest@example.test', ...interval });
    assert.equal(Date.parse(invite.startIso), Date.parse(start) - 300000);
    assert.equal(Date.parse(invite.endIso), Date.parse(start) + 3600000);
  }
});
test('IANA time zones and elapsed duration across DST', () => {
  const interval = cardEventInterval('2026-03-29 01:30', 120);
  assert.equal(interval.startIso, '2026-03-29T00:30:00.000Z');
  assert.equal(interval.endIso, '2026-03-29T02:30:00.000Z');
  assert.equal(cardEventInterval('2026-11-09 14:30', 90, 'America/New_York').startIso, '2026-11-09T19:30:00.000Z');
});
test('reject invalid dates, DST gaps/folds, invalid zone and duration', () => {
  for (const at of ['2026-02-30 12:00', '2026-03-29 02:30', '2026-10-25 02:30', '2026-01-01 24:30', 'tomorrow']) {
    assert.throws(() => cardEventInterval(at));
  }
  assert.throws(() => cardEventInterval('2026-11-09 14:30', 0));
  assert.throws(() => cardEventInterval('2026-11-09 14:30', 60, 'invalid'));
});

import { before, after, describe } from 'node:test';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTemplate } from '../src/db/templates';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { holdGoogleProvider } from './helpers/hold-google';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { HOLD_ZOOM_LOCATION } from '../src/calendar/holds';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

async function invoke(method: string, path: string, body?: unknown, queryStringParameters = {}) {
  const res = await handler({ httpMethod: method, path, body: body ? JSON.stringify(body) : null, queryStringParameters }, {});
  return { code: res.statusCode, data: JSON.parse(res.body), raw: res.body };
}
let db: DynamoDBDocumentClient;
describe('Card-owned invitation lifecycle', () => {
  before(async () => {
    db = await getClient(await startLocal());
    await createTables(db);
  });
  after(async () => { setCalendarHoldGoogleDepsForTests({}); await stopLocal(); });
  async function card(type: string) {
    const template = await createTemplate(db, { name: type, type, triggerType: 'manual', taskDefinitions: [
      { refId: 'create-calendar-invite', description: 'Create a calendar invite for the guests', offsetDays: 0 },
    ] });
    const result = await invoke('POST', '/api/cards', { templateId: template.id, title: `Test ${type}`, anchorDate: '2026-11-09' });
    assert.equal(result.code, 201, result.raw);
    return result.data.card;
  }
  function google() {
    const provider = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ fetchImpl: provider.fetchImpl, credential: 'test', connectionId: 'orin', calendarIds: ['dtc@example.test', 'personal@example.test'] });
    return provider;
  }
  test('first time creates invite, changing time PATCHes same event with updates; task auto-closes', async () => {
    const provider = google();
    const c = await card('webinar');
    const task = (await invoke('GET', '/api/tasks', undefined, { cardId: c.id })).data.tasks[0];
    assert.equal((await invoke('PUT', `/api/tasks/${task.id}`, { expectedVersion: task.version, status: 'done' })).code, 400);
    const first = await invoke('POST', `/api/cards/${c.id}/time`, { at: '2026-11-09 14:30', guestEmails: ['guest@example.test'] });
    assert.equal(first.code, 200, first.raw);
    const id = first.data.card.eventTime.googleEventIds[HOLD_ORGANIZER];
    const event = provider.events.get(HOLD_ORGANIZER)!.get(id);
    assert.equal(event.start.dateTime, '2026-11-09T13:25:00.000Z');
    assert.equal(event.end.dateTime, '2026-11-09T14:30:00.000Z');
    assert.equal(event.location, HOLD_ZOOM_LOCATION);
    assert.ok(event.attendees.some((a: any) => a.email === 'guest@example.test'));
    assert.ok(first.data.card.calendarInvites.find((i: any) => i.eventId === id).url);
    assert.equal((await invoke('GET', `/api/tasks/${task.id}`)).data.status, 'done');
    const second = await invoke('POST', `/api/cards/${c.id}/time`, { at: '2026-11-10 16:47', duration: 90 });
    assert.equal(second.code, 200, second.raw);
    assert.equal(second.data.card.eventTime.googleEventIds[HOLD_ORGANIZER], id);
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 1);
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.get(id).start.dateTime, '2026-11-10T15:42:00.000Z');
    const patches = provider.calls.filter(call => call.method === 'PATCH' && call.url.pathname.includes(encodeURIComponent(HOLD_ORGANIZER)));
    assert.ok(patches.length >= 2);
    assert.ok(patches.every(call => call.url.searchParams.get('sendUpdates') === 'all'));
  });
  test('podcast confirm-hold uses same stored event for later Card time changes', async () => {
    const provider = google();
    const c = await card('podcast');
    const proposed = await invoke('POST', '/api/calendar-holds', { date: '2026-11-09', title: 'Test podcast', topic: 'Test', cardId: c.id, guestRef: 'guest@example.test' });
    assert.equal(proposed.code, 201, proposed.raw);
    const confirmed = await invoke('POST', `/api/calendar-holds/${proposed.data.hold.id}/confirm`, {});
    assert.equal(confirmed.code, 200, confirmed.raw);
    const id = confirmed.data.hold.googleEventIds[HOLD_ORGANIZER];
    const moved = await invoke('POST', `/api/cards/${c.id}/time`, { at: '2026-11-09 14:37' });
    assert.equal(moved.code, 200, moved.raw);
    assert.equal(moved.data.card.eventTime.googleEventIds[HOLD_ORGANIZER], id);
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 1);
    const tasks = (await invoke('GET', '/api/tasks', undefined, { cardId: c.id })).data.tasks;
    assert.equal(tasks[0].status, 'done');
  });
  test('Card time adopts its tentative hold so expiry cannot cancel the invite', async () => {
    const provider = google();
    const c = await card('webinar-tentative');
    const proposed = await invoke('POST', '/api/calendar-holds', { date: '2026-11-09', title: 'Test webinar', topic: 'Test', cardId: c.id, guestRef: 'guest@example.test' });
    assert.equal(proposed.code, 201, proposed.raw);
    const moved = await invoke('POST', `/api/cards/${c.id}/time`, { at: '2026-11-10 14:30' });
    assert.equal(moved.code, 200, moved.raw);
    assert.equal(moved.data.card.eventTime.googleEventIds[HOLD_ORGANIZER], proposed.data.hold.googleEventIds[HOLD_ORGANIZER]);
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 1);
    const holds = await invoke('GET', '/api/calendar-holds');
    assert.equal(holds.data.holds.find((h: any) => h.id === proposed.data.hold.id).status, 'confirmed');
  });
  test('concurrent Card time requests reserve one writer; missing guests fails before Google', async () => {
    const provider = google();
    const c = await card('webinar-concurrent');
    assert.equal((await invoke('POST', `/api/cards/${c.id}/time`, { at: '2026-11-09 14:30' })).code, 400);
    assert.equal(provider.events.size, 0);
    const results = await Promise.all([
      invoke('POST', `/api/cards/${c.id}/time`, { at: '2026-11-09 14:30', guestEmails: ['guest@example.test'] }),
      invoke('POST', `/api/cards/${c.id}/time`, { at: '2026-11-09 16:30', guestEmails: ['guest@example.test'] }),
    ]);
    assert.deepEqual(results.map(r => r.code).sort(), [200, 409]);
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 1);
  });
  test('an adopted legacy event moves by PATCH without replacing its organizer or creating a new event', async () => {
    const c = await card('webinar-legacy');
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = String(input), method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/api/agent/token')) return Response.json({ access_token: 'test-google' });
      if (method === 'GET') return Response.json({ id: 'legacy-event', organizer: { email: 'legacy@example.test' } });
      if (method === 'PATCH') return Response.json({ id: 'legacy-event' });
      throw new Error('Unexpected create');
    }) as typeof fetch;
    setCalendarHoldGoogleDepsForTests({ fetchImpl, credential: 'test', connectionId: 'orin' });
    assert.equal((await invoke('POST', `/api/cards/${c.id}/calendar-invites`, { eventId: 'legacy-event', calendar: 'legacy@example.test' })).code, 201);
    for (const at of ['2026-11-09 14:30', '2026-11-10 14:37']) {
      const moved = await invoke('POST', `/api/cards/${c.id}/time`, { at, guestEmails: ['guest@example.test'] });
      assert.equal(moved.code, 200, moved.raw);
      assert.equal(moved.data.card.eventTime.googleEventIds['legacy@example.test'], 'legacy-event');
    }
    const patches = calls.filter(call => call.method === 'PATCH');
    assert.equal(patches.length, 2);
    assert.ok(patches.every(call => call.url.endsWith('/events/legacy-event?sendUpdates=all')));
    assert.ok(patches.every(call => Object.keys(call.body).sort().join(',') === 'end,start'));
    assert.equal(patches[1].body.start.dateTime, '2026-11-10T13:32:00.000Z');
  });
  test('retry after uncertain Google response recovers same event and closes task', async () => {
    const provider = google();
    provider.state.loseInviteResponse = true;
    const c = await card('webinar-retry');
    const first = await invoke('POST', `/api/cards/${c.id}/time`, { at: '2026-11-09 14:30', guestEmails: ['guest@example.test'] });
    assert.equal(first.code, 502, first.raw);
    assert.equal(first.data.card.calendarInvites.length, 0);
    const retry = await invoke('POST', `/api/cards/${c.id}/time`, { at: '2026-11-09 14:30' });
    assert.equal(retry.code, 200, retry.raw);
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 1);
    assert.equal((await invoke('GET', '/api/tasks', undefined, { cardId: c.id })).data.tasks[0].status, 'done');
  });
});

import { mapCard } from '../src/export/portableMappers';
test('portable Card export retains guest addresses and event identity for recovery', () => {
  const eventTime = { ...cardEventInterval('2026-11-09 14:30'), eventKey: 'card:test', googleEventIds: { organizer: 'event-1' }, sync: 'synced' };
  const exported = mapCard({ id: 'test', guestEmails: ['guest@example.test'], eventTime });
  assert.deepEqual(exported.guest_emails, ['guest@example.test']);
  assert.deepEqual(exported.event_time, eventTime);
});
