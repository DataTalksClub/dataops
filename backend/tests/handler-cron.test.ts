import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { handler } from '../src/handler';
import { stopLocal } from '../scripts/local-dynamodb';
import { useTestDatabase } from './helpers/db';
import { extractExportArchive } from '../src/export/archive';
import { validatePortableExport } from '../src/export/portable';

describe('handler - EventBridge scheduled events', () => {
  before(async () => {
    // Tables come from infrastructure in production; the suite creates them.
    await useTestDatabase();
  });

  after(async () => {
    await stopLocal();
  });

  it('routes EventBridge scheduled event to cron runner (source: aws.events)', async () => {
    const event = {
      source: 'aws.events',
      'detail-type': 'Scheduled Event',
      detail: {},
    };

    const result = await handler(event);

    // Result should be a CronRunnerResult, not a LambdaResponse
    assert.ok('created' in result, 'should have "created" field');
    assert.ok('skipped' in result, 'should have "skipped" field');
    assert.ok(Array.isArray((result as Record<string, unknown>).created));
  });

  it('routes EventBridge event with only detail-type', async () => {
    const event = {
      'detail-type': 'Scheduled Event',
      detail: {},
    };

    const result = await handler(event);

    assert.ok('created' in result, 'should have "created" field');
    assert.ok('skipped' in result, 'should have "skipped" field');
  });

  it('routes scheduled export events to archive generation without production writes', async () => {
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-handler-export-'));
    process.env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR = archiveDir;
    process.env.DATAOPS_EXPORT_ARCHIVE_PREFIX = 'execution-exports';
    process.env.DATAOPS_ENV = 'test';
    try {
      const result = await handler({
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        detail: { dataopsAction: 'export' },
      });

      assert.ok('statusCode' in result, 'should return an HTTP-style archive summary');
      assert.strictEqual((result as Record<string, unknown>).statusCode, 200);
      const body = JSON.parse((result as { body: string }).body);
      assert.match(body.archive_uri, /^file:\/\//);
      assert.match(body.archive_key, /^execution-exports\/test\//);
      assert.strictEqual(body.schema_version, 'dataops.execution.v1');
      const archivePath = body.archive_uri.replace('file://', '');
      await fs.access(archivePath);
      const extractedDir = path.join(archiveDir, 'test-extracted');
      await extractExportArchive(await fs.readFile(archivePath), extractedDir);
      const manifest = JSON.parse(await fs.readFile(path.join(extractedDir, 'manifest.json'), 'utf8'));
      assert.strictEqual(manifest.source_environment, 'test');
      assert.notStrictEqual(manifest.source_environment, 'sandbox');
      assert.strictEqual((await validatePortableExport(extractedDir)).valid, true);
    } finally {
      delete process.env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR;
      delete process.env.DATAOPS_EXPORT_ARCHIVE_PREFIX;
      delete process.env.DATAOPS_ENV;
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it('routes scheduled exports with immutable sandbox provenance', async () => {
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-handler-sandbox-export-'));
    process.env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR = archiveDir;
    process.env.DATAOPS_EXPORT_ARCHIVE_PREFIX = 'execution-exports';
    process.env.DATAOPS_ENV = 'sandbox';
    try {
      const result = await handler({
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        detail: { dataopsAction: 'export' },
      });

      assert.ok('statusCode' in result, 'should return an HTTP-style archive summary');
      assert.strictEqual((result as Record<string, unknown>).statusCode, 200);
      const body = JSON.parse((result as { body: string }).body);
      const archivePath = body.archive_uri.replace('file://', '');
      const extractedDir = path.join(archiveDir, 'sandbox-extracted');
      assert.match(
        body.archive_key,
        /^execution-exports\/sandbox\/\d{4}-\d{2}-\d{2}\/dataops-execution-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.tar\.gz$/,
      );
      await extractExportArchive(await fs.readFile(archivePath), extractedDir);
      const manifest = JSON.parse(await fs.readFile(path.join(extractedDir, 'manifest.json'), 'utf8'));
      assert.strictEqual(manifest.source_environment, 'sandbox');
      assert.strictEqual(
        body.archive_key,
        `execution-exports/sandbox/${manifest.generated_at.slice(0, 10)}`
          + `/dataops-execution-${manifest.generated_at.replace(/[:.]/g, '-')}.tar.gz`,
      );
      assert.strictEqual((await validatePortableExport(extractedDir)).valid, true);
    } finally {
      delete process.env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR;
      delete process.env.DATAOPS_EXPORT_ARCHIVE_PREFIX;
      delete process.env.DATAOPS_ENV;
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it('does not route normal HTTP events as cron', async () => {
    const event = {
      httpMethod: 'GET',
      path: '/api/health',
    };

    const result = await handler(event);

    // This should be a normal HTTP response
    assert.ok('statusCode' in result, 'should have statusCode');
    assert.strictEqual((result as Record<string, unknown>).statusCode, 200);
  });
});
