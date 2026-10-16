/**
 * Booking a newsletter slot through the Sponsors tab's records.
 *
 * Sponsors are tracked as deals with deliverables. Booking a slot records a
 * deliverable on the sponsor's deal for that issue and slot (the deliverable
 * points at the issue with `newsletterIssueId`; its channel names the slot)
 * and writes the sponsor's name onto the slot. Releasing a slot, or changing
 * its sponsor, withdraws the slot's deliverable: it stays on the deal, marked
 * withdrawn, and no longer books anything.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  createDealAtomic,
  createDeliverableAtomic,
  getCrmRecord,
  listCrmRecords,
  updateDeliverableAtomic,
  type CrmRecord,
} from '../db/sponsorCrm';
import type { NewsletterIssue, NewsletterIssueKind, NewsletterSlotPosition } from '../db/newsletterIssues';

/** The deliverable channel of each slot. */
export const SLOT_CHANNEL: Record<NewsletterIssueKind, Partial<Record<NewsletterSlotPosition, string>>> = {
  weekly: { primary: 'main', secondary: 'secondary' },
  standalone: { primary: 'standalone' },
};

/** The slot a deliverable of `channel` books on an issue of `kind`, if any. */
export function channelSlot(kind: NewsletterIssueKind, channel: unknown): NewsletterSlotPosition | null {
  const entry = Object.entries(SLOT_CHANNEL[kind]).find(([, value]) => value === channel);
  return entry ? entry[0] as NewsletterSlotPosition : null;
}

const live = (record: CrmRecord) => !record.archivedAt;

/** The deliverables that book the issue's slots, withdrawn ones excluded. */
export async function issueDeliverables(client: DynamoDBDocumentClient, issueId: string): Promise<CrmRecord[]> {
  return (await listCrmRecords(client, 'deliverable')).filter((item) => item.newsletterIssueId === issueId && live(item));
}

/** Who a slot can be booked for: each live deal, and each organization without one. */
export async function sponsorOptions(client: DynamoDBDocumentClient) {
  const [organizations, deals] = await Promise.all([
    listCrmRecords(client, 'organization'),
    listCrmRecords(client, 'deal'),
  ]);
  const names = new Map(organizations.filter(live).map((org) => [org.id, String(org.displayName || '')]));
  const liveDeals = deals.filter((deal) => live(deal) && ['open', 'agreed'].includes(String(deal.status)) && names.has(String(deal.organizationId)));
  const withDeal = new Set(liveDeals.map((deal) => String(deal.organizationId)));
  return [
    ...liveDeals.map((deal) => ({
      dealId: deal.id,
      organizationId: String(deal.organizationId),
      name: names.get(String(deal.organizationId))!,
      dealTitle: typeof deal.title === 'string' ? deal.title : '',
      dealStatus: String(deal.status),
    })),
    ...[...names].filter(([id]) => !withDeal.has(id)).map(([organizationId, name]) => ({ organizationId, name })),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

export type SponsorChoice = { dealId: string } | { organizationId: string };

export type ResolvedSponsor = { deal: CrmRecord; name: string; created: boolean };

/**
 * The deal a booking goes on: the chosen live deal, or a new open deal for
 * an organization that has none.
 */
export async function resolveSponsorDeal(
  client: DynamoDBDocumentClient,
  choice: SponsorChoice,
  actorId: string,
  dealTitle: string,
): Promise<ResolvedSponsor | { error: string }> {
  if ('dealId' in choice) {
    const deal = await getCrmRecord(client, 'deal', choice.dealId);
    if (!deal || deal.archivedAt || deal.status === 'lost') return { error: 'Choose a live deal' };
    const org = await getCrmRecord(client, 'organization', String(deal.organizationId));
    if (!org || org.archivedAt) return { error: 'The deal has no live organization' };
    return { deal, name: String(org.displayName), created: false };
  }
  const org = await getCrmRecord(client, 'organization', choice.organizationId);
  if (!org || org.archivedAt) return { error: 'Choose a live organization' };
  const created = await createDealAtomic(client, {
    organizationId: org.id,
    status: 'open',
    productKind: 'one-off',
    title: dealTitle,
    active: true,
    sourceType: 'portal',
    historyNote: 'Deal created by booking a newsletter slot',
  }, actorId);
  return { deal: created.item, name: String(org.displayName), created: true };
}

/** Record the deliverable that books `position` on `issue` for `deal`. */
export async function createSlotDeliverable(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
  position: NewsletterSlotPosition,
  deal: CrmRecord,
  actorId: string,
): Promise<CrmRecord> {
  const created = await createDeliverableAtomic(client, {
    dealId: deal.id,
    organizationId: deal.organizationId,
    channel: SLOT_CHANNEL[issue.kind][position],
    plannedPublicationDate: issue.publicationDate,
    newsletterIssueId: issue.id,
    active: true,
    sourceType: 'portal',
  }, actorId);
  return created.item;
}

/** Withdraw a deliverable: it stays on the deal and stops booking the slot. */
export async function withdrawDeliverable(client: DynamoDBDocumentClient, deliverable: CrmRecord, actorId: string) {
  const now = new Date().toISOString();
  return updateDeliverableAtomic(client, deliverable, { archivedAt: now, withdrawnAt: now, active: false }, actorId);
}

/** Withdraw every live deliverable booking `position` on `issue`, except `keepId`. */
export async function withdrawSlotDeliverables(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
  position: NewsletterSlotPosition,
  actorId: string,
  keepId?: string,
): Promise<string[]> {
  const withdrawn: string[] = [];
  for (const deliverable of await issueDeliverables(client, issue.id)) {
    if (deliverable.id === keepId || channelSlot(issue.kind, deliverable.channel) !== position) continue;
    await withdrawDeliverable(client, deliverable, actorId);
    withdrawn.push(deliverable.id);
  }
  return withdrawn;
}

/** Keep the issue's deliverables on the issue's date after it moves. */
export async function moveIssueDeliverables(client: DynamoDBDocumentClient, issue: NewsletterIssue, actorId: string) {
  for (const deliverable of await issueDeliverables(client, issue.id)) {
    if (deliverable.plannedPublicationDate === issue.publicationDate || deliverable.publishedAt) continue;
    await updateDeliverableAtomic(client, deliverable, { plannedPublicationDate: issue.publicationDate }, actorId);
  }
}
