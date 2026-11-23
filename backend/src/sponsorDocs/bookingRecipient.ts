/**
 * Who a newsletter sponsor document's email is for, read from the slot's
 * current booking.
 *
 * The recipient is the booking contact: the contact named on the booked
 * deal, else the organization's designated primary contact. It is never
 * just any contact that happens to belong to the booked organization, and it
 * is derived again on every read, so rebooking a slot changes who the email
 * greets. A slot booked for DataTalks.Club itself advertises one of our own
 * courses: the advertiser is the owner, and the reviewer is not copied.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  getNewsletterIssue,
  listNewsletterIssuesByCardId,
  type NewsletterIssue,
  type NewsletterSlotPosition,
} from '../db/newsletterIssues';
import { getCrmRecord, listCrmRecords, type CrmRecord } from '../db/sponsorCrm';
import { isOwnOrganization, OWN_COURSE_ADVERTISER } from '../identity/operatingIdentities';
import { channelSlot, issueDeliverables } from '../newsletter/slotBooking';
import type { SponsorDocTemplateKey } from './templates';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SponsorDocBookingSource = 'own-course' | 'deal-contact' | 'organization-primary-contact' | 'none';

export interface SponsorDocBooking {
  /** The advertiser the email names: the booked sponsor, or the owner for an own-course slot. */
  advertiserName: string | null;
  organizationId: string | null;
  /** The slot is booked for DataTalks.Club itself. */
  ownCourse: boolean;
  /** The booking contact the email goes to; null when the booking names none. */
  contact: { email: string; name?: string } | null;
  source: SponsorDocBookingSource;
}

export function isNewsletterDocTemplate(template: SponsorDocTemplateKey): boolean {
  return template === 'newsletter-main' || template === 'newsletter-secondary' || template === 'newsletter-standalone';
}

function slotPosition(template: SponsorDocTemplateKey): NewsletterSlotPosition {
  return template === 'newsletter-secondary' ? 'secondary' : 'primary';
}

const live = (record: CrmRecord | null | undefined): record is CrmRecord =>
  Boolean(record) && !record!.archivedAt && record!.active !== false;

function contactAddress(contact: CrmRecord): { email: string; name?: string } | null {
  const email = (Array.isArray(contact.emails) ? contact.emails : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .find((value) => EMAIL_PATTERN.test(value));
  if (!email) return null;
  const name = String(contact.name || '').trim();
  return { email, ...(name ? { name } : {}) };
}

async function ownerIssue(client: DynamoDBDocumentClient, cardId: string): Promise<NewsletterIssue | null> {
  if (!cardId) return null;
  const [byCard] = await listNewsletterIssuesByCardId(client, cardId);
  return byCard || await getNewsletterIssue(client, cardId);
}

/**
 * The current booking of a newsletter document's slot; null for documents
 * that are not newsletter sponsor documents.
 */
export async function resolveSponsorDocBooking(
  client: DynamoDBDocumentClient,
  doc: { cardId: string; template: SponsorDocTemplateKey; sponsorName?: string | null },
): Promise<SponsorDocBooking | null> {
  if (!isNewsletterDocTemplate(doc.template)) return null;
  const issue = await ownerIssue(client, doc.cardId).catch(() => null);
  const position = slotPosition(doc.template);
  const slot = issue?.slots?.[position];
  const sponsor = String(slot?.sponsor || doc.sponsorName || '').trim() || null;
  let organizationId = String(slot?.organizationId || '').trim() || null;

  if (isOwnOrganization({ organizationId, name: sponsor })) {
    return {
      advertiserName: OWN_COURSE_ADVERTISER.name,
      organizationId,
      ownCourse: true,
      contact: { email: OWN_COURSE_ADVERTISER.email, name: OWN_COURSE_ADVERTISER.greetingName },
      source: 'own-course',
    };
  }

  const none = (): SponsorDocBooking => ({ advertiserName: sponsor, organizationId, ownCourse: false, contact: null, source: 'none' });
  try {
    if (issue) {
      const deliverables = (await issueDeliverables(client, issue.id))
        .filter((deliverable) => channelSlot(issue.kind, deliverable.channel) === position);
      for (const deliverable of deliverables) {
        organizationId ||= String(deliverable.organizationId || '').trim() || null;
        const deal = deliverable.dealId ? await getCrmRecord(client, 'deal', String(deliverable.dealId)) : null;
        if (!deal || deal.archivedAt) continue;
        const contactIds = [deal.primaryContactId, deal.contactId, ...(Array.isArray(deal.contactIds) ? deal.contactIds : [])]
          .map((id) => String(id || '').trim())
          .filter(Boolean);
        for (const contactId of [...new Set(contactIds)]) {
          const contact = await getCrmRecord(client, 'contact', contactId);
          const address = live(contact) ? contactAddress(contact) : null;
          if (address) return { advertiserName: sponsor, organizationId, ownCourse: false, contact: address, source: 'deal-contact' };
        }
      }
    }
    if (!organizationId && sponsor) {
      const wanted = sponsor.toLowerCase();
      const org = (await listCrmRecords(client, 'organization'))
        .find((record) => !record.archivedAt && String(record.displayName || record.name || '').trim().toLowerCase() === wanted);
      organizationId = org?.id || null;
    }
    if (organizationId) {
      const primary = (await listCrmRecords(client, 'contact'))
        .find((contact) => contact.organizationId === organizationId && contact.primary === true && live(contact) && contactAddress(contact));
      if (primary) {
        return {
          advertiserName: sponsor,
          organizationId,
          ownCourse: false,
          contact: contactAddress(primary),
          source: 'organization-primary-contact',
        };
      }
    }
  } catch {
    // CRM unavailable: no booking contact, so nothing is addressed.
  }
  return none();
}
