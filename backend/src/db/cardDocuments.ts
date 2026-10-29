import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { collectBoundedPages } from './boundedPagination';
import { getCardConsistent } from './cards';
import { TABLE_ARTIFACTS } from './tableNames';

export const CARD_DOCUMENT_KINDS = ['transcript', 'timecodes', 'summary', 'note'] as const;
export interface CardDocumentRecord {
  id: string;
  cardId: string;
  kind: typeof CARD_DOCUMENT_KINDS[number];
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export type CardDocumentSummary = Omit<CardDocumentRecord, 'content'>;
export class CardDocumentVersionConflict extends Error {}
const key = (id: string) => ({ PK: `CARD_DOCUMENT#${id}`, SK: `CARD_DOCUMENT#${id}` });
function clean(item: Record<string, unknown>): CardDocumentRecord {
  const { PK, SK, ...doc } = item;
  return doc as unknown as CardDocumentRecord;
}
export async function getCardDocument(client: DynamoDBDocumentClient, id: string): Promise<CardDocumentRecord | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: key(id), ConsistentRead: true }));
  if (!result.Item) return null;
  const document = clean(result.Item);
  return await getCardConsistent(client, document.cardId) ? document : null;
}
export async function createCardDocument(client: DynamoDBDocumentClient, data: Pick<CardDocumentRecord, 'cardId' | 'kind' | 'title' | 'content'>): Promise<CardDocumentRecord> {
  const now = new Date().toISOString();
  const doc: CardDocumentRecord = { ...data, id: randomUUID(), version: 1, createdAt: now, updatedAt: now };
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...key(doc.id), ...doc }, ConditionExpression: 'attribute_not_exists(PK)' }));
  return doc;
}
export async function listCardDocuments(client: DynamoDBDocumentClient, cardId: string): Promise<CardDocumentSummary[]> {
  const rows = await collectBoundedPages<Record<string, unknown>>({
    loadPage: async (ExclusiveStartKey, abortSignal) => client.send(new ScanCommand({
      TableName: TABLE_ARTIFACTS, ExclusiveStartKey, ConsistentRead: true,
      // Lists contain metadata only; retrieve text through GET /:id. This keeps
      // valid collections below Lambda's synchronous response size limit.
      ProjectionExpression: 'id, cardId, kind, title, #version, createdAt, updatedAt',
      ExpressionAttributeNames: { '#version': 'version' },
      FilterExpression: 'begins_with(PK, :prefix) AND cardId = :task',
      ExpressionAttributeValues: { ':prefix': 'CARD_DOCUMENT#', ':task': cardId },
    }), { abortSignal }),
    limits: { maxPages: 1000, maxItems: 1000, maxBytes: 8 * 1024 * 1024, deadlineMs: 10000 },
  });
  const docs = rows as unknown as CardDocumentSummary[];
  return docs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export async function updateCardDocument(client: DynamoDBDocumentClient, id: string, updates: Pick<CardDocumentRecord, 'title' | 'content'>, version: number): Promise<CardDocumentRecord | null> {
  const current = await getCardDocument(client, id);
  if (!current) return null;
  if (current.version !== version) throw new CardDocumentVersionConflict('Document changed; reload before saving');
  const doc = { ...current, ...updates, version: version + 1, updatedAt: new Date().toISOString() };
  try {
    await client.send(new PutCommand({
      TableName: TABLE_ARTIFACTS, Item: { ...key(id), ...doc },
      ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': version },
    }));
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw new CardDocumentVersionConflict('Document changed; reload before saving');
    throw error;
  }
  return doc;
}

/** Card documents have no guest review identities or access codes. */
export async function deleteCardDocument(client: DynamoDBDocumentClient, id: string, version: number): Promise<boolean> {
  try {
    await client.send(new DeleteCommand({ TableName: TABLE_ARTIFACTS, Key: key(id),
      ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':version': version },
    }));
    return true;
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    if (!await getCardDocument(client, id)) return false;
    throw new CardDocumentVersionConflict('Document changed; reload before deleting');
  }
}
