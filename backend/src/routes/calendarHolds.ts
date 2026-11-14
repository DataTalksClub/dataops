import { linkConfirmedHold, HoldLinkError } from '../calendar/linkConfirmedHold';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import {
  buildHold,
  confirmHoldRecord,
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
  fetchGoogleEvent,
  HOLD_ORGANIZER,
  updateHoldGoogleEvents,
} from '../calendar/holdGoogleSync';
import { buildGuestInvite, GuestInviteValidationError } from '../calendar/guestInvite';
import { reportGuestInviteFailure, writeGuestInvite } from '../calendar/guestInviteSync';
import { PUBLIC_DTC_EVENTS_CALENDAR, resolveHoldGoogleCalendars } from '../calendar/dapierBroker';
import { resolveInteractiveActor } from '../identity/actor';
import {
  calendarInviteDeps,
  expireCalendarHolds,
  getCalendarHold,
  listCalendarHolds,
  putCalendarHold,
  setCalendarHoldGoogleDepsForTests,
} from '../db/calendarHolds';
import { CardVersionConflictError, getCardConsistent } from '../db/cards';
import { listPodcastEpisodes, type PodcastEpisode } from '../db/podcastEpisodes';
import { CardInviteConflictError, CardInviteInputError, resolvePodcastCardInviteTitle, syncCardInvite } from '../calendar/cardInvite';
import { recordAutomationRun } from '../automations/runs';
import {
  EventConflictError,
  EventInputError,
  EventNotFoundError,
  rescheduleEvent,
  toCalendarHoldView,
} from '../events/service';

import { json } from '../http';
import { realDate } from '../sponsorCrm/model';

export { calendarInviteDeps, setCalendarHoldGoogleDepsForTests };

// Kept separate from http.parseJsonObjectEventOrEmpty: does not filter non-object JSON here (callers validate fields).
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
    return json(422, { error: 'Card-linked proposals use dataops event propose CARD_ID so the invitation stays linked and updateable. Standalone calendar propose creates only a private hold.', code: 'use_card_event_proposal' });
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
  const original = await getCalendarHold(client, id);
  if (!original) return json(404, { error: 'Hold not found' });
  let existing = original;
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
  let card = existing.cardId ? await getCardConsistent(client, existing.cardId) : null;
  let episode: PodcastEpisode | null = null;
  try {
    const episodes = await listPodcastEpisodes(client);
    if (card) {
      episode = episodes.find((item) => item.cardId === card!.id) || null;
    } else {
      episode = episodes.find((item) => item.recordingHoldId === existing.id && item.cardId) || null;
      if (!episode) {
        const guestEmail = existing.guestRef?.trim().toLowerCase();
        const dateMatches = episodes.filter((item) => item.cardId && !item.recordingHoldId && item.recordingDate === existing.date);
        episode = (guestEmail
          ? dateMatches.find((item) => item.guests?.some((g) => String(g.email || '').trim().toLowerCase() === guestEmail))
          : undefined) || (dateMatches.length === 1 ? dateMatches[0] : null) || null;
      }
      if (episode?.cardId) {
        card = await getCardConsistent(client, episode.cardId);
      }
    }
  } catch {
    episode = null;
  }
  if (!existing.guestRef) {
    const fallbackEmail = episode?.guests?.map((g) => String(g.email || '').trim()).find(Boolean)
      || card?.guestEmails?.map((e) => String(e || '').trim()).find(Boolean);
    if (fallbackEmail) existing = { ...existing, guestRef: fallbackEmail };
  }
  if (!existing.guestRef || !holdGuestAttendees(existing.guestRef).includes(existing.guestRef.trim().toLowerCase())) {
    return json(422, { error: 'A guest email is required before sending the calendar invite.', code: 'guest_required' });
  }
  const detailsChanged =
    (existing.guestRef || '').trim().toLowerCase() !== (original.guestRef || '').trim().toLowerCase() ||
    existing.documentUrl !== original.documentUrl;
  const podcastTitle = card ? await resolvePodcastCardInviteTitle(client, card, undefined, episode) : undefined;
  const desiredTitle = confirmedTitle(podcastTitle || existing.title || card?.title || 'DataTalks.Club event');
  const eventIdEntries = Object.entries(existing.googleEventIds || {});
  const cardHasInvite = Boolean(
    card &&
    card.eventTime?.eventKey === existing.id &&
    card.eventTime?.sync === 'synced' &&
    eventIdEntries.length > 0 &&
    eventIdEntries.every(([calendar, eventId]) =>
      card!.calendarInvites?.some((item) => item.calendar === calendar && item.eventId === eventId && !item.staleAt),
    ),
  );
  if (
    card &&
    existing.status === 'confirmed' &&
    existing.googleSync.state === 'synced' &&
    cardHasInvite &&
    existing.cardId === card.id &&
    existing.title === desiredTitle &&
    existing.googleTitle === desiredTitle &&
    !detailsChanged
  ) {
    return json(200, { hold: existing });
  }
  let next;
  try {
    next = existing.status === 'confirmed' && (existing.googleSync.state === 'deferred' || Boolean(card))
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
  const invite = buildGuestInvite({
    eventKey: next.id, title: next.title, documentUrl: next.documentUrl, guests: next.guestRef ? [next.guestRef] : [],
    startIso: next.startIso, endIso: next.endIso,
  }, deps.calendarIds);
  if (card) {
    try {
      const result = await syncCardInvite(client, card, {
        startIso: next.startIso, endIso: next.endIso, timeZone: next.timeZone, durationMinutes: next.durationMinutes,
      }, [existing.guestRef!.trim().toLowerCase()], deps, actor(event), {
        ...existing,
        cardId: card.id,
        ...(podcastTitle ? { title: podcastTitle } : {}),
        documentUrl: next.documentUrl,
      });
      return json(200, { hold: result.hold });
    } catch (error) {
      if (error instanceof CardVersionConflictError || error instanceof CardInviteConflictError) {
        return json(409, { error: error.message, code: 'card_invite_conflict' });
      }
      if (error instanceof CardInviteInputError) return json(422, { error: error.message });
      throw error;
    }
  }
  const inviteEventIds = Object.fromEntries(Object.entries(existing.googleEventIds || {})
    .filter(([calendar]) => calendar !== PUBLIC_DTC_EVENTS_CALENDAR));
  let sync;
  try { sync = await writeGuestInvite(invite, inviteEventIds, deps); }
  catch (error) {
    if (error instanceof GuestInviteValidationError) {
      await reportGuestInviteFailure(client, error, { actorId: actor(event) });
      return json(502, { error: error.message, code: 'guest_invite_validation_failed', problems: error.problems });
    }
    throw error;
  }
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

async function moveRoute(
  id: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const body = parse(event);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { error: 'Request body is required' });
  }
  const existing = await getCalendarHold(client, id);
  if (!existing) return json(404, { error: 'Hold not found' });

  // Delegate to unified event lifecycle service if the hold is backed by a Card with an eventPolicy
  if (existing.cardId) {
    try {
      if (body.suppressGuestNotifications !== undefined && typeof body.suppressGuestNotifications !== 'boolean') {
        throw new EventInputError('suppressGuestNotifications must be a boolean');
      }
      const result = await rescheduleEvent(client, id, {
        ...(body.suppressGuestNotifications === true ? { suppressGuestNotifications: true } : {}),
        ...(body.expiresDays !== undefined ? { expiresDays: body.expiresDays } : {}),
        ...(typeof body.date === 'string' ? { date: body.date } : {}),
        ...(typeof body.time === 'string' ? { time: body.time } : {}),
        ...(typeof body.window === 'string' ? { window: body.window } : {}),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.topic === 'string' ? { topic: body.topic } : {}),
        ...(typeof body.documentUrl === 'string' ? { documentUrl: body.documentUrl } : {}),
        ...(typeof body.guestRef === 'string' && body.guestRef.includes('@')
          ? { guestEmails: [body.guestRef.trim()] }
          : {}),
        actor: actor(event),
      });
      return json(200, {
        hold: toCalendarHoldView(result),
        event: result.event,
        card: result.card,
        episode: result.episode,
      });
    } catch (err) {
      if (err instanceof EventConflictError) return json(409, { error: err.message, code: 'event_conflict' });
      if (err instanceof EventNotFoundError) return json(404, { error: err.message, code: 'event_not_found' });
      if (!(err instanceof EventInputError && err.message.includes('does not declare an eventPolicy'))) {
        if (err instanceof EventInputError) return json(422, { error: err.message, code: 'event_input_error' });
        throw err;
      }
      // Fallback below when a standalone/legacy Card has no eventPolicy
    }
  }

  if (existing.status === 'released' || existing.status === 'expired') {
    return json(409, { error: `Cannot move a ${existing.status} hold; propose a new hold instead.`, code: 'hold_state' });
  }

  let rebuilt;
  try {
    rebuilt = buildHold(
      {
        date: body.date ?? existing.date,
        window: body.window ?? existing.window,
        duration: body.duration ?? body.durationMinutes ?? existing.durationMinutes,
        durationMinutes: body.durationMinutes ?? existing.durationMinutes,
        title: body.title ?? existing.title,
        topic: body.topic ?? existing.topic,
        cardId: existing.cardId,
        guestRef: body.guestRef ?? existing.guestRef,
        documentUrl: body.documentUrl ?? existing.documentUrl,
        organizationId: existing.organizationId,
        expiresDays: body.expiresDays ?? existing.expiresDays,
        googleCalendars: body.googleCalendars,
      },
      actor(event),
    );
  } catch (e: any) {
    return json(400, { error: String(e?.message || 'Invalid hold move') });
  }

  const deps = { ...await calendarInviteDeps(body, client), ...(body.suppressGuestNotifications === true ? { sendUpdates: 'none' as const } : {}) };
  const payload = googlePayload(existing, proposalTitle(rebuilt.title), rebuilt.startIso, rebuilt.endIso);
  const sync = Object.keys(existing.googleEventIds || {}).length
    ? await updateHoldGoogleEvents(existing.googleEventIds, payload, deps)
    : await createHoldGoogleEvents(payload, deps);

  const stored = {
    ...rebuilt,
    id: existing.id,
    proposedAt: existing.proposedAt,
    proposedBy: existing.proposedBy,
    status: 'tentative' as const,
    googleTitle: proposalTitle(rebuilt.title),
    version: existing.version + 1,
    ...(sync.state === 'synced'
      ? { googleEventIds: sync.eventIds, googleSync: { state: 'synced' as const } }
      : { googleEventIds: sync.eventIds, googleSync: { state: 'deferred' as const, reason: sync.reason } }),
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

/** Guest-safe view of a live Google event; internal extendedProperties never leave the backend. */
function googleEventView(event: any) {
  return {
    id: event.id,
    status: event.status,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: event.start,
    end: event.end,
    attendees: (event.attendees || []).map((attendee: { email?: string; responseStatus?: string }) => ({
      email: attendee.email,
      responseStatus: attendee.responseStatus,
    })),
  };
}

function publicCalendarWarnings(event: any): string[] {
  const details = `${event.description || ''}\n${event.location || ''}`;
  const warnings = [];
  if (/zoom\.us|zoom\.com/i.test(details)) warnings.push('public_calendar_contains_zoom_link');
  if (/ops\.dtcdev\.click/i.test(details)) warnings.push('public_calendar_contains_internal_link');
  if ((event.attendees || []).length) warnings.push('public_calendar_contains_attendees');
  return warnings;
}

/**
 * Read one Google event as it exists right now — by default on the organizer
 * calendar, every configured personal calendar and the public DTC events
 * calendar, or on `?calendar=` (one of those). Public entries include safety
 * warnings when they expose Zoom/internal links or attendees.
 */
async function googleEventRoute(eventId: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const actor = await resolveInteractiveActor(client, event, 'work-read');
  if (!actor.ok) return actor.response;
  const q = event.queryStringParameters || {};
  const calendar = String(q.calendar || '').trim();
  const deps = await calendarInviteDeps({}, client);
  const allowed = [...new Set([HOLD_ORGANIZER, PUBLIC_DTC_EVENTS_CALENDAR, ...resolveHoldGoogleCalendars(deps.calendarIds)])];
  const targets = calendar ? [calendar] : allowed;
  const unknown = targets.find((candidate) => !allowed.includes(candidate));
  if (unknown) {
    return json(400, { error: `Calendar ${unknown} is not a DataOps hold calendar (${allowed.join(', ')}).` });
  }
  const events = [];
  for (const candidate of targets) {
    const fetched = await fetchGoogleEvent(eventId, candidate, deps);
    events.push(
      fetched.state === 'ok'
        ? { calendar: candidate, state: 'ok', event: googleEventView(fetched.event),
            ...(candidate === PUBLIC_DTC_EVENTS_CALENDAR ? { warnings: publicCalendarWarnings(fetched.event) } : {}) }
        : fetched.state === 'gone'
          ? { calendar: candidate, state: 'gone' }
          : { calendar: candidate, state: 'deferred', reason: fetched.reason },
    );
  }
  return json(200, { eventId, events });
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
  const link = path.match(/^\/api\/calendar-holds\/([^/]+)\/link-card$/);
  if (link) {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    const auth = await resolveInteractiveActor(client, event, 'work-write');
    if (!auth.ok) return auth.response;
    if (!auth.actor.isAdmin && !auth.actor.testBypass) return json(403, { error: 'Calendar association repair requires an admin' });
    const body = parse(event);
    if (!body || typeof body.cardId !== 'string' || !body.cardId.trim()) return json(400, { error: 'cardId is required' });
    for (const field of ['expectedCardVersion', 'expectedHoldVersion', 'expectedEpisodeVersion']) {
      if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || body[field] < 0)) return json(400, { error: `${field} must be a nonnegative integer` });
    }
    if (body.apply === true && (body.expectedCardVersion === undefined || body.expectedHoldVersion === undefined)) return json(400, { error: 'Apply requires the reviewed Card and hold versions' });
    try {
      return json(200, await linkConfirmedHold(client, decodeURIComponent(link[1]), body.cardId.trim(), await calendarInviteDeps({}, client), auth.actor.id, body));
    } catch (e) {
      if (e instanceof HoldLinkError) return json(e.status, { error: e.message, code: 'hold_link_conflict' });
      throw e;
    }
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
  const move = path.match(/^\/api\/calendar-holds\/([^/]+)\/move$/);
  if (move) {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    return moveRoute(decodeURIComponent(move[1]), event, client);
  }
  const googleEvent = path.match(/^\/api\/calendar-holds\/google-events\/([^/]+)$/);
  if (googleEvent) {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    return googleEventRoute(decodeURIComponent(googleEvent[1]), event, client);
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
