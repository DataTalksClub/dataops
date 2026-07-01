import { getClient } from '../db/client';
import { runCron } from '../cron/runner';
import { writePortableExportArchive } from '../export/archive';
import { writePortableExport } from '../export/portable';
import type { LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/**
 * Handle /api/cron routes: run recurring tasks and scheduled export.
 */
async function handleCronRoutes(path: string, method: string): Promise<LambdaResponse | null> {
  if (path !== '/api/cron/run' && path !== '/api/cron/export') {
    return null;
  }

  if (path === '/api/cron/export') {
    return handleScheduledExport(method);
  }

  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const client = await getClient();
    const result = await runCron(client);

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(result),
    };
  } catch (err: unknown) {
    console.error('Cron route error:', err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

async function handleScheduledExport(method: string): Promise<LambdaResponse> {
  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const client = await getClient();
    const archiveBucket = process.env.DATAOPS_EXPORT_ARCHIVE_BUCKET || '';
    const archivePrefix = process.env.DATAOPS_EXPORT_ARCHIVE_PREFIX || 'execution-exports';
    const archiveLocalDir = process.env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR || '';
    const outputDir = process.env.EXPORT_OUTPUT_DIR || '';

    if (archiveBucket || archiveLocalDir) {
      const result = await writePortableExportArchive(client, {
        bucket: archiveBucket || undefined,
        prefix: archivePrefix,
        environment: process.env.DATAOPS_ENV,
        localArchiveDir: archiveLocalDir || undefined,
        tempDir: outputDir || undefined,
      });
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
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

    if (!outputDir) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Export storage is not configured' }),
      };
    }

    const result = await writePortableExport(client, outputDir);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        output_dir: result.outputDir,
        schema_version: result.manifest.schema_version,
        entity_counts: result.manifest.entity_counts,
        generated_at: result.manifest.generated_at,
      }),
    };
  } catch (err: unknown) {
    console.error('Scheduled export route error:', err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

export { handleCronRoutes };
