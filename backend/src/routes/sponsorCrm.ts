import { createNote } from '../crmWorkspace/notes';
import { berlinDate } from '../sponsorFinance/core';
import { isIndividualTuition } from '../tuition/classification';
import { sponsorPipeline, PIPELINE_STAGES, PIPELINE_VIEWS, pipelineDateRangeError } from '../sponsorCrm/pipeline';
import { resolveView } from '../crmWorkspace/views';
import { queryTargetMessages, workspaceErrorOf } from '../crmWorkspace/reads';
import { getNewsletterIssue } from '../db/newsletterIssues';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse, Task } from '../types';
import {
  createContactAtomic,
  createCrmRecord,
  createDealAtomic,
  createDeliverableAtomic,
  createOrganizationAtomic,
  getCrmRecord,
  hardDeleteCrmRecord,
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
import { listTasksByStatus } from '../db/tasks';
import { getWorkspaceSettings, resolveDefaultAssigneeId } from '../db/workspaceSettings';
import { importCrmSnapshot } from '../sponsorCrm/importSnapshot';
import { listColdEntries, remindColdEntries, touchTarget, TOUCH_CHANNELS } from '../sponsorCrm/coldContacts';
import { dealMoneyFacts } from '../sponsorFinance/ledger';
import {
  CHANNELS,
  NEWSLETTER_CHANNELS,
  PROMOTION_SOURCES,
  CONTENT_TYPES,
  RELEVANCY,
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
import { splitVatId } from '../vies/format';
import { lastViesCheck } from '../vies/service';
import { recordRequestError } from '../requestErrorLog';
import { resolveInteractiveActor } from '../identity/actor';

const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const parse = (event: LambdaEvent) => { try { const value = event.body ? JSON.parse(String(event.body)) : null; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } };
const actor = (event: LambdaEvent) => Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'x-user-id')?.[1] || '';
const text = (value: unknown, max = 500) => typeof value === 'string' && value.trim() && value.length <= max;
const page = (items: unknown[], event: LambdaEvent) => {
  const query = event.queryStringParameters || {}, limit = Number(query.limit || 50), cursor = Number(query.cursor || 0);
  const sliced = items.slice(cursor, cursor + limit);
  return { items: sliced, nextCursor: cursor + limit < items.length ? String(cursor + limit) : null };
};
const todayOf = (event: LambdaEvent) => {
  const query = event.queryStringParameters || {};
  return realDate(query.today) ? String(query.today) : berlinDate();
};

function validateList(event: LambdaEvent) {
  const query = event.queryStringParameters || {}, limit = Number(query.limit || 50), cursor = Number(query.cursor || 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(cursor) || cursor < 0) return 'Invalid pagination';
  if (query.from && !realDate(query.from)) return 'Invalid from date';
  if (query.to && !realDate(query.to)) return 'Invalid to date';
  if (query.from && query.to && query.from > query.to) return 'Invalid date range';
  if ((query.organizationId || query.company) && !ID.test(query.organizationId || query.company)) return 'Invalid organizationId filter';
  if (query.dealId && !ID.test(query.dealId)) return 'Invalid dealId filter';
  if (query.active && !['true', 'false'].includes(query.active)) return 'Invalid active filter';
  if (query.status && !DEAL_STATUSES.has(query.status)) return 'Invalid status filter';
  return '';
}

const validStamp = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && realDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value)));

function validateTags(tags: unknown): string | null {
  if (tags === undefined || tags === null) return null;
  if (!Array.isArray(tags)) return 'Invalid tags';
  if (tags.length > 20) return 'Invalid tags: maximum 20 tags';
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag.trim() || tag.trim().length > 60) {
      return 'Invalid tags';
    }
  }
  return null;
}

function validateOrganization(body: Record<string, unknown>, partial = false) {
  if ((!partial && !text(body.displayName, 200)) || (body.displayName !== undefined && !text(body.displayName, 200))) return 'Invalid organization fields';
  if (body.notes !== undefined && typeof body.notes !== 'string') return 'Invalid organization fields';
  if (body.domain !== undefined && body.domain !== '' && !registrableDomain(String(body.domain))) return 'Invalid domain';
  if (body.country !== undefined && body.country !== null && body.country !== '' && !/^[A-Za-z]{2}$/.test(String(body.country))) return 'Invalid country';
  if (body.vatId !== undefined && body.vatId !== null && body.vatId !== '') {
    const split = splitVatId(String(body.vatId));
    if ('error' in split) return split.error === 'missing-country-prefix' ? 'Invalid vatId: missing EU member-state prefix (a register number like a bare CVR is not a VAT ID)' : 'Invalid vatId format';
  }
  if (!validStamp(body.lastOutboundAt)) return 'Invalid lastOutboundAt';
  if (!validStamp(body.lastInboundAt)) return 'Invalid lastInboundAt';
  if (!validStamp(body.first_contact_at)) return 'Invalid first_contact_at';
  if (!validStamp(body.last_contact_at)) return 'Invalid last_contact_at';
  if (body.doNotContact !== undefined && typeof body.doNotContact !== 'boolean') return 'Invalid doNotContact flag';
  if (body.dnc !== undefined && typeof body.dnc !== 'boolean') return 'Invalid dnc flag';
  if (body.tags !== undefined) {
    const error = validateTags(body.tags);
    if (error) return error;
  }
  return '';
}

function validateContact(body: Record<string, unknown>, partial = false) {
  if ((!partial && !text(body.name, 200)) || (body.name !== undefined && !text(body.name, 200))) return 'Invalid contact fields';
  if (body.emails !== undefined && (!Array.isArray(body.emails) || body.emails.length < 1 || body.emails.length > 10 || body.emails.some((email) => typeof email !== 'string' || !EMAIL.test(email) || email.length > 254))) return 'Invalid contact channels';
  if (body.organizationId !== undefined && body.organizationId !== null && body.organizationId !== '' && !ID.test(String(body.organizationId))) return 'Invalid organizationId';
  for (const field of ['role', 'notes', 'telegram']) if (body[field] !== undefined && (typeof body[field] !== 'string' || String(body[field]).length > (field === 'notes' ? 2000 : 200))) return `Invalid ${field}`;
  if (body.primary !== undefined && typeof body.primary !== 'boolean') return 'Invalid primary flag';
  if (body.linkedin !== undefined && body.linkedin !== '') {
    try { const url = new URL(String(body.linkedin)); if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname)) return 'Invalid LinkedIn URL'; }
    catch { return 'Invalid LinkedIn URL'; }
  }
  if (!validStamp(body.lastContactedAt)) return 'Invalid lastContactedAt';
  if (!validStamp(body.lastOutboundAt)) return 'Invalid lastOutboundAt';
  if (!validStamp(body.lastInboundAt)) return 'Invalid lastInboundAt';
  if (!validStamp(body.first_contact_at)) return 'Invalid first_contact_at';
  if (!validStamp(body.last_contact_at)) return 'Invalid last_contact_at';
  if (body.doNotContact !== undefined && typeof body.doNotContact !== 'boolean') return 'Invalid doNotContact flag';
  if (body.dnc !== undefined && typeof body.dnc !== 'boolean') return 'Invalid dnc flag';
  if (body.tags !== undefined) {
    const error = validateTags(body.tags);
    if (error) return error;
  }
  return '';
}

function validateDeal(body: Record<string, unknown>, partial = false, existing?: CrmRecord) {
  if (isIndividualTuition({ ...existing, ...body })) return 'Individual tuition belongs in /api/tuition (Bookkeeping), not sponsor CRM';
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

function validateDeliverable(body: Record<string, unknown>, partial = false, existing?: CrmRecord) {
  if (!partial && !ID.test(String(body.dealId || ''))) return 'Invalid dealId';
  if ((!partial || body.channel !== undefined) && !CHANNELS.has(String(body.channel))) return 'Invalid channel';
  for (const name of ['plannedPublicationDate', 'materialDeadline']) if (body[name] != null && !realDate(body[name])) return `Invalid ${name}`;
  for (const name of ['primaryContactId', 'scheduleEntryId', 'cardId', 'newsletterIssueId']) if (body[name] != null && !ID.test(String(body[name]))) return `Invalid ${name}`;
  const channel = String(body.channel ?? existing?.channel ?? '');
  const next = (name: string) => (Object.hasOwn(body, name) ? body[name] : existing?.[name]);
  if (NEWSLETTER_CHANNELS.has(channel) && next('cardId') != null) return 'A newsletter deliverable links its issue (newsletterIssueId), not a Card';
  if (!NEWSLETTER_CHANNELS.has(channel) && next('newsletterIssueId') != null) return 'Only a newsletter deliverable links a newsletter issue';
  if (body.artifactUrls !== undefined && (!Array.isArray(body.artifactUrls) || body.artifactUrls.length > 20 || body.artifactUrls.some((url) => { try { const parsed = new URL(String(url)); return parsed.protocol !== 'https:'; } catch { return true; } }))) return 'Invalid artifactUrls';
  if (body.title !== undefined && body.title !== '' && !text(body.title, 300)) return 'Invalid title';
  if (body.requiredLinkUrl !== undefined && body.requiredLinkUrl !== null && body.requiredLinkUrl !== '') {
    try {
      if (new URL(String(body.requiredLinkUrl)).protocol !== 'https:') return 'Invalid requiredLinkUrl';
    } catch {
      return 'Invalid requiredLinkUrl';
    }
  }
  // promotionSource mirrors Airtable Content "Source" (Influencer Marketing, Paid Marketing, …)
  if (body.promotionSource !== undefined && body.promotionSource !== null && body.promotionSource !== ''
      && !PROMOTION_SOURCES.has(String(body.promotionSource))) return 'Invalid promotionSource';
  if (body.contentType !== undefined && body.contentType !== null && body.contentType !== ''
      && !CONTENT_TYPES.has(String(body.contentType))) return 'Invalid contentType';
  if (body.relevancy !== undefined && body.relevancy !== null && body.relevancy !== ''
      && !RELEVANCY.has(String(body.relevancy))) return 'Invalid relevancy';
  if (body.influencerHandle !== undefined && body.influencerHandle !== null && body.influencerHandle !== '') {
    const handle = String(body.influencerHandle).trim();
    if (handle.length > 100 || /\s/.test(handle)) return 'Invalid influencerHandle';
  }
  if (body.publishedAt !== undefined && body.publishedAt !== null && body.publishedAt !== '') {
    if (Number.isNaN(Date.parse(String(body.publishedAt)))) return 'Invalid publishedAt';
  }
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
  newsletterIssueId: deliverable.newsletterIssueId,
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
    const kids = deliverables.filter((item) => item.dealId === deal.id && !item.archivedAt);
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
  if (body && 'rehomedTo' in body) return json(400, { error: 'Archival provenance is read-only' });

  if (path === '/api/sponsor-crm/pipeline' && method === 'GET') {
    let query = event.queryStringParameters || {};
    const error = validateList(event);
    if (error) return json(400, { error });
    if (query.savedView) {
      if (!user && !query.savedView.startsWith('builtin:')) return json(401, { error: 'Unauthorized' });
      let resolved: Awaited<ReturnType<typeof resolveView>>;
      try {
        resolved = await resolveView(client, user, query.savedView, today);
      } catch (err) {
        const errorObj = workspaceErrorOf(err, 'saved views');
        return json((errorObj as { statusCode?: number }).statusCode || 500, { error: errorObj.message });
      }
      if (!resolved) return json(404, { error: 'View not found' });
      if ('archived' in resolved) return json(422, { error: 'View is archived' });
      if (resolved.entity !== 'pipeline') return json(400, { error: 'View entity mismatch' });
      const stored = (resolved.view.resolvedFilters || {}) as Record<string, unknown>;
      const baseFilters = Object.fromEntries(
        Object.entries(stored).map(([k, v]) => [k, String(v)]),
      );
      const viewSort = (resolved.view.sort || {}) as Record<string, string>;
      const { savedView, ...explicit } = query;
      void savedView;
      query = {
        ...baseFilters,
        ...(viewSort.field ? { sort: viewSort.field } : {}),
        ...explicit,
      };
    }
    if (query.view && !(PIPELINE_VIEWS as readonly string[]).includes(query.view)) return json(400, { error: 'Invalid pipeline view' });
    if (query.stage && !(PIPELINE_STAGES as readonly string[]).includes(query.stage)) return json(400, { error: 'Invalid pipeline stage' });
    if (query.sort && !['next-action', 'recent'].includes(query.sort)) return json(400, { error: 'Invalid pipeline sort' });
    const rangeError = pipelineDateRangeError(query);
    if (rangeError) return json(400, { error: rangeError });
    return json(200, await sponsorPipeline(client, query, today));
  }

  if (path === '/api/sponsor-crm/followups' && method === 'GET') {
    const query = event.queryStringParameters || {};
    const dueOnly = query.due === 'true';
    const overdueOnly = query.overdue === 'true';
    const openTasks = [
      ...(await listTasksByStatus(client, 'todo')),
      ...(await listTasksByStatus(client, 'waiting')),
    ];
    const sponsorTasks = openTasks.filter(
      (t) =>
        t.subject?.type === 'sponsor-deal' ||
        t.subject?.type === 'sponsor-company' ||
        t.subject?.type === 'sponsor-person',
    );
    const matchingTasks = sponsorTasks.filter((t) => {
      const taskDate = String(t.date || '');
      if (overdueOnly) return taskDate < today;
      if (dueOnly) return taskDate <= today;
      return true;
    });

    const orgCache = new Map<string, any>();
    const contactCache = new Map<string, any>();
    const dealCache = new Map<string, any>();

    const getOrg = async (id: string) => {
      if (!orgCache.has(id)) orgCache.set(id, await getCrmRecord(client, 'organization', id));
      return orgCache.get(id);
    };
    const getContact = async (id: string) => {
      if (!contactCache.has(id)) contactCache.set(id, await getCrmRecord(client, 'contact', id));
      return contactCache.get(id);
    };
    const getDeal = async (id: string) => {
      if (!dealCache.has(id)) dealCache.set(id, await getCrmRecord(client, 'deal', id));
      return dealCache.get(id);
    };

    const isRecordDnc = (record: any) => {
      if (!record) return false;
      return Boolean(record.doNotContact || (Array.isArray(record.tags) && record.tags.includes('do-not-contact')));
    };

    const items: Array<{
      task: any;
      subjectType: string;
      subjectId: string;
      subjectName: string;
      organizationId?: string;
      organizationName?: string;
      contactId?: string;
      contactName?: string;
      dealId?: string;
      dealTitle?: string;
      isDue: boolean;
      isOverdue: boolean;
    }> = [];

    for (const task of matchingTasks) {
      const subjectType = task.subject!.type;
      const subjectId = task.subject!.id;
      let subjectName = subjectId;
      let orgId: string | undefined;
      let orgName: string | undefined;
      let cntId: string | undefined;
      let cntName: string | undefined;
      let dlId: string | undefined;
      let dlTitle: string | undefined;
      let excluded = false;

      if (subjectType === 'sponsor-company') {
        const org = await getOrg(subjectId);
        if (isRecordDnc(org)) {
          excluded = true;
        } else if (org) {
          orgId = org.id;
          orgName = org.displayName || org.name;
          subjectName = orgName || subjectId;
        }
      } else if (subjectType === 'sponsor-person') {
        const contact = await getContact(subjectId);
        if (isRecordDnc(contact)) {
          excluded = true;
        } else if (contact) {
          cntId = contact.id;
          cntName = contact.name;
          subjectName = cntName || subjectId;
          if (contact.organizationId) {
            const org = await getOrg(String(contact.organizationId));
            if (isRecordDnc(org)) {
              excluded = true;
            } else if (org) {
              orgId = org.id;
              orgName = org.displayName || org.name;
            }
          }
        }
      } else if (subjectType === 'sponsor-deal') {
        const deal = await getDeal(subjectId);
        if (deal) {
          dlId = deal.id;
          dlTitle = deal.name || deal.title;
          subjectName = dlTitle || subjectId;
          if (deal.organizationId) {
            const org = await getOrg(String(deal.organizationId));
            if (isRecordDnc(org)) {
              excluded = true;
            } else if (org) {
              orgId = org.id;
              orgName = org.displayName || org.name;
            }
          }
        }
      }

      if (excluded) continue;

      const taskDate = String(task.date || '');
      items.push({
        task: {
          id: task.id,
          description: task.description,
          status: task.status,
          date: task.date,
          assigneeId: task.assigneeId,
          subject: task.subject,
        },
        subjectType,
        subjectId,
        subjectName,
        ...(orgId ? { organizationId: orgId, organizationName: orgName } : {}),
        ...(cntId ? { contactId: cntId, contactName: cntName } : {}),
        ...(dlId ? { dealId: dlId, dealTitle: dlTitle } : {}),
        isDue: taskDate <= today,
        isOverdue: taskDate < today,
      });
    }

    items.sort(
      (a, b) =>
        String(a.task.date || '').localeCompare(String(b.task.date || '')) ||
        a.task.id.localeCompare(b.task.id),
    );
    return json(200, { items, total: items.length });
  }

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
    if (contact && !contact.archivedAt) {
      const fresh = await getCrmRecord(client, 'contact', contact.id);
      if (fresh && !fresh.archivedAt) {
        const contactUpdates: Record<string, unknown> = { ...stamp, last_contact_at: sentAt };
        if (!fresh.first_contact_at) contactUpdates.first_contact_at = sentAt;
        await updateContactAtomic(client, fresh, contactUpdates, user);
      }
    }
    const freshOrg = await getCrmRecord(client, 'organization', organization.id);
    const orgTarget = freshOrg || organization;
    const orgUpdates: Record<string, unknown> = { ...stamp, last_contact_at: sentAt };
    if (!orgTarget.first_contact_at) orgUpdates.first_contact_at = sentAt;
    await updateOrganizationAtomic(client, orgTarget, orgUpdates, user, 'mail');
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
    const { items: orgMsgItems } = await queryTargetMessages(client, { targetType: 'organization', targetId: organization.id }, 'messages');
    let items = orgMsgItems;
    if (query) items = items.filter((item) => String(item.snippet || '').toLowerCase().includes(query) || String(item.threadId || '').toLowerCase().includes(query));
    items.sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')));
    return json(200, { items: items.slice(0, 20), nextCursor: items.length > 20 ? '20' : null });
  }

  if (path === '/api/sponsor-crm/cold' && method === 'GET') {
    const query = event.queryStringParameters || {};
    const today = todayOf(event);
    const days = query.days === undefined ? undefined : Number(query.days);
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) return json(400, { error: 'days must be a whole number of days from 1 to 365' });
    const settings = await getWorkspaceSettings(client);
    const [organizations, contacts] = await Promise.all([
      listCrmRecords(client, 'organization'),
      listCrmRecords(client, 'contact'),
    ]);
    const deals = (await organizationMoney(client, today)).filter((deal) => !deal.archivedAt);
    return json(200, {
      today,
      thresholds: days !== undefined ? { overrideDays: days } : settings.sponsorColdContactDays,
      items: listColdEntries({ organizations, contacts, deals, today, thresholds: settings.sponsorColdContactDays, ...(days !== undefined ? { overrideDays: days } : {}) }),
    });
  }

  if (path === '/api/sponsor-crm/cold/remind' && method === 'POST') {
    if (!body) return json(400, { error: 'Invalid JSON' });
    const today = typeof body.today === 'string' && realDate(body.today) ? body.today : todayOf(event);
    const days = body.days === undefined ? undefined : Number(body.days);
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) return json(400, { error: 'days must be a whole number of days from 1 to 365' });
    const settings = await getWorkspaceSettings(client);
    const [organizations, contacts] = await Promise.all([
      listCrmRecords(client, 'organization'),
      listCrmRecords(client, 'contact'),
    ]);
    const deals = (await organizationMoney(client, today)).filter((deal) => !deal.archivedAt);
    const entries = listColdEntries({ organizations, contacts, deals, today, thresholds: settings.sponsorColdContactDays, ...(days !== undefined ? { overrideDays: days } : {}) });
    try {
      return json(201, { today, ...(await remindColdEntries(client, entries, { actorId: user, today })) });
    } catch (error) {
      recordRequestError(error);
      return json(500, { error: 'Could not create cold-contact reminders' });
    }
  }

  if (path === '/api/sponsor-crm/touches' && method === 'POST') {
    if (!body) return json(400, { error: 'Invalid JSON' });
    const rawTarget = String(body.targetType || body.kind || '');
    const targetType = rawTarget === 'company' ? 'organization' : rawTarget === 'person' ? 'contact' : rawTarget;
    const targetId = String(body.targetId || body.id || '');
    const channel = String(body.channel || '');
    if (!['organization', 'contact'].includes(targetType) || !ID.test(targetId)) return json(400, { error: 'targetType must be organization or contact with a record id in targetId' });
    if (!TOUCH_CHANNELS.has(channel)) return json(400, { error: 'channel must be one of: email, call, meeting, linkedin, other' });
    const touchedAt = typeof body.touchedAt === 'string' ? body.touchedAt : typeof body.date === 'string' ? body.date : new Date().toISOString();
    if (!realDate(touchedAt.slice(0, 10)) || Number.isNaN(Date.parse(touchedAt))) return json(400, { error: 'touchedAt must be a date or datetime' });
    if (typeof body.note === 'string' && body.note.length > 2000) return json(400, { error: 'note must be at most 2000 characters' });
    try {
      const result = await touchTarget(client, { targetType: targetType as 'organization' | 'contact', targetId }, {
        actorId: user,
        channel,
        ...(typeof body.note === 'string' && body.note ? { note: body.note } : {}),
        touchedAt,
      });
      return json(201, result);
    } catch (error) {
      recordRequestError(error);
      return json((error as { statusCode?: number }).statusCode || 500, { error: (error as Error).message });
    }
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

  const unarchiveMatch = path.match(/^\/api\/sponsor-crm\/(organizations|contacts|deals)\/([^/]+)\/unarchive$/);
  if (unarchiveMatch) {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    const plural = unarchiveMatch[1], id = unarchiveMatch[2];
    const kind = plural === 'contacts' ? 'contact' : plural === 'deals' ? 'deal' : 'organization';
    if (!ID.test(id)) return json(400, { error: 'Invalid ID' });
    const existing = await getCrmRecord(client, kind, id);
    if (!existing) return json(404, { error: 'Not found' });
    if (!existing.archivedAt) return json(200, kind === 'deal' ? publicDeal(existing) : existing);
    if (kind === 'contact' || kind === 'deal') {
      const organization = await getCrmRecord(client, 'organization', String(existing.organizationId));
      if (!organization || organization.archivedAt) return json(422, { error: 'Cannot unarchive when organization is archived' });
    }
    if (kind === 'contact') return json(200, await updateContactAtomic(client, existing, { archivedAt: null, active: true }, user, 'unarchived'));
    if (kind === 'deal') return json(200, publicDeal(await updateDealAtomic(client, existing, { archivedAt: null, active: true }, user)));
    return json(200, await updateOrganizationAtomic(client, existing, { archivedAt: null, active: true }, user, 'unarchived'));
  }

  const dncMatch = path.match(/^\/api\/sponsor-crm\/(organizations|contacts)\/([^/]+)\/dnc$/);
  if (dncMatch) {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    const plural = dncMatch[1], id = dncMatch[2];
    const kind = plural === 'contacts' ? 'contact' : 'organization';
    if (!ID.test(id)) return json(400, { error: 'Invalid ID' });
    const existing = await getCrmRecord(client, kind, id);
    if (!existing) return json(404, { error: 'Not found' });
    const dncValue = body?.doNotContact !== undefined ? Boolean(body.doNotContact)
      : body?.dnc !== undefined ? Boolean(body.dnc)
      : true;
    const updated = kind === 'organization'
      ? await updateOrganizationAtomic(client, existing, { doNotContact: dncValue }, user)
      : await updateContactAtomic(client, existing, { doNotContact: dncValue }, user);
    if (typeof body?.note === 'string' && body.note.trim()) {
      await createNote(client, user, kind, id, { body: body.note.trim() });
    }
    return json(200, updated);
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
      const viesCheck = await lastViesCheck(client, record);
      return json(200, {
        ...record, relationship: relationshipTag(record, moneyDeals, today), deals: moneyDeals,
        ...(viesCheck ? { viesCheck } : {}),
      });
    }
    return json(200, record);
  }

  if (method === 'GET' && !id) {
    const listError = validateList(event);
    if (listError) return json(400, { error: listError });
    let items = await listCrmRecords(client, kind);
    const query = event.queryStringParameters || {};
    const orgFilter = query.organizationId || query.company;
    if (orgFilter) items = items.filter((item) => item.organizationId === orgFilter);
    if (query.dealId) items = items.filter((item) => item.dealId === query.dealId);
    if (query.promotionSource || query.source) {
      const source = String(query.promotionSource || query.source);
      items = items.filter((item) => item.promotionSource === source);
    }
    if (query.contentType) items = items.filter((item) => item.contentType === query.contentType);
    if (query.channel) items = items.filter((item) => item.channel === query.channel);
    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.active) items = items.filter((item) => String(item.archivedAt ? false : true) === query.active);
    if (query.from) items = items.filter((item) => !item.plannedPublicationDate || String(item.plannedPublicationDate) >= query.from!);
    if (query.to) items = items.filter((item) => !item.plannedPublicationDate || String(item.plannedPublicationDate) <= query.to!);
    if (query.search) {
      const q = query.search.toLowerCase();
      items = items.filter((item) => [item.displayName, item.name, item.title, item.status, item.domain, item.promotionSource, item.contentType, item.influencerHandle, item.requiredLinkUrl].some((value) => String(value || '').toLowerCase().includes(q)));
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
    if ((kind === 'contact' && body.organizationId) || kind === 'deal') {
      const organization = await getCrmRecord(client, 'organization', String(body.organizationId));
      if (!organization || organization.archivedAt) return json(422, { error: 'Invalid organization reference' });
    }
    if (kind === 'deliverable' && body.newsletterIssueId != null && !(await getNewsletterIssue(client, String(body.newsletterIssueId)))) {
      return json(422, { error: 'Invalid newsletter issue reference' });
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
    if (Array.isArray(body.tags)) body.tags = body.tags.map((t) => String(t).trim());
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
      recordRequestError(error);
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
      : validateDeliverable(body, true, existing);
    if (error) return json(400, { error });
    const nextOrganizationId = body.organizationId !== undefined ? String(body.organizationId || '') : String(existing.organizationId || '');
    if ((kind === 'contact' && nextOrganizationId) || kind === 'deal') {
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
    if (kind === 'deliverable' && body.newsletterIssueId != null && !(await getNewsletterIssue(client, String(body.newsletterIssueId)))) {
      return json(422, { error: 'Invalid newsletter issue reference' });
    }
    if (kind === 'organization' && body.domain) body.domain = registrableDomain(String(body.domain));
    if (Array.isArray(body.tags)) body.tags = body.tags.map((t) => String(t).trim());
    try {
      if (kind === 'deal') return json(200, publicDeal(await updateDealAtomic(client, existing, body, user)));
      if (kind === 'deliverable') return json(200, await updateDeliverableAtomic(client, existing, body, user));
      if (kind === 'contact') return json(200, await updateContactAtomic(client, existing, body, user));
      return json(200, await updateOrganizationAtomic(client, existing, body, user));
    } catch (error) {
      recordRequestError(error);
      return json((error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional') ? 409 : 500, { error: 'Conflicting update; reload and retry' });
    }
  }

  if (method === 'DELETE' && id && kind !== 'deliverable') {
    if (event.queryStringParameters?.hard !== undefined) {
      if (event.queryStringParameters.hard !== 'true' || (kind !== 'organization' && kind !== 'contact')) {
        return json(400, { error: 'hard=true is supported only for organizations and contacts' });
      }
      const auth = await resolveInteractiveActor(client, event, 'work-write');
      if (!auth.ok) return auth.response;
      if (!auth.actor.isAdmin) return json(403, { error: 'Hard delete requires an active admin' });
      const rawVersion = event.queryStringParameters.expectedVersion;
      const expectedVersion = rawVersion === undefined ? undefined : Number(rawVersion);
      if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
        return json(400, { error: 'expectedVersion must be a positive integer' });
      }
      try {
        return json(200, await hardDeleteCrmRecord(client, kind, id, expectedVersion));
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status) return json(status, { error: (error as Error).message });
        if ((error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional')) {
          return json(409, { error: 'Conflicting delete; reload and retry' });
        }
        recordRequestError(error);
        return json(500, { error: 'Could not confirm hard deletion; reload before retrying' });
      }
    }
    const existing = await getCrmRecord(client, kind, id);
    if (!existing) return json(404, { error: 'Not found' });
    if (kind === 'contact') return json(200, await updateContactAtomic(client, existing, { archivedAt: new Date().toISOString(), active: false, primary: false }, user));
    if (kind === 'deal') return json(200, publicDeal(await updateDealAtomic(client, existing, { archivedAt: new Date().toISOString(), active: false }, user)));
    return json(200, await updateOrganizationAtomic(client, existing, { archivedAt: new Date().toISOString(), active: false }, user, 'archived'));
  }
  return json(405, { error: 'Method not allowed' });
}
