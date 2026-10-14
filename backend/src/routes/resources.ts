/**
 * `GET /api/resources` — the required-resource vocabulary.
 *
 * Clients label and filter a Task's `requires` from this list, so the CLI and
 * the frontend never carry their own copy of the ids.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { resolveInteractiveActor } from '../identity/actor';
import { REQUIRED_RESOURCES } from '../resources/vocabulary';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function handleResourceRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path !== '/api/resources' && path !== '/api/resources/') return null;
  if (method !== 'GET') return json(405, { error: 'Method not allowed' });
  const resolution = await resolveInteractiveActor(client, event, 'work-read');
  if (!resolution.ok) return resolution.response;
  return json(200, { resources: REQUIRED_RESOURCES });
}
