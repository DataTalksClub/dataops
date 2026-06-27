import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import {
  createTemplate,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  listTemplates,
} from '../db/templates';
import type { LambdaResponse } from '../types';

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

  for (let i = 0; i < taskDefinitions.length; i++) {
    const td = taskDefinitions[i] as Record<string, unknown>;
    if (!td.refId || typeof td.refId !== 'string') {
      return `taskDefinitions[${i}] is missing required field: refId`;
    }
    if (!td.description || typeof td.description !== 'string') {
      return `taskDefinitions[${i}] is missing required field: description`;
    }
    if (td.offsetDays === undefined || td.offsetDays === null || typeof td.offsetDays !== 'number') {
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
async function handleTemplateRoutes(path: string, method: string, rawBody: string | null): Promise<LambdaResponse | null> {
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
      return await handleCollection(method, rawBody, client);
    }

    // Route: /api/templates/:id
    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch) {
      const id = idMatch[1];
      return await handleSingle(method, id, rawBody, client);
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
async function handleCollection(method: string, rawBody: string | null, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method === 'GET') {
    const templates = await listTemplates(client);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ templates }),
    };
  }

  if (method === 'POST') {
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

    const templateData: Record<string, unknown> = {
      name: body.name,
      type: body.type,
      taskDefinitions: body.taskDefinitions,
    };

    // Pick optional template-level fields
    const optionalFields = [
      'emoji', 'tags', 'defaultAssigneeId', 'phases', 'sourceDocIds', 'references',
      'bundleLinkDefinitions', 'triggerType', 'triggerSchedule', 'triggerLeadDays',
    ];
    for (const field of optionalFields) {
      if (body[field] !== undefined) {
        templateData[field] = body[field];
      }
    }

    const template = await createTemplate(client, templateData);
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
async function handleSingle(method: string, id: string, rawBody: string | null, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
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

    // Only allow updating known fields
    const allowedFields = [
      'name', 'type', 'taskDefinitions',
      'emoji', 'tags', 'defaultAssigneeId', 'phases', 'sourceDocIds', 'references',
      'bundleLinkDefinitions', 'triggerType', 'triggerSchedule', 'triggerLeadDays',
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

    const template = await updateTemplate(client, id, updates);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ template }),
    };
  }

  if (method === 'DELETE') {
    const existing = await getTemplate(client, id);
    if (!existing) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Template not found' }),
      };
    }

    await deleteTemplate(client, id);
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
