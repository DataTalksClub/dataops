import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import {
  createTemplateWithAudit,
  getTemplate,
  updateTemplateWithAudit,
  deleteTemplateWithAudit,
  listTemplates,
  countTemplateReferences,
  recordRejectedTemplateDelete,
  TemplateVersionConflictError,
} from '../db/templates';
import { getUser } from '../db/users';
import type { LambdaEvent, LambdaResponse, User } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

const VALID_STAGES = ['preparation', 'announced', 'after-event', 'done'];
const VALID_PROOF_REQUIREMENT_TYPES = ['url', 'file', 'artifact', 'comment', 'external-status'];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidationPayload(value: unknown): boolean {
  return (
    typeof value === 'string'
    || (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
    )
  );
}

function isRecordArrayWithStringId(value: unknown, idField: string): boolean {
  return Array.isArray(value) && value.every((item) => (
    item !== null
    && typeof item === 'object'
    && !Array.isArray(item)
    && typeof (item as Record<string, unknown>)[idField] === 'string'
    && ((item as Record<string, unknown>)[idField] as string).trim().length > 0
  ));
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function json(statusCode: number, body: Record<string, unknown>): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

async function requireTemplateAdmin(
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<{ actor: User } | { response: LambdaResponse }> {
  // The router deletes browser-supplied x-user-id and replaces it only after
  // verifying a portal cookie or bearer session. This route resolves the role
  // from the persisted user record; role/id forwarding headers are never used.
  const testActorId = process.env.NODE_ENV === 'test' && process.env.SKIP_AUTH === 'true'
    ? process.env.E2E_TEMPLATE_ACTOR_ID || ''
    : '';
  const actorId = headerValue(event.headers, 'x-user-id') || testActorId;
  if (!actorId) return { response: json(401, { error: 'Unauthorized' }) };
  const actor = await getUser(client, actorId);
  if (!actor || actor.disabled) return { response: json(401, { error: 'Unauthorized' }) };
  if (actor.role !== 'admin') return { response: json(403, { error: 'Admin access required' }) };
  return { actor };
}

function expectedVersion(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function conflictResponse(template: { version: number; updatedAt: string } | null): LambdaResponse {
  const body: Record<string, unknown> = { error: 'Template version conflict', code: 'version_conflict' };
  if (template) {
    body.currentVersion = template.version;
    body.updatedAt = template.updatedAt;
  }
  return json(409, body);
}

function validateProofRequirement(value: unknown, context: string): string | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${context} must be an object`;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || !VALID_PROOF_REQUIREMENT_TYPES.includes(record.type)) {
    return `${context}.type must be one of: ${VALID_PROOF_REQUIREMENT_TYPES.join(', ')}`;
  }
  if (record.label !== undefined && typeof record.label !== 'string') {
    return `${context}.label must be a string`;
  }
  if (record.required !== undefined && typeof record.required !== 'boolean') {
    return `${context}.required must be a boolean`;
  }
  return null;
}

/**
 * Validate an array of task definitions.
 * Returns an error string if invalid, or null if valid.
 */
function validateTaskDefinitions(taskDefinitions: unknown): string | null {
  if (!Array.isArray(taskDefinitions) || taskDefinitions.length === 0) {
    return 'taskDefinitions must be a non-empty array';
  }

  const refIds = new Set<string>();
  for (let i = 0; i < taskDefinitions.length; i++) {
    const td = taskDefinitions[i] as Record<string, unknown>;
    if (!td.refId || typeof td.refId !== 'string') {
      return `taskDefinitions[${i}] is missing required field: refId`;
    }
    if (refIds.has(td.refId)) return `taskDefinitions[${i}].refId must be unique`;
    refIds.add(td.refId);
    if (!td.description || typeof td.description !== 'string') {
      return `taskDefinitions[${i}] is missing required field: description`;
    }
    if (td.offsetDays === undefined || td.offsetDays === null || typeof td.offsetDays !== 'number' || !Number.isFinite(td.offsetDays)) {
      return `taskDefinitions[${i}] is missing required field: offsetDays`;
    }
    if (td.instructionsUrl !== undefined && typeof td.instructionsUrl !== 'string') {
      return `taskDefinitions[${i}].instructionsUrl must be a string`;
    }
    if (td.instructionDocId !== undefined && typeof td.instructionDocId !== 'string') {
      return `taskDefinitions[${i}].instructionDocId must be a string`;
    }
    if (td.instructionStepId !== undefined && typeof td.instructionStepId !== 'string') {
      return `taskDefinitions[${i}].instructionStepId must be a string`;
    }
    if (td.phase !== undefined && typeof td.phase !== 'string') {
      return `taskDefinitions[${i}].phase must be a string`;
    }
    if (td.systems !== undefined && !isStringArray(td.systems)) {
      return `taskDefinitions[${i}].systems must be an array of strings`;
    }
    if (td.validation !== undefined && !isValidationPayload(td.validation)) {
      return `taskDefinitions[${i}].validation must be a string or object`;
    }
    if (td.isMilestone !== undefined && typeof td.isMilestone !== 'boolean') {
      return `taskDefinitions[${i}].isMilestone must be a boolean`;
    }
    if (td.stageOnComplete !== undefined) {
      if (typeof td.stageOnComplete !== 'string' || !VALID_STAGES.includes(td.stageOnComplete)) {
        return `taskDefinitions[${i}].stageOnComplete must be one of: ${VALID_STAGES.join(', ')}`;
      }
    }
    if (td.assigneeId !== undefined && typeof td.assigneeId !== 'string') {
      return `taskDefinitions[${i}].assigneeId must be a string`;
    }
    if (td.requiredLinkName !== undefined && typeof td.requiredLinkName !== 'string') {
      return `taskDefinitions[${i}].requiredLinkName must be a string`;
    }
    if (td.requiresFile !== undefined && typeof td.requiresFile !== 'boolean') {
      return `taskDefinitions[${i}].requiresFile must be a boolean`;
    }
    const proofRequirementError = validateProofRequirement(td.proofRequirement, `taskDefinitions[${i}].proofRequirement`);
    if (proofRequirementError) {
      return proofRequirementError;
    }
    if (td.artifactRefs !== undefined && !isRecordArrayWithStringId(td.artifactRefs, 'artifactId')) {
      return `taskDefinitions[${i}].artifactRefs must be an array of objects with artifactId`;
    }
    if (td.assistantJobRefs !== undefined && !isRecordArrayWithStringId(td.assistantJobRefs, 'assistantJobId')) {
      return `taskDefinitions[${i}].assistantJobRefs must be an array of objects with assistantJobId`;
    }
    if (td.auditEventRefs !== undefined && !isRecordArrayWithStringId(td.auditEventRefs, 'auditEventId')) {
      return `taskDefinitions[${i}].auditEventRefs must be an array of objects with auditEventId`;
    }
    if (td.intakeRefs !== undefined && !isRecordArrayWithStringId(td.intakeRefs, 'intakeItemId')) {
      return `taskDefinitions[${i}].intakeRefs must be an array of objects with intakeItemId`;
    }
  }

  return null;
}

function validateTemplateFields(body: Record<string, unknown>): string | null {
  for (const field of ['name', 'type', 'emoji', 'defaultAssigneeId', 'triggerType', 'triggerSchedule']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') return `${field} must be a string`;
  }
  for (const field of ['name', 'type']) {
    if (body[field] !== undefined && String(body[field]).trim().length === 0) return `${field} must be a non-empty string`;
  }
  if (body.tags !== undefined && !isStringArray(body.tags)) return 'tags must be an array of strings';
  if (body.triggerLeadDays !== undefined && (
    typeof body.triggerLeadDays !== 'number' || !Number.isInteger(body.triggerLeadDays) || body.triggerLeadDays < 0
  )) return 'triggerLeadDays must be a non-negative integer';
  if (body.triggerEnabled !== undefined && typeof body.triggerEnabled !== 'boolean') return 'triggerEnabled must be a boolean';
  if (body.references !== undefined) {
    if (!Array.isArray(body.references) || !body.references.every((item) => item && typeof item === 'object' && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).name === 'string' && typeof (item as Record<string, unknown>).url === 'string')) {
      return 'references must be an array of objects with string name and url';
    }
  }
  if (body.cardLinkDefinitions !== undefined) {
    if (!Array.isArray(body.cardLinkDefinitions) || !body.cardLinkDefinitions.every((item) => item && typeof item === 'object' && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).name === 'string')) {
      return 'cardLinkDefinitions must be an array of objects with string name';
    }
  }
  return null;
}

function validateTemplateDocContext(body: Record<string, unknown>): string | null {
  if (body.sourceDocIds !== undefined && !isStringArray(body.sourceDocIds)) {
    return 'sourceDocIds must be an array of strings';
  }
  if (body.phases !== undefined) {
    if (!Array.isArray(body.phases)) {
      return 'phases must be an array';
    }
    for (let i = 0; i < body.phases.length; i++) {
      const phase = body.phases[i] as Record<string, unknown>;
      if (phase === null || typeof phase !== 'object' || Array.isArray(phase)) {
        return `phases[${i}] must be an object`;
      }
      if (typeof phase.id !== 'string' || phase.id.trim().length === 0) {
        return `phases[${i}].id must be a non-empty string`;
      }
      if (typeof phase.name !== 'string' || phase.name.trim().length === 0) {
        return `phases[${i}].name must be a non-empty string`;
      }
      if (phase.stage !== undefined && typeof phase.stage !== 'string') {
        return `phases[${i}].stage must be a string`;
      }
    }
  }
  return null;
}

/**
 * Handle all /api/templates routes.
 */
async function handleTemplateRoutes(path: string, method: string, rawBody: string | null, event: LambdaEvent): Promise<LambdaResponse | null> {
  // Match /api/templates paths
  if (!path.startsWith('/api/templates')) {
    return null;
  }

  const client = await getClient();

  try {
    // Parse the path segments after /api/templates
    const suffix = path.slice('/api/templates'.length);

    // Route: /api/templates (collection)
    if (suffix === '' || suffix === '/') {
      return await handleCollection(method, rawBody, client, event);
    }

    // Route: /api/templates/:id
    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch) {
      const id = idMatch[1];
      return await handleSingle(method, id, rawBody, client, event);
    }

    // No match within /api/templates
    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (err: unknown) {
    console.error('Template route error:', err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

/**
 * Handle /api/templates collection routes (GET list, POST create).
 */
async function handleCollection(method: string, rawBody: string | null, client: DynamoDBDocumentClient, event: LambdaEvent): Promise<LambdaResponse> {
  if (method === 'GET') {
    const templates = await listTemplates(client);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ templates }),
    };
  }

  if (method === 'POST') {
    const gate = await requireTemplateAdmin(event, client);
    if ('response' in gate) return gate.response;
    // Parse body
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody!);
    } catch {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Invalid JSON' }),
      };
    }

    // Validate required fields
    if (!body.name || typeof body.name !== 'string' || (body.name as string).trim() === '') {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Missing required field: name' }),
      };
    }

    if (!body.type || typeof body.type !== 'string' || (body.type as string).trim() === '') {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Missing required field: type' }),
      };
    }

    if (!body.taskDefinitions) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Missing required field: taskDefinitions' }),
      };
    }

    const tdError = validateTaskDefinitions(body.taskDefinitions);
    if (tdError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: tdError }),
      };
    }
    const docContextError = validateTemplateDocContext(body);
    if (docContextError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: docContextError }),
      };
    }
    const fieldError = validateTemplateFields(body);
    if (fieldError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: fieldError }),
      };
    }

    const templateData: Record<string, unknown> = {
      name: body.name,
      type: body.type,
      taskDefinitions: body.taskDefinitions,
    };

    // Pick optional template-level fields
    const optionalFields = [
      'emoji', 'tags', 'defaultAssigneeId', 'phases', 'sourceDocIds', 'references',
      'cardLinkDefinitions', 'triggerType', 'triggerSchedule', 'triggerLeadDays',
      'triggerEnabled',
    ];
    for (const field of optionalFields) {
      if (body[field] !== undefined) {
        templateData[field] = body[field];
      }
    }

    const template = await createTemplateWithAudit(client, templateData, gate.actor.id);
    return {
      statusCode: 201,
      headers: JSON_HEADERS,
      body: JSON.stringify({ template }),
    };
  }

  // Method not allowed
  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
}

/**
 * Handle /api/templates/:id single resource routes (GET, PUT, DELETE).
 */
async function handleSingle(method: string, id: string, rawBody: string | null, client: DynamoDBDocumentClient, event: LambdaEvent): Promise<LambdaResponse> {
  if (method === 'GET') {
    const template = await getTemplate(client, id);
    if (!template) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Template not found' }),
      };
    }
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ template }),
    };
  }

  if (method === 'PUT') {
    const gate = await requireTemplateAdmin(event, client);
    if ('response' in gate) return gate.response;
    // Parse body
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody!);
    } catch {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Invalid JSON' }),
      };
    }

    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Request body is empty or invalid' }),
      };
    }

    // Check template exists
    const existing = await getTemplate(client, id);
    if (!existing) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Template not found' }),
      };
    }

    const version = expectedVersion(body.expectedVersion);
    if (version === null || version !== existing.version) return conflictResponse(existing);

    // Only allow updating known fields
    const allowedFields = [
      'name', 'type', 'taskDefinitions',
      'emoji', 'tags', 'defaultAssigneeId', 'phases', 'sourceDocIds', 'references',
      'cardLinkDefinitions', 'triggerType', 'triggerSchedule', 'triggerLeadDays',
      'triggerEnabled',
    ];
    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'No valid fields to update' }),
      };
    }

    // Validate taskDefinitions if provided
    if (updates.taskDefinitions !== undefined) {
      const tdError = validateTaskDefinitions(updates.taskDefinitions);
      if (tdError) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: tdError }),
        };
      }
    }
    const docContextError = validateTemplateDocContext(updates);
    if (docContextError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: docContextError }),
      };
    }
    const fieldError = validateTemplateFields(updates);
    if (fieldError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: fieldError }),
      };
    }

    let template;
    try {
      template = await updateTemplateWithAudit(client, id, updates, version, gate.actor.id);
    } catch (error) {
      if (error instanceof TemplateVersionConflictError) return conflictResponse(await getTemplate(client, id));
      throw error;
    }
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ template }),
    };
  }

  if (method === 'DELETE') {
    const gate = await requireTemplateAdmin(event, client);
    if ('response' in gate) return gate.response;
    let body: Record<string, unknown>;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }
    const existing = await getTemplate(client, id);
    if (!existing) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Template not found' }),
      };
    }


    const version = expectedVersion(body.expectedVersion);
    if (version === null || version !== existing.version) {
      await recordRejectedTemplateDelete(client, {
        actorId: gate.actor.id,
        templateId: id,
        reason: 'version_conflict',
        priorVersion: existing.version,
      });
      return conflictResponse(existing);
    }

    const references = await countTemplateReferences(client, id);
    if (references.total > 0) {
      await recordRejectedTemplateDelete(client, {
        actorId: gate.actor.id,
        templateId: id,
        reason: 'template_in_use',
        priorVersion: existing.version,
      });
      const categories = Object.fromEntries(
        Object.entries(references).filter(([name, count]) => name !== 'total' && count > 0),
      );
      return json(409, {
        error: 'Template is in use',
        code: 'template_in_use',
        references: { total: references.total, categories },
      });
    }

    try {
      await deleteTemplateWithAudit(client, id, version, gate.actor.id);
    } catch (error) {
      if (error instanceof TemplateVersionConflictError) {
        const current = await getTemplate(client, id);
        await recordRejectedTemplateDelete(client, {
          actorId: gate.actor.id,
          templateId: id,
          reason: 'version_conflict',
          priorVersion: current?.version,
        });
        return conflictResponse(current);
      }
      throw error;
    }
    return {
      statusCode: 204,
      headers: JSON_HEADERS,
      body: '',
    };
  }

  // Method not allowed
  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
}

export { handleTemplateRoutes };
