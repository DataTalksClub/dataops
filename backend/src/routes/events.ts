import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { resolveInteractiveActor } from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import { getTemplateIdByType } from '../cards/createCard';
import { projectCard } from '../identity/projections';
import {
  approveEvent,
  EventConflictError,
  EventInputError,
  EventNotFoundError,
  getEventDetail,
  pollEventCalendarAcceptances,
  proposeEvent,
  releaseEvent,
  rescheduleEvent,
  retryEventOperation,
  toCalendarHoldView,
  type EventLifecycleResult,
} from '../events/service';

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function parseBody(raw: string | null | undefined): Record<string, any> | null {
  try {
    const val = raw ? JSON.parse(raw) : {};
    return val && typeof val === 'object' && !Array.isArray(val) ? val : null;
  } catch {
    return null;
  }
}

async function formatEventResponse(
  client: DynamoDBDocumentClient,
  result: EventLifecycleResult,
) {
  const directory = new TeamDirectory(client);
  const templateIdByType = await getTemplateIdByType(client);
  const projectedCard = await projectCard(directory, result.card, undefined, templateIdByType);
  return {
    event: result.event,
    hold: toCalendarHoldView(result),
    history: result.history,
    card: projectedCard,
    episode: result.episode,
    sync: result.sync,
    emailReceipts: result.emailReceipts,
    ...(result.attendeeResponses ? { attendeeResponses: result.attendeeResponses } : {}),
    ...(result.declinedBy ? { declinedBy: result.declinedBy } : {}),
  };
}

function parseTransitionInput(body: Record<string, any>, actorId: string) {
  const guestEmails = Array.isArray(body.guestEmails)
    ? body.guestEmails.map((e: unknown) => String(e).trim()).filter(Boolean)
    : typeof body.guestEmail === 'string' && body.guestEmail.trim()
      ? [body.guestEmail.trim()]
      : typeof body.guestRef === 'string' && body.guestRef.includes('@')
        ? [body.guestRef.trim()]
        : undefined;
  return {
    ...(typeof body.date === 'string' && body.date.trim() ? { date: body.date.trim() } : {}),
    ...(typeof body.time === 'string' && body.time.trim() ? { time: body.time.trim() } : {}),
    ...(typeof body.window === 'string' && body.window.trim() ? { window: body.window.trim() } : {}),
    ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
    ...(typeof body.topic === 'string' && body.topic.trim() ? { topic: body.topic.trim() } : {}),
    ...(typeof body.guestNames === 'string' && body.guestNames.trim()
      ? { guestNames: body.guestNames.trim() }
      : {}),
    ...(guestEmails !== undefined ? { guestEmails } : {}),
    ...(typeof body.documentUrl === 'string' ? { documentUrl: body.documentUrl.trim() } : {}),
    ...(typeof body.operationKey === 'string' && body.operationKey.trim()
      ? { operationKey: body.operationKey.trim() }
      : {}),
    ...(typeof body.now === 'string' && body.now.trim() ? { now: body.now.trim() } : {}),
    actor: actorId,
  };
}

export async function handleEventRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/events')) return null;

  const resolved = await resolveInteractiveActor(
    client,
    event,
    method === 'GET' ? 'work-read' : 'work-write',
  );
  if (!resolved.ok) return resolved.response;
  const actorId = resolved.actor.id || 'authenticated-operator';

  try {
    // POST /api/events/poll or POST /api/events/:targetId/poll
    const pollMatch = path.match(/^\/api\/events(?:\/([^/]+))?\/poll\/?$/);
    if (pollMatch) {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const body = parseBody(event.body);
      if (!body) return json(400, { error: 'Invalid JSON body' });
      const targetId = pollMatch[1]
        ? decodeURIComponent(pollMatch[1])
        : typeof body.targetId === 'string' && body.targetId.trim()
          ? body.targetId.trim()
          : typeof body.cardId === 'string' && body.cardId.trim()
            ? body.cardId.trim()
            : typeof body.holdId === 'string' && body.holdId.trim()
              ? body.holdId.trim()
              : undefined;
      const pollResult = await pollEventCalendarAcceptances(client, {
        ...(targetId ? { targetId } : {}),
        ...(typeof body.now === 'string' ? { now: body.now } : {}),
      });
      return json(200, pollResult);
    }

    // POST /api/events/google-webhook
    if (/^\/api\/events\/google-webhook\/?$/.test(path)) {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const body = parseBody(event.body) || {};
      const targetId =
        typeof body.targetId === 'string' && body.targetId.trim() ? body.targetId.trim() : undefined;
      const pollResult = await pollEventCalendarAcceptances(client, {
        ...(targetId ? { targetId } : {}),
      });
      return json(200, pollResult);
    }

    // POST /api/events/:action or POST /api/events/:targetId/:action
    const actionMatch = path.match(
      /^\/api\/events(?:\/([^/]+))?\/(propose|approve|reschedule|release|retry)\/?$/,
    );
    if (actionMatch) {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const body = parseBody(event.body);
      if (!body) return json(400, { error: 'Invalid JSON body' });
      const action = actionMatch[2] as 'propose' | 'approve' | 'reschedule' | 'release' | 'retry';
      const targetId = actionMatch[1]
        ? decodeURIComponent(actionMatch[1])
        : String(body.targetId || body.cardId || body.holdId || body.episodeId || '').trim();
      if (!targetId) {
        return json(400, { error: 'targetId (Card ID, Hold ID, or Episode ID) is required' });
      }
      let result: EventLifecycleResult;
      if (action === 'retry') {
        result = await retryEventOperation(client, targetId, {
          ...(typeof body.operationKey === 'string' ? { operationKey: body.operationKey } : {}),
          ...(body.forceEmailRetry === true ? { forceEmailRetry: true } : {}),
          actor: actorId,
        });
      } else if (action === 'propose') {
        result = await proposeEvent(client, targetId, parseTransitionInput(body, actorId));
      } else if (action === 'approve') {
        result = await approveEvent(client, targetId, parseTransitionInput(body, actorId));
      } else if (action === 'reschedule') {
        result = await rescheduleEvent(client, targetId, parseTransitionInput(body, actorId));
      } else {
        result = await releaseEvent(client, targetId, parseTransitionInput(body, actorId));
      }
      const status = action === 'propose' ? 201 : 200;
      return json(status, await formatEventResponse(client, result));
    }

    // GET /api/events/:targetId
    const detailMatch = path.match(/^\/api\/events\/([^/]+)\/?$/);
    if (detailMatch) {
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      const targetId = decodeURIComponent(detailMatch[1]);
      const result = await getEventDetail(client, targetId);
      return json(200, await formatEventResponse(client, result));
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof EventNotFoundError) {
      return json(404, { error: err.message, code: 'event_not_found' });
    }
    if (err instanceof EventConflictError) {
      return json(409, { error: err.message, code: 'event_conflict' });
    }
    if (err instanceof EventInputError) {
      return json(422, { error: err.message, code: 'event_input_error' });
    }
    throw err;
  }
}
