import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { API_TOKEN_SCOPES, parseApiTokenScopes } from '../auth/tokenScopes';
import { deleteApiToken, createApiToken, listApiTokens, projectApiToken } from '../db/apiTokens';
import { getUser } from '../db/users';
import type { LambdaEvent, LambdaResponse } from '../types';
import { json, noStoreJson, parseJsonObjectBody } from '../http';
import { headerValue } from '../httpHeaders';
import { recordRequestError } from '../requestErrorLog';

const TOKEN_PATH = '/api/tokens';
const LABEL_MAX_LENGTH = 80;

/** Admin management for scoped headless-agent credentials. */
export async function handleApiTokenRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path !== TOKEN_PATH && !path.startsWith(`${TOKEN_PATH}/`)) return null;

  if (path === `${TOKEN_PATH}/self`) {
    if (method !== 'DELETE') return json(405, { error: 'Method not allowed' });
    const tokenId = headerValue(event.headers, 'x-api-token-id');
    if (!tokenId) return json(401, { error: 'Unauthorized' });
    try {
      const revoked = await deleteApiToken(client, tokenId);
      return json(200, { revoked });
    } catch (error: unknown) {
      recordRequestError(error);
      return json(500, { error: 'Internal server error' });
    }
  }

  const gate = await requireAdmin(client, event);
  if (!gate.ok) return gate.response;

  try {
    if (path === TOKEN_PATH || path === `${TOKEN_PATH}/`) {
      if (method === 'GET') return json(200, { tokens: await listApiTokens(client) });
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });

      const body = parseJsonObjectBody<Record<string, unknown>>(event.body);
      if (!body) return json(400, { error: 'Body must be a JSON object with label and scopes' });
      const unknown = Object.keys(body).find((field) => field !== 'label' && field !== 'scopes');
      if (unknown) return json(400, { error: `Unknown field '${unknown}'` });
      if (typeof body.label !== 'string') return json(400, { error: 'label must be a string' });
      const label = body.label.trim();
      if (!label || label.length > LABEL_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) {
        return json(400, { error: `label must be 1-${LABEL_MAX_LENGTH} printable characters` });
      }
      const scopes = parseApiTokenScopes(body.scopes);
      if (!scopes) return json(400, { error: `scopes must contain one or more of: ${API_TOKEN_SCOPES.join(', ')}` });

      const { apiToken, token } = await createApiToken(client, {
        userId: gate.actorId,
        issuedBy: gate.actorId,
        label,
        scopes,
      });
      // This is the only response that contains the raw bearer value. The CLI
      // consumes it directly into its private credential store; it never logs
      // or returns the value to command output.
      return noStoreJson(201, { token, apiToken: projectApiToken(apiToken) });
    }

    const match = path.match(/^\/api\/tokens\/([^/]+)\/?$/);
    if (!match) return json(404, { error: 'Not found' });
    if (method !== 'DELETE') return json(405, { error: 'Method not allowed' });
    const id = decodeURIComponent(match[1]);
    if (!id || id === 'self') return json(404, { error: 'Not found' });
    return json(200, { revoked: await deleteApiToken(client, id) });
  } catch (error: unknown) {
    recordRequestError(error);
    return json(500, { error: 'Internal server error' });
  }
}

async function requireAdmin(
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
): Promise<{ ok: true; actorId: string } | { ok: false; response: LambdaResponse }> {
  // Even an administrator-owned agent token is scoped and cannot manage the
  // token inventory. The router sets this header only after token validation.
  if (headerValue(event.headers, 'x-api-token-id')) {
    return { ok: false, response: json(403, { error: 'Admin access required' }) };
  }
  const actorId = headerValue(event.headers, 'x-user-id');
  const user = actorId ? await getUser(client, actorId) : null;
  if (!user || user.role !== 'admin' || user.disabled) {
    return { ok: false, response: json(403, { error: 'Admin access required' }) };
  }
  return { ok: true, actorId: user.id };
}
