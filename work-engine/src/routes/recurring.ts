import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import {
  createRecurringConfig,
  getRecurringConfig,
  updateRecurringConfig,
  deleteRecurringConfig,
  listRecurringConfigs,
  generateRecurringTasks,
} from '../db/recurring';
import type { LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/**
 * Validate that a cron expression has exactly 5 space-separated fields.
 */
function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5;
}

/**
 * Validate recurring config data for create/update.
 * Returns an error string if invalid, or null if valid.
 */
function validateRecurringData(body: Record<string, unknown>, isUpdate: boolean): string | null {
  if (!isUpdate) {
    // Required fields for creation
    if (!body.description || typeof body.description !== 'string' || (body.description as string).trim() === '') {
      return 'Missing required field: description';
    }

    if (!body.cronExpression || typeof body.cronExpression !== 'string') {
      return 'Missing required field: cronExpression';
    }

    if (!isValidCronExpression(body.cronExpression as string)) {
      return 'Invalid cron expression format: must have exactly 5 space-separated fields';
    }
  }

  // Validate cronExpression format if provided on update
  if (isUpdate && body.cronExpression !== undefined) {
    if (typeof body.cronExpression !== 'string' || !isValidCronExpression(body.cronExpression as string)) {
      return 'Invalid cron expression format: must have exactly 5 space-separated fields';
    }
  }

  // Validate assigneeId type if provided
  if (body.assigneeId !== undefined && typeof body.assigneeId !== 'string') {
    return 'assigneeId must be a string';
  }

  // Validate enabled type if provided
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }

  return null;
}

/**
 * Handle all /api/recurring routes.
 */
async function handleRecurringRoutes(path: string, method: string, rawBody: string | null): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/recurring')) {
    return null;
  }

  const client = await getClient();

  try {
    const suffix = path.slice('/api/recurring'.length);

    // Route: /api/recurring/generate (must be matched before /:id)
    if (suffix === '/generate') {
      return await handleGenerate(method, rawBody, client);
    }

    // Route: /api/recurring (collection)
    if (suffix === '' || suffix === '/') {
      return await handleCollection(method, rawBody, client);
    }

    // Route: /api/recurring/:id
    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch) {
      const id = idMatch[1];
      return await handleSingle(method, id, rawBody, client);
    }

    // No match within /api/recurring
    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (err: unknown) {
    console.error('Recurring route error:', err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

/**
 * Handle /api/recurring collection routes (GET list, POST create).
 */
async function handleCollection(method: string, rawBody: string | null, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method === 'GET') {
    const recurringConfigs = await listRecurringConfigs(client);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ recurringConfigs }),
    };
  }

  if (method === 'POST') {
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

    const validationError = validateRecurringData(body, false);
    if (validationError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: validationError }),
      };
    }

    const allowedFields = ['description', 'cronExpression', 'assigneeId', 'enabled'];
    const data: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        data[field] = body[field];
      }
    }

    const recurringConfig = await createRecurringConfig(client, data);
    return {
      statusCode: 201,
      headers: JSON_HEADERS,
      body: JSON.stringify({ recurringConfig }),
    };
  }

  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
}

/**
 * Handle /api/recurring/:id single resource routes (GET, PUT, DELETE).
 */
async function handleSingle(method: string, id: string, rawBody: string | null, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method === 'GET') {
    const recurringConfig = await getRecurringConfig(client, id);
    if (!recurringConfig) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Recurring config not found' }),
      };
    }
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ recurringConfig }),
    };
  }

  if (method === 'PUT') {
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

    // Check config exists
    const existing = await getRecurringConfig(client, id);
    if (!existing) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Recurring config not found' }),
      };
    }

    // Validate fields
    const validationError = validateRecurringData(body, true);
    if (validationError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: validationError }),
      };
    }

    const allowedFields = ['description', 'cronExpression', 'assigneeId', 'enabled'];
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

    const recurringConfig = await updateRecurringConfig(client, id, updates);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ recurringConfig }),
    };
  }

  if (method === 'DELETE') {
    const existing = await getRecurringConfig(client, id);
    if (!existing) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Recurring config not found' }),
      };
    }

    await deleteRecurringConfig(client, id);
    return {
      statusCode: 204,
      headers: JSON_HEADERS,
      body: '',
    };
  }

  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
}

/**
 * Handle POST /api/recurring/generate.
 */
async function handleGenerate(method: string, rawBody: string | null, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

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

  if (!body || !body.startDate || !body.endDate) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'startDate and endDate are required' }),
    };
  }

  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(body.startDate as string) || !dateRegex.test(body.endDate as string)) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'startDate and endDate must be in YYYY-MM-DD format' }),
    };
  }

  // Validate endDate >= startDate
  if ((body.endDate as string) < (body.startDate as string)) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'endDate must be greater than or equal to startDate' }),
    };
  }

  // Validate date range does not exceed 90 days
  const start = new Date((body.startDate as string) + 'T00:00:00Z');
  const end = new Date((body.endDate as string) + 'T00:00:00Z');
  const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays > 90) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Date range must not exceed 90 days' }),
    };
  }

  const result = await generateRecurringTasks(client, body.startDate as string, body.endDate as string);
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ generated: result.generated, skipped: result.skipped }),
  };
}

export { handleRecurringRoutes };
