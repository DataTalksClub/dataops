import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createContactAtomic,
  createCrmRecord,
  createDealAtomic,
  createDeliverableAtomic,
  createOrganizationAtomic,
  listCrmRecords,
} from '../db/sponsorCrm';
import { DEAL_STATUSES, PRODUCT_KINDS, parseNextAction, realDate, registrableDomain } from './model';
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
  sourceKey?: string;
};
export type SnapshotDeal = {
  organizationDomain: string;
  status: string;
  productKind?: string;
  amountEur?: number;
  cash?: boolean;
  agreementDate?: string;
  nextAction?: unknown;
  sourceKey?: string;
  deliverables?: SnapshotDeliverable[];
};
export type SnapshotInvoice = {
  dealSourceKey: string;
  amountEur: number;
  due?: string;
  paidAt?: string;
  sourceKey?: string;
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
  invoices?: SnapshotInvoice[];
  leads?: SnapshotLead[];
  newsletters?: SnapshotNewsletter[];
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function importCrmSnapshot(client: DynamoDBDocumentClient, snapshot: CrmSnapshot, actorId: string) {
  const companies = snapshot.companies || [];
  const people = snapshot.people || [];
  const deals = snapshot.deals || [];
  const invoices = snapshot.invoices || [];
  const leads = snapshot.leads || [];
  const newsletters = snapshot.newsletters || [];
  if (companies.length + people.length + deals.length + invoices.length + leads.length + newsletters.length > 10_000) {
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
  const created = { companies: 0, people: 0, deals: 0, invoices: 0, leads: 0, newsletters: 0, duplicates: 0 };
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
    const result = await createDealAtomic(client, {
      organizationId,
      status: deal.status,
      productKind: deal.productKind || 'one-off',
      amountEur: deal.amountEur,
      cash: deal.cash === true,
      agreementDate: deal.agreementDate,
      nextAction: nextAction || undefined,
      sourceType: 'import',
      sourceKey,
    }, actorId);
    dealIdBySource.set(sourceKey, result.item.id);
    if (result.duplicate) created.duplicates += 1;
    else created.deals += 1;
    for (const deliverable of deal.deliverables || []) {
      await createDeliverableAtomic(client, {
        dealId: result.item.id,
        organizationId,
        channel: deliverable.channel,
        plannedPublicationDate: deliverable.plannedPublicationDate,
        materialDeadline: deliverable.materialDeadline,
        publishedAt: deliverable.publishedAt,
        artifactUrls: deliverable.artifactUrls || [],
        sourceType: 'import',
        sourceKey: deliverable.sourceKey || `${sourceKey}:deliverable:${deliverable.channel}:${deliverable.plannedPublicationDate || 'none'}`,
      }, actorId);
    }
  }

  for (const invoice of invoices) {
    const dealId = dealIdBySource.get(invoice.dealSourceKey);
    if (!dealId || typeof invoice.amountEur !== 'number') {
      throw Object.assign(new Error('Invalid invoice'), { statusCode: 400 });
    }
    if (invoice.due && !realDate(invoice.due)) throw Object.assign(new Error('Invalid invoice'), { statusCode: 400 });
    const result = await createCrmRecord(client, 'invoice', {
      dealId,
      amountEur: invoice.amountEur,
      due: invoice.due,
      paidAt: invoice.paidAt,
      sourceType: 'import',
      sourceKey: invoice.sourceKey || `import-invoice:${invoice.dealSourceKey}`,
    });
    if (result.duplicate) created.duplicates += 1;
    else created.invoices += 1;
  }

  for (const lead of leads) {
    if (!lead.name?.trim()) throw Object.assign(new Error('Invalid lead'), { statusCode: 400 });
    const result = await createCrmRecord(client, 'lead', {
      messageId: lead.sourceKey || `import-lead:${lead.name}`,
      newsletter: { name: lead.newsletter || 'imported', sender: 'import@example.invalid', subject: lead.name, receivedAt: new Date().toISOString() },
      sponsor: { name: lead.name, url: lead.url || '', blurb: '', context: '', normalizedName: lead.name.toLowerCase(), normalizedUrl: (lead.url || '').toLowerCase() },
      status: 'new',
      active: true,
      sourceType: 'import',
      sourceKey: lead.sourceKey || `import-lead:${lead.name.toLowerCase()}`,
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
