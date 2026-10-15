/**
 * Every Card is instantiated from a Template. Tests that are about something
 * else (ownership, lifecycle, links) use this Template without Tasks, so a
 * Card linked to it starts empty.
 */
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_TEMPLATES } from '../../src/db/tableNames';
import { templateLinkage } from '../../src/templates/cardTemplateProjection';
import type { Template } from '../../src/types';

export const EMPTY_TEMPLATE: Template = {
  id: 'synthetic-empty-template',
  name: 'Synthetic empty',
  type: 'synthetic-empty',
  version: 1,
  taskDefinitions: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Template;

export const EMPTY_TEMPLATE_ID = EMPTY_TEMPLATE.id;

/** The linkage fields a Card instantiated from `template` records. */
export function templateLink(template: Template = EMPTY_TEMPLATE): Record<string, unknown> {
  return templateLinkage(template);
}

/** Store the empty Template so `POST /api/cards` can instantiate from it. Idempotent. */
export async function putEmptyTemplate(client: DynamoDBDocumentClient): Promise<Template> {
  await client.send(new PutCommand({
    TableName: TABLE_TEMPLATES,
    Item: { PK: `TEMPLATE#${EMPTY_TEMPLATE.id}`, SK: `TEMPLATE#${EMPTY_TEMPLATE.id}`, ...EMPTY_TEMPLATE },
  }));
  return EMPTY_TEMPLATE;
}
