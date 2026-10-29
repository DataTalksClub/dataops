import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { collectBoundedPages } from './boundedPagination';
import { TABLE_ARTIFACTS } from './tableNames';

export const DOCUMENT_KINDS = ['transcript', 'timecodes', 'summary', 'note'] as const;
export interface DocumentRecord {
  id: string;
  taskId: string;
  kind: typeof DOCUMENT_KINDS[number];
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export class DocumentVersionConflict extends Error {}
const key = (id: string) => ({ PK: `DOCUMENT#${id}`, SK: `DOCUMENT#${id}` });
function clean(item: Record<string, unknown>): DocumentRecord {
  const { PK, SK, ...doc } = item;
  return doc as unknown as DocumentRecord;
}
export async function getDocument(client: DynamoDBDocumentClient, id: string): Promise<DocumentRecord | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: key(id), ConsistentRead: true }));
  return result.Item ? clean(result.Item) : null;
}
export async function createDocument(client: DynamoDBDocumentClient, data: Pick<DocumentRecord, 'taskId' | 'kind' | 'title' | 'content'>): Promise<DocumentRecord> {
  const now = new Date().toISOString();
  const doc: DocumentRecord = { ...data, id: randomUUID(), version: 1, createdAt: now, updatedAt: now };
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...key(doc.id), ...doc }, ConditionExpression: 'attribute_not_exists(PK)' }));
  return doc;
}
export async function listDocuments(client: DynamoDBDocumentClient, taskId: string): Promise<DocumentRecord[]> {
  const rows = await collectBoundedPages<Record<string, unknown>>({
    loadPage: async (ExclusiveStartKey, abortSignal) => client.send(new ScanCommand({
      TableName: TABLE_ARTIFACTS, ExclusiveStartKey, ConsistentRead: true,
      FilterExpression: 'begins_with(PK, :prefix) AND taskId = :task',
      ExpressionAttributeValues: { ':prefix': 'DOCUMENT#', ':task': taskId },
    }), { abortSignal }),
    limits: { maxPages: 1000, maxItems: 1000, maxBytes: 8 * 1024 * 1024, deadlineMs: 10000 },
  });
  const docs = rows.map(clean);
  return docs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export async function updateDocument(client: DynamoDBDocumentClient, id: string, updates: Pick<DocumentRecord, 'title' | 'content'>, version: number): Promise<DocumentRecord | null> {
  const current = await getDocument(client, id);
  if (!current) return null;
  if (current.version !== version) throw new DocumentVersionConflict('Document changed; reload before saving');
  const doc = { ...current, ...updates, version: version + 1, updatedAt: new Date().toISOString() };
  try {
    await client.send(new PutCommand({
      TableName: TABLE_ARTIFACTS, Item: { ...key(id), ...doc },
      ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': version },
    }));
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw new DocumentVersionConflict('Document changed; reload before saving');
    throw error;
  }
  return doc;
}
