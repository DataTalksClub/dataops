import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_INTAKE } from './setup';
import type { IntakeItem } from '../types';

export interface IntakeFilters {
  status?: string;
  dueFollowUpAt?: string;
  followUpFrom?: string;
  followUpTo?: string;
  standaloneOnly?: string;
  source?: string;
  ownerId?: string;
  assigneeId?: string;
  priority?: string;
  tag?: string;
  taskId?: string;
  bundleId?: string;
  assistantReadinessStatus?: string;
  duplicateState?: string;
  from?: string;
  to?: string;
}

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

function matchesFilters(item: IntakeItem, filters: IntakeFilters): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'tag' && !(item.tags || []).includes(String(value))) return false;
    else if (key === 'taskId' && !(item.taskIds || []).includes(String(value))) return false;
    else if (key === 'bundleId' && !(item.bundleIds || []).includes(String(value))) return false;
    else if (key === 'assistantReadinessStatus' && item.assistantReadiness?.status !== value) return false;
    else if (key === 'duplicateState' && value === 'duplicates' && !item.duplicateOfIntakeItemId) return false;
    else if (key === 'duplicateState' && value === 'not-duplicates' && item.duplicateOfIntakeItemId) return false;
    else if (key === 'from' && String(item.sourceReceivedAt || '') < String(value)) return false;
    else if (key === 'to' && String(item.sourceReceivedAt || '') > String(value)) return false;
    else if (key === 'dueFollowUpAt') {
      if (!item.followUpAt || String(item.followUpAt).slice(0, 10) > String(value).slice(0, 10)) return false;
    }
    else if (key === 'followUpFrom' && String(item.followUpAt || '') < String(value)) return false;
    else if (key === 'followUpTo' && String(item.followUpAt || '').slice(0, 10) > String(value).slice(0, 10)) return false;
    else if (key === 'standaloneOnly' && String(value) === 'true' && (item.taskIds || []).length > 0) return false;
    else if (!['tag', 'taskId', 'bundleId', 'assistantReadinessStatus', 'duplicateState', 'from', 'to', 'dueFollowUpAt', 'followUpFrom', 'followUpTo', 'standaloneOnly'].includes(key)) {
      if ((item as unknown as Record<string, unknown>)[key] !== value) return false;
    }
  }
  return true;
}

async function createIntakeItem(
  client: DynamoDBDocumentClient,
  data: Record<string, unknown>
): Promise<IntakeItem> {
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
    bundleIds: [],
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

  await client.send(new PutCommand({
    TableName: TABLE_INTAKE,
    Item: item,
  }));

  return cleanItem(item) as IntakeItem;
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
    bundleIds: [],
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

async function findIntakeBySourceMessage(
  client: DynamoDBDocumentClient,
  source: string,
  sourceMessageId: string
): Promise<IntakeItem | null> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_INTAKE,
    IndexName: 'GSI-SourceMessage',
    KeyConditionExpression: 'sourceMessageKey = :sourceMessageKey',
    ExpressionAttributeValues: {
      ':sourceMessageKey': `${source}#${sourceMessageId}`,
    },
  }));
  const first = result.Items?.[0] as Record<string, unknown> | undefined;
  return first ? cleanItem(first) : null;
}

async function listIntakeItems(
  client: DynamoDBDocumentClient,
  filters: IntakeFilters = {}
): Promise<IntakeItem[]> {
  const query =
    filters.ownerId && filters.status
      ? {
          IndexName: 'GSI-OwnerStatus',
          KeyConditionExpression: 'ownerStatusKey = :key',
          ExpressionAttributeValues: { ':key': `${filters.ownerId}#${filters.status}` },
        }
      : filters.assigneeId && filters.status
        ? {
            IndexName: 'GSI-AssigneeStatus',
            KeyConditionExpression: 'assigneeStatusKey = :key',
            ExpressionAttributeValues: { ':key': `${filters.assigneeId}#${filters.status}` },
          }
        : filters.assistantReadinessStatus && filters.status
          ? {
              IndexName: 'GSI-AssistantStatus',
              KeyConditionExpression: 'assistantStatusKey = :key',
              ExpressionAttributeValues: { ':key': `${filters.assistantReadinessStatus}#${filters.status}` },
            }
          : filters.status
            ? {
                IndexName: 'GSI-Status',
                KeyConditionExpression: '#status = :status',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':status': filters.status },
              }
            : null;

  if (query) {
    const items: IntakeItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(new QueryCommand({
        TableName: TABLE_INTAKE,
        ...query,
        ExclusiveStartKey: lastEvaluatedKey,
      }));
      items.push(...(result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as IntakeItem));
      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return items
      .filter((item) => matchesFilters(item, filters))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  const filterExpressions: string[] = ['begins_with(PK, :prefix)'];
  const expressionAttrValues: Record<string, unknown> = { ':prefix': 'INTAKE#' };
  const expressionAttrNames: Record<string, string> = {};

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'tag') {
      filterExpressions.push('contains(tags, :tag)');
      expressionAttrValues[':tag'] = value;
      continue;
    }
    if (key === 'taskId') {
      filterExpressions.push('contains(taskIds, :taskId)');
      expressionAttrValues[':taskId'] = value;
      continue;
    }
    if (key === 'bundleId') {
      filterExpressions.push('contains(bundleIds, :bundleId)');
      expressionAttrValues[':bundleId'] = value;
      continue;
    }
    if (key === 'assistantReadinessStatus') {
      filterExpressions.push('#assistantReadiness.#status = :assistantReadinessStatus');
      expressionAttrNames['#assistantReadiness'] = 'assistantReadiness';
      expressionAttrNames['#status'] = 'status';
      expressionAttrValues[':assistantReadinessStatus'] = value;
      continue;
    }
    if (key === 'duplicateState') {
      if (value === 'duplicates') filterExpressions.push('attribute_exists(duplicateOfIntakeItemId)');
      if (value === 'not-duplicates') filterExpressions.push('attribute_not_exists(duplicateOfIntakeItemId)');
      continue;
    }
    if (key === 'from') {
      filterExpressions.push('sourceReceivedAt >= :from');
      expressionAttrValues[':from'] = value;
      continue;
    }
    if (key === 'to') {
      filterExpressions.push('sourceReceivedAt <= :to');
      expressionAttrValues[':to'] = value;
      continue;
    }
    if (key === 'dueFollowUpAt') {
      filterExpressions.push('attribute_exists(followUpAt) AND followUpAt <= :dueFollowUpAt');
      expressionAttrValues[':dueFollowUpAt'] = value;
      continue;
    }
    if (key === 'followUpFrom') {
      filterExpressions.push('attribute_exists(followUpAt) AND followUpAt >= :followUpFrom');
      expressionAttrValues[':followUpFrom'] = value;
      continue;
    }
    if (key === 'followUpTo') {
      filterExpressions.push('attribute_exists(followUpAt) AND followUpAt <= :followUpTo');
      expressionAttrValues[':followUpTo'] = value;
      continue;
    }
    if (key === 'standaloneOnly') {
      if (String(value) === 'true') {
        filterExpressions.push('size(taskIds) = :standaloneTaskCount');
        expressionAttrValues[':standaloneTaskCount'] = 0;
      }
      continue;
    }
    const nameToken = `#${key}`;
    const valueToken = `:${key}`;
    filterExpressions.push(`${nameToken} = ${valueToken}`);
    expressionAttrNames[nameToken] = key;
    expressionAttrValues[valueToken] = value;
  }

  const items: IntakeItem[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_INTAKE,
      FilterExpression: filterExpressions.join(' AND '),
      ExpressionAttributeNames: Object.keys(expressionAttrNames).length > 0 ? expressionAttrNames : undefined,
      ExpressionAttributeValues: expressionAttrValues,
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    items.push(...(result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as IntakeItem));
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export {
  createIntakeItem,
  createIntakeItemIfAbsent,
  findIntakeBySourceMessage,
  getIntakeItem,
  listIntakeItems,
  updateIntakeItem,
};
