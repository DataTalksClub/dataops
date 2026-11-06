import assert from 'node:assert/strict';
import { HOLD_ORGANIZER } from '../../src/calendar/holdGoogleSync';
import { DEFAULT_HOLD_GOOGLE_CALENDARS } from '../../src/calendar/dapierBroker';
export function createMockGoogleCalendar() {
  const calendars = new Map<string, Map<string, any>>();
  const ensureCal = (calId: string) => {
    if (!calendars.has(calId)) calendars.set(calId, new Map());
    return calendars.get(calId)!;
  };
  ensureCal(HOLD_ORGANIZER);
  for (const cal of DEFAULT_HOLD_GOOGLE_CALENDARS) ensureCal(cal);

  const calls: Array<{ method: string; url: string; body?: any }> = [];
  let seq = 1;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: urlStr, body });

    if (urlStr.endsWith('/api/agent/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-google-token' }), { status: 200 });
    }
    if (urlStr.endsWith('/calendars/primary')) {
      return new Response(JSON.stringify({ id: HOLD_ORGANIZER }), { status: 200 });
    }

    const parsed = new URL(urlStr);
    const calMatch = parsed.pathname.match(/\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!calMatch) {
      return new Response(JSON.stringify({ error: { message: `Unhandled URL ${urlStr}` } }), { status: 404 });
    }
    const calendarId = decodeURIComponent(calMatch[1]);
    const secondSeg = calMatch[2] ? decodeURIComponent(calMatch[2]) : undefined;
    const calStore = ensureCal(calendarId);

    // GET list by iCalUID
    if (method === 'GET' && !secondSeg) {
      const uid = parsed.searchParams.get('iCalUID');
      const items = [...calStore.values()].filter((e) => !uid || e.iCalUID === uid);
      return new Response(JSON.stringify({ items }), { status: 200 });
    }

    // POST /import
    if (method === 'POST' && secondSeg === 'import') {
      const id = `gev_${calendarId.split('@')[0]}_${seq++}`;
      const record = {
        id,
        status: 'confirmed',
        organizer: { email: HOLD_ORGANIZER },
        ...body,
      };
      calStore.set(id, record);
      return new Response(JSON.stringify(record), { status: 200 });
    }

    if (!secondSeg) {
      return new Response(JSON.stringify({ error: { message: 'Missing event id' } }), { status: 400 });
    }

    const existing = calStore.get(secondSeg);
    if (method === 'GET') {
      if (!existing) return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
      return new Response(JSON.stringify(existing), { status: 200 });
    }

    if (method === 'PATCH') {
      if (!existing) return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
      const mergedAttendees = body.attendees
        ? body.attendees.map((a: any) => {
            const prev = (existing.attendees || []).find(
              (p: any) => p.email?.toLowerCase() === a.email?.toLowerCase(),
            );
            return {
              email: a.email,
              responseStatus: a.responseStatus || prev?.responseStatus || 'needsAction',
            };
          })
        : existing.attendees;
      const updated = {
        ...existing,
        ...body,
        ...(mergedAttendees ? { attendees: mergedAttendees } : {}),
        ...(body.extendedProperties
          ? {
              extendedProperties: {
                private: {
                  ...(existing.extendedProperties?.private || {}),
                  ...(body.extendedProperties.private || {}),
                },
              },
            }
          : {}),
      };
      calStore.set(secondSeg, updated);
      return new Response(JSON.stringify(updated), { status: 200 });
    }

    if (method === 'DELETE') {
      calStore.delete(secondSeg);
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify({ error: { message: 'Unsupported method' } }), { status: 405 });
  }) as typeof fetch;

  return {
    calendars,
    calls,
    fetchImpl,
    getOrganizerEvent(eventId: string) {
      return ensureCal(HOLD_ORGANIZER).get(eventId);
    },
    setAttendeeResponse(eventId: string, attendeeEmail: string, responseStatus: string) {
      const ev = ensureCal(HOLD_ORGANIZER).get(eventId);
      assert.ok(ev, `Organizer event ${eventId} must exist`);
      ev.attendees = (ev.attendees || []).map((a: any) =>
        a.email?.toLowerCase() === attendeeEmail.toLowerCase() ? { ...a, responseStatus } : a,
      );
      if (!ev.attendees.some((a: any) => a.email?.toLowerCase() === attendeeEmail.toLowerCase())) {
        ev.attendees.push({ email: attendeeEmail, responseStatus });
      }
    },
  };
}

