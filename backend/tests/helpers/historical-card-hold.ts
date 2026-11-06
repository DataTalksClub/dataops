import { handler as realHandler } from '../../src/handler';
import { getClient } from '../../src/db/client';
import { getCalendarHold, putCalendarHold } from '../../src/db/calendarHolds';
import type { LambdaEvent, LambdaResponse } from '../../src/types';

/** Seed a historical Card-linked hold while exercising its original provider proposal.
 * New Card-linked proposals use /api/events; these tests cover previously saved
 * holds that must still confirm/reconcile safely after the creation route changes. */
export async function invokeHistoricalHoldFixture(event: LambdaEvent, context?: unknown): Promise<LambdaResponse> {
  const body = event.body ? JSON.parse(event.body) : null;
  if (event.httpMethod !== 'POST' || event.path !== '/api/calendar-holds' || !body?.cardId) return realHandler(event, context);
  const { cardId, ...standalone } = body;
  const response = await realHandler({ ...event, body: JSON.stringify(standalone) }, context);
  if (response.statusCode !== 201) return response;
  const payload = JSON.parse(response.body);
  const db = await getClient();
  const hold = await getCalendarHold(db, payload.hold.id);
  if (!hold) throw new Error('Historical fixture hold was not persisted');
  await putCalendarHold(db, { ...hold, cardId });
  return { ...response, body: JSON.stringify({ ...payload, hold: { ...payload.hold, cardId } }) };
}
