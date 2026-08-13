import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_TEMPLATES } from './tableNames';
import { createTask, listTasksByCard } from './tasks';
import type { Template, Task } from '../types';
import { templateTaskProjection } from '../templates/cardTemplateProjection';

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

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
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
      FilterExpression: 'begins_with(PK, :prefix)',
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

  for (const [order, def] of taskDefinitions.entries()) {
    if (existingRefs.has(def.refId)) {
      continue;
    }

    const taskData = templateTaskProjection(template, def, order, anchorDate, cardId);

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
