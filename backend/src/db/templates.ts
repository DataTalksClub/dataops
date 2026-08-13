import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_TEMPLATES } from './setup';
import { createTask, listTasksByCard } from './tasks';
import type { Template, Task } from '../types';

export class TemplateVersionConflictError extends Error {
  constructor() {
    super('Template version conflict');
    this.name = 'TemplateVersionConflictError';
  }
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

async function rawTemplate(client: DynamoDBDocumentClient, id: string): Promise<Record<string, unknown> | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_TEMPLATES, Key: templateKey(id), ConsistentRead: true }));
  return result.Item ? result.Item as Record<string, unknown> : null;
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

/** Test/local helper. Production definitions are replaced from Git. */
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
 * Replace a complete Git-authored runtime projection while preserving its
 * stable identity. A conditional write makes a concurrent old-editor mutation
 * fail the deployment instead of silently winning or being overwritten.
 */
async function replaceTemplate(
  client: DynamoDBDocumentClient,
  id: string,
  definition: Record<string, unknown>,
  expectedVersion: number,
): Promise<Template> {
  const before = await rawTemplate(client, id);
  if (!before) throw new TemplateVersionConflictError();
  const now = new Date().toISOString();
  const item = {
    ...templateKey(id),
    id,
    createdAt: before.createdAt,
    updatedAt: now,
    ...definition,
    version: expectedVersion + 1,
  };
  try {
    await client.send(new PutCommand({
      TableName: TABLE_TEMPLATES,
      Item: item,
      ConditionExpression: 'attribute_exists(#pk) AND (#version = :expectedVersion OR (attribute_not_exists(#version) AND :expectedVersion = :versionOne))',
      ExpressionAttributeNames: { '#pk': 'PK', '#version': 'version' },
      ExpressionAttributeValues: { ':expectedVersion': expectedVersion, ':versionOne': 1 },
    }));
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw new TemplateVersionConflictError();
    throw error;
  }
  return cleanItem(item) as Template;
}

/** Test/local cleanup helper. Production template deletion is not a runtime operation. */
async function deleteTemplate(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(new DeleteCommand({ TableName: TABLE_TEMPLATES, Key: templateKey(id) }));
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
async function instantiateTemplate(client: DynamoDBDocumentClient, templateId: string, cardId: string, anchorDate: string): Promise<Task[]> {
  const template = await getTemplate(client, templateId);
  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  const taskDefinitions = template.taskDefinitions || [];
  const existingTasks = await listTasksByCard(client, cardId);
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
      cardId,
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
  getTemplate,
  updateTemplate,
  replaceTemplate,
  deleteTemplate,
  listTemplates,
  instantiateTemplate,
};
