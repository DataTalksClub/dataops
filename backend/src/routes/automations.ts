/**
 * `GET /api/automations`: what runs without anyone pressing a button. Settings
 * the automations read are changed through `PUT /api/workspace-settings`, the
 * one place workspace settings are written; `canEdit` tells the caller whether
 * it may.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { automationsOverview } from '../automations/view';
import { resolveInteractiveActor } from '../identity/actor';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

export async function handleAutomationRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path !== '/api/automations' && path !== '/api/automations/') return null;
  if (method !== 'GET') {
    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const resolution = await resolveInteractiveActor(client, event, 'work-read');
  if (!resolution.ok) return resolution.response;
  const overview = await automationsOverview(client);
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...overview, canEdit: resolution.actor.isAdmin }),
  };
}
