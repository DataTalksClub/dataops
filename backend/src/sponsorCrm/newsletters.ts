import { dayDiff, realDate } from './model';

export const NEWSLETTER_STATUSES = new Set(['subscribed', 'pending', 'paused', 'unsubscribed']);
export const NEWSLETTER_HEALTH = [
  'overdue',
  'missing',
  'pending',
  'waiting',
  'current',
  'paused',
  'unsubscribed',
] as const;
export type NewsletterHealth = (typeof NEWSLETTER_HEALTH)[number];

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEALTH_RANK: Record<NewsletterHealth, number> = {
  overdue: 0,
  missing: 1,
  pending: 2,
  waiting: 3,
  current: 4,
  paused: 5,
  unsubscribed: 6,
};

export function slugifyNewsletter(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return slug;
}

export function parseSenders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const senders: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !EMAIL.test(entry.trim()) || entry.length > 254) return null;
    const email = entry.trim().toLowerCase();
    if (!senders.includes(email)) senders.push(email);
  }
  return senders;
}

export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function newsletterGraceDays(expectedIntervalDays: number): number {
  return Math.max(expectedIntervalDays + 2, Math.ceil(expectedIntervalDays * 1.5));
}

export function newsletterHealth(record: Record<string, unknown>, today: string): NewsletterHealth {
  const status = String(record.subscriptionStatus || '');
  if (status === 'paused' || status === 'unsubscribed' || status === 'pending') return status;
  const interval = Number(record.expectedIntervalDays);
  const grace = Number.isFinite(interval) && interval > 0 ? newsletterGraceDays(interval) : 9;
  const last = String(record.lastReceivedAt || '').slice(0, 10);
  if (last && realDate(last)) return dayDiff(last, today) > grace ? 'overdue' : 'current';
  const start = String(record.subscribedAt || record.createdAt || today).slice(0, 10);
  const origin = realDate(start) ? start : today;
  return dayDiff(origin, today) > grace ? 'missing' : 'waiting';
}

export function publicNewsletter(
  record: Record<string, unknown>,
  today: string,
): Record<string, unknown> & { health: NewsletterHealth } {
  return { ...record, health: newsletterHealth(record, today) };
}

export function sortNewsletters(items: Array<Record<string, unknown>>, today: string) {
  return [...items].sort((left, right) => {
    const leftHealth = newsletterHealth(left, today);
    const rightHealth = newsletterHealth(right, today);
    return HEALTH_RANK[leftHealth] - HEALTH_RANK[rightHealth]
      || String(left.name || '').localeCompare(String(right.name || ''))
      || String(left.id || '').localeCompare(String(right.id || ''));
  });
}

export function matchNewsletterBySender(
  newsletters: Array<Record<string, unknown>>,
  sender: string,
): Record<string, unknown> | null {
  const email = sender.trim().toLowerCase();
  const matches = newsletters.filter((item) => Array.isArray(item.senders) && item.senders.includes(email));
  return matches.length === 1 ? matches[0] : null;
}

export function validateNewsletter(body: Record<string, unknown>, partial = false): string {
  if ((!partial && typeof body.name !== 'string') || (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200))) {
    return 'Invalid name';
  }
  if (body.slug !== undefined && (typeof body.slug !== 'string' || !SLUG.test(body.slug))) return 'Invalid slug';
  if (!partial && !body.slug && typeof body.name === 'string' && !SLUG.test(slugifyNewsletter(body.name))) return 'Invalid slug';
  if ((!partial && body.url === undefined) || (body.url !== undefined && !httpsUrl(body.url))) return 'Invalid url';
  if (body.mailbox !== undefined && (typeof body.mailbox !== 'string' || !EMAIL.test(body.mailbox.trim()) || body.mailbox.length > 254)) {
    return 'Invalid mailbox';
  }
  if (body.senders !== undefined && parseSenders(body.senders) === null) return 'Invalid senders';
  if (body.cadence !== undefined && (typeof body.cadence !== 'string' || !body.cadence.trim() || body.cadence.length > 80)) {
    return 'Invalid cadence';
  }
  if ((!partial && body.expectedIntervalDays === undefined)
    || (body.expectedIntervalDays !== undefined && (typeof body.expectedIntervalDays !== 'number' || !Number.isInteger(body.expectedIntervalDays) || body.expectedIntervalDays < 1 || body.expectedIntervalDays > 90))) {
    return 'Invalid expectedIntervalDays';
  }
  if ((!partial && body.subscriptionStatus === undefined)
    || (body.subscriptionStatus !== undefined && !NEWSLETTER_STATUSES.has(String(body.subscriptionStatus)))) {
    return 'Invalid subscriptionStatus';
  }
  if (body.subscribedAt !== undefined && body.subscribedAt !== null && !realDate(String(body.subscribedAt).slice(0, 10))) {
    return 'Invalid subscribedAt';
  }
  if (body.lastReceivedAt !== undefined && body.lastReceivedAt !== null && Number.isNaN(Date.parse(String(body.lastReceivedAt)))) {
    return 'Invalid lastReceivedAt';
  }
  if (body.lastSubject !== undefined && (typeof body.lastSubject !== 'string' || body.lastSubject.length > 300)) {
    return 'Invalid lastSubject';
  }
  if (body.lastSender !== undefined && (typeof body.lastSender !== 'string' || (body.lastSender && !EMAIL.test(body.lastSender)))) {
    return 'Invalid lastSender';
  }
  if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 2000)) return 'Invalid notes';
  return '';
}

export function newsletterRecord(body: Record<string, unknown>): Record<string, unknown> {
  const name = String(body.name || '').trim();
  const slug = typeof body.slug === 'string' && SLUG.test(body.slug) ? body.slug : slugifyNewsletter(name);
  const senders = body.senders === undefined ? [] : parseSenders(body.senders) || [];
  const mailbox = typeof body.mailbox === 'string' && EMAIL.test(body.mailbox.trim())
    ? body.mailbox.trim().toLowerCase()
    : 'newsletter@dtcdev.click';
  return {
    name,
    slug,
    url: httpsUrl(body.url) || '',
    mailbox,
    senders,
    cadence: typeof body.cadence === 'string' && body.cadence.trim() ? body.cadence.trim() : 'Weekly',
    expectedIntervalDays: Number(body.expectedIntervalDays),
    subscriptionStatus: String(body.subscriptionStatus),
    subscribedAt: body.subscribedAt ? String(body.subscribedAt).slice(0, 10) : undefined,
    lastReceivedAt: body.lastReceivedAt ? String(body.lastReceivedAt) : undefined,
    lastSubject: typeof body.lastSubject === 'string' ? body.lastSubject : undefined,
    lastSender: typeof body.lastSender === 'string' ? body.lastSender.trim().toLowerCase() : undefined,
    lastMessageId: typeof body.lastMessageId === 'string' ? body.lastMessageId : undefined,
    notes: typeof body.notes === 'string' ? body.notes : undefined,
    sourceKey: typeof body.sourceKey === 'string' && body.sourceKey.trim() ? body.sourceKey.trim() : `newsletter:${slug}`,
    sourceType: typeof body.sourceType === 'string' ? body.sourceType : 'portal',
  };
}

export function newsletterPatch(existing: Record<string, unknown>, body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  if (body.name !== undefined) next.name = String(body.name).trim();
  if (body.slug !== undefined) next.slug = body.slug;
  if (body.url !== undefined) next.url = httpsUrl(body.url);
  if (body.mailbox !== undefined) next.mailbox = String(body.mailbox).trim().toLowerCase();
  if (body.senders !== undefined) next.senders = parseSenders(body.senders);
  if (body.cadence !== undefined) next.cadence = String(body.cadence).trim();
  if (body.expectedIntervalDays !== undefined) next.expectedIntervalDays = body.expectedIntervalDays;
  if (body.subscriptionStatus !== undefined) next.subscriptionStatus = body.subscriptionStatus;
  if (body.subscribedAt !== undefined) next.subscribedAt = body.subscribedAt ? String(body.subscribedAt).slice(0, 10) : undefined;
  if (body.lastReceivedAt !== undefined) next.lastReceivedAt = body.lastReceivedAt || undefined;
  if (body.lastSubject !== undefined) next.lastSubject = body.lastSubject || undefined;
  if (body.lastSender !== undefined) next.lastSender = body.lastSender ? String(body.lastSender).trim().toLowerCase() : undefined;
  if (body.notes !== undefined) next.notes = body.notes || undefined;
  return next;
}
