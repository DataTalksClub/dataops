/**
 * Podcast first-contact email (Orin's ask).
 *
 * A pure renderer: given the guest's first name and exactly one proposed
 * recording slot, it returns the send-ready first-contact email sent from
 * Orin's mailbox. It creates nothing: no Card, no hold, no draft. The caller
 * (CLI `dataops podcast invite`) creates the CalendarHold (Google Proposal)
 * and the standalone follow-up Task separately; this module only renders copy.
 *
 * Rules (literal acceptance criteria, t518u):
 * - from is always orin@datatalks.club;
 * - exactly one proposed slot (no slot list, no alternate picker in email);
 * - do NOT ask the guest to invent alternate times in email — slot changes
 *   go through the guest materials form (confirm / free slots / none-fit);
 * - topics/bio via the form (optional short couple-sentences reply still ok);
 * - if a topic is already known, the email can seed from that topic;
 * - links the public podcast docs page and (when available) the guest form;
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
   * "Tuesday, November 4 at 12:30 CET". Exactly one slot: the guest form
   * (not this email) collects alternates / free-slot picks.
   */
  slotLabel: string;
  /** Public guest materials form URL (with access code when available). */
  formUrl?: string;
  /**
   * When the episode topic is already known (e.g. Ian), seed the email from
   * that topic instead of asking the guest to invent one in email.
   */
  topicSeed?: string;
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
  formUrl: string | null;
  topicSeed: string | null;
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
  const formUrl = clean(input.formUrl) || null;
  const topicSeed = clean(input.topicSeed) || null;

  if (!guestFirstName) throw new Error('guestFirstName is required');
  if (guestFirstName.length > 100) throw new Error('guestFirstName is too long');
  if (!slotLabel) throw new Error('slotLabel is required: propose exactly one slot');
  if (slotLabel.length > 200) throw new Error('slotLabel is too long');
  if (!/^https:\/\//.test(docsUrl)) throw new Error('docsUrl must be an https URL');
  if (formUrl && !/^https:\/\//.test(formUrl)) throw new Error('formUrl must be an https URL');
  if (topicSeed && topicSeed.length > 300) throw new Error('topicSeed is too long');

  const subject = `${guestFirstName} at DataTalks.Club Podcast`;
  const lines = [
    `Hi ${guestFirstName},`,
    '',
    `Nice to meet you! I'm ${senderName} and I'm taking care of organizing events at DataTalks.Club.`,
    '',
    'In case you don\'t know about our podcasts, you can read more about them here:',
    '',
    docsUrl,
    '',
  ];

  if (topicSeed) {
    lines.push(
      `We'd love to record an episode with you about ${topicSeed}.`,
      '',
    );
  }

  lines.push(
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
    `For the interview, will ${slotLabel} work for you?`,
    '',
  );

  if (formUrl) {
    lines.push(
      'Please use this short optional form to confirm that time, pick another free recording slot if needed, share a bio, and (if we have not already agreed) the topics you would most enjoy covering:',
      '',
      formUrl,
      '',
      'Or you can just reply to this email in a couple of sentences instead — either way works. Please do not invent alternate times in email; the form lists ordinary free slots and has a “none fit / custom” option.',
      '',
    );
  } else {
    lines.push(
      'Once we have a guest form link for you, you can confirm the time, pick another free recording slot, share a bio, and topics there — or just reply to this email in a couple of sentences. Please do not invent alternate days/times in email; we will share free ordinary slots (midday 12:30 or evening 17:00 Europe/Berlin) via the form.',
      '',
    );
  }

  lines.push('Best,', senderName);

  return {
    from: PODCAST_FIRST_CONTACT_FROM,
    subject,
    body: lines.join('\n'),
    docsUrl,
    formUrl,
    topicSeed,
  };
}

/** Berlin wall-clock label for a hold instant, e.g. "Tuesday, November 4 at 12:30 CET". */
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
