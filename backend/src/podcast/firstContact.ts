/** Approved first-contact copy and guest-thread reply helpers. Rendering creates no records and sends no mail. */
export const PODCAST_FIRST_CONTACT_FROM = 'orin@datatalks.club';
export const PODCAST_GUEST_OBSERVER_CC = 'alexey@datatalks.club';
export const PODCAST_FIRST_CONTACT_CC = [PODCAST_GUEST_OBSERVER_CC] as const;
export const PODCAST_DOCS_URL = 'https://datatalksclub.github.io/docs/activities/podcast/';

const BERLIN_TZ = 'Europe/Berlin';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORBIDDEN_PODCAST_RECIPIENTS = new Set([
  'grace@datatalks.club',
  'alexey.s.grigoriev@gmail.com',
  'valeriia@datatalks.club',
]);

/**
 * Enforce the single podcast guest observer Cc (`alexey@datatalks.club`).
 * Strips sender/guest duplicates and rejects forbidden extra recipients.
 */
export function normalizePodcastGuestCc(
  cc?: readonly string[],
  recipientEmail?: string,
): string[] {
  const guest = (recipientEmail || '').trim().toLowerCase();
  for (const raw of cc || []) {
    const addr = String(raw || '').trim().toLowerCase();
    if (!addr) continue;
    if (!EMAIL_PATTERN.test(addr) || /[\r\n]/.test(addr)) {
      throw new Error(`Invalid podcast Cc email address: ${raw}`);
    }
    if (FORBIDDEN_PODCAST_RECIPIENTS.has(addr)) {
      throw new Error(`Forbidden podcast guest recipient in Cc: ${addr}`);
    }
    if (addr !== PODCAST_GUEST_OBSERVER_CC && addr !== PODCAST_FIRST_CONTACT_FROM && addr !== guest) {
      throw new Error(`Unexpected extra podcast Cc recipient: ${addr}; only ${PODCAST_GUEST_OBSERVER_CC} is allowed`);
    }
  }
  return [PODCAST_GUEST_OBSERVER_CC];
}

export interface PodcastGuestReplyInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  cc?: readonly string[];
}

export interface PreparedPodcastGuestReply {
  from: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}

/**
 * Prepare an Orin-driven reply in a podcast guest thread.
 * Preserves the guest `To:`, enforces `Cc: alexey@datatalks.club` with no extra
 * recipients, and normalizes the `Re:` subject prefix without sending mail.
 */
export function preparePodcastGuestReply(input: PodcastGuestReplyInput): PreparedPodcastGuestReply {
  const to = String(input.to || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(to) || /[\r\n]/.test(to)) {
    throw new Error('A valid single-line guest recipient email is required');
  }
  if (FORBIDDEN_PODCAST_RECIPIENTS.has(to) || to === PODCAST_FIRST_CONTACT_FROM || to === PODCAST_GUEST_OBSERVER_CC) {
    throw new Error(`Invalid podcast guest recipient: ${to}`);
  }
  const rawSubject = String(input.subject || '').trim();
  if (!rawSubject || /[\r\n]/.test(rawSubject)) {
    throw new Error('A single-line thread subject is required');
  }
  const body = String(input.body || '').replace(/\r\n/g, '\n').trim();
  if (!body) {
    throw new Error('A non-empty reply body is required');
  }
  const cc = normalizePodcastGuestCc(input.cc, to);
  const subject = /^re:\s*/i.test(rawSubject) ? rawSubject.replace(/^re:\s*/i, 'Re: ') : `Re: ${rawSubject}`;
  const threadId = input.threadId?.trim() || undefined;
  const inReplyTo = input.inReplyTo?.trim() || undefined;
  if ((threadId && /[\r\n]/.test(threadId)) || (inReplyTo && /[\r\n]/.test(inReplyTo))) {
    throw new Error('Thread identifiers must be single-line');
  }
  return {
    from: PODCAST_FIRST_CONTACT_FROM,
    to,
    cc,
    subject,
    body,
    ...(threadId ? { threadId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
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
    year: 'numeric',
    timeZone,
  }).format(new Date(instant)).replace(',', '');
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(instant));
  return `${date} at ${time}`;
}
