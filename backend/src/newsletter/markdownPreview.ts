import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { normalizeCardLinks } from '../artifactLinks';
import { getCardConsistent, updateCard } from '../db/cards';
import {
  getNewsletterIssue,
  listNewsletterIssuesByCardId,
  updateNewsletterIssue,
  type NewsletterIssue,
  type NewsletterIssueLink,
  type NewsletterMarkdownKind,
  type NewsletterMarkdownPackage,
} from '../db/newsletterIssues';
import {
  checkSponsorDocRateLimit,
  clearSponsorDocRateLimit,
  decryptSponsorDocAccessCode,
  encryptSponsorDocAccessCode,
  generateSponsorDocAccessCode,
  recordSponsorDocFailedAttempt,
  verifySponsorDocCodeConstantTime,
} from '../db/sponsorDocs';
import { resolveInteractiveActor } from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import { sponsorDocPortalBaseUrl } from '../routes/sponsorDocs';
import type { Card, LambdaEvent, LambdaResponse } from '../types';
import { issueLabel, SLOT_POSITIONS } from './issueCard';

export const NEWSLETTER_MARKDOWN_KINDS: readonly NewsletterMarkdownKind[] = ['issue', 'sources', 'brief'];
export const NEWSLETTER_MARKDOWN_LINK_NAME = 'Newsletter Markdown';
export const MAX_NEWSLETTER_MARKDOWN_LENGTH = 200_000;

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

function json(statusCode: number, body: unknown, extraHeaders?: Record<string, string>): LambdaResponse {
  return {
    statusCode,
    headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function requestIp(event: LambdaEvent): string {
  const forwarded = headerValue(event.headers, 'x-forwarded-for');
  return forwarded.split(',')[0].trim() || 'unknown';
}

function parseBody(rawBody: string | null | undefined): Record<string, unknown> | null {
  if (!rawBody) return {};
  if (typeof rawBody === 'object') return rawBody as Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function newsletterPreviewTargetId(issueId: string): string {
  return `newsletter-preview:${issueId}`;
}

export function newsletterIssuePreviewUrl(event: LambdaEvent | undefined, issueId: string): string {
  const base = event ? sponsorDocPortalBaseUrl(event) : 'https://ops.dtcdev.click';
  return `${base}/newsletter-issues/${encodeURIComponent(issueId)}/preview`;
}

/**
 * Anonymous external requests allowed to reach `GET /api/newsletter-issues/:id/markdown`
 * (or `/preview`), where they are gated by the issue's access code and rate limiter.
 */
export function isAnonymousNewsletterPreviewRequest(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  return /^\/api\/newsletter-issues\/[^/]+\/(?:markdown|preview)\/?$/.test(path);
}

/**
 * Browser page and static assets required to render `/newsletter-issues/:id/preview`
 * for an external viewer without a DataOps session cookie.
 */
export function isAnonymousNewsletterPreviewAsset(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  if (/^\/newsletter-issues\/[^/]+\/preview\/?$/.test(path)) return true;
  return (
    path === '/src/newsletter-preview-page.js'
    || path === '/src/surfaces/operations/newsletter-preview.js'
    || path === '/src/styles/newsletter-preview.css'
    || path === '/src/styles/sponsor-docs.css'
    || path.startsWith('/src/dakit/')
  );
}

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHref(rawUrl: string): string | null {
  const trimmed = String(rawUrl || '').trim();
  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

function renderInlineMarkdown(escapedLine: string): string {
  let out = escapedLine;
  // Inline code: `code`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Images inline: ![alt](src)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, rawSrc: string) => {
    const unescapedSrc = rawSrc.replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(unescapedSrc) || unescapedSrc.startsWith('/')) {
      return `<span class="newsletter-preview-inline-image"><img src="${escapeHtml(unescapedSrc)}" alt="${alt}" loading="lazy"></span>`;
    }
    return `<span class="newsletter-preview-image-note">[Image: ${alt || 'visual'} — ${rawSrc}]</span>`;
  });
  // Links: [label](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, rawUrl: string) => {
    const unescaped = rawUrl.replace(/&amp;/g, '&');
    const safe = sanitizeHref(unescaped);
    if (!safe) return `${label} (${rawUrl})`;
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // Bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic: *text*
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out;
}

/**
 * Safe, zero-dependency Markdown-to-HTML renderer tailored for newsletter
 * issue packages (`issue.md`, `sources.md`, `brief.md`).
 */
export function renderNewsletterMarkdownHtml(markdown: string): string {
  const normalized = String(markdown || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const joined = paragraphLines.join(' ');
    paragraphLines = [];
    // Standalone image block: ![alt](src)
    const imageMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(joined.trim());
    if (imageMatch) {
      const alt = escapeHtml(imageMatch[1].trim());
      const srcRaw = imageMatch[2].trim();
      if (/^https?:\/\//i.test(srcRaw) || srcRaw.startsWith('/')) {
        blocks.push(
          `<figure class="newsletter-preview-figure"><img src="${escapeHtml(srcRaw)}" alt="${alt}" loading="lazy">${alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`,
        );
      } else {
        blocks.push(
          `<div class="newsletter-preview-image-placeholder" role="img" aria-label="${alt || 'Newsletter image'}"><strong>Image: ${alt || 'Newsletter visual'}</strong><span>${escapeHtml(srcRaw)}</span></div>`,
        );
      }
      return;
    }
    // Standalone CTA link block: [Label](https://...)
    const ctaMatch = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/i.exec(joined.trim());
    if (ctaMatch) {
      const label = renderInlineMarkdown(escapeHtml(ctaMatch[1].trim()));
      const safeHref = sanitizeHref(ctaMatch[2].trim());
      if (safeHref) {
        blocks.push(
          `<p class="newsletter-preview-cta"><a class="newsletter-preview-cta__link" href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${label}</a></p>`,
        );
        return;
      }
    }
    blocks.push(`<p>${renderInlineMarkdown(escapeHtml(joined))}</p>`);
  };

  const flushList = () => {
    if (!listType || !listItems.length) return;
    blocks.push(`<${listType}>${listItems.map((item) => `<li>${item}</li>`).join('')}</${listType}>`);
    listType = null;
    listItems = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push('<hr>');
      continue;
    }
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(escapeHtml(headingMatch[2].trim()))}</h${level}>`);
      continue;
    }
    const ulMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      flushParagraph();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(renderInlineMarkdown(escapeHtml(ulMatch[1].trim())));
      continue;
    }
    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      flushParagraph();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(renderInlineMarkdown(escapeHtml(olMatch[1].trim())));
      continue;
    }
    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote>${renderInlineMarkdown(escapeHtml(quoteMatch[1].trim()))}</blockquote>`);
      continue;
    }
    flushList();
    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks.join('\n');
}

export interface ParsedNewsletterIssueMarkdown {
  frontmatter: Record<string, string>;
  subject: string;
  previewText: string;
  bodyMarkdown: string;
  bodyHtml: string;
}

/**
 * Parse `issue.md` into frontmatter metadata, `Subject:` / `Preview:` lines,
 * and rendered HTML email body.
 */
export function parseNewsletterIssueMarkdown(rawIssueMd: string): ParsedNewsletterIssueMarkdown {
  const normalized = String(rawIssueMd || '').replace(/\r\n/g, '\n');
  const frontmatter: Record<string, string> = {};
  let rest = normalized;

  if (rest.startsWith('---\n')) {
    const closingIdx = rest.indexOf('\n---\n', 4);
    if (closingIdx >= 0) {
      const fmBlock = rest.slice(4, closingIdx);
      for (const line of fmBlock.split('\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const key = line.slice(0, colon).trim();
          const val = line.slice(colon + 1).trim();
          if (key) frontmatter[key] = val;
        }
      }
      rest = rest.slice(closingIdx + 5);
    }
  }

  let subject = frontmatter.subject || '';
  let previewText = frontmatter.preview || '';

  const bodyLines: string[] = [];
  let inHeaderPreamble = true;
  for (const line of rest.split('\n')) {
    const trimmed = line.trim();
    if (inHeaderPreamble) {
      if (!trimmed) continue;
      const subjectMatch = /^Subject:\s*(.+)$/i.exec(trimmed);
      if (subjectMatch) {
        subject = subjectMatch[1].trim();
        continue;
      }
      const previewMatch = /^Preview:\s*(.+)$/i.exec(trimmed);
      if (previewMatch) {
        previewText = previewMatch[1].trim();
        continue;
      }
      inHeaderPreamble = false;
    }
    bodyLines.push(line);
  }

  const bodyMarkdown = bodyLines.join('\n').trim();
  return {
    frontmatter,
    subject,
    previewText,
    bodyMarkdown,
    bodyHtml: renderNewsletterMarkdownHtml(bodyMarkdown),
  };
}

/**
 * Strip internal access-code hash/ciphertext from an issue before returning it
 * on `/api/newsletter-issues` and attach staff preview URL metadata when present.
 */
export function publicNewsletterIssueFields<T extends NewsletterIssue>(
  issue: T,
  event?: LambdaEvent,
): Omit<T, 'previewAccessCodeHash' | 'previewAccessCodeCiphertext'> & {
  previewUrl?: string;
  previewShareUrl?: string | null;
  previewAccessCode?: string | null;
} {
  const {
    previewAccessCodeHash: _hash,
    previewAccessCodeCiphertext,
    ...rest
  } = issue;
  const hasMarkdown = Boolean(
    issue.markdown && (issue.markdown.issue || issue.markdown.sources || issue.markdown.brief),
  );
  if (!hasMarkdown && !previewAccessCodeCiphertext) {
    return rest;
  }
  const previewUrl = newsletterIssuePreviewUrl(event, issue.id);
  const accessCode = decryptSponsorDocAccessCode(
    newsletterPreviewTargetId(issue.id),
    previewAccessCodeCiphertext,
  );
  const previewShareUrl = accessCode
    ? `${previewUrl}?code=${encodeURIComponent(accessCode)}`
    : null;
  return {
    ...rest,
    previewUrl,
    previewShareUrl,
    previewAccessCode: accessCode,
  };
}

async function resolveIssueByIdOrCardId(
  client: DynamoDBDocumentClient,
  idOrCardId: string,
): Promise<NewsletterIssue | null> {
  const direct = await getNewsletterIssue(client, idOrCardId);
  if (direct) return direct;
  const byCard = await listNewsletterIssuesByCardId(client, idOrCardId);
  return byCard[0] || null;
}

function extractProvidedPreviewCode(
  event: LambdaEvent,
  body?: Record<string, unknown> | null,
): string {
  const fromPreviewHeader = headerValue(event.headers, 'x-newsletter-preview-code');
  if (fromPreviewHeader) return fromPreviewHeader;
  const fromSponsorHeader = headerValue(event.headers, 'x-sponsor-doc-code');
  if (fromSponsorHeader) return fromSponsorHeader;
  const fromQuery = event.queryStringParameters?.code;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  if (body && typeof body.code === 'string' && body.code.length > 0) return body.code;
  return '';
}

async function resolveStaffOrExternalAccess(
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
  permission: 'work-read' | 'work-write',
  body?: Record<string, unknown> | null,
): Promise<{
  isStaff: boolean;
  staffActorId?: string;
  staffActorName?: string | null;
}> {
  const userIdHeader = headerValue(event.headers, 'x-user-id');
  const forceAnonymous =
    headerValue(event.headers, 'x-newsletter-preview-anonymous') === 'true'
    || headerValue(event.headers, 'x-sponsor-doc-anonymous') === 'true';
  const hasExplicitCode = Boolean(extractProvidedPreviewCode(event, body));
  const skipAuth = process.env.NODE_ENV === 'test' && process.env.SKIP_AUTH === 'true';

  if (!forceAnonymous && (userIdHeader || (skipAuth && !hasExplicitCode))) {
    const resolved = await resolveInteractiveActor(client, event, permission);
    if (resolved.ok) {
      let actorName: string | null = null;
      if (resolved.actor.id) {
        const proj = await new TeamDirectory(client).project(resolved.actor.id);
        actorName = proj.name;
      }
      return {
        isStaff: true,
        staffActorId: resolved.actor.id || 'staff',
        staffActorName: actorName || 'DataOps Staff',
      };
    }
  }
  return { isStaff: false };
}

function buildPreviewResponsePayload(
  issue: NewsletterIssue,
  event: LambdaEvent,
  options: {
    viewerRole: 'staff' | 'external';
    accessCode?: string | null;
  },
) {
  const previewUrl = newsletterIssuePreviewUrl(event, issue.id);
  const md: NewsletterMarkdownPackage = issue.markdown || {};
  const parsedIssue = parseNewsletterIssueMarkdown(md.issue || '');
  const sourcesHtml = renderNewsletterMarkdownHtml(md.sources || '');
  const briefHtml = renderNewsletterMarkdownHtml(md.brief || '');

  const sponsors: Record<string, string> = {};
  for (const pos of SLOT_POSITIONS[issue.kind]) {
    const sp = issue.slots?.[pos]?.sponsor;
    if (sp) sponsors[pos] = sp;
  }

  const basePayload = {
    issueId: issue.id,
    cardId: issue.cardId || null,
    label: issueLabel(issue),
    kind: issue.kind,
    publicationDate: issue.publicationDate,
    publicationTime: issue.publicationTime || null,
    issueNumber: issue.issueNumber ?? null,
    status: issue.status,
    sponsors,
    previewUrl,
    markdown: {
      issue: md.issue || '',
      sources: md.sources || '',
      brief: md.brief || '',
      updatedAt: md.updatedAt || null,
      updatedBy: md.updatedBy || null,
      updatedByName: md.updatedByName || null,
    },
    rendered: {
      frontmatter: parsedIssue.frontmatter,
      subject: parsedIssue.subject,
      previewText: parsedIssue.previewText,
      issueHtml: parsedIssue.bodyHtml,
      sourcesHtml,
      briefHtml,
    },
    version: issue.version,
  };

  if (options.viewerRole === 'staff') {
    const accessCode = options.accessCode || null;
    const shareUrl = accessCode
      ? `${previewUrl}?code=${encodeURIComponent(accessCode)}`
      : null;
    return {
      ...basePayload,
      viewerRole: 'staff' as const,
      shareUrl,
      accessCode,
    };
  }

  return {
    ...basePayload,
    viewerRole: 'external' as const,
  };
}

function updatedIssueLinksWithPreview(
  currentLinks: NewsletterIssueLink[] | undefined,
  previewUrl: string,
): NewsletterIssueLink[] | undefined {
  if (!previewUrl.startsWith('https://')) return currentLinks;
  const list = [...(currentLinks || [])];
  const idx = list.findIndex(
    (item) => item.name.toLowerCase() === NEWSLETTER_MARKDOWN_LINK_NAME.toLowerCase(),
  );
  if (idx >= 0) {
    list[idx] = { name: NEWSLETTER_MARKDOWN_LINK_NAME, url: previewUrl };
  } else {
    list.push({ name: NEWSLETTER_MARKDOWN_LINK_NAME, url: previewUrl });
  }
  return list;
}

async function syncCardNewsletterMarkdownLink(
  client: DynamoDBDocumentClient,
  cardId: string | undefined,
  previewUrl: string,
): Promise<void> {
  if (!cardId) return;
  const card = await getCardConsistent(client, cardId);
  if (!card) return;
  const currentLinks = Array.isArray(card.cardLinks) ? card.cardLinks : [];
  let matched = false;
  const updatedLinks = currentLinks.map((item) => {
    if (String(item.name || '').toLowerCase() === NEWSLETTER_MARKDOWN_LINK_NAME.toLowerCase()) {
      matched = true;
      return { ...item, name: item.name || NEWSLETTER_MARKDOWN_LINK_NAME, url: previewUrl };
    }
    return item;
  });
  if (!matched) {
    updatedLinks.push({ name: NEWSLETTER_MARKDOWN_LINK_NAME, url: previewUrl });
  }
  const nextCardLinks = normalizeCardLinks(updatedLinks) as Card['cardLinks'];
  await updateCard(client, card.id, {
    expectedVersion: card.version,
    patch: { cardLinks: nextCardLinks },
  });
}

async function ensureIssueHasPreviewCode(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
): Promise<{ issue: NewsletterIssue; accessCode: string }> {
  const rateTargetId = newsletterPreviewTargetId(issue.id);
  const existingCode = decryptSponsorDocAccessCode(rateTargetId, issue.previewAccessCodeCiphertext);
  if (issue.previewAccessCodeHash && existingCode) {
    return { issue, accessCode: existingCode };
  }
  const generated = generateSponsorDocAccessCode();
  const ciphertext = encryptSponsorDocAccessCode(rateTargetId, generated.code);
  const updated = await updateNewsletterIssue(client, issue, {
    previewAccessCodeHash: generated.hashHex,
    previewAccessCodeCiphertext: ciphertext,
  });
  return { issue: updated, accessCode: generated.code };
}

export async function handleNewsletterMarkdownRoutes(
  idOrCardId: string,
  action: 'get' | 'put' | 'rotate-code',
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  if (action === 'get') {
    const access = await resolveStaffOrExternalAccess(client, event, 'work-read');
    const existing = await resolveIssueByIdOrCardId(client, idOrCardId);

    if (access.isStaff) {
      if (!existing) return json(404, { error: 'Newsletter issue not found', code: 'issue_not_found' });
      const ensured = await ensureIssueHasPreviewCode(client, existing);
      return json(
        200,
        buildPreviewResponsePayload(ensured.issue, event, {
          viewerRole: 'staff',
          accessCode: ensured.accessCode,
        }),
      );
    }

    const rateTargetId = newsletterPreviewTargetId(existing ? existing.id : idOrCardId);
    const ip = requestIp(event);
    const rate = await checkSponsorDocRateLimit(client, rateTargetId, ip);
    if (!rate.allowed) {
      return json(
        429,
        {
          error: 'Too many failed access code attempts. Please wait and try again.',
          code: 'rate_limited',
          retryAfterSeconds: rate.retryAfterSeconds,
        },
        { 'Retry-After': String(rate.retryAfterSeconds) },
      );
    }

    const providedCode = extractProvidedPreviewCode(event);
    if (!providedCode.trim()) {
      return json(401, {
        error: 'Access code is required to view this newsletter preview.',
        code: 'access_code_required',
      });
    }

    const valid = verifySponsorDocCodeConstantTime(
      providedCode,
      existing?.previewAccessCodeHash || '',
    );
    if (!existing || !valid) {
      const afterFail = await recordSponsorDocFailedAttempt(client, rateTargetId, ip);
      if (!afterFail.allowed) {
        return json(
          429,
          {
            error: 'Too many failed access code attempts. Please wait and try again.',
            code: 'rate_limited',
            retryAfterSeconds: afterFail.retryAfterSeconds,
          },
          { 'Retry-After': String(afterFail.retryAfterSeconds) },
        );
      }
      return json(403, {
        error: 'Invalid access code.',
        code: 'invalid_access_code',
      });
    }

    await clearSponsorDocRateLimit(client, rateTargetId, ip);
    return json(200, buildPreviewResponsePayload(existing, event, { viewerRole: 'external' }));
  }

  if (action === 'rotate-code') {
    const resolved = await resolveInteractiveActor(client, event, 'work-write');
    if (!resolved.ok) return resolved.response;
    const existing = await resolveIssueByIdOrCardId(client, idOrCardId);
    if (!existing) return json(404, { error: 'Newsletter issue not found', code: 'issue_not_found' });

    const generated = generateSponsorDocAccessCode();
    const rateTargetId = newsletterPreviewTargetId(existing.id);
    const ciphertext = encryptSponsorDocAccessCode(rateTargetId, generated.code);
    let updated: NewsletterIssue;
    try {
      updated = await updateNewsletterIssue(client, existing, {
        previewAccessCodeHash: generated.hashHex,
        previewAccessCodeCiphertext: ciphertext,
      });
    } catch {
      return json(409, { error: 'Issue changed; reload and retry' });
    }
    return json(
      200,
      buildPreviewResponsePayload(updated, event, {
        viewerRole: 'staff',
        accessCode: generated.code,
      }),
    );
  }

  // action === 'put'
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  const body = parseBody(event.body);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const existing = await resolveIssueByIdOrCardId(client, idOrCardId);
  if (!existing) return json(404, { error: 'Newsletter issue not found', code: 'issue_not_found' });

  const updates: Partial<Record<NewsletterMarkdownKind, string>> = {};
  if (typeof body.kind === 'string' && body.content !== undefined) {
    const kind = body.kind.trim() as NewsletterMarkdownKind;
    if (!NEWSLETTER_MARKDOWN_KINDS.includes(kind)) {
      return json(400, { error: `Invalid markdown kind "${body.kind}". Must be one of: issue, sources, brief` });
    }
    if (typeof body.content !== 'string') {
      return json(400, { error: 'content must be a string' });
    }
    if (body.content.length > MAX_NEWSLETTER_MARKDOWN_LENGTH) {
      return json(400, { error: `${kind} markdown exceeds maximum length (${MAX_NEWSLETTER_MARKDOWN_LENGTH} characters)` });
    }
    updates[kind] = body.content;
  } else {
    const allowedKeys = new Set<string>([...NEWSLETTER_MARKDOWN_KINDS, 'version']);
    const unknownKey = Object.keys(body).find((k) => !allowedKeys.has(k));
    if (unknownKey) {
      return json(400, { error: `Unknown markdown field: ${unknownKey}` });
    }
    for (const kind of NEWSLETTER_MARKDOWN_KINDS) {
      if (body[kind] !== undefined) {
        if (typeof body[kind] !== 'string') {
          return json(400, { error: `${kind} must be a string` });
        }
        const text = body[kind] as string;
        if (text.length > MAX_NEWSLETTER_MARKDOWN_LENGTH) {
          return json(400, { error: `${kind} markdown exceeds maximum length (${MAX_NEWSLETTER_MARKDOWN_LENGTH} characters)` });
        }
        updates[kind] = text;
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    return json(400, { error: 'Provide at least one of issue, sources, or brief markdown content' });
  }
  if (body.version !== undefined && Number(body.version) !== existing.version) {
    return json(409, { error: 'Issue changed; reload and retry' });
  }

  let actorName: string | null = null;
  if (resolved.actor.id) {
    const proj = await new TeamDirectory(client).project(resolved.actor.id);
    actorName = proj.name;
  }

  const rateTargetId = newsletterPreviewTargetId(existing.id);
  let accessCode = decryptSponsorDocAccessCode(rateTargetId, existing.previewAccessCodeCiphertext);
  let previewAccessCodeHash = existing.previewAccessCodeHash;
  let previewAccessCodeCiphertext = existing.previewAccessCodeCiphertext;
  if (!accessCode || !previewAccessCodeHash) {
    const generated = generateSponsorDocAccessCode();
    accessCode = generated.code;
    previewAccessCodeHash = generated.hashHex;
    previewAccessCodeCiphertext = encryptSponsorDocAccessCode(rateTargetId, generated.code);
  }

  const now = new Date().toISOString();
  const nextMarkdown: NewsletterMarkdownPackage = {
    ...(existing.markdown || {}),
    ...updates,
    updatedAt: now,
    updatedBy: resolved.actor.id || 'staff',
    updatedByName: actorName || 'DataOps Staff',
  };

  const previewUrl = newsletterIssuePreviewUrl(event, existing.id);
  const nextLinks = updatedIssueLinksWithPreview(existing.links, previewUrl);

  let updated: NewsletterIssue;
  try {
    updated = await updateNewsletterIssue(client, existing, {
      markdown: nextMarkdown,
      previewAccessCodeHash,
      previewAccessCodeCiphertext,
      ...(nextLinks ? { links: nextLinks } : {}),
    });
  } catch {
    return json(409, { error: 'Issue changed; reload and retry' });
  }

  await syncCardNewsletterMarkdownLink(client, updated.cardId, previewUrl).catch((err) => {
    console.error('Failed to sync Newsletter Markdown link to Card:', err);
  });

  return json(
    200,
    buildPreviewResponsePayload(updated, event, {
      viewerRole: 'staff',
      accessCode,
    }),
  );
}
