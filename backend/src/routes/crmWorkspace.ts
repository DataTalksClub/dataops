import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { resolveDefaultAssigneeId } from '../db/workspaceSettings';
import { listCompanies, listPeople, getCompanySummary, resolveToday } from '../crmWorkspace/directory';
import { archiveView, createView, getViewOne, listViews, resolveView, updateView } from '../crmWorkspace/views';
import { workspaceErrorOf } from '../crmWorkspace/reads';
import { createNote, listNotes, type NoteTarget } from '../crmWorkspace/notes';
import { readActivity, type ActivityTarget } from '../crmWorkspace/activity';

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Path captures arrive percent-encoded (the CLI encodes ids); decode before ID checks. */
function pathId(raw: string): { id: string } | { error: string } {
  try {
    const id = decodeURIComponent(raw);
    if (!ID.test(id)) return { error: 'Invalid ID' };
    return { id };
  } catch {
    return { error: 'Invalid ID' };
  }
}

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

  // Execute a saved view: base filters = the view's server-resolved filters,
  // explicit query params win (copied links stay meaningful via effective params).
  async function withSavedView(
    entity: 'companies' | 'people',
    base: Record<string, string | undefined>,
  ): Promise<{ query: Record<string, string | undefined> } | { status: number; body: unknown }> {
    if (!base.view) return { query: base };
    const today = resolveToday(base);
    if ('error' in today) return { status: 400, body: { error: today.error } };
    const user = actor(event) || (await resolveDefaultAssigneeId(client)) || '';
    if (!user) return { status: 401, body: { error: 'Unauthorized' } };
    let resolved: Awaited<ReturnType<typeof resolveView>>;
    try {
      resolved = await resolveView(client, user, base.view, today.today);
    } catch (error) {
      const err = workspaceErrorOf(error, 'saved views');
      return { status: (err as { statusCode?: number }).statusCode || 500, body: { error: err.message, ...('code' in err ? { code: (err as { code?: string }).code } : {}) } };
    }
    if (!resolved) return { status: 404, body: { error: 'View not found' } };
    if ('archived' in resolved) return { status: 422, body: { error: 'View is archived' } };
    if (resolved.entity !== entity) return { status: 400, body: { error: 'View entity mismatch' } };
    const stored = (resolved.view.resolvedFilters || {}) as Record<string, unknown>;
    const baseFilters = Object.fromEntries(
      Object.entries(stored).map(([key, value]) => [key, String(value)]),
    );
    const { view, cursor, sort, direction, ...explicit } = base;
    void view;
    const viewSort = (resolved.view.sort || {}) as Record<string, string>;
    return {
      query: {
        ...baseFilters,
        ...(viewSort.field ? { sort: viewSort.field } : {}),
        ...(viewSort.direction ? { direction: viewSort.direction } : {}),
        ...explicit,
        ...(sort ? { sort } : {}),
        ...(direction ? { direction } : {}),
        ...(cursor ? { cursor } : {}),
      },
    };
  }

  const companyDir = path.match(/^\/api\/sponsor-crm\/directory\/companies(?:\/([^/]+))?$/);
  if (companyDir) {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    if (companyDir[1]) {
      const decoded = pathId(companyDir[1]);
      if ('error' in decoded) return json(400, { error: decoded.error });
      try {
        const result = await getCompanySummary(client, decoded.id, query);
        return json(result.status, result.body);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode) {
          const err = error as { message: string; code?: string; source?: string };
          return json(statusCode, { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.source ? { source: err.source } : {}) });
        }
        throw error;
      }
    }
    const applied = await withSavedView('companies', query);
    if ('status' in applied) return json(applied.status, applied.body);
    const result = await listCompanies(client, applied.query);
    return json(result.status, result.body);
  }
  if (path === '/api/sponsor-crm/directory/people') {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    const applied = await withSavedView('people', query);
    if ('status' in applied) return json(applied.status, applied.body);
    const result = await listPeople(client, applied.query);
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
    if (id) {
      const decoded = pathId(id);
      if ('error' in decoded) return json(400, { error: decoded.error });
      const viewId = decoded.id;
      if (method === 'GET') {
        const result = await getViewOne(client, user, viewId, query);
        return json(result.status, result.body);
      }
      if (method === 'PUT') {
        const body = parse(event);
        if (!body) return json(400, { error: 'Invalid JSON' });
        const result = await updateView(client, user, viewId, body);
        return json(result.status, result.body);
      }
      if (method === 'DELETE') {
        const result = await archiveView(client, user, viewId);
        return json(result.status, result.body);
      }
      return json(405, { error: 'Method not allowed' });
    }
    return json(405, { error: 'Method not allowed' });
  }

  const activityMatch = path.match(/^\/api\/sponsor-crm\/activity\/(organization|contact|deal)\/([^/]+)$/);
  if (activityMatch) {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    const decoded = pathId(activityMatch[2]);
    if ('error' in decoded) return json(400, { error: decoded.error });
    const result = await readActivity(client, activityMatch[1] as ActivityTarget, decoded.id, query);
    return json(result.status, result.body);
  }

  const notesMatch = path.match(/^\/api\/sponsor-crm\/notes\/(organization|contact|deal)\/([^/]+)$/);
  if (notesMatch) {
    const decoded = pathId(notesMatch[2]);
    if ('error' in decoded) return json(400, { error: decoded.error });
    const target = notesMatch[1] as NoteTarget;
    const targetId = decoded.id;
    if (method === 'GET') {
      const result = await listNotes(client, target, targetId, query);
      return json(result.status, result.body);
    }
    if (method === 'POST') {
      const user = actor(event) || (await resolveDefaultAssigneeId(client)) || '';
      if (!user) return json(401, { error: 'Unauthorized' });
      const body = parse(event);
      if (!body) return json(400, { error: 'Invalid JSON' });
      const result = await createNote(client, user, target, targetId, body);
      return json(result.status, result.body);
    }
    return json(405, { error: 'Method not allowed' });
  }

  return null;
}
