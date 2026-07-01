import {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_ASSISTANT_JOBS, TABLE_AUDIT_EVENTS } from './setup';
import type { AssistantJobEvent, AssistantJobRecord } from '../types';

export interface AssistantJobFilters {
  status?: string;
  assistantType?: string;
  taskId?: string;
  bundleId?: string;
  needsApproval?: boolean;
}

function cleanJobItem(item: Record<string, unknown> | undefined): AssistantJobRecord | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as AssistantJobRecord;
}

function cleanEventItem(item: Record<string, unknown> | undefined): AssistantJobEvent | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as AssistantJobEvent;
}

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

async function createAssistantJob(
  client: DynamoDBDocumentClient,
  data: Record<string, unknown>
): Promise<AssistantJobRecord> {
  const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id : crypto.randomUUID();
  const now = new Date().toISOString();
  const item = withoutUndefined({
    PK: `ASSISTANT_JOB#${id}`,
    SK: `ASSISTANT_JOB#${id}`,
    id,
    status: 'draft',
    inputRefs: [],
    outputArtifactIds: [],
    logRefs: [],
    approvalRequired: true,
    attemptCount: 0,
    maxAttempts: 2,
    createdAt: now,
    updatedAt: now,
    ...data,
  });

  await client.send(new PutCommand({
    TableName: TABLE_ASSISTANT_JOBS,
    Item: item,
  }));

  return cleanJobItem(item) as AssistantJobRecord;
}

async function getAssistantJob(client: DynamoDBDocumentClient, id: string): Promise<AssistantJobRecord | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_ASSISTANT_JOBS,
    Key: { PK: `ASSISTANT_JOB#${id}`, SK: `ASSISTANT_JOB#${id}` },
  }));

  return result.Item ? cleanJobItem(result.Item as Record<string, unknown>) : null;
}

async function updateAssistantJob(
  client: DynamoDBDocumentClient,
  id: string,
  updates: Record<string, unknown>
): Promise<AssistantJobRecord | null> {
  const fields: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) fields[key] = value;
  }
  const expressionParts: string[] = [];
  const expressionAttrNames: Record<string, string> = {};
  const expressionAttrValues: Record<string, unknown> = {};

  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    const nameToken = `#f${i}`;
    const valueToken = `:v${i}`;
    expressionParts.push(`${nameToken} = ${valueToken}`);
    expressionAttrNames[nameToken] = key;
    expressionAttrValues[valueToken] = value;
    i++;
  }

  const result = await client.send(new UpdateCommand({
    TableName: TABLE_ASSISTANT_JOBS,
    Key: { PK: `ASSISTANT_JOB#${id}`, SK: `ASSISTANT_JOB#${id}` },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: expressionAttrNames,
    ExpressionAttributeValues: expressionAttrValues,
    ReturnValues: 'ALL_NEW',
  }));

  return cleanJobItem(result.Attributes as Record<string, unknown>);
}

async function listAssistantJobs(
  client: DynamoDBDocumentClient,
  filters: AssistantJobFilters = {}
): Promise<AssistantJobRecord[]> {
  const filterExpressions: string[] = ['begins_with(PK, :prefix)'];
  const expressionAttrValues: Record<string, unknown> = { ':prefix': 'ASSISTANT_JOB#' };
  const expressionAttrNames: Record<string, string> = {};

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'needsApproval') {
      if (value !== true) continue;
      filterExpressions.push('#status = :waitingApproval');
      expressionAttrNames['#status'] = 'status';
      expressionAttrValues[':waitingApproval'] = 'waiting_approval';
      continue;
    }
    const nameToken = `#${key}`;
    const valueToken = `:${key}`;
    filterExpressions.push(`${nameToken} = ${valueToken}`);
    expressionAttrNames[nameToken] = key;
    expressionAttrValues[valueToken] = value;
  }

  const result = await client.send(new ScanCommand({
    TableName: TABLE_ASSISTANT_JOBS,
    FilterExpression: filterExpressions.join(' AND '),
    ExpressionAttributeNames: Object.keys(expressionAttrNames).length > 0 ? expressionAttrNames : undefined,
    ExpressionAttributeValues: expressionAttrValues,
  }));

  return (result.Items || [])
    .map((item) => cleanJobItem(item as Record<string, unknown>) as AssistantJobRecord)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function appendAssistantJobEvent(
  client: DynamoDBDocumentClient,
  data: Record<string, unknown>
): Promise<AssistantJobEvent> {
  const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id : crypto.randomUUID();
  const now = new Date().toISOString();
  const assistantJobId = String(data.assistantJobId || '');
  const item = withoutUndefined({
    PK: `AUDIT_EVENT#${id}`,
    SK: `AUDIT_EVENT#${id}`,
    id,
    createdAt: now,
    ...data,
    assistantJobId,
  });

  await client.send(new PutCommand({
    TableName: TABLE_AUDIT_EVENTS,
    Item: item,
  }));

  return cleanEventItem(item) as AssistantJobEvent;
}

async function listAssistantJobEvents(client: DynamoDBDocumentClient, assistantJobId: string): Promise<AssistantJobEvent[]> {
  const result = await client.send(new ScanCommand({
    TableName: TABLE_AUDIT_EVENTS,
    FilterExpression: 'begins_with(PK, :prefix) AND assistantJobId = :assistantJobId',
    ExpressionAttributeValues: {
      ':prefix': 'AUDIT_EVENT#',
      ':assistantJobId': assistantJobId,
    },
  }));

  return (result.Items || [])
    .map((item) => cleanEventItem(item as Record<string, unknown>) as AssistantJobEvent)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export {
  appendAssistantJobEvent,
  createAssistantJob,
  getAssistantJob,
  listAssistantJobEvents,
  listAssistantJobs,
  updateAssistantJob,
};
