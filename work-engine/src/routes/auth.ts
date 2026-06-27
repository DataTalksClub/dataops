import { getClient } from '../db/client';
import { getUserByEmail, getUser } from '../db/users';
import { createSession, getSession, deleteSession } from '../db/sessions';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/**
 * Simple hash function using SHA-256 via Web Crypto API.
 * Returns hex string.
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
 * Handle all /api/auth/* and /api/me routes.
 */
async function handleAuthRoutes(event: LambdaEvent): Promise<LambdaResponse | null> {
  const method = event.httpMethod || 'GET';
  const path = event.path || '/';

  if (!path.startsWith('/api/auth') && path !== '/api/me') {
    return null;
  }

  const client = await getClient();

  try {
    // POST /api/auth/login
    if (method === 'POST' && path === '/api/auth/login') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
      }

      const email = (body.email as string) || '';
      const password = (body.password as string) || '';

      if (!email || !password) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'email and password are required' }),
        };
      }

      // Find user by email
      const rawUser = await getUserByEmail(client, email);
      if (!rawUser) {
        return {
          statusCode: 401,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Invalid email or password' }),
        };
      }

      // Check password
      if (!rawUser.passwordHash) {
        // No password set - deny access
        return {
          statusCode: 401,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Invalid email or password' }),
        };
      }

      const inputHash = await hashPassword(password);
      if (inputHash !== rawUser.passwordHash) {
        return {
          statusCode: 401,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Invalid email or password' }),
        };
      }

      // Create session
      const session = await createSession(client, rawUser.id);

      // Return user without passwordHash
      const { passwordHash: _ph, ...user } = rawUser;

      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ user, token: session.token }),
      };
    }

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

      const user = await getUser(client, session.userId);
      if (!user) {
        return {
          statusCode: 401,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ user }),
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

export { handleAuthRoutes, hashPassword };
