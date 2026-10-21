/**
 * Google mirroring for calendar holds, per SOP
 * `sop.events.calendar.creating-tentative-event-on-google-calendar`.
 *
 * A tentative hold creates `(Proposal) {title}` on each configured Google
 * calendar (DTC events + personal Alexey); confirm renames it to drop the
 * prefix; release deletes it. DataOps is the source of truth: when the broker
 * credential is unavailable the hold is still created locally and the Google
 * leg stays `deferred` instead of failing the request.
 */

export interface HoldGoogleEvent {
  summary: string;
  startIso: string;
  endIso: string;
  timeZone: string;
  description: string;
}

export interface HoldGoogleDeps {
  fetchImpl?: typeof fetch;
  brokerUrl?: string;
  credential?: string;
  agent?: string;
  connectionId?: string;
  calendarIds?: string[];
}

export type HoldGoogleResult =
  | { state: 'synced'; eventIds: Record<string, string> }
  | { state: 'deferred'; reason: string };

const DEFAULT_BROKER_URL = 'https://dapier.dtcdev.click';
const DEFAULT_AGENT = 'personal-scheduler';

let fetcher: typeof fetch = fetch;

export function setHoldGoogleFetchForTests(value: typeof fetch | undefined): void {
  if (value) fetcher = value;
}

function resolveCalendarIds(explicit: string[] | undefined): string[] {
  if (explicit && explicit.length) return explicit;
  const env = (process.env.DATAOPS_HOLD_GOOGLE_CALENDARS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return env.length ? env : ['primary'];
}

async function accessToken(deps: HoldGoogleDeps): Promise<{ token: string } | { problem: string }> {
  const { brokerUrl = DEFAULT_BROKER_URL, agent = DEFAULT_AGENT, connectionId = 'google-calendar' } = deps;
  if (!deps.credential) return { problem: 'no calendar broker credential in this environment (dry-run: hold stored, Google leg deferred)' };
  const run = deps.fetchImpl || fetcher;
  let tokenRes: Response;
  try {
    tokenRes = await run(`${brokerUrl.replace(/\/$/, '')}/api/agent/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_id: connectionId, agent }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { problem: 'the calendar broker could not be reached' };
  }
  if (!tokenRes.ok) return { problem: `the calendar broker refused the token request (HTTP ${tokenRes.status})` };
  const data = (await tokenRes.json()) as { access_token?: string };
  if (!data.access_token) return { problem: 'the calendar broker returned no access token' };
  return { token: data.access_token };
}

async function googleFetch(deps: HoldGoogleDeps, url: string, init: RequestInit): Promise<Response> {
  const run = deps.fetchImpl || fetcher;
  return run(url, init);
}

/** Create the Proposal event on every target calendar. */
export async function createHoldGoogleEvents(event: HoldGoogleEvent, deps: HoldGoogleDeps): Promise<HoldGoogleResult> {
  const resolved = await accessToken(deps);
  if ('problem' in resolved) return { state: 'deferred', reason: resolved.problem };
  const eventIds: Record<string, string> = {};
  for (const calendarId of resolveCalendarIds(deps.calendarIds)) {
    const res = await googleFetch(
      deps,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${resolved.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: event.summary,
          description: event.description,
          start: { dateTime: event.startIso, timeZone: event.timeZone },
          end: { dateTime: event.endIso, timeZone: event.timeZone },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) return { state: 'deferred', reason: `Google Calendar returned HTTP ${res.status} for ${calendarId}` };
    const created = (await res.json()) as { id?: string };
    if (!created.id) return { state: 'deferred', reason: `Google Calendar returned no event id for ${calendarId}` };
    eventIds[calendarId] = created.id;
  }
  return { state: 'synced', eventIds };
}

/** Rename the mirrored events (confirm drops the Proposal prefix). */
export async function updateHoldGoogleEvents(
  eventIds: Record<string, string>,
  summary: string,
  deps: HoldGoogleDeps,
): Promise<HoldGoogleResult> {
  const ids = Object.entries(eventIds);
  if (!ids.length) return { state: 'deferred', reason: 'no mirrored Google events to update' };
  const resolved = await accessToken(deps);
  if ('problem' in resolved) return { state: 'deferred', reason: resolved.problem };
  for (const [calendarId, eventId] of ids) {
    const res = await googleFetch(
      deps,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${resolved.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) return { state: 'deferred', reason: `Google Calendar returned HTTP ${res.status} for ${calendarId}` };
  }
  return { state: 'synced', eventIds };
}

/** Cancel the mirrored events on release/expire. */
export async function deleteHoldGoogleEvents(
  eventIds: Record<string, string>,
  deps: HoldGoogleDeps,
): Promise<HoldGoogleResult> {
  const ids = Object.entries(eventIds);
  if (!ids.length) return { state: 'deferred', reason: 'no mirrored Google events to cancel' };
  const resolved = await accessToken(deps);
  if ('problem' in resolved) return { state: 'deferred', reason: resolved.problem };
  for (const [calendarId, eventId] of ids) {
    const res = await googleFetch(
      deps,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${resolved.token}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      return { state: 'deferred', reason: `Google Calendar returned HTTP ${res.status} for ${calendarId}` };
    }
  }
  return { state: 'synced', eventIds };
}
