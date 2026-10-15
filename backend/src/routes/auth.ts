import { getClient } from '../db/client';
import { getUser } from '../db/users';
import { getSession, deleteSession } from '../db/sessions';
import { identityProjection } from '../identity/projections';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/**
 * Extract Bearer token from Authorization header.
 */
export function extractToken(event: LambdaEvent): string | null {
  const headers = event.headers || {};
  // AWS API Gateway may lowercase headers
  const authHeader = headers['Authorization'] || headers['authorization'] || null;
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Handle /api/auth/logout and /api/me for bearer sessions. Sign-in is SSO
 * (browser) or the device flow (CLI and agents); there is no password login.
 */
async function handleAuthRoutes(event: LambdaEvent): Promise<LambdaResponse | null> {
  const method = event.httpMethod || 'GET';
  const path = event.path || '/';

  if (!path.startsWith('/api/auth') && path !== '/api/me') {
    return null;
  }

  const client = await getClient();

  try {
    // POST /api/auth/logout
    if (method === 'POST' && path === '/api/auth/logout') {
      const token = extractToken(event);
      if (token) {
        await deleteSession(client, token);
      }
      return {
        statusCode: 204,
        headers: JSON_HEADERS,
        body: '',
      };
    }

    // GET /api/me
    if (method === 'GET' && path === '/api/me') {
      const token = extractToken(event);
      if (!token) {
        return {
          statusCode: 401,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      const session = await getSession(client, token);
      if (!session) {
        return {
          statusCode: 401,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      // A deleted or disabled account fails closed here exactly as it does on
      // the portal cookie seam: identity is one decision, not per-transport.
      const user = await getUser(client, session.userId);
      if (!user || user.disabled) {
        return {
          statusCode: 401,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ user: identityProjection(user) }),
      };
    }

    return null;
  } catch (err: unknown) {
    console.error('Auth route error:', err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

export { handleAuthRoutes };
