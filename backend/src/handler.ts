import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { route } from './router';
import { getClient } from './db/client';
import { runCron } from './cron/runner';
import { writePortableExportArchive } from './export/archive';
import { runConfiguredMailingExports } from './mailingExports/service';
import { sanitizeJsonResponse } from './responsePrivacy';
import type { CronRunnerResult } from './cron/runner';
import type { LambdaEvent, LambdaResponse } from './types';
import {
  ConversationalRolloutConfigurationError,
  conversationalRolloutSnapshot,
} from './conversation/rollout';
import { logConversationalEvent } from './conversation/observability';
import {
  assertCanonicalDeploymentTemplateLoader,
  seedDeploymentRuntime,
} from './deploymentSeeds';
import {
  apiRequestMethod,
  classifyApiRouteFamily,
  emitApiRequestMetrics,
  safeApiRequestId,
} from './apiRequestTelemetry';
import type { ApiErrorClass, ApiRequestMetricEmitter } from './apiRequestTelemetry';

let client: DynamoDBDocumentClient | null = null;
let initialized = false;
let portalApiColdStart = true;

function consumePortalApiColdStart(): boolean {
  const value = portalApiColdStart;
  portalApiColdStart = false;
  return value;
}

interface HttpApiTelemetryOverrides {
  monotonicClock?: () => number;
  wallClock?: () => number;
  emit?: ApiRequestMetricEmitter;
  coldStart?: boolean;
}

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    client = await getClient();
    initialized = true;
  }
}

/**
 * Check if this is an EventBridge scheduled event.
 */
function isScheduledEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return (
    e.source === 'aws.events' ||
    e['detail-type'] === 'Scheduled Event'
  );
}

function isRuntimeSeedEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const raw = event as Record<string, unknown>;
  const detail = raw.detail as Record<string, unknown> | undefined;
  return raw.source === 'dataops.deploy'
    && raw['detail-type'] === 'Runtime Seed'
    && detail?.dataopsAction === 'sync-runtime-seeds';
}

function isDeploymentControlEvent(event: unknown): boolean {
  return typeof event === 'object'
    && event !== null
    && (event as Record<string, unknown>).source === 'dataops.deploy';
}

function isJsonBody(response: LambdaResponse): boolean {
  const contentType = Object.entries(response.headers || {})
    .find(([key]) => key.toLowerCase() === 'content-type')
    ?.[1] || '';
  const normalizedContentType = String(contentType).toLowerCase();
  if (normalizedContentType.includes('application/json')) return true;
  if (normalizedContentType || typeof response.body !== 'string') return false;
  try {
    const parsed = JSON.parse(response.body) as unknown;
    return Boolean(parsed)
      && typeof parsed === 'object'
      && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function deleteHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string
): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}

function attachCorrelationId(response: LambdaResponse, requestId: string): LambdaResponse {
  const headers = { ...(response.headers || {}) };
  deleteHeaderCaseInsensitive(headers, 'x-dataops-request-id');
  let result = {
    ...response,
    headers: { ...headers, 'x-dataops-request-id': requestId },
  };

  if (result.statusCode >= 500 && result.statusCode < 600 && isJsonBody(result)) {
    try {
      const body = JSON.parse(result.body) as Record<string, unknown>;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        body.requestId = requestId;
        result = { ...result, body: JSON.stringify(body) };
      }
    } catch {
      // Leave an invalid JSON body unchanged rather than making it look valid.
    }
  }

  return result;
}

async function withApiRequestTelemetry(
  event: LambdaEvent,
  context: unknown,
  operation: () => Promise<LambdaResponse>,
  overrides: HttpApiTelemetryOverrides = {}
): Promise<LambdaResponse> {
  const monotonicClock = overrides.monotonicClock ?? performance.now.bind(performance);
  const wallClock = overrides.wallClock ?? Date.now;
  const emitMetric = overrides.emit ?? emitApiRequestMetrics;
  const coldStart = overrides.coldStart ?? consumePortalApiColdStart();
  const requestId = safeApiRequestId(context);
  let startedAt: number | null = null;
  try {
    startedAt = monotonicClock();
  } catch {
    // A faulty telemetry clock must not prevent the business route from running.
  }
  let errorClass: ApiErrorClass | undefined;

  let response: LambdaResponse;
  try {
    response = await operation();
  } catch (error) {
    errorClass = 'unhandled_exception';
    // Preserve the pre-telemetry behavior of exposing an escaping failure in
    // runtime diagnostics while keeping its raw details out of the response.
    console.error('Unhandled API request error:', error);
    response = sanitizeJsonResponse({
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    });
  }

  if (!errorClass && response.statusCode >= 500 && response.statusCode < 600) {
    errorClass = 'route_handled';
  }

  let correlatedResponse: LambdaResponse;
  try {
    correlatedResponse = attachCorrelationId(response, requestId);
  } catch {
    // Correlation must not replace an already privacy-sanitized business
    // response when its response-mutation step itself fails.
    correlatedResponse = response;
  }

  try {
    let endedAt: number | null = null;
    try {
      endedAt = monotonicClock();
    } catch {
      // Missing one endpoint of a faulty clock reports zero duration rather
      // than changing the response contract.
    }
    const durationMs = startedAt === null || endedAt === null
      ? 0
      : Math.max(0, endedAt - startedAt);
    let timestamp: number | undefined;
    try {
      timestamp = wallClock();
    } catch {
      // The dedicated emitter supplies the real wall clock when an injected
      // timestamp source fails, so the invocation still gets exactly one record.
    }
    emitMetric({
      routeFamily: classifyApiRouteFamily(event.path),
      method: apiRequestMethod(event.httpMethod),
      statusCode: correlatedResponse.statusCode,
      durationMs,
      requestId,
      coldStart,
      timestamp,
      ...(errorClass ? { errorClass } : {}),
    });
  } catch {
    // Telemetry faults never alter the privacy-sanitized HTTP contract.
  }

  return correlatedResponse;
}

function normalizeHttpApiEvent(
  event: LambdaEvent | Record<string, unknown>
): LambdaEvent | null {
  if (typeof event !== 'object' || event === null) return null;
  const raw = event as Record<string, unknown>;
  if (typeof raw.httpMethod === 'string') return raw as unknown as LambdaEvent;

  const requestContext = raw.requestContext as Record<string, unknown> | undefined;
  const http = requestContext?.http as Record<string, unknown> | undefined;
  if (typeof http?.method !== 'string') return null;

  return {
    httpMethod: http.method,
    path: (raw.rawPath as string)
      || (typeof http?.path === 'string' ? http.path : '/')
      || '/',
    headers: (raw.headers as Record<string, string>) || {},
    body: (raw.body as string) ?? null,
    isBase64Encoded: (raw.isBase64Encoded as boolean) || false,
    queryStringParameters: (raw.queryStringParameters as Record<string, string>) || null,
  };
}

async function handleInvocation(
  event: LambdaEvent | Record<string, unknown>,
  _context?: unknown
): Promise<LambdaResponse | CronRunnerResult> {
  await ensureInitialized();

  // IAM-only deployment invocation. This uses the exact packaged runtime and
  // never depends on a package install in the GitHub Actions deploy checkout.
  if (isRuntimeSeedEvent(event)) {
    if (process.env.NODE_ENV !== 'test') assertCanonicalDeploymentTemplateLoader();
    const result = await seedDeploymentRuntime(client!);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  }

  if (isDeploymentControlEvent(event)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid deployment control event' }),
    };
  }

  // Handle EventBridge scheduled events
  if (isScheduledEvent(event)) {
    const detail = typeof event === 'object' && event !== null
      ? (event as Record<string, unknown>).detail as Record<string, unknown> | undefined
      : undefined;
    if (detail?.dataopsAction === 'export') {
      const archiveBucket = process.env.DATAOPS_EXPORT_ARCHIVE_BUCKET || '';
      const archivePrefix = process.env.DATAOPS_EXPORT_ARCHIVE_PREFIX || 'execution-exports';
      const archiveLocalDir = process.env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR || '';
      const result = await writePortableExportArchive(client!, {
        bucket: archiveBucket || undefined,
        prefix: archivePrefix,
        environment: process.env.DATAOPS_ENV,
        localArchiveDir: archiveLocalDir || undefined,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          archive_uri: result.archiveUri,
          archive_key: result.archiveKey,
          generated_at: result.manifest.generated_at,
          schema_version: result.manifest.schema_version,
          export_format_version: result.manifest.export_format_version,
          entity_counts: result.manifest.entity_counts,
          checksums: result.manifest.checksums,
          archive_checksum: result.archiveChecksum,
          archive_size_bytes: result.archiveSizeBytes,
        }),
      };
    }
    if (detail?.dataopsAction === 'mailing-export') {
      const runKey = typeof detail.runKey === 'string' ? detail.runKey : new Date().toISOString().slice(0, 10);
      const exports = await runConfiguredMailingExports(client!, runKey);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exports }) };
    }
    return runCron(client!);
  }

  return sanitizeJsonResponse(await route(event as LambdaEvent, client!));
}

async function handleInvocationAfterRolloutCheck(
  event: LambdaEvent | Record<string, unknown>,
  context?: unknown
): Promise<LambdaResponse | CronRunnerResult> {
  try {
    conversationalRolloutSnapshot();
  } catch (error) {
    if (error instanceof ConversationalRolloutConfigurationError) {
      logConversationalEvent('configuration_rejected', 'telegram');
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Conversational rollout configuration is invalid' }),
      };
    }
    throw error;
  }

  return await handleInvocation(event, context);
}

async function handler(
  event: LambdaEvent | Record<string, unknown>,
  context?: unknown
): Promise<LambdaResponse | CronRunnerResult> {
  if (
    isScheduledEvent(event)
    || isRuntimeSeedEvent(event)
    || isDeploymentControlEvent(event)
  ) {
    return handleInvocationAfterRolloutCheck(event, context);
  }

  const httpApiEvent = normalizeHttpApiEvent(event);
  if (!httpApiEvent) return handleInvocationAfterRolloutCheck(event, context);

  return withApiRequestTelemetry(httpApiEvent, context, async () =>
    await handleInvocationAfterRolloutCheck(httpApiEvent, context) as LambdaResponse
  );
}

export {
  handler,
  withApiRequestTelemetry,
};
export type { HttpApiTelemetryOverrides };
// trigger deploy
