import { timingSafeEqual } from 'crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handleCardRoutes } from './routes/cards';
import { handleTemplateRoutes } from './routes/templates';
import { handleRecurringRoutes } from './routes/recurring';
import { handleUserRoutes } from './routes/users';
import { handleFileRoutes } from './routes/files';
import { handleArtifactRoutes } from './routes/artifacts';
import { handleAssistantJobRoutes } from './routes/assistantJobs';
import { handleSocialDraftAssistantRoutes } from './assistant/socialDraftAssistant';
import { handleDocsRoutes, isDocsDomainEnabled, isDocsRoute } from './docs';
import { handlePortal, serveCanonicalFrontend } from './docs/portal';
import { handleTelegramWebhook } from './routes/telegram';
import { handleEmailDocumentIntake } from './routes/emailDocuments';
import { handleNotificationRoutes } from './routes/notifications';
import { handleCronRoutes } from './routes/cron';
import { handleBookkeepingRoutes } from './routes/bookkeeping';
import { handleSponsorCrmRoutes } from './routes/sponsorCrm';
import { handleSponsorFinanceRoutes } from './routes/sponsorFinance';
import { handleSponsorCommunicationRoutes } from './routes/sponsorCommunications';
import { handleNewsletterSlotRoutes } from './routes/newsletterSlots';
import { handleCalendarRoutes } from './routes/calendar';
import { handleConversationalExecutionRoutes } from './routes/conversationalExecution';
import { handleConversationalIdentityBindingRoutes } from './routes/conversationalIdentityBindings';
import { handleConversationalReadiness } from './routes/conversationalReadiness';
import { handleDocumentReviewRoutes } from './routes/documentReviews';
import { handleOperatingModelRoutes } from './routes/operatingModel';
import { handleAuthRoutes, extractToken } from './routes/auth';
import { handleTeamMemberRoutes } from './routes/teamMembers';
import { handleTaskRoutes } from './routes/tasks';
import { resolveInteractiveActor } from './identity/actor';
import { identityProjection } from './identity/projections';
import { getSession } from './db/sessions';
import { getUser } from './db/users';
import { getTaskConsistent, TaskVersionConflictError, CardLifecycleConflictError } from './db/tasks';
import { CardNotFoundError, getCardConsistent } from './db/cards';
import { getApiToken, touchApiToken } from './db/cliAuth';
import { handleInvoiceReader } from './auth/invoiceReader';
import { handleCliAuthRoutes, isAnonymousDeviceRequest } from './routes/cliAuth';
import type { LambdaEvent, LambdaResponse } from './types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
let cachedPortalSecret: string | null | undefined;
let secretsClient: SecretsManagerClient | null = null;

// Routes that do NOT require authentication
const AUTH_EXEMPT_PATHS = new Set([
  '/',
  '/api/health',
  '/api/auth/login',
]);

function isAuthExempt(method: string, path: string): boolean {
  if (isAnonymousDeviceRequest(method, path)) return true;
  if (AUTH_EXEMPT_PATHS.has(path)) return true;
  if (method === 'POST' && path === '/api/v1/intake/email-documents') return true;
  if (method === 'POST' && path === '/api/webhook/telegram') return true;
  return false;
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function deleteHeader(headers: Record<string, string> | null | undefined, name: string): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}

async function portalSecret(): Promise<string> {
  if (process.env.WORK_ENGINE_PORTAL_SECRET) return process.env.WORK_ENGINE_PORTAL_SECRET;
  if (cachedPortalSecret !== undefined) return cachedPortalSecret || '';

  const secretName = process.env.WORK_ENGINE_PORTAL_SECRET_NAME;
  if (!secretName) {
    cachedPortalSecret = null;
    return '';
  }

  secretsClient ||= new SecretsManagerClient({});
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  const secret = result.SecretString || (result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf-8') : '');
  cachedPortalSecret = secret || null;
  return secret;
}

function constantTimeEquals(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function portalTrustedUserId(event: LambdaEvent): Promise<string | null> {
  if (process.env.WORK_ENGINE_AUTH_MODE !== 'portal') return null;
  const portalAuth = headerValue(event.headers, 'x-portal-auth');
  if (portalAuth !== 'true') return null;
  const expectedSecret = await portalSecret();
  const providedSecret = headerValue(event.headers, 'x-portal-secret');
  if (!constantTimeEquals(providedSecret, expectedSecret)) return null;
  return headerValue(event.headers, 'x-user-id') || 'portal-admin';
}

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function decodeBase64Body(event: LambdaEvent): void {
  if (!event.isBase64Encoded || typeof event.body !== 'string') return;
  event.body = Buffer.from(event.body, 'base64').toString('binary');
  event.isBase64Encoded = false;
}

async function route(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const method = event.httpMethod || 'GET';
  let reqPath = event.path || '/';
  const portalMode = process.env.WORK_ENGINE_AUTH_MODE === 'portal';
  const skipAuth = process.env.NODE_ENV === 'test' && process.env.SKIP_AUTH === 'true';

  try {
    // Machine-to-machine intake has its own rotated secret and must not pass
    // through interactive session or portal authentication.
    if (method === 'POST' && reqPath === '/api/v1/intake/email-documents') {
      return await handleEmailDocumentIntake(event, client);
    }

    decodeBase64Body(event);

    // Telegram authenticates with its own rotated webhook secret and must be
    // handled before the interactive single-origin portal middleware.
    if (method === 'POST' && reqPath === '/api/webhook/telegram') {
      return await handleTelegramWebhook(event);
    }

    // ── Single-origin portal layer (docs domain, flag-gated) ─────
    // When the docs domain is enabled, the portal serves the frontend, the docs
    // content API, and `/content/*`, enforces the opaque browser session, and
    // rewrites the old `/work/api/*` proxy path to `/api/*`. A verified portal
    // session also authorizes the work `/api/*` routes (portalAuthorized).
    let portalAuthorized = false;
    let browserUserId: string | undefined;
    if (isDocsDomainEnabled()) {
      const portal = await handlePortal(event, client);
      if (portal.response) return portal.response;
      portalAuthorized = portal.authorized;
      browserUserId = portal.userId;
      // The portal may rewrite the path (e.g. /work/api/* -> /api/*).
      reqPath = event.path || '/';
    }

    // The canonical frontend always uses the single-origin /work API seam.
    // Full portal mode rewrites it above; API-only/local mode performs the
    // same in-process mapping without enabling browser-session auth or docs.
    if (!isDocsDomainEnabled() && reqPath === '/work/health') {
      event.path = '/api/health';
      reqPath = event.path;
    } else if (!isDocsDomainEnabled() && reqPath.startsWith('/work/api/')) {
      event.path = reqPath.slice('/work'.length);
      reqPath = event.path;
    }

    // ── Auth routes (exempt from middleware) ─────────────────────
    const portalUserId = await portalTrustedUserId(event);
    // x-user-id is an internal identity propagation header, never a client
    // credential. Preserve it only in the explicit test auth bypass; all real
    // requests must replace it with an identity established below.
    if (!skipAuth) deleteHeader(event.headers, 'x-user-id');
    const serviceResponse = await handleInvoiceReader(event, client);
    if (serviceResponse) return serviceResponse;
    const verifiedInteractiveUserId = browserUserId || portalUserId;
    if (verifiedInteractiveUserId) {
      if (!event.headers) event.headers = {};
      event.headers['x-user-id'] = verifiedInteractiveUserId;
    }
    // Portal mode disables password auth, but the device flow is how non-browser
    // clients obtain a credential from that same portal session.
    if (portalMode && reqPath.startsWith('/api/auth') && !reqPath.startsWith('/api/auth/device')) {
      return jsonResponse(404, { error: 'Not found' });
    }
    if (reqPath.startsWith('/api/auth/device')) {
      const result = await handleCliAuthRoutes(reqPath, method, event);
      if (result) return result;
    }
    const testTemplateActorId = skipAuth ? process.env.E2E_TEMPLATE_ACTOR_ID || '' : '';
    if (skipAuth && reqPath === '/api/me' && (headerValue(event.headers, 'x-user-id') || testTemplateActorId)) {
      const user = await getUser(client, headerValue(event.headers, 'x-user-id') || testTemplateActorId);
      return user && !user.disabled
        ? jsonResponse(200, { user: identityProjection(user) })
        : jsonResponse(401, { error: 'Unauthorized' });
    }
    if (portalMode && reqPath === '/api/me') {
      if (verifiedInteractiveUserId) {
        const user = await getUser(client, verifiedInteractiveUserId);
        return user && !user.disabled
          ? jsonResponse(200, { user: identityProjection(user) })
          : jsonResponse(401, { error: 'Unauthorized' });
      }
      // Preserve the existing non-browser bearer-session contract, and accept
      // the API tokens CLI clients hold: `whoami` runs through this route.
      const bearer = extractToken(event);
      const session = bearer ? await getSession(client, bearer) : null;
      const bearerApiToken = bearer && !session ? await getApiToken(client, bearer) : null;
      const bearerUserId = session?.userId || bearerApiToken?.userId || '';
      if (bearerUserId) {
        if (bearerApiToken) await touchApiToken(client, bearerApiToken);
        const user = await getUser(client, bearerUserId);
        return user && !user.disabled
          ? jsonResponse(200, { user: identityProjection(user) })
          : jsonResponse(401, { error: 'Unauthorized' });
      }
      return jsonResponse(401, { error: 'Unauthorized' });
    }
    if (reqPath.startsWith('/api/auth') || reqPath === '/api/me') {
      const result = await handleAuthRoutes(event);
      if (result) return result;
    }

    // API-only/local configurations still expose the same canonical frontend;
    // full portal mode serves it earlier after browser authentication.
    if (!portalMode && method === 'GET' && (reqPath === '/' || reqPath === '/index.html' || reqPath.startsWith('/src/'))) {
      const frontend = serveCanonicalFrontend(event);
      if (frontend) return frontend;
    }

    // ── Auth middleware ───────────────────────────────────────────
    // All /api/* routes (except exempt ones) require a valid session.
    // In test mode (NODE_ENV=test), auth can be bypassed with SKIP_AUTH=true.
    // Portal browser cookies and legacy bearer sessions are independent. The
    // generic bearer middleware below remains available in portal mode.
    // A portal pass without an identity (local development with browser auth
    // unconfigured) must not skip bearer validation: without it no x-user-id
    // is ever established and every interactive route fails closed.
    if (!skipAuth && !verifiedInteractiveUserId && (reqPath.startsWith('/api/') || isDocsRoute(reqPath)) && !isAuthExempt(method, reqPath)) {
      const token = extractToken(event);
      if (!token) {
        return jsonResponse(401, { error: 'Unauthorized' });
      }
      const session = await getSession(client, token);
      // CLI and script clients present an API token instead of a session. It
      // resolves to the same user, so every downstream role check is unchanged.
      const apiToken = session ? null : await getApiToken(client, token);
      if (!session && !apiToken) {
        return jsonResponse(401, { error: 'Unauthorized' });
      }
      if (apiToken) await touchApiToken(client, apiToken);
      // Attach userId to event headers for downstream use
      if (!event.headers) event.headers = {};
      event.headers['x-user-id'] = session ? session.userId : apiToken!.userId;
    }

    // GET /api/health — health check
    if (method === 'GET' && reqPath === '/api/health') {
      return jsonResponse(200, { status: 'ok' });
    }

    // ── Safe team directory ───────────────────────────────────────
    // The work projection of the workspace. `/api/users` stays the
    // account-management surface and is not used by routine work views.
    if (reqPath.startsWith('/api/team-members')) {
      const result = await handleTeamMemberRoutes(reqPath, method, event);
      if (result) return result;
    }

    // ── Task routes ────────────────────────────────────────────────
    if (reqPath.startsWith('/api/bookkeeping')) {
      return await handleBookkeepingRoutes(reqPath, method, event, client, skipAuth || !!portalUserId || portalAuthorized || !!headerValue(event.headers, 'x-user-id'));
    }

    if (reqPath.startsWith('/api/sponsor-crm')) {
      if (isSponsorCommunicationRoute(reqPath)) {
        return await handleSponsorCommunicationRoutes(reqPath, method, event, client);
      }
      const finance = await handleSponsorFinanceRoutes(reqPath, method, event, client);
      if (finance) return finance;
      return await handleSponsorCrmRoutes(reqPath, method, event, client);
    }
    if (reqPath.startsWith('/api/newsletter-slots')) return await handleNewsletterSlotRoutes(reqPath,method,event,client);
    if (reqPath.startsWith('/api/calendar-items')) return await handleCalendarRoutes(reqPath,method,event,client);

    if (reqPath.startsWith('/api/conversational/execution-attempts/')) {
      const result = await handleConversationalExecutionRoutes(reqPath, method, event, client);
      if (result) return result;
    }
    if (reqPath.startsWith('/api/conversational/identity-bindings')) {
      const result = await handleConversationalIdentityBindingRoutes(reqPath, method, event, client);
      if (result) return result;
    }
    if (reqPath === '/api/conversational/readiness') {
      const result = await handleConversationalReadiness(reqPath, method, event, client);
      if (result) return result;
    }

    // ── Task routes ────────────────────────────────────────────────
    if (reqPath.startsWith('/api/tasks')) {
      const result = await handleTaskRoutes(reqPath, method, event, client);
      if (result) return result;
    }

    // ── Assistant, artifact, and file routes ──────────────────────

    if (reqPath.startsWith('/api/assistant-jobs')) {
      const result = await handleAssistantJobRoutes(event, client);
      if (result) return result;
    }

    if (reqPath.startsWith('/api/assistant-social-drafts')) {
      const result = await handleSocialDraftAssistantRoutes(event, client);
      if (result) return result;
    }

    if (reqPath.startsWith('/api/document-reviews')) {
      const result = await handleDocumentReviewRoutes(event, client);
      if (result) return result;
    }

    if (reqPath === '/api/operating-model') {
      const result = await handleOperatingModelRoutes(event, client);
      if (result) return result;
    }

    if (reqPath.startsWith('/api/artifacts')) {
      const result = await handleArtifactRoutes(event);
      if (result) return result;
    }

    if (reqPath.startsWith('/api/files')) {
      const result = await handleFileRoutes(event);
      if (result) return result;
    }

    // ── Card routes ──────────────────────────────────────────────

    if (reqPath.startsWith('/api/cards')) {
      const result = await handleCardRoutes(reqPath, method, event.body || null, event, client);
      if (result) return result;
    }

    // ── Template routes ────────────────────────────────────────────

    if (reqPath.startsWith('/api/templates')) {
      const result = await handleTemplateRoutes(reqPath, method, event.body || null, event);
      if (result) return result;
    }

    // ── Recurring routes ───────────────────────────────────────────

    if (reqPath.startsWith('/api/recurring')) {
      const result = await handleRecurringRoutes(reqPath, method, event.body || null, event);
      if (result) return result;
    }

    // ── User routes ──────────────────────────────────────────────

   if (reqPath.startsWith('/api/users')) {
      const result = await handleUserRoutes(reqPath, method, event.body || null, event);
      if (result) return result;
   }

    // ── Notification routes ─────────────────────────────────────

    if (reqPath.startsWith('/api/tokens')) {
      const result = await handleCliAuthRoutes(reqPath, method, event);
      if (result) return result;
    }

    if (reqPath.startsWith('/api/notifications')) {
      const rawUserId = event.headers?.['x-user-id'] || undefined;
      const userId = rawUserId === 'portal-admin' ? undefined : rawUserId;
      const result = await handleNotificationRoutes(reqPath, method, event.body || null, event.queryStringParameters || null, userId);
      if (result) return result;
    }

    // ── Cron routes ───────────────────────────────────────────────

    if (reqPath.startsWith('/api/cron')) {
      const result = await handleCronRoutes(reqPath, method);
      if (result) return result;
    }

    // ── Docs domain (seam — stubs, flag-gated) ──────────────────
    // TODO(#87/#88): the docs content API is ported into this backend. While the
    // seam is stub-only it stays behind DATAOPS_DOCS_DOMAIN so existing routes
    // and tests are unaffected. Handlers currently return 501.
    if (isDocsDomainEnabled()) {
      if (isDocsRoute(reqPath)) {
        const resolved=await resolveInteractiveActor(client,event,method==='GET'?'work-read':'work-write');
        if(!resolved.ok)return resolved.response;
        const result=await handleDocsRoutes(event,resolved.actor.id || (resolved.actor.testBypass?'local-test-operator':''));
        if(result)return result;
      }
    }

    // Anything else — 404
    return jsonResponse(404, { error: 'Not found' });
  } catch (err: unknown) {
    if (err instanceof TaskVersionConflictError) {
      const currentTask = await getTaskConsistent(client, err.taskId);
      if (!currentTask) {
        return jsonResponse(404, { error: 'Task not found', code: 'task_not_found' });
      }
      return jsonResponse(409, {
        error: 'Task changed; review the current task and retry',
        code: 'task_version_conflict',
        expectedVersion: err.expectedVersion,
        currentVersion: currentTask.version,
        currentTask,
      });
    }
    if (err instanceof CardNotFoundError) {
      return jsonResponse(404, { error: 'Card not found', code: 'card_not_found' });
    }
    if (err instanceof CardLifecycleConflictError) {
      const [currentTask, ...currentCards] = await Promise.all([
        getTaskConsistent(client, err.taskId),
        ...err.cardIds.map((cardId) => getCardConsistent(client, cardId)),
      ]);
      if (!currentTask && !err.taskMayBeMissing) {
        return jsonResponse(404, { error: 'Task not found', code: 'task_not_found' });
      }
      const cards = currentCards.filter((card): card is NonNullable<typeof card> => card !== null);
      if (cards.length !== err.cardIds.length) {
        return jsonResponse(404, { error: 'Card not found', code: 'card_not_found' });
      }
      return jsonResponse(409, {
        error: 'Card or its Tasks changed; review current work and retry',
        code: 'card_lifecycle_conflict',
        currentTask: currentTask || undefined,
        currentCard: cards.length === 1 ? cards[0] : undefined,
        currentCards: cards.length > 1 ? cards : undefined,
      });
    }
    console.error('Unexpected error:', err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

export function isSponsorCommunicationRoute(pathname: string): boolean {
  const prefix = '/api/sponsor-crm/';
  if (!pathname.startsWith(prefix)) return false;
  const segments = pathname.slice(prefix.length).split('/');
  if (segments.some((segment) => segment.length === 0)) return false;

  const [family] = segments;
  if (family === 'bookings') {
    return segments.length === 3 && segments[2] === 'communications';
  }
  if (family === 'communication-suggestions') {
    return segments.length === 3 && segments[2] === 'drafts';
  }
  if (family === 'contacts') {
    return segments.length === 3 && segments[2] === 'suppressions';
  }
  if (family !== 'communications') return false;

  if (
    segments.length === 2
    && (segments[1] === 'config' || segments[1] === 'evaluate')
  ) return true;
  if (
    segments[1] === 'attempts'
    && segments.length === 4
    && (segments[3] === 'cancel' || segments[3] === 'reconcile')
  ) return true;
  return (
    (segments.length === 3
      && (segments[2] === 'presentations' || segments[2] === 'approve'))
    || (segments.length === 5
      && segments[2] === 'presentations'
      && segments[4] === 'reject')
  );
}

export { route };
