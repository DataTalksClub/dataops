/**
 * External artifact links: one clean URL per link, and one link per owner.
 *
 * The Trello import stored links exactly as Markdown left them, so the same
 * Luma page arrived as `https://luma.com/x`, `https://luma.com/x](https://luma.com/x`
 * and `[https://luma.com/x](https://luma.com/x)`, with `\_` escapes and
 * tracking parameters along for the ride. Every write path normalises through
 * here, and the one-off cleanup reuses the same rules, so the stored shape is
 * the single shape the UI has to render.
 */

const MARKDOWN_ESCAPE = /\\([\\`*_{}[\]()#+\-.!~|])/g;

/** Query parameters that only ever carry tracking or share-sheet noise. */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'si', 'feature', 'ref', 'ref_src',
]);

/** Google Docs share-sheet parameters; the document id is the identity. */
const GOOGLE_NOISE_PARAMS = new Set(['usp', 'urp', 'ouid', 'rtpof', 'sd', 'pli', 'authuser']);

/** Hosts whose pages are identified by path alone; any query is noise. */
const PATH_IDENTIFIED_HOSTS = [/(^|\.)meetup\.com$/, /(^|\.)luma\.com$/, /(^|\.)lu\.ma$/, /(^|\.)linkedin\.com$/];

export interface ParsedLinkText {
  url: string;
  label?: string;
}

function count(text: string, character: string): number {
  return text.split(character).length - 1;
}

function stripMarkdownTitle(value: string): string {
  // `url "title"` — Markdown's optional link title, often a zero-width char.
  return value.replace(/\s+"[^"]*"\s*$/, '').trim();
}

/**
 * Pull the link target (and a label, when one was written) out of the shapes
 * the import produced: a bare URL, `[label](url)`, and the broken
 * `url](url` / `url]` halves of a link whose opening bracket was lost.
 */
export function parseLinkText(raw: string): ParsedLinkText {
  let text = String(raw || '').trim().replace(/^<(.+)>$/, '$1');
  let label: string | undefined;

  const full = /^\[([^\]]*)\]\((.+)\)$/.exec(text);
  if (full) {
    label = full[1].trim();
    text = full[2];
  } else {
    const split = text.lastIndexOf('](');
    if (split >= 0) {
      const before = text.slice(0, split).replace(/^\[/, '');
      text = text.slice(split + 2);
      if (!/^https?:\/\//i.test(before.replace(MARKDOWN_ESCAPE, '$1'))) label = before.trim();
    }
  }

  text = stripMarkdownTitle(text);
  // A lost opening bracket leaves an unbalanced `]` or `)` at the end.
  text = text.replace(MARKDOWN_ESCAPE, '$1').trim();
  for (;;) {
    if (text.endsWith(']')) text = text.slice(0, -1);
    else if (text.endsWith(')') && count(text, '(') < count(text, ')')) text = text.slice(0, -1);
    else break;
  }

  const cleanLabel = label?.replace(MARKDOWN_ESCAPE, '$1').trim();
  return cleanLabel ? { url: text, label: cleanLabel } : { url: text };
}

/**
 * Canonical form of an external http(s) link, or null when the text does not
 * hold one. Tracking and share-sheet parameters are dropped; the rest of the
 * URL (path, meaningful query, fragment) is kept.
 */
export function normalizeExternalUrl(raw: string): string | null {
  const { url } = parseLinkText(raw);
  if (!/^https?:\/\//i.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname.includes('.')) return null;
  const host = parsed.hostname.toLowerCase();

  if (PATH_IDENTIFIED_HOSTS.some((pattern) => pattern.test(host))) {
    parsed.search = '';
  } else {
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) parsed.searchParams.delete(key);
      if (/(^|\.)google\.com$/.test(host) && GOOGLE_NOISE_PARAMS.has(lower)) parsed.searchParams.delete(key);
    }
    // `tab=t.0` is a Google Doc's first tab, which is where it opens anyway.
    if (host === 'docs.google.com' && parsed.searchParams.get('tab') === 't.0') parsed.searchParams.delete('tab');
  }
  return parsed.toString();
}

/**
 * Identity of a link for duplicate detection: two links that open the same
 * page share a key. Google documents are keyed by their id, so `/edit`,
 * `/edit?tab=…` and `/view` links to one document collapse together.
 */
export function externalLinkKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const googleDoc = /^\/(document|spreadsheets|presentation|forms|file)\/d\/([^/]+)/.exec(parsed.pathname);
  if ((host === 'docs.google.com' || host === 'drive.google.com') && googleDoc) {
    return `google:${googleDoc[1]}:${googleDoc[2]}`;
  }
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${host}${path}${parsed.search}`;
}

/** True when a title is just a URL (or a broken Markdown copy of one). */
export function isUrlLikeTitle(title: string): boolean {
  const { url, label } = parseLinkText(title);
  return !label && /^https?:\/\//i.test(url);
}

/**
 * The title to store for an external link: an operator-written label wins;
 * a URL-shaped title (or none) becomes the clean URL, which the UI renders
 * as a service name plus short identifier rather than the raw address.
 */
export function normalizeExternalTitle(title: unknown, cleanUrl: string): string {
  const text = typeof title === 'string' ? title.trim() : '';
  if (!text) return cleanUrl;
  const { label } = parseLinkText(text);
  if (label) return label;
  if (isUrlLikeTitle(text)) return cleanUrl;
  return text;
}

export interface CardLinkValue {
  name: string;
  url: string;
}

/**
 * A card's named link slots (Luma link, YouTube link...) get the same
 * treatment: a filled URL is stored clean, a slot whose name is just a URL
 * is named by the clean URL, and two slots that point at the same page
 * collapse into the first. Empty and non-URL values (a slot still to fill)
 * pass through untouched.
 */
export function normalizeCardLinks(links: unknown): unknown {
  if (!Array.isArray(links)) return links;
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const link of links) {
    if (!link || typeof link !== 'object' || Array.isArray(link)) {
      result.push(link);
      continue;
    }
    const value = link as Record<string, unknown>;
    const rawUrl = typeof value.url === 'string' ? value.url.trim() : value.url;
    const clean = typeof rawUrl === 'string' && rawUrl ? normalizeExternalUrl(rawUrl) : null;
    if (clean) {
      const key = externalLinkKey(clean);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const name = typeof value.name === 'string' ? value.name : '';
    result.push({
      ...value,
      name: clean && isUrlLikeTitle(name) ? clean : name,
      url: clean || rawUrl,
    });
  }
  return result;
}
