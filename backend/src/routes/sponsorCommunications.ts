import { randomUUID } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCrmRecord } from '../db/sponsorCrm';
import { getUser } from '../db/users';
import type { LambdaEvent, LambdaResponse, User } from '../types';
import {
  canonicalPayload,
  COMMUNICATION_TYPES,
  newReviewToken,
  normalizeEmail,
  normalizePublicLinks,
  sha256,
  suppressionKey,
  validateSendConfig,
  type SendConfig,
} from '../sponsorCommunications/core';
import {
  addSuppression,
  anchorPayloadRetention,
  approveDraft,
  assertSuppressionCoverage,
  cancelQueuedAttempt,
  getCurrentConfig,
  getDraft,
  getPrivatePayload,
  getSponsorItem,
  listBookingCommunications,
  listSuppressionMigrationOrphans,
  migrateSuppressions,
  nextDraftVersion,
  putConfig,
  reconcileAttempt,
  reconcileSuppressionMigrationOrphan,
  removeSuppression,
  revokePresentation,
  storeDraft,
  storePresentation,
} from '../sponsorCommunications/repository';
import { evaluateCommunicationSuggestions } from '../sponsorCommunications/suggestions';
import { loadHmacKeyring, loadTemplateBundle, renderTemplate } from '../sponsorCommunications/secrets';
import type {
  CommunicationDraftVersion,
  CommunicationPresentation,
  CommunicationPrivatePayload,
  CommunicationSuggestion,
} from '../sponsorCommunications/types';

const PRIVATE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers: PRIVATE_HEADERS, body: JSON.stringify(body) });
const parse = (event: LambdaEvent): Record<string, unknown> | null => {
  try {
    if (!event.body) return {};
    const parsed = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
};
const header = (event: LambdaEvent, name: string) => Object.entries(event.headers || {})
  .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || '';
const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

async function currentActor(
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  roles: Array<'operator' | 'admin'>,
): Promise<{ user?: User; response?: LambdaResponse }> {
  const actorId = header(event, 'x-user-id');
  if (!actorId || ['authenticated-operator', 'portal-admin'].includes(actorId) || !validId(actorId)) {
    return { response: json(401, { error: 'Unauthorized' }) };
  }
  const user = await getUser(client, actorId);
  if (!user || user.disabled || !roles.includes(user.role as 'operator' | 'admin')) {
    return { response: json(403, { error: 'Forbidden' }) };
  }
  return { user };
}

async function sourceRecords(
  client: DynamoDBDocumentClient,
  suggestion: CommunicationSuggestion,
  contactId: string,
) {
  const [booking, organization, contact] = await Promise.all([
    getCrmRecord(client, 'booking', suggestion.bookingId),
    getCrmRecord(client, 'organization', suggestion.organizationId),
    getCrmRecord(client, 'contact', contactId),
  ]);
  if (
    !booking || !organization || !contact
    || booking.organizationId !== organization.id
    || contact.organizationId !== organization.id
    || booking.archivedAt || organization.archivedAt || contact.archivedAt
    || contact.active === false
    || !Array.isArray(contact.emails) || contact.emails.length < 1
  ) throw Object.assign(new Error('Current sponsor recipient is not eligible'), { statusCode: 409 });
  return { booking, organization, contact };
}

function contactAddresses(contact: Record<string, unknown>): string[] {
  if (!Array.isArray(contact.emails)) return [];
  return contact.emails.flatMap((value) => {
    try { return [normalizeEmail(value)]; } catch { return []; }
  });
}

async function validatePresentationState(
  client: DynamoDBDocumentClient,
  draft: CommunicationDraftVersion,
  payload: CommunicationPrivatePayload,
) {
  const config = await getCurrentConfig(client);
  if (
    !config?.enabled
    || process.env.SPONSOR_COMMUNICATION_SEND_ENABLED !== 'true'
    || config.digest !== draft.configDigest
    || draft.abandonedAt
    || draft.claimedAttemptId
  ) throw new Error('Sending is disabled or the draft is no longer current');
  const [suggestion, key, templates] = await Promise.all([
    getSponsorItem<CommunicationSuggestion>(client, 'COMMUNICATION_SUGGESTION', draft.suggestionId),
    loadHmacKeyring(),
    loadTemplateBundle(),
  ]);
  validateSendConfig(config, key.keyring);
  await assertSuppressionCoverage(client, config.hmacAcceptedVersions);
  if (
    !suggestion || suggestion.status !== 'open' || !suggestion.eligible
    || suggestion.version !== payload.payload.suggestionVersion
    || suggestion.bookingId !== payload.payload.bookingId
    || suggestion.organizationId !== payload.payload.organizationId
    || templates.digest !== config.templateBundleDigest
    || templates.card.generation !== config.templateBundleGeneration
  ) throw new Error('Source, template, or suppression configuration changed');
  const template = templates.card.templates.find((item) => item.id === payload.payload.templateId);
  if (
    !template
    || template.version !== payload.payload.templateVersion
    || sha256(JSON.stringify(template)) !== payload.payload.templateDigest
  ) throw new Error('Template version changed');
  const { booking, organization, contact } = await sourceRecords(client, suggestion, payload.payload.contactId);
  const verifiedStoredRecipient = Array.isArray(contact.emails)
    ? contact.emails.find((candidate) => {
      try { return normalizeEmail(candidate) === payload.payload.to; } catch { return false; }
    })
    : undefined;
  if (
    booking.version !== payload.payload.bookingVersion
    || organization.version !== payload.payload.organizationVersion
    || contact.version !== payload.payload.contactVersion
    || typeof verifiedStoredRecipient !== 'string'
  ) throw new Error('Booking, organization, contact, or recipient changed');
  const rebuilt = canonicalPayload(payload.payload);
  if (
    rebuilt.hash !== payload.payloadHash
    || rebuilt.hash !== draft.payloadHash
    || rebuilt.previewHash !== draft.previewHash
  ) throw new Error('Private payload no longer matches the immutable draft');
  for (const version of config.hmacAcceptedVersions) {
    const suppression = await getSponsorItem<Record<string, unknown>>(
      client,
      'EMAIL_SUPPRESSION',
      suppressionKey(version, payload.payload.to, key.keyring),
    );
    if (suppression?.status === 'active') throw new Error('Recipient is suppressed');
  }
  const nextVersion = await nextDraftVersion(client, draft.communicationId);
  if (nextVersion !== draft.version + 1) throw new Error('A newer draft must be reviewed');
  return { config, keyring: key.keyring, payload, verifiedStoredRecipient };
}

function configResponse(config: SendConfig | null) {
  if (!config) return { configured: false, enabled: false };
  return {
    configured: true,
    enabled: config.enabled,
    generation: config.generation,
    templateBundleGeneration: config.templateBundleGeneration,
    hmacActiveVersion: config.hmacActiveVersion,
    hmacAcceptedVersions: config.hmacAcceptedVersions,
    sesRegion: config.sesRegion,
    from: config.from,
    configurationSet: config.configurationSet,
    configurationSetGeneration: config.configurationSetGeneration,
    digest: config.digest,
  };
}

export async function handleSponsorCommunicationRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const body = parse(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  if (path === '/api/sponsor-crm/communications/config' && method === 'GET') {
    const auth = await currentActor(event, client, ['operator', 'admin']);
    if (auth.response) return auth.response;
    return json(200, configResponse(await getCurrentConfig(client)));
  }
  if (path === '/api/sponsor-crm/communications/config' && method === 'PUT') {
    const auth = await currentActor(event, client, ['admin']);
    if (auth.response) return auth.response;
    try {
      const { keyring, digest: hmacKeyringDigest } = await loadHmacKeyring();
      const templates = await loadTemplateBundle();
      const previous = await getCurrentConfig(client);
      const input = body as unknown as Omit<SendConfig, 'digest'>;
      const config = validateSendConfig({
        ...input,
        enabled: body.enabled === true && process.env.SPONSOR_COMMUNICATION_SEND_ENABLED === 'true',
        generation: (previous?.generation || 0) + 1,
        templateBundleGeneration: templates.card.generation,
        templateBundleDigest: templates.digest,
        hmacSecretVersionId: keyring.secretVersionId,
        hmacActiveVersion: keyring.activeVersion,
        hmacAcceptedVersions: keyring.acceptedVersions,
        hmacKeyringDigest,
      }, keyring);
      await putConfig(client, config, auth.user!.id);
      return json(200, configResponse(config));
    } catch {
      return json(409, { error: 'Private configuration is incomplete or mismatched; sending remains disabled' });
    }
  }

  if (path === '/api/sponsor-crm/communications/evaluate' && method === 'POST') {
    const auth = await currentActor(event, client, ['operator', 'admin']);
    if (auth.response) return auth.response;
    return json(200, await evaluateCommunicationSuggestions(client, typeof body.today === 'string' ? body.today : undefined));
  }

  if (path === '/api/sponsor-crm/communications/suppressions/migrate' && method === 'POST') {
    const auth = await currentActor(event, client, ['admin']);
    if (auth.response) return auth.response;
    if (process.env.SPONSOR_COMMUNICATION_SEND_ENABLED === 'true') {
      return json(409, { error: 'Disable the deployment send switch before suppression migration' });
    }
    try {
      const config = await getCurrentConfig(client);
      if (!config) throw new Error('Suppression configuration is unavailable');
      const { keyring } = await loadHmacKeyring();
      validateSendConfig(config, keyring);
      const result = await migrateSuppressions(client, {
        actorId: auth.user!.id,
        fromVersion: String(body.fromVersion || ''),
        limit: Number(body.limit || 10),
        cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
      }, config, keyring);
      return json(200, result);
    } catch (error) {
      return json(409, { error: (error as Error).message });
    }
  }
  if (path === '/api/sponsor-crm/communications/suppressions/orphans' && method === 'GET') {
    const auth = await currentActor(event, client, ['admin']);
    if (auth.response) return auth.response;
    try {
      return json(200, await listSuppressionMigrationOrphans(client, {
        limit: Number(event.queryStringParameters?.limit || 20),
        cursor: event.queryStringParameters?.cursor,
      }));
    } catch (error) {
      return json(400, { error: (error as Error).message });
    }
  }

  const orphanReconcile = path.match(/^\/api\/sponsor-crm\/communications\/suppressions\/orphans\/([^/]+)\/reconcile$/);
  if (orphanReconcile && method === 'POST') {
    const auth = await currentActor(event, client, ['admin']);
    if (auth.response) return auth.response;
    if (typeof body.reason !== 'string' || !body.reason.trim()) return json(400, { error: 'A reconciliation reason is required' });
    try {
      await reconcileSuppressionMigrationOrphan(client, {
        id: orphanReconcile[1],
        actorId: auth.user!.id,
        reason: body.reason,
      });
      return json(200, { status: 'resolved' });
    } catch (error) {
      return json(409, { error: (error as Error).message });
    }
  }

  const bookingList = path.match(/^\/api\/sponsor-crm\/bookings\/([^/]+)\/communications$/);
  if (bookingList && method === 'GET') {
    const auth = await currentActor(event, client, ['operator', 'admin']);
    if (auth.response) return auth.response;
    if (!validId(bookingList[1])) return json(400, { error: 'Invalid booking ID' });
    const limit = Number(event.queryStringParameters?.limit || 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json(400, { error: 'Invalid pagination' });
    try {
      const history = await listBookingCommunications(client, bookingList[1], {
        limit,
        cursor: event.queryStringParameters?.cursor,
      });
      return json(200, {
        ...history,
        config: configResponse(await getCurrentConfig(client)),
        permissions: {
          role: auth.user!.role,
          canApprove: auth.user!.role === 'admin',
          canCancel: auth.user!.role === 'admin',
          canReconcile: auth.user!.role === 'admin',
        },
      });
    } catch {
      return json(400, { error: 'Invalid communication history cursor' });
    }
  }

  const suggestionDraft = path.match(/^\/api\/sponsor-crm\/communication-suggestions\/([^/]+)\/drafts$/);
  if (suggestionDraft && method === 'POST') {
    const auth = await currentActor(event, client, ['operator', 'admin']);
    if (auth.response) return auth.response;
    try {
      const suggestion = await getSponsorItem<CommunicationSuggestion>(client, 'COMMUNICATION_SUGGESTION', suggestionDraft[1]);
      if (!suggestion || suggestion.status !== 'open' || !suggestion.eligible) return json(409, { error: 'Suggestion is no longer eligible' });
      const contactId = String(body.contactId || '');
      if (!contactId || typeof body.recipient !== 'string' || !body.recipient) {
        return json(400, { error: 'Select exactly one active sponsor contact address' });
      }
      const { booking, organization, contact } = await sourceRecords(client, suggestion, contactId);
      const canonicalRecipient = normalizeEmail(body.recipient);
      if (!contactAddresses(contact).includes(canonicalRecipient)) return json(409, { error: 'Recipient is not on the selected active contact' });
      const config = await getCurrentConfig(client);
      if (!config) return json(409, { error: 'Sponsor send configuration is not ready' });
      const key = await loadHmacKeyring();
      validateSendConfig(config, key.keyring);
      const templates = await loadTemplateBundle();
      if (templates.digest !== config.templateBundleDigest || templates.card.generation !== config.templateBundleGeneration) {
        return json(409, { error: 'Template configuration changed; reconcile before drafting' });
      }
      const template = templates.card.templates.find((item) => item.id === suggestion.communicationType)!;
      const rendered = renderTemplate(template, {
        organizationName: String(organization.displayName),
        publicationDate: typeof booking.plannedPublicationDate === 'string' ? booking.plannedPublicationDate : undefined,
        materialDeadline: typeof booking.materialDeadline === 'string' ? booking.materialDeadline : undefined,
        publicLink: typeof booking.requiredLinkUrl === 'string' ? booking.requiredLinkUrl : undefined,
      });
      const version = await nextDraftVersion(client, suggestion.id);
      const communicationId = suggestion.id;
      const canonical = canonicalPayload({
        from: config.from,
        replyTo: config.replyTo,
        to: canonicalRecipient,
        communicationType: suggestion.communicationType,
        communicationId,
        version,
        subject: typeof body.subject === 'string' ? body.subject : rendered.subject,
        body: typeof body.body === 'string' ? body.body : rendered.body,
        publicLinks: normalizePublicLinks(body.publicLinks || (booking.requiredLinkUrl ? [booking.requiredLinkUrl] : [])),
        templateId: template.id,
        templateVersion: template.version,
        templateDigest: sha256(JSON.stringify(template)),
        templateBundleGeneration: templates.card.generation,
        bookingId: booking.id,
        bookingVersion: booking.version,
        organizationId: organization.id,
        organizationVersion: organization.version,
        contactId: contact.id,
        contactVersion: contact.version,
        suggestionId: suggestion.id,
        suggestionVersion: suggestion.version,
        approverPolicyVersion: config.approverPolicyVersion,
        sesAccount: config.sesAccount,
        sesRegion: config.sesRegion,
        sesIdentityArn: config.sesIdentityArn,
        configurationSet: config.configurationSet,
        configurationSetGeneration: config.configurationSetGeneration,
        hmacKeyringDigest: config.hmacKeyringDigest,
        sendConfigGeneration: config.generation,
        sendConfigDigest: config.digest,
      });
      const now = new Date().toISOString();
      const payloadId = `${communicationId}#${version}`;
      const draft: CommunicationDraftVersion = {
        id: payloadId,
        recordType: 'communication-draft-version',
        communicationId,
        bookingId: booking.id,
        version,
        suggestionId: suggestion.id,
        payloadRef: payloadId,
        payloadHash: canonical.hash,
        previewHash: canonical.previewHash,
        configDigest: config.digest,
        createdBy: auth.user!.id,
        createdAt: now,
      };
      const payload: CommunicationPrivatePayload = {
        id: payloadId,
        recordType: 'communication-private-payload',
        communicationId,
        version,
        payload: canonical.payload,
        payloadHash: canonical.hash,
        createdAt: now,
      };
      await storeDraft(client, draft, payload);
      return json(201, { communicationId, version, payloadHash: canonical.hash, previewHash: canonical.previewHash });
    } catch (error) {
      return json((error as { statusCode?: number }).statusCode || 400, { error: (error as Error).message });
    }
  }

  const presentationRoute = path.match(/^\/api\/sponsor-crm\/communications\/([^/]+)\/presentations$/);
  if (presentationRoute && method === 'POST') {
    const auth = await currentActor(event, client, ['operator', 'admin']);
    if (auth.response) return auth.response;
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) return json(400, { error: 'Valid draft version is required' });
    const draft = await getDraft(client, presentationRoute[1], version);
    if (!draft) return json(404, { error: 'Draft not found' });
    const payload = await getPrivatePayload(client, draft.payloadRef);
    if (!payload) return json(410, { error: 'Private payload expired; create a new draft' });
    const guard = await validatePresentationState(client, draft, payload).catch(() => null);
    if (!guard) {
      return json(409, { error: 'Source, recipient, suppression, template, keyring, or configuration changed; create a new draft' });
    }
    const token = newReviewToken();
    const now = new Date();
    const expires = new Date(now.getTime() + 15 * 60_000);
    const presentation: CommunicationPresentation = {
      id: randomUUID(),
      recordType: 'communication-presentation',
      communicationId: draft.communicationId,
      bookingId: draft.bookingId,
      payloadRef: draft.payloadRef,
      draftVersion: draft.version,
      payloadHash: draft.payloadHash,
      previewHash: draft.previewHash,
      tokenHash: sha256(token),
      state: 'active',
      expiresAt: expires.toISOString(),
      ttl: Math.floor(expires.getTime() / 1000) + 24 * 60 * 60,
      revision: 1,
      createdBy: auth.user!.id,
      createdAt: now.toISOString(),
    };
    await storePresentation(client, presentation, guard);
    return json(201, {
      presentationId: presentation.id,
      version: draft.version,
      expiresAt: presentation.expiresAt,
      token,
      previewHash: draft.previewHash,
      preview: payload.payload,
    });
  }

  const approvalRoute = path.match(/^\/api\/sponsor-crm\/communications\/([^/]+)\/approve$/);
  if (approvalRoute && method === 'POST') {
    const auth = await currentActor(event, client, ['admin']);
    if (auth.response) return auth.response;
    const presentationId = String(body.presentationId || '');
    const token = String(body.token || '');
    if (!presentationId || !token || token.length < 32) return json(400, { error: 'Review token and presentation are required' });
    const presentation = await getSponsorItem<CommunicationPresentation>(client, 'COMMUNICATION_PRESENTATION', presentationId);
    if (
      !presentation
      || presentation.communicationId !== approvalRoute[1]
      || presentation.createdBy !== auth.user!.id
    ) return json(403, { error: 'Forbidden' });
    const draft = await getDraft(client, approvalRoute[1], Number(body.version));
    if (!draft || draft.version !== presentation.draftVersion) return json(409, { error: 'Draft changed; review again' });
    const payload = await getPrivatePayload(client, draft.payloadRef);
    if (!payload) return json(410, { error: 'Private payload expired; draft again' });
    const config = await getCurrentConfig(client);
    if (!config) return json(409, { error: 'Sending is disabled' });
    try {
      const { keyring } = await loadHmacKeyring();
      validateSendConfig(config, keyring);
      await assertSuppressionCoverage(client, config.hmacAcceptedVersions);
      const attempt = await approveDraft(client, { actorId: auth.user!.id, presentation, draft, payload, config, keyring, token });
      return json(202, { attemptId: attempt.id, status: attempt.status, derivedStatus: attempt.derivedStatus });
    } catch {
      return json(409, { error: 'Approval conflict, suppression, or configuration change; review again' });
    }
  }

  const rejectRoute = path.match(/^\/api\/sponsor-crm\/communications\/([^/]+)\/presentations\/([^/]+)\/reject$/);
  if (rejectRoute && method === 'POST') {
    const auth = await currentActor(event, client, ['operator', 'admin']);
    if (auth.response) return auth.response;
    const presentation = await getSponsorItem<CommunicationPresentation>(client, 'COMMUNICATION_PRESENTATION', rejectRoute[2]);
    if (
      !presentation
      || presentation.communicationId !== rejectRoute[1]
      || presentation.createdBy !== auth.user!.id
    ) return json(404, { error: 'Presentation not found' });
    if (presentation.state === 'revoked') {
      const draft = await getDraft(client, presentation.communicationId, presentation.draftVersion);
      if (draft) await anchorPayloadRetention(client, draft.payloadRef, new Date().toISOString());
      return json(200, { state: 'revoked' });
    }
    if (presentation.state !== 'active') return json(409, { error: 'Review already changed' });
    try {
      await revokePresentation(client, presentation, auth.user!.id);
      const draft = await getDraft(client, presentation.communicationId, presentation.draftVersion);
      if (draft) await anchorPayloadRetention(client, draft.payloadRef, new Date().toISOString());
      return json(200, { state: 'revoked' });
    } catch {
      return json(409, { error: 'Review already changed' });
    }
  }

  const cancelRoute = path.match(/^\/api\/sponsor-crm\/communications\/attempts\/([^/]+)\/cancel$/);
  if (cancelRoute && method === 'POST') {
    const auth = await currentActor(event, client, ['admin']);
    if (auth.response) return auth.response;
    const attempt = await getSponsorItem<any>(client, 'SPONSOR_SEND_ATTEMPT', cancelRoute[1]);
    if (!attempt) return json(404, { error: 'Attempt not found' });
    try {
      await cancelQueuedAttempt(client, attempt, auth.user!.id);
      return json(200, { status: 'cancelled' });
    } catch {
      return json(409, { error: 'The dispatch point of no return may already have passed' });
    }
  }

  const reconcileRoute = path.match(/^\/api\/sponsor-crm\/communications\/attempts\/([^/]+)\/reconcile$/);
  if (reconcileRoute && method === 'POST') {
    const auth = await currentActor(event, client, ['admin']);
    if (auth.response) return auth.response;
    const attempt = await getSponsorItem<any>(client, 'SPONSOR_SEND_ATTEMPT', reconcileRoute[1]);
    const resolution = body.resolution;
    if (!attempt || !['effect_applied', 'no_effect'].includes(String(resolution)) || typeof body.reason !== 'string' || !body.reason.trim()) {
      return json(400, { error: 'Current unknown attempt, resolution, and reason are required' });
    }
    try {
      await reconcileAttempt(client, attempt, auth.user!.id, resolution as 'effect_applied' | 'no_effect', body.reason);
      return json(200, { status: 'resolved', resolution });
    } catch {
      return json(409, { error: 'Attempt changed; reload before reconciling' });
    }
  }

  const suppressionRoute = path.match(/^\/api\/sponsor-crm\/contacts\/([^/]+)\/suppressions$/);
  if (suppressionRoute && method === 'POST') {
    const auth = await currentActor(event, client, ['operator', 'admin']);
    if (auth.response) return auth.response;
    const contact = await getCrmRecord(client, 'contact', suppressionRoute[1]);
    if (!contact || contact.archivedAt || !Array.isArray(contact.emails)) return json(404, { error: 'Contact not found' });
    try {
      const canonicalAddress = normalizeEmail(body.email || contact.emails[0]);
      if (!(contact.emails as unknown[]).map(normalizeEmail).includes(canonicalAddress)) return json(409, { error: 'Email is not on this contact' });
      const config = await getCurrentConfig(client);
      if (!config) return json(409, { error: 'Suppression configuration is unavailable' });
      const { keyring } = await loadHmacKeyring();
      const suppression = await addSuppression(client, {
        canonicalAddress,
        contactId: contact.id,
        organizationId: String(contact.organizationId),
        category: 'manual',
        actorId: auth.user!.id,
        safeReason: typeof body.reason === 'string' ? body.reason : 'operator-requested',
      }, config, keyring);
      return json(201, suppression);
    } catch (error) {
      return json(400, { error: (error as Error).message });
    }
  }
  if (suppressionRoute && method === 'DELETE') {
    const auth = await currentActor(event, client, ['admin']);
    if (auth.response) return auth.response;
    const contact = await getCrmRecord(client, 'contact', suppressionRoute[1]);
    if (!contact || !Array.isArray(contact.emails)) return json(404, { error: 'Contact not found' });
    try {
      const canonicalAddress = normalizeEmail(body.email || contact.emails[0]);
      const config = await getCurrentConfig(client);
      if (!config) return json(409, { error: 'Suppression configuration is unavailable' });
      const { keyring } = await loadHmacKeyring();
      const candidates = config.hmacAcceptedVersions.map((version) => ({
        version,
        id: suppressionKey(version, canonicalAddress, keyring),
      }));
      let found: any = null;
      for (const candidate of candidates) {
        const item = await getSponsorItem<any>(client, 'EMAIL_SUPPRESSION', candidate.id);
        if (item?.status === 'active') { found = item; break; }
      }
      if (!found) return json(404, { error: 'Suppression not found' });
      await removeSuppression(client, {
        id: found.id,
        revision: Number(body.revision || found.revision),
        actorId: auth.user!.id,
        reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason : 'admin reconciliation',
        allowProtected: body.protectedReconciliation === true,
      });
      return json(200, { status: 'removed' });
    } catch (error) {
      return json(409, { error: (error as Error).message });
    }
  }

  return json(404, { error: 'Not found' });
}
