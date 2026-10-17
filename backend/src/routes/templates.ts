import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { invalidateTemplateTypeMap } from '../cards/createCard';
import {
  createCustomTemplate,
  deleteCustomTemplate,
  getTemplate,
  listTemplates,
  resetTemplateOverride,
  writeTemplateDefinition,
  TemplateDuplicateTypeError,
  TemplateEditForbiddenError,
  TemplateImmutableTypeError,
  TemplateRevisionConflictError,
  TemplateVersionConflictError,
} from '../db/templates';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import {
  normalizeTemplateDefinition,
  SERVER_OWNED_TEMPLATE_FIELDS,
  TemplateDefinitionInvalidError,
} from '../templates/templateEdits';
import type { LambdaEvent, LambdaResponse, Template } from '../types';
import { recordRequestError } from '../requestErrorLog';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function json(statusCode: number, body: Record<string, unknown>): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

class TemplateRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'TemplateRequestError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseObject(rawBody: string | null): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || '');
  } catch {
    throw new TemplateRequestError(400, 'invalid-json', 'Invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TemplateRequestError(400, 'invalid-body', 'Request body must be an object');
  }
  return parsed as Record<string, unknown>;
}

function expectedVersionOf(body: Record<string, unknown>): number {
  if (Object.hasOwn(body, 'version')) {
    throw new TemplateRequestError(400, 'invalid-body', 'version is response-only; use expectedVersion');
  }
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
    throw new TemplateRequestError(400, 'invalid-body', 'expectedVersion must be an integer greater than or equal to 1');
  }
  return body.expectedVersion as number;
}

function revisionOf(body: Record<string, unknown>): string {
  if (typeof body.revision !== 'string' || body.revision.length === 0) {
    throw new TemplateRequestError(400, 'invalid-body', 'revision must be a non-empty string');
  }
  return body.revision;
}

function rejectServerOwned(definition: Record<string, unknown>): void {
  const supplied = SERVER_OWNED_TEMPLATE_FIELDS.find((field) => Object.hasOwn(definition, field));
  if (supplied) {
    throw new TemplateRequestError(400, 'invalid-body', `${supplied} is server-owned and cannot be supplied`);
  }
}

function isDryRun(event: LambdaEvent): boolean {
  const query = event.queryStringParameters || {};
  return query.dryRun === 'true' || query['dry-run'] === 'true';
}

async function conflictResponse(client: DynamoDBDocumentClient, id: string, expectedVersion: number): Promise<LambdaResponse> {
  const current = await getTemplate(client, id);
  return json(409, {
    error: 'Template changed; review the current Template and retry',
    code: 'template_version_conflict',
    expectedVersion,
    ...(current ? { currentVersion: current.version, currentTemplate: current } : {}),
  });
}

/**
 * Authenticated runtime Template editing. Reads use `work-read`; pin/reset
 * use `work-write` for any active role; custom create/delete are
 * admin-only. The invoice-reader and knowledge-publisher principals never
 * reach here with a usable credential: their allowlists exclude these
 * paths, so they fail at the router middleware with 401/403.
 */
async function handleTemplateRoutes(
  path: string,
  method: string,
  rawBody: string | null,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/templates')) return null;
  try {
    const suffix = path.slice('/api/templates'.length);
    if (suffix === '' || suffix === '/') {
      if (method === 'GET') {
        const read = await resolveInteractiveActor(client, event, 'work-read');
        if (!read.ok) return read.response;
        const templates = await listTemplates(client);
        return json(200, { templates: templates.map(({ base: _, ...t }) => t) });
      }
      if (method === 'POST') {
        const create = await resolveInteractiveActor(client, event, 'work-write');
        if (!create.ok) return create.response;
        if (!create.actor.isAdmin) return workAdminForbidden('Creating a Template requires an admin');
        const body = parseObject(rawBody);
        rejectServerOwned(body);
        const definition = normalizeTemplateDefinition(body);
        if (isDryRun(event)) return json(200, { dryRun: true, effective: definition });
        const template = await createCustomTemplate(client, definition);
        invalidateTemplateTypeMap();
        return json(201, { template });
      }
      return json(405, { error: 'Method not allowed' });
    }

    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch && method === 'GET') {
      const read = await resolveInteractiveActor(client, event, 'work-read');
      if (!read.ok) return read.response;
      const template = await getTemplate(client, idMatch[1]);
      return template ? json(200, { template }) : json(404, { error: 'Template not found' });
    }
    if (idMatch && (method === 'PUT' || method === 'DELETE')) {
      return method === 'PUT'
        ? await handleTemplateUpdate(client, event, rawBody, idMatch[1])
        : await handleTemplateDelete(client, event, rawBody, idMatch[1]);
    }
    if (idMatch) return json(405, { error: 'Method not allowed' });

    const resetMatch = suffix.match(/^\/([^/]+)\/reset\/?$/);
    if (resetMatch) {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const reset = await resolveInteractiveActor(client, event, 'work-write');
      if (!reset.ok) return reset.response;
      const body = parseObject(rawBody);
      const expectedVersion = expectedVersionOf(body);
      const revision = revisionOf(body);
      if (isDryRun(event)) {
        const template: Template | null = await getTemplate(client, resetMatch[1]);
        if (!template) return json(404, { error: 'Template not found' });
        // A dry run validates exactly what the real reset would enforce, so
        // callers can rely on it before sending an offline edit.
        if (template.version !== expectedVersion || template.revision !== revision) {
          return conflictResponse(client, resetMatch[1], expectedVersion);
        }
        if (template.origin !== 'git' || !template.base) {
          return json(409, {
            error: 'Only Git templates with a base can be reset',
            code: 'cannot-reset-custom-template',
          });
        }
        return json(200, { dryRun: true, template });
      }
      const result = await resetTemplateOverride(client, resetMatch[1], expectedVersion, revision);
      if (!result) return json(404, { error: 'Template not found' });
      return json(200, { template: result.template, applied: result.applied });
    }

    return json(404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof TemplateRequestError) {
      return json(error.statusCode, { error: error.message, code: error.code });
    }
    if (error instanceof TemplateDefinitionInvalidError) {
      return json(422, { error: error.message, code: 'invalid-template', issues: error.issues });
    }
    if (error instanceof TemplateImmutableTypeError) {
      return json(422, { error: 'Template type is immutable', code: 'immutable-template-type' });
    }
    if (error instanceof TemplateDuplicateTypeError) {
      return json(409, { error: error.message, code: 'duplicate-type', type: error.templateType });
    }
    if (error instanceof TemplateEditForbiddenError) {
      const messages = {
        'cannot-reset-custom-template': 'Only Git templates with a base can be reset',
        'cannot-delete-git-template': 'Only custom Templates can be deleted',
        'template-in-use': 'Template is in use by Cards and cannot be deleted',
      } as const;
      return json(409, { error: messages[error.code], code: error.code });
    }
    if (error instanceof TemplateVersionConflictError || error instanceof TemplateRevisionConflictError) {
      const idMatch = path.slice('/api/templates'.length).match(/^\/([^/]+)(?:\/reset)?\/?$/);
      const body = (() => { try { return parseObject(rawBody); } catch { return {}; } })();
      return conflictResponse(client, idMatch?.[1] || '', Number(body.expectedVersion) || 0);
    }
    recordRequestError(error);
    return json(500, { error: 'Internal server error' });
  }
}

async function handleTemplateUpdate(
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
  rawBody: string | null,
  id: string,
): Promise<LambdaResponse> {
  const update = await resolveInteractiveActor(client, event, 'work-write');
  if (!update.ok) return update.response;
  const body = parseObject(rawBody);
  const expectedVersion = expectedVersionOf(body);
  const revision = revisionOf(body);
  if (!body.definition || typeof body.definition !== 'object' || Array.isArray(body.definition)) {
    throw new TemplateRequestError(400, 'invalid-body', 'definition must be an object');
  }
  rejectServerOwned(body.definition as Record<string, unknown>);
  const definition = normalizeTemplateDefinition(body.definition);
  if (isDryRun(event)) return json(200, { dryRun: true, effective: definition });
  const template = await writeTemplateDefinition(
    client, id, definition as Record<string, unknown>, expectedVersion, revision,
  );
  if (!template) return json(404, { error: 'Template not found' });
  return json(200, { template });
}

async function handleTemplateDelete(
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
  rawBody: string | null,
  id: string,
): Promise<LambdaResponse> {
  const remove = await resolveInteractiveActor(client, event, 'work-write');
  if (!remove.ok) return remove.response;
  if (!remove.actor.isAdmin) return workAdminForbidden('Deleting a Template requires an admin');
  const body = parseObject(rawBody);
  const expectedVersion = expectedVersionOf(body);
  const revision = revisionOf(body);
  const template = await deleteCustomTemplate(client, id, expectedVersion, revision);
  if (!template) return json(404, { error: 'Template not found' });
  invalidateTemplateTypeMap();
  return json(200, { deleted: template as unknown as Record<string, unknown> });
}

export { handleTemplateRoutes };
