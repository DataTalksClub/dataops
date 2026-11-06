import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { resolveInteractiveActor } from '../identity/actor';
import { json, parseJsonObjectBody } from '../http';
import { BannerInputError, parseBannerInput } from '../banners/model';
import { getBannerJob } from '../banners/jobs';
import { requestBanner } from '../banners/service';

export async function handleCardBannerRoutes(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  const match = /^\/api\/cards\/([a-zA-Z0-9-]+)\/banners(?:\/([a-f0-9]{64}))?\/?$/.exec(event.path || '');
  if (!match) return null;
  const method = event.httpMethod || 'GET';
  const actor = await resolveInteractiveActor(client, event, method === 'GET' ? 'work-read' : 'work-write');
  if (!actor.ok) return actor.response;
  if (method === 'GET' && match[2]) {
    const job = await getBannerJob(client, match[2]);
    return !job || job.cardId !== match[1] ? json(404, { error: 'Banner job not found on this Card' }) : json(200, { job });
  }
  if (method !== 'POST' || match[2]) return json(405, { error: 'Method not allowed' });
  try {
    const input = parseBannerInput(parseJsonObjectBody(event.body));
    const job = await requestBanner(client, match[1], input, actor.actor.id);
    return json(job.state === 'succeeded' ? 200 : 202, { job });
  } catch (error) {
    if (error instanceof BannerInputError) return json(400, { error: error.message });
    throw error;
  }
}
