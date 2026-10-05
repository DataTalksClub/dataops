import {KnowledgeStore} from '../docs/knowledgeStore';
import { resolveInteractiveActor } from '../identity/actor';
import { loadOperatingModelSnapshot } from '../operatingModel/loader';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
let cached: Awaited<ReturnType<typeof loadOperatingModelSnapshot>> | null = null;
let cachedPublication = '';
let storeFactory=()=>new KnowledgeStore();
export function configureOperatingModelStoreForTests(factory:(()=>KnowledgeStore)|null):void {storeFactory=factory||(()=>new KnowledgeStore());cached=null;cachedPublication='';}
async function snapshot(store:KnowledgeStore) {
  try {
    if(!store.offline) await store.pin();
    if(!store.offline && cached && cachedPublication===store.revision)return cached;
    const loaded=await loadOperatingModelSnapshot(store);
    cached=loaded;cachedPublication=store.revision;return loaded;
  } catch(error) {if(cached)return {...cached,freshness:'stale' as const};throw error;}
}

export async function handleOperatingModelRoutes(
  event: LambdaEvent,
  _client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (event.path !== '/api/operating-model') return null;
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const actor = await resolveInteractiveActor(_client, event, 'work-read');
  if (!actor.ok) return actor.response;
  try {
    const store=storeFactory();
    const model = await snapshot(store);
    return { statusCode: 200, headers, body: JSON.stringify({ model }) };
  } catch (error) {
    console.error('Operating model load failed', error instanceof Error ? error.message : 'unknown');
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Operating model definitions are unavailable' }) };
  }
}
