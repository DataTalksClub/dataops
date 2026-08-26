import { randomUUID } from 'node:crypto';

import { DOCS_ROUTE_PREFIXES } from './docs/contentApi';

export const API_TELEMETRY_NAMESPACE = 'DataOps/PortalAPI';

export type ApiRouteFamily =
  | 'health_auth_team'
  | 'tasks'
  | 'cards'
  | 'templates'
  | 'recurring'
  | 'files'
  | 'artifacts'
  | 'assistant_jobs_social_drafts'
  | 'intake'
  | 'users_tokens'
  | 'notifications'
  | 'calendar_newsletter'
  | 'bookkeeping'
  | 'sponsor_crm'
  | 'mailing_exports'
  | 'conversational_telegram'
  | 'email_documents'
  | 'docs_content_search'
  | 'static_frontend'
  | 'other';

export type ApiRequestMethod =
  | 'DELETE'
  | 'GET'
  | 'HEAD'
  | 'OPTIONS'
  | 'OTHER'
  | 'PATCH'
  | 'POST'
  | 'PUT';

export type ApiStatusClass = '2xx' | '3xx' | '4xx' | '5xx';
export type ApiErrorClass = 'route_handled' | 'unhandled_exception';
export type ApiRequestMetricEmitter = (input: ApiRequestMetricInput) => void;

export interface ApiRequestMetricInput {
  routeFamily: ApiRouteFamily;
  method: ApiRequestMethod;
  statusCode: number;
  durationMs: number;
  requestId: string;
  coldStart: boolean;
  timestamp?: number;
  errorClass?: ApiErrorClass;
}

const REQUEST_METHODS = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
]);

const ROUTE_FAMILIES: ReadonlyArray<readonly [ApiRouteFamily, string]> = [
  ['email_documents', '/api/v1/intake/email-documents'],
  ['conversational_telegram', '/api/webhook/telegram'],
  ['email_documents', '/api/webhook/email'],
  ['health_auth_team', '/api/health'],
  ['health_auth_team', '/api/auth'],
  ['health_auth_team', '/api/me'],
  ['health_auth_team', '/api/team-members'],
  ['tasks', '/api/tasks'],
  ['cards', '/api/cards'],
  ['templates', '/api/templates'],
  ['recurring', '/api/recurring'],
  ['files', '/api/files'],
  ['artifacts', '/api/artifacts'],
  ['assistant_jobs_social_drafts', '/api/assistant-jobs'],
  ['assistant_jobs_social_drafts', '/api/assistant-social-drafts'],
  ['intake', '/api/intake'],
  ['users_tokens', '/api/users'],
  ['users_tokens', '/api/tokens'],
  ['notifications', '/api/notifications'],
  ['calendar_newsletter', '/api/calendar-items'],
  ['calendar_newsletter', '/api/newsletter-slots'],
  ['bookkeeping', '/api/bookkeeping'],
  ['recurring', '/api/cron'],
  ['sponsor_crm', '/api/sponsor-crm'],
  ['mailing_exports', '/api/mailing-exports'],
  ['conversational_telegram', '/api/conversational'],
];

const ROUTE_FAMILY_VALUES = new Set<string>(
  ROUTE_FAMILIES.map(([family]) => family).concat('other')
);

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function canonicalClassificationPath(path: unknown): string {
  const value = typeof path === 'string' && path.length > 0 ? path : '/';
  if (value === '/work/health') return '/api/health';
  if (value === '/work/api') return '/api';
  if (value.startsWith('/work/api/')) return value.slice('/work'.length);
  return value;
}

export function classifyApiRouteFamily(path: unknown): ApiRouteFamily {
  const normalizedPath = canonicalClassificationPath(path);
  const isApiPath = normalizedPath === '/api'
    || normalizedPath.startsWith('/api/');

  for (const [family, prefix] of ROUTE_FAMILIES) {
    if (matchesPrefix(normalizedPath, prefix)) return family;
  }

  if (
    DOCS_ROUTE_PREFIXES.some((prefix) => matchesPrefix(normalizedPath, prefix))
    || matchesPrefix(normalizedPath, '/content')
  ) {
    return 'docs_content_search';
  }

  return isApiPath ? 'other' : 'static_frontend';
}

export function apiRequestMethod(method: unknown): ApiRequestMethod {
  const normalized = String(method ?? 'GET').trim().toUpperCase();
  return REQUEST_METHODS.has(normalized) ? normalized as ApiRequestMethod : 'OTHER';
}

export function apiStatusClass(statusCode: number): ApiStatusClass {
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  if (statusCode >= 500 && statusCode < 600) return '5xx';
  return '2xx';
}

function safeHeaderId(candidate: string): string | null {
  return candidate.length > 0
    && candidate.length <= 128
    && /^[A-Za-z0-9._-]+$/.test(candidate)
    ? candidate
    : null;
}

/**
 * CloudWatch accepts each serialized object as one EMF record. Only fixed
 * dimensions and platform-provided correlation metadata are exposed here.
 */
export function emitApiRequestMetrics(input: ApiRequestMetricInput): void {
  try {
    const timestamp = input.timestamp ?? Date.now();
    const durationMs = Math.max(0, Number.isFinite(input.durationMs) ? input.durationMs : 0);
    const statusClass = apiStatusClass(input.statusCode);
    const failureValue = statusClass === '5xx' ? 1 : 0;
    const requestId = safeHeaderId(input.requestId);
    if (
      !Number.isSafeInteger(timestamp)
      || requestId === null
      || !ROUTE_FAMILY_VALUES.has(input.routeFamily)
    ) return;

    const record: Record<string, unknown> = {
      _aws: {
        Timestamp: timestamp,
        CloudWatchMetrics: [{
          Namespace: API_TELEMETRY_NAMESPACE,
          Dimensions: [['RouteFamily', 'Method', 'StatusClass']],
          Metrics: [
            { Name: 'RequestCount', Unit: 'Count' },
            { Name: 'RequestDurationMs', Unit: 'Milliseconds' },
            { Name: 'HandledApiFailures', Unit: 'Count' },
          ],
        }],
      },
      RouteFamily: input.routeFamily,
      Method: input.method,
      StatusClass: statusClass,
      RequestCount: 1,
      RequestDurationMs: durationMs,
      HandledApiFailures: failureValue,
      RequestId: requestId,
      ColdStart: Boolean(input.coldStart),
    };

    if (failureValue === 1) record.ErrorClass = input.errorClass ?? 'route_handled';
    console.log(JSON.stringify(record));
  } catch {
    // Observability must never replace the HTTP business response.
  }
}

export function safeApiRequestId(context: unknown): string {
  const candidate = (context as { awsRequestId?: unknown } | null | undefined)?.awsRequestId;
  if (typeof candidate !== 'string') return randomUUID();
  return safeHeaderId(candidate.trim()) ?? randomUUID();
}
