import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { deterministicCrmId } from '../db/sponsorCrm';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { collectBoundedPages } from '../db/boundedPagination';
import { realDate } from '../sponsorCrm/model';
import { DIRECTORY_RELATIONSHIPS } from './directory';
import { clean, workspaceErrorOf } from './reads';

export const VIEW_ENTITIES = ['companies', 'people', 'pipeline'] as const;
export type ViewEntity = (typeof VIEW_ENTITIES)[number];

/**
 * A-owned pipeline enums, confirmed against the live route at 7fdcda84
 * (`validateList` + view/stage/sort checks in `routes/sponsorCrm.ts`): stored
 * verbatim, interpreted by A. No translator alias.
 */
const PIPELINE_VIEWS = ['actionable', 'active', 'closed', 'all', 'unscheduled'] as const;
const PIPELINE_STAGES = ['open', 'agreed', 'invoiced', 'running', 'closed', 'lost'] as const;
const PIPELINE_SORTS = ['next-action', 'recent'] as const;

/**
 * Views live under an owner-keyed PK so a list reads exactly one owner's rows:
 * PK `SAVEDVIEW#<ownerId>`, SK `<viewId>`. No whole-table SAVEDVIEW scan exists
 * on any path; personal sets are bounded (200) and fail loudly past the bound.
 */
const MAX_PERSONAL_VIEWS = 200;
const viewPk = (ownerId: string) => `SAVEDVIEW#${ownerId}`;

type RelativeDay = { daysAgo: number };
type Filters = Record<string, unknown>;
type StoredView = Record<string, unknown> & { id: string; version: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]))
      : item,
  );

function relativeDay(value: unknown): RelativeDay | null {
  if (!isRecord(value)) return null;
  if (!Number.isInteger(value.daysAgo) || (value.daysAgo as number) < 1 || (value.daysAgo as number) > 730) return null;
  if (Object.keys(value).length !== 1) return null;
  return { daysAgo: value.daysAgo as number };
}

function absoluteOrRelative(value: unknown): boolean {
  if (typeof value === 'string') return realDate(value);
  return relativeDay(value) !== null;
}

function validateCompanyFilters(filters: Filters): string {
  const allowed = ['search', 'relationship', 'active', 'lastTouchAfter', 'lastTouchBefore'];
  for (const key of Object.keys(filters)) if (!allowed.includes(key)) return `Unknown companies filter: ${key}`;
  if (filters.search !== undefined && (typeof filters.search !== 'string' || !filters.search || filters.search.length > 200)) {
    return 'Invalid search filter';
  }
  if (filters.relationship !== undefined && !(DIRECTORY_RELATIONSHIPS as readonly string[]).includes(String(filters.relationship))) {
    return 'Invalid relationship filter';
  }
  if (filters.active !== undefined && !['true', 'false', 'all'].includes(String(filters.active))) {
    return 'Invalid active filter';
  }
  for (const name of ['lastTouchAfter', 'lastTouchBefore'] as const) {
    if (filters[name] !== undefined && !absoluteOrRelative(filters[name])) {
      return `Invalid ${name} filter: YYYY-MM-DD or {daysAgo: 1..730}`;
    }
  }
  return '';
}

function validatePeopleFilters(filters: Filters): string {
  const allowed = ['search', 'company', 'primary', 'unlinked', 'active'];
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  for (const key of Object.keys(filters)) if (!allowed.includes(key)) return `Unknown people filter: ${key}`;
  if (filters.search !== undefined && (typeof filters.search !== 'string' || !filters.search || filters.search.length > 200)) {
    return 'Invalid search filter';
  }
  if (filters.company !== undefined && (typeof filters.company !== 'string' || !ID.test(filters.company))) {
    return 'Invalid company filter';
  }
  for (const name of ['primary', 'unlinked', 'active'] as const) {
    if (name === 'active') {
      if (filters[name] !== undefined && !['true', 'false', 'all'].includes(String(filters[name]))) return 'Invalid active filter';
    } else if (filters[name] !== undefined && !['true', 'false'].includes(String(filters[name]))) {
      return `Invalid ${name} filter`;
    }
  }
  return '';
}

function validatePipelineFilters(filters: Filters): string {
  const allowed = ['view', 'stage', 'search', 'organizationId', 'owner'];
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  for (const key of Object.keys(filters)) if (!allowed.includes(key)) return `Unknown pipeline filter: ${key}`;
  if (filters.view !== undefined && !(PIPELINE_VIEWS as readonly string[]).includes(String(filters.view))) {
    return 'view must be actionable, active, closed, all or unscheduled';
  }
  if (filters.stage !== undefined && !(PIPELINE_STAGES as readonly string[]).includes(String(filters.stage))) {
    return 'stage must be open, agreed, invoiced, running, closed or lost';
  }
  if (filters.search !== undefined && (typeof filters.search !== 'string' || !filters.search || filters.search.length > 200)) {
    return 'Invalid search filter';
  }
  if (filters.organizationId !== undefined && (typeof filters.organizationId !== 'string' || !ID.test(filters.organizationId))) {
    return 'Invalid organizationId filter';
  }
  if (filters.owner !== undefined && (typeof filters.owner !== 'string' || !filters.owner || filters.owner.length > 200)) {
    return 'Invalid owner filter';
  }
  return '';
}

function validateSort(entity: ViewEntity, sort: unknown): string {
  if (!isRecord(sort) || typeof sort.field !== 'string') return 'sort must be {field, direction?}';
  if (entity === 'pipeline') {
    if (!(PIPELINE_SORTS as readonly string[]).includes(sort.field)) return 'pipeline sort must be next-action or recent';
    if (Object.keys(sort).length !== 1) return 'pipeline sort takes no direction';
    return '';
  }
  if (sort.field !== 'name' && sort.field !== 'lastTouch') return 'sort field must be name or lastTouch';
  if (sort.direction !== 'asc' && sort.direction !== 'desc') return 'sort direction must be asc or desc';
  if (Object.keys(sort).length !== 2) return 'Invalid sort';
  return '';
}

export function validateViewInput(body: Record<string, unknown>): string {
  if (!VIEW_ENTITIES.includes(body.entity as ViewEntity)) return 'entity must be companies, people or pipeline';
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) return 'name must be 1..120 characters';
  if (!isRecord(body.filters)) return 'filters must be an object';
  const entity = body.entity as ViewEntity;
  const error =
    entity === 'companies' ? validateCompanyFilters(body.filters)
    : entity === 'people' ? validatePeopleFilters(body.filters)
    : validatePipelineFilters(body.filters);
  if (error) return error;
  if (body.sort !== undefined) {
    const sortError = validateSort(entity, body.sort);
    if (sortError) return sortError;
  }
  if (body.columns !== undefined) {
    if (!Array.isArray(body.columns) || body.columns.length > 20 || body.columns.some((c) => typeof c !== 'string' || !c || c.length > 60)) {
      return 'columns must be up to 20 strings of up to 60 characters';
    }
  }
  if (body.sourceKey !== undefined && (typeof body.sourceKey !== 'string' || !body.sourceKey)) return 'Invalid sourceKey';
  return '';
}

type Builtin = { id: string; entity: ViewEntity; name: string; filters: Filters; sort?: Record<string, string> };

const BUILTINS: Builtin[] = [
  { id: 'builtin:companies:active', entity: 'companies', name: 'Active', filters: { active: 'true' }, sort: { field: 'name', direction: 'asc' } },
  { id: 'builtin:companies:all', entity: 'companies', name: 'All', filters: { active: 'all' }, sort: { field: 'name', direction: 'asc' } },
  { id: 'builtin:companies:recent', entity: 'companies', name: 'Recently contacted', filters: { active: 'true', lastTouchAfter: { daysAgo: 30 } }, sort: { field: 'lastTouch', direction: 'desc' } },
  { id: 'builtin:companies:stale', entity: 'companies', name: 'No recent contact', filters: { active: 'true', lastTouchBefore: { daysAgo: 30 } }, sort: { field: 'lastTouch', direction: 'desc' } },
  { id: 'builtin:companies:archived', entity: 'companies', name: 'Archived', filters: { active: 'false' }, sort: { field: 'name', direction: 'asc' } },
  { id: 'builtin:people:active', entity: 'people', name: 'Active', filters: { active: 'true' }, sort: { field: 'name', direction: 'asc' } },
  { id: 'builtin:people:all', entity: 'people', name: 'All', filters: { active: 'all' }, sort: { field: 'name', direction: 'asc' } },
  { id: 'builtin:people:primary', entity: 'people', name: 'Primary only', filters: { active: 'true', primary: 'true' }, sort: { field: 'name', direction: 'asc' } },
  { id: 'builtin:people:unlinked', entity: 'people', name: 'Unlinked', filters: { active: 'true', unlinked: 'true' }, sort: { field: 'name', direction: 'asc' } },
  { id: 'builtin:people:archived', entity: 'people', name: 'Archived', filters: { active: 'false' }, sort: { field: 'name', direction: 'asc' } },
  { id: 'builtin:pipeline:attention', entity: 'pipeline', name: 'Needs attention', filters: { view: 'actionable' }, sort: { field: 'next-action' } },
  { id: 'builtin:pipeline:active', entity: 'pipeline', name: 'Active', filters: { view: 'active' }, sort: { field: 'next-action' } },
  { id: 'builtin:pipeline:unscheduled', entity: 'pipeline', name: 'Unscheduled', filters: { view: 'unscheduled' }, sort: { field: 'next-action' } },
  { id: 'builtin:pipeline:closed', entity: 'pipeline', name: 'Closed', filters: { view: 'closed' }, sort: { field: 'recent' } },
  { id: 'builtin:pipeline:all', entity: 'pipeline', name: 'All', filters: { view: 'all' }, sort: { field: 'next-action' } },
];

const publicBuiltin = (view: Builtin) => ({ ...view, builtin: true });

const publicView = (view: StoredView) => ({
  id: view.id,
  builtin: false,
  entity: view.entity,
  name: view.name,
  filters: view.filters,
  ...(view.sort ? { sort: view.sort } : {}),
  ...(view.columns ? { columns: view.columns } : {}),
  version: view.version,
  updatedAt: view.updatedAt,
  ...(view.archivedAt ? { archivedAt: view.archivedAt } : {}),
});

async function queryPersonalViews(client: DynamoDBDocumentClient, ownerId: string): Promise<StoredView[]> {
  const raw = await collectBoundedPages<Record<string, unknown>>({
    limits: { maxPages: 5, maxItems: MAX_PERSONAL_VIEWS, maxBytes: 1024 * 1024, deadlineMs: 10_000 },
    loadPage: async (ExclusiveStartKey, abortSignal) =>
      client.send(
        new QueryCommand({
          TableName: TABLE_SPONSOR_CRM,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': viewPk(ownerId) },
          ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
        }),
        { abortSignal },
      ),
  });
  return raw.map(clean) as StoredView[];
}

async function getView(client: DynamoDBDocumentClient, ownerId: string, id: string): Promise<StoredView | null> {
  const result = await client.send(
    new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: viewPk(ownerId), SK: id } }),
  );
  return (result.Item ? clean(result.Item as Record<string, unknown>) : null) as StoredView | null;
}

export async function listViews(
  client: DynamoDBDocumentClient,
  ownerId: string,
  query: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  if (query.entity !== undefined && !VIEW_ENTITIES.includes(query.entity as ViewEntity)) {
    return { status: 400, body: { error: 'entity must be companies, people or pipeline' } };
  }
  if (query.includeArchived !== undefined && query.includeArchived !== 'true' && query.includeArchived !== 'false') {
    return { status: 400, body: { error: 'includeArchived must be true or false' } };
  }
  const entity = query.entity as ViewEntity | undefined;
  let personal: StoredView[];
  try {
    personal = await queryPersonalViews(client, ownerId);
  } catch (error) {
    const err = workspaceErrorOf(error, 'saved views');
    return { status: (err as { statusCode?: number }).statusCode || 500, body: { error: err.message, ...('code' in err ? { code: (err as { code?: string }).code } : {}) } };
  }
  const includeArchived = query.includeArchived === 'true';
  const items = [
    ...BUILTINS.filter((view) => !entity || view.entity === entity).map(publicBuiltin),
    ...personal
      .filter((view) => (!entity || view.entity === entity) && (includeArchived || !view.archivedAt))
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)) || a.id.localeCompare(b.id))
      .map(publicView),
  ];
  return { status: 200, body: { items, total: items.length } };
}

export async function createView(
  client: DynamoDBDocumentClient,
  ownerId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const error = validateViewInput(body);
  if (error) return { status: 400, body: { error } };
  const sourceKey = typeof body.sourceKey === 'string' ? body.sourceKey : undefined;
  const id = sourceKey ? deterministicCrmId('savedview', `${ownerId}:${sourceKey}`) : randomUUID();
  const now = new Date().toISOString();
  const item = {
    PK: viewPk(ownerId),
    SK: id,
    id,
    ownerId,
    entity: body.entity,
    name: String(body.name).trim(),
    filters: body.filters,
    ...(body.sort ? { sort: body.sort } : {}),
    ...(body.columns ? { columns: body.columns } : {}),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_SPONSOR_CRM,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );
    return { status: 201, body: publicView(item as StoredView) };
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException' || !sourceKey) {
      return { status: 500, body: { error: 'Could not create view' } };
    }
    const stored = await getView(client, ownerId, id);
    const same =
      stored &&
      stored.ownerId === ownerId &&
      stored.entity === body.entity &&
      canonical(stored.name) === canonical(String(body.name).trim()) &&
      canonical(stored.filters) === canonical(body.filters) &&
      canonical(stored.sort) === canonical(body.sort) &&
      canonical(stored.columns) === canonical(body.columns);
    if (!same) return { status: 409, body: { error: 'Idempotency key already used with different data' } };
    return { status: 200, body: publicView(stored) };
  }
}

export async function updateView(
  client: DynamoDBDocumentClient,
  ownerId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const existing = await getView(client, ownerId, id);
  if (!existing) return { status: 404, body: { error: 'Not found' } };
  if (existing.archivedAt) return { status: 422, body: { error: 'Archived views cannot be updated' } };
  if (body.version !== existing.version) return { status: 409, body: { error: 'View was changed; reload and retry' } };
  if (body.entity !== undefined && body.entity !== existing.entity) {
    return { status: 400, body: { error: 'A view cannot change entity' } };
  }
  const error = validateViewInput({ ...body, entity: existing.entity });
  if (error) return { status: 400, body: { error } };
  // Full replace: omitted optional fields are cleared, not merged.
  const next = {
    ...existing,
    PK: viewPk(ownerId),
    SK: id,
    name: String(body.name).trim(),
    filters: body.filters,
    version: existing.version + 1,
    updatedAt: new Date().toISOString(),
  } as Record<string, unknown>;
  if (body.sort === undefined) delete next.sort;
  else next.sort = body.sort;
  if (body.columns === undefined) delete next.columns;
  else next.columns = body.columns;
  delete next.sourceKey;
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_SPONSOR_CRM,
        Item: next,
        ConditionExpression: '#version = :expected',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expected': existing.version },
      }),
    );
    return { status: 200, body: publicView(next as StoredView) };
  } catch {
    return { status: 409, body: { error: 'Conflicting update; reload and retry' } };
  }
}

export async function archiveView(
  client: DynamoDBDocumentClient,
  ownerId: string,
  id: string,
): Promise<{ status: number; body: unknown }> {
  const existing = await getView(client, ownerId, id);
  if (!existing) return { status: 404, body: { error: 'Not found' } };
  if (existing.archivedAt) return { status: 200, body: publicView(existing) };
  const next = {
    ...existing,
    PK: viewPk(ownerId),
    SK: id,
    archivedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
  };
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_SPONSOR_CRM,
        Item: next,
        ConditionExpression: '#version = :expected',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expected': existing.version },
      }),
    );
    return { status: 200, body: publicView(next as StoredView) };
  } catch {
    return { status: 409, body: { error: 'Conflicting update; reload and retry' } };
  }
}
