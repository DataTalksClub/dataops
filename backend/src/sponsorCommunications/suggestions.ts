import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { deterministicCrmId, listCrmRecords } from '../db/sponsorCrm';
import { COMMUNICATION_TYPES, type CommunicationType } from './core';
import { putSuggestion } from './repository';
import type { CommunicationSuggestion } from './types';
import { sponsorReminderTiming, type SponsorReminderTiming } from '../sponsorCrm/alerts';

type Candidate = { type: CommunicationType; occurrenceKey: string; reason: string };
const dayDiff = (from: string, to: string) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function communicationCandidates(
  deal: Record<string, unknown>,
  deliverables: Array<Record<string, unknown>>,
  today: string,
  timing: SponsorReminderTiming,
): Candidate[] {
  if (deal.status === 'lost') return [];
  const candidates: Candidate[] = [];
  if (deal.status === 'agreed' && deal.primaryContactId) {
    candidates.push({ type: 'booking-confirmation', occurrenceKey: 'agreed', reason: 'Deal agreed with an active recipient' });
  }
  for (const deliverable of deliverables) {
    const publication = String(deliverable.plannedPublicationDate || '');
    const deadline = String(deliverable.materialDeadline || '');
    const hasMaterials = Array.isArray(deliverable.artifactUrls) && deliverable.artifactUrls.length > 0;
    const published = String(deliverable.publishedAt || '').slice(0, 10);
    if (deal.status === 'agreed' && publication && !hasMaterials && !published) {
      const days = dayDiff(today, publication);
      if (timing.materialsReminderDays.includes(days)) candidates.push({
        type: 'materials-reminder',
        occurrenceKey: `materials-missing-${days}d:${publication}`,
        reason: `Materials reminder eligible at ${days} days`,
      });
    }
    if (deadline && deadline < today && !hasMaterials) candidates.push({
      type: 'materials-reminder',
      occurrenceKey: `materials-deadline-overdue:${deadline}`,
      reason: 'Materials deadline is overdue',
    });
    if (published && typeof deliverable.requiredLinkUrl === 'string') {
      try {
        const link = new URL(String(deliverable.requiredLinkUrl));
        if (link.protocol === 'https:') candidates.push({
          type: 'publication-live',
          occurrenceKey: `published:${String(deliverable.version)}`,
          reason: 'Publication is live with a public link',
        });
      } catch { /* ineligible */ }
    }
    if (published && dayDiff(published, today) >= timing.followUpDays) candidates.push({
      type: 'performance-follow-up',
      occurrenceKey: `performance-follow-up:${published}`,
      reason: 'Performance follow-up is due',
    });
  }
  return candidates;
}

export async function evaluateCommunicationSuggestions(
  client: DynamoDBDocumentClient,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ created: string[]; existing: string[] }> {
  const deals = await listCrmRecords(client, 'deal');
  const deliverables = await listCrmRecords(client, 'deliverable');
  const timing = await sponsorReminderTiming(client);
  const created: string[] = [];
  const existing: string[] = [];
  for (const deal of deals) {
    const kids = deliverables.filter((item) => item.dealId === deal.id);
    for (const candidate of communicationCandidates(deal, kids, today, timing)) {
      if (!COMMUNICATION_TYPES.includes(candidate.type)) continue;
      const id = deterministicCrmId('communication-suggestion', `${deal.id}:${candidate.type}:${candidate.occurrenceKey}`);
      const now = new Date().toISOString();
      const suggestion: CommunicationSuggestion = {
        id,
        recordType: 'communication-suggestion',
        dealId: deal.id,
        organizationId: String(deal.organizationId),
        communicationType: candidate.type,
        occurrenceKey: candidate.occurrenceKey,
        dealVersion: deal.version,
        eligible: true,
        safeReason: candidate.reason.slice(0, 120),
        status: 'open',
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      const stored = await putSuggestion(client, suggestion);
      (stored.createdAt === now ? created : existing).push(id);
    }
  }
  return { created, existing };
}
