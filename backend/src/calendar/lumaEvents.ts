import { normalizeExternalUrl } from '../artifactLinks';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { liveBackReferences } from '../db/taskCardLinks';
import type { Card } from '../types';

export function lumaUrlFromText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw) return null;
  const normalized = normalizeExternalUrl(raw);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'luma.com' || host.endsWith('.luma.com') || host === 'lu.ma' || host.endsWith('.lu.ma')) {
      return normalized;
    }
  } catch {
    // A malformed or non-HTTP URL is not a Luma event link.
  }
  return null;
}

/** The first saved Luma event link on a Card, if one exists. */
export function lumaUrlForCard(card: Pick<Card, 'cardLinks' | 'references'>): string | null {
  for (const link of [...(card.cardLinks || []), ...(card.references || [])]) {
    const url = lumaUrlFromText(link.url);
    if (url) return url;
  }
  return null;
}

/** True when an event Task's link is a Luma page. */
export function isLumaEventLink(raw: unknown): boolean {
  return Boolean(lumaUrlFromText(raw));
}

/**
 * A course can keep the Luma URL on its event Task while the linked event
 * Card carries the time and Google entries. Resolve either saved location.
 */
export async function lumaUrlForEventCard(
  client: DynamoDBDocumentClient,
  card: Card,
): Promise<string | null> {
  const own = lumaUrlForCard(card);
  if (own) return own;
  for (const { task } of await liveBackReferences(client, card.id, card.linkedFrom)) {
    const url = lumaUrlFromText(task.link);
    if (url) return url;
  }
  return null;
}
