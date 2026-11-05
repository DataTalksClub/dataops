/**
 * Generic text templates: one structured record in the Users table
 * (`SETTINGS#text-templates`) next to the offers rate card and workspace
 * settings.
 *
 * A text template is plain text with `<UPPER_SNAKE>` placeholders (the KB
 * token convention, see `../textTemplates/render`). It is deliberately not a
 * card/workflow template (`TEMPLATE#` records) and not a KB email template:
 * it is reusable copy any agent can render by filling values.
 *
 * All authenticated actors can list and show templates
 * (`GET /api/text-templates`); only admins can create, update or delete them
 * (`POST`/`PUT`/`DELETE`). The whole record is versioned like the offers rate
 * card: every mutation bumps `version` and item mutations carry
 * `expectedVersion` for optimistic concurrency.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_USERS } from './tableNames';
import { extractPlaceholders } from '../textTemplates/render';

const TEXT_TEMPLATES_KEY = { PK: 'SETTINGS#text-templates', SK: 'SETTINGS#text-templates' } as const;

export interface TextTemplateItem {
  /** Stable slug, e.g. `reply.out-of-office`. */
  id: string;
  title: string;
  /** Template body with `<UPPER_SNAKE>` placeholders. */
  body: string;
  description: string | null;
  /** Placeholder names derived from the body (without angle brackets). */
  placeholders: string[];
  updatedAt: string;
  updatedBy?: string;
}

export interface TextTemplatesRecord {
  templates: TextTemplateItem[];
  /** 0 until the record is first written. */
  version: number;
  updatedAt?: string;
  updatedBy?: string;
}

export class TextTemplatesConflictError extends Error {
  constructor(readonly expectedVersion: number) {
    super(`Text templates changed since version ${expectedVersion}`);
    this.name = 'TextTemplatesConflictError';
  }
}

export class TextTemplateMissingError extends Error {
  constructor(readonly id: string) {
    super(`Text template '${id}' not found`);
    this.name = 'TextTemplateMissingError';
  }
}

export class TextTemplateDuplicateError extends Error {
  constructor(readonly id: string) {
    super(`Text template '${id}' already exists`);
    this.name = 'TextTemplateDuplicateError';
  }
}

const MAX_BODY_BYTES = 100_000;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;

/** Validation shared by the route handlers; throws TextTemplateInputError. */
export class TextTemplateInputError extends Error {}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new TextTemplateInputError(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new TextTemplateInputError(`${field} must be at most ${maxLength} characters`);
  return value;
}

function normalizeItem(raw: Record<string, unknown>): TextTemplateItem {
  const id = String(raw.id ?? '').trim();
  const title = requireText(raw.title ?? id, 'title', MAX_TITLE_LENGTH);
  const bodyValue = raw.body;
  if (typeof bodyValue !== 'string' || !bodyValue.trim()) throw new TextTemplateInputError('body must be a non-empty string');
  if (Buffer.byteLength(bodyValue, 'utf8') > MAX_BODY_BYTES) {
    throw new TextTemplateInputError(`body must be text of at most ${MAX_BODY_BYTES} UTF-8 bytes`);
  }
  const description = raw.description === undefined || raw.description === null
    ? null
    : requireText(raw.description, 'description', MAX_DESCRIPTION_LENGTH);
  return {
    id,
    title,
    body: bodyValue,
    description,
    placeholders: extractPlaceholders(bodyValue),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    ...(typeof raw.updatedBy === 'string' && raw.updatedBy ? { updatedBy: raw.updatedBy } : {}),
  };
}

export async function getTextTemplatesRecord(client: DynamoDBDocumentClient): Promise<TextTemplatesRecord> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_USERS,
    Key: TEXT_TEMPLATES_KEY,
    ConsistentRead: true,
  }));
  const item = result.Item as Record<string, unknown> | undefined;
  if (!item) return { templates: [], version: 0 };
  const rawTemplates = Array.isArray(item.templates) ? item.templates : [];
  const templates = rawTemplates
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .filter((entry) => typeof entry.id === 'string' && entry.id.trim())
    .map((entry) => normalizeItem(entry));
  return {
    templates,
    version: Number(item.version) || 0,
    ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    ...(typeof item.updatedBy === 'string' ? { updatedBy: item.updatedBy } : {}),
  };
}

export interface TextTemplateWriteInput {
  id: string;
  patch: { title?: unknown; body?: unknown; description?: unknown };
  expectedVersion: number;
  actorId?: string;
}

/**
 * Create or update one template inside the record. The record-level
 * `expectedVersion` guards concurrent edits the same way the offers rate card
 * does; the item's `updatedAt`/`updatedBy` always reflect this write.
 */
export async function upsertTextTemplate(
  client: DynamoDBDocumentClient,
  input: TextTemplateWriteInput & { allowCreate: boolean },
): Promise<{ record: TextTemplatesRecord; template: TextTemplateItem }> {
  const current = await getTextTemplatesRecord(client);
  if (current.version !== input.expectedVersion) throw new TextTemplatesConflictError(input.expectedVersion);
  const existingIndex = current.templates.findIndex((item) => item.id === input.id);
  if (existingIndex < 0 && !input.allowCreate) throw new TextTemplateMissingError(input.id);
  if (existingIndex >= 0 && input.allowCreate) throw new TextTemplateDuplicateError(input.id);

  const base = existingIndex >= 0
    ? (current.templates[existingIndex] as unknown as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = {
    ...base,
    ...input.patch,
    id: input.id,
    updatedAt: new Date().toISOString(),
    ...(input.actorId ? { updatedBy: input.actorId } : {}),
  };
  const template = normalizeItem(merged);
  const templates = [...current.templates];
  if (existingIndex >= 0) templates[existingIndex] = template;
  else templates.push(template);

  const record = await writeRecord(client, { templates, expectedVersion: input.expectedVersion, actorId: input.actorId });
  return { record, template };
}

export async function deleteTextTemplate(
  client: DynamoDBDocumentClient,
  input: { id: string; expectedVersion: number; actorId?: string },
): Promise<TextTemplatesRecord> {
  const current = await getTextTemplatesRecord(client);
  if (current.version !== input.expectedVersion) throw new TextTemplatesConflictError(input.expectedVersion);
  const templates = current.templates.filter((item) => item.id !== input.id);
  if (templates.length === current.templates.length) throw new TextTemplateMissingError(input.id);
  return writeRecord(client, { templates, expectedVersion: input.expectedVersion, actorId: input.actorId });
}

async function writeRecord(
  client: DynamoDBDocumentClient,
  input: { templates: TextTemplateItem[]; expectedVersion: number; actorId?: string },
): Promise<TextTemplatesRecord> {
  const next: TextTemplatesRecord = {
    templates: input.templates,
    version: input.expectedVersion + 1,
    updatedAt: new Date().toISOString(),
    ...(input.actorId ? { updatedBy: input.actorId } : {}),
  };
  try {
    await client.send(new PutCommand({
      TableName: TABLE_USERS,
      Item: { ...TEXT_TEMPLATES_KEY, ...next },
      ConditionExpression: input.expectedVersion === 0
        ? 'attribute_not_exists(PK)'
        : '#version = :expectedVersion',
      ...(input.expectedVersion === 0 ? {} : {
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': input.expectedVersion },
      }),
    }));
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new TextTemplatesConflictError(input.expectedVersion);
    }
    throw error;
  }
  return next;
}
