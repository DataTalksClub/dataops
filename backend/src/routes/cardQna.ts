import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCardConsistent, listCards } from '../db/cards';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import { backfillCardQna, buildCardAnnouncement, cardHasQnaEventType, closeCardQna, ensureCardQna, readCardQnaQuestions } from '../qna/service';
import type { LambdaEvent, LambdaResponse } from '../types';
import { JSON_HEADERS } from '../http';

const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) });

/**
 * Card Q&A routes (audience Q&A on qna.dtcdev.click):
 *   POST /api/cards/qna/backfill          admin: give every upcoming dated event Card a room
 *   GET  /api/cards/:id/qna/questions     stable read model: live while open, saved copy once closed
 *   GET  /api/cards/:id/qna/announcement  announcement snippet with the Card's Q&A room link
 *   POST /api/cards/:id/qna               create the Card's room (idempotent)
 *   POST /api/cards/:id/qna/close         close the room and save every question on the Card
 */
export async function handleCardQnaRoute(
  method: string,
  suffix: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const backfill = /^\/qna\/backfill\/?$/.test(suffix);
  const match = suffix.match(/^\/([^/]+)\/qna(?:\/(questions|announcement|close))?\/?$/);
  if (!backfill && !match) return null;
  const read = method === 'GET';
  const resolved = await resolveInteractiveActor(client, event, read ? 'work-read' : 'work-write');
  if (!resolved.ok) return resolved.response;
  const actor = resolved.actor;

  if (backfill) {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!actor.testBypass && !actor.isAdmin) return workAdminForbidden('Backfilling Q&A rooms requires an admin');
    return json(200, await backfillCardQna(client, await listCards(client)));
  }

  const [, id, action] = match!;
  const card = await getCardConsistent(client, id);
  if (!card) return json(404, { error: 'Card not found' });
  if (action === 'questions' || action === 'announcement') {
    if (!read) return json(405, { error: 'Method not allowed' });
    const body = action === 'announcement' ? buildCardAnnouncement(card) : await readCardQnaQuestions(card);
    return body ? json(200, body) : json(404, { error: 'This Card has no Q&A room', code: 'qna_not_found' });
  }
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!actor.testBypass && !actor.isAdmin && !(actor.id && card.ownerId === actor.id)) {
    return workAdminForbidden('Managing the Q&A requires the Card owner or an admin');
  }
  if (!(await cardHasQnaEventType(client, card))) return json(422, { error: 'Only podcast, webinar and workshop Cards have a Q&A', code: 'qna_not_event_card' });
  const updated = action === 'close' ? await closeCardQna(client, card) : await ensureCardQna(client, card);
  return json(200, { qna: updated.qna });
}
