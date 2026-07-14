import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { route } from './router';
import { getClient } from './db/client';
import { createTables, shouldAutoCreateTables } from './db/setup';
import { runCron } from './cron/runner';
import { writePortableExportArchive } from './export/archive';
import { runConfiguredMailingExports } from './mailingExports/service';
import { sanitizeJsonResponse } from './responsePrivacy';
import type { CronRunnerResult } from './cron/runner';
import type { LambdaEvent, LambdaResponse } from './types';

let client: DynamoDBDocumentClient | null = null;
let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    client = await getClient();
    if (shouldAutoCreateTables()) {
      await createTables(client);
    }
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

async function handler(event: LambdaEvent | Record<string, unknown>, _context?: unknown): Promise<LambdaResponse | CronRunnerResult> {
  // Normalize Lambda Function URL events to the API Gateway-shaped LambdaEvent
  // the router expects. Function URLs send requestContext.http.method/path and
  // rawPath, not httpMethod/path.
  if (typeof event === 'object' && event !== null && !('httpMethod' in event)) {
    const raw = event as Record<string, unknown>;
    const requestContext = raw.requestContext as Record<string, unknown> | undefined;
    const http = requestContext?.http as Record<string, unknown> | undefined;
    if (http?.method || raw.rawPath) {
      event = {
        httpMethod: (http?.method as string) || 'GET',
        path: (raw.rawPath as string) || (http?.path as string) || '/',
        headers: (raw.headers as Record<string, string>) || {},
        body: (raw.body as string) ?? null,
        isBase64Encoded: (raw.isBase64Encoded as boolean) || false,
        queryStringParameters: (raw.queryStringParameters as Record<string, string>) || null,
      } as LambdaEvent;
    }
  }

  await ensureInitialized();

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

export { handler };
// trigger deploy
