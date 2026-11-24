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

const LUMA_PAGE_LIMIT = 1024 * 1024;
const LUMA_SUBTITLE_LIMIT = 300;
const LUMA_FETCH_USER_AGENT = 'DataOps/1.0 (DataTalks.Club operations portal)';

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Luma HTML-escapes its meta content (`&#x27;`, `&quot;`, `&amp;`). */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (!body.startsWith('#')) return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** The decoded `content` of the first `<meta property|name="<name>">` tag, in either attribute order. */
function metaContent(html: string, name: string): string | undefined {
  for (const [tag] of html.matchAll(/<meta\s[^>]*>/gi)) {
    if (/\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] !== name) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (content !== undefined) return decodeHtmlEntities(content);
  }
  return undefined;
}

/**
 * The Luma event's own subtitle: the first line of its public `og:description`
 * (`<subtitle> - <speakers>`). Undefined when Luma gives none (a missing,
 * non-public or changed page); the caller decides what a missing subtitle means.
 * Never throws.
 */
export async function lumaEventSubtitle(lumaUrl: string, fetchImpl?: typeof fetch): Promise<string | undefined> {
  try {
    const response = await (fetchImpl || fetch)(lumaUrl, {
      headers: { 'User-Agent': LUMA_FETCH_USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > LUMA_PAGE_LIMIT) return undefined;
    const raw = metaContent((await response.text()).slice(0, LUMA_PAGE_LIMIT), 'og:description')?.split(/\r?\n/)[0];
    const subtitle = raw?.replace(/\s+/g, ' ').trim().slice(0, LUMA_SUBTITLE_LIMIT);
    return subtitle || undefined;
  } catch {
    return undefined;
  }
}
