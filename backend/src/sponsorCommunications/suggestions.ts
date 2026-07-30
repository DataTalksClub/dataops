import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { deterministicCrmId, listCrmRecords } from '../db/sponsorCrm';
import { COMMUNICATION_TYPES, type CommunicationType } from './core';
import { putSuggestion } from './repository';
import type { CommunicationSuggestion } from './types';

type Candidate = { type: CommunicationType; occurrenceKey: string; reason: string };
const dayDiff = (from: string, to: string) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function communicationCandidates(booking: Record<string, unknown>, today: string): Candidate[] {
  if (booking.status === 'cancelled' || booking.status === 'complete') return [];
  const candidates: Candidate[] = [];
  const publication = String(booking.plannedPublicationDate || '');
  const deadline = String(booking.materialDeadline || '');
  const hasMaterials = Array.isArray(booking.artifactUrls) && booking.artifactUrls.length > 0;
  if (booking.status === 'confirmed' && booking.primaryContactId) {
    candidates.push({ type: 'booking-confirmation', occurrenceKey: 'confirmed', reason: 'Booking confirmed with an active recipient' });
  }
  if (publication && ['confirmed', 'materials-pending'].includes(String(booking.status)) && !hasMaterials) {
    const days = dayDiff(today, publication);
    if ([14, 10, 3].includes(days)) candidates.push({
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
  if (booking.status === 'published' && typeof booking.requiredLinkUrl === 'string') {
    try {
      const link = new URL(booking.requiredLinkUrl);
      if (link.protocol === 'https:') candidates.push({
        type: 'publication-live',
        occurrenceKey: `published:${String(booking.version)}`,
        reason: 'Publication is live with a public link',
      });
    } catch { /* ineligible */ }
  }
  if (booking.status === 'published' && publication && dayDiff(publication, today) >= 7) candidates.push({
    type: 'performance-follow-up',
    occurrenceKey: `performance-follow-up:${publication}`,
    reason: 'Performance follow-up is due',
  });
  return candidates;
}

export async function evaluateCommunicationSuggestions(
  client: DynamoDBDocumentClient,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ created: string[]; existing: string[] }> {
  const bookings = await listCrmRecords(client, 'booking');
  const created: string[] = [];
  const existing: string[] = [];
  for (const booking of bookings) {
    for (const candidate of communicationCandidates(booking, today)) {
      if (!COMMUNICATION_TYPES.includes(candidate.type)) continue;
      const id = deterministicCrmId('communication-suggestion', `${booking.id}:${candidate.type}:${candidate.occurrenceKey}`);
      const now = new Date().toISOString();
      const suggestion: CommunicationSuggestion = {
        id,
        recordType: 'communication-suggestion',
        bookingId: booking.id,
        organizationId: String(booking.organizationId),
        communicationType: candidate.type,
        occurrenceKey: candidate.occurrenceKey,
        bookingVersion: booking.version,
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
