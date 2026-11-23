/**
 * Operating identities: the mailboxes and calendars DataOps acts as or on.
 *
 * Sender, owner calendars, required attendees, denied attendees and blocked
 * recipients used to be literals at their point of use, so the same rule
 * could be written twice and drift. Every caller reads them from here.
 * Whether these move to workspace settings is a separate product decision.
 */

/** Mailbox that operational mail is sent from and calendar events are organised by. */
export const OPERATIONS_SENDER = 'orin@datatalks.club';

/** The owner's work address. */
export const OWNER_WORK_EMAIL = 'alexey@datatalks.club';

/** The owner's personal Google calendar (also an invite attendee). */
export const OWNER_PERSONAL_CALENDAR = 'alexey.s.grigoriev@gmail.com';

/** The sponsor-document reviewer; never a podcast hold attendee. */
export const SPONSOR_DOC_REVIEWER = 'valeriia@datatalks.club';

/** Addresses no DataOps send path may mail. */
export const BLOCKED_RECIPIENTS: readonly string[] = ['grace@datatalks.club'];

/** True when `email` (any case, surrounding whitespace ignored) must never be mailed. */
export function isBlockedRecipient(email: string | null | undefined): boolean {
  const normalized = (email || '').trim().toLowerCase();
  return BLOCKED_RECIPIENTS.includes(normalized);
}

/**
 * DataTalks.Club's own CRM organization. A newsletter slot booked for it
 * advertises one of our own courses: the advertiser is the owner, nobody is
 * invoiced and no sponsor mailbox is emailed.
 */
export const OWN_ORGANIZATION_ID = 'bcc73320-6d89-4a62-9ff0-e1d65eac877f';
export const OWN_ORGANIZATION_NAME = 'DataTalks.Club';

/** The advertiser of an own-course slot, as the sponsor email names and greets them. */
export const OWN_COURSE_ADVERTISER = {
  name: 'Alexey Grigorev',
  greetingName: 'Alexey',
  email: OWNER_WORK_EMAIL,
} as const;

/** True when a booking (organization id and/or sponsor name) is DataTalks.Club itself. */
export function isOwnOrganization(booking: { organizationId?: string | null; name?: string | null }): boolean {
  if (String(booking.organizationId || '').trim() === OWN_ORGANIZATION_ID) return true;
  return String(booking.name || '').trim().toLowerCase() === OWN_ORGANIZATION_NAME.toLowerCase();
}
