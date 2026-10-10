export const GRACE_USER_ID = '00000000-0000-0000-0000-000000000001';
export const VALERIIA_USER_ID = '00000000-0000-0000-0000-000000000002';
export const ALEXEY_USER_ID = '00000000-0000-0000-0000-000000000003';

export const DEAL_STATUSES = new Set(['open', 'agreed', 'lost']);
export const PRODUCT_KINDS = new Set(['one-off', 'package', 'course']);
export const CHANNELS = new Set(['main', 'secondary', 'standalone', 'social', 'workshop', 'course', 'other']);
export const NEXT_ACTION_TYPES = new Set(['follow_up', 'send_invoice', 'chase_payment', 'chase_materials', 'send_stats', 'other']);
export const LOST_REASONS = new Set(['no_budget', 'no_reply', 'wrong_fit', 'timing', 'other']);
export const MONEY_STATES = ['none', 'invoiced', 'partial', 'paid', 'overdue'] as const;
export type MoneyState = (typeof MONEY_STATES)[number];

export type NextAction = { type: string; due: string; owner: string; note: string };
export type QueueItem = {
  id: string;
  kind: 'relationship' | 'operational';
  why: string;
  action: string;
  companyId: string;
  companyName: string;
  dealId?: string;
  deliverableId?: string;
  invoiceId?: string;
  due: string;
  owner: string;
  href: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function realDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function dayDiff(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export function registrableDomain(urlOrHost: unknown): string | null {
  if (typeof urlOrHost !== 'string' || !urlOrHost.trim()) return null;
  let host = urlOrHost.trim().toLowerCase();
  try {
    if (host.includes('://')) host = new URL(host).hostname;
    else if (host.includes('/') && host.includes('.')) host = new URL(`https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host || host.includes(' ') || !host.includes('.')) return null;
  return host;
}

export function parseNextAction(value: unknown): NextAction | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!NEXT_ACTION_TYPES.has(String(record.type)) || !realDate(record.due) || typeof record.owner !== 'string' || !record.owner.trim() || record.owner.length > 128) {
    return null;
  }
  if (record.note !== undefined && (typeof record.note !== 'string' || record.note.length > 500)) return null;
  return { type: String(record.type), due: String(record.due), owner: String(record.owner).trim(), note: typeof record.note === 'string' ? record.note : '' };
}

export function dealIsRotting(deal: Record<string, unknown>): boolean {
  const status = String(deal.status || '');
  if (status !== 'open' && status !== 'agreed') return false;
  const action = deal.nextAction as NextAction | null | undefined;
  return !action || !action.type || !action.due || !action.owner;
}

export function deriveMoney(invoices: Array<Record<string, unknown>>, today: string): MoneyState {
  if (!invoices.length) return 'none';
  const amounts = invoices.map((item) => Number(item.amountEur || item.amount || 0));
  const paid = invoices.filter((item) => item.paidAt);
  const unpaid = invoices.filter((item) => !item.paidAt);
  if (paid.length === invoices.length) return 'paid';
  if (unpaid.some((item) => realDate(item.due) && String(item.due) < today)) return 'overdue';
  if (paid.length) return 'partial';
  if (amounts.some((value) => value > 0) || invoices.length) return 'invoiced';
  return 'none';
}

export function deriveFulfillment(deliverables: Array<Record<string, unknown>>): 'none' | 'not-started' | 'in-delivery' | 'delivered' {
  if (!deliverables.length) return 'none';
  if (deliverables.every((item) => item.publishedAt)) return 'delivered';
  if (deliverables.some((item) => item.publishedAt || item.plannedPublicationDate)) return 'in-delivery';
  return 'not-started';
}

export function relationshipTag(
  organization: Record<string, unknown>,
  deals: Array<Record<string, unknown>>,
  today: string,
): 'customer' | 'talking' | 'dormant' | 'prospect' {
  const paid = deals.some((deal) => deal.cash === true || deal.money === 'paid');
  const live = deals.some((deal) => deal.status === 'open' || deal.status === 'agreed');
  const last = String(organization.lastInboundAt || organization.lastOutboundAt || '').slice(0, 10);
  const hasLast = Boolean(last && realDate(last));
  const quietDays = hasLast ? dayDiff(last, today) : 0;
  if (paid && hasLast && quietDays > 540) return 'dormant';
  if (paid) return 'customer';
  if (live || (organization.lastOutboundAt && quietDays <= 90)) return 'talking';
  return 'prospect';
}

export function neverContacted(organization: Record<string, unknown>, deals: Array<Record<string, unknown>>): boolean {
  return !organization.lastOutboundAt && !deals.length && relationshipTag(organization, deals, '2099-01-01') === 'prospect';
}

export function defaultOwner(why: string, channel = ''): string {
  if (why === 'yes' || why === 'price' || why === 'lost') return ALEXEY_USER_ID;
  if ((why === 'chase_materials' || why === 'copy') && (channel === 'workshop' || channel === 'course')) return VALERIIA_USER_ID;
  return GRACE_USER_ID;
}

function push(
  items: QueueItem[],
  item: Omit<QueueItem, 'id' | 'href'> & { href?: string },
) {
  const href = item.href || `#/sponsors?companyId=${encodeURIComponent(item.companyId)}`;
  items.push({ ...item, href, id: `${item.kind}:${item.companyId}:${item.dealId || ''}:${item.why}:${item.due}` });
}

export function computeQueue(input: {
  organizations: Array<Record<string, unknown>>;
  deals: Array<Record<string, unknown>>;
  deliverables: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
  today: string;
  actorId: string;
}): QueueItem[] {
  const { organizations, deals, deliverables, invoices, today, actorId } = input;
  const items: QueueItem[] = [];
  const dealsByOrg = new Map<string, Array<Record<string, unknown>>>();
  for (const deal of deals) {
    const organizationId = String(deal.organizationId || '');
    const list = dealsByOrg.get(organizationId) || [];
    list.push(deal);
    dealsByOrg.set(organizationId, list);
  }
  const deliverablesByDeal = new Map<string, Array<Record<string, unknown>>>();
  for (const deliverable of deliverables) {
    const dealId = String(deliverable.dealId || '');
    const list = deliverablesByDeal.get(dealId) || [];
    list.push(deliverable);
    deliverablesByDeal.set(dealId, list);
  }
  const invoicesByDeal = new Map<string, Array<Record<string, unknown>>>();
  for (const invoice of invoices) {
    const dealId = String(invoice.dealId || '');
    const list = invoicesByDeal.get(dealId) || [];
    list.push(invoice);
    invoicesByDeal.set(dealId, list);
  }

  for (const organization of organizations) {
    if (organization.archivedAt) continue;
    const organizationId = String(organization.id);
    const orgDeals = dealsByOrg.get(organizationId) || [];
    if (neverContacted(organization, orgDeals)) continue;
    const name = String(organization.displayName || 'Unknown sponsor');
    const tag = relationshipTag(organization, orgDeals.map((deal) => ({
      ...deal,
      money: deriveMoney(invoicesByDeal.get(String(deal.id)) || [], today),
    })), today);

    const outbound = String(organization.lastOutboundAt || '').slice(0, 10);
    const inbound = String(organization.lastInboundAt || '').slice(0, 10);
    if ((tag === 'talking' || tag === 'customer' || tag === 'dormant') && outbound && realDate(outbound) && dayDiff(outbound, today) >= 10 && (!inbound || inbound < outbound)) {
      push(items, {
        kind: 'relationship',
        why: 'quiet',
        action: 'Follow up',
        companyId: organizationId,
        companyName: name,
        due: today,
        owner: String(organization.owner || GRACE_USER_ID),
      });
    }

    for (const deal of orgDeals) {
      const dealId = String(deal.id);
      const dealInvoices = invoicesByDeal.get(dealId) || [];
      const dealDeliverables = deliverablesByDeal.get(dealId) || [];
      const status = String(deal.status || '');
      if (status === 'lost') continue;
      const action = deal.nextAction as NextAction | null | undefined;
      if (dealIsRotting(deal)) {
        push(items, {
          kind: 'operational',
          why: 'rotting',
          action: 'Set next action',
          companyId: organizationId,
          companyName: name,
          dealId,
          due: today,
          owner: String(deal.owner || defaultOwner('follow_up')),
        });
      } else if (action && action.due <= today) {
        push(items, {
          kind: 'operational',
          why: action.type,
          action: action.note || action.type,
          companyId: organizationId,
          companyName: name,
          dealId,
          due: action.due,
          owner: action.owner,
        });
      }
      if (status === 'agreed' && !dealInvoices.length) {
        const agreedAt = String(deal.agreementDate || deal.createdAt || today).slice(0, 10);
        if (realDate(agreedAt) && dayDiff(agreedAt, today) >= 7) {
          push(items, {
            kind: 'operational',
            why: 'send_invoice',
            action: 'Send invoice',
            companyId: organizationId,
            companyName: name,
            dealId,
            due: today,
            owner: defaultOwner('send_invoice'),
          });
        }
      }
      for (const invoice of dealInvoices) {
        if (!invoice.paidAt && realDate(invoice.due) && String(invoice.due) < today) {
          push(items, {
            kind: 'operational',
            why: 'chase_payment',
            action: 'Chase payment',
            companyId: organizationId,
            companyName: name,
            dealId,
            invoiceId: String(invoice.id),
            due: String(invoice.due),
            owner: defaultOwner('chase_payment'),
          });
        }
      }
      for (const deliverable of dealDeliverables) {
        const publication = String(deliverable.plannedPublicationDate || '');
        const hasMaterials = Array.isArray(deliverable.artifactUrls) && deliverable.artifactUrls.length > 0;
        const channel = String(deliverable.channel || '');
        if (publication && realDate(publication) && !hasMaterials && !deliverable.publishedAt) {
          const days = dayDiff(today, publication);
          if (days <= 14) {
            push(items, {
              kind: 'operational',
              why: 'chase_materials',
              action: 'Get materials',
              companyId: organizationId,
              companyName: name,
              dealId,
              deliverableId: String(deliverable.id),
              due: publication,
              owner: defaultOwner('chase_materials', channel),
            });
          }
        }
        const published = String(deliverable.publishedAt || '').slice(0, 10);
        if (published && realDate(published) && dayDiff(published, today) >= 7 && !deliverable.statsSentAt) {
          push(items, {
            kind: 'operational',
            why: 'send_stats',
            action: 'Send stats',
            companyId: organizationId,
            companyName: name,
            dealId,
            deliverableId: String(deliverable.id),
            due: today,
            owner: defaultOwner('send_stats'),
          });
        }
      }
    }
  }

  return items
    .filter((item) => !item.owner || item.owner === actorId)
    .sort((a, b) => a.due.localeCompare(b.due) || a.companyName.localeCompare(b.companyName) || a.id.localeCompare(b.id));
}
