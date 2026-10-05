import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_INTAKE } from './tableNames';
import type { IntakeItem } from '../types';

function cleanItem(item: Record<string, unknown> | undefined): IntakeItem | null {
  if (!item) return null;
  const {
    PK,
    SK,
    sourceMessageKey,
    ownerStatusKey,
    assigneeStatusKey,
    assistantStatusKey,
    ...rest
  } = item;
  return rest as unknown as IntakeItem;
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneUndefined).filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = pruneUndefined(child);
      if (next !== undefined) clean[key] = next;
    }
    return clean;
  }
  return value;
}

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const next = pruneUndefined(value);
    if (next !== undefined) clean[key] = next;
  }
  return clean;
}

function derivedKeys(item: Record<string, unknown>): Record<string, unknown> {
  const source = typeof item.source === 'string' ? item.source : '';
  const sourceMessageId = typeof item.sourceMessageId === 'string' ? item.sourceMessageId : '';
  const ownerId = typeof item.ownerId === 'string' ? item.ownerId : '';
  const assigneeId = typeof item.assigneeId === 'string' ? item.assigneeId : '';
  const status = typeof item.status === 'string' ? item.status : '';
  const assistantReadiness = item.assistantReadiness && typeof item.assistantReadiness === 'object' && !Array.isArray(item.assistantReadiness)
    ? item.assistantReadiness as Record<string, unknown>
    : null;
  const assistantStatus = typeof assistantReadiness?.status === 'string' ? assistantReadiness.status : '';
  return withoutUndefined({
    sourceMessageKey: source && sourceMessageId ? `${source}#${sourceMessageId}` : undefined,
    ownerStatusKey: ownerId && status ? `${ownerId}#${status}` : undefined,
    assigneeStatusKey: assigneeId && status ? `${assigneeId}#${status}` : undefined,
    assistantStatusKey: assistantStatus ? `${assistantStatus}#${status || 'unknown'}` : undefined,
  });
}

async function createIntakeItemIfAbsent(
  client: DynamoDBDocumentClient,
  data: Record<string, unknown>
): Promise<{ item: IntakeItem; created: boolean }> {
  const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id : crypto.randomUUID();
  const now = new Date().toISOString();
  const item = withoutUndefined({
    PK: `INTAKE#${id}`,
    SK: `INTAKE#${id}`,
    id,
    source: 'manual',
    sourceReceivedAt: now,
    status: 'new',
    title: 'Untitled intake',
    summary: '',
    receivedChannels: [],
    linkRefs: [],
    fileRefs: [],
    artifactRefs: [],
    taskIds: [],
    cardIds: [],
    assistantJobIds: [],
    relatedIntakeItemIds: [],
    tags: [],
    priority: 'normal',
    dataClass: 'internal',
    history: [],
    createdAt: now,
    updatedAt: now,
    ...data,
  });
  Object.assign(item, derivedKeys(item));

  try {
    await client.send(new PutCommand({
      TableName: TABLE_INTAKE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return { item: cleanItem(item) as IntakeItem, created: true };
  } catch (error) {
    if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
    const existing = await getIntakeItem(client, id);
    if (!existing) throw error;
    return { item: existing, created: false };
  }
}

async function getIntakeItem(client: DynamoDBDocumentClient, id: string): Promise<IntakeItem | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_INTAKE,
    Key: { PK: `INTAKE#${id}`, SK: `INTAKE#${id}` },
  }));
  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

async function updateIntakeItem(
  client: DynamoDBDocumentClient,
  id: string,
  updates: Record<string, unknown>
): Promise<IntakeItem | null> {
  const existing = await getIntakeItem(client, id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const merged = { ...existing, ...updates, updatedAt: now };
  const fields = withoutUndefined({
    ...updates,
    updatedAt: now,
    ...derivedKeys(merged),
  });

  const expressionParts: string[] = [];
  const removeParts: string[] = [];
  const expressionAttrNames: Record<string, string> = {};
  const expressionAttrValues: Record<string, unknown> = {};

  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    const nameToken = `#f${i}`;
    expressionAttrNames[nameToken] = key;
    if (value === null) {
      removeParts.push(nameToken);
    } else {
      const valueToken = `:v${i}`;
      expressionParts.push(`${nameToken} = ${valueToken}`);
      expressionAttrValues[valueToken] = value;
    }
    i++;
  }
  const updateExpressions = [];
  if (expressionParts.length) updateExpressions.push(`SET ${expressionParts.join(', ')}`);
  if (removeParts.length) updateExpressions.push(`REMOVE ${removeParts.join(', ')}`);

  const result = await client.send(new UpdateCommand({
    TableName: TABLE_INTAKE,
    Key: { PK: `INTAKE#${id}`, SK: `INTAKE#${id}` },
    UpdateExpression: updateExpressions.join(' '),
    ExpressionAttributeNames: expressionAttrNames,
    ExpressionAttributeValues: Object.keys(expressionAttrValues).length > 0 ? expressionAttrValues : undefined,
    ReturnValues: 'ALL_NEW',
  }));

  return cleanItem(result.Attributes as Record<string, unknown>);
}

export {
  createIntakeItemIfAbsent,
  getIntakeItem,
  updateIntakeItem,
};
