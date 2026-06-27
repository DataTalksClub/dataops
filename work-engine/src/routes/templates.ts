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

    const templateData: Record<string, unknown> = {
      name: body.name,
      type: body.type,
      taskDefinitions: body.taskDefinitions,
    };

    // Pick optional template-level fields
    const optionalFields = [
      'emoji', 'tags', 'defaultAssigneeId', 'references',
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
      'emoji', 'tags', 'defaultAssigneeId', 'references',
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
