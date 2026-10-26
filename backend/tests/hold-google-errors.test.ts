import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  GOOGLE_ERROR_MESSAGE_LIMIT,
  HOLD_ORGANIZER,
  createHoldGoogleEvents,
  deleteHoldGoogleEvents,
  googleErrorDetail,
  moveLinkedGoogleInvite,
  updateHoldGoogleEvents,
} from '../src/calendar/holdGoogleSync';

const GOOGLE_ERROR_JSON = JSON.stringify({
  error: {
    code: 400,
    message: 'The owner of the calendar must either be the organizer or an attendee of an event that is imported',
    errors: [{ domain: 'calendar', reason: 'invalidAttendee', message: 'The owner of the calendar must either be the organizer or an attendee' }],
  },
});

function googleFailure(status: number, body: string) {
  return (async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/agent/token') return Response.json({ access_token: 'test-google' });
    if (url.pathname.endsWith('/calendars/primary')) return Response.json({ id: HOLD_ORGANIZER });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const deps = (fetchImpl: typeof fetch) => ({ credential: 'test-machine', connectionId: 'orin-selected', fetchImpl });
const proposal = {
  eventKey: 'hold_reason400', summary: '(Proposal) Reason', startIso: '2026-11-10T11:30:00.000Z',
  endIso: '2026-11-10T12:30:00.000Z', timeZone: 'Europe/Berlin', description: '',
};

describe('google error reasons (no bare HTTP status)', () => {
  it('googleErrorDetail keeps status + message + errors reason, bounded, body-only', () => {
    const reason = googleErrorDetail(400, GOOGLE_ERROR_JSON);
    assert.match(reason, /HTTP 400/);
    assert.match(reason, /must either be the organizer or an attendee/);
    assert.match(reason, /invalidAttendee/);
    assert.ok(reason.length <= `Google Calendar returned HTTP 400: `.length + GOOGLE_ERROR_MESSAGE_LIMIT);
    assert.equal(googleErrorDetail(503, '{}'), 'Google Calendar returned HTTP 503');
    assert.equal(googleErrorDetail(500, 'not json'), 'Google Calendar returned HTTP 500');
    assert.equal(googleErrorDetail(500, ''), 'Google Calendar returned HTTP 500');
    const long = googleErrorDetail(400, JSON.stringify({ error: { message: 'x'.repeat(5000), errors: [] } }));
    assert.ok(long.length <= `Google Calendar returned HTTP 400: `.length + GOOGLE_ERROR_MESSAGE_LIMIT);
    // Non-string fields never leak into the reason.
    assert.equal(googleErrorDetail(400, JSON.stringify({ error: { message: { token: 'secret' } } })), 'Google Calendar returned HTTP 400');
  });

  it('create surfaces the Google 400 text in the deferred reason', async () => {
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/agent/token') return Response.json({ access_token: 'test-google' });
      if (url.pathname.endsWith('/calendars/primary')) return Response.json({ id: HOLD_ORGANIZER });
      if ((init.method || 'GET') === 'GET') return Response.json({ items: [] });
      return new Response(GOOGLE_ERROR_JSON, { status: 400, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const sync = await createHoldGoogleEvents(proposal, deps(fetchImpl));
    assert.equal(sync.state, 'deferred');
    assert.match(sync.reason, /HTTP 400/);
    assert.match(sync.reason, /must either be the organizer or an attendee/);
    assert.match(sync.reason, /invalidAttendee/);
  });

  it('update surfaces the Google PATCH error text in the deferred reason', async () => {
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      const method = init.method || 'GET';
      if (url.pathname === '/api/agent/token') return Response.json({ access_token: 'test-google' });
      if (url.pathname.endsWith('/calendars/primary')) return Response.json({ id: HOLD_ORGANIZER });
      if (method === 'GET') {
        if (url.searchParams.has('iCalUID')) return Response.json({ items: [] });
        const uid = `${createHash('sha256').update(proposal.eventKey).digest('hex')}@google.com`;
        return Response.json({ id: 'event-1', organizer: { email: HOLD_ORGANIZER }, iCalUID: uid });
      }
      return new Response(GOOGLE_ERROR_JSON, { status: 400, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const sync = await updateHoldGoogleEvents(
      { [HOLD_ORGANIZER]: 'event-1', 'alexey.s.grigoriev@gmail.com': 'event-2' },
      { ...proposal, attendees: ['guest@example.com'] }, deps(fetchImpl));
    assert.equal(sync.state, 'deferred');
    assert.match(sync.reason, /HTTP 400/);
    assert.match(sync.reason, /must either be the organizer or an attendee/);
  });

  it('delete surfaces the Google DELETE error text in the deferred reason', async () => {
    const sync = await deleteHoldGoogleEvents(
      { [HOLD_ORGANIZER]: 'event-1' }, deps(googleFailure(400, GOOGLE_ERROR_JSON)));
    assert.equal(sync.state, 'deferred');
    assert.match(sync.reason, /HTTP 400/);
    assert.match(sync.reason, /must either be the organizer or an attendee/);
  });

  it('move surfaces the Google error text in the deferred reason', async () => {
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/agent/token') return Response.json({ access_token: 'test-google' });
      if ((init.method || 'GET') === 'GET') return Response.json({ id: 'legacy-1', status: 'confirmed' });
      return new Response(GOOGLE_ERROR_JSON, { status: 400, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const sync = await moveLinkedGoogleInvite({ 'orin@datatalks.club': 'legacy-1' }, proposal, deps(fetchImpl));
    assert.equal(sync.state, 'deferred');
    assert.match(sync.reason, /HTTP 400/);
    assert.match(sync.reason, /must either be the organizer or an attendee/);
  });
});
