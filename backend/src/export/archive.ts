import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import zlib from 'zlib';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  EXPORT_FORMAT_VERSION,
  SCHEMA_VERSION,
  dryRunImport,
  validatePortableExport,
  writePortableExport,
} from './portable';
import type { DryRunImportResult, Manifest, PortableExportResult, ValidationResult } from './portable';

interface ExportArchiveConfig {
  bucket?: string;
  prefix?: string;
  environment?: string;
  localArchiveDir?: string;
  tempDir?: string;
  s3Client?: Pick<S3Client, 'send'>;
}

interface ExportArchiveResult extends PortableExportResult {
  archiveUri: string;
  archiveKey: string;
  archiveBucket?: string;
  archiveChecksum: string;
  archiveSizeBytes: number;
}

interface RestoreEvidenceOptions {
  archiveUri: string;
  outputDir: string;
  targetEnvironment: string;
  appGitSha?: string;
  timestamp?: string;
  smokeChecksPassed?: boolean;
  s3Client?: Pick<S3Client, 'send'>;
}

interface RestoreEvidenceReport {
  schema_version: string;
  archive_uri: string;
  archive_key: string;
  app_git_sha: string;
  export_generated_at: string;
  manifest_checksum_summary: Record<string, string>;
  validation: ValidationResult;
  dry_run_import: DryRunImportResult;
  skipped_record_counts: Record<string, number>;
  invalid_record_count: number;
  target_environment: string;
  evidence_timestamp: string;
  smoke_check_checklist: Array<{ check: string; result: 'passed' | 'not_run' }>;
  production_write_gate: string;
}

interface RestoreEvidenceResult {
  report: RestoreEvidenceReport;
  evidencePath: string;
  extractedDir: string;
}

const TAR_BLOCK_SIZE = 512;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const RESTORE_SMOKE_CHECKS = [
  'List today tasks',
  'Open workflow bundle',
  'Instantiate workflow template',
  'Generate recurring tasks',
  'List due notifications',
  'List files for task',
  'Export target data and compare counts',
];

function sha256Bytes(content: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function sha256Base64(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('base64');
}

function sanitizePathSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function archiveTimestamp(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }
  return date.toISOString().replace(/[:.]/g, '-');
}

function buildArchiveKey(manifest: Manifest, prefix = 'execution-exports'): string {
  const safePrefix = prefix.replace(/^\/+|\/+$/g, '') || 'execution-exports';
  const safeEnvironment = sanitizePathSegment(manifest.source_environment);
  const generatedDate = manifest.generated_at.slice(0, 10);
  const generatedTime = archiveTimestamp(manifest.generated_at);
  return `${safePrefix}/${safeEnvironment}/${generatedDate}/dataops-execution-${generatedTime}.tar.gz`;
}

function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

function archiveKeyFromUri(uri: string): string {
  const s3 = parseS3Uri(uri);
  if (s3) return s3.key;
  if (uri.startsWith('file://')) return uri.slice('file://'.length);
  return uri;
}

function tarHeader(filename: string, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  header.write(filename, 0, Math.min(Buffer.byteLength(filename), 100), 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.fill(' ', 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

async function createExportArchive(exportDir: string, manifest: Manifest): Promise<Buffer> {
  const filenames = ['manifest.json', ...Object.values(manifest.entity_files)];
  const blocks: Buffer[] = [];

  for (const filename of filenames) {
    if (filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Refusing to archive unsafe export filename: ${filename}`);
    }
    const content = await fs.readFile(path.join(exportDir, filename));
    blocks.push(tarHeader(filename, content.length));
    blocks.push(content);
    const padding = (TAR_BLOCK_SIZE - (content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
  }

  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));
  return gzip(Buffer.concat(blocks));
}

async function extractExportArchive(archiveBuffer: Buffer, outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  const tar = await gunzip(archiveBuffer);
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const filename = path.basename(rawName);
    if (!filename || filename !== rawName) {
      throw new Error(`Archive contains unsafe path: ${rawName}`);
    }

    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Archive contains invalid size for ${filename}`);
    }

    const content = tar.subarray(offset, offset + size);
    await fs.writeFile(path.join(outputDir, filename), content);
    offset += size;
    const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    offset += padding;
  }
}

async function readArchiveUri(uri: string, s3Client: Pick<S3Client, 'send'> = new S3Client({})): Promise<Buffer> {
  const s3 = parseS3Uri(uri);
  if (!s3) {
    const filePath = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
    return fs.readFile(filePath);
  }

  const response = await s3Client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: s3.key }));
  const body = response.Body as unknown as {
    transformToByteArray?: () => Promise<Uint8Array>;
  };
  if (!body || typeof body.transformToByteArray !== 'function') {
    throw new Error('S3 archive response body is not readable');
  }
  return Buffer.from(await body.transformToByteArray());
}

async function writeLocalArchive(localArchiveDir: string, archiveKey: string, content: Buffer): Promise<string> {
  const filePath = path.resolve(localArchiveDir, archiveKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return `file://${filePath}`;
}

async function writePortableExportArchive(
  client: DynamoDBDocumentClient,
  config: ExportArchiveConfig = {}
): Promise<ExportArchiveResult> {
  const ownsTempDir = !config.tempDir;
  const tempDir = config.tempDir || await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-export-'));
  try {
    const result = await writePortableExport(client, tempDir, {
      sourceEnvironment: config.environment,
    });
    const archiveKey = buildArchiveKey(result.manifest, config.prefix);
    const archive = await createExportArchive(result.outputDir, result.manifest);
    const archiveChecksum = sha256Bytes(archive);

    if (config.bucket) {
      const s3Client = config.s3Client || new S3Client({});
      await s3Client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: archiveKey,
        Body: archive,
        ContentType: 'application/gzip',
        ChecksumSHA256: sha256Base64(archive),
        ServerSideEncryption: 'AES256',
        Metadata: {
          schema_version: SCHEMA_VERSION,
          export_format_version: String(EXPORT_FORMAT_VERSION),
          generated_at: result.manifest.generated_at,
        },
      }));
      return {
        ...result,
        archiveUri: `s3://${config.bucket}/${archiveKey}`,
        archiveKey,
        archiveBucket: config.bucket,
        archiveChecksum,
        archiveSizeBytes: archive.length,
      };
    }

    if (!config.localArchiveDir) {
      throw new Error('Export archive storage is not configured');
    }

    const archiveUri = await writeLocalArchive(config.localArchiveDir, archiveKey, archive);
    return {
      ...result,
      archiveUri,
      archiveKey,
      archiveChecksum,
      archiveSizeBytes: archive.length,
    };
  } finally {
    if (ownsTempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function writeRestoreEvidence(options: RestoreEvidenceOptions): Promise<RestoreEvidenceResult> {
  if (!options.targetEnvironment || options.targetEnvironment === 'production' || options.targetEnvironment === 'prod') {
    throw new Error('Restore evidence targetEnvironment must be a non-production environment');
  }

  await fs.mkdir(options.outputDir, { recursive: true });
  const timestamp = options.timestamp || new Date().toISOString();
  const archiveBuffer = await readArchiveUri(options.archiveUri, options.s3Client);
  const extractedDir = path.join(options.outputDir, `extracted-${timestamp.replace(/[:.]/g, '-')}`);
  await extractExportArchive(archiveBuffer, extractedDir);

  const manifest = JSON.parse(await fs.readFile(path.join(extractedDir, 'manifest.json'), 'utf8')) as Manifest;
  const validation = await validatePortableExport(extractedDir);
  const dryRun = await dryRunImport(extractedDir);
  const report: RestoreEvidenceReport = {
    schema_version: 'dataops.restore-evidence.v1',
    archive_uri: options.archiveUri,
    archive_key: archiveKeyFromUri(options.archiveUri),
    app_git_sha: options.appGitSha || process.env.GITHUB_SHA || process.env.APP_GIT_SHA || 'unknown',
    export_generated_at: manifest.generated_at,
    manifest_checksum_summary: manifest.checksums,
    validation,
    dry_run_import: dryRun,
    skipped_record_counts: dryRun.skipped,
    invalid_record_count: validation.valid ? 0 : validation.errors.length,
    target_environment: options.targetEnvironment,
    evidence_timestamp: timestamp,
    smoke_check_checklist: RESTORE_SMOKE_CHECKS.map((check) => ({
      check,
      result: options.smokeChecksPassed ? 'passed' : 'not_run',
    })),
    production_write_gate: 'No restore/import/write action is performed by this drill. Production writes require a separate human-approved command.',
  };
  const evidencePath = path.join(options.outputDir, `restore-evidence-${timestamp.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return { report, evidencePath, extractedDir };
}

export {
  buildArchiveKey,
  createExportArchive,
  extractExportArchive,
  parseS3Uri,
  writePortableExportArchive,
  writeRestoreEvidence,
};
export type {
  ExportArchiveConfig,
  ExportArchiveResult,
  RestoreEvidenceOptions,
  RestoreEvidenceReport,
  RestoreEvidenceResult,
};
