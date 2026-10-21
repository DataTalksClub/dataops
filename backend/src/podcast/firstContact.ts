/**
 * Podcast first-contact email (Orin's ask).
 *
 * A pure renderer: given the guest's first name and exactly one proposed
 * recording slot, it returns the send-ready first-contact email sent from
 * Orin's mailbox. It creates nothing: no Card, no hold, no draft. The caller
 * (CLI `dataops podcast invite`) creates the CalendarHold (Google Proposal)
 * and the standalone follow-up Task separately; this module only renders copy.
 *
 * Rules (literal acceptance criteria):
 * - from is always orin@datatalks.club;
 * - exactly one proposed slot (no slot list, no alternate picker in email);
 * - no topic ask: topics are collected later via the optional guest form;
 * - links the public podcast docs page, never the old Google Doc;
 * - mentions no Card and returns no card reference.
 */

export const PODCAST_FIRST_CONTACT_FROM = 'orin@datatalks.club';

export const PODCAST_FIRST_CONTACT_SENDER_NAME = 'Orin';

export const PODCAST_DOCS_URL =
  'https://datatalksclub.github.io/docs/activities/podcast/';

export interface PodcastFirstContactInput {
  /** Guest's first name, used in the subject and greeting. */
  guestFirstName: string;
  /**
   * The single proposed recording slot as a human label, e.g.
   * "Tuesday, November 4 at 16:30 CET". Exactly one slot: the guest form
   * (not this email) collects alternates.
   */
  slotLabel: string;
  /** Override the docs link (tests only); production uses PODCAST_DOCS_URL. */
  docsUrl?: string;
  /** Override the sender display name (tests only). */
  senderName?: string;
}

export interface PodcastFirstContactEmail {
  from: string;
  subject: string;
  body: string;
  docsUrl: string;
}

const BERLIN_TZ = 'Europe/Berlin';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Render the first-contact email. Throws on missing/blank inputs so callers
 * fail loudly instead of sending unresolved template text.
 */
export function renderPodcastFirstContactEmail(
  input: PodcastFirstContactInput,
): PodcastFirstContactEmail {
  const guestFirstName = clean(input.guestFirstName);
  const slotLabel = clean(input.slotLabel);
  const senderName = clean(input.senderName) || PODCAST_FIRST_CONTACT_SENDER_NAME;
  const docsUrl = clean(input.docsUrl) || PODCAST_DOCS_URL;

  if (!guestFirstName) throw new Error('guestFirstName is required');
  if (guestFirstName.length > 100) throw new Error('guestFirstName is too long');
  if (!slotLabel) throw new Error('slotLabel is required: propose exactly one slot');
  if (slotLabel.length > 200) throw new Error('slotLabel is too long');
  if (!/^https:\/\//.test(docsUrl)) throw new Error('docsUrl must be an https URL');

  const subject = `${guestFirstName} at DataTalks.Club Podcast`;
  const body = [
    `Hi ${guestFirstName},`,
    '',
    `Nice to meet you! I'm ${senderName} and I'm taking care of organizing events at DataTalks.Club.`,
    '',
    'In case you don\'t know about our podcasts, you can read more about them here:',
    '',
    docsUrl,
    '',
    'Please share anything you published online that you think will help us prepare for the interview. For example:',
    '',
    '- Blog posts',
    '',
    '- Talks and podcast interviews',
    '',
    '- Social media posts',
    '',
    '- Github repositories',
    '',
    `For the interview, will ${slotLabel} work for you? If not, just reply with one or two alternate days/times and we'll make it work.`,
    '',
    'Once we agree on a time, I\'ll send a short optional form where you can share your bio and the topics you\'d most enjoy covering — or you can just reply to that email in a couple of sentences instead.',
    '',
    'Best,',
    senderName,
  ].join('\n');

  return { from: PODCAST_FIRST_CONTACT_FROM, subject, body, docsUrl };
}

/** Berlin wall-clock label for a hold instant, e.g. "Tuesday, November 4 at 16:30 CET". */
export function formatSlotLabel(startIso: string, timeZone = BERLIN_TZ): string {
  const instant = Date.parse(startIso);
  if (Number.isNaN(instant)) throw new Error('startIso must be a valid ISO instant');
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(new Date(instant));
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(instant));
  return `${date} at ${time}`;
}
