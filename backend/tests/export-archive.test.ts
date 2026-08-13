import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createTask } from '../src/db/tasks';
import { validatePortableExport } from '../src/export/portable';
import {
  buildArchiveKey,
  extractExportArchive,
  writePortableExportArchive,
  writeRestoreEvidence,
} from '../src/export/archive';

function projectTmpDir(name: string): string {
  return path.join(__dirname, '..', '..', '.tmp', 'exports', `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

describe('offsite portable export archives', () => {
  let client: DynamoDBDocumentClient;
  let tmpDir: string;

  beforeEach(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    tmpDir = projectTmpDir('archive-test');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await stopLocal();
  });

  it('writes a portable tar.gz archive to local archive storage and restores evidence without data writes', async () => {
    await createTask(client, { description: 'Archive export task', date: '2026-06-27' });

    const result = await writePortableExportArchive(client, {
      environment: 'staging',
      localArchiveDir: path.join(tmpDir, 'archive-store'),
      tempDir: path.join(tmpDir, 'working-export'),
      prefix: 'execution-exports',
    });

    assert.match(result.archiveUri, /^file:\/\//);
    assert.match(result.archiveKey, /^execution-exports\/staging\/\d{4}-\d{2}-\d{2}\/dataops-execution-/);
    assert.ok(result.archiveChecksum.startsWith('sha256:'));
    assert.ok(result.archiveSizeBytes > 0);
    assert.strictEqual(result.manifest.entity_counts.tasks, 1);
    assert.strictEqual(result.manifest.entity_files.artifacts, 'artifacts.jsonl');
    assert.strictEqual(result.manifest.entity_files.assistant_jobs, 'assistant_jobs.jsonl');
    assert.strictEqual(result.manifest.entity_files.audit_events, 'audit_events.jsonl');

    const archivePath = result.archiveUri.replace('file://', '');
    const extractedDir = path.join(tmpDir, 'extracted');
    await extractExportArchive(await fs.readFile(archivePath), extractedDir);
    const validation = await validatePortableExport(extractedDir);
    assert.strictEqual(validation.valid, true);

    const evidence = await writeRestoreEvidence({
      archiveUri: result.archiveUri,
      expectedArchiveChecksum: result.archiveChecksum,
      outputDir: path.join(tmpDir, 'evidence'),
      targetEnvironment: 'restore-drill',
      appGitSha: 'test-sha',
      timestamp: '2026-06-27T10:00:00.000Z',
      smokeChecksPassed: true,
    });

    assert.ok(evidence.evidencePath.endsWith('restore-evidence-2026-06-27T10-00-00-000Z.json'));
    assert.strictEqual(evidence.report.archive_uri, result.archiveUri);
    assert.strictEqual(evidence.report.expected_archive_checksum, result.archiveChecksum);
    assert.strictEqual(evidence.report.calculated_archive_checksum, result.archiveChecksum);
    assert.strictEqual(evidence.report.app_git_sha, 'test-sha');
    assert.strictEqual(evidence.report.validation.valid, true);
    assert.strictEqual(evidence.report.dry_run_import.valid, true);
    assert.strictEqual(evidence.report.dry_run_import.wouldWrite.tasks, 1);
    assert.deepStrictEqual(evidence.report.skipped_record_counts, {});
    assert.strictEqual(evidence.report.invalid_record_count, 0);
    assert.strictEqual(evidence.report.target_environment, 'restore-drill');
    assert.ok(evidence.report.smoke_check_checklist.every((item) => item.result === 'passed'));
    assert.match(evidence.report.production_write_gate, /human-approved/);
    await fs.access(evidence.evidencePath);
  });

  it('uploads an archive to a configured S3 bucket with a safe key and no credentials in the result', async () => {
    await createTask(client, { description: 'S3 archive task', date: '2026-06-27' });
    const sentCommands: unknown[] = [];
    const mockS3 = {
      send: async (command: unknown) => {
        sentCommands.push(command);
        return {};
      },
    };

    const result = await writePortableExportArchive(client, {
      bucket: 'dataops-v1-export-archives',
      prefix: 'exports',
      environment: 'prod',
      tempDir: path.join(tmpDir, 's3-working-export'),
      s3Client: mockS3,
    });

    assert.strictEqual(result.archiveBucket, 'dataops-v1-export-archives');
    assert.match(result.archiveUri, /^s3:\/\/dataops-v1-export-archives\/exports\/prod\//);
    assert.ok(result.manifest.redactions.includes('proposal_presentations.action_token_hash'));
    assert.ok(result.manifest.omitted_entities.includes('provider_credentials'));
    assert.doesNotMatch(result.archiveUri, /[?&](token|credential|signature)=/i);
    assert.strictEqual(sentCommands.length, 1);
    assert.ok(sentCommands[0] instanceof PutObjectCommand);
    const input = (sentCommands[0] as PutObjectCommand).input;
    assert.strictEqual(input.Bucket, 'dataops-v1-export-archives');
    assert.strictEqual(input.Key, result.archiveKey);
    assert.strictEqual(input.ServerSideEncryption, 'AES256');
    assert.strictEqual(input.ContentType, 'application/gzip');
    assert.ok(input.Body instanceof Buffer);
  });

  it('builds deterministic audit-friendly archive keys without private data', () => {
    const key = buildArchiveKey({
      schema_version: 'dataops.execution.v1',
      generated_at: '2026-06-27T10:15:30.000Z',
      source_environment: 'Prod EU/Private Operator',
      source_stack: 'stack',
      source_region: 'eu-west-1',
      app_git_sha: 'sha',
      export_format_version: 1,
      entity_files: {},
      entity_counts: {},
      checksums: {},
      redactions: [],
      omitted_entities: [],
    }, 'execution-exports');

    assert.strictEqual(key, 'execution-exports/prod-eu-private-operator/2026-06-27/dataops-execution-2026-06-27T10-15-30-000Z.tar.gz');
    assert.doesNotMatch(key, /@|token|secret|credential/i);
  });

  it('refuses to generate restore evidence for production targets', async () => {
    await assert.rejects(
      () => writeRestoreEvidence({
        archiveUri: 'file:///does/not/matter.tar.gz',
        expectedArchiveChecksum: `sha256:${'0'.repeat(64)}`,
        outputDir: path.join(tmpDir, 'evidence'),
        targetEnvironment: 'production',
      }),
      /non-production/
    );
  });

  it('rejects an archive checksum mismatch before creating restore evidence', async () => {
    const result = await writePortableExportArchive(client, {
      environment: 'staging',
      localArchiveDir: path.join(tmpDir, 'mismatch-store'),
      tempDir: path.join(tmpDir, 'mismatch-export'),
    });
    const outputDir = path.join(tmpDir, 'must-not-be-created');
    await assert.rejects(
      () => writeRestoreEvidence({
        archiveUri: result.archiveUri,
        expectedArchiveChecksum: `sha256:${'f'.repeat(64)}`,
        outputDir,
        targetEnvironment: 'staging',
      }),
      /Archive checksum mismatch/
    );
    await assert.rejects(() => fs.access(outputDir), /ENOENT/);
  });

  it('rejects a tar member with a corrupted header checksum before extracting files', async () => {
    const result = await writePortableExportArchive(client, {
      environment: 'staging',
      localArchiveDir: path.join(tmpDir, 'tar-store'),
      tempDir: path.join(tmpDir, 'tar-export'),
    });
    const archive = await fs.readFile(result.archiveUri.replace('file://', ''));
    const tar = zlib.gunzipSync(archive);
    tar[0] = tar[0] === 0x6d ? 0x6e : 0x6d;
    const corrupted = zlib.gzipSync(tar);
    const extractionDir = path.join(tmpDir, 'corrupt-extraction');
    await assert.rejects(
      () => extractExportArchive(corrupted, extractionDir),
      /tar header checksum mismatch/
    );
    assert.deepStrictEqual(await fs.readdir(extractionDir), []);
  });
});
