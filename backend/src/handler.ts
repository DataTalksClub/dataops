import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { route } from './router';
import { getClient } from './db/client';
import { runCron } from './cron/runner';
import { recordAutomationRun } from './automations/runs';
import { expireCalendarHolds } from './db/calendarHolds';
import { writePortableExportArchive } from './export/archive';
import { backupConfigFromEnv, writeRawDynamoBackup } from './export/dynamoBackup';
import { checkDynamoPitrStatus } from './export/dynamoPitrCheck';
import type { PitrCheckResult } from './export/dynamoPitrCheck';
import { createNotification, dismissNotification, listUndismissedNotifications } from './db/notifications';
import { sanitizeJsonResponse } from './responsePrivacy';
import type { CronRunnerResult } from './cron/runner';
import type { LambdaEvent, LambdaResponse } from './types';
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
import {
  currentRequestError,
  logApiRequestFailure,
  runWithRequestErrorScope,
} from './requestErrorLog';

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

/** Run a scheduled job and record its outcome for the automations overview. */
async function recordedRun<T>(automationId: string, job: () => Promise<T>, summarize: (result: T) => string): Promise<T> {
  try {
    const result = await job();
    await recordAutomationRun(client!, automationId, { ok: true, summary: summarize(result) });
    return result;
  } catch (error) {
    await recordAutomationRun(client!, automationId, { ok: false, summary: `Failed: ${(error as Error)?.message || 'unknown error'}` });
    throw error;
  }
}

/**
 * Page the PITR guard through the portal's own notifications instead of a
 * CloudWatch alarm: the deploy role cannot create alarms or SNS topics, so
 * infra-level paging is unavailable to this stack. One undismissed
 * notification per active problem; auto-dismissed once the guard is green
 * again. A fully-unreadable check pages too, mirroring the old alarm's
 * treat-missing-data-as-breaching behavior.
 */
async function reconcilePitrGuardNotification(db: DynamoDBDocumentClient, result: PitrCheckResult): Promise<void> {
  const breaching = result.disabledTables.length > 0 || result.unknownTables.length === result.tableCount;
  const existing = (await listUndismissedNotifications(db)).filter(
    (notification) => notification.type === 'automation-failure'
      && notification.metadata?.guard === 'dynamo-pitr-check',
  );
  if (!breaching) {
    for (const notification of existing) await dismissNotification(db, notification.id);
    return;
  }
  if (existing.length > 0) return;
  const message = result.disabledTables.length > 0
    ? `DynamoDB PITR disabled on: ${result.disabledTables.join(', ')}`
    : `DynamoDB PITR status unknown for all ${result.tableCount} tables`;
  await createNotification(db, {
    type: 'automation-failure',
    message,
    metadata: {
      guard: 'dynamo-pitr-check',
      disabledTables: result.disabledTables,
      unknownTables: result.unknownTables,
    },
  });
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
  let failure: unknown;

  let response: LambdaResponse;
  try {
    response = await runWithRequestErrorScope(async () => {
      try {
        return await operation();
      } finally {
        failure = currentRequestError();
      }
    });
  } catch (error) {
    errorClass = 'unhandled_exception';
    // The escaping failure is reported on the 5xx log line below; its raw
    // details stay out of the response.
    failure = error;
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
    const routeFamily = classifyApiRouteFamily(event.path);
    const method = apiRequestMethod(event.httpMethod);
    if (errorClass) {
      logApiRequestFailure({
        method,
        path: event.path,
        routeFamily,
        statusCode: correlatedResponse.statusCode,
        durationMs,
        requestId,
        coldStart,
        errorClass,
        error: failure,
        responseError: response.body,
      });
    }
    emitMetric({
      routeFamily,
      method,
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
      const result = await recordedRun('execution-export', () => writePortableExportArchive(client!, {
        bucket: archiveBucket || undefined,
        prefix: archivePrefix,
        environment: process.env.DATAOPS_ENV,
        localArchiveDir: archiveLocalDir || undefined,
      }), (archive) => `${Object.values(archive.manifest.entity_counts).reduce((sum, count) => sum + Number(count || 0), 0)} records exported`);
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
    if (detail?.dataopsAction === 'dynamo-backup') {
      const result = await recordedRun('dynamo-backup', () => writeRawDynamoBackup(client!, backupConfigFromEnv()),
        (backup) => `${backup.manifest.item_count} items from ${backup.manifest.table_count} tables`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema_version: result.manifest.schema_version,
          generated_at: result.manifest.generated_at,
          source_environment: result.manifest.source_environment,
          manifest_uri: result.manifestUri,
          manifest_key: result.manifestKey,
          item_count: result.manifest.item_count,
          table_count: result.manifest.table_count,
          tables: Object.fromEntries(
            Object.entries(result.manifest.tables).map(([name, stats]) => [
              name,
              { items: stats.items, bytes: stats.bytes },
            ]),
          ),
        }),
      };
    }
    if (detail?.dataopsAction === 'dynamo-pitr-check') {
      const result = await recordedRun('dynamo-pitr-check', () => checkDynamoPitrStatus(client!),
        (check) => (check.unknownTables.length === check.tableCount
          ? `PITR status unknown for all ${check.tableCount} tables`
          : check.disabledTables.length === 0
            ? `PITR on for ${check.tableCount - check.unknownTables.length - check.expectedDisabledTables.length}/${check.tableCount} tables`
              + (check.expectedDisabledTables.length > 0 ? ` (${check.expectedDisabledTables.length} expected-disabled: sessions)` : '')
              + (check.unknownTables.length > 0 ? `, ${check.unknownTables.length} unknown` : '')
            : `PITR disabled: ${check.disabledTables.join(', ')}`
              + (check.unknownTables.length > 0 ? ` (${check.unknownTables.length} unknown)` : '')));
      await reconcilePitrGuardNotification(client!, result);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generated_at: result.generatedAt,
          table_count: result.tableCount,
          disabled_tables: result.disabledTables,
          expected_disabled_tables: result.expectedDisabledTables,
          unknown_tables: result.unknownTables,
          tables: Object.fromEntries(
            result.tables.map((status) => [
              status.table,
              {
                pitr: status.pitrEnabled,
                ...(status.earliestRestorable ? { earliest_restorable: status.earliestRestorable } : {}),
                ...(status.latestRestorable ? { latest_restorable: status.latestRestorable } : {}),
                ...(status.error ? { error: status.error } : {}),
              },
            ]),
          ),
        }),
      };
    }
    if (detail?.dataopsAction === 'calendar-holds-expire') {
      const dryRun = detail.dryRun === true;
      const nowIso = typeof detail.now === 'string' && detail.now.trim() ? detail.now.trim() : undefined;
      const result = dryRun
        ? await expireCalendarHolds(client!, nowIso, { dryRun: true })
        : await recordedRun(
            'calendar-hold-expiry',
            () => expireCalendarHolds(client!, nowIso),
            (run) => `${run.expired.length} hold${run.expired.length === 1 ? '' : 's'} expired`,
          );
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dryRun,
          activeCount: result.activeCount,
          expired: result.expired,
          followUps: result.followUps,
          note: 'Expired holds are released in DataOps and Google. Follow-ups are for Orin — no guest email was sent.',
        }),
      };
    }
    return runCron(client!);
  }

  return sanitizeJsonResponse(await route(event as LambdaEvent, client!));
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
    return handleInvocation(event, context);
  }

  const httpApiEvent = normalizeHttpApiEvent(event);
  if (!httpApiEvent) return handleInvocation(event, context);

  return withApiRequestTelemetry(httpApiEvent, context, async () =>
    await handleInvocation(httpApiEvent, context) as LambdaResponse
  );
}

export {
  handler,
  withApiRequestTelemetry,
};
export type { HttpApiTelemetryOverrides };
// trigger deploy
