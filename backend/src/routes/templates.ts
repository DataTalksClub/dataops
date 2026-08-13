import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../db/client';
import { getTemplate, listTemplates } from '../db/templates';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function json(statusCode: number, body: Record<string, unknown>): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function methodNotAllowed(): LambdaResponse {
  return json(405, {
    error: 'Method not allowed',
    authority: 'git-authored-workflow-templates',
  });
}

async function handleCollection(method: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method !== 'GET') return methodNotAllowed();
  return json(200, { templates: await listTemplates(client) });
}

async function handleSingle(method: string, id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method !== 'GET') return methodNotAllowed();
  const template = await getTemplate(client, id);
  return template
    ? json(200, { template })
    : json(404, { error: 'Template not found' });
}

/** Read-only runtime projections of the Git-authored template definitions. */
async function handleTemplateRoutes(
  path: string,
  method: string,
  _rawBody: string | null,
  _event: LambdaEvent,
): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/templates')) return null;
  const client = await getClient();
  try {
    const suffix = path.slice('/api/templates'.length);
    if (suffix === '' || suffix === '/') return handleCollection(method, client);

    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch) return handleSingle(method, idMatch[1], client);
    return json(404, { error: 'Not found' });
  } catch (error) {
    console.error('Template read route error:', error);
    return json(500, { error: 'Internal server error' });
  }
}

export { handleTemplateRoutes };
