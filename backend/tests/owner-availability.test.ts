import { createHoldGoogleEvents, HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readOwnerAvailability, isSoftEvent } from '../src/calendar/ownerAvailability';
import { ownerCalendarOverlay, setOwnerCalendarProviderClientsForTests } from '../src/calendar/ownerCalendarOverlay';
import { assertOwnerAvailable } from '../src/calendar/assertOwnerAvailable';

import { guestEventSlots } from '../src/events/guestIntakeSlots';
import { prepareGuestIntake } from '../src/events/guestIntakeCreate';
import { OWNER_PERSONAL_CALENDAR as OWNER } from '../src/identity/operatingIdentities';
import { DAPIER_AGENT } from '../src/calendar/dapierBroker';
import type { GuestIntakeJob } from '../src/events/guestIntakeStore';
import type { EventPolicy } from '../src/events/policy';
import type { Template } from '../src/types';

const lunch = { id: 'lunch', summary: 'Lunch', start: { dateTime: '2026-11-26T12:00:00+01:00' }, end: { dateTime: '2026-11-26T13:00:00+01:00' } };
// The owner calendar is read only from today onward, so the fixture days below
// must stay ahead of a pinned today, never of the wall clock.
const clock = { today: '2026-11-24', now: new Date('2026-11-24T12:00:00Z') };
function fixture(events: Record<string, any[]>, options: { timeout?: boolean; freebusy?: any; paginate?: boolean } = {}) {
  const calls: string[] = [];
  const run: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(`${init?.method || 'GET'} ${url.pathname}`);
    if (url.pathname.endsWith('/api/agent/connections')) return Response.json({ connections: [{ connection_id: 'owner', verified_account_id: OWNER, provider: 'google', status: 'connected', agent: DAPIER_AGENT, operations: ['use'], granted_scopes: ['https://www.googleapis.com/auth/calendar'] }] });
    if (url.pathname.endsWith('/api/agent/token')) return Response.json({ access_token: 'synthetic' });
    if (url.pathname.endsWith('/calendars/primary')) return Response.json({ id: OWNER });
    if (url.pathname.endsWith('/users/me/calendarList')) {
      if (options.paginate && !url.searchParams.has('pageToken')) return Response.json({ items: [{ id: OWNER }], nextPageToken: 'next' });
      return Response.json({ items: Object.keys(events).map(id => ({ id })) });
    }
    if (url.pathname.endsWith('/freeBusy')) {
      if (options.timeout) throw new DOMException('Timed out', 'TimeoutError');
      return Response.json(options.freebusy || { calendars: Object.fromEntries([OWNER, ...Object.keys(events)].map(id => [id, { busy: [] }])) });
    }
    const id = decodeURIComponent(url.pathname.match(/\/calendars\/([^/]+)\/events/)?.[1] || '');
    if (id) return Response.json({ items: events[id] || [] });
    throw new Error(`Unexpected calendar write ${init?.method} ${url.pathname}`);
  };
  setOwnerCalendarProviderClientsForTests({ readSecret: async () => 'synthetic', fetch: run });
  return { run, calls };
}
afterEach(() => setOwnerCalendarProviderClientsForTests({}));

test('named lunch on a second owner calendar blocks 12:25 booking and midday listing; bare Lunch alone is soft', async () => {
  const realLunch = { ...lunch, id: 'meeting', summary: 'Lunch with Guest' };
  fixture({ [OWNER]: [lunch], secondary: [realLunch] }, { paginate: true });
  const slots = await ownerCalendarOverlay(clock).project('2026-11-26','2026-11-26');
  assert.equal(slots.connection.state, 'connected'); assert.equal(slots.items.length, 0);
  await assert.rejects(assertOwnerAvailable(undefined, '2026-11-26T11:25:00Z', '2026-11-26T12:30:00Z', {}, clock), /owner calendar conflict.*Lunch with Guest/);
  fixture({ [OWNER]: [lunch] }, { freebusy: { calendars: { [OWNER]: { busy: [{ start: lunch.start.dateTime, end: lunch.end.dateTime }] } } } });
  const available = await ownerCalendarOverlay(clock).project('2026-11-26','2026-11-26');
  assert.ok(available.items.some(i => i.isAvailableSlot));
  await assertOwnerAvailable(undefined, '2026-11-26T11:25:00Z', '2026-11-26T12:30:00Z', {}, clock);
  assert.equal(isSoftEvent({ summary: 'Morning no' }), false);
  assert.equal(isSoftEvent({ summary: 'No' }), false);
});

test('transparent all-day summit closes December 3 in both listing and booking', async () => {
  fixture({ [OWNER]: [{ id: 'summit', summary: 'Summit', transparency: 'transparent', start: { date: '2026-12-03' }, end: { date: '2026-12-04' } }] });
  const slots = await ownerCalendarOverlay(clock).project('2026-12-03','2026-12-03');
  assert.equal(slots.items.length, 0);
  const day = await ownerCalendarOverlay({ includeAll: true, ...clock }).project('2026-12-03','2026-12-03');
  assert.equal(day.items[0].slot, 'all-day');
  await assert.rejects(assertOwnerAvailable(undefined, '2026-12-03T11:25:00Z', '2026-12-03T12:30:00Z', {}, clock), /Summit/);
});

test('booking refreshes freebusy after an earlier free listing; conflict sends no write', async () => {
  fixture({ [OWNER]: [] });
  assert.ok((await ownerCalendarOverlay(clock).project('2026-11-26','2026-11-26')).items.length);
  const { calls } = fixture({ [OWNER]: [{ ...lunch, summary: 'New meeting' }] });
  const writerCalls: string[] = [];
  await assert.rejects(createHoldGoogleEvents({ eventKey: 'synthetic', summary: 'Guest', description: '', startIso: '2026-11-26T11:25:00Z', endIso: '2026-11-26T12:30:00Z', timeZone: 'Europe/Berlin' }, { credential: 'synthetic', connectionId: 'organizer', clock, fetchImpl: async (input, init) => {
    writerCalls.push(`${init?.method || 'GET'} ${String(input)}`);
    return Response.json(String(input).endsWith('/api/agent/token') ? { access_token: 'writer' } : { id: HOLD_ORGANIZER });
  } }), /Cannot book/);
  assert.equal(writerCalls.length, 2, 'only token and organizer identity reads; no event write');
  assert.ok(!calls.some(c => /^(POST|PATCH|DELETE).*\/events/.test(c)));
});

test('unknown freebusy, timeout and per-calendar errors fail closed; an own invite is excluded only by calendar and id', async () => {
  fixture({ [OWNER]: [] }, { timeout: true });
  await assert.rejects(assertOwnerAvailable(undefined, '2026-11-26T11:25:00Z', '2026-11-26T12:30:00Z', {}, clock), /freebusy unavailable/);
  let f = fixture({ [OWNER]: [] }, { freebusy: { calendars: { [OWNER]: { errors: [{ reason: 'forbidden' }] } } } });
  await assert.rejects(readOwnerAvailability(f.run,'synthetic','2026-11-26','2026-11-26'), /incomplete/);
  fixture({ [OWNER]: [] }, { freebusy: { calendars: { [OWNER]: { busy: [{ start: '2026-11-26T11:00:00Z', end: '2026-11-26T12:00:00Z' }] } } } });
  await assert.rejects(assertOwnerAvailable(undefined, '2026-11-26T11:25:00Z', '2026-11-26T12:30:00Z', {}, clock), /Busy \(freebusy\)/);
  fixture({ [OWNER]: [{ ...lunch, summary: 'Own invite' }] });
  await assertOwnerAvailable(undefined, '2026-11-26T11:25:00Z', '2026-11-26T12:30:00Z', { [OWNER]: 'lunch' }, clock);
});

test('missing agreement and November selection outside a January agreement fail before any data/calendar access', async () => {
  await assert.rejects(guestEventSlots({} as any, { policy: { enabled: true } } as GuestIntakeJob, {} as EventPolicy), /Record the guest agreement/);
  await assert.rejects(guestEventSlots({} as any, { policy: { enabled: true }, requestedDate: '2026-11-26', agreedFrom: '2027-01-01', agreedTo: '2027-01-31' } as GuestIntakeJob, {} as EventPolicy), /outside the guest agreement/);
});
