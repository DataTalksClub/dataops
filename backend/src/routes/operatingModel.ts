import { resolveInteractiveActor } from '../identity/actor';
import { loadOperatingModelSnapshot } from '../operatingModel/loader';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };

export async function handleOperatingModelRoutes(
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (event.path !== '/api/operating-model' && event.path !== '/api/my-plan') return null;
  if ((event.httpMethod || 'GET').toUpperCase() !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const actor = await resolveInteractiveActor(client, event, 'work-read');
  if (!actor.ok) return actor.response;
  try {
    const model = await loadOperatingModelSnapshot();
    if (event.path === '/api/my-plan') {
      return { statusCode: 200, headers, body: JSON.stringify({ revision: model.revision, sessions: model.roadmap.sessions }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ model }) };
  } catch (error) {
    console.error('Operating model load failed', error instanceof Error ? error.message : 'unknown');
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Operating model definitions are unavailable' }) };
  }
}
