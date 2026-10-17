import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listCrmRecords, type CrmRecord } from '../db/sponsorCrm';
import { dealMoneyFacts } from '../sponsorFinance/ledger';
import { deriveMoney, realDate, relationshipTag } from '../sponsorCrm/model';
import { lastTouchOf } from '../sponsorCrm/coldContacts';
import { berlinToday } from './berlin';
import { cursorBinding, decodeCursor, encodeCursor, pageLimit } from './cursor';

export const DIRECTORY_RELATIONSHIPS = ['customer', 'talking', 'dormant', 'prospect'] as const;

type CompanyFilters = {
  search?: string;
  relationship?: string;
  active: 'true' | 'false' | 'all';
  lastTouchAfter?: string;
  lastTouchBefore?: string;
  sort: 'name' | 'lastTouch';
};

type PersonFilters = {
  search?: string;
  company?: string;
  primary?: 'true' | 'false';
  unlinked?: 'true' | 'false';
  active: 'true' | 'false' | 'all';
  sort: 'name' | 'lastTouch';
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
  return {
    filters: {
      ...(query.search ? { search: query.search } : {}),
      ...(query.relationship ? { relationship: query.relationship } : {}),
      active,
      ...(after.day ? { lastTouchAfter: after.day } : {}),
      ...(before.day ? { lastTouchBefore: before.day } : {}),
      sort,
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
  return {
    filters: {
      ...(query.search ? { search: query.search } : {}),
      ...(query.company ? { company: query.company } : {}),
      ...(query.primary ? { primary: query.primary as 'true' | 'false' } : {}),
      ...(query.unlinked ? { unlinked: query.unlinked as 'true' | 'false' } : {}),
      active,
      sort,
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
  const binding = cursorBinding(['companies', filters]);
  let offset = 0;
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(binding, query.cursor);
    if ('error' in cursor) return { status: 400, body: { error: cursor.error } };
    offset = cursor.offset;
  }

  const [organizations, contacts, deals, deliverables] = await Promise.all([
    listCrmRecords(client, 'organization'),
    listCrmRecords(client, 'contact'),
    listCrmRecords(client, 'deal'),
    listCrmRecords(client, 'deliverable'),
  ]);
  const facts = await dealMoneyFacts(client, today.today, { organizations, deals, deliverables });
  const dealsByOrg = new Map<string, CrmRecord[]>();
  for (const deal of deals) {
    const orgId = String(deal.organizationId || '');
    dealsByOrg.set(orgId, [...(dealsByOrg.get(orgId) || []), { ...deal, money: deriveMoney(facts.get(deal.id)) }]);
  }
  const primaryByOrg = new Map<string, CrmRecord>();
  for (const contact of contacts) {
    if (contact.primary && contact.organizationId && !primaryByOrg.has(String(contact.organizationId))) {
      primaryByOrg.set(String(contact.organizationId), contact);
    }
  }

  const q = (filters.search || '').toLowerCase();
  let items: CompanyItem[] = [];
  for (const org of organizations) {
    if (filters.active !== 'all' && activeOf(org) !== (filters.active === 'true')) continue;
    if (q && ![org.displayName, org.domain].some((value) => String(value || '').toLowerCase().includes(q))) continue;
    const orgDeals = dealsByOrg.get(org.id) || [];
    const relationship = relationshipTag(org, orgDeals, today.today);
    if (filters.relationship && relationship !== filters.relationship) continue;
    if (!passesTouchWindow(touchDay(org), filters)) continue;
    const primary = primaryByOrg.get(org.id);
    items.push({
      id: org.id,
      displayName: String(org.displayName || ''),
      ...(org.domain ? { domain: String(org.domain) } : {}),
      relationship,
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
    });
  }
  items.sort((a, b) =>
    filters.sort === 'name'
      ? a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
      : String(b.lastTouch || '').localeCompare(String(a.lastTouch || '')) || a.id.localeCompare(b.id),
  );
  const total = items.length;
  const slice = items.slice(offset, offset + limit.limit);
  return {
    status: 200,
    body: {
      items: slice,
      total,
      nextCursor: offset + limit.limit < total ? encodeCursor(binding, offset + limit.limit) : null,
    },
  };
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
  let items: PersonItem[] = [];
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
      lastTouch: lastTouchOf(contact),
      ...(typeof contact.lastInboundAt === 'string' ? { lastInboundAt: contact.lastInboundAt } : {}),
      ...(typeof contact.lastOutboundAt === 'string' ? { lastOutboundAt: contact.lastOutboundAt } : {}),
      ...(typeof contact.lastContactedAt === 'string' ? { lastContactedAt: contact.lastContactedAt } : {}),
      active: activeOf(contact),
      version: contact.version,
      updatedAt: String(contact.updatedAt),
    });
  }
  items.sort((a, b) =>
    filters.sort === 'name'
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
      : String(b.lastTouch || '').localeCompare(String(a.lastTouch || '')) || a.id.localeCompare(b.id),
  );
  const total = items.length;
  const slice = items.slice(offset, offset + limit.limit);
  return {
    status: 200,
    body: {
      items: slice,
      total,
      nextCursor: offset + limit.limit < total ? encodeCursor(binding, offset + limit.limit) : null,
    },
  };
}
