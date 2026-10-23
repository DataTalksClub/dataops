/**
 * Google mirroring for calendar holds, per SOP
 * `sop.events.calendar.creating-tentative-event-on-google-calendar`.
 *
 * A tentative hold creates `(Proposal) {title}` on each configured Google
 * calendar (DTC events + personal Alexey); confirm turns the mirror into the
 * guest invite — Zoom location + description, required attendees, window
 * start −5 min, `sendUpdates=all`; never Google Meet (no conferenceData is
 * ever sent). Release deletes it. DataOps is the source of truth: when the broker
 * credential is unavailable the hold is still created locally and the Google
 * leg stays `deferred` instead of failing the request — with an operator path
 * in the reason (connection selection, Dapier grant or machine credential).
 */

import { createHash } from 'node:crypto';

import {
  CREDENTIAL_OPERATOR_HINT,
  DAPIER_AGENT,
  DAPIER_BASE_URL,
  CONNECTION_OPERATOR_HINT,
  dapierTokenProblem,
  readDapierCredential,
  resolveHoldGoogleCalendars,
} from './dapierBroker';

export interface HoldGoogleEvent {
  eventKey: string;
  summary: string;
  startIso: string;
  endIso: string;
  timeZone: string;
  description: string;
  /** Zoom meeting room (confirmed invites). Never Google Meet. */
  location?: string;
  /** Emails invited when the hold confirms; proposals stay attendee-free. */
  attendees?: string[];
}

export interface HoldGoogleDeps {
  fetchImpl?: typeof fetch;
  brokerUrl?: string;
  /** When set (via tests), skips Secrets Manager lookup. */
  credential?: string;
  agent?: string;
  connectionId?: string;
  calendarIds?: string[];
}

export type HoldGoogleResult =
  | { state: 'synced'; eventIds: Record<string, string> }
  | { state: 'deferred'; reason: string; eventIds: Record<string, string> };

let fetcher: typeof fetch = fetch;

export function setHoldGoogleFetchForTests(value: typeof fetch | undefined): void {
  if (value) fetcher = value;
}

async function accessToken(deps: HoldGoogleDeps): Promise<{ token: string } | { problem: string }> {
  const {
    brokerUrl = DAPIER_BASE_URL,
    agent = DAPIER_AGENT,
    connectionId = '',
  } = deps;

  if (!connectionId.trim()) return { problem: `No Dapier calendar connection selected. ${CONNECTION_OPERATOR_HINT}` };

  let credential = deps.credential;
  let problem: string | undefined;
  if (!credential) {
    const resolved = await readDapierCredential(undefined);
    credential = resolved.credential;
    problem = resolved.problem;
  }
  if (!credential) {
    const base = problem || `No calendar broker credential in this environment. ${CREDENTIAL_OPERATOR_HINT}`;
    const withHint = base.includes('Through Dapier') ? base : `${base} ${CREDENTIAL_OPERATOR_HINT}`;
    return { problem: `${withHint} (hold stored; Google leg deferred)` };
  }

  const run = deps.fetchImpl || fetcher;
  let tokenRes: Response;
  try {
    tokenRes = await run(`${brokerUrl.replace(/\/$/, '')}/api/agent/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_id: connectionId, agent }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { problem: 'the calendar broker could not be reached' };
  }
  if (!tokenRes.ok) return { problem: dapierTokenProblem(tokenRes.status, connectionId, agent) };
  let data: { access_token?: string };
  try { data = await tokenRes.json() as { access_token?: string }; }
  catch { return { problem: 'the calendar broker returned an invalid token response' }; }
  if (!data.access_token) return { problem: 'the calendar broker returned no access token' };
  return { token: data.access_token };
}

async function googleFetch(deps: HoldGoogleDeps, url: string, init: RequestInit): Promise<Response> {
  const run = deps.fetchImpl || fetcher;
  return run(url, init);
}

/** Orin owns the event; SOP target calendars contain copies of that same event. */
export const HOLD_ORGANIZER = 'orin@datatalks.club';
const GOOGLE = 'https://www.googleapis.com/calendar/v3';
const eventsUrl = (calendar: string) => `${GOOGLE}/calendars/${encodeURIComponent(calendar)}/events`;

function eventBody(event: HoldGoogleEvent) {
  return {
    summary: event.summary,
    description: event.description,
    location: event.location || '',
    guestsCanModify: true,
    attendees: (event.attendees || []).map((email) => ({ email })),
    start: { dateTime: event.startIso, timeZone: event.timeZone },
    end: { dateTime: event.endIso, timeZone: event.timeZone },
  };
}

async function syncEvents(
  event: HoldGoogleEvent,
  deps: HoldGoogleDeps,
  existing: Record<string, string>,
): Promise<HoldGoogleResult> {
  const eventIds = { ...existing };
  const deferred = (reason: string): HoldGoogleResult => ({ state: 'deferred', reason, eventIds });
  const resolved = await accessToken(deps);
  if ('problem' in resolved) return deferred(resolved.problem);
  const headers = { Authorization: `Bearer ${resolved.token}`, 'Content-Type': 'application/json' };
  async function request(url: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await googleFetch(deps, url, {
      method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Google Calendar returned HTTP ${response.status}`);
    return response.json();
  }
  try {
    // Fail before writing anything with a token for the wrong Google identity.
    const account = await request(`${GOOGLE}/calendars/primary`);
    if (account.id?.toLowerCase() !== HOLD_ORGANIZER) {
      return deferred('Calendar invitations require the Orin Google Calendar connection. Select it in calendar settings.');
    }
    const calendars = resolveHoldGoogleCalendars(deps.calendarIds);
    if (calendars.includes('primary') || calendars.includes(HOLD_ORGANIZER)) {
      return deferred('Hold calendars must name the DTC and personal calendars explicitly; primary is the Orin organizer calendar.');
    }
    // Stable opaque UID enables recovery after partial writes without leaking the hold id.
    const uid = `${createHash('sha256').update(event.eventKey).digest('hex')}@google.com`;
    const body = eventBody(event);
    let organizer: any;
    for (const calendar of [HOLD_ORGANIZER, ...calendars]) {
      let current: any;
      if (eventIds[calendar]) {
        current = await request(`${eventsUrl(calendar)}/${encodeURIComponent(eventIds[calendar])}`);
      } else {
        const found = await request(`${eventsUrl(calendar)}?iCalUID=${encodeURIComponent(uid)}`);
        const matches = (found.items || []).filter((item: any) => item.status !== 'cancelled');
        if (matches.length > 1) throw new Error('Google event identity has multiple calendar copies; reconcile before sending.');
        current = matches[0];
      }
      if (!current) {
        // Google documents importing matching UIDs on organizer and attendee
        // calendars to show copies regardless of invitation auto-add settings.
        // Imports send no email. Only the organizer PATCH below sends the invite.
        current = await request(`${eventsUrl(calendar)}/import`, 'POST', {
          ...body, attendees: [], iCalUID: uid, organizer: { email: HOLD_ORGANIZER },
        });
      }
      if (!current.id || current.organizer?.email?.toLowerCase() !== HOLD_ORGANIZER || current.iCalUID !== uid) {
        throw new Error('Google event organizer or identity does not match the Orin invitation.');
      }
      eventIds[calendar] = current.id;
      if (calendar === HOLD_ORGANIZER) organizer = current;
    }
    // Update organizer last, once both target blocks exist. On a retry after
    // an uncertain response, compare the live event before sending updates.
    for (const calendar of [...calendars, HOLD_ORGANIZER]) {
      const isOrganizer = calendar === HOLD_ORGANIZER;
      const url = `${eventsUrl(calendar)}/${encodeURIComponent(eventIds[calendar])}`;
      const sameInvite = isOrganizer && Object.entries(body).every(([key, value]) => {
        if (key === 'attendees') {
          return JSON.stringify((organizer.attendees || []).map((a: any) => a.email.toLowerCase()).sort()) ===
            JSON.stringify((event.attendees || []).map((email) => email.toLowerCase()).sort());
        }
        if (key === 'start' || key === 'end') {
          return Date.parse(organizer[key]?.dateTime) === Date.parse((value as { dateTime: string }).dateTime) &&
            organizer[key]?.timeZone === event.timeZone;
        }
        if (key === 'location' || key === 'description') return (organizer[key] || '') === value;
        return JSON.stringify(organizer[key]) === JSON.stringify(value);
      });
      if (sameInvite) continue;
      const { attendees, guestsCanModify, ...copyBody } = body;
      await request(`${url}${isOrganizer && event.attendees?.length ? '?sendUpdates=all' : '?sendUpdates=none'}`,
        'PATCH', isOrganizer ? body : copyBody);
    }
    return { state: 'synced', eventIds };
  } catch (error) {
    const reason = error instanceof Error && error.message.startsWith('Google ')
      ? error.message : 'Google Calendar sync could not complete; retry the hold after checking the Orin connection.';
    return deferred(reason);
  }
}

export async function createHoldGoogleEvents(event: HoldGoogleEvent, deps: HoldGoogleDeps): Promise<HoldGoogleResult> {
  return syncEvents(event, deps, {});
}

export async function updateHoldGoogleEvents(
  eventIds: Record<string, string>, event: HoldGoogleEvent, deps: HoldGoogleDeps,
): Promise<HoldGoogleResult> {
  // Existing independent calendar events must be reconciled explicitly, never
  // emailed from a personal organizer or silently duplicated under Orin.
  if (Object.keys(eventIds).length && !eventIds[HOLD_ORGANIZER]) {
    return { state: 'deferred', eventIds, reason: 'Existing Google blocks require organizer reconciliation before sending an Orin invite.' };
  }
  return syncEvents(event, deps, eventIds);
}

/** Cancel each copy; only the organizer sends cancellation notifications. */
export async function deleteHoldGoogleEvents(
  eventIds: Record<string, string>, deps: HoldGoogleDeps,
): Promise<HoldGoogleResult> {
  if (!Object.keys(eventIds).length) return { state: 'synced', eventIds };
  const resolved = await accessToken(deps);
  if ('problem' in resolved) return { state: 'deferred', reason: resolved.problem, eventIds };
  try {
    for (const [calendar, id] of Object.entries(eventIds).sort(([a], [b]) =>
      Number(a === HOLD_ORGANIZER) - Number(b === HOLD_ORGANIZER))) {
      const res = await googleFetch(deps,
        `${eventsUrl(calendar)}/${encodeURIComponent(id)}${calendar === HOLD_ORGANIZER ? '?sendUpdates=all' : ''}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${resolved.token}` }, signal: AbortSignal.timeout(15000) });
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        return { state: 'deferred', reason: `Google Calendar returned HTTP ${res.status}`, eventIds };
      }
    }
    return { state: 'synced', eventIds };
  } catch {
    return { state: 'deferred', reason: 'Google Calendar cancellation could not complete.', eventIds };
  }
}
