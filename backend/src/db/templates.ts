import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  TABLE_AUDIT_EVENTS,
  TABLE_BUNDLES,
  TABLE_CALENDAR,
  TABLE_NOTIFICATIONS,
  TABLE_TASKS,
  TABLE_TEMPLATES,
} from './setup';
import { createTask, listTasksByBundle } from './tasks';
import type { Template, Task, TemplateAuditAction, TemplateAuditEvent } from '../types';

export class TemplateVersionConflictError extends Error {
  constructor() {
    super('Template version conflict');
    this.name = 'TemplateVersionConflictError';
  }
}

export interface TemplateReferenceCounts {
  bundles: number;
  tasks: number;
  recurrences: number;
  schedules: number;
  calendar: number;
  notifications: number;
  total: number;
}

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): Template | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return { ...rest, version: typeof rest.version === 'number' ? rest.version : 1 } as unknown as Template;
}

function templateKey(id: string) {
  return { PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}` };
}

function transactionsUnsupported(error: unknown): boolean {
  return (error as Error)?.name === 'UnknownOperationException';
}

async function rawTemplate(client: DynamoDBDocumentClient, id: string): Promise<Record<string, unknown> | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_TEMPLATES, Key: templateKey(id), ConsistentRead: true }));
  return result.Item ? result.Item as Record<string, unknown> : null;
}

function auditItem(input: {
  actorId: string;
  templateId: string;
  action: TemplateAuditAction;
  outcome?: 'success' | 'rejected';
  reason?: 'template_in_use' | 'version_conflict';
  priorVersion?: number;
  resultVersion?: number;
  changedFields?: string[];
  now?: string;
}): Record<string, unknown> {
  const id = crypto.randomUUID();
  const createdAt = input.now || new Date().toISOString();
  const event: TemplateAuditEvent = {
    id,
    recordType: 'runtime_template_audit_event',
    actorId: input.actorId,
    templateId: input.templateId,
    action: input.action,
    outcome: input.outcome || 'success',
    changedFields: [...new Set(input.changedFields || [])].sort(),
    createdAt,
  };
  if (input.reason) event.reason = input.reason;
  if (input.priorVersion !== undefined) event.priorVersion = input.priorVersion;
  if (input.resultVersion !== undefined) event.resultVersion = input.resultVersion;
  return { PK: `TEMPLATE_AUDIT#${id}`, SK: `TEMPLATE_AUDIT#${id}`, ...event };
}

/**
 * Create a new template. Generates a UUID, sets createdAt/updatedAt.
 */
async function createTemplate(client: DynamoDBDocumentClient, data: Record<string, unknown>): Promise<Template> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    PK: `TEMPLATE#${id}`,
    SK: `TEMPLATE#${id}`,
    id,
    createdAt: now,
    updatedAt: now,
    ...data,
    version: 1,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_TEMPLATES,
      Item: item,
    })
  );

  return cleanItem(item) as Template;
}

/** Create a template and its privacy-safe success audit event atomically. */
async function createTemplateWithAudit(
  client: DynamoDBDocumentClient,
  data: Record<string, unknown>,
  actorId: string,
): Promise<Template> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const item = {
    ...templateKey(id),
    id,
    createdAt: now,
    updatedAt: now,
    ...data,
    version: 1,
  };
  const audit = auditItem({
    actorId,
    templateId: id,
    action: 'create',
    resultVersion: 1,
    changedFields: Object.keys(data),
    now,
  });
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_TEMPLATES, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE_AUDIT_EVENTS, Item: audit, ConditionExpression: 'attribute_not_exists(PK)' } },
      ],
    }));
  } catch (error) {
    if (!transactionsUnsupported(error)) throw error;
    await client.send(new PutCommand({ TableName: TABLE_TEMPLATES, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    try {
      await client.send(new PutCommand({ TableName: TABLE_AUDIT_EVENTS, Item: audit, ConditionExpression: 'attribute_not_exists(PK)' }));
    } catch (auditError) {
      await client.send(new DeleteCommand({
        TableName: TABLE_TEMPLATES,
        Key: templateKey(id),
        ConditionExpression: 'version = :version AND createdAt = :createdAt',
        ExpressionAttributeValues: { ':version': 1, ':createdAt': now },
      }));
      throw auditError;
    }
  }
  return cleanItem(item) as Template;
}

/**
 * Get a template by id.
 */
async function getTemplate(client: DynamoDBDocumentClient, id: string): Promise<Template | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_TEMPLATES,
      Key: { PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}` },
      ConsistentRead: true,
    })
  );

  const template = result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
  return template?.archivedAt ? null : template;
}

/**
 * Partial update of a template.
 */
async function updateTemplateWithAudit(
  client: DynamoDBDocumentClient,
  id: string,
  updates: Record<string, unknown>,
  expectedVersion = 1,
  actorId = 'system',
): Promise<Template | null> {
  const before = await rawTemplate(client, id);
  if (!before) return null;
  const now = new Date().toISOString();
  const resultVersion = expectedVersion + 1;
  const fields: Record<string, unknown> = { ...updates, updatedAt: now, version: resultVersion };

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

  expressionAttrNames['#version'] = 'version';
  expressionAttrNames['#pk'] = 'PK';
  expressionAttrValues[':expectedVersion'] = expectedVersion;
  expressionAttrValues[':versionOne'] = 1;
  const audit = auditItem({
    actorId,
    templateId: id,
    action: 'update',
    priorVersion: expectedVersion,
    resultVersion,
    changedFields: Object.keys(updates),
    now,
  });
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        { Update: {
          TableName: TABLE_TEMPLATES,
          Key: templateKey(id),
          UpdateExpression: `SET ${expressionParts.join(', ')}`,
          ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(archivedAt) AND (#version = :expectedVersion OR (attribute_not_exists(#version) AND :expectedVersion = :versionOne))',
          ExpressionAttributeNames: expressionAttrNames,
          ExpressionAttributeValues: expressionAttrValues,
        } },
        { Put: { TableName: TABLE_AUDIT_EVENTS, Item: audit, ConditionExpression: 'attribute_not_exists(PK)' } },
      ],
    }));
  } catch (error) {
    if (transactionsUnsupported(error)) {
      try {
        await client.send(new UpdateCommand({
          TableName: TABLE_TEMPLATES,
          Key: templateKey(id),
          UpdateExpression: `SET ${expressionParts.join(', ')}`,
          ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(archivedAt) AND (#version = :expectedVersion OR (attribute_not_exists(#version) AND :expectedVersion = :versionOne))',
          ExpressionAttributeNames: expressionAttrNames,
          ExpressionAttributeValues: expressionAttrValues,
        }));
      } catch (updateError) {
        if ((updateError as Error).name === 'ConditionalCheckFailedException') throw new TemplateVersionConflictError();
        throw updateError;
      }
      try {
        await client.send(new PutCommand({ TableName: TABLE_AUDIT_EVENTS, Item: audit, ConditionExpression: 'attribute_not_exists(PK)' }));
      } catch (auditError) {
        await client.send(new PutCommand({
          TableName: TABLE_TEMPLATES,
          Item: before,
          ConditionExpression: '#version = :resultVersion',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':resultVersion': resultVersion },
        }));
        throw auditError;
      }
      return getTemplate(client, id);
    }
    if ((error as Error).name === 'TransactionCanceledException' || (error as Error).name === 'ConditionalCheckFailedException') {
      throw new TemplateVersionConflictError();
    }
    throw error;
  }
  return getTemplate(client, id);
}

/** Internal/seed helper. API mutations use updateTemplateWithAudit. */
async function updateTemplate(client: DynamoDBDocumentClient, id: string, updates: Record<string, unknown>): Promise<Template | null> {
  const now = new Date().toISOString();
  const expressionParts: string[] = [];
  const names: Record<string, string> = { '#version': 'version' };
  const values: Record<string, unknown> = { ':zero': 0, ':one': 1 };
  let index = 0;
  for (const [key, value] of Object.entries({ ...updates, updatedAt: now })) {
    const name = `#field${index}`;
    const token = `:value${index}`;
    names[name] = key;
    values[token] = value;
    expressionParts.push(`${name} = ${token}`);
    index++;
  }
  expressionParts.push('#version = if_not_exists(#version, :zero) + :one');
  const result = await client.send(new UpdateCommand({
    TableName: TABLE_TEMPLATES,
    Key: templateKey(id),
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));
  return cleanItem(result.Attributes as Record<string, unknown>);
}

/**
 * Delete a template by id.
 */
async function deleteTemplateWithAudit(
  client: DynamoDBDocumentClient,
  id: string,
  expectedVersion = 1,
  actorId = 'system',
): Promise<void> {
  const before = await rawTemplate(client, id);
  if (!before || typeof before.archivedAt === 'string') throw new TemplateVersionConflictError();
  const now = new Date().toISOString();
  const resultVersion = expectedVersion + 1;
  const audit = auditItem({
    actorId,
    templateId: id,
    action: 'delete',
    priorVersion: expectedVersion,
    resultVersion,
    changedFields: ['archivedAt', 'archivedBy'],
    now,
  });
  const update = {
    TableName: TABLE_TEMPLATES,
    Key: templateKey(id),
    UpdateExpression: 'SET archivedAt = :archivedAt, archivedBy = :archivedBy, #version = :resultVersion, updatedAt = :updatedAt',
    ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(archivedAt) AND (#version = :expectedVersion OR (attribute_not_exists(#version) AND :expectedVersion = :versionOne))',
    ExpressionAttributeNames: { '#pk': 'PK', '#version': 'version' },
    ExpressionAttributeValues: {
      ':archivedAt': now,
      ':archivedBy': actorId,
      ':resultVersion': resultVersion,
      ':updatedAt': now,
      ':expectedVersion': expectedVersion,
      ':versionOne': 1,
    },
  };
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        { Update: update },
        { Put: { TableName: TABLE_AUDIT_EVENTS, Item: audit, ConditionExpression: 'attribute_not_exists(PK)' } },
      ],
    }));
  } catch (error) {
    if (transactionsUnsupported(error)) {
      try {
        await client.send(new UpdateCommand(update));
      } catch (archiveError) {
        if ((archiveError as Error).name === 'ConditionalCheckFailedException') throw new TemplateVersionConflictError();
        throw archiveError;
      }
      try {
        await client.send(new PutCommand({ TableName: TABLE_AUDIT_EVENTS, Item: audit, ConditionExpression: 'attribute_not_exists(PK)' }));
      } catch (auditError) {
        await client.send(new PutCommand({
          TableName: TABLE_TEMPLATES,
          Item: before,
          ConditionExpression: '#version = :resultVersion AND archivedAt = :archivedAt',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':resultVersion': resultVersion, ':archivedAt': now },
        }));
        throw auditError;
      }
      return;
    }
    if ((error as Error).name === 'TransactionCanceledException' || (error as Error).name === 'ConditionalCheckFailedException') {
      throw new TemplateVersionConflictError();
    }
    throw error;
  }
}

/** Internal/seed helper. API mutations use deleteTemplateWithAudit. */
async function deleteTemplate(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(new DeleteCommand({ TableName: TABLE_TEMPLATES, Key: templateKey(id) }));
}

async function recordRejectedTemplateDelete(
  client: DynamoDBDocumentClient,
  input: { actorId: string; templateId: string; reason: 'template_in_use' | 'version_conflict'; priorVersion?: number },
): Promise<void> {
  const audit = auditItem({ ...input, action: 'delete', outcome: 'rejected', changedFields: [] });
  await client.send(new PutCommand({
    TableName: TABLE_AUDIT_EVENTS,
    Item: audit,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
}

async function countMatches(
  client: DynamoDBDocumentClient,
  tableName: string,
  filterExpression: string,
  templateId: string,
  expressionAttributeNames?: Record<string, string>,
  extraValues: Record<string, unknown> = {},
): Promise<number> {
  let count = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: tableName,
      Select: 'COUNT',
      FilterExpression: filterExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: { ':templateId': templateId, ...extraValues },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    count += result.Count || 0;
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return count;
}

/** Server-owned persisted reference scan. Only category counts leave this layer. */
async function countTemplateReferences(client: DynamoDBDocumentClient, templateId: string): Promise<TemplateReferenceCounts> {
  const [bundles, taskRows, recurrences, schedules, calendar, notifications] = await Promise.all([
    countMatches(client, TABLE_BUNDLES, 'templateId = :templateId', templateId),
    countMatches(client, TABLE_TASKS, 'begins_with(PK, :taskPrefix) AND templateId = :templateId', templateId, undefined, { ':taskPrefix': 'TASK#' }),
    countMatches(client, TABLE_TASKS, 'begins_with(PK, :recurringPrefix) AND templateId = :templateId', templateId, undefined, { ':recurringPrefix': 'RECURRING#' }),
    countMatches(client, TABLE_TASKS, 'begins_with(PK, :schedulePrefix) AND templateId = :templateId', templateId, undefined, { ':schedulePrefix': 'SCHEDULE#' }),
    countMatches(client, TABLE_CALENDAR, 'templateId = :templateId', templateId),
    countMatches(client, TABLE_NOTIFICATIONS, 'templateId = :templateId OR #metadata.templateId = :templateId', templateId, { '#metadata': 'metadata' }),
  ]);
  const counts = { bundles, tasks: taskRows, recurrences, schedules, calendar, notifications };
  return { ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
}

async function listTemplateAuditEvents(client: DynamoDBDocumentClient, templateId?: string): Promise<TemplateAuditEvent[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_AUDIT_EVENTS,
      FilterExpression: templateId
        ? 'recordType = :recordType AND templateId = :templateId'
        : 'recordType = :recordType',
      ExpressionAttributeValues: templateId
        ? { ':recordType': 'runtime_template_audit_event', ':templateId': templateId }
        : { ':recordType': 'runtime_template_audit_event' },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    items.push(...((result.Items || []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items.map(({ PK, SK, ...item }) => item as unknown as TemplateAuditEvent)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * List all templates by scanning for items where PK begins with "TEMPLATE#".
 */
async function listTemplates(client: DynamoDBDocumentClient): Promise<Template[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_TEMPLATES,
      FilterExpression: 'begins_with(PK, :prefix) AND attribute_not_exists(archivedAt)',
      ExpressionAttributeValues: { ':prefix': 'TEMPLATE#' },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    items.push(...((result.Items || []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items.map((item) => cleanItem(item) as Template);
}

/**
 * Instantiate a template: fetch the template, and for each taskDefinition
 * create a task with a calculated date (anchorDate + offsetDays).
 */
async function instantiateTemplate(client: DynamoDBDocumentClient, templateId: string, bundleId: string, anchorDate: string): Promise<Task[]> {
  const template = await getTemplate(client, templateId);
  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  const taskDefinitions = template.taskDefinitions || [];
  const existingTasks = await listTasksByBundle(client, bundleId);
  const existingRefs = new Set(
    existingTasks
      .filter((task) => task.templateId === templateId && task.templateTaskRef)
      .map((task) => task.templateTaskRef as string)
  );
  const createdTasks: Task[] = [];

  for (const def of taskDefinitions) {
    if (existingRefs.has(def.refId)) {
      continue;
    }

    const anchor = new Date(anchorDate + 'T00:00:00Z');
    anchor.setUTCDate(anchor.getUTCDate() + (def.offsetDays || 0));
    const taskDate = anchor.toISOString().split('T')[0];

    const taskData: Record<string, unknown> = {
      description: def.description,
      bundleId,
      templateId,
      date: taskDate,
      source: 'template',
      templateTaskRef: def.refId,
      templateOffsetDays: def.offsetDays,
      status: 'todo',
    };
    if (template.sourceDocIds && template.sourceDocIds.length > 0) {
      taskData.sourceDocIds = template.sourceDocIds;
    }

    // Set instructionsUrl from task definition (not comment)
    if (def.instructionsUrl) {
      taskData.instructionsUrl = def.instructionsUrl;
    }
    if (def.instructionDocId) {
      taskData.instructionDocId = def.instructionDocId;
    }
    if (def.instructionStepId) {
      taskData.instructionStepId = def.instructionStepId;
    }
    if (def.phase) {
      taskData.phase = def.phase;
    }
    if (def.systems && def.systems.length > 0) {
      taskData.systems = def.systems;
    }
    if (def.validation) {
      taskData.validation = def.validation;
    }
    if (def.proofRequirement) {
      taskData.proofRequirement = def.proofRequirement;
    }
    if (def.artifactRefs && def.artifactRefs.length > 0) {
      taskData.artifactRefs = def.artifactRefs;
    }
    if (def.assistantJobRefs && def.assistantJobRefs.length > 0) {
      taskData.assistantJobRefs = def.assistantJobRefs;
    }
    if (def.auditEventRefs && def.auditEventRefs.length > 0) {
      taskData.auditEventRefs = def.auditEventRefs;
    }
    if (def.intakeRefs && def.intakeRefs.length > 0) {
      taskData.intakeRefs = def.intakeRefs;
    }

    // Set assigneeId: task definition overrides, fall back to template default
    if (def.assigneeId) {
      taskData.assigneeId = def.assigneeId;
    } else if (template.defaultAssigneeId) {
      taskData.assigneeId = template.defaultAssigneeId;
    }

    // Set requiredLinkName from task definition
    if (def.requiredLinkName) {
      taskData.requiredLinkName = def.requiredLinkName;
    }
    if (def.requiresFile !== undefined) {
      taskData.requiresFile = def.requiresFile;
    }

    // Set stageOnComplete from task definition (internal field for stage transitions)
    if (def.stageOnComplete) {
      taskData.stageOnComplete = def.stageOnComplete;
    }
    if (def.isMilestone !== undefined) {
      taskData.isMilestone = def.isMilestone;
    }

    // Inherit tags from template
    if (template.tags && template.tags.length > 0) {
      taskData.tags = template.tags;
    }

    const task = await createTask(client, taskData);

    existingRefs.add(def.refId);
    createdTasks.push(task);
  }

  return createdTasks;
}

export {
  createTemplate,
  createTemplateWithAudit,
  getTemplate,
  updateTemplate,
  updateTemplateWithAudit,
  deleteTemplate,
  deleteTemplateWithAudit,
  listTemplates,
  instantiateTemplate,
  countTemplateReferences,
  recordRejectedTemplateDelete,
  listTemplateAuditEvents,
};
