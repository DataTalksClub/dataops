import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_CARDS, TABLE_TASKS, TABLE_TEMPLATES } from './tableNames';
import { buildCard, cardKey } from './cards';
import { usesLocalTransactionEmulation } from './client';
import { createTask, listTasksByCard } from './tasks';
import type { Card, Template, Task } from '../types';
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
  if (!Number.isInteger(rest.version) || Number(rest.version) < 1) {
    throw new Error(`Template ${String(rest.id || PK || 'unknown')} is not in the canonical versioned shape`);
  }
  return rest as unknown as Template;
}

function templateKey(id: string) {
  return { PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}` };
}

function taskKey(id: string) {
  return { PK: `TASK#${id}`, SK: `TASK#${id}` };
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, compact(field)]),
    );
  }
  return value;
}

let templateCreationTail: Promise<void> = Promise.resolve();

async function withTemplateCreationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = templateCreationTail;
  let release!: () => void;
  templateCreationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function emulateTemplateCardCreation(
  client: DynamoDBDocumentClient,
  template: Template,
  card: Card,
  tasks: Task[],
): Promise<void> {
  await withTemplateCreationLock(async () => {
    if (process.env.TEMPLATE_CARD_CREATE_TEST_TEMPLATE_RACE === 'true') {
      await client.send(new UpdateCommand({
        TableName: TABLE_TEMPLATES,
        Key: templateKey(template.id),
        UpdateExpression: 'SET #version = :nextVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':nextVersion': template.version + 1 },
      }));
    }
    const currentTemplate = await rawTemplate(client, template.id);
    if (!currentTemplate || currentTemplate.version !== template.version) {
      throw new TemplateVersionConflictError();
    }
    const writes = [
      { table: TABLE_CARDS, key: cardKey(card.id), item: { ...cardKey(card.id), ...card } },
      ...tasks.map((task) => ({
        table: TABLE_TASKS,
        key: taskKey(task.id),
        item: { ...taskKey(task.id), ...task },
      })),
    ];
    for (const write of writes) {
      const current = await client.send(new GetCommand({
        TableName: write.table,
        Key: write.key,
        ConsistentRead: true,
      }));
      if (current.Item) throw new Error(`Template Card entity already exists: ${String(write.key.PK)}`);
    }

    const applied: typeof writes = [];
    try {
      for (const write of writes) {
        await client.send(new PutCommand({
          TableName: write.table,
          Item: compact(write.item) as Record<string, unknown>,
        }));
        applied.push(write);
        if (Number(process.env.TEMPLATE_CARD_CREATE_TEST_FAIL_AFTER || 0) === applied.length) {
          throw new Error('Injected Template Card creation transaction failure');
        }
      }
    } catch (error) {
      for (const write of applied.reverse()) {
        await client.send(new DeleteCommand({ TableName: write.table, Key: write.key }));
      }
      throw error;
    }
  });
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
  const current = await getTemplate(client, id);
  if (!current) return null;
  const now = new Date().toISOString();
  const expressionParts: string[] = [];
  const names: Record<string, string> = { '#version': 'version' };
  const values: Record<string, unknown> = { ':expectedVersion': current.version, ':one': 1 };
  let index = 0;
  for (const [key, value] of Object.entries({ ...updates, updatedAt: now })) {
    const name = `#field${index}`;
    const token = `:value${index}`;
    names[name] = key;
    values[token] = value;
    expressionParts.push(`${name} = ${token}`);
    index++;
  }
  expressionParts.push('#version = #version + :one');
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_TEMPLATES,
      Key: templateKey(id),
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return cleanItem(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw new TemplateVersionConflictError();
    throw error;
  }
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
      ConditionExpression: 'attribute_exists(#pk) AND #version = :expectedVersion',
      ExpressionAttributeNames: { '#pk': 'PK', '#version': 'version' },
      ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
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

/** Create a Template-backed Card and projected Tasks as one aggregate. */
async function createCardFromTemplate(
  client: DynamoDBDocumentClient,
  cardData: Record<string, unknown>,
  template: Template,
  anchorDate: string,
): Promise<{ card: Card; tasks: Task[] }> {
  const definitions = template.taskDefinitions || [];
  const card = buildCard(cardData, {
    taskCount: definitions.length,
    openTaskCount: definitions.length,
  });
  const now = card.createdAt;
  const tasks = definitions.map((definition, order) => {
    const id = crypto.randomUUID();
    return compact({
      id,
      version: 1,
      taskHistory: [],
      createdAt: now,
      updatedAt: now,
      ...templateTaskProjection(template, definition, order, anchorDate, card.id),
    }) as Task;
  });

  // Card Put + Template condition + one Put per Task.
  const itemCount = 2 + tasks.length;
  if (itemCount > 100) {
    throw new RangeError(`Template Card creation requires ${itemCount} transaction items; maximum is 100`);
  }

  if (usesLocalTransactionEmulation()) {
    await emulateTemplateCardCreation(client, template, card, tasks);
    return { card, tasks };
  }

  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_CARDS,
            Item: compact({ ...cardKey(card.id), ...card }) as Record<string, unknown>,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_TEMPLATES,
            Key: templateKey(template.id),
            ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expectedVersion': template.version },
          },
        },
        ...tasks.map((task) => ({
          Put: {
            TableName: TABLE_TASKS,
            Item: compact({ ...taskKey(task.id), ...task }) as Record<string, unknown>,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        })),
      ],
    }));
  } catch (error) {
    if ((error as Error).name === 'TransactionCanceledException') {
      const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons || [];
      if (reasons[1]?.Code === 'ConditionalCheckFailed') throw new TemplateVersionConflictError();
      const currentTemplate = await rawTemplate(client, template.id);
      if (!currentTemplate || currentTemplate.version !== template.version) {
        throw new TemplateVersionConflictError();
      }
    }
    throw error;
  }
  return { card, tasks };
}

export {
  createTemplate,
  getTemplate,
  updateTemplate,
  replaceTemplate,
  deleteTemplate,
  listTemplates,
  instantiateTemplate,
  createCardFromTemplate,
};
