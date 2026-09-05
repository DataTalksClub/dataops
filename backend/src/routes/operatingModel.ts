import { resolveInteractiveActor } from '../identity/actor';
import { createHash } from 'node:crypto';
import { loadOperatingModelSnapshot, loadRoadmapSessionTemplate } from '../operatingModel/loader';
import { getCardConsistent } from '../db/cards';
import { listTasksByCard } from '../db/tasks';
import { createCardFromDefinition, DefinitionCardConflictError } from '../db/templates';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
let cached: Awaited<ReturnType<typeof loadOperatingModelSnapshot>> | null = null;
let cachedAt = 0;

async function snapshot() {
  if (cached && Date.now() - cachedAt < SNAPSHOT_TTL_MS) return cached;
  try {
    const loaded = await loadOperatingModelSnapshot();
    cached = loaded;
    cachedAt = Date.now();
    return loaded;
  } catch (error) {
    if (cached) return { ...cached, freshness: 'stale' as const };
    throw error;
  }
}

function identity(actorId: string, sessionId: string, suffix = ''): string {
  return `operating-model-${createHash('sha256').update(`${actorId}:2026-q4:${sessionId}:${suffix}`).digest('hex').slice(0, 40)}`;
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  try {
    const value = JSON.parse(event.body || '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export async function handleOperatingModelRoutes(
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const sessionMatch = /^\/api\/my-plan\/sessions\/(W\d{2})$/.exec(event.path || '');
  if (event.path !== '/api/operating-model' && event.path !== '/api/my-plan' && !sessionMatch) return null;
  const method = (event.httpMethod || 'GET').toUpperCase();
  if ((!sessionMatch && method !== 'GET') || (sessionMatch && method !== 'POST')) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const actor = await resolveInteractiveActor(client, event, method === 'POST' ? 'work-write' : 'work-read');
  if (!actor.ok) return actor.response;
  try {
    const model = await snapshot();
    if (event.path === '/api/my-plan') {
      const actorId = actor.actor.id || 'local-operator';
      const sessions = await Promise.all(model.roadmap.sessions.map(async (session) => {
        const card = await getCardConsistent(client, identity(actorId, session.id));
        return { ...session, state: card ? (card.status === 'archived' ? 'completed' : 'active') : 'proposed', card };
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ revision: model.revision, freshness: model.freshness, sessions }) };
    }
    if (sessionMatch) {
      const body = parseBody(event);
      if (!body || typeof body.expectedDefinitionRevision !== 'string' || typeof body.anchorDate !== 'string') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'expectedDefinitionRevision and anchorDate are required' }) };
      }
      if (body.expectedDefinitionRevision !== model.revision) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Operating model definitions changed; reload the preview' }) };
      }
      if (model.freshness === 'stale') {
        return { statusCode: 503, headers, body: JSON.stringify({ error: 'Operating model definitions must be current before adding a session' }) };
      }
      if (!isIsoDate(body.anchorDate)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'anchorDate must be an ISO date' }) };
      }
      const session = model.roadmap.sessions.find((candidate) => candidate.id === sessionMatch[1]);
      if (!session) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Roadmap session not found' }) };
      const actorId = actor.actor.id || 'local-operator';
      const cardId = identity(actorId, session.id);
      const existing = await getCardConsistent(client, cardId);
      if (existing) {
        if (existing.ownerId !== actorId || existing.operatingModelSource?.sessionId !== session.id) {
          return { statusCode: 409, headers, body: JSON.stringify({ error: 'The deterministic session identity is already in use' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ card: existing, tasks: await listTasksByCard(client, cardId), replayed: true }) };
      }
      const template = await loadRoadmapSessionTemplate(session.templateType, model.revision, actorId);
      try {
        const created = await createCardFromDefinition(client, {
          id: cardId, title: `${session.id}: ${session.title}`, description: session.goal,
          anchorDate: body.anchorDate, ownerId: actorId, ...({ operatingModelSource: {
            kind: 'roadmap-session', roadmapId: model.roadmap.id, sessionId: session.id,
            documentId: session.documentId, definitionRevision: model.revision,
          } }), ...({ sourceDocIds: [session.documentId] }), ...({ templateId: template.id }),
        }, template, body.anchorDate, (ref) => identity(actorId, session.id, ref));
        return { statusCode: 201, headers, body: JSON.stringify({ ...created, replayed: false }) };
      } catch (error) {
        if (error instanceof DefinitionCardConflictError) {
          const card = await getCardConsistent(client, cardId);
          if (card?.ownerId === actorId && card.operatingModelSource?.sessionId === session.id) {
            return { statusCode: 200, headers, body: JSON.stringify({ card, tasks: await listTasksByCard(client, cardId), replayed: true }) };
          }
        }
        throw error;
      }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ model }) };
  } catch (error) {
    console.error('Operating model load failed', error instanceof Error ? error.message : 'unknown');
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Operating model definitions are unavailable' }) };
  }
}
