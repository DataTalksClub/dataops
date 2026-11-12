import { getClient } from '../db/client';
import { getUser } from '../db/users';
import { deleteApiToken, getApiToken, projectApiToken } from '../db/apiTokens';
import { verifySharedIssuerJwt } from '../auth/sharedIssuer';
import { identityProjection } from '../identity/projections';
import { getUsersByNormalizedEmail, normalizeEmail } from '../db/users';
import type { LambdaEvent, LambdaResponse } from '../types';
import { recordRequestError } from '../requestErrorLog';

/** Shared-issuer JWTs identify humans by verified email, like the browser seam. */
async function findUserIdByEmail(client: Awaited<ReturnType<typeof getClient>>, email: string): Promise<string | null> {
  const users = await getUsersByNormalizedEmail(client, normalizeEmail(email));
  if (users.length !== 1 || users[0].disabled) return null;
  return users[0].id;
}

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
 * Handle /api/auth/logout and /api/me for bearer clients: API tokens and
 * shared-issuer JWTs. Sign-in is SSO (browser, cookie session) or the device
 * flow (CLI and agents); there is no password login, and a browser session
 * token is never accepted as a bearer.
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
        const jwt = await verifySharedIssuerJwt(token);
        if (!jwt) {
          const apiToken = await getApiToken(client, token);
          if (apiToken) await deleteApiToken(client, apiToken.id);
        }
        // Issuer sessions are revoked at the issuer (`dataops logout`).
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

      const claims = await verifySharedIssuerJwt(token);
      const apiToken = claims ? null : await getApiToken(client, token);
      const email = claims?.email;
      const jwtUserId = typeof email === 'string' && email && (claims!.email_verified === true || claims!.email_verified === 'true')
        ? await findUserIdByEmail(client, email)
        : null;
      const userId = jwtUserId || apiToken?.userId;
      if (!userId) {
        return {
          statusCode: 401,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      // A deleted or disabled account fails closed here exactly as it does on
      // the portal cookie seam: identity is one decision, not per-transport.
      const user = await getUser(client, userId);
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
        body: JSON.stringify({
          user: identityProjection(user),
          ...(apiToken ? { apiToken: projectApiToken(apiToken) } : {}),
        }),
      };
    }

    return null;
  } catch (err: unknown) {
    recordRequestError(err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

export { handleAuthRoutes };
