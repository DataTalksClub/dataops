import { OWNER_PERSONAL_CALENDAR } from '../identity/operatingIdentities';

const GOOGLE = 'https://www.googleapis.com/calendar/v3';
export type AvailabilityEvent = {
  id?: string; summary?: string; status?: string; transparency?: string; htmlLink?: string;
  start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string };
  calendarId?: string;
};

/** Only placeholders, never named lunches, meetings, routines or hard No blocks. */
export function isSoftEvent(event: AvailabilityEvent): boolean {
  return /^(lunch|lunchtime|lunch break|обед|dtc event block|datatalks\.club event|dtc event|dtc buffer)$/i.test((event.summary || '').trim());
}

function bounds(event: AvailabilityEvent): [number, number] {
  return [Date.parse(event.start?.dateTime || `${event.start?.date}T00:00:00Z`), Date.parse(event.end?.dateTime || `${event.end?.date}T00:00:00Z`)];
}

/** Read every calendar on the owner's account, including hidden calendars and every page.
 * Freebusy closes gaps from private/redacted events; only fully explained busy time can be softened.
 */
export async function readOwnerAvailability(run: typeof fetch, token: string, from: string, to: string): Promise<AvailabilityEvent[]> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function request(path: string, body?: unknown): Promise<any> {
    const response = await run(`${GOOGLE}${path}`, { headers, signal: AbortSignal.timeout(15000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Owner calendar availability returned HTTP ${response.status}; no time can be booked`);
    return response.json();
  }
  const primary = await request('/calendars/primary');
  if (primary.id?.toLowerCase() !== OWNER_PERSONAL_CALENDAR) throw new Error('Availability requires Alexey’s Google Calendar connection; the organizer connection cannot enumerate his calendars');
  const calendars = new Set<string>([OWNER_PERSONAL_CALENDAR]);
  let page: string | undefined;
  do {
    const data = await request(`/users/me/calendarList?showHidden=true&maxResults=250${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    if (!Array.isArray(data.items)) throw new Error('Invalid owner calendar list; availability is unknown');
    for (const calendar of data.items) if (!calendar.deleted && calendar.id) calendars.add(calendar.id);
    page = data.nextPageToken;
  } while (page);
  // Widen UTC bounds to include the complete Berlin dates in either DST offset.
  const timeMin = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString();
  const timeMax = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86400000).toISOString();
  const result: AvailabilityEvent[] = [];
  const ids = [...calendars];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const group = ids.slice(offset, offset + 50);
    const freebusy = await request('/freeBusy', { timeMin, timeMax, items: group.map(id => ({ id })) });
    for (const id of group) {
      const availability = freebusy.calendars?.[id];
      if (!availability || availability.errors?.length || !Array.isArray(availability.busy)) throw new Error('Owner calendar freebusy is incomplete; no time can be booked');
      const events: AvailabilityEvent[] = [];
      page = undefined;
      do {
        const query = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', maxResults: '2500', ...(page ? { pageToken: page } : {}) });
        const data = await request(`/calendars/${encodeURIComponent(id)}/events?${query}`);
        if (!Array.isArray(data.items)) throw new Error('Invalid owner calendar events; availability is unknown');
        events.push(...data.items.map((event: AvailabilityEvent) => ({ ...event, calendarId: id })));
        page = data.nextPageToken;
      } while (page);
      result.push(...events);
      for (const busy of availability.busy) {
        let gaps: Array<[number, number]> = [[Date.parse(busy.start), Date.parse(busy.end)]];
        if (!gaps.every(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && start < end)) throw new Error('Invalid freebusy interval; availability is unknown');
        for (const event of events) {
          if (event.status === 'cancelled' || event.transparency === 'transparent') continue;
          const [start, end] = bounds(event);
          gaps = gaps.flatMap(([a,b]) => start >= b || end <= a || !Number.isFinite(start + end) ? [[a,b]] : [...(a < start ? [[a,start]] : []), ...(end < b ? [[end,b]] : [])]) as Array<[number,number]>;
        }
        result.push(...gaps.map(([start,end], i) => ({ id: `freebusy:${busy.start}:${i}`, calendarId: id, summary: 'Busy (freebusy)', start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } })));
      }
    }
  }
  return result;
}
