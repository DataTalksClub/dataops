import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCrmRecord, listCrmRecords, type CrmRecord } from '../db/sponsorCrm';
import { dealMoneyFacts } from '../sponsorFinance/ledger';
import { deriveMoney, realDate, relationshipTag } from '../sponsorCrm/model';
import { lastTouchOf } from '../sponsorCrm/coldContacts';
import { berlinToday } from './berlin';
import { cursorBinding, decodeCursor, encodeCursor, pageLimit } from './cursor';

export const DIRECTORY_RELATIONSHIPS = ['customer', 'talking', 'dormant', 'prospect'] as const;

export type CompanyFilters = {
  search?: string;
  relationship?: string;
  active: 'true' | 'false' | 'all';
  lastTouchAfter?: string;
  lastTouchBefore?: string;
  sort: 'name' | 'lastTouch';
  direction: 'asc' | 'desc';
};

export type PersonFilters = {
  search?: string;
  company?: string;
  primary?: 'true' | 'false';
  unlinked?: 'true' | 'false';
  active: 'true' | 'false' | 'all';
  sort: 'name' | 'lastTouch';
  direction: 'asc' | 'desc';
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (error: string) => ({ error });

function activeOf(record: CrmRecord): boolean {
  return !record.archivedAt;
}


function emailOf(contact: CrmRecord): string | undefined {
  const emails = Array.isArray(contact.emails) ? contact.emails.map(String) : [];
  return emails[0] || undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function resolveToday(query: Record<string, string | undefined>): { today: string } | { error: string } {
  if (query.today === undefined) return { today: berlinToday() };
  if (!realDate(query.today)) return bad('Invalid today date');
  return { today: query.today };
}

function parseActive(raw: string | undefined): CompanyFilters['active'] | null {
  if (raw === undefined || raw === 'true') return 'true';
  if (raw === 'false' || raw === 'all') return raw;
  return null;
}

function parseDay(raw: string | undefined, name: string): { day?: string } | { error: string } {
  if (raw === undefined) return {};
  if (!realDate(raw)) return bad(`Invalid ${name} date`);
  return { day: raw };
}

function parseDirection(query: Record<string, string | undefined>, sort: 'name' | 'lastTouch'):
  { direction: 'asc' | 'desc' } | { error: string } {
  // Direction executes: a saved view's {field, direction} applies exactly as stored.
  // Defaults preserve history: name/asc, lastTouch/desc.
  const fallback = sort === 'name' ? 'asc' : 'desc';
  const direction = query.direction === undefined ? fallback : query.direction;
  if (direction !== 'asc' && direction !== 'desc') return bad('direction must be asc or desc');
  return { direction };
}

export function parseCompanyFilters(
  query: Record<string, string | undefined>,
): { filters: CompanyFilters } | { error: string } {
  const active = parseActive(query.active);
  if (!active) return bad('active must be true, false or all');
  if (query.relationship !== undefined && !(DIRECTORY_RELATIONSHIPS as readonly string[]).includes(query.relationship)) {
    return bad('relationship must be customer, talking, dormant or prospect');
  }
  const after = parseDay(query.lastTouchAfter, 'lastTouchAfter');
  if ('error' in after) return after;
  const before = parseDay(query.lastTouchBefore, 'lastTouchBefore');
  if ('error' in before) return before;
  const sort = query.sort === undefined ? 'name' : query.sort;
  if (sort !== 'name' && sort !== 'lastTouch') return bad('sort must be name or lastTouch');
  const direction = parseDirection(query, sort);
  if ('error' in direction) return direction;
  return {
    filters: {
      ...(query.search ? { search: query.search } : {}),
      ...(query.relationship ? { relationship: query.relationship } : {}),
      active,
      ...(after.day ? { lastTouchAfter: after.day } : {}),
      ...(before.day ? { lastTouchBefore: before.day } : {}),
      sort,
      direction: direction.direction,
    },
  };
}

export function parsePersonFilters(
  query: Record<string, string | undefined>,
): { filters: PersonFilters } | { error: string } {
  const active = parseActive(query.active);
  if (!active) return bad('active must be true, false or all');
  if (query.company !== undefined && !ID.test(query.company)) return bad('Invalid company filter');
  for (const name of ['primary', 'unlinked'] as const) {
    if (query[name] !== undefined && query[name] !== 'true' && query[name] !== 'false') {
      return bad(`${name} must be true or false`);
    }
  }
  const sort = query.sort === undefined ? 'name' : query.sort;
  if (sort !== 'name' && sort !== 'lastTouch') return bad('sort must be name or lastTouch');
  const direction = parseDirection(query, sort);
  if ('error' in direction) return direction;
  return {
    filters: {
      ...(query.search ? { search: query.search } : {}),
      ...(query.company ? { company: query.company } : {}),
      ...(query.primary ? { primary: query.primary as 'true' | 'false' } : {}),
      ...(query.unlinked ? { unlinked: query.unlinked as 'true' | 'false' } : {}),
      active,
      sort,
      direction: direction.direction,
    },
  };
}

export type CompanyItem = {
  id: string;
  displayName: string;
  domain?: string;
  relationship: string;
  active: boolean;
  primaryPerson: { id: string; name: string; email?: string } | null;
  lastTouch: string | null;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  openDealCount: number;
  version: number;
  updatedAt: string;
};

export type PersonItem = {
  id: string;
  organizationId?: string;
  companyName: string | null;
  name: string;
  emails: string[];
  primary: boolean;
  role?: string;
  linkedin?: string;
  telegram?: string;
  phone?: string;
  lastTouch: string | null;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastContactedAt?: string;
  active: boolean;
  version: number;
  updatedAt: string;
};

function touchDay(record: CrmRecord): string | null {
  const touch = lastTouchOf(record);
  return touch ? touch.slice(0, 10) : null;
}

/** Null last touch is infinitely old: satisfies lastTouchBefore, never lastTouchAfter. */
function passesTouchWindow(day: string | null, filters: { lastTouchAfter?: string; lastTouchBefore?: string }): boolean {
  if (filters.lastTouchAfter && (day === null || day < filters.lastTouchAfter)) return false;
  if (filters.lastTouchBefore && day !== null && day > filters.lastTouchBefore) return false;
  return true;
}

type CompanyContext = {
  dealsByOrg: Map<string, CrmRecord[]>;
  primaryByOrg: Map<string, CrmRecord>;
  today: string;
};

function companyRow(org: CrmRecord, ctx: CompanyContext): CompanyItem {
  const orgDeals = ctx.dealsByOrg.get(org.id) || [];
  const primary = ctx.primaryByOrg.get(org.id);
  return {
    id: org.id,
    displayName: String(org.displayName || ''),
    ...(org.domain ? { domain: String(org.domain) } : {}),
    relationship: relationshipTag(org, orgDeals, ctx.today),
    active: activeOf(org),
    primaryPerson: primary
      ? { id: primary.id, name: String(primary.name || ''), ...(emailOf(primary) ? { email: emailOf(primary)! } : {}) }
      : null,
    lastTouch: lastTouchOf(org),
    ...(typeof org.lastInboundAt === 'string' ? { lastInboundAt: org.lastInboundAt } : {}),
    ...(typeof org.lastOutboundAt === 'string' ? { lastOutboundAt: org.lastOutboundAt } : {}),
    openDealCount: orgDeals.filter((deal) => deal.status === 'open' && !deal.archivedAt).length,
    version: org.version,
    updatedAt: String(org.updatedAt),
  };
}

async function companyContext(
  client: DynamoDBDocumentClient,
  today: string,
): Promise<CompanyContext & { organizations: CrmRecord[] }> {
  const [organizations, contacts, deals, deliverables] = await Promise.all([
    listCrmRecords(client, 'organization'),
    listCrmRecords(client, 'contact'),
    listCrmRecords(client, 'deal'),
    listCrmRecords(client, 'deliverable'),
  ]);
  const facts = await dealMoneyFacts(client, today, { organizations, deals, deliverables });
  const dealsByOrg = new Map<string, CrmRecord[]>();
  for (const deal of deals) {
    const orgId = String(deal.organizationId || '');
    dealsByOrg.set(orgId, [...(dealsByOrg.get(orgId) || []), { ...deal, money: deriveMoney(facts.get(deal.id)) }]);
  }
  return { dealsByOrg, primaryByOrg: primaryIndex(contacts), today, organizations };
}

function primaryIndex(contacts: CrmRecord[]): Map<string, CrmRecord> {
  const primaryByOrg = new Map<string, CrmRecord>();
  for (const contact of contacts) {
    // Defensive: ordinary archive clears primary, but never surface an archived person as primary.
    if (contact.archivedAt) continue;
    if (contact.primary && contact.organizationId && !primaryByOrg.has(String(contact.organizationId))) {
      primaryByOrg.set(String(contact.organizationId), contact);
    }
  }
  return primaryByOrg;
}

function applyCompanyDirection(items: CompanyItem[], filters: CompanyFilters): void {
  items.sort((a, b) => {
    const ascending =
      filters.sort === 'name'
        ? a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
        : String(a.lastTouch || '').localeCompare(String(b.lastTouch || '')) || a.id.localeCompare(b.id);
    return filters.direction === 'desc' ? -ascending : ascending;
  });
}

function pageItems<T>(items: T[], offset: number, limit: number, binding: string) {
  const total = items.length;
  return {
    items: items.slice(offset, offset + limit),
    total,
    nextCursor: offset + limit < total ? encodeCursor(binding, offset + limit) : null,
  };
}

export async function listCompanies(
  client: DynamoDBDocumentClient,
  query: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  const parsed = parseCompanyFilters(query);
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } };
  const { filters } = parsed;
  const today = resolveToday(query);
  if ('error' in today) return { status: 400, body: { error: today.error } };
  const limit = pageLimit(query.limit);
  if ('error' in limit) return { status: 400, body: { error: limit.error } };
  // The cursor binds the effective today: relationship membership depends on it.
  const binding = cursorBinding(['companies', filters, today.today]);
  let offset = 0;
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(binding, query.cursor);
    if ('error' in cursor) return { status: 400, body: { error: cursor.error } };
    offset = cursor.offset;
  }

  const ctx = await companyContext(client, today.today);
  const q = (filters.search || '').toLowerCase();
  const items: CompanyItem[] = [];
  for (const org of ctx.organizations) {
    if (filters.active !== 'all' && activeOf(org) !== (filters.active === 'true')) continue;
    if (q && ![org.displayName, org.domain].some((value) => String(value || '').toLowerCase().includes(q))) continue;
    const row = companyRow(org, ctx);
    if (filters.relationship && row.relationship !== filters.relationship) continue;
    if (!passesTouchWindow(touchDay(org), filters)) continue;
    items.push(row);
  }
  applyCompanyDirection(items, filters);
  return { status: 200, body: pageItems(items, offset, limit.limit, binding) };
}

/**
 * Cheap lazy-record summary: direct Get plus the same snapshot-derived row as
 * the list (no added scans beyond the request's shared snapshot), plus the
 * existing operator notes summary. Never nested deals/finance/mail/contacts.
 */
/**
 * Cheap lazy-record summary: a direct Get plus snapshot-derived contact/deal
 * metadata (primary person, open deal count). It never invokes the finance
 * subsystem, the global ledger, or bookkeeping reads for any caller — monetary
 * and finance-derived facts (notably `relationship`) belong to the lazy Finance
 * tab and the directory context, and are omitted here rather than synthesized.
 */
export type CompanySummary = {
  id: string;
  displayName: string;
  domain?: string;
  active: boolean;
  primaryPerson: { id: string; name: string; email?: string } | null;
  lastTouch: string | null;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  openDealCount: number;
  version: number;
  updatedAt: string;
  notes?: string;
};

export async function getCompanySummary(
  client: DynamoDBDocumentClient,
  id: string,
  query: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  const org = await getCrmRecord(client, 'organization', id);
  if (!org) return { status: 404, body: { error: 'Not found' } };
  const [contacts, deals] = await Promise.all([
    listCrmRecords(client, 'contact'),
    listCrmRecords(client, 'deal'),
  ]);
  const primary = primaryIndex(contacts).get(org.id);
  const openDealCount = deals.filter(
    (deal) => String(deal.organizationId) === id && deal.status === 'open' && !deal.archivedAt,
  ).length;
  const summary: CompanySummary = {
    id: org.id,
    displayName: String(org.displayName || ''),
    ...(org.domain ? { domain: String(org.domain) } : {}),
    active: activeOf(org),
    primaryPerson: primary
      ? { id: primary.id, name: String(primary.name || ''), ...(emailOf(primary) ? { email: emailOf(primary)! } : {}) }
      : null,
    lastTouch: lastTouchOf(org),
    ...(typeof org.lastInboundAt === 'string' ? { lastInboundAt: org.lastInboundAt } : {}),
    ...(typeof org.lastOutboundAt === 'string' ? { lastOutboundAt: org.lastOutboundAt } : {}),
    openDealCount,
    version: org.version,
    updatedAt: String(org.updatedAt),
    ...(typeof org.notes === 'string' && org.notes ? { notes: org.notes } : {}),
  };
  return { status: 200, body: summary };
}

export async function listPeople(
  client: DynamoDBDocumentClient,
  query: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  const parsed = parsePersonFilters(query);
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } };
  const { filters } = parsed;
  const limit = pageLimit(query.limit);
  if ('error' in limit) return { status: 400, body: { error: limit.error } };
  const binding = cursorBinding(['people', filters]);
  let offset = 0;
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(binding, query.cursor);
    if ('error' in cursor) return { status: 400, body: { error: cursor.error } };
    offset = cursor.offset;
  }

  const [organizations, contacts] = await Promise.all([
    listCrmRecords(client, 'organization'),
    listCrmRecords(client, 'contact'),
  ]);
  const orgById = new Map(organizations.map((org) => [org.id, org]));
  const q = (filters.search || '').toLowerCase();
  const items: PersonItem[] = [];
  for (const contact of contacts) {
    if (filters.active !== 'all' && activeOf(contact) !== (filters.active === 'true')) continue;
    if (filters.company && String(contact.organizationId || '') !== filters.company) continue;
    if (filters.primary && String(!!contact.primary) !== filters.primary) continue;
    const org = contact.organizationId ? orgById.get(String(contact.organizationId)) : undefined;
    const linked = !!org;
    if (filters.unlinked === 'true' && linked) continue;
    if (filters.unlinked === 'false' && !linked) continue;
    const companyName = org ? String(org.displayName || '') : null;
    if (
      q &&
      ![contact.name, companyName, ...(Array.isArray(contact.emails) ? contact.emails.map(String) : [])].some((value) =>
        String(value || '').toLowerCase().includes(q),
      )
    ) {
      continue;
    }
    items.push({
      id: contact.id,
      ...(contact.organizationId ? { organizationId: String(contact.organizationId) } : {}),
      companyName,
      name: String(contact.name || ''),
      emails: Array.isArray(contact.emails) ? contact.emails.map(String) : [],
      primary: !!contact.primary,
      ...(optionalText(contact.role) ? { role: optionalText(contact.role)! } : {}),
      ...(optionalText(contact.linkedin) ? { linkedin: optionalText(contact.linkedin)! } : {}),
      ...(optionalText(contact.telegram) ? { telegram: optionalText(contact.telegram)! } : {}),
      // Echoed only when stored, never modified here (A owns contact writes).
      ...(optionalText(contact.phone) ? { phone: optionalText(contact.phone)! } : {}),
      lastTouch: lastTouchOf(contact),
      ...(typeof contact.lastInboundAt === 'string' ? { lastInboundAt: contact.lastInboundAt } : {}),
      ...(typeof contact.lastOutboundAt === 'string' ? { lastOutboundAt: contact.lastOutboundAt } : {}),
      ...(typeof contact.lastContactedAt === 'string' ? { lastContactedAt: contact.lastContactedAt } : {}),
      active: activeOf(contact),
      version: contact.version,
      updatedAt: String(contact.updatedAt),
    });
  }
  items.sort((a, b) => {
    const ascending =
      filters.sort === 'name'
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
        : String(a.lastTouch || '').localeCompare(String(b.lastTouch || '')) || a.id.localeCompare(b.id);
    return filters.direction === 'desc' ? -ascending : ascending;
  });
  return { status: 200, body: pageItems(items, offset, limit.limit, binding) };
}
