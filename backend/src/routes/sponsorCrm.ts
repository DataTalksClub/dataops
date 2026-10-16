import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse, Task } from '../types';
import {
  createContactAtomic,
  createCrmRecord,
  createDealAtomic,
  createDeliverableAtomic,
  createOrganizationAtomic,
  getCrmRecord,
  listBookingHistory,
  listCrmRecords,
  updateContactAtomic,
  updateCrmRecord,
  updateDealAtomic,
  updateDeliverableAtomic,
  updateOrganizationAtomic,
  type CrmRecord,
} from '../db/sponsorCrm';
import { listOpenDealTasks } from '../db/taskSubjects';
import { resolveDefaultAssigneeId } from '../db/workspaceSettings';
import { importCrmSnapshot } from '../sponsorCrm/importSnapshot';
import { dealMoneyFacts } from '../sponsorFinance/ledger';
import {
  CHANNELS,
  DEAL_STATUSES,
  LOST_REASONS,
  PRODUCT_KINDS,
  type DealMoneyFacts,
  deriveFulfillment,
  deriveMoney,
  realDate,
  registrableDomain,
  relationshipTag,
} from '../sponsorCrm/model';

const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const parse = (event: LambdaEvent) => { try { return event.body ? JSON.parse(String(event.body)) as Record<string, unknown> : null; } catch { return null; } };
const actor = (event: LambdaEvent) => Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'x-user-id')?.[1] || '';
const text = (value: unknown, max = 500) => typeof value === 'string' && value.trim() && value.length <= max;
const page = (items: unknown[], event: LambdaEvent) => {
  const query = event.queryStringParameters || {}, limit = Number(query.limit || 50), cursor = Number(query.cursor || 0);
  const sliced = items.slice(cursor, cursor + limit);
  return { items: sliced, nextCursor: cursor + limit < items.length ? String(cursor + limit) : null };
};
const todayOf = (event: LambdaEvent) => {
  const query = event.queryStringParameters || {};
  return realDate(query.today) ? String(query.today) : new Date().toISOString().slice(0, 10);
};

function validateList(event: LambdaEvent) {
  const query = event.queryStringParameters || {}, limit = Number(query.limit || 50), cursor = Number(query.cursor || 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(cursor) || cursor < 0) return 'Invalid pagination';
  if (query.from && !realDate(query.from)) return 'Invalid from date';
  if (query.to && !realDate(query.to)) return 'Invalid to date';
  if (query.from && query.to && query.from > query.to) return 'Invalid date range';
  if (query.organizationId && !ID.test(query.organizationId)) return 'Invalid organizationId filter';
  if (query.dealId && !ID.test(query.dealId)) return 'Invalid dealId filter';
  if (query.active && !['true', 'false'].includes(query.active)) return 'Invalid active filter';
  if (query.status && !DEAL_STATUSES.has(query.status)) return 'Invalid status filter';
  return '';
}

function validateOrganization(body: Record<string, unknown>, partial = false) {
  if ((!partial && !text(body.displayName, 200)) || (body.displayName !== undefined && !text(body.displayName, 200))) return 'Invalid organization fields';
  if (body.notes !== undefined && typeof body.notes !== 'string') return 'Invalid organization fields';
  if (body.domain !== undefined && body.domain !== '' && !registrableDomain(String(body.domain))) return 'Invalid domain';
  if (body.lastOutboundAt !== undefined && body.lastOutboundAt !== null && !realDate(String(body.lastOutboundAt).slice(0, 10)) && typeof body.lastOutboundAt !== 'string') return 'Invalid lastOutboundAt';
  return '';
}

function validateContact(body: Record<string, unknown>, partial = false) {
  if ((!partial && (!ID.test(String(body.organizationId || '')) || !text(body.name, 200))) || (body.name !== undefined && !text(body.name, 200))) return 'Invalid contact fields';
  if (body.emails !== undefined && (!Array.isArray(body.emails) || body.emails.length < 1 || body.emails.length > 10 || body.emails.some((email) => typeof email !== 'string' || !EMAIL.test(email) || email.length > 254))) return 'Invalid contact channels';
  return '';
}

function validateDeal(body: Record<string, unknown>, partial = false, existing?: CrmRecord) {
  if (!partial && !ID.test(String(body.organizationId || ''))) return 'Invalid organizationId';
  const status = String((body.status ?? existing?.status) || '');
  if ((!partial || body.status !== undefined) && !DEAL_STATUSES.has(status)) return 'Invalid status';
  if (body.productKind !== undefined && !PRODUCT_KINDS.has(String(body.productKind))) return 'Invalid productKind';
  if (body.title !== undefined && body.title !== '' && !text(body.title, 200)) return 'Invalid title';
  if (body.lostReason !== undefined && !LOST_REASONS.has(String(body.lostReason))) return 'Invalid lostReason';
  if (body.amountEur !== undefined && (typeof body.amountEur !== 'number' || !Number.isFinite(body.amountEur))) return 'Invalid amountEur';
  if (body.agreementDate != null && !realDate(body.agreementDate)) return 'Invalid agreementDate';
  if (body.primaryContactId != null && !ID.test(String(body.primaryContactId))) return 'Invalid primaryContactId';
  return '';
}

function validateDeliverable(body: Record<string, unknown>, partial = false) {
  if (!partial && !ID.test(String(body.dealId || ''))) return 'Invalid dealId';
  if ((!partial || body.channel !== undefined) && !CHANNELS.has(String(body.channel))) return 'Invalid channel';
  for (const name of ['plannedPublicationDate', 'materialDeadline']) if (body[name] != null && !realDate(body[name])) return `Invalid ${name}`;
  for (const name of ['primaryContactId', 'scheduleEntryId', 'cardId']) if (body[name] != null && !ID.test(String(body[name]))) return `Invalid ${name}`;
  if (body.artifactUrls !== undefined && (!Array.isArray(body.artifactUrls) || body.artifactUrls.length > 20 || body.artifactUrls.some((url) => { try { const parsed = new URL(String(url)); return parsed.protocol !== 'https:'; } catch { return true; } }))) return 'Invalid artifactUrls';
  return '';
}

const safeDeliverableSummary = (deliverable: CrmRecord) => ({
  id: deliverable.id,
  dealId: deliverable.dealId,
  organizationId: deliverable.organizationId,
  channel: deliverable.channel,
  plannedPublicationDate: deliverable.plannedPublicationDate,
  scheduleEntryId: deliverable.scheduleEntryId,
  cardId: deliverable.cardId,
  version: deliverable.version,
  updatedAt: deliverable.updatedAt,
});

function publicDeal(deal: CrmRecord, extras: Record<string, unknown> = {}) {
  const { historyNote, ...record } = deal;
  return { ...record, ...extras };
}

/** A deal's open Tasks, earliest first: what the pipeline shows as next. */
const publicDealTask = (task: Task) => ({
  id: task.id,
  description: task.description,
  date: task.date,
  status: task.status,
  ...(task.assigneeId ? { assigneeId: task.assigneeId } : {}),
});

const publicMoney = (facts: DealMoneyFacts | undefined) => facts ? {
  invoiceState: facts.invoiceState,
  paymentState: facts.paymentState,
  timingState: facts.timingState,
  followUp: facts.followUp,
  ...(facts.amountDue ? { amountDue: facts.amountDue, currency: facts.currency } : {}),
  ...(facts.invoiceNumber ? { invoiceNumber: facts.invoiceNumber } : {}),
  ...(facts.dueOn ? { dueOn: facts.dueOn } : {}),
  ...(facts.outstanding ? { outstanding: facts.outstanding } : {}),
  ...(facts.lastPaymentOn ? { lastPaymentOn: facts.lastPaymentOn } : {}),
} : undefined;

async function decorateDeals(client: DynamoDBDocumentClient, deals: CrmRecord[], today: string) {
  const [organizations, allDeals, deliverables] = await Promise.all([
    listCrmRecords(client, 'organization'),
    listCrmRecords(client, 'deal'),
    listCrmRecords(client, 'deliverable'),
  ]);
  const [facts, tasksByDeal] = await Promise.all([
    dealMoneyFacts(client, today, { organizations, deals: allDeals, deliverables }),
    listOpenDealTasks(client),
  ]);
  return deals.map((deal) => {
    const kids = deliverables.filter((item) => item.dealId === deal.id);
    const money = facts.get(deal.id);
    return publicDeal(deal, {
      money: deriveMoney(money), fulfillment: deriveFulfillment(kids), deliverables: kids,
      openTasks: (tasksByDeal.get(deal.id) || []).map(publicDealTask),
      ...(money ? { finance: publicMoney(money) } : {}),
    });
  });
}

async function organizationMoney(client: DynamoDBDocumentClient, today: string) {
  const [organizations, deals, deliverables] = await Promise.all([
    listCrmRecords(client, 'organization'),
    listCrmRecords(client, 'deal'),
    listCrmRecords(client, 'deliverable'),
  ]);
  const facts = await dealMoneyFacts(client, today, { organizations, deals, deliverables });
  return deals.map((deal): CrmRecord => ({ ...deal, money: deriveMoney(facts.get(deal.id)) }));
}

export async function handleSponsorCrmRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const defaultAssigneeId = await resolveDefaultAssigneeId(client);
  const body = parse(event), user = actor(event) || defaultAssigneeId || '', today = todayOf(event);

  if (path === '/api/sponsor-crm/imports' && method === 'POST') {
    if (!body) return json(400, { error: 'Invalid JSON' });
    try {
      return json(200, await importCrmSnapshot(client, body, user));
    } catch (error) {
      return json((error as { statusCode?: number }).statusCode || 400, { error: (error as Error).message });
    }
  }

  if (path === '/api/sponsor-crm/messages' && method === 'POST') {
    if (!body) return json(400, { error: 'Invalid JSON' });
    const email = typeof body.personEmail === 'string' ? body.personEmail.toLowerCase() : '';
    const domain = registrableDomain(email.split('@')[1] || '');
    if (!EMAIL.test(email) || !['inbound', 'outbound'].includes(String(body.direction)) || typeof body.threadId !== 'string' || !body.threadId.trim()) {
      return json(400, { error: 'Invalid message' });
    }
    const contacts = await listCrmRecords(client, 'contact');
    const organizations = await listCrmRecords(client, 'organization');
    const contact = contacts.find((item) => Array.isArray(item.emails) && item.emails.map((value) => String(value).toLowerCase()).includes(email));
    const organization = contact
      ? await getCrmRecord(client, 'organization', String(contact.organizationId))
      : organizations.find((item) => item.domain && item.domain === domain);
    if (!organization) return json(422, { error: 'Unknown person or company domain' });
    const sentAt = typeof body.sentAt === 'string' ? body.sentAt : new Date().toISOString();
    const stamp = body.direction === 'outbound' ? { lastOutboundAt: sentAt } : { lastInboundAt: sentAt };
    await updateOrganizationAtomic(client, organization, stamp, user, 'mail');
    const created = await createCrmRecord(client, 'message', {
      organizationId: organization.id,
      contactId: contact?.id,
      personEmail: email,
      threadId: body.threadId,
      direction: body.direction,
      snippet: typeof body.snippet === 'string' ? body.snippet.slice(0, 500) : '',
      sentAt,
      dealId: typeof body.dealId === 'string' ? body.dealId : undefined,
      sourceType: 'gmail',
    });
    return json(created.duplicate ? 200 : 201, created.item);
  }

  const orgMessages = path.match(/^\/api\/sponsor-crm\/organizations\/([^/]+)\/messages$/);
  if (orgMessages && method === 'GET') {
    const organization = await getCrmRecord(client, 'organization', orgMessages[1]);
    if (!organization) return json(404, { error: 'Not found' });
    const query = (event.queryStringParameters || {}).q?.toLowerCase() || '';
    let items = (await listCrmRecords(client, 'message')).filter((item) => item.organizationId === organization.id);
    if (query) items = items.filter((item) => String(item.snippet || '').toLowerCase().includes(query) || String(item.threadId || '').toLowerCase().includes(query));
    items.sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')));
    return json(200, { items: items.slice(0, 20), nextCursor: items.length > 20 ? '20' : null });
  }

  const lookupMatch = path.match(/^\/api\/sponsor-crm\/integrations\/newsletter\/deliverables\/([^/]+)$/);
  if (lookupMatch && method === 'GET') {
    const deliverable = await getCrmRecord(client, 'deliverable', lookupMatch[1]);
    return deliverable ? json(200, safeDeliverableSummary(deliverable)) : json(404, { error: 'Not found' });
  }

  const historyMatch = path.match(/^\/api\/sponsor-crm\/deals\/([^/]+)\/history$/);
  if (historyMatch && method === 'GET') return json(200, { items: await listBookingHistory(client, historyMatch[1]) });

  const linkMatch = path.match(/^\/api\/sponsor-crm\/deliverables\/([^/]+)\/schedule-link$/);
  if (linkMatch && (method === 'PUT' || method === 'DELETE')) {
    const existing = await getCrmRecord(client, 'deliverable', linkMatch[1]);
    if (!existing) return json(404, { error: 'Not found' });
    const scheduleEntryId = method === 'DELETE' ? undefined : body?.scheduleEntryId;
    if (scheduleEntryId !== undefined && !ID.test(String(scheduleEntryId))) return json(400, { error: 'Invalid scheduleEntryId' });
    if (body?.version !== existing.version) return json(409, { error: 'Deliverable was changed; reload and retry' });
    try { return json(200, safeDeliverableSummary(await updateDeliverableAtomic(client, existing, { scheduleEntryId }, user))); }
    catch (error) { if ((error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional')) return json(409, { error: 'Schedule entry is already linked' }); throw error; }
  }

  const match = path.match(/^\/api\/sponsor-crm\/(organizations|contacts|deals|deliverables)(?:\/([^/]+))?$/);
  if (!match) return json(404, { error: 'Not found' });
  const plural = match[1], id = match[2];
  const kind = plural === 'deliverables' ? 'deliverable' : plural.slice(0, -1);
  if (id && !ID.test(id)) return json(400, { error: 'Invalid ID' });

  if (method === 'GET' && id) {
    const record = await getCrmRecord(client, kind, id);
    if (!record) return json(404, { error: 'Not found' });
    if (kind === 'deal') return json(200, (await decorateDeals(client, [record], today))[0]);
    if (kind === 'organization') {
      const moneyDeals = (await organizationMoney(client, today)).filter((item) => item.organizationId === record.id);
      return json(200, { ...record, relationship: relationshipTag(record, moneyDeals, today), deals: moneyDeals });
    }
    return json(200, record);
  }

  if (method === 'GET' && !id) {
    const listError = validateList(event);
    if (listError) return json(400, { error: listError });
    let items = await listCrmRecords(client, kind);
    const query = event.queryStringParameters || {};
    if (query.organizationId) items = items.filter((item) => item.organizationId === query.organizationId);
    if (query.dealId) items = items.filter((item) => item.dealId === query.dealId);
    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.active) items = items.filter((item) => String(item.archivedAt ? false : true) === query.active);
    if (query.from) items = items.filter((item) => !item.plannedPublicationDate || String(item.plannedPublicationDate) >= query.from!);
    if (query.to) items = items.filter((item) => !item.plannedPublicationDate || String(item.plannedPublicationDate) <= query.to!);
    if (query.search) {
      const q = query.search.toLowerCase();
      items = items.filter((item) => [item.displayName, item.name, item.status, item.domain].some((value) => String(value || '').toLowerCase().includes(q)));
    }
    if (kind === 'deal') return json(200, page(await decorateDeals(client, items, today), event));
    if (kind === 'organization') {
      const moneyDeals = await organizationMoney(client, today);
      const decorated = items.map((organization) => {
        const orgDeals = moneyDeals.filter((deal) => deal.organizationId === organization.id);
        return { ...organization, relationship: relationshipTag(organization, orgDeals, today) };
      });
      return json(200, page(decorated, event));
    }
    return json(200, page(items, event));
  }

  if (method === 'POST' && !id) {
    if (!body) return json(400, { error: 'Invalid JSON' });
    const error = kind === 'organization' ? validateOrganization(body)
      : kind === 'contact' ? validateContact(body)
      : kind === 'deal' ? validateDeal(body)
      : validateDeliverable(body);
    if (error) return json(400, { error });
    if (kind === 'contact' || kind === 'deal') {
      const organization = await getCrmRecord(client, 'organization', String(body.organizationId));
      if (!organization || organization.archivedAt) return json(422, { error: 'Invalid organization reference' });
    }
    if (kind === 'deliverable') {
      const deal = await getCrmRecord(client, 'deal', String(body.dealId));
      if (!deal || deal.archivedAt) return json(422, { error: 'Invalid deal reference' });
      body.organizationId = deal.organizationId;
    }
    if (kind === 'deal' && body.primaryContactId) {
      const contact = await getCrmRecord(client, 'contact', String(body.primaryContactId));
      if (!contact || contact.organizationId !== body.organizationId) return json(422, { error: 'Invalid primary contact reference' });
    }
    if (kind === 'deal') body.productKind = body.productKind || 'one-off';
    if (kind === 'organization' && body.domain) body.domain = registrableDomain(String(body.domain));
    try {
      const values = { ...body, active: body.active !== false, sourceType: body.sourceType || 'portal' };
      const created = kind === 'deal' ? await createDealAtomic(client, values, user)
        : kind === 'deliverable' ? await createDeliverableAtomic(client, values, user)
        : kind === 'contact' ? await createContactAtomic(client, values, user)
        : await createOrganizationAtomic(client, values, user);
      if (kind === 'deal' && body.deliverable && typeof body.deliverable === 'object') {
        const deliverableBody = body.deliverable as Record<string, unknown>;
        const deliverableError = validateDeliverable({ ...deliverableBody, dealId: created.item.id });
        if (deliverableError) return json(400, { error: deliverableError });
        await createDeliverableAtomic(client, { ...deliverableBody, dealId: created.item.id, organizationId: created.item.organizationId, sourceType: 'portal' }, user);
      }
      return json(created.duplicate ? 200 : 201, kind === 'deal' ? publicDeal(created.item) : created.item);
    } catch (error) {
      const conflict = (error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional');
      return json((error as { statusCode?: number }).statusCode || (conflict ? 409 : 500), { error: (error as { statusCode?: number }).statusCode ? (error as Error).message : (conflict ? 'Exclusive CRM reference is already claimed' : 'Could not create record') });
    }
  }

  if ((method === 'PUT' || method === 'PATCH') && id) {
    if (!body) return json(400, { error: 'Invalid JSON' });
    const existing = await getCrmRecord(client, kind, id);
    if (!existing) return json(404, { error: 'Not found' });
    if (body.version !== existing.version) return json(409, { error: 'Record was changed; reload and retry' });
    const error = kind === 'organization' ? validateOrganization(body, true)
      : kind === 'contact' ? validateContact(body, true)
      : kind === 'deal' ? validateDeal(body, true, existing)
      : validateDeliverable(body, true);
    if (error) return json(400, { error });
    const nextOrganizationId = String(body.organizationId || existing.organizationId || '');
    if (kind === 'contact' || kind === 'deal') {
      const organization = await getCrmRecord(client, 'organization', nextOrganizationId);
      if (!organization || organization.archivedAt) return json(422, { error: 'Invalid organization reference' });
    }
    if (kind === 'deal' && (body.primaryContactId !== undefined || body.organizationId !== undefined)) {
      const contactId = String(body.primaryContactId || existing.primaryContactId || '');
      if (contactId) {
        const contact = await getCrmRecord(client, 'contact', contactId);
        if (!contact || contact.archivedAt || contact.organizationId !== nextOrganizationId) return json(422, { error: 'Invalid primary contact reference' });
      }
    }
    if (kind === 'organization' && body.domain) body.domain = registrableDomain(String(body.domain));
    try {
      if (kind === 'deal') return json(200, publicDeal(await updateDealAtomic(client, existing, body, user)));
      if (kind === 'deliverable') return json(200, await updateDeliverableAtomic(client, existing, body, user));
      if (kind === 'contact') return json(200, await updateContactAtomic(client, existing, body, user));
      return json(200, await updateOrganizationAtomic(client, existing, body, user));
    } catch (error) {
      return json((error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional') ? 409 : 500, { error: 'Conflicting update; reload and retry' });
    }
  }

  if (method === 'DELETE' && id && kind !== 'deal' && kind !== 'deliverable') {
    const existing = await getCrmRecord(client, kind, id);
    if (!existing) return json(404, { error: 'Not found' });
    if (kind === 'contact') return json(200, await updateContactAtomic(client, existing, { archivedAt: new Date().toISOString(), active: false, primary: false }, user));
    return json(200, await updateOrganizationAtomic(client, existing, { archivedAt: new Date().toISOString(), active: false }, user, 'archived'));
  }
  return json(405, { error: 'Method not allowed' });
}
