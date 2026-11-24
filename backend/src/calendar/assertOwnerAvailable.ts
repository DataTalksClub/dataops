import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { formatBerlinDate, ownerCalendarOverlay } from './ownerCalendarOverlay';

export class OwnerAvailabilityError extends Error {
  constructor(message: string, public statusCode: 409 | 503) { super(message); this.name = 'OwnerAvailabilityError'; }
}

/** Fresh read at the last boundary before any calendar write, including retries. */
export async function assertOwnerAvailable(client: DynamoDBDocumentClient | undefined, startIso: string, endIso: string, existingEventIds: Record<string,string> = {}): Promise<void> {
  const from = formatBerlinDate(startIso), to = formatBerlinDate(endIso);
  const projection = await ownerCalendarOverlay({ client, includeAll: true, excludeEventIds: existingEventIds }).project(from, to);
  if (projection.connection.state !== 'connected') throw new OwnerAvailabilityError(`Cannot book: owner freebusy unavailable. ${projection.connection.reason || ''}`, 503);
  const start = Date.parse(startIso), end = Date.parse(endIso);
  const conflicts = projection.items.filter(item => item.startsAt && item.endsAt
    ? Date.parse(item.startsAt) < end && Date.parse(item.endsAt) > start
    : item.startDate <= to && item.endDate >= from);
  if (conflicts.length) throw new OwnerAvailabilityError(`Cannot book: owner calendar conflict: ${conflicts.map(item => item.label).join('; ')}. Use dataops calendar day ${from} to review.`, 409);
}
