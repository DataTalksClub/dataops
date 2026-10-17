import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_BOOKKEEPING } from './tableNames';
import { readAllPages } from './readAllPages';

export type TuitionAgreement = {
  id: string; version: number; studentName: string; title: string;
  status: 'conditional' | 'due' | 'invoiced' | 'settled' | 'cancelled';
  trigger: string; amount?: string; currency?: string; dueOn?: string | null;
  notes?: string; taskIds?: string[]; createdAt: string; updatedAt: string;
};
const clean = (item?: Record<string, unknown>): TuitionAgreement | null => {
  if (!item) return null;
  const { PK, SK, ...record } = item; return record as TuitionAgreement;
};
export async function getTuitionAgreement(client: DynamoDBDocumentClient, id: string) {
  return clean((await client.send(new GetCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: 'TUITION', SK: id }, ConsistentRead: true }))).Item);
}
export async function listTuitionAgreements(client: DynamoDBDocumentClient) {
  const items = await readAllPages(client, (ExclusiveStartKey) => new QueryCommand({
    TableName: TABLE_BOOKKEEPING, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'TUITION' },
    ConsistentRead: true, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
  }));
  return items.map((item) => clean(item)!);
}
export async function saveTuitionAgreement(client: DynamoDBDocumentClient, value: Omit<TuitionAgreement, 'id' | 'version' | 'createdAt' | 'updatedAt'>, existing?: TuitionAgreement) {
  const now = new Date().toISOString();
  const item = { ...value, id: existing?.id || randomUUID(), version: (existing?.version || 0) + 1, createdAt: existing?.createdAt || now, updatedAt: now };
  await client.send(new PutCommand({ TableName: TABLE_BOOKKEEPING, Item: { PK: 'TUITION', SK: item.id, ...item },
    ...(existing ? { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': existing.version } }
      : { ConditionExpression: 'attribute_not_exists(PK)' }),
  }));
  return item;
}
export async function tuitionEvidence(client: DynamoDBDocumentClient, id: string) {
  return readAllPages(client, (ExclusiveStartKey) => new QueryCommand({
    TableName: TABLE_BOOKKEEPING, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `TUITION#${id}` },
    ConsistentRead: true, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
  }));
}
