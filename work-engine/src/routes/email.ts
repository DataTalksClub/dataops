import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createTask } from '../db/tasks';
import type { LambdaEvent, LambdaResponse } from '../types';

// Extract date from email body (first YYYY-MM-DD match)
function extractDate(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

async function handleEmailWebhook(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  // Check that WEBHOOK_EMAIL_SECRET is configured
  const expectedSecret = process.env.WEBHOOK_EMAIL_SECRET;
  if (!expectedSecret) {
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Webhook not configured' }),
    };
  }

  // Verify webhook secret
  const headers = event.headers || {};
  const secret = headers['x-webhook-secret'] || headers['X-Webhook-Secret'];

  if (secret !== expectedSecret) {
    return {
      statusCode: 401,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  // Parse JSON body
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Invalid request body' }),
    };
  }

  // Validate required fields
  if (!body.from) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Missing required field: from' }),
    };
  }
  if (!body.subject) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Missing required field: subject' }),
    };
  }

  // Extract date from body text, default to today (UTC)
  const date = extractDate(body.body as string | null) || new Date().toISOString().slice(0, 10);

  // Comment is the email body text, or null if empty/missing
  const comment = (body.body as string) || null;

  const task = await createTask(client, {
    description: body.subject,
    date,
    comment,
    source: 'email',
  });

  return {
    statusCode: 201,
    headers: JSON_HEADERS,
    body: JSON.stringify(task),
  };
}

export { handleEmailWebhook, extractDate };
