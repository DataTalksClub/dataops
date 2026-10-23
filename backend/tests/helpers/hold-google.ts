import assert from 'node:assert/strict';
import { HOLD_ORGANIZER } from '../../src/calendar/holdGoogleSync';

export function holdGoogleProvider() {
  const events = new Map<string, Map<string, any>>();
  const calls: Array<{ url: URL; method: string; body?: any }> = [];
  let sequence = 0;
  const state = { account: HOLD_ORGANIZER, failCalendar: '', loseInviteResponse: false };
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.pathname === '/api/agent/token') return Response.json({ access_token: 'test-google' });
    if (url.pathname.endsWith('/calendars/primary')) return Response.json({ id: state.account });
    const match = url.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    assert.ok(match, `unexpected ${method} ${url.pathname}`);
    const calendar = decodeURIComponent(match[1]);
    const id = match[2] && decodeURIComponent(match[2]);
    if (calendar === state.failCalendar) return Response.json({}, { status: 503 });
    const store = events.get(calendar) || new Map<string, any>();
    events.set(calendar, store);
    if (method === 'GET' && !id) return Response.json({ items: [...store.values()].filter((e) => e.iCalUID === url.searchParams.get('iCalUID')) });
    if (method === 'GET') return Response.json(store.get(id!) || {}, { status: store.has(id!) ? 200 : 404 });
    if (method === 'POST' && id === 'import') {
      assert.equal(body.organizer.email, HOLD_ORGANIZER);
      assert.deepEqual(body.attendees, [], 'imports never invite guests');
      const event = { ...body, id: `event-${++sequence}` };
      store.set(event.id, event);
      return Response.json(event);
    }
    if (method === 'PATCH') {
      assert.ok(store.has(id!));
      assert.ok(!('conferenceData' in body));
      const event = { ...store.get(id!), ...body };
      store.set(id!, event);
      if (calendar !== HOLD_ORGANIZER) {
        assert.equal(url.searchParams.get('sendUpdates'), 'none');
        assert.ok(!('attendees' in body));
        assert.ok(!('guestsCanModify' in body));
      }
      if (calendar === HOLD_ORGANIZER && url.searchParams.get('sendUpdates') === 'all' && state.loseInviteResponse) {
        state.loseInviteResponse = false;
        throw new Error('response lost after committed invitation');
      }
      return Response.json(event);
    }
    if (method === 'DELETE') { store.delete(id!); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  return { events, calls, state, fetchImpl };
}
