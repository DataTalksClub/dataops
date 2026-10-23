import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { browserAuthOrigin } from '../auth/browserAuth';
import { normalizeCardLinks } from '../artifactLinks';
import { cardTemplateType, hydrateStructuredCardFields } from '../cards/cardTitleStructure';
import { getTemplateIdByType } from '../cards/createCard';
import { getCardConsistent, updateCard } from '../db/cards';
import {
  getNewsletterIssue,
  listNewsletterIssuesByCardId,
  updateNewsletterIssue,
  type NewsletterIssue,
  type NewsletterSlotPosition,
} from '../db/newsletterIssues';
import { getPodcastEpisode, listPodcastEpisodes, type PodcastEpisode } from '../db/podcastEpisodes';
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
  SponsorDocValidationError,
  getSponsorDocTemplate,
  hydratePodcastGuestSlotOptions,
  isSponsorDocTemplateKey,
  renderSponsorDocMarkdownExport,
  renderSponsorEmailDraft,
  type SponsorDocTemplateKey,
} from '../sponsorDocs/templates';
import { listNextRecordingSlots } from '../podcast/resolveRecordingSlot';
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

/** Canonical public materials page for each event or sponsorship template. */
export function sponsorDocPathForTemplate(template: string | null | undefined): string {
  if (template === 'webinar') return '/webinar-docs';
  return template === 'podcast' ? '/podcast-docs' : '/sponsor-docs';
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
  if (/^\/(sponsor-docs|podcast-docs|guest-docs|webinar-docs)\/[^/]+\/?$/.test(path)) return true;
  return (
    path === '/src/sponsor-doc-page.js'
    || path === '/src/surfaces/operations/sponsor-docs.js'
    || path === '/src/surfaces/operations/sponsor-doc-gate.js'
    || path === '/src/surfaces/operations/sponsor-doc-select.js'
    || path === '/src/surfaces/operations/sponsor-doc-radio.js'
    || path === '/src/surfaces/operations/sponsor-doc-bullets.js'
    || path === '/src/styles/sponsor-docs.css'
    || path.startsWith('/src/dakit/')
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

  if (cType === 'webinar' || cType === 'podcast') return cType;
  if (/\bwebinar\b/.test(combinedText)) return 'webinar';

  if (/\bpodcast\b/.test(combinedText)) {
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

async function buildDocResponsePayload(
  doc: SponsorDoc,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  options: {
    viewerRole: 'staff' | 'sponsor';
    accessCode?: string | null;
  },
) {
  const base = sponsorDocPortalBaseUrl(event);
  const docPath = sponsorDocPathForTemplate(doc.template);
  const docUrl = `${base}${docPath}/${encodeURIComponent(doc.id)}`;
  let templateDefinition = getSponsorDocTemplate(doc.template);
  if (doc.template === 'podcast') {
    try {
      const next = await listNextRecordingSlots(client, 6);
      const proposedLabel = String(doc.content?.proposedSlotLabel || '').trim() || null;
      templateDefinition = hydratePodcastGuestSlotOptions(
        templateDefinition,
        next.slots || [],
        proposedLabel,
      );
    } catch {
      // Keep static confirm/none-fit options if occupancy load fails.
    }
  }
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
        error: 'Access code is required to view or edit this document.',
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
            docUrl: `${base}${sponsorDocPathForTemplate(d.template)}/${encodeURIComponent(d.id)}`,
          })),
        });
      }

      if (m === 'POST') {
        const actor = await resolveInteractiveActor(client, event, 'work-write');
        if (!actor.ok) return actor.response;
        const body = parseBody(event.body);
        if (!body) return json(400, { error: 'Invalid JSON body' });

        const rawTargetId = typeof body.cardId === 'string' && body.cardId.trim()
          ? body.cardId.trim()
          : typeof body.issueId === 'string' && body.issueId.trim()
            ? body.issueId.trim()
            : typeof body.episodeId === 'string' && body.episodeId.trim()
              ? body.episodeId.trim()
              : '';
        if (!rawTargetId) {
          return json(400, { error: 'cardId is required', code: 'missing_card_id' });
        }

        let existingCard = await getCardConsistent(client, rawTargetId);
        let existingIssue: NewsletterIssue | null = null;
        let existingEpisode: PodcastEpisode | null = null;

        if (existingCard) {
          const issues = await listNewsletterIssuesByCardId(client, existingCard.id);
          if (issues.length > 0) existingIssue = issues[0];
        } else {
          existingIssue = await getNewsletterIssue(client, rawTargetId);
          if (existingIssue && existingIssue.cardId) {
            existingCard = await getCardConsistent(client, existingIssue.cardId);
          }
          if (!existingIssue) {
            existingEpisode = await getPodcastEpisode(client, rawTargetId);
            if (existingEpisode && existingEpisode.cardId) {
              existingCard = await getCardConsistent(client, existingEpisode.cardId);
            }
          }
        }

        if (!existingCard && !existingIssue && !existingEpisode) {
          return json(404, { error: 'Card not found', code: 'card_not_found' });
        }

        const templateIdByType = await getTemplateIdByType(client);
        let hydratedCard: Card | null = null;
        if (existingCard) {
          hydratedCard = { ...existingCard };
          hydrateStructuredCardFields(hydratedCard, templateIdByType);
        }

        const slotHint = typeof body.slot === 'string' ? body.slot.trim().toLowerCase() : undefined;
        const standaloneFlag = body.standalone === true
          || body.standalone === 'true'
          || slotHint === 'standalone'
          || slotHint === 'stand-alone';

        let template: SponsorDocTemplateKey;
        if (body.template !== undefined && body.template !== null && String(body.template).trim() !== '') {
          const requested = String(body.template).trim();
          if (!isSponsorDocTemplateKey(requested)) {
            return json(400, {
              error: `Invalid template "${requested}". Must be one of: newsletter-main, newsletter-secondary, newsletter-standalone, webinar, podcast, podcast-guest-research, podcast-run-sheet, podcast-episode-brief`,
              code: 'invalid_template',
            });
          }
          template = requested;
        } else if (standaloneFlag) {
          template = 'newsletter-standalone';
        } else if (slotHint === 'secondary') {
          template = 'newsletter-secondary';
        } else if (slotHint === 'primary' || slotHint === 'main') {
          template = existingIssue?.kind === 'standalone' ? 'newsletter-standalone' : 'newsletter-main';
        } else if (existingEpisode) {
          template = 'podcast';
        } else if (existingIssue && !existingCard) {
          if (existingIssue.kind === 'standalone') {
            template = 'newsletter-standalone';
          } else if (!existingIssue.slots?.primary?.sponsor && existingIssue.slots?.secondary?.sponsor) {
            template = 'newsletter-secondary';
          } else {
            template = 'newsletter-main';
          }
        } else if (existingCard) {
          template = await inferTemplateForCard(client, existingCard, slotHint);
        } else {
          template = 'newsletter-main';
        }

        // Guest research and host run sheets start only after the date is
        // confirmed (a recording date on the owning episode). The guest
        // materials doc and the episode brief stay available before confirm.
        if (template === 'podcast-guest-research' || template === 'podcast-run-sheet') {
          const datedOwner = existingEpisode?.recordingDate
            ? existingEpisode
            : existingCard
              ? (await listPodcastEpisodes(client)).find(
                (episode) => episode.cardId === existingCard.id && episode.recordingDate,
              )
              : undefined;
          if (!datedOwner) {
            return json(422, {
              error: 'Guest research and run sheets start only after the date is confirmed: set the episode recording date first (dataops podcast update <episode-id> --recording-date YYYY-MM-DD).',
              code: 'date_not_confirmed',
            });
          }
        }

        const publicationDate = typeof body.publicationDate === 'string' && body.publicationDate.trim()
          ? body.publicationDate.trim()
          : existingIssue?.publicationDate
            || existingEpisode?.releaseDate
            || existingEpisode?.recordingDate
            || (hydratedCard?.anchorDate ? String(hydratedCard.anchorDate).slice(0, 10) : null);

        let sponsorName: string | null = null;
        if (typeof body.sponsorName === 'string' && body.sponsorName.trim()) {
          sponsorName = body.sponsorName.trim();
        } else if (template === 'newsletter-secondary') {
          sponsorName = existingIssue?.slots?.secondary?.sponsor
            || hydratedCard?.secondarySponsors?.[0]
            || hydratedCard?.sponsor
            || existingIssue?.slots?.primary?.sponsor
            || null;
        } else if (template === 'webinar') {
          sponsorName = hydratedCard?.people?.[0] || null;
        } else if (template === 'podcast' || template.startsWith('podcast-')) {
          sponsorName = hydratedCard?.sponsor
            || hydratedCard?.people?.[0]
            || existingEpisode?.guests?.[0]?.name
            || null;
        } else {
          sponsorName = existingIssue?.slots?.primary?.sponsor
            || hydratedCard?.sponsor
            || hydratedCard?.people?.[0]
            || null;
        }

        let title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
          if (publicationDate && sponsorName) {
            title = `${publicationDate} - ${sponsorName}`;
          } else if (publicationDate && hydratedCard?.title) {
            title = `${publicationDate} - ${hydratedCard.title}`;
          } else if (publicationDate && existingEpisode?.title) {
            title = `${publicationDate} - ${existingEpisode.title}`;
          } else {
            title = hydratedCard?.title || existingEpisode?.title || getSponsorDocTemplate(template).label;
          }
        }

        const linkType = typeof body.linkType === 'string' && body.linkType.trim()
          ? body.linkType.trim()
          : getSponsorDocTemplate(template).defaultLinkType;

        const directory = new TeamDirectory(client);
        const staffProj = actor.actor.id ? await directory.project(actor.actor.id) : null;
        const ownerRecordId = existingCard?.id || existingIssue?.id || existingEpisode!.id;

        const { doc, accessCode } = await createSponsorDoc(client, {
          cardId: ownerRecordId,
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
        const docUrl = `${base}${sponsorDocPathForTemplate(template)}/${encodeURIComponent(doc.id)}`;

        let projectedCard = null;
        if (existingCard) {
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
          projectedCard = await projectCard(directory, updatedCard, undefined, templateIdByType);
        }

        let updatedIssue: NewsletterIssue | null = null;
        if (existingIssue && docUrl.startsWith('https://')) {
          const slotPos: NewsletterSlotPosition =
            template === 'newsletter-secondary' && existingIssue.kind === 'weekly'
              ? 'secondary'
              : 'primary';
          const currentSlot = existingIssue.slots?.[slotPos] || {};
          const nextSlots = {
            ...(existingIssue.slots || {}),
            [slotPos]: { ...currentSlot, documentUrl: docUrl },
          };
          updatedIssue = await updateNewsletterIssue(client, existingIssue, { slots: nextSlots }).catch(() => existingIssue);
        }

        return json(201, {
          doc: await buildDocResponsePayload(doc, event, client, { viewerRole: 'staff', accessCode }),
          card: projectedCard,
          ...(updatedIssue ? { issue: updatedIssue } : {}),
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
        if (!loaded) return json(404, { error: 'Document not found', code: 'sponsor_doc_not_found' });
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
        return json(404, { error: 'Document not found', code: 'sponsor_doc_not_found' });
      }
      return json(200, {
        doc: await buildDocResponsePayload(rotated.doc, event, client, {
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
            return json(404, { error: 'Document not found', code: 'sponsor_doc_not_found' });
          }
          const accessCode = decryptSponsorDocAccessCode(docId, loaded.accessCodeCiphertext);
          return json(200, {
            doc: await buildDocResponsePayload(loaded.doc, event, client, {
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
          doc: await buildDocResponsePayload(verified.doc, event, client, { viewerRole: 'sponsor' }),
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
            return json(404, { error: 'Document not found', code: 'sponsor_doc_not_found' });
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
            doc: await buildDocResponsePayload(updated!, event, client, {
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
          doc: await buildDocResponsePayload(updated!, event, client, { viewerRole: 'sponsor' }),
        });
      }

      if (m === 'DELETE') {
        const actor = await resolveInteractiveActor(client, event, 'work-write');
        if (!actor.ok) return actor.response;
        const deleted = await deleteSponsorDoc(client, docId);
        if (!deleted) {
          return json(404, { error: 'Document not found', code: 'sponsor_doc_not_found' });
        }
        // Clean up the Card's link if it points at this sponsor doc
        const card = await getCardConsistent(client, deleted.cardId);
        if (card && Array.isArray(card.cardLinks)) {
          const encodedId = encodeURIComponent(deleted.id);
          let changed = false;
          const nextLinks = card.cardLinks.map((item) => {
            const url = String(item.url || '');
            if (
              url.endsWith(`/sponsor-docs/${encodedId}`)
              || url.endsWith(`/webinar-docs/${encodedId}`)
              || url.endsWith(`/podcast-docs/${encodedId}`)
              || url.endsWith(`/guest-docs/${encodedId}`)
            ) {
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
    if (err instanceof SponsorDocValidationError) {
      return json(422, { error: err.message, code: 'invalid_content', fields: err.fields });
    }
    recordRequestError(err);
    return json(500, { error: 'Internal server error' });
  }
}
