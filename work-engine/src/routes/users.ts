import { getClient } from '../db/client';
import { getUser, listUsers } from '../db/users';
import type { LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/**
 * Handle all /api/users routes.
 */
async function handleUserRoutes(path: string, method: string, rawBody: string | null): Promise<LambdaResponse | null> {
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
      return await handleCollection(method, client);
    }

    // Route: /api/users/:id
    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch) {
      const id = idMatch[1];
      return await handleSingle(method, id, client);
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

/**
 * Handle /api/users collection routes (GET only).
 */
async function handleCollection(method: string, client: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (method === 'GET') {
    const users = await listUsers(client);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ users }),
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
 * Handle /api/users/:id single resource routes (GET only).
 */
async function handleSingle(method: string, id: string, client: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient): Promise<LambdaResponse> {
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

  // Method not allowed
  return {
    statusCode: 405,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: 'Method not allowed' }),
  };
}

export { handleUserRoutes };
