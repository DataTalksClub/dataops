import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createContactAtomic,
  createCrmRecord,
  createDealAtomic,
  createDeliverableAtomic,
  createOrganizationAtomic,
  deterministicCrmId,
  getCrmRecord,
  listCrmRecords,
} from '../db/sponsorCrm';
import { CHANNELS, DEAL_STATUSES, PRODUCT_KINDS, parseNextAction, realDate, registrableDomain } from './model';
import { newsletterRecord, validateNewsletter } from './newsletters';

export type SnapshotCompany = {
  domain?: string;
  displayName: string;
  relevancy?: string;
  sourceKey?: string;
  lastOutboundAt?: string;
  lastInboundAt?: string;
  notes?: string;
};
export type SnapshotPerson = {
  email: string;
  name: string;
  organizationDomain: string;
  sourceKey?: string;
};
export type SnapshotDeliverable = {
  channel: string;
  plannedPublicationDate?: string;
  materialDeadline?: string;
  publishedAt?: string;
  artifactUrls?: string[];
  cardId?: string;
  scheduleEntryId?: string;
  sourceKey?: string;
};
export type SnapshotDeal = {
  organizationDomain: string;
  title?: string;
  status: string;
  productKind?: string;
  amountEur?: number;
  agreementDate?: string;
  nextAction?: unknown;
  sourceKey?: string;
  deliverables?: SnapshotDeliverable[];
};
export type SnapshotActivity = {
  organizationDomain: string;
  personEmail?: string | null;
  threadId: string;
  direction: 'inbound' | 'outbound';
  sentAt: string;
  snippet?: string;
};
export type SnapshotLead = {
  name: string;
  url?: string;
  newsletter?: string;
  sourceKey?: string;
};
export type SnapshotNewsletter = {
  name: string;
  slug?: string;
  url: string;
  mailbox?: string;
  senders?: string[];
  cadence?: string;
  expectedIntervalDays: number;
  subscriptionStatus: string;
  subscribedAt?: string;
  notes?: string;
  sourceKey?: string;
};
export type CrmSnapshot = {
  companies?: SnapshotCompany[];
  people?: SnapshotPerson[];
  deals?: SnapshotDeal[];
  activity?: SnapshotActivity[];
  leads?: SnapshotLead[];
  newsletters?: SnapshotNewsletter[];
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function importCrmSnapshot(client: DynamoDBDocumentClient, snapshot: CrmSnapshot, actorId: string) {
  const companies = snapshot.companies || [];
  const people = snapshot.people || [];
  const deals = snapshot.deals || [];
  const activity = snapshot.activity || [];
  const leads = snapshot.leads || [];
  const newsletters = snapshot.newsletters || [];
  if (companies.length + people.length + deals.length + activity.length + leads.length + newsletters.length > 10_000) {
    throw Object.assign(new Error('Snapshot too large'), { statusCode: 400 });
  }

  const orgByDomain = new Map<string, string>();
  const orgByName = new Map<string, string>();
  for (const existing of await listCrmRecords(client, 'organization')) {
    if (existing.domain) orgByDomain.set(String(existing.domain), existing.id);
    if (existing.displayName) orgByName.set(String(existing.displayName).trim().toLowerCase(), existing.id);
  }
  const contactByEmail = new Map<string, string>();
  for (const existing of await listCrmRecords(client, 'contact')) {
    const emails = Array.isArray(existing.emails) ? existing.emails : [];
    for (const email of emails) {
      if (typeof email === 'string' && email.trim()) contactByEmail.set(email.toLowerCase(), existing.id);
    }
  }
  const created = { companies: 0, people: 0, deals: 0, deliverables: 0, activity: 0, leads: 0, newsletters: 0, duplicates: 0 };
  const resolveOrg = (ref: string) => {
    const domain = registrableDomain(ref);
    if (domain && orgByDomain.has(domain)) return orgByDomain.get(domain);
    return orgByName.get(ref.trim().toLowerCase());
  };

  for (const company of companies) {
    if (!company.displayName?.trim() || company.displayName.length > 200) {
      throw Object.assign(new Error('Invalid company'), { statusCode: 400 });
    }
    const domain = registrableDomain(company.domain);
    const nameKey = company.displayName.trim().toLowerCase();
    const existingId = (domain && orgByDomain.get(domain)) || orgByName.get(nameKey);
    if (existingId) {
      created.duplicates += 1;
      if (domain) orgByDomain.set(domain, existingId);
      orgByName.set(nameKey, existingId);
      continue;
    }
    const relevancy = String(company.relevancy || 'medium').trim().toLowerCase();
    const result = await createOrganizationAtomic(client, {
      displayName: company.displayName.trim(),
      ...(domain ? { domain } : {}),
      relevancy: ['high', 'medium', 'low'].includes(relevancy) ? relevancy : 'medium',
      ...(company.lastOutboundAt ? { lastOutboundAt: company.lastOutboundAt } : {}),
      ...(company.lastInboundAt ? { lastInboundAt: company.lastInboundAt } : {}),
      ...(company.notes ? { notes: company.notes.slice(0, 2000) } : {}),
      sourceType: 'import',
      sourceKey: company.sourceKey || (domain ? `import-org:${domain}` : `import-org:name:${nameKey}`),
    }, actorId);
    if (domain) orgByDomain.set(domain, result.item.id);
    orgByName.set(nameKey, result.item.id);
    if (result.duplicate) created.duplicates += 1;
    else created.companies += 1;
  }

  for (const person of people) {
    const organizationId = resolveOrg(person.organizationDomain);
    const email = typeof person.email === 'string' ? person.email.toLowerCase() : '';
    if (!organizationId || !person.name?.trim() || !EMAIL.test(email)) {
      throw Object.assign(new Error('Invalid person'), { statusCode: 400 });
    }
    const existingId = contactByEmail.get(email);
    if (existingId) {
      created.duplicates += 1;
      continue;
    }
    const result = await createContactAtomic(client, {
      organizationId,
      name: person.name.trim(),
      emails: [email],
      sourceType: 'import',
      sourceKey: person.sourceKey || `import-person:${email}`,
    }, actorId);
    contactByEmail.set(email, result.item.id);
    if (result.duplicate) created.duplicates += 1;
    else created.people += 1;
  }

  const dealIdBySource = new Map<string, string>();
  for (const deal of deals) {
    const organizationId = resolveOrg(deal.organizationDomain);
    if (!organizationId || !DEAL_STATUSES.has(deal.status)) {
      throw Object.assign(new Error('Invalid deal'), { statusCode: 400 });
    }
    if (deal.productKind && !PRODUCT_KINDS.has(deal.productKind)) {
      throw Object.assign(new Error('Invalid deal'), { statusCode: 400 });
    }
    const nextAction = deal.status === 'lost' ? undefined : parseNextAction(deal.nextAction);
    if ((deal.status === 'open' || deal.status === 'agreed') && deal.nextAction !== undefined && nextAction === null) {
      throw Object.assign(new Error('Invalid next action'), { statusCode: 400 });
    }
    const sourceKey = deal.sourceKey || `import-deal:${deal.organizationDomain}:${deal.status}:${deal.amountEur || 0}`;
    if (deal.title !== undefined && (typeof deal.title !== 'string' || deal.title.length > 200)) {
      throw Object.assign(new Error('Invalid deal'), { statusCode: 400 });
    }
    if (deal.agreementDate !== undefined && !realDate(deal.agreementDate)) {
      throw Object.assign(new Error('Invalid deal'), { statusCode: 400 });
    }
    const result = await createDealAtomic(client, {
      organizationId,
      ...(deal.title ? { title: deal.title } : {}),
      status: deal.status,
      productKind: deal.productKind || 'one-off',
      amountEur: deal.amountEur,
      agreementDate: deal.agreementDate,
      nextAction: nextAction || undefined,
      sourceType: 'import',
      sourceKey,
    }, actorId);
    dealIdBySource.set(sourceKey, result.item.id);
    if (result.duplicate) created.duplicates += 1;
    else created.deals += 1;
    for (const deliverable of deal.deliverables || []) {
      if (
        !CHANNELS.has(deliverable.channel)
        || (deliverable.cardId !== undefined && !OPAQUE_ID.test(deliverable.cardId))
        || (deliverable.scheduleEntryId !== undefined && !OPAQUE_ID.test(deliverable.scheduleEntryId))
        || (deliverable.plannedPublicationDate !== undefined && !realDate(deliverable.plannedPublicationDate))
      ) throw Object.assign(new Error('Invalid deliverable'), { statusCode: 400 });
      const made = await createDeliverableAtomic(client, {
        dealId: result.item.id,
        organizationId,
        channel: deliverable.channel,
        plannedPublicationDate: deliverable.plannedPublicationDate,
        materialDeadline: deliverable.materialDeadline,
        publishedAt: deliverable.publishedAt,
        artifactUrls: deliverable.artifactUrls || [],
        ...(deliverable.cardId ? { cardId: deliverable.cardId } : {}),
        ...(deliverable.scheduleEntryId ? { scheduleEntryId: deliverable.scheduleEntryId } : {}),
        sourceType: 'import',
        sourceKey: deliverable.sourceKey || `${sourceKey}:deliverable:${deliverable.channel}:${deliverable.plannedPublicationDate || 'none'}`,
      }, actorId);
      if (made.duplicate) created.duplicates += 1;
      else created.deliverables += 1;
    }
  }

  for (const entry of activity) {
    const organizationId = resolveOrg(entry.organizationDomain);
    const email = typeof entry.personEmail === 'string' ? entry.personEmail.toLowerCase() : '';
    if (
      !organizationId || typeof entry.threadId !== 'string' || !entry.threadId.trim() || entry.threadId.length > 128
      || !['inbound', 'outbound'].includes(entry.direction) || Number.isNaN(Date.parse(entry.sentAt))
      || (email && !EMAIL.test(email))
    ) throw Object.assign(new Error('Invalid activity'), { statusCode: 400 });
    const result = await createCrmRecord(client, 'message', {
      organizationId,
      ...(email && contactByEmail.has(email) ? { contactId: contactByEmail.get(email) } : {}),
      ...(email ? { personEmail: email } : {}),
      threadId: entry.threadId,
      direction: entry.direction,
      snippet: typeof entry.snippet === 'string' ? entry.snippet.slice(0, 500) : '',
      sentAt: entry.sentAt,
      sourceType: 'gmail',
      sourceKey: `gmail:${entry.threadId}:${entry.direction}:${entry.sentAt}`,
    });
    if (result.duplicate) created.duplicates += 1;
    else created.activity += 1;
  }

  for (const lead of leads) {
    if (!lead.name?.trim()) throw Object.assign(new Error('Invalid lead'), { statusCode: 400 });
    const leadKey = lead.sourceKey || `import-lead:${lead.name.toLowerCase()}`;
    if (await getCrmRecord(client, 'lead', deterministicCrmId('lead', leadKey))) {
      created.duplicates += 1;
      continue;
    }
    const result = await createCrmRecord(client, 'lead', {
      messageId: lead.sourceKey || `import-lead:${lead.name}`,
      newsletter: { name: lead.newsletter || 'imported', sender: 'import@example.invalid', subject: lead.name, receivedAt: new Date().toISOString() },
      sponsor: { name: lead.name, url: lead.url || '', blurb: '', context: '', normalizedName: lead.name.toLowerCase(), normalizedUrl: (lead.url || '').toLowerCase() },
      status: 'new',
      active: true,
      sourceType: 'import',
      sourceKey: leadKey,
    });
    if (result.duplicate) created.duplicates += 1;
    else created.leads += 1;
  }

  const existingNewsletters = await listCrmRecords(client, 'newsletter');
  const newsletterBySlug = new Map(existingNewsletters.map((item) => [String(item.slug || ''), item.id]));
  for (const newsletter of newsletters) {
    const error = validateNewsletter(newsletter);
    if (error) throw Object.assign(new Error('Invalid newsletter'), { statusCode: 400 });
    const record = newsletterRecord({ ...newsletter, sourceType: 'import' });
    const slug = String(record.slug);
    if (newsletterBySlug.has(slug)) {
      created.duplicates += 1;
      continue;
    }
    const result = await createCrmRecord(client, 'newsletter', record);
    newsletterBySlug.set(slug, result.item.id);
    if (result.duplicate) created.duplicates += 1;
    else created.newsletters += 1;
  }

  return created;
}
