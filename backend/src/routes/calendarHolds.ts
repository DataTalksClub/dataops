import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import {
  buildHold,
  confirmHoldRecord,
  confirmedHoldInvite,
  confirmedTitle,
  holdGuestAttendees,
  parseHoldDocumentUrl,
  proposalTitle,
  releaseHoldRecord,
  type CalendarHoldReleaseReason,
  type CalendarHoldStatus,
} from '../calendar/holds';
import {
  createHoldGoogleEvents,
  deleteHoldGoogleEvents,
  updateHoldGoogleEvents,
} from '../calendar/holdGoogleSync';
import {
  calendarInviteDeps,
  expireCalendarHolds,
  getCalendarHold,
  listCalendarHolds,
  putCalendarHold,
  setCalendarHoldGoogleDepsForTests,
} from '../db/calendarHolds';
import { CardVersionConflictError, getCardConsistent } from '../db/cards';
import { CardInviteConflictError, CardInviteInputError, syncCardInvite } from '../calendar/cardInvite';
import { recordAutomationRun } from '../automations/runs';

export { calendarInviteDeps, setCalendarHoldGoogleDepsForTests };

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (v: unknown): v is string =>
  typeof v === 'string' && DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

const parse = (event: LambdaEvent): any => {
  try {
    return event.body ? JSON.parse(String(event.body)) : {};
  } catch {
    return null;
  }
};

const actor = (event: LambdaEvent): string =>
  Object.entries(event.headers || {}).find(([k]) => k.toLowerCase() === 'x-user-id')?.[1] ||
  'authenticated-operator';

const STATUSES: CalendarHoldStatus[] = ['tentative', 'confirmed', 'released', 'expired'];

const googlePayload = (hold: { id: string }, summary: string, startIso: string, endIso: string) => ({
  eventKey: hold.id,
  summary,
  startIso,
  endIso,
  timeZone: 'Europe/Berlin' as const,
  description: '',
});

async function createRoute(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const body = parse(event);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Request body is required' });
  if (typeof body.cardId === 'string') {
    const card = await getCardConsistent(client, body.cardId);
    if (card?.eventTime || card?.calendarInvites?.length) {
      return json(409, { error: 'This Card already owns an invitation. Change its time with dataops cards time.' });
    }
  }
  let hold;
  try {
    hold = buildHold(
      {
        date: body.date,
        window: body.window,
        duration: body.duration ?? body.durationMinutes,
        durationMinutes: body.durationMinutes,
        title: body.title,
        topic: body.topic,
        cardId: body.cardId,
        guestRef: body.guestRef,
        documentUrl: body.documentUrl,
        organizationId: body.organizationId,
        expiresDays: body.expiresDays ?? body.expires_days,
        googleCalendars: body.googleCalendars,
      },
      actor(event),
    );
  } catch (e: any) {
    return json(400, { error: String(e?.message || 'Invalid hold') });
  }
  const sync = await createHoldGoogleEvents(
    googlePayload(hold, proposalTitle(hold.title), hold.startIso, hold.endIso),
    await calendarInviteDeps(body, client),
  );
  const stored = {
    ...hold,
    ...(sync.state === 'synced'
      ? { googleEventIds: sync.eventIds, googleSync: { state: 'synced' as const } }
      : { googleEventIds: sync.eventIds, googleSync: { state: 'deferred' as const, reason: sync.reason } }),
  };
  await putCalendarHold(client, stored);
  return json(201, { hold: stored });
}

function rangeQuery(event: LambdaEvent): { from?: string; to?: string } | null {
  const q = event.queryStringParameters || {};
  const from = q.from;
  const to = q.to;
  if (from !== undefined && !realDate(from)) return null;
  if (to !== undefined && !realDate(to)) return null;
  if (from && to && from > to) return null;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

async function listRoute(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const range = rangeQuery(event);
  if (!range) return json(400, { error: 'Invalid range: from/to must be YYYY-MM-DD with from <= to' });
  const q = event.queryStringParameters || {};
  const status = q.status;
  if (status !== undefined && !(STATUSES as string[]).includes(status)) {
    return json(400, { error: "Invalid status: must be one of 'tentative', 'confirmed', 'released', 'expired'" });
  }
  const holds = await listCalendarHolds(client, {
    ...range,
    ...(status ? { status: status as CalendarHoldStatus } : {}),
  });
  return json(200, { holds, timeZone: 'Europe/Berlin' });
}

async function confirmRoute(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  let existing = await getCalendarHold(client, id);
  if (!existing) return json(404, { error: 'Hold not found' });
  const body = parse(event);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid confirmation body' });
  try {
    existing = {
      ...existing,
      ...(typeof body.guestRef === 'string' ? { guestRef: body.guestRef.trim() } : {}),
      ...(body.documentUrl !== undefined ? { documentUrl: parseHoldDocumentUrl(body.documentUrl) } : {}),
    };
  } catch {
    return json(400, { error: 'The guest document must be an HTTPS URL.' });
  }
  if (!existing.guestRef || !holdGuestAttendees(existing.guestRef).includes(existing.guestRef.trim().toLowerCase())) {
    return json(422, { error: 'A guest email is required before sending the calendar invite.', code: 'guest_required' });
  }
  let next;
  try {
    next = existing.status === 'confirmed' && existing.googleSync.state === 'deferred'
      ? existing : confirmHoldRecord(existing);
  } catch (e: any) {
    return json(409, { error: String(e?.message || 'Cannot confirm hold'), code: e?.code || 'hold_state' });
  }
  const confirmed = confirmedTitle(existing.title);
  const deps = await calendarInviteDeps({}, client);
  // Propose may have deferred while the broker credential was unavailable,
  // leaving googleEventIds empty. Confirm must still mirror Google: PATCH
  // when mirrors exist, otherwise CREATE. Either way the mirror becomes the
  // guest invite immediately: confirmed title, Zoom location + description,
  // required attendees (never Meet, never deny-listed), window start −5 min.
  const card = existing.cardId ? await getCardConsistent(client, existing.cardId) : null;
  const invite = confirmedHoldInvite(next);
  if (card) {
    try {
      const result = await syncCardInvite(client, card, {
        startIso: next.startIso, endIso: next.endIso, timeZone: next.timeZone, durationMinutes: next.durationMinutes,
      }, [existing.guestRef!.trim().toLowerCase()], deps, actor(event), { ...existing, documentUrl: next.documentUrl });
      return json(200, { hold: result.hold });
    } catch (error) {
      if (error instanceof CardVersionConflictError || error instanceof CardInviteConflictError) {
        return json(409, { error: error.message, code: 'card_invite_conflict' });
      }
      if (error instanceof CardInviteInputError) return json(422, { error: error.message });
      throw error;
    }
  }
  const sync = Object.keys(existing.googleEventIds || {}).length
    ? await updateHoldGoogleEvents(existing.googleEventIds, invite, deps)
    : await createHoldGoogleEvents(invite, deps);
  const stored = {
    ...next,
    version: existing.version + 1,
    googleTitle: confirmed,
    ...(sync.state === 'synced'
      ? { googleEventIds: sync.eventIds, googleSync: { state: 'synced' as const } }
      : { googleEventIds: sync.eventIds, googleSync: { state: 'deferred' as const, reason: sync.reason } }),
  };
  await putCalendarHold(client, stored);
  return json(200, { hold: stored });
}

async function releaseRoute(
  id: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const existing = await getCalendarHold(client, id);
  if (!existing) return json(404, { error: 'Hold not found' });
  const body = parse(event) || {};
  const rawReason = body.reason || body.releaseReason || 'manual';
  const reason = String(rawReason) as CalendarHoldReleaseReason;
  if (reason !== 'manual' && reason !== 'confirmed') {
    return json(400, { error: "Invalid reason: must be 'manual' or 'confirmed'" });
  }
  let next;
  try {
    next = releaseHoldRecord(existing, reason);
  } catch (e: any) {
    return json(409, { error: String(e?.message || 'Cannot release hold'), code: e?.code || 'hold_state' });
  }
  const sync = await deleteHoldGoogleEvents(existing.googleEventIds, await calendarInviteDeps(body, client));
  const stored = {
    ...next,
    ...(sync.state === 'synced'
      ? { googleSync: { state: 'synced' as const } }
      : { googleSync: { state: 'deferred' as const, reason: sync.reason } }),
  };
  await putCalendarHold(client, stored);
  return json(200, { hold: stored });
}

async function expireRoute(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const body = parse(event) || {};
  const q = event.queryStringParameters || {};
  const dryRun = body.dryRun === true || q.dryRun === 'true';
  const { expired, followUps, activeCount } = await expireCalendarHolds(client, undefined, { dryRun });
  if (!dryRun) {
    await recordAutomationRun(client, 'calendar-hold-expiry', {
      ok: true,
      summary: `${expired.length} hold${expired.length === 1 ? '' : 's'} expired`,
    });
  }
  return json(200, {
    dryRun,
    activeCount,
    expired,
    followUps,
    note: 'Expired holds are released in DataOps and Google. Follow-ups are for Orin — no guest email was sent.',
  });
}

export async function handleCalendarHoldRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path === '/api/calendar-holds/expire') {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    return expireRoute(event, client);
  }
  if (path === '/api/calendar-holds') {
    if (method === 'POST') return createRoute(event, client);
    if (method === 'GET') return listRoute(event, client);
    return json(405, { error: 'Method not allowed' });
  }
  const confirm = path.match(/^\/api\/calendar-holds\/([^/]+)\/confirm$/);
  if (confirm) {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    return confirmRoute(decodeURIComponent(confirm[1]), event, client);
  }
  const release = path.match(/^\/api\/calendar-holds\/([^/]+)\/release$/);
  if (release) {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    return releaseRoute(decodeURIComponent(release[1]), event, client);
  }
  const detail = path.match(/^\/api\/calendar-holds\/([^/]+)$/);
  if (detail) {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    const hold = await getCalendarHold(client, decodeURIComponent(detail[1]));
    if (!hold) return json(404, { error: 'Hold not found' });
    return json(200, { hold });
  }
  return null;
}
