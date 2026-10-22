import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import {
  buildHold,
  confirmHoldRecord,
  confirmedTitle,
  parseHoldCalendars,
  proposalTitle,
  releaseHoldRecord,
  type CalendarHoldReleaseReason,
  type CalendarHoldStatus,
} from '../calendar/holds';
import {
  createHoldGoogleEvents,
  deleteHoldGoogleEvents,
  updateHoldGoogleEvents,
  type HoldGoogleDeps,
} from '../calendar/holdGoogleSync';
import { DEFAULT_CALENDAR_CONNECTION } from '../calendar/dapierBroker';
import {
  expireCalendarHolds,
  getCalendarHold,
  listCalendarHolds,
  putCalendarHold,
} from '../db/calendarHolds';
import { getCalendarOverlaySettings } from '../db/calendar';

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

let googleDeps: HoldGoogleDeps = {};
export function setCalendarHoldGoogleDepsForTests(deps: HoldGoogleDeps): void {
  googleDeps = deps;
}

/**
 * Resolve hold Google deps: calendars from the request (optional), Dapier
 * connectionId from DataOps calendar settings (Orin-picked). Explicit
 * googleDeps.connectionId (tests) wins over settings.
 */
async function depsFor(body: any, client: DynamoDBDocumentClient): Promise<HoldGoogleDeps> {
  const calendars = (() => {
    try {
      return parseHoldCalendars(body?.googleCalendars);
    } catch {
      return undefined;
    }
  })();
  let connectionId = googleDeps.connectionId;
  if (!connectionId) {
    const settings = await getCalendarOverlaySettings(client);
    const picked = (settings.connectionId || '').trim();
    connectionId = picked || DEFAULT_CALENDAR_CONNECTION;
  }
  // Machine credential resolution lives in holdGoogleSync via dapierBroker
  // (SM personal-scheduler/dapier-api-token). Tests inject googleDeps.credential.
  return {
    ...googleDeps,
    connectionId,
    ...(calendars ? { calendarIds: calendars } : {}),
  };
}

const googlePayload = (hold: { id: string; status: string }, summary: string, startIso: string, endIso: string) => ({
  summary,
  startIso,
  endIso,
  timeZone: 'Europe/Berlin' as const,
  description: `DataOps calendar hold ${hold.id} (${hold.status})`,
});

async function createRoute(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const body = parse(event);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Request body is required' });
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
    await depsFor(body, client),
  );
  const stored = {
    ...hold,
    ...(sync.state === 'synced'
      ? { googleEventIds: sync.eventIds, googleSync: { state: 'synced' as const } }
      : { googleSync: { state: 'deferred' as const, reason: sync.reason } }),
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

async function confirmRoute(id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const existing = await getCalendarHold(client, id);
  if (!existing) return json(404, { error: 'Hold not found' });
  let next;
  try {
    next = confirmHoldRecord(existing);
  } catch (e: any) {
    return json(409, { error: String(e?.message || 'Cannot confirm hold'), code: e?.code || 'hold_state' });
  }
  const sync = await updateHoldGoogleEvents(existing.googleEventIds, confirmedTitle(existing.title), await depsFor({}, client));
  await putCalendarHold(client, {
    ...next,
    googleTitle: confirmedTitle(existing.title),
    ...(sync.state === 'synced' ? { googleSync: { state: 'synced' as const } } : {}),
  });
  return json(200, { hold: { ...next, googleTitle: confirmedTitle(existing.title) } });
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
  const sync = await deleteHoldGoogleEvents(existing.googleEventIds, await depsFor(body, client));
  await putCalendarHold(client, {
    ...next,
    ...(sync.state === 'synced' ? { googleSync: { state: 'synced' as const } } : {}),
  });
  return json(200, { hold: next });
}

async function expireRoute(client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const { expired, followUps } = await expireCalendarHolds(client);
  for (const hold of expired) {
    await deleteHoldGoogleEvents(hold.googleEventIds, await depsFor({}, client));
  }
  return json(200, {
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
    return expireRoute(client);
  }
  if (path === '/api/calendar-holds') {
    if (method === 'POST') return createRoute(event, client);
    if (method === 'GET') return listRoute(event, client);
    return json(405, { error: 'Method not allowed' });
  }
  const confirm = path.match(/^\/api\/calendar-holds\/([^/]+)\/confirm$/);
  if (confirm) {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    return confirmRoute(decodeURIComponent(confirm[1]), client);
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
