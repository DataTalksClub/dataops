import { createHash } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_BOOKKEEPING } from './setup';

export type BookkeepingItem = Record<string, unknown> & { id: string; createdAt: string; updatedAt: string };
const key = (kind: string, id: string) => `${kind.toUpperCase()}#${id}`;
const clean = (item?: Record<string, unknown>): BookkeepingItem | null => {
  if (!item) return null;
  const { PK, SK, ...value } = item;
  return value as BookkeepingItem;
};

export async function putBookkeepingItem(client: DynamoDBDocumentClient, kind: string, value: Record<string, unknown>, unique?: string): Promise<{ item: BookkeepingItem; duplicate: boolean }> {
  const id = String(value.id || (unique ? createHash('sha256').update(unique).digest('hex') : crypto.randomUUID()));
  const now = new Date().toISOString();
  const item = { PK: key(kind, id), SK: key(kind, id), ...value, id, createdAt: value.createdAt || now, updatedAt: now };
  try {
    await client.send(new PutCommand({ TableName: TABLE_BOOKKEEPING, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return { item: clean(item)!, duplicate: false };
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    if (!unique) throw error;
    const targetPK = key(kind, id);
    const existing = await client.send(new GetCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: targetPK, SK: targetPK } }));
    return { item: clean(existing.Item as Record<string, unknown>)!, duplicate: true };
  }
}

export async function getBookkeepingItem(client: DynamoDBDocumentClient, kind: string, id: string) {
  const result = await client.send(new GetCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: key(kind, id), SK: key(kind, id) } }));
  return clean(result.Item as Record<string, unknown>);
}

export async function listBookkeepingItems(client: DynamoDBDocumentClient, kind: string): Promise<BookkeepingItem[]> {
  const result = await client.send(new ScanCommand({ TableName: TABLE_BOOKKEEPING, FilterExpression: 'begins_with(PK, :prefix)', ExpressionAttributeValues: { ':prefix': `${kind.toUpperCase()}#` } }));
  return (result.Items || []).map(i => clean(i as Record<string, unknown>)!).sort((a, b) => String(b.transactionDate || b.createdAt).localeCompare(String(a.transactionDate || a.createdAt)));
}

export async function deleteBookkeepingItem(client: DynamoDBDocumentClient, kind: string, id: string) {
  const existing = await getBookkeepingItem(client, kind, id);
  if (existing) await client.send(new DeleteCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: key(kind, id), SK: key(kind, id) } }));
  return existing;
}
