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
