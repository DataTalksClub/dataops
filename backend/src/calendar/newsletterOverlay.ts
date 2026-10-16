import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listNewsletterIssues, type NewsletterIssue } from '../db/newsletterIssues';
import { issueLabel, SLOT_POSITIONS } from '../newsletter/issueCard';
import type { CalendarOverlayItem, CalendarOverlayProvider } from './overlays';

export const NEWSLETTER_OVERLAY = 'newsletter-issues-readonly';

/** Slot state as the calendar shows it: who booked each slot, or open. */
function slotSummary(issue: NewsletterIssue) {
  const slots = (SLOT_POSITIONS[issue.kind] as readonly ('primary' | 'secondary')[]).map((position) => ({
    position,
    sponsor: issue.slots[position]?.sponsor || null,
  }));
  return { slots, booked: slots.filter((slot) => slot.sponsor).length };
}

/**
 * One calendar item per newsletter issue, labelled with its sponsors, e.g.
 * `Weekly #297 · VectorAI DB + Astronomer` or `Weekly #302 · open`: the
 * primary slot (unless the week is cancelled), the secondary once booked. An issue with a slot
 * nobody has booked is offered as available.
 */
export function newsletterOverlayItem(issue: NewsletterIssue): CalendarOverlayItem {
  const summary = slotSummary(issue);
  const names = summary.slots
    .filter((slot) => slot.sponsor || (slot.position === 'primary' && issue.status !== 'cancelled'))
    .map((slot) => slot.sponsor || 'open');
  return {
    provider: NEWSLETTER_OVERLAY,
    id: issue.id,
    startDate: issue.publicationDate,
    endDate: issue.publicationDate,
    label: [issueLabel(issue), names.join(' + ')].filter(Boolean).join(' · '),
    status: issue.status,
    href: `/newsletter?issueId=${encodeURIComponent(issue.id)}`,
    isAvailableSlot: !['sent', 'cancelled'].includes(issue.status) && summary.booked < summary.slots.length,
    newsletter: { kind: issue.kind, issueNumber: issue.issueNumber ?? null, ...summary },
  };
}

export function newsletterCalendarOverlay(client: DynamoDBDocumentClient): CalendarOverlayProvider {
  return {
    name: NEWSLETTER_OVERLAY,
    async project(from, to) {
      const issues = await listNewsletterIssues(client, from, to);
      return { items: issues.map(newsletterOverlayItem), connection: { state: 'connected' } };
    },
  };
}
