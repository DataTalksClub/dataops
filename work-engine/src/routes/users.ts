import { getClient } from '../db/client';
import { getUser, listUsers, createUser, updateUser } from '../db/users';
import { hashPassword } from './auth';
import type { LambdaEvent, LambdaResponse, UserRole } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const VALID_ROLES = new Set<UserRole>(['admin', 'operator']);

/**
* Handle all /api/users routes.
 */
async function handleUserRoutes(path: string, method: string, rawBody: string | null, event: LambdaEvent): Promise<LambdaResponse | null> {
  // Match /api/users paths
  if (!path.startsWith('/api/users')) {
    return null;
  }

  const client = await getClient();

  try {
    // Parse the path segments after /api/users
    const suffix = path.slice('/api/users'.length);

    // Route: /api/users (collection)
    if (suffix === '' || suffix === '/') {
      return await handleCollection(method, event, rawBody, client);
    }

    // Route: /api/users/:id
    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch) {
      const id = idMatch[1];
      return await handleSingle(method, id, event, rawBody, client);
    }

    // No match within /api/users
    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (err: unknown) {
    console.error('User route error:', err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

function parseBody(rawBody: string | null): Record<string, unknown> | null {
  if (!rawBody) return null;
  if (typeof rawBody === 'object') return rawBody as Record<string, unknown>;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolve the authenticated actor from the request. The router middleware has
 * already verified the session/portal credentials and set `x-user-id`. Returns
 * the actor's user record (with role) or null when the id is absent or unknown.
 */
async function resolveActor(event: LambdaEvent) {
  const actorId = headerValue(event.headers, 'x-user-id');
  if (!actorId) return null;
  return getUser(await getClient(), actorId);
}

/**
 * Only `admin` users may create or mutate user records. `operator` users get
 * 403. This is the permission gate for every write endpoint in this route.
 */
async function requireAdmin(event: LambdaEvent): Promise<{ ok: true } | { ok: false; response: LambdaResponse }> {
  const actor = await resolveActor(event);
  if (!actor || actor.role !== 'admin') {
    return {
      ok: false,
      response: {
        statusCode: 403,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Admin access required' }),
      },
    };
  }
  return { ok: true };
}

/**
 * Handle /api/users collection routes: GET (list) and POST (create).
 */
async function handleCollection(
  method: string,
  event: LambdaEvent,
  rawBody: string | null,
  client: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient
): Promise<LambdaResponse> {
  if (method === 'GET') {
    const users = await listUsers(client);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ users }),
    };
  }

  if (method === 'POST') {
    const gate = await requireAdmin(event);
    if (!gate.ok) return gate.response;

    const body = parseBody(rawBody);
    if (!body) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Request body is required' }),
      };
    }
    if (!isNonEmptyString(body.name)) {
      return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'name is required' }) };
    }
    if (!isNonEmptyString(body.email)) {
      return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'email is required' }) };
    }
    const email = String(body.email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'email must be a valid email address' }) };
    }

    const data: Record<string, unknown> = { name: String(body.name).trim(), email };
    if (body.role !== undefined) {
      if (!VALID_ROLES.has(body.role as UserRole)) {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'role must be "admin" or "operator"' }) };
      }
      data.role = body.role;
    } else {
      data.role = 'operator';
    }
    if (body.password !== undefined) {
      const password = String(body.password);
      if (password.length < 4) {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'password must be at least 4 characters' }) };
      }
      data.passwordHash = await hashPassword(password);
    }

    const user = await createUser(client, data);
    return {
      statusCode: 201,
      headers: JSON_HEADERS,
      body: JSON.stringify({ user }),
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
 * Handle /api/users/:id single resource routes: GET, PATCH (edit/disable).
 */
async function handleSingle(
  method: string,
  id: string,
  event: LambdaEvent,
  rawBody: string | null,
  client: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient
): Promise<LambdaResponse> {
  if (method === 'GET') {
    const user = await getUser(client, id);
    if (!user) {
      return {
        statusCode: 404,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'User not found' }),
      };
    }
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ user }),
    };
  }

  if (method === 'PATCH' || method === 'PUT') {
    const gate = await requireAdmin(event);
    if (!gate.ok) return gate.response;

    const body = parseBody(rawBody);
    if (!body) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Request body is required' }),
      };
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (!isNonEmptyString(body.name)) {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'name must be a non-empty string' }) };
      }
      updates.name = String(body.name).trim();
    }
    if (body.email !== undefined) {
      const email = String(body.email).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'email must be a valid email address' }) };
      }
      updates.email = email;
    }
    if (body.role !== undefined) {
      if (!VALID_ROLES.has(body.role as UserRole)) {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'role must be "admin" or "operator"' }) };
      }
      updates.role = body.role;
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== 'boolean') {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'disabled must be a boolean' }) };
      }
      updates.disabled = body.disabled;
    }
    if (body.password !== undefined) {
      const password = String(body.password);
      if (password.length < 4) {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'password must be at least 4 characters' }) };
      }
      updates.passwordHash = await hashPassword(password);
    }

    if (Object.keys(updates).length === 0) {
      return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: 'No valid fields to update' }) };
    }

    const updated = await updateUser(client, id, updates);
    if (!updated) {
      return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'User not found' }) };
    }
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ user: updated }) };
  }

  // Method not allowed
  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
}

export { handleUserRoutes };
