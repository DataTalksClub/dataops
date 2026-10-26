import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_HOLD_GOOGLE_CALENDARS } from '../src/calendar/dapierBroker';
import {
  HOLD_ORGANIZER,
  createHoldGoogleEvents,
  deleteHoldGoogleEvents,
} from '../src/calendar/holdGoogleSync';

function captureGoogle() {
  const calls: Array<{ url: URL; method: string; body?: any }> = [];
  const events = new Map<string, Map<string, any>>();
  let sequence = 0;
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.pathname === '/api/agent/token') return Response.json({ access_token: 'test-google' });
    if (url.pathname.endsWith('/calendars/primary')) return Response.json({ id: HOLD_ORGANIZER });
    const match = url.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    const calendar = decodeURIComponent(match![1]);
    const id = match![2] && decodeURIComponent(match![2]);
    const store = events.get(calendar) || new Map<string, any>();
    events.set(calendar, store);
    if (method === 'GET' && !id) return Response.json({ items: [...store.values()].filter((e) => e.iCalUID === url.searchParams.get('iCalUID')) });
    if (method === 'GET') return Response.json(store.get(id!) || {}, { status: store.has(id!) ? 200 : 404 });
    if (method === 'POST' && id === 'import') {
      const event = { ...body, id: `event-${++sequence}` };
      store.set(event.id, event);
      return Response.json(event);
    }
    if (method === 'PATCH') {
      const event = { ...store.get(id!), ...body };
      store.set(id!, event);
      return Response.json(event);
    }
    if (method === 'DELETE') { store.delete(id!); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  return { calls, events, fetchImpl };
}

const deps = (fetchImpl: typeof fetch) => ({ credential: 'test-machine', connectionId: 'orin-selected', fetchImpl });
const proposal = (attendees?: string[]) => ({
  eventKey: 'hold_copies400', summary: '(Proposal) Copies', startIso: '2026-11-12T11:30:00.000Z',
  endIso: '2026-11-12T12:30:00.000Z', timeZone: 'Europe/Berlin', description: '', ...(attendees ? { attendees } : {}),
});
const uid = `${createHash('sha256').update('hold_copies400').digest('hex')}@google.com`;
const imports = (calls: Array<{ url: URL; method: string; body?: any }>) =>
  calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/import'));

describe('hold google copies: importable payloads, silent copies', () => {
  it('copies import with the target calendar as sole attendee; organizer stays guest-only', async () => {
    const google = captureGoogle();
    const sync = await createHoldGoogleEvents(proposal(['guest@example.com']), deps(google.fetchImpl));
    assert.equal(sync.state, 'synced', JSON.stringify(sync));
    assert.deepEqual(Object.keys(sync.eventIds).sort(), [HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS].sort());
    const made = imports(google.calls);
    assert.equal(made.length, 3);
    for (const call of made) {
      const calendar = decodeURIComponent(call.url.pathname.split('/')[4]);
      assert.equal(call.body.iCalUID, uid, 'copies share the organizer iCalUID');
      assert.equal(call.body.organizer.email, HOLD_ORGANIZER, 'organizer stays orin');
      if (calendar === HOLD_ORGANIZER) {
        // The organizer import stays attendee-free: the organizer PATCH is the
        // single guest invitation. It never lists the copy calendars.
        assert.deepEqual(call.body.attendees, []);
      } else {
        // The import constraint: calendar owner must be organizer or attendee.
        assert.deepEqual(call.body.attendees, [{ email: calendar }]);
      }
      for (const copy of DEFAULT_HOLD_GOOGLE_CALENDARS) {
        if (calendar === HOLD_ORGANIZER) {
          assert.ok(!call.body.attendees.some((a: any) => a.email === copy), 'organizer never invites copy calendars');
        }
      }
      // The organizer PATCH is the single guest invitation.
      const organizerPatch = google.calls.find((c) => c.method === 'PATCH' &&
        decodeURIComponent(c.url.pathname).includes(HOLD_ORGANIZER));
      assert.ok(organizerPatch);
      assert.equal(organizerPatch.url.searchParams.get('sendUpdates'), 'all');
      assert.deepEqual(organizerPatch.body.attendees, [{ email: 'guest@example.com' }]);
    }
  });

  it('copy PATCH/DELETE stay silent; organizer invite/cancel carries guests', async () => {
    const google = captureGoogle();
    const created = await createHoldGoogleEvents(proposal(), deps(google.fetchImpl));
    assert.equal(created.state, 'synced');
    const patches = google.calls.filter((c) => c.method === 'PATCH');
    // A guestless proposal PATCHes only the copies (the organizer block
    // already matches, so the silent organizer PATCH is skipped).
    assert.equal(patches.length, 2);
    for (const patch of patches) {
      const calendar = decodeURIComponent(patch.url.pathname.split('/')[4]);
      if (calendar === HOLD_ORGANIZER) continue; // proposal PATCH not asserted here
      assert.equal(patch.url.searchParams.get('sendUpdates'), 'none');
      assert.ok(!('attendees' in patch.body), 'copies never email attendees');
      assert.ok(!('guestsCanModify' in patch.body));
    }
    google.calls.length = 0;
    const released = await deleteHoldGoogleEvents(created.eventIds, deps(google.fetchImpl));
    assert.equal(released.state, 'synced');
    const deletes = google.calls.filter((c) => c.method === 'DELETE');
    assert.equal(deletes.length, 3);
    for (const del of deletes) {
      const calendar = decodeURIComponent(del.url.pathname.split('/')[4]);
      assert.equal(del.url.searchParams.get('sendUpdates'), calendar === HOLD_ORGANIZER ? 'all' : 'none');
    }
    // Organizer copy is cancelled last so guests see one cancellation.
    assert.ok(decodeURIComponent(deletes[deletes.length - 1].url.pathname).includes(HOLD_ORGANIZER));
    assert.ok([...google.events.values()].every((store) => store.size === 0), 'release deletes all copies');
  });
});
