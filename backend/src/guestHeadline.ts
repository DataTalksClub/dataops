/**
 * The guest headline rule: the website shows every guest as photo + name +
 * "<job title> at <company>" (for example "AI Engineer at IBM"). Both parts are
 * collected from the guest as their own fields so nobody has to cut a title out
 * of the bio.
 *
 * Applied to the guest event forms (webinar, workshop, podcast) on submit and
 * to the People register on every write. Values are trimmed, single-line, at
 * most 80 characters, and never a link.
 */

export const GUEST_HEADLINE_MAX_LENGTH = 80;

export const JOB_TITLE_HELP =
  'Your current role, as we should show it next to your photo on the website. For example: AI Engineer.';

export const COMPANY_HELP =
  'Where you work now. For example: IBM. If you are independent, write "Independent" or your own company name.';

/** A scheme, a www. host, or a host with a path. A bare "Booking.com" is a company name and stays allowed. */
const URL_LIKE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\S\.[a-z]{2,}\/)/i;

/** Why a job title or company value is not acceptable, or "" when it is. */
export function guestHeadlineProblem(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return `${label} is required.`;
  if (/[\r\n]/.test(trimmed)) return `${label} must be a single line.`;
  if (trimmed.length > GUEST_HEADLINE_MAX_LENGTH)
    return `${label} must be at most ${GUEST_HEADLINE_MAX_LENGTH} characters.`;
  if (URL_LIKE.test(trimmed)) return `${label} must be plain text, not a link.`;
  return '';
}

/** The website headline: "AI Engineer at IBM". Empty when either part is missing. */
export function guestHeadline(jobTitle: string | null | undefined, company: string | null | undefined): string {
  const title = (jobTitle || '').trim();
  const where = (company || '').trim();
  return title && where ? `${title} at ${where}` : '';
}
