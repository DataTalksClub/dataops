/**
 * `/api/text-templates`: generic templated text records with placeholders.
 *
 * These are distinct from card/workflow templates (`/api/templates`) and from
 * KB email templates (`/api/email-templates`, Gmail-rendered). Reads are open
 * to any authenticated actor; create/update/delete require an admin, and every
 * mutation carries the record-level `expectedVersion` like `/api/offers`.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  deleteTextTemplate,
  getTextTemplatesRecord,
  TextTemplateDuplicateError,
  TextTemplateInputError,
  TextTemplateMissingError,
  TextTemplatesConflictError,
  upsertTextTemplate,
} from '../db/textTemplates';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import { json, parseJsonObjectEventOrEmpty } from '../http';
import { recordRequestError } from '../requestErrorLog';
import { renderTextTemplate } from '../textTemplates/render';
import type { LambdaEvent, LambdaResponse } from '../types';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const BASE = '/api/text-templates';

/** Empty-body-friendly parse: handlers validate required fields themselves. */
function jsonBody(event: LambdaEvent): Record<string, unknown> {
  return parseJsonObjectEventOrEmpty(event) ?? {};
}

function requireExpectedVersion(raw: unknown): number {
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TextTemplateInputError('expectedVersion must be the record version you read (0 when empty)');
  }
  return version;
}

function templateValues(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TextTemplateInputError('values must be an object mapping placeholder names to strings');
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new TextTemplateInputError(`values.${key} must be a string`);
    values[key] = value;
  }
  return values;
}

export async function handleTextTemplateRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return null;

  try {
    const suffix = path.slice(BASE.length);
    const isRead = method === 'GET';
    const resolution = await resolveInteractiveActor(client, event, isRead || suffix.endsWith('/render') ? 'work-read' : 'work-write');
    if (!resolution.ok) return resolution.response;
    if (!isRead && !suffix.endsWith('/render') && !resolution.actor.isAdmin) {
      return workAdminForbidden('Admin access required to change text templates');
    }

    if (suffix === '' || suffix === '/') {
      if (method === 'GET') return json(200, await getTextTemplatesRecord(client));
      if (method === 'POST') return await handleCreate(event, client, resolution.actor.id);
      return json(405, { error: 'Method not allowed' });
    }

    const idMatch = suffix.match(/^\/([^/]+)(\/render)?$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (!SLUG_PATTERN.test(id)) {
        return json(400, { error: 'Template id must be 1-64 characters of letters, digits, ".", "-", "_"' });
      }
      if (idMatch[2]) {
        if (method === 'POST') return await handleRender(event, client, id);
        return json(405, { error: 'Method not allowed' });
      }
      if (method === 'GET') return await handleShow(client, id);
      if (method === 'PUT' || method === 'PATCH') return await handleUpdate(event, client, id, resolution.actor.id);
      if (method === 'DELETE') return await handleDelete(event, client, id, resolution.actor.id);
      return json(405, { error: 'Method not allowed' });
    }

    return json(404, { error: 'Not found' });
  } catch (error: unknown) {
    if (error instanceof TextTemplateInputError) return json(400, { error: error.message });
    if (error instanceof TextTemplateMissingError) return json(404, { error: error.message });
    if (error instanceof TextTemplateDuplicateError) return json(409, { error: error.message });
    if (error instanceof TextTemplatesConflictError) {
      return json(409, {
        error: 'Text templates changed since you read them; reload and try again',
        code: 'version_conflict',
        current: await getTextTemplatesRecord(client),
      });
    }
    recordRequestError(error);
    return json(500, { error: 'Internal server error' });
  }
}

async function handleCreate(event: LambdaEvent, client: DynamoDBDocumentClient, actorId: string): Promise<LambdaResponse> {
  const body = jsonBody(event);
  const id = String(body.id ?? '').trim();
  if (!SLUG_PATTERN.test(id)) throw new TextTemplateInputError('id must be 1-64 characters of letters, digits, ".", "-", "_"');
  const { record, template } = await upsertTextTemplate(client, {
    id,
    patch: { title: body.title, body: body.body, description: body.description },
    expectedVersion: requireExpectedVersion(body.expectedVersion),
    actorId,
    allowCreate: true,
  });
  return json(201, { template, version: record.version });
}

async function handleUpdate(event: LambdaEvent, client: DynamoDBDocumentClient, id: string, actorId: string): Promise<LambdaResponse> {
  const body = jsonBody(event);
  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.body !== undefined) patch.body = body.body;
  if (body.description !== undefined) patch.description = body.description;
  if (!Object.keys(patch).length) throw new TextTemplateInputError('Nothing to update; pass title, body or description');
  const { record, template } = await upsertTextTemplate(client, {
    id,
    patch,
    expectedVersion: requireExpectedVersion(body.expectedVersion),
    actorId,
    allowCreate: false,
  });
  return json(200, { template, version: record.version });
}

async function handleDelete(event: LambdaEvent, client: DynamoDBDocumentClient, id: string, actorId: string): Promise<LambdaResponse> {
  const body = jsonBody(event);
  const expectedVersion = requireExpectedVersion(body.expectedVersion ?? event.queryStringParameters?.expectedVersion);
  const record = await deleteTextTemplate(client, { id, expectedVersion, actorId });
  return json(200, { deleted: id, version: record.version });
}

async function handleShow(client: DynamoDBDocumentClient, id: string): Promise<LambdaResponse> {
  const record = await getTextTemplatesRecord(client);
  const template = record.templates.find((item) => item.id === id);
  if (!template) return json(404, { error: `Text template '${id}' not found` });
  return json(200, { template, version: record.version });
}

async function handleRender(event: LambdaEvent, client: DynamoDBDocumentClient, id: string): Promise<LambdaResponse> {
  const record = await getTextTemplatesRecord(client);
  const template = record.templates.find((item) => item.id === id);
  if (!template) return json(404, { error: `Text template '${id}' not found` });
  const values = templateValues(jsonBody(event).values);
  const rendered = renderTextTemplate(template.body, values);
  if (rendered.missing.length) {
    return json(400, {
      error: `Missing values for placeholder${rendered.missing.length === 1 ? '' : 's'}: ${rendered.missing.map((name) => `<${name}>`).join(', ')}`,
      missing: rendered.missing,
    });
  }
  return json(200, {
    id,
    text: rendered.text,
    placeholders: template.placeholders,
    unused: rendered.unused,
    version: record.version,
  });
}
