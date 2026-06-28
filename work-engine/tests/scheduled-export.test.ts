import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createTask } from '../src/db/tasks';
import { handleCronRoutes } from '../src/routes/cron';
import { validatePortableExport } from '../src/export/portable';

describe('scheduled export route (POST /api/cron/export)', () => {
  let client: DynamoDBDocumentClient;
  let exportDir: string;
  let archiveDir: string;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-cron-export-'));
    archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-cron-archive-'));
    process.env.EXPORT_OUTPUT_DIR = exportDir;
  });

  after(async () => {
    delete process.env.EXPORT_OUTPUT_DIR;
    delete process.env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR;
    delete process.env.DATAOPS_EXPORT_ARCHIVE_PREFIX;
    delete process.env.DATAOPS_ENV;
    await fs.rm(exportDir, { recursive: true, force: true });
    await fs.rm(archiveDir, { recursive: true, force: true });
    await stopLocal();
  });

  it('rejects non-POST methods', async () => {
    const result = await handleCronRoutes('/api/cron/export', 'GET');
    assert.ok(result);
    assert.strictEqual(result!.statusCode, 405);
  });

  it('returns 400 when EXPORT_OUTPUT_DIR is not set', async () => {
    const saved = process.env.EXPORT_OUTPUT_DIR;
    delete process.env.EXPORT_OUTPUT_DIR;
    try {
      const result = await handleCronRoutes('/api/cron/export', 'POST');
      assert.ok(result);
      assert.strictEqual(result!.statusCode, 400);
      const body = JSON.parse(result!.body);
      assert.match(body.error, /Export storage/);
    } finally {
      process.env.EXPORT_OUTPUT_DIR = saved;
    }
  });

  it('produces a valid export and returns manifest summary', async () => {
    await createTask(client, { description: 'Export test task', date: '2026-06-27' });

    const result = await handleCronRoutes('/api/cron/export', 'POST');
    assert.ok(result);
    assert.strictEqual(result!.statusCode, 200);

    const body = JSON.parse(result!.body);
    assert.strictEqual(body.schema_version, 'dataops.execution.v1');
    assert.ok(body.entity_counts.tasks >= 1);
    assert.strictEqual(body.output_dir, exportDir);

    // The exported files must exist and validate
    const manifestPath = path.join(exportDir, 'manifest.json');
    await fs.access(manifestPath);
    const validation = await validatePortableExport(exportDir);
    assert.strictEqual(validation.valid, true);
  });

  it('writes an offsite archive when archive storage is configured', async () => {
    await createTask(client, { description: 'Archive route task', date: '2026-06-28' });
    process.env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR = archiveDir;
    process.env.DATAOPS_EXPORT_ARCHIVE_PREFIX = 'execution-exports';
    process.env.DATAOPS_ENV = 'staging';

    const result = await handleCronRoutes('/api/cron/export', 'POST');
    assert.ok(result);
    assert.strictEqual(result!.statusCode, 200);

    const body = JSON.parse(result!.body);
    assert.match(body.archive_uri, /^file:\/\//);
    assert.match(body.archive_key, /^execution-exports\/staging\//);
    assert.strictEqual(body.schema_version, 'dataops.execution.v1');
    assert.strictEqual(body.export_format_version, 1);
    assert.ok(body.entity_counts.tasks >= 1);
    assert.ok(body.checksums['manifest.json'] === undefined);
    assert.ok(body.archive_checksum.startsWith('sha256:'));
    assert.strictEqual(typeof body.archive_size_bytes, 'number');
    assert.doesNotMatch(result!.body, /secret|token|credential|signed/i);

    await fs.access(body.archive_uri.replace('file://', ''));
  });
});
