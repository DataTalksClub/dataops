import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createCrmRecord,
  getCrmRecord,
  updateCrmRecord,
  type CrmRecord,
} from '../db/sponsorCrm';
import { realDate } from '../sponsorCrm/model';
import { DIRECTORY_RELATIONSHIPS } from './directory';
import { listKindRecords, workspaceErrorOf } from './reads';

export const VIEW_ENTITIES = ['companies', 'people', 'pipeline'] as const;
export type ViewEntity = (typeof VIEW_ENTITIES)[number];

/** A-owned pipeline enums (confirmed 2026-10-17); stored + validated here, interpreted by A. */
const PIPELINE_VIEWS = ['actionable', 'active', 'all', 'closed', 'unscheduled'] as const;
const PIPELINE_STAGES = ['open', 'agreed', 'invoiced', 'running', 'closed', 'lost'] as const;
const PIPELINE_SORTS = ['next', 'recent'] as const;

type RelativeDay = { daysAgo: number };
type Filters = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

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
    return 'view must be actionable, active, all, closed or unscheduled';
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
    if (!(PIPELINE_SORTS as readonly string[]).includes(sort.field)) return 'pipeline sort must be next or recent';
    if (sort.direction !== undefined) return 'pipeline sort takes no direction';
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
  if (body.sourceKey !== undefined && typeof body.sourceKey !== 'string') return 'Invalid sourceKey';
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
  { id: 'builtin:pipeline:attention', entity: 'pipeline', name: 'Needs attention', filters: { view: 'actionable' }, sort: { field: 'next' } },
  { id: 'builtin:pipeline:active', entity: 'pipeline', name: 'Active', filters: { view: 'active' }, sort: { field: 'next' } },
  { id: 'builtin:pipeline:unscheduled', entity: 'pipeline', name: 'Unscheduled', filters: { view: 'unscheduled' }, sort: { field: 'next' } },
  { id: 'builtin:pipeline:closed', entity: 'pipeline', name: 'Closed', filters: { view: 'closed' }, sort: { field: 'recent' } },
  { id: 'builtin:pipeline:all', entity: 'pipeline', name: 'All', filters: { view: 'all' }, sort: { field: 'next' } },
];

const publicBuiltin = (view: Builtin) => ({ ...view, builtin: true });

const publicView = (view: CrmRecord) => ({
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

async function personalViews(client: DynamoDBDocumentClient, ownerId: string) {
  const { items } = await listKindRecords(client, 'savedview', 'saved views');
  return items.filter((item) => item.ownerId === ownerId);
}

export async function listViews(
  client: DynamoDBDocumentClient,
  ownerId: string,
  query: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  if (query.entity !== undefined && !VIEW_ENTITIES.includes(query.entity as ViewEntity)) {
    return { status: 400, body: { error: 'entity must be companies, people or pipeline' } };
  }
  const entity = query.entity as ViewEntity | undefined;
  let personal: CrmRecord[];
  try {
    personal = (await personalViews(client, ownerId)) as CrmRecord[];
  } catch (error) {
    const err = workspaceErrorOf(error, 'saved views');
    return { status: (err as { statusCode?: number }).statusCode || 500, body: { error: err.message, ...( 'code' in err ? { code: (err as { code?: string }).code } : {}) } };
  }
  const includeArchived = query.includeArchived === 'true';
  if (query.includeArchived !== undefined && query.includeArchived !== 'true' && query.includeArchived !== 'false') {
    return { status: 400, body: { error: 'includeArchived must be true or false' } };
  }
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
  const value = {
    ownerId,
    entity: body.entity,
    name: String(body.name).trim(),
    filters: body.filters,
    ...(body.sort ? { sort: body.sort } : {}),
    ...(body.columns ? { columns: body.columns } : {}),
    ...(typeof body.sourceKey === 'string' ? { sourceKey: body.sourceKey } : {}),
  };
  try {
    const created = await createCrmRecord(client, 'savedview', value);
    return { status: created.duplicate ? 200 : 201, body: publicView(created.item) };
  } catch (err) {
    const conflict = (err as Error).name.includes('Conditional') || (err as { statusCode?: number }).statusCode === 409;
    return {
      status: (err as { statusCode?: number }).statusCode || (conflict ? 409 : 500),
      body: { error: (err as Error).message },
    };
  }
}

async function ownedView(client: DynamoDBDocumentClient, ownerId: string, id: string) {
  const existing = await getCrmRecord(client, 'savedview', id);
  if (!existing || existing.ownerId !== ownerId) return null;
  return existing;
}

export async function updateView(
  client: DynamoDBDocumentClient,
  ownerId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const existing = await ownedView(client, ownerId, id);
  if (!existing) return { status: 404, body: { error: 'Not found' } };
  if (existing.archivedAt) return { status: 422, body: { error: 'Archived views cannot be updated' } };
  if (body.version !== existing.version) return { status: 409, body: { error: 'View was changed; reload and retry' } };
  if (body.entity !== undefined && body.entity !== existing.entity) {
    return { status: 400, body: { error: 'A view cannot change entity' } };
  }
  const error = validateViewInput({ ...body, entity: existing.entity });
  if (error) return { status: 400, body: { error } };
  // Full replace: omitted optional fields are cleared, not merged from the old view.
  const next = {
    name: String(body.name).trim(),
    filters: body.filters,
    sort: body.sort,
    columns: body.columns,
  };
  try {
    return { status: 200, body: publicView(await updateCrmRecord(client, 'savedview', existing, next)) };
  } catch {
    return { status: 409, body: { error: 'Conflicting update; reload and retry' } };
  }
}

export async function archiveView(
  client: DynamoDBDocumentClient,
  ownerId: string,
  id: string,
): Promise<{ status: number; body: unknown }> {
  const existing = await ownedView(client, ownerId, id);
  if (!existing) return { status: 404, body: { error: 'Not found' } };
  if (existing.archivedAt) return { status: 200, body: publicView(existing) };
  try {
    const archived = await updateCrmRecord(client, 'savedview', existing, {
      archivedAt: new Date().toISOString(),
    });
    return { status: 200, body: publicView(archived) };
  } catch {
    return { status: 409, body: { error: 'Conflicting update; reload and retry' } };
  }
}
