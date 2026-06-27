import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_TEMPLATES } from './setup';
import { createTask } from './tasks';
import type { Template, Task } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): Template | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as Template;
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
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * Partial update of a template.
 */
async function updateTemplate(client: DynamoDBDocumentClient, id: string, updates: Record<string, unknown>): Promise<Template | null> {
  const now = new Date().toISOString();
  const fields: Record<string, unknown> = { ...updates, updatedAt: now };

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

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_TEMPLATES,
      Key: { PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}` },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttrNames,
      ExpressionAttributeValues: expressionAttrValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return cleanItem(result.Attributes as Record<string, unknown>);
}

/**
 * Delete a template by id.
 */
async function deleteTemplate(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_TEMPLATES,
      Key: { PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}` },
    })
  );
}

/**
 * List all templates by scanning for items where PK begins with "TEMPLATE#".
 */
async function listTemplates(client: DynamoDBDocumentClient): Promise<Template[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_TEMPLATES,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'TEMPLATE#' },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Template);
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
  const createdTasks: Task[] = [];

  for (const def of taskDefinitions) {
    const anchor = new Date(anchorDate + 'T00:00:00Z');
    anchor.setUTCDate(anchor.getUTCDate() + (def.offsetDays || 0));
    const taskDate = anchor.toISOString().split('T')[0];

    const taskData: Record<string, unknown> = {
      description: def.description,
      bundleId,
      date: taskDate,
      source: 'template',
      templateTaskRef: def.refId,
      status: 'todo',
    };

    // Set instructionsUrl from task definition (not comment)
    if (def.instructionsUrl) {
      taskData.instructionsUrl = def.instructionsUrl;
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

    // Set stageOnComplete from task definition (internal field for stage transitions)
    if (def.stageOnComplete) {
      taskData.stageOnComplete = def.stageOnComplete;
    }

    // Inherit tags from template
    if (template.tags && template.tags.length > 0) {
      taskData.tags = template.tags;
    }

    const task = await createTask(client, taskData);

    createdTasks.push(task);
  }

  return createdTasks;
}

export {
  createTemplate,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  listTemplates,
  instantiateTemplate,
};
