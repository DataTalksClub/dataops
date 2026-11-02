import { ScanCommand, type DynamoDBDocumentClient, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { TABLE_TASKS } from '../db/tableNames';

const CHASE_ACTIONS = new Set(['follow-up-sent', 'waiting-started']);

/**
 * The first day someone followed up with the sponsor about a deal: the earliest
 * recorded follow-up (or wait) on any Task whose subject is that deal. A sponsor
 * that has been chased was sent the invoice, even when `sentOn` was never
 * recorded, so the money is past "send the invoice". One scan serves every deal;
 * pass `dealId` to look at a single deal.
 */
export async function chaseDates(client: DynamoDBDocumentClient, dealId?: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression: dealId ? 'subject.#type = :deal AND subject.id = :id' : 'subject.#type = :deal',
      ProjectionExpression: 'subject, taskHistory',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':deal': 'sponsor-deal', ...(dealId ? { ':id': dealId } : {}) },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of page.Items || []) {
      const subjectId = String((item.subject as { id?: unknown } | undefined)?.id || '');
      const history = Array.isArray(item.taskHistory) ? item.taskHistory as Array<Record<string, unknown>> : [];
      for (const event of history) {
        if (!CHASE_ACTIONS.has(String(event.action)) || typeof event.createdAt !== 'string') continue;
        const day = event.createdAt.slice(0, 10);
        const known = found.get(subjectId);
        if (!known || day < known) found.set(subjectId, day);
      }
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return found;
}
