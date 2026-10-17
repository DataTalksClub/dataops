import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { browserAuthOrigin } from '../auth/browserAuth';
import { normalizeCardLinks } from '../artifactLinks';
import { cardTemplateType, hydrateStructuredCardFields } from '../cards/cardTitleStructure';
import { getTemplateIdByType } from '../cards/createCard';
import { getCardConsistent, updateCard } from '../db/cards';
import { listNewsletterIssuesByCardId } from '../db/newsletterIssues';
import {
  checkSponsorDocRateLimit,
  clearSponsorDocRateLimit,
  createSponsorDoc,
  decryptSponsorDocAccessCode,
  deleteSponsorDoc,
  getSponsorDocWithAuthMaterial,
  listAllSponsorDocSummaries,
  listSponsorDocSummariesByCardId,
  recordSponsorDocFailedAttempt,
  rotateSponsorDocAccessCode,
  updateSponsorDoc,
  verifySponsorDocCodeConstantTime,
  type SponsorDoc,
  type SponsorDocStatus,
} from '../db/sponsorDocs';
import { resolveInteractiveActor } from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import { projectCard } from '../identity/projections';
import { recordRequestError } from '../requestErrorLog';
import {
  SPONSOR_DOC_TEMPLATES,
  getSponsorDocTemplate,
  isSponsorDocTemplateKey,
  renderSponsorDocMarkdownExport,
  renderSponsorEmailDraft,
  type SponsorDocTemplateKey,
} from '../sponsorDocs/templates';
import type { Card, LambdaEvent, LambdaResponse } from '../types';

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

function requestIp(event: LambdaEvent): string {
  const forwarded = headerValue(event.headers, 'x-forwarded-for');
  return forwarded.split(',')[0].trim() || 'unknown';
}

export function sponsorDocPortalBaseUrl(event: LambdaEvent): string {
  const browserOrigin = browserAuthOrigin();
  if (browserOrigin) return browserOrigin.replace(/\/$/, '');
  const configured = process.env.DATAOPS_PORTAL_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  const host = headerValue(event.headers, 'x-forwarded-host') || headerValue(event.headers, 'host');
  const forwardedProto = headerValue(event.headers, 'x-forwarded-proto');
  if (host) {
    const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    const proto = forwardedProto || (isLoopback ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  return 'https://ops.dtcdev.click';
}

/**
 * Anonymous external sponsor requests are allowed to reach `/api/sponsor-docs/:id`
 * (`GET` and `PUT`) and `/api/sponsor-docs/:id/export` (`GET`), where they are
 * gated by the document's per-doc access code and rate limiter.
 */
export function isAnonymousSponsorDocRequest(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if ((m === 'GET' || m === 'PUT') && /^\/api\/sponsor-docs\/[^/]+\/?$/.test(path)) {
    const segment = path.replace(/^\/api\/sponsor-docs\//, '').replace(/\/$/, '');
    return segment !== 'templates';
  }
  if (m === 'GET' && /^\/api\/sponsor-docs\/[^/]+\/export\/?$/.test(path)) {
    return true;
  }
  return false;
}

/**
 * Browser page and static assets required to render the standalone `/sponsor-docs/:id`
 * editor for an external sponsor who has no DataOps portal session cookie.
 */
export function isAnonymousSponsorDocAsset(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  if (/^\/sponsor-docs\/[^/]+\/?$/.test(path)) return true;
  return (
    path === '/src/sponsor-doc-page.js'
    || path === '/src/surfaces/operations/sponsor-docs.js'
    || path === '/src/styles/sponsor-docs.css'
    || path === '/src/dakit/dakit.css'
    || path === '/src/dakit/device-code.js'
    || path.startsWith('/src/dakit/fonts/')
  );
}

function extractProvidedAccessCode(
  event: LambdaEvent,
  body?: Record<string, unknown> | null,
): string {
  const fromHeader = headerValue(event.headers, 'x-sponsor-doc-code');
  if (fromHeader) return fromHeader;
  const fromQuery = event.queryStringParameters?.code;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  if (body && typeof body.code === 'string' && body.code.length > 0) return body.code;
  return '';
}

async function inferTemplateForCard(
  client: DynamoDBDocumentClient,
  card: Card,
  slotHint?: string,
): Promise<SponsorDocTemplateKey> {
  if (slotHint === 'secondary') return 'newsletter-secondary';
  if (slotHint === 'primary' || slotHint === 'main') return 'newsletter-main';
  if (slotHint === 'standalone' || slotHint === 'stand-alone') return 'newsletter-standalone';

  const templateIdByType = await getTemplateIdByType(client);
  const cType = cardTemplateType(card, templateIdByType);
  const combinedText = `${card.title || ''} ${(card.tags || []).join(' ')} ${card.description || ''}`.toLowerCase();

  if (cType === 'podcast' || /\bpodcast\b/.test(combinedText)) {
    return 'podcast';
  }

  const issues = await listNewsletterIssuesByCardId(client, card.id);
  if (issues.length > 0) {
    const issue = issues[0];
    if (issue.kind === 'standalone') return 'newsletter-standalone';
    if (
      issue.kind === 'weekly'
      && !issue.slots?.primary?.sponsor
      && issue.slots?.secondary?.sponsor
    ) {
      return 'newsletter-secondary';
    }
  }

  if (/\bstand-?alone\b|\bdedicated\b/.test(combinedText)) {
    return 'newsletter-standalone';
  }
  if (/\bsecondary\b/.test(combinedText)) {
    return 'newsletter-secondary';
  }
  return 'newsletter-main';
}

function buildDocResponsePayload(
  doc: SponsorDoc,
  event: LambdaEvent,
  options: {
    viewerRole: 'staff' | 'sponsor';
    accessCode?: string | null;
  },
) {
  const base = sponsorDocPortalBaseUrl(event);
  const docUrl = `${base}/sponsor-docs/${encodeURIComponent(doc.id)}`;
  const templateDefinition = getSponsorDocTemplate(doc.template);
  const markdownExport = renderSponsorDocMarkdownExport(doc);

  if (options.viewerRole === 'staff') {
    const accessCode = options.accessCode || null;
    const shareUrl = accessCode
      ? `${docUrl}?code=${encodeURIComponent(accessCode)}`
      : null;
    const emailDraft = accessCode && shareUrl
      ? renderSponsorEmailDraft({
        template: doc.template,
        sponsorName: doc.sponsorName,
        publicationDate: doc.publicationDate,
        shareUrl,
        accessCode,
      })
      : null;
    return {
      ...doc,
      viewerRole: 'staff' as const,
      templateDefinition,
      docUrl,
      shareUrl,
      accessCode,
      emailDraft,
      markdownExport,
    };
  }

  return {
    ...doc,
    viewerRole: 'sponsor' as const,
    templateDefinition,
    docUrl,
    markdownExport,
  };
}

async function resolveStaffOrSponsorAccess(
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
  const forceAnonymous = headerValue(event.headers, 'x-sponsor-doc-anonymous') === 'true';
  const hasExplicitCode = Boolean(extractProvidedAccessCode(event, body));
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

async function verifyExternalCodeForDoc(
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
  docId: string,
  providedCode: string,
): Promise<
  | { ok: true; doc: SponsorDoc }
  | { ok: false; response: LambdaResponse }
> {
  const ip = requestIp(event);
  const rate = await checkSponsorDocRateLimit(client, docId, ip);
  if (!rate.allowed) {
    return {
      ok: false,
      response: json(
        429,
        {
          error: 'Too many failed access code attempts. Please wait and try again.',
          code: 'rate_limited',
          retryAfterSeconds: rate.retryAfterSeconds,
        },
        { 'Retry-After': String(rate.retryAfterSeconds) },
      ),
    };
  }

  const loaded = await getSponsorDocWithAuthMaterial(client, docId);
  if (!providedCode.trim()) {
    return {
      ok: false,
      response: json(401, {
        error: 'Access code is required to view or edit this sponsor document.',
        code: 'access_code_required',
      }),
    };
  }

  const valid = verifySponsorDocCodeConstantTime(
    providedCode,
    loaded ? loaded.accessCodeHash : '',
  );
  if (!loaded || !valid) {
    const afterFail = await recordSponsorDocFailedAttempt(client, docId, ip);
    if (!afterFail.allowed) {
      return {
        ok: false,
        response: json(
          429,
          {
            error: 'Too many failed access code attempts. Please wait and try again.',
            code: 'rate_limited',
            retryAfterSeconds: afterFail.retryAfterSeconds,
          },
          { 'Retry-After': String(afterFail.retryAfterSeconds) },
        ),
      };
    }
    return {
      ok: false,
      response: json(403, {
        error: 'Invalid access code.',
        code: 'invalid_access_code',
      }),
    };
  }

  await clearSponsorDocRateLimit(client, docId, ip);
  return { ok: true, doc: loaded.doc };
}

export async function handleSponsorDocRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/sponsor-docs')) return null;

  try {
    const suffix = path.slice('/api/sponsor-docs'.length);
    const m = method.toUpperCase();

    // GET /api/sponsor-docs/templates
    if (m === 'GET' && /^\/templates\/?$/.test(suffix)) {
      const actor = await resolveInteractiveActor(client, event, 'work-read');
      if (!actor.ok) return actor.response;
      return json(200, { templates: Object.values(SPONSOR_DOC_TEMPLATES) });
    }

    // Collection: GET /api/sponsor-docs, POST /api/sponsor-docs
    if (suffix === '' || suffix === '/') {
      if (m === 'GET') {
        const actor = await resolveInteractiveActor(client, event, 'work-read');
        if (!actor.ok) return actor.response;
        const cardId = (event.queryStringParameters?.cardId || '').trim();
        const docs = cardId
          ? await listSponsorDocSummariesByCardId(client, cardId)
          : await listAllSponsorDocSummaries(client);
        const base = sponsorDocPortalBaseUrl(event);
        return json(200, {
          docs: docs.map((d) => ({
            ...d,
            docUrl: `${base}/sponsor-docs/${encodeURIComponent(d.id)}`,
          })),
        });
      }

      if (m === 'POST') {
        const actor = await resolveInteractiveActor(client, event, 'work-write');
        if (!actor.ok) return actor.response;
        const body = parseBody(event.body);
        if (!body) return json(400, { error: 'Invalid JSON body' });

        const cardId = typeof body.cardId === 'string' ? body.cardId.trim() : '';
        if (!cardId) {
          return json(400, { error: 'cardId is required', code: 'missing_card_id' });
        }

        const existingCard = await getCardConsistent(client, cardId);
        if (!existingCard) {
          return json(404, { error: 'Card not found', code: 'card_not_found' });
        }

        const templateIdByType = await getTemplateIdByType(client);
        const hydratedCard: Card = { ...existingCard };
        hydrateStructuredCardFields(hydratedCard, templateIdByType);

        let template: SponsorDocTemplateKey;
        if (body.template !== undefined && body.template !== null && String(body.template).trim() !== '') {
          const requested = String(body.template).trim();
          if (!isSponsorDocTemplateKey(requested)) {
            return json(400, {
              error: `Invalid template "${requested}". Must be one of: newsletter-main, newsletter-secondary, newsletter-standalone, podcast`,
              code: 'invalid_template',
            });
          }
          template = requested;
        } else {
          const slotHint = typeof body.slot === 'string' ? body.slot.trim().toLowerCase() : undefined;
          template = await inferTemplateForCard(client, existingCard, slotHint);
        }

        const publicationDate = typeof body.publicationDate === 'string' && body.publicationDate.trim()
          ? body.publicationDate.trim()
          : (hydratedCard.anchorDate ? String(hydratedCard.anchorDate).slice(0, 10) : null);

        let sponsorName: string | null = null;
        if (typeof body.sponsorName === 'string' && body.sponsorName.trim()) {
          sponsorName = body.sponsorName.trim();
        } else if (template === 'newsletter-secondary') {
          sponsorName = hydratedCard.secondarySponsors?.[0] || hydratedCard.sponsor || null;
        } else if (template === 'podcast') {
          sponsorName = hydratedCard.people?.[0] || hydratedCard.sponsor || null;
        } else {
          sponsorName = hydratedCard.sponsor || hydratedCard.people?.[0] || null;
        }

        let title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
          if (publicationDate && sponsorName) {
            title = `${publicationDate} - ${sponsorName}`;
          } else if (publicationDate && hydratedCard.title) {
            title = `${publicationDate} - ${hydratedCard.title}`;
          } else {
            title = hydratedCard.title || getSponsorDocTemplate(template).label;
          }
        }

        const linkType = typeof body.linkType === 'string' && body.linkType.trim()
          ? body.linkType.trim()
          : getSponsorDocTemplate(template).defaultLinkType;

        const directory = new TeamDirectory(client);
        const staffProj = actor.actor.id ? await directory.project(actor.actor.id) : null;

        const { doc, accessCode } = await createSponsorDoc(client, {
          cardId: existingCard.id,
          template,
          title,
          sponsorName,
          publicationDate,
          linkType,
          content: body.content && typeof body.content === 'object' && !Array.isArray(body.content)
            ? (body.content as Record<string, unknown>)
            : undefined,
          createdBy: actor.actor.id || 'staff',
          createdByName: staffProj?.name || 'DataOps Staff',
        });

        const base = sponsorDocPortalBaseUrl(event);
        const docUrl = `${base}/sponsor-docs/${encodeURIComponent(doc.id)}`;
        const currentLinks = Array.isArray(existingCard.cardLinks) ? existingCard.cardLinks : [];
        let matchedSlot = false;
        const updatedLinks = currentLinks.map((item) => {
          if (String(item.name || '').toLowerCase() === linkType.toLowerCase()) {
            matchedSlot = true;
            return { ...item, name: item.name || linkType, url: docUrl };
          }
          return item;
        });
        if (!matchedSlot) {
          updatedLinks.push({ name: linkType, url: docUrl });
        }
        const nextCardLinks = normalizeCardLinks(updatedLinks) as Card['cardLinks'];

        const updatedCard = await updateCard(client, existingCard.id, {
          expectedVersion: existingCard.version,
          patch: { cardLinks: nextCardLinks },
        });
        const projectedCard = await projectCard(directory, updatedCard, undefined, templateIdByType);

        return json(201, {
          doc: buildDocResponsePayload(doc, event, { viewerRole: 'staff', accessCode }),
          card: projectedCard,
        });
      }

      return json(405, { error: 'Method not allowed' });
    }

    // GET /api/sponsor-docs/:id/export
    const exportMatch = suffix.match(/^\/([^/]+)\/export\/?$/);
    if (exportMatch) {
      if (m !== 'GET') return json(405, { error: 'Method not allowed' });
      const docId = decodeURIComponent(exportMatch[1]);
      const access = await resolveStaffOrSponsorAccess(client, event, 'work-read');
      let doc: SponsorDoc;
      if (access.isStaff) {
        const loaded = await getSponsorDocWithAuthMaterial(client, docId);
        if (!loaded) return json(404, { error: 'Sponsor document not found', code: 'sponsor_doc_not_found' });
        doc = loaded.doc;
      } else {
        const verified = await verifyExternalCodeForDoc(
          client,
          event,
          docId,
          extractProvidedAccessCode(event),
        );
        if (!verified.ok) return verified.response;
        doc = verified.doc;
      }

      const markdown = renderSponsorDocMarkdownExport(doc);
      const format = (event.queryStringParameters?.format || 'json').toLowerCase();
      if (format === 'markdown' || format === 'md' || format === 'text') {
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          },
          body: markdown,
        };
      }
      return json(200, {
        id: doc.id,
        cardId: doc.cardId,
        title: doc.title,
        template: doc.template,
        status: doc.status,
        lastEditedAt: doc.lastEditedAt,
        lastEditedBy: doc.lastEditedBy,
        markdown,
      });
    }

    // POST /api/sponsor-docs/:id/rotate-code
    const rotateMatch = suffix.match(/^\/([^/]+)\/rotate-code\/?$/);
    if (rotateMatch) {
      if (m !== 'POST') return json(405, { error: 'Method not allowed' });
      const actor = await resolveInteractiveActor(client, event, 'work-write');
      if (!actor.ok) return actor.response;
      const docId = decodeURIComponent(rotateMatch[1]);
      const rotated = await rotateSponsorDocAccessCode(client, docId);
      if (!rotated) {
        return json(404, { error: 'Sponsor document not found', code: 'sponsor_doc_not_found' });
      }
      return json(200, {
        doc: buildDocResponsePayload(rotated.doc, event, {
          viewerRole: 'staff',
          accessCode: rotated.accessCode,
        }),
      });
    }

    // Single resource: GET, PUT, DELETE /api/sponsor-docs/:id
    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch) {
      const docId = decodeURIComponent(idMatch[1]);

      if (m === 'GET') {
        const access = await resolveStaffOrSponsorAccess(client, event, 'work-read');
        if (access.isStaff) {
          const loaded = await getSponsorDocWithAuthMaterial(client, docId);
          if (!loaded) {
            return json(404, { error: 'Sponsor document not found', code: 'sponsor_doc_not_found' });
          }
          const accessCode = decryptSponsorDocAccessCode(docId, loaded.accessCodeCiphertext);
          return json(200, {
            doc: buildDocResponsePayload(loaded.doc, event, {
              viewerRole: 'staff',
              accessCode,
            }),
          });
        }

        const verified = await verifyExternalCodeForDoc(
          client,
          event,
          docId,
          extractProvidedAccessCode(event),
        );
        if (!verified.ok) return verified.response;
        return json(200, {
          doc: buildDocResponsePayload(verified.doc, event, { viewerRole: 'sponsor' }),
        });
      }

      if (m === 'PUT') {
        const body = parseBody(event.body);
        if (!body) return json(400, { error: 'Invalid JSON body' });

        if (body.status !== undefined && body.status !== 'draft' && body.status !== 'submitted') {
          return json(400, {
            error: 'status must be "draft" or "submitted"',
            code: 'invalid_status',
          });
        }
        if (body.content !== undefined && (!body.content || typeof body.content !== 'object' || Array.isArray(body.content))) {
          return json(400, {
            error: 'content must be an object mapping template field keys to strings',
            code: 'invalid_content',
          });
        }

        const access = await resolveStaffOrSponsorAccess(client, event, 'work-write', body);
        if (access.isStaff) {
          const loaded = await getSponsorDocWithAuthMaterial(client, docId);
          if (!loaded) {
            return json(404, { error: 'Sponsor document not found', code: 'sponsor_doc_not_found' });
          }
          const updated = await updateSponsorDoc(client, docId, {
            title: typeof body.title === 'string' ? body.title : undefined,
            sponsorName: body.sponsorName !== undefined ? (body.sponsorName as string | null) : undefined,
            publicationDate: body.publicationDate !== undefined ? (body.publicationDate as string | null) : undefined,
            content: body.content as Record<string, unknown> | undefined,
            status: body.status as SponsorDocStatus | undefined,
            actorKind: 'staff',
            actorUserId: access.staffActorId || null,
            actorName: access.staffActorName || 'DataOps Staff',
          });
          const accessCode = decryptSponsorDocAccessCode(docId, loaded.accessCodeCiphertext);
          return json(200, {
            doc: buildDocResponsePayload(updated!, event, {
              viewerRole: 'staff',
              accessCode,
            }),
          });
        }

        const verified = await verifyExternalCodeForDoc(
          client,
          event,
          docId,
          extractProvidedAccessCode(event, body),
        );
        if (!verified.ok) return verified.response;

        const updated = await updateSponsorDoc(client, docId, {
          content: body.content as Record<string, unknown> | undefined,
          status: body.status as SponsorDocStatus | undefined,
          actorKind: 'sponsor',
        });
        return json(200, {
          doc: buildDocResponsePayload(updated!, event, { viewerRole: 'sponsor' }),
        });
      }

      if (m === 'DELETE') {
        const actor = await resolveInteractiveActor(client, event, 'work-write');
        if (!actor.ok) return actor.response;
        const deleted = await deleteSponsorDoc(client, docId);
        if (!deleted) {
          return json(404, { error: 'Sponsor document not found', code: 'sponsor_doc_not_found' });
        }
        // Clean up the Card's link if it points at this sponsor doc
        const card = await getCardConsistent(client, deleted.cardId);
        if (card && Array.isArray(card.cardLinks)) {
          const suffixPath = `/sponsor-docs/${encodeURIComponent(deleted.id)}`;
          let changed = false;
          const nextLinks = card.cardLinks.map((item) => {
            if (String(item.url || '').endsWith(suffixPath)) {
              changed = true;
              return { ...item, url: '' };
            }
            return item;
          });
          if (changed) {
            await updateCard(client, card.id, {
              expectedVersion: card.version,
              patch: { cardLinks: nextLinks },
            });
          }
        }
        return json(200, { deleted: { id: deleted.id, cardId: deleted.cardId, title: deleted.title } });
      }

      return json(405, { error: 'Method not allowed' });
    }

    return json(404, { error: 'Not found' });
  } catch (err: unknown) {
    recordRequestError(err);
    return json(500, { error: 'Internal server error' });
  }
}
