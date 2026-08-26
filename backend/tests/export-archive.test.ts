import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import zlib from 'zlib';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createTask } from '../src/db/tasks';
import {
  buildArchiveKey,
  DEFAULT_ARCHIVE_EXTRACTION_LIMITS,
  extractExportArchive,
  writePortableExportArchive,
  writeRestoreEvidence,
} from '../src/export/archive';
import {
  setPortableExportClockForTests,
  validatePortableExport,
} from '../src/export/portable';

function projectTmpDir(name: string): string {
  return path.join(__dirname, '..', '..', '.tmp', 'exports', `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

interface SyntheticMember {
  name: string;
  content?: Buffer;
  prefix?: string;
  type?: string;
}

function syntheticTarHeader(name: string, size: number, type = '0', prefix = ''): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(' ', 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, Math.min(Buffer.byteLength(prefix), 155), 'utf8');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function syntheticArchive(
  members: SyntheticMember[],
  options: { trailing?: Buffer; truncatedBytes?: number } = {},
): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const content = member.content || Buffer.alloc(0);
    blocks.push(syntheticTarHeader(
      member.name,
      content.length,
      member.type,
      member.prefix,
    ));
    blocks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  if (options.trailing) blocks.push(options.trailing);
  const tar = Buffer.concat(blocks);
  return zlib.gzipSync(options.truncatedBytes ? tar.subarray(0, options.truncatedBytes) : tar);
}

function fixtureChecksum(content: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

async function assertRejectedWithoutEvidence(
  operation: Promise<unknown>,
  outputDir: string,
  pattern: RegExp,
): Promise<Error> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error, `expected operation to reject for ${outputDir}`);
  assert.strictEqual(caught.name, 'ArchiveBoundaryError');
  assert.match(caught.message, pattern);
  try {
    const entries = await fs.readdir(outputDir);
    assert.ok(!entries.some((entry) => entry.startsWith('restore-evidence-')));
  } catch (error) {
    assert.strictEqual((error as NodeJS.ErrnoException).code, 'ENOENT');
  }
  return caught;
}

async function assertExtractionRejected(
  operation: Promise<unknown>,
  outputDir: string,
  pattern: RegExp,
): Promise<Error> {
  const error = await assertRejectedWithoutEvidence(operation, outputDir, pattern);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(outputDir);
  } catch (readError) {
    assert.strictEqual((readError as NodeJS.ErrnoException).code, 'ENOENT');
  }
  return Object.assign(error, { entries });
}

describe('offsite portable export archives', () => {
  let client: DynamoDBDocumentClient;
  let tmpDir: string;

  beforeEach(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    tmpDir = projectTmpDir('archive-test');
    await fs.mkdir(tmpDir, { recursive: true });
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
      targetEnvironment: 'Restore Drill',
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
    assert.strictEqual(evidence.report.target_environment, 'Restore Drill');
    assert.ok(evidence.report.smoke_check_checklist.every((item) => item.result === 'passed'));
    assert.match(evidence.report.production_write_gate, /human-approved/);
    assert.match(
      evidence.report.artifact_binary_backup_proof,
      /Not performed or verified by this drill/,
    );
    assert.match(
      evidence.report.artifact_binary_backup_proof,
      /authorized artifact-storage operator/,
    );
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

    setPortableExportClockForTests(() => new Date('2026-06-27T12:15:30+02:00'));
    try {
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
      assert.strictEqual(result.manifest.generated_at, '2026-06-27T10:15:30.000Z');
      assert.strictEqual(
        input.Key,
        'exports/prod/2026-06-27/dataops-execution-2026-06-27T10-15-30-000Z.tar.gz',
      );
      assert.strictEqual(input.Metadata?.generated_at, result.manifest.generated_at);
      assert.strictEqual(input.ServerSideEncryption, 'AES256');
      assert.strictEqual(input.ContentType, 'application/gzip');
      assert.ok(input.Body instanceof Buffer);
    } finally {
      setPortableExportClockForTests();
    }
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

  it('rejects production target aliases before any restore side effect', async () => {
    const targets = [
      '',
      '   ',
      'Production',
      'PRODUCTION',
      'Prod',
      'prod',
      '  production  ',
      '\tPROD\n',
    ];
    let s3Calls = 0;
    const guardedS3 = {
      send: async () => {
        s3Calls += 1;
        return {};
      },
    };

    for (const [index, targetEnvironment] of targets.entries()) {
      const outputDir = path.join(tmpDir, `guarded-${index}`);
      await assert.rejects(
        () => writeRestoreEvidence({
          archiveUri: 's3://guarded-bucket/archive.tar.gz',
          expectedArchiveChecksum: `sha256:${'0'.repeat(64)}`,
          outputDir,
          targetEnvironment,
          s3Client: guardedS3,
        }),
        /non-production/,
      );
      await assert.rejects(() => fs.access(outputDir), /ENOENT/);
    }

    assert.strictEqual(s3Calls, 0);
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
    const error = await assertExtractionRejected(
      extractExportArchive(corrupted, extractionDir),
      extractionDir,
      /invalid tar header checksum/,
    );
    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
    await assert.rejects(
      () => extractExportArchive(corrupted, extractionDir),
      /invalid tar header checksum/
    );
    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
  });

  it('enforces the local-file compressed ceiling before extraction', async () => {
    const limit = 16;
    const archivePath = path.join(tmpDir, 'oversized-local.tar.gz');
    await fs.writeFile(archivePath, Buffer.alloc(limit + 1, 7));
    const outputDir = path.join(tmpDir, 'local-compressed-boundary');

    await assertRejectedWithoutEvidence(
      writeRestoreEvidence({
        archiveUri: archivePath,
        expectedArchiveChecksum: fixtureChecksum(Buffer.alloc(0)),
        outputDir,
        targetEnvironment: 'staging',
        timestamp: '2026-06-27T10:00:00.000Z',
        extractionLimits: { maxCompressedArchiveBytes: limit },
      }),
      outputDir,
      /compressed-size/,
    );
    await assert.rejects(() => fs.access(outputDir), /ENOENT/);
  });

  it('stops an unbounded S3 body at the compressed ceiling without extracting it', async () => {
    const limit = 16;
    const chunks = [Buffer.alloc(10, 1), Buffer.alloc(10, 2), Buffer.alloc(10, 3)];
    let offeredBytes = 0;
    let s3Calls = 0;
    const body = Readable.from((function* generateOversizedBody() {
      for (const chunk of chunks) {
        offeredBytes += chunk.length;
        yield chunk;
      }
    })());
    const guardedS3 = {
      send: async () => {
        s3Calls += 1;
        return { Body: body };
      },
    };
    const outputDir = path.join(tmpDir, 's3-compressed-boundary');

    await assertRejectedWithoutEvidence(
      writeRestoreEvidence({
        archiveUri: 's3://guarded-bucket/unbounded.tar.gz',
        expectedArchiveChecksum: fixtureChecksum(Buffer.alloc(0)),
        outputDir,
        targetEnvironment: 'staging',
        timestamp: '2026-06-27T10:00:00.000Z',
        s3Client: guardedS3,
        extractionLimits: { maxCompressedArchiveBytes: limit },
      }),
      outputDir,
      /compressed-size/,
    );

    assert.strictEqual(s3Calls, 1);
    assert.ok(offeredBytes >= limit + 1);
    assert.ok(offeredBytes < chunks.reduce((total, chunk) => total + chunk.length, 0));
    await assert.rejects(() => fs.access(outputDir), /ENOENT/);
  });

  it('rejects an inflated stream above the configured ceiling before creating the output directory', async () => {
    const limit = 1024;
    const archive = zlib.gzipSync(Buffer.alloc(limit + 1, 0));
    const archivePath = path.join(tmpDir, 'inflate-bomb.tar.gz');
    await fs.writeFile(archivePath, archive);
    const outputDir = path.join(tmpDir, 'inflate-boundary');

    await assertRejectedWithoutEvidence(
      writeRestoreEvidence({
        archiveUri: archivePath,
        expectedArchiveChecksum: fixtureChecksum(archive),
        outputDir,
        targetEnvironment: 'staging',
        timestamp: '2026-06-27T10:00:00.000Z',
        extractionLimits: { maxInflatedArchiveBytes: limit },
      }),
      outputDir,
      /inflated-size/,
    );
    await assert.rejects(
      () => fs.access(path.join(outputDir, 'extracted-2026-06-27T10-00-00-000Z')),
      /ENOENT/,
    );
  });

  it('rejects an oversized member before writing that member', async () => {
    const archive = syntheticArchive([
      { name: 'oversized-member.json', content: Buffer.alloc(17, 8) },
    ]);
    const extractionDir = path.join(tmpDir, 'member-size-boundary');
    const error = await assertExtractionRejected(
      extractExportArchive(archive, extractionDir, { maxMemberBytes: 16 }),
      extractionDir,
      /member-size/,
    );

    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
    assert.ok(!error.message.includes('oversized-member'));
  });

  it('rejects an archive whose aggregate payload crosses the configured ceiling', async () => {
    const archive = syntheticArchive([
      { name: 'first.json', content: Buffer.alloc(10, 1) },
      { name: 'second.json', content: Buffer.alloc(10, 2) },
    ]);
    const extractionDir = path.join(tmpDir, 'aggregate-boundary');
    const error = await assertExtractionRejected(
      extractExportArchive(archive, extractionDir, { maxAggregatePayloadBytes: 15 }),
      extractionDir,
      /member 2 exceeds the aggregate-payload/,
    );

    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
    assert.ok(!error.message.includes('second.json'));
  });

  it('rejects excess members without retaining previously validated members', async () => {
    const archive = syntheticArchive([
      { name: 'manifest.json' },
      { name: 'tasks.jsonl' },
      { name: 'unexpected.jsonl' },
    ]);
    const extractionDir = path.join(tmpDir, 'member-count-boundary');
    const error = await assertExtractionRejected(
      extractExportArchive(archive, extractionDir, { maxMembers: 2 }),
      extractionDir,
      /member 3 exceeds the member-count/,
    );

    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
    assert.ok(!error.message.includes('unexpected.jsonl'));
  });

  it('rejects traversal, absolute paths, hidden names, and USTAR prefixes without exposing paths', async () => {
    const hostileMembers = [
      { name: '../escaped-secret', fragments: ['../', 'escaped-secret'] },
      { name: '/tmp/absolute-by-archive', fragments: ['/tmp/', 'absolute-by-archive'] },
      { name: '.hidden-export', fragments: ['.hidden-export'] },
      { name: 'windows\\unsafe.json', fragments: ['windows\\unsafe.json'] },
      { name: 'safe.json\0/../hidden.json', fragments: ['../', 'hidden.json'] },
      { name: 'safe.txt', prefix: '../prefix-escape', fragments: ['../', 'prefix-escape'] },
    ];

    for (const [index, member] of hostileMembers.entries()) {
      const archive = syntheticArchive([member]);
      const extractionDir = path.join(tmpDir, `hostile-name-${index}`);
      const error = await assertExtractionRejected(
        extractExportArchive(archive, extractionDir),
        extractionDir,
        /unsafe flat name/,
      );

      assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
      for (const fragment of member.fragments) {
        assert.ok(!error.message.includes(fragment));
      }
    }

    await assert.rejects(() => fs.access(path.join(tmpDir, 'escaped-secret')), /ENOENT/);
  });

  it('rejects unsupported TAR member types before writing them', async () => {
    const archive = syntheticArchive([{ name: 'directory-entry', type: '5' }]);
    const extractionDir = path.join(tmpDir, 'unsupported-type-boundary');

    const error = await assertExtractionRejected(
      extractExportArchive(archive, extractionDir),
      extractionDir,
      /unsupported type/,
    );
    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
  });

  it('rejects duplicate flat filenames even when letter casing differs', async () => {
    const archive = syntheticArchive([
      { name: 'duplicate.txt', content: Buffer.from('first') },
      { name: 'DUPLICATE.TXT', content: Buffer.from('second') },
    ]);
    const extractionDir = path.join(tmpDir, 'duplicate-name-boundary');
    const error = await assertExtractionRejected(
      extractExportArchive(archive, extractionDir),
      extractionDir,
      /member 2 duplicates a flat filename/,
    );

    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
    assert.ok(!error.message.includes('DUPLICATE.TXT'));
  });

  it('rejects a member whose declared bytes are truncated', async () => {
    const archive = syntheticArchive([
      { name: 'payload.json', content: Buffer.alloc(100, 9) },
    ], { truncatedBytes: 600 });
    const extractionDir = path.join(tmpDir, 'truncation-boundary');
    const error = await assertExtractionRejected(
      extractExportArchive(archive, extractionDir),
      extractionDir,
      /member 1 is truncated/,
    );
    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
    assert.ok(!error.message.includes('payload.json'));
  });

  it('rejects nonzero data after the standard TAR end marker', async () => {
    const archive = syntheticArchive(
      [{ name: 'valid-before-trailing.json' }],
      { trailing: Buffer.alloc(512, 1) },
    );
    const extractionDir = path.join(tmpDir, 'trailing-data-boundary');

    const error = await assertExtractionRejected(
      extractExportArchive(archive, extractionDir),
      extractionDir,
      /nonzero trailing data/,
    );
    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
  });

  it('ignores environment variables when selecting extraction defaults', async () => {
    const members = Array.from({ length: DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxMembers + 1 }, (_, index) => ({
      name: `member-${index}.json`,
    }));
    const archive = syntheticArchive(members);
    const extractionDir = path.join(tmpDir, 'environment-boundary');
    process.env.ARCHIVE_EXTRACTION_LIMITS = JSON.stringify({
      maxMembers: DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxMembers + 1,
    });
    process.env.ARCHIVE_EXTRACTION_MAX_MEMBERS = String(DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxMembers + 1);

    try {
      const error = await assertExtractionRejected(
        extractExportArchive(archive, extractionDir),
        extractionDir,
        new RegExp(`member ${DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxMembers + 1} exceeds the member-count`),
      );
      assert.ok(!error.message.includes('member-128.json'));
    } finally {
      delete process.env.ARCHIVE_EXTRACTION_LIMITS;
      delete process.env.ARCHIVE_EXTRACTION_MAX_MEMBERS;
    }
  });

  it('does not let archive content raise the configured member-count boundary', async () => {
    const attemptedManifestLimit = JSON.stringify({
      archive_extraction_limits: { maxMembers: DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxMembers + 1 },
    });
    const archive = syntheticArchive([
      { name: 'manifest.json', content: Buffer.from(attemptedManifestLimit) },
      { name: 'tasks.jsonl' },
    ]);
    const extractionDir = path.join(tmpDir, 'archive-limit-escalation');
    const error = await assertExtractionRejected(
      extractExportArchive(archive, extractionDir, { maxMembers: 1 }),
      extractionDir,
      /member 2 exceeds the member-count/,
    );

    assert.deepStrictEqual((error as { entries?: string[] }).entries, []);
    assert.ok(!error.message.includes(attemptedManifestLimit));
  });

  it('rejects caller overrides above the named default before reading an archive', async () => {
    const archivePath = path.join(tmpDir, 'not-read.tar.gz');
    const outputDir = path.join(tmpDir, 'limit-increase-boundary');

    await assertRejectedWithoutEvidence(
      writeRestoreEvidence({
        archiveUri: archivePath,
        expectedArchiveChecksum: fixtureChecksum(Buffer.alloc(0)),
        outputDir,
        targetEnvironment: 'staging',
        extractionLimits: { maxMembers: DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxMembers + 1 },
      }),
      outputDir,
      /limit maxMembers must be at or below/,
    );
    await assert.rejects(() => fs.access(archivePath), /ENOENT/);
    await assert.rejects(() => fs.access(outputDir), /ENOENT/);
  });

  it('extracts validates dry-runs and records evidence for a synthetic archive below every ceiling', async () => {
    await createTask(client, { description: 'Bounded recovery task', date: '2026-06-27' });
    const result = await writePortableExportArchive(client, {
      environment: 'staging',
      localArchiveDir: path.join(tmpDir, 'below-ceiling-store'),
      tempDir: path.join(tmpDir, 'below-ceiling-export'),
    });
    const archivePath = result.archiveUri.replace(/^file:\/\//, '');
    const archive = await fs.readFile(archivePath);
    const inflated = zlib.gunzipSync(archive);
    const filenames = ['manifest.json', ...Object.values(result.manifest.entity_files)];
    const memberSizes = await Promise.all(filenames.map(async (filename) => {
      const stats = await fs.stat(path.join(result.outputDir, filename));
      return stats.size;
    }));
    const aggregateSize = memberSizes.reduce((total, size) => total + size, 0);
    const limits = {
      maxCompressedArchiveBytes: result.archiveSizeBytes + 1,
      maxInflatedArchiveBytes: inflated.length + 1,
      maxMembers: filenames.length + 1,
      maxMemberBytes: Math.max(...memberSizes) + 1,
      maxAggregatePayloadBytes: aggregateSize + 1,
    };

    assert.strictEqual(filenames.length, 25);
    assert.ok(limits.maxCompressedArchiveBytes < DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxCompressedArchiveBytes);
    assert.ok(limits.maxInflatedArchiveBytes < DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxInflatedArchiveBytes);
    assert.ok(limits.maxMembers < DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxMembers);
    assert.ok(limits.maxMemberBytes < DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxMemberBytes);
    assert.ok(limits.maxAggregatePayloadBytes < DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxAggregatePayloadBytes);

    const outputDir = path.join(tmpDir, 'below-ceiling-evidence');
    const evidence = await writeRestoreEvidence({
      archiveUri: result.archiveUri,
      expectedArchiveChecksum: result.archiveChecksum,
      outputDir,
      targetEnvironment: 'Below Ceiling Drill',
      appGitSha: 'test-sha',
      timestamp: '2026-06-27T11:00:00.000Z',
      smokeChecksPassed: true,
      extractionLimits: limits,
    });

    assert.strictEqual(evidence.report.validation.valid, true);
    assert.strictEqual(evidence.report.dry_run_import.valid, true);
    assert.strictEqual(evidence.report.dry_run_import.totalRecords, 1);
    assert.strictEqual(evidence.report.dry_run_import.wouldWrite.tasks, 1);
    assert.strictEqual(evidence.report.target_environment, 'Below Ceiling Drill');
    assert.strictEqual((await fs.readdir(evidence.extractedDir)).length, 25);
    await fs.access(evidence.evidencePath);
  });
});
