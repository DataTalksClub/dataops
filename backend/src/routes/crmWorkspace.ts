import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { resolveDefaultAssigneeId } from '../db/workspaceSettings';
import { listCompanies, listPeople } from '../crmWorkspace/directory';
import { archiveView, createView, listViews, updateView } from '../crmWorkspace/views';
import { createNote, listNotes, type NoteTarget } from '../crmWorkspace/notes';
import { readActivity, type ActivityTarget } from '../crmWorkspace/activity';

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const parse = (event: LambdaEvent): Record<string, unknown> | null => {
  try {
    return event.body ? (JSON.parse(String(event.body)) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const actor = (event: LambdaEvent): string =>
  Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'x-user-id')?.[1] || '';

const queryOf = (event: LambdaEvent): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(event.queryStringParameters || {}).map(([key, value]) => [key, value ?? undefined]));

/**
 * CRM workspace routes: bounded directories, personal saved views, unified
 * record activity and append-only notes. Record/task/mail/finance stores are
 * reused, never duplicated; writes are views + notes only.
 */
export async function handleCrmWorkspaceRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const query = queryOf(event);
  // Same actor rule as the existing sponsor CRM routes: explicit identity, else
  // the workspace default. Writer endpoints 401 when neither resolves.

  if (path === '/api/sponsor-crm/directory/companies') {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    const result = await listCompanies(client, query);
    return json(result.status, result.body);
  }
  if (path === '/api/sponsor-crm/directory/people') {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    const result = await listPeople(client, query);
    return json(result.status, result.body);
  }

  const viewMatch = path.match(/^\/api\/sponsor-crm\/views(?:\/([^/]+))?$/);
  if (viewMatch) {
    const id = viewMatch[1];
    const user = actor(event) || (await resolveDefaultAssigneeId(client)) || '';
    if (!user) return json(401, { error: 'Unauthorized' });
    if (!id && method === 'GET') {
      const result = await listViews(client, user, query);
      return json(result.status, result.body);
    }
    if (!id && method === 'POST') {
      const body = parse(event);
      if (!body) return json(400, { error: 'Invalid JSON' });
      const result = await createView(client, user, body);
      return json(result.status, result.body);
    }
    if (id && !ID.test(id)) return json(400, { error: 'Invalid ID' });
    if (id && method === 'PUT') {
      const body = parse(event);
      if (!body) return json(400, { error: 'Invalid JSON' });
      const result = await updateView(client, user, id, body);
      return json(result.status, result.body);
    }
    if (id && method === 'DELETE') {
      const result = await archiveView(client, user, id);
      return json(result.status, result.body);
    }
    return json(405, { error: 'Method not allowed' });
  }

  const activityMatch = path.match(/^\/api\/sponsor-crm\/activity\/(organization|contact|deal)\/([^/]+)$/);
  if (activityMatch) {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    if (!ID.test(activityMatch[2])) return json(400, { error: 'Invalid ID' });
    const result = await readActivity(client, activityMatch[1] as ActivityTarget, activityMatch[2], query);
    return json(result.status, result.body);
  }

  const notesMatch = path.match(/^\/api\/sponsor-crm\/notes\/(organization|contact|deal)\/([^/]+)$/);
  if (notesMatch) {
    if (!ID.test(notesMatch[2])) return json(400, { error: 'Invalid ID' });
    const target = notesMatch[1] as NoteTarget;
    if (method === 'GET') {
      const result = await listNotes(client, target, notesMatch[2], query);
      return json(result.status, result.body);
    }
    if (method === 'POST') {
      const user = actor(event) || (await resolveDefaultAssigneeId(client)) || '';
      if (!user) return json(401, { error: 'Unauthorized' });
      const body = parse(event);
      if (!body) return json(400, { error: 'Invalid JSON' });
      const result = await createNote(client, user, target, notesMatch[2], body);
      return json(result.status, result.body);
    }
    return json(405, { error: 'Method not allowed' });
  }

  return null;
}
